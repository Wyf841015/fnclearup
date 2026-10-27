/**
 * 启动风险提示偏好的稳定性测试
 *
 * 用户反馈：「首页弹出提醒勾选后有时还是会弹出」。
 *
 * 根因不是分支写错，而是**偏好的存放位置不可靠**：整个应用的偏好只存
 * localStorage，而 fnOS 上同一个应用会同时出现在
 *   · 应用中心点进去 = iframe
 *   · 新窗口打开     = CEF 独立窗口
 * 两种上下文的 localStorage 可能是不同存储分区，有的环境还会直接禁用/清空。
 * 于是「关了又弹」随机出现。
 *
 * 修法：服务端 <TRM_PKGVAR>/data/ui-prefs.json 作为唯一真理源，
 *       localStorage 降级为本地缓存；并且一次页面加载最多弹一次。
 *
 * 这里覆盖三层：
 *   1) /api/prefs 的读写与容错（默认值 / 白名单 / 类型规整 / 坏文件）
 *   2) 前端接线（两只勾选框显式传来源、初始化走统一入口、导出齐全）
 *   3) 幂等（showStartupWarning 不能重复初始化倒计时）
 *
 * Usage: node --test tests/test_startup_warning_pref.js
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/fnclearup_test/prefs';
const PREFS_FILE = join(TMP, 'data', 'ui-prefs.json');
const PORT = 47948;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function http(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 30000,
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

let child = null;

before(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  child = spawn(process.execPath, [join(ROOT, 'app/ui/server.js')], {
    env: { ...process.env, PORT: String(PORT), TRM_PKGVAR: TMP },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await http('GET', '/api/prefs');
      if (r.status === 200 && r.body && r.body.success) return;
    } catch { /* 还没起来 */ }
  }
  throw new Error('测试服务器未能就绪');
});

after(() => {
  if (child) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('启动提示偏好：后端读写', () => {
  test('没有文件时返回安全默认（每次都弹）', async () => {
    rmSync(PREFS_FILE, { force: true });
    const { status, body } = await http('GET', '/api/prefs');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.prefs.startup_warn_always, true, '默认必须是「弹」，不能偷偷帮用户关掉');
    assert.equal(body.file, PREFS_FILE, '文件应落在 TRM_PKGVAR/data 下');
  });

  test('保存 false → 立刻读回 false，并真的写进文件', async () => {
    const w = await http('POST', '/api/prefs', { prefs: { startup_warn_always: false } });
    assert.equal(w.status, 200);
    assert.equal(w.body.success, true);
    assert.equal(w.body.prefs.startup_warn_always, false);
    assert.equal(w.body.applied.startup_warn_always, false);

    const r = await http('GET', '/api/prefs');
    assert.equal(r.body.prefs.startup_warn_always, false, '读回必须一致（这才是"下次不弹"的依据）');

    assert.ok(existsSync(PREFS_FILE), '文件应已落盘');
    const onDisk = JSON.parse(readFileSync(PREFS_FILE, 'utf8'));
    assert.equal(onDisk.startup_warn_always, false);
  });

  test('也接受扁平写法（不带 prefs 包裹）', async () => {
    const w = await http('POST', '/api/prefs', { startup_warn_always: true });
    assert.equal(w.body.success, true);
    assert.equal(w.body.prefs.startup_warn_always, true);
  });

  test('字符串/数字形式一律按布尔规整（前端不同序列化都能吃）', async () => {
    for (const [v, want] of [['0', false], [0, false], ['false', false], ['1', true], [1, true], ['true', true]]) {
      const w = await http('POST', '/api/prefs', { prefs: { startup_warn_always: v } });
      assert.equal(w.body.success, true, `值 ${JSON.stringify(v)} 应被接受`);
      assert.equal(w.body.prefs.startup_warn_always, want, `值 ${JSON.stringify(v)} 应规整成 ${want}`);
    }
  });

  test('非法值 → 400，且不破坏已有设置', async () => {
    await http('POST', '/api/prefs', { prefs: { startup_warn_always: false } });
    const bad = await http('POST', '/api/prefs', { prefs: { startup_warn_always: 'maybe' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /不合法/);
    const r = await http('GET', '/api/prefs');
    assert.equal(r.body.prefs.startup_warn_always, false, '非法请求不该把旧值改掉');
  });

  test('只传白名单外的键 → success:false 并说清什么都没存', async () => {
    const w = await http('POST', '/api/prefs', { prefs: { evil_key: 'x' } });
    assert.equal(w.body.success, false, '不能假装保存成功');
    assert.match(w.body.error, /可保存的字段/);
    const onDisk = readFileSync(PREFS_FILE, 'utf8');
    assert.ok(!onDisk.includes('evil_key'), '白名单外的键不能被写进文件');
  });

  test('文件被写坏 → 回默认值而不是 500', async () => {
    mkdirSync(dirname(PREFS_FILE), { recursive: true });
    writeFileSync(PREFS_FILE, '{ 这不是 JSON', 'utf8');
    const r = await http('GET', '/api/prefs');
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.prefs.startup_warn_always, true, '坏文件要回安全默认');
  });
});

describe('启动提示偏好：前端接线', () => {
  const html = readFileSync(join(ROOT, 'app/ui/index.html'), 'utf8');
  const js = readFileSync(join(ROOT, 'app/ui/main.js'), 'utf8');
  const serverJs = readFileSync(join(ROOT, 'app/ui/server.js'), 'utf8');

  test('两只勾选框都显式传来源，不再靠「谁变了」猜', () => {
    assert.match(html, /id="startupWarningAlwaysCb"[^>]*onchange="setStartupWarnFrom\('modal'\)"/, '弹窗里的勾选框');
    assert.match(html, /id="startupWarningSettingCb"[^>]*onchange="setStartupWarnFrom\('setting'\)"/, '设置页的勾选框');
    assert.ok(!/onchange="toggleStartupWarningAlways\(\)"/.test(html), 'HTML 里不该再有旧的推断式调用');
  });

  test('偏好走后端 /api/prefs，不再只存 localStorage', () => {
    assert.match(js, /API\.get\('api\/prefs'/, '缺读取预好的调用');
    assert.match(js, /API\.post\('api\/prefs'/, '缺保存偏好的调用');
    assert.match(serverJs, /'\/api\/prefs'/, 'server.js 缺 prefs 路由');
  });

  test('保存失败必须回滚（否则界面说关了、下次还弹）', () => {
    const i = js.indexOf('async function setStartupWarnFrom');
    assert.ok(i > 0, '缺 setStartupWarnFrom');
    const body = js.slice(i, i + 2600);
    assert.match(body, /catch/, '缺失败分支');
    assert.match(body, /_warnAlways = prev/, '失败后要回滚内存值');
    assert.match(body, /syncStartupWarningChecks\(\)/, '回滚后要同步勾选框');
    assert.match(body, /writeLocalWarnAlways\(prev\)/, '回滚后要同步本地缓存');
  });

  test('一次页面加载最多弹一次（幂等）', () => {
    assert.match(js, /_startupWarnShown/, '缺"本次已弹"标记');
    const i = js.indexOf('function maybeShowStartupWarning');
    const body = js.slice(i, i + 500);
    assert.match(body, /if \(_startupWarnShown\) return false;/, 'maybeShowStartupWarning 必须先判幂等');
    // showStartupWarning 自己也要幂等：重复调用不能把倒计时重置成 3 秒
    const j = js.indexOf('function showStartupWarning');
    const body2 = js.slice(j, j + 400);
    assert.match(body2, /classList\.contains\('visible'\)\) return/, '已显示时不该重复初始化');
  });

  test('init 走统一入口，不再直接裸调 showStartupWarning', () => {
    assert.match(js, /^\s*initStartupWarning\(\);\s*$/m, 'init 应调用 initStartupWarning()');
    // 只数「真正的调用语句」：一行就是 showStartupWarning(); 的那种。
    // 注释里提到 / 函数定义行都不算。
    const callLines = js.split('\n')
      .map(l => l.trim())
      .filter(l => l === 'showStartupWarning();');
    assert.equal(callLines.length, 1,
      `裸调用点应为 1 个（在 maybeShowStartupWarning 内部），实际 ${callLines.length}`);
  });

  test('新函数都导出了（inline onchange 在 WebView 里要靠 window 上的引用）', () => {
    for (const fn of ['setStartupWarnFrom', 'initStartupWarning', 'maybeShowStartupWarning', 'loadStartupWarningPref']) {
      assert.ok(new RegExp(`function\\s+${fn}\\s*\\(`).test(js), `main.js 缺 function ${fn}`);
      assert.ok(new RegExp(`(^|[\\s,{])${fn}\\s*[,}]`, 'm').test(js), `${fn} 没进 exports → 页面里的 onchange 调不到`);
    }
  });

  test('版本戳已推进（改前端必须改戳，否则跑的还是旧 JS）', () => {
    const m = html.match(/main\.js\?v=([0-9a-z]+)/);
    assert.ok(m);
    assert.notEqual(m[1], '20261026b', '戳没改 → 用户那边还是旧代码，等于没修');
  });
});
