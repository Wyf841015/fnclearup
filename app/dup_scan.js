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
const PARTIAL_BYTES = 4096;
const HASH_CACHE_FILE = 'dup_hash_cache.json';   // key: path → {size, mtimeMs, hash, ext, id3}

// ── Hash cache (persistent across runs, mirrors jdupes -y/--hash-db) ──
// Remembers (path → size+mtime+hash) so repeat scans skip hashing files that
// haven't changed. Falls back gracefully if corrupt/missing.
function loadHashCache(stateDir) {
  try {
    const raw = readFileSync(join(stateDir, HASH_CACHE_FILE), 'utf-8');
    const obj = JSON.parse(raw);
    return (obj && obj.files && typeof obj.files === 'object') ? obj.files : {};
  } catch { return {}; }
}
function saveHashCache(stateDir, files) {
  try {
    const tmp = join(stateDir, HASH_CACHE_FILE + '.tmp');
    writeFileSync(tmp, JSON.stringify({ version: 1, files }));
    renameSync(tmp, join(stateDir, HASH_CACHE_FILE));
  } catch (e) { process.stderr.write(`saveHashCache error: ${e}\n`); }
}

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
          if (breakCounter > 20) { state._paused = false; writeState(stateDir, jobId, state); return true; }
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
  if (args.length < 4) { process.stderr.write('Usage: node dup_scan.js <scan_type> <scan_paths> <job_id> <state_dir>\\n'); process.exit(1); }

  const [scanType, scanPathsRaw, jobId, stateDir, minSizeRaw, keepModeRaw] = args;
  const scanPaths = scanPathsRaw.split(',').map(p => p.trim()).filter(Boolean);
  let minSize = parseInt(minSizeRaw, 10);
  if (!Number.isFinite(minSize) || minSize < 0) minSize = 0;   // 0 = no min-size filter
  const keepMode = keepModeRaw || 'first';   // first | newest | deepest (which file to KEEP per group)
  if (!['music', 'files'].includes(scanType)) { process.stderr.write(`Invalid scan_type: ${scanType}`); process.exit(1); }
  if (scanPaths.length === 0) { process.stderr.write('No paths provided\\n'); process.exit(1); }
  mkdirSync(stateDir, { recursive: true });

  let state = {
    id: jobId, scanType, rootPaths: scanPaths,
    status: 'counting',
    progress: { total: 0, processed: 0, currentFile: '' },
    files: [], duplicates: [],
    stats: { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 },
    error: null, startTime: Date.now(),
    _aborted: false, _paused: false, _prev_status: 'counting',
  };

  for (const sp of scanPaths) {
    if (!existsSync(sp)) {
      state.status = 'error';
      state.error = `目录不存在: ${sp}`;
      writeState(stateDir, jobId, state);
      process.exit(1);
    }
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
          if (minSize > 0 && st.size < minSize) continue;   // min-size filter
          allFiles.push({ path: fp, size: st.size, mtimeMs: st.mtimeMs });
          state.progress.total = allFiles.length;
          state.progress.currentFile = e.name;
          if (allFiles.length % 50 === 0) writeState(stateDir, jobId, state);
        }
      }
    };
    for (const sp of scanPaths) walk(sp);
  } catch (e) { state.status = 'error'; state.error = e.message; writeState(stateDir, jobId, state); return; }

  if (!allFiles.length) {
    state.status = 'complete';
    state.progress.currentFile = '未找到匹配文件';
    writeState(stateDir, jobId, state);
    return;
  }

  // Phase 1.5: group by file size — only hash files where ≥2 share the same size
  const sizeMap = new Map();   // size → {path, size, mtimeMs}[]
  for (const f of allFiles) {
    if (!sizeMap.has(f.size)) sizeMap.set(f.size, []);
    sizeMap.get(f.size).push(f);
  }
  // Files that share a size with ≥1 other file are *candidates* (may still be
  // excluded later by partial-hash pre-filter or hash-cache reuse).
  const candidates = [];
  for (const [size, group] of sizeMap) {
    if (group.length >= 2) candidates.push(...group);
  }
  const skippedCount = allFiles.length - candidates.length;
  state.progress.currentFile = `大小预分组完成: ${allFiles.length}→${candidates.length} 个候选 (${skippedCount} 个唯一大小已跳过)`;
  writeState(stateDir, jobId, state);

  if (!candidates.length) {
    state.status = 'complete';
    state.duplicates = [];
    state.stats = { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 };
    writeState(stateDir, jobId, state);
    return;
  }

  const pool = getHashPool(WORKER_COUNT);

  // ── Phase 1.6: partial-hash pre-filter (jdupes partial-hash exclusion step) ──
  // Hash only the first 4096 bytes of each candidate. Files whose headers differ
  // cannot be duplicates (for identical content the headers are identical), so we
  // reject them BEFORE paying for a full read. Group survivors by size+partial;
  // only a group with ≥2 matching headers advances to full hashing.
  state.status = 'hashing';
  state._prev_status = 'hashing';
  state.progress.currentFile = '部分哈希预筛 (仅读文件头部)...';
  state.progress.total = candidates.length;
  state.progress.processed = 0;
  writeState(stateDir, jobId, state);

  const partialResults = {};
  const batchesPartial = [];
  const PB = WORKER_COUNT * 10;   // 40 files per partial batch (fast, tiny reads)
  for (let b = 0; b < candidates.length; b += PB) {
    batchesPartial.push(candidates.slice(b, b + PB));
  }
  let processed = 0;
  for (const batch of batchesPartial) {
    if (!(await reloadControl(stateDir, jobId, state))) { await pool.terminate(); return; }
    const paths = batch.map(f => f.path);
    let results;
    try {
      results = await pool.hashFiles(paths, { mode: 'partial', onProgress: function() {
        processed++;
        state.progress.processed = Math.min(processed, candidates.length);
        writeState(stateDir, jobId, state);
      }});
    } catch (e) {
      process.stderr.write(`partial batch failed: ${e.message}, skipping\n`);
      state.error = state.error || `部分哈希预筛批次失败: ${e.message}`;
      continue;
    }
    for (const r of results) {
      if (r && r.partial) partialResults[r.path] = { size: r.size, mtimeMs: r.mtimeMs, partial: r.partial };
    }
  }

  // Group by size+partial; keep only files whose size+header matches ≥2 others.
  const partialMap = new Map();
  for (const [path, r] of Object.entries(partialResults)) {
    const key = r.size + '|' + r.partial;
    if (!partialMap.has(key)) partialMap.set(key, []);
    partialMap.get(key).push({ path, size: r.size, mtimeMs: r.mtimeMs });
  }
  const needFull = [];   // files that survived partial pre-filter
  for (const group of partialMap.values()) {
    if (group.length >= 2) needFull.push(...group);
  }
  state.progress.currentFile = `部分哈希预筛完成: ${candidates.length}→${needFull.length} 个需全量哈希`;
  writeState(stateDir, jobId, state);

  if (!needFull.length) {
    await pool.terminate();
    state.status = 'complete';
    state.duplicates = [];
    state.stats = { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 };
    writeState(stateDir, jobId, state);
    return;
  }

  // ── Phase 2: full hash (with persistent hash-cache reuse, mirrors jdupes -y) ──
  // Files whose (size, mtime) are unchanged since a previous scan are reused from
  // the cache instead of being re-read. Only changed/new files are actually hashed.
  const hashCache = loadHashCache(stateDir);
  const fileHashes = [];

  const toHash = [];          // need fresh full hash
  const cacheHits = [];       // served from cache
  for (const f of needFull) {
    const c = hashCache[f.path];
    if (c && c.size === f.size && c.mtimeMs === f.mtimeMs && c.hash) {
      cacheHits.push({ path: f.path, size: f.size, hash: c.hash, mtimeMs: f.mtimeMs });
    } else {
      toHash.push(f);
    }
  }
  if (cacheHits.length) {
    state.progress.currentFile = `哈希缓存命中: ${cacheHits.length} 个文件跳过读取 (size+mtime 未变)` + (toHash.length ? `，需新哈希 ${toHash.length} 个` : '');
    writeState(stateDir, jobId, state);
  }
  for (const h of cacheHits) fileHashes.push(h);

  state.status = 'hashing';
  state._prev_status = 'hashing';
  state.progress.total = toHash.length;
  state.progress.processed = 0;
  writeState(stateDir, jobId, state);

  const batchSize = WORKER_COUNT * 5; // 20 files per batch for 4 workers
  let hashedCount = 0;
  for (let batchStart = 0; batchStart < toHash.length; batchStart += batchSize) {
    if (!(await reloadControl(stateDir, jobId, state))) {
      await pool.terminate();
      return;
    }
    const batch = toHash.slice(batchStart, batchStart + batchSize);
    const paths = batch.map(f => f.path);
    let results;
    try {
      results = await pool.hashFiles(paths, { onProgress: function(idx, total, filePath, result) {
        hashedCount++;
        if (result && result.error) {
          if (!state.failedFiles) state.failedFiles = [];
          state.failedFiles.push({ path: filePath, error: result.error });
        }
        state.progress.processed = Math.min(hashedCount, toHash.length);
        state.progress.currentFile = filePath;
        state.progress.hashProgress = '';
        writeState(stateDir, jobId, state);
      }, onFileHashProgress: function(filePath, bytesRead, totalSize) {
        const pct = totalSize > 0 ? Math.round((bytesRead / totalSize) * 100) : 0;
        state.progress.currentFile = filePath;
        state.progress.hashProgress = pct + '%';
        writeState(stateDir, jobId, state);
      } });
    } catch (e) {
      process.stderr.write(`batch ${batchStart}-${batchStart + batchSize} failed: ${e.message}, skipping\n`);
      state.error = state.error || `部分批次失败: ${e.message}`;
      continue;
    }
    for (const r of results) {
      if (!r) continue;
      // Update cache for every freshly hashed file (so future runs skip it)
      if (r.hash) {
        const cExt = r.ext || ''; const cId3 = r.id3 || null;
        hashCache[r.path] = { size: r.size, mtimeMs: r.mtimeMs, hash: r.hash, ext: cExt, id3: cId3 };
        fileHashes.push({ path: r.path, size: r.size, hash: r.hash, mtimeMs: r.mtimeMs });
      }
    }
  }

  // Clean up pool after all hashing is done
  await pool.terminate();

  // Persist cache so next run skips unchanged files (best-effort)
  saveHashCache(stateDir, hashCache);

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
      // Smart keep: order files so files[0] is the file to KEEP (never deleted).
      // first   = path sort ascending → keep lowest path (backwards compatible)
      // newest  = keep the most recently modified file
      // deepest = keep the file with the deepest path (most likely the intentional copy)
      let kept;
      if (keepMode === 'newest') {
        kept = files.slice().sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
      } else if (keepMode === 'deepest') {
        kept = files.slice().sort((a, b) => b.path.split('/').length - a.path.split('/').length)[0];
      } else {
        kept = files.slice().sort((a, b) => a.path.localeCompare(b.path))[0];
      }
      const rest = files.filter(f => f.path !== kept.path)
        .sort((a, b) => a.path.localeCompare(b.path));
      const ordered = [kept, ...rest];
      const wasted = rest.reduce((s, f) => s + (f.size || 0), 0);
      duplicates.push({ hash, count: ordered.length, files: ordered, wasted, keepMode });
      dupFiles += ordered.length;
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
