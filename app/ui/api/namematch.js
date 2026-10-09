// ── Same-name Conflict Detection API (P2-2) ──
// Wraps the namematch_scan.js subprocess worker. Groups files sharing the
// same filename across different directories.
//
//   POST /api/namematch/scan    { paths:[...] } → { jobId }
//   GET  /api/namematch/status ?job=name_xxx → progress + groups
//   POST /api/namematch/stop   ?job= → { stopped }

import { existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { sendJSON, parseBody, isSafePath, safeReadJSON } from '../lib/util.js';

let NM_STATE_DIR = '';
let NM_SCAN_SCRIPT = '';

export function setNamematchPaths(stateDir, script) {
  NM_STATE_DIR = stateDir;
  NM_SCAN_SCRIPT = script;
  mkdirSync(stateDir, { recursive: true });
}

// POST /api/namematch/scan
export async function handleNamematchScan(req, res) {
  const data = await parseBody(req);
  const paths = Array.isArray(data.paths) ? data.paths.map(p => p.trim()).filter(Boolean) : [];

  if (paths.length === 0) {
    sendJSON(res, 400, { error: '请至少选择一个扫描目录', success: false });
    return;
  }
  for (const p of paths) {
    if (!existsSync(p)) { sendJSON(res, 400, { error: `目录不存在: ${p}`, success: false }); return; }
    if (!isSafePath(p)) { sendJSON(res, 403, { error: `路径越界：${p} 仅允许 /vol* 下的目录`, success: false }); return; }
  }

  const jobId = `name_${randomUUID().slice(0, 8)}`;
  const stateFile = join(NM_STATE_DIR, `${jobId}.json`);
  const initial = {
    id: jobId, type: 'namematch', rootPaths: paths,
    status: 'scanning', progress: { scanned: 0, currentFile: '' },
    groups: [], stats: { scanned: 0, groups: 0, files_in_groups: 0 }, error: null,
    startTime: Date.now(), _aborted: false,
  };
  const tmp = stateFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(initial));
  renameSync(tmp, stateFile);

  if (existsSync(NM_SCAN_SCRIPT)) {
    const proc = spawn(process.execPath, [NM_SCAN_SCRIPT, paths.join(','), jobId, NM_STATE_DIR], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (proc.stderr) proc.stderr.on('data', c => process.stderr.write(`[namematch] ${c}`));
    proc.on('error', e => process.stderr.write(`[namematch] spawn error: ${e}\n`));
  }

  sendJSON(res, 200, { jobId, success: true });
}

// GET /api/namematch/status?job=name_xxx
export function handleNamematchStatus(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^name_/.test(jobId)) {
    sendJSON(res, 400, { error: 'job 参数缺失或非法' });
    return;
  }
  const state = safeReadJSON(join(NM_STATE_DIR, `${jobId}.json`));
  if (!state.id) { sendJSON(res, 404, { error: '任务不存在' }); return; }
  sendJSON(res, 200, state);
}

// POST /api/namematch/stop?job=name_xxx
export function handleNamematchStop(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^name_/.test(jobId)) { sendJSON(res, 400, { error: 'job 非法' }); return; }
  const stateFile = join(NM_STATE_DIR, `${jobId}.json`);
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
    console.error('[namematch] stop failed:', e.message);
    sendJSON(res, 200, { stopped: false, error: e.message, job: jobId });
    return;
  }
  sendJSON(res, 200, { stopped: true, job: jobId });
}