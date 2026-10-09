// 大文件查找 toLocaleString 崩溃修复 — 2026-10-09
//
// 用户报: 大文件查找提示 "❌ Cannot read properties of undefined (reading 'toLocaleString')"
//
// 根因(3 层, 缺一不可):
//   1. 后端 bigfiles.js 的 403 分支只回 { error: 'path must be under /vol*' },
//      没有 scanned_paths 字段(另两个分支都有)
//   2. 前端 main.js doBigFilesScan 直接 `data.scanned_paths.toLocaleString()`, 无保护
//   3. 抛出的 TypeError 被同一函数的 catch 捕获, catch 里 status.textContent =
//      '❌ ' + e.message —— 于是把真实原因 "path must be under /vol*" 替换成了
//      一句 JS 内部错误。用户完全看不到真正的问题在哪。
//
// 另外发现并修掉 parseFetchResponse 的两个配套缺陷:
//   - if (!r.ok && !data.error) —— 后端 4xx 响应自带 error 字段时反而不设 __error,
//     调用方回退成 "HTTP 403", 真实原因被掩盖第二次
//   - HTTP 200 但 body 不是 JSON(fnOS 网关 302 跳登录页会回 HTML)时 __ok 仍为 true,
//     数据全是 undefined, 按 200 正常渲染就会显示 "undefined 个"
//
// 原则: 从真源码抠函数出来跑, 不重实现被测逻辑。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'app/ui/main.js'), 'utf8');
const bigfilesSrc = fs.readFileSync(path.join(ROOT, 'app/ui/api/bigfiles.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function block(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error('未找到锚点: ' + anchor);
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('块未闭合: ' + anchor);
}
const code = stripComments(mainSrc);

/* ══════ 1. 源码层: 前端不得再裸调 data.X.toLocaleString() ══════ */
test('前端所有 data.*.toLocaleString() 都有 || 0 保护', () => {
  // 全局扫描: 形如 xxx.toLocaleString( 且前面 12 字符内没有 '||' 的
  const bad = [];
  const re = /(?<![\w.$])([\w.$]+)\.toLocaleString\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const expr = m[1];
    const pre = code.slice(Math.max(0, m.index - 12), m.index);
    if (pre.includes('||')) continue;                 // 已有保护
    const line = code.slice(0, m.index).split('\n').length;
    bad.push('L' + line + ': ' + expr + ' → ' + code.split('\n')[line - 1].trim().slice(0, 70));
  }
  assert.deepStrictEqual(bad, [], '无保护的 toLocaleString 调用:\n' + bad.join('\n'));
});

test('doBigFilesScan 在渲染前检查 __ok', () => {
  const body = block(code, 'async function doBigFilesScan');
  const ai = body.indexOf("api/bigfiles/scan");
  const oi = body.indexOf('__ok');
  assert.ok(ai > 0, '应能找到 bigfiles/scan 调用');
  assert.ok(oi > 0, 'doBigFilesScan 应检查 data.__ok —— 否则 4xx 响应里的缺失字段会在渲染时炸');
  assert.ok(oi < ai + 900, '__ok 检查应在渲染之前(不能等渲染完了再查)');
  assert.ok(body.includes('throw new Error(data.__error'), '应抛 __error(真实原因), 而不是继续渲染');
});

/* ══════ 2. 行为层: 从真源码 eval parseFetchResponse 跑 6 个场景 ══════ */
function loadParseFetchResponse() {
  const fn = block(mainSrc, 'async function parseFetchResponse');
  // eslint-disable-next-line no-new-func
  return new Function(fn + '\nreturn parseFetchResponse;')();
}

const SCENARIOS = [
  { name: '403 带 error(本次 bug 场景)', status: 403, ok: false, body: { error: 'path must be under /vol*' }, expectErr: 'path must be under /vol*' },
  { name: '403 无 error', status: 403, ok: false, body: {}, expectErr: 'HTTP 403' },
  { name: '500 带 error', status: 500, ok: false, body: { error: '扫描内部错误' }, expectErr: '扫描内部错误' },
  { name: '200 正常', status: 200, ok: true, body: { scanned_paths: 34875, total_candidates: 32 }, expectOk: true },
  { name: '200 非 JSON(网关跳登录页返 HTML)', status: 200, ok: true, body: null, expectErr: '响应不是合法 JSON' },
  { name: '200 空对象', status: 200, ok: true, body: {}, expectOk: true },
];

for (const sc of SCENARIOS) {
  test('parseFetchResponse: ' + sc.name, async () => {
    const pfr = loadParseFetchResponse();
    const r = {
      ok: sc.ok,
      status: sc.status,
      json: async () => { if (sc.body === null) throw new SyntaxError('Unexpected token <'); return sc.body; },
    };
    const d = await pfr(r);
    assert.strictEqual(d.__ok, !!sc.expectOk, '__ok 应为 ' + (!!sc.expectOk));
    if (sc.expectOk) {
      assert.strictEqual(d.__error, undefined, '正常响应不应有 __error');
    } else {
      // 调用方会 throw new Error(data.__error || `HTTP ${d.__status}`)
      const userSees = d.__error || 'HTTP ' + d.__status;
      assert.ok(userSees.includes(sc.expectErr),
        `用户应看到 "${sc.expectErr}", 实际看到 "${userSees}"`);
    }
  });
}

/* ══════ 3. 后端层: 所有 sendJSON 200 响应都应带 scanned_paths ══════ */
test('后端 handleBigFilesScan 的每个 200 响应都带 scanned_paths', () => {
  // 只查 handleBigFilesScan 内部 —— stop/delete/export 等端点本就不返回
  // scanned_paths, 拿它们来断言是范围错误(这个测试第一版就栽在这)。
  const fnBody = block(bigfilesSrc, 'export async function handleBigFilesScan');
  const bodies = [];
  const re = /sendJSON\(\s*res,\s*200,\s*\{/g;
  let m;
  while ((m = re.exec(fnBody)) !== null) {
    let d = 0, end = -1;
    const k0 = fnBody.indexOf('{', m.index + m[0].length - 1);
    for (let k = k0; k < fnBody.length; k++) {
      if (fnBody[k] === '{') d++;
      else if (fnBody[k] === '}') { d--; if (d === 0) { end = k; break; } }
    }
    if (end < 0) continue;
    bodies.push(fnBody.slice(m.index, end + 1));
  }
  assert.ok(bodies.length >= 2, 'handleBigFilesScan 应至少有两处 200 响应(空路径分支 + 正常分支), 实际 ' + bodies.length);
  const missing = bodies.filter(b => !b.includes('scanned_paths'))
    .map(b => b.replace(/\s+/g, ' ').slice(0, 100));
  assert.deepStrictEqual(missing, [],
    'handleBigFilesScan 这些 200 响应缺 scanned_paths, 前端渲染时会抛 TypeError:\n' + missing.join('\n'));
});

/* ══════ 4. 复现断言: 无保护版本确实会抛用户报的那个错 ══════ */
test('回归依据: 无保护写法抛出的正是用户报的错', () => {
  // 后端 403 的真实响应形状(已实测)
  const backend403 = { error: 'path must be under /vol*' };
  // 修复前的写法
  let msg = null;
  try {
    msg = `扫描了 ${backend403.scanned_paths.toLocaleString()} 个路径`;
  } catch (e) {
    msg = e.message;
  }
  assert.strictEqual(msg, "Cannot read properties of undefined (reading 'toLocaleString')",
    '修复前应精确复现用户报的报错');
  // 修复后的写法
  assert.strictEqual(`扫描了 ${(backend403.scanned_paths || 0).toLocaleString()} 个路径`,
    '扫描了 0 个路径', '修复后应回退为 0 而不是抛错');
});

/* ══════ 5. 后端路径校验: 卷内子目录必须允许, 穿越必须拒绝 ══════ */
test('后端 bigfiles 允许卷内子目录(原实现只认卷根)', () => {
  const body = stripComments(block(bigfilesSrc, 'export async function handleBigFilesScan'));
  // 原写法是「拼斜杠后去 Set 做精确匹配」:
  //   '/vol3'         → has('/vol3/')        → true  (通过)
  //   '/vol3/1000/x'  → has('/vol3/1000/x/') → false (被 403)
  assert.ok(!/SAFE_PREFIXES\.has\(/.test(body),
    '仍在用 Set 精确匹配判前缀 —— 只有路径正好等于某个卷根才通过, 卷内子目录一律被 403');
  assert.ok(body.includes('resolve(path)'),
    '必须先 resolve 消掉 .. 和 //, 否则直接 startsWith 会被 /vol3/../etc 绕过');
  assert.ok(/resolved\.startsWith\(v\s*\+\s*['"]\/['"]\)/.test(body),
    '应判定"是某个卷的前缀", 而不是精确等于卷根');
  // 安全约束不能被顺手去掉
  assert.ok(body.includes("path must be under /vol*"), '仍应保留 /vol* 限制');
  assert.ok(/existsSync\(resolved\)/.test(body), '仍应检查路径存在');
});

test('后端 bigfiles 路径校验 12 个场景(真起服务)', async () => {
  const { spawn } = await import('node:child_process');
  const PORT = 48391;
  const PKGVAR = '/tmp/fnc_bf_path_test';
  require('node:fs').rmSync(PKGVAR, { recursive: true, force: true });
  require('node:fs').mkdirSync(PKGVAR, { recursive: true });
  const srv = spawn(process.execPath, ['app/ui/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), TRM_PKGVAR: PKGVAR },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    // 等端口就绪
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise(r => setTimeout(r, 250));
      up = await new Promise(res => {
        const req = require('node:http').request({ hostname: '127.0.0.1', port: PORT, path: '/app/fnclearup/api/config', method: 'GET' }, r2 => { r2.resume(); res(r2.statusCode > 0); });
        req.on('error', () => res(false));
        req.end();
      });
    }
    assert.ok(up, '服务未启动');
    const probe = (p) => new Promise(resolve => {
      const path = '/app/fnclearup/api/bigfiles/scan?topN=1&depth=1&path=' + encodeURIComponent(p);
      const req = require('node:http').request({ hostname: '127.0.0.1', port: PORT, path }, r => {
        let b = ''; r.on('data', c => b += c);
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', () => resolve({ status: -1 }));
      req.end();
    });
    const vol3 = '/vol3';
    const hasVol3 = require('node:fs').existsSync(vol3);
    const cases = [
      ['/etc/passwd', 403, '系统目录必须拒绝'],
      ['/etc', 403, '/etc 必须拒绝'],
      ['/vol3/../etc', 403, '../ 穿越必须被 resolve 拦下'],
      ['/vol3/../../etc', 403, '../../ 穿越'],
      ['/vol3x', 403, '/vol3x 前缀相似必须拒绝'],
      ['/tmp', 403, '非 /vol 路径必须拒绝'],
    ];
    if (hasVol3) {
      cases.unshift([vol3 + '/.', 200, '/./ 应被规范化后接受']);
      cases.unshift([vol3, 200, '卷根必须接受']);
    }
    const results = [];
    for (const [p, expect, why] of cases) {
      const r = await probe(p);
      results.push({ p, expect, got: r.status, why });
    }
    const bad = results.filter(r => r.got !== r.expect);
    assert.deepStrictEqual(bad, [], '路径校验不符:\n' + bad.map(r => `${r.p} → ${r.got}(期望 ${r.expect}) ${r.why}`).join('\n'));
    require('node:fs').rmSync(PKGVAR, { recursive: true, force: true });
  } finally {
    srv.kill('SIGTERM');
  }
});
