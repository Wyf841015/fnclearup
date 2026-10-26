// 导航分组回归测试 (2026-10-02)
//
// 背景: 15 个 tab 平铺一行, 移动端必须横向滚动才能看全功能, 且排列按开发
// 时间堆砌而非用户心智。方案 A 的改造是「只改导航层」——
// tab / panel / 业务逻辑一律未动, 只在外层套 4 组(清理回收/文件清理/空间分析/定时清理)。
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
// 方案 B 合并后的最终形态: tab 15 → 12
//   B-1: dockercleanup 并入 docker tab(容器/缓存分区)      -1
//   B-2: sysclean + temp + trash 并入「系统垃圾」单 tab      -2
const EXPECTED = {
  clean: ['app', 'disk', 'docker', 'sysjunk', 'users', 'kernel'],
  find:  ['scan'],
  space: ['diskanalysis'],
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

test('导航分组: 9 个 tab 无遗漏无重复(原 15 经三轮合并 + 用户清理 + 内核清理)', () => {
  const all = Object.values(parseGroupTabs()).flat();
  assert.strictEqual(all.length, 9, `应恰好 9 个 tab, 实际 ${all.length}: ${all}`);
  assert.strictEqual(new Set(all).size, 9, `tab 有重复: ${all}`);
  // 每个 tab 都有对应 panel
  const panels = [...html.matchAll(/data-panel="(\w+)"/g)].map(x => x[1]);
  const missing = all.filter(t => !panels.includes(t));
  assert.strictEqual(missing.length, 0, `这些 tab 没有对应 panel: ${missing}`);
  assert.strictEqual(panels.length, 9, `panel 应为 9 个, 实际 ${panels.length}`);
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
  assert.strictEqual(all.length, 9, `TAB_GROUPS 应含 9 个 tab, 实际 ${all.length}`);
  assert.strictEqual(new Set(all).size, 9, `TAB_GROUPS 有重复 tab`);
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
  assert.strictEqual(tabs.length, 9);
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
// 只取 docker panel 内部的那一组 —— 方案 B-2 后系统垃圾也带 inner-tab,
// 全局匹配会把两组的 8 个分区混在一起
function innerTabsOf(panelId) {
  const a = html.indexOf(`data-panel="${panelId}"`);
  assert.ok(a > 0, `找不到 panel ${panelId}`);
  const na = html.indexOf('data-panel="', a + 1);
  const seg = html.slice(a, na > 0 ? na : html.length);
  return [...seg.matchAll(/data-inner-tab="(\w+)"/g)].map(x => x[1]);
}

test('Docker 合并: 单 tab 内含 镜像/容器/卷/网络/缓存 五个二级分区', () => {
  const inners = innerTabsOf('docker');
  assert.deepStrictEqual(inners, ['images', 'containers', 'volumes', 'networks', 'cache'],
    `Docker 二级分区不符: ${inners}`);
  // 每个分区按钮都要有对应的 panel, 否则切过去是空白
  for (const it of inners) {
    const a = html.indexOf('data-panel="docker"');
    const na = html.indexOf('data-panel="', a + 1);
    const seg = html.slice(a, na > 0 ? na : html.length);
    assert.ok(seg.includes(`data-inner-panel="${it}"`),
      `分区 ${it} 有按钮但没有对应 inner-panel`);
  }
});

test('两组 inner-tab 各自完整且互不重叠', () => {
  const docker = innerTabsOf('docker');
  const sysjunk = innerTabsOf('sysjunk');
  assert.deepStrictEqual(sysjunk, ['syscache', 'tmpfiles', 'recycle'],
    `系统垃圾二级分区不符: ${sysjunk}`);
  const scan = innerTabsOf('scan');
  assert.deepStrictEqual(scan, ['duplicates', 'similar', 'broken', 'samename', 'emptydirs', 'largefiles'],
    `文件体检二级分区不符: ${scan}`);
  const all = [...docker, ...sysjunk, ...scan];
  const overlap = all.filter((x, i) => all.indexOf(x) !== i);
  assert.strictEqual(overlap.length, 0,
    `多组 inner-tab 出现同名分区, switchInnerTab 的作用域修复会失效: ${overlap}`);
  assert.strictEqual(new Set(all).size, 14, '二级分区名应有 14 个且互不相同');
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
  const sw = main.slice(j, main.indexOf('\n}', j));
  assert.ok(/tabName===\x27containers\x27/.test(sw) && /tabName===\x27cache\x27/.test(sw),
    'switchInnerTab 未处理 containers / cache 分区');
});

// ── 方案 B-2: 系统 + 临时文件 + 回收站 合并为「系统垃圾」 ──
test('系统垃圾合并: 单 tab 内含 系统缓存/临时文件/回收站 三个二级分区', () => {
  assert.ok(html.includes('data-panel="sysjunk"'), '缺少 sysjunk panel');
  for (const [inner, panel] of [['syscache', 'syscache'], ['tmpfiles', 'tmpfiles'], ['recycle', 'recycle']]) {
    assert.ok(html.includes(`data-inner-tab="${inner}"`), `缺少二级按钮 ${inner}`);
    assert.ok(html.includes(`data-inner-panel="${panel}"`), `缺少 inner-panel ${panel}`);
  }
  // 旧 tab 与 panel 都应消失
  for (const gone of ['sysclean', 'temp', 'trash']) {
    assert.ok(!html.includes(`data-panel="${gone}"`), `旧 panel ${gone} 未移除`);
    assert.ok(!html.includes(`data-tab="${gone}"`), `旧导航 ${gone} 未移除`);
  }
});

test('系统垃圾合并: 三个分区的功能元素全部保留', () => {
  const must = [
    // 系统缓存
    'syscleanScanBtn', 'syscleanBackupCb', 'sysclean-list', 'sysclean-empty',
    // 临时文件
    'temp-dirs-count', 'temp-files-count', 'temp-total-size', 'deleteTempBtn', 'temp-list',
    // 回收站
    'trashKpi30', 'trashKpi90', 'trashKpi365', 'trashKpiTotal', 'trashKpiTopDirs',
    'trashScanBtn', 'trashCleanAllBtn', 'trashBrowseBtn', 'trash-list',
  ];
  for (const id of must) {
    assert.strictEqual(html.split(`id="${id}"`).length - 1, 1,
      `${id} 缺失或重复(合并后应恰好一处)`);
  }
});

test('系统垃圾合并: 内层不得残留 hidden(会让分区永远不可见)', () => {
  // 原 trash panel 靠 [hidden] 隐藏, 靠 .tab-panel.active 覆盖显示。
  // 搬进 inner-panel 后若仍带 hidden, 特异度不再有 .tab-panel.active 兜底 → 永远看不见。
  const i = html.indexOf('data-inner-panel="recycle"');
  assert.ok(i > 0, '找不到 recycle 分区');
  const seg = html.slice(i, html.indexOf('</div>\n        </div>', i) + 20);
  assert.ok(!/\bhidden\b/.test(seg), 'recycle 分区内仍残留 hidden 属性');
  // 且不得出现嵌套 tab-panel
  assert.ok(!seg.includes('class="tab-panel'), 'recycle 分区内嵌套了 tab-panel');
});

test('两组 inner-tab 互不干扰: switchInnerTab 已限定作用域', () => {
  // 这是合并引入的真实回归点: 现在有两个 panel 各带一组 inner-tab
  // (docker 5 个 + 系统垃圾 3 个), 早先用全局 querySelectorAll 会互相抹掉。
  const j = main.indexOf('function switchInnerTab');
  assert.ok(j > 0, '找不到 switchInnerTab');
  const body = main.slice(j, main.indexOf('\n}', j));
  assert.ok(/\.tab-panel\.active/.test(body) && /scope\.querySelectorAll/.test(body),
    'switchInnerTab 必须把 inner-tab / inner-panel 查询限定在当前激活的 tab-panel 内');
  assert.ok(!/document\.querySelectorAll\('\.inner-tab-btn'\)/.test(body),
    'switchInnerTab 仍在全局查询 inner-tab —— 会与另一组互相干扰');
});

test('系统垃圾合并: main.js 保留旧 tab 名的兼容别名', () => {
  const i = main.indexOf('async function switchTab');
  const body = main.slice(i, main.indexOf('\n// ═', i));
  for (const alias of ['sysclean', 'trash', 'temp']) {
    assert.ok(body.includes(`tabName===\x27${alias}\x27`) ||
              new RegExp(`tabName==='${alias}'`).test(body),
      `switchTab 缺少 ${alias} 的兼容别名 —— 旧书签会失效`);
  }
  assert.ok(body.includes("switchTab('sysjunk')"), '旧 tab 名未重定向到 sysjunk');
  // 临时文件的懒加载逻辑要从 switchTab 搬到 switchInnerTab('tmpfiles')
  //
  // 用花括号配对取**完整**函数体, 不要 slice(k, k+1400) 写死窗口 ——
  // switchInnerTab 每加一个分区就长几行, 固定窗口迟早把后面的分支切掉,
  // 表现为"功能好好的但测试报未挂载"。2026-10-10 就这么踩了一次:
  // 容器/系统缓存两个新分区把函数撑长, tmpfiles 落到窗口外, 假失败一次。
  const k = main.indexOf('function switchInnerTab');
  assert.ok(k > 0, '应能找到 switchInnerTab');
  let depth = 0, sw = '';
  for (let x = main.indexOf('{', k); x < main.length; x++) {
    const ch = main[x];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; sw += ch; if (depth === 0) break; continue; }
    sw += ch;
  }
  assert.ok(depth === 0, 'switchInnerTab 的花括号应配平');
  assert.ok(/tabName==='tmpfiles'/.test(sw) && /App\.tempScanned/.test(sw),
    "临时文件的懒加载扫描未挂到 switchInnerTab('tmpfiles')");
  // 同理检查另外几个惰性加载分区也在里面
  for (const [part, flag] of [['images','dockerImagesLoaded'],['volumes','dockerVolumesLoaded'],
                              ['networks','dockerNetworksLoaded'],['tmpfiles','tempScanned']]) {
    assert.ok(new RegExp("tabName==='" + part + "'").test(sw) && sw.includes(flag),
      part + ' 分区的懒加载标记 ' + flag + ' 不在 switchInnerTab 里');
  }
});

// ── 方案 B-3: 六个扫描型合并为「文件体检」 ──
test('文件体检合并: 单 tab 内含 六个扫描分区', () => {
  assert.ok(html.includes('data-panel="scan"'), '缺少 scan panel');
  assert.ok(html.includes('data-tab="scan"'), '导航缺少 scan');
  for (const inner of ['duplicates', 'similar', 'broken', 'samename', 'emptydirs', 'largefiles']) {
    assert.ok(html.includes(`data-inner-tab="${inner}"`), `缺少二级按钮 ${inner}`);
    assert.ok(html.includes(`data-inner-panel="${inner}"`), `缺少 inner-panel ${inner}`);
  }
  for (const gone of ['dup', 'simdup', 'broken', 'namematch', 'empty', 'bigfiles']) {
    assert.ok(!html.includes(`data-panel="${gone}"`), `旧 panel ${gone} 未移除`);
    assert.ok(!html.includes(`data-tab="${gone}"`), `旧导航 ${gone} 未移除`);
  }
});

test('文件体检合并: 六个分区的功能元素全部保留且唯一', () => {
  const must = {
    duplicates: ['musicScanBtn', 'filesScanBtn', 'musicPathList', 'filesPathList'],
    similar:    ['simdupBtn', 'simdupPathList', 'simdup-total', 'simdup-threshold'],
    broken:     ['brokenBtn', 'brokenPathList', 'broken-total', 'broken-links'],
    samename:   ['nmBtn', 'namePathList', 'name-groups', 'name-files'],
    emptydirs:  ['emptyScanBtn', 'emptyPath', 'empty-count', 'empty-list'],
    largefiles: ['bigfilesBtn', 'bigfilesPathList', 'bigfiles-candidates', 'bigfiles-topn'],
  };
  for (const [inner, ids] of Object.entries(must)) {
    for (const id of ids) {
      assert.strictEqual(html.split(`id="${id}"`).length - 1, 1,
        `${inner} 分区的 ${id} 缺失或重复(合并后应恰好一处)`);
    }
  }
});

test('文件体检合并: 全局 modal 未被卷入或丢失', () => {
  // 最后一个扫描分区(bigfiles)后面挂着全站 modal, div 深度配对容易把它们吞进 panel。
  // 注意: 只有部分 modal 用 class="modal-overlay"(browseModal/sponsorModal 等
  // 用别的容器写法), 所以按 id 存在性判断, 不能只查 modal-overlay。
  for (const must of ['bigfilesDeleteModal', 'dupDeleteModal', 'emptyDeleteModal',
                      'syscleanDeleteModal', 'trashDeleteModal', 'browseModal',
                      'sponsorModal', 'contactModal', 'cleanupSummaryModal']) {
    assert.ok(html.includes(`id="${must}"`), `全局 modal ${must} 丢失`);
  }
  // 最后一个 tab-panel 的 data-panel 应排在所有 modal 之前
  const lastPanel = html.lastIndexOf('data-panel="');
  const firstModal = html.indexOf('id="bigfilesDeleteModal"');
  assert.ok(lastPanel < firstModal, '有 modal 被卷进了 tab-panel 内部');
});

test('文件体检合并: 旧 tab 名全部映射到对应二级分区', () => {
  const map = { dup: 'duplicates', simdup: 'similar', broken: 'broken',
                namematch: 'samename', empty: 'emptydirs', bigfiles: 'largefiles' };
  for (const [tab, inner] of Object.entries(map)) {
    const re = new RegExp(`${tab}:\\s*'${inner}'`);
    assert.ok(re.test(main), `SCAN_TAB_TO_INNER 缺少 ${tab} → ${inner} 映射`);
  }
  const i = main.indexOf('async function switchTab');
  const body = main.slice(i, main.indexOf('\n// ═', i));
  assert.ok(body.includes("switchTab('scan')"), '旧 tab 名未重定向到 scan');
  assert.ok(body.includes('SCAN_TAB_TO_INNER[tabName]'), 'switchTab 未走 SCAN_TAB_TO_INNER 映射');
});

test('SCAN_TAB_TO_INNER 定义在使用点之前(避免 TDZ)', () => {
  const def = main.indexOf('const SCAN_TAB_TO_INNER');
  const use = main.indexOf('async function switchTab');
  assert.ok(def > 0 && use > 0, '缺少定义或使用点');
  assert.ok(def < use, `SCAN_TAB_TO_INNER 定义(${def})晚于 switchTab(${use})`);
});

// ── 二级分区的位置记忆 ──
// 这个 bug 是浏览器实测抓出来的, 结构测试看不出来:
// switchTab('scan') 里写死 switchInnerTab('duplicates'), 导致用户在大文件分区
// 翻页时切去别的 tab 再切回来, 位置被弹回第一个分区。
test('二级分区记忆: panelInnerLastTab 已接入 switchTab / switchInnerTab', () => {
  assert.ok(/const panelInnerLastTab = \{/.test(main), '缺少 panelInnerLastTab 声明');
  for (const [panel, fallback] of [['docker', 'images'], ['sysjunk', 'syscache'], ['scan', 'duplicates']]) {
    assert.ok(new RegExp(`switchInnerTab\\(panelInnerLastTab\\.${panel}\\|\\|\x27${fallback}\x27\\)`).test(main),
      `switchTab 的 ${panel} 入口未读取分区记忆`);
  }
  // switchInnerTab 必须在切换时写回记忆
  const i = main.indexOf('function switchInnerTab');
  const body = main.slice(i, main.indexOf('\n}', i));
  assert.ok(/panelInnerLastTab\[activePanel\.dataset\.panel\] = tabName/.test(body),
    'switchInnerTab 未写回 panelInnerLastTab');
  // 不得再有写死默认分区的入口
  assert.ok(!/tabName===\x27scan\x27\) \{ switchInnerTab\(\x27duplicates\x27\)/.test(main),
    "switchTab('scan') 仍写死默认分区, 会丢掉用户选中的二级分区");
});

// ── 合并时最容易漏的一环: CSS 选择器指向已删除的 panel ──
// 方案 B-2/B-3 合并时只搬了 HTML, 一度有 19 条 CSS 规则仍指向已删除的
// data-panel="trash"/"temp"/"bigfiles"。这类失效不会报错, 只是样式静默消失 ——
// 回收站整套移动端 KPI 布局(2 列 + 第 5 张跨列)就是这样差点没的,
// 结构测试发现不了, 是 test_trash_panel_mobile 先报出来的。
test('CSS: 不得存在指向已删除 panel 的选择器', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'styles', 'style.css'), 'utf8');
  const live = new Set([...html.matchAll(/data-panel="(\w+)"/g)].map(x => x[1]));
  const stale = [];
  for (const m of css.matchAll(/\[\s*data-panel\s*=\s*"([\w-]+)"[^{}]*\{/g)) {
    if (!live.has(m[1])) stale.push(m[1]);
  }
  assert.strictEqual(stale.length, 0,
    `CSS 里有 ${stale.length} 处选择器指向已不存在的 panel: ${[...new Set(stale)]} —— ` +
    '合并时只搬了 HTML 没搬 CSS, 这些规则会静默失效');
});

test('CSS: 原 tab 有专属样式的分区, 样式必须跟着搬过来', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'styles', 'style.css'), 'utf8');
  // recycle/tmpfiles/largefiles 原本各有专属规则(移动端 KPI 布局、图标配色),
  // 合并时必须一起改到 inner-panel 选择器上。
  // containers/cache 则相反 —— 原 dockercleanup tab 本就没有专属规则, 走通用
  // .card/.kpi-card/.section-header 样式, 这里不该凭空要求它们有专属规则。
  for (const inner of ['recycle', 'tmpfiles', 'largefiles']) {
    const n = css.split(`data-inner-panel="${inner}"]`).length - 1;
    assert.ok(n > 0, `分区 ${inner} 在 CSS 里没有任何规则(原 tab 的样式没有跟着搬过来)`);
  }
  // 回收站那套移动端 KPI 布局必须完整保留: 固定 2 列 + 第 5 张跨列
  const kpiRow = css.slice(css.indexOf('.inner-panel[data-inner-panel="recycle"] .kpi-row{'));
  assert.ok(/repeat\(\s*2\s*,\s*minmax\(0,\s*1fr\)\s*\)/.test(kpiRow.slice(0, 200)),
    '回收站移动端「固定 2 列」布局丢失');
});
