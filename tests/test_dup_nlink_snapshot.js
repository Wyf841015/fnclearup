// ── P0-1/P0-2 回归测试：硬链接与快照不应计入"可释放空间" ──
//
// 背景：旧实现 `wasted = rest.reduce((s,f) => s + f.size)` 假设"删一份副本 = 省一份大小"。
// 这在两种情况下是假账：
//   ① 硬链接 —— 组内多个路径指向同一 inode，或 nlink>1 说明组外还有链接，
//      删掉其中一个后数据块仍被引用，实际释放 0 字节
//   ② btrfs 快照 —— 快照与主卷共享 extent，删快照里的副本同样不释放空间
//
// 测试用真实文件系统造场景（临时目录），跑 dup_scan.js 子进程，断言 stats 与分组字段。
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, linkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCAN = new URL('../app/dup_scan.js', import.meta.url).pathname;
const TMP = join(process.env.TMPDIR || '/tmp', 'fnclearup_p0_test_' + process.pid);

function setup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function teardown() {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}

// 跑一次扫描，返回 { state, stats, duplicates }
function runScan(scanPath, stateDir, extraArgs = []) {
  const r = spawnSync(process.execPath, [
    SCAN, 'files', scanPath, 'first', stateDir, '0', 'default', ...extraArgs,
  ], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) {
    throw new Error(`dup_scan failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  // 状态文件命名规则：<stateDir>/<jobId>.json；jobId 由参数决定时不好猜，
  // 这里直接读目录里最新的 json（排除 hash cache）
  const { readdirSync, readFileSync, statSync } = require('node:fs');
  const files = readdirSync(stateDir)
    .filter(f => f.endsWith('.json') && f !== 'dup_hash_cache.json')
    .map(f => ({ f, t: statSync(join(stateDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error('no state file produced');
  return JSON.parse(readFileSync(join(stateDir, files[0].f), 'utf8'));
}

// 用 import 拿 require（ESM 里没有 require）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('P0-1 硬链接：同一 inode 的两个路径不计入可释放空间', () => {
  setup();
  const dataDir = join(TMP, 'data');
  const stateDir = join(TMP, 'state');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const payload = 'X'.repeat(8192);
  const a = join(dataDir, 'a.txt');
  const b = join(dataDir, 'b.txt');
  writeFileSync(a, payload);
  linkSync(a, b);           // b 是 a 的硬链接 → 同一 inode，nlink=2

  const state = runScan(dataDir, stateDir);
  teardown();

  assert.strictEqual(state.status, 'complete', '扫描应完成');
  assert.strictEqual(state.stats.duplicateGroups, 1, '应识别出 1 个重复组');
  // 核心断言：硬链接不释放空间
  assert.strictEqual(state.stats.wastedBytes, 0,
    `硬链接组可释放空间应为 0，实际 ${state.stats.wastedBytes}`);
  assert.strictEqual(state.stats.hardlinkBlockedBytes, 8192,
    '应记录被硬链接挡住的 8192 字节');
  const g = state.duplicates[0];
  assert.strictEqual(g.hasHardlink, true, '组应标记含硬链接');
  assert.ok(g.fileMeta.every(f => f.shared === true), '两个路径都应标记 shared');
});

test('P0-1 nlink>1 且链接在扫描范围外：删除仍不释放空间', () => {
  setup();
  const dataDir = join(TMP, 'data');
  const outside = join(TMP, 'outside');
  const stateDir = join(TMP, 'state');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const payload = 'Y'.repeat(4096);
  // keep.txt 与 out/keep_link.txt 是硬链接；dup.txt 是独立副本
  const keep = join(dataDir, 'keep.txt');
  writeFileSync(keep, payload);
  linkSync(keep, join(outside, 'keep_link.txt'));   // nlink=2，其中一个在扫描范围外
  writeFileSync(join(dataDir, 'dup.txt'), payload);  // 独立 inode，与 keep 内容相同

  const state = runScan(dataDir, stateDir);
  teardown();

  assert.strictEqual(state.stats.duplicateGroups, 1);
  const g = state.duplicates[0];
  // 组内 2 个文件：keep.txt(nlink=2) 和 dup.txt(nlink=1)
  // keep 模式 first → 保留字典序更小的 dup.txt，要删 keep.txt
  // 删 keep.txt 后 out/keep_link.txt 仍引用数据 → 不释放空间
  assert.strictEqual(state.stats.wastedBytes, 0,
    `含外部硬链接的组可释放应为 0，实际 ${state.stats.wastedBytes}`);
  assert.ok(g.hardlinkBlocked > 0, '应记录被硬链接挡住的字节');
});

test('P0-2 快照目录内的文件不计入可释放空间', () => {
  setup();
  const dataDir = join(TMP, 'data');
  const stateDir = join(TMP, 'state');
  const snapDir = join(dataDir, '.snapshots', 'snap1');
  mkdirSync(snapDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const payload = 'Z'.repeat(16384);
  writeFileSync(join(dataDir, 'photo.jpg'), payload);
  writeFileSync(join(snapDir, 'photo.jpg'), payload);   // 快照副本（内容相同，独立 inode）

  const state = runScan(dataDir, stateDir);
  teardown();

  assert.strictEqual(state.stats.duplicateGroups, 1, '应识别出快照重复组');
  assert.strictEqual(state.stats.wastedBytes, 0,
    `快照副本可释放应为 0，实际 ${state.stats.wastedBytes}`);
  assert.strictEqual(state.stats.snapshotBlockedBytes, 16384,
    '应记录被快照挡住的 16384 字节');
  const g = state.duplicates[0];
  assert.strictEqual(g.hasSnapshot, true, '组应标记含快照成员');
  assert.ok(g.fileMeta.some(f => f.snapshot === true), '快照内路径应标记 snapshot');
  // 快照文件不应被列为可删除
  assert.strictEqual(g.reclaimableFiles, 0, '快照组不应有可删除文件');
});

test('正常重复（独立 inode、非快照）仍应正常计算可释放空间', () => {
  setup();
  const dataDir = join(TMP, 'data');
  const stateDir = join(TMP, 'state');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const payload = 'W'.repeat(10240);
  writeFileSync(join(dataDir, 'one.txt'), payload);
  writeFileSync(join(dataDir, 'two.txt'), payload);
  writeFileSync(join(dataDir, 'three.txt'), payload);

  const state = runScan(dataDir, stateDir);
  teardown();

  assert.strictEqual(state.stats.duplicateGroups, 1);
  // 3 个独立 inode、nlink 都是 1 → 保留 1 个，删 2 个，释放 2×10240
  assert.strictEqual(state.stats.wastedBytes, 20480,
    `三个独立副本应可释放 20480 字节，实际 ${state.stats.wastedBytes}`);
  const g = state.duplicates[0];
  assert.strictEqual(g.reclaimableFiles, 2, '应有 2 个文件可删');
  assert.strictEqual(g.hasHardlink, false, '不应误标硬链接');
  assert.strictEqual(g.hasSnapshot, false, '不应误标快照');
  assert.strictEqual(state.stats.hardlinkBlockedBytes, 0);
  assert.strictEqual(state.stats.snapshotBlockedBytes, 0);
});
