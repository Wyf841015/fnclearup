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

import { existsSync, statSync, readdirSync, unlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { sendJSON, formatBytes, isSafePath, partitionDeletable, parseBody, isProtectedPath } from '../lib/util.js';
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
/**
 * 探测目录所在卷是否真的可写。
 *
 * 不用 access(W_OK): fnOS 的 trimacl 会把目录 mode 显示成 000(实测 /vol2/1000
 * 是 mode=0o0), 于是 access(W_OK) 对可写卷也返回 false, 完全不可信。
 * 唯一可靠的办法是真的写一个临时文件再删掉 —— 每个扫描根试一次, 开销可忽略。
 *
 * 背景: /vol2 以 btrfs (ro) 挂载, 用户 82G 视频全在它上面。之前扫描照常列出 57 个
 * "大文件", 用户勾选全删, 57 个全部 EROFS 失败 —— 显示出来就是"全部失败"。
 * 扫描阶段就告知"这个卷只读、删不掉", 才是应用该做的事。
 */
function probeWritable(dir) {
  const probe = join(dir, `.fnclearup_wtest_${process.pid}_${Date.now()}`);
  let code = '', msg = '';
  try {
    writeFileSync(probe, '0');
    code = '';
  } catch (e) {
    // EROFS = 卷以只读方式挂载, 这是用户需要知道的根因, 不是权限问题
    code = e.code || 'EUNKNOWN';
    msg = e.message || String(e);
  }
  // 写成功(或有残留)都要清掉探针, 但清理失败必须上报 —— 静默忽略会在用户
  // 目录里留下一堆 .fnclearup_wtest_*, 那比"探测不准"更让人困惑。
  let leftover = '';
  try { if (existsSync(probe)) unlinkSync(probe); }
  catch (e2) { leftover = `${dir} 下残留探测临时文件 ${basename(probe)}（${e2.code}）`; }
  if (code) {
    return { writable: false, code,
      reason: code === 'EROFS' ? '卷以只读方式挂载，无法写入或删除任何文件'
        : code === 'EACCES' ? '没有写入权限'
        : msg.slice(0, 80),
      ...(leftover ? { leftover } : {}) };
  }
  return leftover ? { writable: true, leftover } : { writable: true };
}

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
    } else {
      // 允许卷内任意子目录, 不只是卷根。
      //
      // 原先用的是「把路径拼上斜杠后去 Set 里做 has() 精确匹配」, 而那个 Set
      // 只装了各卷根(如 '/vol1/', '/vol2/', ...) 本身。于是只有路径正好等于
      // 某个卷根时才成立: '/vol3' 通过, 而 '/vol3/1000/hermes' 直接被 403 拒掉。
      // 用户想扫某个具体目录(而不是整卷)时必然踩到这个, 前端又把 403 的真实
      // 原因掩盖成 toLocaleString 的 TypeError, 排查成本很高。
      //
      // 这里改成"必须是某个卷的前缀", 且先 resolve 消掉 .. 与 // 再判定 ——
      // 直接 startsWith 会被 '/vol3/../etc' 绕过(它确实以 '/vol3/' 开头)。
      const resolved = resolve(path);
      const inSomeVol = VOL_GLOBS.some(v => resolved === v || resolved.startsWith(v + '/'));
      if (!inSomeVol && !extraRoots.includes(resolved)) {
        sendJSON(res, 403, { error: `path must be under /vol*: ${resolved}` });
        return;
      }
      if (!existsSync(resolved)) {
        sendJSON(res, 400, { error: `path not found: ${resolved}` });
        return;
      }
      roots.push(resolved);
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
  let skippedProtectedDirs = 0;
  let statFailures = 0;
  let lastStatErr = '';

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
            // P0(2026-10-10): 整棵跳过 fnOS 系统目录与回收站, 而不是等删除时才拦。
            //
            // 原来的问题: 扫描把 /vol3/@sysappmeta/ai-manager/models/*.onnx 这类
            // 应用模型文件也列给用户("占了我 5.8G, 得清一下"), 用户勾选后删除端点
            // 全被 partitionDeletable 拦下 —— deleted=2 / blocked=8 / skipped=8,
            // 用户看到的就是"全部失败"。既浪费了一次扫描, 又让人以为程序坏了。
            //
            // 剪在 push 之前而不是过滤结果: 一是省掉整棵子树的遍历(fuse 挂载的
            // 系统目录能扫到上万个 inode), 二是结果列表里不再混着删不掉的东西。
            // exemptSelf:true —— 应用自身数据目录该列出来, 用户有权知道自己占了多少。
            if (isProtectedPath(full, { exemptSelf: true })) { skippedProtectedDirs++; continue; }
            queue.push([full, level + 1]);
          }
          // symlinks and special nodes are ignored silently (safe default)
        } catch (err) { statFailures++; lastStatErr = `${e.name}: ${e.message}`; }
        if (scanned % YIELD_INTERVAL === 0) await new Promise(r => setImmediate(r));
      }
    }
  }

  for (const r of roots) await walk(r);

  // 逐根探测可写性 —— 结果随响应回传, 让前端在用户勾选之前就告知
  const rootAccess = roots.map(r => ({ root: r, ...probeWritable(r) }));

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
    // 扫描阶段就跳过了多少个受保护目录 —— 让前端能如实告诉用户"这些不是你的,
    // 也不该你清", 而不是让用户白勾一遍再被删除端点拦。
    skipped_protected_dirs: skippedProtectedDirs,
    // 只读根: [{ root, writable:false, code:'EROFS', reason:'...' }]
    // 前端据此在扫描结果上方直接提示"这些删不掉", 而不是让用户勾完才发现。
    read_only_roots: rootAccess.filter(a => !a.writable),
    // stat 失败(权限/断链)统计: 之前 catch 里连错误内容都不打, 日志里只有一行
    // 光秃秃的 "[bigfiles.js]", 排查时完全无从下手。
    stat_failures: statFailures,
    last_stat_error: lastStatErr,
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
  const permanentFallbacks = [];   // trash 降级为永久删除的路径(不混入 deleted, 保持其字符串数组契约)
  for (const fp of valid) {
    try {
      if (!existsSync(fp)) {
        // Path not on disk anymore — count as skipped, not failure
        continue;
      }
      let ok = false;
      let permanentFallback = false;
      if (mode === 'trash') {
        ok = moveToTrash(fp);
        if (!ok) {
          // /volN/UID/... doesn't match (e.g. /vol1 itself) or /vol02 netdisk
          // — fall back to rm -rf via unlink. Big files are usually single
          // files so unlinkSync is the right tool; only descend to rm -rf
          // if it's a directory.
          // P1: 用户选的是"进回收站(可恢复)", 这里实际做的是不可逆的永久删除。
          // 行为保持不变(否则 /vol02 网络盘等路径将完全无法清理), 但把
          // 标记放到独立的 permanentFallbacks 字段, 不改动 deleted 本身 ——
          // deleted 一直是字符串数组, 把它换成 {path, permanentFallback} 对象会破坏
          // 既有契约(调用方的 deleted.includes(path) 与字符串 map 渲染都会失效)。
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
            permanentFallback = ok;
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
      if (ok) { deleted.push(fp); if (permanentFallback) permanentFallbacks.push(fp); }
      else if (!failed.find(f => f.path === fp)) failed.push({ path: fp, reason: 'unknown' });
    } catch (e) {
      failed.push({ path: fp, reason: e.message });
    }
  }

  sendJSON(res, 200, {
    success: true,
    deleted,
    permanentFallbacks,
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
