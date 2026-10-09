import { existsSync, readdirSync, lstatSync, unlinkSync, renameSync, cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname, extname, resolve } from 'node:path';
import { sendJSON, execCmd, parseBody, formatBytes } from '../lib/util.js';
import { TEMP_DIRS } from '../lib/config.js';

// Whitelist: only allow deletion of paths inside /tmp or /var/tmp
//
// P0 安全: 必须先 resolve() 消除 '..' 再判断。原先用 p.startsWith('/tmp/'),
// 对 '/tmp/../etc/cron.d/x' 返回 true, 但 rm 自身会解析 '..', 删除落到 /tmp 之外。
// resolve 后 '/tmp/../etc/...' === '/etc/...' → 正确拒绝。
function isTempPath(p) {
  if (typeof p !== 'string') return false;
  const n = resolve(p);
  if (n === '/tmp' || n === '/var/tmp' ||
      n.startsWith('/tmp/') || n.startsWith('/var/tmp/')) return true;
  // Test fixture allowlist
  if (process.env.TRM_FNCLEARUP_TEST === '1' && (n === '/tmp/fnclearup_test' || n.startsWith('/tmp/fnclearup_test/'))) return true;
  return false;
}

// Move path into a trash dir; create unique name on conflict
function moveToTrash(p) {
  const trashDir = '/tmp/.@#local/trash';
  const dest = join(trashDir, p.replace(/^\/+/, ''));
  mkdirSync(dirname(dest), { recursive: true });
  let finalDest = dest;
  let counter = 1;
  while (existsSync(finalDest)) {
    const ext2 = extname(dest);
    const stem = basename(dest).slice(0, ext2.length ? -ext2.length : basename(dest).length);
    finalDest = join(dirname(dest), `${stem}_${counter}${ext2}`);
    counter++;
  }
  try { renameSync(p, finalDest); }
  catch (e2) { if (e2.code === 'EXDEV') { cpSync(p, finalDest); unlinkSync(p); } else throw e2; }
  return finalDest;
}

// GET /api/temp/scan
export function handleTempScan(req, res) {
  const result = { dirs: [], files: [], total_size: 0, counts: { dirs: 0, files: 0 } };
  let totalSize = 0;
  for (const dir of TEMP_DIRS) {
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = lstatSync(full);  // lstatSync: don't follow symlinks (avoid deleting link target)
        // Use mtime (reliable) instead of atime (unreliable on tmpfs/relatime)
        const ageHours = (Date.now() - st.mtimeMs) / 3600000;
        if (ageHours < 24) continue;
        const isDir = st.isDirectory();
        const item = { path: full, name: entry, dir, age_hours: Math.round(ageHours * 10) / 10, size: st.size, size_str: formatBytes(st.size), is_dir: isDir, type: isDir ? 'dir' : 'file' };
        (isDir ? result.dirs : result.files).push(item);
        totalSize += st.size;
      } catch { console.error('[temp.js]'); }
    }
  }
  result.dirs.sort((a, b) => b.age_hours - a.age_hours);
  result.files.sort((a, b) => b.age_hours - a.age_hours);
  result.total_size = totalSize;
  result.total_size_str = formatBytes(totalSize);
  result.counts.dirs = result.dirs.length;
  result.counts.files = result.files.length;
  sendJSON(res, 200, { ...result, success: true });
}

// POST /api/temp/delete
export async function handleTempDelete(req, res) {
  const data = await parseBody(req);
  const rawPaths = data.paths || [];
  const mode = data.mode || 'trash';
  const deleted = [], failed = [], errors = [];
  // Filter: only paths under /tmp or /var/tmp
  const paths = rawPaths.filter(p => isTempPath(p));
  const skipped = rawPaths.length - paths.length;
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        if (mode === 'permanent') {
          const r = await execCmd('rm', ['-rf', p], 30000);
          if (r.code !== 0) throw new Error(r.stderr);
        } else {
          moveToTrash(p);
        }
      } else {
        // File
        if (mode === 'permanent') {
          unlinkSync(p);
        } else {
          moveToTrash(p);
        }
      }
      deleted.push(p);
    } catch (e) { failed.push(p); errors.push(`${p}: ${e.message}`); }
  }
  sendJSON(res, 200, { deleted, failed, skipped, total: deleted.length, failures: failed.length, errors, success: true });
}
