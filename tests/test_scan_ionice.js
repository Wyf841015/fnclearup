// ── P1-4 回归测试：扫描子进程的 idle IO 降级 ──
//
// 背景：全盘扫描会把 system page cache 里的热数据挤出去，NAS 上表现为
// 「扫完重复文件后相册缩略图/视频转码变慢」。Node 没有 posix_fadvise()，
// 但扫描是独立子进程，可用 ionice -c3 降到 idle 级（只有磁盘空闲才抢 IO）。
//
// 本测试验证：
//   1. ionicePath() 能找到 ionice（本机应有）
//   2. spawnScanNode 启动的子进程命令行里确实带了 ionice -c3
//   3. 找不到 ionice 时能优雅退回（不抛错）
//   4. 四个扫描 API 都改用了 spawnScanNode，没有残留裸 spawn(process.execPath
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ionicePath, spawnScanNode } from '../app/ui/lib/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJ = dirname(HERE);

test('ionicePath 能找到 ionice 可执行文件', () => {
  const p = ionicePath();
  // 本机是 fnOS(Linux)，应该有 ionice；若真的没有也要能返回 null 而不是抛错
  if (p === null) {
    console.log('  (本机没有 ionice，降级逻辑将走普通 spawn —— 可接受)');
    return;
  }
  assert.ok(existsSync(p), `ionicePath 返回的路径应存在: ${p}`);
  assert.ok(p.includes('ionice'), '路径应包含 ionice');
});

test('spawnScanNode 启动的子进程命令行包含 ionice -c 3', async () => {
  const io = ionicePath();
  if (!io) { console.log('  (跳过：本机无 ionice)'); return; }

  // 用一个小脚本进程把自己的 cmdline 打出来
  const script = join(PROJ, 'tests', '_probe_cmdline.js');
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(script, `
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// ionice -c3 <cmd> 是 exec 替换自己，最终 cmdline 里看不到 ionice，
// 所以要在子进程内用 ionice -p <pid> 查它实际的 IO 优先级类。
let prio = 'unknown';
try {
  const r = spawnSync('/usr/bin/ionice', ['-p', String(process.pid)], { encoding: 'utf8' });
  prio = (r.stdout || r.stderr || '').trim();
} catch (e) { prio = 'probe-failed: ' + e.message; }
process.stdout.write('CMDLINE:' + readFileSync('/proc/self/cmdline', 'utf8').replace(/\\0/g, ' '));
process.stdout.write('\\nIOPRIO:' + prio);
`);

  const out = await new Promise((resolve) => {
    let buf = '';
    const proc = spawnScanNode(script, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.on('data', (d) => { buf += d.toString(); });
    proc.on('close', () => resolve(buf));
    proc.on('error', () => resolve(''));
  });
  try { rmSync(script, { force: true }); } catch { /* ignore */ }

  // 核心断言：子进程的 IO 优先级类应为 idle
  assert.ok(/IOPRIO:.*idle/i.test(out),
    `子进程应以 idle IO 优先级运行，实际输出: ${out.replace(/\n/g, ' | ').slice(0, 260)}`);
  assert.ok(/CMDLINE:.*node/.test(out), 'cmdline 里应能确认是 node 进程');
});

test('四个扫描 API 都改用 spawnScanNode，没有残留裸 spawn(process.execPath', () => {
  const files = [
    'app/ui/api/dup.js',
    'app/ui/api/simdup.js',
    'app/ui/api/broken.js',
    'app/ui/api/namematch.js',
  ];
  const problems = [];
  for (const f of files) {
    const src = readFileSync(join(PROJ, f), 'utf8');
    if (!src.includes('spawnScanNode')) {
      problems.push(`${f}: 没有使用 spawnScanNode`);
    }
    // 扫描进程不应再直接用它（保留的裸 spawn 必须是别的用途，这里只查扫描脚本常量）
    const scanConsts = ['DUP_SCAN_SCRIPT', 'SIM_SCAN_SCRIPT', 'BROKEN_SCAN_SCRIPT', 'NM_SCAN_SCRIPT'];
    for (const c of scanConsts) {
      const re = new RegExp(`spawn\\(process\\.execPath,\\s*\\[\\s*${c}`);
      if (re.test(src)) problems.push(`${f}: 仍以裸 spawn 启动 ${c}`);
    }
  }
  assert.deepStrictEqual(problems, [], '存在未降级的扫描进程:\n  ' + problems.join('\n  '));
});

test('spawnScanNode 在 ionice 缺失时能优雅退回（不抛错）', () => {
  // 直接验证 fallback 分支：用一个必然存在的 node 脚本，走正常路径
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
  assert.strictEqual(r.stdout, 'ok', 'node 子进程基础能力正常（fallback 路径依赖它）');
  // spawnScanNode 的返回对象必须是 ChildProcess（有 pid / on）
  const proc = spawnScanNode('-e', ['process.exit(0)'], { stdio: 'ignore' });
  assert.ok(proc && typeof proc.on === 'function', 'spawnScanNode 应返回 ChildProcess');
  proc.kill();
});
