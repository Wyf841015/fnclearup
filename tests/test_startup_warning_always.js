// 首页风险弹窗「是否每次都弹」—— UI 契约测试（happy-dom 真跑整页）
//
// 演变说明（重要）：
// 这个测试原来把 localStorage 当唯一真理源，靠抽取函数源码 + 注入假 localStorage
// 来验证。**2026-10-27 起设计变了**：偏好改存服务端 <TRM_PKGVAR>/data/ui-prefs.json，
// localStorage 只当本地缓存。原因是应用会同时跑在「应用中心 iframe」和
// 「CEF 独立新窗口」两种上下文，两者 localStorage 可能是不同存储分区，
// 导致「关了又弹」—— 用户报的就是这个。
//
// 所以这里改成**跑真实页面**（index.html + main.js + 假 fetch），验证的是
// 「开关语义 + 两只勾选框始终同步」这条 UI 契约；
// 「服务端优先 / 幂等」由 test_startup_warning_dom.js 覆盖，
// 「/api/prefs 读写容错」由 test_startup_warning_pref.js 覆盖。
//
// happy-dom 是可选依赖（本机装在 fnlogpush/node_modules 下），找不到整文件跳过。
import { test as T } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const code = fs.readFileSync(ROOT + '/app/ui/main.js', 'utf8');
const html = fs.readFileSync(ROOT + '/app/ui/index.html', 'utf8');

let Window = null;
for (const c of ['happy-dom',
  '/vol3/1000/hermes/fnlogpush/node_modules/happy-dom/lib/index.js',
  '/vol3/1000/hermes/netwatch/node_modules/happy-dom/lib/index.js']) {
  try { ({ Window } = await import(c)); break; } catch { /* 试下一个 */ }
}
const skip = Window ? false : 'happy-dom 不可用';

const KEY = 'fnclearup.startup.warnAlways';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 起一页真实应用。
 * prefs     = /api/prefs GET 返回的 prefs（null 表示这个接口一直失败）
 * saved     = 收集 POST /api/prefs 的请求体
 */
async function boot({ prefs = { startup_warn_always: true }, failGet = false, failPost = false } = {}) {
  const win = new Window({ url: 'http://localhost/app/fnclearup/' });
  win.document.write(html);
  try { win.localStorage.clear(); } catch { /* ignore */ }

  const saved = [];
  win.fetch = async (url, opts) => {
    const u = String(url || '');
    const method = (opts && opts.method) || 'GET';
    if (u.includes('api/prefs')) {
      if (method === 'POST') {
        if (failPost) return { ok: false, status: 500, json: async () => ({ success: false, error: '模拟失败' }), text: async () => '' };
        let body = {};
        try { body = JSON.parse((opts && opts.body) || '{}'); } catch { /* ignore */ }
        saved.push(body);
        const applied = (body.prefs || body);
        return { ok: true, status: 200, json: async () => ({ success: true, prefs: { startup_warn_always: true, ...applied } }), text: async () => '' };
      }
      if (failGet) return { ok: false, status: 500, json: async () => ({ success: false }), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({ success: true, prefs }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, ok: true, results: {}, users: [], kernels: [] }), text: async () => '{}' };
  };
  win.eval(code);
  await sleep(350);            // 等 init 的 async 分支
  return { win, saved, $: (id) => win.document.getElementById(id) };
}

const visible = (win) => !!win.document.getElementById('startupWarningModal')
  ?.classList.contains('visible');

T('默认（服务端和本地都没有值）按「每次都弹」处理', { skip }, async () => {
  const { win } = await boot({ prefs: {}, failGet: true });
  assert.equal(visible(win), true, '拿不到任何偏好时必须走安全默认：弹');
});

T('服务端 false → 不弹；服务端 true → 弹', { skip }, async () => {
  const a = await boot({ prefs: { startup_warn_always: false } });
  assert.equal(visible(a.win), false, 'false 时首屏不该弹');
  const b = await boot({ prefs: { startup_warn_always: true } });
  assert.equal(visible(b.win), true, 'true 时应该弹');
});

T('在弹窗里取消勾选：POST 出去 false，且两处勾选框都同步为未勾选', { skip }, async () => {
  const { win, saved, $ } = await boot({ prefs: { startup_warn_always: true } });
  assert.equal($('startupWarningAlwaysCb').checked, true);
  assert.equal($('startupWarningSettingCb').checked, true);

  $('startupWarningAlwaysCb').checked = false;      // 模拟用户点掉
  await win.eval("window.setStartupWarnFrom('modal')");
  await sleep(120);

  assert.equal(saved.length, 1, '必须把选择写到服务端（否则换个上下文又弹）');
  assert.equal(saved[0].prefs.startup_warn_always, false);
  assert.equal($('startupWarningAlwaysCb').checked, false);
  assert.equal($('startupWarningSettingCb').checked, false, '系统清理页的开关必须同步');
  assert.equal(win.localStorage.getItem(KEY), '0', '本地缓存也要同步（首屏快速路径靠它）');
});

T('在系统清理页重新打开：POST true，两处勾选框都变勾选', { skip }, async () => {
  const { win, saved, $ } = await boot({ prefs: { startup_warn_always: false } });
  assert.equal($('startupWarningSettingCb').checked, false);

  $('startupWarningSettingCb').checked = true;
  await win.eval("window.setStartupWarnFrom('setting')");
  await sleep(120);

  assert.equal(saved.length, 1);
  assert.equal(saved[0].prefs.startup_warn_always, true);
  assert.equal($('startupWarningAlwaysCb').checked, true, '弹窗里的勾选框必须同步');
  assert.equal($('startupWarningSettingCb').checked, true);
});

T('保存失败必须回滚：界面不能显示「已关闭」而实际没存上', { skip }, async () => {
  const { win, $ } = await boot({ prefs: { startup_warn_always: true }, failPost: true });
  assert.equal($('startupWarningAlwaysCb').checked, true);

  $('startupWarningAlwaysCb').checked = false;
  await win.eval("window.setStartupWarnFrom('modal')");
  await sleep(150);

  assert.equal($('startupWarningAlwaysCb').checked, true, '保存失败要把勾选状态改回去');
  assert.equal($('startupWarningSettingCb').checked, true, '另一处也要改回去');
  assert.equal(win.localStorage.getItem(KEY), '1', '本地缓存也要回滚，不能留 false');
});

T('弹窗打开时勾选状态按偏好校正（不显示过期状态）', { skip }, async () => {
  const { win, $ } = await boot({ prefs: { startup_warn_always: false } });
  $('startupWarningAlwaysCb').checked = true;        // 故意先放错
  win.eval('window.syncStartupWarningChecks()');
  assert.equal($('startupWarningAlwaysCb').checked, false, '应按偏好校正回来');
  // 偏好为 false 时手动弹（例如用户主动查看）也不该把状态改乱
  win.eval('window.showStartupWarning()');
  assert.equal($('startupWarningAlwaysCb').checked, false);
});

T('index.html 两处勾选框 / main.js 启动入口都在位', { skip }, () => {
  assert.match(html, /id="startupWarningAlwaysCb"[^>]*onchange="setStartupWarnFrom\('modal'\)"/);
  assert.match(html, /id="startupWarningSettingCb"[^>]*onchange="setStartupWarnFrom\('setting'\)"/);
  assert.match(code, /^\s*initStartupWarning\(\);\s*$/m, 'init 必须走统一入口');
  assert.match(code, /initStartupWarning, maybeShowStartupWarning,/, '必须导出到 window');
});
