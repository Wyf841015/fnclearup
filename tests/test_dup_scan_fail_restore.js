// 扫描启动失败必须还原界面, 不能留一个不动的进度条 —— 2026-10-10
//
// 用户场景: 去重分区添加了 /vol1/1000/music(该目录在本机不存在), 点「开始扫描」。
// 后端返回 400 { error: '目录不存在: /vol1/1000/music' }, 前端弹了 toast,
// 状态栏也写了 ❌ —— 但 progress 区仍停在「正在验证路径...」, 一个不动的进度条,
// 而 results / empty / actions 三个区在函数开头就被藏了没放回来, 整块内容区空白。
// 用户第一眼看到的是"点了没反应, 而且界面空了"。
//
// startDupScan 一进来就做了 3 个"只在成功时才对"的改动(results/empty 隐藏 +
// progress 显示), 成功路径的收尾在 finishDupScan, 但启动失败的两条早退路径
// (后端返回 error / 请求抛异常)原本一个都没还原。
//
// ★ 关键: 必须真执行 startDupScan, 静态断言查不出"哪条路径忘了还原"。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'app/ui/main.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// RegExp#exec 返回的是 match 数组, 用 .index + m[0].length 定位, 没有 .start()
function fnSrc(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index + m[0].length), d = 0;
  for (let x = i; x < src.length; x++) {
    if (src[x] === '{') d++;
    else if (src[x] === '}') { d--; if (d === 0) return src.slice(m.index, x + 1); }
  }
  return null;
}

const { Window } = await import('/vol3/1000/hermes/fnlogpush/node_modules/happy-dom/lib/index.js');

const HTML = `<!DOCTYPE html><html><body>
  <input id="musicKeepMode" value="deepest"><input id="musicMinSize" value="0">
  <button id="musicScanBtn">开始扫描</button><button id="musicStopBtn" style="display:none">停止</button>
  <div id="musicProgress" class=""><div id="musicProgressBar" style="width:0%"></div>
    <span id="musicProgressText">正在验证路径...</span><span id="musicProgressCount">-</span>
    <span id="musicCurrentFile"></span></div>
  <div id="musicStatus"></div>
  <div id="musicResults" style="display:none"></div><div id="musicStats"></div>
  <div id="musicDupList" style="display:none"></div><div id="musicActions"></div>
  <div id="musicSelectedCount"></div><div id="musicSelectedSize"></div>
  <div id="musicEmpty" class="dup-empty-state" style="display:none">
    <div class="dup-empty-icon">🎶</div><h3>尚未开始扫描</h3><p>输入目录路径，点击开始扫描查找重复音乐文件。</p>
  </div>
</body></html>`;

/** 真跑一次 startDupScan, apiPost 按 scenario 决定返回什么 */
async function run(scenario) {
  const win = new Window({ url: 'http://localhost/app/fnclearup/' });
  win.document.write(HTML);
  const doc = win.document;
  const toasts = [];
  const api = new Function('window', 'document', 'toasts', 'API_POST', `
    const $ = id => document.getElementById(id);
    const escHtml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const DupState = { music: { checking:false, paths:['/vol1/1000/music'], jobId:null } };
    function showToast(msg, type){ toasts.push({msg, type}); }
    function getDupIds(){
      return { pathInput:'musicPath', scanBtn:'musicScanBtn', stopBtn:'musicStopBtn', deleteBtn:'musicDeleteBtn',
        exportBtn:'musicExportBtn', progress:'musicProgress', progressBar:'musicProgressBar',
        progressText:'musicProgressText', progressCount:'musicProgressCount', currentFile:'musicCurrentFile',
        status:'musicStatus', results:'musicResults', stats:'musicStats', dupList:'musicDupList',
        actions:'musicActions', selectedCount:'musicSelectedCount', selectedSize:'musicSelectedSize',
        empty:'musicEmpty' };
    }
    const API = { post: async () => (typeof API_POST === 'function' ? API_POST() : API_POST) };
    function pollDupProgress(){}
    ${fnSrc('restoreDupScanUI')}
    ${fnSrc('startDupScan')}
    return { startDupScan, restoreDupScanUI };
  `)(win, doc, toasts, scenario.res);

  const btn = doc.getElementById('musicScanBtn');
  btn.style.display = ''; btn.disabled = false;
  await api.startDupScan('music');
  return {
    toasts,
    status: doc.getElementById('musicStatus').textContent,
    progressVisible: doc.getElementById('musicProgress').classList.contains('visible'),
    progressText: doc.getElementById('musicProgressText').textContent,
    emptyDisplay: doc.getElementById('musicEmpty').style.display,
    emptyH3: doc.getElementById('musicEmpty').querySelector('h3').textContent,
    emptyP: doc.getElementById('musicEmpty').querySelector('p').textContent,
    scanBtnDisplay: btn.style.display, scanBtnDisabled: btn.disabled,
    stopBtnDisplay: doc.getElementById('musicStopBtn').style.display,
  };
}

test('后端返回"目录不存在"时, 界面要还原', async () => {
  const r = await run({ res: { error: '目录不存在: /vol1/1000/music', success: false } });
  assert.ok(r.toasts.some(t => /目录不存在/.test(t.msg)), '应弹出错误提示');
  assert.match(r.status, /❌.*目录不存在/, '状态栏应写明原因: ' + r.status);
  assert.ok(!r.progressVisible,
    '★ progress 区必须移除 visible —— 否则留一个永远停在"正在验证路径"的进度条');
  assert.notEqual(r.progressText, '正在验证路径...', '进度文案要清掉, 不能停在"正在验证路径..."');
  assert.equal(r.emptyDisplay, '',
    '★ 空态区要放回来 —— 开头被藏了, 不放回来整块内容区是空白的');
  assert.match(r.emptyH3, /❌/, '空态标题要说明是失败: ' + r.emptyH3);
  assert.match(r.emptyP, /目录不存在/, '空态正文要给出原因: ' + r.emptyP);
  assert.equal(r.scanBtnDisplay, '', '★ 扫描按钮要恢复可见, 否则用户没法重试');
  assert.equal(r.scanBtnDisabled, false, '扫描按钮要恢复可用');
  assert.equal(r.stopBtnDisplay, 'none', '停止按钮不该出现(没开始扫)');
});

test('请求抛异常时也要还原(网络错误/超时)', async () => {
  const err = new Error('fetch failed'); err.name = 'TypeError';
  const r = await run({ res: () => { throw err; } });
  assert.ok(!r.progressVisible, '★ progress 区必须还原');
  assert.equal(r.emptyDisplay, '', '★ 空态区要放回来');
  assert.equal(r.scanBtnDisplay, '', '★ 扫描按钮要恢复');
  assert.match(r.status, /❌/, '状态栏要有错误');
});

test('AbortError(超时)要说清是超时, 而不是"fetch failed"', async () => {
  const err = new Error('signal is aborted without reason'); err.name = 'AbortError';
  const r = await run({ res: () => { throw err; } });
  assert.match(r.status, /超时|30s/, '超时要说清: ' + r.status);
  assert.ok(!r.progressVisible, '★ progress 区必须还原');
});

test('成功启动时不能被还原逻辑误伤', async () => {
  // 这是最该防的回归: 还原函数如果写得太宽, 成功路径也会把 progress 藏掉 ——
  // 那样扫描刚开始界面就空了, 比原 bug 更糟。
  const r = await run({ res: { jobId: 'job-1', success: true } });
  assert.ok(r.progressVisible, '★ 成功启动后 progress 区必须仍然可见(轮询要靠它)');
  assert.equal(r.stopBtnDisplay, '', '成功启动后停止按钮应可见');
  assert.equal(r.scanBtnDisplay, 'none', '成功启动后扫描按钮仍隐藏(扫完才回来)');
  assert.equal(r.emptyDisplay, 'none', '★ 成功启动时空态区应保持隐藏, 不能被还原函数放出来');
});

test('restoreDupScanUI 幂等: 连续调用两次不会出错', async () => {
  const r = await run({ res: { error: '目录不存在: /x', success: false } });
  // 再手动触发一次(模拟用户重复点扫描又失败)
  const r2 = await run({ res: { error: '目录不存在: /x', success: false } });
  assert.ok(!r2.progressVisible && r2.emptyDisplay === '' && r2.scanBtnDisplay === '',
    '重复失败后状态应一致');
});

test('静态检查: startDupScan 的每条早退路径都调了 restoreDupScanUI', () => {
  const f = fnSrc('startDupScan');
  // 统计"藏了内容区 + 显示 progress"之后的所有 return / catch
  const afterHiding = f.slice(f.indexOf("classList.add('visible')"));
  const earlyReturns = afterHiding.match(/\breturn;|\}\s*catch/g) || [];
  const calls = (afterHiding.match(/restoreDupScanUI\(/g) || []).length;
  // 1 条 result.error 早退 + 1 条 catch = 2 处
  assert.ok(earlyReturns.length >= 2,
    'startDupScan 在隐藏界面之后应有 2 条早退路径, 实际 ' + earlyReturns.length);
  assert.ok(calls >= 2,
    '★ 两条早退路径都要调 restoreDupScanUI, 实际只调了 ' + calls + ' 次 —— ' +
    '漏一条就是"某一种失败留空进度条, 另一种不会", 比原来更难查');
});

test('restoreDupScanUI 存在且做了该做的四件事', () => {
  const f = fnSrc('restoreDupScanUI');
  assert.ok(f, '应存在 restoreDupScanUI');
  assert.match(f, /classList\.remove\('visible'\)/, '必须移除 progress 的 visible');
  assert.match(f, /scanBtn\.disabled = false/, '必须恢复扫描按钮');
  assert.match(f, /emptyEl\.style\.display = ''/, '必须把空态区放回来');
  assert.match(f, /stopBtn\.style\.display = 'none'/, '失败时停止按钮不该出现');
});

test('成功收尾(finishDupScan)也要清进度文案', () => {
  // 浏览器实测发现的第二个问题: 成功路径 finishDupScan 移除了 progress 的
  // visible, 但没改文案。下次 startDupScan 开头重设「正在验证路径...」时,
  // 中间会闪出上一次的「正在验证路径...」/「正在计算哈希值 812/1000」。
  // 扫描成功和失败两条路径都要清。
  const f = fnSrc('finishDupScan');
  assert.ok(f, '应存在 finishDupScan');
  assert.match(f, /classList\.remove\('visible'\)/);
  assert.match(f, /progressText\)\s*;\s*if\(pt\) pt\.textContent\s*=\s*''/,
    '★ finishDupScan 成功收尾也必须清 progressText');
  assert.match(f, /progressCount\)\s*;\s*if\(pc\) pc\.textContent\s*=\s*''/);
  assert.match(f, /currentFile\)\s*;\s*if\(cf\) cf\.textContent\s*=\s*''/);
});

test('两条路径都清文案(成功 finishDupScan / 失败 restoreDupScanUI)', () => {
  for (const fn of ['finishDupScan', 'restoreDupScanUI']) {
    const f = fnSrc(fn);
    assert.ok(f, fn + ' 应存在');
    assert.match(f, /progressText/, fn + ' 没碰 progressText —— 会闪上一次的内容');
    assert.match(f, /progressCount/, fn + ' 没碰 progressCount');
  }
});
