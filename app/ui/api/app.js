import { existsSync, readdirSync, renameSync, cpSync, mkdirSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { sendJSON, execCmd, isSafePath, parseBody } from '../lib/util.js';
import { VOL_GLOBS } from '../lib/config.js';

// Move a path to its volume's recycle bin: /volN/UID/.@#local/trash/...
// For /vol02 netdisk mounts, the cloud filesystem doesn't support .@#local trash
// (fuse mount, mkdir is denied) — return false so caller falls back to rm -rf.
function moveToTrash(p) {
  // /volN/UID/... or /vol02/<mount-id>/... — UID/mount-id may contain digits, letters, dashes
  const m = p.match(/^(\/(?:mnt\/)?vol\d+\/[\w-]+)\/(.+)/);
  if (!m) return false;
  // /vol02 is fnOS netdisk mount — no .@#local trash support
  if (m[1].startsWith('/vol02/')) return false;
  const trashDir = `${m[1]}/.@#local/trash`;
  const dest = join(trashDir, m[2]);
  try {
    mkdirSync(dirname(dest), { recursive: true });
    let finalDest = dest;
    let counter = 1;
    while (existsSync(finalDest)) {
      const ext = extname(dest);
      finalDest = join(dirname(dest), `${basename(dest).slice(0, ext.length || basename(dest).length)}_${counter}${ext}`);
      counter++;
    }
    try {
      renameSync(p, finalDest);
      return true;
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      // Cross-device: copy then remove original
      cpSync(p, finalDest, { recursive: true });
      try { execCmd('rm', ['-rf', p], 60000); } catch {}
      return true;
    }
  } catch { return false; }
}

// POST /api/scan
export async function handleScan(req, res) {
  const result = await execCmd('appcenter-cli', ['list'], 30000);
  const installed = [];
  if (result.code === 0) {
    for (const line of result.stdout.split('\n')) {
      const parts = line.split('│').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 3 && !parts[0].startsWith('APP')) {
        installed.push({ appname: parts[0], display_name: parts[1] });
      }
    }
  }
  const allAppDirs = [];
  for (const vp of VOL_GLOBS) {
    if (existsSync(vp)) {
      const entries = readdirSync(vp, { withFileTypes: true }).filter(e => e.name.startsWith('@app') && e.isDirectory());
      for (const e of entries) allAppDirs.push(join(vp, e.name));
    }
  }
  const allInstDirs = [];
  for (const ad of allAppDirs) {
    if (existsSync(ad)) {
      const entries = readdirSync(ad, { withFileTypes: true }).filter(e => e.isDirectory());
      for (const e of entries) allInstDirs.push(join(ad, e.name));
    }
  }
  const installedNames = new Set(installed.map(a => a.appname.toLowerCase()));
  const orphanDirs = [];
  for (const d of allInstDirs) {
    const name = basename(d).toLowerCase();
    let isInstalled = installedNames.has(name);
    if (!isInstalled && name.endsWith('-docker')) isInstalled = installedNames.has(name.slice(0, -7));
    if (!isInstalled && name.startsWith('docker-')) isInstalled = installedNames.has(name.slice(7));
    if (!isInstalled) {
      let subdirs = [];
      try { subdirs = readdirSync(d); } catch {}
      orphanDirs.push({ app: basename(d), vol: dirname(dirname(d)), path: d, dirs: subdirs });
    }
  }
  sendJSON(res, 200, { installed, orphan: orphanDirs, success: true });
}

// POST /api/delete
// Body: { paths: [...], mode: 'trash'|'permanent' (default trash), delete_users: bool, delete_appshare_residual: bool }
export async function handleDelete(req, res) {
  const data = await parseBody(req);
  const deleteUsers = !!data.delete_users;
  const deleteAppshare = !!data.delete_appshare_residual;
  const mode = data.mode === 'permanent' ? 'permanent' : 'trash';
  const rawPaths = data.paths || [];
  const paths = rawPaths.filter(p => isSafePath(p));
  const skipped = rawPaths.length - paths.length;
  const deleted = [], failed = [], usersDeleted = [], usersFailed = [];
  for (const p of paths) {
    try {
      await execCmd('chattr', ['-i', p], 5000).catch(() => {});
      if (existsSync(p)) {
        // If deleteAppshare, also remove sibling @appshare/.../app directory (always permanent — appshare is system)
        if (deleteAppshare) {
          const m = p.match(/^(\/(?:mnt\/)?vol\d+\/[\w-]+)\/(.+)/);
          if (m) {
            const appsharePath = `${m[1]}/@appshare/${m[2]}`;
            await execCmd('chattr', ['-i', appsharePath], 5000).catch(() => {});
            if (existsSync(appsharePath)) {
              const ra = await execCmd('rm', ['-rf', appsharePath], 60000);
              if (ra.code !== 0) failed.push(`${appsharePath} (appshare)`);
            }
          }
        }
        // Per user request: netdisk / vol02 residuals are user data — default to trash, not permanent rm -rf
        let ok = false;
        if (mode === 'trash') {
          ok = moveToTrash(p);
          if (!ok) {
            // Fall back to rm -rf if path isn't in /volN/UID/... (e.g. /volN itself)
            const r = await execCmd('rm', ['-rf', p], 60000);
            ok = (r.code === 0);
          }
        } else {
          const r = await execCmd('rm', ['-rf', p], 60000);
          ok = (r.code === 0);
        }
        if (ok) deleted.push(p);
        else failed.push(p);
      } else {
        // Path doesn't exist; report as skipped (not failed) so UI can distinguish
        skipped++;
      }
    } catch { failed.push(p); }
  }
  if (deleteUsers) {
    for (const p of paths) {
      const m = p.match(/(@app\d+)\/([^/]+)/);
      if (!m) continue;
      const username = m[2];
      const r = await execCmd('id', [username], 5000);
      if (r.code === 0) {
        const dr = await execCmd('userdel', ['-r', username], 30000);
        if (dr.code === 0) usersDeleted.push(username);
        else usersFailed.push(username);
      } else usersFailed.push(username);
    }
  }
  sendJSON(res, 200, { deleted, failed, skipped, total: deleted.length, failures: failed.length, users_deleted: usersDeleted, users_failed: usersFailed, success: true });
}
