// ── Similar Image / Video Detection API (P0-2) ──
// Wraps the simdup_scan.js subprocess worker (process isolation, same
// pattern as dup.js). Endpoints:
//
//   POST /api/simdup/scan    { type:'image'|'video', paths:[...], threshold? } → { jobId }
//   GET  /api/simdup/status  ?job=id → progress + groups
//   POST /api/simdup/stop    { job: id, _aborted:1 } → { stopped }
//
// Worker writes state to <stateDir>/simdup_<jobId>.json (atomic tmp+rename).

import { existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sendJSON, parseBody, isSafePath, safeReadJSON } from '../lib/util.js';

let SIM_STATE_DIR = '';
let SIM_SCAN_SCRIPT = '';

export function setSimDupPaths(stateDir, script) {
  SIM_STATE_DIR = stateDir;
  SIM_SCAN_SCRIPT = script;
  mkdirSync(stateDir, { recursive: true });
}

const VALID_TYPES = ['image', 'video'];

// POST /api/simdup/scan
export async function handleSimDupScan(req, res) {
  const data = await parseBody(req);
  const type = data.type || 'image';
  const paths = Array.isArray(data.paths) ? data.paths.map(p => p.trim()).filter(Boolean) : [];
  const threshold = (data.threshold === undefined || data.threshold === null) ? 10 : (Number(data.threshold) || 10);

  if (!VALID_TYPES.includes(type)) {
    sendJSON(res, 400, { error: 'type 必须是 image 或 video', success: false });
    return;
  }
  if (paths.length === 0) {
    sendJSON(res, 400, { error: '请至少选择一个扫描目录', success: false });
    return;
  }
  for (const p of paths) {
    if (!existsSync(p)) { sendJSON(res, 400, { error: `目录不存在: ${p}`, success: false }); return; }
    if (!isSafePath(p)) { sendJSON(res, 403, { error: `路径越界：${p} 仅允许 /vol* 下的目录`, success: false }); return; }
  }

  const jobId = `simdup_${randomUUID().slice(0, 8)}`;
  const stateFile = join(SIM_STATE_DIR, `${jobId}.json`);
  const initial = {
    id: jobId, type, rootPaths: paths, threshold,
    status: 'counting', progress: { total: 0, processed: 0, currentFile: '' },
    files: [], groups: [], stats: { totalFiles: 0, groups: 0, files: 0, wastedBytes: 0 }, error: null,
    startTime: Date.now(), _aborted: false, _paused: false,
  };
  const tmpInit = stateFile + '.tmp';
  writeFileSync(tmpInit, JSON.stringify(initial));
  renameSync(tmpInit, stateFile);

  if (existsSync(SIM_SCAN_SCRIPT)) {
    const proc = spawn(process.execPath, [SIM_SCAN_SCRIPT, type, paths.join(','), jobId, SIM_STATE_DIR, String(threshold)], {
      // imports inside the worker resolve relative to the worker file, not cwd
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (proc.stdout) proc.stdout.on('data', () => {});
    if (proc.stderr) proc.stderr.on('data', c => process.stderr.write(`[simdup] ${c}`));
    proc.on('error', e => {
      process.stderr.write(`[simdup] spawn error: ${e}\n`);
    });
  }

  sendJSON(res, 200, { jobId, success: true, type, threshold });
}

// GET /api/simdup/status?job=simdup_xxx
export function handleSimDupStatus(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^simdup_/.test(jobId)) {
    sendJSON(res, 400, { error: 'job 参数缺失或非法' });
    return;
  }
  const state = safeReadJSON(join(SIM_STATE_DIR, `${jobId}.json`));
  if (!state.id) {
    sendJSON(res, 404, { error: '任务不存在' });
    return;
  }
  sendJSON(res, 200, state);
}

// POST /api/simdup/stop { job: id }
export function handleSimDupStop(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^simdup_/.test(jobId)) {
    sendJSON(res, 400, { error: 'job 参数缺失或非法' });
    return;
  }
  const stateFile = join(SIM_STATE_DIR, `${jobId}.json`);
  try {
    if (existsSync(stateFile)) {
      const state = safeReadJSON(stateFile);
      state._aborted = true;
      writeFileSync(stateFile + '.tmp', JSON.stringify(state));
      renameSync(stateFile + '.tmp', stateFile);
    }
  } catch (e) { /* ignore */ }
  sendJSON(res, 200, { stopped: true, job: jobId });
}