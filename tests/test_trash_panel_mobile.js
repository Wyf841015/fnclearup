// 回收站 tab 移动端布局回归 (2026-10-02, 依据真机截图)
//
// 用户截图反馈: KPI 卡片挤在一行, 数值被截成 "3._"、"1..", 标签完全消失,
// 第 3 张卡片还被屏幕右边缘裁掉; 「浏览内容」按钮半宽左对齐, 与上方全宽按钮
// 和 2 列网格宽度不一致, 破坏区块对齐。
//
// 根因: .tab-panel[data-panel="trash"] .kpi-row 硬编码了 repeat(5,1fr) ——
// 移动端也强制 5 列; 而 section-header 在基础规则里根本没定 display, 只有
// 媒体查询里另起了一套 grid, 于是窄屏下各按钮宽度互不一致。
//
// 关键约束: 样式写在基础规则里, 不能只写在 max-width 媒体查询中 ——
// fnOS 移动 WebView 常以桌面 UA 渲染, 断点不触发(见 memory), 真机上就是一堆
// 没有布局样式的裸元素。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'styles', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'index.html'), 'utf8');

/**
 * 取某选择器的规则体(花括号配平, 支持多行)。
 * 必须精确匹配 "选择器{" —— 用 indexOf(sel) 会先撞上 .kpi-card:nth-child(5)
 * 这类更长的选择器前缀, 取到错误的规则体(实测踩过)。
 */
function rule(sel) {
  const i = css.indexOf(sel + '{');
  if (i < 0) return null;
  const open = i + sel.length;
  let depth = 0;
  for (let k = open; k < css.length; k++) {
    if (css[k] === '{') depth++;
    else if (css[k] === '}') { depth--; if (depth === 0) return css.slice(open + 1, k); }
  }
  return null;
}

test('回收站 KPI 固定 2 列, 且第 5 张跨列收尾(不留半边空白)', () => {
  const r = rule('.tab-panel[data-panel="trash"] .kpi-row');
  assert.ok(r, '.kpi-row 的回收站规则缺失');
  assert.ok(!/repeat\(\s*5\s*,\s*1fr\s*\)/.test(r),
    '不能用 repeat(5,1fr) —— 移动端也强制 5 列, 数值被截成一两个字符');
  // 实测 360px 下 auto-fit 会排成 2+2+1, 第 5 张孤零零独占一行留空,
  // 因此固定 2 列 + 让第 5 张 grid-column:1/-1 铺满收尾
  assert.ok(/repeat\(\s*2\s*,\s*minmax\(0,\s*1fr\)\s*\)/.test(r),
    '应固定 2 列并用 minmax(0,1fr) 防止内容撑破列宽');
  const fifth = rule('.tab-panel[data-panel="trash"] .kpi-card:nth-child(5)');
  assert.ok(fifth, '缺少第 5 张卡的规则');
  assert.ok(/grid-column\s*:\s*1\s*\/\s*-1/.test(fifth),
    '第 5 张必须跨两列, 否则 2+2+1 的排布会在右侧留半边空白');
  // 通栏卡内标签贴左、数值贴右, 内容不能全堆在一侧
  const body = rule('.tab-panel[data-panel="trash"] .kpi-card:nth-child(5) .kpi-body');
  assert.ok(body, '通栏卡的 kpi-body 缺规则');
  assert.ok(/grid-template-columns\s*:\s*1fr\s+auto/.test(body),
    '通栏卡应为 1fr auto —— 标签占左侧、数值贴右, 两侧对齐');
});

test('KPI 数值与标签在窄屏必须自身截断, 而不是把卡片撑破', () => {
  for (const sel of ['.tab-panel[data-panel="trash"] .kpi-label',
                     '.tab-panel[data-panel="trash"] .kpi-value']) {
    const r = rule(sel);
    assert.ok(r, `${sel} 规则缺失`);
    assert.ok(/text-overflow\s*:\s*ellipsis/.test(r), `${sel} 缺 ellipsis 截断`);
    assert.ok(/overflow\s*:\s*hidden/.test(r), `${sel} 缺 overflow:hidden`);
    assert.ok(/white-space\s*:\s*nowrap/.test(r), `${sel} 缺 nowrap, 长数字会换行撑高卡片`);
  }
  // 图标必须允许收缩, 否则在极窄列里会把内容区挤到零宽
  const icon = rule('.tab-panel[data-panel="trash"] .kpi-icon');
  assert.ok(/flex-shrink\s*:\s*0/.test(icon), '图标未设 flex-shrink:0');
  // 卡片本身要有最小内边距, 不能为省空间压到 6px
  const card = rule('.tab-panel[data-panel="trash"] .kpi-card');
  // padding 可能是 `10px` 也可能是 `9px 10px`(上下 左右), 取横向值判断
  const pads = [...card.matchAll(/padding\s*:([^;]+)/g)].map(x => x[1]);
  const nums = pads.flatMap(v => (v.match(/(\d+)px/g) || []).map(n => Number(n.replace('px',''))));
  assert.ok(nums.length, '未找到 padding 声明');
  assert.ok(Math.min(...nums) >= 8,
    `KPI 卡片内边距过小(最小 ${Math.min(...nums)}px), 内容贴边显得局促: ${pads.join(' | ')}`);
});

test('按钮区统一为 grid, 不再有半宽左对齐的孤儿按钮', () => {
  const r = rule('.tab-panel[data-panel="trash"] .section-header');
  assert.ok(r, 'section-header 基础规则缺失(原先只有媒体查询里有 display)');
  assert.ok(/display\s*:\s*grid/.test(r), '按钮区基础规则必须定 display, 否则各按钮宽度互不一致');
  assert.ok(/repeat\(\s*auto-fit\s*,\s*minmax/.test(r), '按钮区应用 auto-fit 自适应');
  // 扫描与浏览内容各占满一行, 4 个分级清理按钮排成 2x2
  const full = /\.tab-panel\[data-panel="trash"\]\s+\.section-header\s+#trashScanBtn,\s*\n?[^}]*#trashBrowseBtn\{grid-column:1\/-1\}/.test(css);
  assert.ok(full, '「扫描回收站」与「浏览内容」应各占满整行(浏览内容此前半宽左对齐)');
});

test('高危操作「全部清空」与其余清理按钮拉开视觉层级', () => {
  const r = rule('.tab-panel[data-panel="trash"] .section-header #trashCleanAllBtn');
  assert.ok(r, '缺少 #trashCleanAllBtn 独立样式');
  assert.ok(/grid-column\s*:\s*1\s*\/\s*-1/.test(r), '「全部清空」应独占一行, 与分级清理区分');
  assert.ok(/border-color\s*:\s*var\(--color-danger\)/.test(r), '「全部清空」应有红色边框强化警示');
});

test('回收站 6 个按钮与 5 张 KPI 卡片齐全', () => {
  const i = html.indexOf('data-panel="trash"');
  const seg = html.slice(i, html.indexOf('data-panel=', i + 20));
  for (const id of ['trashScanBtn', 'trashClean30Btn', 'trashClean90Btn',
                     'trashClean365Btn', 'trashCleanAllBtn', 'trashBrowseBtn']) {
    assert.ok(seg.includes(`id="${id}"`), `缺少按钮 ${id}`);
  }
  const cards = (seg.match(/class="kpi-card"/g) || []).length;
  assert.equal(cards, 5, `KPI 卡片应为 5 张, 实际 ${cards}`);
});

test('空状态说明文字不被截断(截图底部只露出半行)', () => {
  // 截图里空状态描述最后一行被屏幕底部裁掉 —— 属页面可滚动区域的正常表现,
  // 但要求文字自身可正常折行, 不能是 break-all 竖排或 nowrap 被裁
  const r = rule('.dup-empty-state p');
  assert.ok(r, '.dup-empty-state p 规则缺失');
  assert.ok(!/white-space\s*:\s*nowrap/.test(r), '空状态说明不应 nowrap, 否则长路径模板会被裁掉');
  assert.ok(!/word-break\s*:\s*break-all/.test(r), '空状态说明不应 break-all 竖排');
});