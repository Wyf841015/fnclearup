// 相似度数值可见化 (P1-2) 回归测试 — 2026-09-30
//
// 背景: simdup 的 dHash 汉明距离只在 cluster() 内部用于判定, 用完就丢。
// 界面上"这两张图相似"却看不出有多相似, 用户无法决定先删哪张。
// 本测试锁定: 距离必须落进输出、按相似度排序、前端换算与展示。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const scanSrc = fs.readFileSync(path.join(ROOT, 'app', 'simdup_scan.js'), 'utf8');
const hashSrc = fs.readFileSync(path.join(ROOT, 'app', 'simhash.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'index.html'), 'utf8');

test('simdup_scan: 提供 pairDist, 与 cluster 判定口径一致', () => {
  assert.ok(/function pairDist\(a, b\)/.test(scanSrc), '缺少 pairDist');
  const body = scanSrc.slice(scanSrc.indexOf('function pairDist'),
    scanSrc.indexOf('function topPairs'));
  assert.ok(/type === 'image'/.test(body), 'pairDist 未按 image/video 分支');
  assert.ok(/hamming\(a\.hash, b\.hash\)/.test(body), 'image 分支未用 hamming');
  assert.ok(/for \(const x of av\) for \(const y of bv\)/.test(body),
    'video 分支未取各抽帧组合的最小距离');
});

test('simdup_scan: topPairs 返回最相近的若干对并限长', () => {
  assert.ok(/const MAX_PAIRS = 5;/.test(scanSrc), 'MAX_PAIRS 未定义');
  const body = scanSrc.slice(scanSrc.indexOf('function topPairs'),
    scanSrc.indexOf('function cluster'));
  assert.ok(/pairs\.sort\(\(x, y\) => x\.dist - y\.dist\)/.test(body), '未按距离升序');
  assert.ok(/slice\(0, MAX_PAIRS\)/.test(body), '未对 pairs 限长, 组内文件多时会爆');
  assert.ok(/minDist: pairs\.length \? pairs\[0\]\.dist : null/.test(body),
    '未取组内最小距离');
});

test('simdup_scan: 每个文件输出 minDist, 每个组输出 minDist 与 pairs', () => {
  assert.ok(/minDist: md \};/.test(scanSrc), '文件级 minDist 未输出');
  assert.ok(/minDist: tp\.minDist,/.test(scanSrc), '组级 minDist 未输出');
  assert.ok(/pairs: tp\.pairs,/.test(scanSrc), '组级 pairs 未输出');
  // md 必须是与组内其他文件的最小值, 不能是首尾相减
  const body = scanSrc.slice(scanSrc.indexOf('let md = null;'),
    scanSrc.indexOf('let md = null;') + 320);
  assert.ok(/md === null \|\| d < md/.test(body), 'md 未取最小值');
  assert.ok(/if \(j === fi\) continue;/.test(body), '未跳过自身');
});

test('simdup_scan: 组按相似度升序, 无距离数据的组排末尾', () => {
  assert.ok(/state\.groups\.sort\(\(a, b\) =>/.test(scanSrc), '组未排序');
  const body = scanSrc.slice(scanSrc.indexOf('state.groups.sort'),
    scanSrc.indexOf('state.groups.sort') + 460);
  assert.ok(/a\.minDist - b\.minDist/.test(body), '未按 minDist 排序');
  assert.ok(/if \(a\.minDist == null\) return 1;/.test(body), 'null 应排到末尾');
  assert.ok(/if \(b\.minDist == null\) return -1;/.test(body), 'null 排序分支不完整');
});

test('simdup_scan: stats 输出全局最相似距离 bestDist', () => {
  assert.ok(/bestDist: state\.groups\.reduce/.test(scanSrc), 'stats 缺少 bestDist');
});

test('simhash: FFMPEG 路径可被环境变量覆盖', () => {
  assert.ok(/process\.env\.FFMPEG_PATH \|\| '\/usr\/bin\/ffmpeg'/.test(hashSrc),
    'FFMPEG 仍硬编码, 非 /usr/bin 安装的机器无法运行相似检测');
});

test('前端: 距离换算相似度(64 位 dHash, 距离越小越像)', () => {
  const start = mainSrc.indexOf('const SIMDASH_BITS');
  const end = mainSrc.indexOf('function simDupRenderResult');
  const body = mainSrc.slice(start, end);
  assert.ok(/const SIMDASH_BITS = 64;/.test(body), 'SIMDASH_BITS 应为 64');
  const iPct = body.indexOf('function simSimilarityPct');
  const iCell = body.indexOf('function simSimilarityCell');
  assert.ok(iPct >= 0 && iCell > iPct, '未能定位 simSimilarityPct / Cell');
  // 注意: SIMDASH_BITS 声明在 simSimilarityPct 之前, 必须一并带入,
  // 否则 new Function 内会 ReferenceError
  const bitsDecl = body.slice(0, body.indexOf('function simSimilarityPct'));
  const fnSrc = bitsDecl + body.slice(iPct, iCell) + '\nreturn simSimilarityPct(dist);';
  const fn = new Function('dist', fnSrc);
  assert.equal(fn(0), 100, '距离 0 应为 100%');
  assert.equal(fn(64), 0, '距离 64 应为 0%');
  assert.equal(fn(null), null, '无距离应返回 null 而非 NaN');
  assert.equal(fn(undefined), null, 'undefined 应返回 null');
  assert.ok(fn(2) > fn(10), '距离越大相似度必须越低');
});

test('前端: 相似度单元格按量级着色', () => {
  const body = mainSrc.slice(mainSrc.indexOf('function simSimilarityCell'),
    mainSrc.indexOf('function simDupRenderResult'));
  assert.ok(/pct >= 95/.test(body), '缺少高相似度配色');
  assert.ok(/pct >= 80/.test(body), '缺少中等相似度配色');
  assert.ok(/—/.test(body), '无距离时应显示占位符而非 0%');
  assert.ok(/dHash 汉明距离/.test(body), '应提供 title 说明原始距离');
});

test('前端: 表格接入相似度列并携带 minDist', () => {
  assert.ok(/minDist: f\.minDist, groupMinDist: g\.minDist/.test(mainSrc),
    'clusters 未携带 minDist');
  assert.ok(/simSimilarityCell\(c\.minDist\)/.test(mainSrc), '行未渲染相似度单元格');
  assert.ok(/>相似度</.test(mainSrc), '表头缺少相似度列');
});

test('前端: 概览点明最相似的一对', () => {
  assert.ok(/simdup-best/.test(mainSrc), '未写入 #simdup-best');
  assert.ok(/最相似的一对/.test(mainSrc), '缺少文案');
  assert.ok(/id="simdup-best"/.test(html), 'index.html 缺少 #simdup-best 容器');
});
