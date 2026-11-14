// ── Bad Names API（不规范文件名）──
// Wraps the badname_scan.js subprocess worker.
//
//   POST /api/badname/scan    { paths:[...] } → { jobId }
//   GET  /api/badname/status ?job=badname_xxx → progress + items
//   POST /api/badname/stop   ?job= → { stopped }
//   POST /api/badname/fix    { items:[{ path, newName }] } → 重命名修复

import { existsSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename, sep } from 'node:path';
import { sendJSON, parseBody, isSafePath, isDeletablePath, protectedReason, safeReadJSON, spawnScanNode } from '../lib/util.js';

let BN_STATE_DIR = '';
let BN_SCAN_SCRIPT = '';

export function setBadNamePaths(stateDir, script) {
  BN_STATE_DIR = stateDir;
  BN_SCAN_SCRIPT = script;
  mkdirSync(stateDir, { recursive: true });
}

// POST /api/badname/scan
export async function handleBadNameScan(req, res) {
  const data = await parseBody(req);
  const paths = Array.isArray(data.paths) ? data.paths.map(p => String(p || '').trim()).filter(Boolean) : [];

  if (paths.length === 0) {
    sendJSON(res, 400, { error: '请至少选择一个扫描目录', success: false });
    return;
  }
  for (const p of paths) {
    if (!existsSync(p)) { sendJSON(res, 400, { error: `目录不存在: ${p}`, success: false }); return; }
    if (!isSafePath(p)) { sendJSON(res, 403, { error: `路径越界：${p} 仅允许 /vol* 下的目录`, success: false }); return; }
  }

  const jobId = `badname_${randomUUID().slice(0, 8)}`;
  const stateFile = join(BN_STATE_DIR, `${jobId}.json`);
  const initial = {
    id: jobId, type: 'badname', rootPaths: paths,
    status: 'scanning', progress: { scanned: 0, currentFile: '' },
    items: [], stats: { scanned: 0, bad: 0, high: 0, medium: 0, low: 0, byCode: {}, skipped: 0 },
    error: null, startTime: Date.now(), _aborted: false,
  };
  const tmp = stateFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(initial));
  renameSync(tmp, stateFile);

  if (existsSync(BN_SCAN_SCRIPT)) {
    const proc = spawnScanNode(BN_SCAN_SCRIPT, [paths.join(','), jobId, BN_STATE_DIR], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (proc.stderr) proc.stderr.on('data', c => process.stderr.write(`[badname] ${c}`));
    proc.on('error', e => process.stderr.write(`[badname] spawn error: ${e}\n`));
  }

  sendJSON(res, 200, { jobId, success: true });
}

// GET /api/badname/status?job=badname_xxx
export function handleBadNameStatus(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^badname_/.test(jobId)) {
    sendJSON(res, 400, { error: 'job 参数缺失或非法' });
    return;
  }
  const state = safeReadJSON(join(BN_STATE_DIR, `${jobId}.json`));
  if (!state.id) { sendJSON(res, 404, { error: '任务不存在' }); return; }
  sendJSON(res, 200, state);
}

// POST /api/badname/stop?job=badname_xxx
export function handleBadNameStop(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^badname_/.test(jobId)) { sendJSON(res, 400, { error: 'job 非法' }); return; }
  const stateFile = join(BN_STATE_DIR, `${jobId}.json`);
  try {
    if (existsSync(stateFile)) {
      const state = safeReadJSON(stateFile);
      state._aborted = true;
      writeFileSync(stateFile + '.tmp', JSON.stringify(state));
      renameSync(stateFile + '.tmp', stateFile);
    }
  } catch (e) {
    console.error('[badname] stop failed:', e.message);
    sendJSON(res, 200, { stopped: false, error: e.message, job: jobId });
    return;
  }
  sendJSON(res, 200, { stopped: true, job: jobId });
}

// 新名字里必须排除路径分隔符，否则 rename 会写到自己推导的目录之外
function sanitizeNewName(name) {
  return String(name || '')
    .replace(/[\/\\]/g, '_')          // 路径分隔符
    .replace(/[\x00-\x1F\x7F]/g, '')  // 控制字符
    .replace(/^[\s.]+|[\s.]+$/g, '')  // 首尾空格/点
    .trim();
}

/**
 * POST /api/badname/fix  { items:[{ path, newName }] }
 * 只改名，不动内容、不移动目录。目标已存在时自动加 _1/_2 后缀，绝不覆盖。
 */
export async function handleBadNameFix(req, res) {
  const data = await parseBody(req);
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) { sendJSON(res, 400, { error: '未提供要修复的条目', success: false }); return; }

  let fixed = 0;
  const failed = [];
  const done = [];

  for (const it of items.slice(0, 500)) {
    const src = String(it.path || '');
    try {
      const rawNewName = String(it.newName || '');
      const newName = sanitizeNewName(rawNewName);
      if (!src) throw new Error('path 缺失');
      if (!newName) throw new Error('新文件名为空或只含非法字符');
      // sanitize 已经把 / \ 和控制字符换成 _/删掉了，这里再显式拒绝一次分隔符，
      // 防止后续有人改动 sanitize 时把这道保护一起改掉。
      if (newName.includes('/') || newName.includes('\\')) throw new Error('新文件名不得包含路径分隔符');
      // 名字被静默改写时告知用户 —— 否则他输入 ../../etc/evil 会得到一个
      // 奇怪的 _.._etc_evil，却不知道为什么。
      const sanitized = rawNewName !== newName;
      if (!existsSync(src)) throw new Error('文件不存在');
      if (!isDeletablePath(src)) throw new Error('路径不可操作：' + (protectedReason(src) || '越界'));

      const dir = dirname(src);
      if (!isSafePath(dir)) throw new Error('所在目录越界');

      const oldName = basename(src);
      if (newName === oldName) { done.push({ path: src, target: src, skipped: '名字未变' }); continue; }

      let target = join(dir, newName);
      if (existsSync(target)) {
        // 同名冲突：在扩展名前插入 _n
        const dot = newName.lastIndexOf('.');
        const stem = dot > 0 ? newName.slice(0, dot) : newName;
        const ext = dot > 0 ? newName.slice(dot) : '';
        let n = 1;
        while (existsSync(join(dir, `${stem}_${n}${ext}`)) && n < 1000) n++;
        target = join(dir, `${stem}_${n}${ext}`);
      }

      renameSync(src, target);
      fixed++;
      done.push({ path: src, target, sanitized });
    } catch (e) {
      failed.push({ path: src, reason: e.message });
    }
  }

  sendJSON(res, 200, {
    success: true, fixed, failed: failed.length, failures: failed.slice(0, 50), items: done,
  });
}
