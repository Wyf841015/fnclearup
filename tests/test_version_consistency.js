// 四处版本号必须一致 —— 2026-10-10
//
// fnOS 应用的版本号散在 4 个地方: manifest / package.json / app/ui/lib/config.js
// (前端运行时读它显示版本徽章) / README。任何一处漏改, 用户看到的版本就与
// 实际安装的对不上 —— 而应用自带的"检查 FnDepot 是否有新版本"就是拿这个号去比的,
// 对不上会误报"已是最新"。
//
// 本轮把 v0.12.1 / v0.13.0 / v0.14.0 的修改说明合并回 v0.12.0, 版本号一并回退,
// 顺手加这条测试锁住 4 处一致。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('manifest / package.json / config.js 三处版本号一致', () => {
  const man = /^version\s*=\s*(\S+)\s*$/m.exec(read('manifest'));
  assert.ok(man, 'manifest 应有 version 字段');
  const pkg = JSON.parse(read('package.json'));
  const cfg = /export const VERSION\s*=\s*'([^']+)'/.exec(read('app/ui/lib/config.js'));
  assert.ok(cfg, 'config.js 应导出 VERSION');
  assert.strictEqual(pkg.version, man[1],
    'package.json(' + pkg.version + ') 与 manifest(' + man[1] + ') 不一致');
  assert.strictEqual(cfg[1], man[1],
    'config.js(' + cfg[1] + ') 与 manifest(' + man[1] + ') 不一致 —— 前端版本徽章会显示错的号');
});

test('版本号是合法的 x.y.z 语义化版本', () => {
  const man = /^version\s*=\s*(\S+)\s*$/m.exec(read('manifest'))[1];
  assert.match(man, /^\d+\.\d+\.\d+$/, '版本号应为 x.y.z, 实际 ' + man);
});

test('README 的当前版本段标题与 manifest 一致', () => {
  const man = /^version\s*=\s*(\S+)\s*$/m.exec(read('manifest'))[1];
  const readme = read('README.md');
  // 第一个 ## vX.Y.Z 更新 段就是当前版本
  const m = /^## v([\d.]+) 更新\s*$/m.exec(readme);
  assert.ok(m, 'README 应有 "## vX.Y.Z 更新" 段');
  assert.strictEqual(m[1], man,
    'README 首个版本段是 v' + m[1] + ', 但 manifest 是 ' + man);
});

test('已合并的版本号不再出现在 README 里', () => {
  // v0.12.1 / v0.13.0 / v0.14.0 的说明已合并进 v0.12.0, 不该再有残留引用 ——
  // 留着会让读者以为能装到那些版本。
  const readme = read('README.md');
  for (const v of ['0.12.1', '0.13.0', '0.14.0']) {
    assert.ok(!readme.includes(v), 'README 仍提到已合并的版本 ' + v);
  }
});
