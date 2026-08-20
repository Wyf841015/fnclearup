import { existsSync, statSync, readdirSync, renameSync, cpSync, mkdirSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { sendJSON, execCmd, isSafePath, parseBody } from '../lib/util.js';
import { VOL_GLOBS } from '../lib/config.js';
import { moveToTrash } from './trash.js';

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
      try { subdirs = readdirSync(d); } catch { console.error('[app.js]'); }
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
        // BUT: appcenter/appstore paths (@appcenter, @appstore) can't go to trash (regex rejects @),
        // and they're system app dirs (not user data) — permanent delete is safe.
        let ok = false;
        const isAppDir = p.includes('/@appcenter/') || p.includes('/@appstore/');
        if (mode === 'trash' && !isAppDir) {
          ok = moveToTrash(p);
        }
        if (!ok) {
          // Fallback: use rm -rf (appcenter dirs always go here; user data dirs that
          // failed moveToTrash also go here, e.g. /vol02 paths without trash support)
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
    const seenUsers = new Set(); // 同一应用可能有多个残留目录，用户只删一次
    for (const p of paths) {
      // Extract app system user from any @app* directory (e.g. /vol3/@appcenter/fnclearup).
      // NOTE: @app\d+ would only match numeric suffixes (@app1); real dirs are
      // @appcenter / @appstore — use [^/]+ so letters+digits both work.
      const m = p.match(/\/(@app[^/]+)\/([^/]+)$/);
      if (!m || m[2].startsWith('.')) continue;
      const username = m[2];
      if (seenUsers.has(username)) continue; // dedupe
      seenUsers.add(username);
      // Safety guard: only ever delete fnOS app accounts (uid >= 900).
      // System/reserved users (root, daemon, fnos-apps-store, ...) must never be touched.
      const ur = await execCmd('id', ['-u', username], 5000);
      if (ur.code !== 0) continue; // no such user -> nothing to delete
      const uid = parseInt(ur.stdout.trim(), 10);
      if (!Number.isInteger(uid) || uid < 900) {
        usersFailed.push(`${username} (系统保留用户，已跳过)`);
        continue;
      }
      const dr = await execCmd('userdel', ['-r', username], 30000);
      if (dr.code === 0) usersDeleted.push(username);
      else usersFailed.push(username);
    }
  }
  sendJSON(res, 200, { deleted, failed, skipped, total: deleted.length, failures: failed.length, users_deleted: usersDeleted, users_failed: usersFailed, success: true });
}
