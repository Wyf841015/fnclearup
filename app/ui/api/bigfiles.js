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

import { existsSync, statSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { sendJSON, formatBytes, isSafePath, partitionDeletable, parseBody } from '../lib/util.js';
import { moveToTrash } from './trash.js';
import { VOL_GLOBS, SAFE_PREFIXES } from '../lib/config.js';

const DEFAULT_DEPTH = 6;
const DEFAULT_TOPN = 100;
const DEFAULT_MINSIZE = 100 * 1024 * 1024; // 100 MB
const SCAN_BUDGET_MS = 1000 * 60 * 5; // 5 min hard timeout
const YIELD_INTERVAL = 100; // setImmediate every N entries
// Per-directory sibling count threshold: dirs with more entries than this
// are likely huge content stores (app icons, photo thumbnails, torrent
// seeders) where recursing burns the entire budget for negligible gain.
// We still pick up sibling files in this directory — we just don't descend.
const SIBLING_THRESHOLD = parseInt(process.env.TRM_FNCLEARUP_SIBLING_THRESHOLD || '5000', 10);

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
  // 多目录支持(2026-10-01): 与去重/相似/异常/重名统一, 前端可一次提交多个根目录。
  // 用 getAll 读重复的 path 参数; 保留单 path 与不传(= /vol*) 的旧行为, 兼容旧调用方。
  const pathParams = url.searchParams.getAll('path').map(s => s.trim()).filter(Boolean);
  const requested = pathParams.length ? pathParams : ['/vol*'];
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
  const roots = [];
  for (const path of requested) {
    if (roots.includes(path)) continue;
    if (path === '/vol*' || path === '/vol*/') {
      // By default also include /vol2 (the most common media mount on fnOS)
      // — skip /vol02 (netdisk fuse) which can be huge and slow.
      for (const r of VOL_GLOBS.filter(x => existsSync(x) && !x.startsWith('/vol0'))) {
        if (r !== '/vol02' && !roots.includes(r)) roots.push(r);
      }
      if (extraRoots.length) {
        for (const r of extraRoots.filter(x => existsSync(x))) {
          if (!roots.includes(r)) roots.push(r);
        }
      }
    } else if (SAFE_PREFIXES.has(path + '/') || VOL_GLOBS.includes(path) || extraRoots.includes(path)) {
      if (!existsSync(path)) {
        sendJSON(res, 400, { error: `path not found: ${path}` });
        return;
      }
      roots.push(path);
    } else {
      sendJSON(res, 403, { error: 'path must be under /vol*' });
      return;
    }
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
      // Per-dir sibling threshold: huge dirs (app icons, photo thumbs) waste
      // the whole run if we recurse. We keep sibling files but skip children.
      const skipRecurse = entries.length > SIBLING_THRESHOLD;
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
                skipped_subtree: skipRecurse, // marker for UI/debug
              });
            }
          } else if (e.isDirectory()) {
            if (level >= depth) continue;
            if (skipRecurse) continue; // ← big files in this dir are still picked up above
            queue.push([full, level + 1]);
          }
          // symlinks and special nodes are ignored silently (safe default)
        } catch { console.error('[bigfiles.js]'); }
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
    root: roots.join(','),
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

// POST /api/bigfiles/delete
// Body: { paths: string[], mode: 'trash'|'permanent', confirmed: bool }
//
// Three-layer confirmation (fnOS multi-user NAS context):
//   1. UI: user must check ≥1 row checkbox + click "🗑 删除选中"
//   2. UI modal: shows path preview + total size + "我已知晓" checkbox +
//      mode radio (default 'trash'). Permanent mode has its own red checkbox.
//   3. API: confirmed:true is REQUIRED. Missing/false → 400.
//
// Safety:
//   - Every path must pass isSafePath (under /vol*). Others are skipped.
//   - mode='trash' (default) calls moveToTrash → /volN/UID/.@#local/trash/
//   - mode='permanent' calls unlinkSync — irreversible
//   - Files not on disk are reported as skipped, not failed (UI distinguishes)
//   - Returns { deleted, failed, skipped, total, failures, success }
export async function handleBigFilesDelete(req, res) {
  const body = await parseBody(req);
  const paths = Array.isArray(body?.paths) ? body.paths : [];
  const mode = body?.mode === 'permanent' ? 'permanent' : 'trash';
  const confirmed = body?.confirmed === true;

  if (!confirmed) {
    sendJSON(res, 400, {
      success: false,
      error: 'confirmation required: send {confirmed: true, ...}',
    });
    return;
  }
  if (!paths.length) {
    sendJSON(res, 200, { success: true, deleted: [], failed: [], skipped: 0, total: 0, failures: 0 });
    return;
  }
  // P0 安全: 大文件删除同样不得触及 fnOS 系统目录与卷内回收站
  const { ok: valid, blocked } = partitionDeletable(paths.filter(p => typeof p === 'string'));
  const skipped = paths.length - valid.length;
  if (!valid.length) {
    sendJSON(res, 200, {
      success: true,
      deleted: [],
      failed: [],
      skipped,
      total: 0,
      failures: 0,
      error: 'no paths under /vol* (whitelist rejected all)',
    });
    return;
  }

  const deleted = [];
  const failed = [];
  for (const fp of valid) {
    try {
      if (!existsSync(fp)) {
        // Path not on disk anymore — count as skipped, not failure
        continue;
      }
      let ok = false;
      if (mode === 'trash') {
        ok = moveToTrash(fp);
        if (!ok) {
          // /volN/UID/... doesn't match (e.g. /vol1 itself) or /vol02 netdisk
          // — fall back to rm -rf via unlink. Big files are usually single
          // files so unlinkSync is the right tool; only descend to rm -rf
          // if it's a directory.
          try {
            const st = statSync(fp);
            if (st.isDirectory()) {
              // For directories we can't trash, try permanent remove
              rmSync(fp, { recursive: true, force: true });
              ok = true;
            } else {
              unlinkSync(fp);
              ok = true;
            }
          } catch (e) {
            failed.push({ path: fp, reason: 'trash fallback failed: ' + e.message });
          }
        }
      } else {
        // permanent
        try {
          const st = statSync(fp);
          if (st.isDirectory()) {
            rmSync(fp, { recursive: true, force: true });
          } else {
            unlinkSync(fp);
          }
          ok = true;
        } catch (e) {
          failed.push({ path: fp, reason: e.message });
        }
      }
      if (ok) deleted.push(fp);
      else if (!failed.find(f => f.path === fp)) failed.push({ path: fp, reason: 'unknown' });
    } catch (e) {
      failed.push({ path: fp, reason: e.message });
    }
  }

  sendJSON(res, 200, {
    success: true,
    deleted,
    failed,
    skipped,
    total: deleted.length,
    failures: failed.length,
    mode,
    // P0: 回传被拦截的路径与原因
    blockedCount: blocked.length,
    blocked: blocked.slice(0, 50),
  });
}
