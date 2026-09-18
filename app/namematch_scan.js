#!/usr/bin/env node
/**
 * namematch_scan.js — Same-name conflict detector for FnClearup (P2-2).
 * Launched as a subprocess by server.js (same pattern as broken_scan.js).
 *
 * Usage: node namematch_scan.js <scan_path> <job_id> <state_dir>
 *   scan_path : comma-separated roots (caller enforces isSafePath)
 *   job_id    : name_<rand>
 *   state_dir : where <job_id>.json is written
 *
 * Detects groups of files that share the same filename but live in different
 * directories (case-insensitive option). Pure fs walk, no ffmpeg.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const POLL_MS = 1000;
const MAX_FILES = 80000;
const YIELD = 400;

const [scanPathsRaw, jobId, stateDir] = process.argv.slice(2);
const scanPaths = scanPathsRaw.split(',').map(s => s.trim()).filter(Boolean);
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

// name(lowercased) → [{ path, name, size, dir }]
const byName = new Map();
let totalFiles = 0;

function writeState(data) {
  const path = join(stateDir, `${jobId}.json`);
  const tmp = path + '.tmp';
  try { writeFileSync(tmp, JSON.stringify(data, (k, v) => v === undefined ? null : v)); renameSync(tmp, path); }
  catch (e) { process.stderr.write(`writeState error: ${e}\n`); }
}

async function walk(dir, state) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (state._aborted) return;
    if (totalFiles >= MAX_FILES) return;
    const full = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        await walk(full, state);
      } else if (e.isFile()) {
        totalFiles++;
        const key = e.name.toLowerCase();
        if (!byName.has(key)) byName.set(key, []);
        const st = statSync(full);
        byName.get(key).push({ path: full, name: e.name, size: st.size, dir: dir });
        if (totalFiles % 200 === 0) writeState(state);
      }
    } catch { /* ignore */ }
    if (totalFiles % YIELD === 0) await new Promise(r => setImmediate(r));
  }
}

const state = {
  id: jobId, type: 'namematch', rootPaths: scanPaths,
  status: 'scanning', progress: { scanned: 0, currentFile: '' },
  groups: [], stats: { scanned: 0, groups: 0, files_in_groups: 0 },
  error: null, startTime: Date.now(), _aborted: false,
};
writeState(state);

(async () => {
  for (const rp of scanPaths) {
    if (existsSync(rp)) {
      state.progress.currentFile = rp;
      await walk(rp, state);
      if (state._aborted) break;
    }
  }

  // Groups = names with ≥2 occurrences in DIFFERENT directories
  const groups = [];
  for (const [, occurrences] of byName) {
    if (occurrences.length < 2) continue;
    const dirs = new Set(occurrences.map(o => o.dir));
    if (dirs.size < 2) continue; // same dir → not a conflict (e.g. ".gitkeep" clones? still same dir)
    // skip trivial same-name patterns that are expected: keep all for now
    groups.push({
      name: occurrences[0].name,
      count: occurrences.length,
      total_size: occurrences.reduce((s, o) => s + o.size, 0),
      files: occurrences.map(o => ({ path: o.path, dir: o.dir, size: o.size, size_str: o.size < 1024 ? o.size + ' B' : (o.size / 1048576).toFixed(1) + ' MB' })),
    });
  }
  // Largest conflicts first
  groups.sort((a, b) => b.total_size - a.total_size);

  state.status = 'done';
  state.progress.scanned = totalFiles;
  state.groups = groups.slice(0, 1000);
  state.stats = {
    scanned: totalFiles,
    groups: groups.length,
    files_in_groups: groups.reduce((s, g) => s + g.count, 0),
  };
  writeState(state);
  process.exit(0);
})();