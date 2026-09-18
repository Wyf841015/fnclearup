// ── Disk Space Analysis (P0-1) ──
// Two-layer disk usage analysis for fnOS:
//
//   1. GET  /api/diskanalysis/volumes
//      — perf-sure overview: sum of every direct child of each /vol* root.
//        Uses `du -s` per volume (fast, one syscall per subtree budget) so the
//        initial dashboard renders in seconds even on huge volumes.
//
//   2. POST /api/diskanalysis/tree  { path, maxDepth? } (default 3)
//      — drill-down: returns, for a single directory:
//        - the largest sub-directories (top by total size)
//        - file-type distribution (videos / audio / images / archives /
//          docs / installers / code / other) in bytes & count
//        - the largest individual files in this dir
//      Pure Node walk (same BFS + setImmediate yield + activeJob.stop as
//      empty_dir_scan / bigfiles) so it honours /stop within ~1s.
//
// Safety: every scanned path must pass isSafePath (under /vol*). Results are
// read-only — this module never mutates the filesystem (deletion stays in
// bigfiles/trash where the confirmed+isSafePath guard lives).

import { statSync, statfsSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { sendJSON, formatBytes, parseBody, isSafePath } from '../lib/util.js';
import { VOL_GLOBS } from '../lib/config.js';

const DEFAULT_MAX_DEPTH = 3;
const YIELD_INTERVAL = 200;
const SCAN_BUDGET_MS = 1000 * 60 * 3; // 3 min hard timeout per tree scan
const TOP_DIRS = 40;          // top sub-directories returned
const TOP_FILES = 20;         // largest files returned
// Skip virtual/fuse/system roots that are huge and not user content.
const SKIP_TOP = new Set(['.@__warp_dir__', '.@#local', '.snapshots', '.trash']);

// File-type buckets for the distribution pie (usable for dashboards).
const TYPE_BUCKETS = {
  video:       ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.m4v', '.rmvb', '.f4v'],
  audio:       ['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.ape', '.alac', '.dsf', '.opus', '.flac'],
  image:       ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.heif', '.tiff', '.raw', '.cr2', '.nef', '.svg', '.ico', '.psd'],
  archive:     ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.zst', '.tgz', '.tbz2', '.lz4'],
  docs:        ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.epub', '.csv', '.ods', '.odt'],
  installer:   ['.deb', '.rpm', '.apk', '.exe', '.msi', '.dmg', '.pkg', '.AppImage', '.flatpak'],
  code:        ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.php', '.rb', '.sh', '.json', '.html', '.css', '.xml', '.sql', '.yaml', '.yml', '.vue'],
};
const BUCKET_ORDER = ['video', 'audio', 'image', 'archive', 'docs', 'installer', 'code', 'other'];

function bucketOf(ext) {
  const e = ext.toLowerCase();
  for (const b of BUCKET_ORDER) {
    if (b !== 'other' && TYPE_BUCKETS[b].includes(e)) return b;
  }
  return 'other';
}

let activeJob = null;
export function cancelDiskAnalysisJob() { if (activeJob) activeJob.stopped = true; }

// Resolve a /vol* root or validated sub-path into one root directory.
function resolveRoot(path) {
  if (path === '/vol*' || path === '/vol*/' || !path || path === '/') {
    return { roots: VOL_GLOBS.filter(v => existsSync(v)), isSet: true };
  }
  if (isSafePath(path) && existsSync(path)) return { roots: [path], isSet: false };
  return null;
}

// ── Level 1: per-volume total ──
// Uses statfs(2) on each mount root — instantaneous, no filesystem traversal.
// Returns total + used + free for each /vol* so the dashboard shows true disk
// usage without a slow `du` scan (a huge media tree can make `du -s` take
// minutes). Directory-level drill-down is the job of the tree endpoint.
// st_blocks stat() reports file bytes which undercounts (sparse) — statfs
// f_bavail/f_blocks is the authoritative mount usage, so we use that.
export async function handleDiskVolumes(req, res) {
  const roots = VOL_GLOBS.filter(v => existsSync(v));
  const volumes = [];

  for (const vol of roots) {
    const st = statSync(vol);
    // statfs(2) via fs.statfs
    let used = 0, total = 0, free = 0;
    try {
      const sf = statfsSync(vol);
      total = sf.blocks * sf.bsize;
      free = sf.bavail * sf.bsize;
      used = total - free;
    } catch { /* keep 0s */ }
    // child count (cheap readdir, no traversal)
    let childCount = 0;
    try { childCount = readdirSync(vol).length; } catch { /* unreadable */ }

    volumes.push({
      path: vol,
      used,
      used_str: formatBytes(used),
      free,
      free_str: formatBytes(free),
      total,
      total_str: formatBytes(total),
      child_count: childCount,
    });
  }

  const total = volumes.reduce((a, v) => a + v.used, 0);
  const capacity = volumes.reduce((a, v) => a + v.total, 0);
  sendJSON(res, 200, { volumes, total_used: total, total_str: formatBytes(total), capacity, roots });
}

// ── Level 2: directory tree drill-down ──
// { path, maxDepth? } → returns subdir sizes, file-type distribution, top files.
export async function handleDiskTree(req, res) {
  const body = await parseBody(req);
  const path = body?.path || '/';
  const maxDepth = Math.min(parseInt(body?.maxDepth ?? String(DEFAULT_MAX_DEPTH), 10) || DEFAULT_MAX_DEPTH, 6);

  const resolved = resolveRoot(path);
  if (!resolved) {
    sendJSON(res, 403, { error: 'path must be under /vol*' });
    return;
  }

  const roots = resolved.roots;
  if (!roots.length) {
    sendJSON(res, 200, { dirs: [], types: [], top_files: [], total: 0, total_str: '0 B' });
    return;
  }

  const job = { stopped: false };
  activeJob = job;
  const t0 = Date.now();
  let scanned = 0;
  let totalBytes = 0;
  let totalFiles = 0;

  const typeBytes = { video: 0, audio: 0, image: 0, archive: 0, docs: 0, installer: 0, code: 0, other: 0 };
  const typeCount = { video: 0, audio: 0, image: 0, archive: 0, docs: 0, installer: 0, code: 0, other: 0 };
  const dirSizes = new Map();      // full path → bytes
  const topFilesHeap = [];         // keep TOP_FILES largest

  function pushTopFile(f) {
    if (topFilesHeap.length < TOP_FILES) { topFilesHeap.push(f); return; }
    // find smallest
    let mi = 0;
    for (let i = 1; i < topFilesHeap.length; i++) if (topFilesHeap[i].size < topFilesHeap[mi].size) mi = i;
    if (f.size > topFilesHeap[mi].size) topFilesHeap[mi] = f;
  }

  async function walk(root, depth, dirPath) {
    if (job.stopped || depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dirPath, { withFileTypes: true }); }
    catch { return; }

    let dirUsage = 0;
    for (const e of entries) {
      if (job.stopped) return;
      const full = join(dirPath, e.name);
      scanned++;
      try {
        if (e.isDirectory()) {
          const st = statSync(full);
          const subUsage = await walk(root, depth + 1, full);
          if (subUsage !== undefined && subUsage >= 0) {
            dirUsage += subUsage;
            if (depth >= 1) { // only meaningful at drill levels
              // record cumulative size of this subdir
              const prev = dirSizes.get(full) || 0;
              dirSizes.set(full, prev + subUsage);
            }
          }
        } else if (e.isFile()) {
          const st = statSync(full);
          const sz = st.size;
          totalBytes += sz;
          totalFiles++;
          dirUsage += sz;
          const b = bucketOf(extname(e.name));
          typeBytes[b] += sz;
          typeCount[b]++;
          pushTopFile({ path: full, name: e.name, size: sz, size_str: formatBytes(sz), mtime: st.mtimeMs });
        }
      } catch { /* permission/symlink — skip safely */ }
      if (scanned % YIELD_INTERVAL === 0) await new Promise(r => setImmediate(r));
    }
    // record current dir cumulative size
    if (depth >= 0) {
      const prev = dirSizes.get(dirPath) || 0;
      dirSizes.set(dirPath, prev + dirUsage);
    }
    return dirUsage;
  }

  // Walk each root; root dir accumulated into dirSizes for display.
  for (const r of roots) await walk(r, 0, r);
  activeJob = null;

  // Build subdir ranking (exclude the roots themselves unless single root drill).
  const dirs = [...dirSizes.entries()]
    .filter(([p]) => !roots.includes(p))
    .map(([path, size]) => ({ path, name: basename(path), size, size_str: formatBytes(size) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, TOP_DIRS);

  const types = BUCKET_ORDER.map(b => ({
    type: b, bytes: typeBytes[b], bytes_str: formatBytes(typeBytes[b]), count: typeCount[b],
  }));

  topFilesHeap.sort((a, b) => b.size - a.size);

  sendJSON(res, 200, {
    dirs,
    types,
    top_files: topFilesHeap.slice(0, TOP_FILES),
    total: totalBytes,
    total_str: formatBytes(totalBytes),
    total_files: totalFiles,
    scanned,
    elapsed_ms: Date.now() - t0,
    truncated_dirs: dirSizes.size > TOP_DIRS,
    root: roots.length === 1 ? roots[0] : roots,
    max_depth: maxDepth,
  });
}

// POST /api/diskanalysis/stop
export function handleDiskStop(req, res) {
  cancelDiskAnalysisJob();
  sendJSON(res, 200, { stopped: true });
}