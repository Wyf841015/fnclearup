// 导航分组回归测试 (2026-10-02)
//
// 背景: 15 个 tab 平铺一行, 移动端必须横向滚动才能看全功能, 且排列按开发
// 时间堆砌而非用户心智。方案 A 的改造是「只改导航层」——
// tab / panel / 业务逻辑一律未动, 只在外层套 4 组(清理回收/查找问题/空间分析/自动化)。
//
// 这里锁住三件事, 防止后续改动把分组悄悄破坏:
//   1) 结构完整性: 4 组 / 15 个 tab / 15 个 panel, 且每个 tab 恰好归属一个组
//   2) 每个 tab 都有对应 panel (分组改造最容易漏掉某个 panel)
//   3) main.js 的 TAB_GROUPS 与 index.html 的 data-group-list 声明一致
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'main.js'), 'utf8');

// 方案 B 合并后: dockercleanup 已并入 docker tab 的「容器 / 缓存」两个分区,
// tab 总数 15 → 14。这个数字变化是预期内的, 由本文件同步锁住。
const EXPECTED = {
  clean: ['app', 'disk', 'docker', 'temp', 'sysclean', 'trash'],
  find:  ['dup', 'simdup', 'broken', 'namematch'],
  space: ['diskanalysis', 'bigfiles', 'empty'],
  auto:  ['schedule'],
};

// ── 从 HTML 解析各组的 tab ──
function parseGroupTabs() {
  const out = {};
  const re = /<div class="tab-list[^"]*" data-group-list="(\w+)"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const gid = m[1];
    out[gid] = [...m[2].matchAll(/data-tab="(\w+)"/g)].map(x => x[1]);
  }
  return out;
}

test('导航分组: 4 组容器存在, 且 tab 归属与设计一致', () => {
  const actual = parseGroupTabs();
  const gids = Object.keys(actual).sort();
  assert.deepStrictEqual(gids, Object.keys(EXPECTED).sort(),
    `分组容器与设计不符: 实际 ${gids}`);
  for (const [gid, tabs] of Object.entries(EXPECTED)) {
    assert.deepStrictEqual(actual[gid], tabs,
      `分组 ${gid} 的 tab 列表不符\n  期望: ${tabs}\n  实际: ${actual[gid]}`);
  }
});

test('导航分组: 14 个 tab 无遗漏无重复(原 15, dockercleanup 已并入 docker)', () => {
  const all = Object.values(parseGroupTabs()).flat();
  assert.strictEqual(all.length, 14, `应恰好 15 个 tab, 实际 ${all.length}: ${all}`);
  assert.strictEqual(new Set(all).size, 14, `tab 有重复: ${all}`);
  // 每个 tab 都有对应 panel
  const panels = [...html.matchAll(/data-panel="(\w+)"/g)].map(x => x[1]);
  const missing = all.filter(t => !panels.includes(t));
  assert.strictEqual(missing.length, 0, `这些 tab 没有对应 panel: ${missing}`);
  assert.strictEqual(panels.length, 14, `panel 应为 15 个, 实际 ${panels.length}`);
});

test('导航分组: 每组只默认展开一个, 且恰好一个组有 active', () => {
  const lists = [...html.matchAll(/<div class="(tab-list[^"]*)" data-group-list="(\w+)"/g)];
  const active = lists.filter(x => /\bactive\b/.test(x[1]));
  assert.strictEqual(active.length, 1,
    `应有且仅有 1 个 tab-list 带 active, 实际 ${active.length}: ${lists.map(x => x[2] + '=' + x[1])}`);
  assert.strictEqual(active[0][2], 'clean', '默认展开的应为第一组 clean');

  const groups = [...html.matchAll(/<button[^>]*class="(group-btn[^"]*)" data-group="(\w+)"/g)];
  assert.strictEqual(groups.length, 4, `组按钮应为 4 个, 实际 ${groups.length}`);
  const gActive = groups.filter(x => /\bactive\b/.test(x[1]));
  assert.strictEqual(gActive.length, 1, `组按钮应有且仅有 1 个 active, 实际 ${gActive.length}`);
  assert.strictEqual(gActive[0][2], 'clean', '默认激活的组按钮应为 clean');
});

test('导航分组: main.js 的 TAB_GROUPS 与 HTML 分组一致', () => {
  const i = main.indexOf('const TAB_GROUPS');
  assert.ok(i > 0, 'main.js 未找到 TAB_GROUPS —— 分组逻辑丢失');
  const body = main.slice(i, main.indexOf('};', i));
  for (const [gid, tabs] of Object.entries(EXPECTED)) {
    const m = body.match(new RegExp(`${gid}:\\s*\\[([^\\]]*)\\]`));
    assert.ok(m, `TAB_GROUPS 缺少分组 ${gid}`);
    const parsed = [...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]);
    assert.deepStrictEqual(parsed, tabs, `TAB_GROUPS.${gid} 与设计不符: ${parsed}`);
  }
  // 每个 tab 必须恰好属于一个组(漏一个 → 点不到; 重复 → 记忆会串)
  const all = [...body.matchAll(/'(\w+)'/g)].map(x => x[1]);
  assert.strictEqual(all.length, 14, `TAB_GROUPS 应含 15 个 tab, 实际 ${all.length}`);
  assert.strictEqual(new Set(all).size, 14, `TAB_GROUPS 有重复 tab`);
});

test('导航分组: switchGroup 已导出(否则 inline onclick 静默失效)', () => {
  // 项目约定: 依赖 inline onclick 的函数必须进 const exports 块, 不能只 window.X =
  assert.ok(/const exports = \{[\s\S]*?switchGroup/.test(main),
    'switchGroup 不在 exports 块内 → onclick="switchGroup(...)" 会 ReferenceError 静默失效');
  // 本次事故的同类防线: 插入代码时曾把 `async function switchTab` 的 async
  // 落成悬空标识符(后面直接跟 const 声明)。async 本身是合法标识符名, 所以
  // node --check 抓不到, 只会在运行时炸。合法用法有三种, 都要排除:
  //   async function … / async (…) => / 对象方法 async name(…)
  // 这里用负向断言精确匹配, 不能用 split('async').length —— 那种数法把
  // 上面三种合法用法也算成"悬空", 测试本身就成了误报源。
  const dangling = [...main.matchAll(/\basync\b(?!\s*(function|\(|[\w$]+\s*\())/g)];
  assert.strictEqual(dangling.length, 0,
    `存在悬空的 async 标识符(插入代码时截断了 async function), 共 ${dangling.length} 处` +
    (dangling[0]
      ? `, 首处在第 ${main.slice(0, dangling[0].index).split('\n').length} 行: ` +
        JSON.stringify(main.slice(dangling[0].index - 40, dangling[0].index + 40))
      : ''));
});

test('导航分组: 组按钮都绑定了 onclick', () => {
  const groups = [...html.matchAll(/<button[^>]*data-group="(\w+)"([^>]*)>/g)];
  assert.strictEqual(groups.length, 4);
  for (const [_, gid, attrs] of groups) {
    assert.ok(/onclick="switchGroup\('/.test(attrs),
      `组按钮 ${gid} 未绑定 onclick`);
  }
  const tabs = [...html.matchAll(/<button[^>]*data-tab="(\w+)"([^>]*)>/g)];
  assert.strictEqual(tabs.length, 14);
  for (const [_, tid, attrs] of tabs) {
    assert.ok(/onclick="switchTab\('/.test(attrs), `tab 按钮 ${tid} 未绑定 onclick`);
  }
});

test('响应式: 分组容器用 flex-wrap 而非 max-width 媒体查询', () => {
  // fnOS 移动 WebView 常以桌面 UA + 980 viewport 渲染, max-width 断点根本不触发。
  // 分组按钮必须靠 flex-wrap 自适应, 断点写法在这里等于没写。
  const css = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'styles', 'style.css'), 'utf8');
  const m = css.match(/\.tab-groups\{([^}]*)\}/);
  assert.ok(m, '未找到 .tab-groups 规则');
  assert.ok(/flex-wrap:wrap/.test(m[1]),
    '.tab-groups 必须用 flex-wrap:wrap, 不能靠媒体查询');
  assert.ok(/\.tab-list\{[^}]*display:none/.test(css) && /\.tab-list\.active\{display:flex\}/.test(css),
    '非当前组的 tab-list 必须隐藏, 当前组显示为 flex');
});
// ── 方案 B-1: Docker + Docker 清理 合并 ──
test('Docker 合并: 单 tab 内含 镜像/容器/卷/网络/缓存 五个二级分区', () => {
  const inners = [...html.matchAll(/data-inner-tab="(\w+)"/g)].map(x => x[1]);
  assert.deepStrictEqual(inners, ['images', 'containers', 'volumes', 'networks', 'cache'],
    `Docker 二级分区不符: ${inners}`);
  // 每个分区按钮都要有对应的 panel, 否则切过去是空白
  for (const it of inners) {
    assert.ok(html.includes(`data-inner-panel="${it}"`),
      `分区 ${it} 有按钮但没有对应 inner-panel`);
  }
});

test('Docker 合并: dockercleanup tab 与 panel 已彻底移除', () => {
  assert.ok(!html.includes('data-tab="dockercleanup"'), '导航里还残留 dockercleanup 按钮');
  assert.ok(!html.includes('data-panel="dockercleanup"'), '还残留 dockercleanup panel');
  assert.ok(!html.includes('id="dockercleanup-main"'), 'dockercleanup-main 包裹层未删除');
  // 不可用提示卡保留(docker 不可达时仍要提示), 但归到 docker panel
  assert.strictEqual(html.split('id="dockercleanup-unavailable"').length - 1, 1,
    'Docker 不可用提示卡应保留且只有一处');
  // dc-* 的功能 id 必须都在(只是换了位置)
  for (const id of ['dc-stopped-count', 'dc-stopped-size', 'dc-stopped-list', 'dcScanBtn',
                    'dcRemoveBtn', 'dcDryRun', 'dc-cache-total', 'dc-cache-reclaim',
                    'dc-cache-status', 'dcPruneBtn']) {
    assert.ok(html.includes(`id="${id}"`), `合并后丢了 ${id}`);
  }
});

test('Docker 合并: main.js 侧 dockercleanup 仅保留兼容别名', () => {
  // switchTab('dockercleanup') 必须重定向到 docker, 否则旧入口静默失效
  assert.ok(/tabName===\x27dockercleanup\x27[\s\S]{0,120}switchTab\(\x27docker\x27\)/.test(main),
    "switchTab('dockercleanup') 未重定向到 docker");
  // dcCheckAvailable 不能再引用已删除的包裹层
  const i = main.indexOf('async function dcCheckAvailable');
  const body = main.slice(i, i + 1800);
  assert.ok(!/\$\(\x27dockercleanup-main\x27\)/.test(body),
    'dcCheckAvailable 仍在引用已删除的 dockercleanup-main');
  // containers / cache 分区要能触发 Docker 可用性检查
  const j = main.indexOf('function switchInnerTab');
  const sw = main.slice(j, j + 700);
  assert.ok(/tabName===\x27containers\x27/.test(sw) && /tabName===\x27cache\x27/.test(sw),
    'switchInnerTab 未处理 containers / cache 分区');
});
