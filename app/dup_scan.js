#!/usr/bin/env node
/**
 * dup_scan.js — Duplicate file scan worker for FnClearup (Node.js).
 * Uses worker_threads pool for parallel SHA-256 hashing with streaming reads.
 * Launched as a subprocess by server.js.
 *
 * Usage: node dup_scan.js <scan_type> <scan_path> <job_id> <state_dir>
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { getHashPool } from './dup_hash_pool.js';

const MUSIC_EXTS = new Set(['.mp3','.flac','.wav','.aac','.ogg','.m4a','.wma','.alac','.ape','.dsf']);
const POLL_MS = 1000;
const WORKER_COUNT = 4;

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
        } catch {
          // If state file is corrupted, retry a few times then bail
          breakCounter = (breakCounter || 0) + 1;
          if (breakCounter > 60) { state._paused = false; writeState(stateDir, jobId, state); return true; }
        }
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') process.stderr.write(`reloadControl error: ${e}\n`);
  }
  return true;
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

  // Phase 1: count files (sequential walk, record sizes for pre-grouping)
  writeState(stateDir, jobId, state);
  const allFiles = [];         // {path, size}[]
  let sizeGroupCount = 0;      // files that share a size with ≥1 other file
  try {
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const fp = join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.isFile()) {
          if (scanType === 'music' && !MUSIC_EXTS.has(extname(e.name).toLowerCase())) continue;
          let st;
          try { st = statSync(fp); } catch { continue; }
          allFiles.push({ path: fp, size: st.size });
          state.progress.total = allFiles.length;
          state.progress.currentFile = e.name;
          if (allFiles.length % 50 === 0) writeState(stateDir, jobId, state);
        }
      }
    };
    walk(scanPath);
  } catch (e) { state.status = 'error'; state.error = e.message; writeState(stateDir, jobId, state); return; }

  if (!allFiles.length) {
    state.status = 'complete';
    state.progress.currentFile = '未找到匹配文件';
    writeState(stateDir, jobId, state);
    return;
  }

  // Phase 1.5: group by file size — only hash files where ≥2 share the same size
  const sizeMap = new Map();   // size → {path, size}[]
  for (const f of allFiles) {
    if (!sizeMap.has(f.size)) sizeMap.set(f.size, []);
    sizeMap.get(f.size).push(f);
  }
  const filesToHash = [];
  for (const [size, group] of sizeMap) {
    if (group.length >= 2) filesToHash.push(...group);
  }
  const skippedCount = allFiles.length - filesToHash.length;
  state.progress.currentFile = `大小预分组完成: ${allFiles.length}→${filesToHash.length} 个需要哈希 (${skippedCount} 个唯一大小已跳过)`;
  writeState(stateDir, jobId, state);

  if (!filesToHash.length) {
    state.status = 'complete';
    state.duplicates = [];
    state.stats = { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 };
    writeState(stateDir, jobId, state);
    return;
  }

  // Phase 2: hash files using worker thread pool (only files sharing a size)
  state.status = 'hashing';
  state._prev_status = 'hashing';
  state.progress.total = filesToHash.length;
  state.progress.processed = 0;
  writeState(stateDir, jobId, state);

  const pool = getHashPool(WORKER_COUNT);
  const batchSize = WORKER_COUNT * 5; // 20 files per batch for 4 workers
  const fileHashes = [];
  let processed = 0;

  for (let batchStart = 0; batchStart < filesToHash.length; batchStart += batchSize) {
    if (!(await reloadControl(stateDir, jobId, state))) {
      await pool.terminate();
      return;
    }

    const batch = filesToHash.slice(batchStart, batchStart + batchSize);
    const paths = batch.map(f => f.path);
    let results;
    try {
      results = await pool.hashFiles(paths, function(idx, total, filePath, result) {
        // Per-file progress: update state immediately
        processed++;
        if (result && result.hash) {
          // Will be collected in the main results loop
        } else if (result && result.error) {
          // File hash failed — record error
          if (!state.failedFiles) state.failedFiles = [];
          state.failedFiles.push({ path: filePath, error: result.error });
        }
        state.progress.processed = processed;
        state.progress.currentFile = filePath;
        state.progress.hashProgress = '';
        writeState(stateDir, jobId, state);
      }, function(filePath, bytesRead, totalSize) {
        // Per-file hash progress (within current file)
        const pct = totalSize > 0 ? Math.round((bytesRead / totalSize) * 100) : 0;
        state.progress.currentFile = filePath;
        state.progress.hashProgress = pct + '%';
        writeState(stateDir, jobId, state);
      });
    } catch (e) {
      process.stderr.write(`batch ${batchStart}-${batchStart + batchSize} failed: ${e.message}, skipping\n`);
      state.error = state.error || `部分批次失败: ${e.message}`;
      continue;
    }

    for (let i = 0; i < results.length; i++) {
      if (results[i]) fileHashes.push(results[i]);
    }
  }

  // Clean up pool after all hashing is done
  await pool.terminate();

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
