// 扫描排除规则 (P1-1) 回归测试 — 2026-09-30
//
// 背景: 原先扫描除最小体积外没有任何路径排除, 每次扫 /vol1 都要把 @appdata
// 的 SQLite、node_modules、.git、Docker overlay 全走一遍, 而发现的"重复文件"
// 多半是各应用共用的 LICENSE/图标, 对清理没有价值。对标 fclones .hashignore。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const rulesSrc = fs.readFileSync(path.join(ROOT, 'app', 'exclude_rules.js'), 'utf8');
const dupScan = fs.readFileSync(path.join(ROOT, 'app', 'dup_scan.js'), 'utf8');
const simScan = fs.readFileSync(path.join(ROOT, 'app', 'simdup_scan.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'api', 'dup.js'), 'utf8');
const srvSrc = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'server.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'index.html'), 'utf8');

const { compileMatcher, DEFAULT_PATTERNS, loadPatterns } =
  await import(path.join(ROOT, 'app', 'exclude_rules.js'));

test('段名规则: 任意层级的同名目录都被排除', () => {
  const m = compileMatcher(['node_modules']);
  for (const p of ['/vol1/a/node_modules/x.js', '/vol1/b/c/node_modules/deep/y.js', '/node_modules/z.js']) {
    assert.ok(m(p, false), `${p} 应排除`);
  }
  assert.ok(!m('/vol1/a/node_modules备份/x.js', false), '名字相近但不同的目录应保留');
  assert.ok(!m('/vol1/文档/a.txt', false), '普通目录应保留');
});

test('段名规则支持 * 与 ? glob', () => {
  const m = compileMatcher(['*.log', 'tmp?']);
  assert.ok(m('/vol1/a/debug.log', false), '*.log 应匹配');
  assert.ok(m('/vol1/a/tmp1', true), 'tmp? 应匹配 tmp1');
  assert.ok(!m('/vol1/a/tmp12', true), 'tmp? 不应匹配 tmp12');
  assert.ok(!m('/vol1/a/log.txt', false), '*.log 不应匹配 log.txt');
});

test('路径模式支持 ** 与 *', () => {
  const m = compileMatcher(['缓存/**', 'a/*/deep.txt']);
  assert.ok(m('/vol1/缓存/x.txt', false), '** 前缀应匹配');
  assert.ok(m('/vol1/x/缓存/y/z.txt', false), '**/x 应匹配任意层');
  assert.ok(m('/vol1/a/b/deep.txt', false), '单层 * 应匹配');
  assert.ok(!m('/vol1/a/b/c/deep.txt', false), '单层 * 不应跨层');
});

test('绝对路径前缀规则', () => {
  const m = compileMatcher(['/vol1/1000/tmp']);
  assert.ok(m('/vol1/1000/tmp/a.bin', false), '前缀内应排除');
  assert.ok(m('/vol1/1000/tmp', true), '前缀本身应排除');
  assert.ok(!m('/vol1/1000/tmp2/a.bin', false), '同前缀不同目录不应排除');
});

test('默认规则覆盖 fnOS 全部系统目录, 但不误伤用户自建的 @ 目录', () => {
  const m = compileMatcher(DEFAULT_PATTERNS);
  for (const p of ['/vol3/@appcenter/fnclearup/ui/server.js', '/vol3/@appdata/fnstat/db.sqlite',
                   '/vol3/@appmeta/x', '/vol3/@sysappmeta/ai-manager/model']) {
    assert.ok(m(p, false), `${p} 是 fnOS 系统目录, 应排除`);
  }
  // 关键: 排除是"跳过扫描"(性能), 不能像安全删除保护那样误伤用户目录
  for (const p of ['/vol1/1000/@我的相册/a.jpg', '/vol1/1000/@backup/b.bin']) {
    assert.ok(!m(p, false), `${p} 是用户目录, 不应被排除`);
  }
});

test('默认规则含常见无价值目录', () => {
  for (const need of ['node_modules', '.git', '__pycache__', 'lost+found', '$RECYCLE.BIN', 'overlay2']) {
    assert.ok(DEFAULT_PATTERNS.includes(need), `默认规则缺少 ${need}`);
  }
  assert.ok(!DEFAULT_PATTERNS.includes('@*'), '默认规则不应使用 @* (会误伤用户 @ 目录)');
});

test('空规则 = 不排除任何东西(用户显式清空)', () => {
  const m = compileMatcher([]);
  assert.ok(!m('/vol3/@appcenter/x/y.js', false), '清空后不应排除任何路径');
  const m2 = compileMatcher(['', '   ', '# 注释行']);
  assert.ok(!m2('/vol1/a/b.txt', false), '空白与注释行应被忽略');
});

test('规则文件缺失/损坏时回落到默认规则, 绝不中断扫描', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-'));
  try {
    assert.deepEqual(loadPatterns(dir), DEFAULT_PATTERNS, '文件缺失应返回默认规则');
    fs.writeFileSync(path.join(dir, 'scan_exclude.json'), '{ 这不是合法 JSON');
    assert.deepEqual(loadPatterns(dir), DEFAULT_PATTERNS, '文件损坏应返回默认规则');
    fs.writeFileSync(path.join(dir, 'scan_exclude.json'), JSON.stringify({ patterns: ['自定义目录'] }));
    assert.deepEqual(loadPatterns(dir), ['自定义目录'], '合法自定义规则应生效');
    fs.writeFileSync(path.join(dir, 'scan_exclude.json'), JSON.stringify({ patterns: [] }));
    assert.deepEqual(loadPatterns(dir), [], '显式空数组应表示"不排除"');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('两个扫描器都在遍历阶段接入排除, 并上报计数', () => {
  for (const [name, src] of [['dup_scan.js', dupScan], ['simdup_scan.js', simScan]]) {
    assert.ok(/import \{ buildMatcher \} from '\.\/exclude_rules\.js'/.test(src), `${name} 未引入 buildMatcher`);
    assert.ok(/isExcluded\(/.test(src), `${name} 未调用 isExcluded`);
  }
  // 必须在 readdir 之后、stat 之前剪枝, 否则省不掉元数据开销
  const iRead = dupScan.indexOf('readdirSync(dir');
  const iExcl = dupScan.indexOf('isExcluded(fp');
  const iStat = dupScan.indexOf('st = statSync(fp)');
  assert.ok(iRead < iExcl && iExcl < iStat, '排除判断必须夹在 readdir 与 stat 之间');
  assert.ok(/state\.stats\.excluded = excludedCount/.test(dupScan), 'dup 未上报 excluded');
  assert.ok(/stats\.scanned = allFiles\.length/.test(dupScan), 'dup 未上报 scanned');
  assert.ok(/excluded: _excluded/.test(simScan), 'simdup 未上报 excluded');
});

test('规则读写 API: 路由、校验、落盘位置', () => {
  assert.ok(srvSrc.includes("path === '/api/dup/exclude-rules'"), '未注册 exclude-rules 路由');
  assert.ok(srvSrc.includes("method === 'GET' && path === '/api/dup/exclude-rules'"), '缺 GET 路由');
  assert.ok(srvSrc.includes("method === 'POST' && path === '/api/dup/exclude-rules'"), '缺 POST 路由');
  const body = apiSrc.slice(apiSrc.indexOf('// ── 扫描排除规则 (P1-1) ─'));
  assert.ok(/Array\.isArray\(data\.patterns\)/.test(body), '未校验 patterns 为数组');
  assert.ok(/400/.test(body), '非法输入未返回 400');
  assert.ok(/\.tmp/.test(body) && /renameSync/.test(body), '未用 tmp+rename 原子写');
  assert.ok(/'data', 'scan_exclude\.json'/.test(body), '规则文件位置不对');
});

test('UI: 折叠面板 + 保存/恢复默认, 且用 window 导出(inline onclick 需挂 window)', () => {
  assert.ok(/id="dupExcludeBox"/.test(html), '缺少折叠容器');
  assert.ok(/id="dupExcludePatterns"/.test(html), '缺少规则编辑框');
  assert.ok(/saveDupExcludeRules\(\)/.test(html), '缺少保存按钮');
  assert.ok(/resetDupExcludeRules\(\)/.test(html), '缺少恢复默认按钮');
  // 项目约定: inline onclick 依赖的函数必须进 const exports 块(由 Object.assign(window,exports) 挂出),
  // 单独写 window.X = X 不符合约定, test_api.js 会判失败。
  const expBlock = mainSrc.slice(mainSrc.indexOf('const exports'));
  for (const fn of ['saveDupExcludeRules', 'resetDupExcludeRules']) {
    assert.ok(new RegExp(`(?:^|\\n|,\\s*|\\s)${fn}\\s*[,}]`).test(expBlock),
      `${fn} 未进 const exports 块(inline onclick 会静默失效)`);
  }
  // 懒加载: 展开时才读, 避免每次进页面都发请求
  assert.ok(/box\.addEventListener\('toggle'/.test(mainSrc), '未在展开时才加载');
});

// node --check 不校验 import 路径, 曾因此导致 server 启动即崩
test('全项目相对 import 路径均可解析(防 ERR_MODULE_NOT_FOUND 回归)', () => {
  const bad = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) {
        const t = fs.readFileSync(f, 'utf8');
        for (const m of t.matchAll(/from '(\.[^']+)'/g)) {
          const rp = path.resolve(path.dirname(f), m[1]);
          if (!fs.existsSync(rp)) bad.push(`${path.relative(ROOT, f)} -> ${m[1]}`);
        }
      }
    }
  };
  walk(path.join(ROOT, 'app'));
  assert.deepEqual(bad, [], `以下相对 import 无法解析:\n${bad.join('\n')}`);
});
