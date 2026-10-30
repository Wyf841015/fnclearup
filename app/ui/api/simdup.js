// ── Similar Image / Video Detection API (P0-2) ──
// Wraps the simdup_scan.js subprocess worker (process isolation, same
// pattern as dup.js). Endpoints:
//
//   POST /api/simdup/scan    { type:'image'|'video', paths:[...], threshold? } → { jobId }
//   GET  /api/simdup/status  ?job=id → progress + groups
//   POST /api/simdup/stop    { job: id, _aborted:1 } → { stopped }
//
// Worker writes state to <stateDir>/simdup_<jobId>.json (atomic tmp+rename).

import { existsSync, writeFileSync, mkdirSync, renameSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join, extname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { sendJSON, parseBody, isSafePath, safeReadJSON } from '../lib/util.js';
import { getPkgVar } from '../lib/pkgvar.js';

let SIM_STATE_DIR = '';
let SIM_SCAN_SCRIPT = '';

export function setSimDupPaths(stateDir, script) {
  SIM_STATE_DIR = stateDir;
  SIM_SCAN_SCRIPT = script;
  mkdirSync(stateDir, { recursive: true });
}

const VALID_TYPES = ['image', 'video'];
const FFMPEG_BIN = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';

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
  } catch (e) {
    // P1: 状态文件写失败(磁盘满/权限)时不能仍回 stopped:true ——
    // 那会让前端显示"已停止", 而扫描子进程继续跑满一小时预算。
    console.error('[simdup] stop failed:', e.message);
    sendJSON(res, 200, { stopped: false, error: e.message, job: jobId });
    return;
  }
  sendJSON(res, 200, { stopped: true, job: jobId });
}

// ── 缩略图 (P1-4) ─────────────────────────────────────────────────────────
// 相似文件的结果光有路径和相似度不够, 用户需要"眼见为实"才能决定删哪张。
// 这里按需生成 320px 宽的 JPEG 缩略图并落盘缓存(键含 mtime+size, 文件一变即失效)。
const THUMB_WIDTH = 320;
const THUMB_QUALITY = '5';                       // ffmpeg -q:v, 2(最好)~31(最差)
const THUMB_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.heic',
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg', '.ts',
]);
const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg', '.ts',
]);

function thumbCacheDir() {
  const base = getPkgVar();
  const d = join(base, 'data', 'thumbs');
  try { mkdirSync(d, { recursive: true }); } catch (e) { /* 目录不可写则不缓存 */ }
  return d;
}

/** 生成(或复用)缩略图, 返回 JPEG 字节; 失败返回 null */
function buildThumb(absPath) {
  let st;
  try { st = statSync(absPath); } catch { return null; }
  if (!st.isFile() || st.size === 0) return null;

  const key = createHash('sha1')
    .update(`${absPath}|${st.size}|${Math.floor(st.mtimeMs)}|v3`)
    .digest('hex');
  const out = join(thumbCacheDir(), key + '.jpg');

  if (existsSync(out)) {
    try { return readFileSync(out); } catch { /* 缓存损坏则重新生成 */ }
  }

  const tmp = out + '.tmp' + process.pid;
  const args = [];
  if (VIDEO_EXTS.has(extname(absPath).toLowerCase())) {
    // 视频取 1 秒处的帧(避开纯黑片头); 再退化为 0 秒
    args.push('-ss', '1');
  }
  args.push('-i', absPath,
    '-frames:v', '1',
    '-vf', `scale=${THUMB_WIDTH}:-1:force_original_aspect_ratio=decrease`,
    '-q:v', THUMB_QUALITY,
    '-f', 'image2', '-y', tmp);

  const r = spawnSync(FFMPEG_BIN, args, { timeout: 20000, stdio: ['ignore', 'ignore', 'ignore'] });
  if (r.status !== 0 || !existsSync(tmp)) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return null;
  }
  try {
    const buf = readFileSync(tmp);
    renameSync(tmp, out);
    return buf;
  } catch { return null; }
  finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
}

// GET /api/simdup/thumb?path=<abs>
export function handleSimDupThumb(req, res, url) {
  const p = url.searchParams.get('path') || '';
  if (!p) return sendJSON(res, 400, { error: '缺少 path 参数' });
  if (!isSafePath(p)) return sendJSON(res, 403, { error: '路径越界：仅允许 /vol* 下的文件' });
  if (!existsSync(p)) return sendJSON(res, 404, { error: '文件不存在' });
  const ext = extname(p).toLowerCase();
  if (!THUMB_EXTS.has(ext)) return sendJSON(res, 400, { error: `不支持的文件类型: ${ext}` });

  let buf;
  try { buf = buildThumb(p); }
  catch (e) { return sendJSON(res, 500, { error: '缩略图生成失败: ' + e.message }); }
  if (!buf) return sendJSON(res, 500, { error: '缩略图生成失败（文件可能已损坏或格式不受支持）' });

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=86400',   // 键含 mtime, 文件一变即换 URL 内容
  });
  res.end(buf);
}
