import { readdirSync, lstatSync, rmSync, existsSync, mkdirSync, renameSync, cpSync, unlinkSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sendJSON, isSafePath, parseQuery } from '../lib/util.js';

export const emptyDirJobs = new Map();
let EMPTY_STATE_DIR = '';

export function setEmptyDirPaths(stateDir, _scanScript) {
  EMPTY_STATE_DIR = stateDir;
  mkdirSync(stateDir, { recursive: true });
}

// Yield to the event loop every N directories so other HTTP requests
// (browse / stop) can be served while a scan is running. Without this,
// walk() blocks the entire Node.js event loop and the server looks "frozen"
// — clicks in other tabs (e.g. open directory browser) appear to silently
// fail until the scan completes.
const YIELD_EVERY = 200;
let _yieldSinceLast = 0;
function maybeYield() {
  _yieldSinceLast++;
  if (_yieldSinceLast >= YIELD_EVERY) {
    _yieldSinceLast = 0;
    return new Promise(resolve => setImmediate(resolve));
  }
  return null;
}

// ── 同进程异步扫描（不用 spawn 子进程） ──
// Stream + parent-only tracking: don't retain dirMap for all dirs
// Each directory only needs to know "do I have a child that has a file"
// Skip system dirs: .@#local, @appcenter, @appshare, @apphome, @appconf, @apptmp
const SKIP_DIRS = new Set(['.@#local', '@appcenter', '@appshare', '@apphome', '@appconf', '@apptemp', '@apphome', '@appdata']);
function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith('@app');
}

function runScan(jobId, scanPath) {
  const stateFile = join(EMPTY_STATE_DIR, `empty_${jobId}.json`);
  let visitCount = 0;
  let aborted = false;
  console.log('[empty_dir] runScan START', { jobId, scanPath, stateFile, stateFileExists: existsSync(stateFile) });

  function update(status, items, error, currentDir) {
    if (aborted) return;
    try {
      const raw = existsSync(stateFile)
        ? JSON.parse(readFileSync(stateFile, 'utf-8'))
        : { id: jobId, rootPath: scanPath, startTime: Date.now() };
      raw.status = status;
      raw.items = items;
      raw.total = items.length || 0;
      raw.error = error || null;
      if (currentDir !== undefined) raw.currentDir = currentDir;
      const tmp = stateFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(raw));
      renameSync(tmp, stateFile);
    } catch { console.error('[empty_dir.js]'); }
  }

  // Phase 1: visit all dirs, count files in each dir, record parent hasFile state.
  // To save memory, we don't keep dirMap: just write a transient count to state file.
  // We do a single bottom-up traversal: walk deep first, then count hasFile based on
  // direct children.
  // For each dir, hasFile = any direct file in it OR any direct child that hasFile.
  // Stream the result: don't retain allPaths.

  // We use a 2-pass approach:
  // Pass 1: collect all dir paths (no recursion, just store the path)
  // Pass 2: walk bottom-up (sorted by depth desc), compute hasFile
  // This still O(N) memory, but we free hasFileMap after each parent processed.
  const allPaths = [];
  const fileCount = new Map();  // dir -> number of direct files

  async function walk(p) {
    if (aborted) return;
    // Yield to event loop every N dirs so other HTTP requests (browse/stop)
    // can be served. Without this, walk() blocks the entire server and
    // interactive features like "open directory browser" silently fail
    // until the scan completes.
    const y = maybeYield();
    if (y) await y;
    let entries;
    try { entries = readdirSync(p); } catch { return; }
    let fileN = 0;
    const childDirs = [];
    for (const name of entries) {
      if (aborted) return;
      const fp = join(p, name);
      let st;
      try { st = lstatSync(fp); } catch { continue; }
      if (st.isFile()) {
        fileN++;
      } else if (st.isDirectory() && !st.isSymbolicLink() && !shouldSkipDir(name)) {
        childDirs.push(fp);
      }
    }
    fileCount.set(p, fileN);
    allPaths.push(p);
    visitCount++;
    // Update progress: first directory IMMEDIATELY so UI shows feedback within ~1s,
    // then every 5 directories after that (was every 10 — felt too slow on big trees).
    if (visitCount === 1 || visitCount % 5 === 0) update('scanning', [], null, p);
    for (const c of childDirs) {
      if (aborted) return;
      await walk(c);
    }
  }

  return (async () => {
    try {
      await walk(scanPath);

      // Pass 2: bottom-up — for each dir, hasFile = (own files > 0) OR (any child hasFile)
      // Sort by depth (desc) so deepest processed first
      const hasFile = new Map();
      allPaths.sort((a, b) => b.split('/').length - a.split('/').length);
      for (const p of allPaths) {
        if (aborted) return;
        const y2 = maybeYield();
        if (y2) await y2;
        const own = (fileCount.get(p) || 0) > 0;
        // hasFile includes child dirs that have files
        // We check each child by looking it up
        let childHasFile = false;
        try {
          const entries = readdirSync(p);
          for (const name of entries) {
            if (shouldSkipDir(name)) continue;
            const fp = join(p, name);
            try {
              const st = lstatSync(fp);
              if (st.isDirectory() && !st.isSymbolicLink() && hasFile.get(fp)) {
                childHasFile = true;
                break;
              }
            } catch { console.error('[empty_dir.js]'); }
          }
        } catch { console.error('[empty_dir.js]'); }
        hasFile.set(p, own || childHasFile);
      }

      // Pass 3: collect empty dirs (top-down, but only output leaves)
      const results = [];
      async function collect(p) {
        if (aborted) return;
        const y3 = maybeYield();
        if (y3) await y3;
        if (!hasFile.get(p)) {
          results.push({ path: p, name: basename(p), type: 'dir' });
          return;  // empty leaf
        }
        try {
          const entries = readdirSync(p);
          for (const name of entries) {
            if (shouldSkipDir(name)) continue;
            const fp = join(p, name);
            try {
              const st = lstatSync(fp);
              if (st.isDirectory() && !st.isSymbolicLink()) await collect(fp);
            } catch { console.error('[empty_dir.js]'); }
          }
        } catch { console.error('[empty_dir.js]'); }
      }
      await collect(scanPath);

      // Free memory
      allPaths.length = 0;
      fileCount.clear();
      hasFile.clear();

      update('complete', results, null);
    } catch (e) {
      console.error('[empty_dir] runScan ERROR', e);
      if (!aborted) update('error', [], e.message || '扫描异常');
    } finally {
      console.log('[empty_dir] runScan FINALLY', { jobId, aborted, visitCount, willUnlink: aborted });
      emptyDirJobs.delete(jobId);
      // Only unlink state file on abort/error — keep complete state so client can poll
      if (aborted) {
        try { unlinkSync(stateFile); } catch (e2) { console.error('[empty_dir] unlink fail', e2); }
      }
    }
  })().then(() => ({ abort: () => { aborted = true; } }));
}

// ── POST /api/empty_dir/scan ──
export async function handleEmptyDirScan(req, res) {
  const bufs = [];
  for await (const c of req) bufs.push(c);
  let data = {};
  try { data = JSON.parse(Buffer.concat(bufs).toString()); } catch { console.error('[empty_dir.js]'); }
  const scanPath = (data.path || '').trim();
  if (!scanPath || !existsSync(scanPath)) {
    sendJSON(res, 400, { error: scanPath ? `目录不存在: ${scanPath}` : '无效的扫描路径', success: false });
    return;
  }
  if (!isSafePath(scanPath)) {
    sendJSON(res, 403, { error: '路径越界：仅允许 /vol* 下的目录', success: false });
    return;
  }
  let st;
  try { st = lstatSync(scanPath); } catch (e) { sendJSON(res, 400, { error: e.message, success: false }); return; }
  if (!st.isDirectory()) { sendJSON(res, 400, { error: '不是目录', success: false }); return; }

  const jobId = `empty_${randomUUID().slice(0, 8)}`;
  const stateFile = join(EMPTY_STATE_DIR, `empty_${jobId}.json`);
  const startTime = Date.now();
  const initialState = { id: jobId, rootPath: scanPath, status: 'scanning', items: [], total: 0, error: null, startTime };
  console.log('[empty_dir] handleEmptyDirScan: EMPTY_STATE_DIR=', EMPTY_STATE_DIR, 'stateFile=', stateFile, 'scanPath=', scanPath);
  const tmp = stateFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(initialState));
      renameSync(tmp, stateFile);
  console.log('[empty_dir] wrote initial state, existsSync=', existsSync(stateFile));

  // 先返回响应，再异步扫描
  sendJSON(res, 200, { jobId, status: 'started', success: true });

  // Register the job BEFORE the scan starts so /api/empty_dir/stop can find it
  // immediately. Abort handle is set after the async runScan resolves, but stop
  // can still find the job and will just no-op on the abort call until then
  // (worst case: stop arrives before walk starts, scan never runs, status stays
  // in memory briefly until runScan completes its setup, then sees aborted=true).
  let abortFn = () => { aborted_flag.early = true; };
  const aborted_flag = { early: false };
  emptyDirJobs.set(jobId, { stateFile, scanPath, startTime, abort: () => abortFn() });

  setTimeout(async () => {
    // If stop arrived before runScan started, don't run at all
    if (aborted_flag.early) return;
    const handle = await runScan(jobId, scanPath);
    // If stop arrived BEFORE runScan resolved, set aborted flag so the scan
    // loop sees it and exits immediately.
    if (aborted_flag.early) handle.abort();
    abortFn = handle.abort;
    // Re-register with the real abort fn
    const job = emptyDirJobs.get(jobId);
    if (job) job.abort = handle.abort;
  }, 0);
}

// ── POST /api/empty_dir/stop ──
export async function handleEmptyDirStop(req, res) {
  const bufs = [];
  for await (const c of req) bufs.push(c);
  let data = {};
  try { data = JSON.parse(Buffer.concat(bufs).toString()); } catch { console.error('[empty_dir.js]'); }
  const jobId = data.jobId || '';
  if (!jobId) { sendJSON(res, 400, { error: '缺少 jobId', success: false }); return; }
  const job = emptyDirJobs.get(jobId);
  if (!job) { sendJSON(res, 200, { stopped: false, success: true }); return; }
  if (job.abort) job.abort();
  emptyDirJobs.delete(jobId);
  sendJSON(res, 200, { stopped: true, success: true });
}

// ── GET /api/empty_dir/status?jobId=xxx ──
export function handleEmptyDirStatus(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const params = parseQuery(url);
  const jobId = params.jobId || '';
  if (!jobId) { sendJSON(res, 400, { error: '缺少 jobId', success: false }); return; }
  const stateFile = join(EMPTY_STATE_DIR, `empty_${jobId}.json`);
  if (!existsSync(stateFile)) {
    const job = emptyDirJobs.get(jobId);
    if (job) { sendJSON(res, 200, { id: jobId, status: 'scanning', items: [], total: 0 }); return; }
    sendJSON(res, 404, { error: '任务不存在', success: false }); return;
  }
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    sendJSON(res, 200, { id: raw.id, status: raw.status, items: raw.items || [], total: raw.total || 0, error: raw.error, startTime: raw.startTime, currentDir: raw.currentDir });
  } catch (e) {
    sendJSON(res, 500, { error: e.message, success: false });
  }
}

// ── POST /api/empty_dir/delete ──
export async function handleEmptyDirDelete(req, res) {
  const bufs = [];
  for await (const c of req) bufs.push(c);
  let data = {};
  try { data = JSON.parse(Buffer.concat(bufs).toString()); } catch { console.error('[empty_dir.js]'); }
  const rawPaths = Array.isArray(data.paths) ? data.paths : [];
  const paths = rawPaths.filter(p => isSafePath(p));
  const skipped = rawPaths.length - paths.length;
  const mode = data.mode || 'trash';
  let deleted = 0, failed = [];
  for (const fp of paths) {
    try {
      if (mode === 'permanent') {
        rmSync(fp, { recursive: true, force: true });
      } else {
        const m = fp.match(/^\/(?:mnt\/)?(vol\d+)\/(\d+)\/(.+)/);
        if (m) {
          const trashDir = `/${m[1]}/${m[2]}/.@#local/trash`;
          const dest = join(trashDir, m[3]);
          mkdirSync(dirname(dest), { recursive: true });
          let finalDest = dest;
          let counter = 1;
          while (existsSync(finalDest)) {
            const ext2 = extname(dest);
            const stem = basename(dest).slice(0, ext2.length ? -ext2.length : basename(dest).length);
            finalDest = join(dirname(dest), `${stem}_${counter}${ext2}`);
            counter++;
          }
          try { renameSync(fp, finalDest); }
          catch (e2) { if (e2.code === 'EXDEV') { cpSync(fp, finalDest); unlinkSync(fp); } else throw e2; }
        } else {
          // Path doesn't match vol pattern — can't move to trash, report as failure
          failed.push({ path: fp, reason: '路径格式不支持回收站: ' + fp + ' (需 /volN/UID/... 格式)' });
          continue;
        }
      }
      deleted++;
    } catch (e) { failed.push({ path: fp, reason: e.message }); }
  }
  sendJSON(res, 200, { deleted, failed, skipped, total: paths.length, failures: failed.length, success: true });
}
