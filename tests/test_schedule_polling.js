import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(new URL('../app/ui/main.js', import.meta.url), 'utf8');
const SCHED_API = readFileSync(new URL('../app/ui/api/schedule.js', import.meta.url), 'utf8');

/** 按花括号配对精确取出函数体, 不用固定字符数切片 ——
 *  固定切片会把紧邻的下一个函数也圈进来, 造成误报。 */
function fnBody(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return null;
  let d = 0, j = src.indexOf('{', i);
  if (j < 0) return null;
  for (let k = j; k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') d++;
    else if (ch === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return null;
}


/* ══════════════════════════════════════════════════════════════
   定时清理执行后「执行历史」不自动刷新

   原状: loadScheduleHistory 全项目只在 switchTab('schedule') 里被调一次,
   之后再无任何调用。后台自动触发的任务完成后, 前端零感知 ——
   必须切走再切回 tab 才能看到新记录。
   ══════════════════════════════════════════════════════════════ */

// ── 签名算法: 从 main.js **真源码**里抠出来 eval ──────────────────
//
// 原来这里是手抄一份 main.js 的表达式, 注释还写着"与 main.js 中的实现保持一致"
// —— 纯靠人工同步。把 main.js 那行改成 hist[0].completedAt, 本文件下面三个
// 签名测试仍然全绿。同目录 test_sponsor_reminder.js 已明确记录过"自己重实现
// 导致全绿"这个坑, 此处重犯, 现在改为抠真源码。
//
// 后端 schedule.js 是 history.push() 追加(最新在末尾), 满 100 条后 slice(-100)
// 裁剪(长度不再变化), 所以签名必须取**最后一条**。
const _histBody = fnBody(MAIN, 'async function loadScheduleHistory');
assert.ok(_histBody, 'main.js 里找不到 loadScheduleHistory');
const _sigSrc = /const sig = ([^;]+);/.exec(_histBody);
assert.ok(_sigSrc, 'loadScheduleHistory 里找不到 const sig = ...');
const sigOf = new Function('hist', 'newest', 'return ' + _sigSrc[1] + ';');
// main.js 里 sig 依赖 hist / newest 两个局部变量, 这里按同样形状构造它们:
function sigOfHistory(history) {
  const hist = Array.isArray(history) ? history : [];
  const newest = hist.length ? hist[hist.length - 1] : null;
  return sigOf(hist, newest);
}

test('签名: 新记录 push 到末尾后签名必须变化', () => {
  const before = [{ completedAt: '2026-10-01T00:00:00Z' }];
  const after = [{ completedAt: '2026-10-01T00:00:00Z' }, { completedAt: '2026-10-02T00:00:00Z' }];
  assert.notStrictEqual(sigOfHistory(before), sigOfHistory(after));
});

test('签名: 满 100 条后(长度不再变)追加新记录仍能检测到', () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ completedAt: `2026-10-${String(i % 28 + 1).padStart(2, '0')}T00:00:00Z` }));
  // 裁剪后长度仍是 100, 只有最后一条变了
  const afterTrim = [...full.slice(1), { completedAt: '2026-11-01T00:00:00Z' }];
  assert.strictEqual(full.length, afterTrim.length, '前提: 裁剪后长度不变');
  assert.notStrictEqual(sigOfHistory(full), sigOfHistory(afterTrim), '取 [0] 会漏掉, 取最后一条才能检测');
});

test('签名: 无变化时签名保持一致(轮询跳过重绘)', () => {
  const h = [{ completedAt: 'a' }, { completedAt: 'b' }];
  assert.strictEqual(sigOfHistory(h), sigOfHistory(h));
  assert.strictEqual(sigOfHistory(h), sigOfHistory([...h]));
  assert.strictEqual(sigOfHistory([]), sigOfHistory(null));
  assert.strictEqual(sigOfHistory(undefined), '0|');
});

/* ══════════════════════════════════════════════════════════════
   源码级接线检查
   ══════════════════════════════════════════════════════════════ */

test('源码: switchTab 的 schedule 分支必须启动轮询', () => {
  assert.match(MAIN, /else if\(tabName==='schedule'\)\s*\{[\s\S]{0,400}?startSchedulePolling\(\)/,
    'switchTab("schedule") 里应调用 startSchedulePolling(), 否则停留在该 tab 时执行历史不会自己更新');
});

test('源码: switchTab 开头必须无条件停轮询(切走即停)', () => {
  const head = fnBody(MAIN, 'async function switchTab(tabName)');
  assert.ok(head);
  assert.match(head, /stopSchedulePolling\(\)/,
    'switchTab 开头应先 stopSchedulePolling(); 放在函数最前而不是各分支里, 免得新增 tab 漏停');
});

test('源码: 轮询必须调用 loadScheduleStatus 而不是 loadSchedule', () => {
  const body = fnBody(MAIN, 'function startSchedulePolling()');
  assert.ok(body, '应有 startSchedulePolling');
  assert.match(body, /loadScheduleStatus\(\)/, '轮询应调 loadScheduleStatus');
  assert.ok(!/setInterval[\s\S]{0,200}?loadSchedule\(\)/.test(body),
    '轮询里不能直接调 loadSchedule(): 它会重置 scheduleHour/scheduleMinute 和各 checkbox, ' +
    '把用户正在编辑的配置冲掉');
});

test('源码: loadScheduleStatus 只更新只读字段, 不碰表单控件', () => {
  const body = fnBody(MAIN, 'async function loadScheduleStatus()');
  assert.ok(body);
  for (const id of ['#scheduleStatus', '#scheduleNext', '#scheduleRunCount', '#scheduleLastRun']) {
    assert.ok(body.includes(id), `loadScheduleStatus 应更新 ${id}`);
  }
  for (const id of ['scheduleHour', 'scheduleMinute', 'scheduleEnabled', 'scApp', 'scDocker', 'scTemp', 'scTrash']) {
    assert.ok(!body.includes(id), `loadScheduleStatus 不应触碰 ${id} —— 那是表单控件, 轮询会冲掉用户输入`);
  }
});

test('源码: 历史签名必须取最后一条而非 [0]', () => {
  const body = fnBody(MAIN, 'async function loadScheduleHistory');
  assert.ok(body);
  assert.match(body, /hist\[hist\.length\s*-\s*1\]/,
    '签名应取 hist[hist.length-1] (最新)。后端是 history.push(), [0] 是最旧且恒定不变');
  assert.ok(!/history\[0\]\.completedAt/.test(body),
    '不能取 history[0].completedAt —— 满 100 条 slice(-100) 后长度也不变, 会彻底检测不到新记录');
});

test('源码: triggerSchedule 必须在多个时间点强刷历史', () => {
  const body = fnBody(MAIN, 'async function triggerSchedule()');
  assert.ok(body);
  assert.match(body, /loadScheduleHistory\(true\)/,
    '手动触发后应强制刷新历史(任务在后台跑, 跑完才追加记录)');
  assert.match(body, /_lastHistorySig\s*=\s*null/,
    '触发后必须先清空 _lastHistorySig: 否则旧签名还在, force 只加在后面的定时器里, ' +
    '第一次立即刷新仍会被签名比对跳过');
  assert.ok(/setTimeout/.test(body), '应有多次延时刷新以覆盖任务结束时刻');
  // 第一次刷新必须紧跟在触发之后, 不能只挂在延时器里。
  // 注意先剥掉注释再找 setTimeout —— 函数注释里就写着「原先只有 setTimeout(loadSchedule, 2000)」,
  // 不剥注释会拿注释里的字样当代码, 断言结果毫无意义(注释污染测试的老坑)。
  const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const firstForce = codeOnly.indexOf('loadScheduleHistory(true)');
  const firstTimer = codeOnly.indexOf('setTimeout');
  assert.ok(firstTimer === -1 || firstForce < firstTimer,
    '首次 loadScheduleHistory(true) 应在 setTimeout 之前 —— 任务刚触发时历史可能已有"执行中"记录');
  assert.ok(!/setTimeout\(loadSchedule,\s*2000\)\s*;?\s*\}\s*else/.test(body),
    '原先只有 setTimeout(loadSchedule,2000) 且不带 force, 历史签名未变会被跳过');
});

test('源码: 切 tab 时历史要用 force 强刷', () => {
  const i = MAIN.indexOf("else if(tabName==='schedule')");
  assert.ok(i > 0);
  const body = MAIN.slice(i, i + 400);   // switchTab 分支, 无嵌套函数, 固定窗口可用
  assert.match(body, /loadScheduleHistory\(true\)/,
    '切进 schedule 应 force 刷新 —— 离开期间后端可能已追加记录, 签名比对会误判为"无变化"');
  assert.match(body, /_lastHistorySig\s*=\s*null/,
    '切进 schedule 应先清空 _lastHistorySig');
});

/* ══════════════════════════════════════════════════════════════
   与后端的契约
   ══════════════════════════════════════════════════════════════ */

test('契约: 后端 GET /api/schedule 返回 lastRun/runCount/nextRun(轮询依赖)', () => {
  const i = SCHED_API.indexOf('export async function handleSchedule');
  assert.ok(i > 0);
  const body = SCHED_API.slice(i, i + 1200);
  for (const k of ['lastRun', 'runCount', 'nextRun', 'enabled']) {
    assert.ok(body.includes(k), `GET /api/schedule 应返回 ${k}`);
  }
});

test('契约: 后端执行完成后会写 history 且最新在末尾', () => {
  assert.match(SCHED_API, /history\.push\(summary\)/,
    'logRunHistory 应 push, 新记录在数组末尾');
  assert.match(SCHED_API, /history\.slice\(-100\)/,
    '应保留最近 100 条(说明 length 会在满后不再变化, 签名不能只依赖 length)');
  // logRunHistory 必须在 lastRun/runCount 更新之后被调用
  const lc = SCHED_API.indexOf('config.lastRun = completedAt');
  const lh = SCHED_API.indexOf('logRunHistory(report);');
  assert.ok(lc > 0 && lh > lc, 'logRunHistory 应在状态落盘之后调用');
});

test('契约: 后端任务完成后重排下一次(setTimeout 链能持续运行)', () => {
  assert.match(SCHED_API, /scheduleNext\(\)\s*;?\s*\}\s*finally/,
    'executeCleanup 末尾应调用 scheduleNext(), 否则只跑一次');
});
