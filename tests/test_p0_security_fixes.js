// P0 安全修复回归测试 — 2026-10-09
//
// 覆盖 7 个 P0：
//   P0-1 sysclean isTargetPath 放过带 filter 的整目录 + fallback join(..) 逃逸 → /var/log 可 rm -rf
//   P0-2 temp isTempPath 用 startsWith 不解 '..' → /tmp/../etc 逃逸
//   P0-3 dup jobId 无格式校验 → 状态文件路径穿越(读+写)
//   P0-4 docker 三个删除端点直接把用户串当参数 → 选项注入
//   P0-5 内联 onclick="fn('${escHtml(path)}')" 实体解码后逃逸 JS
//   P0-6 内联 onclick 转义反斜杠 → 闭合 JS 字符串
//   P0-7 恒真断言(已在 test_export_save / test_simdup_compare 修掉, 这里做兜底扫描)
//
// 原则: 每个断言都针对**真源码**抠出来的函数跑, 不在测试里重实现被测逻辑
// (重实现 = 验的不是真代码 = 假通行证, 本项目已因此栽过两次)。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const apiSrc = rd('app/ui/api/sysclean.js');
const tempSrc = rd('app/ui/api/temp.js');
const dupSrc = rd('app/ui/api/dup.js');
const dockerSrc = rd('app/ui/api/docker.js');
const mainSrc = rd('app/ui/main.js');

/** 按花括号配对精确提取函数体(带 async 前缀), 不用固定字符切片 */
function fnBody(src, sig) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + sig + '\\s*\\(').exec(src);
  if (!m) return null;
  const i = m.index;
  let d = 0;
  const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
   P0-1 sysclean: isTargetPath 拒绝带 filter 的整目录
   ══════════════════════════════════════════════════════════════ */

function makeIsTargetPath() {
  const body = fnBody(apiSrc, 'isTargetPath');
  assert.ok(body, 'sysclean.js 里找不到 isTargetPath');
  // 从 SCAN_TARGETS 真源码抠出 filter/path, 保证测的是真实配置
  // 直接 eval SCAN_TARGETS 数组字面量 —— 用正则切条目是不可靠的
  // (filter 函数体里也有花括号/逗号, 实测只抓到 1/7), 抠出完整数组 eval 才能
  // 拿到与生产完全一致的真实配置。
  const arrStart = apiSrc.indexOf('const SCAN_TARGETS = [') + 'const SCAN_TARGETS = '.length;
  // 方括号配对提取(不能用 indexOf('];') —— filter 函数体里就有 ];,
  // 例如 /\.1$/ 之类的正则, 会在数组中途截断, 实测只 eval 出 6/7 项)
  let depth = 0, arrEnd = -1;
  for (let i = arrStart; i < apiSrc.length; i++) {
    const ch = apiSrc[i];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { arrEnd = i + 1; break; } }
  }
  assert.ok(arrEnd > 0, '未能配对提取 SCAN_TARGETS 数组');
  const SCAN_TARGETS = new Function('return ' + apiSrc.slice(arrStart, arrEnd))();
  // 注意: 实测 SCAN_TARGETS 6 项**全部**带 filter(apt-archives/apt-lists 也有,
  // 因为它们只列 .deb / 非 partial 子项)。整目录一律该拒, 只能删子项。
  assert.ok(Array.isArray(SCAN_TARGETS) && SCAN_TARGETS.length >= 6,
    '未能 eval 出 SCAN_TARGETS(实得 ' + (Array.isArray(SCAN_TARGETS) ? SCAN_TARGETS.length : typeof SCAN_TARGETS) + ')');
  // 确认关键 fixture 真的在(否则下面的断言是空转)
  assert.ok(SCAN_TARGETS.some(t => t.id === 'syslog-gz' && t.path === '/var/log' && t.filter),
    'fixture 前提缺失: SCAN_TARGETS 里应有带 filter 的 syslog-gz(/var/log)');
  assert.ok(SCAN_TARGETS.every(t => t.filter),
    '前提变更: SCAN_TARGETS 出现了不带 filter 的项, isTargetPath 的整目录策略需重新评估');
  // 用户缓存项(USER_CACHE_TEMPLATES)不产出 filter 字段 → 整目录可删, 必须放行
  const buildUserCacheItems = () => ([
    { id: 'npm:root', path: '/root/.npm' },
    { id: 'npm:1000', path: '/vol1/1000/.npm' },
  ]);
  const resolve = (p) => path.resolve(p);
  const shim = new Function('SCAN_TARGETS', 'buildUserCacheItems', 'resolve',
    body + '\nreturn isTargetPath;');
  return shim(SCAN_TARGETS, buildUserCacheItems, resolve);
}

test('P0-1: 带 filter 的 target 其整目录不再被当作可删目标', () => {
  const isTargetPath = makeIsTargetPath();
  // syslog-gz / syslog-old / journal 都以 /var/log 或其子目录为 path 且带 filter
  assert.strictEqual(isTargetPath('/var/log'), false,
    '/var/log 是带 filter target(syslog-gz)的整目录, 必须拒绝(否则 journal:.. 拼出它后 rm -rf /var/log)');
});

test('P0-1: 带 filter 的 target 其子路径仍可删(不能误伤合法日志清理)', () => {
  const isTargetPath = makeIsTargetPath();
  // syslog-gz:syslog.1.gz → /var/log/syslog.1.gz 必须仍放行
  assert.strictEqual(isTargetPath('/var/log/syslog.1.gz'), true,
    '日志子项 /var/log/syslog.1.gz 必须仍可删, 否则 syslog-gz 清理功能坏掉');
  assert.strictEqual(isTargetPath('/var/log/syslog'), true, '/var/log 下子路径应放行');
});

test('P0-1: 无 filter 的用户缓存整目录仍可删', () => {
  const isTargetPath = makeIsTargetPath();
  // 用户缓存项(来自 USER_CACHE_TEMPLATES, 不带 filter)整目录必须仍可删,
  // 否则「NPM 缓存 /root/.npm」这类正常清理会被误拒。
  assert.strictEqual(isTargetPath('/root/.npm'), true, '用户缓存 /root/.npm 整目录应放行');
  assert.strictEqual(isTargetPath('/vol1/1000/.npm'), true, '用户缓存 /vol1/1000/.npm 整目录应放行');
  assert.strictEqual(isTargetPath('/root/.npm/_cacache'), true, '用户缓存子路径应放行');
});

test('P0-1: 带 filter 的 apt-archives 整目录同样被拒(只列子项)', () => {
  const isTargetPath = makeIsTargetPath();
  assert.strictEqual(isTargetPath('/var/cache/apt/archives'), false,
    'apt-archives 也带 filter(只列 .deb 子项), 整目录不应可删');
  assert.strictEqual(isTargetPath('/var/cache/apt/archives/foo.deb'), true, '.deb 子项应放行');
});

test('P0-1: isTargetPath 先 resolve 消除 ..', () => {
  const isTargetPath = makeIsTargetPath();
  assert.strictEqual(isTargetPath('/var/log/../log'), false,
    '/var/log/../log 归一化后是 /var/log(带 filter 整目录), 必须拒绝');
});

test('P0-1: fallback 对 rest 做 .. 逃逸防护(join 后复检)', () => {
  const body = apiSrc.slice(apiSrc.indexOf('// Fallback: parse'), apiSrc.indexOf('let size = 0, mtime = 0;'));
  assert.ok(body.length > 0, '未找到 fallback 段');
  assert.match(body, /resolve\(join\(targetPath,\s*rest\)\)/,
    'fallback 应用 resolve(join(...)) 归一化后再赋给 path');
  assert.match(body, /candidate\s*!==\s*resolve\(targetPath\)\s*&&\s*!candidate\.startsWith\(resolve\(targetPath\)/,
    'fallback 必须复检 candidate 仍在 targetPath 之下, 否则 journal:.. 逃逸到 /var/log');
});

/* ══════════════════════════════════════════════════════════════
   P0-2 temp: isTempPath 用 resolve
   ══════════════════════════════════════════════════════════════ */

function makeIsTempPath() {
  const body = fnBody(tempSrc, 'isTempPath');
  assert.ok(body, 'temp.js 里找不到 isTempPath');
  const resolve = (p) => path.resolve(p);
  return new Function('resolve', body + '\nreturn isTempPath;')(resolve);
}

test('P0-2: /tmp/../etc 逃逸被拒', () => {
  const isTempPath = makeIsTempPath();
  assert.strictEqual(isTempPath('/tmp/../etc/cron.d/x'), false,
    '/tmp/../etc 归一化后是 /etc, 必须拒绝(原先 startsWith("/tmp/") 会放行)');
  assert.strictEqual(isTempPath('/var/tmp/../etc/passwd'), false, '/var/tmp/../etc 必须拒绝');
});

test('P0-2: 真正的 /tmp /var/tmp 子路径仍放行', () => {
  const isTempPath = makeIsTempPath();
  assert.strictEqual(isTempPath('/tmp/foo'), true);
  assert.strictEqual(isTempPath('/var/tmp/bar'), true);
  assert.strictEqual(isTempPath('/tmp'), true);
  assert.strictEqual(isTempPath('/var/tmp'), true);
});

test('P0-2: /etc 等系统目录被拒', () => {
  const isTempPath = makeIsTempPath();
  for (const p of ['/etc/passwd', '/var/log/syslog', '/vol3/@appcenter']) {
    assert.strictEqual(isTempPath(p), false, `${p} 不该被 isTempPath 放行`);
  }
});

/* ══════════════════════════════════════════════════════════════
   P0-3 dup: jobId 格式校验(4 个入口)
   ══════════════════════════════════════════════════════════════ */

test('P0-3: isValidDupJobId 只放行 dup_<hex>', () => {
  const body = fnBody(dupSrc, 'isValidDupJobId');
  assert.ok(body, 'dup.js 里找不到 isValidDupJobId');
  const shim = new Function(body + '\nreturn isValidDupJobId;');
  const isValid = shim();
  assert.strictEqual(isValid('dup_1234abcd'), true, '合法 jobId 应放行');
  assert.strictEqual(isValid('dup_' + 'a'.repeat(32)), true);
  assert.strictEqual(isValid('dup_abc'), true, 'abc 是 3 位 hex, 符合 {1,32}');
  for (const bad of [
    'dup_../../../etc/cron.d/x',   // 路径穿越
    'dup_',
    'dup_../../x',
    '../dup_x',
    'dup_GHIJ',                    // 非 hex
    'other_abc',
    '',
    'dup_abc/../../x',
  ]) {
    assert.strictEqual(isValid(bad), false, `jobId ${JSON.stringify(bad)} 必须被拒`);
  }
});

test('P0-3: status/stop/pause/resume 四个入口都做了格式校验', () => {
  for (const fn of ['handleDupStatus', 'handleDupStop', 'handleDupPause', 'handleDupResume']) {
    const body = fnBody(dupSrc, fn);
    assert.ok(body, `找不到 ${fn}`);
    assert.match(body, /isValidDupJobId\(jobId\)/,
      `${fn} 必须用 isValidDupJobId 校验 jobId, 否则 jobId 含 ../ 可穿越状态文件路径`);
  }
});

/* ══════════════════════════════════════════════════════════════
   P0-4 docker: 名称/ID 校验(选项注入)
   ══════════════════════════════════════════════════════════════ */

function makeIsSafeDockerRef() {
  const body = fnBody(dockerSrc, 'isSafeDockerRef');
  assert.ok(body, 'docker.js 里找不到 isSafeDockerRef');
  return new Function(body + '\nreturn isSafeDockerRef;')();
}

test('P0-4: 以 - 开头的值被拒(docker 会当成选项)', () => {
  const ok = makeIsSafeDockerRef();
  for (const bad of ['--force', '-f', '--all', '-a', '--prune']) {
    assert.strictEqual(ok(bad), false, `${bad} 以 - 开头会被 docker 当选项, 必须拒绝`);
  }
});

test('P0-4: 合法 docker 资源名/ID 放行', () => {
  const ok = makeIsSafeDockerRef();
  const good = [
    'my-volume', 'vol_name', 'vol.name', 'bridge', 'host', 'none',
    'abc123def456',                                   // 短 id
    'a'.repeat(64),                                   // 长 sha
    'nginx:latest', 'repo/name:1.2', 'r.io/n@sha256:abc',
    'nginx', 'alpine',
  ];
  for (const g of good) {
    assert.strictEqual(ok(g), true, `合法引用 ${g} 应放行`);
  }
});

test('P0-4: 空/超长/非法字符被拒', () => {
  const ok = makeIsSafeDockerRef();
  assert.strictEqual(ok(''), false);
  assert.strictEqual(ok('a'.repeat(513)), false, '超长应拒');
  assert.strictEqual(ok('has space'), false);
  assert.strictEqual(ok('has;semicolon'), false);
  assert.strictEqual(ok(null), false);
  assert.strictEqual(ok(undefined), false);
});

test('P0-4: 三个删除端点都接了 isSafeDockerRef', () => {
  for (const fn of ['handleVolumesDelete', 'handleNetworksDelete', 'handleImagesDelete']) {
    const body = fnBody(dockerSrc, fn);
    assert.ok(body, `找不到 ${fn}`);
    assert.match(body, /isSafeDockerRef\(/,
      `${fn} 必须用 isSafeDockerRef 过滤, 否则用户可控字符串构成选项注入`);
  }
});

/* ══════════════════════════════════════════════════════════════
   P0-5 / P0-6 前端 XSS: 目录/路径不再进内联 onclick 的 JS 字符串
   ══════════════════════════════════════════════════════════════ */

// 断言前必须剥掉注释 —— 否则注释里为了说明问题而写的字面量
// onclick="dsDrillDown('...')" 会被正则命中, 让修复后的代码"看起来"仍在用。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/^\s*\/\/.*$/gm, '');          // 行注释
}

test('P0-5: dsDrillDown 不再出现在内联 onclick 里', () => {
  const code = stripComments(mainSrc);
  assert.doesNotMatch(code, /onclick="dsDrillDown\(/,
    "dsDrillDown 仍写在内联 onclick 的 JS 字符串里: escHtml 把 ' 转 &#39; 后浏览器先做实体解码再当 JS 编译, 形如 x');alert(1)// 的路径仍可闭合");
});

test('P0-5: dsDrillDown 改用 data-ds-path + 事件绑定', () => {
  assert.match(mainSrc, /data-ds-path="\$\{escHtml\(/,
    'ds 下钻按钮应改为 data-ds-path 属性');
  const binder = fnBody(mainSrc, 'bindDsDrillBtns');
  assert.ok(binder, '缺少 bindDsDrillBtns 绑定器');
  assert.match(binder, /el\.onclick\s*=\s*\(\)\s*=>\s*dsDrillDown\(el\.dataset\.dsPath\)/,
    '绑定器应从 dataset.dsPath 取值传给 dsDrillDown');
  // 两个渲染点都要调
  assert.ok(mainSrc.includes('bindDsDrillBtns(listEl)'), 'dsLoadVolumes 未调用绑定器');
  assert.ok(mainSrc.includes('bindDsDrillBtns(container)'), 'dsRenderDirs 未调用绑定器');
});

test('P0-6: loadBrowseDir 目录项不再用 onclick 转义拼接', () => {
  // 旧写法: onclick="loadBrowseDir(' + e.path.replace(/'/g,"\\'")...
  assert.doesNotMatch(mainSrc, /onclick="loadBrowseDir\\\('/,
    'browse 目录项仍用 onclick 内联拼接路径, 反斜杠未转义可闭合 JS 字符串');
  assert.match(mainSrc, /data-browse-path="'\s*\+\s*escHtml\(e\.path\)/,
    'browse 目录项应改为 data-browse-path');
  assert.match(mainSrc, /loadBrowseDir\(el\.dataset\.browsePath\)/,
    'browse 绑定应从 dataset 取值');
});

test('P0-6: confirmEmptyDeleteOne 改用 data-empty-del', () => {
  assert.doesNotMatch(mainSrc, /onclick="confirmEmptyDeleteOne/,
    'confirmEmptyDeleteOne 仍写在内联 onclick 里');
  assert.match(mainSrc, /data-empty-del="'\s*\+\s*escHtml\(item\.path\)/,
    'empty 删除按钮应改为 data-empty-del');
  assert.match(mainSrc, /confirmEmptyDeleteOne\(delBtn\.dataset\.emptyDel\)/,
    'empty 绑定应从 dataset 取值');
});

test('P0-5/6: 全项目不再有"用户路径进内联 onclick 字符串"的写法', () => {
  // 更宽的兜底: onclick="...('  + <含 path/name 的变量拼接>
  const code = stripComments(mainSrc); // 剥注释, 避免匹配到说明性字面量
  const risky = [];
  for (const re of [
    /onclick="[A-Za-z_$][\w$]*\(' \+ \w+\.(path|name|file)/g,
    /onclick="[A-Za-z_$][\w$]*\('\$\{escHtml\(/g,
  ]) {
    let m;
    while ((m = re.exec(code)) !== null) risky.push(m[0].slice(0, 60));
  }
  assert.deepStrictEqual(risky, [], `仍有路径/文件名进内联 onclick 的写法(应改 data-* + 事件委托):\n${risky.join('\n')}`);
});

/* ══════════════════════════════════════════════════════════════
   P0-7 兜底: 测试套件里不再有 `|| true` 恒真断言
   ══════════════════════════════════════════════════════════════ */

test('P0-7: 测试套件无 `|| true` 恒真断言', () => {
  const testsDir = path.join(ROOT, 'tests');
  const offenders = [];
  for (const f of fs.readdirSync(testsDir).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(testsDir, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      // assert.ok(...) 结尾 || true, 或 === false || true 这类短路
      if (/assert\.(ok|notOk)\([^)]*\|\|\s*true/.test(line)) {
        offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    `以下断言被 || true 短路成恒真(无论被测代码是什么都通过, 等于没测):\n${offenders.join('\n')}`);
});