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
import { profileFor } from './storage_profile.js';
import { buildMatcher } from './exclude_rules.js';

const MUSIC_EXTS = new Set(['.mp3','.flac','.wav','.aac','.ogg','.m4a','.wma','.alac','.ape','.dsf']);
const POLL_MS = 1000;
// 哈希并发度按介质动态推导 (P0, 2026-09-30): 原为固定 4。
// 本机双核 + 机械盘 RAID1, 固定 4 既超订 CPU 又造成寻道竞争。
let WORKER_COUNT = 4;      // main() 内按 storage_profile 覆盖
const PARTIAL_BYTES = 4096;   // 仅作小文件快速路径的参考值, 实际值见 dup_hash_worker.js

// ── P0-2: 快照路径识别 ──
// btrfs 快照（含 fnOS 的自动快照）与主卷共享同一批 extent，快照里的"重复文件"
// 删除后并不释放空间。把它们算进"可释放"会让用户删完发现 df 毫无变化。
// 只做路径判断，不依赖 btrfs 命令（无需 root，任何文件系统都安全）。
const SNAPSHOT_MARKERS = [
  '/.snapshots/', '/@snapshots/', '/.snapshot/',
  '/@snapshot/', '/snapshots/', '/__snapshot__/',
  '/.@#local/snapshot/', '/.recycle_snapshots/',
];
function isSnapshotPath(p) {
  const s = '/' + String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const lower = s.toLowerCase();
  for (const m of SNAPSHOT_MARKERS) {
    if (lower.includes(m)) return true;
  }
  return false;
}

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
  const storageProfile = profileFor(scanPaths);
  WORKER_COUNT = storageProfile.poolSize;
  process.stderr.write(
    `[dup_scan] 哈希并发度=${WORKER_COUNT} · ${storageProfile.reason}\n`
  );
  let minSize = parseInt(minSizeRaw, 10);
  if (!Number.isFinite(minSize) || minSize < 0) minSize = 0;   // 0 = no min-size filter
  const keepMode = keepModeRaw || 'first';   // first | newest | deepest (which file to KEEP per group)
  if (!['music', 'files'].includes(scanType)) { process.stderr.write(`Invalid scan_type: ${scanType}`); process.exit(1); }
  if (scanPaths.length === 0) { process.stderr.write('No paths provided\\n'); process.exit(1); }
  mkdirSync(stateDir, { recursive: true });

  // P1-1: 排除规则。@appcenter/@appdata/node_modules/.git 等目录既拖慢扫描,
  // 发现的"重复文件"又多半是各应用共用的 LICENSE/图标, 对用户没有清理价值。
  const isExcluded = buildMatcher(stateDir);
  let excludedCount = 0;

  let state = {
    id: jobId, scanType, rootPaths: scanPaths,
    storageProfile,
    status: 'counting',
    progress: { total: 0, processed: 0, currentFile: '' },
    files: [], duplicates: [],
    stats: { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0, cacheHits: 0, hashed: 0, cacheHitRate: 0, partialSkipped: 0, sizeSkipped: 0, excluded: 0 },
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
        // P1-1: 命中排除规则直接跳过(目录整棵剪掉, 省掉后续 stat 开销)
        if (isExcluded(fp, e.isDirectory())) { excludedCount++; continue; }
        if (e.isDirectory()) walk(fp);
        else if (e.isFile()) {
          if (scanType === 'music' && !MUSIC_EXTS.has(extname(e.name).toLowerCase())) continue;
          let st;
          try { st = statSync(fp); } catch { continue; }
          if (minSize > 0 && st.size < minSize) continue;   // min-size filter
          // P0-1/P0-2: 采集 nlink/ino/dev 与"是否位于快照内"。
          //  - (dev,ino) 相同 = 同一 inode 的多个硬链接，删其中一个不释放任何空间
          //  - nlink > 1     = 还有别的硬链接指向同一数据块，删它同样不释放空间
          //  - 快照副本      = btrfs 快照与主卷共享 extent，报"可释放"是假账
          allFiles.push({
            path: fp, size: st.size, mtimeMs: st.mtimeMs,
            nlink: st.nlink || 1, ino: st.ino, dev: st.dev,
            snapshot: isSnapshotPath(fp),
          });
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

  // P0-1/P0-2: 把 stat 采集到的硬链接/快照信息按路径索引起来。
  // 后续 partial → full → group 各阶段都会重建精简对象（只带 path/size/hash），
  // 用这个 Map 在最后算账时补齐真实的可释放空间。
  const metaByPath = new Map();
  let snapshotFileCount = 0, hardlinkedFileCount = 0;
  for (const f of allFiles) {
    metaByPath.set(f.path, { nlink: f.nlink || 1, ino: f.ino, dev: f.dev, snapshot: !!f.snapshot });
    if (f.snapshot) snapshotFileCount++;
    if ((f.nlink || 1) > 1) hardlinkedFileCount++;
  }

  const skippedCount = allFiles.length - candidates.length;
  if (skippedCount > 0) state.stats.sizeSkipped = skippedCount;
  // P1-1: 记录被排除规则跳过的条目数与实际收集到的文件数
  state.stats.excluded = excludedCount;
  state.stats.scanned = allFiles.length;
  state.progress.currentFile = `大小预分组完成: ${allFiles.length}→${candidates.length} 个候选 (${skippedCount} 个唯一大小已跳过)`;
  writeState(stateDir, jobId, state);

  if (!candidates.length) {
    state.status = 'complete';
    state.duplicates = [];
    state.stats = { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0, cacheHits: 0, hashed: 0, cacheHitRate: 0, partialSkipped: 0, sizeSkipped: state.stats.sizeSkipped || 0 };
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
  // P2 缓存/预筛可观测性: 让用户看到"这次省了多少磁盘读取"
  state.stats.partialSkipped = Math.max(0, candidates.length - needFull.length);
  state.stats.candidates = candidates.length;
  state.progress.currentFile = `部分哈希预筛完成: ${candidates.length}→${needFull.length} 个需全量哈希`;
  writeState(stateDir, jobId, state);

  if (!needFull.length) {
    await pool.terminate();
    state.status = 'complete';
    state.duplicates = [];
    state.stats = { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0, cacheHits: 0, hashed: 0, cacheHitRate: 0, partialSkipped: 0, sizeSkipped: state.stats.sizeSkipped || 0 };
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
  state.stats.cacheHits = cacheHits.length;
  state.stats.hashed = toHash.length;
  state.stats.cacheHitRate = (cacheHits.length + toHash.length)
    ? Math.round(cacheHits.length / (cacheHits.length + toHash.length) * 100) : 0;
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
  // P0-1/P0-2 汇总量：让界面能解释"为什么算出来的可释放比文件总大小小"
  let hardlinkSaving = 0;      // 因硬链接而无法释放的字节
  let snapshotSaving = 0;      // 因快照共享而无法释放的字节
  let meta = { hardlinked: hardlinkedFileCount || 0, snapshot: snapshotFileCount || 0 };

  for (const [hash, files] of groups) {
    if (files.length >= 2) {
      // Smart keep: order files so files[0] is the file to KEEP (never deleted).
      // P0-2 修正: 快照副本绝不能当"保留的那份" —— 否则会建议删除主卷原文件，
      // 而删掉主卷后快照里那份是历史状态，等于丢数据。所以先把候选按
      // 「非快照优先」分层，再在各层内应用 keepMode。
      const isSnap = (f) => {
        const m = metaByPath.get(f.path);
        return !!(m && m.snapshot);
      };
      const nonSnapFiles = files.filter(f => !isSnap(f));
      // 全组都在快照里 → 没有"真实"副本可保留，整组不产生可释放空间（下面会处理）
      const keepCandidates = nonSnapFiles.length ? nonSnapFiles : files;
      let kept;
      if (keepMode === 'newest') {
        kept = keepCandidates.slice().sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
      } else if (keepMode === 'deepest') {
        kept = keepCandidates.slice().sort((a, b) => b.path.split('/').length - a.path.split('/').length)[0];
      } else {
        kept = keepCandidates.slice().sort((a, b) => a.path.localeCompare(b.path))[0];
      }
      const rest = files.filter(f => f.path !== kept.path)
        .sort((a, b) => a.path.localeCompare(b.path));
      const ordered = [kept, ...rest];

      // ── P0-1/P0-2: 真实可释放空间 ──
      // 旧实现 `rest.reduce((s,f) => s + f.size)` 假设"删掉一个副本 = 省一份大小"，
      // 这在两种情况下是假账：
      //   ① 硬链接：组内多个路径指向同一 inode（或 nlink>1 说明组外还有链接），
      //      删掉其中一个后数据块仍被引用，实际释放 0 字节
      //   ② btrfs 快照：快照与主卷共享 extent，删快照里的副本同样不释放空间
      // 判定方法：对该 inode 计算「组内副本数」与「内核 nlink」的较大值即总引用数，
      // 删掉这一个后若仍剩 ≥1 个引用 → 数据块不会释放。
      const inodeRefs = new Map();   // "dev:ino" → 组内出现次数
      for (const f of files) {
        const m = metaByPath.get(f.path);
        if (m && m.ino !== undefined && m.ino !== null) {
          const k = `${m.dev}:${m.ino}`;
          inodeRefs.set(k, (inodeRefs.get(k) || 0) + 1);
        }
      }

      let wasted = 0;
      let reclaimable = 0;
      let groupHardlinkBlocked = 0;
      let groupSnapshotBlocked = 0;
      for (const f of rest) {
        const m = metaByPath.get(f.path) || { nlink: 1, snapshot: false };
        const k = (m.ino !== undefined && m.ino !== null) ? `${m.dev}:${m.ino}` : null;
        const inGroup = k ? (inodeRefs.get(k) || 1) : 1;
        const totalRefs = Math.max(inGroup, Number(m.nlink) || 1);
        const remainingRefs = totalRefs - 1;      // 删掉这一个之后的剩余引用数

        if (m.snapshot) {
          // 快照副本：删除不释放空间（与主卷共享 extent），且不应被建议删除
          groupSnapshotBlocked += f.size || 0;
          continue;
        }
        if (remainingRefs >= 1) {
          // 还有硬链接指向同一数据块 → 删这份不省空间
          groupHardlinkBlocked += f.size || 0;
          continue;
        }
        wasted += f.size || 0;
        reclaimable += 1;
      }
      hardlinkSaving += groupHardlinkBlocked;
      snapshotSaving += groupSnapshotBlocked;

      const hasSnapshotMember = files.some(f => {
        const m = metaByPath.get(f.path);
        return m && m.snapshot;
      });
      const hasHardlinkMember = files.some(f => {
        const m = metaByPath.get(f.path);
        return m && (Math.max(inodeRefs.get(`${m.dev}:${m.ino}`) || 1, Number(m.nlink) || 1) > 1);
      });

      duplicates.push({
        hash, count: ordered.length, files: ordered, wasted, keepMode,
        // P0 附加信息：界面用来解释"为什么可释放比总大小少"
        reclaimableFiles: reclaimable,
        hardlinkBlocked: groupHardlinkBlocked,
        snapshotBlocked: groupSnapshotBlocked,
        hasSnapshot: hasSnapshotMember,
        hasHardlink: hasHardlinkMember,
        // 附带每个文件的硬链接/快照标记，供前端逐条展示
        fileMeta: ordered.map(f => {
          const m = metaByPath.get(f.path) || {};
          const k2 = (m.ino !== undefined && m.ino !== null) ? `${m.dev}:${m.ino}` : null;
          return {
            path: f.path,
            nlink: Number(m.nlink) || 1,
            snapshot: !!m.snapshot,
            shared: k2 ? ((inodeRefs.get(k2) || 1) > 1 || (Number(m.nlink) || 1) > 1) : false,
          };
        }),
      });
      dupFiles += ordered.length;
      wastedBytes += wasted;
    }
  }
  duplicates.sort((a, b) => b.wasted - a.wasted);


  state.status = 'complete';
  state.files = fileHashes;
  state.duplicates = duplicates;
  state.stats.totalFiles = fileHashes.length;
  state.stats.duplicateGroups = duplicates.length;
  state.stats.duplicateFiles = dupFiles;
  state.stats.wastedBytes = wastedBytes;
  // P0-1/P0-2: 解释性字段 —— 界面据此说明"报告的可释放空间已扣除硬链接/快照"
  state.stats.hardlinkBlockedBytes = hardlinkSaving;
  state.stats.snapshotBlockedBytes = snapshotSaving;
  state.stats.hardlinkedFiles = meta.hardlinked;
  state.stats.snapshotFiles = meta.snapshot;
  state.stats.hashed = toHash.length;
  state.stats.cacheHits = cacheHits.length;
  state.stats.cacheHitRate = (cacheHits.length + toHash.length)
    ? Math.round(cacheHits.length / (cacheHits.length + toHash.length) * 100) : 0;
  writeState(stateDir, jobId, state);
}

main().catch(e => {
  process.stderr.write(`dup_scan fatal: ${e}\n`);
  process.exit(1);
});
