// ── 路径列表容器 ID 一致性 ──
//
// 背景：renderDupPaths(tab) 是用 `tab + 'PathList'` 拼元素 ID 的：
//
//     const container = document.getElementById(tab + 'PathList');
//
// 所以每加一个扫描面板，HTML 里的容器 id 必须**严格**是 `<tab>PathList`。
// 曾经把扩展名面板的 id 写成 bePathList（缩写），函数找不到元素直接 return，
// 表现为「添加目录后路径标签不显示」——功能全对，就是界面空着。
//
// 这个测试把「DupState 里有哪些 tab」和「HTML 里有哪些 PathList」对齐，
// 以后加新面板漏改 ID 会立刻失败。
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = dirname(HERE);
const MAIN = readFileSync(join(PROJ, 'app/ui/main.js'), 'utf8');
const HTML = readFileSync(join(PROJ, 'app/ui/index.html'), 'utf8');

/** 从 DupState 定义里抠出所有 tab key */
function getDupStateKeys() {
  // DupState = { music:{...}, files:{...}, ... };
  const m = MAIN.match(/const\s+DupState\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(m, '未找到 DupState 定义');
  const body = m[1];
  const keys = [];
  // 逐行找 `  key: {` 或 `  key:{`（排除注释行）
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const km = trimmed.match(/^([a-zA-Z_][\w]*)\s*:\s*\{/);
    if (km) keys.push(km[1]);
  }
  return keys;
}

/** HTML 里所有 <tab>PathList 形式的容器 id */
function getPathListIds() {
  const ids = new Set();
  for (const m of HTML.matchAll(/id="([a-zA-Z_]\w*PathList)"/g)) ids.add(m[1]);
  return ids;
}

test('DupState 每个 tab 在 HTML 里都有对应的 <tab>PathList 容器', () => {
  const keys = getDupStateKeys();
  assert.ok(keys.length >= 6, `DupState 应至少有 6 个 tab，实际 ${keys.length}: ${keys.join(',')}`);

  const ids = getPathListIds();
  const missing = [];
  for (const k of keys) {
    if (!ids.has(k + 'PathList')) missing.push(`${k} → 缺 id="${k}PathList"`);
  }
  assert.deepStrictEqual(missing, [],
    '以下 tab 的路径容器 ID 与 renderDupPaths 的 `tab + PathList` 拼法对不上：\n  ' + missing.join('\n  '));
});

test('扩展名 / 文件名两个新面板的路径容器存在', () => {
  const ids = getPathListIds();
  assert.ok(ids.has('badextPathList'), '缺 id="badextPathList"');
  assert.ok(ids.has('badnamePathList'), '缺 id="badnamePathList"');
});

test('新面板在页面初始化时会被渲染（否则打开就是空白）', () => {
  // 初始化里有个 forEach 批量调 renderDupPaths，新 tab 必须进这个列表，
  // 否则初始状态连「尚未添加目录」的提示都不显示。
  const m = MAIN.match(/\[([^\]]*)\]\.forEach\(\s*t\s*=>\s*renderDupPaths\(t\)\s*\)/);
  assert.ok(m, '未找到 renderDupPaths 的批量初始化调用');
  const listed = m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.ok(listed.includes('badext'), `初始化列表缺 badext，当前: ${listed.join(',')}`);
  assert.ok(listed.includes('badname'), `初始化列表缺 badname，当前: ${listed.join(',')}`);
});

test('两个面板的「添加目录」按钮调用 showDupBrowseModal 时传的 tab 名正确', () => {
  // showDupBrowseModal(tab) 会把 tab 存起来，选中目录后 push 进 DupState[tab].paths。
  // 传错名字会导致 push 到不存在的 key（静默什么都不发生）。
  for (const tab of ['badext', 'badname']) {
    const re = new RegExp(`showDupBrowseModal\\('${tab}'\\)`);
    assert.ok(re.test(HTML), `HTML 缺少 showDupBrowseModal('${tab}')`);
    assert.ok(
      new RegExp(`${tab}\\s*:\\s*\\{`).test(MAIN),
      `DupState 里没有 ${tab}，showDupBrowseModal('${tab}') 会 push 失败`
    );
  }
});

test('扫描面板的路径列表不能塞在 .section-actions 里', () => {
  // 路径列表和按钮同处一个 flex 行时会互相抢宽度：路径框只拿到 343px
  // （可用 696px），单个标签就占满一行，三个路径堆三行把标题区撑到 94px，
  // 按钮被挤到右下方悬空。路径列表必须独立成行（.scan-path-row）。
  for (const tab of ['badext', 'badname']) {
    const idIdx = HTML.indexOf(`id="${tab}PathList"`);
    assert.ok(idIdx > 0, `缺 id="${tab}PathList"`);

    // 截出这个元素所在行的标签
    const lineStart = HTML.lastIndexOf('\n', idIdx) + 1;
    const lineEnd = HTML.indexOf('\n', idIdx);
    const line = HTML.slice(lineStart, lineEnd);

    assert.ok(line.includes('scan-path-row'),
      `${tab}PathList 缺少 class="scan-path-row"，会被和按钮挤在同一行`);

    // 向上找最近的 .section-actions 开标签，确认它不在里面
    const before = HTML.slice(0, lineStart);
    const lastActions = before.lastIndexOf('class="section-actions"');
    const lastActionsClose = before.lastIndexOf('</div>');
    // 如果 section-actions 在最近一个 </div> 之后还没闭合，说明当前元素仍在里面
    assert.ok(lastActions === -1 || lastActions < lastActionsClose,
      `${tab}PathList 仍在 .section-actions 内部，会和按钮抢宽度`);
  }
});

test('CSS 缓存版本号必须随样式改动推进', () => {
  // style.css 通过 ?v=N 做缓存控制。改了样式不推进 N，浏览器会一直用旧缓存，
  // 表现为「明明改了 CSS 但界面没变」。
  const m = HTML.match(/styles\/style\.css\?v=(\d+)/);
  assert.ok(m, '未找到 style.css 的版本号引用');
  const v = parseInt(m[1], 10);
  assert.ok(v >= 7, `style.css 版本号应 >= 7（scan-path-row 是 v7 引入的），当前 v${v}`);
});

test('.scan-path-row 的关键约束都在 CSS 里', () => {
  const CSS = readFileSync(join(PROJ, 'app/ui/styles/style.css'), 'utf8');
  const idx = CSS.indexOf('.scan-path-row {');
  assert.ok(idx > 0, 'CSS 里缺少 .scan-path-row 规则');
  // 取该规则块
  const block = CSS.slice(idx, CSS.indexOf('}', idx));
  assert.ok(/max-height:\s*\d+px/.test(block), '.scan-path-row 需要 max-height 限制高度，否则路径多了会把标题区无限撑高');
  assert.ok(/overflow-y:\s*auto/.test(block), '.scan-path-row 需要 overflow-y:auto，超出时滚动而不是撑高');
  assert.ok(/width:\s*100%/.test(block), '.scan-path-row 需要 width:100% 占满整行');

  // 标签文字宽度要收窄，否则单个标签就吃满一行
  const tidx = CSS.indexOf('.scan-path-row .dup-path-tag-text');
  assert.ok(tidx > 0, '缺 .scan-path-row .dup-path-tag-text 规则');
  const tblock = CSS.slice(tidx, CSS.indexOf('}', tidx));
  const mw = tblock.match(/max-width:\s*(\d+)px/);
  assert.ok(mw, '标签文字需要 max-width');
  assert.ok(parseInt(mw[1], 10) <= 210, `标签文字 max-width 应 <=210px（实际 ${mw && mw[1]}px），否则一行放不下第二个`);
});

