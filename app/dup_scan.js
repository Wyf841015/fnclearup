#!/usr/bin/env node
/**
 * dup_scan.js — Duplicate file scan worker for FnClearup (Node.js).
 * Uses 10-way concurrent Promise.all batch processing.
 * Launched as a subprocess by server.js.
 *
 * Usage: node dup_scan.js <scan_type> <scan_path> <job_id> <state_dir>
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, readdirSync, unlinkSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const MUSIC_EXTS = new Set(['.mp3','.flac','.wav','.aac','.ogg','.m4a','.wma','.alac','.ape','.dsf']);
const MAX_WORKERS = 10;
const POLL_MS = 1000;

function writeState(stateDir, jobId, data) {
  const path = join(stateDir, `dup_${jobId}.json`);
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data, (k, v) => v === undefined ? null : v));
    renameSync(tmp, path);
  } catch (e) { process.stderr.write(`writeState error: ${e}\n`); }
}

async function reloadControl(stateDir, jobId, state) {
  try {
    const path = join(stateDir, `dup_${jobId}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (raw._aborted) {
      state._aborted = true;
      state.status = 'aborted';
      writeState(stateDir, jobId, state);
      return false;
    }
    if (raw._paused) {
      state._paused = true;
      state.status = 'paused';
      state.progress.currentFile = '已暂停';
      writeState(stateDir, jobId, state);
      while (true) {
        await sleep(POLL_MS);
        try {
          const r = JSON.parse(readFileSync(path, 'utf-8'));
          if (r._aborted) { state._aborted = true; state.status = 'aborted'; writeState(stateDir, jobId, state); return false; }
          if (!r._paused) { state._paused = false; state.status = state._prev_status || 'counting'; writeState(stateDir, jobId, state); return true; }
        } catch {}
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write(`reloadControl error: ${e}\n`);
  }
  return true;
}

function hashFileWorker(fp) {
  try {
    const hash = createHash('sha256');
    const stream = createReadStream(fp, { highWaterMark: 256 * 1024 });
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    return new Promise((resolve) => {
      stream.on('end', () => {
        for (const c of chunks) hash.update(c);
        const digest = hash.digest('hex');
        try {
          const st = statSync(fp);
          let id3 = null;
          if (fp.toLowerCase().endsWith('.mp3')) {
            try {
              const buf = readFileSync(fp, { start: 0, end: 10239 });
              if (buf.length >= 10 && buf.slice(0, 3).toString() === 'ID3') {
                const hdr = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
                const end = Math.min(10 + hdr, buf.length);
                let pos = 10;
                id3 = { title: '', artist: '', album: '' };
                while (pos + 10 <= end) {
                  const fid = buf.slice(pos, pos + 4).toString();
                  const fsize = buf.readUInt32BE(pos + 4);
                  if (fid === '\x00\x00\x00\x00' || fsize === 0) break;
                  if (['TIT2','TPE1','TALB'].includes(fid) && pos + 10 + fsize <= end) {
                    const val = buf.slice(pos + 11, pos + 10 + fsize).toString('utf-8').replace(/\x00/g, '').trim();
                    if (fid === 'TIT2') id3.title = val;
                    else if (fid === 'TPE1') id3.artist = val;
                    else if (fid === 'TALB') id3.album = val;
                  }
                  pos += 10 + fsize;
                }
              }
            } catch {}
          }
          resolve({ path: fp, size: st.size, hash: digest, ext: extname(fp).toLowerCase(), id3 });
        } catch { resolve(null); }
      });
      stream.on('error', () => resolve(null));
    });
  } catch { return Promise.resolve(null); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) { process.stderr.write('Usage: node dup_scan.js <scan_type> <scan_path> <job_id> <state_dir>\n'); process.exit(1); }

  const [scanType, scanPath, jobId, stateDir] = args;
  if (!['music', 'files'].includes(scanType)) { process.stderr.write(`Invalid scan_type: ${scanType}\n`); process.exit(1); }
  mkdirSync(stateDir, { recursive: true });

  let state = {
    id: jobId, scanType, rootPath: scanPath,
    status: 'counting',
    progress: { total: 0, processed: 0, currentFile: '' },
    files: [], duplicates: [],
    stats: { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 },
    error: null, startTime: Date.now(),
    _aborted: false, _paused: false, _prev_status: 'counting',
  };

  if (!existsSync(scanPath)) {
    state.status = 'error';
    state.error = `目录不存在: ${scanPath}`;
    writeState(stateDir, jobId, state);
    process.exit(1);
  }

  // Phase 1: count files (sequential walk)
  writeState(stateDir, jobId, state);
  const allFiles = [];
  try {
    const walk = async (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const fp = join(dir, e.name);
        if (e.isDirectory()) await walk(fp);
        else if (e.isFile()) {
          if (scanType === 'music' && !MUSIC_EXTS.has(extname(e.name).toLowerCase())) continue;
          allFiles.push(fp);
          state.progress.total = allFiles.length;
          state.progress.currentFile = e.name;
          if (allFiles.length % 50 === 0) writeState(stateDir, jobId, state);
        }
      }
    };
    await walk(scanPath);
  } catch (e) { state.status = 'error'; state.error = e.message; writeState(stateDir, jobId, state); return; }

  if (!allFiles.length) {
    state.status = 'complete';
    state.progress.currentFile = '未找到匹配文件';
    writeState(stateDir, jobId, state);
    return;
  }

  // Phase 2: hash files with 10-way concurrency
  state.status = 'hashing';
  state._prev_status = 'hashing';
  state.progress.total = allFiles.length;
  writeState(stateDir, jobId, state);

  const fileHashes = [];
  let processed = 0;
  const batchSize = MAX_WORKERS * 5;

  for (let batchStart = 0; batchStart < allFiles.length; batchStart += batchSize) {
    if (!reloadControl(stateDir, jobId, state)) return;

    const batch = allFiles.slice(batchStart, batchStart + batchSize);
    const promises = batch.map(fp => hashFileWorker(fp));
    const results = await Promise.all(promises);

    for (let i = 0; i < results.length; i++) {
      processed++;
      if (results[i]) fileHashes.push(results[i]);
      state.progress.processed = processed;
      state.progress.currentFile = batch[i];
      if (processed % 20 === 0) writeState(stateDir, jobId, state);
    }
  }

  // Group by hash
  const groups = new Map();
  for (const f of fileHashes) {
    if (!groups.has(f.hash)) groups.set(f.hash, []);
    groups.get(f.hash).push(f);
  }

  const duplicates = [];
  let dupFiles = 0, wastedBytes = 0;
  for (const [hash, files] of groups) {
    if (files.length >= 2) {
      files.sort((a, b) => a.path.localeCompare(b.path));
      const wasted = files.slice(1).reduce((s, f) => s + f.size, 0);
      duplicates.push({ hash, count: files.length, files, wasted });
      dupFiles += files.length;
      wastedBytes += wasted;
    }
  }
  duplicates.sort((a, b) => b.wasted - a.wasted);

  state.status = 'complete';
  state.files = fileHashes;
  state.duplicates = duplicates;
  state.stats = { totalFiles: fileHashes.length, duplicateGroups: duplicates.length, duplicateFiles: dupFiles, wastedBytes };
  writeState(stateDir, jobId, state);
}

main().catch(e => {
  process.stderr.write(`dup_scan fatal: ${e}\n`);
  process.exit(1);
});
