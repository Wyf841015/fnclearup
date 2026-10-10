// 容器 / 系统缓存 分区切进来就自动扫描 —— 2026-10-10
//
// 用户反馈"切换到面板后应该自动扫描, 而不是每次都需要手动点击扫描"。
//
// 两个接口的实测耗时差了 100 倍, 所以策略必须不同(实测数据写在注释里,
// 别凭直觉给两者套同一个策略):
//   api/docker/stopped   0.1s   → 每次切换都扫, 代价可忽略
//   api/sysclean/scan  3.8~16s  → 只能限流, 否则来回切 tab 每次都要等十几秒
//
// 另外防了两件事: 自动扫描与用户手点撞车(两个响应同时渲染同一列表, 后到的
// 覆盖先到的, 用户看到随机一份数据)。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'app/ui/main.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const js = strip(src);

// 把 main.js 里的函数抠出来真跑 —— 静态断言只能确认"调用了这个名字",
// 查不出 dcAutoScan 到底调了什么、限流判断写没写对。
function fnSrc(name) {
  // RegExp#exec 返回的是 match 数组(有 .index/.input, 没有 .start()/.end) ——
  // 写成 m.start() 会报 "m.start is not a function", 这里用 .index + m[0].length。
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(js);
  if (!m) return null;
  const start = m.index;
  let i = js.indexOf('{', start + m[0].length), d = 0;
  for (let x = i; x < js.length; x++) {
    if (js[x] === '{') d++;
    else if (js[x] === '}') { d--; if (d === 0) return js.slice(start, x + 1); }
  }
  return null;
}

test('switchInnerTab: containers 分区走 dcAutoScan (不是只探测)', () => {
  const s = fnSrc('switchInnerTab');
  assert.match(s, /tabName==='containers'\)\s*\{\s*dcAutoScan\(\);\s*\}/,
    '★ 切到容器分区必须调 dcAutoScan(), 不能只是 dcCheckAvailable() —— ' +
    '后者只探测可用性不拉列表, 用户看到的还是空列表');
  assert.match(s, /tabName==='cache'\)\s*\{\s*dcCheckAvailable\(\);\s*\}/,
    '缓存分区只读 KPI 卡片, dcCheckAvailable() 已经填好, 不必再拉一次列表');
});

test('switchInnerTab: syscache 分区走 sysCleanAutoScan', () => {
  const s = fnSrc('switchInnerTab');
  assert.match(s, /tabName==='syscache'\)\s*\{\s*sysCleanAutoScan\(\);\s*\}/,
    '★ 系统缓存分区必须自动扫描');
});

test('switchInnerTab: 其它分区的原有惰性加载没被改坏', () => {
  const s = fnSrc('switchInnerTab');
  // 这几个是先前就有的行为, 改 containers/cache/syscache 时不能误伤
  assert.match(s, /tabName==='images'&&\s*!App\.dockerImagesLoaded/);
  assert.match(s, /tabName==='volumes'&&\s*!App\.dockerVolumesLoaded/);
  assert.match(s, /tabName==='networks'&&\s*!App\.dockerNetworksLoaded/);
  assert.match(s, /tabName==='tmpfiles'&&\s*!App\.tempScanned/);
  assert.match(s, /tabName==='emptydirs'\)/);
});

test('dcAutoScan: 探测不可用时不扫', async () => {
  // Docker 没起来时 dcCheckAvailable 会把入口藏起来并退回镜像分区, 这时不该
  // 再去打 api/docker/stopped —— 那必然失败, 只会往状态栏写一个 ❌。
  const calls = [];
  const fake = new Function('dcCheckAvailable', 'dcScan', 'console',
    fnSrc('dcAutoScan').replace(/\/\/.*$/gm, '') + '\nreturn dcAutoScan;')
    (async () => ({ available: false, stopped: { available: false } }),
     async (p) => { calls.push(p); }, console);
  await fake();
  assert.deepStrictEqual(calls, [], 'Docker 不可用时不应调 dcScan');
});

test('dcAutoScan: 可用时把探测结果复用, 不重复打同一个接口', async () => {
  // dcCheckAvailable 已经拿到了 stopped 数据, 传给 dcScan 复用。
  // 否则切一次容器分区要发三个请求(probe stopped / probe cache / scan stopped)。
  let passed = null;
  const probe = { available: true, daemon: true, stopped: { available: true, containers: [1, 2] }, cache: {} };
  const fake = new Function('dcCheckAvailable', 'dcScan', 'console',
    fnSrc('dcAutoScan').replace(/\/\/.*$/gm, '') + '\nreturn dcAutoScan;')
    (async () => probe, async (p) => { passed = p; }, console);
  await fake();
  assert.ok(passed, '可用时应调 dcScan');
  assert.strictEqual(passed, probe, '★ 应把探测结果原样传给 dcScan 复用');
});

test('sysCleanAutoScan: 60 秒内不重复扫(接口要 3.8~16s)', async () => {
  // 用例设计要点: 必须让兜底路径(无条件扫)选出与期望不同的答案, 否则
  // "没写限流但用例恰好通过"这种假阳性抓不到。
  const calls = [];
  const st = { scanLoaded: true };
  const fake = new Function('SysCleanState', '_sysCleanScanning', '_sysCleanScannedAt', 'Date', 'doSysCleanScan',
    fnSrc('sysCleanAutoScan').replace(/\/\/.*$/gm, '') + '\nreturn sysCleanAutoScan;')
    (st, false, Date.now() - 5000, { now: () => Date.now() }, async () => { calls.push(1); });
  await fake();
  assert.deepStrictEqual(calls, [], '★ 60 秒内切走再切回来, 不该重新扫(会白等 4~16s)');

  // 超过 60 秒 → 应该扫
  const calls2 = [];
  const st2 = { scanLoaded: true };
  const fake2 = new Function('SysCleanState', '_sysCleanScanning', '_sysCleanScannedAt', 'Date', 'doSysCleanScan',
    fnSrc('sysCleanAutoScan').replace(/\/\/.*$/gm, '') + '\nreturn sysCleanAutoScan;')
    (st2, false, Date.now() - 61000, { now: () => Date.now() }, async () => { calls2.push(1); });
  await fake2();
  assert.strictEqual(calls2.length, 1, '★ 超过 60 秒应该重新扫');

  // 从没扫过 → 应该扫(这是最常见路径: 用户第一次点进这个分区)
  const calls3 = [];
  const fake3 = new Function('SysCleanState', '_sysCleanScanning', '_sysCleanScannedAt', 'Date', 'doSysCleanScan',
    fnSrc('sysCleanAutoScan').replace(/\/\/.*$/gm, '') + '\nreturn sysCleanAutoScan;')
    ({ scanLoaded: false }, false, 0, { now: () => Date.now() }, async () => { calls3.push(1); });
  await fake3();
  assert.strictEqual(calls3.length, 1, '★ 首次进入必须自动扫 —— 这正是用户要的');
});

test('sysCleanAutoScan: 正在扫时不重复触发', async () => {
  const calls = [];
  const fake = new Function('SysCleanState', '_sysCleanScanning', '_sysCleanScannedAt', 'Date', 'doSysCleanScan',
    fnSrc('sysCleanAutoScan').replace(/\/\/.*$/gm, '') + '\nreturn sysCleanAutoScan;')
    ({ scanLoaded: false }, true, 0, { now: () => Date.now() }, async () => { calls.push(1); });
  await fake();
  assert.deepStrictEqual(calls, [], '扫描中应直接返回');
});

test('doSysCleanScan 自身也有防重入(不只靠调用方)', async () => {
  // 只在调用方加锁是不够的: 用户手动点「扫描缓存」按钮这条路径不经过
  // sysCleanAutoScan, 照样会和自动扫描撞车。
  assert.match(js, /if \(_sysCleanScanning\) return;/);
  assert.match(js, /_sysCleanScanning = false;[\s\S]{0,200}finally|finally[\s\S]{0,200}_sysCleanScanning = false;/,
    '★ 必须在 finally 里复位, 否则一次失败后这个分区永远扫不了了');
  assert.match(js, /_sysCleanScannedAt = Date\.now\(\);/, '成功后要记时间, 限流才有依据');
});

test('dcScan 也防重入, 且支持复用预载数据', () => {
  assert.match(js, /async function dcScan\(preloaded\)/, '应接受预载数据参数');
  assert.match(js, /if \(_dcScanning\) return;/);
  assert.match(js, /preloaded && preloaded\.available \? preloaded : await API\.get/,
    '★ 有预载就用预载, 没有才自己拉');
  // 删除容器后要刷新列表, 那里调的是无参 dcScan() —— 不能被"正在扫"标记卡住
  assert.match(js, /if \(!dryRun && deleted > 0\) await dcScan\(\);/);
});

test('缓存分区空状态的提示不再指向不存在的按钮', () => {
  // 这个分区只有 dcPruneCache 按钮, 没有「扫描」按钮。原来写"点击「扫描」按钮
  // 获取详情", 用户在这个分区找不到那个按钮, 只会干等着。
  assert.ok(!/点击「扫描」按钮获取详情/.test(js),
    '★ 缓存分区没有扫描按钮, 提示语必须换掉');
  assert.match(js, /Docker daemon 未响应，无法读取构建缓存/);
});

test('api/sysclean/scan 的超时从默认 15s 提到 90s', () => {
  // 自动扫描暴露出来的既有 bug: API.get 默认超时 15s, 而这个接口要 stat 上千个
  // 缓存目录, 实测首次 16s / 缓存后 3.7~4.2s —— 慢的那一半必然超时。
  // 手动点扫描同样会超时, 用户只会当成自己网络问题。
  assert.match(js, /API\.get\('api\/sysclean\/scan',\s*90000\)/,
    '★ 必须显式传超时, 否则自动扫描在慢机器上必然报 aborted');
});

test('超时数字不是随手写的: 要明显大于实测最坏值', () => {
  const m = /API\.get\('api\/sysclean\/scan',\s*(\d+)\)/.exec(js);
  assert.ok(m, '应能找到超时参数');
  // 实测最坏 16s。留 5 倍余量, 又不能大到能掩盖真正的挂死。
  assert.ok(Number(m[1]) >= 80000,
    '超时 ' + m[1] + 'ms 太小 —— 实测最坏 16s, 至少要 80s');
  assert.ok(Number(m[1]) <= 180000,
    '超时 ' + m[1] + 'ms 太大 —— 挂死时要等这么久用户会以为应用死了');
});

test('其它接口没被顺手改成大超时', () => {
  // 只有 sysclean/scan 需要特殊处理。别把全局默认调大, 那会让所有接口的
  // 失败都变慢 —— 15s 默认值对 docker 这类 0.1s 的接口是合适的。
  assert.match(js, /async get\(path,\s*timeoutMs\s*=\s*15000\)/,
    '★ API.get 的默认超时应保持 15s, 只在具体调用点按需覆盖');
});
