// tests/test_ext_trash.mjs
// 外接存储（U 盘 / 移动硬盘）回收站支持 —— 回归测试
//
// 背景：fnOS 把可移除设备挂在 /vol00 /vol01 …，这些卷是 exFAT/NTFS，
// 没有 /volN/<UID>/.@#local/trash，之前要么删不掉、要么降级成永久删除。
// 现在改为同盘 <挂载根>/_fnclearup_trash/<相对路径>，可恢复。
//
// 安全：所有真实文件系统操作只在 /tmp/fnclearup_test 沙箱内进行（TRM_FNCLEARUP_TEST=1），
// 绝不触碰真实 /vol*。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.TRM_FNCLEARUP_TEST = '1';

const SRC = new URL('../app/ui/lib/', import.meta.url).pathname;
const {
  EXT_TRASH_DIR, isExternalVolumePath, extTrashTarget, findMountRoot,
  parseMounts, isExtTrashPath, uniqueDest, moveToExtTrash,
} = await import(join(SRC, 'ext_trash.js'));
const { isSafePath, protectedReason } = await import(join(SRC, 'util.js'));

const SANDBOX = '/tmp/fnclearup_test';
const VOL = join(SANDBOX, 'vol00');            // 模拟 /vol00
const USB = join(VOL, 'USB_NAME');             // 模拟设备挂载点 /vol00/USB_NAME

before(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(join(USB, 'photos', '2026'), { recursive: true });
  writeFileSync(join(USB, 'photos', '2026', 'a.jpg'), 'AAAA');
  writeFileSync(join(USB, 'photos', 'b.jpg'), 'BBBB');
});

after(() => rmSync(SANDBOX, { recursive: true, force: true }));

describe('isExternalVolumePath - 哪些路径算外接盘', () => {
  test('识别 /vol00 /vol01 /vol03', () => {
    for (const p of ['/vol00', '/vol00/x', '/vol01/a/b', '/vol03/y']) {
      assert.equal(isExternalVolumePath(p), true, p);
    }
  });

  test('网盘 /vol02 不算外接盘（fuse 建不了回收站）', () => {
    assert.equal(isExternalVolumePath('/vol02'), false);
    assert.equal(isExternalVolumePath('/vol02/1000-1-abc/x'), false);
  });

  test('内置卷和系统目录不算外接盘', () => {
    for (const p of ['/vol1', '/vol1/1000/a', '/vol3/@appcenter', '/vol10/x', '/tmp/x', '/etc/passwd']) {
      assert.equal(isExternalVolumePath(p), false, p);
    }
  });
});

describe('findMountRoot - 挂载点按最长前缀匹配', () => {
  const mounts = parseMounts([
    '/dev/sdc2 / ext4 rw 0 0',
    '/dev/sdq1 /vol00 exfat rw 0 0',
    '/dev/sdq1 /vol00/USB_NAME ntfs rw 0 0',
  ].join('\n'));

  test('设备挂在 /vol00/USB_NAME 时，取更深的那层', () => {
    assert.equal(findMountRoot('/vol00/USB_NAME/photos/a.jpg', mounts), '/vol00/USB_NAME');
  });

  test('设备直接挂在 /vol00 时取 /vol00', () => {
    assert.equal(findMountRoot('/vol00/photos/a.jpg', mounts), '/vol00');
  });

  test('没有 mountinfo 时退回卷根', () => {
    assert.equal(findMountRoot('/vol00/USB_NAME/photos/a.jpg', []), '/vol00');
  });
});

describe('extTrashTarget - 回收站落点', () => {
  const mounts = parseMounts('/dev/sdq1 /vol00/USB_NAME ntfs rw 0 0');

  test('回收站落在文件所在文件系统的根下', () => {
    const t = extTrashTarget('/vol00/USB_NAME/photos/2026/a.jpg', mounts);
    assert.equal(t.root, '/vol00/USB_NAME');
    assert.equal(t.dest, '/vol00/USB_NAME/_fnclearup_trash/photos/2026/a.jpg');
  });

  test('非外接路径返回 null', () => {
    assert.equal(extTrashTarget('/vol1/1000/a.jpg', mounts), null);
    assert.equal(extTrashTarget('/vol02/1000-1-a/b.jpg', mounts), null);
  });

  test('卷根自身不能当删除目标', () => {
    assert.equal(extTrashTarget('/vol00', mounts), null);
  });
});

describe('moveToExtTrash - 真实移动（沙箱内）', () => {
  const mounts = parseMounts(`/dev/x ${VOL} exfat rw 0 0`);

  test('文件移进同盘 _fnclearup_trash 且内容完整', () => {
    const fp = join(USB, 'photos', 'b.jpg');
    const dest = moveToExtTrash(fp, mounts);
    assert.ok(dest, '应返回落点');
    assert.ok(dest.includes(EXT_TRASH_DIR), dest);
    assert.equal(existsSync(fp), false, '原文件应已移走');
    assert.equal(readFileSync(dest, 'utf8'), 'BBBB');
  });

  test('同名重复时追加 _1 后缀，不覆盖已有回收站文件', () => {
    const fp = join(USB, 'photos', 'b.jpg');
    writeFileSync(fp, 'BBBB-2');
    const dest = moveToExtTrash(fp, mounts);
    assert.ok(dest.endsWith('b_1.jpg'), dest);
    assert.equal(readFileSync(dest, 'utf8'), 'BBBB-2');
  });

  test('目录也能整体移走', () => {
    const dir = join(USB, 'photos', '2026');
    const dest = moveToExtTrash(dir, mounts);
    assert.ok(dest && dest.endsWith('2026'), String(dest));
    assert.equal(existsSync(dir), false);
    assert.equal(readFileSync(join(dest, 'a.jpg'), 'utf8'), 'AAAA');
  });

  test('非外接路径返回 null（不接管内置卷）', () => {
    assert.equal(moveToExtTrash('/vol1/1000/a.jpg', mounts), null);
  });
});

describe('isExtTrashPath / uniqueDest', () => {
  test('回收站内路径识别', () => {
    assert.equal(isExtTrashPath('/vol00/USB_NAME/_fnclearup_trash/a.jpg'), true);
    assert.equal(isExtTrashPath('/vol00/USB_NAME/photos/a.jpg'), false);
    assert.equal(isExtTrashPath('/vol02/_fnclearup_trash/a.jpg'), false);
  });

  test('uniqueDest 在沙箱里递增后缀', () => {
    const d = join(SANDBOX, 'uniq');
    mkdirSync(d, { recursive: true });
    const f = join(d, 'x.txt');
    assert.equal(uniqueDest(f), f);
    writeFileSync(f, '1');
    assert.equal(uniqueDest(f), join(d, 'x_1.txt'));
    writeFileSync(join(d, 'x_1.txt'), '2');
    assert.equal(uniqueDest(f), join(d, 'x_2.txt'));
  });
});

describe('util.js 联动 - 路径校验与保护', () => {
  test('外接盘路径通过 isSafePath', () => {
    assert.equal(isSafePath('/vol00/USB_NAME/photos'), true);
    assert.equal(isSafePath('/vol01/x'), true);
    assert.equal(isSafePath('/vol1/1000/x'), true);
    assert.equal(isSafePath('/etc/passwd'), false);
  });

  test('_fnclearup_trash 受保护，清理扫描不能直接删掉回收站', () => {
    const why = protectedReason('/vol00/USB_NAME/_fnclearup_trash/photos/a.jpg', { exemptSelf: false });
    assert.ok(why && why.includes(EXT_TRASH_DIR), String(why));
  });
});
