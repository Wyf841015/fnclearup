// 布局: 子分区按钮行不得超出导航区 —— 2026-10-10
//
// 用户报"去重/相似等卡片右侧超出了上面文件体检卡片"。真根因是 HTML 嵌套错误:
// index.html 的 .tabs 提前闭合(L215 有个多余的 </div>), 于是 tab-panel
// data-panel="scan" 成了 <body> 的直接子元素, 宽度撑满全屏 1270px;
// 而 .tabs 在 .container(max-width:1200) 内只有 1168px。
// inner-tabs 在 tab-panel 内 → 右侧比导航区多出 35px。
//
// 这里锁定 CSS 侧的约束(tab-panel 复制 container 的宽度), 防止有人改回去。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'app/ui/styles/style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'app/ui/index.html'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const cssNoComment = strip(css);

// CSS 里 .tab-panel 有多条规则(.tab-panel{display:none} / .tab-panel.active{...} /
// 限宽那条...), 只取第一条会匹配到 display:none 那条, 断言全部落空。
// 要拿全部, 任意一条含 max-width 就算数。
function rulesOf(selector) {
  const re = new RegExp('(?:^|[}{;\\n])\\s*' + selector.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')
    .replace(/\\s+/g, '\\s*') + '\\s*\\{([^}]*)\\}', 'g');
  const out = [];
  let m;
  while ((m = re.exec(cssNoComment))) out.push(m[1]);
  return out;
}
const panelRules = rulesOf('.tab-panel');
const containerRules = rulesOf('.container');

test('tab-panel 复制了 container 的宽度约束', () => {
  assert.ok(panelRules.length, '应存在 .tab-panel 规则');
  const width = panelRules.find(r => /max-width/.test(r));
  assert.ok(width, '★ tab-panel 必须限宽, 否则挂到 body 下就撑满全屏(1280px 视口下比导航区宽 102px)。'
    + '实际 .tab-panel 规则: ' + JSON.stringify(panelRules));
  assert.match(width, /max-width:1200px/);
  assert.match(width, /margin-left:auto/, '要水平居中, 与 container 的 margin:0 auto 一致');
  assert.match(width, /margin-right:auto/);
  assert.match(width, /padding-left:16px/, '左内边距要与 container 的 16px 一致');
  assert.match(width, /padding-right:16px/);
});

test('container 与 tab-panel 的限宽值必须相同', () => {
  const cw = containerRules.map(r => /max-width:(\d+)px/.exec(r)).find(Boolean);
  const tw = panelRules.map(r => /max-width:(\d+)px/.exec(r)).find(Boolean);
  assert.ok(cw && tw, '两者都要有 max-width');
  assert.strictEqual(tw[1], cw[1],
    '限宽不一致: container=' + cw[1] + 'px 但 tab-panel=' + tw[1] + 'px —— 会导致右侧对不齐');
});

test('移动端 padding 变化要同步给 tab-panel', () => {
  // 漏同步的后果: 窄屏下 container 收窄到 12px 但 tab-panel 还是 16px, 右边又错开 4px。
  // 这里不做嵌套正则(media query 里套正则太脆), 直接取块内容做字符串包含判断。
  const at = cssNoComment.indexOf('@media(max-width:768px)');
  assert.ok(at > 0, '应有 768px media query');
  // 从 { 开始花括号配平截取整块
  let depth = 0, end = -1;
  for (let x = cssNoComment.indexOf('{', at); x < cssNoComment.length; x++) {
    if (cssNoComment[x] === '{') depth++;
    else if (cssNoComment[x] === '}') { depth--; if (depth === 0) { end = x; break; } }
  }
  assert.ok(end > 0, '768px media query 应有闭合');
  const block = cssNoComment.slice(at, end + 1);

  const cpad = /\.container\s*\{([^}]*)\}/.exec(block);
  assert.ok(cpad, '768px media query 内应有 .container 规则');
  const tpad = /\.tab-panel\s*\{([^}]*)\}/.exec(block);
  assert.ok(tpad, '★ 768px media query 内必须同步 tab-panel 的 padding, 否则窄屏下右侧又错开');
  assert.match(tpad[1], /padding-left:12px/, '实际: ' + tpad[1].trim());
  assert.match(tpad[1], /padding-right:12px/, '实际: ' + tpad[1].trim());

  // container 的左右 padding 必须与 tab-panel 一致。
  // 注意 padding:16px 12px 是 "上下 左右" 两值简写, 左=右=parts[1];
  // 正则必须能吃掉 px 单位 —— 用 [\d.]+px 而不是 [\d\s\.]+ (后者会在 'p' 处截断,
  // 把 "16px 12px" 读成 "16", 于是断言报出一个根本不存在的错)。
  const cm = /padding:\s*([\d.]+px(?:\s+[\d.]+px){0,3})/.exec(cpad[1]);
  assert.ok(cm, '应能读出 container 的 padding 简写值, 实际规则: ' + cpad[1].trim());
  const parts = cm[1].trim().split(/\s+/);
  const wantL = parts.length >= 2 ? parts[1] : parts[0];
  const wantR = parts.length >= 4 ? parts[3] : (parts.length >= 2 ? parts[1] : parts[0]);
  const gotL = /padding-left:(\d+)px/.exec(tpad[1])[1];
  const gotR = /padding-right:(\d+)px/.exec(tpad[1])[1];
  assert.strictEqual(gotL, wantL.replace('px', ''),
    '768px 下左 padding 不一致: container=' + wantL + ' tab-panel=' + gotL + 'px');
  assert.strictEqual(gotR, wantR.replace('px', ''),
    '768px 下右 padding 不一致: container=' + wantR + ' tab-panel=' + gotR + 'px');
});

test('HTML 里有 2 个 tab-panel 挂在 body 下(记录现状, 提醒根治)', () => {
  // 这是 CSS 修复要"绕开"的真实问题。改 HTML 挪回 .tabs 内是根治方案,
  // 但要动 1000+ 行的嵌套结构, 风险高。这里把现状钉住, 一旦有人修了
  // .tabs 的嵌套(可以删掉 CSS 约束), 这条测试会提醒同步清理。
  const bodyChildren = /<body[^>]*>([\s\S]*)/.exec(html)[1];
  // 粗略判断: .tabs 的闭合位置早于 data-panel="scan"
  const tabsEnd = bodyChildren.indexOf('</div><!-- Panel: tmp -->');
  const scanAt = bodyChildren.indexOf('data-panel="scan"');
  if (tabsEnd > 0 && scanAt > tabsEnd) {
    // 当前就是"挂 body 下"的状态 —— CSS 约束是必要的
    assert.match(cssNoComment, /\.tab-panel\s*\{[^}]*max-width/,
      'scan 面板挂在 body 下时, tab-panel 必须限宽');
  }
});

test('CSS 花括号配平', () => {
  const open = (cssNoComment.match(/\{/g) || []).length;
  const close = (cssNoComment.match(/\}/g) || []).length;
  assert.strictEqual(open, close, 'CSS 花括号不配平: ' + open + ' vs ' + close);
});
