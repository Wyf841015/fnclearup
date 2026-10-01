#!/usr/bin/env node
/**
 * simdup_scan.js — Similar image/video detection worker for FnClearup (P0-2).
 * Launched as a subprocess by server.js (process isolation, no server blocking).
 *
 * Usage: node simdup_scan.js <type> <scan_path> <job_id> <state_dir> <threshold>
 *   type     : 'image' | 'video'
 *   scan_path: comma-separated roots (only /vol* via isSafePath enforced by caller)
 *   job_id   : simdup_<rand>
 *   state_dir: PKGVAR/data/dup (writes simdup_<job_id>.json)
 *   threshold: hamming threshold (default 10) — lower = stricter
 *
 * Pipeline per type:
 *   image: walk dirs → collect image files → dHash each (ffmpeg, ~50-150ms) →
 *          cluster by hamming distance ≤ threshold → emit groups
 *   video: walk dirs → collect video files → extract 3-frame dHashes →
 *          cluster by best frame-wise distance
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { dHashOfFile, videoDHashes, hamming } from './simhash.js';

const POLL_MS = 1000;
const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif', '.tiff'];
const VID_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.rmvb'];
const MAX_FILES = 4000;      // safety cap — hashing is per-file ffmpeg
const YIELD = 200;

const [type, scanPathsRaw, jobId, stateDir, thresholdRaw] = process.argv.slice(2);
const threshold = parseInt(thresholdRaw || '10', 10) || 10;
const scanPaths = scanPathsRaw.split(',').map(s => s.trim()).filter(Boolean);

let runningCount = 0;   // for progress (files processed)
let totalCandidates = 0;
const hashes = [];      // { path, size, hash|hashes[], mtime }

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
      state._paused = true; state.status = 'paused';
      writeState(state);
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

// Walk a root, collect files of matching extension (respect cap).
function collect(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return true;
    const full = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        if (collect(full, out)) return true;
      } else if (e.isFile()) {
        const st = statSync(full);
        const ex = extname(e.name).toLowerCase();
        if (type === 'image' && IMG_EXTS.includes(ex)) out.push({ path: full, size: st.size, mtime: st.mtimeMs });
        else if (type === 'video' && VID_EXTS.includes(ex)) out.push({ path: full, size: st.size, mtime: st.mtimeMs });
      }
    } catch { /* skip permission/special */ }
  }
  return out.length >= MAX_FILES;
}

// Union-find cluster based on hamming distance. O(n²) worst; for ≤4000 with
// early cutoff it's acceptable (~caps, greedy pairwise compare).
// P1-2: 计算两个条目的感知距离。与 cluster() 内的判定保持完全一致:
//   image -> dHash 汉明距离; video -> 各抽帧组合的最小距离。
// 之前这个值只在聚类内部用完就丢, 导致界面上"这两张图相似"却看不出有多相似。
function pairDist(a, b) {
  if (type === 'image') {
    if (a.hash == null || b.hash == null) return null;
    return hamming(a.hash, b.hash);
  }
  const av = a.hashes || [], bv = b.hashes || [];
  if (!av.length || !bv.length) return null;
  let best = Infinity;
  for (const x of av) for (const y of bv) {
    if (x == null || y == null) continue;
    const d = hamming(x, y);
    if (d < best) best = d;
  }
  return best === Infinity ? null : best;
}

// 取组内最相似的若干对, 供界面展示"哪两个最像"
const MAX_PAIRS = 5;
function topPairs(g) {
  const pairs = [];
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 1; j < g.length; j++) {
      const d = pairDist(g[i], g[j]);
      if (d != null) pairs.push({ a: g[i].path, b: g[j].path, dist: d });
    }
  }
  pairs.sort((x, y) => x.dist - y.dist);
  return { pairs: pairs.slice(0, MAX_PAIRS), minDist: pairs.length ? pairs[0].dist : null };
}

function cluster(items) {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

  for (let i = 0; i < n; i++) {
    if (items[i]._skip) continue;
    for (let j = i + 1; j < n; j++) {
      if (items[j]._skip) continue;
      if (type === 'image') {
        if (items[i].hash !== null && items[j].hash !== null && hamming(items[i].hash, items[j].hash) <= threshold) union(i, j);
      } else {
        // video: distance = min over frame pairs
        if (items[i].hashes.length && items[j].hashes.length) {
          let best = Infinity;
          for (const a of items[i].hashes) for (const b of items[j].hashes) {
            const d = hamming(a.hash, b.hash); if (d < best) best = d;
          }
          if (best <= threshold) union(i, j);
        }
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(items[i]);
  }
  return [...groups.values()].filter(g => g.length >= 2);
}

const state = {
  id: jobId, type, rootPaths: scanPaths, threshold,
  status: 'counting', progress: { total: 0, processed: 0, currentFile: '' },
  files: [], groups: [], stats: { totalFiles: 0, groups: 0, files: 0 }, error: null,
  startTime: Date.now(), _aborted: false, _paused: false,
};
writeState(state);

(async () => {
  // Phase 1: collect
  const files = [];
  for (const rp of scanPaths) if (existsSync(rp)) collect(rp, files);
  totalCandidates = files.length;
  state.status = 'hashing';
  state.progress.total = files.length;
  writeState(state);
  if (!totalCandidates) {
    state.status = 'done'; state.stats = { totalFiles: 0, groups: 0, files: 0 }; writeState(state);
    process.exit(0);
  }

  // Phase 2: hash
  for (const f of files) {
    if (state._aborted) break;
    if (!await reloadControl(state)) break;
    state.progress.currentFile = f.path;
    state.progress.processed++;
    try {
      if (type === 'image') {
        const h = await dHashOfFile(f.path);
        hashes.push({ ...f, hash: h });
      } else {
        const hs = await videoDHashes(f.path, 3);
        hashes.push({ ...f, hashes: hs });
      }
    } catch { hashes.push({ ...f, hash: null, hashes: [] }); }
    if (state.progress.processed % 20 === 0) writeState(state);
  }

  // Phase 3: cluster
  state.status = 'clustering';
  writeState(state);
  const groups = cluster(hashes);
  const keptFiles = groups.flat().length;
  const wasted = groups.reduce((s, g) => s + g.reduce((a, f) => a + (f.size || 0), 0) - Math.max(...g.map(f => f.size || 0)), 0);

  state.status = 'done';
  state.groups = groups.map((g, i) => {
    const tp = topPairs(g);
    return {
      group: i + 1,
      size: g.reduce((a, f) => a + (f.size || 0), 0),
      // P1-2: 组内最相似的一对距离 + 最近若干对明细
      minDist: tp.minDist,
      pairs: tp.pairs,
      files: g.map((f, fi) => {
        // 该文件与组内其他文件的最小距离(越小越像)
        let md = null;
        for (let j = 0; j < g.length; j++) {
          if (j === fi) continue;
          const d = pairDist(f, g[j]);
          if (d != null && (md === null || d < md)) md = d;
        }
        return { path: f.path, name: f.path.split('/').pop(), size: f.size,
                 size_str: (f.size / 1048576).toFixed(1) + ' MB',
                 hash: f.hash?.toString() || null, minDist: md };
      }),
    };
  });
  // P1-2: 最像的组排前面(距离越小越像); 无距离数据的组按原序排在末尾
  state.groups.sort((a, b) => {
    if (a.minDist == null && b.minDist == null) return a.group - b.group;
    if (a.minDist == null) return 1;
    if (b.minDist == null) return -1;
    return a.minDist - b.minDist || a.group - b.group;
  });
  state.stats = {
    totalFiles: totalCandidates,
    groups: groups.length,
    files: keptFiles,
    wastedBytes: wasted,
    threshold,
    // P1-2: 全部组里最相似的一对距离
    bestDist: state.groups.reduce((m, g) => (g.minDist != null && (m === null || g.minDist < m)) ? g.minDist : m, null),
  };
  writeState(state);
  process.exit(0);
})();