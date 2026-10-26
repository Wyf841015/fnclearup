// 用户清理 UI —— happy-dom 端到端执行真实渲染函数
//
// 只做静态断言看不出「默认是否真的隐藏了系统账号」「不可删的行是否真的 disabled」
// 「确认按钮是否真的被 ack 勾住」这类问题，这里把 main.js 里的函数真实跑一遍。
// happy-dom 是可选依赖（本机装在 fnlogpush/node_modules 下），找不到时整个文件跳过。
import { test as T } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let Window = null;
for (const c of ['happy-dom',
  '/vol3/1000/hermes/fnlogpush/node_modules/happy-dom/lib/index.js',
  '/vol3/1000/hermes/netwatch/node_modules/happy-dom/lib/index.js']) {
  try { ({ Window } = await import(c)); break; } catch { /* 试下一个 */ }
}
const skip = Window ? false : 'happy-dom 不可用';

const code = fs.readFileSync(ROOT + '/app/ui/main.js', 'utf8');

function fnSrc(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let i = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0;
  for (let x = i; x < src.length; x++) {
    if (src[x] === '{') d++;
    else if (src[x] === '}') { d--; if (d === 0) return src.slice(m.index, x + 1); }
  }
  return null;
}
function declSrc(src, name) {
  const m = new RegExp('^\\s*(?:const|let|var)\\s+' + name + '\\s*=\\s*[^;]+;', 'm').exec(src);
  return m ? m[0] : null;
}

const FNS = ['getUsersShowSystem', 'toggleUsersShowSystem', 'renderUsers', 'selectAllUsers',
  'selectedUserNames', 'updateUsersSelectInfo', 'showUsersDeleteModal', 'hideUsersDeleteModal',
  'usersRefreshConfirmBtn', 'usersKindBadge', 'usersDockerBadge', 'escHtml', 'confirmUsersDelete'];
const DECLS = ['USERS_SHOW_SYSTEM_KEY', '_usersCache', 'USERS_DELETE_BATCH'];

const HTML = `
  <div id="users-status"></div>
  <div id="users-list"></div>
  <div id="users-empty"><h3>empty</h3></div>
  <div id="users-select-info" style="display:none"></div>
  <button id="usersDeleteBtn" disabled></button>
  <input type="checkbox" id="usersShowSystemCb">
  <div class="modal-overlay" id="usersDeleteModal">
    <span id="usersDeleteCount">0</span>
    <div id="usersDeleteNames"></div>
    <p id="usersDeleteBatchTip" style="display:none"></p>
    <input type="checkbox" id="usersDeleteRemoveHome">
    <input type="checkbox" id="usersDeleteAck">
    <button id="usersDeleteConfirmBtn" disabled></button>
  </div>`;

// 夹具：一个可删应用账号、一个可删真实用户、一个系统账号、一个「已装应用」账号、一个家目录不可删的账号
const USERS = [
  { name: 'root', uid: 0, gid: 0, home: '/root', kind: 'system', deletable: false, reason: 'root 账号，禁止删除', warn: '', home_removable: false },
  { name: 'lp', uid: 7, gid: 7, home: '/var/spool/lpd', kind: 'system', deletable: false, reason: '系统/服务账号（uid 7 < 900），不可删除', warn: '', home_removable: true },
  { name: 'fakeapp', uid: 950, gid: 901, home: '/home/fakeapp', kind: 'app', deletable: true, reason: '', warn: '', home_removable: true },
  { name: 'installed', uid: 960, gid: 901, home: '/home/installed', kind: 'app', deletable: false, reason: '应用「installed」仍在安装中，请先在应用中心卸载', warn: '', home_removable: true },
  { name: 'fakereal', uid: 1001, gid: 1001, home: '/home/fakereal', kind: 'user', deletable: true, reason: '', warn: '仍有目录属于该账号：/vol3/@appcenter/x', home_removable: true },
  { name: 'nohome', uid: 952, gid: 901, home: '/', kind: 'app', deletable: true, reason: '', warn: '', home_removable: false },
];

function build(seed, postHandler) {
  const win = new Window({ url: 'http://localhost/' });
  win.document.body.innerHTML = HTML;
  const toasts = [];
  const posts = [];
  let loadCalls = 0;
  const parts = [];
  for (const d of DECLS) { const s = declSrc(code, d); assert.ok(s, `源码缺常量 ${d}`); parts.push(s); }
  for (const f of FNS) { const s = fnSrc(code, f); assert.ok(s, `源码缺函数 ${f}`); parts.push(s); }
  const out = {};
  const $ = (id) => win.document.getElementById(id);
  const API = {
    get: async () => ({ success: true, users: USERS, stats: { total: USERS.length } }),
    post: async (p, body) => {
      posts.push({ path: p, body: JSON.parse(JSON.stringify(body)) });
      return postHandler ? postHandler(body, posts.length) : { success: true, __ok: true, deleted: [], failed: [], skipped: [] };
    },
  };
  const loadUsers = () => { loadCalls++; return Promise.resolve(); };
  const factory = new Function('window', 'document', 'localStorage', '$', 'showToast', 'API', 'loadUsers', '__out',
    parts.join('\n') + '\n' +
    FNS.map(f => `__out.${f} = ${f};`).join('\n') + '\n' +
    // _usersCache 是沙箱内的闭包变量，必须从内部赋值（外部改 out._usersCache 无效）
    '__out.setUsers = function (v) { _usersCache = v; };');
  factory(win, win.document, win.localStorage, $, (m, t) => toasts.push({ m, t }), API, loadUsers, out);
  if (seed) for (const [k, v] of Object.entries(seed)) win.localStorage.setItem(k, v);
  out.setUsers(USERS);          // 注入夹具数据（等价于 loadUsers 拉回来的结果）
  return { win, $, toasts, out, posts, loadCalls: () => loadCalls };
}

const rowsOf = (win) => [...win.document.querySelectorAll('#users-table tbody tr')]
  .map(tr => tr.querySelector('.users-cb').value);

T('默认隐藏系统自带账号', { skip }, () => {
  const { win, out } = build();
  out.renderUsers();
  const names = rowsOf(win);
  assert.ok(!names.includes('root'), 'root 属系统账号，默认不该显示');
  assert.ok(!names.includes('lp'), 'lp 属系统账号，默认不该显示');
  assert.deepStrictEqual(names, ['fakeapp', 'installed', 'fakereal', 'nohome']);
});

T('勾上「显示系统账号」后全部显示，且系统行不可勾选', { skip }, () => {
  const { win, $, out } = build();
  $('usersShowSystemCb').checked = true;
  out.toggleUsersShowSystem();
  const names = rowsOf(win);
  assert.deepStrictEqual(names, ['root', 'lp', 'fakeapp', 'installed', 'fakereal', 'nohome']);
  const rowOf = (n) => [...win.document.querySelectorAll('#users-table tbody tr')]
    .find(tr => tr.querySelector('.users-cb').value === n);
  assert.strictEqual(rowOf('root').querySelector('.users-cb').disabled, true, 'root 的勾选框必须 disabled');
  assert.strictEqual(rowOf('installed').querySelector('.users-cb').disabled, true, '已装应用的账号必须 disabled');
  assert.strictEqual(rowOf('fakeapp').querySelector('.users-cb').disabled, false);
  assert.strictEqual(win.localStorage.getItem('fnclearup.users.showSystem'), '1', '开关要持久化');
});

T('默认开关值：localStorage 没有记录时是「不显示系统账号」', { skipped: false }, () => {
  const { out } = build();
  assert.strictEqual(out.getUsersShowSystem(), false);
});

T('全选只勾「可删」的行，并更新已选计数与按钮状态', { skip }, () => {
  const { win, $, out } = build();
  out.renderUsers();
  assert.strictEqual($('usersDeleteBtn').disabled, true, '一开始没选，删除按钮应禁用');
  out.selectAllUsers({ checked: true });
  const checked = [...win.document.querySelectorAll('#users-table .users-cb:checked')].map(cb => cb.value);
  assert.deepStrictEqual(checked, ['fakeapp', 'fakereal', 'nohome'], '不可删的行不该被全选勾上');
  assert.strictEqual($('usersDeleteBtn').disabled, false);
  assert.match($('users-select-info').textContent, /已选 3 个账号/);
});

T('删除弹窗：列出账号、清空 ack、确认按钮需勾 ack 才可点', { skip }, () => {
  const { win, $, out } = build();
  out.renderUsers();
  out.selectAllUsers({ checked: true });
  out.showUsersDeleteModal();
  assert.ok($('usersDeleteModal').classList.contains('visible'));
  assert.strictEqual($('usersDeleteCount').textContent, '3');
  const namesHtml = $('usersDeleteNames').innerHTML;
  assert.match(namesHtml, /fakeapp/);
  assert.match(namesHtml, /fakereal/);
  assert.strictEqual($('usersDeleteAck').checked, false, '每次打开都要重新确认');
  assert.strictEqual($('usersDeleteConfirmBtn').disabled, true);

  $('usersDeleteAck').checked = true;
  out.usersRefreshConfirmBtn();
  assert.strictEqual($('usersDeleteConfirmBtn').disabled, false, '勾了 ack 才允许删');
});

T('所选账号里有家目录不可删的 → 禁用「同时删家目录」', { skip }, () => {
  const { win, $, out } = build();
  out.renderUsers();
  // 只选 nohome（家目录是 /，不可 -r）
  [...win.document.querySelectorAll('#users-table .users-cb')].forEach(cb => { cb.checked = (cb.value === 'nohome'); });
  out.updateUsersSelectInfo();
  out.showUsersDeleteModal();
  assert.strictEqual($('usersDeleteRemoveHome').disabled, true, '家目录不可删时必须禁用 -r 勾选项');
  assert.strictEqual($('usersDeleteRemoveHome').checked, false);

  out.hideUsersDeleteModal();
  // 只选 fakeapp（家目录正常）→ 应恢复可用
  [...win.document.querySelectorAll('#users-table .users-cb')].forEach(cb => { cb.checked = (cb.value === 'fakeapp'); });
  out.updateUsersSelectInfo();
  out.showUsersDeleteModal();
  assert.strictEqual($('usersDeleteRemoveHome').disabled, false);
});

T('index.html / main.js 结构在位（tab、panel、弹窗、switchTab 钩子）', { skip }, () => {
  const html = fs.readFileSync(ROOT + '/app/ui/index.html', 'utf8');
  assert.match(html, /data-tab="users"[^>]*switchTab\('users'\)/, '缺少「用户」tab');
  assert.match(html, /data-panel="users"/, '缺少用户 panel');
  assert.match(html, /id="usersDeleteModal"/, '缺少删除确认弹窗');
  assert.match(html, /id="usersShowSystemCb"[^>]*toggleUsersShowSystem\(\)/, '缺少「显示系统账号」开关');
  assert.match(html, /id="usersDeleteAck"/, '缺少确认勾选');
  // 分组里 app 之后还会继续加 tab（如 kernel），所以只断言 users 在这个组里、不强绑顺序尾部
  assert.match(code, /clean: \[[^\]]*'users'[^\]]*\]/, 'TAB_GROUPS 未登记 users');
  assert.match(code, /tabName==='users'\) \{ await loadUsers\(\); \}/, 'switchTab 未挂 loadUsers');
});

// ── 「全选后删除」回归（真实反馈：提示「已删除 0 个账号」） ──
// 根因：后端单次上限 20，全选 30+ 个 → 400；而 API.post 对 4xx 不抛异常，
// confirmUsersDelete 直接读 d.deleted（空数组）→ 界面报「已删除 0 个账号」，
// 真正原因（一次最多删 20 个）被吃掉。修法：前端分批提交 + 校验 __ok/success。
T('全选 45 个可删账号 → 分 3 批提交（每批 ≤20），汇总提示已删除 45', { skip }, async () => {
  const many = Array.from({ length: 45 }, (_, i) => ({
    name: 'u' + i, uid: 950 + i, gid: 901, home: '/home/u' + i, kind: 'app',
    deletable: true, reason: '', warn: '', home_removable: true,
  }));
  const { win, $, out, posts, toasts, loadCalls } = build(null, (body) => ({
    success: true, __ok: true,
    deleted: body.users.map(u => ({ name: u.name, home_removed: false })), failed: [], skipped: [],
  }));
  out.setUsers(many);
  out.renderUsers();
  out.selectAllUsers({ checked: true });
  assert.strictEqual(out.selectedUserNames().length, 45);

  out.showUsersDeleteModal();
  assert.strictEqual($('usersDeleteCount').textContent, '45');
  // 超过 20 个时弹窗要提示会分批
  assert.strictEqual($('usersDeleteBatchTip').style.display, '', '>20 时应显示分批提示');
  assert.match($('usersDeleteBatchTip').textContent, /分批/);

  $('usersDeleteAck').checked = true;
  out.usersRefreshConfirmBtn();
  await out.confirmUsersDelete();

  assert.strictEqual(posts.length, 3, '45 个应分 3 批提交，实际 ' + posts.length);
  assert.deepStrictEqual(posts.map(p => p.body.users.length), [20, 20, 5]);
  for (const p of posts) {
    assert.strictEqual(p.body.ack, true, '每批都要带 ack');
    assert.ok(p.body.users.length <= 20, '每批不得超过后端上限');
  }
  const toast = toasts.map(t => t.m).join(' | ');
  assert.match(toast, /已删除 45 个账号/);
  assert.ok(!/已删除 0 个/.test(toast), '不能出现「已删除 0 个」');
  assert.strictEqual(loadCalls(), 1, '删完要刷新列表');
});

T('后端拒绝（400 success:false）时提示真实原因，不再假报「已删除 0 个账号」', { skip }, async () => {
  const { $, out, posts, toasts } = build(null, () => ({
    success: false, __ok: false, __error: '一次最多删除 20 个用户',
  }));
  out.renderUsers();
  out.selectAllUsers({ checked: true });
  out.showUsersDeleteModal();
  $('usersDeleteAck').checked = true;
  out.usersRefreshConfirmBtn();
  await out.confirmUsersDelete();

  assert.strictEqual(posts.length, 1, '被拒绝后应立即停止，不继续下一批');
  const toast = toasts.map(t => t.m).join(' | ');
  assert.match(toast, /删除失败/);
  assert.match(toast, /一次最多删除 20 个用户/, '必须把后端原因透出');
  assert.ok(!/已删除 0 个/.test(toast));
});

T('skipped（账号已不存在）也会汇总进提示', { skip }, async () => {
  const { $, out, toasts } = build(null, (body) => ({
    success: true, __ok: true,
    deleted: body.users.slice(0, 1).map(u => ({ name: u.name })),
    failed: [], skipped: body.users.slice(1).map(u => ({ name: u.name, reason: '账号不存在' })),
  }));
  out.renderUsers();
  out.selectAllUsers({ checked: true });
  out.showUsersDeleteModal();
  $('usersDeleteAck').checked = true;
  out.usersRefreshConfirmBtn();
  await out.confirmUsersDelete();
  const toast = toasts.map(t => t.m).join(' | ');
  assert.match(toast, /已删除 1 个账号/);
  assert.match(toast, /账号不存在/);
});

T('删除数 ≤20 时弹窗不显示分批提示', { skip }, () => {
  const { $, out } = build();
  out.renderUsers();
  out.selectAllUsers({ checked: true });
  out.showUsersDeleteModal();
  assert.strictEqual($('usersDeleteBatchTip').style.display, 'none');
});

// Docker 占用：行上要有 Docker 标记 + 不可勾选；没被 Docker 用的行不能多出标记
const DOCKER_USERS = [
  { name: 'dockerused', uid: 953, gid: 901, home: '/home/dockerused', kind: 'app', deletable: false,
    reason: 'Docker 容器「dockerapp」正在使用该账号，挂载目录 /vol3/docker/app/data', warn: '', home_removable: true,
    docker: { container: 'dockerapp', via: '挂载目录 /vol3/docker/app/data' } },
  { name: 'freeapp', uid: 952, gid: 901, home: '/home/freeapp', kind: 'app', deletable: true,
    reason: '', warn: '', home_removable: true, docker: null },
];

T('Docker 占用的账号：显示 Docker 标记、勾选框禁用、原因写清容器与来源', { skip }, () => {
  const { win, out } = build();
  out.setUsers(DOCKER_USERS);
  out.renderUsers();
  const rowOf = (n) => [...win.document.querySelectorAll('#users-table tbody tr')]
    .find(tr => tr.querySelector('.users-cb').value === n);

  const dr = rowOf('dockerused');
  assert.strictEqual(dr.querySelector('.users-cb').disabled, true, 'Docker 占用的账号必须 disabled');
  assert.match(dr.textContent, /Docker/, '类型列要出现 Docker 标记');
  assert.match(dr.textContent, /dockerapp/, '说明列要点出容器名');
  assert.match(dr.textContent, /挂载目录/, '说明列要写清是被哪种方式占用');

  const fr = rowOf('freeapp');
  assert.strictEqual(fr.querySelector('.users-cb').disabled, false);
  assert.doesNotMatch(fr.textContent, /Docker/, '没被 Docker 占用的账号不能多出标记');
});

T('Docker 占用的账号不会被全选勾上（否则用户以为能删）', { skip }, () => {
  const { win, out } = build();
  out.setUsers(DOCKER_USERS);
  out.renderUsers();
  out.selectAllUsers({ checked: true });
  const checked = [...win.document.querySelectorAll('#users-table .users-cb:checked')].map(cb => cb.value);
  assert.deepStrictEqual(checked, ['freeapp']);
});
