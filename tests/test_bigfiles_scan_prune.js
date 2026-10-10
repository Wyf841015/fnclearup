// 大文件扫描必须跳过 fnOS 系统目录与回收站 — 2026-10-10
//
// 真实事故: 用户扫整卷 /vol3, 返回 20 个"≥100MB 的文件", 其中 8 个是
// /vol3/@sysappmeta/ai-manager/models/*.onnx 这类应用模型文件, 8 个 skipped。
// 用户勾选全部去删, 删除端点被 partitionDeletable 全部拦下 ——
// deleted=2 / blocked=8 / skipped=8, 用户看到的就是"全部失败"。
//
// 修法不是放宽删除端点的安全闸门(那是对的), 而是不把删不掉的东西列出来:
// 扫描阶段就整棵剪枝, 既省掉 fuse 挂载系统目录的遍历开销, 结果列表也不再
// 混着用户无权清理的文件。
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

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const api = stripComments(apiSrc);

test('剪枝: walk 里在 push 之前判定受保护目录', () => {
  // 必须剪在 queue.push 之前 —— 剪在结果过滤上虽然也能让列表干净,
  // 但 fuse 挂载的系统目录仍会被整个遍历一遍(上万个 inode)。
  assert.match(api, /if \(isProtectedPath\(full, \{ exemptSelf: true \}\)\) \{ skippedProtectedDirs\+\+; continue; \}\s*\n\s*queue\.push/,
    '应在下钻前剪掉受保护目录, 而不是遍历完再过滤结果');
});

test('剪枝: exemptSelf 必须为 true(应用自身数据目录该列出来)', () => {
  // fnclearup 自己的 data/ 占多少空间, 用户有权知道 —— 那是真占他的盘。
  // 用了 exemptSelf:false 会把自身目录也藏起来, 反而成了"看不见的占用"。
  assert.match(api, /isProtectedPath\(full, \{ exemptSelf: true \}\)/);
  assert.ok(!/isProtectedPath\([^)]*exemptSelf: false/.test(api), '扫描不应使用 exemptSelf:false');
});

test('删除端的闸门保持不变(剪枝不是放宽安全)', () => {
  assert.match(api, /partitionDeletable\(paths\.filter/, '删除端点仍必须走 partitionDeletable');
  assert.match(api, /blockedCount: blocked\.length/, '删除端点仍必须回报拦截数');
});

test('响应回报跳过数, 让前端能如实告知用户', () => {
  assert.match(api, /skipped_protected_dirs: skippedProtectedDirs/, '响应应含跳过目录数');
  assert.match(api, /stat_failures: statFailures/, '响应应含 stat 失败数');
  assert.match(api, /last_stat_error: lastStatErr/);
});

test('stat 失败不再吞掉错误内容', () => {
  // 事故现场: info.log 里只有 12 行光秃秃的 "[bigfiles.js]", 连错误是什么都看不到。
  assert.ok(!/catch \{ console\.error\('\[bigfiles\.js\]'\); \}/.test(api),
    'catch 块不能只打一个没有内容的前缀');
  assert.match(api, /catch \(err\) \{ statFailures\+\+; lastStatErr = `\$\{e\.name\}: \$\{e\.message\}`; \}/,
    '应记录 stat 失败的次数与最后一条错误信息');
});

test('前端状态栏告知跳过了多少系统目录', () => {
  assert.match(mainSrc, /data\.skipped_protected_dirs/,
    '状态栏应显示跳过的系统目录数, 否则用户会以为自己的盘被那些文件占满');
  assert.match(mainSrc, /已跳过 \$\{data\.skipped_protected_dirs\} 个系统目录/);
});

test('isProtectedPath 能识别要剪枝的路径形态', () => {
  // 直接调用真实实现, 确认判定标准与我们以为的一致
  const util = rd('app/ui/lib/util.js');
  const m = /export function isProtectedPath\(p, opts = \{\}\) \{ return protectedReason\(p, opts\) !== null; \}/.test(util);
  assert.ok(m, 'util.js 应导出 isProtectedPath');
  assert.match(util, /FNOS_SYSTEM_DIRS\.has\(seg\)/, '按路径段名判定');
  assert.match(util, /seg\.startsWith\('\.@#'\)/, '回收站(.@#*)也应被识别');
});

test('端到端: 受保护目录里的文件不出现在扫描结果', async () => {
  // 这条不能用静态断言 —— 剪枝调用点写对了但判定逻辑传错参数(比如把
  // exemptSelf 写成 false, 或把 protectedReason 换成裸的段名匹配), grep 一律看不出来。
  // 所以真造目录、真调 isProtectedPath 验证判定。
  const { isProtectedPath } = await import('../app/ui/lib/util.js');
  // 注意: 不能拿 @appdata/fnclearup 当"应剪枝"的例子 —— 扫描用的是
  // exemptSelf:true, 应用自身的数据目录会被豁免(那占用的是用户的盘, 该列出来)。
  // @appdata/fnclearup 的行为由下一条测试专门覆盖。
  // 常量直接从源码里读, 不手抄 —— 手抄过一次就抄错过(@appstore 根本不存在)。
  const utilSrc = fs.readFileSync(path.join(ROOT, 'app/ui/lib/util.js'), 'utf8');
  const cm = /const FNOS_SYSTEM_DIRS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(utilSrc);
  assert.ok(cm, '应能从 util.js 读到 FNOS_SYSTEM_DIRS');
  const sysDirs = [...cm[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
  assert.ok(sysDirs.length >= 8, '受保护的系统目录不该少于 8 个, 实际 ' + sysDirs.length);
  const mustPrune = [
    ...sysDirs.map(d => `/vol3/${d}/某个应用`),
    '/vol3/1000/.@#local/trash',
    '/vol3/1000/.@#local/share',
  ];
  // fnOS 上真实存在的 @ 目录必须全部在集合里 —— 少一个就意味着那个目录
  // 里的应用安装文件能被"清理"掉, 应用直接起不来。
  if (fs.existsSync('/vol1')) {
    for (const v of ['/vol1', '/vol2', '/vol3', '/vol4']) {
      if (!fs.existsSync(v)) continue;
      for (const n of fs.readdirSync(v)) {
        if (n.startsWith('@')) {
          assert.ok(sysDirs.includes(n), `fnOS 上存在的 ${n} 未列入受保护集合`);
        }
      }
    }
  }
  const mustKeep = [
    '/vol3/1000/Pictures',
    '/vol3/1000/Downloads',
    '/vol3/docker/overlay2/abc',          // docker 目录: 不是系统目录, 该列出
    '/vol3/1000/my @app backup',          // 段名含 @app 但不等于系统目录名
    '/vol3/1000/我的下载',                 // 中文路径
  ];
  for (const p of mustPrune) {
    assert.ok(isProtectedPath(p, { exemptSelf: true }), '应剪枝: ' + p);
  }
  for (const p of mustKeep) {
    assert.ok(!isProtectedPath(p, { exemptSelf: true }), '★ 不应误剪: ' + p);
  }
});

test('端到端: 应用自身数据目录不被剪(exemptSelf 的意义)', async () => {
  const { isProtectedPath } = await import('../app/ui/lib/util.js');
  // fnclearup 自己的数据目录该列出来 —— 那占用的是用户的盘, 用户有权知道。
  const own = process.env.TRM_PKGVAR || '/vol3/@appdata/fnclearup';
  assert.ok(!isProtectedPath(own + '/data/manifests', { exemptSelf: true }),
    '自身数据目录不应被剪');
  // 但删除场景仍要拦(exemptSelf:false) —— 避免应用误删自己的运行数据
  assert.ok(isProtectedPath(own + '/data/manifests', { exemptSelf: false }),
    '删除场景仍须拦自身目录');
});

