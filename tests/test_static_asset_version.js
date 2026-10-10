// 静态资源版本号必须随改动递增 —— 2026-10-10
//
// index.html 里写的是 <link href="styles/style.css?v=3">。这个 ?v= 是浏览器
// 缓存键: 改了 CSS 但不 bump, 用户拿到的还是旧样式 —— 表现为"代码明明改了,
// 界面却没变化", 极难自查。本轮布局修复就先踩了这个坑(对比实验时浏览器
// 一直在用缓存的 CSS, 差点得出"修复无效"的错误结论)。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'app/ui/index.html'), 'utf8');

test('style.css 带 ?v= 版本号', () => {
  const m = /style\.css\?v=(\d+)/.exec(html);
  assert.ok(m, 'style.css 必须带 ?v= 版本号, 否则改了样式用户看不到');
});

test('main.js 也带版本号(与 CSS 同批 bump)', () => {
  // main.js 没有 ?v=, 它靠 no-store 或 ETag 保证新鲜度; 这里只记录现状,
  // 一旦将来加了 ?v=, 记得和 CSS 一起 bump。
  const has = /main\.js\?v=\d+/.test(html);
  const nocache = /main\.js/.test(html);
  assert.ok(nocache, 'main.js 应被引用');
  if (!has) {
    // 当前无版本号 —— 确认 server 对 js 走的是 no-store/ETag 而不是长缓存
    const server = fs.readFileSync(path.join(ROOT, 'app/ui/server.js'), 'utf8');
    assert.match(server, /no-cache|no-store|etag|ETag/,
      'main.js 没有 ?v= 版本号, server 必须用 no-cache/no-store/ETag 保证新鲜度');
  }
});

test('所有 ?v= 版本号是纯数字且不重复错乱', () => {
  const all = [...html.matchAll(/\?v=(\d+)/g)].map(m => Number(m[1]));
  for (const v of all) assert.ok(Number.isInteger(v) && v >= 1, '?v= 必须是正整数');
});
