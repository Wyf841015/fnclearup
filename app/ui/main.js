(function(){
'use strict';

const App = {
  installedApps: [], orphanData: {},
  mountsLoaded: false, vol02Scanned: false, diskMountsLoaded: false,
  dockerVolumesLoaded: false, dockerNetworksLoaded: false, dockerImagesLoaded: false,
  tempScanned: false
};

// P1: 原来直接 return r.json(), HTTP 状态码被丢弃 —— 后端 500 返回 HTML 时
// 抛出的是 "Unexpected token '<'" 这类 JSON 解析错, 真实错误信息被吞掉;
// 4xx+JSON 时业务 error 字段能读到但调用方无从知道这是错误响应。
// 这里不抛错(抛错会打断几十个现有调用点的正常路径), 只把状态信息挂到结果对象上,
// 调用方需要时可读 __ok / __status / __error。
async function parseFetchResponse(r) {
  let data, parsed = true;
  try { data = await r.json(); }
  catch { parsed = false; data = { success: false, error: `响应不是合法 JSON (HTTP ${r.status})` }; }
  // HTTP 200 但 body 不是 JSON 时(网关 302 跳登录页会回 HTML)同样不可信 ——
  // 这时数据全是 undefined, 调用方按 200 正常渲染就会显示 "undefined 个"。
  // 所以 __ok 要同时看 HTTP 状态和 JSON 是否解析成功。
  data.__ok = r.ok && parsed;
  data.__status = r.status;
  // 后端的 4xx 响应本身带 error 字段(如 403 { error: 'path must be under /vol*' }),
  // 原来的写法 "if (!r.ok && !data.error)" 在这种情况下反而不设 __error,
  // 调用方回退成 `HTTP 403` —— 真实原因又被掩盖了一次。这里统一: 有 error 用它,
  // 没有才回退成状态码。
  if (!data.__ok) data.__error = data.error || `HTTP ${r.status}`;
  return data;
}

const API = {
  base: '/app/fnclearup/',
  async get(path, timeoutMs=15000) {
    const ac = new AbortController();
    const t = setTimeout(()=>ac.abort(), timeoutMs);
    try { const r=await fetch(this.base+path,{signal:ac.signal}); clearTimeout(t); return await parseFetchResponse(r); }
    catch(e){ clearTimeout(t); throw e; }
  },
  async post(path, body, timeoutMs=30000) {
    const ac = new AbortController();
    const t = setTimeout(()=>ac.abort(), timeoutMs);
    try { const r=await fetch(this.base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ac.signal}); clearTimeout(t); return await parseFetchResponse(r); }
    catch(e){ clearTimeout(t); throw e; }
  }
};

const $ = id => document.getElementById(id.replace(/^#/, ''));

function escHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

// Theme
const THEME_KEY = 'fnclearup-dark';
function applyTheme(dark) { document.documentElement.classList.toggle('dark', dark); }
function toggleTheme() {
  const dark = !document.documentElement.classList.contains('dark');
  applyTheme(dark);
  try { localStorage.setItem(THEME_KEY, dark ? '1' : '0'); } catch (e) { console.error('[main.js]', e); }
}
function initTheme() {
  let dark = false;
  try { dark = localStorage.getItem(THEME_KEY) === '1'; } catch (e) { console.error('[main.js]', e); }
  applyTheme(dark);
}
// Lucide icons init
let _lucideTimer = null;
function initLucide() {
  if (typeof lucide === 'undefined') return;
  lucide.createIcons();
  if (!initLucide._obs && typeof MutationObserver !== 'undefined') {
    initLucide._obs = true;
    // P1: 回调触发的**原因**正是 createIcons() 自己替换 <i data-lucide> 产生的
    // childList 变更。debounce 只合并不打断, 只要 createIcons() 每次都产出新的
    // childList, 链条就以 ~20Hz 永续自触发。这里加自写互斥(与 motion.js 的
    // data-counting 同思路): 执行期间置位, 置位时直接 return。
    new MutationObserver(() => {
      if (document.body.__iconizing) return;
      clearTimeout(_lucideTimer);
      _lucideTimer = setTimeout(() => {
        if (document.body.__iconizing) return;
        document.body.__iconizing = true;
        try { if (typeof lucide !== 'undefined') lucide.createIcons(); }
        finally { document.body.__iconizing = false; }
      }, 50);
    }).observe(document.body, { subtree: true, childList: true });
  }
}

// Toast
function showToast(msg, type='info') {
  const t = document.createElement('div'); t.className='toast '+type; t.textContent=msg;
  const c = document.getElementById('toastContainer');
  if (!c) { const nc=document.createElement('div'); nc.id='toastContainer'; document.body.appendChild(nc); nc.appendChild(t); }
  else c.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),300);},3000);

}
// P0 安全(2026-09-30): 删除端点会拦截 fnOS 系统目录(@appcenter/@appdata/...)
// 与卷内回收站(.@#local)。前端必须把拦截原因透出, 否则用户会以为程序出错。
// ── 扫描排除规则 (P1-1) ──────────────────────────────────────────────────
async function loadDupExcludeRules(){
  const box = $('dupExcludeBox');
  try {
    const r = await API.get('api/dup/exclude-rules');
    const ta = $('dupExcludePatterns');
    if (ta) ta.value = (r.patterns || []).join('\n');
    const st = $('dupExcludeStatus');
    if (st) st.textContent = r.isDefault ? '当前使用默认规则（' + (r.patterns||[]).length + ' 条）'
                                          : '自定义规则（' + (r.patterns||[]).length + ' 条）· ' + (r.file || '');
  } catch(e) { /* 面板未打开时忽略 */ }
}
async function saveDupExcludeRules(){
  const ta = $('dupExcludePatterns');
  if (!ta) return;
  const patterns = ta.value.split('\n').map(x => x.trim()).filter(Boolean);
  try {
    const r = await API.post('api/dup/exclude-rules', { patterns });
    const st = $('dupExcludeStatus');
    if (st) st.textContent = '✓ 已保存 ' + r.count + ' 条规则，下次扫描生效';
    showToast('排除规则已保存（' + r.count + ' 条）', 'success');
  } catch(e){ showToast('保存失败: ' + e.message, 'error'); }
}
async function resetDupExcludeRules(){
  try {
    const r = await API.get('api/dup/exclude-rules');
    const ta = $('dupExcludePatterns');
    if (ta) ta.value = (r.defaultPatterns || []).join('\n');
    const st = $('dupExcludeStatus');
    if (st) st.textContent = '已填入默认规则，点「保存」生效';
  } catch(e){ showToast('读取默认规则失败: ' + e.message, 'error'); }
}
// 首次打开折叠区时懒加载
(function(){
  function bind(){
    const box = document.getElementById('dupExcludeBox');
    if (box && !box._exclBound){
      box._exclBound = true;
      box.addEventListener('toggle', function(){ if (box.open) loadDupExcludeRules(); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

function blockedNotice(d){
  const n = (d && d.blockedCount) || 0;
  if(!n) return '';
  const first = (d && d.blocked && d.blocked[0]) || null;
  const why = first && first.reason ? (first.reason) : '位于系统目录或回收站';
  return n === 1 ? ` · 1 个受保护未删除（${why}）` : ` · ${n} 个受保护未删除（${why} 等）`;
}

// ── Cleanup summary ──
// Generic table filter: hide rows whose given column doesn't match the query
function filterTable(inputId, tableId, colIndex) {
  const input = document.getElementById(inputId);
  const table = document.getElementById(tableId);
  if (!input || !table) return;
  const q = input.value.trim().toLowerCase();
  const rows = table.querySelectorAll('tbody tr');
  for (const row of rows) {
    const cell = row.children[colIndex];
    const txt = cell ? cell.textContent.toLowerCase() : '';
    row.style.display = (!q || txt.includes(q)) ? '' : 'none';
  }
}

// Generic table CSV export: extracts table data, then lets the user pick a
// folder on the NAS to write it to (was: Blob + a.download → browser's download
// dir, unreachable inside the fnOS WebView).
function exportTableToCSV(tableId, filename) {
  const table = document.getElementById(tableId);
  if (!table) return showToast('未找到数据表', 'error');
  const rows = []; const cols = [];
  const thead = table.querySelector('thead');
  if (thead) {
    const ths = thead.querySelectorAll('th');
    ths.forEach((th,i) => { if (i > 0 || !th.querySelector('input[type=checkbox]')) cols.push(th.textContent.trim()); });
  }
  const tbody = table.querySelector('tbody');
  if (!tbody || tbody.rows.length === 0) { showToast('无数据可导出', 'warning'); return; }
  for (const tr of tbody.rows) {
    if (tr.style.display === 'none') continue;
    const row = []; const cells = tr.querySelectorAll('td');
    for (let i = 0, ci = 0; i < cells.length; i++) {
      if (ci < cols.length && cells[i].querySelector('input[type=checkbox]')) continue;
      row.push('"' + (cells[i].textContent || '').trim().replace(/"/g, '""') + '"');
      ci++;
    }
    rows.push(row.join(','));
  }
  // \uFEFF = BOM, Excel 打开中文 CSV 不乱码; 用转义写法而非字面字符, 避免源码编码问题
  const csv = '\uFEFF' + cols.join(',') + '\n' + rows.join('\n');
  saveContentViaBrowser(csv, filename || 'export.csv');
}

async function refreshCleanupSummary() {
  const body = $('summaryBody');
  if (!body) return;
  body.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-secondary)">⏳ 扫描中...</div>';
  try {
    const r = await API.get('api/cleanup/quick-summary', 20000);
    if (!r.ok && !r.results) { body.innerHTML = '<div style="color:var(--color-danger)">❌ ' + escHtml(r.error || '扫描失败') + '</div>'; return; }
    const res = r.results || {};
    const rows = [];
    function addRow(icon, label, count, size, tab) {
      rows.push(`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--color-border);cursor:pointer" onclick="switchTab('${tab}');document.getElementById('cleanupSummaryModal').classList.remove('visible')">
        <span>${icon} ${label}</span>
        <span style="color:var(--color-text-secondary)">${count} 项${size ? ' · ' + formatBytes(size) : ''}</span>
      </div>`);
    }
    if (res.app) addRow('📦', '应用残留', res.app.count, res.app.size, 'app');
    if (res.temp) addRow('🕐', '过期临时文件', res.temp.count, res.temp.size, 'temp');
    if (res.docker_images) addRow('🖼️', 'Docker 镜像', res.docker_images.count, 0, 'docker');
    if (res.docker_volumes) addRow('💾', 'Docker 卷', res.docker_volumes.count, 0, 'docker');
    if (res.docker_networks) addRow('🌐', 'Docker 网络', res.docker_networks.count, 0, 'docker');
    if (rows.length === 0) rows.push('<div style="text-align:center;padding:20px;color:var(--color-success)">🎉 未发现明显可清理项</div>');
    body.innerHTML = rows.join('');
  } catch (e) {
    body.innerHTML = '<div style="color:var(--color-danger)">❌ ' + escHtml(e.message) + '</div>';
  }
}
function showCleanupSummary() {
  const m = $('cleanupSummaryModal');
  if (!m) return;
  m.classList.add('visible');
  refreshCleanupSummary();
}

// Sponsor
function showSponsorModal() { $('#sponsorModal')?.classList.add('show'); }

// ── 赞助提醒: 启动风险警告确认后再弹一次 ──────────────────────────
//
// 为什么加频率控制: 打开应用本来就有强制的「清理有风险」警告(还带 3 秒倒计时),
// 再叠一个每次必弹的赞助框就是连续两次打断, 天天用的人会直接麻木 ——
// 到了「看到就划掉」的程度, 反而比不弹更糟。
// 规则: 首次打开必弹; 之后每 7 天提醒一次。localStorage 不可用时按「该弹」处理,
// 宁可多弹一次也别让整个提醒链路静默失效。
const SPONSOR_REMIND_KEY = 'fnclearup.sponsor.remindAt';
const SPONSOR_REMIND_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function maybeShowSponsorReminder() {
  let due = true;
  try {
    const last = Number(localStorage.getItem(SPONSOR_REMIND_KEY) || 0);
    due = !(last > 0 && (Date.now() - last) < SPONSOR_REMIND_INTERVAL_MS);
    if (due) localStorage.setItem(SPONSOR_REMIND_KEY, String(Date.now()));
  } catch (e) {
    console.error('[main.js] sponsor remind:', e);
    due = true;
  }
  if (due) {
    // 延后一拍: 让警告弹窗的关闭动画先走完, 两个框不要叠在一起闪
    setTimeout(() => showSponsorModal(), 260);
  }
  return due;
}
function showSponsorImgFull(img) { const o=document.getElementById('sponsorImgOverlay'); if(o){o.classList.add('show');document.getElementById('sponsorImgFull').src=img.src;} }

// 联系作者
function showContactModal() { $('#contactModal')?.classList.add('show'); }
function copyQQNumber() {
  const qq = '745565752';
  const el = $('#qqNumber');
  const feedback = (ok) => {
    if (!el) return;
    const orig = el.textContent;
    el.textContent = ok ? '✓ 已复制' : '复制失败，请长按/选中后手动复制';
    el.style.color = ok ? 'var(--color-success)' : 'var(--color-warning)';
    setTimeout(() => { el.textContent = orig; el.style.color = ''; }, 2000);
  };
  // 降级链: navigator.clipboard → execCommand(带 focus) → 选中文本让用户手动复制
  // 每一级都必须兜住异常并给出可见反馈，绝不静默失败。
  const manualFallback = () => {
    try {
      if (!el) return feedback(false);
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection && window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    } catch (e) { /* ignore — 反馈仍要给 */ }
    feedback(false);
  };
  const execFallback = () => {
    let ta = null;
    try {
      ta = document.getElementById('__qqCopyTa');
      if (!ta) {
        ta = document.createElement('textarea');
        ta.id = '__qqCopyTa';
        ta.value = qq;
        ta.setAttribute('readonly', '');
        // 必须在 body 直属、尺寸非 0，否则 CEF 里 select() 会失败
        ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:99999';
        document.body.appendChild(ta);
      }
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, qq.length);
      if (document.execCommand('copy')) { ta.remove(); return feedback(true); }
    } catch (e) { /* 落到 manualFallback */ }
    if (ta && ta.remove) { try { ta.remove(); } catch (e) { /* ignore */ } }
    manualFallback();
  };
  // fnOS WebView 走 http（非安全上下文）时 navigator.clipboard 通常为 undefined
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(qq).then(() => feedback(true)).catch(execFallback);
    } else {
      execFallback();
    }
  } catch (e) { execFallback(); }
}

// ── Helper: selectAll for any table ──
function selectAllHandler(tableId, checkboxClass) {
  const tbl = $(tableId);
  if (!tbl) return;
  tbl.addEventListener('change', function(e) {
    if (e.target && e.target.classList.contains('select-all-cb')) {
      document.querySelectorAll('#'+tableId+' .'+checkboxClass+':not(:disabled)').forEach(cb => cb.checked = e.target.checked);
      // Call the appropriate update function
      if (checkboxClass === 'app-cb') updateSelectInfo();
      else if (checkboxClass === 'disk-cb') updateDiskSelectInfo();
      else if (checkboxClass === 'docker-cb') updateDockerSelectInfo();
      else if (checkboxClass === 'image-cb') updateImagesSelectInfo();
      else if (checkboxClass === 'network-cb') updateNetworkSelectInfo();
      else if (checkboxClass === 'temp-cb') updateTempSelectInfo();
      else if (checkboxClass === 'empty-cb') updateEmptySelectInfo();
    }
  });
}

// ════════════════════════════════
// Tab switching
// ════════════════════════════════
// ── 导航分组 ──
// 15 个 tab 按使用场景归为 4 组。这里只改导航层的呈现, tab / panel / 业务逻辑一律未动。
const TAB_GROUPS = {
  clean: ['app', 'disk', 'docker', 'sysjunk', 'users', 'kernel'],
  find:  ['scan'],
  space: ['diskanalysis'],
  auto:  ['schedule'],
};
// 记忆每组上次停留的 tab, 切组时回到原位而不是跳回组内第一个
const groupLastTab = { clean: 'app', find: 'scan', space: 'diskanalysis', auto: 'schedule' };
// 每个带二级分区的 panel 上次停在哪里。少这层记忆的话, switchTab('scan') 里
// 写死 switchInnerTab('duplicates') 会让用户每次回到该 tab 都被弹回第一个分区,
// 在「大文件」里翻页时切走再切回就丢了位置。
const panelInnerLastTab = { docker: 'images', sysjunk: 'syscache', scan: 'duplicates' };

// 旧 tab 名 → 「文件体检」下的二级分区。旧书签/历史调度任务仍写着这些名字。
const SCAN_TAB_TO_INNER = {
  dup: 'duplicates', simdup: 'similar', broken: 'broken',
  namematch: 'samename', empty: 'emptydirs', bigfiles: 'largefiles',
};
function tabGroupOf(tabName) {
  for (const g in TAB_GROUPS) if (TAB_GROUPS[g].includes(tabName)) return g;
  return null;
}
// 只切换组按钮与组内 tab 列表的可见性, 不碰 panel —— 避免与 switchTab 相互递归
function showGroup(g) {
  document.querySelectorAll('.group-btn').forEach(b => {
    const on = b.dataset.group === g;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-list').forEach(l => {
    l.classList.toggle('active', l.dataset.groupList === g);
  });
}
function switchGroup(g) {
  if (!TAB_GROUPS[g]) return;
  showGroup(g);
  switchTab(groupLastTab[g] || TAB_GROUPS[g][0]);
}

async function switchTab(tabName) {
  // 切到任何 tab 都先停掉定时清理的轮询, 只有 schedule 分支会再启动。
  // 放在函数最前面而不是各分支里, 免得新增 tab 时漏掉停止。
  stopSchedulePolling();
  // 若目标 tab 不在当前显示的组里, 顺手把组切过去(例如从「清理回收」直接跳到「定时」)
  const g = tabGroupOf(tabName);
  if (g) { showGroup(g); groupLastTab[g] = tabName; }
  document.querySelectorAll('.tab-btn').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tabName);b.setAttribute('aria-selected',b.dataset.tab===tabName?'true':'false');});
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.dataset.panel===tabName));
  if(tabName==='app') await doScan();
  else if(tabName==='disk') { App.diskMountsLoaded=false; await loadDiskMounts(true); }
  else if(tabName==='docker') { App.dockerVolumesLoaded=false; await loadDockerVolumes(); switchInnerTab(panelInnerLastTab.docker||'images'); }
  // 「Docker 清理」已并入 docker tab 的「容器 / 缓存」分区, 保留这个别名是为了
  // 旧书签 / 历史调度任务里仍写着 switchTab('dockercleanup') 时不至于失效。
  else if(tabName==='dockercleanup') { await switchTab('docker'); switchInnerTab('containers'); }
  else if(tabName==='scan') { switchInnerTab(panelInnerLastTab.scan||'duplicates'); }
  // 旧 tab 名别名: dup/simdup/broken/namematch/empty/bigfiles 已并入「文件体检」的六个分区。
  // 保留是为了旧书签与历史调度任务 —— 它们至今仍写着这些名字。
  else if(SCAN_TAB_TO_INNER[tabName]) {
    await switchTab('scan');
    switchInnerTab(SCAN_TAB_TO_INNER[tabName]);
  }
  else if(tabName==='sysjunk') { switchInnerTab(panelInnerLastTab.sysjunk||'syscache'); }
  else if(tabName==='users') { await loadUsers(); }
  else if(tabName==='kernel') { await kernelScan(); }
  // 旧 tab 名别名: 系统/临时文件/回收站 已并入「系统垃圾」的三个分区。
  // 保留这些分支是为了旧书签与历史调度任务 —— 它们至今仍写着这些名字。
  else if(tabName==='sysclean'||tabName==='trash'||tabName==='temp') {
    const map = { sysclean:'syscache', trash:'recycle', temp:'tmpfiles' };
    await switchTab('sysjunk');
    switchInnerTab(map[tabName]);
  }
  else if(tabName==='schedule') {
    // 切进「定时清理」才开轮询: 后台自动执行的任务完成后, 「上次运行」和
    // 执行历史会自己更新, 不必再切走切回。_lastHistorySig 先清掉, 因为
    // 上次离开这个 tab 期间历史可能已经被后端追加过。
    _lastHistorySig = null;
    loadSchedule();
    loadScheduleHistory(true);
    startSchedulePolling();
  }
  else if(tabName==='diskanalysis') { if(!App.dsLoaded) { App.dsLoaded=true; dsLoadVolumes(); } }
}

// ════════════════════════════════
// App Scan
// ════════════════════════════════
let _appScanning = false;
async function doScan() {
  // P1: switchTab('app') 每次都 await doScan(), 快速来回切 tab 会并发两个
  // api/scan, 两次都写 App.installedApps / App.orphanData 并各自重建表格,
  // 后返回的旧结果会覆盖新结果。加 in-flight 锁(项目里其它扫描都有此守卫)。
  if (_appScanning) return;
  _appScanning = true;
  try { await doScanInner(); } finally { _appScanning = false; }
}

async function doScanInner() {
  const btn=$('scanBtn')||$('scanTrigger'); const status=$('app-status'); const list=$('app-list');
  if(btn){btn.disabled=true;btn.innerHTML='<span>⏳</span><span>扫描中...</span>';}
  if(status){status.className='loading';status.textContent='⏳ 正在扫描...';}
  if(list)list.innerHTML='';
  const db=$('deleteBtn'); if(db)db.disabled=true;
  const si=$('select-info'); if(si)si.style.display='none';
  try {
    const data = await API.post('api/scan', {});
    // 后端在 appcenter-cli 取不到已装列表时会返回 500（fail-open 守卫）。
    // 不检查 __ok 的话 data.installed/orphan 都是 undefined → 渲染空表，
    // 用户以为"扫描完成无残余"，实际是根本没扫成。这里显式抛错走错误分支。
    if (data.__ok === false) throw new Error(data.__error || `HTTP ${data.__status}`);
    App.installedApps = data.installed||[];
    App.orphanData = {};
    if(Array.isArray(data.orphan)) {
      for(const item of data.orphan) {
        const sn = item.app;
        if(!App.orphanData[sn]) App.orphanData[sn]=[];
        App.orphanData[sn].push(item.path);
      }
    } else App.orphanData = data.orphan||{};
    const orphanNames = new Set(Object.keys(App.orphanData));
    const totalOrphan = orphanNames.size;
    if($('installed-count'))$('installed-count').textContent=App.installedApps.length;
    if($('orphan-count'))$('orphan-count').textContent=totalOrphan;
    const vols=new Set();
    for(const paths of Object.values(App.orphanData)) for(const p of paths) {
      const m=p.match(/^\/(vol\d+)/); if(m)vols.add(m[1]);
    }
    if($('vol-count'))$('vol-count').textContent=vols.size;
    // Build merged rows
    const rows=[];
    const installedSet = new Set(App.installedApps.map(a=>typeof a==='object'?a.appname:a));
    for(const app of App.installedApps) {
      const appname=typeof app==='object'?app.appname:app;
      const displayName=typeof app==='object'?app.display_name:app;
      const isO=orphanNames.has(appname);
      rows.push({status:isO?'orphan':'installed',appname:appname,displayName:displayName,paths:App.orphanData[appname]||[],isOrphan:isO});
    }
    for(const sn of orphanNames) {
      if(!installedSet.has(sn)) rows.push({status:'orphan',appname:sn,displayName:sn,paths:App.orphanData[sn]||[],isOrphan:true});
    }
    // Render table
    if(rows.length===0) {
      if(list)list.innerHTML='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">🎉 无残留</div>';
    } else {
      let html='<div class="list-scroll"><table class="data-table" id="app-table"><thead><tr>'+
        '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="selectAllApp(this)"></th>'+
        '<th style="width:44px">状态</th><th>应用</th><th style="min-width:100px">显示名称</th><th style="width:50px">所在卷</th><th>路径</th>'+
        '</tr></thead><tbody>';
      for(const row of rows) {
        const badge=row.status==='installed'
          ?'<span class="file-badge" style="background:#dcfce7;color:#059669">已安装</span>'
          :'<span class="file-badge" style="background:#fff7ed;color:#ea580c">残余</span>';
        const disabled=row.status==='installed';
        const rowStyle=disabled?'style="opacity:0.6"':'';
        const cbId='cb_'+row.appname.replace(/[^a-zA-Z0-9]/g,'_');
        const firstPath=row.paths[0]||'';
        const volMatch=firstPath.match(/^\/(vol\d+)/);
        const volsUsed=[...new Set(row.paths.map(p=>{const m=p.match(/^\/(vol\d+)/);return m?m[1]:'';}).filter(Boolean))].join(', ');
        const pathsStr=row.paths.join('\n');
        html+=`<tr ${rowStyle}>
          <td><input type="checkbox" class="app-cb" id="${cbId}" data-app="${escHtml(row.appname)}" data-firstpath="${escHtml(firstPath)}" onchange="updateSelectInfo()" ${disabled?'disabled':''}></td>
          <td>${badge}</td>
          <td style="font-family:var(--font-mono);font-size:13px;white-space:nowrap">${escHtml(row.appname)}</td>
          <td style="font-size:13px">${escHtml(row.displayName)}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(volsUsed||'-')}</td>
          <td class="paths-cell" title="${escHtml(pathsStr)}">${escHtml(firstPath)}${row.paths.length>1?' …':''}</td>
        </tr>`;
      }
      html+='</tbody></table></div>';
      if(list)list.innerHTML=html;
    }
    if(status){status.className='success';status.textContent=`✅ 已安装 ${App.installedApps.length} 个应用，发现 ${totalOrphan} 个残余`;}
  } catch(e) {
    if(status){status.className='error';status.textContent='❌ 扫描失败: '+e.message;}
    showToast('扫描失败','error');
  } finally {
    if(btn){btn.disabled=false;btn.innerHTML='<span>🔍</span><span>扫描目录</span>';}
  }
}

function selectAllApp(el) {
  document.querySelectorAll('#app-table .app-cb:not(:disabled)').forEach(cb => cb.checked = el.checked);
  updateSelectInfo();
}

function updateSelectInfo() {
  const cbs=document.querySelectorAll('#app-list .app-cb:checked');
  const db=$('deleteBtn'); const si=$('select-info');
  let totalPaths=0;
  for(const cb of cbs){
    const appname=cb.dataset.app;
    totalPaths+=(App.orphanData[appname]||[]).length;
  }
  if(cbs.length>0){if(db)db.disabled=false;if(si){si.style.display='';si.textContent=`已选 ${cbs.length} 个应用，共 ${totalPaths} 个路径`;}}
  else{if(db)db.disabled=true;if(si)si.style.display='none';}
}

function closeModal() { const m=$('confirmModal'); if(m)m.classList.remove('visible'); }
function confirmDelete() {
  const cbs=document.querySelectorAll('#app-list .app-cb:checked');
  if(cbs.length===0){showToast('请选择要删除的目录','error');return;}
  const c=$('confirmCount'); if(c)c.textContent=cbs.length;
  // Collect paths
  const allPaths=[];
  for(const cb of cbs){
    const appname=cb.dataset.app;
    if(App.orphanData[appname]&&App.orphanData[appname].length>0) allPaths.push(...App.orphanData[appname]);
    else if(cb.dataset.firstpath) allPaths.push(cb.dataset.firstpath);
  }
  const p=$('confirmPaths');
  if(p){
    p.innerHTML=allPaths.slice(0,20).map(p=>`<div>${escHtml(p)}</div>`).join('');
    if(allPaths.length>20)p.innerHTML+=`<div style="color:var(--color-text-secondary)">...还有 ${allPaths.length-20} 个</div>`;
  }
  $('confirmModal')?.classList.add('visible');
}
async function doDelete() {
  const cbs=document.querySelectorAll('#app-list .app-cb:checked');
  const allPaths=[];
  for(const cb of cbs){
    const appname=cb.dataset.app;
    if(App.orphanData[appname]&&App.orphanData[appname].length>0) allPaths.push(...App.orphanData[appname]);
    else if(cb.dataset.firstpath) allPaths.push(cb.dataset.firstpath);
  }
  const delUsers=!!$('deleteUsersCheckbox')?.checked;
  const delAppshare=!!$('deleteAppshareCheckbox')?.checked;
  $('confirmModal')?.classList.remove('visible');
  // P0-6: Strong warning before deleting users
  if (delUsers) {
    if (!confirm('⚠️ 危险操作：将删除系统用户及其家目录！\n\n确定要继续吗？')) {
      showToast('已取消', 'info');
      return;
    }
    if (!confirm('最后确认：用户家目录会被永久删除，无法恢复！\n\n继续吗？')) {
      showToast('已取消', 'info');
      return;
    }
  }
  try {
    const r=await API.post('api/delete',{paths:allPaths,delete_users:delUsers,delete_appshare_residual:delAppshare});
    // let 而非 const: 勾选「删除用户」成功后下面要 += 追加用户列表。
    // 原来是 const, 只要真删掉了用户就抛 TypeError: Assignment to constant
    // variable, 且抛点在下方 await doScan() 之前 —— 于是既弹错误提示,
    // 列表也不刷新（两个症状同一个根因）。
    let msg=`已删除 ${r.total||0} 个，失败 ${r.failures||0} 个`;
    if(r.skipped) msg+=`，跳过 ${r.skipped} 个`;
    if(r.users_deleted&&r.users_deleted.length) msg+=`，已删用户 ${r.users_deleted.join(',')}`;
    if(r.users_failed&&r.users_failed.length) msg+=`，用户未删 ${r.users_failed.length} 个（受保护）`;
    showToast(msg,'success');
    await doScan();
  } catch(e){showToast('删除失败: '+e.message,'error');await doScan();}
}

// ════════════════════════════════
// Disk Mounts
// ════════════════════════════════
async function loadDiskMounts(force) {
  if(App.diskMountsLoaded&&!force) return;
  App.diskMountsLoaded=true;
  const status=$('disk-status'); const list=$('disk-list'); const btn=$('scanDiskMountsBtn');
  const delBtn=$('deleteVol02Btn'); if(delBtn)delBtn.disabled=true;
  if(btn){btn.disabled=true;btn.innerHTML='<span>⏳</span><span>扫描中...</span>';}
  if(status){status.className='loading';status.textContent='⏳ 加载中...';}
  try {
    const [m, v] = await Promise.all([API.get('api/mounts'), API.get('api/vol02')]);
    const mounts=m.mounts||[]; const allDirs=v.vol02_dirs||[]; const mountedPts=v.mounted_points||[];
    const mountedSet=new Set();
    for(const mp of mountedPts){
      const name=mp.split('/').pop();
      if(name) mountedSet.add(name);
    }
    if($('vol02-total-count'))$('vol02-total-count').textContent=allDirs.length;
    if($('mounts-count'))$('mounts-count').textContent=mountedSet.size;
    const residual=allDirs.filter(d=>!mountedSet.has(d));
    if($('vol02-count'))$('vol02-count').textContent=residual.length;
    if(list){
      let html='<div class="list-scroll"><table class="data-table" id="disk-table"><thead><tr>'+
        '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="selectAllDisk(this)"></th>'+
        '<th style="width:44px">状态</th><th>目录名</th><th>挂载点</th><th>网盘类型</th>'+
        '</tr></thead><tbody>';
      for(const dirName of allDirs) {
        const isMounted=mountedSet.has(dirName);
        const fullPath='/vol02/'+dirName;
        const mountInfo=mounts.find(mx=>mx.mountPoint&&mx.mountPoint.includes(dirName));
        const badge=isMounted?'<span class="file-badge" style="background:#dcfce7;color:#059669">在用</span>':'<span class="file-badge" style="background:#fff7ed;color:#ea580c">残余</span>';
        const disabledAttr=isMounted?'disabled':'';
        const rowStyle=isMounted?'style="opacity:0.6"':'';
        const mountDisplay=mountInfo?escHtml(mountInfo.mountPoint||'-'):'-';
        const cstStr=mountInfo?escHtml(mountInfo.cloudStorageTypeStr||mountInfo.cloudStorageType||'-'):'-';
        html+=`<tr ${rowStyle}>
          <td><input type="checkbox" class="disk-cb" value="${escHtml(dirName)}" data-fullpath="${escHtml(fullPath)}" onchange="updateDiskSelectInfo()" ${disabledAttr}></td>
          <td>${badge}</td>
          <td style="font-family:var(--font-mono);font-size:13px;white-space:nowrap" title="${escHtml(fullPath)}">${escHtml(dirName)}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${mountDisplay}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${cstStr}</td>
        </tr>`;
      }
      html+='</tbody></table></div>';
      if(allDirs.length===0) html='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">🎉 /vol02 目录为空</div>';
      list.innerHTML=html;
    }
    if(status){status.className='success';status.textContent=`✅ 共 ${allDirs.length} 个目录（在用 ${allDirs.length-residual.length}，残余 ${residual.length}）`;}
  } catch(e){
    if(status){status.className='error';status.textContent='❌ 加载失败: '+e.message;}
  } finally {
    if(btn){btn.disabled=false;btn.innerHTML='<span>🔍</span><span>扫描目录</span>';}
  }
}

function selectAllDisk(el) {
  document.querySelectorAll('#disk-table .disk-cb:not(:disabled)').forEach(cb => cb.checked = el.checked);
  updateDiskSelectInfo();
}

function updateDiskSelectInfo() {
  const cbs=document.querySelectorAll('.disk-cb:checked');
  const db=$('deleteVol02Btn'); const si=$('disk-select-info');
  if(db)db.disabled=cbs.length===0;
  if(si){si.style.display=cbs.length>0?'':'none';si.textContent=`已选 ${cbs.length} 个`;}
}
function confirmDeleteVol02() {
  const cbs=document.querySelectorAll('.disk-cb:checked');
  if(cbs.length===0){showToast('请选择要删除的目录','error');return;}
  if(!confirm(`确定删除 ${cbs.length} 个网盘残余目录？`))return;
  doDeleteVol02();
}
async function doDeleteVol02() {
  const cbs=document.querySelectorAll('.disk-cb:checked');
  const paths=[...cbs].map(cb=>'/vol02/'+cb.value);
  try {
    const r=await API.post('api/delete',{paths});
    showToast(`已删除 ${r.total||0} 个，失败 ${r.failures||0} 个`,'success');
  } catch(e){showToast('删除失败: '+e.message,'error');}
  await loadDiskMounts(true);
}

// ════════════════════════════════
// Docker Inner Tab
// ════════════════════════════════
function switchInnerTab(tabName) {
  // 作用域必须限定在当前激活的 tab-panel 内。现在有两个 panel 各带一组 inner-tab
  // (docker 的 5 个 + 系统垃圾的 3 个), 早先用全局 querySelectorAll 会把对方
  // 的按钮和面板一起切成 inactive —— 切一次 Docker 再切系统垃圾就会互相抹掉。
  const activePanel = document.querySelector('.tab-panel.active');
  const scope = activePanel || document;
  if (activePanel && activePanel.dataset.panel) panelInnerLastTab[activePanel.dataset.panel] = tabName;
  scope.querySelectorAll('.inner-tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.innerTab===tabName));
  scope.querySelectorAll('.inner-panel').forEach(p=>p.classList.toggle('active',p.dataset.innerPanel===tabName));
  if(tabName==='images'&&!App.dockerImagesLoaded){App.dockerImagesLoaded=true;doImagesScan();}
  else if(tabName==='volumes'&&!App.dockerVolumesLoaded)loadDockerVolumes();
  else if(tabName==='networks'&&!App.dockerNetworksLoaded){App.dockerNetworksLoaded=true;doNetworksScan();}
  // 容器 / 缓存 分区来自原「Docker 清理」tab。
  // 切进来就自动扫 —— 用户反馈"每次都需要手动点击扫描"。容器分区实测只要
  // 0.1s 且状态随时会变, 每次都重扫; 缓存分区只读 KPI 卡片, dcCheckAvailable
  // 已经顺手填好了。
  else if(tabName==='containers'){ dcAutoScan(); }
  else if(tabName==='cache'){ dcCheckAvailable(); }
  // 系统缓存分区: 同样改成自动扫, 但走 sysCleanAutoScan() 限流(1 分钟内
  // 不重复), 因为它要 3.8~16s。
  else if(tabName==='syscache'){ sysCleanAutoScan(); }
  // 临时文件分区: 懒加载逻辑从原 switchTab('temp') 搬过来
  else if(tabName==='tmpfiles'&&!App.tempScanned){App.tempScanned=true;doTempScan();}
  // 空目录分区: 每次进入都重置到未扫描态(原 switchTab('empty') 的逻辑)
  else if(tabName==='emptydirs'){ EmptyDirState.items=[]; $('empty-empty').style.display=''; $('empty-results').style.display='none'; $('empty-list').innerHTML=''; $('empty-status').textContent=''; $('empty-count').textContent='-'; $('empty-pending').textContent='-'; $('empty-elapsed').textContent='-'; }
}

// ── Docker Volumes ──
async function loadDockerVolumes() {
  App.dockerVolumesLoaded=true;
  const status=$('docker-orphan-status'); const list=$('docker-volumes-list');
  try {
    const data=await API.get('api/volumes');
    const v=data.volumes||{};
    const inUse=v.in_use||[]; const orphan=v.orphan||[];
    const all=[...inUse,...orphan];
    if($('docker-total-count'))$('docker-total-count').textContent=all.length;
    if($('docker-inuse-count'))$('docker-inuse-count').textContent=inUse.length;
    if($('docker-orphan-count'))$('docker-orphan-count').textContent=orphan.length;
    if(list){
      let html='<div class="list-scroll"><table class="data-table" id="docker-vol-table"><thead><tr>'+
        '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="selectAllDockerVol(this)"></th>'+
        '<th style="width:44px">状态</th><th>卷名称</th><th>驱动</th><th>挂载点</th><th>关联容器</th>'+
        '</tr></thead><tbody>';
      for(const vol of all) {
        const isOrphan=orphan.some(o=>o.name===vol.name);
        const badge=isOrphan?'<span class="file-badge" style="background:#fff7ed;color:#ea580c">孤立</span>':'<span class="file-badge" style="background:#dcfce7;color:#059669">'+(vol.containers?vol.containers.length+' 个容器':'在用')+'</span>';
        const disabledAttr=isOrphan?'':'disabled';
        const rowStyle=isOrphan?'':'style="opacity:0.6"';
        const containers=(vol.containers||[]).map(c=>escHtml(c)).join(', ')||'-';
        html+=`<tr ${rowStyle}>
          <td><input type="checkbox" class="docker-cb" value="${escHtml(vol.name)}" data-volname="${escHtml(vol.name)}" onchange="updateDockerSelectInfo()" ${disabledAttr}></td>
          <td>${badge}</td>
          <td style="font-family:var(--font-mono);font-size:13px;white-space:nowrap">${escHtml(vol.name)}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(vol.driver||'-')}</td>
          <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary);max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(vol.mountpoint||'-')}">${escHtml(vol.mountpoint||'-')}</td>
          <td style="font-size:13px">${containers}</td>
        </tr>`;
      }
      html+='</tbody></table></div>';
      if(all.length===0) html='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">无 Docker 卷</div>';
      list.innerHTML=html;
    }
    if(status){status.className='success';status.textContent=`✅ ${all.length} 个卷（在用 ${inUse.length}，孤立 ${orphan.length}）`;}
  } catch(e){if(status){status.className='error';status.textContent='❌ '+e.message;}}
}

function selectAllDockerVol(el) {
  document.querySelectorAll('#docker-vol-table .docker-cb:not(:disabled)').forEach(cb => cb.checked = el.checked);
  updateDockerSelectInfo();
}

function updateDockerSelectInfo() {
  const cbs=document.querySelectorAll('.docker-cb:checked');
  const db=$('deleteDockerBtn'); if(db)db.disabled=cbs.length===0;
  const si=$('docker-select-info'); if(si){si.style.display=cbs.length>0?'':'none';si.textContent=`已选 ${cbs.length} 个卷`;}
}
function confirmDeleteDocker() {
  const cbs=document.querySelectorAll('.docker-cb:checked');
  if(cbs.length===0){showToast('请选择孤立卷','error');return;}
  showDockerVolDeleteModal();
}
function showDockerVolDeleteModal() {
  const count = document.querySelectorAll('.docker-cb:checked').length;
  $('dockerVolDeleteCount').textContent = count;
  $('dockerVolDeleteModal')?.classList.add('visible');
}
function hideDockerVolDeleteModal() { $('dockerVolDeleteModal')?.classList.remove('visible'); }
async function doDeleteDocker() {
  const vols=[...document.querySelectorAll('.docker-cb:checked')].map(cb=>cb.value);
  hideDockerVolDeleteModal();
  try {
    const r=await API.post('api/volumes/delete',{volumes:vols});
    showToast(`已删除 ${r.total||0} 个卷`,'success');
    App.dockerVolumesLoaded=false; await loadDockerVolumes();
  } catch(e){showToast('删除失败: '+e.message,'error');}
}

// ── Docker Networks ──
async function doNetworksScan() {
  const status=$('networks-status'); const list=$('networks-list');
  try {
    const data=await API.get('api/networks');
    const n=data.networks||{};
    const all=n.all||[];
    if($('networks-total-count'))$('networks-total-count').textContent=all.length;
    if($('networks-used-count'))$('networks-used-count').textContent=all.filter(x=>!x.unused).length;
    if($('networks-unused-count'))$('networks-unused-count').textContent=all.filter(x=>x.unused).length;
    if(list){
      let html='<div class="list-scroll"><table class="data-table" id="networks-table"><thead><tr>'+
        '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="selectAllNetworks(this)"></th>'+
        '<th style="width:44px">状态</th><th>网络名称</th><th>驱动</th><th>范围</th>'+
        '</tr></thead><tbody>';
      for(const net of all) {
        const isUnused=net.unused;
        const badge=isUnused?'<span class="file-badge" style="background:#fff7ed;color:#ea580c">未使用</span>':'<span class="file-badge" style="background:#dcfce7;color:#059669">'+(net.containers+' 个容器')+'</span>';
        const disabledAttr=isUnused?'':'disabled';
        const rowStyle=isUnused?'':'style="opacity:0.6"';
        html+=`<tr ${rowStyle}>
          <td><input type="checkbox" class="network-cb" value="${escHtml(net.name)}" data-netname="${escHtml(net.name)}" onchange="updateNetworkSelectInfo()" ${disabledAttr}></td>
          <td>${badge}</td>
          <td style="font-family:var(--font-mono);font-size:13px;white-space:nowrap">${escHtml(net.name)}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(net.driver)}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(net.scope)}</td>
        </tr>`;
      }
      html+='</tbody></table></div>';
      if(all.length===0) html='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">无 Docker 网络</div>';
      list.innerHTML=html;
    }
    if(status){status.className='success';status.textContent=`✅ ${all.length} 个网络（使用中 ${all.filter(x=>!x.unused).length}，未使用 ${all.filter(x=>x.unused).length}）`;}
  } catch(e){if(status){status.className='error';status.textContent='❌ '+e.message;}}
}

function selectAllNetworks(el) {
  document.querySelectorAll('#networks-table .network-cb:not(:disabled)').forEach(cb => cb.checked = el.checked);
  updateNetworkSelectInfo();
}

function updateNetworkSelectInfo() {
  const cbs=document.querySelectorAll('.network-cb:checked');
  const db=$('deleteNetworksBtn'); if(db)db.disabled=cbs.length===0;
  const si=$('networks-select-info'); if(si){si.style.display=cbs.length>0?'':'none';si.textContent=`已选 ${cbs.length} 个网络`;}
}
function confirmDeleteNetworks() {
  const cbs=document.querySelectorAll('.network-cb:checked');
  if(cbs.length===0){showToast('请选择网络','error');return;}
  showDockerNetDeleteModal();
}
function showDockerNetDeleteModal() {
  const count = document.querySelectorAll('.network-cb:checked').length;
  $('dockerNetDeleteCount').textContent = count;
  $('dockerNetDeleteModal')?.classList.add('visible');
}
function hideDockerNetDeleteModal() { $('dockerNetDeleteModal')?.classList.remove('visible'); }
async function doDeleteNetworks() {
  const nets=[...document.querySelectorAll('.network-cb:checked')].map(cb=>cb.value);
  hideDockerNetDeleteModal();
  try {
    const r=await API.post('api/networks/delete',{networks:nets});
    showToast(`已删除 ${r.total||0} 个网络`,'success');
    await doNetworksScan();
  } catch(e){showToast('删除失败: '+e.message,'error');}
}

// ── Docker Images ──
async function doImagesScan() {
  const status=$('images-status'); const list=$('images-list');
  try {
    const data=await API.get('api/images');
    const imgs=data.images||{};
    const all=imgs.all||[];
    if($('images-total-count'))$('images-total-count').textContent=all.length;
    if($('images-used-count'))$('images-used-count').textContent=all.filter(x=>x.used).length;
    if($('images-unused-count'))$('images-unused-count').textContent=all.filter(x=>!x.used&&!x.dangling).length;
    if(list){
      let html='<div class="list-scroll"><table class="data-table" id="images-table"><thead><tr>'+
        '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="selectAllImages(this)"></th>'+
        '<th style="width:44px">状态</th><th>镜像名</th><th>Tag</th><th>ID</th><th>大小</th><th>创建时间</th>'+
        '</tr></thead><tbody>';
      for(const img of all) {
        const isUsed=img.used; const isDangling=img.dangling;
        const badge=isUsed?'<span class="file-badge" style="background:#dcfce7;color:#059669">使用中</span>':(isDangling?'<span class="file-badge" style="background:#fce7f3;color:#db2777">悬空</span>':'<span class="file-badge" style="background:#fff7ed;color:#ea580c">未使用</span>');
        const isSelectable=!isUsed;
        const disabledAttr=isSelectable?'':'disabled';
        const rowStyle=isUsed?'style="opacity:0.6"':'';
        html+=`<tr ${rowStyle}>
          <td><input type="checkbox" class="image-cb" value="${escHtml(img.id)}" data-imgid="${escHtml(img.id)}" onchange="updateImagesSelectInfo()" ${disabledAttr}></td>
          <td>${badge}</td>
          <td style="font-family:var(--font-mono);font-size:13px;white-space:nowrap" title="${escHtml(img.repository)}">${escHtml(img.repository)}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(img.tag)}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(img.id)}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(img.size)}</td>
          <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(img.created)}</td>
        </tr>`;
      }
      html+='</tbody></table></div>';
      if(all.length===0) html='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">无 Docker 镜像</div>';
      list.innerHTML=html;
    }
    if(status){status.className='success';status.textContent=`✅ ${all.length} 个镜像（使用中 ${all.filter(x=>x.used).length}，未使用 ${all.filter(x=>!x.used&&!x.dangling).length}）`;}
  } catch(e){if(status){status.className='error';status.textContent='❌ '+e.message;}}
}

function selectAllImages(el) {
  document.querySelectorAll('#images-table .image-cb:not(:disabled)').forEach(cb => cb.checked = el.checked);
  updateImagesSelectInfo();
}

function updateImagesSelectInfo() {
  const cbs=document.querySelectorAll('.image-cb:checked');
  const db=$('deleteImagesBtn'); if(db)db.disabled=cbs.length===0;
  const si=$('images-select-info'); if(si){si.style.display=cbs.length>0?'':'none';si.textContent=`已选 ${cbs.length} 个镜像`;}
}
function confirmDeleteImages() {
  const cbs=document.querySelectorAll('.image-cb:checked');
  if(cbs.length===0){showToast('请选择镜像','error');return;}
  showDockerImgDeleteModal();
}
function showDockerImgDeleteModal() {
  const count = document.querySelectorAll('.image-cb:checked').length;
  $('dockerImgDeleteCount').textContent = count;
  $('dockerImgDeleteModal')?.classList.add('visible');
}
function hideDockerImgDeleteModal() { $('dockerImgDeleteModal')?.classList.remove('visible'); }
async function doDeleteImages() {
  const ids=[...document.querySelectorAll('.image-cb:checked')].map(cb=>cb.value);
  hideDockerImgDeleteModal();
  try {
    const r=await API.post('api/images/delete',{images:ids});
    showToast(`已删除 ${r.total||0} 个镜像`,'success');
    await doImagesScan();
  } catch(e){showToast('删除失败: '+e.message,'error');}
}

// ════════════════════════════════
// Temp files
// ════════════════════════════════
async function doTempScan() {
  const status=$('temp-status'); const list=$('temp-list');
  const btn=$('deleteTempBtn'); if(btn)btn.disabled=true;
  try {
    const data=await API.get('api/temp/scan');
    if($('temp-dirs-count'))$('temp-dirs-count').textContent=data.counts?.dirs||0;
    if($('temp-files-count'))$('temp-files-count').textContent=data.counts?.files||0;
    if($('temp-total-size'))$('temp-total-size').textContent=data.total_size_str||'0 B';
    if(list){
      const allItems=[...(data.dirs||[]),...(data.files||[])];
      if(allItems.length===0) {
        list.innerHTML='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">🎉 未发现过期临时文件</div>';
      } else {
        let html='<div class="list-scroll"><table class="data-table" id="temp-table"><thead><tr>'+
          '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="selectAllTemp(this)"></th>'+
          '<th>名称</th><th>位置</th><th>类型</th><th>大小</th><th>未访问</th>'+
          '</tr></thead><tbody>';
        for(const item of allItems) {
          const typeLabel=item.type==='dir'?'<span class="file-badge" style="background:#eef2ff;color:#6366f1">目录</span>':'<span class="file-badge" style="background:#f0fdf4;color:#059669">文件</span>';
          html+=`<tr>
            <td><input type="checkbox" class="temp-cb" value="${escHtml(item.path)}" onchange="updateTempSelectInfo()"></td>
            <td><span title="${escHtml(item.path)}">${escHtml(item.name)}</span></td>
            <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(item.dir)}</td>
            <td>${typeLabel}</td>
            <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(item.size_str||'-')}</td>
            <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${item.age_hours}h</td>
          </tr>`;
        }
        html+='</tbody></table></div>';
        list.innerHTML=html;
      }
    }
    if(status){status.className='success';status.textContent=`✅ ${data.counts?.files||0} 个文件 ${data.counts?.dirs||0} 个目录`;}
  } catch(e){if(status){status.className='error';status.textContent='❌ '+e.message;}}
}

function selectAllTemp(el) {
  document.querySelectorAll('#temp-table .temp-cb:not(:disabled)').forEach(cb => cb.checked = el.checked);
  updateTempSelectInfo();
}

function updateTempSelectInfo() {
  const cbs=document.querySelectorAll('.temp-cb:checked');
  const db=$('deleteTempBtn'); if(db)db.disabled=cbs.length===0;
  const si=$('temp-select-info'); if(si){si.style.display=cbs.length>0?'':'none';si.textContent=`已选 ${cbs.length} 项`;}
}
function confirmDeleteTemp() {
  const cbs=document.querySelectorAll('.temp-cb:checked');
  if(cbs.length===0){showToast('请选择文件','error');return;}
  showTempDeleteModal();
}
function showTempDeleteModal() {
  const count = document.querySelectorAll('.temp-cb:checked').length;
  $('tempDeleteCount').textContent = count;
  $('tempDeleteModal')?.classList.add('visible');
}
function hideTempDeleteModal() { $('tempDeleteModal')?.classList.remove('visible'); }
async function doDeleteTemp() {
  const paths=[...document.querySelectorAll('.temp-cb:checked')].map(cb=>cb.value);
  const mode=document.querySelector('input[name="tempDeleteMode"]:checked')?.value||'trash';
  hideTempDeleteModal();
  try {
    const r=await API.post('api/temp/delete',{paths,mode});
    showToast(`已处理 ${r.total||0} 个（跳过 ${r.skipped||0}）`,'success');
    await doTempScan();
  } catch(e){showToast('删除失败: '+e.message,'error');}
}

// ════════════════════════════════
// Duplicate File Scanning
// ════════════════════════════════
// 路径容器: 6 个扫描 tab 共用同一套「添加目录 / 标签列表 / 单个移除」组件。
// renderDupPaths / removeDupPath / browseSelect 都只依赖 `tab + 'PathList'` 这个
// DOM id 与 DupState[tab].paths, 因此新增 tab 只需在此登记, 无需改动组件代码。
const DupState = {
  music: { jobId: null, duplicates: [], checking: false, pagination: null, start: 0, paths: ['/vol1/1000/music'] },
  files: { jobId: null, duplicates: [], checking: false, pagination: null, start: 0, paths: ['/vol1/1000'] },
  // ↓ 2026-10-01: 相似/异常/重名/大文件 四项统一为去重风格的多目录选择
  simdup:  { paths: ['/vol1/1000'] },
  broken:  { paths: ['/vol1/1000'] },
  name:    { paths: ['/vol1/1000'] },
  bigfiles:{ paths: [] },
};

function getDupIds(tab) {
  return { pathInput: tab+'Path', scanBtn: tab+'ScanBtn', stopBtn: tab+'StopBtn', deleteBtn: tab+'DeleteBtn', exportBtn: tab+'ExportBtn', progress: tab+'Progress', progressBar: tab+'ProgressBar', progressText: tab+'ProgressText', progressCount: tab+'ProgressCount', currentFile: tab+'CurrentFile', status: tab+'Status', results: tab+'Results', stats: tab+'Stats', dupList: tab+'DupList', actions: tab+'Actions', selectedCount: tab+'SelectedCount', selectedSize: tab+'SelectedSize', empty: tab+'Empty' };
}

function switchDupInnerTab(tabName) {
  document.querySelectorAll('.dup-inner-tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.dupTab===tabName));
  document.querySelectorAll('.dup-inner-panel').forEach(p=>p.classList.toggle('active',p.dataset.dupPanel===tabName));
  updateDupSelectedCount();
}

/**
 * 扫描启动失败时把界面恢复成扫描前的样子。
 *
 * startDupScan 一进来就把 results / empty / actions 全藏了, 再显示 progress 区 ——
 * 这些改动只在「扫描成功启动」时才是对的。所以启动失败(目录不存在、网盘掉线、
 * 参数非法)必须原样还原, 否则用户看到的是:
 *   - progress 区永远停在「正在验证路径...」, 一个不动的进度条
 *   - 内容区一片空白(空态和结果都被藏了), 整块像卡死
 * 错误本身会写进状态栏, 但状态栏在 progress 区里, 用户第一眼看到的仍是空进度条。
 *
 * 成功路径的收尾在 finishDupScan, 失败路径收尾在这里 —— 两条路径都要还原,
 * 漏一条就是上面那个现象。
 */
function restoreDupScanUI(tab, msg) {
  const ids = getDupIds(tab);
  $(ids.progress)?.classList.remove('visible');
  // 文案/计数也要清。只移除 visible 时它虽然看不见, 但下次扫描开头设的
  // 「正在验证路径...」会闪一帧上一次的旧内容(比如「正在计算哈希值 812/1000」)。
  const bar = $(ids.progressBar); if (bar) bar.style.width = '0%';
  const txt = $(ids.progressText); if (txt) txt.textContent = '';
  const cnt = $(ids.progressCount); if (cnt) cnt.textContent = '';
  const cur = $(ids.currentFile); if (cur) cur.textContent = '';
  const scanBtn = $(ids.scanBtn), stopBtn = $(ids.stopBtn);
  if (scanBtn) { scanBtn.disabled = false; scanBtn.style.display = ''; }
  if (stopBtn) { stopBtn.style.display = 'none'; stopBtn.disabled = true; }
  // 空态区放回来并说明为什么空 —— 目录不存在时它是唯一能承载解释的地方
  const emptyEl = $(ids.empty);
  if (emptyEl) {
    emptyEl.style.display = '';
    const h3 = emptyEl.querySelector('h3');
    if (h3) h3.textContent = '❌ ' + (msg || '无法开始扫描');
    const p = emptyEl.querySelector('p');
    if (p) p.textContent = msg ? ('原因: ' + msg) : '请检查目录是否存在, 或换一个目录再试';
  }
}

async function startDupScan(tab) {
  const ids = getDupIds(tab);
  if (DupState[tab].checking) { showToast('已有扫描任务进行中', 'error'); return; }
  const scanPaths = DupState[tab].paths.slice();
  if (scanPaths.length === 0) { showToast('请添加至少一个扫描目录', 'error'); return; }

  $(ids.results)&&($(ids.results).style.display='none');
  $(ids.empty)&&($(ids.empty).style.display='none');
  $(ids.actions)&&$(ids.actions).classList.remove('visible');

  const pe = $(ids.progress); if(pe) pe.classList.add('visible');
  const bar=$(ids.progressBar), txt=$(ids.progressText), cnt=$(ids.progressCount), cur=$(ids.currentFile);
  if(bar) bar.style.width='0%'; if(txt) txt.textContent='正在验证路径...'; if(cnt) cnt.textContent='-'; if(cur) cur.textContent='';

  const scanBtn=$(ids.scanBtn), stopBtn=$(ids.stopBtn);
  if(scanBtn){scanBtn.disabled=true;scanBtn.style.display='none';}
  if(stopBtn){stopBtn.style.display='none';stopBtn.disabled=true;}

  const statusEl=$(ids.status);
  if(statusEl) statusEl.innerHTML='<span class="dup-spinner"></span> 正在验证路径...';

  try {
    const keepMode = $(tab+'KeepMode')?.value || 'deepest';
    let minSize = 0;
    const minEl = $(tab+'MinSize');
    if (minEl && minEl.value) { minSize = parseInt(minEl.value, 10); if (isNaN(minSize) || minSize<0) minSize = 0; }
    const result = await API.post('api/dup/scan', { type: tab==='music'?'music':'files', paths: scanPaths, minSize, keepMode });
    if (result.error || !result.jobId) {
      const msg = result.error || '启动扫描失败';
      showToast(msg,'error');
      if(statusEl) statusEl.innerHTML='❌ '+escHtml(msg);
      restoreDupScanUI(tab, msg);   // ★ 还原界面, 别留一个不动的进度条 + 空白内容区
      return;
    }
    DupState[tab].jobId = result.jobId;
    DupState[tab].checking = true;
    if(stopBtn){stopBtn.style.display='';stopBtn.disabled=false;}
    pollDupProgress(tab);
  } catch(e) {
    // AbortError 是超时(API.post 默认 30s)。目录太大时扫描启动请求本身可能就慢,
    // 但对用户来说结果是"没开始扫描", 不该表现成一个永远不动的空进度条。
    const msg = e.name === 'AbortError' ? '启动扫描超时(30s), 目录可能过大' : (e.message || String(e));
    showToast('启动扫描失败: '+msg,'error');
    if(statusEl) statusEl.innerHTML='❌ '+escHtml(msg);
    restoreDupScanUI(tab, msg);
  }
}

async function pollDupProgress(tab) {
  const ids = getDupIds(tab);
  const poll = async () => {
    if (!DupState[tab].checking) return;
    try {
      const data = await API.get('api/dup/status?jobId='+DupState[tab].jobId+'&start=0&limit=50');
      if (!data || data.error) { DupState[tab].checking=false; finishDupScan(tab, null); return; }
      const p = data.progress||{}, total = p.total||0, processed = p.processed||0;
      const pct = total > 0 ? Math.round((processed/total)*100) : 0;
      const bar=$(ids.progressBar), cnt=$(ids.progressCount), cur=$(ids.currentFile), txt=$(ids.progressText), statusEl=$(ids.status);
      if(bar) bar.style.width=pct+'%'; if(cnt) cnt.textContent=processed+' / '+total; if(cur) cur.textContent=p.currentFile||'';
      if(data.status==='counting'){if(txt)txt.textContent='正在遍历...（已发现 '+total+' 个）';if(statusEl)statusEl.innerHTML='<span class="dup-spinner"></span> 遍历中 ('+total+' 个)';}
      else if(data.status==='hashing'){if(txt)txt.textContent='正在计算哈希值...';if(statusEl)statusEl.innerHTML='<span class="dup-spinner"></span> 哈希 ('+processed+'/'+total+')';if(cur){var hp=p.hashProgress||'';cur.textContent=p.currentFile+(hp?' ('+hp+')':'');}}
      if(['complete','error','aborted'].includes(data.status)){DupState[tab].checking=false;finishDupScan(tab,data);}
      else setTimeout(poll, 800);
    } catch(e) { DupState[tab].checking=false; finishDupScan(tab, null); }
  };
  setTimeout(poll, 500);
}

function finishDupScan(tab, data) {
  const ids = getDupIds(tab);
  const btns = {scan:$(ids.scanBtn),stop:$(ids.stopBtn)};
  if(btns.scan){btns.scan.disabled=false;btns.scan.style.display='';}
  if(btns.stop){btns.stop.style.display='none';}
  $(ids.progress)?.classList.remove('visible');
  // 文案/计数也清掉。progress 区虽然看不见了, 但下次 startDupScan 开头会重设
  // 「正在验证路径...」, 中间这一帧会闪出上一次的旧内容(比如「正在计算哈希值
  // 812/1000」)—— 扫描失败和扫描成功都会遇到, 所以放在 finishDupScan 收尾里。
  { const pb=$(ids.progressBar); if(pb) pb.style.width='0%';
    const pt=$(ids.progressText); if(pt) pt.textContent='';
    const pc=$(ids.progressCount); if(pc) pc.textContent='';
    const cf=$(ids.currentFile); if(cf) cf.textContent=''; }
  const se=$(ids.status);
  if(!data||data.status==='error'||data.status==='aborted') {
    const msg = data?(data.error||(data.status==='aborted'?'已中止':'失败')):'扫描失败';
    if(se)se.innerHTML='❌ '+escHtml(msg); showToast(msg,'error');
    const ee=$(ids.empty); if(ee){ee.style.display='';const h3=ee.querySelector('h3');if(h3)h3.textContent='❌ 扫描失败';}
    return;
  }
  const dups = data.duplicates||[], stats = data.stats||{}, pagination = data.pagination||{};
  DupState[tab].start = 0;
  DupState[tab].pagination = pagination;
  if(dups.length===0) {
    const ee=$(ids.empty); if(ee){ee.style.display='';const h3=ee.querySelector('h3');if(h3)h3.textContent='🎉 未发现重复文件';const p=ee.querySelector('p');if(p)p.textContent='共扫描 '+(stats.totalFiles||0)+' 个文件';}
    if(se)se.innerHTML='✅ 无重复'; showToast('未发现重复文件','success'); return;
  }
  DupState[tab].duplicates = dups;
  const totalGroups = pagination.total || dups.length;
  // P2 可观测性: 展示持久化哈希缓存的命中情况(jdupes --hash-db 同等能力)。
  // 用户由此能看到"二次扫描没重新读盘", 而不必每次都靠猜。
  var _cacheStat='';
  var _cHits=stats.cacheHits||0, _cHashed=stats.hashed||0, _cPart=stats.partialSkipped||0;
  if(_cHits+_cHashed>0){
    var _rate=stats.cacheHitRate||0;
    var _cls=_rate>=80?'':'warning';
    _cacheStat='<div class="dup-stat-card '+_cls+'"><div class="dup-stat-value">'+_rate+'%</div>'
      +'<div class="dup-stat-label">缓存命中 · 新哈希 '+_cHashed+'</div></div>';
    if(_cPart>0){
      _cacheStat+='<div class="dup-stat-card"><div class="dup-stat-value">'+_cPart+'</div>'
        +'<div class="dup-stat-label">预筛已排除</div></div>';
    }
  }
  const stEl=$(ids.stats); if(stEl){stEl.style.display='';stEl.innerHTML='<div class="dup-stat-card"><div class="dup-stat-value">'+(stats.totalFiles||0)+'</div><div class="dup-stat-label">扫描文件</div></div><div class="dup-stat-card"><div class="dup-stat-value">'+totalGroups+'</div><div class="dup-stat-label">重复组</div></div><div class="dup-stat-card warning"><div class="dup-stat-value">'+(stats.duplicateFiles||0)+'</div><div class="dup-stat-label">重复文件</div></div><div class="dup-stat-card danger"><div class="dup-stat-value">'+(stats.wastedHuman||'0 B')+'</div><div class="dup-stat-label">浪费空间</div></div>'+_cacheStat;}
  if(se)se.innerHTML='✅ 完成';
  renderDupList(tab, dups);
  $(ids.results)&&($(ids.results).style.display='');
  $(ids.empty)&&($(ids.empty).style.display='none');
  $(ids.actions)?.classList.add('visible');
  $(ids.deleteBtn)&&($(ids.deleteBtn).disabled=false);
  showToast('发现 '+(pagination.total||dups.length)+' 组重复文件','info');
  // Show failed files warning
  var failed=data.failedFiles||[]; if(failed.length>0){showToast(failed.length+' 个文件哈希失败, 已跳过','warning');var fl=$(ids.currentFile);if(fl){var fhtml='<span style="color:var(--color-warning)">⚠️ '+failed.length+' 个文件哈希失败:</span><br>';for(var k=0;k<Math.min(failed.length,5);k++){fhtml+='<span style="font-size:12px;color:var(--color-text-secondary)">'+escHtml(failed[k].path)+': '+escHtml(failed[k].error)+'</span><br>';}if(failed.length>5)fhtml+='<span style="font-size:12px;color:var(--color-text-secondary)">... 还有 '+(failed.length-5)+' 个</span>';fl.innerHTML=fhtml;}}
}

function renderDupList(tab, duplicates) {
  const ids = getDupIds(tab); const container = $(ids.dupList);
  if(!container) return; container.innerHTML='';
  let selCount=0, selSize=0;
  duplicates.forEach((group, gi) => {
    const div = document.createElement('div'); div.className='dup-group';
    const hdr = document.createElement('div'); hdr.className='dup-group-header open';
    hdr.innerHTML='<div class="dup-info"><span class="dup-file-name" title="'+escHtml(group.files[0].path)+'">'+escHtml(group.files[0].name||group.files[0].path)+'</span><span class="dup-count">'+group.count+' 个</span><span class="dup-wasted">浪费 '+group.wastedHuman+'</span></div><span class="dup-toggle">▼</span>';
    const body = document.createElement('div'); body.className='dup-group-body open';
    hdr.classList.add('open');
    // Per-group delete button
    (function(t, b){
      var btn = document.createElement('button');
      btn.className = 'dup-group-delete-btn';
      btn.textContent = '\u{1F5D1}';
      btn.title = '删除本组重复文件（保留第一个原始文件）';
      btn.onclick = function(e){
        e.stopPropagation();
        document.querySelectorAll('.dup-file-cb:not(.group-select-all)').forEach(function(c){c.checked=false;});
        b.querySelectorAll('.dup-file-cb:not(.group-select-all):not(:disabled)').forEach(function(c){c.checked=true;c.dispatchEvent(new Event('change'));});
        showDupDeleteModal(t);
      };
      hdr.appendChild(btn);
    })(tab, body);
    hdr.addEventListener('click', function(e){if(e.target.closest('input')||e.target.closest('button'))return;this.classList.toggle('open');this.nextElementSibling.classList.toggle('open');this.querySelector('.dup-toggle').textContent=this.classList.contains('open')?'\u25BC':'\u25B6';});

    // Select all for this group
    const selAll = document.createElement('div'); selAll.className='select-all-row';
    const selLabel = document.createElement('label'); selLabel.className='select-all-label';
    const selAllCb = document.createElement('input'); selAllCb.type='checkbox'; selAllCb.className='group-select-all'; selAllCb.checked=true;
    selAllCb.addEventListener('change', function(){
      body.querySelectorAll('.dup-file-cb:not(.group-select-all)').forEach(cb=>{cb.checked=this.checked;cb.dispatchEvent(new Event('change'));});
    });
    selLabel.appendChild(selAllCb); selLabel.appendChild(document.createTextNode(' 全选本组（保留第一个原始文件）'));
    selAll.appendChild(selLabel); body.appendChild(selAll);

    group.files.forEach(function(file, fi) {
      const item = document.createElement('div'); item.className='dup-file-item';
      const isFirst = fi===0; const isChecked = !isFirst;
      if(isChecked){selCount++;selSize+=file.size;}
      const cb = document.createElement('input'); cb.type='checkbox'; cb.className='dup-file-cb';
      cb.dataset.path=file.path; cb.dataset.size=file.size; cb.dataset.hash=group.hash; cb.checked=isChecked;
      if(isFirst)cb.disabled=true;
      cb.addEventListener('change', function(){updateDupSelectedCount();});
      const label = document.createElement('span'); label.className='dup-file-label';
      const sizeSpan = document.createElement('span'); sizeSpan.className='dup-file-size'; sizeSpan.textContent=' ('+file.sizeHuman+')';
      label.textContent=' '+file.path; label.prepend(cb);
      const tag = document.createElement('span'); tag.className='dup-file-tag'; tag.textContent=isFirst?'原始文件':'重复文件';
      item.appendChild(label); item.appendChild(sizeSpan); item.appendChild(tag); body.appendChild(item);
    });
    div.appendChild(hdr); div.appendChild(body); container.appendChild(div);
  });

  // "加载更多" button
  var pag = DupState[tab].pagination;
  if(pag && pag.hasMore) {
    var loadMore = document.createElement('div');
    loadMore.className = 'load-more-row';
    loadMore.id = tab+'LoadMore';
    loadMore.innerHTML = '<button class="btn btn-secondary" onclick="loadMoreDupResults(\''+tab+'\')">加载更多 ('+(pag.total-pag.start-pag.limit)+' 组剩余)</button>';
    container.appendChild(loadMore);
  }

  updateDupSelectedCount();
}

function loadMoreDupResults(tab) {
  var ids = getDupIds(tab);
  var btn = document.querySelector('#'+tab+'LoadMore button');
  if(btn) { btn.disabled = true; btn.textContent = '加载中...'; }
  var nextStart = DupState[tab].start + 50;
  API.get('api/dup/status?jobId='+DupState[tab].jobId+'&start='+nextStart+'&limit=50').then(function(data){
    if(!data || !data.duplicates) return;
    DupState[tab].start = nextStart;
    DupState[tab].pagination = data.pagination || {};
    // Remove old loadMore button
    var oldBtn = document.getElementById(tab+'LoadMore');
    if(oldBtn) oldBtn.remove();
    // Render new page
    var container = $(ids.dupList);
    if(!container) return;
    data.duplicates.forEach(function(group, gi) {
      // Same rendering as renderDupList but using container.appendChild
      var div = document.createElement('div'); div.className='dup-group';
      var hdr = document.createElement('div'); hdr.className='dup-group-header open';
      hdr.innerHTML='<div class="dup-info"><span class="dup-file-name" title="'+escHtml(group.files[0].path)+'">'+escHtml(group.files[0].name||group.files[0].path)+'</span><span class="dup-count">'+group.count+' 个</span><span class="dup-wasted">浪费 '+group.wastedHuman+'</span></div><span class="dup-toggle">▼</span>';
      var body = document.createElement('div'); body.className='dup-group-body open';
      hdr.classList.add('open');
      (function(t, b){
        var btn2 = document.createElement('button');
        btn2.className = 'dup-group-delete-btn';
        btn2.textContent = '\u{1F5D1}';
        btn2.title = '删除本组重复文件（保留第一个原始文件）';
        btn2.onclick = function(e){
          e.stopPropagation();
          document.querySelectorAll('.dup-file-cb:not(.group-select-all)').forEach(function(c){c.checked=false;});
          b.querySelectorAll('.dup-file-cb:not(.group-select-all):not(:disabled)').forEach(function(c){c.checked=true;c.dispatchEvent(new Event('change'));});
          showDupDeleteModal(t);
        };
        hdr.appendChild(btn2);
      })(tab, body);
      hdr.addEventListener('click', function(e){if(e.target.closest('input')||e.target.closest('button'))return;this.classList.toggle('open');this.nextElementSibling.classList.toggle('open');this.querySelector('.dup-toggle').textContent=this.classList.contains('open')?'\u25BC':'\u25B6';});
      var selAll = document.createElement('div'); selAll.className='select-all-row';
      var selLabel = document.createElement('label'); selLabel.className='select-all-label';
      var selAllCb = document.createElement('input'); selAllCb.type='checkbox'; selAllCb.className='group-select-all'; selAllCb.checked=true;
      selAllCb.addEventListener('change', function(){
        body.querySelectorAll('.dup-file-cb:not(.group-select-all)').forEach(function(cb){cb.checked=this.checked;cb.dispatchEvent(new Event('change'));});
      });
      selLabel.appendChild(selAllCb); selLabel.appendChild(document.createTextNode(' 全选本组（保留第一个原始文件）'));
      selAll.appendChild(selLabel); body.appendChild(selAll);
      group.files.forEach(function(file, fi) {
        var item = document.createElement('div'); item.className='dup-file-item';
        var isFirst = fi===0; var isChecked = !isFirst;
        var cb = document.createElement('input'); cb.type='checkbox'; cb.className='dup-file-cb';
        cb.dataset.path=file.path; cb.dataset.size=file.size; cb.dataset.hash=group.hash; cb.checked=isChecked;
        if(isFirst)cb.disabled=true;
        cb.addEventListener('change', function(){updateDupSelectedCount();});
        var label = document.createElement('span'); label.className='dup-file-label';
        var sizeSpan = document.createElement('span'); sizeSpan.className='dup-file-size'; sizeSpan.textContent=' ('+file.sizeHuman+')';
        label.textContent=' '+file.path; label.prepend(cb);
        var tag = document.createElement('span'); tag.className='dup-file-tag'; tag.textContent=isFirst?'原始文件':'重复文件';
        item.appendChild(label); item.appendChild(sizeSpan); item.appendChild(tag); body.appendChild(item);
      });
      div.appendChild(hdr); div.appendChild(body); container.appendChild(div);
    });
    // New loadMore if still hasMore
    var pag2 = DupState[tab].pagination;
    if(pag2 && pag2.hasMore) {
      var loadMore2 = document.createElement('div');
      loadMore2.className = 'load-more-row';
      loadMore2.id = tab+'LoadMore';
      loadMore2.innerHTML = '<button class="btn btn-secondary" onclick="loadMoreDupResults(\''+tab+'\')">加载更多 ('+(pag2.total-pag2.start-pag2.limit)+' 组剩余)</button>';
      container.appendChild(loadMore2);
    }
    updateDupSelectedCount();
  }).catch(function(e){
    showToast('加载更多失败: '+e.message, 'error');
    var oldBtn2 = document.getElementById(tab+'LoadMore');
    if(oldBtn2) { oldBtn2.innerHTML = '<button class="btn btn-secondary" onclick="loadMoreDupResults(\''+tab+'\')">加载失败，重试</button>'; }
  });
}

function updateDupSelectedCount() {
  let count=0,size=0;
  document.querySelectorAll('.dup-file-cb:checked:not(.group-select-all)').forEach(cb=>{count++;size+=parseInt(cb.dataset.size)||0;});
  document.querySelectorAll('.dup-group').forEach((g,i)=>{
    const cbs=g.querySelectorAll('.dup-file-cb:checked:not(.group-select-all)');
    (cbs.length>0)?g.classList.add('has-selected'):g.classList.remove('has-selected');
  });
  // Update all tab instances
  ['music','files'].forEach(tab=>{
    const sc=$(tab+'SelectedCount'); if(sc)sc.textContent=count;
    const ss=$(tab+'SelectedSize'); if(ss)ss.textContent=formatBytes(size);
    const db=$(tab+'DeleteBtn');
    if(db)db.disabled=count===0;
  });
}

// ═══════════════════════════════
// Big Files Finder
// ═══════════════════════════════
let _bigFilesScanning = false;

async function doBigFilesScan(preserveStatus) {
  if (_bigFilesScanning) return;
  _bigFilesScanning = true;
  const status = $('bigfiles-status');
  const list = $('bigfiles-list');
  const scanBtn = $('bigfilesBtn');
  const stopBtn = $('bigfilesStopBtn');
  if (scanBtn) scanBtn.disabled = true;
  if (stopBtn) stopBtn.style.display = '';
  // Reset KPIs
  ['bigfiles-candidates', 'bigfiles-results', 'bigfiles-total-size', 'bigfiles-elapsed'].forEach(id => {
    const el = $(id); if (el) el.textContent = '…';
  });
  if (status) { status.className = 'loading'; status.textContent = '⏳ 正在扫描中，可点击「停止」提前结束'; }
  if (list) list.innerHTML = '<div class="dup-empty-state"><div class="dup-empty-icon">🐘</div><h3>扫描中…</h3><p>正在遍历所选卷目录寻找大文件，请稍候</p></div>';

  const paths = DupState.bigfiles.paths.slice();   // 多目录(2026-10-01 统一为去重风格)
  if (paths.length === 0) { _bigFilesScanning = false; showToast('请先点击「添加目录」选择至少一个目录（可添加 /vol* 表示所有卷）', 'error'); if (scanBtn) scanBtn.disabled = false; return; }
  const minSize = parseInt($('bigfiles-minsize')?.value || '0', 10) || 0;
  const topN = parseInt($('bigfiles-topn')?.value || '100', 10) || 100;
  const params = new URLSearchParams({ topN: String(topN), depth: '6' });
  // 多个根目录 -> 重复的 path 查询参数(后端用 getAll 读取)
  for (const p of paths) params.append('path', p);
  if (minSize > 0) params.set('minSize', String(minSize));

  try {
    const data = await API.get('api/bigfiles/scan?' + params.toString());
    // 后端的 4xx 分支(如 403 path must be under /vol*)只回 { error }, 没有
    // scanned_paths 等字段。原先直接渲染, 第一个用到缺失字段的地方抛
    // TypeError, 被下面的 catch 捕获后把真实错误信息掩盖成
    // "Cannot read properties of undefined", 用户完全看不到真正原因。
    if (data.__ok === false) throw new Error(data.__error || `HTTP ${data.__status}`);
    if ($('bigfiles-candidates')) $('bigfiles-candidates').textContent = data.total_candidates ?? 0;
    if ($('bigfiles-results')) $('bigfiles-results').textContent = (data.files || []).length;
    const totalSize = (data.files || []).reduce((s, f) => s + (f.size || 0), 0);
    if ($('bigfiles-total-size')) $('bigfiles-total-size').textContent = formatBytes(totalSize);
    if ($('bigfiles-elapsed')) $('bigfiles-elapsed').textContent = `${(data.elapsed_ms / 1000).toFixed(1)}s`;

    if (status) {
      status.className = data.truncated ? 'success' : 'success';
      const rootLabel = data.root === '/vol*' ? '所有卷' : data.root;
      const partialLabel = data.truncated ? `（仅显示前 ${data.top_n} 个）` : '';
      const stoppedNote = data.files && data.files.length === 0 && data.scanned_paths > 0 ? ' [已停止]' : '';
      // 扫描阶段已整棵跳过 fnOS 系统目录与回收站。不说清楚的话, 用户会以为自己
      // 的盘被那些文件占满(实际占用大头常是 @sysappmeta 的应用模型), 白折腾一圈。
      const skipNote = data.skipped_protected_dirs
        ? ` · 已跳过 ${data.skipped_protected_dirs} 个系统目录/回收站（应用安装文件与运行数据，不占用可清理空间）`
        : '';
      // 只读卷: 卷以 ro 挂载时下面这些文件一个都删不掉。与其让用户勾完 57 个再
      // 全部 EROFS 失败(显示出来就是"全部失败"), 不如在扫描结果时就讲清楚。
      const roNote = (data.read_only_roots || []).length
        ? ' · ⚠ ' + data.read_only_roots.map(a => `${a.root} 为只读卷(${a.reason})，其下文件无法删除`)
        : '';
      status.textContent = `🐘 在 ${rootLabel} 中找到 ${data.total_candidates} 个 ≥${formatBytes(data.min_size)} 的文件${partialLabel}${skipNote}${stoppedNote}，扫描了 ${(data.scanned_paths || 0).toLocaleString()} 个路径` + roNote;
    }
    renderBigFilesList(data.files || []);
    // preserveStatus: 删除后自动重扫时不要覆盖状态栏。
    // 否则"✅ 删除完成: 3/3"会被紧跟着的"找到 0 个 ≥100 MB 的文件"立刻冲掉,
    // 用户只看到扫描结果, 误以为删除失败。KPI 仍照常刷新。
    if (preserveStatus && status && status.dataset.lastOp) status.textContent = status.dataset.lastOp;
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ ' + e.message; }
    if (list) list.innerHTML = '<div class="dup-empty-state"><div class="dup-empty-icon">⚠️</div><h3>扫描失败</h3><p>' + escHtml(e.message) + '</p></div>';
  } finally {
    _bigFilesScanning = false;
    if (scanBtn) scanBtn.disabled = false;
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

// ════════════════════════════════
// Disk Space Analysis (P0-1)
// ════════════════════════════════
let _dsScanning = false;
let _dsCurrentTreePath = '/vol*';

// P0 XSS 修复: 目录/卷名来自磁盘, 不可控。原先写进 onclick="dsDrillDown('...')",
// 而 escHtml 把 ' 转成 &#39; 后浏览器会先做 HTML 实体解码再把整串当 JS 编译,
// 形如 x');alert(1)// 的路径仍能闭合字符串执行任意 JS。改为 data-* + 事件绑定。
function bindDsDrillBtns(root) {
  root.querySelectorAll('[data-ds-path]').forEach(el => {
    el.onclick = () => dsDrillDown(el.dataset.dsPath);
  });
}

async function dsLoadVolumes() {
  const listEl = $('ds-volumes-list');
  if (!listEl) return;
  try {
    listEl.innerHTML = '<div class="loading">⏳ 加载卷用量…</div>';
    const data = await API.get('api/diskanalysis/volumes');
    if ($('ds-total-used')) $('ds-total-used').textContent = data.total_str || '0 B';
    if ($('ds-total-cap')) $('ds-total-cap').textContent = data.capacity ? formatBytes(data.capacity) : '-';
    let maxVol = null;
    (data.volumes || []).forEach(v => {
      if (!maxVol || v.used > maxVol.used) maxVol = v;
    });
    if ($('ds-max-vol')) $('ds-max-vol').textContent = maxVol ? `${maxVol.path} ${maxVol.used_str}` : '-';

    const vols = data.volumes || [];
    if (!vols.length) {
      listEl.innerHTML = '<div style="color:var(--color-text-muted);padding:10px">未检测到 /vol* 卷</div>';
      return;
    }
    let html = '';
    vols.forEach(v => {
      const pct = v.total > 0 ? Math.round((v.used / v.total) * 100) : 0;
      const barColor = pct >= 90 ? 'var(--color-danger)' : pct >= 70 ? 'var(--color-warning)' : 'var(--color-primary)';
      html += `<div style="padding:8px 0;border-bottom:1px solid var(--color-border)">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span style="font-weight:600">${escHtml(v.path)}</span>
          <span style="font-family:var(--font-mono);color:var(--color-text-secondary)">${escHtml(v.used_str)} / ${escHtml(v.total_str)} (${pct}%)</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:8px;background:var(--color-border);border-radius:4px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px"></div>
          </div>
          <button class="btn btn-ghost" style="padding:2px 8px;font-size:12px" data-ds-path="${escHtml(v.path)}" title="分析此卷">分析</button>
        </div>
      </div>`;
    });
    listEl.innerHTML = html;
    bindDsDrillBtns(listEl);
  } catch (e) {
    listEl.innerHTML = '<div style="color:var(--color-danger);padding:10px">❌ 加载失败: ' + escHtml(e.message) + '</div>';
  }
}

async function dsDrillDown(path) {
  if (_dsScanning) return;
  _dsScanning = true;
  const status = $('ds-status');
  const scanBtn = $('dsScanBtn');
  const stopBtn = $('dsStopBtn');
  if (scanBtn) scanBtn.disabled = true;
  if (stopBtn) stopBtn.style.display = '';
  if (status) { status.className = 'loading'; status.style.display = ''; status.textContent = '⏳ 正在分析 ' + path + ' …'; }
  if (path === '/vol*') {
    // scan all volumes together
  }
  _dsCurrentTreePath = path;
  if ($('ds-current-path')) $('ds-current-path').textContent = path;

  try {
    const data = await API.post('api/diskanalysis/tree', { path: path === '/vol*' ? '/' : path, maxDepth: 3 });
    if (status) {
      status.className = 'success';
      const stopped = data.scanned > 0 && data.total === 0 ? ' [已停止/权限受限]' : '';
      status.textContent = `✅ 扫描了 ${(data.scanned || 0).toLocaleString()} 个条目，${(data.total_files || 0).toLocaleString()} 个文件，共 ${data.total_str}${stopped}`;
    }
    dsRenderDirs(data.dirs || [], path === '/vol*');
    dsRenderTypes(data.types || []);
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ ' + e.message; }
    const dirsEl = $('ds-dirs'); if (dirsEl) dirsEl.innerHTML = '';
    const typesEl = $('ds-types'); if (typesEl) typesEl.innerHTML = '';
  } finally {
    _dsScanning = false;
    if (scanBtn) scanBtn.disabled = false;
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

async function dsStop() {
  _dsScanning = false;
  try { await API.post('api/diskanalysis/stop', {}); showToast('已请求停止', 'info'); } catch (e) { /* ignore */ }
}

function dsRenderDirs(dirs, isAll) {
  const container = $('ds-dirs');
  if (!container) return;
  if (!dirs.length) {
    container.innerHTML = '';
    return;
  }
  const maxSize = dirs[0].size || 1;
  const TYPE_LABEL = { video: '视频', audio: '音频', image: '图片', archive: '压缩', docs: '文档', installer: '安装包', code: '代码', other: '其他' };
  let html = `<div class="card" style="margin-top:10px">
    <div class="section-header"><h3 style="font-size:1rem;margin:0"><span>📁 占用最大的目录${isAll ? '（全部卷）' : ''}</span></h3></div>
    <div class="list-scroll"><table class="data-table">
      <thead><tr><th style="width:46px">#</th><th>目录</th><th style="width:130px">占用</th><th style="width:140px">占比</th><th style="width:54px"></th></tr></thead><tbody>`;
  dirs.forEach((d, i) => {
    const pct = Math.round((d.size / maxSize) * 100);
    const depthFull = d.path;
    html += `<tr>
      <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary)">${i + 1}</td>
      <td title="${escHtml(d.path)}" style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:12px">${escHtml(d.name)}&nbsp;<span style="color:var(--color-text-muted);font-size:11px">${escHtml(d.path.slice(0, Math.max(0, d.path.lastIndexOf('/'))))}</span></td>
      <td style="font-family:var(--font-mono);font-weight:600;color:var(--color-primary)">${escHtml(d.size_str)}</td>
      <td><div style="flex:1;height:6px;background:var(--color-border);border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:var(--color-primary)"></div></div></td>
      <td><button class="btn btn-ghost" style="padding:2px 8px;font-size:12px" data-ds-path="${escHtml(d.path)}">下钻</button></td>
    </tr>`;
  });
  html += '</tbody></table></div></div>';
  container.innerHTML = html;
  bindDsDrillBtns(container);
}

function dsRenderTypes(types) {
  const container = $('ds-types');
  if (!container) return;
  if (!types || !types.length) { container.innerHTML = ''; return; }
  const TYPE_LABEL = { video: '视频', audio: '音频', image: '图片', archive: '压缩', docs: '文档', installer: '安装包', code: '代码', other: '其他' };
  const COLORS = { video:'#e74c3c', audio:'#9b59b6', image:'#2ecc71', archive:'#f39c12', docs:'#3498db', installer:'#e67e22', code:'#1abc9c', other:'#95a5a6' };
  const totalBytes = types.reduce((s, t) => s + t.bytes, 0) || 1;
  const sorted = [...types].sort((a, b) => b.bytes - a.bytes);
  let seg = '';
  sorted.forEach(t => { if (t.bytes > 0) seg += `<div style="width:${Math.max(0.5, (t.bytes / totalBytes) * 100)}%;height:100%;background:${COLORS[t.type] || '#888'}" title="${TYPE_LABEL[t.type]} ${t.bytes_str}"></div>`; });

  let html = `<div class="card" style="margin-top:10px">
    <div class="section-header"><h3 style="font-size:1rem;margin:0"><span>🗂 文件类型分布</span></h3></div>
    <div style="display:flex;height:22px;border-radius:4px;overflow:hidden;margin:8px 0">${seg}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;font-size:12px">`;
  sorted.forEach(t => {
    if (t.bytes <= 0) return;
    const pct = Math.round((t.bytes / totalBytes) * 100);
    html += `<div style="display:flex;align-items:center;gap:6px">
      <span style="width:10px;height:10px;border-radius:2px;background:${COLORS[t.type] || '#888'}"></span>
      <span>${TYPE_LABEL[t.type] || t.type}</span>
      <span style="font-family:var(--font-mono);color:var(--color-text-secondary)">${escHtml(t.bytes_str)}</span>
      <span style="color:var(--color-text-muted)">${pct}%</span>
    </div>`;
  });
  html += '</div></div>';
  container.innerHTML = html;
}

// ════════════════════════════════
// Similar Image/Video Detection (P0-2)
// ════════════════════════════════
let _simScanning = false;
let _simJob = null;

async function simDupScan() {
  if (_simScanning) return;
  const paths = DupState.simdup.paths.slice();   // 多目录(2026-10-01 统一为去重风格)
  if (paths.length === 0) { showToast('请先点击「添加目录」选择至少一个目录', 'error'); return; }
  const type = $('simdup-type')?.value || 'image';
  const threshold = parseInt($('simdup-threshold')?.value || '10', 10) || 10;

  _simScanning = true;
  const btn = $('simdupBtn'); const stopBtn = $('simdupStopBtn'); const status = $('simdup-status'); const list = $('simdup-list');
  if (btn) btn.disabled = true;
  if (stopBtn) stopBtn.style.display = '';
  if (status) { status.className = 'loading'; status.textContent = '⏳ 正在扫描 ' + paths.length + ' 个目录 …'; }
  if (list) list.innerHTML = '';

  try {
    const r = await API.post('api/simdup/scan', { type, paths, threshold });
    if (!r.success) throw new Error(r.error || 'scan failed');
    _simJob = r.jobId;
    // poll
    const t0 = Date.now();
    while (_simScanning) {
      await new Promise(res => setTimeout(res, 800));
      const s = await API.get('api/simdup/status?job=' + encodeURIComponent(_simJob));
      const el = $('simdup-elapsed'); if (el) el.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      simDupRenderProgress(s);
      if (s.status === 'done') {
        simDupRenderResult(s);
        if (status) { status.className = 'success'; status.textContent = `✅ 扫描完成：${s.stats.totalFiles} 个${type==='video'?'视频':'图片'}，发现 ${s.stats.groups} 个相似组（${s.stats.files} 个重复文件）`; }
        break;
      }
      if (s.status === 'aborted') {
        if (status) { status.className = 'error'; status.textContent = '⏹ 已停止'; }
        break;
      }
      if (s.status === 'error') { throw new Error(s.error || 'scan error'); }
    }
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ ' + e.message; }
    if (list) list.innerHTML = '<div class="dup-empty-state"><div class="dup-empty-icon">⚠️</div><h3>扫描失败</h3><p>' + escHtml(e.message) + '</p></div>';
  } finally {
    _simScanning = false;
    if (btn) btn.disabled = false;
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

function simDupRenderProgress(s) {
  const total = s.progress?.total || 0;
  const proc = s.progress?.processed || 0;
  if (total > 0 && s.status !== 'done') {
    const pct = Math.round((proc / total) * 100);
    const statusEl = $('simdup-status');
    if (statusEl) { statusEl.className = 'loading'; statusEl.textContent = `⏳ ${s.status==='paused'?'已暂停':''} 哈希计算 ${proc}/${total} (${pct}%)${s.progress?.currentFile?(' · ' + s.progress.currentFile.split('/').pop()):''}`; }
  }
}

// P1-2: dHash 是 64 位感知哈希, 汉明距离越小越像(0=完全一致)。
// 换算成百分比便于直观判断: 相似度 = (1 - 距离/64)。
const SIMDASH_BITS = 64;
function simSimilarityPct(dist){
  if (dist == null || dist < 0) return null;
  return Math.max(0, Math.round((1 - dist / SIMDASH_BITS) * 100));
}
// ═══════════════════════════════════════════════════════════════════
// 相似文件: 每组推荐保留一个
//
// 相似 ≠ 重复: dHash 距离小只是视觉接近, 内容仍可能有差异(不同水印、
// 压缩质量、局部裁剪)。所以不能像去重那样靠哈希判定"这份是多余的",
// 只能给出**建议**, 最终删不删由用户决定。推荐只决定默认勾选谁被保留。
//
// 推荐依据(按优先级, 每一条都可解释):
//   1. 文件名干净  —— 带 (1) / -副本 / _copy / -副本(2) 这类特征的, 基本可断定
//      是复制出来的副本, 原件优先。文件名完全相同时这一条区分不出, 往下看。
//   2. 修改时间新  —— 同样干净时, 新的那份通常是用户后来整理/导出的结果。
//   3. 体积更大    —— 同类文件中更大的往往是更高画质/更高分辨率的那份。
//   4. 路径更短    —— 深拷贝目录(backup/备份/xxx - 副本)里的让位给浅层的。
// 全部相同则按路径字典序, 保证同一份数据每次推荐结果一致(否则用户会
// 看到"推荐的文件每次扫描都不一样", 反而不敢信)。
// ═══════════════════════════════════════════════════════════════════
// 全部锚定在 stem 末尾。分隔符统一成 [\s_\-] 的字符类 —— 写成 /[-_]copy$/
// 会漏掉 "photo copy"(空格分隔) 这种最常见的形态。
const SIMDUP_COPY_SUFFIX = [
  /\(\d+\)$/,                      // photo(1)
  /（\d+）$/,                        // photo（1）全角
  /[\s_\-]copy$/i,                  // photo - copy / photo_copy / photo copy
  /[\s_\-]cop(?:y|ies)\s*\d*$/i,   // photo copy2
  /[\s_\-]副本$/,                    // photo - 副本
  /[\s_\-]副本\(\d+\)$/,          // photo - 副本(2)
  /[\s_\-]backups?$/i,              // photo backup
  /[\s_\-]bak$/i,
];
// 整名就等于这些词的, 是文件本来就这么叫, 不算副本标记。
// 注意别写 /copy\.\w+$/ 这种 —— 它会把 "photo - copy.jpg" 一起豁免掉。
const SIMDUP_COPY_ALLOW = [
  /^copy$/i, /copywriting/i, /copyright/i,
];

/**
 * 文件名是否带"这是副本"的味道。
 * 关键: 只看**扩展名之前**的部分(stem)。直接对全名匹配 /(1)$/ 会失配 ——
 * "photo(1).jpg" 的结尾是 ".jpg" 不是 "(1)", 而 "report(1).pdf" 这类才碰巧
 * 在 . 前。加 strip 之后 photo(1).jpg / video(2).mp4 都能识别。
 */
function simDupLooksLikeCopy(name) {
  const n = String(name || '');
  if (!n) return false;
  if (SIMDUP_COPY_ALLOW.some(re => re.test(n))) return false;
  const dot = n.lastIndexOf('.');
  const stem = dot > 0 ? n.slice(0, dot) : n;
  return SIMDUP_COPY_SUFFIX.some(re => re.test(stem));
}

/** 人话解释为什么推荐这份(展示在 tooltip 里, 让用户能推翻推荐) */
function simDupKeepReason(f, all) {
  const reasons = [];
  if (!simDupLooksLikeCopy(f.name)) {
    const copies = all.filter(x => simDupLooksLikeCopy(x.name)).length;
    if (copies) reasons.push('文件名无副本标记(其余 ' + copies + ' 份带 (1)/副本 等后缀)');
  }
  const withMtime = all.filter(x => x.mtime != null);
  if (withMtime.length > 1 && f.mtime != null) {
    const newest = withMtime.reduce((a, b) => (a.mtime >= b.mtime ? a : b));
    if (newest.path === f.path) reasons.push('组内修改时间最新');
  }
  const maxSize = Math.max(...all.map(x => x.size || 0));
  if (f.size === maxSize && all.filter(x => x.size === maxSize).length === 1) reasons.push('组内体积最大(通常画质最高)');
  if (!reasons.length) {
    const shortest = all.reduce((a, b) => (a.path.split('/').length <= b.path.split('/').length ? a : b));
    reasons.push(shortest.path === f.path ? '路径层级最浅' : '组内综合排序第一');
  }
  return reasons.join(' · ');
}

/**
 * 在组内挑一个推荐保留的, 返回 { index, file, reason }。
 * 排序键必须全序且稳定(最后用 path 兜底), 否则同一份数据两次扫描推荐会跳。
 */
function simDupPickKeeper(files) {
  if (!files || !files.length) return null;
  if (files.length === 1) return { index: 0, file: files[0], reason: '组内只有一个文件' };
  const sorted = files.map((f, i) => ({
    f, i,
    copy: simDupLooksLikeCopy(f.name) ? 1 : 0,              // 越小越优先
    mtime: f.mtime == null ? -1 : f.mtime,                  // 越大越优先(取反)
    size: f.size || 0,                                       // 越大越优先(取反)
    depth: (f.path || '').split('/').length,                 // 越小越优先
    path: f.path || '',                                      // 字典序兜底
  }));
  sorted.sort((a, b) =>
    (a.copy - b.copy)
    || (b.mtime - a.mtime)
    || (b.size - a.size)
    || (a.depth - b.depth)
    || (a.path.localeCompare(b.path))
  );
  const win = sorted[0];
  return { index: win.i, file: win.f, reason: simDupKeepReason(win.f, files) };
}

/** 组内文件按"推荐保留的排第一"重排, 用于展示 */
function simDupOrderGroup(files) {
  const pick = simDupPickKeeper(files);
  if (!pick) return [];
  const rest = files.filter((_, i) => i !== pick.index);
  return [files[pick.index], ...rest];
}

function simSimilarityCell(dist){
  const pct = simSimilarityPct(dist);
  if (pct == null) return '<td style="color:var(--color-text-secondary);font-size:12px">—</td>';
  // >=95% 基本一致(绿), 80~95% 很相似(主色), <80% 勉强匹配(橙)
  const col = pct >= 95 ? 'var(--color-success,#22c55e)' : (pct >= 80 ? 'var(--color-primary)' : 'var(--color-warning,#f59e0b)');
  return '<td style="font-family:var(--font-mono);color:'+col+';font-size:12px" title="dHash 汉明距离 '+dist+' / 64">'+pct+'%</td>';
}

// P1-4: 并排对比。缩略图由 /api/simdup/thumb 按需生成(ffmpeg 抽帧 + 磁盘缓存),
// 这里只负责组装 DOM。原生 <dialog> 而非自定义 modal —— fnOS WebView/CEF 下
// 自定义 overlay 常出现 getComputedStyle 显示正常但视觉层不渲染的问题。
let _simCmpGroups = null;
function simDupThumbUrl(p){ return 'api/simdup/thumb?path=' + encodeURIComponent(p); }

function simDupCompareGroup(groupNo){
  if(!_simCmpGroups) return;
  const g = _simCmpGroups.find(x => x.group === groupNo);
  const dlg = $('simdupCompareDlg'), body = $('simdupCmpBody'), title = $('simdupCmpTitle');
  if(!g || !dlg || !body) return;
  const pct = simSimilarityPct(g.minDist);
  title.textContent = '第 ' + g.group + ' 组 · ' + g.files.length + ' 个文件'
    + (pct==null ? '' : ' · 最相似 ' + pct + '% (dHash 距离 ' + g.minDist + '/64)');
  body.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px">'
    + g.files.map(f => {
        const p = simSimilarityPct(f.minDist);
        const col = p==null ? 'var(--color-text-secondary)'
          : (p>=95 ? 'var(--color-success,#22c55e)' : (p>=80 ? 'var(--color-primary)' : 'var(--color-warning,#f59e0b)'));
        return '<figure style="margin:0;display:flex;flex-direction:column;gap:6px">'
          + '<a href="'+escHtml(f.path)+'" target="_blank" rel="noopener" '
          + 'style="display:block;aspect-ratio:4/3;background:var(--color-bg);border-radius:8px;overflow:hidden;border:1px solid var(--color-border)">'
          + '<img src="'+escHtml(simDupThumbUrl(f.path))+'" alt="'+escHtml(f.name)+'" loading="lazy" '
          + 'style="width:100%;height:100%;object-fit:contain;display:block"></a>'
          + '<figcaption style="font-size:12px;line-height:1.5;word-break:break-all">'
          + '<div title="'+escHtml(f.path)+'" style="font-weight:600">'+escHtml(f.name)+'</div>'
          + '<div style="color:var(--color-text-secondary)">'+escHtml(f.size_str)+'</div>'
          + (f.minDist==null ? '' :
             '<div style="color:'+col+';font-family:var(--font-mono)">相似 '+p+'% · 距离 '+f.minDist+'</div>')
          + '</figcaption></figure>';
      }).join('')
    + '</div>';
  if(typeof dlg.showModal === 'function'){ try{ dlg.showModal(); }catch(e){ dlg.setAttribute('open',''); } }
  else dlg.setAttribute('open','');
}

function simDupCompareClose(){
  const dlg = $('simdupCompareDlg');
  if(!dlg) return;
  if(typeof dlg.close === 'function'){ try{ dlg.close(); }catch(e){} }
  dlg.removeAttribute('open');
}

function simDupRenderResult(s) {
  const list = $('simdup-list'); if (!list) return;
  _simCmpGroups = s.groups || [];   // P1-4: 供对比弹窗取用
  if ($('simdup-total')) $('simdup-total').textContent = s.stats?.totalFiles ?? 0;
  if ($('simdup-groups')) $('simdup-groups').textContent = s.stats?.groups ?? 0;
  if ($('simdup-files')) $('simdup-files').textContent = s.stats?.files ?? 0;
  // P1-2: 概览里点明"最像的一对有多像"
  const _bp = simSimilarityPct(s.stats?.bestDist);
  const _best = $('simdup-best');
  if (_best) {
    if (_bp == null) { _best.textContent = ''; }
    else _best.innerHTML = '最相似的一对 <b style="color:var(--color-primary)">'+_bp+'%</b>'
      + '<span style="font-size:11px;color:var(--color-text-secondary)"> (dHash 距离 '+s.stats.bestDist+'/'+SIMDASH_BITS+')</span>';
  }
  if (!s.groups || !s.groups.length) {
    // 这里会提前 return, 末尾那次 filesUpdateSelectInfo 执行不到。
    list.innerHTML = '<div class="dup-empty-state"><div class="dup-empty-icon">🎉</div><h3>未发现相似文件</h3><p>当前阈值下没有匹配项，可换「宽松」策略重试</p></div>';
    // 顺序要紧: 必须先清空 DOM 再刷新。filesCollect 查的是
    // .fd-cb[data-mod="simdup"]:checked —— 若在 innerHTML 赋值之前调用,
    // 读到的还是上一轮扫描的旧 checkbox, 按钮会一直停留在旧数量。
    filesUpdateSelectInfo('simdup');
    return;
  }

  // ═══ 按组分块渲染 ═══
  //
  // 原来所有文件铺成一张大表, 靠"组"列的数字区分 —— 组内文件在视觉上完全散开,
  // 也没有"这一组该留哪个"的提示。用户要的是"每组推荐保留一个", 所以改成:
  //   组头   组号 · 份数 · 组相似度 · 组总占用 · [并排对比]
  //   组内行 推荐保留的那份标 ★ 推荐(带推荐理由), 其余标 ✕ 删除
  // 组头的 checkbox = 删掉本组除推荐外的全部; 组内不逐文件给框,
  // 因为"相似"的判断权在推荐算法, 逐文件勾选会让用户误以为可以随便挑。
  let html = '';
  s.groups.forEach((g, gi) => {
    const ordered = simDupOrderGroup(g.files || []);
    if (!ordered.length) return;
    const pick = simDupPickKeeper(g.files || []);
    const keepIdx = pick ? pick.index : 0;
    const delFiles = ordered.filter((_, i) => (g.files || []).indexOf(ordered[i]) !== keepIdx);
    // 组的可释放空间 = 组内总量 - 推荐保留那份
    const keepSize = pick ? (pick.file.size || 0) : 0;
    const groupSize = (g.files || []).reduce((a, f) => a + (f.size || 0), 0);
    const delSize = groupSize - keepSize;
    const pct = simSimilarityPct(g.minDist);
    const cmp = pct == null ? '—'
      : '<span style="color:' + (pct >= 95 ? 'var(--color-success)' : pct >= 80 ? 'var(--color-primary)' : 'var(--color-warning)') + '">' + pct + '%</span>';

    html += '<div class="simdup-group">'
      // ── 组头 ──
      + '<div class="simdup-group-head">'
        + '<input type="checkbox" class="fd-cb" data-mod="simdup" data-group="' + g.group + '"'
          + ' data-paths="' + escHtml(JSON.stringify(delFiles.map(f => f.path))) + '"'
          + ' data-size="' + delSize + '"'
          + ' data-keep="' + escHtml(ordered[0].path) + '"'
          + ' title="' + escHtml(delFiles.length ? '选中后删除本组其余 ' + delFiles.length + ' 个文件, 保留推荐的那份' : '本组只有一份, 无可删除项') + '"'
          + ' onchange="filesUpdateSelectInfo(\'simdup\')" ' + (delFiles.length ? '' : 'disabled') + '>'
        + '<span class="simdup-group-no">组 ' + g.group + '</span>'
        + '<span class="simdup-group-meta">'
          + '<b>' + (g.files || []).length + '</b> 个'
          + ' · 最相似 ' + cmp
          + ' · 组占用 ' + formatBytes(groupSize)
          + (delSize > 0 ? ' · <span style="color:var(--color-success)">可释放 ' + formatBytes(delSize) + '</span>' : '')
        + '</span>'
        + '<button type="button" class="simdup-cmp-btn" data-grp="' + g.group + '" title="并排对比该组">🖼 对比</button>'
      + '</div>'
      // ── 组内文件行 ──
      + '<div class="simdup-group-body">';
    ordered.forEach(f => {
      const isKeep = f === ordered[0];
      const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
      html += '<div class="simdup-file' + (isKeep ? ' is-keep' : '') + '" title="' + escHtml(f.path) + '">'
        + '<span class="simdup-flag ' + (isKeep ? 'keep' : 'del') + '">'
          + (isKeep ? '★ 推荐保留' : '✕ 删除') + '</span>'
        + '<span class="simdup-thumb"><img src="' + escHtml(simDupThumbUrl(f.path)) + '" alt="' + escHtml(f.name) + '" loading="lazy"></span>'
        + '<span class="simdup-name">' + escHtml(f.name)
          + (isKeep && pick ? '<em class="simdup-why">' + escHtml(pick.reason) + '</em>' : '')
        + '</span>'
        + '<span class="simdup-size">' + escHtml(f.size_str) + '</span>'
        + '<span class="simdup-dist">' + (simSimilarityPct(f.minDist) == null ? '—' : simSimilarityPct(f.minDist) + '%') + '</span>'
        + '<span class="simdup-dir" title="' + escHtml(dir) + '">' + escHtml(dir) + '</span>'
      + '</div>';
    });
    html += '</div></div>';
  });

  list.innerHTML = html;
  // P1-4: 事件委托绑定(inline onclick 在 CEF/WebView 下常静默失效)
  list.querySelectorAll('.simdup-cmp-btn').forEach(function(btn){
    btn.addEventListener('click', function(){ simDupCompareGroup(parseInt(btn.dataset.grp, 10)); });
  });
  filesUpdateSelectInfo('simdup');
}

// 对比弹窗的关闭绑定(关闭按钮 / 点遮罩 / ESC)
(function(){
  function bind(){
    const c = document.getElementById('simdupCmpClose');
    if(c && !c._simdupBound){ c._simdupBound = true; c.addEventListener('click', simDupCompareClose); }
    const d = document.getElementById('simdupCompareDlg');
    if(d && !d._simdupBound){
      d._simdupBound = true;
      d.addEventListener('click', function(e){ if(e.target === d) simDupCompareClose(); });
      d.addEventListener('cancel', function(e){ e.preventDefault(); simDupCompareClose(); });
    }
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();

async function simDupStop() {
  if (!_simJob) return;
  _simScanning = false;
  try { await API.post('api/simdup/stop?job=' + encodeURIComponent(_simJob), {}); showToast('已请求停止', 'info'); } catch (e) { showToast('停止失败: ' + e.message, 'error'); }
}

// ════════════════════════════════
// Abnormal File Detection (P0-3)
// ════════════════════════════════
let _brokScanning = false;
let _brokJob = null;
let _brokCat = 'empty';
let _brokState = null;

async function brokScan() {
  if (_brokScanning) return;
  const paths = DupState.broken.paths.slice();   // 多目录(2026-10-01 统一为去重风格)
  if (paths.length === 0) { showToast('请先点击「添加目录」选择至少一个目录', 'error'); return; }
  const checkBroken = ($('broken-checkmedia')?.checked) === true;

  _brokScanning = true;
  const btn = $('brokenBtn'); const stopBtn = $('brokenStopBtn'); const status = $('broken-status'); const list = $('broken-list');
  if (btn) btn.disabled = true;
  if (stopBtn) stopBtn.style.display = '';
  if (status) { status.className = 'loading'; status.textContent = '⏳ 正在扫描 ' + paths.length + ' 个目录 …'; }
  if (list) list.innerHTML = '';
  $('broken-total')&&($('broken-total').textContent='-'); $('broken-empty')&&($('broken-empty').textContent='-');
  $('broken-links')&&($('broken-links').textContent='-'); $('broken-files')&&($('broken-files').textContent='-');
  $('broken-dl')&&($('broken-dl').textContent='-');

  try {
    const r = await API.post('api/broken/scan', { paths, checkBroken });
    if (!r.success) throw new Error(r.error || 'scan failed');
    _brokJob = r.jobId;
    while (_brokScanning) {
      await new Promise(res => setTimeout(res, 800));
      const s = await API.get('api/broken/status?job=' + encodeURIComponent(_brokJob));
      _brokState = s;
      if (s.status === 'done') {
        if (status) { status.className = 'success'; status.textContent = `✅ 扫描 ${s.stats.scanned} 项：${s.stats.empty} 空文件 / ${s.stats.invalid_links} 无效链接 / ${s.stats.broken} 损坏文件 / ${s.stats.download_residue ?? 0} 下载残留`; }
        $('broken-total')&&($('broken-total').textContent = s.stats.empty + s.stats.invalid_links + s.stats.broken + (s.stats.download_residue ?? 0));
        $('broken-empty')&&($('broken-empty').textContent = s.stats.empty);
        $('broken-links')&&($('broken-links').textContent = s.stats.invalid_links);
        $('broken-files')&&($('broken-files').textContent = s.stats.broken);
        $('broken-dl')&&($('broken-dl').textContent = s.stats.download_residue ?? 0);
        brokRender(s);
        break;
      }
      if (s.status === 'aborted') { if (status) { status.className = 'error'; status.textContent = '⏹ 已停止'; } break; }
      if (s.status === 'error') { throw new Error(s.error || 'scan error'); }
      if (s.status === 'scanning') {
        if (status) { status.className = 'loading'; status.textContent = `⏳ 扫描中… 已处理 ${s.progress?.processed || 0}`; }
      }
    }
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ ' + e.message; }
    if (list) list.innerHTML = '<div class="dup-empty-state"><div class="dup-empty-icon">⚠️</div><h3>扫描失败</h3><p>' + escHtml(e.message) + '</p></div>';
  } finally {
    _brokScanning = false;
    if (btn) btn.disabled = false;
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

function brokSwitchCat(cat) {
  _brokCat = cat;
  document.querySelectorAll('.dup-inner-tab-btn[data-brokTab]').forEach(b=>b.classList.toggle('active', b.dataset.brokTab===cat));
  brokRender(_brokState);
}

function brokRender(s) {
  const list = $('broken-list'); if (!list || !s) return;
  let items = [], label = '';
  if (_brokCat === 'empty') { items = s.empty||[]; label = '空文件'; }
  else if (_brokCat === 'links') { items = s.invalid_links||[]; label = '无效链接'; }
  else if (_brokCat === 'dl') { items = s.download_residue||[]; label = '下载残留'; }
  else { items = s.broken||[]; label = '损坏文件'; }
  if (!items.length) {
    list.innerHTML = `<div class="dup-empty-state"><div class="dup-empty-icon">🎉</div><h3>未发现${label}</h3><p>当前目录没有匹配项</p></div>`;
    // 顺序要紧: 必须先清空 DOM 再刷新。filesCollect 查的是
    // .fd-cb[data-mod="broken"]:checked —— 若在 innerHTML 赋值之前调用,
    // 读到的还是上一轮扫描的旧 checkbox, 按钮会一直停留在旧数量。

      filesUpdateSelectInfo('broken');
    return;
  }
  let html = '<div class="list-scroll"><table class="data-table"><thead><tr><th style="width:34px"><input type="checkbox" class="fd-cb-all" data-mod="broken" onchange="filesSelectAll(this)"></th><th style="width:46px">#</th><th>文件名</th><th style="width:14%">信息</th><th style="width:40%">位置</th></tr></thead><tbody>';
  items.forEach((it, i) => {
    const dir = it.path.slice(0, it.path.lastIndexOf('/')) || '/';
    const info = _brokCat === 'links' ? (it.target || '') : (it.size_str || (it.error || ''));
    html += `<tr>
      <td><input type="checkbox" class="fd-cb" data-mod="broken" data-path="${escHtml(it.path)}" onchange="filesUpdateSelectInfo('broken')"></td>
      <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary)">${i+1}</td>
      <td><span title="${escHtml(it.path)}">${escHtml(it.name)}</span></td>
      <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary);max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(info)}">${escHtml(info)}</td>
      <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(dir)}">${escHtml(dir)}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  list.innerHTML = html;
  filesUpdateSelectInfo('broken');
}

async function brokStop() {
  if (!_brokJob) return;
  _brokScanning = false;
  try { await API.post('api/broken/stop?job=' + encodeURIComponent(_brokJob), {}); showToast('已请求停止', 'info'); } catch (e) { showToast('停止失败: ' + e.message, 'error'); }
}

// ════════════════════════════════
// Same-name Conflict Detection (P2-2)
// ════════════════════════════════
let _nmScanning = false;
let _nmJob = null;

async function nmScan() {
  if (_nmScanning) return;
  const paths = DupState.name.paths.slice();     // 多目录(2026-10-01 统一为去重风格)
  if (paths.length === 0) { showToast('请先点击「添加目录」选择至少一个目录', 'error'); return; }

  _nmScanning = true;
  const btn = $('nmBtn'); const stopBtn = $('nmStopBtn'); const status = $('nm-status'); const list = $('nm-list');
  if (btn) btn.disabled = true;
  if (stopBtn) stopBtn.style.display = '';
  if (status) status.textContent = '⏳ 正在扫描 ' + paths.length + ' 个目录 …';
  if (list) list.innerHTML = '';
  $('name-groups')&&($('name-groups').textContent='-'); $('name-files')&&($('name-files').textContent='-');

  try {
    const r = await API.post('api/namematch/scan', { paths });
    if (!r.success) throw new Error(r.error || 'scan failed');
    _nmJob = r.jobId;
    while (_nmScanning) {
      await new Promise(res => setTimeout(res, 800));
      const s = await API.get('api/namematch/status?job=' + encodeURIComponent(_nmJob));
      if (s.status === 'done') {
        if (status) status.textContent = `✅ 扫描 ${s.stats.scanned} 个文件，发现 ${s.stats.groups} 组重名（共 ${s.stats.files_in_groups} 个文件）`;
        $('name-groups')&&($('name-groups').textContent = s.stats.groups);
        $('name-files')&&($('name-files').textContent = s.stats.files_in_groups);
        nmRender(s);
        break;
      }
      if (s.status === 'aborted') { if (status) status.textContent = '⏹ 已停止'; break; }
      if (s.status === 'error') { throw new Error(s.error || 'scan error'); }
      if (s.status === 'scanning' && status) status.textContent = `⏳ 扫描中… 已检查 ${s.progress?.scanned || 0} 个文件`;
    }
  } catch (e) {
    if (status) status.textContent = '❌ ' + e.message;
    if (list) list.innerHTML = '<div class="dup-empty-state"><div class="dup-empty-icon">⚠️</div><h3>扫描失败</h3><p>' + escHtml(e.message) + '</p></div>';
  } finally {
    _nmScanning = false;
    if (btn) btn.disabled = false;
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

  function nmRender(s) {
    const list = $('nm-list'); if (!list) return;
    const groups = s.groups || [];
    if (!groups.length) {
      list.innerHTML = '<div class="dup-empty-state"><div class="dup-empty-icon">🎉</div><h3>未发现重名文件</h3><p>没有同名文件散落在不同目录</p></div>';
      filesUpdateSelectInfo('namematch');
      return;
    }
    // 文件级明细 + 组级选择。
    //
    // 之前一行只显示组名和份数, 用户看不出具体删哪几个 —— 同一组里哪个保留、
    // 哪个删除完全看不出来。这里把组内文件逐个列出: 第一份标「保留」(这是组粒度
    // 选择的保证, 全选也不会删掉它), 其余标「删除」并给累计可释放空间。
    let html = '<div class="list-scroll"><table class="data-table"><thead><tr>'
      + '<th style="width:34px"><input type="checkbox" class="fd-cb-all" data-mod="namematch" onchange="filesSelectAll(this)"></th>'
      + '<th style="width:62px">操作</th><th>文件名</th><th style="width:70px">份数</th>'
      + '<th style="width:90px">大小</th><th>位置</th></tr></thead><tbody>';
    groups.forEach((g, gi) => {
      const files = g.files || [];
      // 保留第一份, 其余是副本 —— 与后端/选择逻辑一致的判定
      const dupFiles = files.slice(1);
      const dupSize = dupFiles.reduce((s2, f) => s2 + (f.size || 0), 0);
      const dupPaths = dupFiles.map(f => f.path);
      files.forEach((f, fi) => {
        const isKeep = fi === 0;
        html += `<tr${isKeep ? ' style="background:var(--color-primary-bg)"' : ''}>
          ${fi === 0
            ? `<td><input type="checkbox" class="fd-cb" data-mod="namematch" data-group="${gi}"
                 data-paths="${escHtml(JSON.stringify(dupPaths))}" data-size="${dupSize}"
                 data-keep="${escHtml(f.path)}" title="${dupFiles.length ? '选中后删除本组其余 ' + dupFiles.length + ' 个副本' : '本组只有一份, 无副本可删'}"
                 onchange="filesUpdateSelectInfo('namematch')" ${dupFiles.length ? '' : 'disabled'}></td>`
            : '<td></td>'}
          <td style="font-size:11px;white-space:nowrap;font-weight:600;color:${isKeep ? 'var(--color-success)' : 'var(--color-danger)'}">${isKeep ? '● 保留' : '✕ 删除'}</td>
          <td style="white-space:nowrap">${escHtml(g.name)}</td>
          <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary);text-align:center">${fi === 0 ? '×' + g.count : ''}</td>
          <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary)">${isKeep ? '<span style="opacity:.6">' + formatBytes(f.size || 0) + '</span>' : formatBytes(f.size || 0)}</td>
          <td style="font-family:var(--font-mono);font-size:11px;color:var(--color-text-secondary);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(f.path)}">${escHtml(f.dir || f.path)}</td>
        </tr>`;
      });
    });
    html += '</tbody></table></div>';
    list.innerHTML = html;
    filesUpdateSelectInfo('namematch');
  }

async function nmStop() {
  if (!_nmJob) return;
  _nmScanning = false;
  try { await API.post('api/namematch/stop?job=' + encodeURIComponent(_nmJob), {}); showToast('已请求停止', 'info'); } catch (e) { showToast('停止失败: ' + e.message, 'error'); }
}

// ═══════════════════════════════════════════════════════════════════
// 相似 / 异常 / 重名 三分区的选择与删除
//
// 三个分区共用 /api/files/delete(后端 app/ui/api/files_delete.js), 删除逻辑
// 与空目录一致: trash 移到 /volN/UID/.@#local/trash, permanent 直接删。
//
// 选择模型按分区语义各不相同:
//   相似  逐文件 —— 每个文件都是独立候选
//   异常  逐文件 —— 空文件/死链/损坏文件/下载残留都是独立项
//   重名  按组   —— 勾一组 = 删该组除第一份外的所有副本。逐文件勾选容易
//                   全选(把仅存的一份也删掉), 组粒度天然保证至少留一份。
// ═══════════════════════════════════════════════════════════════════
const FD_MOD_LABEL = { simdup: '相似', broken: '异常', namematch: '重名' };

/** 取某分区已勾选项 → { paths, size, keeps } */
function filesCollect(mod) {
  const boxes = document.querySelectorAll('.fd-cb[data-mod="' + mod + '"]:checked');
  const paths = [], keeps = [];
  let size = 0;
  boxes.forEach(el => {
    // 相似 / 重名 都是**组粒度**: 勾一个组 = 删该组除推荐/保留外的全部。
    // 逐文件勾选时"全选"会把每组仅存的那份也删掉, 组粒度天然避免。
    // 异常分区是文件粒度(空文件/死链/损坏文件都是独立项, 没有"留一份"的概念)。
    if (mod === 'namematch' || mod === 'simdup') {
      try {
        const arr = JSON.parse(el.dataset.paths || '[]');
        arr.forEach(p => paths.push(p));
        if (el.dataset.keep) keeps.push(el.dataset.keep);
      } catch { /* 数据异常的行跳过 */ }
      size += parseInt(el.dataset.size || '0', 10) || 0;
    } else {
      paths.push(el.dataset.path);
      size += parseInt(el.dataset.size || '0', 10) || 0;
    }
  });
  return { paths: Array.from(new Set(paths.filter(Boolean))), keeps, size };
}
function filesUpdateSelectInfo(mod) {
  const { paths, size } = filesCollect(mod);
  const btn = $(mod + 'DeleteBtn');
  if (btn) {
    btn.disabled = paths.length === 0;
    const span = btn.querySelector('span:last-child');
    if (span) span.textContent = paths.length ? '删除选中 (' + paths.length + ')' : '删除选中';
    btn.title = paths.length ? '共 ' + formatBytes(size) : '';
  }
  const all = document.querySelector('.fd-cb-all[data-mod="' + mod + '"]');
  if (all) {
    const allBoxes = document.querySelectorAll('.fd-cb[data-mod="' + mod + '"]');
    const total = allBoxes.length;
    const checked = document.querySelectorAll('.fd-cb[data-mod="' + mod + '"]:checked').length;
    all.checked = total > 0 && checked === total;
    all.indeterminate = checked > 0 && checked < total;
  }
}

/** 表头全选框(cb) 或「全选所有组」按钮(传 mod 字符串) */
function filesSelectAll(cb) {
  const mod = (typeof cb === 'string') ? cb : cb.dataset.mod;
  const on = (typeof cb === 'string') ? true : cb.checked;
  document.querySelectorAll('.fd-cb[data-mod="' + mod + '"]').forEach(el => {
    // 必须跳过 disabled —— 相似/重名里"只有一份"的组没有可删项,
    // 勾上它会把仅存的那份加入待删, 全选反而变成"全删"。
    if (!el.disabled) el.checked = on;
  });
  filesUpdateSelectInfo(mod);
}

/** 打开确认弹窗。mod: simdup | broken | namematch */
function openFilesDeleteModal(mod) {
  const { paths, size } = filesCollect(mod);
  if (!paths.length) { showToast('请先勾选要删除的文件', 'error'); return; }
  const modal = $('filesDeleteModal');
  if (!modal) return;
  modal.dataset.mod = mod;
  $('filesDeleteSrcLabel').textContent = FD_MOD_LABEL[mod] || mod;
  $('filesDeleteCount').textContent = paths.length;
  $('filesDeleteSize').textContent = formatBytes(size);
  const prev = $('filesDeletePaths');
  if (prev) {
    prev.innerHTML = paths.slice(0, 20)
      .map(p => '<div style="font-family:var(--font-mono);font-size:11px;color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(p) + '">' + escHtml(p) + '</div>')
      .join('') + (paths.length > 20 ? '<div style="font-size:11px;color:var(--color-text-secondary);margin-top:6px">… 另有 ' + (paths.length - 20) + ' 项</div>' : '');
  }
  const warn = $('filesDeleteWarn');
  if (warn) {
    if (mod === 'namematch') warn.textContent = '将保留每组第一份, 只删除其余副本。';
    else if (mod === 'broken') warn.textContent = '「无效链接」删除的是链接本身, 不会影响它指向的文件。';
    else if (mod === 'simdup') warn.textContent = '相似文件不等于重复文件, 请确认后再删。';
    else warn.textContent = '';
  }
  const ack = $('filesDeleteAck');
  if (ack) ack.checked = false;
  const trashRadio = modal.querySelector('input[name="filesDeleteMode"][value="trash"]');
  if (trashRadio) trashRadio.checked = true;
  filesRefreshConfirmBtn();
  modal.classList.add('visible');
}

function filesRefreshConfirmBtn() {
  const btn = $('filesDeleteConfirmBtn');
  if (btn) btn.disabled = !$('filesDeleteAck')?.checked;
}

function closeFilesDeleteModal() {
  $('filesDeleteModal')?.classList.remove('visible');
}

async function confirmFilesDelete() {
  const modal = $('filesDeleteModal');
  const mod = modal?.dataset.mod;
  if (!mod) { closeFilesDeleteModal(); return; }
  const { paths } = filesCollect(mod);
  if (!paths.length) { closeFilesDeleteModal(); return; }
  const mode = modal.querySelector('input[name="filesDeleteMode"]:checked')?.value || 'trash';
  const btn = $('filesDeleteConfirmBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await API.post('api/files/delete', { paths, mode });
    if (r.__ok === false) throw new Error(r.__error || ('HTTP ' + r.__status));
    closeFilesDeleteModal();
    let msg = '✅ 已' + (mode === 'trash' ? '移入回收站' : '永久删除') + ' ' + (r.deleted || 0) + ' 个文件';
    if (r.gone && r.gone.length) msg += '，' + r.gone.length + ' 个已被其他程序移走';
    if (r.blockedCount) msg += '，' + r.blockedCount + ' 个被安全策略拦截';
    if (r.failures) msg += '，' + r.failures + ' 个失败';
    showToast(msg, (r.failures || r.blockedCount) ? 'error' : 'success');
    // 重新扫描刷新列表
    if (mod === 'simdup') simDupScan();
    else if (mod === 'broken') brokScan();
    else nmScan();
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}


async function stopBigFiles() {
  try { await API.post('api/bigfiles/stop', {}); showToast('已请求停止', 'info'); } catch (e) { showToast('停止失败: ' + e.message, 'error'); }
}

function renderBigFilesList(files) {
  const list = $('bigfiles-list');
  if (!list) return;
  if (!files.length) {
    list.innerHTML = '<div class="dup-empty-state"><div class="dup-empty-icon">🎉</div><h3>未发现符合条件的大文件</h3><p>试试调小「最小值」或切换搜索范围</p></div>';
    if ($('bigfilesDeleteBtn')) $('bigfilesDeleteBtn').disabled = true;
    return;
  }
  let html = '<div class="list-scroll"><table class="data-table" id="bigfiles-table"><thead><tr>' +
    '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="bigfilesSelectAll(this)"></th>' +
    '<th style="width:50px">#</th>' +
    '<th>文件名</th>' +
    '<th style="width:14%">大小</th>' +
    '<th style="width:18%">位置</th>' +
    '<th style="width:90px">修改时间</th>' +
    '<th style="width:60px">深度</th>' +
    '</tr></thead><tbody>';
  files.forEach((f, i) => {
    const mtime = f.mtime ? new Date(f.mtime).toISOString().slice(0, 10) : '-';
    const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
    html += `<tr>
      <td><input type="checkbox" class="bigfiles-cb" value="${escHtml(f.path)}" data-size="${f.size || 0}" onchange="bigfilesUpdateSelectInfo()"></td>
      <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary)">${i + 1}</td>
      <td><span title="${escHtml(f.path)}">${escHtml(f.name)}</span></td>
      <td style="font-family:var(--font-mono);font-weight:600;color:var(--color-primary)">${escHtml(f.size_str)}</td>
      <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(dir)}">${escHtml(dir)}</td>
      <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary)">${escHtml(mtime)}</td>
      <td style="text-align:center;font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary)">${f.depth || 0}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  list.innerHTML = html;
  bigfilesUpdateSelectInfo();
}

function bigfilesSelectAll(cb) {
  document.querySelectorAll('.bigfiles-cb').forEach(el => { el.checked = cb.checked; });
  bigfilesUpdateSelectInfo();
}

function bigfilesUpdateSelectInfo() {
  const checked = document.querySelectorAll('.bigfiles-cb:checked');
  const n = checked.length;
  let totalBytes = 0;
  checked.forEach(el => { totalBytes += parseInt(el.dataset.size || '0', 10); });
  const btn = $('bigfilesDeleteBtn');
  if (btn) {
    btn.disabled = n === 0;
    const span = btn.querySelector('span:last-child');
    if (span) span.textContent = n ? `删除选中 (${n})` : '删除选中';
  }
  // Stash total for confirm modal
  _bigFilesSelectedBytes = totalBytes;
}

// ── Big Files: delete flow (3-layer confirmation) ──
let _bigFilesSelectedBytes = 0;

function confirmBigFilesDelete() {
  const checked = document.querySelectorAll('.bigfiles-cb:checked');
  if (!checked.length) return;
  const paths = Array.from(checked).map(el => el.value);
  let totalBytes = 0;
  checked.forEach(el => { totalBytes += parseInt(el.dataset.size || '0', 10); });
  $('bigfilesDeleteCount').textContent = String(paths.length);
  $('bigfilesDeleteSize').textContent = formatBytes(totalBytes);
  // Show up to 20 paths + overflow indicator
  const preview = $('bigfilesDeletePaths');
  let html = paths.slice(0, 20).map(p => `<div>${escHtml(p)}</div>`).join('');
  if (paths.length > 20) {
    html += `<div style="color:var(--color-text-secondary);margin-top:4px">…还有 ${paths.length - 20} 个未显示</div>`;
  }
  preview.innerHTML = html;
  // Reset to safe defaults each time
  const trashRadio = document.querySelector('input[name="bigfilesDeleteMode"][value="trash"]');
  if (trashRadio) trashRadio.checked = true;
  $('bigfilesDeletePermanentAck').checked = false;
  $('bigfilesDeletePermanentAck').disabled = true;
  $('bigfilesDeleteAck').checked = false;
  $('bigfilesDeleteConfirmBtn').disabled = true;
  bigfilesRefreshConfirmBtn();
  // Wire mode-change → enable/disable permanent ack
  document.querySelectorAll('input[name="bigfilesDeleteMode"]').forEach(r => {
    r.onchange = () => {
      const isPerm = document.querySelector('input[name="bigfilesDeleteMode"]:checked')?.value === 'permanent';
      $('bigfilesDeletePermanentAck').disabled = !isPerm;
      if (!isPerm) $('bigfilesDeletePermanentAck').checked = false;
      bigfilesRefreshConfirmBtn();
    };
  });
  // Wire ack change → refresh confirm button
  $('bigfilesDeleteAck').onchange = bigfilesRefreshConfirmBtn;
  $('bigfilesDeletePermanentAck').onchange = bigfilesRefreshConfirmBtn;
  $('bigfilesDeleteModal').classList.add('visible');
}

function bigfilesRefreshConfirmBtn() {
  const ack = $('bigfilesDeleteAck')?.checked;
  const isPerm = document.querySelector('input[name="bigfilesDeleteMode"]:checked')?.value === 'permanent';
  const permAck = isPerm ? $('bigfilesDeletePermanentAck')?.checked : true;
  $('bigfilesDeleteConfirmBtn').disabled = !(ack && permAck);
}

function closeBigFilesDeleteModal() {
  $('bigfilesDeleteModal').classList.remove('visible');
}

async function doBigFilesDelete() {
  const checked = document.querySelectorAll('.bigfiles-cb:checked');
  if (!checked.length) return;
  const paths = Array.from(checked).map(el => el.value);
  const mode = document.querySelector('input[name="bigfilesDeleteMode"]:checked')?.value || 'trash';
  closeBigFilesDeleteModal();
  $('bigfiles-status').textContent = mode === 'trash' ? '🗑 移到回收站…' : '🔥 永久删除…';
  try {
    // 超时给 120s: 默认 30s 对超大文件不够。unlink/rename 在大数据量或
    // 网盘 fuse 上会明显变慢, 30s 到了就是 AbortError, 前端报"删除失败",
    // 但后端其实还在删 —— 用户看到的就是"明明在删却提示失败"。
    const data = await API.post('api/bigfiles/delete', { paths, mode, confirmed: true }, 120000);
    if (data.__ok === false) throw new Error(data.__error || ('HTTP ' + data.__status));
    const deleted = data.total || 0;
    const skipped = data.skipped || 0;
    const failures = data.failures || 0;
    // 选了"放到回收站"但实际永久删除的路径(卷根/网盘等建不了回收站的)。
    // 原先这个字段前端根本不显示 —— 用户去回收站找不到文件, 只会认为"删除失败"。
    const fallbacks = Array.isArray(data.permanentFallbacks) ? data.permanentFallbacks : [];
    const fmtSize = formatBytes(_bigFilesSelectedBytes);
    const modeLabel = mode === 'trash' ? '移到回收站' : '永久删除';
    let msg = `✅ ${modeLabel}完成：${deleted}/${paths.length} 个 (${fmtSize})`;
    if (skipped) msg += ` · 跳过 ${skipped}`;
    if (failures) msg += ` · 失败 ${failures}`;
    // EROFS 是最常见的失败原因(卷以只读方式挂载), 直接把英文错误码翻译出来,
    // 否则用户看到 "failed: EROFS: read-only file system" 会以为是程序坏了。
    const roFailed = (data.failed || []).filter(f => /EROFS|read-only/i.test(f.reason || ''));
    if (roFailed.length) {
      msg = `⛔ ${roFailed.length} 个文件所在卷为只读，无法删除（EROFS）· 成功 ${deleted}/${paths.length}`
        + (roFailed.length === paths.length ? '，本卷一个都删不掉' : '');
    }
    if (fallbacks.length) {
      msg += ` · ${fallbacks.length} 个未能进回收站已直接删除（${escHtml(fallbacks[0])} 等）`;
    }
    msg += blockedNotice(data);
    const st = $('bigfiles-status');
    if (st) { st.textContent = msg; st.dataset.lastOp = msg; }
    // 有失败/被拦/未能进回收站时不能用绿色成功样式 —— 否则用户以为一切正常
    const partial = failures || data.blockedCount || fallbacks.length;
    showToast(msg, partial ? (failures ? 'error' : 'warning') : 'success');
    // Re-scan to refresh the list (deleted files are gone)
    if (deleted > 0) await doBigFilesScan(true);
  } catch (e) {
    // 超时 ≠ 没删成。请求超时后端仍可能在继续删(unlink 大文件/网盘 fuse 尤其慢),
    // 直接报"删除失败"会让用户以为文件还在、从而重复操作。
    // 所以超时单独给一条"结果未知, 请刷新确认"的提示。
    const timedOut = /abort/i.test(e.message || '') || e.name === 'AbortError';
    const st = $('bigfiles-status');
    const msg = timedOut
      ? '⏳ 删除超时（超过 120 秒），结果未知 — 请重新扫描确认哪些文件已删除，不要重复操作'
      : '❌ ' + e.message;
    if (st) { st.className = timedOut ? 'loading' : 'error'; st.textContent = msg; st.dataset.lastOp = msg; }
    showToast(timedOut ? '删除超时, 结果未知, 请重新扫描确认' : ('删除失败: ' + e.message), timedOut ? 'warning' : 'error');
  }
}

// ═══════════════════════════════
// Docker Cleanup (stopped containers + build cache)
// ═══════════════════════════════
// 分区自动扫描用的状态。放在这里而不是各函数内部, 是因为 dcAutoScan 和手动
// 点「扫描」按钮走的是同一个 dcScan, 必须共用同一个"正在扫"标记。
let _dcScanning = false;          // 容器列表正在拉, 防自动扫描与手点撞车
let _dcScannedAt = 0;            // 上次拉到的时刻(ms), 用于状态栏显示
let _sysCleanScanning = false;    // 系统缓存扫描中(耗时 3.8~16s, 必须防重入)
let _sysCleanScannedAt = 0;       // 上次扫描时刻, 1 分钟内不重复自动扫
let _dcStoppedList = []; // last scan result (cached for selection)

async function dcCheckAvailable() {
  // Probe both endpoints in parallel — if either succeeds docker is up
  const [stopped, cache] = await Promise.all([
    API.get('api/docker/stopped').catch(() => ({ available: false })),
    API.get('api/docker/build_cache').catch(() => ({ available: false })),
  ]);
  const available = !!(stopped.available && cache.available);
  const daemon = !!(stopped.daemon && cache.daemon);
  // Docker 不可用时: 顶部提示卡显示, 并把「容器 / 缓存」两个入口藏起来。
  // 原来的 dockercleanup-main 包裹层已随 tab 合并删除 —— 这两个分区各自带
  // 独立的 kpi-row, 不再需要共用一个开关容器。
  $('dockercleanup-unavailable').style.display = available ? 'none' : '';
  document.querySelectorAll('[data-inner-tab="containers"],[data-inner-tab="cache"]')
    .forEach(b => { b.style.display = available ? '' : 'none'; });
  document.querySelectorAll('[data-inner-panel="containers"],[data-inner-panel="cache"]')
    .forEach(p => { if (!available) p.classList.remove('active'); });
  if (!available) {
    // 当前若正停在容器/缓存, 退回镜像分区, 否则会空白一片
    const cur = document.querySelector('.inner-tab-btn.active');
    if (cur && (cur.dataset.innerTab === 'containers' || cur.dataset.innerTab === 'cache')) {
      switchInnerTab('images');
    }
  }
  if (!available) return;
  // Auto-populate cache card even without explicit scan (cheap)
  if (cache.build_cache) {
    $('dc-cache-total').textContent = cache.build_cache.total_str || '0 B';
    $('dc-cache-reclaim').textContent = cache.build_cache.reclaimable_str || '0 B';
    $('dcPruneBtn').disabled = !cache.build_cache.reclaimable_bytes;
    $('dc-cache-status').textContent = daemon ? '' : '⚠️ Docker daemon 未响应';
  } else {
    $('dc-cache-total').textContent = '-';
    $('dc-cache-reclaim').textContent = '-';
    $('dcPruneBtn').disabled = true;
    // ★ 这个分区没有「扫描」按钮(只有 dcPruneCache), 原来那句"点击「扫描」按钮
    // 获取详情"指向一个不存在的按钮, 用户只会在这里干等。改成说明真实原因。
    $('dc-cache-status').textContent = daemon === false
      ? '⚠️ Docker daemon 未响应，无法读取构建缓存'
      : '未获取到构建缓存信息';
  }
  // 把探测结果带回去: 进「容器」分区时 dcScan 可以直接用它渲染, 不用再打一次
  // api/docker/stopped(否则切一次容器分区要发三个请求)。
  return { available, daemon, stopped, cache };
}

// preloaded: dcCheckAvailable 已经拿到的 {available, daemon, stopped} —— 传进来
// 就省掉一次重复请求。缺省(手动点「扫描」按钮)照旧自己拉。
// ── 分区自动扫描 ──────────────────────────────────────────────────
// 为什么容器分区可以每次都扫: api/docker/stopped 实测只要 0.1s, 而容器的启停
// 由用户在别处随时改变, 切进来看到的是"上次扫描时的快照"几乎必然是错的。
// 所以每次进入都重扫, 代价可以忽略, 换来的是看到的一定是当前状态。
async function dcAutoScan() {
  const probe = await dcCheckAvailable();
  // Docker 不可用时 dcCheckAvailable 已经把入口藏起来并退回镜像分区, 这里不再扫。
  if (!probe || !probe.available) return;
  await dcScan(probe);
}

// 为什么系统缓存分区要限流: api/sysclean/scan 实测 3.8~16s(要 stat 上千个缓存
// 目录)。切一次就等十几秒, 来回切两个 tab 更是叠加。所以只在没扫过时自动扫,
// 一分钟内切走再切回来直接沿用上次结果 —— 缓存体积一分钟内不会变多少。
// 手动「扫描缓存」按钮始终可用, 随时能强刷。
async function sysCleanAutoScan() {
  if (_sysCleanScanning) return;
  if (SysCleanState.scanLoaded && _sysCleanScannedAt
      && (Date.now() - _sysCleanScannedAt) < 60000) {
    return;
  }
  await doSysCleanScan();
}

async function dcScan(preloaded) {
  const btn = $('dcScanBtn');
  const status = $('dc-stopped-status');
  const list = $('dc-stopped-list');
  // 正在扫就直接返回: 自动扫描和用户手点可能撞在一起, 两个响应同时往同一个
  // 列表渲染, 后到的会把先到的结果覆盖掉, 用户看到的是随机一份数据。
  if (_dcScanning) return;
  _dcScanning = true;
  btn.disabled = true;
  status.className = '';
  status.textContent = '🔍 扫描中…';
  try {
    const data = preloaded && preloaded.available ? preloaded : await API.get('api/docker/stopped');
    _dcScannedAt = Date.now();
    if (!data.available) {
      dcCheckAvailable(); // refresh unavailable banner
      status.className = 'error';
      status.textContent = '❌ Docker 不可用';
      return;
    }
    _dcStoppedList = data.containers || [];
    $('dc-stopped-count').textContent = String(_dcStoppedList.length);
    $('dc-stopped-size').textContent = data.total_size || '0 B';
    renderDcStoppedList(_dcStoppedList);
    status.textContent = _dcStoppedList.length
      ? `🛑 找到 ${_dcStoppedList.length} 个已停止容器，共 ${data.total_size}`
      : '🎉 没有已停止的容器';
  } catch (e) {
    status.className = 'error';
    status.textContent = '❌ ' + e.message;
  } finally {
    _dcScanning = false;
    btn.disabled = false;
  }
}

function renderDcStoppedList(items) {
  const list = $('dc-stopped-list');
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="dup-empty-state"><div class="dup-empty-icon">🎉</div><h3>无已停止容器</h3></div>';
    $('dcRemoveBtn').disabled = true;
    return;
  }
  let html = '<div class="list-scroll"><table class="data-table" id="dc-stopped-table"><thead><tr>' +
    '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="dcSelectAll(this)"></th>' +
    '<th>ID</th><th>名称</th><th>镜像</th><th style="width:90px">大小</th><th>状态</th>' +
    '</tr></thead><tbody>';
  items.forEach((c) => {
    html += `<tr>
      <td><input type="checkbox" class="dc-cb" value="${escHtml(c.id)}" onchange="dcUpdateSelectInfo()"></td>
      <td style="font-family:var(--font-mono);font-size:11px;color:var(--color-text-secondary)">${escHtml(c.id.slice(0, 12))}</td>
      <td>${escHtml(c.names || '-')}</td>
      <td style="font-family:var(--font-mono);font-size:12px">${escHtml(c.image || '-')}</td>
      <td style="font-family:var(--font-mono);font-weight:600;color:var(--color-primary)">${escHtml(c.size_str || '0 B')}</td>
      <td style="font-size:12px;color:var(--color-text-muted)">${escHtml(c.status || '-')}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';
  list.innerHTML = html;
  $('dcRemoveBtn').disabled = false;
}

function dcSelectAll(cb) {
  document.querySelectorAll('.dc-cb').forEach(el => { el.checked = cb.checked; });
  dcUpdateSelectInfo();
}

function dcUpdateSelectInfo() {
  const n = document.querySelectorAll('.dc-cb:checked').length;
  const btn = $('dcRemoveBtn');
  btn.disabled = n === 0;
  btn.querySelector('span:last-child').textContent = n ? `删除选中 (${n})` : '删除选中';
}

async function dcRemoveSelected() {
  const ids = Array.from(document.querySelectorAll('.dc-cb:checked')).map(el => el.value);
  if (!ids.length) return;
  const dryRun = $('dcDryRun').checked;
  const totalBytes = _dcStoppedList
    .filter(c => ids.includes(c.id))
    .reduce((sum, c) => sum + (c.size_bytes || 0), 0);
  const dryRunLabel = dryRun ? '【预览】' : '【真实删除】';
  const msg = dryRun
    ? `${dryRunLabel}\n\n将对 ${ids.length} 个容器执行预览（不会真实删除）：\n${formatBytes(totalBytes)}\n\n继续？`
    : `${dryRunLabel}\n\n将真实删除 ${ids.length} 个容器（约 ${formatBytes(totalBytes)}）：\n\n${ids.slice(0, 5).join('\n')}${ids.length > 5 ? `\n…共 ${ids.length} 个` : ''}\n\n此操作不可恢复！`;
  if (!confirm(msg)) return;
  const btn = $('dcRemoveBtn');
  btn.disabled = true;
  $('dc-stopped-status').textContent = dryRun ? '🧪 预览中…' : '🗑 删除中…';
  try {
    const data = await API.post('api/docker/stopped/remove', { ids, dry_run: dryRun });
    const deleted = data.total?.deleted ?? 0;
    $('dc-stopped-status').textContent = dryRun
      ? `🧪 预览完成：${ids.length} 个容器可删除（${formatBytes(totalBytes)}）`
      : `✅ 已删除 ${deleted}/${ids.length} 个容器`;
    if (!dryRun && deleted > 0) await dcScan(); // refresh
  } catch (e) {
    $('dc-stopped-status').className = 'error';
    $('dc-stopped-status').textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

async function dcPruneCache() {
  const dryRun = $('dcDryRun').checked;
  const reclaim = $('dc-cache-reclaim').textContent || '0 B';
  const msg = dryRun
    ? `【预览】\n\n将清理所有未使用的 Docker build cache：\n预计可回收 ${reclaim}\n\n继续？`
    : `【真实删除】\n\n将执行 docker builder prune -af：\n预计可回收 ${reclaim}\n\n此操作不可恢复，下次 docker build 会重新拉取镜像层！`;
  if (!confirm(msg)) return;
  const btn = $('dcPruneBtn');
  btn.disabled = true;
  $('dc-cache-status').textContent = dryRun ? '🧪 预览中…' : '🧹 Prune 中…';
  try {
    const data = await API.post('api/docker/build_cache/prune', { dry_run: dryRun });
    if (dryRun) {
      $('dc-cache-status').textContent = `🧪 预览：${data.reclaimed_str || '0 B'} 可回收`;
    } else {
      $('dc-cache-status').textContent = data.ok
        ? `✅ 已回收 ${data.reclaimed_str || '0 B'}`
        : `❌ 失败: ${data.error || '未知错误'}`;
      if (data.ok) await dcCheckAvailable(); // refresh cache card
    }
  } catch (e) {
    $('dc-cache-status').className = 'error';
    $('dc-cache-status').textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── Version Check ──
function checkVersion() {
  const badge = document.getElementById('versionBadge');
  if (!badge) return;
  // Try to get current version from API
  fetch('/app/fnclearup/api/version', { signal: AbortSignal.timeout(5000) }).then(r=>r.json()).then(d=>{
    const cur = d.version || '0.7.2';
    badge.textContent = 'v' + cur;
    // Fetch remote version from FnDepot
    return fetch('https://raw.githubusercontent.com/Wyf841015/FnDepot/main/fnpack.json', { signal: AbortSignal.timeout(8000) });
  }).then(r=>r.json()).then(data => {
    if (!data || !data.apps) return;
    const appInfo = data.apps.find(a => a.appname === 'fnclearup');
    if (!appInfo || !appInfo.version) return;
    const curVer = badge.textContent.replace(/^v/, '');
    const remoteVer = appInfo.version.replace(/^v/, '');
    if (compareVersions(remoteVer, curVer) > 0) {
      badge.classList.add('new-version');
      badge.title = '有新版本 v' + remoteVer + ' 可用！点击查看';
      badge.onclick = function(){ window.open('https://github.com/Wyf841015/FnDepot', '_blank'); };
      showToast('发现新版本 v' + remoteVer + '，当前 v' + curVer, 'info');
    }
  }).catch(() => {/* ignore network errors */});
}
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function stopDupScan(tab){
  const jobId=DupState[tab].jobId; if(!jobId)return;
  API.post('api/dup/stop',{jobId}).then(r=>{if(r.success){DupState[tab].checking=false;finishDupScan(tab,{status:'aborted'});}else showToast(r.error||'停止失败','error');}).catch(e=>showToast('停止失败','error'));
}
function showDupDeleteModal(tab){
  const cbs=document.querySelectorAll('.dup-file-cb:checked:not(.group-select-all)'); const count=cbs.length;
  if(count===0){showToast('请选择要删除的文件','error');return;}
  $('#dupDeleteCount').textContent=count; $('#dupDeleteModal').dataset.tab=tab; $('#dupDeleteModal').classList.add('visible');
}
function hideDupDeleteModal(){$('#dupDeleteModal')?.classList.remove('visible');}
async function confirmDupDelete(){
  const tab=$('#dupDeleteModal').dataset.tab; if(!tab)return;
  const mode=document.querySelector('input[name="dupDeleteMode"]:checked')?.value||'trash';
  const cbs=[...document.querySelectorAll('.dup-file-cb:checked:not(.group-select-all)')];
  const paths=cbs.map(cb=>cb.dataset.path);
  if(!paths.length){hideDupDeleteModal();return;}
  hideDupDeleteModal();
  try{
    let r;
    if (mode === 'hardlink') {
      // For each selected file, find its group's KEEP file (files[0], decided by keepMode on backend).
      // The hardlink keep must not be one of the selected files.
      const byHash={};
      for(const g of DupState[tab].duplicates){ byHash[g.hash]=g; }
      const keepPathFor=new Map();
      for(const cb of cbs){
        const g=byHash[cb.dataset.hash];
        if(!g||!g.files||!g.files.length) continue;
        // files[0] is the keep candidate; only link-remove the OTHER files
        const keep=g.files[0].path;
        if(!paths.includes(keep) && cb.dataset.path!==keep){ keepPathFor.set(cb.dataset.path, keep); }
      }
      const linkTargets=[...keepPathFor.keys()].filter(p=>paths.includes(p));
      if(!linkTargets.length){ showToast('所选文件都需保留，无法硬链接去重','warning'); return; }
      // Batch by keep to minimize API calls
      const byKeep=new Map();
      for(const p of linkTargets){ const k=keepPathFor.get(p); if(!byKeep.has(k))byKeep.set(k,[]); byKeep.get(k).push(p); }
      r={deleted:0, linked:0, failed:[], skipped:0, emptyDirs:[]};
      for(const [keep,ps] of byKeep){
        const sub=await API.post('api/dup/delete',{files:ps,mode:'hardlink',keep});
        if(sub){ r.deleted+=sub.deleted||0; r.linked+=sub.linked?.length||0; if(sub.failed)r.failed.push(...sub.failed); r.emptyDirs.push(...(sub.emptyDirs||[])); }
      }
    } else {
      r=await API.post('api/dup/delete',{files:paths,mode});
    }
    const msg=mode==='hardlink' ? `硬链接 ${r.linked||0} 个文件` : `已删除 ${r.deleted||0} 个文件`;
    if(r.blockedCount) showToast(msg+blockedNotice(r),'warning');
    if(r.failed&&r.failed.length) showToast(msg+'，失败 '+r.failed.length+' 个: '+r.failed.map(f=>f.reason).join('; '),'warning');
    else showToast(msg,'success');
    if(r.emptyDirs&&r.emptyDirs.length){
      const sample=r.emptyDirs.slice(0,5).join('<br>');
      showToast('发现 '+r.emptyDirs.length+' 个空目录，可用「去空」清理:<br>'+sample,'info');
    }
    // Re-fetch results to update UI
    const ids=getDupIds(tab);
    const data={status:'complete',duplicates:DupState[tab].duplicates,stats:{}};
    // Remove deleted files from state
    const remDups=[];
    let delCount=0;
    for(const g of DupState[tab].duplicates){
      const remaining=g.files.filter(f=>!paths.includes(f.path));
      if(remaining.length>=2){remDups.push({...g,files:remaining,count:remaining.length});}
      else delCount++;
    }
    DupState[tab].duplicates=remDups;
    if(remDups.length===0){
      $(ids.results).style.display='none';$(ids.empty).style.display='';
      const h3=$(ids.empty).querySelector('h3'); if(h3)h3.textContent='🎉 已清理所有重复项';
    } else {
      renderDupList(tab,remDups);
    }
  }catch(e){showToast('删除失败: '+e.message,'error');}
}
async function exportDup(tab){
  showToast('导出功能已停用', 'info');
}

// ── Directory Browser ──
let _browseTargetId = '';
let _browseDupTab = '';
// 导出保存模式: 复用同一个 browseModal, 只是多一个文件名输入框。
// _browseSaving 为真时 browseSelect() 不再回填输入框, 而是调后端把
// _pendingExport 里的内容写到用户选的目录。
let _browseSaving = false;
let _pendingExport = null;   // { content, filename, encoding }

// 把「内容 + 文件名」交给用户在 NAS 上选目录落盘。
// 以前走 Blob + a.download, 文件落到客户端浏览器目录 —— 在 fnOS WebView
// 里用户根本拿不到, 手机上更是无从下载。
function saveContentViaBrowser(content, filename, encoding) {
  if (typeof content !== 'string' || content.length === 0) {
    showToast('没有可导出的内容', 'warning');
    return false;
  }
  _pendingExport = { content, filename: filename || 'export.txt', encoding: encoding || 'utf8' };
  _browseSaving = true;
  _browseDupTab = '';
  _browseTargetId = '';
  document.getElementById('browseSaveRow').classList.add('visible');
  document.getElementById('browseFilename').value = _pendingExport.filename;
  document.getElementById('browseTitle').textContent = '💾 选择保存位置';
  document.getElementById('browseSelectBtn').textContent = '💾 保存到此处';
  document.getElementById('browseModal').classList.add('visible');
  // 起点给 '/' —— handleBrowse 在根目录只列出可用的 /vol*, 用户点进去即可
  loadBrowseDir('/');
  return true;
}

// 三种模式(选择目录 / 去重路径 / 导出保存)共用的开关逻辑
function setBrowseMode(mode) {
  _browseSaving = mode === 'save';
  const isSave = _browseSaving;
  const row = document.getElementById('browseSaveRow');
  if (row) row.classList.toggle('visible', isSave);
  const title = document.getElementById('browseTitle');
  if (title) title.textContent = isSave ? '💾 选择保存位置' : '📁 选择目录';
  const btn = document.getElementById('browseSelectBtn');
  if (btn) btn.textContent = isSave ? '💾 保存到此处' : '✅ 选择当前目录';
}

// 点遮罩关闭。保存模式下不允许直接关掉 —— 用户已经点了导出, 内容还捏在
// _pendingExport 里, 一关掉内容就丢了且无处可寻; 此时只能改文件名或换目录,
// 或显式点 ✕ / 「保存到此处」/「上级目录」以外的方式退出。
function browseBackdropClick() {
  if (_browseSaving) {
    showToast('请先选择保存位置，或点右上角 ✕ 取消导出', 'warning', 3500);
    return;
  }
  hideBrowseModal();
}

function showBrowseModal(inputId) {
  _browseTargetId = inputId;
  _browseDupTab = '';
  setBrowseMode('select');
  const input = document.getElementById(inputId);
  const path = input ? input.value || '/' : '/';
  document.getElementById('browseModal').classList.add('visible');
  loadBrowseDir(path);
}
function showDupBrowseModal(tab) {
  _browseDupTab = tab;
  _browseTargetId = '';
  setBrowseMode('select');
  document.getElementById('browseModal').classList.add('visible');
  // Always start from root to avoid ENOENT on stale default paths
  loadBrowseDir('/');
}
function hideBrowseModal() {
  document.getElementById('browseModal')?.classList.remove('visible');
  // 复位保存模式, 否则下次打开目录浏览会带着上次的文件名和标题
  if (_browseSaving) {
    _browseSaving = false;
    _pendingExport = null;
    const inp = document.getElementById('browseFilename');
    if (inp) inp.value = '';
  }
  // 无条件把 UI 拨回「选择目录」形态: 即使本来就不是保存模式, 上一轮保存留下的
  // "💾 选择保存位置" 标题也不该继续挂在关闭状态的弹窗上。
  setBrowseMode('select');
}
// P1: 每次点击目录都发独立 fetch, 只有超时没有取消/序号比对。两个响应乱序到达时,
// 旧结果会直接覆盖 list.innerHTML, 出现"路径栏显示 A、列表却是 B"的错位。
let _browseSeq = 0;
async function loadBrowseDir(dirPath) {
  const seq = ++_browseSeq;              // 本次请求序号
  const list = document.getElementById('browseList');
  const pathEl = document.getElementById('browsePath');
  if (pathEl) pathEl.textContent = dirPath;
  if (list) list.innerHTML = '<div class="browse-item" style="justify-content:center;color:var(--color-text-secondary);cursor:default">⏳ 加载中...</div>';
  try {
    const r = await fetch('/app/fnclearup/api/browse?path=' + encodeURIComponent(dirPath), { signal: AbortSignal.timeout(15000) });
    const data = await r.json();
    if (seq !== _browseSeq) return;   // 已有更新的请求在飞, 丢弃本次过期响应
    if (!data.success) { if (list) list.innerHTML = '<div class="browse-item" style="justify-content:center;color:var(--color-danger);cursor:default">❌ ' + escHtml(data.error||'加载失败') + '</div>'; return; }
    if (list) {
      let html = '';
      if (data.parent) html += '<div class="browse-item dir" onclick="browseGoUp()" style="color:var(--color-primary)">⬆ ..</div>';
      for (const e of data.entries) {
        if (e.isDirectory) html += '<div class="browse-item dir" data-browse-path="' + escHtml(e.path) + '">📁 ' + escHtml(e.name) + '</div>';
        else html += '<div class="browse-item file">📄 ' + escHtml(e.name) + '</div>';
      }
      if (data.entries.length === 0) html = '<div class="browse-item" style="justify-content:center;color:var(--color-text-secondary);cursor:default">📂 空目录</div>';
      list.innerHTML = html;
    // P0 XSS: 目录名含反斜杠时旧 onclick 转义会被闭合, 改 data-* 绑定
    list.querySelectorAll('[data-browse-path]').forEach(el => {
      el.onclick = () => loadBrowseDir(el.dataset.browsePath);
    });
    }
  } catch(e) { if (list) list.innerHTML = '<div class="browse-item" style="justify-content:center;color:var(--color-danger);cursor:default">❌ ' + escHtml(e.message) + '</div>'; }
}
function browseGoUp() {
  const p = document.getElementById('browsePath');
  if (!p) return;
  const cur = p.textContent;
  const parent = cur === '/' ? null : cur.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  if (parent) loadBrowseDir(parent);
}
// 把待导出内容写到用户选定的目录。
// 单独抽出来是因为覆盖确认需要重试一次(带 overwrite), 逻辑较长不宜塞进 browseSelect。
async function doSaveExportTo(dir) {
  const pending = _pendingExport;
  if (!pending) { showToast('没有待保存的内容', 'error'); hideBrowseModal(); return; }
  const nameInput = document.getElementById('browseFilename');
  const filename = (nameInput ? nameInput.value : '').trim() || pending.filename;
  if (dir === '/') {
    showToast('请选择一个具体目录（不能是根目录 /）', 'warning', 4000);
    return;
  }
  const btn = document.getElementById('browseSelectBtn');
  // 只记 disabled 状态, **不要把文案存下来 finally 还原** ——
  // 成功路径里 hideBrowseModal() 已经通过 setBrowseMode 把按钮拨回
  // 「✅ 选择当前目录」, 再用存档文案覆盖回去就会留下
  // 「关闭的弹窗上却挂着『💾 保存到此处』按钮」这种脏状态(浏览器实测抓到过)。
  const wasDisabled = btn ? btn.disabled : false;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 保存中...'; }
  try {
    let r = await postExportSave(dir, filename, pending, false);
    // 409 = 目标已存在且未允许覆盖
    if (r && r.__status === 409) {
      if (confirm(`「${filename}」已存在于：\n${dir}\n\n是否覆盖？`)) {
        r = await postExportSave(dir, filename, pending, true);
      } else {
        return;   // 用户取消, 弹窗保持打开以便改名字或换目录
      }
    }
    if (r && r.success) {
      showToast(`✅ 已保存: ${r.path}（${r.sizeText}）${r.overwritten ? '（已覆盖）' : ''}`, 'success', 5000);
      hideBrowseModal();
    } else {
      showToast('保存失败: ' + ((r && r.error) || '未知错误'), 'error', 6000);
    }
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error', 6000);
  } finally {
    // 文案交给 setBrowseMode 管: 成功时弹窗已关(选择模式), 失败/取消时弹窗还开着
    // (保存模式), 两种情况都由它给出正确文案。
    if (btn) btn.disabled = wasDisabled;
    if (_browseSaving) setBrowseMode('save'); else setBrowseMode('select');
  }
}

async function postExportSave(dir, filename, pending, overwrite) {
  const res = await fetch('api/export/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      dir, filename,
      content: pending.content,
      encoding: pending.encoding || 'utf8',
      overwrite: !!overwrite,
    }),
    signal: AbortSignal.timeout(60000),
  });
  let body = {};
  try { body = await res.json(); } catch { body = { success: false, error: 'HTTP ' + res.status }; }
  body.__status = res.status;
  return body;
}

function browseSelect() {
  const p = document.getElementById('browsePath');
  if (!p) return;
  const path = p.textContent;
  // 导出保存模式: 不回填输入框, 直接把待导出内容写到用户选的目录
  if (_browseSaving) {
    doSaveExportTo(path);
    return;
  }
  if (_browseDupTab) {
    const tab = _browseDupTab;
    _browseDupTab = '';
    if (DupState[tab] && !DupState[tab].paths.includes(path)) {
      DupState[tab].paths.push(path);
      renderDupPaths(tab);
    }
    hideBrowseModal();
    return;
  }
  if (!_browseTargetId) return;
  const input = document.getElementById(_browseTargetId);
  if (input) input.value = path;
  hideBrowseModal();
}

function renderDupPaths(tab) {
  const container = document.getElementById(tab + 'PathList');
  if (!container) return;
  const paths = DupState[tab]?.paths || [];
  if (paths.length === 0) {
    container.innerHTML = '<span class="dup-path-empty">尚未添加目录，请点击"添加目录"选择</span>';
    return;
  }
  let html = '';
  for (let i = 0; i < paths.length; i++) {
    html += '<span class="dup-path-tag"><span class="dup-path-tag-text" title="' + escHtml(paths[i]) + '">' + escHtml(paths[i]) + '</span><button type="button" class="dup-path-tag-remove" onclick="removeDupPath(\'' + tab + '\',' + i + ')" title="移除">×</button></span>';
  }
  container.innerHTML = html;
}

function removeDupPath(tab, index) {
  if (DupState[tab]) {
    DupState[tab].paths.splice(index, 1);
    renderDupPaths(tab);
  }
}

// ════════════════════════════════
// 空目录清理
// ════════════════════════════════
const EmptyDirState = { items: [], checking: false, jobId: null, startTime: null, stopRequested: false, _timer: null };

function startEmptyScan() {
  const pathInput = $('emptyPath');
  const scanPath = pathInput ? pathInput.value.trim() : '';
  if (!scanPath) { showToast('请输入目录路径', 'error'); return; }
  const btn = $('emptyScanBtn'), stopBtn = $('emptyStopBtn'), prog = $('emptyProgress');
  const status = $('empty-status'), list = $('empty-list'), emptyEl = $('empty-empty'), resultsEl = $('empty-results');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span><span>扫描中...</span>'; }
  if (stopBtn) { stopBtn.style.display = ''; stopBtn.disabled = false; }
  if (prog) prog.classList.add('visible');
  if (status) { status.className = 'loading'; status.textContent = '⏳ 正在扫描空目录...'; }
  if (list) list.innerHTML = '';
  if (emptyEl) emptyEl.style.display = 'none';
  if (resultsEl) resultsEl.style.display = 'none';
  EmptyDirState.items = [];
  EmptyDirState.checking = true;
  EmptyDirState.startTime = Date.now();
  EmptyDirState.stopRequested = false;
  EmptyDirState.jobId = null;
  // 独立定时器每秒更新耗时
  if (EmptyDirState._timer) clearInterval(EmptyDirState._timer);
  EmptyDirState._timer = setInterval(() => {
    if (!EmptyDirState.startTime) return;
    const s = Math.round((Date.now() - EmptyDirState.startTime) / 1000);
    const el = $('empty-elapsed'); if (el) el.textContent = s + 's';
    const txt = $('emptyProgressText'); if (txt && EmptyDirState.checking) txt.textContent = '正在扫描... ' + s + 's';
  }, 1000);
  $('empty-count').textContent = '-';
  $('empty-pending').textContent = '-';
  $('empty-elapsed').textContent = '-';
  const bar = $('emptyProgressBar'); if (bar) bar.style.width = '0%';
  // Immediately show "启动中..." so user sees feedback before first poll
  const cdEl0 = $('emptyCurrentDir'); if (cdEl0) cdEl0.textContent = '⏳ 启动中...';
  API.post('api/empty_dir/scan', { path: scanPath }, 60000).then(r => {
    if (r.error || !r.success) { finishEmptyScan(false, r.error || '扫描失败'); return; }
    EmptyDirState.jobId = r.jobId;
    pollEmptyProgress();
  }).catch(e => { finishEmptyScan(false, e.message); });
}

function stopEmptyScan() {
  EmptyDirState.checking = false;
  EmptyDirState.stopRequested = true;
  if (EmptyDirState._timer) { clearInterval(EmptyDirState._timer); EmptyDirState._timer = null; }
  $('emptyScanBtn').disabled = false;
  $('emptyScanBtn').innerHTML = '<span>🔍</span><span>开始扫描</span>';
  $('emptyStopBtn').style.display = 'none';
  $('emptyProgress').classList.remove('visible');
  $('empty-status').textContent = '';
  // Call backend to actually stop the scan
  if (EmptyDirState.jobId) {
    API.post('api/empty_dir/stop', { jobId: EmptyDirState.jobId }).catch(() => {});
  }
  // Reset all state to prevent stale pollEmptyProgress from continuing
  EmptyDirState.jobId = null;
  EmptyDirState.startTime = null;
  EmptyDirState.items = [];
  showToast('已停止扫描', 'info');
}

function pollEmptyProgress() {
  if (!EmptyDirState.checking || EmptyDirState.stopRequested) return;
  const jobId = EmptyDirState.jobId;
  const elapsed = EmptyDirState.startTime ? Math.round((Date.now() - EmptyDirState.startTime) / 1000) : 0;
  const el = $('empty-elapsed'); if (el) el.textContent = elapsed + 's';
  // Update progress bar
  const bar = $('emptyProgressBar'); if (bar) bar.style.width = '85%';
  const txt = $('emptyProgressText'); if (txt) txt.textContent = '正在扫描... ' + elapsed + 's';

  API.get('api/empty_dir/status?jobId=' + jobId, 60000).then(r => {
    if (!EmptyDirState.checking) return;
    // Show current scanning directory
    if (r.currentDir) { const cd = $('emptyCurrentDir'); if (cd) cd.textContent = '📂 ' + r.currentDir; }
    if (r.status === 'complete' || r.status === 'error') {
      finishEmptyScan(r.status !== 'error', r.error, r);
    } else {
      setTimeout(pollEmptyProgress, 800);
    }
  }).catch(() => {
    if (EmptyDirState.checking) setTimeout(pollEmptyProgress, 2000);
  });
}

function finishEmptyScan(success, error, data) {
  EmptyDirState.checking = false;
  if (EmptyDirState._timer) { clearInterval(EmptyDirState._timer); EmptyDirState._timer = null; }
  const btn = $('emptyScanBtn'), stopBtn = $('emptyStopBtn'), prog = $('emptyProgress');
  const status = $('empty-status'), resultsEl = $('empty-results'), emptyEl = $('empty-empty'), list = $('empty-list');
  const cdEl = $('emptyCurrentDir'); if (cdEl) cdEl.textContent = '';
  if (btn) { btn.disabled = false; btn.innerHTML = '<span>🔍</span><span>开始扫描</span>'; }
  if (stopBtn) stopBtn.style.display = 'none';
  if (prog) prog.classList.remove('visible');
  if (!success) {
    if (status) status.className = 'status-error'; status.textContent = '❌ ' + (error || '扫描失败');
    if (emptyEl) { emptyEl.style.display = ''; const h3 = emptyEl.querySelector('h3'); if (h3) h3.textContent = '❌ 扫描失败'; }
    showToast(error || '扫描失败', 'error');
    return;
  }
  const items = data?.items || [];
  EmptyDirState.items = items;
  const count = items.length;
  const elapsed = EmptyDirState.startTime ? Math.round((Date.now() - EmptyDirState.startTime) / 1000) : 0;
  if (status) status.className = 'status-success'; status.textContent = '✅ 扫描完成，发现 ' + count + ' 个空目录，耗时 ' + elapsed + 's';
  const cntEl = $('empty-count'); if (cntEl) cntEl.textContent = count;
  const penEl = $('empty-pending'); if (penEl) penEl.textContent = count;
  const elEl = $('empty-elapsed'); if (elEl) elEl.textContent = elapsed + 's';
  const bar = $('emptyProgressBar'); if (bar) bar.style.width = '100%';
  if (count === 0) {
    if (emptyEl) { emptyEl.style.display = ''; const h3 = emptyEl.querySelector('h3'); if (h3) h3.textContent = '🎉 未发现空目录'; }
    if (list) list.innerHTML = '';
  } else {
    if (emptyEl) emptyEl.style.display = 'none';
    renderEmptyList(items);
    if (resultsEl) resultsEl.style.display = '';
  }
  showToast('发现 ' + count + ' 个空目录', count > 0 ? 'info' : 'success');
}

function renderEmptyList(items) {
  const list = $('empty-list');
  if (!list) return;
  list.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'list-scroll';
  const tbl = document.createElement('table');
  tbl.className = 'data-table';
  tbl.style.width = '100%';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th style="width:40px"><input type="checkbox" class="select-all-cb empty-cb" onclick="selectAllEmpty(event)"></th><th>目录路径</th><th style="width:120px">操作</th></tr>';
  tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  items.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td><input type="checkbox" class="empty-cb" data-path="' + escHtml(item.path) + '" onclick="updateEmptySelectInfo()"></td>' +
      '<td title="' + escHtml(item.path) + '">' + escHtml(item.path) + '</td>' +
      '<td><button type="button" class="btn btn-danger btn-sm" data-empty-del="' + escHtml(item.path) + '">🗑</button></td>'
    tbody.appendChild(tr);
    // P0 XSS: 目录名含反斜杠时旧 onclick 转义会被闭合, 改 data-* 绑定
    const delBtn = tr.querySelector('[data-empty-del]');
    if (delBtn) delBtn.onclick = () => confirmEmptyDeleteOne(delBtn.dataset.emptyDel);
  });
  tbl.appendChild(tbody);
  wrapper.appendChild(tbl);
  list.appendChild(wrapper);
  updateEmptySelectInfo();
}

function selectAllEmpty(e) {
  document.querySelectorAll('.empty-cb:not(:disabled)').forEach(cb => cb.checked = e.target.checked);
  updateEmptySelectInfo();
}

function updateEmptySelectInfo() {
  const cbs = document.querySelectorAll('.empty-cb:checked');
  const count = cbs.length;
  const sc = $('emptySelectedCount'); if (sc) sc.textContent = count;
  const db = $('emptyDeleteBtn'); if (db) db.disabled = count === 0;
  const dbH = $('emptyDeleteHeaderBtn'); if (dbH) dbH.disabled = count === 0;
  const si = $('empty-select-info'); if (si) { si.style.display = count > 0 ? '' : 'none'; si.textContent = '已选 ' + count + ' 个目录'; }
}

function showEmptyDeleteModal() {
  const count = document.querySelectorAll('.empty-cb:checked').length;
  if (count === 0) { showToast('请选择要删除的目录', 'error'); return; }
  $('emptyDeleteCount').textContent = count;
  $('emptyDeleteModal')?.classList.add('visible');
}
function hideEmptyDeleteModal() { $('emptyDeleteModal')?.classList.remove('visible'); }

async function confirmEmptyDelete() {
  hideEmptyDeleteModal();
  const paths = [...document.querySelectorAll('.empty-cb:checked')].map(cb => cb.dataset.path);
  const mode = document.querySelector('input[name="emptyDeleteMode"]:checked')?.value || 'trash';
  try {
    const r = await API.post('api/empty_dir/delete', { paths, mode });
    let msg = '已删除 ' + (r.deleted || 0) + ' 个空目录';
    msg += blockedNotice(r);
    if (r.failed && r.failed.length) showToast(msg + '，失败 ' + r.failed.length + ' 个', 'warning');
    else showToast(msg, 'success');
    // Remove deleted from list
    const deletedSet = new Set(paths);
    const remaining = EmptyDirState.items.filter(i => !deletedSet.has(i.path));
    EmptyDirState.items = remaining;
    const count = remaining.length;
    const cntEl = $('empty-count'); if (cntEl) cntEl.textContent = count;
    const penEl = $('empty-pending'); if (penEl) penEl.textContent = count;
    const resultsEl = $('empty-results'), emptyEl = $('empty-empty'), list = $('empty-list');
    if (remaining.length === 0) {
      if (resultsEl) resultsEl.style.display = 'none';
      if (emptyEl) { emptyEl.style.display = ''; const h3 = emptyEl.querySelector('h3'); if (h3) h3.textContent = '🎉 已清理所有空目录'; }
    } else {
      renderEmptyList(remaining);
    }
  } catch(e) { showToast('删除失败: ' + e.message, 'error'); }
}

function confirmEmptyDeleteOne(path) {
  // Select just this one and show modal
  document.querySelectorAll('.empty-cb').forEach(cb => cb.checked = cb.dataset.path === path);
  updateEmptySelectInfo();
  $('emptyDeleteCount').textContent = '1';
  $('emptyDeleteModal')?.classList.add('visible');
}

// ════════════════════════════════
// System Cache Cleaning
// ════════════════════════════════
const SysCleanState = { items: [], scanLoaded: false };

function formatSysCleanBytes(n) {
  if (n === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

const RISK_LABELS = {
  low: { label: '低', color: '#059669', bg: '#dcfce7' },
  medium: { label: '中', color: '#d97706', bg: '#fff7ed' },
  high: { label: '高', color: '#dc2626', bg: '#fee2e2' },
  dangerous: { label: '危险', color: '#dc2626', bg: '#7f1d1d' },
};

// Category badges for sysclean classification (MangoDisk-style buckets).
const CAT_BADGE = {
  system:  { label: '系统', color: '#1d4ed8', bg: '#dbeafe' },
  logs:    { label: '日志', color: '#7c3aed', bg: '#ede9fe' },
  dev:     { label: '开发', color: '#0f766e', bg: '#ccfbf1' },
  browser: { label: '浏览器', color: '#b45309', bg: '#fef3c7' },
  app:     { label: '应用', color: '#be185d', bg: '#fce7f3' },
};

function getSysCleanRiskFilter() {
  return document.querySelector('input[name="syscleanRiskFilter"]:checked')?.value || 'all';
}

async function doSysCleanScan() {
  const btn = $('syscleanScanBtn');
  const status = $('sysclean-status');
  const list = $('sysclean-list');
  const empty = $('sysclean-empty');
  // 这个接口要 3.8~16s, 自动扫描和用户手点很容易撞车(切进分区的同时手点按钮)。
  // 两个响应同时往同一个列表渲染, 后到的会覆盖先到的, 用户看到的是随机一份数据。
  if (_sysCleanScanning) return;
  _sysCleanScanning = true;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span><span>扫描中...</span>'; }
  if (status) { status.className = 'loading'; status.textContent = '⏳ 正在扫描系统缓存...'; }
  if (list) list.innerHTML = '';
  if (empty) empty.style.display = 'none';
  try {
    // ★ 这个接口要 stat 上千个缓存目录, 实测 3.8~16s, 而 API.get 默认超时只有
    // 15s —— 慢的那一半用户必然看到 "signal is aborted without reason"。
    // 手动点扫描时同样会超时, 只是用户会当成自己网络问题, 根本想不到是超时。
    // 给 90s: 上限只是防挂死, 正常情况下 4 秒左右就回来了。
    const data = await API.get('api/sysclean/scan', 90000);
    SysCleanState.items = data.items || [];
    SysCleanState.scanLoaded = true;
    _sysCleanScannedAt = Date.now();
    if ($('sysclean-count')) $('sysclean-count').textContent = data.count || 0;
    if ($('sysclean-total')) $('sysclean-total').textContent = data.total_size_str || '0 B';
    renderSysCleanList();
    if (status) { status.className = 'success'; status.textContent = `✅ 共 ${data.count} 项，可释放 ${data.total_size_str}`; }
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ 扫描失败: ' + e.message; }
  } finally {
    _sysCleanScanning = false;
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>🔍</span><span>扫描缓存</span>'; }
  }
}

function renderSysCleanList() {
  const list = $('sysclean-list');
  if (!list) return;
  const filter = getSysCleanRiskFilter();
  const catFilter = getSysCleanCatFilter();
  const items = SysCleanState.items.filter(it => {
    if (filter === 'low') return it.risk === 'low';
    if (filter === 'medium') return it.risk === 'low' || it.risk === 'medium';
    return true; // 'all' shows everything
  }).filter(it => {
    if (catFilter === 'all') return true;
    return it.category === catFilter;
  });
  if (items.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-secondary)">没有匹配的项</div>';
    return;
  }
  let html = '<div class="list-scroll"><table class="data-table" id="sysclean-table"><thead><tr>' +
    '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="selectAllSysClean(this)"></th>' +
    '<th style="width:64px">风险</th><th style="width:70px">分类</th><th>名称</th><th>路径</th><th style="text-align:right">大小</th>' +
    '</tr></thead><tbody>';
  for (const it of items) {
    const r = RISK_LABELS[it.risk] || RISK_LABELS.low;
    const isDangerous = it.risk === 'dangerous';
    const checked = it.recommended ? 'checked' : '';
    const disabled = isDangerous ? 'disabled' : '';
    const rowStyle = isDangerous ? 'style="opacity:0.6"' : '';
    const riskBadge = `<span class="file-badge" style="background:${r.bg};color:${r.color}">${r.label}</span>`;
    const catBadge = `<span class="file-badge" style="background:${CAT_BADGE[it.category]?.bg||'#eee'};color:${CAT_BADGE[it.category]?.color||'#333'}">${CAT_BADGE[it.category]?.label||it.category||'-'}</span>`;
    html += `<tr ${rowStyle}>
      <td><input type="checkbox" class="sysclean-cb" value="${escHtml(it.id)}" data-size="${it.size}" data-label="${escHtml(it.label)}" onchange="updateSysCleanSelectInfo()" ${checked} ${disabled}></td>
      <td>${riskBadge}</td>
      <td>${catBadge}</td>
      <td style="white-space:nowrap" title="${escHtml(it.label)}">${escHtml(it.name || it.label)}</td>
      <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary);max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(it.path)}">${escHtml(it.path)}</td>
      <td style="text-align:right;font-family:var(--font-mono);font-size:13px">${escHtml(it.size_str)}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  list.innerHTML = html;
  updateSysCleanSelectInfo();
}

function getSysCleanCatFilter() {
  const el = document.querySelector('input[name="syscleanCatFilter"]:checked');
  return el ? el.value : 'all';
}

function selectAllSysClean(el) {
  // Don't toggle dangerous items
  document.querySelectorAll('#sysclean-table .sysclean-cb:not(:disabled)').forEach(cb => cb.checked = el.checked);
  updateSysCleanSelectInfo();
}

function selectAllSysCleanRecommended() {
  // Select only recommended + low/medium risk (skip high/dangerous)
  document.querySelectorAll('#sysclean-table .sysclean-cb').forEach(cb => {
    if (cb.disabled) return; // dangerous
    const r = cb.closest('tr').querySelector('.file-badge')?.textContent || '';
    cb.checked = (r === '低' || r === '中');
  });
  updateSysCleanSelectInfo();
}

function updateSysCleanSelectInfo() {
  const cbs = document.querySelectorAll('.sysclean-cb:checked');
  let total = 0;
  for (const cb of cbs) total += parseInt(cb.dataset.size || 0);
  const count = cbs.length;
  if ($('sysclean-selected-count')) $('sysclean-selected-count').textContent = count;
  const db = $('syscleanDeleteBtn');
  if (db) db.disabled = count === 0;
  const si = $('sysclean-select-info');
  if (si) {
    if (count > 0) { si.style.display = ''; si.textContent = `已选 ${count} 项，可释放 ${formatSysCleanBytes(total)}`; }
    else { si.style.display = 'none'; }
  }
}

function showSysCleanDeleteModal() {
  const cbs = document.querySelectorAll('.sysclean-cb:checked');
  if (cbs.length === 0) { showToast('请选择要清理的项', 'error'); return; }
  let total = 0;
  const items = [];
  for (const cb of cbs) {
    total += parseInt(cb.dataset.size || 0);
    items.push({ id: cb.value, label: cb.dataset.label, size: parseInt(cb.dataset.size || 0) });
  }
  $('syscleanDeleteCount').textContent = cbs.length;
  $('syscleanDeleteSize').textContent = formatSysCleanBytes(total);
  $('syscleanDeletePaths').innerHTML = items
    .sort((a, b) => b.size - a.size)
    .slice(0, 50)
    .map(it => `<div>${escHtml(it.label)} <span style="color:var(--color-text-secondary);font-size:11px">(${formatSysCleanBytes(it.size)})</span></div>`)
    .join('') + (items.length > 50 ? `<div style="color:var(--color-text-secondary)">...还有 ${items.length - 50} 项</div>` : '');
  // Show backup hint if enabled
  const backupCb = $('syscleanBackupCb');
  const backupInfo = $('syscleanBackupInfo');
  if (backupInfo) {
    if (getSysCleanBackupEnabled()) {
      $('syscleanBackupInfoText').textContent = '清理前将先写一份 manifest 到 <PKGVAR>/data/manifests/（仅记录路径/size/mtime，不复制文件内容）';
      backupInfo.style.display = 'block';
    } else {
      backupInfo.style.display = 'none';
    }
  }
  $('syscleanDeleteModal')?.classList.add('visible');
}

function hideSysCleanDeleteModal() { $('syscleanDeleteModal')?.classList.remove('visible'); }

// Backup toggle (persists in localStorage)
const SYSCLEAN_BACKUP_KEY = 'fnclearup.sysclean.backup';
function getSysCleanBackupEnabled() {
  try {
    const v = localStorage.getItem(SYSCLEAN_BACKUP_KEY);
    return v === null ? true : v === '1';  // default ON
  } catch { return true; }
}
function toggleSysCleanBackup() {
  const cb = $('syscleanBackupCb');
  if (!cb) return;
  try { localStorage.setItem(SYSCLEAN_BACKUP_KEY, cb.checked ? '1' : '0'); } catch { console.error('[main.js]'); }
  showToast(cb.checked ? '✅ 已开启清理前备份' : '⚠️ 已关闭清理前备份（不推荐）', cb.checked ? 'success' : 'warning');
}

// History manifests modal
async function showSysCleanManifests() {
  const modal = $('syscleanManifestsModal');
  const list = $('syscleanManifestsList');
  if (!modal || !list) return;
  list.innerHTML = '<div style="color:var(--color-text-secondary)">⏳ 加载中...</div>';
  modal.classList.add('visible');
  try {
    const r = await API.get('api/sysclean/manifests');
    if (!r.manifests || r.manifests.length === 0) {
      list.innerHTML = `<div style="color:var(--color-text-secondary);padding:20px;text-align:center">📭 暂无历史 manifest（开启"清理前备份"开关后，下次清理会自动写入）<br><br><span style="font-size:12px">位置：<code>${escHtml(r.base_dir || '<PKGVAR>/data/manifests')}</code></span></div>`;
      return;
    }
    list.innerHTML = r.manifests.map(m => {
      const t = new Date(m.mtime);
      const tstr = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
      // data-* attrs for download handler (avoid inline JS with embedded user paths)
      return `<div class="sysclean-manifest-row" style="padding:8px;border-bottom:1px solid var(--color-border);display:flex;justify-content:space-between;align-items:center;gap:12px" data-path="${escHtml(m.path)}" data-name="${escHtml(m.name)}">
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:var(--color-text-muted)">${tstr}</div>
          <div style="font-size:11px;color:var(--color-text-secondary);word-break:break-all" title="${escHtml(m.path)}">${escHtml(m.name)}</div>
        </div>
        <span style="font-size:11px;color:var(--color-text-secondary);white-space:nowrap">${escHtml(m.size_str)}</span>
        <button type="button" class="btn btn-outline sysclean-manifest-dl" style="font-size:11px;padding:4px 8px">下载</button>
        <button type="button" class="btn btn-outline sysclean-manifest-view" style="font-size:11px;padding:4px 8px" title="在弹窗里查看 manifest JSON 内容">查看</button>
      </div>`;
    }).join('');
    // Wire up download/view handlers (avoid inline onclick with user-controlled paths)
    list.querySelectorAll('.sysclean-manifest-dl').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const row = e.target.closest('.sysclean-manifest-row');
        if (!row) return;
        downloadSysCleanManifest(row.dataset.path, row.dataset.name);
      });
    });
    list.querySelectorAll('.sysclean-manifest-view').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const row = e.target.closest('.sysclean-manifest-row');
        if (!row) return;
        viewSysCleanManifest(row.dataset.path, row.dataset.name);
      });
    });
  } catch (e) {
    list.innerHTML = `<div style="color:var(--color-danger)">❌ 加载失败: ${escHtml(e.message)}</div>`;
  }
}
function hideSysCleanManifests() { $('syscleanManifestsModal')?.classList.remove('visible'); }

// Download a manifest via fetch → Blob → temporary <a download>. No popup blocker concerns
// since we never open a new window.
async function downloadSysCleanManifest(path, name) {
  try {
    const url = `api/sysclean/manifest?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      let msg = `读取失败 (HTTP ${res.status})`;
      try { const j = await res.json(); if (j.error) msg = `读取失败: ${j.error}`; } catch { console.error('[main.js]'); }
      showToast(msg, 'error', 5000);
      return;
    }
    // 取成文本后交给「选择保存位置」弹窗, 不再走浏览器下载 ——
    // manifest 是 JSON, text() 足够, 也不必把内容再 base64 一遍。
    const text = await res.text();
    const fname = name || 'manifest.json';
    if (!saveContentViaBrowser(text, fname)) return;
    showToast(`已读取 ${fname}，请选择保存位置`, 'info', 3000);
  } catch (e) {
    showToast('读取失败: ' + e.message, 'error', 5000);
  }
}

// View a manifest inline (in a sub-modal) so users can preview without downloading
async function viewSysCleanManifest(path, name) {
  // Open a new modal layered on top
  let m = $('syscleanManifestViewer');
  if (!m) {
    m = document.createElement('div');
    m.id = 'syscleanManifestViewer';
    m.className = 'modal-overlay';
    m.innerHTML = `<div class="modal modal-md" style="max-width:880px;max-height:80vh;display:flex;flex-direction:column">
      <h3><span>👁</span><span>Manifest 内容</span></h3>
      <pre id="syscleanManifestViewerPre" style="flex:1;overflow:auto;background:var(--color-bg-secondary);padding:12px;border-radius:6px;font-size:11px;line-height:1.5;margin:8px 0;white-space:pre-wrap;word-break:break-all"></pre>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" onclick="document.getElementById('syscleanManifestViewer').classList.remove('visible')">关闭</button>
      </div>
    </div>`;
    document.body.appendChild(m);
  }
  const pre = $('syscleanManifestViewerPre');
  if (pre) pre.textContent = '⏳ 加载中...';
  m.classList.add('visible');
  try {
    const res = await fetch(`api/sysclean/manifest?path=${encodeURIComponent(path)}`, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      let msg = `加载失败 (HTTP ${res.status})`;
      try { const j = await res.json(); if (j.error) msg = `加载失败: ${j.error}`; } catch { console.error('[main.js]'); }
      if (pre) pre.textContent = msg;
      return;
    }
    const data = await res.json();
    if (pre) pre.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    if (pre) pre.textContent = '❌ ' + e.message;
  }
}

async function doSysCleanDelete() {
  hideSysCleanDeleteModal();
  const cbs = document.querySelectorAll('.sysclean-cb:checked');
  const ids = [...cbs].map(cb => cb.value);
  if (ids.length === 0) return;
  const btn = $('syscleanDeleteBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span><span>清理中...</span>'; }
  const doBackup = getSysCleanBackupEnabled();
  try {
    const r = await API.post('api/sysclean/clean', { ids, backup: doBackup });
    if (r.backup_error) {
      showToast('⚠️ 备份 manifest 失败，已中止清理（请检查 <PKGVAR>/data/manifests 写入权限）: ' + r.error, 'error', 6000);
      return;
    }
    let msg = `已清理 ${r.total || 0} 项`;
    if (r.backup_path) msg += ` · 📦 ${r.backup_path}`;
    if (r.failed && r.failed.length) {
      showToast(msg + `，失败 ${r.failures} 个`, 'warning', 6000);
    } else {
      showToast(msg, 'success', 5000);
    }
    // Reload the scan
    await doSysCleanScan();
  } catch (e) {
    showToast('清理失败: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>🗑</span><span>清理选中</span>'; }
  }
}

// Re-render the sysclean list when risk filter changes
document.addEventListener('change', (e) => {
  if (e.target && e.target.name === 'syscleanRiskFilter') {
    if (SysCleanState.scanLoaded) renderSysCleanList();
  }
});

// ════════════════════════════════
// 用户清理（清理回收 → 用户）
// ════════════════════════════════
// 列出 /etc/passwd 账号，默认隐藏系统自带账号（uid < 900）。能否删除由**服务端**
// 判定（系统核心账号 / 应用仍在安装 / 有进程在运行），前端只负责把结果标灰并解释原因。
const USERS_SHOW_SYSTEM_KEY = 'fnclearup.users.showSystem';
let _usersCache = [];
// docker 判据是否真的生效：false 时说明「没检出 Docker 占用」这个结论不可信，要在界面上讲清楚
let _usersDockerAvailable = true;
let _usersDockerError = '';

function getUsersShowSystem() {
  try { return localStorage.getItem(USERS_SHOW_SYSTEM_KEY) === '1'; } catch { return false; }
}
function toggleUsersShowSystem() {
  const cb = $('usersShowSystemCb');
  try { localStorage.setItem(USERS_SHOW_SYSTEM_KEY, cb && cb.checked ? '1' : '0'); } catch (e) { console.error('[main.js]', e); }
  renderUsers();
}

async function loadUsers() {
  const status = $('users-status');
  const btn = $('usersRefreshBtn');
  if (btn) btn.disabled = true;
  if (status) { status.className = ''; status.textContent = '⏳ 正在读取账号列表...'; }
  try {
    const d = await API.get('api/users');
    if (!d || !d.success) throw new Error((d && d.error) || '读取失败');
    _usersCache = d.users || [];
    _usersDockerAvailable = d.docker_available !== false;
    _usersDockerError = d.docker_error || '';
    const s = d.stats || {};
    if ($('users-total')) $('users-total').textContent = s.total ?? '-';
    if ($('users-app')) $('users-app').textContent = s.app ?? '-';
    if ($('users-system')) $('users-system').textContent = s.system ?? '-';
    if ($('users-deletable')) $('users-deletable').textContent = s.deletable ?? '-';
    const scb = $('usersShowSystemCb'); if (scb) scb.checked = getUsersShowSystem();
    // 成功时不写摘要：账号总数/应用/系统/可删除 已在上面 4 张 KPI 卡片里，
    // 再打一行「共 N 个账号…」是纯重复。这里只清掉上一次的错误文案。
    // 但 Docker 判据没跑起来必须说：否则「查不到 Docker 占用」会被误读成「没被占用」。
    if (status) {
      status.className = '';
      status.textContent = _usersDockerAvailable ? ''
        : `⚠️ Docker 未检测（${_usersDockerError || 'docker 命令不可用'}）：无法确认账号是否被 Docker 容器使用，请留意`;
      if (!_usersDockerAvailable) status.className = 'warning';
    }
    renderUsers();
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ ' + e.message; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function usersKindBadge(kind) {
  if (kind === 'app') return '<span class="file-badge" style="background:#eef2ff;color:#6366f1">应用</span>';
  if (kind === 'system') return '<span class="file-badge" style="background:#f1f5f9;color:#64748b">系统</span>';
  return '<span class="file-badge" style="background:#f0fdf4;color:#059669">用户</span>';
}

// Docker 占用标记：容器在用它（运行账号 / 挂载目录 owner），删了容器就写不进数据目录
function usersDockerBadge(u) {
  if (!u || !u.docker || !u.docker.container) return '';
  const tip = `Docker 容器「${u.docker.container}」${u.docker.via ? '：' + u.docker.via : ''}`;
  return `<span class="file-badge" style="background:#e0f2fe;color:#0284c7;margin-left:4px" title="${escHtml(tip)}">Docker</span>`;
}

function renderUsers() {
  const list = $('users-list'), empty = $('users-empty');
  if (!list) return;
  const showSystem = getUsersShowSystem();
  const rows = _usersCache.filter(u => showSystem || u.kind !== 'system');
  if (!rows.length) {
    list.innerHTML = '';
    if (empty) {
      empty.style.display = '';
      const h = empty.querySelector('h3'); if (h) h.textContent = _usersCache.length ? '系统自带账号已隐藏' : '没有读到任何账号';
    }
    updateUsersSelectInfo();
    return;
  }
  if (empty) empty.style.display = 'none';
  let html = '<div class="list-scroll"><table class="data-table" id="users-table"><thead><tr>' +
    '<th style="width:36px"><input type="checkbox" class="users-cb-all" onchange="selectAllUsers(this)"></th>' +
    '<th>用户名</th><th style="width:64px">UID</th><th style="width:64px">GID</th>' +
    '<th style="width:64px">类型</th><th style="width:22%">家目录</th><th>说明</th>' +
    '</tr></thead><tbody>';
  for (const u of rows) {
    const tips = [u.reason, u.warn, u.docker ? `Docker 容器「${u.docker.container}」：${u.docker.via || ''}` : ''].filter(Boolean).join(' / ');
    html += `<tr${u.deletable ? '' : ' style="opacity:.55"'}>
      <td><input type="checkbox" class="users-cb" value="${escHtml(u.name)}" ${u.deletable ? '' : 'disabled'} onchange="updateUsersSelectInfo()"></td>
      <td><span title="${escHtml(u.name)}">${escHtml(u.name)}</span></td>
      <td style="font-family:var(--font-mono);font-size:13px">${u.uid}</td>
      <td style="font-family:var(--font-mono);font-size:13px">${u.gid}</td>
      <td style="white-space:nowrap">${usersKindBadge(u.kind)}${usersDockerBadge(u)}</td>
      <td style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escHtml(u.home || '-')}">${escHtml(u.home || '-')}</td>
      <td style="font-size:12px;color:${u.deletable ? 'var(--color-text-secondary)' : 'var(--color-danger)'}" title="${escHtml(tips)}">${escHtml(u.deletable ? (u.warn || '可删除') : u.reason)}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  list.innerHTML = html;
  updateUsersSelectInfo();
}

function selectAllUsers(el) {
  document.querySelectorAll('#users-table .users-cb:not(:disabled)').forEach(cb => { cb.checked = !!el.checked; });
  updateUsersSelectInfo();
}

function selectedUserNames() {
  return [...document.querySelectorAll('#users-table .users-cb:checked')].map(cb => cb.value);
}

function updateUsersSelectInfo() {
  const names = selectedUserNames();
  const btn = $('usersDeleteBtn');
  if (btn) btn.disabled = names.length === 0;
  const si = $('users-select-info');
  if (si) {
    si.style.display = names.length ? '' : 'none';
    si.textContent = `已选 ${names.length} 个账号`;
  }
}

function showUsersDeleteModal() {
  const names = selectedUserNames();
  if (!names.length) { showToast('请先勾选要删除的账号', 'warning'); return; }
  const byName = new Map(_usersCache.map(u => [u.name, u]));
  if ($('usersDeleteCount')) $('usersDeleteCount').textContent = String(names.length);
  if ($('usersDeleteNames')) {
    $('usersDeleteNames').innerHTML = names.map(n => {
      const u = byName.get(n) || {};
      return `${escHtml(n)} <span style="color:var(--color-text-muted)">uid ${u.uid ?? '?'} · ${escHtml(u.home || '-')}</span>`;
    }).join('<br>');
  }
  // 所选账号里有「家目录不能删」的（如 /home 之下只有一层或卷根）→ 禁用该勾选项
  const anyUnsafe = names.some(n => !(byName.get(n) || {}).home_removable);
  const homeCb = $('usersDeleteRemoveHome');
  if (homeCb) {
    homeCb.checked = false;
    homeCb.disabled = anyUnsafe;
    homeCb.title = anyUnsafe ? '所选账号里有家目录不允许删除，无法勾选' : '';
  }
  const ack = $('usersDeleteAck'); if (ack) ack.checked = false;
  const ok = $('usersDeleteConfirmBtn'); if (ok) ok.disabled = true;
  const tip = $('usersDeleteBatchTip');
  if (tip) {
    if (names.length > USERS_DELETE_BATCH) {
      tip.style.display = '';
      tip.textContent = `超过 ${USERS_DELETE_BATCH} 个会自动分批提交（每批 ${USERS_DELETE_BATCH} 个），全部完成后汇总结果`;
    } else {
      tip.style.display = 'none';
      tip.textContent = '';
    }
  }
  const m = $('usersDeleteModal'); if (m) m.classList.add('visible');
}

function hideUsersDeleteModal() {
  const m = $('usersDeleteModal'); if (m) m.classList.remove('visible');
}

function usersRefreshConfirmBtn() {
  const ack = $('usersDeleteAck');
  const btn = $('usersDeleteConfirmBtn');
  if (btn) btn.disabled = !(ack && ack.checked);
}

// 后端单次最多删 MAX_DELETE_PER_RUN(20) 个；「全选」可能有几十个账号，
// 所以按批串行提交 —— 一批被拒（参数/鉴权问题）就停，不再继续，避免刷一堆同样的错误。
const USERS_DELETE_BATCH = 20;

async function confirmUsersDelete() {
  const names = selectedUserNames();
  if (!names.length) { hideUsersDeleteModal(); return; }
  const homeCb = $('usersDeleteRemoveHome');
  const removeHome = !!(homeCb && homeCb.checked && !homeCb.disabled);
  hideUsersDeleteModal();

  const st = $('users-status');
  const deleted = [], failed = [], skipped = [];
  let firstError = '';

  for (let i = 0; i < names.length; i += USERS_DELETE_BATCH) {
    const chunk = names.slice(i, i + USERS_DELETE_BATCH);
    if (st && names.length > USERS_DELETE_BATCH) {
      st.className = '';
      st.textContent = `⏳ 正在删除 ${i + 1}-${Math.min(i + chunk.length, names.length)} / ${names.length} ...`;
    }
    let d;
    try {
      d = await API.post('api/users/delete', {
        ack: true,
        users: chunk.map(name => ({ name, removeHome })),
      });
    } catch (e) {
      firstError = e.message || String(e);
      failed.push(...chunk.map(name => ({ name, reason: firstError })));
      break;
    }
    // 注意: API.post 对 4xx **不抛异常**（见 parseFetchResponse），只带 __ok=false。
    // 原来直接读 d.deleted 会得到空数组，界面上就成了「已删除 0 个账号」—— 真实原因被吃掉。
    if (!d || d.__ok === false || d.success === false) {
      firstError = (d && (d.__error || d.error)) || '请求被拒绝';
      failed.push(...chunk.map(name => ({ name, reason: firstError })));
      break;
    }
    deleted.push(...(d.deleted || []));
    failed.push(...(d.failed || []));
    skipped.push(...(d.skipped || []));
  }

  const parts = [];
  if (deleted.length) parts.push(`已删除 ${deleted.length} 个账号`);
  if (failed.length) parts.push(`${failed.length} 个失败`);
  if (skipped.length) parts.push(`${skipped.length} 个账号不存在`);
  if (deleted.length) {
    showToast(parts.join('，'), failed.length ? 'warning' : 'success');
  } else {
    // 一个都没删掉时必须说清原因，不能只报「删除 0 个」
    showToast('删除失败：' + (firstError || (failed[0] && failed[0].reason) || '没有账号被删除'), 'error');
  }

  if (st) {
    const problems = failed.filter(f => f.reason);
    if (problems.length) {
      st.className = 'error';
      st.textContent = `⚠️ ${deleted.length ? '部分失败' : '删除失败'} — ` +
        problems.map(f => `${f.name}: ${f.reason}`).join('；');
    } else if (deleted.length) {
      st.className = 'success';
      st.textContent = `✅ 已删除：${deleted.map(x => x.name + (x.home_removed ? '(含家目录)' : '')).join('、')}`;
    }
  }
  await loadUsers();
}

// ════════════════════════════════
// Startup warning modal
// ════════════════════════════════
let _startupCountdownTimer = null;
let _startupCountdownLeft = 3;

// ── 启动风险提示偏好 ─────────────────────────────────────────────────────
//
// 稳定性要求：这个开关以前只存 localStorage，结果是「有时生效、有时又弹」——
// 因为应用会同时跑在「应用中心 iframe」和「CEF 独立新窗口」两种上下文，
// 两者 localStorage 可能是不同存储分区，有的环境还直接禁用/清空。
//
// 现在：
//   · 服务端 /api/prefs（<TRM_PKGVAR>/data/ui-prefs.json）是唯一真理源
//   · localStorage 只当本地缓存，用于「首屏立刻决定弹不弹」的快速路径
//   · 首屏本地没缓存（首次运行 / localStorage 被禁）时，等后端说了算再决定
//   · 一次页面加载最多弹一次（_startupWarnShown），杜绝重复触发
const STARTUP_ALWAYS_KEY = 'fnclearup.startup.warnAlways';
let _warnAlways = null;          // null = 还没从任何来源拿到
let _startupWarnShown = false;   // 本次页面加载是否已经弹过

function readLocalWarnAlways() {
  try {
    const v = localStorage.getItem(STARTUP_ALWAYS_KEY);
    return v === null ? null : v === '1';
  } catch { return null; }   // 读不了 ≠ 用户选了「弹」，返回 null 表示「不知道」
}
function writeLocalWarnAlways(on) {
  try { localStorage.setItem(STARTUP_ALWAYS_KEY, on ? '1' : '0'); } catch { /* 存不了就算了，服务端才是真理源 */ }
}

/** 当前生效值：内存 > localStorage > 安全默认（弹） */
function getStartupWarningAlways() {
  if (typeof _warnAlways === 'boolean') return _warnAlways;
  const local = readLocalWarnAlways();
  if (local !== null) return local;
  return true;
}

/** 从后端拉真值并覆盖本地缓存；后端不可达时回退到本地值。 */
async function loadStartupWarningPref() {
  try {
    const r = await API.get('api/prefs', 2500);
    if (r && r.prefs && typeof r.prefs.startup_warn_always === 'boolean') {
      _warnAlways = r.prefs.startup_warn_always;
      writeLocalWarnAlways(_warnAlways);
      return _warnAlways;
    }
  } catch (e) {
    console.error('[main.js] 读取偏好失败，回退本地缓存', e);
  }
  const local = readLocalWarnAlways();
  _warnAlways = (local === null) ? true : local;
  return _warnAlways;
}

function syncStartupWarningChecks() {
  const on = getStartupWarningAlways();
  for (const id of ['startupWarningAlwaysCb', 'startupWarningSettingCb']) {
    const cb = $(id);
    // 只在真不一样时写，避免无谓地触发浏览器的 checked 变更
    if (cb && cb.checked !== on) cb.checked = on;
  }
}

/**
 * 用户改开关。**显式传来源**（'modal' / 'setting'），
 * 不再靠「谁的 checked 和旧值不同」来猜是哪只框被点了 ——
 * 那种猜法在两只框状态不一致时会选错，也是「改了没生效」的来源之一。
 */
async function setStartupWarnFrom(source) {
  const cbId = source === 'modal' ? 'startupWarningAlwaysCb' : 'startupWarningSettingCb';
  const cb = $(cbId);
  const on = !!(cb && cb.checked);
  const prev = getStartupWarningAlways();
  if (on === prev) { syncStartupWarningChecks(); return; }

  // 乐观更新：界面先跟手，再去落盘
  _warnAlways = on;
  syncStartupWarningChecks();
  writeLocalWarnAlways(on);

  try {
    const r = await API.post('api/prefs', { prefs: { startup_warn_always: on } }, 8000);
    if (!r || r.success === false) throw new Error((r && r.error) || '保存失败');
    showToast(on ? '✅ 已开启：每次进入应用都弹风险提示'
                 : '👍 已关闭：以后不再自动弹（「系统清理」页可重新开启）', on ? 'success' : 'info');
  } catch (e) {
    // 落盘失败必须回滚，否则界面显示「关了」、下次进来又弹 —— 正是用户遇到的现象
    _warnAlways = prev;
    syncStartupWarningChecks();
    writeLocalWarnAlways(prev);
    showToast('保存失败（' + e.message + '），设置没有生效', 'error');
  }
}

/** 兼容旧调用点（HTML 已改成显式传来源，这里保留但不推荐用）。 */
function toggleStartupWarningAlways() {
  const a = $('startupWarningAlwaysCb');
  const b = $('startupWarningSettingCb');
  // 取「当前真的和生效值不同」的那只；都一样就按 modal 那只处理
  const cur = getStartupWarningAlways();
  if (a && a.checked !== cur) return setStartupWarnFrom('modal');
  if (b && b.checked !== cur) return setStartupWarnFrom('setting');
  return setStartupWarnFrom('modal');
}

/** 一次页面加载最多弹一次。所有「可能想弹」的路径都走这里。 */
function maybeShowStartupWarning() {
  if (_startupWarnShown) return false;
  syncStartupWarningChecks();
  if (!getStartupWarningAlways()) return false;
  _startupWarnShown = true;
  showStartupWarning();
  return true;
}

/**
 * 首屏入口。
 * 本地有缓存 → 立刻按本地值决定（不闪、不等网络）；
 * 本地没缓存 → 等后端（这才是「从没设过 / localStorage 被禁」的机器）。
 * 两种情况都会在后台跟服务端对齐一次，让缓存与勾选框保持一致。
 */
function initStartupWarning() {
  // 一律先问服务端再决定。
  //
  // 为什么不「本地优先、再后台对齐」：那样在「本地缓存说弹、服务端说关」时会先弹一次
  // 再对齐 —— 用户看到的就是"我明明关了，它又弹了一次"。宁可等这一次网络往返
  // （同机 socket 通常 2~5ms），也不要弹出不该弹的东西。
  // 后端不可达时 loadStartupWarningPref 会回退到本地缓存，最长等 2.5s。
  loadStartupWarningPref().then(() => maybeShowStartupWarning())
    .catch(() => maybeShowStartupWarning());
}

// ── Trash tab ──
let _trashLastScan = null;
let _trashCleanAge = 30;

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2) + ' ' + u[i];
}

async function trashScan() {
  const btn = $('trashScanBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span><span>扫描中...</span>'; }
  $('trash-status').innerHTML = '<div class="kpi-loading">⏳ 扫描所有 vol/UID 下的 trash 目录...</div>';
  try {
    const r = await API.get('api/trash/scan');
    if (!r || !r.ok) {
      $('trash-status').innerHTML = '<div class="kpi-error">❌ 扫描失败：' + escHtml((r && r.error) || 'unknown') + '</div>';
      return;
    }
    _trashLastScan = r;
    // KPI
    const b = r.buckets || {};
    const totalCleanable = (b.lt90?.size || 0) + (b.lt365?.size || 0) + (b.gte365?.size || 0);
    $('trashKpi30').textContent = formatBytes(b.lt90?.size || 0);
    $('trashKpi90').textContent = formatBytes(b.lt365?.size || 0);
    $('trashKpi365').textContent = formatBytes(b.gte365?.size || 0);
    $('trashKpiTotal').textContent = formatBytes(r.totals?.size || 0);
    $('trashKpiTopDirs').textContent = (r.trashList || []).reduce((s, t) => s + (t.dirs || 0), 0);

    // List all trash dirs (root 包含所有用户)
    const list = $('trash-list');
    if (!r.trashList || r.trashList.length === 0) {
      list.innerHTML = '<div class="kpi-info">✨ 没有任何用户的 trash 目录（可能还没被用过回收站功能）</div>';
    } else {
      // Desktop: <table>; Mobile (CSS hides table): card list
      let html = '<div class="data-table"><table><thead><tr><th>卷</th><th>UID</th><th>路径</th><th>文件数</th><th>目录数</th><th>大小</th><th>最老 mtime</th></tr></thead><tbody>';
      for (const t of r.trashList) {
        const mtime = t.mtime ? new Date(t.mtime).toLocaleString('zh-CN') : '?';
        html += `<tr>
          <td>${escHtml(t.vol)}</td>
          <td>${escHtml(t.uid)}</td>
          <td><code>${escHtml(t.path)}</code></td>
          <td>${t.files}</td>
          <td>${t.dirs}</td>
          <td><strong>${formatBytes(t.size)}</strong></td>
          <td><small>${escHtml(mtime)}</small></td>
        </tr>`;
      }
      html += '</tbody></table></div>';
      // Mobile cards
      html += '<div class="trash-mobile-card">';
      for (const t of r.trashList) {
        const mtime = t.mtime ? new Date(t.mtime).toLocaleString('zh-CN') : '?';
        html += `<div class="trash-card">
          <div class="trash-card-head">
            <span style="font-weight:600" title="${escHtml(t.vol)} · UID ${escHtml(t.uid)}">${escHtml(t.vol)} · UID ${escHtml(t.uid)}</span>
            <span style="color:var(--color-danger);font-weight:600">${formatBytes(t.size)}</span>
          </div>
          <div class="trash-card-path" title="${escHtml(t.path)}">${escHtml(t.path)}</div>
          <div class="trash-card-stats">
            <span>📄 <strong>${t.files}</strong> 文件</span>
            <span>📁 <strong>${t.dirs}</strong> 目录</span>
            <span>🕒 ${escHtml(mtime)}</span>
          </div>
        </div>`;
      }
      html += '</div>';
      list.innerHTML = html;
    }

    // 清空"其他用户"段（已合并到 trashList）
    const other = $('trash-other');
    if (other) other.innerHTML = '';

    $('trash-status').innerHTML = '<div class="kpi-info">✅ 扫描完成：' + formatBytes(r.totals?.size || 0) + '，其中 30+ 天可清 ' + formatBytes(totalCleanable) + '</div>';
    $('trash-empty').style.display = 'none';
    // 启用清理按钮
    for (const id of ['trashClean30Btn', 'trashClean90Btn', 'trashClean365Btn', 'trashCleanAllBtn', 'trashBrowseBtn']) {
      const b = $(id); if (b) b.disabled = false;
    }
  } catch (e) {
    $('trash-status').innerHTML = '<div class="kpi-error">❌ 扫描失败：' + escHtml(e.message || String(e)) + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>🔍</span><span>扫描回收站</span>'; }
  }
}

function trashClean(ageDays) {
  _trashCleanAge = ageDays;
  if (!_trashLastScan) {
    showToast('请先点击「扫描回收站」', 'warn');
    return;
  }
  // 弹确认框
  // 语义：清理 ageDays 天+ = mtime >= ageDays*86400000 ms
  //   X 越大范围越窄：30+ 最宽，365+ 最窄
  const ageText = ageDays === 0 ? '全部内容（不挑 mtime）' : `mtime 超过 ${ageDays} 天的内容`;
  $('trashDeleteAgeDesc').textContent = '范围：' + ageText;
  // 估算将删数量（按桶名相加）
  // 桶名语义：ltN = mtime < N 天的内容（"lt" = less than）
  // ageDays 天+ = mtime >= ageDays = lt{ageDays 下一档}+ ... + gte365
  const b = _trashLastScan.buckets || {};
  let willDelete = 0, willSize = 0;
  if (ageDays === 0) {
    // 全部 = 5 个桶全加
    willSize = (b.lt7?.size || 0) + (b.lt30?.size || 0) + (b.lt90?.size || 0) + (b.lt365?.size || 0) + (b.gte365?.size || 0);
    willDelete = (b.lt7?.count || 0) + (b.lt30?.count || 0) + (b.lt90?.count || 0) + (b.lt365?.count || 0) + (b.gte365?.count || 0);
  } else if (ageDays === 30) {
    willSize = (b.lt90?.size || 0) + (b.lt365?.size || 0) + (b.gte365?.size || 0);
    willDelete = (b.lt90?.count || 0) + (b.lt365?.count || 0) + (b.gte365?.count || 0);
  } else if (ageDays === 90) {
    willSize = (b.lt365?.size || 0) + (b.gte365?.size || 0);
    willDelete = (b.lt365?.count || 0) + (b.gte365?.count || 0);
  } else if (ageDays === 365) {
    willSize = b.gte365?.size || 0;
    willDelete = b.gte365?.count || 0;
  }
  $('trashDeleteCount').textContent = willDelete;
  $('trashDeleteSize').textContent = formatBytes(willSize);
  // 路径预览：按 mtime 阈值过滤
  const pathsEl = $('trashDeletePaths');
  const now = Date.now();
  const thresholdMs = ageDays > 0 ? now - ageDays * 86400000 : Infinity;
  const previewList = (_trashLastScan.trashList || []).filter(t => {
    if (ageDays === 0) return true;
    if (!t.mtime) return false;
    return new Date(t.mtime).getTime() <= thresholdMs;
  });
  if (previewList.length === 0) {
    pathsEl.innerHTML = '<em style="color:var(--color-text-secondary)">当前没有可清理的内容</em>';
  } else {
    let ph = '<ul style="margin:0;padding-left:20px;list-style:none">';
    for (const t of previewList) {
      ph += `<li style="margin-bottom:6px"><code style="word-break:break-all;font-size:12px">${escHtml(t.path)}</code><br><span style="color:var(--color-text-secondary);font-size:12px">${escHtml(t.vol)} · UID ${escHtml(t.uid)} · ${formatBytes(t.size)}</span></li>`;
    }
    ph += '</ul>';
    pathsEl.innerHTML = ph;
  }
  $('trashDeleteModal').classList.add('visible');
}

function hideTrashDeleteModal() {
  $('trashDeleteModal')?.classList.remove('visible');
}

async function doTrashClean() {
  const age = _trashCleanAge;
  const btn = $('trashDeleteConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = '清理中...'; }
  $('trash-status').innerHTML = '<div class="kpi-loading">⏳ 清理中（写入 manifest + 删除文件）...</div>';
  hideTrashDeleteModal();
  try {
    const r = await API.post('api/trash/clean', { ageDays: age, manifest: true });
    if (!r || !r.ok) {
      $('trash-status').innerHTML = '<div class="kpi-error">❌ 清理失败：' + escHtml((r && r.error) || 'unknown') + '</div>';
      return;
    }
    const deletedCount = (r.deleted || []).length;
    const failedCount = (r.failed || []).length;
    const freedSize = (r.deleted || []).reduce((s, d) => s + (d.size || 0), 0);
    let msg = '✅ 清理完成：删除 ' + deletedCount + ' 个目录，释放 ' + formatBytes(freedSize);
    if (failedCount > 0) msg += '，失败 ' + failedCount + ' 个';
    if (r.manifestPath) msg += '<br><small style="color:var(--color-text-secondary)">📦 manifest: ' + escHtml(r.manifestPath) + '</small>';
    $('trash-status').innerHTML = '<div class="kpi-info">' + msg + '</div>';
    showToast(`清理 ${deletedCount} 项，释放 ${formatBytes(freedSize)}`, 'success');
    // 自动重新扫描
    await trashScan();
  } catch (e) {
    $('trash-status').innerHTML = '<div class="kpi-error">❌ 清理失败：' + escHtml(e.message || String(e)) + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '确认清理'; }
  }
}

async function trashBrowseList() {
  if (!_trashLastScan || !_trashLastScan.trashList || _trashLastScan.trashList.length === 0) {
    showToast('请先扫描回收站', 'warn');
    return;
  }
  $('trashBrowseDesc').textContent = '正在加载所有 vol 的回收站树...';
  $('trashBrowseTree').innerHTML = '<div class="kpi-loading">⏳ 加载中...</div>';
  $('trashBrowseModal').classList.add('visible');
  try {
    let html = '';
    for (const t of _trashLastScan.trashList) {
      html += '<h4 style="margin:8px 0 4px"><code>' + escHtml(t.path) + '</code></h4>';
      const r = await API.get('api/trash/browse?path=' + encodeURIComponent(t.path));
      if (!r || !r.ok) {
        html += '<div class="kpi-error">❌ ' + escHtml((r && r.error) || '加载失败') + '</div>';
        continue;
      }
      html += _renderTrashTree(r.tree, 0);
    }
    $('trashBrowseTree').innerHTML = html || '<em>回收站为空</em>';
    $('trashBrowseDesc').textContent = '共 ' + (_trashLastScan.trashList || []).length + ' 个 trash 目录的完整文件树（只读）';
  } catch (e) {
    $('trashBrowseTree').innerHTML = '<div class="kpi-error">❌ ' + escHtml(e.message || String(e)) + '</div>';
  }
}

function _renderTrashTree(node, depth) {
  if (!node) return '';
  let html = '';
  const indent = depth * 16;
  if (node.type === 'dir') {
    const sizeStr = node.size > 0 ? ' (' + formatBytes(node.size) + ')' : '';
    html += '<div style="padding-left:' + indent + 'px">📁 <strong>' + escHtml(node.name) + '</strong>' + sizeStr + '</div>';
    if (node.children && depth < 4) {
      for (const c of node.children) html += _renderTrashTree(c, depth + 1);
    } else if (node.children && node.children.length > 0) {
      html += '<div style="padding-left:' + (indent + 16) + 'px;color:var(--color-text-secondary)">…(' + node.children.length + ' 项，更深层省略)</div>';
    }
  } else {
    html += '<div style="padding-left:' + indent + 'px;color:var(--color-text-secondary)">📄 ' + escHtml(node.name) + ' · ' + formatBytes(node.size || 0) + '</div>';
  }
  return html;
}

function hideTrashBrowseModal() {
  $('trashBrowseModal')?.classList.remove('visible');
}

// 风险提示弹窗。调用入口统一是 maybeShowStartupWarning()（内部带幂等 + 偏好判断）；
// 本函数自己也幂等（已在显示就不重复初始化，否则倒计时会被重置成 3 秒，
// 看起来就像"又弹了一次"）。"我已知晓风险"按钮禁用 3 秒，强制用户读完。
function showStartupWarning() {
  const modal = $('startupWarningModal');
  if (!modal) return;
  // 已经在显示就不重复初始化（否则倒计时会被重置成 3 秒，看起来像"又弹了一次"）
  if (modal.classList.contains('visible')) return;
  _startupWarnShown = true;
  syncStartupWarningChecks();
  // Reset countdown
  _startupCountdownLeft = 3;
  const btn = $('startupWarningConfirmBtn');
  const cd = $('startupWarningCountdown');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '我已知晓风险（<span id="startupWarningCountdown">3</span>）';
  }
  if (cd) cd.textContent = '3';
  modal.classList.add('visible');
  // Start countdown
  if (_startupCountdownTimer) clearInterval(_startupCountdownTimer);
  _startupCountdownTimer = setInterval(() => {
    _startupCountdownLeft--;
    const cd2 = $('startupWarningCountdown');
    const btn2 = $('startupWarningConfirmBtn');
    if (_startupCountdownLeft <= 0) {
      if (_startupCountdownTimer) { clearInterval(_startupCountdownTimer); _startupCountdownTimer = null; }
      if (cd2) cd2.textContent = '0';
      if (btn2) {
        btn2.disabled = false;
        btn2.innerHTML = '✅ 我已知晓风险';
      }
    } else {
      if (cd2) cd2.textContent = String(_startupCountdownLeft);
    }
  }, 1000);
}

function closeStartupWarning(confirmed) {
  const modal = $('startupWarningModal');
  if (modal) modal.classList.remove('visible');
  if (_startupCountdownTimer) { clearInterval(_startupCountdownTimer); _startupCountdownTimer = null; }
  if (confirmed) {
    // Just a soft toast — the modal is the actual deterrent
    showToast('✅ 已确认。继续操作前请确保已备份重要数据。', 'success', 3000);
    // 风险警告确认后, 再递上一个赞助提醒(内部有 7 天频率控制)
    maybeShowSponsorReminder();
  }
}

// ════════════════════════════════
// Schedule
// ════════════════════════════════

// ── 定时清理状态轮询 ──────────────────────────────────────────────
// 定时任务是在后端后台自动触发的, 前端原本零感知: loadScheduleHistory 只在
// switchTab('schedule') 里被调一次, 于是任务执行完成后「上次运行」和「执行
// 历史」都要等用户切走再切回 tab 才更新 —— 实际使用中表现为"清理完了但历史
// 还是旧的"。
//
// 这里做两件事:
//   1) startSchedulePolling  — 只在「定时清理」tab 可见时轮询, 切走即停,
//      不在其他 tab 空耗请求。
//   2) 拆出 loadScheduleStatus — 轮询只更新只读字段(status/next/runCount/
//      lastRun)。**不能**直接轮询 loadSchedule: 它会重置 scheduleHour/
//      scheduleMinute 和各清理类型 checkbox, 用户正在编辑的配置会被冲掉。
let _schedulePollTimer = 0;
const SCHEDULE_POLL_MS = 5000;

function startSchedulePolling() {
  stopSchedulePolling();
  _schedulePollTimer = setInterval(() => {
    loadScheduleStatus();
    loadScheduleHistory();
  }, SCHEDULE_POLL_MS);
}

function stopSchedulePolling() {
  if (_schedulePollTimer) { clearInterval(_schedulePollTimer); _schedulePollTimer = 0; }
}

// 只刷新只读状态, 不触碰任何表单控件 (见上方注释)
async function loadScheduleStatus() {
  try {
    const data = await API.get('api/schedule');
    if (!data || !data.success) return;
    $('#scheduleStatus').textContent = data.enabled ? '🟢 已启用' : '🔴 已停用';
    $('#scheduleNext').textContent = data.nextRun ? new Date(data.nextRun).toLocaleString('zh-CN') : '-';
    $('#scheduleRunCount').textContent = data.runCount || 0;
    $('#scheduleLastRun').textContent = data.lastRun ? new Date(data.lastRun).toLocaleString('zh-CN') : '-';
  } catch (e) {
    // 轮询里的失败不弹 toast — 短暂网络抖动不该打扰用户
    console.error('[schedule] status poll error:', e);
  }
}

async function loadSchedule() {
  try {
    const data = await API.get('api/schedule');
    if (!data || !data.success) return;
    $('#scheduleEnabled').checked = data.enabled;
    $('#scheduleHour').value = data.hour;
    $('#scheduleMinute').value = data.minute;
    $('#scheduleStatus').textContent = data.enabled ? '🟢 已启用' : '🔴 已停用';
    $('#scheduleNext').textContent = data.nextRun ? new Date(data.nextRun).toLocaleString('zh-CN') : '-';
    $('#scheduleRunCount').textContent = data.runCount || 0;
    $('#scheduleLastRun').textContent = data.lastRun ? new Date(data.lastRun).toLocaleString('zh-CN') : '-';
    // Restore cleanup type checkboxes (new format: objects with sub-options)
    if (data.cleanupTypes) {
      for (const [k, v] of Object.entries(data.cleanupTypes)) {
        const cfg = typeof v === 'object' ? v : { enabled: !!v };
        const masterCb = document.getElementById('sc' + k.charAt(0).toUpperCase() + k.slice(1));
        if (masterCb) masterCb.checked = cfg.enabled;
        // Restore sub-options
        if (k === 'app') {
          const cb = document.getElementById('scAppClean');
          if (cb) cb.checked = cfg.cleanOrphans !== false;
        } else if (k === 'disk') {
          const cb = document.getElementById('scDiskClean');
          if (cb) cb.checked = cfg.cleanResiduals !== false;
        } else if (k === 'docker') {
          const ci = document.getElementById('scDockerImages');
          if (ci) ci.checked = cfg.images !== false;
          const cv = document.getElementById('scDockerVolumes');
          if (cv) cv.checked = cfg.volumes !== false;
          const cn = document.getElementById('scDockerNetworks');
          if (cn) cn.checked = cfg.networks !== false;
        } else if (k === 'temp') {
          const inp = document.getElementById('scTempHours');
          if (inp) inp.value = cfg.olderThanHours || 24;
        } else if (k === 'trash') {
          const cb = document.getElementById('scTrash');
          if (cb) cb.checked = cfg.enabled;
          const inp = document.getElementById('scTrashDays');
          if (inp) inp.value = cfg.olderThanDays || 30;
        }
      }
    }
  } catch (e) {
    console.error('[schedule] load error:', e);
  }
}

async function saveSchedule() {
  const data = {
    enabled: $('#scheduleEnabled').checked,
    hour: parseInt($('#scheduleHour').value) || 3,
    minute: parseInt($('#scheduleMinute').value) || 0,
    cleanupTypes: {
      app: { enabled: $('#scApp').checked, cleanOrphans: $('#scAppClean').checked },
      disk: { enabled: $('#scDisk').checked, cleanResiduals: $('#scDiskClean').checked },
      docker: {
        enabled: $('#scDocker').checked,
        images: $('#scDockerImages').checked,
        volumes: $('#scDockerVolumes').checked,
        networks: $('#scDockerNetworks').checked,
      },
      temp: { enabled: $('#scTemp').checked, olderThanHours: parseInt($('#scTempHours').value) || 24 },
      trash: { enabled: $('#scTrash').checked, olderThanDays: parseInt($('#scTrashDays').value) || 30 },
    },
  };
  try {
    const result = await API.post('api/schedule', data);
    if (result && result.success) {
      showToast('✅ 定时设置已保存', 'success');
      loadSchedule(); // Refresh display
      // 保存会重置服务端状态(下次运行时间/执行计数), 历史区一并强刷
      loadScheduleHistory(true);
    } else {
      showToast('❌ 保存失败', 'error');
    }
  } catch (e) {
    showToast('❌ 保存失败: ' + e.message, 'error');
  }
}

function toggleSchedule() {
  // Just visual feedback, actual save happens on "保存设置" button
  const enabled = $('#scheduleEnabled').checked;
  $('#scheduleStatus').textContent = enabled ? '🟡 已修改（需保存）' : '🔴 已停用';
}

async function triggerSchedule() {
  try {
    const result = await API.post('api/schedule/trigger');
    if (result && result.success) {
      showToast('▶ 定时清理已触发', 'info');
      // 任务在后台跑, 跑完才会往 history 里追加记录。所以:
      //   立即强刷一次(此时可能已有"执行中"的记录)
      //   2s / 5s / 9s 再各强刷一次覆盖任务结束的时刻
      // 之后交给轮询接手。原先只有 setTimeout(loadSchedule, 2000), 且不带
      // force, 历史签名没变就会被跳过 —— 这正是"触发后历史不刷新"的另一半原因。
      _lastHistorySig = null;
      loadSchedule();
      loadScheduleHistory(true);
      [2000, 5000, 9000].forEach(ms => setTimeout(() => {
        loadScheduleStatus();
        loadScheduleHistory(true);
      }, ms));
    } else {
      showToast('❌ 触发失败', 'error');
    }
  } catch (e) {
    showToast('❌ 触发失败: ' + e.message, 'error');
  }
}

function viewScheduleFilesFromAttr(btn) {
  const raw = btn.getAttribute('data-files');
  if (!raw) { showToast('无可查看的文件清单', 'info'); return; }
  let deleted;
  try { deleted = JSON.parse(decodeURIComponent(raw)); } catch { showToast('文件清单数据异常', 'error'); return; }
  let html = '<div class="schedule-files-modal"><h3>🧾 被清理文件清单</h3>';
  if (!deleted || deleted.length === 0) {
    html += '<p style="color:var(--color-text-secondary)">无清理记录</p>';
  } else {
    let hasFiles = false;
    for (const d of deleted) {
      html += `<h4 style="margin:12px 0 4px">${escHtml(d.detail)}</h4>`;
      if (d.files && d.files.length > 0) {
        hasFiles = true;
        html += '<ul class="schedule-file-list" style="display:block">';
        for (const f of d.files) {
          html += '<li>' + escHtml(f) + '</li>';
        }
        html += '</ul>';
      } else {
        html += '<p style="color:var(--color-text-tertiary);font-size:13px;margin:4px 0 8px">（无详细路径记录）</p>';
      }
    }
    if (!hasFiles) {
      html = '<div class="schedule-files-modal"><h3>🧾 被清理文件清单</h3><p style="color:var(--color-text-secondary)">该记录未保存文件级路径，升级后新执行的清理会自动记录。</p>';
    }
  }
  html += '</div>';
  // Show in overlay modal
  const existing = document.getElementById('scheduleFilesModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'scheduleFilesModal';
  modal.className = 'modal-overlay';
  modal.style.display = 'flex';
  modal.innerHTML = `<div class="modal modal-lg" onclick="event.stopPropagation()">
    <div class="modal-header"><span class="modal-title">🧾 被清理文件清单</span>
      <button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div class="modal-body" style="max-height:70vh;overflow-y:auto">${html}</div>
    <div class="modal-footer"><button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">关闭</button></div>
  </div>`;
  modal.addEventListener('click', function() { this.remove(); });
  document.body.appendChild(modal);
}

// force=true 时无视签名强制重绘(切 tab / 保存 / 手动触发后用);
// 轮询时传 false, 历史没变化就整段跳过, 避免表格反复重绘闪烁。
let _lastHistorySig = null;
async function loadScheduleHistory(force) {
  try {
    const data = await API.get('api/schedule/history');
    const list = $('#scheduleHistoryList');
    if (!list) return;
    // 签名 = 条数 + **最后一条**的完成时间。
    // 注意不能取 history[0]: 后端是 history.push() 追加(L336), 最新记录在末尾,
    // history[0] 永远是最旧那条、恒定不变; 而且满 100 条后会被 slice(-100) 裁剪,
    // length 也不再变 —— 取 [0] 的话攒够 100 条后轮询就彻底瞎了。
    const hist = (data && Array.isArray(data.history)) ? data.history : [];
    const newest = hist.length ? hist[hist.length - 1] : null;
    const sig = hist.length + '|' + ((newest && newest.completedAt) || '');
    if (!force && sig === _lastHistorySig) return;
    _lastHistorySig = sig;
    if (!data || !data.history || data.history.length === 0) {
      list.innerHTML = '<p class="schedule-empty">暂无执行记录</p>';
      return;
    }
    let html = '<div class="schedule-history-table"><table><thead><tr><th>时间</th><th>耗时</th><th>清理项</th><th>释放</th><th>结果</th><th></th></tr></thead><tbody>';
    for (const h of data.history) {
      const time = h.completedAt ? new Date(h.completedAt).toLocaleString('zh-CN') : '-';
      const duration = h.duration ? (h.duration / 1000).toFixed(1) + 's' : '-';
      const items = (h.deleted || []).map(d => escHtml(d.detail)).join('<br>') || '无';
      const bytes = h.totalBytes ? formatBytes(h.totalBytes) : '-';
      const errors = (h.errors || []).length;
      const status = errors > 0 ? '⚠️ ' + errors + ' 个错误' : '✅';
      const reportName = h.reportFile || '';
      const reportBtn = reportName ? `<button class="btn btn-ghost btn-xs" data-report="${encodeURIComponent(reportName)}" onclick="viewScheduleReportFromAttr(this)">📄</button>` : '';
      // 文件清单按钮 — 始终显示，弹窗查看
      const filesBtn = `<button class="btn btn-ghost btn-xs" data-files="${encodeURIComponent(JSON.stringify(h.deleted || []))}" onclick="viewScheduleFilesFromAttr(this)">🧾</button>`;
      html += `<tr><td>${escHtml(time)}</td><td>${escHtml(duration)}</td><td>${items}</td><td>${bytes}</td><td>${status}</td><td>${reportBtn}${filesBtn}</td></tr>`;
    }
    html += '</tbody></table></div>';
    list.innerHTML = html;
  } catch (e) {
    console.error('[schedule] history load error:', e);
  }
}

function viewScheduleReportFromAttr(btn) {
  const raw = btn.getAttribute('data-report');
  if (!raw) return;
  viewScheduleReport(decodeURIComponent(raw));
}

async function viewScheduleReport(name) {
  try {
    const data = await API.get('api/schedule/report?name=' + encodeURIComponent(name));
    if (!data || !data.report) { showToast('无法加载报告', 'error'); return; }
    const r = data.report;
    let html = '<div class="report-detail"><h3>定时清理报告</h3>';
    html += `<p><strong>开始时间:</strong> ${new Date(r.startedAt).toLocaleString('zh-CN')}</p>`;
    html += `<p><strong>完成时间:</strong> ${new Date(r.completedAt).toLocaleString('zh-CN')}</p>`;
    html += `<p><strong>耗时:</strong> ${(r.duration / 1000).toFixed(1)}s</p>`;
    if (r.deleted && r.deleted.length > 0) {
      html += '<h4>清理明细</h4><ul>';
      for (const d of r.deleted) {
        html += `<li>${escHtml(d.detail || d.type + ': ' + (d.count || 0) + '项')}</li>`;
      }
      html += '</ul>';
    }
    if (r.errors && r.errors.length > 0) {
      html += '<h4>错误</h4><ul style="color:var(--color-danger)">';
      for (const e of r.errors) html += `<li>${escHtml(e.type)}: ${escHtml(e.error)}</li>`;
      html += '</ul>';
    }
    html += '</div>';
    // Show in a modal or overlay
    const existing = document.getElementById('scheduleReportModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'scheduleReportModal';
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `<div class="modal modal-lg" onclick="event.stopPropagation()">
      <div class="modal-header"><span class="modal-title">📋 清理报告</span>
        <button class="btn-icon" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="modal-body" style="max-height:70vh;overflow-y:auto">${html}</div>
      <div class="modal-footer"><button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()">关闭</button></div>
    </div>`;
    modal.addEventListener('click', function() { this.remove(); });
    document.body.appendChild(modal);
  } catch (e) {
    showToast('加载报告失败: ' + e.message, 'error');
  }
}

// ════════════════════════════════
// Init
// ════════════════════════════════
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
else init();

function init() {
  initTheme();
  initLucide();
  doScan();

  // Check version from FnDepot
  checkVersion();

  // Load schedule config
  loadSchedule();

  // Render initial dup path lists
  renderDupPaths('music');
  renderDupPaths('files');
    // 2026-10-01: 相似/异常/重名/大文件 与去重共用同一套路径列表组件
    ['simdup','broken','name','bigfiles'].forEach(t => renderDupPaths(t));

  // Export all functions to window for inline onclick and event delegation
// ══════════════════════════ 内核清理 ══════════════════════════
// 数据全部来自后端 /api/kernel/scan（root 进程读 /boot + /lib/modules + dpkg），
// 前端只负责展示与选择。删除走 /api/kernel/delete，后端会用 apt-get purge 整组清。
let kernelState = { data: null, selected: new Set(), dry: null, dryLoading: false };

async function kernelScan() {
  const status = $('kernel-status'), list = $('kernel-list'), empty = $('kernel-empty');
  const btn = $('kernelScanBtn');
  if (btn) btn.disabled = true;
  if (status) { status.className = ''; status.textContent = '⏳ 正在扫描 /boot 与 /lib/modules…'; }
  try {
    const data = await API.get('api/kernel/scan', 60000);
    if (!data || data.success === false) throw new Error((data && data.error) || '扫描失败');
    kernelState.data = data;
    kernelState.selected = new Set();
    renderKernelList();
    if (empty) empty.style.display = 'none';
    if (status) {
      status.className = 'success';
      status.textContent = `✅ 找到 ${data.count} 套内核，建议清理 ${data.deletable_count} 套（约 ${data.reclaimable_str}）`;
    }
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ ' + e.message; }
    if (list) list.innerHTML = '';
    if (empty) empty.style.display = '';
  } finally {
    if (btn) btn.disabled = false;
    if (typeof lucide !== 'undefined') { try { lucide.createIcons(); } catch (err) { console.error('[main.js]', err); } }
  }
}

function renderKernelList() {
  const d = kernelState.data;
  const list = $('kernel-list');
  if (!d || !list) return;

  // KPI
  if ($('kernel-count')) $('kernel-count').textContent = d.count || 0;
  if ($('kernel-running')) $('kernel-running').textContent = d.running || '-';
  if ($('kernel-reclaim')) $('kernel-reclaim').textContent = d.reclaimable_str || '0 B';
  // APT 缓存：只有 .deb 才是真能清掉的量。0 个 .deb 时界面上不要说还有缓存，
  // 否则用户点了清理、数字纹丝不动（目录 inode 开销约 16K 清不掉），
  // 看起来就像「清理根本没生效」。
  const apc = d.apt_cache || {};
  if ($('kernel-aptcache')) {
    $('kernel-aptcache').textContent = (apc.files || 0) > 0 ? (apc.size_str || '0 B') : '0 B';
  }

  // 表格
  let html = '<div class="list-scroll"><table class="data-table" id="kernel-table"><thead><tr>' +
    '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="selectAllKernel(this)"></th>' +
    '<th>内核版本</th><th>状态</th><th>大小</th><th>安装包</th></tr></thead><tbody>';
  for (const k of (d.kernels || [])) {
    const badges = [];
    if (k.running) badges.push('<span class="kernel-badge run">运行中</span>');
    if (k.suggest_keep && !k.running) badges.push('<span class="kernel-badge keep">建议保留</span>');
    if (k.grub_default) badges.push('<span class="kernel-badge grub">GRUB 默认启动</span>');
    if (k.hold) badges.push('<span class="kernel-badge hold">hold</span>');
    if (!k.deletable && !k.running) badges.push('<span class="kernel-badge hold">不可自动清理</span>');
    const pkgTitle = (k.packages || []).join(' ') || k.reason || '';
    html += `<tr class="${k.deletable ? '' : 'row-disabled'}">
      <td><input type="checkbox" class="kernel-cb" value="${escHtml(k.version)}" ${k.deletable ? '' : 'disabled'} onchange="updateKernelSelectInfo()"></td>
      <td style="font-family:var(--font-mono)">${escHtml(k.version)}</td>
      <td>${badges.join('') || '<span style="color:var(--color-text-tertiary)">可清理</span>'}</td>
      <td style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-secondary)">${escHtml(k.size_str)}</td>
      <td><div class="kernel-pkgs" title="${escHtml(pkgTitle)}">${escHtml((k.packages || []).join('  ') || k.reason || '-')}</div></td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  list.innerHTML = html;

  // 顺带可清（APT 缓存 + rc 残留）
  const extras = $('kernel-extras'), card = $('kernel-extras-card');
  if (extras && card) {
    const ap = d.apt_cache || {};
    const rc = d.rc_packages || [];
    if ((ap.size || 0) > 0 || rc.length) {
      let eh = '<div class="kernel-hint" style="margin-top:0">';
      eh += `<span>📦</span><span>APT 下载缓存：<b>${escHtml(ap.size_str || '0 B')}</b>（${ap.files || 0} 个 .deb，清理后不影响已装软件）`;
      if (rc.length) {
        eh += `<br>残留配置包 <b>${rc.length}</b> 个：<code>${escHtml(rc.slice(0, 8).join(' '))}${rc.length > 8 ? ' …' : ''}</code>`
          + `　<button type="button" class="btn btn-outline btn-xs" onclick="purgeRcPackages()"><span>🧹</span><span>清理残留配置包</span></button>`;
      }
      eh += '</span></div>';
      extras.innerHTML = eh;
      card.style.display = '';
    } else {
      card.style.display = 'none';
    }
  }
  updateKernelSelectInfo();
}

function updateKernelSelectInfo() {
  const cbs = Array.from(document.querySelectorAll('.kernel-cb:checked'));
  kernelState.selected = new Set(cbs.map(cb => cb.value));
  const btn = $('kernelDeleteBtn');
  if (btn) btn.disabled = cbs.length === 0;
  const si = $('kernel-select-info');
  if (si) {
    if (cbs.length === 0) { si.style.display = 'none'; }
    else {
      let size = 0;
      const d = kernelState.data;
      for (const v of kernelState.selected) {
        const k = (d && d.kernels || []).find(x => x.version === v);
        if (k) size += k.size || 0;
      }
      si.style.display = '';
      si.textContent = `已选 ${cbs.length} 套内核，约可释放 ${(size / 1073741824 >= 1 ? (size / 1073741824).toFixed(2) + ' GB' : Math.round(size / 1048576) + ' MB')}`;
    }
  }
}

function selectAllKernel(el) {
  document.querySelectorAll('.kernel-cb:not(:disabled)').forEach(cb => { cb.checked = el.checked; });
  updateKernelSelectInfo();
}

/** 推荐勾选：除「运行中」和「建议保留（最新一个备用）」之外的全部 */
function selectAllKernelRecommended() {
  const d = kernelState.data;
  if (!d) { showToast('请先扫描', 'error'); return; }
  let n = 0;
  document.querySelectorAll('.kernel-cb:not(:disabled)').forEach(cb => {
    const k = (d.kernels || []).find(x => x.version === cb.value);
    const on = !!(k && k.deletable && !k.suggest_keep);
    cb.checked = on;
    if (on) n++;
  });
  updateKernelSelectInfo();
  showToast(n > 0 ? `已勾选 ${n} 套可清理内核` : '没有可推荐清理的内核', n > 0 ? 'success' : 'info');
}

async function showKernelDeleteModal() {
  const d = kernelState.data;
  const picked = Array.from(kernelState.selected);
  if (!d || picked.length === 0) { showToast('请先选择要清理的内核', 'error'); return; }
  const rows = picked.map(v => (d.kernels || []).find(x => x.version === v)).filter(Boolean);

  const cnt = $('kernelDeleteCount'); if (cnt) cnt.textContent = rows.length;
  const box = $('kernelDeleteList');
  if (box) box.innerHTML = '<span style="color:var(--color-text-tertiary)">⏳ 正在让 apt 预演一遍（apt-get -s purge），不会改动系统…</span>';

  const ack = $('kernelAckCb'); if (ack) ack.checked = false;
  const extraAck = $('kernelExtraAckCb'); if (extraAck) extraAck.checked = false;
  const extraWrap = $('kernelExtraAckWrap'); if (extraWrap) extraWrap.style.display = 'none';
  const warn = $('kernelDeleteWarn'); if (warn) warn.style.display = 'none';
  const cacheCb = $('kernelCleanAptCb'); if (cacheCb) cacheCb.checked = ((d.apt_cache && d.apt_cache.size) || 0) > 0;
  const cs = $('kernelAptCacheSize'); if (cs) cs.textContent = (d.apt_cache && d.apt_cache.size_str) || '0 B';
  // 预演期间不允许点确认：后端预演虽然不占清理锁，但此时点确认没意义
  // （结果还没出来，也拿不到「是否需要额外确认连带删除」的结论）
  kernelState.dryLoading = true;
  updateKernelConfirmBtn();
  $('kernelDeleteModal')?.classList.add('visible');

  // ── 关键一步：先用 apt-get -s purge 预演，把「apt 到底会删哪些包」摆给用户看
  kernelState.dry = null;
  try {
    const r = await API.post('api/kernel/delete', { versions: picked, confirm: 'PURGE', dry_run: true }, 180000);
    if (!r || r.success === false) throw new Error((r && r.error) || '预演失败');
    kernelState.dry = r;
    const plan = r.plan || [];
    let html = '';
    for (const p of plan) {
      html += `<div style="margin-bottom:6px">• <b>${escHtml(p.version)}</b> — ${escHtml(p.size_str)}<br>`
        + `<span style="color:var(--color-text-tertiary)">apt 会删：${escHtml((p.apt_removes || []).join(' '))}</span></div>`;
    }
    for (const rj of (r.rejected || [])) {
      html += `<div style="color:var(--color-danger)">✗ ${escHtml(rj.version)} — ${escHtml(rj.error)}</div>`;
    }
    if (box) box.innerHTML = html || '<span style="color:var(--color-danger)">没有可执行的项</span>';

    if ((r.extras || []).length > 0) {
      if (extraWrap) extraWrap.style.display = '';
      const et = $('kernelExtraAckText');
      if (et) et.innerHTML = `我知道还会连带删除 <b>${r.extras.length}</b> 个范围外的包：<code>${escHtml(r.extras.slice(0, 6).join(' '))}${r.extras.length > 6 ? ' …' : ''}</code>（通常是依赖内核的元包）`;
    }

    // GRUB 默认启动项提醒
    const grubOnes = rows.filter(k => k.grub_default);
    if (warn && grubOnes.length) {
      warn.style.display = '';
      warn.innerHTML = `⚠️ 你选中的 <b>${escHtml(grubOnes.map(k => k.version).join(', '))}</b> 是当前 <code>GRUB_DEFAULT</code> 指向的启动项。<br>`
        + `删掉之后它从启动菜单消失，<b>下次开机会回退到启动菜单的第一条</b>（通常是当前正在运行的 ${escHtml(d.running)}）。这不会让系统无法启动，但请知悉。`;
    }
  } catch (e) {
    if (box) box.innerHTML = `<span style="color:var(--color-danger)">预演失败：${escHtml(e.message)}</span>`;
    kernelState.dry = null;
  } finally {
    kernelState.dryLoading = false;
  }
  updateKernelConfirmBtn();
}

function hideKernelDeleteModal() {
  $('kernelDeleteModal')?.classList.remove('visible');
}

function updateKernelConfirmBtn() {
  const ack = $('kernelAckCb');
  const btn = $('kernelConfirmBtn');
  // 预演发现 apt 会连带删范围外的包时，必须再单独勾一次
  const needExtra = !!(kernelState.dry && (kernelState.dry.extras || []).length > 0);
  const extraCb = $('kernelExtraAckCb');
  const extraOk = !needExtra || !!(extraCb && extraCb.checked);
  // 预演还没结束时不允许点（也避免用户在预演期间点出「有任务正在进行」）
  if (btn) btn.disabled = !(ack && ack.checked && extraOk) || kernelState.dryLoading;
}

async function confirmKernelDelete() {
  const picked = Array.from(kernelState.selected);
  if (picked.length === 0) { hideKernelDeleteModal(); return; }
  if (kernelState.dryLoading) { showToast('预演还没完成，请稍等一下再点确认', 'warn'); return; }
  const btn = $('kernelConfirmBtn');
  const cleanCache = !!($('kernelCleanAptCb') && $('kernelCleanAptCb').checked);
  if (btn) { btn.disabled = true; btn.textContent = '正在清理…'; }
  const status = $('kernel-status');
  const est = picked.length <= 2 ? '约 30 秒' : (picked.length <= 5 ? '约 1 分钟' : '约 1~2 分钟');
  if (status) { status.className = ''; status.textContent = `⏳ 正在执行 apt-get purge（${picked.length} 套，${est}），请不要关闭页面…`; }
  try {
    const needExtra = !!(kernelState.dry && (kernelState.dry.extras || []).length > 0);
    const extraCb = $('kernelExtraAckCb');
    const r = await API.post('api/kernel/delete', {
      versions: picked,
      confirm: 'PURGE',
      clean_apt_cache: cleanCache,
      allow_extra_removals: !!(needExtra && extraCb && extraCb.checked),
    }, 620000);
    if (!r || r.success === false) {
      if (r && r.needs_extra_ack) {
        if (status) { status.className = 'error'; status.textContent = '⚠ ' + r.error; }
        showToast(r.error, 'error');
        return;
      }
      throw new Error((r && r.error) || '清理失败');
    }
    hideKernelDeleteModal();
    const okN = r.removed || 0, badN = r.failed || 0;
    let msg = `✅ 已清理 ${okN} 套内核，释放 ${r.freed_str || '0 B'}`;
    if ((r.rejected || []).length) msg += `；${r.rejected.length} 套被安全校验拦下（${r.rejected[0].version}: ${r.rejected[0].error}）`;
    if ((r.leftover || []).length) msg += `；⚠ ${r.leftover.length} 套包已删但文件仍在（${r.leftover.map(x => x.version + ' ' + x.size_str).join(', ')}）`;
    if (r.cache_cleaned) msg += `；另清 APT 缓存 ${r.cache_cleaned_str || ''}`;
    if (badN) {
      const fails = (r.results || []).filter(x => !x.ok).map(x => `${x.version}: ${x.error || '失败'}`).slice(0, 3).join('；');
      msg += `；${badN} 项失败（${fails}）`;
    }
    showToast(msg, badN ? 'error' : 'success');
    if (status) { status.className = badN ? 'error' : 'success'; status.textContent = msg; }
    await kernelScan();
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ ' + e.message; }
    showToast('清理失败：' + e.message, 'error');
  } finally {
    const b2 = $('kernelConfirmBtn');
    if (b2) { b2.disabled = false; b2.textContent = '确认清理'; }
  }
}

// 清理「残留配置包」（dpkg 状态 rc：包已删，只剩 /etc 下的配置）
async function purgeRcPackages() {
  const d = kernelState.data;
  const rc = (d && d.rc_packages) || [];
  if (rc.length === 0) { showToast('没有残留配置包', 'info'); return; }
  const ok = await new Promise(resolve => {
    // 没有通用确认框就退化成浏览器原生确认（够用且不会误点）
    const msg = `将清理 ${rc.length} 个残留配置包：\n\n${rc.join('\n')}\n\n`
      + '这些包的本体早就删掉了，只剩 /etc 下的配置文件。清理只是去掉这些残留配置，不会影响已安装的软件。';
    resolve(window.confirm(msg));
  });
  if (!ok) return;
  const status = $('kernel-status');
  if (status) { status.className = ''; status.textContent = `⏳ 正在执行 dpkg --purge（${rc.length} 个），请稍等…`; }
  try {
    const r = await API.post('api/kernel/purge-rc', { confirm: 'PURGE', packages: rc }, 320000);
    if (!r || r.success === false) throw new Error((r && r.error) || '清理失败');
    let msg = `✅ 已清理 ${r.purged_count} 个残留配置包`;
    if (r.failed) msg += `；${r.failed} 个没清掉（${(r.failed_packages || []).slice(0, 3).join(' ')}）`;
    if ((r.remaining || []).length) msg += `；还剩 ${r.remaining.length} 个`;
    showToast(msg, r.failed ? 'error' : 'success');
    if (status) { status.className = r.failed ? 'error' : 'success'; status.textContent = msg; }
    await kernelScan();
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ ' + e.message; }
    showToast('清理残留配置包失败：' + e.message, 'error');
  }
}

async function cleanAptCache() {
  const d = kernelState.data;
  const apc = (d && d.apt_cache) || {};
  if ((apc.files || 0) === 0) {
    showToast('APT 下载缓存已经是空的（没有 .deb 文件可清）', 'info');
    return;
  }
  const btn = $('kernelAptCleanBtn');
  if (btn) btn.disabled = true;
  try {
    // versions 传空 = 只清 APT 缓存（后端允许这种「不删内核只清缓存」的调用）
    const r = await API.post('api/kernel/delete', { versions: [], confirm: 'PURGE', clean_apt_cache: true }, 180000);
    if (!r || r.success === false) throw new Error((r && r.error) || '清理失败');
    const freed = r.cache_cleaned || 0;
    showToast(freed > 0 ? `✅ 已清理 APT 缓存，释放 ${r.cache_cleaned_str}` : 'APT 缓存本来就是空的，没有可释放空间', freed > 0 ? 'success' : 'info');
    await kernelScan();
  } catch (e) {
    showToast('清理 APT 缓存失败：' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

  const exports = {
    toggleTheme, showSponsorModal, maybeShowSponsorReminder, showSponsorImgFull, showContactModal,
    showCleanupSummary, refreshCleanupSummary, filterTable, exportTableToCSV,
    switchGroup,
    switchTab,
    doScan, selectAllApp, updateSelectInfo,
    confirmDelete, doDelete, closeModal,
    loadDiskMounts, selectAllDisk, updateDiskSelectInfo,
    confirmDeleteVol02, doDeleteVol02,
    switchInnerTab, loadDockerVolumes,
    selectAllDockerVol, updateDockerSelectInfo,
    confirmDeleteDocker, doDeleteDocker,
    hideDockerVolDeleteModal,
    doNetworksScan, selectAllNetworks,
    updateNetworkSelectInfo, confirmDeleteNetworks, doDeleteNetworks,
    hideDockerNetDeleteModal,
    doImagesScan, selectAllImages,
    updateImagesSelectInfo, confirmDeleteImages, doDeleteImages,
    hideDockerImgDeleteModal,
    doTempScan, selectAllTemp, updateTempSelectInfo,
    confirmDeleteTemp, doDeleteTemp,
    hideTempDeleteModal,
    switchDupInnerTab, startDupScan,
    stopDupScan,
    showDupDeleteModal, hideDupDeleteModal,
    confirmDupDelete,
    updateDupSelectedCount, loadMoreDupResults,
    simDupScan, simDupStop,
    brokScan, brokStop, brokSwitchCat, brokRender,
    nmScan, nmStop, nmRender,
    showBrowseModal, showDupBrowseModal, hideBrowseModal, loadBrowseDir, browseGoUp, browseSelect,
  browseBackdropClick, saveContentViaBrowser,
    renderDupPaths, removeDupPath,
    startEmptyScan, stopEmptyScan, selectAllEmpty, updateEmptySelectInfo,
    showEmptyDeleteModal, hideEmptyDeleteModal, confirmEmptyDelete, confirmEmptyDeleteOne,
    doSysCleanScan, renderSysCleanList, selectAllSysClean, selectAllSysCleanRecommended,
    updateSysCleanSelectInfo, showSysCleanDeleteModal, hideSysCleanDeleteModal, doSysCleanDelete,
    toggleSysCleanBackup, getSysCleanBackupEnabled, showSysCleanManifests, hideSysCleanManifests,
    downloadSysCleanManifest, viewSysCleanManifest,
    loadUsers, renderUsers, toggleUsersShowSystem, selectAllUsers, updateUsersSelectInfo,
    showUsersDeleteModal, hideUsersDeleteModal, usersRefreshConfirmBtn, confirmUsersDelete,
    purgeRcPackages,
    showStartupWarning, closeStartupWarning, toggleStartupWarningAlways, syncStartupWarningChecks,
    setStartupWarnFrom, loadStartupWarningPref, initStartupWarning, maybeShowStartupWarning,
    trashScan, trashClean, hideTrashDeleteModal, doTrashClean,
    trashBrowseList, hideTrashBrowseModal,
    loadSchedule, saveSchedule, toggleSchedule, triggerSchedule, loadScheduleHistory, viewScheduleReport,
    viewScheduleFilesFromAttr, viewScheduleReportFromAttr,
    doBigFilesScan, stopBigFiles,
    confirmBigFilesDelete, closeBigFilesDeleteModal, doBigFilesDelete,
    bigfilesSelectAll, bigfilesUpdateSelectInfo, bigfilesRefreshConfirmBtn,
    filesCollect, filesSelectAll, filesUpdateSelectInfo, openFilesDeleteModal,
    closeFilesDeleteModal, confirmFilesDelete, filesRefreshConfirmBtn,
    dsLoadVolumes, dsDrillDown, dsStop,
    dcCheckAvailable, dcScan, renderDcStoppedList, dcSelectAll, dcUpdateSelectInfo, dcRemoveSelected, dcPruneCache,
    copyQQNumber,
        saveDupExcludeRules, resetDupExcludeRules,
    kernelScan, renderKernelList, updateKernelSelectInfo, selectAllKernel,
    selectAllKernelRecommended, showKernelDeleteModal, hideKernelDeleteModal,
    updateKernelConfirmBtn, confirmKernelDelete, cleanAptCache,
  };
  Object.assign(window, exports);

  // Convert all inline [onclick] buttons to DOM-0 handlers (bypass IIFE scope issue).
  // Use el.onclick= rather than addEventListener: the fnOS WebView (CEF) fires DOM-0
  // reliably on dynamically re-rendered elements, where addEventListener may be dropped.
  // Also stamp an idempotency marker so re-running this never double-binds.
  document.querySelectorAll('[onclick]').forEach(el => {
    if (el.__rewired) return;
    const attr = el.getAttribute('onclick');
    const fnName = attr.replace(/\(.*\)/, '').trim();
    if (typeof window[fnName] === 'function') {
      el.__rewired = true;
      el.removeAttribute('onclick');
      el.onclick = function(e) {
        const match = attr.match(/\(([^)]*)\)/);
        if (match && match[1].trim()) {
          const args = match[1].split(',').map(a => {
            let v = a.trim().replace(/^['"]|['"]$/g, '');
            if (v === 'true') return true;
            if (v === 'false') return false;
            if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
            return v;
          });
          window[fnName](...args);
        } else {
          window[fnName]();
        }
      };
    }
  });

  // Direct bind for sponsor button (second .sponsor-btn)
  const sponsorBtns = document.querySelectorAll('.sponsor-btn');
  const sponsorBtn = sponsorBtns[1];
  if (sponsorBtn) sponsorBtn.addEventListener('click', function(e) {
    document.querySelector('#sponsorModal').classList.add('show');
  });
  // Sponsor image enlarge
  document.querySelectorAll('[data-sponsor-img]').forEach(img => {
    img.addEventListener('click', function(e) {
      const o = document.getElementById('sponsorImgOverlay');
      if (o) {
        document.getElementById('sponsorImgFull').src = this.src;
        o.classList.add('show');
      }
    });
  });

  // Initialize sysclean backup toggle from localStorage (default ON)
  const backupCb = document.getElementById('syscleanBackupCb');
  if (backupCb) backupCb.checked = getSysCleanBackupEnabled();

  // 动效编排层: 面板切换入场 / 结果逐条进场 / KPI 数字滚动 / 进度流光。
  // 由 MutationObserver 驱动, 不改动任何既有渲染函数。
  if (window.Motion) window.Motion.init();

  // 启动风险提示：以服务端偏好为准，且一次页面加载最多弹一次
  initStartupWarning();
}

})();
