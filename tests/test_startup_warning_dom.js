/**
 * 启动提示「首屏到底弹不弹」的 happy-dom 端到端测试
 *
 * 前面的 test_startup_warning_pref.js 只验了接口和字符串接线，
 * 但用户报的是**真实行为**：「勾选后有时还是会弹出」。字符串断言查不出这种问题 ——
 * 必须把 index.html + main.js 真跑起来，看那个 modal 到底有没有变成 visible。
 *
 * 两个场景：
 *   A) 服务端说 startup_warn_always=false 且本地无缓存 → 首屏不该弹
 *   B) 服务端说 startup_warn_always=true                    → 首屏应该弹
 *
 * happy-dom 从 fnlogpush 的 node_modules 借（本项目没装）。
 * Usage: node --test tests/test_startup_warning_dom.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(ROOT, 'app/ui/index.html'), 'utf8');
const MAIN = readFileSync(join(ROOT, 'app/ui/main.js'), 'utf8');

const HAPPY = '/vol3/1000/hermes/fnlogpush/node_modules/happy-dom/lib/index.js';

let Window = null;
try { ({ Window } = await import(HAPPY)); } catch { /* 借不到就跳过 */ }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 起一个独立的 happy-dom 世界，把 main.js 跑起来。
 * @param {object} opts.prefs  /api/prefs 返回的 prefs
 * @param {boolean} opts.haveLocalCache  localStorage 里是否预置值
 */
async function boot({ prefs, haveLocalCache = false, localWarnAlways = null }) {
  const win = new Window({ url: 'http://localhost/app/fnclearup/' });
  win.document.write(HTML);

  // localStorage：模拟「本地没缓存」和「本地有旧缓存」两种情况
  try {
    win.localStorage.clear();
    if (haveLocalCache) {
      win.localStorage.setItem('fnclearup.startup.warnAlways', prefs.startup_warn_always ? '1' : '0');
    } else if (localWarnAlways !== null) {
      // 明确指定本地缓存值（可与服务端相反，用来验「服务端优先」）
      win.localStorage.setItem('fnclearup.startup.warnAlways', localWarnAlways ? '1' : '0');
    }
  } catch { /* happy-dom 一般支持 */ }

  const calls = [];
  win.fetch = async (url) => {
    const u = String(url || '');
    calls.push(u);
    let body = { success: true };
    if (u.includes('api/prefs')) body = { success: true, prefs };
    else if (u.includes('api/cleanup/quick-summary')) body = { ok: true, results: {} };
    else if (u.includes('/api/kernel/scan')) body = { success: true, kernels: [], apt_cache: {} };
    else if (u.includes('api/users')) body = { success: true, users: [] };
    else if (u.includes('api/schedule')) body = { success: true };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  // main.js 用到的浏览器能力补齐
  win.AbortController = win.AbortController || globalThis.AbortController;
  win.eval(MAIN);
  await sleep(400);            // 等 init 里的 async 分支跑完
  return { win, calls };
}

function isWarningVisible(win) {
  const m = win.document.getElementById('startupWarningModal');
  return !!(m && m.classList.contains('visible'));
}

describe('启动风险提示：首屏真实行为', { skip: Window ? false : '借不到 happy-dom' }, () => {
  test('服务端说「不再弹」且本地无缓存 → 首屏不弹', async () => {
    const { win, calls } = await boot({ prefs: { startup_warn_always: false }, haveLocalCache: false });
    assert.ok(calls.some(c => String(c).includes('api/prefs')), '本地无缓存时必须去问服务端');
    assert.equal(isWarningVisible(win), false, '关掉之后首屏不能弹（这正是用户报的 bug）');
  });

  test('服务端说「每次都弹」→ 首屏弹', async () => {
    const { win } = await boot({ prefs: { startup_warn_always: true }, haveLocalCache: false });
    assert.equal(isWarningVisible(win), true, '开着的时候应该弹');
  });

  test('本地缓存说「弹」但服务端说「不弹」→ 不弹（服务端优先，绝不先弹再收）', async () => {
    // 这是最容易出问题的一种：用户在 iframe 里关掉了，CEF 新窗口那套 localStorage
    // 还残留着 "1"。如果实现成「本地优先 + 后台对齐」，就会先弹一次再收 ——
    // 用户看到的就是"我明明关了它又弹"。
    const { win } = await boot({ prefs: { startup_warn_always: false }, localWarnAlways: true });
    assert.equal(isWarningVisible(win), false, '服务端说关就一次都不能弹');
  });

  test('本地缓存说「不弹」但服务端说「弹」→ 弹（以服务端为准）', async () => {
    const { win } = await boot({ prefs: { startup_warn_always: true }, localWarnAlways: false });
    assert.equal(isWarningVisible(win), true, '服务端说弹就该弹');
  });

  test('只有一次首屏弹出机会：重复触发不会重开', async () => {
    const { win } = await boot({ prefs: { startup_warn_always: true }, haveLocalCache: false });
    const m = win.document.getElementById('startupWarningModal');
    assert.ok(m.classList.contains('visible'));
    // 手动关掉，然后尝试再触发一次（模拟别的路径又调了一次）
    win.eval("window.closeStartupWarning(false)");
    await sleep(50);
    assert.equal(isWarningVisible(win), false);
    win.eval("window.maybeShowStartupWarning()");
    await sleep(50);
    assert.equal(isWarningVisible(win), false, '一次页面加载最多弹一次');
  });
});
