#!/usr/bin/env node
/**
 * broken_scan.js — Abnormal file detector for FnClearup (P0-3).
 * Launched as a subprocess by server.js (isolation, same pattern as simdup_scan.js).
 *
 * Usage: node broken_scan.js <scan_path> <job_id> <state_dir> [check_broken]
 *   scan_path : comma-separated roots (caller enforces isSafePath)
 *   job_id    : broken_<rand>
 *   state_dir : where broken_<job_id>.json is written
 *   check_broken : '1' to also ffmpeg-decode media to find corrupt files
 *
 * Detects three kinds of abnormal files:
 *   1. Empty files       — size === 0 (corrupt/placeholder zero-byte files)
 *   2. Invalid symlinks  — lstat shows a symlink whose target doesn't exist
 *   3. Broken media      — ffmpeg fails to decode an image/video (corrupt)
 */
import { existsSync, mkdirSync, readdirSync, lstatSync, statSync, unlinkSync, readlinkSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execCmd } from './ui/lib/util.js';

const POLL_MS = 1000;
const MAX_FILES = 60000;
const YIELD = 300;
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);
const VID_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.rmvb']);
// Download-in-progress / leftover partial files (semi-downloaded fragments).
const DL_RESIDUE_EXTS = new Set(['.part', '.crdownload', '.download', '.partial', '.aria2']);
const FFMPEG = '/usr/bin/ffmpeg';

const [scanPathsRaw, jobId, stateDir, checkBrokenRaw] = process.argv.slice(2);
const checkBroken = checkBrokenRaw === '1';
const scanPaths = scanPathsRaw.split(',').map(s => s.trim()).filter(Boolean);
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

let emptyFiles = [];       // { path, name, size }
let invalidLinks = [];     // { path, target }
let brokenFiles = [];      // { path, name, size, error }
let downloadResidue = [];  // { path, name, size, size_str }

function writeState(data) {
  const path = join(stateDir, `${jobId}.json`);
  const tmp = path + '.tmp';
  try { writeFileSync(tmp, JSON.stringify(data, (k, v) => v === undefined ? null : v)); renameSync(tmp, path); }
  catch (e) { process.stderr.write(`writeState error: ${e}\n`); }
}

async function reloadControl(state) {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, `${jobId}.json`), 'utf-8'));
    if (raw._aborted) { state._aborted = true; state.status = 'aborted'; writeState(state); return false; }
    if (raw._paused) {
      state._paused = true; state.status = 'paused'; writeState(state);
      while (true) {
        await sleep(POLL_MS);
        try {
          const r = JSON.parse(readFileSync(join(stateDir, `${jobId}.json`), 'utf-8'));
          if (r._aborted) { state._aborted = true; state.status = 'aborted'; writeState(state); return false; }
          if (!r._paused) { state._paused = false; state.status = 'running'; writeState(state); return true; }
        } catch { /* retry */ }
      }
    }
  } catch (e) { if (e.code !== 'ENOENT') process.stderr.write(`reloadControl error: ${e}\n`); }
  return true;
}

// ftw walk; first pass collects everything, second classifies.
async function walk(dir, state, counts) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (state._aborted) return;
    if (counts.scanned >= MAX_FILES) return;
    const full = join(dir, e.name);
    counts.scanned++;
    try {
      if (e.isDirectory()) {
        await walk(full, state, counts);
      } else if (e.isSymbolicLink()) {
        // check target exists
        const target = readlinkSync(full);
        if (!existsSync(full)) invalidLinks.push({ path: full, name: e.name, target });
      } else if (e.isFile()) {
        const st = statSync(full);
        state.progress.processed++;
        if (st.size === 0) {
          emptyFiles.push({ path: full, name: e.name, size: 0 });
        }
        // download residue: leftover partial-download fragments (non-empty .part/.crdownload etc.)
        const dlEx = extname(e.name).toLowerCase();
        if (DL_RESIDUE_EXTS.has(dlEx)) {
          downloadResidue.push({ path: full, name: e.name, size: st.size, size_str: st.size });
        }
        // broken-media check: only if enabled + media ext + nonzero (skip empty)
        if (checkBroken && st.size > 0) {
          const ex = extname(e.name).toLowerCase();
          if (IMG_EXTS.has(ex) || VID_EXTS.has(ex)) {
            const ok = await probeDecode(full, ex);
            if (!ok) {
              brokenFiles.push({ path: full, name: e.name, size: st.size, error: 'decode failed' });
            }
          }
        }
        if (state.progress.processed % 100 === 0) writeState(state);
      }
    } catch { /* dead symlink to a dir etc — ignore */ }
    if (counts.scanned % YIELD === 0) await new Promise(r => setImmediate(r));
  }
}

// Quick decode probe via ffmpeg. Images: decode one frame; videos: decode first frame.
async function probeDecode(file, ext) {
  const isImg = IMG_EXTS.has(ext);
  const r = await execCmd('bash', ['-c', `${FFMPEG} -v error -i ${q(file)} -frames:v 1 -f null /dev/null 2>/dev/null; echo "SIMRC=$?"`], 15000);
  const m = r.stdout.match(/SIMRC=(\d+)/);
  const rc = m ? parseInt(m[1], 10) : 1;
  // rc=0 → decodable; non-zero → likely corrupt
  return rc === 0;
}

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

const state = {
  id: jobId, type: 'broken', checkBroken, rootPaths: scanPaths,
  status: 'counting', progress: { scanned: 0, processed: 0, currentFile: '' },
  empty: [], invalid_links: [], broken: [], download_residue: [],
  stats: { scanned: 0, empty: 0, invalid_links: 0, broken: 0, download_residue: 0 },
  error: null, startTime: Date.now(), _aborted: false, _paused: false,
};
writeState(state);

(async () => {
  const counts = { scanned: 0 };
  state.status = 'scanning';
  // pre-count total via a cheap pass for progress denominator
  state.progress.scanned = 0;
  for (const rp of scanPaths) {
    if (existsSync(rp)) {
      state.progress.currentFile = rp;
      await walk(rp, state, counts);
      if (state._aborted) break;
    }
  }

  state.status = 'done';
  const toStr = b => b < 1024 ? b + ' B' : (b / 1048576).toFixed(1) + ' MB';
  state.empty = emptyFiles.slice(0, 2000).map(f => ({ path: f.path, name: f.name, size: 0, size_str: '0 B' }));
  state.invalid_links = invalidLinks.slice(0, 2000).map(l => ({ path: l.path, name: l.name, target: l.target }));
  state.broken = brokenFiles.slice(0, 2000).map(f => ({ path: f.path, name: f.name, size: f.size, size_str: toStr(f.size), error: f.error }));
  state.download_residue = downloadResidue.slice(0, 2000).map(f => ({ path: f.path, name: f.name, size: f.size, size_str: toStr(f.size) }));
  state.stats = {
    scanned: counts.scanned,
    empty: emptyFiles.length,
    invalid_links: invalidLinks.length,
    broken: brokenFiles.length,
    download_residue: downloadResidue.length,
    checkBroken,
  };
  writeState(state);
  process.exit(0);
})();