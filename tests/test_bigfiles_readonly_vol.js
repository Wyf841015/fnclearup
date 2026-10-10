// 大文件: 只读卷无法删除 —— 2026-10-10
//
// 真根因(用户报的"扫描后选中删除全部失败"): /vol2 以 btrfs (ro) 挂载,
// 用户 82G 视频全在 /vol2/1000/video。扫描照常列出 57 个"大文件", 用户勾选全删,
// 每个都 EROFS: read-only file system —— 显示出来就是"全部失败"。
//
// 应用没做错删除逻辑, 错在没告诉用户:
//   1. 扫描阶段不告知该卷只读, 用户白勾一遍
//   2. 删除失败时把英文错误码原样透出, 用户以为是程序坏了
//
// 这两条都要修。另外探测可写性不能用 access(W_OK): fnOS 的 trimacl 把目录
// mode 显示成 000(实测 /vol2/1000 是 mode=0o0), 对可写卷也返回 false。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const apiSrc = rd('app/ui/api/bigfiles.js');
const mainSrc = rd('app/ui/main.js');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const api = strip(apiSrc);

test('探测可写性: 真写临时文件, 不用 access(W_OK)', () => {
  // trimacl 下 mode 显示 000, access(W_OK) 对可写卷也返回 false —— 不可信
  assert.ok(!/access\([^)]*W_OK/.test(api), '不应依赖 access(W_OK) 判定可写');
  assert.match(api, /function probeWritable\(dir\)/);
  assert.match(api, /writeFileSync\(probe, '0'\)/, '必须真写一个探针文件');
  assert.match(api, /unlinkSync\(probe\)/, '写完要删掉探针, 不能留垃圾在用户目录');
});

test('探测可写性: EROFS 单独识别并翻译成人话', () => {
  // 代码里先把 e.code 存进局部变量 code, 再拿 code 比较 —— 别按 e.code 匹配
  assert.match(api, /code = e\.code \|\| 'EUNKNOWN'/, '应捕获原始错误码');
  assert.match(api, /code === 'EROFS'/, 'EROFS 要单独识别');
  assert.match(api, /卷以只读方式挂载，无法写入或删除任何文件/);
  assert.match(api, /code === 'EACCES'/, '权限不足也要区分开, 两者原因不同');
  // 探针失败后必须清理, 否则 EACCES 的目录里会留下 .fnclearup_wtest_* 垃圾
  assert.ok(/if \(existsSync\(probe\)\) unlinkSync\(probe\)/.test(api),
    '探针写入失败(文件可能已部分创建)时要清理, 否则用户目录里会留下垃圾');
});

test('探测失败不影响扫描: 探测结果只做提示, 不阻断', () => {
  // 探测放在 walk 之后 —— 不能因为探测失败就让整个扫描失败
  assert.match(api, /const rootAccess = roots\.map\(r => \(\{ root: r, \.\.\.probeWritable\(r\) \}\)\);/);
  assert.ok(!/if\s*\(!\w+\.writable\)\s*\{[^}]*sendJSON\(res, \d+/s.test(api),
    '只读根不应中断扫描 —— 仍要列出文件, 只是告知删不掉');
});

test('响应回传只读根', () => {
  assert.match(api, /read_only_roots: rootAccess\.filter\(a => !a\.writable\)/);
});

test('前端: 扫描结果里明示只读卷', () => {
  assert.match(mainSrc, /data\.read_only_roots/);
  assert.match(mainSrc, /为只读卷\(\$\{a\.reason\}\)，其下文件无法删除/,
    '要讲清"哪个卷 + 为什么 + 后果"');
});

test('前端: EROFS 失败翻译成人话, 不透出英文错误码', () => {
  assert.match(mainSrc, /roFailed/);
  assert.match(mainSrc, /⛔ \$\{roFailed\.length\} 个文件所在卷为只读，无法删除（EROFS）/);
  assert.match(mainSrc, /roFailed\.length === paths\.length \? '，本卷一个都删不掉'/,
    '整卷都删不掉时要明说, 而不是只报个失败数');
});

test('端到端: 真实执行 probeWritable, 对只读卷给出 EROFS', async () => {
  // 只在**只读卷**上真跑探测: 只读卷写不进去, 探测必然失败, 无副作用。
  // 可写卷不真探测 —— 测试往用户真实卷根写临时文件是污染, 而且本机权限
  // (trimacl 下 mode 显示 000) 与运行测试的账号都会影响结果, 不可靠。
  const fnStart = api.indexOf('function probeWritable');
  assert.ok(fnStart > 0, '应找到 probeWritable');
  const fnEnd = api.indexOf('\n}\n', fnStart) + 2;
  const fnSrc = api.slice(fnStart, fnEnd);
  const { writeFileSync, unlinkSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const probeWritable = new Function('join', 'writeFileSync', 'unlinkSync', 'existsSync',
    fnSrc + '\nreturn probeWritable;')(join, writeFileSync, unlinkSync, existsSync);
  const { execSync } = await import('node:child_process');

  const roVols = [];
  for (const v of ['/vol1', '/vol2', '/vol3', '/vol4']) {
    if (!existsSync(v)) continue;
    const ml = execSync('mount | grep " on ' + v + ' " || true').toString().trim();
    if (/[(,]\s*ro\s*[,)]/.test(ml)) roVols.push(v);
  }
  if (!roVols.length) {
    // 本机没有只读卷: 用一个不存在的路径探测, 至少验证函数不会崩
    const r = probeWritable('/__definitely_not_exist__/x');
    assert.strictEqual(r.writable, false);
    assert.ok(r.code, '探测失败要给出错误码');
    return;
  }
  for (const v of roVols) {
    const r = probeWritable(v);
    assert.strictEqual(r.writable, false, v + ' 是只读卷, 探测必须报不可写');
    assert.strictEqual(r.code, 'EROFS', v + ' 应识别为 EROFS, 实际 ' + r.code);
    assert.match(r.reason, /只读/, '要给出人话原因, 不能是原始错误对象: ' + r.reason);
    assert.ok(!/Error|undefined|\[object/.test(r.reason), '原因不应是原始对象: ' + r.reason);
    // 只读卷上不可能留下探针(写都没成功)
    const left = execSync('ls -a ' + v + ' 2>/dev/null | grep fnclearup_wtest || true').toString().trim();
    assert.strictEqual(left, '', v + ': 只读卷上不应留下探针, 实际 ' + left);
  }
});

test('端到端: 探针删不掉时必须如实上报 leftover', async () => {
  // 正常环境里探针总能删掉, 这条分支永远走不到 —— 只能靠注入依赖验证。
  // 静默忽略的后果是用户目录里留一堆 .fnclearup_wtest_*, 那比"探测不准"更难解释。
  const fnStart = api.indexOf('function probeWritable');
  const fnEnd = api.indexOf('\n}\n', fnStart) + 2;
  const { writeFileSync, existsSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const os = await import('node:os');
  const dir = mkdtempSync(join(os.tmpdir(), 'wtest_lo_'));
  try {
    // unlinkSync 永远失败(EACCES), 模拟"写进去了但删不掉"
    const unlinkFail = () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; };
    // basename 也要注入 —— probeWritable 用了它拼 leftover 文案。漏注入会得到
    // "basename is not defined" 而不是测到真正的行为。
    const { basename } = await import('node:path');
    const probeWritable = new Function('join', 'basename', 'writeFileSync', 'unlinkSync', 'existsSync',
      api.slice(fnStart, fnEnd) + '\nreturn probeWritable;')(join, basename, writeFileSync, unlinkFail, existsSync);
    const r = probeWritable(dir);
    assert.ok(r.leftover, '★ 删除失败必须上报 leftover, 不能静默: ' + JSON.stringify(r));
    assert.match(r.leftover, /残留探测临时文件/);
    assert.match(r.leftover, /EACCES/, '要带上真实错误码, 便于判断是权限还是只读');
  } finally { rmSync(dir, { recursive: true, force: true }); }   // 探针是故意留下的
});

test('端到端: 探测可写目录不留残留', async () => {
  // 可写性用 os.tmpdir 下的子目录验证 —— 不碰用户真实卷, 但仍验证
  // "写成功→删掉探针→不留垃圾" 这条链路。
  const fnStart = api.indexOf('function probeWritable');
  const fnEnd = api.indexOf('\n}\n', fnStart) + 2;
  const { writeFileSync, unlinkSync, rmdirSync, existsSync, readdirSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const os = await import('node:os');
  const probeWritable = new Function('join', 'writeFileSync', 'unlinkSync', 'existsSync',
    api.slice(fnStart, fnEnd) + '\nreturn probeWritable;')(join, writeFileSync, unlinkSync, existsSync);
  const dir = mkdtempSync(join(os.tmpdir(), 'wtest_'));
  try {
    const r = probeWritable(dir);
    assert.strictEqual(r.writable, true, 'tmp 下的目录必然可写: ' + JSON.stringify(r));
    const left = readdirSync(dir).filter(n => n.includes('fnclearup_wtest'));
    assert.deepStrictEqual(left, [], '可写目录探针必须清理干净');
  } finally { rmdirSync(dir); }   // 目录要用 rmdir, unlink 会 EISDIR
});
