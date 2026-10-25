// 用户清理：列出系统用户 + 删除选中的用户
//
// 为什么单独做: 应用残余清理里的「删除用户」是**跟着残余目录**走的（路径 → 用户名），
// 装了又卸的应用留下的账号、手工建的测试账号都没有入口清理。这里提供独立视图：
// 列出 /etc/passwd 全部账号，默认只显示「非系统」账号（系统自带账号 uid < 900 折叠），
// 由用户勾选后删除 —— 服务端二次校验，前端标灰只是提前告知。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendJSON, execCmd, parseBody } from '../lib/util.js';
import { PROTECTED_USERS, APP_USER_GID, APP_USER_UID_MIN, APP_USER_UID_MAX } from './app.js';

// fnOS 里 uid < 900 是系统/服务账号（root/daemon/polkitd/systemd-* …）
export const SYSTEM_UID_MAX = 900;
// 一次最多删多少个，防误操作把整机账号扫平
export const MAX_DELETE_PER_RUN = 20;
// 家目录不允许是这些（userdel -r 会递归删掉）
const UNSAFE_HOMES = new Set(['/', '/root', '/home', '/usr', '/var', '/etc', '/boot', '/vol1', '/vol2', '/vol3', '/vol4', '/vol5', '/vol02']);
// 扫「账号是否仍被目录占用」的根：卷内的 @app* 与系统级 apps 目录
const APP_DIR_ROOTS = [
  '/vol1', '/vol2', '/vol3', '/vol4', '/vol5', '/vol6', '/vol7', '/vol8', '/vol9', '/vol10', '/vol02',
  '/usr/local/apps',
];

/** 解析 /etc/passwd 文本 → 账号数组（跳过格式不对的行） */
export function parsePasswd(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 7) continue;
    const [name, , uidStr, gidStr, , home, shell] = parts;
    const uid = parseInt(uidStr, 10);
    const gid = parseInt(gidStr, 10);
    if (!name || !Number.isInteger(uid) || !Number.isInteger(gid)) continue;
    out.push({ name, uid, gid, home: home || '', shell: shell || '' });
  }
  return out;
}

/**
 * 账号分类 + 是否可删（服务端最终判据）。
 * @param {{name:string,uid:number,gid:number}} u
 * @param {{activeCount?:number, installedApp?:string, ownedDir?:string, dockerUse?:{container:string,via:string}|null}} opts
 *   activeCount  = 该 uid 当前运行的进程数
 *   installedApp = 该 uid 对应的「已安装应用名」（应用还在，账号不能删）
 *   ownedDir     = 仍属于该账号的 @app* 目录（仅提示，不阻止）
 *   dockerUse    = Docker 容器正在使用该账号（运行用户或挂载目录 owner），不能删
 * @returns {{kind:'system'|'app'|'user', deletable:boolean, reason:string, warn:string}}
 */
export function classifyUser(u, opts = {}) {
  const activeCount = opts.activeCount || 0;
  const installedApp = opts.installedApp || '';
  const ownedDir = opts.ownedDir || '';
  const dockerUse = opts.dockerUse || null;
  const kind = u.uid < SYSTEM_UID_MAX ? 'system'
    : (u.uid >= APP_USER_UID_MIN && u.uid < APP_USER_UID_MAX) ? 'app'
    : 'user';
  const warn = ownedDir ? `仍有目录属于该账号：${ownedDir}` : '';

  if (u.uid === 0) return { kind: 'system', deletable: false, reason: 'root 账号，禁止删除', warn };
  if (PROTECTED_USERS.has(u.name)) return { kind: 'system', deletable: false, reason: '系统核心账号，禁止删除', warn };
  if (kind === 'system') return { kind, deletable: false, reason: `系统/服务账号（uid ${u.uid} < ${SYSTEM_UID_MAX}），不可删除`, warn };
  if (installedApp) return { kind, deletable: false, reason: `应用「${installedApp}」仍在安装中，请先在应用中心卸载`, warn };
  // Docker 容器（含已停止的）用着这个账号：删掉后容器再也写不进它的数据目录，
  // 且已停止的容器没有进程，靠 activeCount 拦不住 —— 必须单独判断。
  if (dockerUse) {
    const via = dockerUse.via ? `，${dockerUse.via}` : '';
    return { kind, deletable: false, reason: `Docker 容器「${dockerUse.container}」正在使用该账号${via}`, warn };
  }
  if (activeCount > 0) return { kind, deletable: false, reason: `有 ${activeCount} 个进程在运行，请先停止`, warn };
  if (kind === 'app' && u.gid !== APP_USER_GID) return { kind, deletable: false, reason: `gid ${u.gid} 不是应用账号组(${APP_USER_GID})`, warn };
  return { kind, deletable: true, reason: '', warn };
}

/** 家目录能不能跟着一起删（userdel -r）：拒绝根目录、系统目录、卷根 */
export function isHomeSafeToRemove(home) {
  const h = String(home || '').trim();
  if (!h || !h.startsWith('/')) return false;
  if (UNSAFE_HOMES.has(h)) return false;
  if (/^\/vol\d+$/.test(h)) return false;                      // 卷根 /vol1 /vol3 …
  if (h.split('/').filter(Boolean).length < 2) return false;    // 只有一层，如 /root
  return true;
}

/** 统计每个 uid 当前有多少进程（一次 ps 拿全，避免逐个 pgrep） */
async function activeByUid() {
  const map = {};
  const r = await execCmd('ps', ['-eo', 'uid='], 8000);
  if (r.code !== 0) return map;
  for (const line of r.stdout.split('\n')) {
    const uid = parseInt(line.trim(), 10);
    if (Number.isInteger(uid)) map[uid] = (map[uid] || 0) + 1;
  }
  return map;
}

/**
 * 已安装应用 → 账号 uid。
 * 注意：fnOS 的应用账号名**不一定**等于应用名（例如应用 Emby-crack 用账号 Emby-crack，
 * 但历史安装可能留下 EmbyServer 这种同名不同号的账号），所以只做「名字能对上」的映射；
 * 对不上的靠 ownedDir（目录归属）提示，不去猜。
 */
async function installedAppByUid() {
  const map = new Map();
  const r = await execCmd('appcenter-cli', ['list'], 30000);
  if (r.code !== 0) return map;    // 非 root 时拿不到，安全降级为「不拦」
  const names = [];
  for (const line of r.stdout.split('\n')) {
    const parts = line.split('│').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 3 && !parts[0].startsWith('APP')) names.push(parts[0]);
  }
  for (const name of names.slice(0, 120)) {
    const u = await execCmd('id', ['-u', name], 4000);
    if (u.code !== 0) continue;
    const uid = parseInt(u.stdout.trim(), 10);
    if (Number.isInteger(uid)) map.set(uid, name);
  }
  return map;
}

/** 扫 @app* 目录归属：uid → 一个示例路径（用于提示「这个账号还占着目录」） */
function ownedDirByUid() {
  const map = new Map();
  for (const root of APP_DIR_ROOTS) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('@app')) continue;
      const base = join(root, e.name);
      let subs;
      try {
        subs = readdirSync(base, { withFileTypes: true });
      } catch { continue; }        // @appshare 之类的无权限目录直接跳过
      for (const s of subs) {
        const p = join(base, s.name);
        try {
          const st = statSync(p);
          if (!map.has(st.uid)) map.set(st.uid, p);
        } catch { /* 单个目录 stat 失败不影响其它 */ }
      }
    }
  }
  return map;
}

/**
 * Docker 容器 → 账号 uid 的占用关系（账号能不能删的关键判据之一）。
 *
 * 三条来源，任一命中即认为「该账号被 Docker 应用使用」：
 *   1) 运行中容器的**真实进程 uid**（/proc/<pid>/status，最权威，能穿透镜像内用户名）
 *   2) Config.User 里写的数字 uid（'1000' / '1000:1000'）
 *   3) bind 挂载宿主目录 / named volume 挂载点的 owner（容器以该 uid 往这里写文件）
 *
 * 为什么不用「Config.User 写用户名 → 宿主 id -u 反查」当唯一依据：容器里的用户名是按
 * **镜像内** /etc/passwd 解析的，宿主同名账号未必同一 uid，硬拦会误伤。运行中的容器
 * 直接读 /proc 就没有这个问题；已停止的容器没法解，宁可漏判也不误判。
 *
 * @returns {Promise<{map:Map<number,{container:string,via:string}>, available:boolean, reason:string}>}
 *   available=false 表示 docker 不可用/无权限，调用方应把这点透出给前端而不是静默当「没有占用」。
 */
export async function dockerUsageByUid() {
  const map = new Map();
  const unavailable = (reason) => ({ map, available: false, reason });
  const rp = await execCmd('docker', ['ps', '-a', '--format', '{{.ID}}'], 10000);
  if (rp.code !== 0) {
    const why = (rp.stderr || '').trim().split('\n')[0] || ('docker ps code ' + rp.code);
    return unavailable(why);
  }
  const ids = rp.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return { map, available: true, reason: '' };

  const ri = await execCmd('docker', [
    'inspect', '--type', 'container', '--format',
    '{{.Name}}||{{.Config.User}}||{{.State.Running}}||{{.State.Pid}}||{{range .Mounts}}{{.Type}}={{.Source}};{{end}}',
    ...ids,
  ], 20000);
  if (ri.code !== 0) {
    const why = (ri.stderr || '').trim().split('\n')[0] || ('docker inspect code ' + ri.code);
    return unavailable(why);
  }

  const put = (uid, container, via) => {
    if (!Number.isInteger(uid) || uid < 0) return;
    if (!map.has(uid)) map.set(uid, { container, via });
  };

  for (const line of ri.stdout.split('\n')) {
    const [rawName, rawUser, rawRunning, rawPid, rawMounts] = line.split('||');
    const container = String(rawName || '').replace(/^\//, '').trim();
    if (!container) continue;

    // 1) 运行中容器：/proc/<pid>/status 的 Uid 就是真实 uid
    if (String(rawRunning || '').trim() === 'true') {
      const pid = parseInt(String(rawPid || '').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          const st = readFileSync(`/proc/${pid}/status`, 'utf8');
          const m = st.match(/^Uid:\s*(\d+)/m);
          if (m) put(parseInt(m[1], 10), container, '容器进程运行账号');
        } catch { /* 容器刚退出或 /proc 不可读，退回下面的静态信息 */ }
      }
    }

    // 2) Config.User 写死的数字 uid（带用户名的不猜，理由见函数头注释）
    const who = String(rawUser || '').split(':')[0].trim();
    if (/^\d+$/.test(who)) put(parseInt(who, 10), container, `容器指定 user=${who}`);

    // 3) 挂载源 owner
    for (const m of String(rawMounts || '').split(';')) {
      const eq = m.indexOf('=');
      if (eq < 0) continue;
      const src = m.slice(eq + 1).trim();
      if (!src.startsWith('/')) continue;
      try {
        put(statSync(src).uid, container, `挂载目录 ${src}`);
      } catch { /* 挂载源已不存在（容器未启动且宿主目录被删）时跳过 */ }
    }
  }
  return { map, available: true, reason: '' };
}

// 账号库路径。TRM_PASSWD_FILE 只为测试夹具而生（生产环境不设这个变量就是 /etc/passwd），
// 否则「删除成功」这条路径无法在没有 root 的测试机上验证。
function passwdFile() {
  return process.env.TRM_PASSWD_FILE || '/etc/passwd';
}

function readPasswd() {
  return parsePasswd(readFileSync(passwdFile(), 'utf8'));
}

// GET /api/users
export async function handleListUsers(req, res) {
  let users;
  try {
    users = readPasswd();
  } catch (e) {
    return sendJSON(res, 500, { success: false, error: '读不到 /etc/passwd：' + e.message });
  }
  const [act, installed, docker] = await Promise.all([activeByUid(), installedAppByUid(), dockerUsageByUid()]);
  const owned = ownedDirByUid();

  const list = users.map(u => {
    const c = classifyUser(u, {
      activeCount: act[u.uid] || 0,
      installedApp: installed.get(u.uid) || '',
      ownedDir: owned.get(u.uid) || '',
      dockerUse: docker.map.get(u.uid) || null,
    });
    return {
      name: u.name, uid: u.uid, gid: u.gid, home: u.home, shell: u.shell,
      kind: c.kind, deletable: c.deletable, reason: c.reason, warn: c.warn,
      active: act[u.uid] || 0,
      docker: docker.map.get(u.uid) || null,
      home_removable: isHomeSafeToRemove(u.home),
    };
  }).sort((a, b) => a.uid - b.uid);

  const stats = {
    total: list.length,
    system: list.filter(x => x.kind === 'system').length,
    app: list.filter(x => x.kind === 'app').length,
    user: list.filter(x => x.kind === 'user').length,
    deletable: list.filter(x => x.deletable).length,
  };
  // docker_available=false 时把原因一并带给前端：不能让用户以为「没被 Docker 占用」
  return sendJSON(res, 200, {
    success: true, users: list, stats,
    docker_available: docker.available, docker_error: docker.reason || '',
  });
}

// POST /api/users/delete  { ack: true, users: [{ name, removeHome }] }
export async function handleDeleteUsers(req, res) {
  const data = await parseBody(req);
  if (!data || data.ack !== true) {
    return sendJSON(res, 400, { success: false, error: '缺少确认标记（前端必须在弹窗里确认过）' });
  }
  const reqs = Array.isArray(data.users) ? data.users : [];
  if (!reqs.length) return sendJSON(res, 400, { success: false, error: '没有选择用户' });
  if (reqs.length > MAX_DELETE_PER_RUN) {
    return sendJSON(res, 400, { success: false, error: `一次最多删除 ${MAX_DELETE_PER_RUN} 个用户` });
  }

  let users;
  try {
    users = readPasswd();
  } catch (e) {
    return sendJSON(res, 500, { success: false, error: '读不到 /etc/passwd：' + e.message });
  }
  const byName = new Map(users.map(u => [u.name, u]));
  const [act, installed, docker] = await Promise.all([activeByUid(), installedAppByUid(), dockerUsageByUid()]);

  const deleted = [], failed = [], skipped = [];
  for (const item of reqs) {
    const name = String((item && item.name) ?? item ?? '').trim();
    const removeHome = !!(item && item.removeHome);
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) { failed.push({ name, reason: '用户名非法' }); continue; }
    const u = byName.get(name);
    if (!u) { skipped.push({ name, reason: '账号不存在' }); continue; }
    // 服务端重新校验：前端标灰不是安全边界
    const c = classifyUser(u, {
      activeCount: act[u.uid] || 0,
      installedApp: installed.get(u.uid) || '',
      dockerUse: docker.map.get(u.uid) || null,
    });
    if (!c.deletable) { failed.push({ name, reason: c.reason }); continue; }

    const useHome = removeHome && isHomeSafeToRemove(u.home);
    const args = useHome ? ['-r', name] : [name];
    const r = await execCmd('userdel', args, 30000);
    if (r.code === 0) {
      deleted.push({ name, uid: u.uid, home_removed: useHome, home: useHome ? u.home : '' });
    } else {
      const why = (r.stderr || '').trim().split('\n')[0] || ('userdel code ' + r.code);
      failed.push({ name, reason: why });
    }
  }
  if (deleted.length) {
    console.log('[users.js] userdel:', deleted.map(d => d.name + (d.home_removed ? '(-r)' : '')).join(', '));
  }
  return sendJSON(res, 200, {
    success: true, deleted, failed, skipped,
    total: deleted.length, failures: failed.length,
  });
}
