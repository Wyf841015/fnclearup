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
