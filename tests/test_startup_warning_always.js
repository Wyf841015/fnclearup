// 首页风险弹窗「是否每次都弹」—— happy-dom 端到端执行真实函数
//
// 为什么这么做: 这段逻辑跨三处(index.html 两个勾选框 + main.js 读写 localStorage),
// 只做字符串断言看不出「取消勾选后另一个勾选框没同步」这类问题; 这里把
// getStartupWarningAlways / syncStartupWarningChecks / toggleStartupWarningAlways /
// showStartupWarning 真实跑一遍, 检查 localStorage 与 DOM 勾选状态是否一致。
//
// happy-dom 是可选依赖(本机装在 fnlogpush/node_modules 下)。找不到时整文件跳过。
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
function constSrc(src, name) {
  // const / let / var 都认（倒计时状态是 let 声明的）
  const m = new RegExp('^\\s*(?:const|let|var)\\s+' + name + '\\s*=\\s*[^;]+;', 'm').exec(src);
  return m ? m[0] : null;
}

// 需要真实执行的函数
const FNS = ['getStartupWarningAlways', 'syncStartupWarningChecks', 'toggleStartupWarningAlways', 'showStartupWarning'];
const DECLS = ['STARTUP_ALWAYS_KEY', '_startupCountdownTimer', '_startupCountdownLeft'];

function build(sandboxHtml, seed) {
  const win = new Window({ url: 'http://localhost/' });
  win.document.body.innerHTML = sandboxHtml;
  const toasts = [];
  const parts = [];
  for (const d of DECLS) { const s = constSrc(code, d); assert.ok(s, `源码里找不到常量 ${d}`); parts.push(s); }
  for (const f of FNS) { const s = fnSrc(code, f); assert.ok(s, `源码里找不到函数 ${f}`); parts.push(s); }
  const factory = new Function(
    'window', 'document', 'localStorage', '$', 'showToast', 'setInterval', 'clearInterval', '__out',
    parts.join('\n') + '\n__out.getStartupWarningAlways = getStartupWarningAlways;' +
    '\n__out.syncStartupWarningChecks = syncStartupWarningChecks;' +
    '\n__out.toggleStartupWarningAlways = toggleStartupWarningAlways;' +
    '\n__out.showStartupWarning = showStartupWarning;'
  );
  const out = {};
  const $ = (id) => win.document.getElementById(id);
  factory(win, win.document, win.localStorage, $, (m, t) => toasts.push({ m, t }),
    setInterval, clearInterval, out);
  if (seed) for (const [k, v] of Object.entries(seed)) win.localStorage.setItem(k, v);
  return { win, $, toasts, out };
}

const HTML = `
  <div class="modal-overlay" id="startupWarningModal"></div>
  <button id="startupWarningConfirmBtn" disabled></button>
  <span id="startupWarningCountdown">3</span>
  <input type="checkbox" id="startupWarningAlwaysCb">
  <input type="checkbox" id="startupWarningSettingCb">`;

const KEY = 'fnclearup.startup.warnAlways';

T('默认（无存储）按「每次都弹」处理', { skip }, () => {
  const { out } = build(HTML);
  assert.strictEqual(out.getStartupWarningAlways(), true);
});

T('存储 0 → 不再每次都弹；存储 1 → 每次都弹', { skip }, () => {
  const a = build(HTML, { [KEY]: '0' }); assert.strictEqual(a.out.getStartupWarningAlways(), false);
  const b = build(HTML, { [KEY]: '1' }); assert.strictEqual(b.out.getStartupWarningAlways(), true);
});

T('在弹窗里取消勾选：写入 0，且两处勾选框都同步为未勾选', { skip }, () => {
  const { out, $, win, toasts } = build(HTML, { [KEY]: '1' });
  out.syncStartupWarningChecks();
  assert.strictEqual($('startupWarningAlwaysCb').checked, true);
  assert.strictEqual($('startupWarningSettingCb').checked, true);

  // 模拟用户点掉弹窗里的勾选框
  $('startupWarningAlwaysCb').checked = false;
  out.toggleStartupWarningAlways();

  assert.strictEqual(win.localStorage.getItem(KEY), '0');
  assert.strictEqual($('startupWarningAlwaysCb').checked, false);
  assert.strictEqual($('startupWarningSettingCb').checked, false, '系统清理页的开关必须同步');
  assert.ok(toasts.length === 1 && /已关闭/.test(toasts[0].m), '应有「已关闭」提示');
});

T('在系统清理页重新打开：写入 1，两处勾选框都变勾选', { skip }, () => {
  const { out, $, win } = build(HTML, { [KEY]: '0' });
  out.syncStartupWarningChecks();
  assert.strictEqual($('startupWarningSettingCb').checked, false);

  $('startupWarningSettingCb').checked = true;
  out.toggleStartupWarningAlways();

  assert.strictEqual(win.localStorage.getItem(KEY), '1');
  assert.strictEqual($('startupWarningAlwaysCb').checked, true, '弹窗里的勾选框必须同步');
  assert.strictEqual($('startupWarningSettingCb').checked, true);
});

T('弹窗打开时勾选状态跟随已存偏好（不会显示过期状态）', { skip }, () => {
  const { out, $ } = build(HTML, { [KEY]: '0' });
  $('startupWarningAlwaysCb').checked = true;   // 故意先放错
  out.showStartupWarning();
  assert.strictEqual($('startupWarningAlwaysCb').checked, false, '打开时应按存储值校正');
  assert.ok($('startupWarningModal').classList.contains('visible'));
});

T('index.html 两处勾选框 / main.js 启动条件都在位', { skip }, () => {
  const html = fs.readFileSync(ROOT + '/app/ui/index.html', 'utf8');
  assert.match(html, /id="startupWarningAlwaysCb"[^>]*onchange="toggleStartupWarningAlways\(\)"/);
  assert.match(html, /id="startupWarningSettingCb"[^>]*onchange="toggleStartupWarningAlways\(\)"/);
  assert.match(code, /if \(getStartupWarningAlways\(\)\) showStartupWarning\(\);/,
    'init 里必须按偏好决定是否弹');
  assert.match(code, /toggleStartupWarningAlways, syncStartupWarningChecks,/, '必须导出到 window');
});
