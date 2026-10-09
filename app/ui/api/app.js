import { existsSync, statSync, readdirSync, renameSync, cpSync, mkdirSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { sendJSON, execCmd, isSafePath, parseBody } from '../lib/util.js';
import { VOL_GLOBS } from '../lib/config.js';
import { moveToTrash } from './trash.js';

// ---------------------------------------------------------------------------
// 应用系统用户删除守卫
//
// 实测 fnOS 用户体系（/etc/passwd, 2026-09-26 核对）：
//   - 第三方应用账号  uid 944-989,  gid=901   ← 唯一该被 userdel 的目标
//   - fnOS 组件账号   uid 960-999,  gid=901   ← 大多同 gid，必须靠黑名单排除
//   - 系统服务账号    polkitd/systemd-network/systemd-timesync  gid=uid
//   - 真实用户        admin uid=1000 gid=1001
//   - 其他            nobody/wsdd2/libvirt-qemu  gid 各自
//
// 旧实现只判 `uid < 900` → admin(1000)/polkitd(995)/systemd-network(998)
// 全部通过守护，userdel -r admin 会连带删掉用户全部数据。
//
// 三层判据（任一不满足即拒绝删除）：
//   1) uid 落在应用账号区间 [900, 1000)
//   2) gid == 901（fnOS 应用账号组，排除 admin/polkitd/systemd-*/nobody）
//   3) 用户名不在核心组件黑名单（应用商店/权限/包管理/运行时等）
// ---------------------------------------------------------------------------
export const APP_USER_GID = 901;
export const APP_USER_UID_MIN = 900;
export const APP_USER_UID_MAX = 1000;

// 核心组件账号：删掉会破坏 fnOS 本身（应用商店/权限系统/包管理/运行时/网络）
const PROTECTED_USERS = new Set([
  'root', 'admin', 'nobody', 'daemon', 'bin', 'sys', 'sync', 'games', 'man',
  'polkitd', 'systemd-network', 'systemd-timesync', 'systemd-resolve',
  'systemd-journal', 'systemd-timesync1',
  'fnos-apps-store', 'package', 'supervisor', 'fnos', 'trim',
  'nodejs_v22', 'nodejs_v24', 'bunjs', 'python312', 'trim-media',
]);

// 返回 { ok: true } 或 { ok: false, reason: string }
export function canDeleteAppUser({ username, uid, gid }) {
  if (!username || username.startsWith('-')) {
    return { ok: false, reason: '用户名非法' };
  }
  if (PROTECTED_USERS.has(username)) {
    return { ok: false, reason: '系统核心账号，已跳过' };
  }
  if (!Number.isInteger(uid) || uid < APP_USER_UID_MIN || uid >= APP_USER_UID_MAX) {
    return { ok: false, reason: `uid ${uid} 不在应用账号区间 [${APP_USER_UID_MIN},${APP_USER_UID_MAX})` };
  }
  if (gid !== APP_USER_GID) {
    return { ok: false, reason: `gid ${gid} 不是应用账号组(${APP_USER_GID})` };
  }
  return { ok: true };
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
  // let 而非 const: 下方循环里对「路径已不存在」的情况会 skipped++。
  // 原来是 const, 只要勾选中含一个已被卸载清掉的残余目录就会抛
  // TypeError: Assignment to constant variable, 导致整个删除请求 500。
  let skipped = rawPaths.length - paths.length;
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
      // 三层守护: uid 区间 + gid==901 + 核心组件黑名单 (见 canDeleteAppUser)
      // Safety guard: only ever delete fnOS app accounts. System/reserved users
      // (root, admin, polkitd, fnos-apps-store, systemd-*, ...) must never be touched.
      const ur = await execCmd('id', ['-u', username], 5000);
      if (ur.code !== 0) continue; // no such user -> nothing to delete
      const uid = parseInt(ur.stdout.trim(), 10);
      const gr = await execCmd('id', ['-g', username], 5000);
      const gid = gr.code === 0 ? parseInt(gr.stdout.trim(), 10) : NaN;
      const verdict = canDeleteAppUser({ username, uid, gid });
      if (!verdict.ok) {
        usersFailed.push(`${username} (${verdict.reason})`);
        continue;
      }
      const dr = await execCmd('userdel', ['-r', username], 30000);
      if (dr.code === 0) usersDeleted.push(username);
      else usersFailed.push(`${username} (userdel 失败: ${(dr.stderr || '').trim().split('\n')[0] || 'code ' + dr.code})`);
    }
  }
  sendJSON(res, 200, { deleted, failed, skipped, total: deleted.length, failures: failed.length, users_deleted: usersDeleted, users_failed: usersFailed, success: true });
}
