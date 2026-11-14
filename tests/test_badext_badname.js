// ── Bad Extensions + Bad Names 扫描器回归测试 ──
//
// 两个扫描器都是独立子进程，直接跑它们并检查产出的 state 文件，
// 比断言源码字符串可靠（能真正验证 magic 判定和文件名检查逻辑）。
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = dirname(HERE);
const TMP = join(PROJ, '.test_badname_tmp');

function setup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}
function teardown() {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

function runScan(script, scanPath) {
  const stateDir = join(TMP, 'state_' + script);
  mkdirSync(stateDir, { recursive: true });
  const jobId = 'job_' + Date.now();
  const r = spawnSync(process.execPath,
    [join(PROJ, 'app', script), scanPath, jobId, stateDir],
    { encoding: 'utf8', timeout: 60000 });
  const f = join(stateDir, `${jobId}.json`);
  if (!existsSync(f)) {
    throw new Error(`${script} 未产出状态文件 (exit=${r.status})\nSTDOUT:${r.stdout}\nSTDERR:${r.stderr}`);
  }
  return JSON.parse(readFileSync(f, 'utf8'));
}

// ─────────── Bad Extensions ───────────

test('badext: 识别 PNG 内容但扩展名是 .jpg', () => {
  setup();
  const d = join(TMP, 'ext1');
  mkdirSync(d, { recursive: true });
  // PNG magic + 一点数据
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 0)]);
  writeFileSync(join(d, 'photo.jpg'), png);          // 扩展名错：实际是 PNG
  writeFileSync(join(d, 'real.png'), png);           // 扩展名对：不应报警

  const st = runScan('badext_scan.js', d);
  teardown();

  assert.strictEqual(st.status, 'complete', '扫描应完成');
  assert.strictEqual(st.stats.mismatch, 1, '应只报 1 个不匹配（photo.jpg）');
  const it = st.items.find(x => x.name === 'photo.jpg');
  assert.ok(it, 'photo.jpg 应被列出');
  assert.strictEqual(it.actualKind, 'PNG', '实际类型应为 PNG');
  assert.strictEqual(it.suggest, 'png', '建议扩展名应为 png');
  assert.strictEqual(it.category, 'mismatch');
  assert.ok(!st.items.some(x => x.name === 'real.png'), '正确扩展名不应被报');
});

test('badext: 识别 JPEG / PDF / ZIP 的伪装文件', () => {
  setup();
  const d = join(TMP, 'ext2');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'a.png'), Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(32, 1)]));   // 实为 JPEG
  writeFileSync(join(d, 'b.txt'), Buffer.from('%PDF-1.7\n' + 'x'.repeat(50)));                                    // 实为 PDF
  writeFileSync(join(d, 'c.mp3'), Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.alloc(32, 2)]));    // 实为 ZIP

  const st = runScan('badext_scan.js', d);
  teardown();

  const byName = Object.fromEntries(st.items.map(x => [x.name, x]));
  assert.strictEqual(byName['a.png']?.actualKind, 'JPEG', 'a.png 实为 JPEG');
  assert.strictEqual(byName['b.txt']?.actualKind, 'PDF', 'b.txt 实为 PDF');
  assert.strictEqual(byName['c.mp3']?.actualKind, 'ZIP', 'c.mp3 实为 ZIP');
  assert.strictEqual(st.stats.mismatch, 3, '三个都应被报');
});

test('badext: 无扩展名但能识别类型时报 no_ext', () => {
  setup();
  const d = join(TMP, 'ext3');
  mkdirSync(d, { recursive: true });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 3)]);
  writeFileSync(join(d, 'noext_file'), gif);

  const st = runScan('badext_scan.js', d);
  teardown();

  assert.strictEqual(st.stats.no_ext, 1, '应报 1 个无扩展名');
  const it = st.items.find(x => x.name === 'noext_file');
  assert.ok(it, '应列出 noext_file');
  assert.strictEqual(it.actualKind, 'GIF');
  assert.strictEqual(it.category, 'no_ext');
});

test('badext: 空白文件跳过、正确扩展名不误报', () => {
  setup();
  const d = join(TMP, 'ext4');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'empty.jpg'), Buffer.alloc(0));
  // 真实 JPEG
  writeFileSync(join(d, 'ok.jpg'), Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 5)]));

  const st = runScan('badext_scan.js', d);
  teardown();

  assert.strictEqual(st.stats.mismatch, 0, '不应有误报');
  assert.strictEqual(st.items.length, 0, '不应有任何条目');
  assert.ok(st.stats.skipped >= 1, '空文件应计入 skipped');
});

// ─────────── Bad Names ───────────

test('badname: 检出 Windows 保留字符 / 控制字符 / 保留名', () => {
  setup();
  const d = join(TMP, 'name1');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'a:b.txt'), 'x');       // 冒号
  writeFileSync(join(d, 'q?mark.txt'), 'x');    // 问号
  writeFileSync(join(d, 'star*.txt'), 'x');     // 星号
  writeFileSync(join(d, 'CON'), 'x');           // Windows 保留名
  writeFileSync(join(d, 'normal.txt'), 'x');    // 正常，不应报

  const st = runScan('badname_scan.js', d);
  teardown();

  const codes = st.items.flatMap(x => x.issues.map(i => i.code));
  assert.ok(codes.includes('win_reserved_char'), '应检出 Windows 保留字符');
  assert.ok(codes.includes('win_reserved_name'), '应检出 Windows 保留名');
  const names = st.items.map(x => x.name);
  assert.ok(names.includes('a:b.txt'), 'a:b.txt 应被列出');
  assert.ok(names.includes('CON'), 'CON 应被列出');
  assert.ok(!names.includes('normal.txt'), '正常文件名不应被报');
  assert.ok(st.stats.high >= 3, `应有 >=3 个 high 级问题，实际 ${st.stats.high}`);
});

test('badname: 检出首尾空格、零宽字符', () => {
  setup();
  const d = join(TMP, 'name2');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, ' leading.txt'), 'x');                      // 前导空格
  writeFileSync(join(d, 'trailing.txt '), 'x');                     // 尾部空格
  writeFileSync(join(d, 'zero\u200Bwidth.txt'), 'x');               // 零宽字符

  const st = runScan('badname_scan.js', d);
  teardown();

  const codes = new Set(st.items.flatMap(x => x.issues.map(i => i.code)));
  assert.ok(codes.has('leading_trailing'), '应检出首尾空格');
  assert.ok(codes.has('zero_width'), '应检出零宽字符');
  assert.ok(st.items.length >= 3, `至少 3 条，实际 ${st.items.length}`);
});

test('badname: 超长文件名判定（直接单测 checkName）', async () => {
  // 文件系统本身有 255 字节上限，造不出这种文件来扫描，
  // 所以直接单测判定函数（从扫描脚本导出的纯函数）。
  const { checkName, MAX_NAME_BYTES } = await import('../app/badname_scan.js');

  const longName = '中'.repeat(90) + '.txt';        // 90×3 + 4 = 274 字节
  assert.ok(Buffer.byteLength(longName, 'utf8') > MAX_NAME_BYTES, '前置条件：应超过上限');

  const issues = checkName(longName);
  const tooLong = issues.find(i => i.code === 'too_long');
  assert.ok(tooLong, '应检出 too_long');
  assert.strictEqual(tooLong.severity, 'medium');
  assert.strictEqual(tooLong.fixable, false, '超长无法自动修复（信息不足以截断）');

  // 边界：正好 255 字节不应报
  const edge = 'a'.repeat(251) + '.txt';            // 255 字节
  assert.strictEqual(Buffer.byteLength(edge, 'utf8'), 255);
  assert.ok(!checkName(edge).some(i => i.code === 'too_long'), '255 字节不应报超长');
});

test('badname: 生成的可修复建议名不含原非法字符', () => {
  setup();
  const d = join(TMP, 'name3');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'bad:name?.txt'), 'x');

  const st = runScan('badname_scan.js', d);
  teardown();

  const it = st.items.find(x => x.name === 'bad:name?.txt');
  assert.ok(it, '应被列出');
  const charIssue = it.issues.find(i => i.code === 'win_reserved_char');
  assert.ok(charIssue, '应有 win_reserved_char 问题');
  assert.ok(charIssue.fixable, '该问题应标记为可修复');
  assert.ok(charIssue.suggest, '应给出建议名');
  assert.ok(!/[<>:"|?*]/.test(charIssue.suggest), `建议名不应含非法字符，实际: ${charIssue.suggest}`);
});

test('badname: 目录名也不规范时同样被检出', () => {
  setup();
  const d = join(TMP, 'name4');
  mkdirSync(join(d, 'sub:dir'), { recursive: true });
  writeFileSync(join(d, 'sub:dir', 'inner.txt'), 'x');

  const st = runScan('badname_scan.js', d);
  teardown();

  const names = st.items.map(x => x.name);
  assert.ok(names.includes('sub:dir'), '不规范目录名应被检出');
  const dirItem = st.items.find(x => x.name === 'sub:dir');
  assert.strictEqual(dirItem.isDir, true, '应标记为目录');
});
