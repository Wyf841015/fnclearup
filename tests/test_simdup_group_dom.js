// 相似文件分组渲染 —— happy-dom 端到端执行 simDupRenderResult
//
// 为什么不能只用字符串断言: 渲染函数是纯字符串拼接, 但里面嵌了三层嵌套的模板
// 字面量 + 转义, 引号/括号一旦错位, 字符串断言照样能过, 运行时才炸。这里把函数
// 真实执行一遍并检查产出的 DOM 节点 —— 与用户在浏览器里看到的一致。
//
// happy-dom 是可选依赖(本机装在 fnlogpush/node_modules 下)。找不到时整个
// 文件跳过, 不会让没装依赖的机器测试失败。
import { test as T } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let Window = null;
for (const c of ['happy-dom',
  '/vol3/1000/hermes/fnlogpush/node_modules/happy-dom/lib/index.js',
  '/vol3/1000/hermes/netwatch/node_modules/happy-dom/lib/index.js']) {
  try { ({ Window } = await import(c)); break; } catch { /* 试下一个 */ }
}

const code = (() => {
  const src = fs.readFileSync(ROOT + '/app/ui/main.js', 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
})();

function fnSrc(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let i = src.indexOf('{', src.indexOf(')', m.index));
  let d = 0;
  for (let x = i; x < src.length; x++) {
    if (src[x] === '{') d++;
    else if (src[x] === '}') { d--; if (d === 0) return src.slice(m.index, x + 1); }
  }
  return null;
}

// 真实扫描产出的一组数据: 3 张近乎相同的图, 名字带副本标记
const REAL_DATA = {
  groups: [{
    group: 1, size: 300, minDist: 0,
    files: [
      { path: '/vol3/1000/hermes/_sim/临时/照片 - 副本(2).png', name: '照片 - 副本(2).png',
        size: 100, size_str: '0.0 MB', mtime: 1700000003000, minDist: 0 },
      { path: '/vol3/1000/hermes/_sim/原始/照片.png', name: '照片.png',
        size: 100, size_str: '0.0 MB', mtime: 1700000001000, minDist: 0 },
      { path: '/vol3/1000/hermes/_sim/备份/照片 - 副本.png', name: '照片 - 副本.png',
        size: 100, size_str: '0.0 MB', mtime: 1700000002000, minDist: 0 },
    ],
  }],
  stats: { totalFiles: 3, groups: 1, files: 3, bestDist: 0 },
};

function render(data) {
  const doc = new Window({ url: 'http://localhost/app/fnclearup/' }).document;
  doc.body.innerHTML = `
    <span id="simdup-total"></span><span id="simdup-groups"></span>
    <span id="simdup-files"></span><span id="simdup-best"></span>
    <div id="simdup-list"></div>
    <button id="simdupDeleteBtn" disabled><span>删除选中</span></button>`;
  const parts = [
    fnSrc(code, 'simDupRenderResult'),
    fnSrc(code, 'filesUpdateSelectInfo'),
    fnSrc(code, 'filesCollect'),
    code.slice(code.indexOf('const SIMDUP_COPY_SUFFIX'), code.indexOf('function simSimilarityCell')),
  ].filter(Boolean);
  assert.strictEqual(parts.length, 4, '应取齐待执行的 4 段函数');
  const api = new Function('document', `
    const $ = id => document.getElementById(id.replace(/^#/, ''));
    const escHtml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const formatBytes = n => (n >= 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.round(n)+' B');
    const simDupThumbUrl = p => 'api/simdup/thumb?path=' + encodeURIComponent(p);
    const SIMDASH_BITS = 64;
    function simSimilarityPct(d){ if(d==null||d<0) return null; return Math.max(0,Math.round((1-d/64)*100)); }
    let _simCmpGroups = [];
    ${parts.join('\n')}
    return { simDupRenderResult, filesCollect, filesUpdateSelectInfo, simDupPickKeeper };
  `)(doc);
  api.simDupRenderResult(data);
  return { doc, api };
}

if (!Window) {
  T('happy-dom 未安装, 跳过 DOM 端到端验证', { skip: 'optional dependency' });
} else {

T('渲染出组卡片 + 组内逐文件行', () => {
  const { doc } = render(REAL_DATA);
  const q = s => doc.querySelector(s), qa = s => [...doc.querySelectorAll(s)];
  assert.strictEqual(qa('.simdup-group').length, 1);
  assert.match(q('.simdup-group-head').textContent, /组\s*1/);
  assert.match(q('.simdup-group-head').textContent, /3\s*个/);
  assert.match(q('.simdup-group-head').textContent, /可释放/);
  assert.strictEqual(qa('.simdup-file').length, 3);
  assert.strictEqual(qa('.simdup-thumb img').length, 3);
  assert.strictEqual(qa('.simdup-dist').length, 3);
});

T('每组恰好一个★推荐 + 两个✕删除', () => {
  const { doc } = render(REAL_DATA);
  const qa = s => [...doc.querySelectorAll(s)];
  assert.strictEqual(qa('.simdup-flag.keep').length, 1);
  assert.strictEqual(qa('.simdup-flag.del').length, 2);
  const keep = doc.querySelector('.simdup-file.is-keep');
  assert.ok(keep, '推荐行应有 is-keep 类');
  assert.strictEqual(keep, doc.querySelector('.simdup-file'), '推荐行排在首位');
});

T('推荐的是文件名干净的那份, 并给出理由', () => {
  const { doc } = render(REAL_DATA);
  const keep = doc.querySelector('.simdup-file.is-keep');
  assert.match(keep.querySelector('.simdup-name').textContent, /照片\.png/,
    '应推荐「照片.png」而不是两个带「副本」后缀的');
  const why = doc.querySelector('.simdup-why');
  assert.ok(why && why.textContent.length > 3, '推荐理由应非空: ' + (why && why.textContent));
});

T('组头 checkbox: 待删列表不含推荐项', () => {
  const { doc } = render(REAL_DATA);
  const cb = doc.querySelector('.simdup-group-head .fd-cb');
  assert.ok(cb, '组头应有 checkbox');
  assert.strictEqual(cb.dataset.group, '1');
  assert.strictEqual(cb.dataset.keep, '/vol3/1000/hermes/_sim/原始/照片.png');
  const dp = JSON.parse(cb.dataset.paths);
  assert.strictEqual(dp.length, 2);
  assert.ok(!dp.includes(cb.dataset.keep), '★ 待删列表不能包含推荐保留的那份');
  assert.ok(dp.some(p => p.includes('副本(2)')) && dp.some(p => p.includes('备份')));
});

T('勾选后按钮启用且计数正确, 取消后复位', () => {
  const { doc, api } = render(REAL_DATA);
  const btn = doc.getElementById('simdupDeleteBtn');
  assert.strictEqual(btn.disabled, true, '未勾选时应禁用');
  const cb = doc.querySelector('.simdup-group-head .fd-cb');
  cb.checked = true;
  api.filesUpdateSelectInfo('simdup');
  const col = api.filesCollect('simdup');
  assert.strictEqual(col.paths.length, 2);
  assert.ok(!col.paths.includes(col.keeps[0]), '★ 待删不含推荐项');
  assert.strictEqual(btn.disabled, false);
  assert.match(btn.textContent, /2/);
  cb.checked = false;
  api.filesUpdateSelectInfo('simdup');
  assert.strictEqual(btn.disabled, true, '取消勾选后应复位为禁用');
});

T('★ 空结果: 上次有勾选, 这次扫出空 → 按钮必须复位', () => {
  // 场景: 第一次扫描有结果且用户勾了组, 第二次扫描没有匹配项。
  // 渲染函数在空结果分支会提前 return, 末尾的 filesUpdateSelectInfo 执行不到,
  // 所以这里必须显式复位 —— 否则删除按钮会一直停留在上一次的数量上。
  const { doc, api } = render(REAL_DATA);
  const cb = doc.querySelector('.simdup-group-head .fd-cb');
  cb.checked = true;
  api.filesUpdateSelectInfo('simdup');
  assert.strictEqual(doc.getElementById('simdupDeleteBtn').disabled, false, '前置: 勾选后按钮应启用');

  // 同一次渲染会话里, 再扫出空结果
  api.simDupRenderResult({ groups: [], stats: {} });
  assert.match(doc.getElementById('simdup-list').textContent, /未发现相似文件/);
  assert.strictEqual(doc.getElementById('simdupDeleteBtn').disabled, true,
    '★ 扫出空结果后按钮仍停留在上一次的勾选数');
  assert.strictEqual(api.filesCollect('simdup').paths.length, 0, '空结果不应还有待删路径');
});

T('单文件组: 无可删项 → checkbox 必须禁用', () => {
  const { doc } = render({
    groups: [{ group: 1, size: 100, minDist: 0,
      files: [{ path: '/vol3/only.png', name: 'only.png', size: 100, size_str: '0.0 MB', mtime: 1, minDist: null }] }],
    stats: {},
  });
  const cb = doc.querySelector('.simdup-group-head .fd-cb');
  assert.strictEqual(cb.disabled, true,
    '只有一份的组若不禁用, 全选会把仅存的那份也加入待删');
  assert.strictEqual(JSON.parse(cb.dataset.paths).length, 0);
  assert.strictEqual([...doc.querySelectorAll('.simdup-flag.keep')].length, 1);
});

}
