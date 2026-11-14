// ── P1-3 回归测试：reflink (FICLONE) 去重 ──
//
// reflink 与 hardlink 的区别：
//   hardlink —— 共享 inode，改一个全改，备份工具只算一份，权限共享
//   reflink  —— 独立 inode，只共享数据块(COW)，改一个不影响另一个，权限独立
//
// 本测试必须在支持 CoW 的文件系统（btrfs / XFS）上跑。项目根在 /vol3 (btrfs)，
// 所以测试目录建在项目目录下而不是 /tmp（tmpfs 不支持 FICLONE）。
import { test } from 'node:test';
import assert from 'node:assert';
import {
  mkdirSync, writeFileSync, rmSync, existsSync, statSync,
  copyFileSync, readFileSync, constants as fsConstants,
  openSync, writeSync, closeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = dirname(HERE);                       // 项目根，位于 btrfs 卷上
const TMP = join(PROJ, '.test_reflink_tmp');

function setup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}
function teardown() {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

// 本机是否支持 reflink（不支持就跳过，避免在 tmpfs 上误报）
function reflinkSupported() {
  const s = join(TMP, '.probe_src');
  const d = join(TMP, '.probe_dst');
  try {
    writeFileSync(s, Buffer.alloc(4096, 1));
    copyFileSync(s, d, fsConstants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    return false;
  } finally {
    for (const f of [s, d]) { try { if (existsSync(f)) rmSync(f); } catch { /* ignore */ } }
  }
}

test('reflink: 副本独立 inode、内容一致、不占额外空间', () => {
  setup();
  const supported = reflinkSupported();
  if (!supported) { teardown(); console.log('  (跳过：当前文件系统不支持 reflink)'); return; }

  const keep = join(TMP, 'keep.bin');
  const dup = join(TMP, 'dup.bin');
  const payload = Buffer.alloc(4 * 1024 * 1024, 0x5A);
  writeFileSync(keep, payload);
  writeFileSync(dup, payload);          // 独立 inode 的重复副本

  const keepBefore = statSync(keep);
  const dupBefore = statSync(dup);
  assert.notStrictEqual(dupBefore.ino, keepBefore.ino, '前置条件：两个文件应是不同 inode');

  // 模拟 dup.js 的 reflink 流程
  const tmpRef = dup + '.fnc-reflink-tmp';
  try { rmSync(tmpRef, { force: true }); } catch { /* ignore */ }
  copyFileSync(keep, tmpRef, fsConstants.COPYFILE_FICLONE_FORCE);
  const tmpSt = statSync(tmpRef);
  assert.strictEqual(tmpSt.size, dupBefore.size, 'reflink 后大小必须一致');
  // 原子替换
  rmSync(dup);
  copyFileSync(tmpRef, dup, fsConstants.COPYFILE_FICLONE_FORCE);
  rmSync(tmpRef);

  const keepAfter = statSync(keep);
  const dupAfter = statSync(dup);
  teardown();

  // 核心断言 1：inode 不同（区别于 hardlink）
  assert.notStrictEqual(dupAfter.ino, keepAfter.ino,
    'reflink 后仍应是独立 inode（这正是它比 hardlink 安全的地方）');
  // 核心断言 2：大小一致
  assert.strictEqual(dupAfter.size, keepAfter.size, '大小应保持一致');
});

test('reflink: COW 语义 —— 改副本不影响原始文件', () => {
  setup();
  if (!reflinkSupported()) { teardown(); console.log('  (跳过：不支持 reflink)'); return; }

  const keep = join(TMP, 'a.bin');
  const dup = join(TMP, 'b.bin');
  writeFileSync(keep, Buffer.alloc(65536, 0x11));
  copyFileSync(keep, dup, fsConstants.COPYFILE_FICLONE_FORCE);

  // 改副本前 8 字节
  const fd = openSync(dup, 'r+');
  writeSync(fd, Buffer.from([0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99]), 0, 8, 0);
  closeSync(fd);

  const keepHead = readFileSync(keep).subarray(0, 8);
  const dupHead = readFileSync(dup).subarray(0, 8);
  teardown();

  // 原始文件必须还是 0x11（这正是 reflink 相对 hardlink 的核心优势）
  assert.deepStrictEqual(Array.from(keepHead), [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11],
    'COW 生效：改副本不应影响原始文件');
  // 副本已改成 0x99
  assert.deepStrictEqual(Array.from(dupHead), [0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99],
    '副本自身应已被修改');
});

test('reflink: COPYFILE_FICLONE_FORCE 在不支持的文件系统上抛错而非静默复制', () => {
  // 这条最关键：如果用 COPYFILE_FICLONE(2)，不支持时会静默退化成真拷贝，
  // 2GB 文件瞬间占 2GB 额外空间可能撑爆卷。必须是 FORCE(4)。
  assert.notStrictEqual(fsConstants.COPYFILE_FICLONE_FORCE, fsConstants.COPYFILE_FICLONE,
    'FICLONE_FORCE 必须与 FICLONE 是不同的常量值');
  assert.strictEqual(fsConstants.COPYFILE_FICLONE_FORCE, 4, 'FICLONE_FORCE 的值应为 4');
});

test('dup.js 的 reflink 分支具备与 hardlink 同等的安全护栏', async () => {
  // 源码级断言：reflink 分支不得跳过这些检查，否则会重演 hardlink 早期
  // "先删后建链接 → 失败即不可恢复" 的事故。
  const src = readFileSync(join(PROJ, 'app', 'ui', 'api', 'dup.js'), 'utf8');
  const idx = src.indexOf("mode === 'reflink'");
  assert.ok(idx > 0, 'dup.js 应包含 reflink 分支');

  // 截取 reflink 分支到 trash 分支之间
  const branch = src.slice(idx, src.indexOf('} else {  // trash', idx));

  assert.ok(branch.includes('COPYFILE_FICLONE_FORCE'),
    '必须使用 COPYFILE_FICLONE_FORCE，不能用会静默复制的 COPYFILE_FICLONE');
  assert.ok(branch.includes('isDeletablePath(keep)'),
    '原始文件路径必须过 isDeletablePath 检查');
  assert.ok(branch.includes('fpSt.dev !== keepSt.dev'),
    '必须检查同一文件系统（跨设备 FICLONE 会失败）');
  assert.ok(branch.includes('renameSync(tmpRef, fp)'),
    '必须是"先写临时名再原子 rename"，不能先删原文件');
  assert.ok(branch.indexOf('unlinkSync(tmpRef)') < branch.indexOf('copyFileSync'),
    '临时文件清理应发生在创建之前');
  assert.ok(branch.includes('ENOTSUP') && branch.includes('EOPNOTSUPP'),
    '必须把不支持的文件系统错误翻译成可读提示');
  assert.ok(!/(^|[^k])unlinkSync\(fp\)/.test(branch),
    'reflink 分支不得直接 unlinkSync(fp) —— 必须先成功创建克隆再 rename 替换');
});
