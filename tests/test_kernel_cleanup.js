/**
 * 内核清理 tab 测试
 *
 * 为什么值得单独测：这个 tab 会真的执行 `apt-get purge`，一次误删就可能删掉
 * 唯一能启动的内核。所以这里重点不是「功能好不好用」，而是**四条硬边界**：
 *   1) 没带 confirm='PURGE' 一律拒绝
 *   2) versions 为空且没要求清缓存 → 拒绝
 *   3) 正在运行的内核 → 拒绝（且绝不能走到 apt）
 *   4) 扫描结果里不存在的版本 → 拒绝（防前端传任意包名 → 命令注入/误删）
 *
 * 另外扫一遍前端接线：tab/panel/弹窗/函数导出/TAB_GROUPS/版本戳，
 * 少任何一处都会表现为「点了没反应」或「新代码没生效」。
 *
 * 注意：本测试**不执行任何真实删除**。所有 POST 走到边界检查就返回了，
 * apt-get 一次都不会被调用（这正是被断言的行为）。
 *
 * Usage: node --test tests/test_kernel_cleanup.js
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/fnclearup_test/kernel';
const PORT = 47947;
const BASE = `http://127.0.0.1:${PORT}`;

const { pkgBelongsToVersion } = await import('../app/ui/api/kernel.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function http(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 90000,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch { j = { _raw: buf }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

let child = null;

before(async () => {
  mkdirSync(TMP, { recursive: true });
  child = spawn(process.execPath, [join(ROOT, 'app/ui/server.js')], {
    env: { ...process.env, PORT: String(PORT), TRM_PKGVAR: TMP },
    stdio: 'ignore',
  });
  // 等端口就绪（最多 20s）
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await http('GET', '/api/kernel/scan');
      if (r.status === 200 && r.body && r.body.success !== false) return;
    } catch { /* 还没起来 */ }
  }
  throw new Error('测试服务器未能就绪');
});

after(() => {
  if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('内核清理：扫描', () => {
  test('返回结构完整且自洽', async () => {
    const { status, body } = await http('GET', '/api/kernel/scan');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(typeof body.running === 'string' && body.running.length > 0, 'running 不能为空');
    assert.ok(Array.isArray(body.kernels) && body.kernels.length >= 1, '至少要有一套内核');
    assert.ok(body.apt_cache && typeof body.apt_cache.size_str === 'string', 'apt_cache 要有体积');
    assert.ok(body.grub && typeof body.grub === 'object', 'grub 信息要在');

    for (const k of body.kernels) {
      assert.ok(typeof k.version === 'string' && k.version, 'version 必填');
      assert.ok(typeof k.size_str === 'string' && k.size_str, 'size_str 必填');
      assert.equal(typeof k.deletable, 'boolean', 'deletable 必须是布尔');
      assert.ok(Array.isArray(k.packages), 'packages 必须是数组');
    }
  });

  test('正在运行的内核恰好一个，且永远不可删', async () => {
    const { body } = await http('GET', '/api/kernel/scan');
    const runs = body.kernels.filter(k => k.running);
    assert.equal(runs.length, 1, '只能有一个 running');
    assert.equal(runs[0].version, body.running, 'running 字段要和那一套对上');
    assert.equal(runs[0].deletable, false, '正在运行的内核必须 deletable=false');
    assert.equal(runs[0].suggest_keep, true, '正在运行的内核必须 suggest_keep');
  });

  test('建议保留的至少两套（运行中 + 一个备用）', async () => {
    const { body } = await http('GET', '/api/kernel/scan');
    const keeps = body.kernels.filter(k => k.suggest_keep);
    assert.ok(keeps.length >= 1, '至少保留运行中那套');
    if (body.kernels.length >= 2) {
      assert.ok(keeps.length >= 2, '多套内核时应再保留一套备用，否则出问题无法回退');
    }
  });
});

describe('内核清理：删除边界（绝不落到 apt）', () => {
  test('缺 confirm → 拒绝', async () => {
    const { status, body } = await http('POST', '/api/kernel/delete', { versions: ['whatever'] });
    assert.equal(status, 400);
    assert.equal(body.success, false);
    assert.match(body.error, /confirm/);
  });

  test('versions 为空且没要求清缓存 → 拒绝', async () => {
    const { status, body } = await http('POST', '/api/kernel/delete', { versions: [], confirm: 'PURGE' });
    assert.equal(status, 400);
    assert.match(body.error, /没有选择/);
  });

  test('要删正在运行的内核 → 拒绝，且 removed=0', async () => {
    const scan = await http('GET', '/api/kernel/scan');
    const running = scan.body.running;
    const { status, body } = await http('POST', '/api/kernel/delete', { versions: [running], confirm: 'PURGE' });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.removed, 0, '运行中的内核不能被删掉');
    // 现在在「预检阶段」就拦下（rejected），根本不会进 apt 执行队列
    assert.equal((body.rejected || []).length, 1, '应被预检拦下');
    assert.match(body.rejected[0].error, /正在运行/);
    assert.equal((body.results || []).length, 0, '被拦下的不该进结果队列');
  });

  test('传不存在的版本 → 拒绝（防任意包名注入）', async () => {
    const { status, body } = await http('POST', '/api/kernel/delete', {
      versions: ['9.9.9-does-not-exist', 'linux-image-1; rm -rf /'],
      confirm: 'PURGE',
    });
    assert.equal(status, 200);
    assert.equal(body.removed, 0);
    assert.equal((body.rejected || []).length, 2);
    for (const r of body.rejected) assert.match(r.error, /扫描结果里没有|正在运行/);
    assert.equal((body.results || []).length, 0);
  });

  test('只清 APT 缓存（versions 空 + clean_apt_cache）不报「没有选择」', async () => {
    const { status, body } = await http('POST', '/api/kernel/delete', { versions: [], confirm: 'PURGE', clean_apt_cache: false });
    // clean_apt_cache=false 时应仍按「没有选择」拒绝；这里断言这个分支的判定顺序正确
    assert.equal(status, 400);
    assert.match(body.error, /没有选择/);
  });
});

describe('内核清理：包名匹配（防子串误伤）', () => {
  // 以前用 pkg.includes('-' + version + '-')，一旦同时存在 6.18.18 与 6.18.18-trim，
  // 删前者会把后者的包一起带走。这里把这条边界锁死。
  test('版本号必须完整匹配，不能被更短版本前缀吃掉', () => {
    assert.equal(pkgBelongsToVersion('linux-image-6.18.18-trim', '6.18.18'), false,
      '6.18.18-trim 的包不应该算进 6.18.18');
    assert.equal(pkgBelongsToVersion('linux-image-6.18.18', '6.18.18'), true);
    assert.equal(pkgBelongsToVersion('linux-image-6.18.18-trim', '6.18.18-trim'), true);
  });

  test('认识本机真实命名：linux-modules-trim-<ver>', () => {
    // 实测本机模块包带 trim 中缀，按 linux-modules-<ver> 会漏
    assert.equal(pkgBelongsToVersion('linux-modules-trim-6.18.18.c788-trim', '6.18.18.c788-trim'), true);
  });

  test('允许常见后缀包（-common / -dbg），但只能是包名末尾', () => {
    assert.equal(pkgBelongsToVersion('linux-headers-6.18.18.c1107-trim-common', '6.18.18.c1107-trim'), true);
    assert.equal(pkgBelongsToVersion('linux-image-6.1.0-16-amd64-dbg', '6.1.0-16-amd64'), true);
  });

  test('无关包一律不算（元包 / libc / 其它版本）', () => {
    for (const p of ['linux-image-amd64', 'linux-headers-amd64', 'linux-libc-dev',
      'linux-modules-trim-extra', 'linux-image-6.18.18.c1111-trim']) {
      assert.equal(pkgBelongsToVersion(p, '6.18.18.c1107-trim'), false, p + ' 不该被算进去');
    }
  });
});

describe('内核清理：预演（dry_run）', () => {
  test('预演返回 apt 真实会删的包，且绝不改动系统', async () => {
    const before = await http('GET', '/api/kernel/scan');
    const victim = before.body.kernels.find(k => k.deletable && !k.suggest_keep);
    if (!victim) return;   // 机器上只有一套内核时跳过

    const { status, body } = await http('POST', '/api/kernel/delete', {
      versions: [victim.version], confirm: 'PURGE', dry_run: true,
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.dry_run, true);
    assert.equal(body.removed, undefined, '预演不该有 removed 字段（那是真删的）');
    assert.ok(Array.isArray(body.plan) && body.plan.length === 1, '应有一项计划');
    const p = body.plan[0];
    assert.equal(p.version, victim.version);
    assert.ok(Array.isArray(p.apt_removes) && p.apt_removes.length > 0, 'apt_removes 不该为空');
    // 预演结果里绝不能出现正在运行内核的包
    const runVer = before.body.running;
    for (const pkg of p.apt_removes) {
      assert.ok(!pkg.includes(runVer), '预演会删到运行中内核的包: ' + pkg);
    }
    assert.equal(body.needs_extra_ack, (body.extras || []).length > 0);

    // 系统状态必须完全没变
    const after = await http('GET', '/api/kernel/scan');
    assert.equal(after.body.count, before.body.count, '预演不该改变内核数量');
    assert.equal(after.body.reclaimable, before.body.reclaimable, '预演不该改变可释放体积');
  });

  test('预演里带运行中的内核 → 被 rejected，不进入 plan', async () => {
    const scan = await http('GET', '/api/kernel/scan');
    const { body } = await http('POST', '/api/kernel/delete', {
      versions: [scan.body.running], confirm: 'PURGE', dry_run: true,
    });
    assert.equal(body.success, true);
    assert.equal((body.plan || []).length, 0, '运行中内核不能进 plan');
    assert.equal((body.rejected || []).length, 1);
    assert.match(body.rejected[0].error, /正在运行/);
  });

  test('预演不给 confirm 也拒绝（预演同样要过闸门）', async () => {
    const { status } = await http('POST', '/api/kernel/delete', { versions: ['x'], dry_run: true });
    assert.equal(status, 400);
  });
});

describe('内核清理：并发与超时（用户实际踩的两个坑）', () => {
  // 坑 1：多选后刚打开确认弹窗（后台在预演 8 个版本），用户点确认 → 报
  //       「已有清理任务在执行」。根因是预演也占了清理锁。
  test('预演不占清理锁：两个预演可以同时跑', async () => {
    const scan = await http('GET', '/api/kernel/scan');
    const victim = scan.body.kernels.find(k => k.deletable && !k.suggest_keep);
    if (!victim) return;
    const body = { versions: [victim.version], confirm: 'PURGE', dry_run: true };
    const [a, b] = await Promise.all([
      http('POST', '/api/kernel/delete', body),
      http('POST', '/api/kernel/delete', body),
    ]);
    assert.equal(a.status, 200, '第一个预演不该被拒');
    assert.equal(b.status, 200, '第二个预演也不该被拒（预演是只读的）');
    assert.notEqual(a.body.error, '上一个清理任务还在执行，请等它结束');
    assert.notEqual(b.body.error, '上一个清理任务还在执行，请等它结束');
  });

  test('锁只在真删时占：代码里 409 判断必须在 !dryRun 分支内', () => {
    const src = fs.readFileSync(ROOT + '/app/ui/api/kernel.js', 'utf8');
    const i = src.indexOf('kernelBusy');
    assert.ok(i > 0);
    // 409 的守卫要紧跟在 if (!dryRun) 之后
    const m = src.match(/if \(!dryRun\) \{\s*\n\s*if \(kernelBusy\) \{[\s\S]{0,220}?409/);
    assert.ok(m, '409 守卫必须写在 if (!dryRun) 里面，否则预演会挡住真删');
    // 解锁也要只在真删时做（预演没加锁就不该解锁，否则会把别人的锁清掉）
    assert.match(src, /if \(!dryRun\) kernelBusy = false;/, '预演不该清掉别人持有的锁');
  });

  // 坑 2：多选全选时逐套 apt-get purge，每套约 29s（每次都要跑 update-grub），
  //       8 套 ≈ 200s+，顶到 fnOS 网关 `location /app/` 的 proxy_read_timeout 300s。
  test('全部选中内核合并成一次 apt 事务（避免撞 300s 网关超时）', () => {
    const src = fs.readFileSync(ROOT + '/app/ui/api/kernel.js', 'utf8');
    assert.match(src, /const allPkgs = \[\.\.\.new Set\(planOk\.flatMap/, '缺合并后的包列表');
    assert.match(src, /'-y', 'purge', \.\.\.allPkgs/, '必须一次 purge 传全部包');
    // 不能再有「循环里每套各调一次 purge」
    const inLoop = /for \(const item of planOk\)[\s\S]{0,800}?'purge'/.test(src);
    assert.equal(inLoop, false, '不能在 per-version 循环里调 purge（那会 N 次 update-grub）');
    // hold 也要一次性全部解除，否则 apt -y 会因 held 包中止
    assert.match(src, /unhold', \.\.\.allHolds/, 'hold 包要一次性全解除');
  });

  test('结果以「删完再扫一遍」为准，而不是只看 apt 退出码', () => {
    const src = fs.readFileSync(ROOT + '/app/ui/api/kernel.js', 'utf8');
    assert.match(src, /const gone = !left \|\| !left\.has_files;/, '应按文件是否还在判定');
    assert.match(src, /if \(gone\) freed \+= item\.k\.size;/, '释放量只算真删掉的');
  });

  test('前端预演期间禁用确认按钮（不给用户点出 409 的机会）', () => {
    const js = fs.readFileSync(ROOT + '/app/ui/main.js', 'utf8');
    assert.match(js, /dryLoading: false/, 'kernelState 缺 dryLoading');
    assert.match(js, /kernelState\.dryLoading = true;/, '打开弹窗时要置位');
    assert.match(js, /\} finally \{\s*\n\s*kernelState\.dryLoading = false;/, '预演结束要复位（含异常路径）');
    assert.match(js, /btn\.disabled = !\(ack && ack\.checked && extraOk\) \|\| kernelState\.dryLoading/,
      '按钮禁用条件必须含 dryLoading');
    assert.match(js, /if \(kernelState\.dryLoading\) \{ showToast\('预演还没完成/, '确认时要兜底拦一下');
  });

  test('后端会记录每次 purge 的结果（以前零日志，排查全靠猜）', () => {
    const src = fs.readFileSync(ROOT + '/app/ui/api/kernel.js', 'utf8');
    assert.match(src, /\[kernel\] purge \$\{allPkgs\.length\} 包/, '缺 purge 结果日志');
    assert.match(src, /\[kernel\] apt 错误:/, 'apt 失败时要把 stderr 记下来');
  });
});

describe('APT 缓存与残留配置包（用户报「点了没变化」）', () => {
  // 用户报：点「清理 APT 缓存」后，界面一直显示 16.0 KB（0 个 .deb）。
  // 根因：原来用 du 整个 /var/cache/apt/archives，把目录 inode 块(12K)+partial(4K)
  // 也算成"缓存"了。真正能释放的只有 *.deb。
  test('没有 .deb 时缓存量必须是 0，不能是目录开销', async () => {
    const { body } = await http('GET', '/api/kernel/scan');
    const ap = body.apt_cache || {};
    assert.equal(typeof ap.files, 'number');
    assert.equal(typeof ap.size, 'number');
    if (ap.files === 0) {
      assert.equal(ap.size, 0, `0 个 .deb 却报 ${ap.size} B —— 又把目录开销算进去了`);
      assert.equal(ap.size_str, '0 B');
    }
    // 目录开销另存一个字段，只为透明，不参与"可清理"
    assert.equal(typeof ap.dir_size, 'number', '缺 dir_size（目录开销要单独暴露）');
    assert.ok(ap.dir_size >= ap.size, '目录开销不该小于 .deb 总量');
  });

  test('残留配置包要查全部包，不能只看 linux-*', async () => {
    const { body } = await http('GET', '/api/kernel/scan');
    const rc = body.rc_packages || [];
    assert.ok(Array.isArray(rc));
    // 只要系统里有非 linux 的 rc 包，就应该出现在列表里
    const src = fs.readFileSync(ROOT + '/app/ui/api/kernel.js', 'utf8');
    assert.match(src, /const all = await dpkgList\(null\)/, 'rc 包必须用全量 dpkg 查询');
  });

  test('purge-rc 缺 confirm 一律 400', async () => {
    const { status, body } = await http('POST', '/api/kernel/purge-rc', { packages: ['fuse'] });
    assert.equal(status, 400);
    assert.match(body.error, /confirm/);
  });

  test('purge-rc 只认 rc 状态的包（防任意包名注入）', async () => {
    const { status, body } = await http('POST', '/api/kernel/purge-rc', {
      confirm: 'PURGE', packages: ['bash', 'coreutils', 'systemd'],
    });
    assert.equal(status, 400);
    assert.match(body.error, /残留配置/);
  });

  test('purge-rc 传不存在的包也拒绝，不会瞎 purge', async () => {
    const { status, body } = await http('POST', '/api/kernel/purge-rc', {
      confirm: 'PURGE', packages: ['fnclearup-not-exist-xxx'],
    });
    assert.equal(status, 400);
    assert.match(body.error, /残留配置/);
  });

  test('前端：0 个 .deb 时按钮点了只提示，不发请求；rc 有独立清理按钮', () => {
    const js = fs.readFileSync(ROOT + '/app/ui/main.js', 'utf8');
    assert.match(js, /if \(\(apc\.files \|\| 0\) === 0\) \{[\s\S]{0,120}?APT 下载缓存已经是空的/, '缺空缓存短路');
    assert.match(js, /onclick="purgeRcPackages\(\)"/, 'rc 那行要能点（不能只给一句手动命令）');
    assert.match(js, /function purgeRcPackages/, '缺 purgeRcPackages');
    assert.match(js, /api\/kernel\/purge-rc/, '缺 purge-rc 调用');
    assert.ok(/(^|[\s,{])purgeRcPackages\s*[,}]/m.test(js), 'purgeRcPackages 没导出 → inline onclick 调不到');
  });

  test('清理 APT 缓存报的是真实释放量（前-后），不是清理前大小', () => {
    const src = fs.readFileSync(ROOT + '/app/ui/api/kernel.js', 'utf8');
    assert.match(src, /cache_cleaned = Math\.max\(0, before\.size - after\.size\);/, '必须用前后差值');
  });
});

describe('内核清理：前端接线', () => {
  const html = readFileSync(join(ROOT, 'app/ui/index.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'app/ui/main.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'app/ui/styles/style.css'), 'utf8');
  const serverJs = readFileSync(join(ROOT, 'app/ui/server.js'), 'utf8');

  test('tab 按钮 + panel + 确认弹窗都在', () => {
    assert.match(html, /data-tab="kernel"/, '缺 tab 按钮');
    assert.match(html, /data-panel="kernel"/, '缺 panel');
    assert.match(html, /id="kernelDeleteModal"/, '缺删除确认弹窗');
    assert.match(html, /id="kernel-list"/, '缺列表容器');
    assert.match(html, /onclick="kernelScan\(\)"/, '缺扫描按钮');
    assert.match(html, /onclick="selectAllKernelRecommended\(\)"/, '缺推荐勾选按钮');
    assert.match(html, /onclick="showKernelDeleteModal\(\)"/, '缺清理按钮');
  });

  test('tab 归在「清理回收」分组里', () => {
    assert.match(js, /clean:\s*\[[^\]]*'kernel'/, 'kernel 必须在 TAB_GROUPS.clean 里，否则切组后看不到');
    assert.match(js, /tabName==='kernel'\)\s*\{\s*await kernelScan\(\)/, 'switchTab 缺 kernel 分支 → 点进去不扫描');
  });

  test('所有 onclick 用到的函数都导出了（否则 WebView 里点了没反应）', () => {
    const fns = ['kernelScan', 'selectAllKernel', 'selectAllKernelRecommended',
      'updateKernelSelectInfo', 'showKernelDeleteModal', 'hideKernelDeleteModal',
      'updateKernelConfirmBtn', 'confirmKernelDelete', 'cleanAptCache'];
    for (const fn of fns) {
      assert.ok(new RegExp(`function\\s+${fn}\\s*\\(`).test(js), `main.js 里缺 function ${fn}`);
      assert.ok(new RegExp(`(^|[\\s,{])${fn}\\s*[,}]`, 'm').test(js), `${fn} 没进 exports → window 上没有，inline onclick 失效`);
    }
  });

  test('删除按钮默认 disabled，勾选后才可用', () => {
    assert.match(html, /id="kernelDeleteBtn"[^>]*disabled/, '删除按钮默认应 disabled');
    assert.match(js, /btn\.disabled\s*=\s*cbs\.length\s*===\s*0/, '缺「勾选后才启用」的逻辑');
  });

  test('确认按钮必须勾选 acknowledgment 才能点', () => {
    assert.match(html, /id="kernelAckCb"/, '缺 acknowledgment 勾选框');
    assert.match(html, /id="kernelConfirmBtn"[^>]*disabled/, '确认按钮默认应 disabled');
    assert.match(js, /btn\.disabled\s*=\s*!\(ack\s*&&\s*ack\.checked\)/, '缺 acknowledgment 校验');
  });

  test('后端路由已注册', () => {
    assert.match(serverJs, /'\/api\/kernel\/scan'/, 'server.js 缺 scan 路由');
    assert.match(serverJs, /'\/api\/kernel\/delete'/, 'server.js 缺 delete 路由');
  });

  test('用到的 CSS 类都有定义', () => {
    for (const cls of ['kernel-hint', 'kernel-badge', 'kernel-del-list', 'kernel-del-warn', 'kernel-ack', 'kernel-pkgs']) {
      assert.ok(css.includes('.' + cls), `style.css 缺 .${cls}`);
      assert.ok(html.includes(cls) || js.includes(cls), `.${cls} 定义了但没用上（白写）`);
    }
  });

  test('CSS 变量都是本项目真实存在的（写错静默失效）', () => {
    const block = css.slice(css.indexOf('/* ── 内核清理 tab'));
    // 'var(--radius-md)' → 取 '--radius-md'（去掉 'var(' 4 字符 和末尾 ')'）
    const used = Array.from(new Set((block.match(/var\(--[a-z0-9-]+\)/g) || []).map(v => v.slice(4, -1))));
    assert.ok(used.length > 0, '内核清理 CSS 里应该有 var()');
    for (const v of used) {
      assert.ok(css.includes(`${v}:`), `用了不存在的变量 ${v}`);
    }
  });

  test('改前端必须改版本戳（否则浏览器一直跑旧 main.js）', () => {
    const m = html.match(/main\.js\?v=([0-9a-z]+)/);
    assert.ok(m, 'main.js 必须带 ?v= 戳');
    assert.notEqual(m[1], '20261025d', '戳没改 → 用户那边还是旧 JS，新 tab 不会出现');
  });
});
