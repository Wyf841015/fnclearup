// 所有 tab-panel 必须在 .tabs 内, 不能挂到 <body> 下 —— 2026-10-10
//
// 用户报"去重、相似等卡片右侧超出了上面文件体检卡片"。真根因是 index.html 的
// 嵌套错误: .tabs 提前闭合, 于是 data-panel="scan"/"sysjunk"/"schedule"/
// "diskanalysis" 四个面板成了 <body> 的直接子元素。body 有 position:relative
// 且无宽度约束, 宽度就是整个视口(1280px 视口下 1270px), 而 .tabs 在
// .container(max-width:1200) 内只有 1168px —— 右侧差 102px, 左侧差 51px。
//
// 修法: 删掉提前闭合的 </div>, 在 footer 前补 </div> 闭合 .tabs, footer 后补
// </div> 闭合 .container。switchTab/switchInnerTab 都用 querySelector 按
// data-panel 属性定位, 不依赖父级, 所以移动面板位置不影响功能。
//
// ★ 教训: 最初想用 CSS 补丁(.tab-panel 加 max-width/padding)绕过, 结果引入了
//   新的不一致 —— 补丁给所有 tab-panel 加了 16px 横向 padding, .tabs 内的面板
//   (app/disk/docker) 内容缩进 16px, 而 body 下的那批对齐, 切 tab 时左右边界
//   会跳动 16px。CSS 绕过不了结构问题, 只会在旁边制造新 bug。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'app/ui/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app/ui/styles/style.css'), 'utf8');

const EXPECTED = ['app', 'disk', 'docker', 'scan', 'sysjunk', 'schedule', 'diskanalysis'];

// 用 happy-dom 真解析一遍 —— 静态正则判断嵌套深度容易算错(只数 div 不数
// header 之类), 而浏览器才是实际执行者。解析结果与预期不一致时立刻能看出。
let doc = null, parseErr = null;
try {
  const { Window } = await import('/vol3/1000/hermes/fnlogpush/node_modules/happy-dom/lib/index.js');
  const win = new Window({ url: 'http://localhost/app/fnclearup/' });
  win.document.write(html);
  doc = win.document;
} catch (e) { parseErr = e; }

test('HTML 能被真实解析器解析(且无致命错误)', () => {
  if (parseErr) throw parseErr;   // 解析器不可用就明确报错, 不要静默跳过
  assert.ok(doc, '应有 document');
});

test('.container 存在且包含 header/.tabs/.footer', () => {
  const c = doc.querySelector('.container');
  assert.ok(c, '.container 应存在');
  assert.ok(c.querySelector(':scope > .tabs'), '.tabs 必须是 .container 的直接子元素');
  assert.ok(c.querySelector(':scope > .footer'), '.footer 必须在 .container 内(它原本也挂在 body 下, 比导航区宽 51px)');
  assert.ok(c.querySelector(':scope > .header'), '.header 必须在 .container 内');
});

test('全部 7 个 tab-panel 都在 .tabs 内, 一个都不能挂在 body 下', () => {
  const tabs = doc.querySelector('.tabs');
  assert.ok(tabs, '.tabs 应存在');
  const panels = [...doc.querySelectorAll('.tab-panel')];
  assert.strictEqual(panels.length, EXPECTED.length,
    'tab-panel 数量应为 ' + EXPECTED.length + ', 实际 ' + panels.length);
  for (const p of panels) {
    const name = p.dataset.panel;
    assert.ok(EXPECTED.includes(name), '出现未知的 data-panel: ' + name);
    assert.ok(tabs.contains(p),
      '★ panel[' + name + '] 不在 .tabs 内 —— 它成了 ' +
      p.parentElement.tagName.toLowerCase() + ' 的子元素, 宽度会撑满视口, ' +
      '比导航区宽 51~102px。根因是 .tabs 提前闭合。');
  }
});

test('每个 data-panel 值唯一(不能有重复面板)', () => {
  const names = [...doc.querySelectorAll('.tab-panel')].map(p => p.dataset.panel);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepStrictEqual(dup, [], '重复的 data-panel: ' + JSON.stringify(dup));
});

test('.tabs 直接子元素里不该混进 modal', () => {
  // modal 是 position:fixed, 混进 .tabs 不影响显示, 但说明闭合位置选错了 ——
  // 真正的边界应该在最后一个 panel 之后、modal 之前。
  const tabs = doc.querySelector('.tabs');
  const strays = [...tabs.children].filter(c =>
    c.classList.contains('modal-overlay') ||
    c.classList.contains('sponsor-modal-overlay') ||
    c.tagName === 'DIALOG' ||
    c.classList.contains('footer'));
  assert.deepStrictEqual(strays.map(c => c.className || c.tagName), [],
    '.tabs 里混进了不该有的元素');
});

test('.tabs 内恰好一个 .active 面板(默认)', () => {
  const active = [...doc.querySelectorAll('.tab-panel.active')];
  assert.strictEqual(active.length, 1, '默认应只有一个 active 面板, 实际 ' + active.length);
  assert.ok(['app', 'disk', 'docker', 'scan', 'sysjunk', 'schedule', 'diskanalysis'].includes(active[0].dataset.panel));
});

test('CSS 里不再有 tab-panel 限宽补丁', () => {
  // 这条补丁是上一轮的弯路: 结构修好后它反而制造了 16px 不一致。
  // 留着会让人以为"还需要限宽", 将来改坏结构时又被掩盖。
  const rules = [...css.matchAll(/\.tab-panel\s*\{([^}]*)\}/g)].map(m => m[1]);
  for (const r of rules) {
    assert.ok(!/max-width/.test(r), '.tab-panel 不该有限宽补丁(结构已修好): ' + r.trim());
    assert.ok(!/padding-left|padding-right/.test(r),
      '.tab-panel 不该有横向 padding 补丁(会给所有面板加 16px 缩进): ' + r.trim());
  }
});

test('CSS 花括号配平', () => {
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  assert.strictEqual(open, close, 'CSS 花括号不配平: ' + open + ' vs ' + close);
});

test('闭合标签数量与开标签一致(或仅末尾多一个被浏览器忽略的)', () => {
  const body = html.slice(html.indexOf('<body'));
  const open = (body.match(/<div\b(?![^>]*?\/)[^>]*>/g) || []).length;
  const close = (body.match(/<\/div>/g) || []).length;
  // 历史上文件末尾就多一个 </div>(609 开/610 闭), 浏览器会忽略。
  // 允许多 0~1 个, 但不能少(少了就是有 div 没闭合, 后面全部错位)。
  assert.ok(close - open <= 1,
    '</div> 比 <div> 少 ' + (open - close) + ' 个 —— 有 div 未闭合, 后续元素全部脱离父级');
});
