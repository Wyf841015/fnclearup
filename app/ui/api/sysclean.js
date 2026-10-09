import { existsSync, readdirSync, lstatSync, statSync, unlinkSync, rmSync, mkdirSync, renameSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname, extname, resolve } from 'node:path';
import { sendJSON, execCmd, parseBody, formatBytes, getManifestDir } from '../lib/util.js';
import { VOL_GLOBS } from '../lib/config.js';

// Cache items under ALL users' HOME (root + every /vol<N>/<UID>).
// fnclearup runs as root on fnOS, so without this each non-root user's
// npm/pip/uv cache is invisible to "✅ 推荐清理" one-click button.
// Per-user HOMEs are discovered by scanning /vol1..10 for numeric UIDs.
//
// Also includes $HOME if it's not /root and not already in the list — covers
// dev/test environments (e.g. `/home/admin`) and any non-standard HOME layout.
function getUserHomes() {
  const homes = [{ username: 'root', home: '/root', uid: 0 }];
  for (let v = 1; v <= 10; v++) {
    const base = `/vol${v}`;
    if (!existsSync(base)) continue;
    try {
      for (const name of readdirSync(base)) {
        if (!/^\d+$/.test(name)) continue; // skip non-UID dirs
        const home = join(base, name);
        try {
          const st = lstatSync(home);
          if (st.isDirectory() && st.uid !== undefined) {
            homes.push({ username: name, home, uid: parseInt(name, 10) });
          }
        } catch { console.error('[sysclean.js]'); }
      }
    } catch { console.error('[sysclean.js]'); }
  }
  // Also include $HOME if it's a real dir and not already represented.
  // This covers dev/test (process.env.HOME=/home/admin on the build box) as
  // well as any custom HOME layout (e.g. /home/myuser).
  const envHome = process.env.HOME;
  if (envHome && envHome !== '/root' && existsSync(envHome)) {
    homes.push({ username: process.env.USER || basename(envHome), home: envHome, uid: -1 });
  }
  // Dedup by home path
  const seen = new Set();
  const out = [];
  for (const u of homes) {
    if (seen.has(u.home)) continue;
    seen.add(u.home);
    out.push(u);
  }
  return out;
}

// "No-regression" recommended set: 100% safe to clear, system rebuilds on demand.
// Anything here auto-recreates next time the tool runs (apt/npm/pip/uv/etc).
// Frontend uses this for the "✅ 推荐清理" one-click button.
// Note: RECOMMENDED_IDS now match id WITH a user suffix appended during scan,
// e.g. 'npm:root' for root's npm, 'npm:1000' for UID 1000's npm.
function isRecommended(id) {
  const base = id.split(':')[0];
  return [
    'apt-archives', 'apt-lists',
    'syslog-gz', 'syslog-old', 'journal',
    'npm', 'pip', 'uv', 'node-gyp', 'typescript',
  ].includes(base);
}

// Per-user cache items are emitted once per discovered HOME (root + each UID).
// Returns array of {id, path, ...} with id formatted as `<baseId>:<username>`.
// category groups targets for the frontend's category drill-down (MangoDisk-style).
const USER_CACHE_TEMPLATES = [
  { id: 'npm', label: 'NPM 缓存', subPath: '.npm', recurse: true, risk: 'low', category: 'dev' },
  { id: 'pip', label: 'PIP 缓存', subPath: '.cache/pip', recurse: true, risk: 'low', category: 'dev' },
  { id: 'uv', label: 'uv 缓存', subPath: '.cache/uv', recurse: true, risk: 'low', category: 'dev' },
  { id: 'node-gyp', label: 'node-gyp 缓存', subPath: '.cache/node-gyp', recurse: true, risk: 'low', category: 'dev' },
  { id: 'typescript', label: 'TypeScript 增量编译缓存', subPath: '.cache/typescript', recurse: true, risk: 'medium', category: 'dev' },
  { id: 'playwright', label: 'Playwright 浏览器 (重下耗时)', subPath: '.cache/ms-playwright', recurse: true, risk: 'high', category: 'dev' },
  { id: 'chrome-cache', label: 'Chrome 浏览器缓存 (会丢登录)', subPath: '.cache/google-chrome', recurse: true, risk: 'high', category: 'browser' },
  { id: 'firefox-cache', label: 'Firefox 浏览器缓存', subPath: '.cache/mozilla', recurse: true, risk: 'high', category: 'browser' },
  { id: 'brave-cache', label: 'Brave 浏览器缓存', subPath: '.cache/BraveSoftware', recurse: true, risk: 'high', category: 'browser' },
  // cache-other is the "auto-discover anything else under ~/.cache" item.
  // We exclude the single-level children that are already covered by the
  // templates above so users don't see double-counted items (e.g. both
  // 'PIP 缓存' and '其它 ~/.cache: pip' for the same 1.4 GB directory).
  { id: 'cache-other', label: '其它 ~/.cache 子目录', subPath: '.cache', recurse: true, risk: 'low', category: 'app',
    dynamicChildren: true,
    excludeSingleChildNames: new Set([
      'pip', 'uv', 'node-gyp', 'typescript', 'ms-playwright',
      'google-chrome', 'mozilla', 'BraveSoftware',
    ]) },
];

// Scan items: { id, path, label, size, size_str, risk, recommended }
// Sizes are computed by statSync; recurse=true to sum children.
// Multi-home user caches are generated per-user at scan time via USER_CACHE_TEMPLATES.
const SCAN_TARGETS = [
  // Package manager caches
  { id: 'apt-archives', label: 'APT 下载缓存 (deb)', path: '/var/cache/apt/archives', recurse: true, risk: 'low', category: 'system',
    filter: (n) => n.endsWith('.deb') },
  { id: 'apt-lists', label: 'APT 列表缓存', path: '/var/lib/apt/lists', recurse: true, risk: 'low', category: 'system',
    filter: (n) => !n.startsWith('partial') && !n.endsWith('.gpg') },
  // System logs (admin: rotate .gz + 旧 .1)
  { id: 'syslog-gz', label: '系统日志轮转文件 (.gz)', path: '/var/log', recurse: false, risk: 'low', category: 'logs',
    filter: (n) => n.endsWith('.gz') },
  { id: 'syslog-old', label: '系统日志历史档 (.1)', path: '/var/log', recurse: false, risk: 'low', category: 'logs',
    filter: (n) => /\.1$/.test(n) && (n.startsWith('syslog') || n.startsWith('auth.log') || n.startsWith('mail.log') || n.startsWith('kern.log') || n.startsWith('daemon.log') || n.startsWith('user.log') || n.startsWith('messages')) },
  { id: 'journal', label: 'systemd journal 日志', path: '/var/log/journal', recurse: true, risk: 'low', category: 'logs',
    filter: (n) => n.endsWith('.journal') },
  // App logs in /vol*/@appcenter/*/logs (only those >50MB)
  { id: 'app-logs', label: '应用日志 (>50MB)', path: '/vol*/@appcenter', recurse: true, risk: 'medium', category: 'logs',
    filter: (n, full, st) => {
      if (n === 'logs' && st && st.isDirectory()) {
        // Sum files in this logs dir
        let total = 0;
        try {
          for (const f of readdirSync(full)) {
            const fp = join(full, f);
            try { total += lstatSync(fp).size; } catch { console.error('[sysclean.js]'); }
          }
        } catch { console.error('[sysclean.js]'); }
        return total > 50 * 1024 * 1024;
      }
      return false;
    },
    dynamicChildren: true },
];

// Add per-user cache items to a flat list, one entry per (template × user).
// Returns array like { id: 'npm:1000', path: '/vol2/1000/.npm', label: 'NPM 缓存 (UID 1000)', ... }
function buildUserCacheItems() {
  const out = [];
  for (const u of getUserHomes()) {
    for (const t of USER_CACHE_TEMPLATES) {
      const base = join(u.home, t.subPath);
      // Skip non-existent silently (will be reported size=0)
      const displayHome = u.username === 'root' ? 'root' : `UID ${u.username}`;
      out.push({
        id: `${t.id}:${u.username}`,
        target_id: t.id,
        path: base,
        label: `${t.label} (${displayHome})`,
        recurse: t.recurse,
        risk: t.risk,
        category: t.category,
        recommended: isRecommended(`${t.id}:${u.username}`),
        dynamicChildren: t.dynamicChildren || false,
        excludeSingleChildNames: t.excludeSingleChildNames,
        username: u.username,
        userHome: u.home,
        baseId: t.id,
      });
    }
  }
  return out;
}

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
      } catch { console.error('[sysclean.js]'); }
    }
  } catch { console.error('[sysclean.js]'); }
  return total;
}

// GET /api/sysclean/scan
export function handleSysCleanScan(req, res) {
  const items = [];
  // Combine system-level targets + per-user cache items
  const allTargets = [...SCAN_TARGETS, ...buildUserCacheItems()];
  for (const target of allTargets) {
    if (target.dynamicChildren) {
      // Auto-discover subdirectories matching the filter
      // P1-4 fix: paths containing * (e.g. /vol*/@appcenter) are glob patterns —
      // expand to real existing volumes before scanning. Without this, every
      // glob-path target was silently skipped (existsSync false → continue).
      const expandedPaths = target.path.includes('*')
        ? VOL_GLOBS.map(v => target.path.replace('*', v)).filter(p => existsSync(p))
        : [target.path];
      if (expandedPaths.length === 0) continue;
      try {
        for (const resolvedPath of expandedPaths) {
        const entries = readdirSync(resolvedPath);
        for (const e of entries) {
          const full = join(resolvedPath, e);
          const st = (() => { try { return lstatSync(full); } catch { return null; } })();
          if (!st || !st.isDirectory()) continue;
          // Skip excluded sub-paths (cache-other template's curated set,
          // so we don't double-list npm/pip/uv/etc as both curated and "其它")
          if (target.excludeSingleChildNames && target.excludeSingleChildNames.has(e)) continue;
          if (target.filter && !target.filter(e, full, st)) continue;
          const size = dirSize(full, true);
          if (size === 0) continue;
          const id = `${target.id}:${e}`;
          items.push({
            id,
            target_id: target.id,
            path: full,
            name: e,
            label: `${target.label}: ${e}`,
            size, size_str: formatBytes(size),
            risk: target.risk,
            category: target.category,
            recommended: target.recommended === true || isRecommended(id),
          });
        }
        } // end for resolvedPath (P1-4 glob expansion)
      } catch { console.error('[sysclean.js]'); }
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
        risk: target.risk,
        category: target.category,
        recommended: target.recommended === true || isRecommended(target.id),
      });
    } else {
      // Filter children: list each matching child as its own item
      try {
        const entries = readdirSync(target.path);
        for (const e of entries) {
          const full = join(target.path, e);
          const st = (() => { try { return lstatSync(full); } catch { return null; } })();
          if (!st) continue;
          if (!target.filter(e, full, st)) continue;
          const size = dirSize(full, target.recurse);
          if (size === 0) continue;
          const id = `${target.id}:${e}`;
          items.push({
            id,
            target_id: target.id,
            path: full,
            name: e,
            label: `${target.label}: ${e}`,
            size, size_str: formatBytes(size),
            risk: target.risk,
            category: target.category,
            recommended: target.recommended === true || isRecommended(id),
          });
        }
      } catch { console.error('[sysclean.js]'); }
    }
  }
  // Sort by size desc
  items.sort((a, b) => b.size - a.size);
  const totalSize = items.reduce((s, it) => s + it.size, 0);
  sendJSON(res, 200, { items, total_size: totalSize, total_size_str: formatBytes(totalSize), count: items.length, success: true });
}

// Whitelist: only allow deletion of paths in SCAN_TARGETS or any per-user cache item
// P1-4 fix: targets whose path contains * (e.g. /vol*/@appcenter) are glob patterns —
// compare using a regex derived from the pattern so real paths like /vol1/@appcenter/fnclearup pass.
// P0 安全: 带 filter 的 target(如 syslog-gz 的 path=/var/log)绝不能被当作
// 整目录可删目标 —— 之前 idMap 注册处已挡了裸 id,但这里 isTargetPath 不过滤
// filter,fallback 的 join(targetPath, '..') 又能拼出 /var/log 本身,导致
// rm -rf /var/log。带 filter 的 target 只能经其子 id(如 syslog-gz:syslog.1.gz)
// 走下面的 dynamicChildren 路径访问,且那里仍要做 isTargetPath 复检。
function isTargetPath(p) {
  if (typeof p !== 'string') return false;
  const n = resolve(p); // 消除 '..', 防 /var/log/../log 之类
  for (const t of SCAN_TARGETS) {
    if (t.path.includes('*')) {
      // /vol*/@appcenter → regex ^/vol\d+/@appcenter(/|$)
      // /vol*/@appcenter → ^/vol\d+/@appcenter(/|$)
      // P2 修 bug: 替换 '*' 时只能替换 '*' 这**一个字符**, 所以要写成 '\d+'。
      // 原先写成 'vol\d+' 而 '*' 前面已经有 'vol', 结果拼成 /^\/volvol\d+\//,
      // 实测 pat.test('/vol3/@appcenter/photos') === false —— app-logs 这类
      // glob 目标的清理因此 100% 失效(只在 failed[] 里留一句"path not in whitelist")。
      const pat = new RegExp('^' + t.path.replace(/\*/g, '\\d+') + '(/|$)');
      if (pat.test(n)) return true;
    } else {
      // P0 安全: 带 filter 的 target 只允许其子路径(如 /var/log/syslog.1.gz),
      // 拒绝整目录本身(/var/log) —— 否则 journal:.. 经 join 归一化后
      // 拼出 /var/log 会通过复检, 触发 rm -rf /var/log。
      // 注意: 不能直接跳过 filter target, 否则其合法子项
      // (syslog-gz:syslog.1.gz 之类)也会被误拒。
      if (n === t.path && !t.filter) return true;
      if (n.startsWith(t.path + '/')) return true;
    }
  }
  for (const u of buildUserCacheItems()) {
    if (n === u.path) return true;
    if (n.startsWith(u.path + '/')) return true;
  }
  return false;
}

// POST /api/sysclean/clean
// Body: { ids: ['apt-archives', 'npm:root', 'cache-other:1000:fontconfig', ...], ... }
// Note: sysclean items are caches that auto-rebuild — no recycle bin mode, always permanent.
export async function handleSysCleanClean(req, res) {
  const data = await parseBody(req);
  const ids = Array.isArray(data.ids) ? data.ids : [];
  const doBackup = data.backup === true;
  const deleted = [], failed = [];

  // Lookup table: id → item descriptor (combines system targets + per-user items)
  const allTargets = [...SCAN_TARGETS, ...buildUserCacheItems()];
  const idMap = new Map();
  for (const t of allTargets) {
    // P0-1 fix: only register unfiltered targets in idMap. Filtered targets
    // (syslog-gz, syslog-old, journal etc.) must only be accessed via their
    // child ids (e.g. "syslog-gz:syslog.1.gz") which are produced by scan.
    // Registering their base path (e.g. /var/log) as a deletable target would
    // allow rm -rf /var/log when a bare target id is sent to the API.
    if (!t.filter) {
      idMap.set(t.id, { path: t.path, label: t.label, target_id: t.id });
    }
  }

  // For dynamicChildren per-user items (cache-other:USER or app-logs),
  // remember the parent so the fallback can resolve `<baseId>:<user>:<childName>` ids.
  // We compute parent.id as `cache-other:admin` etc; child id as `cache-other:admin:fakeapp_xxx`.
  const userByName = new Map();
  for (const u of getUserHomes()) userByName.set(u.username, u);

  // Build snapshot of items being deleted (for backup manifest + return data)
  const snapshot = [];
  for (const id of ids) {
    const hit = idMap.get(id);
    let path = null, label = id, target_id = id;
    if (hit) {
      path = hit.path;
      label = hit.label;
      target_id = hit.target_id;
    } else {
      // Fallback: parse '<target_id>:<childName>' for SCAN_TARGETS dynamicChildren
      // (e.g. app-logs:fnclearup), or '<target_id>:<username>:<childName>' for
      // per-user cache-other items.
      let resolved = false;
      // Try SCAN_TARGETS dynamicChildren first
      for (const target of SCAN_TARGETS) {
        if (id.startsWith(target.id + ':')) {
          const rest = id.slice(target.id.length + 1);
          // P1-4 fix applied to fallback: paths containing * are glob patterns —
          // expand to real existing volumes so the resolved path actually exists.
          let targetPath = target.path;
          if (targetPath.includes('*')) {
            const expanded = VOL_GLOBS.map(v => targetPath.replace('*', v)).filter(p => existsSync(p));
            targetPath = expanded[0] || targetPath; // first existing volume
          }
          // P0 安全: rest 来自用户可控的 id 后缀, join 会把 '..' 归一化,
          // 'journal:..' → /var/log/journal/.. → /var/log。join 后必须复检
          // 结果仍在 targetPath 之下, 否则 rm -rf 打到目录外。
          const candidate = resolve(join(targetPath, rest));
          if (candidate !== resolve(targetPath) && !candidate.startsWith(resolve(targetPath) + '/')) {
            // 逃出目标目录 — 记为拒绝, 继续尝试下一个 target
            continue;
          }
          path = candidate;
          label = `${target.label}: ${rest}`;
          target_id = target.id;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        // Try per-user dynamicChildren patterns:
        //   cache-other:<user>:<childName> (cache-other has excludeSubPaths in template)
        //   app-logs here is system-only (in SCAN_TARGETS); the user version is app-logs (handled above)
        for (const t of USER_CACHE_TEMPLATES) {
          if (!t.dynamicChildren) continue;
          const prefix = `${t.id}:`;
          if (!id.startsWith(prefix)) continue;
          const rest = id.slice(prefix.length); // e.g. "admin:fakeapp_test_xxx"
          const colon = rest.indexOf(':');
          if (colon === -1) continue; // not a user-scoped child
          const username = rest.slice(0, colon);
          const childName = rest.slice(colon + 1);
          const u = userByName.get(username);
          if (!u) continue;
          // Skip curated sub-paths (they're emitted as their own top-level user items)
          if (t.excludeSingleChildNames && t.excludeSingleChildNames.has(childName)) continue;
          // For cache-other, child name is the immediate subdir of <home>/.cache
          if (t.id === 'cache-other') {
            path = join(u.home, t.subPath, childName);
            label = `${t.label} (${username}): ${childName}`;
            target_id = t.id;
            resolved = true;
            break;
          }
        }
      }
    }
    let size = 0, mtime = 0;
    if (path && existsSync(path)) {
      try { size = dirSize(path, true); } catch { console.error('[sysclean.js]'); }
      try { mtime = lstatSync(path).mtimeMs; } catch { console.error('[sysclean.js]'); }
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
      try { mkdirSync(trashBase, { recursive: true }); } catch (e) { console.error('[sysclean] mkdir trashBase fail', e); }
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
        } catch { console.error('[sysclean.js]'); }
      }
    }
  } catch { console.error('[sysclean.js]'); }
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
