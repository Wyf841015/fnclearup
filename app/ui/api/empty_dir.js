import { readdirSync, lstatSync, rmSync, existsSync, mkdirSync, renameSync, cpSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sendJSON } from '../lib/util.js';

export const emptyDirJobs = new Map();
let EMPTY_STATE_DIR = '';
let EMPTY_SCAN_SCRIPT = '';

export function setEmptyDirPaths(stateDir, scanScript) {
  EMPTY_STATE_DIR = stateDir;
  EMPTY_SCAN_SCRIPT = scanScript;
  mkdirSync(stateDir, { recursive: true });
}

function isDirEmptySync(dirPath) {
  try {
    const entries = readdirSync(dirPath);
    if (entries.length === 0) return { empty: true, children: [] };
    const subInfo = [];
    for (const name of entries) {
      const fp = join(dirPath, name);
      try {
        const st = lstatSync(fp);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          subInfo.push({ name, path: fp, isDir: true, ...isDirEmptySync(fp) });
        } else {
          subInfo.push({ name, path: fp, isDir: false, size: st.size });
        }
      } catch {}
    }
    const childDirs = subInfo.filter(s => s.isDir);
    const childFiles = subInfo.filter(s => !s.isDir);
    if (childFiles.length > 0) return { empty: false, children: [] };
    if (childDirs.length === 0) return { empty: true, children: [] };
    const allChildDirsEmpty = childDirs.every(d => d.empty);
    if (allChildDirsEmpty) return { empty: true, children: childDirs.map(d => d.path) };
    const emptyChildDirs = childDirs.filter(d => d.empty);
    return { empty: false, children: emptyChildDirs.map(d => d.path) };
  } catch {
    return { empty: false, children: [] };
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
  const initialState = { id: jobId, rootPath: scanPath, status: 'scanning', items: [], total: 0, error: null, startTime: Date.now() };
  const tmpInit = stateFile + '.tmp';
  writeFileSync(tmpInit, JSON.stringify(initialState));
  renameSync(tmpInit, stateFile);

  // Run scan in detached child process
  const args = [EMPTY_SCAN_SCRIPT, scanPath, jobId, EMPTY_STATE_DIR];
  const proc = spawn(process.execPath, args, { stdio: 'ignore', detached: true });
  proc.unref();
  proc.on('error', (err) => {
    try {
      const errState = { ...initialState, status: 'error', error: '启动扫描进程失败: ' + (err.message || String(err)) };
      writeFileSync(stateFile, JSON.stringify(errState));
    } catch {}
    emptyDirJobs.delete(jobId);
  });
  proc.on('exit', (code) => {
    emptyDirJobs.delete(jobId);
    if (code !== 0) {
      try {
        // Only write error if not already complete (race: scan might have updated just before exit)
        const cur = JSON.parse(readFileSync(stateFile, 'utf-8'));
        if (cur.status !== 'complete') {
          cur.status = 'error';
          cur.error = '扫描进程异常退出，code=' + code;
          writeFileSync(stateFile, JSON.stringify(cur));
        }
      } catch {}
    }
  });
  emptyDirJobs.set(jobId, { stateFile, scanPath, proc, startTime: Date.now() });

  sendJSON(res, 200, { jobId, status: 'started', success: true });
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
    // Check if job is still running
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