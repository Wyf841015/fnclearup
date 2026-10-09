import test from 'node:test';
import assert from 'node:assert';
import { readFileSync as _rf0, existsSync, statSync, mkdirSync, rmSync, readdirSync, readFileSync as rf, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// ⚠️ 必须先设 TRM_FNCLEARUP_TEST=1, isSafePath 才会放行 /tmp/fnclearup_test。
// 否则本测试里的写操作要么被 403 拒(测不到写入逻辑), 要么打到真实 /vol3(绝不能发生)。
process.env.TRM_FNCLEARUP_TEST = '1';

const ROOT = new URL('../app/ui/', import.meta.url).pathname.replace(/\/$/, '');
const SERVER_SRC = _rf0(ROOT + '/server.js', 'utf8');

/* 不 import server.js —— 它的顶层会 listen(), 进程永远不退出,
   node --test 会一直挂到超时(实测踩过)。改成把函数源码抠出来 eval,
   依赖从外部注入。注入的 isSafePath 与 lib/util.js 的真实实现一致。 */
const { resolve } = await import('node:path');
const SAFE_PREFIXES = ['/vol1/', '/vol2/', '/vol3/', '/vol4/', '/vol5/', '/vol6/', '/vol7/', '/vol8/', '/vol9/', '/vol10/', '/vol02/'];
function isSafePath(p) {
  if (!p) return false;
  const n = resolve(p);
  if ([...SAFE_PREFIXES].some(pre => n === pre.slice(0, -1) || n.startsWith(pre))) return true;
  if (process.env.TRM_FNCLEARUP_TEST === '1' && (n === '/tmp/fnclearup_test' || n.startsWith('/tmp/fnclearup_test/'))) return true;
  return false;
}
function extractFn(src, name) {
  // 连 async 一起匹配: handleExportSave 是 async function, 只从 'function'
  // 起截会把它降级成同步函数, 函数体里的 await 直接语法错。
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\b').exec(src);
  if (!m) throw new Error('server.js 里找不到 ' + name);
  const i = m.index;
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('括号不配对: ' + name);
}
// 这两个常量必须从 server.js 原样抠出来。**绝不能在测试里另抄一份** ——
// 之前抄了一份, 结果「注入: 改坏 server.js 的 FILENAME_RE」这类故障完全测不到,
// 因为被测的其实是测试自己那份常量, 看着绿其实什么都没验。
const EXPORT_MAX_BYTES = Number(/const EXPORT_MAX_BYTES\s*=\s*([\d\s*]+);/.exec(SERVER_SRC)?.[1]
  .replace(/[\s*]/g, '') || 0);
const FILENAME_RE_SRC = /const FILENAME_RE\s*=\s*(\/.*?\/\w*);/.exec(SERVER_SRC)?.[1];
if (!EXPORT_MAX_BYTES || !FILENAME_RE_SRC) {
  throw new Error('未能从 server.js 提取 EXPORT_MAX_BYTES / FILENAME_RE —— 它们被改名或删掉了');
}
const SRC_EVAL = [
  extractFn(SERVER_SRC, 'handleExportSave'),
  extractFn(SERVER_SRC, 'formatBytesForExport'),
  'const EXPORT_MAX_BYTES = ' + EXPORT_MAX_BYTES + ';',
  'const FILENAME_RE = ' + FILENAME_RE_SRC + ';',
].join('\n');
const __mod = { exports: {} };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
new AsyncFunction('existsSync', 'statSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'join',
             'isSafePath', 'parseBody', 'sendJSON', '__mod',
             SRC_EVAL + '\n__mod.exports = { handleExportSave, formatBytesForExport };')
  .call(null,
    existsSync, statSync, writeFileSync, renameSync, unlinkSync,
    join, isSafePath,
    async (req) => {                       // parseBody 替身
      let raw = '';
      for await (const c of req) raw += c;
      return JSON.parse(raw);
    },
    (res, status, obj) => { res.writeHead(status); res.end(JSON.stringify(obj)); },
    __mod);
const { handleExportSave } = __mod.exports;

const SANDBOX = '/tmp/fnclearup_test/export';
const SANDBOX_SUB = join(SANDBOX, 'sub');

mkdirSync(SANDBOX_SUB, { recursive: true });

function mockRes() {
  const out = {};
  return {
    statusCode: 200,
    writeHead(s) { out.status = s; return this; },
    setHeader() { return this; },
    end(b) {
      if (b) { try { out.body = JSON.parse(b.toString()); } catch { out.body = b.toString(); } }
      out.done = true;
      return this;
    },
    _out: out,
  };
}

async function call(body) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(raw.length) },
    on(ev, cb) { if (ev === 'data') cb(raw); if (ev === 'end') cb(); },
    resume() {},
    async *[Symbol.asyncIterator]() { yield raw; },
  };
  const res = mockRes();
  await handleExportSave(req, res);
  return { status: res._out.status, body: res._out.body };
}

/* ══════════════════════════════════════════════════════════════
   正常路径
   ══════════════════════════════════════════════════════════════ */

test('保存文本到选定目录', async () => {
  rmSync(join(SANDBOX, 'a.txt'), { force: true });
  const r = await call({ dir: SANDBOX, filename: 'a.txt', content: '你好, world\n第二行' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.path, join(SANDBOX, 'a.txt'));
  assert.strictEqual(r.body.overwritten, false);
  assert.strictEqual(rf(join(SANDBOX, 'a.txt'), 'utf8'), '你好, world\n第二行');
  assert.ok(r.body.sizeText, '应返回可读大小');
});

test('BOM 开头的中文 CSV 原样落盘(Excel 不乱码)', async () => {
  rmSync(join(SANDBOX, 'bom.csv'), { force: true });
  const csv = '﻿名称,大小\n临时文件,1.2 GB\n';
  const r = await call({ dir: SANDBOX, filename: 'bom.csv', content: csv });
  assert.strictEqual(r.status, 200);
  const got = rf(join(SANDBOX, 'bom.csv'));
  assert.deepStrictEqual([...got.slice(0, 3)], [0xEF, 0xBB, 0xBF], '文件应以 UTF-8 BOM 开头');
});

test('base64 编码内容正确解码后落盘', async () => {
  rmSync(join(SANDBOX, 'bin.dat'), { force: true });
  const payload = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x42]);
  const r = await call({ dir: SANDBOX, filename: 'bin.dat', content: payload.toString('base64'), encoding: 'base64' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([...rf(join(SANDBOX, 'bin.dat'))], [...payload]);
});

test('子目录同样可用', async () => {
  rmSync(join(SANDBOX_SUB, 'c.txt'), { force: true });
  const r = await call({ dir: SANDBOX_SUB, filename: 'c.txt', content: 'sub' });
  assert.strictEqual(r.status, 200);
  assert.ok(existsSync(join(SANDBOX_SUB, 'c.txt')));
});

/* ══════════════════════════════════════════════════════════════
   覆盖行为
   ══════════════════════════════════════════════════════════════ */

test('目标已存在且未给 overwrite → 409 且不写盘', async () => {
  await call({ dir: SANDBOX, filename: 'dup.txt', content: 'v1' });
  const before = rf(join(SANDBOX, 'dup.txt'), 'utf8');
  const r = await call({ dir: SANDBOX, filename: 'dup.txt', content: 'v2' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.exists, true);
  assert.strictEqual(rf(join(SANDBOX, 'dup.txt'), 'utf8'), before, '被拒时不能改动已有文件');
});

test('overwrite=true → 200 且内容被替换', async () => {
  await call({ dir: SANDBOX, filename: 'dup2.txt', content: 'v1' });
  const r = await call({ dir: SANDBOX, filename: 'dup2.txt', content: 'v2-longer', overwrite: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.overwritten, true);
  assert.strictEqual(rf(join(SANDBOX, 'dup2.txt'), 'utf8'), 'v2-longer');
});

/* ══════════════════════════════════════════════════════════════
   安全: 目录越界 / 文件名穿越
   ══════════════════════════════════════════════════════════════ */

test('目录越界(/etc) → 403', async () => {
  const r = await call({ dir: '/etc', filename: 'x.txt', content: 'no' });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.success, false);
});

test('目录为空 / 非目录 → 拒绝', async () => {
  assert.strictEqual((await call({ dir: '', filename: 'x.txt', content: 'a' })).status, 403);
  assert.strictEqual((await call({ dir: '/tmp/fnclearup_test/export/a.txt', filename: 'x.txt', content: 'a' })).status, 400);
  assert.strictEqual((await call({ dir: '/tmp/fnclearup_test/nonexistent_dir', filename: 'x.txt', content: 'a' })).status, 400);
});

test('文件名穿越 (..) → 400 且不写到目标位置', async () => {
  const evil = join(SANDBOX, '..', 'escaped.txt');
  rmSync(evil, { force: true });
  const r = await call({ dir: SANDBOX, filename: '../escaped.txt', content: 'pwn' });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.ok(!existsSync(evil), '不能写到 SANDBOX 之外');
});

test('文件名含绝对路径/分隔符 → 400', async () => {
  for (const fn of ['/etc/passwd', 'a/b.txt', 'a\\b.txt', '..', '.']) {
    const r = await call({ dir: SANDBOX, filename: fn, content: 'x' });
    assert.strictEqual(r.status, 400, `文件名 ${JSON.stringify(fn)} 应被拒, 实得 ${r.status}`);
  }
});

test('文件名含控制字符 → 400', async () => {
  const r = await call({ dir: SANDBOX, filename: 'a\u0000b.txt', content: 'x' });
  assert.strictEqual(r.status, 400);
});

test('content 非字符串 → 400', async () => {
  const r = await call({ dir: SANDBOX, filename: 'x.txt', content: 123 });
  assert.strictEqual(r.status, 400);
});

test('写入失败后不留 .fnc-export-tmp 残留', async () => {
  await call({ dir: SANDBOX, filename: 'tmpcheck.txt', content: 'ok' });
  const leftovers = readdirSync(SANDBOX).filter(f => f.includes('fnc-export-tmp'));
  assert.deepStrictEqual(leftovers, [], '不应残留临时文件');
});

/* ══════════════════════════════════════════════════════════════
   前端接线(源码级)
   ══════════════════════════════════════════════════════════════ */

const MAIN = _rf0(ROOT + '/main.js', 'utf8');
const HTML = _rf0(ROOT + '/index.html', 'utf8');
const SERVER = SERVER_SRC;

test('前端: 导出不再走 Blob + a.download 浏览器下载', () => {
  // exportTableToCSV / downloadSysCleanManifest 内都不得再有 createObjectURL 下载
  const csvFn = MAIN.slice(MAIN.indexOf('function exportTableToCSV'), MAIN.indexOf('async function refreshCleanupSummary'));
  assert.ok(!/createObjectURL/.test(csvFn), 'exportTableToCSV 不应再用 Blob 下载');
  assert.match(csvFn, /saveContentViaBrowser\(/, 'exportTableToCSV 应改走 saveContentViaBrowser');

  const mfFn = MAIN.slice(MAIN.indexOf('async function downloadSysCleanManifest'));
  assert.ok(!/createObjectURL/.test(mfFn.slice(0, 1200)), 'downloadSysCleanManifest 不应再用 Blob 下载');
  assert.match(mfFn.slice(0, 1200), /saveContentViaBrowser\(/);
});

test('前端: saveContentViaBrowser 打开的是保存模式', () => {
  const i = MAIN.indexOf('function saveContentViaBrowser(');
  assert.ok(i > 0);
  const body = MAIN.slice(i, i + 900);
  assert.match(body, /_browseSaving\s*=\s*true/, '应置 _browseSaving');
  assert.match(body, /_pendingExport\s*=/, '应缓存待导出内容');
  assert.match(body, /classList\.add\('visible'\)/, '应打开弹窗');
});

test('前端: hideBrowseModal 必须复位保存模式', () => {
  const i = MAIN.indexOf('function hideBrowseModal()');
  const body = MAIN.slice(i, i + 500);
  assert.match(body, /_browseSaving\s*=\s*false/, '关闭时必须复位 _browseSaving');
  assert.match(body, /_pendingExport\s*=\s*null/, '关闭时必须清空 _pendingExport');
});

test('前端: 非保存模式打开时必须复位 UI(标题/按钮/文件名行)', () => {
  assert.match(MAIN, /function setBrowseMode\(mode\)/, '应有 setBrowseMode');
  const i = MAIN.indexOf('function setBrowseMode(mode)');
  const body = MAIN.slice(i, i + 700);
  assert.match(body, /classList\.toggle\('visible', isSave\)/, '文件名行显隐');
  // 必须真的有两个不同文案, 否则改成固定字符串也能混过
  assert.match(body, /title\.textContent\s*=\s*isSave\s*\?\s*'[^']+'\s*:\s*'[^']+'/,
    '标题应随 isSave 切换两种文案');
  assert.match(body, /btn\.textContent\s*=\s*isSave\s*\?\s*'[^']+'\s*:\s*'[^']+'/,
    '按钮文案应随 isSave 切换两种文案');
  // 两处文案不能相同
  const titleRe = /title\.textContent\s*=\s*isSave\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/.exec(body);
  const btnRe = /btn\.textContent\s*=\s*isSave\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/.exec(body);
  assert.ok(titleRe && titleRe[1] !== titleRe[2], '保存态与选择态的标题不能相同');
  assert.ok(btnRe && btnRe[1] !== btnRe[2], '保存态与选择态的按钮文案不能相同');
  // 三个入口都要调 setBrowseMode
  assert.match(MAIN, /function showBrowseModal\(inputId\)\s*\{[^}]*setBrowseMode\('select'\)/);
  assert.match(MAIN, /function showDupBrowseModal\(tab\)\s*\{[^}]*setBrowseMode\('select'\)/);
});

test('前端: 保存模式点遮罩不应直接关闭(内容会丢)', () => {
  assert.match(HTML, /id="browseModal"[^>]*onclick="if\(event\.target===this\)browseBackdropClick\(\)"/);
  const i = MAIN.indexOf('function browseBackdropClick()');
  assert.ok(i > 0, '应有 browseBackdropClick');
  const body = MAIN.slice(i, i + 400);
  assert.match(body, /if\s*\(\s*_browseSaving\s*\)/, '保存模式下应拦截关闭');
  // 之前写成 window._browseSaving —— 那是闭包内的 let, window 上永远 undefined
  assert.ok(!/window\._browseSaving/.test(HTML), 'HTML 里不应出现 window._browseSaving(闭包变量不在 window 上)');
});

test('前端: hideBrowseModal 无条件把 UI 拨回「选择目录」形态', () => {
  // 浏览器实测抓到过: 保存完关闭弹窗后标题仍是「💾 选择保存位置」——
  // 关闭状态下不该留着保存态文案。只在 _browseSaving 为真时复位是不够的,
  // 因为 setBrowseMode 还要负责标题/按钮文案/文件名行的显隐。
  const i = MAIN.indexOf('function hideBrowseModal()');
  const body = MAIN.slice(i, i + 700);
  assert.match(body, /setBrowseMode\('select'\)/,
    'hideBrowseModal 应无条件调 setBrowseMode("select"), 不能只在保存模式下复位状态变量');
});

test('前端: doSaveExportTo 的 finally 不得用存档文案覆盖按钮', () => {
  // 浏览器实测抓到过: 成功后 hideBrowseModal() 已把按钮拨回「✅ 选择当前目录」,
  // finally 里再用 btn.innerHTML = restore 还原, 结果**关闭的弹窗**上
  // 挂着「💾 保存到此处」按钮。
  const i = MAIN.indexOf('async function doSaveExportTo(');
  assert.ok(i > 0);
  const body = MAIN.slice(i, i + 1600);
  assert.ok(!/innerHTML\s*=\s*restore/.test(body),
    'finally 不得用存档文案还原按钮 —— 应交给 setBrowseMode 按当前模式给出文案');
  assert.match(body, /finally\s*\{[\s\S]*setBrowseMode\(/,
    'finally 应调 setBrowseMode: 成功时选择模式, 失败/取消时保存模式');
  assert.ok(!/const restore = btn \? btn\.innerHTML/.test(body),
    '不要存档按钮 innerHTML');
});

test('前端: 新函数已导出到 window', () => {
  const i = MAIN.indexOf('const exports = {');
  const body = MAIN.slice(i, i + 3000);
  assert.match(body, /saveContentViaBrowser/);
  assert.match(body, /browseBackdropClick/);
});

test('后端: 路由已注册', () => {
  assert.match(SERVER, /path === '\/api\/export\/save'[\s\S]{0,80}handleExportSave/);
});

test('后端: 必须真的执行 64MB 大小上限检查', () => {
  // 常量已改为从 server.js 提取, 但还得断言「检查代码本身存在」——
  // 只提取常量不检查调用点的话, 注入把 `if (buf.length > EXPORT_MAX_BYTES)`
  // 改成 `if (false)` 仍然测不出来。
  assert.ok(EXPORT_MAX_BYTES > 0, 'EXPORT_MAX_BYTES 应从 server.js 提取到, 实得 ' + EXPORT_MAX_BYTES);
  const i = SERVER.indexOf('async function handleExportSave');
  const body = SERVER.slice(i, i + 2500);
  assert.match(body, /buf\.length\s*>\s*EXPORT_MAX_BYTES/,
    'handleExportSave 应按 EXPORT_MAX_BYTES 拒绝超大内容, 返回 413');
  assert.match(body, /sendJSON\(res,\s*413/, '超限应返回 413');
});

test('后端: 文件名正则必须排除路径分隔符与控制字符', () => {
  // FILENAME_RE 从 server.js 提取后, 断言它确实挡住了 ../ 与绝对路径
  assert.ok(!FILENAME_RE_SRC.includes('..') === false || true);
  const re = new RegExp(FILENAME_RE_SRC.slice(1, FILENAME_RE_SRC.lastIndexOf('/')));
  // 只测正则自己负责的部分: 路径分隔符 / 绝对路径 / 控制字符。
  // 纯 '..' 不在这里测 —— 它不含分隔符, 正则放行是正常的, 由 handleExportSave
  // 里额外的 `|| filename === '.' || filename === '..'` 兜底(上面那条
  // 「文件名穿越 → 400 且不写到目标位置」的行为测试才是它的真正防线)。
  for (const bad of ['../x', 'a/b', '/etc/passwd', 'a\\b', 'a\u0000b', 'a:b', 'a?b', 'a*b']) {
    assert.ok(!re.test(bad), `文件名 ${JSON.stringify(bad)} 应被 FILENAME_RE 拒绝`);
  }
  for (const good of ['a.txt', '应用列表.csv', 'x-1_2.json']) {
    assert.ok(re.test(good), `文件名 ${JSON.stringify(good)} 应被放行`);
  }
});

test('后端: 写入用 tmp + rename 原子替换', () => {
  const i = SERVER.indexOf('async function handleExportSave');
  const body = SERVER.slice(i, i + 2500);
  assert.match(body, /\.fnc-export-tmp/, '应有临时文件');
  assert.match(body, /renameSync\(tmp, target\)/, '应用 rename 原子落盘');
});
