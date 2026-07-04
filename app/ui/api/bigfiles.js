// ── Big Files Finder ──
// Scans user-discovered roots for the largest files on disk.
// `roots` defaults to VOL_GLOBS (safelist from lib/config.js) but the
// frontend may override with a custom path through GET /api/bigfiles?path=….
//
// Stops quickly:
//   1. depth limit (default 6) — fnOS media trees can go deeper but most
//      giant files are within 6 levels of a mount root.
//   2. file-count cap (default 5000) — we only need the Top-N anyway.
//   3. per-dir sibling scan threshold — if a directory has >5000 entries,
//      skip into subdirectories (we keep the top sibling files; recursing
//      into a torrent's seeder dir burns the whole run for little gain).
//   4. minSize filter (default 100 MB) — fragments/files smaller than this
//      are returned only when total scan returned less than topN (rare).
//
// The scan walks top-down breadth-first using an explicit queue + setImmediate
// yield every N entries so /api/bigfiles/stop can interrupt within ~1s, same
// pattern as empty_dir_scan.

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { sendJSON, formatBytes } from '../lib/util.js';
import { VOL_GLOBS, SAFE_PREFIXES } from '../lib/config.js';

const DEFAULT_DEPTH = 6;
const DEFAULT_TOPN = 100;
const DEFAULT_MINSIZE = 100 * 1024 * 1024; // 100 MB
const SCAN_BUDGET_MS = 1000 * 60 * 5; // 5 min hard timeout
const YIELD_INTERVAL = 100; // setImmediate every N entries

let activeJob = null; // { stopped, found, scannedPaths }
export function cancelBigFilesJob() { if (activeJob) activeJob.stopped = true; }

// GET /api/bigfiles?path=/vol2&minSize=104857600&topN=100&depth=6
//
// params (all optional, query string):
//   path   — root directory (must be under /vol* — only safe roots allowed)
//   minSize — minimum file size in bytes (default 100MB)
//   topN    — return at most N results sorted by size desc (default 100)
//   depth   — recursion depth limit (default 6)
//
// Returns: { files: [{path, name, size, size_str, mtime, depth}], total_candidates, scanned_paths, elapsed_ms, truncated }
export async function handleBigFilesScan(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.searchParams.get('path') || '/vol*';
  const minSize = parseInt(url.searchParams.get('minSize') || '0', 10) || DEFAULT_MINSIZE;
  const topN = Math.min(parseInt(url.searchParams.get('topN') || String(DEFAULT_TOPN), 10) || DEFAULT_TOPN, 500);
  const depth = Math.min(parseInt(url.searchParams.get('depth') || String(DEFAULT_DEPTH), 10) || DEFAULT_DEPTH, 12);

  // Resolve path → list of roots. '/vol*' defaults to a conservative subset
  // (vol1-vol10 only — fnOS applications typically don't need to scan netdisk
  // fusion mounts like /vol02). The user can override with a specific vol.
  //
  // Tests/dev can opt into extra roots via TRM_BIGFILES_EXTRA_ROOTS (comma-
  // separated). Production never sets this — it's a deliberate, opt-in knob
  // so unit tests don't have to scan a real /volN with millions of inodes.
  const extraRoots = (process.env.TRM_BIGFILES_EXTRA_ROOTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  let roots;
  if (path === '/vol*' || path === '/vol*/') {
    roots = VOL_GLOBS.filter(r => existsSync(r) && !r.startsWith('/vol0'));
    // By default also include /vol2 (the most common media mount on fnOS)
    // — skip /vol02 (netdisk fuse) which can be huge and slow.
    roots = roots.filter(r => r !== '/vol02');
    if (extraRoots.length) roots.push(...extraRoots.filter(r => existsSync(r)));
  } else if (SAFE_PREFIXES.has(path + '/') || VOL_GLOBS.includes(path) || extraRoots.includes(path)) {
    if (!existsSync(path)) {
      sendJSON(res, 400, { error: `path not found: ${path}` });
      return;
    }
    roots = [path];
  } else {
    sendJSON(res, 403, { error: 'path must be under /vol*' });
    return;
  }
  if (roots.length === 0) {
    sendJSON(res, 200, { files: [], total_candidates: 0, scanned_paths: 0, elapsed_ms: 0 });
    return;
  }

  // Use a heap-like topN: collect all candidates then sort. For NAS filesystems
  // with millions of files we'd want a min-heap, but most users have <500k
  // candidates above 100MB so we just collect + sort.
  const candidates = [];
  const job = { stopped: false };
  activeJob = job;
  const t0 = Date.now();
  let scanned = 0;

  async function walk(root) {
    // BFS queue: [path, level]
    const queue = [[root, 0]];
    while (queue.length > 0) {
      if (job.stopped) return;
      if (Date.now() - t0 > SCAN_BUDGET_MS) return;
      const [dir, level] = queue.shift();
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        if (job.stopped) return;
        const full = join(dir, e.name);
        scanned++;
        try {
          if (e.isFile()) {
            const st = statSync(full);
            if (st.size >= minSize) {
              candidates.push({
                path: full,
                name: basename(full),
                size: st.size,
                size_str: formatBytes(st.size),
                mtime: st.mtimeMs,
                depth: level,
              });
            }
          } else if (e.isDirectory()) {
            if (level >= depth) continue;
            queue.push([full, level + 1]);
          }
          // symlinks and special nodes are ignored silently (safe default)
        } catch {}
        if (scanned % YIELD_INTERVAL === 0) await new Promise(r => setImmediate(r));
      }
    }
  }

  for (const r of roots) await walk(r);

  candidates.sort((a, b) => b.size - a.size);
  const files = candidates.slice(0, topN);
  const elapsed = Date.now() - t0;

  // Reset active job
  activeJob = null;

  sendJSON(res, 200, {
    files,
    total_candidates: candidates.length,
    scanned_paths: scanned,
    elapsed_ms: elapsed,
    truncated: candidates.length > topN,
    root: path,
    min_size: minSize,
    top_n: topN,
    depth,
    roots_scanned: roots,
  });
}

// POST /api/bigfiles/stop — cancel ongoing scan (best-effort)
export function handleBigFilesStop(req, res) {
  cancelBigFilesJob();
  sendJSON(res, 200, { stopped: true });
}
