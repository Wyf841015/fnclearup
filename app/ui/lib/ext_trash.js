// app/ui/lib/ext_trash.js
// 外接存储（U 盘 / 移动硬盘）的回收站支持。
//
// 为什么需要单独一套：
//   fnOS 把可移除设备挂在 /vol00、/vol01 …（两位零前缀，见 check_perm / filestor_service
//   二进制里的 "/vol00/" 与 "fuseblk ntfs exfat"）。这些卷多为 exFAT / NTFS，
//   **没有** btrfs 用户卷那套 /volN/<UID>/.@#local/trash，
//   所以 delete 时若照旧映射回收站路径，只能落到「路径格式不支持回收站 → 失败」
//   或者更糟：降级成永久删除。
//
// 因此这里采用「同盘回收站」：
//   <该文件所在文件系统的根>/_fnclearup_trash/<原相对路径>
//   - 同设备 → renameSync 原子移动，秒完成、不占额外空间峰值
//   - 跨设备（极少见，文件所在挂载点判断错误时）→ 由调用方捕获 EXDEV 走 cp+rm
//   - 挂载点用 /proc/self/mounts 里的**最长前缀**判断，
//     这样 /vol00/USB_NAME 是独立挂载时，回收站落在 /vol00/USB_NAME/_fnclearup_trash，
//     不会跑到 /vol00 根（那是 root 空壳目录，可能不可写）。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdirSync, renameSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, basename, extname, resolve } from 'node:path';

/** 外接盘回收站目录名（也用于 protectedReason 保护，避免被扫描当成普通目录删掉） */
export const EXT_TRASH_DIR = '_fnclearup_trash';

/**
 * 是否为外接存储路径。
 * /vol00 /vol01 /vol03 …（两位数字），**排除 /vol02**：那是 fnOS 网盘 fuse 挂载，
 * 连 mkdir 都会被拒绝（见 api/trash.js 的既有说明），不适用同盘回收站。
 *
 * TRM_FNCLEARUP_TEST=1 时额外把 /tmp/fnclearup_test 当作"外接卷"，
 * 只为让测试能在沙箱里跑真实的 moveToExtTrash（绝不碰 /vol*）。
 */
export function isExternalVolumePath(p) {
  if (typeof p !== 'string') return false;
  const n = resolve(p);
  if (process.env.TRM_FNCLEARUP_TEST === '1'
      && (n === '/tmp/fnclearup_test' || n.startsWith('/tmp/fnclearup_test/'))) return true;
  if (!/^\/vol0\d(\/|$)/.test(n)) return false;
  if (n === '/vol02' || n.startsWith('/vol02/')) return false;
  return true;
}

/** 当前实际存在的外接卷根（/vol00、/vol01 …，不含网盘） */
export function listExternalVolumes() {
  const out = [];
  let names = [];
  try { names = readdirSync('/'); } catch { return out; }
  for (const name of names) {
    if (!/^vol0\d$/.test(name)) continue;
    const p = '/' + name;
    if (p === '/vol02') continue;                       // 网盘，不是外接盘
    try { if (statSync(p).isDirectory()) out.push(p); } catch { /* ignore */ }
  }
  return out.sort();
}

/**
 * 解析 /proc/self/mounts，返回 [{ path, fstype }]。
 * 只保留绝对路径挂载点；不做 root 伪装，调用方可注入文本以便测试。
 */
export function parseMounts(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const mp = f[1].replace(/\\040/g, ' ');
    if (!mp.startsWith('/')) continue;
    out.push({ path: mp === '' ? '/' : mp, fstype: f[2] });
  }
  return out;
}

function readMounts() {
  try { return parseMounts(readFileSync('/proc/self/mounts', 'utf8')); } catch { return []; }
}

/**
 * 找出路径所在文件系统的挂载点（最长前缀匹配）。
 * 找不到时退回路径自身所在的「卷根」：/vol00/xxx → /vol00。
 */
export function findMountRoot(fp, mounts) {
  const p = resolve(fp);
  const list = Array.isArray(mounts) ? mounts : readMounts();
  let best = null;
  for (const m of list) {
    const mp = m.path;
    if (p === mp || p.startsWith(mp === '/' ? '/' : mp + '/')) {
      if (!best || mp.length > best.length) best = mp;
    }
  }
  if (best) return best;
  const m = p.match(/^(\/vol0\d)\//);
  return m ? m[1] : null;
}

/**
 * 计算外接盘上的回收站目标路径。
 * @returns {{root:string, rel:string, dest:string}|null} 非外接路径返回 null
 */
export function extTrashTarget(fp, mounts) {
  if (!isExternalVolumePath(fp)) return null;
  const p = resolve(fp);
  const root = findMountRoot(p, mounts);
  if (!root) return null;
  if (p === root) return null;                    // 卷根本身不能被删除
  const rel = p.slice(root.length).replace(/^\/+/, '');
  if (!rel) return null;
  return { root, rel, dest: join(root, EXT_TRASH_DIR, rel) };
}

/** 目标已存在时追加 _1 / _2 …（与 dup / empty_dir / files_delete 行为一致） */
export function uniqueDest(dest) {
  if (!existsSync(dest)) return dest;
  const ext = extname(dest);
  const bn = basename(dest);
  const stem = ext ? bn.slice(0, -ext.length) : bn;
  let i = 1;
  let cand = join(dirname(dest), `${stem}_${i}${ext}`);
  while (existsSync(cand)) {
    i += 1;
    cand = join(dirname(dest), `${stem}_${i}${ext}`);
  }
  return cand;
}

/** 路径是否落在外接盘回收站里（保护 + 回收站页展示都靠它） */
export function isExtTrashPath(p) {
  if (typeof p !== 'string') return false;
  const n = resolve(p);
  if (!/^\/vol0\d(\/|$)/.test(n)) return false;
  if (n === '/vol02' || n.startsWith('/vol02/')) return false;
  return n.split('/').includes(EXT_TRASH_DIR);
}

/**
 * 把外接盘上的路径移进同盘回收站。
 *
 * @returns {string|null} 成功返回最终落点，非外接路径返回 null
 * @throws 写不进去时抛错（调用方收进 failed —— 绝不静默降级成永久删除）
 */
export function moveToExtTrash(fp, mounts) {
  const t = extTrashTarget(fp, mounts);
  if (!t) return null;
  mkdirSync(dirname(t.dest), { recursive: true });
  const finalDest = uniqueDest(t.dest);
  try {
    renameSync(fp, finalDest);          // 同盘原子移动，符号链接只动链接本身
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;    // EROFS/EPERM（只读 NTFS、权限不足）交给调用方报错
    cpSync(fp, finalDest, { recursive: true });
    rmSync(fp, { recursive: true, force: true });
  }
  return finalDest;
}
