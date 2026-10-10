// 相似文件「每组推荐保留一个」的推荐算法 — 2026-10-09
//
// 背景: 相似(不是重复)文件无法用哈希判定"这份是多余的" —— dHash 距离小只代表
// 视觉接近, 内容可能仍有差异。算法只能给**建议**, 最终删不删由用户决定。
//
// 算法按优先级排序(每条都可解释, 会显示在 UI 的 tooltip 里):
//   1. 文件名无副本标记  (2) / -副本 / -copy / backup 视为副本, 原件优先
//   2. 修改时间新
//   3. 体积更大(通常画质更高)
//   4. 路径层级更浅
//   5. 路径字典序     ← 必须兜底, 否则同一份数据两次扫描推荐会跳
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'app/ui/main.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const code = stripComments(mainSrc);

/** 按花括号配对提取函数体 —— 不能用"到下一个 function"切片,
 *  函数定义顺序不等于源码顺序, 会取到不相干的段落。 */
function fnBody(src, name) {
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

/** 把算法段抽出来单独求值 —— 它是纯函数, 不依赖 DOM */
function loadAlgo() {
  const start = code.indexOf('const SIMDUP_COPY_SUFFIX');
  const end = code.indexOf('function simSimilarityCell');
  assert.ok(start > 0 && end > start, '应能找到算法段');
  const src = code.slice(start, end);
  return new Function(src + `
    return { simDupPickKeeper, simDupLooksLikeCopy, simDupOrderGroup, simDupKeepReason };
  `)();
}

const F = (name, size, mtime, p) => ({ name, size, mtime, path: p || ('/d/' + name) });

/* ══════════ 副本名识别 ══════════ */

test('识别常见的副本文件名', () => {
  const { simDupLooksLikeCopy } = loadAlgo();
  const copies = [
    'photo(1).jpg', 'photo(12).png', 'photo（2）.jpg',      // 全角括号
    'photo - copy.jpg', 'photo_copy.jpg', 'photo copy.jpg',  // 三种分隔符
    'photo - 副本.jpg', '报告 副本.pdf', 'photo - 副本(2).jpg',
    'photo copy2.jpg', 'photo backup.jpg', 'data - backup.png',
  ];
  for (const n of copies) assert.ok(simDupLooksLikeCopy(n), '应识别为副本: ' + n);
});

test('不把正常文件名误判成副本', () => {
  const { simDupLooksLikeCopy } = loadAlgo();
  const normal = [
    'photo.jpg', 'DSC_0001.JPG', '我的照片 2024.png', 'a-b_c.jpg',
    'a.b.c.jpg',                       // 多个点, 只看最后一个
    'copy.jpg',                        // 文件名本来就是 copy
    'copywriting.txt', 'Copyright.pdf', // 含 copy 但不是副本标记
  ];
  for (const n of normal) assert.ok(!simDupLooksLikeCopy(n), '不应误判: ' + n);
});

test('空名/无扩展名不崩', () => {
  const { simDupLooksLikeCopy } = loadAlgo();
  for (const n of ['', null, undefined, 'noext', '.hidden']) {
    assert.doesNotThrow(() => simDupLooksLikeCopy(n));
  }
});

test('只看扩展名之前的 stem(否则 photo(1).jpg 匹配不到)', () => {
  const { simDupLooksLikeCopy } = loadAlgo();
  // 这条是回归: 直接对全名匹配 /(1)$/ 时结尾是 ".jpg" 不是 "(1)"
  assert.ok(simDupLooksLikeCopy('photo(1).jpg'));
  assert.ok(simDupLooksLikeCopy('clip(3).mp4'));
});

/* ══════════ 推荐优先级 ══════════ */

test('优先级 1: 文件名干净的胜出, 哪怕副本更新更大', () => {
  const { simDupPickKeeper } = loadAlgo();
  const r = simDupPickKeeper([
    F('a(1).jpg', 99999, 99999, '/d/a(1).jpg'),
    F('a.jpg', 1, 1, '/d/a.jpg'),
  ]);
  assert.strictEqual(r.file.name, 'a.jpg');
});

test('优先级 2: 都干净时 mtime 新的胜出', () => {
  const { simDupPickKeeper } = loadAlgo();
  const r = simDupPickKeeper([F('x.jpg', 100, 1000, '/d/x.jpg'), F('y.jpg', 100, 2000, '/d/y.jpg')]);
  assert.strictEqual(r.file.name, 'y.jpg');
});

test('优先级 3: mtime 相同时体积大的胜出', () => {
  const { simDupPickKeeper } = loadAlgo();
  // 关键: 期望答案的路径字典序必须**大于**另一个(否则删掉体积优先级后,
  // 路径兜底恰好选出同一个答案, 测试照样绿 —— 注入验证时连续漏过两次)。
  const r = simDupPickKeeper([F('z_big.jpg', 9000, 1000, '/d/z_big.jpg'), F('a_small.jpg', 100, 1000, '/d/a_small.jpg')]);
  assert.strictEqual(r.file.name, 'z_big.jpg');
  // depth 不同、但深度方向也与体积方向相反, 双保险
  const r2 = simDupPickKeeper([F('big.jpg', 9000, 1000, '/x/y/z/big.jpg'), F('small.jpg', 100, 1000, '/a_small.jpg')]);
  assert.strictEqual(r2.file.name, 'big.jpg');
});

test('优先级 4: 前三项相同时路径浅的胜出', () => {
  const { simDupPickKeeper } = loadAlgo();
  const r = simDupPickKeeper([
    F('p.jpg', 100, 1000, '/d/deep/backup/p.jpg'),
    F('p.jpg', 100, 1000, '/d/p.jpg'),
  ]);
  assert.strictEqual(r.file.path, '/d/p.jpg');
});

test('优先级 5: 完全相同时按路径字典序, 且结果稳定', () => {
  const { simDupPickKeeper } = loadAlgo();
  const group = [F('p.jpg', 100, 1000, '/d/b/p.jpg'), F('p.jpg', 100, 1000, '/d/a/p.jpg')];
  // 稳定是硬要求: 推荐结果每次扫描都跳, 用户就没法信任这个功能
  assert.strictEqual(simDupPickKeeper(group).file.path, simDupPickKeeper(group).file.path);
  assert.strictEqual(simDupPickKeeper(group).file.path, '/d/a/p.jpg');
  // 入序打乱也必须得到同一个答案
  assert.strictEqual(simDupPickKeeper([...group].reverse()).file.path, '/d/a/p.jpg');
});

/* ══════════ 边界 ══════════ */

test('mtime 缺失不崩且不影响推荐', () => {
  const { simDupPickKeeper } = loadAlgo();
  const r = simDupPickKeeper([F('a.jpg', 100, null, '/d/a.jpg'), F('b.jpg', 100, null, '/d/b.jpg')]);
  assert.ok(r.file, '应仍能选出推荐');
  assert.ok(r.reason, '应给出理由');
});

test('size 缺失/为 0 不崩', () => {
  const { simDupPickKeeper } = loadAlgo();
  const r = simDupPickKeeper([
    { name: 'a.jpg', path: '/d/a.jpg' },
    { name: 'b.jpg', path: '/d/b.jpg' },
  ]);
  assert.ok(r.file);
});

test('空组/单文件组', () => {
  const { simDupPickKeeper } = loadAlgo();
  assert.strictEqual(simDupPickKeeper([]), null);
  assert.strictEqual(simDupPickKeeper(null), null);
  const one = simDupPickKeeper([F('only.jpg', 100, 1, '/d/only.jpg')]);
  assert.strictEqual(one.file.name, 'only.jpg');
  assert.ok(one.reason, '单文件组也要有理由');
});

test('simDupOrderGroup 把推荐放首位且不丢文件', () => {
  const { simDupOrderGroup } = loadAlgo();
  const g = [F('p(1).jpg', 100, 1, '/a/p(1).jpg'), F('p(2).jpg', 100, 2, '/a/p(2).jpg'), F('p.jpg', 100, 3, '/a/p.jpg')];
  const ord = simDupOrderGroup(g);
  assert.strictEqual(ord.length, 3, '不能丢文件');
  assert.strictEqual(ord[0].name, 'p.jpg', '推荐的在首位');
  assert.deepStrictEqual([...ord].map(f => f.name).sort(), ['p(1).jpg', 'p(2).jpg', 'p.jpg']);
});

/* ══════════ 渲染与选择 ══════════ */

test('渲染: 按组分块, 组内标出推荐与删除', () => {
  const body = fnBody(code, 'simDupRenderResult');
  assert.ok(body, '应取到 simDupRenderResult');
  assert.match(body, /class="simdup-group"/, '应有组容器');
  assert.match(body, /class="simdup-group-head"/, '应有组头');
  assert.match(body, /★ 推荐保留/, '推荐项应有标记');
  assert.match(body, /✕ 删除/, '非推荐项应标删除');
  assert.match(body, /simDupOrderGroup/, '应按推荐顺序渲染');
  assert.match(body, /simdup-why/, '应显示推荐理由(CSS 类名是小写 simdup-why)');
  assert.match(body, /可释放/, '组头应显示可释放空间');
  assert.match(body, /filesUpdateSelectInfo\('simdup'\)/, '渲染后要刷新选择计数');
});

test('选择: 组头 checkbox 携带"除推荐外的全部"路径', () => {
  const body = fnBody(code, 'simDupRenderResult');
  assert.ok(body);
  assert.match(body, /data-paths="' \+ escHtml\(JSON\.stringify\(delFiles\.map/,
    'data-paths 应是待删副本列表');
  assert.match(body, /data-keep="' \+ escHtml\(ordered\[0\]\.path\)/,
    'data-keep 应记录推荐保留的那份');
  assert.match(body, /delFiles\.length \? '' : 'disabled'/,
    '只有一份的组必须 disabled, 否则全选会把仅存的那份也删掉');
});

test('选择: filesCollect 对相似按组粒度取路径', () => {
  const body = fnBody(code, 'filesCollect');
  assert.ok(body);
  assert.match(body, /mod === 'namematch' \|\| mod === 'simdup'/,
    '相似必须与重名一样走组粒度(data-paths), 不能按逐文件 data-path');
  assert.match(body, /else \{\s*paths\.push\(el\.dataset\.path\)/,
    '异常分区仍是文件粒度');
});

test('全选: 支持传入 mod 字符串, 且跳过 disabled', () => {
  const body = fnBody(code, 'filesSelectAll');
  assert.ok(body);
  assert.match(body, /typeof cb === 'string'/, '应支持传 mod 字符串(供按钮调用)');
  assert.match(body, /if \(!el\.disabled\) el\.checked = on/,
    '必须跳过 disabled —— 全选不能把仅存的那份也勾上');
});

test('存在「全选各组」按钮', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app/ui/index.html'), 'utf8');
  assert.match(html, /filesSelectAll\('simdup'\)/, '应有全选各组按钮');
  assert.match(html, /id="simdupSelectAllBtn"/);
});

/* ══════════ 后端 ══════════ */

test('后端: group files 输出 mtime(推荐算法需要)', () => {
  const w = fs.readFileSync(path.join(ROOT, 'app/simdup_scan.js'), 'utf8');
  assert.match(w, /mtime: f\.mtime \?\? null/,
    '提取阶段已拿 mtime, 必须往组里输出, 否则前端只能靠文件名猜');
});

test('后端: 相似组文件保持 g.files 结构(对比弹窗依赖)', () => {
  const w = fs.readFileSync(path.join(ROOT, 'app/simdup_scan.js'), 'utf8');
  assert.match(w, /path: f\.path, name: f\.path\.split\('\/'\)\.pop\(\), size: f\.size/);
  assert.match(w, /minDist: md/);
});
