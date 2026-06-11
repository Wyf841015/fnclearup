// app/ui/api/trash.js
// fnclearup 回收站批量清理 API
import {
  readdirSync, statSync, rmSync, existsSync, writeFileSync, mkdirSync
} from 'node:fs';
import { join } from 'node:path';
import { getManifestDir } from '../lib/util.js';

// fnOS 真实卷 + 网盘挂载根（vol1-10 + vol01-09 + vol02 fuse mount）
const SAFE_VOL_PREFIXES = [
  '/vol1', '/vol2', '/vol3', '/vol4', '/vol5',
  '/vol6', '/vol7', '/vol8', '/vol9', '/vol10',
  '/vol01', '/vol02', '/vol03', '/vol04', '/vol05',
  '/vol06', '/vol07', '/vol08', '/vol09',
];
const LOCAL_TRASH = '.@#local';
const TRASH_SUBDIR = 'trash';

/**
 * 严格白名单校验：路径必须是 /vol<N>/<数字UID>/.@#local/trash[/...]
 * 拒绝任何 .. 段
 */
export function isTrashPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/vol')) return false;
  const m = p.match(/^(\/vol\d+)\/(\d+)(\/.@#local\/trash)(\/.*)?$/);
  if (!m) return false;
  if (!SAFE_VOL_PREFIXES.includes(m[1])) return false;
  if (m[4] && m[4].includes('..')) return false;
  return true;
}

/**
 * 扫描所有 vol × 所有 UID 的 trash 目录
 * fnclearup 以 root 运行，包含全部用户的回收站
 * 返回 [{ path, vol, uid, files, dirs, size, mtime }]
 */
export function getAllTrashDirs() {
  const out = [];
  for (const vol of SAFE_VOL_PREFIXES) {
    if (!existsSync(vol)) continue;
    let uids;
    try { uids = readdirSync(vol); } catch { continue; }
    for (const uid of uids) {
      if (!/^\d+$/.test(uid)) continue;
      const trashDir = join(vol, uid, LOCAL_TRASH, TRASH_SUBDIR);
      if (!existsSync(trashDir)) continue;
      out.push({ path: trashDir, vol, uid });
    }
  }
  return out;
}

/**
 * 递归收集目录统计信息（避开深递归爆栈）
 */
export function collectDirInfo(dir, depth = 0, maxDepth = 16) {
  let files = 0, dirs = 0, size = 0;
  const mtimes = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return { files, dirs, size, mtimes: [] }; }
  for (const e of entries) {
    const p = join(dir, e.name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.mtime) mtimes.push(new Date(st.mtime));
    if (e.isDirectory()) {
      dirs++;
      if (depth < maxDepth) {
        const sub = collectDirInfo(p, depth + 1, maxDepth);
        files += sub.files; dirs += sub.dirs; size += sub.size;
        for (const m of sub.mtimes) mtimes.push(m);
      } else {
        size += st.size;
      }
    } else if (e.isFile()) {
      files++; size += st.size;
    } else if (e.isSymbolicLink()) {
      files++;
    }
  }
  return { files, dirs, size, mtimes };
}

function pickOldestMtime(mtimes) {
  if (!mtimes.length) return null;
  let oldest = mtimes[0];
  for (const m of mtimes) if (m < oldest) oldest = m;
  return oldest;
}

/**
 * 按 mtime 分档
 * buckets: { lt7, lt30, lt90, lt365, gte365 } each { count, size, files, dirs }
 */
export function bucketByAge(items, now = Date.now()) {
  const buckets = {
    lt7:   { count: 0, size: 0, files: 0, dirs: 0 },
    lt30:  { count: 0, size: 0, files: 0, dirs: 0 },
    lt90:  { count: 0, size: 0, files: 0, dirs: 0 },
    lt365: { count: 0, size: 0, files: 0, dirs: 0 },
    gte365:{ count: 0, size: 0, files: 0, dirs: 0 },
  };
  for (const it of items) {
    if (!it.mtime) continue;
    const ageDays = (now - it.mtime.getTime()) / 86400000;
    let key;
    if (ageDays < 7) key = 'lt7';
    else if (ageDays < 30) key = 'lt30';
    else if (ageDays < 90) key = 'lt90';
    else if (ageDays < 365) key = 'lt365';
    else key = 'gte365';
    buckets[key].count++;
    buckets[key].size += it.size;
    buckets[key].files += it.files;
    buckets[key].dirs += it.dirs;
  }
  return buckets;
}

/**
 * 主扫描入口（root 权限，包含所有用户）
 */
export function scanTrash() {
  const allDirs = getAllTrashDirs();
  const trashList = [];
  const allItems = [];
  let totalFiles = 0, totalDirs = 0, totalSize = 0;

  for (const e of allDirs) {
    let info;
    try { info = collectDirInfo(e.path, 0, 16); }
    catch { info = { files: 0, dirs: 0, size: 0, mtimes: [] }; }
    totalFiles += info.files;
    totalDirs += info.dirs;
    totalSize += info.size;
    const oldest = pickOldestMtime(info.mtimes);
    trashList.push({
      path: e.path, vol: e.vol, uid: e.uid,
      files: info.files, dirs: info.dirs, size: info.size,
      mtime: oldest,
    });
    if (oldest) {
      allItems.push({
        path: e.path, mtime: oldest,
        size: info.size, files: info.files, dirs: info.dirs,
      });
    }
  }

  // 排序：按 vol 字母序，vol 内按 uid 数字序
  trashList.sort((a, b) => {
    if (a.vol !== b.vol) return a.vol.localeCompare(b.vol);
    return Number(a.uid) - Number(b.uid);
  });

  return {
    trashList,
    totals: { files: totalFiles, dirs: totalDirs, size: totalSize },
    buckets: bucketByAge(allItems),
  };
}

/**
 * 浏览 trash 目录（递归树状结构）
 */
export function browseTrash(dirPath, maxDepth = 8) {
  if (!isTrashPath(dirPath)) {
    return { error: 'invalid path' };
  }
  return walkTree(dirPath, 0, maxDepth);
}

function walkTree(dir, depth, maxDepth) {
  const result = { name: dir.split('/').pop(), path: dir, type: 'dir', children: [] };
  let st;
  try { st = statSync(dir); } catch { return result; }
  result.mtime = st.mtime;
  result.size = st.size;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return result; }
  // 排序：目录在前，文件在后，按名
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const e of entries) {
    const p = join(dir, e.name);
    let pst;
    try { pst = statSync(p); } catch { continue; }
    if (e.isDirectory()) {
      if (depth < maxDepth) {
        result.children.push(walkTree(p, depth + 1, maxDepth));
      } else {
        // 深度截断：只列名字
        result.children.push({ name: e.name, path: p, type: 'dir', truncated: true });
      }
    } else {
      result.children.push({
        name: e.name, path: p, type: 'file',
        size: pst.size, mtime: pst.mtime,
      });
    }
  }
  return result;
}

/**
 * 清理 trash（root 权限，包含所有用户）
 * ageDays: 0=全部, 30/90/365=对应档位
 */
export function cleanTrash(ageDays, withManifest = true) {
  const allDirs = getAllTrashDirs();
  const now = Date.now();
  const threshold = ageDays > 0 ? now - ageDays * 86400000 : Infinity;
  const deleted = [];
  const failed = [];
  const itemsForManifest = [];

  for (const e of allDirs) {
    let entries;
    try { entries = readdirSync(e.path, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const p = join(e.path, ent.name);
      let st;
      try { st = statSync(p); } catch { continue; }
      const mtime = st.mtime ? st.mtime.getTime() : 0;
      if (mtime > threshold) continue;  // 太新，跳过
      const info = collectDirInfo(p, 0, 16);
      const size = info.size;
      try {
        rmSync(p, { recursive: true, force: true });
        deleted.push({ path: p, vol: e.vol, uid: e.uid, size, files: info.files, dirs: info.dirs });
        itemsForManifest.push({
          path: p, vol: e.vol, uid: e.uid, size, files: info.files, dirs: info.dirs,
          mtime: st.mtime, reason: `age>=${ageDays}d`,
        });
      } catch (err) {
        failed.push({ path: p, error: err.message || String(err) });
      }
    }
  }

  let manifestPath = null;
  if (withManifest && itemsForManifest.length > 0) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/-(\d{3})Z$/, 'Z');
      const filename = `fnclearup_pre_clean_manifest_${ts}.json`;
      const base = getManifestDir();
      try { mkdirSync(base, { recursive: true }); } catch {}
      manifestPath = join(base, filename);
      const manifest = {
        tool: 'fnclearup trash',
        version: '0.7.11',
        timestamp: new Date().toISOString(),
        action: `trash-clean:age=${ageDays}`,
        hostname: process.env.HOSTNAME || 'unknown',
        user: process.env.USER || 'unknown',
        total_items: itemsForManifest.length,
        items: itemsForManifest,
        note: 'Files removed from .@#local/trash. No recovery possible after this point.',
      };
      const tmp = manifestPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
      renameSync(tmp, manifestPath);
    } catch (err) {
      manifestPath = null;
    }
  }

  return { deleted, failed, manifestPath };
}
