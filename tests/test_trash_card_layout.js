// 回收站卡片移动端布局回归 (2026-10-01)
//
// 用户反馈: "回收站tab卡中的卡片移动端叠在了一起, 不够美观"
// 根因: .trash-card-path 用了 word-break:break-all —— 长路径被逐字符折成竖条,
//       卡片内三段内容同时被撑高, 视觉上就叠作一团; 且 .trash-card-stats 用
//       flex+wrap, 窄屏三项挤成两行且间距不均; .trash-card-head 可换行导致
//       卷名与大小换行错位; 卡片作为 grid/flex 项无 min-width:0 时长内容撑破同行。
//
// 关键约束: 样式必须写在基础规则里, 不能只写在 max-width 媒体查询中 ——
// fnOS 移动 WebView 常以桌面 UA 渲染, max-width 断点根本不触发(见 memory),
// 结果真机上就是一堆没有任何布局样式的裸 div。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'styles', 'style.css'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'main.js'), 'utf8');

/** 取出某选择器的规则体(按花括号配平, 支持多行写法) */
function rule(sel) {
  const i = css.indexOf(sel + '{');
  if (i < 0) return null;
  const open = i + sel.length;
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < css.length; k++) {
    if (css[k] === '{') depth++;
    else if (css[k] === '}') { depth--; if (depth === 0) return css.slice(open + 1, k); }
  }
  return null;
}

test('回收站卡片样式唯一, 不在媒体查询里重复定义(单一真源)', () => {
  const defs = [...css.matchAll(/(^|\n)\.trash-card\{/g)];
  assert.equal(defs.length, 1, `.trash-card 应只有一处定义, 实际 ${defs.length} 处`);
  assert.ok(rule('#trash-list .trash-mobile-card'), '缺少容器规则');
  assert.ok(rule('.trash-card'), '缺少卡片规则');
});

test('长路径不再逐字符折行(这是"叠在一起"的直接原因)', () => {
  const r = rule('.trash-card-path');
  assert.ok(r, '.trash-card-path 规则缺失');
  assert.ok(!/word-break\s*:\s*break-all/.test(r),
    '.trash-card-path 不能用 word-break:break-all —— 长路径会被折成竖条, 正是叠在一起的观感来源');
  assert.ok(/overflow-wrap\s*:\s*anywhere|word-break\s*:\s*normal/.test(r),
    '未设置按语义换行(overflow-wrap:anywhere 或 word-break:normal)');
  assert.ok(/-webkit-line-clamp\s*:\s*3/.test(r), '未限制最多 3 行, 长路径会把卡片无限撑高');
});

test('卡片作为布局项允许收缩(无 min-width:0 会被长内容撑破同行)', () => {
  const r = rule('.trash-card');
  assert.ok(/min-width\s*:\s*0/.test(r), '.trash-card 缺 min-width:0 —— 长路径会把卡片撑破所在列, 看起来与相邻卡片叠在一起');
  assert.ok(/overflow\s*:\s*hidden/.test(r), '.trash-card 缺 overflow:hidden');
});

test('头部不换行, 卷名自身截断、大小固定贴右', () => {
  const head = rule('.trash-card-head');
  assert.ok(/flex-wrap\s*:\s*nowrap/.test(head), '.trash-card-head 必须 nowrap —— 换行会让卷名与大小错位堆叠');
  const first = rule('.trash-card-head>span:first-child');
  assert.ok(/text-overflow\s*:\s*ellipsis/.test(first), '卷名过长时未截断');
  const last = rule('.trash-card-head>span:last-child');
  assert.ok(/flex\s*:\s*0 0 auto/.test(last), '大小应固定宽度不参与压缩');
});

test('底部三项均分 grid, 不再用 flex+wrap 挤压', () => {
  const s = rule('.trash-card-stats');
  assert.ok(/display\s*:\s*grid/.test(s), '.trash-card-stats 应改用 grid 均分, flex+wrap 在窄屏会挤成两行');
  assert.ok(/repeat\(3,\s*minmax\(0,1fr\)\)/.test(s), '应为 3 等分列');
  assert.ok(/min-width\s*:\s*0/.test(rule('.trash-card-stats>span') || ''), '子项未允许收缩');
});

test('容器用 grid auto-fit 自适应列数, 不依赖媒体查询', () => {
  const c = rule('#trash-list .trash-mobile-card');
  assert.ok(/display\s*:\s*grid/.test(c), '容器应为 grid');
  assert.ok(/repeat\(auto-fit,\s*minmax/.test(c), '应用 auto-fit + minmax, 宽屏多列窄屏单列由容器自然完成');
  assert.ok(/gap\s*:\s*1[0-9]px/.test(c), '卡片间距应 >=10px, 8px 在窄屏视觉上糊成一片');
});

test('截断的内容可用 title 查看全文', () => {
  assert.ok(/class="trash-card-path" title=/.test(mainJs), '路径被限 3 行后应提供 title');
  assert.ok(/font-weight:600" title=/.test(mainJs), '卷名被截断后应提供 title');
});