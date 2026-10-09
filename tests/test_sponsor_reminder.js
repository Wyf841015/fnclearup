import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(new URL('../app/ui/main.js', import.meta.url), 'utf8');

function fnBody(src, sig) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + sig + '\\s*\\(').exec(src);
  if (!m) return null;
  const i = m.index;
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return null;
}

/* ── 用假 localStorage 隔离, 绝不碰真实浏览器存储 ── */
function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    _map: map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

/* ══════════════════════════════════════════════════════════════
   源码接线
   ══════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════
   频率算法 —— 抠 main.js 的**真源码**来跑。

   这里踩过一次坑: 最初我在测试里另写了一份 decide() 重实现频率算法,
   结果把 main.js 的 `due = ...` 改成"永远该弹"时, 测试依然全绿 ——
   因为验的根本不是真代码。不可靠的测试比没有测试更糟。
   现在改成 extract 真实函数体 + 注入假的 localStorage / setTimeout /
   showSponsorModal, 测的就一定是线上跑的那份逻辑。
   ══════════════════════════════════════════════════════════════ */
const SPONSOR_FN_SRC = fnBody(MAIN, 'maybeShowSponsorReminder');
const KEY_CONST = /const SPONSOR_REMIND_KEY\s*=\s*'([^']+)'/.exec(MAIN);
// 注意这里必须 eval 而不是 Number(): 常量源码是 '7 * 24 * 60 * 60 * 1000',
// Number('7*24*60*60*1000') === NaN —— 会让生成的上限变成 NaN, 比较恒不成立,
// 于是 due 永远 true(每次都弹), 而测试自己却全绿。这个坑踩过一次。
// 正则只允许 数字/空格/*/()/+, eval 的是纯算式, 无注入面。
const INTERVAL_SRC = /const SPONSOR_REMIND_INTERVAL_MS\s*=\s*([\d\s*()]+);/.exec(MAIN)[1];
if (!/^[\d\s*()+]+$/.test(INTERVAL_SRC)) throw new Error('SPONSOR_REMIND_INTERVAL_MS 源码异常: ' + INTERVAL_SRC);
const INTERVAL_CONST = eval(INTERVAL_SRC.replace(/\s+/g, ' '));
if (!Number.isFinite(INTERVAL_CONST) || INTERVAL_CONST <= 0) {
  throw new Error('SPONSOR_REMIND_INTERVAL_MS 求值异常: ' + INTERVAL_SRC + ' → ' + INTERVAL_CONST);
}

// 真跑: 注入可控的 localStorage / Date.now / setTimeout / showSponsorModal
function runReal(nowMs, storage) {
  let shown = 0;
  const timers = [];
  const shim = new Function(
    'localStorage', 'Date', 'setTimeout', 'showSponsorModal',
    KEY_CONST[0] + '\n' + INTERVAL_CONST_TEXT() + '\n' + SPONSOR_FN_SRC + '\nreturn maybeShowSponsorReminder();'
  );
  const due = shim.call(null,
    storage,
    { now: () => nowMs },
    (fn) => { timers.push(fn); },     // 记下待执行的定时器, 不真等
    () => { shown++; }
  );
  // shown 必须用 getter 暴露: 定时器是在 runReal 返回**之后**才触发的,
  // 按值返回的话 r.shown 永远是调用那一刻的快照(0), 断言"触发后应弹"必挂。
  return { due, timers, get shown() { return shown; } };
}
function INTERVAL_CONST_TEXT() {
  return 'const SPONSOR_REMIND_INTERVAL_MS = ' + INTERVAL_CONST + ';';
}

test('常量: SPONSOR_REMIND_INTERVAL_MS 必须是有限正数(不是 NaN)', () => {
  assert.ok(Number.isFinite(INTERVAL_CONST), '上限求值得到 ' + INTERVAL_CONST + ', 不能是 NaN/Infinity');
  assert.ok(INTERVAL_CONST > 0, '上限必须为正, 实得 ' + INTERVAL_CONST);
  assert.strictEqual(INTERVAL_CONST, 7 * 24 * 60 * 60 * 1000, '当前设定应为 7 天');
  assert.ok(KEY_CONST[1], 'SPONSOR_REMIND_KEY 应解析出真实键名');
});

test('真源码: 首次打开必弹', () => {
  const st = makeStorage({});
  const r = runReal(1000000, st);
  assert.strictEqual(r.due, true, 'due 应为 true');
  assert.strictEqual(r.timers.length, 1, '应排一个延后一拍的定时器');
  r.timers[0]();
  assert.strictEqual(r.shown, 1, '定时器触发后应真的调用 showSponsorModal');
  assert.ok(Number(st.getItem(KEY_CONST[1])) === 1000000, '应记下当前时间戳');
});

test('真源码: 刚弹过(< 7 天)不再弹', () => {
  const st = makeStorage({});
  const t0 = 1000000;
  runReal(t0, st);
  const r = runReal(t0 + 1000, st);
  assert.strictEqual(r.due, false, '1 秒后再打开不该弹');
  assert.strictEqual(r.timers.length, 0, '不该排定时器');
  const r2 = runReal(t0 + INTERVAL_CONST - 1, st);
  assert.strictEqual(r2.due, false, '差 1ms 也不该弹');
});

test('真源码: 超过 7 天再弹一次', () => {
  const st = makeStorage({});
  const t0 = 1000000;
  runReal(t0, st);
  const r = runReal(t0 + INTERVAL_CONST, st);
  assert.strictEqual(r.due, true, '满 7 天应再弹');
  assert.strictEqual(r.timers.length, 1);
  // 再过 7 天
  const r2 = runReal(t0 + INTERVAL_CONST * 2, st);
  assert.strictEqual(r2.due, true);
});

test('真源码: localStorage 抛异常时按「该弹」处理(不静默失效)', () => {
  const broken = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceeded'); },
  };
  const r = runReal(Date.now(), broken);
  assert.strictEqual(r.due, true, '存储不可用时仍应提醒');
});

test('真源码: 脏值不会把提醒卡死', () => {
  for (const v of ['', 'abc', 'NaN', '0']) {
    const st = makeStorage({ [KEY_CONST[1]]: v });
    const r = runReal(1000000, st);
    assert.strictEqual(r.due, true, `脏值 ${JSON.stringify(v)} 应被当作「该弹」`);
  }
});

test('真源码: 延后一拍(与风险警告关闭动画错开)', () => {
  const st = makeStorage({});
  const r = runReal(1000000, st);
  assert.strictEqual(r.shown, 0, '刚返回时不应已弹(还在定时器里)');
  assert.strictEqual(r.timers.length, 1);
  r.timers[0]();
  assert.strictEqual(r.shown, 1);
});

test('closeStartupWarning(true) 会触发赞助提醒', () => {
  const body = fnBody(MAIN, 'closeStartupWarning');
  assert.ok(body, '应能找到 closeStartupWarning');
  assert.match(body, /maybeShowSponsorReminder\(\)/,
    '确认风险警告后应调用 maybeShowSponsorReminder()');
  // 必须包在 if (confirmed) 里 —— 走 ✕ 关闭(未确认)时不该弹赞助
  const ifIdx = body.indexOf('if (confirmed)');
  const callIdx = body.indexOf('maybeShowSponsorReminder();');
  assert.ok(ifIdx > 0 && callIdx > ifIdx,
    '调用必须在 if (confirmed) 块内: 未确认就关闭时不该弹赞助框');
});

test('maybeShowSponsorReminder 会更新时间戳并在到期时才弹', () => {
  const body = fnBody(MAIN, 'maybeShowSponsorReminder');
  assert.ok(body, '应能找到 maybeShowSponsorReminder');
  assert.match(body, /localStorage\.setItem\(\s*SPONSOR_REMIND_KEY/,
    '弹出时应记下时间戳, 否则每次打开都会弹');
  assert.match(body, /if\s*\(due\)\s*\{[\s\S]*showSponsorModal\(\)/,
    '只在到期时调 showSponsorModal()');
  // 延后一拍, 避免和风险警告的关闭动画叠在一起闪
  assert.match(body, /setTimeout\(\s*\(\)\s*=>\s*showSponsorModal\(\)\s*,\s*\d+\s*\)/,
    '应延后一拍再弹, 不要和警告弹窗关闭动画重叠');
});

test('常量与键名就位', () => {
  assert.match(MAIN, /const SPONSOR_REMIND_KEY\s*=\s*'fnclearup\.sponsor\.remindAt'/);
  assert.match(MAIN, /const SPONSOR_REMIND_INTERVAL_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
});

test('catch 分支必须兜底为「该弹」', () => {
  const body = fnBody(MAIN, 'maybeShowSponsorReminder');
  const catchIdx = body.indexOf('catch');
  assert.ok(catchIdx > 0, 'localStorage 可能抛异常(隐私模式/配额满), 必须有 catch');
  const seg = body.slice(catchIdx, catchIdx + 260);
  assert.match(seg, /due\s*=\s*true/, '存储不可用时应按「该弹」处理, 不能让提醒静默失效');
});

test('已导出到 window(便于手动触发调试)', () => {
  const i = MAIN.indexOf('const exports = {');
  assert.ok(i > 0);
  assert.match(MAIN.slice(i, i + 600), /maybeShowSponsorReminder/);
});

test('赞助弹窗本身有关闭入口(✕ / 点遮罩)', () => {
  const HTML = readFileSync(new URL('../app/ui/index.html', import.meta.url), 'utf8');
  const i = HTML.indexOf('id="sponsorModal"');
  assert.ok(i > 0, 'index.html 应有 sponsorModal');
  const seg = HTML.slice(i - 200, i + 900);
  assert.match(seg, /classList\.remove\('show'\)/, '赞助弹窗应有 ✕ / 点遮罩关闭入口');
});
