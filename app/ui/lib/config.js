// ── Global constants ──
import { existsSync, statSync } from 'node:fs';
import { listExternalVolumes } from './ext_trash.js';

export const VERSION = '0.15.2';

// 内置存储空间（用户卷）。这几个卷有 btrfs 的 /volN/<UID>/.@#local/trash 回收站。
export const USER_VOL_GLOBS = ['/vol1','/vol2','/vol3','/vol4','/vol5','/vol6','/vol7','/vol8','/vol9','/vol10'];

// /vol02 是 fnOS 的真实网盘挂载根（不是 /vol2）—— 网盘残留如 /vol02/1000-1-0985cb1c 在这里。
// 它没有可写回收站（fuse 拒绝 mkdir），删除只能走永久删除或跳过。
export const CLOUD_VOL_GLOBS = ['/vol02'];

// 兼容旧引用：白名单 = 内置卷 + 网盘。外接盘用 listExternalVolumes() 动态获取，
// 因为插拔随时会变，不能写死在常量里。
export const VOL_GLOBS = [...USER_VOL_GLOBS, ...CLOUD_VOL_GLOBS];
export const SAFE_PREFIXES = new Set(VOL_GLOBS.map(v => v + '/'));

/** 是否存在且是目录 */
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

/**
 * 浏览对话框的根目录列表（外接设备会出现在这里）。
 * @returns {{path:string, name:string, label:string, kind:'user'|'cloud'|'external'}[]}
 */
export function listBrowseRoots() {
  const out = [];
  for (const v of USER_VOL_GLOBS) {
    if (existsSync(v) && isDir(v)) out.push({ path: v, name: v.slice(1), label: v, kind: 'user' });
  }
  for (const v of CLOUD_VOL_GLOBS) {
    if (existsSync(v) && isDir(v)) out.push({ path: v, name: v.slice(1), label: `${v}（网盘）`, kind: 'cloud' });
  }
  for (const v of listExternalVolumes()) {
    out.push({ path: v, name: v.slice(1), label: `${v}（外接设备）`, kind: 'external' });
  }
  return out;
}

/**
 * 扫描类功能（重复文件 / 空目录 / 大文件 / 磁盘分析）的默认扫描根。
 * 含外接设备；**不含网盘** —— 网盘走 fuse，逐个文件 stat 极慢且删除不可回收。
 */
export function listScanRoots() {
  const out = [];
  for (const v of USER_VOL_GLOBS) {
    if (existsSync(v) && isDir(v)) out.push(v);
  }
  for (const v of listExternalVolumes()) out.push(v);
  return out;
}

export const MUSIC_EXTS = new Set(['.mp3','.flac','.wav','.aac','.ogg','.m4a','.wma','.alac','.ape','.dsf']);
export const SYSTEM_NETWORKS = new Set(['bridge','host','none','container']);
export const TEMP_DIRS = ['/tmp', '/var/tmp'];

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};
