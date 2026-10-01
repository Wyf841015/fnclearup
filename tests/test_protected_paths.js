// fnOS 系统目录删除保护 (P0 安全) 回归测试 — 2026-09-30
//
// 问题: isSafePath 的白名单只到 "/vol*" 粒度, 而 fnOS 的系统与应用目录
//       全部位于 /volN/@xxx 之下, 全部通过校验。重复文件扫描常在这些目录
//       间发现同名文件(各应用的 LICENSE、图标、依赖), 用户勾选删除即会
//       误删其他应用的安装文件与运行数据。
//
// 覆盖: 8 个系统目录、回收站、用户 @ 开头目录不误伤、自身数据目录豁免、
//       三个文件清理端点接入、应用卸载端点 app.js 刻意不接入。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(__dirname, '..', 'app', 'ui');
const utilSrc = fs.readFileSync(path.join(UI, 'lib', 'util.js'), 'utf8');
const read = f => fs.readFileSync(path.join(UI, 'api', f), 'utf8');

test('8 个 fnOS 系统目录全部列入保护名单', () => {
  for (const d of ['@appcenter', '@appconf', '@appdata', '@apphome',
                   '@appmeta', '@appshare', '@apptemp', '@sysappmeta']) {
    assert.ok(utilSrc.includes(`'${d}'`),
      `${d} 未列入 FNOS_SYSTEM_DIRS`);
  }
});

test('保护判定覆盖系统目录与回收站, 但不误伤用户自己的 @ 目录', async () => {
  const { protectedReason, isDeletablePath } = await import('../app/ui/lib/util.js');
  for (const d of ['@appcenter', '@appdata', '@appmeta', '@sysappmeta']) {
    const p = `/vol3/${d}/fnlogpush/ui/server.js`;
    assert.ok(protectedReason(p), `${p} 应被保护`);
    assert.ok(!isDeletablePath(p), `${p} 不应可删`);
  }
  const trash = '/vol1/1000/.@#local/trash/2026/x.bin';
  assert.ok(protectedReason(trash), '卷内回收站应被保护');
  assert.ok(/回收站/.test(protectedReason(trash)), '回收站应给出可读原因');
  // 关键: 用户自己的 @ 开头目录不能误伤
  for (const p of ['/vol1/1000/@我的照片/a.jpg', '/vol1/1000/@backup/x.bin']) {
    assert.ok(!protectedReason(p), `${p} 是用户目录, 不应被保护`);
    assert.ok(isDeletablePath(p), `${p} 应可删`);
  }
});

test('普通用户数据目录照常可删', async () => {
  const { isDeletablePath } = await import('../app/ui/lib/util.js');
  for (const p of ['/vol1/1000/照片/a.jpg', '/vol2/1000/Downloads/a.mkv',
                   '/vol3/1000/hermes/fnclearup/README.md']) {
    assert.ok(isDeletablePath(p), `${p} 应可删`);
  }
});

test('应用自身数据目录: 读写场景豁免, 但删除场景不豁免', async () => {
  const prev = process.env.TRM_PKGVAR;
  process.env.TRM_PKGVAR = '/vol3/@appdata/fnclearup';
  try {
    const { protectedReason, isDeletablePath } = await import('../app/ui/lib/util.js');
    const own = '/vol3/@appdata/fnclearup/data/dup_hash_cache.json';
    // 默认(读写场景)豁免: 应用要能写自己的哈希缓存 / manifest / 导出
    assert.ok(!protectedReason(own), '读写场景下自身数据目录应豁免');
    // 删除场景必须不豁免: 否则清理工具会把自己的缓存/审计清单一起删掉
    assert.ok(protectedReason(own, { exemptSelf: false }),
      '删除场景下自身数据目录也必须受保护');
    assert.ok(!isDeletablePath(own), 'isDeletablePath 不应豁免自身数据目录');
    // 同一 @appdata 下的其他应用在两种场景都受保护
    assert.ok(protectedReason('/vol3/@appdata/fnstat/records.db'),
      '同卷其他应用的数据目录仍应受保护');
  } finally {
    if (prev === undefined) delete process.env.TRM_PKGVAR; else process.env.TRM_PKGVAR = prev;
  }
});

test('partitionDeletable 正确分组并给出逐条原因', async () => {
  const { partitionDeletable } = await import('../app/ui/lib/util.js');
  const { ok, blocked } = partitionDeletable([
    '/vol1/1000/照片/a.jpg',
    '/vol3/@appcenter/fnlogpush/ui/server.js',
    '/etc/passwd',
    '/vol1/1000/.@#local/trash/x.bin',
  ]);
  assert.deepEqual(ok, ['/vol1/1000/照片/a.jpg']);
  assert.equal(blocked.length, 3);
  const byPath = Object.fromEntries(blocked.map(b => [b.path, b.reason]));
  assert.match(byPath['/vol3/@appcenter/fnlogpush/ui/server.js'], /fnOS 系统目录受保护/);
  assert.match(byPath['/etc/passwd'], /路径越界/);
  assert.match(byPath['/vol1/1000/.@#local/trash/x.bin'], /回收站目录受保护/);
  for (const b of blocked) assert.ok(b.reason && b.reason.length > 0, '每条拦截都需给出原因');
});

test('三个文件清理端点均接入 partitionDeletable', () => {
  for (const f of ['dup.js', 'bigfiles.js', 'empty_dir.js']) {
    const s = read(f);
    assert.ok(/partitionDeletable/.test(s), `${f} 未接入 partitionDeletable`);
    assert.ok(/blockedCount: blocked\.length/.test(s), `${f} 未回传 blockedCount`);
    assert.ok(/blocked: blocked\.slice\(0, \d+\)/.test(s), `${f} 未回传 blocked 明细(需限长)`);
    // 声明必须早于使用
    const d = s.search(/const \{ ok: \w+, blocked \}/);
    const u = s.search(/blockedCount: blocked\.length/);
    assert.ok(d >= 0 && u > d, `${f} 的 blocked 使用早于声明`);
  }
});

test('硬链接保留路径也走更严的 isDeletablePath', () => {
  const s = read('dup.js');
  assert.ok(/isDeletablePath\(keep\)/.test(s),
    'dup 的 hardlink 模式保留路径未加严, 仍用 isSafePath');
});

test('应用卸载端点 app.js 刻意不接入该保护', () => {
  // app.js 的功能就是删除 /volN/@appcenter/<app> 与 @appshare/<app>(应用卸载),
  // 套用文件清理的保护会直接废掉卸载能力。改动时务必保持现状。
  const s = read('app.js');
  assert.ok(!/partitionDeletable|isDeletablePath/.test(s),
    'app.js 不应接入文件清理用的保护规则 — 它的语义是应用卸载');
  assert.ok(/@appshare/.test(s), 'app.js 应仍在处理 @appshare 残留');
});

test('扫描/查询类端点保持 isSafePath(可见但不可删)', () => {
  // 扫描不受影响: 用户仍可看到 @appcenter 里的重复文件, 只是删不掉
  for (const f of ['simdup.js', 'broken.js', 'namematch.js', 'diskanalysis.js']) {
    const s = read(f);
    assert.ok(/isSafePath/.test(s), `${f} 扫描路径校验不应被改动`);
    assert.ok(!/isDeletablePath/.test(s), `${f} 是只读端点, 不需要 isDeletablePath`);
  }
});
