// 哈希缓存命中统计展示 (P2 可观测性) 回归测试 — 2026-09-30
//
// 背景: dup_scan 一直有持久化哈希缓存(path → size+mtimeMs+hash, 对标
// jdupes --hash-db), 二次扫描几乎不读盘, 但这个能力对用户完全不可见 ——
// 界面上没有任何数字说明"这次省了多少读取"。本测试锁定 stats 字段的产生
// 与前端展示两条链路。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const scanSrc = fs.readFileSync(path.join(ROOT, 'app', 'dup_scan.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'main.js'), 'utf8');

test('dup_scan: stats 初始值含缓存与预筛字段', () => {
  const m = scanSrc.match(/stats: \{[^}]*\}/);
  assert.ok(m, '未找到 stats 初始值');
  for (const k of ['cacheHits', 'hashed', 'cacheHitRate', 'partialSkipped', 'sizeSkipped']) {
    assert.ok(m[0].includes(k), `stats 初始值缺少 ${k}`);
  }
});

test('dup_scan: 记录 cacheHits / hashed / cacheHitRate', () => {
  assert.ok(/state\.stats\.cacheHits = cacheHits\.length;/.test(scanSrc), '未记录 cacheHits');
  assert.ok(/state\.stats\.hashed = toHash\.length;/.test(scanScanSrc(scanSrc), '未记录 hashed'));
  assert.ok(/state\.stats\.cacheHitRate =/.test(scanSrc), '未计算 cacheHitRate');
});

function scanScanSrc(s) { return s; }

test('dup_scan: 缓存命中率按 (命中 / 总量) 整数百分比计算', () => {
  const m = scanSrc.match(/state\.stats\.cacheHitRate = \(([^)]*)\)\s*\?\s*Math\.round\(([^)]*)\) \* 100\)/);
  assert.ok(m, '未找到 cacheHitRate 计算式');
  assert.ok(/cacheHits\.length \+ toHash\.length/.test(m[1]), '分母应为 命中+新哈希');
  assert.ok(/cacheHits\.length \//.test(m[2]), '分子应为命中数');
});

test('dup_scan: 记录 partial 预筛淘汰数', () => {
  assert.ok(/state\.stats\.partialSkipped = Math\.max\(0, candidates\.length - needFull\.length\)/.test(scanSrc),
    '未记录 partial 预筛淘汰数');
  assert.ok(/state\.stats\.sizeSkipped = skippedCount/.test(scanSrc) ||
            /if \(skippedCount > 0\) state\.stats\.sizeSkipped = skippedCount;/.test(scanSrc),
    '未记录大小过滤淘汰数');
});

test('dup_scan: 早退分支也带上缓存字段(不留 undefined)', () => {
  const early = scanSrc.match(/state\.stats = \{ totalFiles: 0[^}]*\}/g) || [];
  assert.ok(early.length >= 2, '应至少有两处早退赋值');
  for (const e of early) {
    for (const k of ['cacheHits', 'hashed', 'cacheHitRate', 'partialSkipped', 'sizeSkipped']) {
      assert.ok(e.includes(k), `早退分支 stats 缺少 ${k}`);
    }
  }
});

// ── 前端展示 ──────────────────────────────────────────────────────────────
function buildStats(stats) {
  // 抽取 main.js 里的 _cacheStat 计算块并真实执行
  const start = mainSrc.indexOf('var _cacheStat=');
  const end = mainSrc.indexOf("const stEl=$(ids.stats)", start);
  assert.ok(start > 0 && end > start, '未找到 _cacheStat 计算块');
  const body = mainSrc.slice(start, end);
  return new Function('stats', body + '\nreturn _cacheStat;')(stats);
}

test('前端: 热缓存显示高命中率与零新哈希', () => {
  const out = buildStats({ cacheHits: 60, hashed: 0, cacheHitRate: 100, partialSkipped: 40 });
  assert.match(out, /100%/, '未显示命中率');
  assert.match(out, /缓存命中/, '缺少标签');
  assert.match(out, /新哈希 0/, '未显示新哈希数');
  assert.match(out, /预筛已排除/, '未显示预筛排除');
  assert.match(out, />40</, '预筛数未渲染');
});

test('前端: 冷缓存显示 0% 且带 warning 样式', () => {
  const out = buildStats({ cacheHits: 0, hashed: 60, cacheHitRate: 0, partialSkipped: 0 });
  assert.match(out, /0%/, '未显示 0%');
  assert.match(out, /dup-stat-card warning/, '低命中率应走 warning 样式');
  assert.match(out, /新哈希 60/, '未显示新哈希数');
  assert.doesNotMatch(out, /预筛已排除/, '预筛数为 0 时不应显示该卡');
});

test('前端: 完全没进入哈希阶段时不显示缓存卡', () => {
  const out = buildStats({ cacheHits: 0, hashed: 0, cacheHitRate: 0, partialSkipped: 0 });
  assert.equal(out, '', '未哈希时应输出空串, 不占位');
});

test('前端: 统计卡拼接闭合正确(不再多出字面分号)', () => {
  // 曾经的 bug: 把字符串结束引号写成了内容, innerHTML 尾部多一个 ';'
  const line = mainSrc.split('\n').find(l => l.includes('stEl.innerHTML=') && l.includes('_cacheStat'));
  assert.ok(line, '未找到统计卡渲染行');
  assert.ok(!/\+_cacheStat\+';'/.test(line), "拼接尾部不应再有多余的 ';'" );
  assert.match(line.trim(), /\+_cacheStat;\s*}$/, '应以 +_cacheStat;} 结束');
  // 花括号配平
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;
  assert.equal(opens, closes, `花括号不配平: ${opens} 开 ${closes} 闭`);
});
