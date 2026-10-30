// PKGVAR 解析回归测试
//   node --test tests/test_pkgvar.js
//
// 覆盖的现场问题：
//   以前落盘路径写死 `process.env.TRM_PKGVAR || '/vol3/@appdata/fnclearup'`。
//   fnOS 框架启动会注入 TRM_PKGVAR（值跟着安装卷走），手动 `node ui/server.js`
//   时没有该变量 → 掉回写死的 /vol3，于是同一台机器上出现两套数据目录：
//   开关（ui-prefs.json）在一处、计划任务（schedule.json）在另一处。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { derivePkgVarFromPath, derivePkgVar, getPkgVar, pkgDataDir } from '../app/ui/lib/pkgvar.js';
import { getManifestDir } from '../app/ui/lib/util.js';

const LEGACY = '/vol3/@appdata/fnclearup';

test('从安装路径反推：<vol>/@appcenter/<app>/… → <vol>/@appdata/<app>', () => {
  assert.equal(derivePkgVarFromPath('/vol1/@appcenter/fnclearup/ui/lib/pkgvar.js'), '/vol1/@appdata/fnclearup');
  assert.equal(derivePkgVarFromPath('/vol3/@appcenter/fnclearup/ui/server.js'), '/vol3/@appdata/fnclearup');
  assert.equal(derivePkgVarFromPath('/vol10/@appcenter/fnclearup'), '/vol10/@appdata/fnclearup');
  // 应用名从路径里取，不写死（换目录名也算对）
  assert.equal(derivePkgVarFromPath('/vol2/@appcenter/otherapp/ui/x.js'), '/vol2/@appdata/otherapp');
});

test('不是安装目录就返回 null（开发仓库 / 已解析的软链 / 缺应用段）', () => {
  assert.equal(derivePkgVarFromPath('/vol3/1000/hermes/fnclearup/app/ui/lib/pkgvar.js'), null);
  assert.equal(derivePkgVarFromPath('/var/apps/fnclearup/target/ui/server.js'), null);
  assert.equal(derivePkgVarFromPath('/vol3/@appdata/fnclearup/ui/x.js'), null);
  assert.equal(derivePkgVarFromPath('/@appcenter/fnclearup/ui/x.js'), null, '卷段不能为空');
  assert.equal(derivePkgVarFromPath(''), null);
  assert.equal(derivePkgVarFromPath(null), null);
});

test('derivePkgVar 接受注入的 moduleUrl（软链解析失败也能用原路径）', () => {
  const fake = pathToFileURL('/vol1/@appcenter/fnclearup/ui/lib/pkgvar.js').href;
  assert.equal(derivePkgVar(fake), '/vol1/@appdata/fnclearup');
});

test('env 优先：TRM_PKGVAR 存在时原样使用（框架启动路径不变）', () => {
  const bak = process.env.TRM_PKGVAR;
  try {
    process.env.TRM_PKGVAR = '/vol1/@appdata/fnclearup';
    assert.equal(getPkgVar(), '/vol1/@appdata/fnclearup');
    process.env.TRM_PKGVAR = '  /vol2/@appdata/fnclearup  ';   // 前后空白要 trim
    assert.equal(getPkgVar(), '/vol2/@appdata/fnclearup');
    process.env.TRM_PKGVAR = '   ';                             // 只有空白 → 视为没设
    assert.ok(getPkgVar().startsWith('/'), '空白 env 不能变成空路径');
  } finally {
    if (bak === undefined) delete process.env.TRM_PKGVAR; else process.env.TRM_PKGVAR = bak;
  }
});

test('无 env 且无法反推时退回历史兜底（不抛错、不留空）', () => {
  const bak = process.env.TRM_PKGVAR;
  try {
    delete process.env.TRM_PKGVAR;
    const v = getPkgVar();                    // 测试在开发仓库里跑 → 反推为 null
    assert.equal(v, LEGACY);
    assert.equal(pkgDataDir(), join(LEGACY, 'data'));
    assert.equal(pkgDataDir('manifests'), join(LEGACY, 'data', 'manifests'));
  } finally {
    if (bak !== undefined) process.env.TRM_PKGVAR = bak;
  }
});

test('同一 PKGVAR 下：manifest 目录与 data 目录同源（不会再分家）', () => {
  const bakEnv = process.env.TRM_PKGVAR;
  const bakTest = process.env.TRM_FNCLEARUP_TEST;
  try {
    delete process.env.TRM_FNCLEARUP_TEST;     // 关掉测试夹具覆盖
    process.env.TRM_PKGVAR = '/vol1/@appdata/fnclearup';
    assert.equal(getManifestDir(), join('/vol1/@appdata/fnclearup', 'data', 'manifests'));

    delete process.env.TRM_PKGVAR;              // 手动启动场景
    const pkg = getPkgVar();
    assert.equal(getManifestDir(), join(pkg, 'data', 'manifests'),
      '手动启动时 manifest 目录也必须跟着同一个 PKGVAR');
  } finally {
    if (bakEnv === undefined) delete process.env.TRM_PKGVAR; else process.env.TRM_PKGVAR = bakEnv;
    if (bakTest === undefined) delete process.env.TRM_FNCLEARUP_TEST; else process.env.TRM_FNCLEARUP_TEST = bakTest;
  }
});
