// 应用数据目录（PKGVAR）解析
//
// 为什么需要这个模块：
//   以前所有落盘路径都写成 `process.env.TRM_PKGVAR || '/vol3/@appdata/fnclearup'`。
//   框架启动应用时会注入 TRM_PKGVAR（值跟着**安装卷**走，装在 vol1 就是
//   /vol1/@appdata/fnclearup），可一旦手动 `node ui/server.js`（调试、重启脚本、
//   守护脚本），环境变量没了，就会掉回写死的 /vol3 —— 于是同一台机器上：
//     · 框架启 → 读 <vol1>/@appdata/fnclearup/data/...
//     · 手动启 → 读 /vol3/@appdata/fnclearup/data/...
//   表现为「开关设了又变回去 / 计划任务不见了 / 哈希缓存像丢了」。
//
// 现在的解析顺序：
//   1. TRM_PKGVAR（框架注入，最权威，原样使用）
//   2. 从本文件真实路径反推：<vol>/@appcenter/<app>/... → <vol>/@appdata/<app>
//      （/var/apps/<app>/target 是软链，realpath 之后一样能反推出来）
//   3. 兜底才用历史字面量 /vol3/@appdata/fnclearup
//
// 反推只用路径字符串计算，不依赖 cwd、不依赖应用名常量（app 名从路径里取），
// 因此放在别的目录名下（例如 @appcenter/otherapp）也能算对。
import { realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'fnclearup';
const LEGACY_PKGVAR = `/vol3/@appdata/${APP_NAME}`;

/**
 * 纯函数：从任意文件/目录路径反推 PKGVAR。
 *   /vol1/@appcenter/fnclearup/ui/lib/pkgvar.js → /vol1/@appdata/fnclearup
 *   /var/apps/fnclearup/target/ui/server.js     → 不含 @appcenter，返回 null
 *   /vol3/1000/hermes/fnclearup/app/ui/lib/x.js → 返回 null（开发目录不是安装目录）
 * @param {string} p
 * @returns {string|null}
 */
export function derivePkgVarFromPath(p) {
  if (!p || typeof p !== 'string') return null;
  const segs = p.split(/[\\/]+/).filter(Boolean);
  const i = segs.indexOf('@appcenter');
  if (i <= 0) return null;                       // 不在安装目录里，不猜
  const app = segs[i + 1];
  if (!app || app.startsWith('@')) return null;  // @appcenter 下一级必须是应用目录
  const vol = (p.startsWith('/') ? '/' : '') + segs.slice(0, i).join('/');
  return join(vol === '/' ? sep : vol, '@appdata', app);
}

/**
 * 从本模块的真实路径反推（软链会先 realpath）。
 * @param {string} [moduleUrl] 便于测试注入
 * @returns {string|null}
 */
export function derivePkgVar(moduleUrl = import.meta.url) {
  let file = '';
  try { file = fileURLToPath(moduleUrl); } catch { return null; }
  let real = file;
  try { real = realpathSync(file); } catch { /* 文件还没落盘就用原路径 */ }
  const fromReal = derivePkgVarFromPath(real);
  if (fromReal) return fromReal;
  return derivePkgVarFromPath(file);
}

/**
 * 当前生效的 PKGVAR。每次现算（成本就是几次字符串切分），
 * 不在模块里缓存 —— 缓存会让测试里改 env / 换路径变得不可预测。
 * @returns {string}
 */
export function getPkgVar() {
  const env = process.env.TRM_PKGVAR;
  if (env && String(env).trim()) return String(env).trim();
  return derivePkgVar() || LEGACY_PKGVAR;
}

/** 应用数据目录：<PKGVAR>/data[/<parts…>]
 *  pkgDataDir()            → <PKGVAR>/data
 *  pkgDataDir('manifests') → <PKGVAR>/data/manifests（与 util.getManifestDir 一致） */
export function pkgDataDir(...parts) {
  return join(getPkgVar(), 'data', ...parts);
}

export const _internals = { APP_NAME, LEGACY_PKGVAR, dirname };
