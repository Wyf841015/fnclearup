import { existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { sendJSON, execCmd, isSafePath, parseBody } from '../lib/util.js';
import { VOL_GLOBS } from '../lib/config.js';

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
export async function handleDelete(req, res) {
  const data = await parseBody(req);
  const deleteUsers = !!data.delete_users;
  const paths = (data.paths || []).filter(p => isSafePath(p));
  const deleted = [], failed = [], usersDeleted = [], usersFailed = [];
  for (const p of paths) {
    try {
      await execCmd('chattr', ['-i', p], 5000).catch(() => {});
      if (existsSync(p)) {
        const r = await execCmd('rm', ['-rf', p], 60000);
        if (r.code === 0) deleted.push(p);
        else failed.push(p);
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
  sendJSON(res, 200, { deleted, failed, total: deleted.length, failures: failed.length, users_deleted: usersDeleted, users_failed: usersFailed, success: true });
}
