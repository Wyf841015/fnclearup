// ── Bad Extensions API（扩展名与内容不符）──
// Wraps the badext_scan.js subprocess worker.
//
//   POST /api/badext/scan    { paths:[...] } → { jobId }
//   GET  /api/badext/status ?job=badext_xxx → progress + items
//   POST /api/badext/stop   ?job= → { stopped }
//   POST /api/badext/fix    { items:[{path, suggest}] } → 重命名（可选）

import { existsSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, basename, extname } from 'node:path';
import { sendJSON, parseBody, isSafePath, isDeletablePath, protectedReason, safeReadJSON, spawnScanNode } from '../lib/util.js';

let BE_STATE_DIR = '';
let BE_SCAN_SCRIPT = '';

export function setBadExtPaths(stateDir, script) {
  BE_STATE_DIR = stateDir;
  BE_SCAN_SCRIPT = script;
  mkdirSync(stateDir, { recursive: true });
}

// POST /api/badext/scan
export async function handleBadExtScan(req, res) {
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

  const jobId = `badext_${randomUUID().slice(0, 8)}`;
  const stateFile = join(BE_STATE_DIR, `${jobId}.json`);
  const initial = {
    id: jobId, type: 'badext', rootPaths: paths,
    status: 'scanning', progress: { scanned: 0, currentFile: '' },
    items: [], stats: { scanned: 0, mismatch: 0, no_ext: 0, unknown: 0, text_ok: 0, skipped: 0, byKind: {} },
    error: null, startTime: Date.now(), _aborted: false,
  };
  const tmp = stateFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(initial));
  renameSync(tmp, stateFile);

  if (existsSync(BE_SCAN_SCRIPT)) {
    const proc = spawnScanNode(BE_SCAN_SCRIPT, [paths.join(','), jobId, BE_STATE_DIR], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (proc.stderr) proc.stderr.on('data', c => process.stderr.write(`[badext] ${c}`));
    proc.on('error', e => process.stderr.write(`[badext] spawn error: ${e}\n`));
  }

  sendJSON(res, 200, { jobId, success: true });
}

// GET /api/badext/status?job=badext_xxx
export function handleBadExtStatus(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^badext_/.test(jobId)) {
    sendJSON(res, 400, { error: 'job 参数缺失或非法' });
    return;
  }
  const state = safeReadJSON(join(BE_STATE_DIR, `${jobId}.json`));
  if (!state.id) { sendJSON(res, 404, { error: '任务不存在' }); return; }
  sendJSON(res, 200, state);
}

// POST /api/badext/stop?job=badext_xxx
export function handleBadExtStop(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const jobId = url.searchParams.get('job');
  if (!jobId || !/^badext_/.test(jobId)) { sendJSON(res, 400, { error: 'job 非法' }); return; }
  const stateFile = join(BE_STATE_DIR, `${jobId}.json`);
  try {
    if (existsSync(stateFile)) {
      const state = safeReadJSON(stateFile);
      state._aborted = true;
      writeFileSync(stateFile + '.tmp', JSON.stringify(state));
      renameSync(stateFile + '.tmp', stateFile);
    }
  } catch (e) {
    console.error('[badext] stop failed:', e.message);
    sendJSON(res, 200, { stopped: false, error: e.message, job: jobId });
    return;
  }
  sendJSON(res, 200, { stopped: true, job: jobId });
}

/**
 * POST /api/badext/fix  { items:[{ path, suggest }] }
 * 把扩展名改成正确的。只改扩展名，不改文件内容。
 * 目标已存在时自动加 _1/_2 后缀，绝不覆盖。
 */
export async function handleBadExtFix(req, res) {
  const data = await parseBody(req);
  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) { sendJSON(res, 400, { error: '未提供要修复的条目', success: false }); return; }

  let fixed = 0;
  const failed = [];
  const done = [];

  for (const it of items.slice(0, 500)) {    // 单次上限，避免超长请求
    const src = String(it.path || '');
    const suggest = String(it.suggest || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    try {
      if (!src || !suggest) throw new Error('参数缺失');
      if (!existsSync(src)) throw new Error('文件不存在');
      if (!isDeletablePath(src)) throw new Error('路径不可操作：' + (protectedReason(src) || '越界'));
      const st = statSync(src);
      if (!st.isFile()) throw new Error('不是普通文件');

      const dir = dirname(src);
      const oldBase = basename(src);
      const oldExt = extname(oldBase);
      const stem = oldExt ? oldBase.slice(0, -oldExt.length) : oldBase;
      if (!stem) throw new Error('无法从文件名推导主干');

      let target = join(dir, `${stem}.${suggest}`);
      // 同名冲突：加序号，绝不覆盖已有文件
      if (existsSync(target) && target !== src) {
        let n = 1;
        while (existsSync(join(dir, `${stem}_${n}.${suggest}`)) && n < 1000) n++;
        target = join(dir, `${stem}_${n}.${suggest}`);
      }
      if (target === src) { done.push({ path: src, target, skipped: '扩展名已正确' }); continue; }

      renameSync(src, target);
      fixed++;
      done.push({ path: src, target });
    } catch (e) {
      failed.push({ path: src, reason: e.message });
    }
  }

  sendJSON(res, 200, {
    success: true, fixed, failed: failed.length, failures: failed.slice(0, 50), items: done,
  });
}
