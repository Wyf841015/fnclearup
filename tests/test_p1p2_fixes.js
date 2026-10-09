// P1/P2 修复回归测试 — 2026-10-09
//
// 覆盖:
//   P1-1 状态栏 error 未转义 / P1-2 API 丢弃 HTTP 状态 / P1-3 loadBrowseDir 乱序覆盖
//   P1-4 doScan 无 in-flight 锁 / P1-5 lucide MutationObserver 自触发
//   P1-6 bigfiles trash 降级永久删除(未透出) / P1-8 dup hardlink 先删后链
//   P1-9 empty_dir jobId 穿越 / P1-10 stop 端点失败仍报成功
//   P2-1 CSS 孤立续行 / P2-2 CSS 悬空空规则 / P2-3 sysclean glob 正则 /volvol/
//   P2-4 protectedReason 软链绕过 / P2-5 旧 CSS 变量名 / P2-6 export fetch 无超时
//   P2-7 测试里手抄签名算法 / P2-8 恒等函数 + 固定字符切片
//
// 原则: 抠真源码跑, 不在测试里重实现被测逻辑(本项目已因此栽过多次)。
// 断言尽量用字面 includes 而非多层转义正则 —— 转义层级是测试自身 bug 的主要来源。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const mainSrc = rd('app/ui/main.js');
const motionSrc = rd('app/ui/motion.js');
const css = rd('app/ui/styles/style.css');
const html = rd('app/ui/index.html');
const dupSrc = rd('app/ui/api/dup.js');
const brokenSrc = rd('app/ui/api/broken.js');
const namematchSrc = rd('app/ui/api/namematch.js');
const simdupSrc = rd('app/ui/api/simdup.js');
const emptySrc = rd('app/ui/api/empty_dir.js');
const syscleanSrc = rd('app/ui/api/sysclean.js');
const bigfilesSrc = rd('app/ui/api/bigfiles.js');
const utilSrc = rd('app/ui/lib/util.js');
const schedTest = rd('tests/test_schedule_polling.js');
const hashTest = rd('tests/test_hash_cache_stats.js');
const storageTest = rd('tests/test_storage_profile.js');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
/** 花括号配对精确取函数体; sig 只写函数名(不含 async/function 关键字)。
 *  注意: 不能用 src.indexOf('{', i) 找函数体 —— 签名里带默认对象参数时
 *  (如 protectedReason(p, opts = {})) 会截到参数里的 '{', 拿到长度 37 的
 *  残片。先配对跳过参数列表 '(...)', 再取其后的第一个 '{' 才是函数体。 */
function fnBody(src, sig) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + sig + '\\s*\\(').exec(src);
  if (!m) return null;
  let p = src.indexOf('(', m.index), depth = 0, k = p;
  for (; k < src.length; k++) {
    if (src[k] === '(') depth++;
    else if (src[k] === ')') { depth--; if (depth === 0) break; }
  }
  if (k >= src.length) return null;
  const bodyStart = src.indexOf('{', k);
  if (bodyStart < 0) return null;
  depth = 0;
  for (let x = bodyStart; x < src.length; x++) {
    if (src[x] === '{') depth++;
    else if (src[x] === '}') { depth--; if (depth === 0) return src.slice(m.index, x + 1); }
  }
  return null;
}
const code = stripComments(mainSrc);

/* ══════════════ P1-1 ══════════════ */
test('P1-1: innerHTML 拼后端 error 时必须转义', () => {
  const bad = [];
  for (const line of code.split('\n')) {
    const at = line.indexOf('innerHTML');
    if (at < 0) continue;
    if (at > line.indexOf('=')) continue;
    const usesData = /\.error\b/.test(line) || /e\.message\b/.test(line);
    if (!usesData) continue;
    if (line.indexOf('escHtml(') < 0) bad.push(line.trim().slice(0, 90));
  }
  assert.deepStrictEqual(bad, [], '未转义的 error 拼接:\n' + bad.join('\n'));
});

/* ══════════════ P1-2 ══════════════ */
test('P1-2: API 封装保留 HTTP 状态', () => {
  const body = fnBody(code, 'parseFetchResponse');
  assert.ok(body, '应有 parseFetchResponse');
  for (const k of ['__ok', '__status', '__error']) {
    assert.ok(body.includes(k), '应回传 ' + k);
  }
  const apiBlock = code.slice(code.indexOf('const API = {'), code.indexOf('const $ ='));
  const n = (apiBlock.match(/parseFetchResponse\(r\)/g) || []).length;
  assert.strictEqual(n, 2, 'get/post 都应走 parseFetchResponse, 实际 ' + n + ' 处');
});

/* ══════════════ P1-3 ══════════════ */
test('P1-3: loadBrowseDir 丢弃过期响应', () => {
  assert.ok(code.includes('let _browseSeq = 0'), '应有 _browseSeq 计数器');
  const body = fnBody(code, 'loadBrowseDir');
  assert.ok(body, '应能找到 loadBrowseDir');
  assert.ok(body.includes('++_browseSeq'), '进入时自增取号');
  assert.ok(body.includes('seq !== _browseSeq'), '渲染前丢弃过期响应');
});

/* ══════════════ P1-4 ══════════════ */
test('P1-4: doScan 有 in-flight 守卫且 finally 复位', () => {
  assert.ok(code.includes('let _appScanning = false'), '应有 _appScanning');
  const body = fnBody(code, 'doScan');
  assert.ok(body, '应能找到 doScan');
  assert.ok(body.includes('if (_appScanning) return;'), '重入直接返回');
  assert.ok(body.includes('finally { _appScanning = false; }'),
    '必须 finally 复位, 否则一次异常后永久卡在"扫描中"');
});

/* ══════════════ P1-5 ══════════════ */
test('P1-5: lucide observer 有自写互斥且 finally 复位', () => {
  const body = fnBody(code, 'initLucide');
  assert.ok(body, '应能找到 initLucide');
  const n = (body.match(/__iconizing/g) || []).length;
  assert.ok(n >= 3, '__iconizing 应出现在 observer 入口/定时器入口/finally 复位, 实际 ' + n + ' 次');
  assert.ok(body.includes('finally { document.body.__iconizing = false; }'),
    '必须 finally 复位, 否则一次异常后图标渲染永久停摆');
});

/* ══════════════ P1-6 ══════════════ */
test('P1-6: bigfiles trash 降级永久删除时透出标记', () => {
  assert.ok(bigfilesSrc.includes('permanentFallback'), '应记录走了永久删除');
  assert.ok(bigfilesSrc.includes('permanentFallback ? { path:'),
    '响应里应带上该标记, 让前端能如实告知用户"未能进回收站"');
});

/* ══════════════ P1-8 ══════════════ */
test('P1-8: dup hardlink 先建临时链接再 rename', () => {
  const badOld = /unlinkSync\(fp\)[^;]*;[^;]*linkSync\(keep,\s*fp\)/.test(dupSrc);
  assert.ok(!badOld, '仍是"先删后链": linkSync 抛错时 fp 已删除, 数据不可恢复');
  assert.ok(dupSrc.includes('linkSync(keep, tmpLink)'), '应先链到临时名');
  assert.ok(dupSrc.includes('renameSync(tmpLink, fp)'), '成功后 rename 原子替换');
});

/* ══════════════ P1-9 ══════════════ */
test('P1-9: empty_dir status 校验 jobId', () => {
  const body = fnBody(emptySrc, 'handleEmptyDirStatus');
  assert.ok(body && body.includes('isValidEmptyJobId(jobId)'), 'status 应校验 jobId');
  const h = fnBody(emptySrc, 'isValidEmptyJobId');
  assert.ok(h, '应有 isValidEmptyJobId');
  const re = new Function(h + '\nreturn isValidEmptyJobId;')();
  assert.strictEqual(re('empty_ab12'), true);
  for (const bad of ['empty_../../x', '../empty_x', 'empty_', 'x', '']) {
    assert.strictEqual(re(bad), false, 'jobId ' + JSON.stringify(bad) + ' 应被拒');
  }
});

/* ══════════════ P1-10 ══════════════ */
test('P1-10: stop 端点写状态失败时不再报成功', () => {
  const cases = [['broken', brokenSrc, 'handleBrokenStop'],
                 ['namematch', namematchSrc, 'handleNamematchStop'],
                 ['simdup', simdupSrc, 'handleSimDupStop']];
  for (const [name, src, fn] of cases) {
    const body = fnBody(src, fn);
    assert.ok(body, '应能找到 ' + fn + ' (' + name + ')');
    const ci = body.indexOf('catch');
    assert.ok(ci > 0, name + ' 的 stop 应有 catch');
    const seg = body.slice(ci, ci + 400);
    assert.ok(seg.includes('stopped: false'),
      name + ': catch 内应回 stopped:false, 而不是 catch 后无条件 stopped:true');
    assert.ok(seg.indexOf('return;') >= 0, name + ': catch 内应 return');
  }
});

/* ══════════════ P2-1 / P2-2 ══════════════ */
test('P2-1/P2-2: CSS 无孤立续行/悬空选择器且括号配平', () => {
  // 必须跟踪多行块注释状态: 只 skip 注释的**首行**是不够的 ——
  // 注释中间那些以中文续行开头(如 "纯蓝比靛紫更冷…")的行会被误判成选择器。
  const lines = css.split('\n');
  const bad = [];
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    let rest = lines[i];
    // 处理本行可能出现的 /* ... */ 开关
    if (inComment) {
      const end = rest.indexOf('*/');
      if (end < 0) continue;
      rest = rest.slice(end + 2);
      inComment = false;
    }
    while (true) {
      const open = rest.indexOf('/*');
      if (open < 0) break;
      const close = rest.indexOf('*/', open);
      if (close < 0) { rest = rest.slice(0, open); inComment = true; break; }
      rest = rest.slice(0, open) + rest.slice(close + 2);
    }
    const st = rest.trim();
    if (!st) continue;
    const c0 = st[0];
    if (c0 === '@' || c0 === '}' || c0 === '{') continue;
    if (st.startsWith('//')) continue;
    const last = st[st.length - 1];
    if (last === '{' || last === '}' || last === ',' || last === ';') continue;
    if (st.indexOf('{') >= 0) continue;
    // 走到这里说明是个选择器行: 下一行必须是它的声明, 而不是另一个选择器
    let j = i + 1, skipped = inComment;
    let nxt = null;
    for (; j < lines.length; j++) {
      let t = lines[j];
      if (t.indexOf('*/') >= 0) { skipped = false; t = t.slice(t.indexOf('*/') + 2); }
      else if (t.indexOf('/*') >= 0) { skipped = true; t = t.slice(0, t.indexOf('/*')); }
      t = t.trim();
      if (t) { nxt = t; break; }
    }
    if (nxt && nxt[0] !== '}' && !skipped && nxt.indexOf('{') > 0) {
      bad.push('L' + (i + 1) + ': ' + st.slice(0, 55) + '  →  ' + nxt.slice(0, 35));
    }
  }
  assert.deepStrictEqual(bad, [], "选择器行缺 '{' (会被并进下一条规则):\n" + bad.join('\n'));
  assert.strictEqual(css.split('{').length, css.split('}').length, 'CSS 花括号不配平');
});

test('P2-1: .tab-btn 窄屏规则已独立生效', () => {
  assert.ok(!/\.dup-stats-row\s*\n\s*\.tab-btn\{/.test(css),
    '仍有 .dup-stats-row 续行把 .tab-btn 变成永不匹配的后代选择器');
  const i = css.indexOf('@media(max-width:768px){');
  assert.ok(i > 0, '未找到 768px 断点');
  const block = css.slice(i, i + 2200);
  assert.ok(/\.tab-btn\{[^}]*padding/.test(block), '768px 断点里 .tab-btn 应有独立 padding 规则');
});

/* ══════════════ P2-3 ══════════════ */
test('P2-3: glob 正则只替换 * 这一个字符', () => {
  const body = fnBody(syscleanSrc, 'isTargetPath');
  assert.ok(body, '应能找到 isTargetPath');
  assert.ok(body.includes("replace(/\\*/g, '\\\\d+')"),
    "必须只替换 '*' 一个字符。写成 'vol\\\\d+' 会得到 ^/volvol\\d+/, 实测永不匹配");
  const pat = new RegExp('^' + '/vol*/@appcenter'.replace(/\*/g, '\\d+') + '(/|$)');
  assert.strictEqual(pat.test('/vol3/@appcenter/photos'), true);
});

/* ══════════════ P2-4 ══════════════ */
test('P2-4: protectedReason 先 realpath 解析软链且有回退', () => {
  const body = fnBody(utilSrc, 'protectedReason');
  assert.ok(body, '应能找到 protectedReason');
  const idx = body.indexOf('realpathSync(n)');
  assert.ok(idx > 0, '必须 realpath, 否则指向 @appcenter 的软链能绕过段名检查');
  assert.ok(body.slice(idx, idx + 80).indexOf('catch') > 0,
    'realpathSync 对不存在路径抛 ENOENT, 必须 try/catch 回退');
  assert.ok(utilSrc.includes('realpathSync }'), '需从 node:fs 引入 realpathSync');
});

/* ══════════════ P2-5 ══════════════ */
test('P2-5: 无未定义 CSS 变量引用', () => {
  const defined = new Set(Array.from(css.matchAll(/(--[\w-]+)\s*:/g)).map(m => m[1]));
  const srcs = [['index.html', html], ['main.js', mainSrc], ['style.css', css], ['motion.js', motionSrc]];
  const bad = [];
  for (const pair of srcs) {
    const name = pair[0], src = pair[1];
    const refs = new Set(Array.from(src.matchAll(/var\((--[\w-]+)/g)).map(m => m[1]));
    for (const v of refs) {
      if (!defined.has(v) && v !== '--i') bad.push(name + ': ' + v);
    }
  }
  assert.deepStrictEqual(bad, [], '引用了未定义变量: ' + bad.join(', '));
});

/* ══════════════ P2-6 ══════════════ */
test('P2-6: export/save fetch 带超时', () => {
  const body = fnBody(code, 'postExportSave');
  assert.ok(body, '应有 postExportSave');
  const i = body.indexOf("fetch('api/export/save'");
  assert.ok(i > 0);
  assert.ok(body.slice(i, i + 400).includes('AbortSignal.timeout('), 'export/save fetch 必须带超时');
});

/* ══════════════ P2-7 / P2-8 ══════════════ */
test('P2-7: 定时历史签名测试改为抠 main.js 真源码', () => {
  assert.ok(stripComments(schedTest).indexOf('function sigOf(history)') < 0,
    'sigOf 仍是测试里手抄的一份: 把 main.js 改错测试仍全绿');
  assert.ok(schedTest.includes('_sigSrc'), '应从 loadScheduleHistory 真源码提取签名表达式');
  assert.ok(schedTest.includes('_histBody'), '应先抠出 loadScheduleHistory 函数体');
});

test('P2-8: 无恒等函数包装, 无固定字符切片', () => {
  assert.ok(stripComments(hashTest).indexOf('scanScanSrc') < 0, '恒等函数 scanScanSrc 应删除');
  assert.ok(storageTest.includes('function blockAfter('), '固定切片应改为花括号配对 blockAfter');
  assert.ok(!/indexOf\([^)]*\)\s*\+\s*\d{3,}\)/.test(storageTest), '仍有固定字符数切片');
});

test('全项目测试套件无恒等函数包装', () => {
  const dir = path.join(ROOT, 'tests');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (/function\s+\w+\(s\)\s*\{\s*return s;\s*\}/.test(src)) bad.push(f);
  }
  assert.deepStrictEqual(bad, [], '恒等函数包装: ' + bad.join(', '));
});