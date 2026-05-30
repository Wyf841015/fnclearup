import { readdirSync, lstatSync, rmSync, existsSync, mkdirSync, renameSync, cpSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sendJSON } from '../lib/util.js';

export const emptyDirJobs = new Map();
let EMPTY_STATE_DIR = '';

export function setEmptyDirPaths(stateDir, _scanScript) {
  EMPTY_STATE_DIR = stateDir;
  mkdirSync(stateDir, { recursive: true });
}

// ── 同进程异步扫描（不用 spawn 子进程） ──
function runScan(jobId, scanPath) {
  const stateFile = join(EMPTY_STATE_DIR, `empty_${jobId}.json`);
  const dirMap = new Map();
  const allPaths = [];
  let visitCount = 0;

  function update(status, items, error, currentDir) {
    try {
      const raw = existsSync(stateFile)
        ? JSON.parse(readFileSync(stateFile, 'utf-8'))
        : { id: jobId, rootPath: scanPath, startTime: Date.now() };
      raw.status = status;
      raw.items = items;
      raw.total = items.length || 0;
      raw.error = error || null;
      if (currentDir !== undefined) raw.currentDir = currentDir;
      writeFileSync(stateFile, JSON.stringify(raw));
    } catch {}
  }

  function scanDir(dirPath, visited) {
    if (visited.has(dirPath)) return null;
    visited.add(dirPath);
    visitCount++;

    if (visitCount % 10 === 0) update('scanning', [], null, dirPath);

    let entries;
    try { entries = readdirSync(dirPath); } catch { return null; }

    const info = { hasFile: false, children: new Set() };
    for (const name of entries) {
      const fp = join(dirPath, name);
      let st;
      try { st = lstatSync(fp); } catch { continue; }
      if (st.isFile()) {
        info.hasFile = true;
      } else if (st.isDirectory() && !st.isSymbolicLink() && name !== '.@#local') {
        info.children.add(fp);
        const childInfo = scanDir(fp, visited);
        if (childInfo && childInfo.hasFile) info.hasFile = true;
      }
    }
    dirMap.set(dirPath, info);
    allPaths.push(dirPath);
    return info;
  }

  try {
    scanDir(scanPath, new Set());

    // 自底向上传播 hasFile
    for (let i = allPaths.length - 1; i >= 0; i--) {
      const info = dirMap.get(allPaths[i]);
      if (!info) continue;
      for (const childPath of info.children) {
        const childInfo = dirMap.get(childPath);
        if (childInfo && childInfo.hasFile) info.hasFile = true;
      }
    }

    // 自上而下收集空目录
    const results = [];
    function collect(dirPath) {
      const info = dirMap.get(dirPath);
      if (!info) return;
      if (!info.hasFile) {
        results.push({ path: dirPath, name: basename(dirPath), type: 'dir' });
        return;
      }
      for (const childPath of info.children) collect(childPath);
    }
    collect(scanPath);

    update('complete', results, null);
  } catch (e) {
    update('error', [], e.message || '扫描异常');
  } finally {
    emptyDirJobs.delete(jobId);
  }
}

// ── POST /api/empty_dir/scan ──
export async function handleEmptyDirScan(req, res) {
  const bufs = [];
  for await (const c of req) bufs.push(c);
  let data = {};
  try { data = JSON.parse(Buffer.concat(bufs).toString()); } catch {}
  const scanPath = (data.path || '').trim();
  if (!scanPath || !existsSync(scanPath)) {
    sendJSON(res, 400, { error: scanPath ? `目录不存在: ${scanPath}` : '无效的扫描路径', success: false });
    return;
  }
  let st;
  try { st = lstatSync(scanPath); } catch (e) { sendJSON(res, 400, { error: e.message, success: false }); return; }
  if (!st.isDirectory()) { sendJSON(res, 400, { error: '不是目录', success: false }); return; }

  const jobId = `empty_${randomUUID().slice(0, 8)}`;
  const stateFile = join(EMPTY_STATE_DIR, `empty_${jobId}.json`);
  const startTime = Date.now();
  const initialState = { id: jobId, rootPath: scanPath, status: 'scanning', items: [], total: 0, error: null, startTime };
  writeFileSync(stateFile, JSON.stringify(initialState));

  emptyDirJobs.set(jobId, { stateFile, scanPath, startTime });

  // 先返回响应，再异步扫描
  sendJSON(res, 200, { jobId, status: 'started', success: true });

  setTimeout(() => runScan(jobId, scanPath), 0);
}

// ── GET /api/empty_dir/status?jobId=xxx ──
export function handleEmptyDirStatus(req, res) {
  const url = typeof req.url === 'string' ? req.url : String(req.url);
  const qIndex = url.indexOf('?');
  const params = {};
  if (qIndex >= 0) {
    for (const p of url.slice(qIndex + 1).split('&')) {
      const [k, v] = p.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
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
  } catch (e) { sendJSON(res, 500, { error: e.message, success: false }); }
}

// ── POST /api/empty_dir/delete ──
export async function handleEmptyDirDelete(req, res) {
  const bufs = [];
  for await (const c of req) bufs.push(c);
  let data = {};
  try { data = JSON.parse(Buffer.concat(bufs).toString()); } catch {}
  const paths = Array.isArray(data.paths) ? data.paths : [];
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
            finalDest = join(dirname(dest), `${basename(dest).slice(0, ext2.length || basename(dest).length)}_${counter}${ext2}`);
            counter++;
          }
          try { renameSync(fp, finalDest); }
          catch (e2) { if (e2.code === 'EXDEV') { cpSync(fp, finalDest); unlinkSync(fp); } else throw e2; }
        } else {
          rmSync(fp, { recursive: true, force: true });
        }
      }
      deleted++;
    } catch (e) { failed.push({ path: fp, reason: e.message }); }
  }
  sendJSON(res, 200, { deleted, failed, success: true });
}
