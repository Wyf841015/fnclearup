import { existsSync, readdirSync, lstatSync, statSync, unlinkSync, rmSync, mkdirSync, renameSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { sendJSON, execCmd, parseBody, formatBytes, getManifestDir } from '../lib/util.js';

// Cache items under the current user's HOME (or root's if running as root).
const HOME = process.env.HOME || '/root';

// "No-regression" recommended set: 100% safe to clear, system rebuilds on demand.
// Anything here auto-recreates next time the tool runs (apt/npm/pip/uv/etc).
// Frontend uses this for the "✅ 推荐清理" one-click button.
export const RECOMMENDED_IDS = [
  'apt-archives', 'apt-lists',
  'syslog-gz', 'syslog-old', 'journal',
  'npm', 'pip', 'uv', 'node-gyp', 'typescript',
];

// Scan items: { id, path, label, size, size_str, risk, recommended }
// Sizes are computed by statSync; recurse=true to sum children.
const SCAN_TARGETS = [
  // Package manager caches
  { id: 'apt-archives', label: 'APT 下载缓存 (deb)', path: '/var/cache/apt/archives', recurse: true, risk: 'low', recommended: true,
    filter: (n) => n.endsWith('.deb') },
  { id: 'apt-lists', label: 'APT 列表缓存', path: '/var/lib/apt/lists', recurse: true, risk: 'low', recommended: true,
    filter: (n) => !n.startsWith('partial') && !n.endsWith('.gpg') },
  // System logs (admin: rotate .gz + 旧 .1)
  { id: 'syslog-gz', label: '系统日志轮转文件 (.gz)', path: '/var/log', recurse: false, risk: 'low', recommended: true,
    filter: (n) => n.endsWith('.gz') },
  { id: 'syslog-old', label: '系统日志历史档 (.1)', path: '/var/log', recurse: false, risk: 'low', recommended: true,
    filter: (n) => /\.1$/.test(n) && (n.startsWith('syslog') || n.startsWith('auth.log') || n.startsWith('mail.log') || n.startsWith('kern.log') || n.startsWith('daemon.log') || n.startsWith('user.log') || n.startsWith('messages')) },
  { id: 'journal', label: 'systemd journal 日志', path: '/var/log/journal', recurse: true, risk: 'low', recommended: true,
    filter: (n) => n.endsWith('.journal') },
  // User-level caches under HOME/.cache and HOME/.npm
  { id: 'npm', label: 'NPM 缓存', path: `${HOME}/.npm`, recurse: true, risk: 'low', recommended: true },
  { id: 'pip', label: 'PIP 缓存', path: `${HOME}/.cache/pip`, recurse: true, risk: 'low', recommended: true },
  { id: 'uv', label: 'uv 缓存', path: `${HOME}/.cache/uv`, recurse: true, risk: 'low', recommended: true },
  { id: 'node-gyp', label: 'node-gyp 缓存', path: `${HOME}/.cache/node-gyp`, recurse: true, risk: 'low', recommended: true },
  { id: 'typescript', label: 'TypeScript 增量编译缓存', path: `${HOME}/.cache/typescript`, recurse: true, risk: 'medium', recommended: true },
  { id: 'playwright', label: 'Playwright 浏览器 (重下耗时)', path: `${HOME}/.cache/ms-playwright`, recurse: true, risk: 'high', recommended: false },
  { id: 'chrome-cache', label: 'Chrome 浏览器缓存 (会丢登录)', path: `${HOME}/.cache/google-chrome`, recurse: true, risk: 'high', recommended: false },
  { id: 'firefox-cache', label: 'Firefox 浏览器缓存', path: `${HOME}/.cache/mozilla`, recurse: true, risk: 'high', recommended: false },
  { id: 'brave-cache', label: 'Brave 浏览器缓存', path: `${HOME}/.cache/BraveSoftware`, recurse: true, risk: 'high', recommended: false },
  // Other ~/.cache subdirs (auto-discovered, not in the curated list above)
  { id: 'cache-other', label: '其它 ~/.cache 子目录', path: `${HOME}/.cache`, recurse: true, risk: 'low', recommended: false,
    filter: (n, full) => !SCAN_TARGETS.find(t => t.path === full),  // not in curated list
    dynamicChildren: true },
  // App logs in /vol*/@appcenter/*/logs (only those >50MB)
  { id: 'app-logs', label: '应用日志 (>50MB)', path: '/vol*/@appcenter', recurse: true, risk: 'medium', recommended: true,
    filter: (n, full, st) => {
      if (n === 'logs' && st && st.isDirectory()) {
        // Sum files in this logs dir
        let total = 0;
        try {
          for (const f of readdirSync(full)) {
            const fp = join(full, f);
            try { total += lstatSync(fp).size; } catch {}
          }
        } catch {}
        return total > 50 * 1024 * 1024;
      }
      return false;
    },
    dynamicChildren: true },
];

// Walk directory and sum file sizes; for filter mode, return matching items.
function dirSize(p, recurse = true) {
  if (!existsSync(p)) return 0;
  let total = 0;
  try {
    const st = lstatSync(p);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    const entries = readdirSync(p);
    for (const e of entries) {
      const fp = join(p, e);
      try {
        const s = lstatSync(fp);
        if (s.isFile()) total += s.size;
        else if (s.isDirectory() && recurse) total += dirSize(fp, true);
      } catch {}
    }
  } catch {}
  return total;
}

// GET /api/sysclean/scan
export function handleSysCleanScan(req, res) {
  const items = [];
  for (const target of SCAN_TARGETS) {
    if (target.dynamicChildren) {
      // Auto-discover subdirectories matching the filter
      if (!existsSync(target.path)) continue;
      try {
        const entries = readdirSync(target.path);
        for (const e of entries) {
          const full = join(target.path, e);
          try {
            const st = lstatSync(full);
            if (!st.isDirectory()) continue;
            if (target.filter && !target.filter(e, full, st)) continue;
            const size = dirSize(full, true);
            if (size === 0) continue;
            items.push({
              id: `${target.id}:${e}`,
              target_id: target.id,
              path: full,
              name: e,
              label: `${target.label}: ${e}`,
              size, size_str: formatBytes(size),
              risk: target.risk, recommended: target.recommended,
            });
          } catch {}
        }
      } catch {}
      continue;
    }
    // Non-dynamic: filter children if filter is set; otherwise treat the path as one item
    if (!existsSync(target.path)) continue;
    if (!target.filter) {
      const size = dirSize(target.path, target.recurse);
      if (size === 0) continue;
      items.push({
        id: target.id,
        target_id: target.id,
        path: target.path,
        name: basename(target.path),
        label: target.label,
        size, size_str: formatBytes(size),
        risk: target.risk, recommended: target.recommended,
      });
    } else {
      // Filter children: list each matching child as its own item
      try {
        const entries = readdirSync(target.path);
        for (const e of entries) {
          const full = join(target.path, e);
          try {
            const st = lstatSync(full);
            if (!target.filter(e, full, st)) continue;
            const size = dirSize(full, target.recurse);
            if (size === 0) continue;
            items.push({
              id: `${target.id}:${e}`,
              target_id: target.id,
              path: full,
              name: e,
              label: `${target.label}: ${e}`,
              size, size_str: formatBytes(size),
              risk: target.risk, recommended: target.recommended,
            });
          } catch {}
        }
      } catch {}
    }
  }
  // Sort by size desc
  items.sort((a, b) => b.size - a.size);
  const totalSize = items.reduce((s, it) => s + it.size, 0);
  sendJSON(res, 200, { items, total_size: totalSize, total_size_str: formatBytes(totalSize), count: items.length, success: true });
}

// Whitelist: only allow deletion of paths in SCAN_TARGETS
function isTargetPath(p) {
  if (typeof p !== 'string') return false;
  for (const t of SCAN_TARGETS) {
    if (p === t.path) return true;
    if (p.startsWith(t.path + '/')) return true;
  }
  // Allow app-logs discovered children
  return false;
}

// POST /api/sysclean/clean
// Body: { ids: ['apt-archives', 'npm', 'cache-other:fontconfig', ...], mode: 'permanent' (default), backup: true|false }
// Note: sysclean items are caches that auto-rebuild — no recycle bin mode, always permanent.
export async function handleSysCleanClean(req, res) {
  const data = await parseBody(req);
  const ids = Array.isArray(data.ids) ? data.ids : [];
  const doBackup = data.backup === true;
  const deleted = [], failed = [];

  // Build snapshot of items being deleted (for backup manifest + return data)
  const snapshot = [];
  for (const id of ids) {
    let path = null, label = id, target_id = id, size = 0, mtime = 0;
    for (const target of SCAN_TARGETS) {
      if (target.id === id) { path = target.path; label = target.label; target_id = target.id; break; }
      if (id.startsWith(target.id + ':')) {
        const childName = id.slice(target.id.length + 1);
        path = join(target.path, childName);
        label = `${target.label}: ${childName}`;
        target_id = target.id;
        break;
      }
    }
    if (path && existsSync(path)) {
      try { size = dirSize(path, true); } catch {}
      try { mtime = lstatSync(path).mtimeMs; } catch {}
    }
    snapshot.push({ id, target_id, label, path, size, mtime });
  }

  // If backup requested, write manifest FIRST (before any deletion) so we have a record
  // even if deletion partially fails.
  let backupPath = null;
  if (doBackup) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, 'T').replace(/-(\d{3})Z$/, 'Z');
      const filename = `fnclearup_pre_clean_manifest_${ts}.json`;
      const trashBase = getManifestDir();
      backupPath = join(trashBase, filename);
      const manifest = {
        tool: 'fnclearup sysclean',
        version: '0.7.7',
        timestamp: new Date().toISOString(),
        hostname: process.env.HOSTNAME || 'unknown',
        user: process.env.USER || 'unknown',
        total_items: snapshot.length,
        items: snapshot,
        note: 'Manifest only — caches auto-rebuild. Use this as audit trail; no files were preserved.',
      };
      try { mkdirSync(trashBase, { recursive: true }); } catch {}
      const tmp = backupPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
      renameSync(tmp, backupPath);
    } catch (e) {
      // Backup failed — abort cleanup to avoid user losing audit trail
      sendJSON(res, 500, { success: false, error: 'backup failed: ' + e.message, backup_error: true });
      return;
    }
  }

  // Now perform the actual deletion
  for (const item of snapshot) {
    const { id, label, path } = item;
    if (!path) { failed.push({ id, reason: 'unknown id' }); continue; }
    if (!isTargetPath(path)) { failed.push({ id, reason: 'path not in whitelist' }); continue; }
    try {
      if (!existsSync(path)) { deleted.push({ id, label, path, skipped: true }); continue; }
      const r = await execCmd('rm', ['-rf', path], 300000);
      if (r.code === 0) {
        deleted.push({ id, label, path });
      } else {
        failed.push({ id, label, path, reason: r.stderr || `rm exit ${r.code}` });
      }
    } catch (e) {
      failed.push({ id, label, path, reason: e.message });
    }
  }
  sendJSON(res, 200, {
    deleted, failed,
    total: deleted.filter(d => !d.skipped).length,
    failures: failed.length,
    success: true,
    backup_path: backupPath,
  });
}

// GET /api/sysclean/manifests — list past pre-clean manifests (for audit/recovery UI)
export function handleSysCleanListManifests(req, res) {
  const base = getManifestDir();
  const manifests = [];
  try {
    if (existsSync(base)) {
      for (const f of readdirSync(base)) {
        if (!f.startsWith('fnclearup_pre_clean_manifest_') || !f.endsWith('.json')) continue;
        const full = join(base, f);
        try {
          const st = lstatSync(full);
          manifests.push({ name: f, path: full, size: st.size, size_str: formatBytes(st.size), mtime: st.mtimeMs });
        } catch {}
      }
    }
  } catch {}
  manifests.sort((a, b) => b.mtime - a.mtime);
  sendJSON(res, 200, { manifests, base_dir: base, count: manifests.length, success: true });
}

// GET /api/sysclean/manifest?path=/vol3/1000/.@#local/fnclearup_pre_clean_manifest_xxx.json
export async function handleSysCleanGetManifest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams.get('path');
  if (!p) { sendJSON(res, 400, { error: 'missing path' }); return; }
  // Whitelist: must live under getManifestDir() and start with fnclearup_pre_clean_manifest_
  const base = getManifestDir();
  if (!p.startsWith(base + '/') || !basename(p).startsWith('fnclearup_pre_clean_manifest_') || !p.endsWith('.json')) {
    sendJSON(res, 403, { error: 'path not allowed' });
    return;
  }
  if (!existsSync(p)) { sendJSON(res, 404, { error: 'not found' }); return; }
  try {
    const data = readFileSync(p, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(data);
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}
