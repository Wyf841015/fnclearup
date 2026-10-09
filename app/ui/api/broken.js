// ── Abnormal File Detection API (P0-3) ──
// Wraps the broken_scan.js subprocess worker. Detects:
//   empty files, invalid symlinks, broken (undecodable) media.
//
//   POST /api/broken/scan  { paths:[...], checkBroken? } → { jobId }
//   GET  /api/broken/status ?job=broken_xxx → progress + categories
//   POST /api/broken/stop  ?job= → { stopped }

import { existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sendJSON, parseBody, isSafePath, safeReadJSON } from '../lib/util.js';

let BROKEN_STATE_DIR = '';
let BROKEN_SCAN_SCRIPT = '';

export function setBrokenPaths(stateDir, script) {
  BROKEN_STATE_DIR = stateDir;
  BROKEN_SCAN_SCRIPT = script;
  mkdirSync(stateDir, { recursive: true });
}

// POST /api/broken/scan
export async function handleBrokenScan(req, res) {
  const data = await parseBody(req);
  const paths = Array.isArray(data.paths) ? data.paths.map(p => p.trim()).filter(Boolean) : [];
  const checkBroken = data.checkBroken === true;

  if (paths.length === 0) {
    sendJSON(res, 400, { error: '请至少选择一个扫描目录', success: false });
    return;
  }
  for (const p of paths) {
    if (!existsSync(p)) { sendJSON(res, 400, { error: `目录不存在: ${p}`, success: false }); return; }
    if (!isSafePath(p)) { sendJSON(res, 403, { error: `路径越界：${p} 仅允许 /vol* 下的目录`, success: false }); return; }
  }

  const jobId = `broken_${randomUUID().slice(0, 8)}`;
  const stateFile = join(BROKEN_STATE_DIR, `${jobId}.json`);
  const initial = {
    id: jobId, type: 'broken', checkBroken, rootPaths: paths,
    status: 'counting', progress: { scanned: 0, processed: 0, currentFile: '' },
    empty: [], invalid_links: [], broken: [],
    stats: { scanned: 0, empty: 0, invalid_links: 0, broken: 0 }, error: null,
    startTime: Date.now(), _aborted: false, _paused: false,
  };
  const tmp = stateFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(initial));
  renameSync(tmp, stateFile);

  if (existsSync(BROKEN_SCAN_SCRIPT)) {
    const proc = spawn(process.execPath, [BROKEN_SCAN_SCRIPT, paths.join(','), jobId, BROKEN_STATE_DIR, checkBroken ? '1' : '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (proc.stderr) proc.stderr.on('data', c => process.stderr.write(`[broken] ${c}`));
    proc.on('error', e => process.stderr.write(`[broken] spawn error: ${e}\n`));
  }

  sendJSON(res, 200, { jobId, success: true, checkBroken });
}

// GET /api/broken/status?job=broken_xxx
export function handleBrokenStatus(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^broken_/.test(jobId)) {
    sendJSON(res, 400, { error: 'job 参数缺失或非法' });
    return;
  }
  const state = safeReadJSON(join(BROKEN_STATE_DIR, `${jobId}.json`));
  if (!state.id) { sendJSON(res, 404, { error: '任务不存在' }); return; }
  sendJSON(res, 200, state);
}

// POST /api/broken/stop?job=broken_xxx
export function handleBrokenStop(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^broken_/.test(jobId)) { sendJSON(res, 400, { error: 'job 非法' }); return; }
  const stateFile = join(BROKEN_STATE_DIR, `${jobId}.json`);
  try {
    if (existsSync(stateFile)) {
      const state = safeReadJSON(stateFile);
      state._aborted = true;
      writeFileSync(stateFile + '.tmp', JSON.stringify(state));
      renameSync(stateFile + '.tmp', stateFile);
    }
  } catch (e) {
    // P1: 状态文件写失败(磁盘满/权限)时不能仍回 stopped:true ——
    // 那会让前端显示"已停止", 而扫描子进程继续跑满一小时预算。
    console.error('[broken] stop failed:', e.message);
    sendJSON(res, 200, { stopped: false, error: e.message, job: jobId });
    return;
  }
  sendJSON(res, 200, { stopped: true, job: jobId });
}