// main.js 可加载性回归测试 (2026-10-01 事故)
//
// 真实事故: P2-2「缓存命中统计」把 blockedNotice 插到 showToast 的 setTimeout
// 行之后, 而 showToast 的闭合 `}` 被吞掉 —— 于是其后插入的所有函数
// (blockedNotice / loadDupExcludeRules / saveDupExcludeRules / ...) 都落在
// showToast 的函数体内。const exports 块在模块作用域引用它们时抛
//   ReferenceError: saveDupExcludeRules is not defined
// init() 因此中断, Object.assign(window, exports) 从未执行, 结果是
// **全站按钮点击毫无反应**。
//
// 关键教训: node --check 只验语法(这类错误语法完全合法), 字符串断言也查不出。
// 必须真的把 main.js 跑起来, 让 init() 执行, 看 window 上是否挂出函数。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'app', 'ui', 'main.js');
const mainSrc = fs.readFileSync(MAIN, 'utf8');

const STUB = `
const stubEl = () => ({ style:{}, dataset:{}, classList:{add(){},remove(){},toggle(){},contains(){return false}},
  appendChild(){}, removeChild(){}, addEventListener(){}, removeEventListener(){}, setAttribute(){},
  querySelector(){return null}, querySelectorAll(){return []}, insertBefore(){}, remove(){}, children:[], childNodes:[] });
globalThis.document = { getElementById: () => null, querySelector: () => stubEl(), querySelectorAll: () => [],
  createElement: () => stubEl(), createTextNode: () => ({}), addEventListener(){},
  body: stubEl(), readyState:'complete', documentElement: stubEl(), head: stubEl(), cookie:'' };
globalThis.window = { addEventListener(){}, location:{ href:'http://x/', pathname:'/app/fnclearup/', search:'' },
  matchMedia: () => ({ matches:false, addEventListener(){}, addListener(){} }),
  innerWidth:1400, innerHeight:900, getComputedStyle: () => ({ getPropertyValue: () => '' }) };
globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
globalThis.fetch = async () => ({ ok:true, status:200, json: async()=>({}), text: async()=>'' });
globalThis.AbortSignal = { timeout: () => ({}) };
globalThis.MutationObserver = class { observe(){} disconnect(){} };
globalThis.IntersectionObserver = class { observe(){} disconnect(){} };
globalThis.ResizeObserver = class { observe(){} disconnect(){} };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.getComputedStyle = globalThis.window.getComputedStyle;
try { Object.defineProperty(globalThis,'navigator',{value:{clipboard:{},userAgent:'node',language:'zh'},configurable:true}); } catch(e){}
`;

function loadMain() {
  const tmp = path.join(os.tmpdir(), `fnc_main_probe_${process.pid}.mjs`);
  const probe = STUB + '\ntry {\n' + mainSrc + `
    console.log('LOADED_OK');
    var keys = Object.keys(window).filter(k => typeof window[k] === 'function');
    console.log('FN_COUNT:' + keys.length);
    console.log('FN_LIST:' + keys.join(','));
  } catch(e) {
    console.log('THROWN:' + e.constructor.name + ': ' + e.message);
    console.log((e.stack||'').split('\\n').slice(0,5).join(' | '));
    process.exit(1);
  }
`;
  fs.writeFileSync(tmp, probe);
  try {
    const out = execFileSync('node', [tmp], { encoding: 'utf8', timeout: 60000 });
    return { ok: true, out };
  } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

test('main.js 能真正加载, init() 不抛异常(全站按钮可用的前提)', () => {
  const r = loadMain();
  const m = r.out.match(/FN_COUNT:(\d+)/);
  assert.ok(!r.out.includes('THROWN:'),
    `main.js 顶层抛错 —— 会导致 Object.assign(window,exports) 不执行, 全站按钮失效:\n${r.out}`);
  assert.ok(m, '未执行到导出统计, 说明 init 中途抛错:\n' + r.out.slice(-600));
  assert.ok(Number(m[1]) > 50, `window 上只挂出 ${m[1]} 个函数, 明显异常(正常 >100)`);
});

test('showToast 的闭合花括号在函数体内(事故点的精确防线)', () => {
  const i = mainSrc.indexOf('function showToast(');
  assert.ok(i > 0, '未找到 showToast');
  const lines = mainSrc.slice(i).split('\n');
  let depth = 0, closed = -1;
  for (let k = 1; k < Math.min(lines.length, 30); k++) {
    for (const ch of lines[k]) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { closed = k; break; } }
    }
    if (closed >= 0) break;
  }
  assert.ok(closed > 0, 'showToast 未闭合(或闭合点异常远)');
  assert.ok(closed <= 8, `showToast 在第 ${closed + 1} 行才闭合, 中间混进了其他函数定义`);
});
