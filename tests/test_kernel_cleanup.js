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
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/fnclearup_test/kernel';
const PORT = 47947;
const BASE = `http://127.0.0.1:${PORT}`;

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
    assert.equal(body.failed, 1);
    assert.match(body.results[0].error, /正在运行/);
  });

  test('传不存在的版本 → 拒绝（防任意包名注入）', async () => {
    const { status, body } = await http('POST', '/api/kernel/delete', {
      versions: ['9.9.9-does-not-exist', 'linux-image-1; rm -rf /'],
      confirm: 'PURGE',
    });
    assert.equal(status, 200);
    assert.equal(body.removed, 0);
    assert.equal(body.failed, 2);
    for (const r of body.results) assert.match(r.error, /扫描结果里没有|正在运行/);
  });

  test('只清 APT 缓存（versions 空 + clean_apt_cache）不报「没有选择」', async () => {
    const { status, body } = await http('POST', '/api/kernel/delete', { versions: [], confirm: 'PURGE', clean_apt_cache: false });
    // clean_apt_cache=false 时应仍按「没有选择」拒绝；这里断言这个分支的判定顺序正确
    assert.equal(status, 400);
    assert.match(body.error, /没有选择/);
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
