// 相似文件并排对比 (P1-4) 回归测试 — 2026-09-30
//
// 背景: 相似文件结果只有路径和百分比, 用户"眼见为实"才能决定删哪张
// (dupeGuru Picture mode / Czkawka side-by-side 都是这个思路)。
// 本测试锁定: 缩略图 API 的安全边界、缓存行为、以及对比弹窗的 HTML 拼装。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'api', 'simdup.js'), 'utf8');
const srvSrc = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'server.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app', 'ui', 'styles', 'style.css'), 'utf8');

test('缩略图 API: 路由已注册', () => {
  assert.ok(srvSrc.includes("path === '/api/simdup/thumb'"), 'server.js 未注册 /api/simdup/thumb');
  assert.ok(/handleSimDupThumb/.test(srvSrc), '未导入 handleSimDupThumb');
  assert.ok(/export function handleSimDupThumb/.test(apiSrc), '未导出 handleSimDupThumb');
});

test('缩略图 API: 路径越界与类型都要拦', () => {
  const body = apiSrc.slice(apiSrc.indexOf('export function handleSimDupThumb'));
  assert.ok(/isSafePath\(p\)/.test(body), '未做 isSafePath 校验');
  assert.ok(/403/.test(body), '越界未返回 403');
  assert.ok(/THUMB_EXTS\.has\(ext\)/.test(body), '未做扩展名白名单校验');
  assert.ok(/400/.test(body), '类型不符未返回 400');
  assert.ok(/404/.test(body), '文件不存在未返回 404');
  // 白名单不能包含可执行/敏感类型
  const m = apiSrc.match(/const THUMB_EXTS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, '未找到 THUMB_EXTS');
  for (const bad of ["'.js'", "'.sh'", "'.exe'", "'.php'", "'.py'"]) {
    assert.ok(!m[1].includes(bad), `缩略图白名单不应包含 ${bad}`);
  }
});

test('缩略图 API: 返回 JPEG 且带私有缓存头', () => {
  const body = apiSrc.slice(apiSrc.indexOf('export function handleSimDupThumb'));
  assert.ok(/'Content-Type': 'image\/jpeg'/.test(body), '未设置 image/jpeg');
  assert.ok(/Content-Length/.test(body), '未设置 Content-Length');
  assert.ok(/Cache-Control.*max-age/.test(body), '未设置缓存头');
});

test('缩略图 API: 磁盘缓存键含 mtime+size, 内容变化即失效', () => {
  const body = apiSrc.slice(apiSrc.indexOf('function buildThumb'),
    apiSrc.indexOf('// GET /api/simdup/thumb'));
  assert.ok(/Math\.floor\(st\.mtimeMs\)/.test(body), '缓存键未含 mtime');
  assert.ok(/st\.size/.test(body), '缓存键未含 size');
  assert.ok(/join\(thumbCacheDir\(\), key \+ '\.jpg'\)/.test(body), '缓存文件名未由 key 派生');
  assert.ok(/if \(existsSync\(out\)\)/.test(body), '未优先读缓存');
  // 缓存必须落在应用数据目录, 不能污染用户卷。
  // 注意: thumbCacheDir() 定义在 buildThumb 之前, 必须单独切片。
  // PKGVAR 统一由 lib/pkgvar.js 解析（env → 安装路径反推 → 兜底）,
  // 所以这里断言「走 getPkgVar()」而不是直接读 process.env。
  const dirBody = apiSrc.slice(apiSrc.indexOf('function thumbCacheDir'),
    apiSrc.indexOf('/** 生成(或复用)缩略图'));
  assert.ok(/getPkgVar\(\)/.test(dirBody), '缓存根目录未取自 getPkgVar()（应用数据目录）');
  assert.ok(!/process\.env\.TRM_PKGVAR\s*\|\|/.test(dirBody), '缓存根目录不得再写死兜底路径');
  assert.ok(/join\(base, 'data', 'thumbs'\)/.test(dirBody), "缓存目录应为 <PKGVAR>/data/thumbs");
  assert.ok(!/join\('\/vol[123]'/.test(dirBody), '缓存目录不得直接写用户卷路径');
});

test('缩略图 API: 视频取非黑屏帧, 统一缩放到定宽', () => {
  const body = apiSrc.slice(apiSrc.indexOf('function buildThumb'),
    apiSrc.indexOf('// GET /api/simdup/thumb'));
  assert.ok(/VIDEO_EXTS\.has/.test(body), '未区分视频');
  assert.ok(/'-ss', '1'/.test(body), '视频未跳到 1 秒处(易取到黑屏片头)');
  assert.ok(/scale=\$\{THUMB_WIDTH\}:-1/.test(body), '未按定宽缩放');
  assert.ok(/'-frames:v', '1'/.test(body), '未限制只取 1 帧');
});

test('对比弹窗: 用原生 <dialog> 而非自定义 modal', () => {
  assert.ok(/<dialog id="simdupCompareDlg"/.test(html), 'index.html 缺少 <dialog>');
  assert.ok(/id="simdupCmpBody"/.test(html), '缺少对比内容容器');
  assert.ok(/id="simdupCmpClose"/.test(html), '缺少关闭按钮');
  assert.ok(/::backdrop/.test(css), '缺少遮罩样式');
  assert.ok(/\.simdup-cmp-btn/.test(css), '缺少对比按钮样式');
  // 关键: 不能用 inline onclick(fnOS WebView/CEF 下静默失效)
  assert.ok(!/onclick="simDupCompareGroup/.test(mainSrc), '对比入口不得使用 inline onclick');
  assert.ok(/addEventListener\('click', function\(\)\{ simDupCompareGroup/.test(mainSrc),
    '对比按钮未用 addEventListener 绑定');
});

test('对比弹窗: 组号渲染为可点击按钮并携带组号', () => {
  // 相似改成组卡片后, 对比按钮从"每行一个"挪到了组头, 但 data-grp 仍必须带组号
  assert.ok(/class="simdup-cmp-btn" data-grp="' \+ g\.group \+ '"/.test(mainSrc),
    '组头未渲染为带 data-grp 的对比按钮');
  assert.ok(/querySelectorAll\('\.simdup-cmp-btn'\)/.test(mainSrc), '未做事件委托绑定');
  assert.ok(/_simCmpGroups = s\.groups \|\| \[\]/.test(mainSrc), '渲染时未保存 groups 供弹窗取用');
});

// ── 真执行: 抽取 HTML 拼装逻辑, 验证输出 ─────────────────────────────────
function renderCompare(group) {
  const start = mainSrc.indexOf('function simDupCompareGroup');
  const end = mainSrc.indexOf('function simDupCompareClose');
  assert.ok(start > 0 && end > start, '未能定位对比弹窗函数');
  const fnSrc = mainSrc.slice(start, end);
  // 依赖的外部符号: escHtml / simSimilarityPct / $ / _simCmpGroups / _simThumb
  const stub = `
    const $ = id => (id === 'simdupCompareDlg' ? dlg
                   : id === 'simdupCmpBody' ? body
                   : id === 'simdupCmpTitle' ? title : null);
    const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
    const SIMDASH_BITS = 64;
    function simSimilarityPct(d){ if(d==null||d<0) return null; return Math.max(0,Math.round((1-d/SIMDASH_BITS)*100)); }
    function simDupThumbUrl(p){ return 'api/simdup/thumb?path=' + encodeURIComponent(p); }
    let _simCmpGroups = GROUPS;
  `;
  const dlg = { showModal(){ dlg._opened = true; }, setAttribute(){}, removeAttribute(){} };
  const body = { innerHTML: '' };
  const title = { textContent: '' };
  const GROUPS = [group];
  const f = new Function('dlg', 'body', 'title', 'GROUPS', stub + fnSrc + '\nsimDupCompareGroup(GROUPS[0].group);');
  f(dlg, body, title, GROUPS);
  return { html: body.innerHTML, title: title.textContent, opened: !!dlg._opened };
}

test('对比弹窗: 真执行渲染出每个文件的缩略图与相似度', () => {
  const r = renderCompare({
    group: 1, minDist: 2,
    files: [
      { path: '/vol1/1000/照片/a.jpg', name: 'a.jpg', size_str: '1.2 MB', minDist: 2 },
      { path: '/vol1/1000/照片/b.jpg', name: 'b.jpg', size_str: '1.3 MB', minDist: 5 },
    ],
  });
  assert.ok(r.opened, '未调用 showModal');
  assert.match(r.html, /<img src="api\/simdup\/thumb\?path=/, '未生成缩略图 img');
  assert.ok((r.html.match(/<img /g) || []).length === 2, '缩略图数量应等于文件数');
  assert.match(r.html, /相似 97%/, '未显示高相似度(距离 2 → 97%)');
  assert.match(r.html, /相似 92%/, '未显示另一文件相似度(距离 5 → 92%)');
  assert.match(r.title, /第 1 组/, '标题未含组号');
  assert.match(r.title, /最相似 97%/, '标题未点明组内最相似度');
  // 路径必须 URL 编码, 防止中文/特殊字符破坏 URL
  // 路径必须经 encodeURIComponent 编码(见 simDupThumbUrl), 否则中文/空格破坏 URL。
  // 原断言被 `|| true` 短路成恒真。真正的防线在 main.js 的 simDupThumbUrl ——
  // 本测试的 renderCompare 用的是 stub 版 _simThumb, 所以这里改成源码级断言。
  const thumbUrlSrc = mainSrc.slice(mainSrc.indexOf('function simDupThumbUrl'),
    mainSrc.indexOf('function simDupThumbUrl') + 200);
  assert.ok(thumbUrlSrc.length > 0, 'main.js 中未找到 simDupThumbUrl');
  assert.match(thumbUrlSrc, /encodeURIComponent\(p\)/,
    'simDupThumbUrl 必须用 encodeURIComponent 编码 path, 否则中文/空格会破坏 URL');
  assert.match(r.html, /href="\/vol1\/1000\/照片\/a\.jpg"/, '未提供点击查看原图的链接');
});

test('对比弹窗: 无距离数据时显示占位而非 0%', () => {
  const r = renderCompare({
    group: 7, minDist: null,
    files: [{ path: '/vol1/x.jpg', name: 'x.jpg', size_str: '1 MB', minDist: null }],
  });
  assert.doesNotMatch(r.html, /相似 0%/, '无距离时不应显示 0%');
  assert.doesNotMatch(r.title, /最相似/, '无距离时标题不应带最相似');
  assert.match(r.html, /<img /, '仍应渲染缩略图');
});

test('对比弹窗: 未知组号安全返回, 不抛异常', () => {
  const start = mainSrc.indexOf('function simDupCompareGroup');
  const end = mainSrc.indexOf('function simDupCompareClose');
  const fnSrc = mainSrc.slice(start, end);
  const stub = `
    const $ = () => null;
    let _simCmpGroups = null;
  `;
  const f = new Function(stub + fnSrc + '\nsimDupCompareGroup(999);');
  assert.doesNotThrow(() => f(), '组号不存在时不应抛异常');
});
