import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { existsSync, statSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { SAFE_PREFIXES } from './config.js';

export function formatBytes(b) {
  if (b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

export async function parseBody(req) {
  if (req.method === 'GET') return {};
  const bufs = [];
  for await (const chunk of req) bufs.push(chunk);
  try { return JSON.parse(Buffer.concat(bufs).toString()); }
  catch { return {}; }
}

// CORS origins: comma-separated env var, or specific dev defaults
export const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:9633,http://127.0.0.1:9633').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_ANY_ORIGIN = CORS_ORIGINS.includes('*');

export function sendJSON(res, code, data) {
  const origin = res.req?.headers?.origin;
  const allowOrigin = ALLOW_ANY_ORIGIN ? '*' : (origin && CORS_ORIGINS.includes(origin) ? origin : CORS_ORIGINS[0] || '*');
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
  });
  res.end(JSON.stringify(data));
}

export function execCmd(cmd, args, timeout = 30000) {
  return new Promise((resolve2) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let killed = false;
    proc.stdout.on('data', c => stdout += c);
    proc.stderr.on('data', c => stderr += c);
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      // 5s grace period, then SIGKILL if still alive
      setTimeout(() => {
        if (!killed) { try { proc.kill('SIGKILL'); } catch {} }
      }, 5000);
    }, timeout);
    proc.on('close', code => { clearTimeout(killTimer); killed = true;
      resolve2({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
    proc.on('error', e => { clearTimeout(killTimer); killed = true;
      resolve2({ code: -1, stdout: '', stderr: e.message }); });
  });
}

export function isSafePath(p) {
  if (!p) return false;
  const n = resolve(p);
  // Standard whitelist: /vol* paths (allow the dir itself like /vol2 or any subdir like /vol2/foo)
  if ([...SAFE_PREFIXES].some(pre => n === pre.slice(0, -1) || n.startsWith(pre))) return true;
  // Test fixture allowlist: when TRM_FNCLEARUP_TEST=1, allow /tmp/fnclearup_test paths
  if (process.env.TRM_FNCLEARUP_TEST === '1' && (n === '/tmp/fnclearup_test' || n.startsWith('/tmp/fnclearup_test/'))) return true;
  return false;
}

// ── fnOS 系统保留目录(P0 安全, 2026-09-30) ────────────────────────────────
//
// 问题: isSafePath 的白名单只到 "/vol*" 粒度, 而 fnOS 的系统与应用目录
//       全部位于 /volN/@xxx 之下, 全部通过校验:
//         /vol3/@appcenter  所有应用的安装目录(代码+二进制) —— 删掉应用就起不来
//         /vol3/@appdata    应用运行数据(SQLite/配置)      —— 删掉数据就丢
//         /vol3/@appmeta    应用元信息
//         /vol3/@apphome /@appconf /@appshare /@apptemp /@sysappmeta
//         /volN/<uid>/.@#local  卷内回收站 —— 删掉绕过二次恢复
//       重复文件扫描常在这些目录间发现相同文件(各应用的 LICENSE、图标、依赖),
//       用户勾选删除即会误删其他应用的文件。
//
// 为什么用精确名单而不是 /@[^/]+/ 正则:
//       用户自己的目录也可能以 @ 开头(如 /vol1/1000/@我的照片),
//       通配会误伤。这里只认 fnOS 实际使用的 8 个系统目录名。
const FNOS_SYSTEM_DIRS = new Set([
  '@appcenter', '@appconf', '@appdata', '@apphome',
  '@appmeta', '@appshare', '@apptemp', '@sysappmeta',
]);

/** 应用自身数据目录(TRM_PKGVAR) —— 哈希缓存/manifest/导出都在这里, 豁免保护 */
function pkgvarRoot() {
  return resolve(process.env.TRM_PKGVAR || '/vol3/@appdata/fnclearup');
}

/**
 * 判断路径是否落在受保护范围内。
 * @param {string} p
 * @param {{exemptSelf?: boolean}} [opts] exemptSelf=true 时豁免应用自身数据目录,
 *        供"能否写入/读取"类场景使用; 删除类场景必须传 false 或用默认值,
 *        否则清理工具会把自己的哈希缓存/manifest 一并删掉。
 * @returns {string|null} 受保护时返回可展示给用户的原因, 否则 null
 */
export function protectedReason(p, opts = {}) {
  if (!p) return '路径为空';
  // P2 安全: 必须 realpath 解析软链再判段名。resolve() 只消除 '..', 不解软链 ——
  // 软链自身名字无害(像 /vol1/1000/我的下载)但指向 /vol3/@appcenter 时,
  // 按传入路径拆段查不到 @appcenter, 于是放行 → 删掉别的应用安装文件。
  // realpathSync 对不存在的路径会抛 ENOENT, 此时回退到 resolve 的结果
  // (该路径本就无法被删除, 不应因此误判为受保护而改变其他行为)。
  let n = resolve(p);
  try { n = realpathSync(n); } catch { /* 不存在: 保持 resolve 结果 */ }
  if (opts.exemptSelf !== false) {
    const own = pkgvarRoot();
    if (n === own || n.startsWith(own + '/')) return null;   // 自身数据目录豁免
  }
  for (const seg of n.split('/')) {
    if (FNOS_SYSTEM_DIRS.has(seg)) {
      return `fnOS 系统目录受保护（${seg}）：内含应用安装文件与运行数据，删除会导致应用无法启动`;
    }
    if (seg.startsWith('.@#')) {
      return `回收站目录受保护（${seg}）：直接删除将绕过回收站，无法二次恢复`;
    }
  }
  return null;
}

export function isProtectedPath(p, opts = {}) { return protectedReason(p, opts) !== null; }

/** 可删除路径: 既要在 /vol* 白名单内, 又不能落在受保护目录。
 *  注意: 删除场景不豁免应用自身数据目录。 */
export function isDeletablePath(p) { return isSafePath(p) && !isProtectedPath(p, { exemptSelf: false }); }

/** 按受保护原因把路径分组, 便于 API 一次性回执跳过原因 */
export function partitionDeletable(paths) {
  const ok = [], blocked = [];
  for (const p of paths) {
    const why = protectedReason(p, { exemptSelf: false });
    if (why) blocked.push({ path: p, reason: why });
    else if (isSafePath(p)) ok.push(p);
    else blocked.push({ path: p, reason: '路径越界：仅允许 /vol* 下的目录' });
  }
  return { ok, blocked };
}

// Return the directory where audit manifests (sysclean pre-clean snapshots) are stored.
// Manifests are app-level audit artifacts, NOT user-deleted files. They live in the same
// parent directory as the system log (info.log), under a dedicated data/manifests/ subdir.
//
// Priority:
//   1. TRM_PKGVAR (fnOS standard; e.g. /vol3/@appcenter/fnclearup/) → <PKGVAR>/data/manifests
//      This puts them alongside info.log and app.pid (also under <PKGVAR>).
//   2. /var/fnclearup/data/manifests (admin-writable fallback for non-fnOS / bare deploys)
//   3. /tmp/fnclearup_test/data/manifests (test mode, keeps fixtures isolated)
//
// Caller is expected to mkdirSync({recursive:true}) before writing.
export function getManifestDir() {
  // Test mode: explicit isolation under /tmp/fnclearup_test (TRM_PKGVAR is also
  // pointed there in tests, but we want a known fixture path regardless of PKGVAR).
  if (process.env.TRM_FNCLEARUP_TEST === '1') {
    return '/tmp/fnclearup_test/data/manifests';
  }
  // Production: TRM_PKGVAR (fnOS standard; e.g. /vol3/@appcenter/fnclearup/) →
  // <PKGVAR>/data/manifests. This puts them alongside info.log and app.pid
  // (also under <PKGVAR>).
  const pkgvar = process.env.TRM_PKGVAR;
  if (pkgvar && pkgvar !== '/' && pkgvar.length > 1) {
    return join(pkgvar, 'data', 'manifests');
  }
  return '/var/fnclearup/data/manifests';
}

// Backwards-compatible alias (older code referenced this name; semantics shifted
// from "user trash dir" to "app manifest dir" so callers should migrate to
// getManifestDir() when writing manifest artifacts).
export const getSafeTrashDir = getManifestDir;

export function parseQuery(url) {
  const q = url.searchParams;
  const o = {};
  for (const [k, v] of q) o[k] = v;
  return o;
}

// Safe JSON.parse of a file that may be missing or corrupt (e.g. a scan state
// file written mid-crash). Returns {} on any failure instead of throwing, so a
// truncated/corrupt state file can't take down an API handler.
export function safeReadJSON(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[util] failed to read/parse ${filePath}:`, e.message);
    return {};
  }
}
