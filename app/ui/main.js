(function(){
'use strict';

const App = {
  installedApps: [], orphanData: {},
  mountsLoaded: false, vol02Scanned: false, diskMountsLoaded: false,
  dockerVolumesLoaded: false, dockerNetworksLoaded: false, dockerImagesLoaded: false,
  tempScanned: false
};

const API = {
  base: '/app/fnclearup/',
  async get(path, timeoutMs=15000) {
    const ac = new AbortController();
    const t = setTimeout(()=>ac.abort(), timeoutMs);
    try { const r=await fetch(this.base+path,{signal:ac.signal}); clearTimeout(t); return r.json(); }
    catch(e){ clearTimeout(t); throw e; }
  },
  async post(path, body, timeoutMs=30000) {
    const ac = new AbortController();
    const t = setTimeout(()=>ac.abort(), timeoutMs);
    try { const r=await fetch(this.base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ac.signal}); clearTimeout(t); return r.json(); }
    catch(e){ clearTimeout(t); throw e; }
  }
};

const $ = id => document.getElementById(id);

// Theme
function applyTheme(dark) { document.documentElement.classList.toggle('dark', dark); }
function toggleTheme() { applyTheme(!document.documentElement.classList.contains('dark')); }

// Toast
function showToast(msg, type='info') {
  const t = document.createElement('div'); t.className='toast '+type; t.textContent=msg;
  const c = document.getElementById('toastContainer');
  if (!c) { const nc=document.createElement('div'); nc.id='toastContainer'; document.body.appendChild(nc); nc.appendChild(t); }
  else c.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),300);},3000);
}

// Sponsor
function showSponsorModal() { $('#sponsorModal')?.classList.add('show'); }
function showSponsorImgFull(img) { const o=$('#sponsorImgOverlay'); if(o){o.classList.add('show');$('#sponsorImgFull').src=img.src;} }

// Tab switching
async function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tabName);b.setAttribute('aria-selected',b.dataset.tab===tabName?'true':'false');});
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.dataset.panel===tabName));
  if(tabName==='app') await doScan();
  else if(tabName==='disk') { App.diskMountsLoaded=false; await loadDiskMounts(true); }
  else if(tabName==='docker') { App.dockerVolumesLoaded=false; await loadDockerVolumes(); switchInnerTab('volumes'); }
  else if(tabName==='temp'&&!App.tempScanned) { App.tempScanned=true; await doTempScan(); }
}

// ── App Scan ──
async function doScan() {
  const btn=$('scanBtn')||$('scanTrigger'); const status=$('app-status'); const list=$('app-list');
  if(btn){btn.disabled=true;btn.innerHTML='<span>⏳</span><span>扫描中...</span>';}
  if(status){status.className='loading';status.textContent='⏳ 正在扫描...';}
  if(list)list.innerHTML='';
  const db=$('deleteBtn'); if(db)db.disabled=true;
  const si=$('select-info'); if(si)si.style.display='none';
  try {
    const data = await API.post('api/scan', {});
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
    // Build merged rows: installed apps first, then orphan-only
    const rows=[];
    const installedSet = new Set(App.installedApps.map(a=>typeof a==='object'?a.appname:a));
    for(const app of App.installedApps) {
      const appname=typeof app==='object'?app.appname:app;
      const isO=orphanNames.has(appname);
      rows.push({status:isO?'orphan':'installed',appname:appname,paths:App.orphanData[appname]||[],isOrphan:isO});
    }
    for(const sn of orphanNames) {
      if(!installedSet.has(sn)) rows.push({status:'orphan',appname:sn,paths:App.orphanData[sn]||[],isOrphan:true});
    }
    // Render
    let html='';
    for(const row of rows) {
      const badge=row.status==='installed'?'<span class="file-badge" style="background:#dcfce7;color:#059669">已安装</span>':'<span class="file-badge" style="background:#fff7ed;color:#ea580c">残余</span>';
      const disabledAttr=row.status==='installed'?'disabled':'';
      const rowStyle=row.status==='installed'?'style="opacity:0.6"':'';
      const firstPath=(row.paths[0]||'');
      const volMatch=firstPath.match(/^\/(vol\d+)/);
      const cbId='cb_'+row.appname.replace(/[^a-zA-Z0-9]/g,'_');
      html+=`<div class="file-row" ${rowStyle}><input type="checkbox" class="file-checkbox" id="${cbId}" data-path="${escHtml(firstPath)}" data-app="${escHtml(row.appname)}" onchange="updateSelectInfo()" ${disabledAttr}><span class="file-path" style="font-weight:500">${escHtml(row.appname)}</span>${badge}<span class="file-vol">${volMatch?volMatch[1]:'-'}</span></div>`;
    }
    if(rows.length===0) html='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">🎉 无残留</div>';
    if(list)list.innerHTML=html;
    if(status){status.className='success';status.textContent=`✅ 已安装 ${App.installedApps.length} 个应用，发现 ${totalOrphan} 个残余`;}
  } catch(e) {
    if(status){status.className='error';status.textContent='❌ 扫描失败: '+e.message;}
    showToast('扫描失败','error');
  } finally {
    if(btn){btn.disabled=false;btn.innerHTML='<span>🔍</span><span>扫描目录</span>';}
  }
}
function toggleSelectAll() {}
function updateSelectInfo() {
  const cbs=document.querySelectorAll('#app-list .file-checkbox:checked');
  const db=$('deleteBtn'); const si=$('select-info');
  if(cbs.length>0){if(db)db.disabled=false;if(si){si.style.display='';si.textContent=`已选 ${cbs.length} 个`;}}
  else{if(db)db.disabled=true;if(si)si.style.display='none';}
}
function closeModal() { const m=$('confirmModal'); if(m)m.classList.remove('visible'); }
function confirmDelete() {
  const cbs=document.querySelectorAll('#app-list .file-checkbox:checked');
  if(cbs.length===0){showToast('请选择要删除的目录','error');return;}
  const c=$('confirmCount'); if(c)c.textContent=cbs.length;
  const p=$('confirmPaths'); if(p){
    p.innerHTML=[...cbs].slice(0,20).map(cb=>`<div>${escHtml(cb.dataset.path)}</div>`).join('');
    if(cbs.length>20)p.innerHTML+=`<div style="color:var(--color-text-secondary)">...还有 ${cbs.length-20} 个</div>`;
  }
  $('confirmModal')?.classList.add('visible');
}
async function doDelete() {
  const cbs=document.querySelectorAll('#app-list .file-checkbox:checked');
  const paths=[...cbs].map(cb=>cb.dataset.path).filter(Boolean);
  const delUsers=!!$('deleteUsersCheckbox')?.checked;
  const delAppshare=!!$('deleteAppshareCheckbox')?.checked;
  $('confirmModal')?.classList.remove('visible');
  try {
    const r=await API.post('api/delete',{paths,delete_users:delUsers,delete_appshare_residual:delAppshare});
    showToast(`已删除 ${r.deleted||0} 个，失败 ${r.failures||0} 个`,'success');
    await doScan();
  } catch(e){showToast('删除失败: '+e.message,'error');}
}

// ── Disk ──
async function loadDiskMounts(force) {
  if(App.diskMountsLoaded&&!force) return;
  App.diskMountsLoaded=true;
  const status=$('disk-status'); const list=$('disk-list'); const btn=$('scanDiskMountsBtn');
  const delBtn=$('deleteVol02Btn'); if(delBtn)delBtn.disabled=true;
  if(btn){btn.disabled=true;btn.innerHTML='<span>⏳</span><span>扫描中...</span>';}
  if(status){status.className='loading';status.textContent='⏳ 加载中...';}
  try {
    const [m, v] = await Promise.all([API.get('api/mounts'), API.get('api/vol02')]);
    const mounts=m.mounts||[]; const allDirs=v.vol02_dirs||[]; const mounted=v.mounted_points||[];
    if($('mounts-count'))$('mounts-count').textContent=mounts.length;
    if($('vol02-total-count'))$('vol02-total-count').textContent=allDirs.length;
    const residual=allDirs.filter(d=>!mounted.some(mp=>mp.includes(d)));
    if($('vol02-count'))$('vol02-count').textContent=residual.length;
    if(list){
      let html='';
      const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      for(const d of allDirs) {
        const isMounted=mounted.some(mp=>mp.includes(d));
        const badge=isMounted?'<span class="file-badge" style="background:#dcfce7;color:#059669">在用</span>':'<span class="file-badge" style="background:#fff7ed;color:#ea580c">残余</span>';
        const disabledAttr=isMounted?'disabled':'';
        const rowStyle=isMounted?'style="opacity:0.6"':'';
        html+=`<div class="file-row" ${rowStyle}><input type="checkbox" class="file-checkbox disk-cb" value="/vol02/${esc(d)}" onchange="updateDiskSelectInfo()" ${disabledAttr}><span class="file-path">/vol02/${esc(d)}</span>${badge}</div>`;
      }
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
function updateDiskSelectInfo() {
  const cbs=document.querySelectorAll('.disk-cb:checked');
  const db=$('deleteVol02Btn'); const si=$('disk-select-info');
  (cbs.length>0)?(db.disabled=false):(db.disabled=true);
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
  for(const cb of cbs){
    try{ await API.post('api/delete',{paths:[cb.value]}); }catch{}
  }
  showToast('删除完成','success');
  await loadDiskMounts(true);
}

// ── Docker Inner Tab ──
function switchInnerTab(tabName) {
  document.querySelectorAll('.inner-tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.innerTab===tabName));
  document.querySelectorAll('.inner-panel').forEach(p=>p.classList.toggle('active',p.dataset.innerPanel===tabName));
  if(tabName==='images'&&!App.dockerImagesLoaded){App.dockerImagesLoaded=true;doImagesScan();}
  else if(tabName==='volumes'&&!App.dockerVolumesLoaded)loadDockerVolumes();
  else if(tabName==='networks'&&!App.dockerNetworksLoaded){App.dockerNetworksLoaded=true;doNetworksScan();}
}
async function loadDockerVolumes() {
  App.dockerVolumesLoaded=true;
  const status=$('docker-orphan-status'); const list=$('docker-volumes-list');
  try {
    const data=await API.get('api/volumes');
    const v=data.volumes||{};
    const all=(v.all||[]).map(n=>{const m=v.orphan?.find(o=>o.name===n);return{name:n,driver:m?m.driver:'local',orphan:!!m};});
    const inUseNames=new Set((v.in_use||[]).map(x=>typeof x==='string'?x:x.name||x));
    const orphan=v.orphan||[];
    if($('docker-total-count'))$('docker-total-count').textContent=all.length;
    if($('docker-inuse-count'))$('docker-inuse-count').textContent=all.filter(x=>!x.orphan).length;
    if($('docker-orphan-count'))$('docker-orphan-count').textContent=orphan.length;
    if(list){
      let html='';
      for(const vol of all) {
        const isInUse=inUseNames.has(vol.name);
        const badge=isInUse?'<span class="file-badge" style="background:#dcfce7;color:#059669">在用</span>':(vol.orphan?'<span class="file-badge" style="background:#fff7ed;color:#ea580c">孤立</span>':'<span class="file-badge" style="background:#eef2ff;color:#6366f1">正常</span>');
        const disabledAttr=isInUse?'disabled':'';
        const rowStyle=isInUse?'style="opacity:0.6"':'';
        html+=`<div class="file-row" ${rowStyle}><input type="checkbox" class="docker-cb" value="${escHtml(vol.name)}" onchange="updateDockerSelectInfo()" ${disabledAttr}><span class="file-path">${escHtml(vol.name)}</span><span class="file-size">${escHtml(vol.driver)}</span>${badge}</div>`;
      }
      if(all.length===0) html='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">无 Docker 卷</div>';
      list.innerHTML=html;
    }
    if(status){status.className='success';status.textContent=`✅ ${all.length} 个卷（在用 ${all.filter(x=>!x.orphan).length}，孤立 ${orphan.length}）`;}
  } catch(e){if(status){status.className='error';status.textContent='❌ '+e.message;}}
}
function updateDockerSelectInfo() {
  const cbs=document.querySelectorAll('.docker-cb:checked');
  ($('deleteDockerBtn')).disabled=cbs.length===0;
  const si=$('docker-select-info'); si.style.display=cbs.length>0?'':'none'; si.textContent=`已选 ${cbs.length} 个`;
}
function confirmDeleteDocker() {
  const cbs=document.querySelectorAll('.docker-cb:checked');
  if(cbs.length===0){showToast('请选择孤立卷','error');return;}
  doDeleteDocker();
}
async function doDeleteDocker() {
  const vols=[...document.querySelectorAll('.docker-cb:checked')].map(cb=>cb.value);
  try {
    const r=await API.post('api/volumes/delete',{volumes:vols});
    showToast(`已删除 ${r.deleted||0} 个卷`,'success');
    App.dockerVolumesLoaded=false; await loadDockerVolumes();
  } catch(e){showToast('删除失败: '+e.message,'error');}
}

// Networks
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
      let html='';
      for(const net of all) {
        const isUsed=!net.unused;
        const badge=isUsed?'<span class="file-badge" style="background:#dcfce7;color:#059669">使用中</span>':'<span class="file-badge" style="background:#fff7ed;color:#ea580c">未使用</span>';
        const disabledAttr=isUsed?'disabled':'';
        const rowStyle=isUsed?'style="opacity:0.6"':'';
        html+=`<div class="file-row" ${rowStyle}><input type="checkbox" class="network-cb" value="${escHtml(net.name)}" onchange="updateNetworkSelectInfo()" ${disabledAttr}><span class="file-path">${escHtml(net.name)}</span><span class="file-size">${escHtml(net.driver)}</span>${badge}</div>`;
      }
      if(all.length===0) html='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">无 Docker 网络</div>';
      list.innerHTML=html;
    }
    if(status){status.className='success';status.textContent=`✅ ${all.length} 个网络（使用中 ${all.filter(x=>!x.unused).length}，未使用 ${all.filter(x=>x.unused).length}）`;}
  } catch(e){if(status){status.className='error';status.textContent='❌ '+e.message;}}
}
function updateNetworkSelectInfo() {
  const cbs=document.querySelectorAll('.network-cb:checked');
  ($('deleteNetworksBtn')).disabled=cbs.length===0;
  const si=$('networks-select-info'); si.style.display=cbs.length>0?'':'none'; si.textContent=`已选 ${cbs.length} 个`;
}
function confirmDeleteNetworks() {
  const cbs=document.querySelectorAll('.network-cb:checked');
  if(cbs.length===0){showToast('请选择网络','error');return;}
  doDeleteNetworks();
}
async function doDeleteNetworks() {
  const nets=[...document.querySelectorAll('.network-cb:checked')].map(cb=>cb.value);
  try {
    const r=await API.post('api/networks/delete',{networks:nets});
    showToast(`已删除 ${r.deleted||0} 个网络`,'success');
    await doNetworksScan();
  } catch(e){showToast('删除失败: '+e.message,'error');}
}

// Images
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
      let html='';
      for(const img of all) {
        const isUsed=img.used;
        const badge=isUsed?'<span class="file-badge" style="background:#dcfce7;color:#059669">使用中</span>':(img.dangling?'<span class="file-badge" style="background:#fce7f3;color:#db2777">悬空</span>':'<span class="file-badge" style="background:#fff7ed;color:#ea580c">未使用</span>');
        const disabledAttr=isUsed?'disabled':'';
        const rowStyle=isUsed?'style="opacity:0.6"':'';
        html+=`<div class="file-row" ${rowStyle}><input type="checkbox" class="image-cb" value="${escHtml(img.id)}" onchange="updateImagesSelectInfo()" ${disabledAttr}><span class="file-path">${escHtml(img.repository||'<none>')}:${escHtml(img.tag||'<none>')}</span><span class="file-size">${escHtml(img.size)}</span>${badge}</div>`;
      }
      if(all.length===0) html='<div style="text-align:center;padding:30px;color:var(--color-text-secondary)">无 Docker 镜像</div>';
      list.innerHTML=html;
    }
    if(status){status.className='success';status.textContent=`✅ ${all.length} 个镜像（使用中 ${all.filter(x=>x.used).length}，未使用 ${all.filter(x=>!x.used&&!x.dangling).length}）`;}
  } catch(e){if(status){status.className='error';status.textContent='❌ '+e.message;}}
}
function updateImagesSelectInfo() {
  const cbs=document.querySelectorAll('.image-cb:checked');
  ($('deleteImagesBtn')).disabled=cbs.length===0;
  const si=$('images-select-info'); si.style.display=cbs.length>0?'':'none'; si.textContent=`已选 ${cbs.length} 个`;
}
function confirmDeleteImages() {
  const cbs=document.querySelectorAll('.image-cb:checked');
  if(cbs.length===0){showToast('请选择镜像','error');return;}
  doDeleteImages();
}
async function doDeleteImages() {
  const ids=[...document.querySelectorAll('.image-cb:checked')].map(cb=>cb.value);
  try {
    const r=await API.post('api/images/delete',{images:ids});
    showToast(`已删除 ${r.total||0} 个镜像`,'success');
    await doImagesScan();
  } catch(e){showToast('删除失败: '+e.message,'error');}
}
function toggleDockerInuseList(btn){}

// ── Temp ──
async function doTempScan() {
  const status=$('temp-status'); const list=$('temp-list');
  const btn=$('deleteTempBtn'); if(btn)btn.disabled=true;
  try {
    const data=await API.get('api/temp/scan');
    if($('temp-dirs-count'))$('temp-dirs-count').textContent=data.counts?.dirs||0;
    if($('temp-files-count'))$('temp-files-count').textContent=data.counts?.files||0;
    if($('temp-total-size'))$('temp-total-size').textContent=data.total_size_str||'0 B';
    if(list){
      const all=[...(data.dirs||[]),...(data.files||[])];
      list.innerHTML=all.map(item=>`<div class="file-row"><input type="checkbox" class="temp-cb" value="${escHtml(item.path)}" onchange="updateTempSelectInfo()"><span class="file-path">${escHtml(item.path)}</span><span class="file-size">${escHtml(item.size_str)}</span><span class="file-tag">${item.type==='dir'?'📁':'📄'}</span></div>`).join('');
    }
    if(status){status.className='success';status.textContent=`✅ ${data.counts?.files||0} 个文件 ${data.counts?.dirs||0} 个目录`;}
  } catch(e){if(status){status.className='error';status.textContent='❌ '+e.message;}}
}
function updateTempSelectInfo() {
  const cbs=document.querySelectorAll('.temp-cb:checked');
  ($('deleteTempBtn')).disabled=cbs.length===0;
  const si=$('temp-select-info'); si.style.display=cbs.length>0?'':'none'; si.textContent=`已选 ${cbs.length} 个`;
}
function confirmDeleteTemp() {
  const cbs=document.querySelectorAll('.temp-cb:checked');
  if(cbs.length===0){showToast('请选择文件','error');return;}
  doDeleteTemp();
}
async function doDeleteTemp() {
  const paths=[...document.querySelectorAll('.temp-cb:checked')].map(cb=>cb.value);
  try {
    const r=await API.post('api/temp/delete',{paths});
    showToast(`已删除 ${r.total||0} 个文件`,'success');
    await doTempScan();
  } catch(e){showToast('删除失败: '+e.message,'error');}
}

// ═══ Duplicate File Scanning ═══
const DupState = { music: { jobId: null, duplicates: [], checking: false }, files: { jobId: null, duplicates: [], checking: false } };

function getDupIds(tab) {
  return { pathInput: tab + 'Path', scanBtn: tab + 'ScanBtn', pauseBtn: tab + 'PauseBtn', resumeBtn: tab + 'ResumeBtn', stopBtn: tab + 'StopBtn', deleteBtn: tab + 'DeleteBtn', exportBtn: tab + 'ExportBtn', progress: tab + 'Progress', progressBar: tab + 'ProgressBar', progressText: tab + 'ProgressText', progressCount: tab + 'ProgressCount', currentFile: tab + 'CurrentFile', status: tab + 'Status', results: tab + 'Results', stats: tab + 'Stats', dupList: tab + 'DupList', actions: tab + 'Actions', selectedCount: tab + 'SelectedCount', selectedSize: tab + 'SelectedSize', empty: tab + 'Empty' };
}

function switchDupInnerTab(tabName) {
  document.querySelectorAll('.dup-inner-tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.dupTab===tabName));
  document.querySelectorAll('.dup-inner-panel').forEach(p=>p.classList.toggle('active',p.dataset.dupPanel===tabName));
  updateDupSelectedCount();
}

async function startDupScan(tab) {
  const ids = getDupIds(tab);
  const scanPath = ($(ids.pathInput)?.value||'').trim();
  if (!scanPath) { showToast('请输入扫描目录路径', 'error'); return; }

  $(ids.results)&&($(ids.results).style.display='none');
  $(ids.empty)&&($(ids.empty).style.display='none');
  $(ids.actions)&&$(ids.actions).classList.remove('visible');

  const pe = $(ids.progress); if(pe) pe.classList.add('visible');
  const bar=$(ids.progressBar), txt=$(ids.progressText), cnt=$(ids.progressCount), cur=$(ids.currentFile);
  if(bar) bar.style.width='0%'; if(txt) txt.textContent='正在验证路径...'; if(cnt) cnt.textContent='-'; if(cur) cur.textContent='';

  const scanBtn=$(ids.scanBtn), pauseBtn=$(ids.pauseBtn), resumeBtn=$(ids.resumeBtn), stopBtn=$(ids.stopBtn);
  if(scanBtn){scanBtn.disabled=true;scanBtn.style.display='none';}
  if(pauseBtn){pauseBtn.style.display='none';pauseBtn.disabled=true;}
  if(resumeBtn){resumeBtn.style.display='none';resumeBtn.disabled=true;}
  if(stopBtn){stopBtn.style.display='none';stopBtn.disabled=true;}

  const statusEl=$(ids.status);
  if(statusEl) statusEl.innerHTML='<span class="dup-spinner"></span> 正在验证路径...';

  try {
    const result = await API.post('api/dup/scan', { type: tab==='music'?'music':'files', path: scanPath });
    if (result.error || !result.jobId) {
      showToast(result.error||'启动扫描失败','error');
      if(statusEl) statusEl.innerHTML='❌ '+(result.error||'启动扫描失败');
      if(scanBtn){scanBtn.disabled=false;scanBtn.style.display='';}
      return;
    }
    DupState[tab].jobId = result.jobId;
    DupState[tab].checking = true;
    if(pauseBtn){pauseBtn.style.display='';pauseBtn.disabled=false;}
    if(stopBtn){stopBtn.style.display='';stopBtn.disabled=false;}
    pollDupProgress(tab);
  } catch(e) {
    showToast('启动扫描失败: '+e.message,'error');
    if(scanBtn){scanBtn.disabled=false;scanBtn.style.display='';}
  }
}

async function pollDupProgress(tab) {
  const ids = getDupIds(tab);
  const poll = async () => {
    if (!DupState[tab].checking) return;
    try {
      const data = await API.get('api/dup/status?jobId='+DupState[tab].jobId);
      if (!data || data.error) { DupState[tab].checking=false; finishDupScan(tab, null); return; }
      const p = data.progress||{}, total = p.total||0, processed = p.processed||0;
      const pct = total > 0 ? Math.round((processed/total)*100) : 0;
      const bar=$(ids.progressBar), cnt=$(ids.progressCount), cur=$(ids.currentFile), txt=$(ids.progressText), statusEl=$(ids.status);
      if(bar) bar.style.width=pct+'%'; if(cnt) cnt.textContent=processed+' / '+total; if(cur) cur.textContent=p.currentFile||'';
      if(data.status==='counting'){if(txt)txt.textContent='正在遍历...（已发现 '+total+' 个）';if(statusEl)statusEl.innerHTML='<span class="dup-spinner"></span> 遍历中 ('+total+' 个)';}
      else if(data.status==='hashing'){if(txt)txt.textContent='正在计算哈希值...';if(statusEl)statusEl.innerHTML='<span class="dup-spinner"></span> 哈希 ('+processed+'/'+total+')';}
      else if(data.status==='paused'){if(txt)txt.textContent='⏸ 已暂停';if(statusEl)statusEl.innerHTML='⏸ 已暂停';$(ids.pauseBtn)&&($(ids.pauseBtn).style.display='none');$(ids.resumeBtn)&&($(ids.resumeBtn).style.display='');}
      if(['complete','error','aborted'].includes(data.status)){DupState[tab].checking=false;finishDupScan(tab,data);}
      else setTimeout(poll, 800);
    } catch(e) { DupState[tab].checking=false; finishDupScan(tab, null); }
  };
  setTimeout(poll, 500);
}

function finishDupScan(tab, data) {
  const ids = getDupIds(tab);
  const btns = {scan:$(ids.scanBtn),pause:$(ids.pauseBtn),resume:$(ids.resumeBtn),stop:$(ids.stopBtn)};
  if(btns.scan){btns.scan.disabled=false;btns.scan.style.display='';}
  if(btns.pause){btns.pause.style.display='none';}
  if(btns.resume){btns.resume.style.display='none';}
  if(btns.stop){btns.stop.style.display='none';}
  $(ids.progress)?.classList.remove('visible');
  const se=$(ids.status);
  if(!data||data.status==='error'||data.status==='aborted') {
    const msg = data?(data.error||(data.status==='aborted'?'已中止':'失败')):'扫描失败';
    if(se)se.innerHTML='❌ '+msg; showToast(msg,'error');
    const ee=$(ids.empty); if(ee){ee.style.display='';const h3=ee.querySelector('h3');if(h3)h3.textContent='❌ 扫描失败';}
    return;
  }
  const dups = data.duplicates||[], stats = data.stats||{};
  if(dups.length===0) {
    const ee=$(ids.empty); if(ee){ee.style.display='';const h3=ee.querySelector('h3');if(h3)h3.textContent='🎉 未发现重复文件';const p=ee.querySelector('p');if(p)p.textContent='共扫描 '+(stats.totalFiles||0)+' 个文件';}
    if(se)se.innerHTML='✅ 无重复'; showToast('未发现重复文件','success'); return;
  }
  DupState[tab].duplicates = dups;
  const stEl=$(ids.stats); if(stEl){stEl.style.display='';stEl.innerHTML='<div class="dup-stat-card"><div class="dup-stat-value">'+(stats.totalFiles||0)+'</div><div class="dup-stat-label">扫描文件</div></div><div class="dup-stat-card"><div class="dup-stat-value">'+dups.length+'</div><div class="dup-stat-label">重复组</div></div><div class="dup-stat-card warning"><div class="dup-stat-value">'+(stats.duplicateFiles||0)+'</div><div class="dup-stat-label">重复文件</div></div><div class="dup-stat-card danger"><div class="dup-stat-value">'+(stats.wastedHuman||'0 B')+'</div><div class="dup-stat-label">浪费空间</div></div>';}
  if(se)se.innerHTML='✅ 完成';
  renderDupList(tab, dups);
  $(ids.results)&&($(ids.results).style.display='');
  $(ids.empty)&&($(ids.empty).style.display='none');
  $(ids.actions)?.classList.add('visible');
  $(ids.deleteBtn)&&($(ids.deleteBtn).disabled=false);
  $(ids.exportBtn)&&($(ids.exportBtn).disabled=false);
  showToast('发现 '+dups.length+' 组重复文件','info');
}

function renderDupList(tab, duplicates) {
  const ids = getDupIds(tab); const container = $(ids.dupList);
  if(!container) return; container.innerHTML='';
  let selCount=0, selSize=0;
  duplicates.forEach((group, gi) => {
    const div = document.createElement('div'); div.className='dup-group';
    const hdr = document.createElement('div'); hdr.className='dup-group-header open';
    hdr.innerHTML='<div class="dup-info"><span class="dup-count">'+group.count+' 个</span><span class="dup-wasted">浪费 '+group.wastedHuman+'</span></div><span class="dup-toggle">▼</span>';
    hdr.addEventListener('click', function(e){if(e.target.closest('input'))return;this.classList.toggle('open');this.nextElementSibling.classList.toggle('open');this.querySelector('.dup-toggle').textContent=this.classList.contains('open')?'▼':'▶';});
    const body = document.createElement('div'); body.className='dup-group-body open';
    body.innerHTML='<div class="select-all-row"><label class="select-all-label"><input type="checkbox" class="group-select-all" checked> 全选本组（保留原始文件）</label></div>';
    group.files.forEach((file, fi) => {
      const isFirst = fi===0; const isChecked = !isFirst;
      if(isChecked){selCount++;selSize+=file.size;}
      let tagHtml='';
      if(file.id3){
        const t=[]; if(file.id3.title)t.push(escHtml(file.id3.title)); if(file.id3.artist)t.push(escHtml(file.id3.artist));
        if(t.length) tagHtml='<span class="file-tags">'+t.map(x=>'<span class="tag">'+x+'</span>').join('')+'</span>';
      }
      const item = document.createElement('div'); item.className='dup-file-item'; item.dataset.filePath=file.path;
      item.innerHTML='<input type="checkbox" class="file-checkbox" data-group="'+gi+'" data-index="'+fi+'" '+(isChecked?'checked':'')+'><span class="'+(isFirst?'file-original-badge':'file-duplicate-badge')+'">'+(isFirst?'★ 原始':'重复')+'</span><span class="file-path" title="'+escHtml(file.path)+'">'+escHtml(file.name||'')+'</span><span class="file-size">'+file.sizeHuman+'</span>'+tagHtml;
      if(isFirst)item.style.opacity='0.6';
      item.querySelector('.file-checkbox').addEventListener('change', updateDupSelectedCount);
      body.appendChild(item);
    });
    div.appendChild(hdr); div.appendChild(body); container.appendChild(div);
  });
  container.querySelectorAll('.group-select-all').forEach(cb=>{
    cb.addEventListener('change', function(){
      const pb=this.closest('.dup-group-body'); if(!pb)return;
      pb.querySelectorAll('.file-checkbox').forEach(c=>{const p=c.closest('.dup-file-item'); if(p&&p.querySelector('.file-original-badge'))return;c.checked=this.checked;});
      updateDupSelectedCount();
    });
  });
  container.querySelectorAll('.group-select-all').forEach(c=>c.checked=true);
  if($(ids.selectedCount))$(ids.selectedCount).textContent=selCount;
  if($(ids.selectedSize))$(ids.selectedSize).textContent=formatBytes(selSize);
  $(ids.actions)?.classList.add('visible');
  $(ids.deleteBtn)&&($(ids.deleteBtn).disabled=false);
  $(ids.exportBtn)&&($(ids.exportBtn).disabled=false);
  updateDupSelectedCount();
}

function updateDupSelectedCount() {
  const tab=document.querySelector('.dup-inner-tab-btn.active')?.dataset.dupTab||'music';
  const ids=getDupIds(tab); const dl=$(ids.dupList); if(!dl)return;
  let count=0, size=0;
  dl.querySelectorAll('.file-checkbox').forEach(cb=>{
    if(!cb.checked)return; count++;
    const gi=parseInt(cb.dataset.group), fi=parseInt(cb.dataset.index);
    const dup=DupState[tab]?.duplicates?.[gi]; if(dup&&dup.files[fi]) size+=dup.files[fi].size;
  });
  if($(ids.selectedCount))$(ids.selectedCount).textContent=count;
  if($(ids.selectedSize))$(ids.selectedSize).textContent=formatBytes(size);
  if($(ids.deleteBtn))$(ids.deleteBtn).disabled=count===0;
  if($(ids.exportBtn))$(ids.exportBtn).disabled=count===0;
}

// Dup controls
let pendingDupTab=null, pendingDupFiles=[];

async function pauseDupScan(tab) { if(DupState[tab].jobId) await API.post('api/dup/pause',{jobId:DupState[tab].jobId}); }
async function resumeDupScan(tab) {
  if(!DupState[tab].jobId) return;
  await API.post('api/dup/resume',{jobId:DupState[tab].jobId});
  const ids=getDupIds(tab); $(ids.pauseBtn)&&($(ids.pauseBtn).style.display=''); $(ids.resumeBtn)&&($(ids.resumeBtn).style.display='none');
  DupState[tab].checking=true; pollDupProgress(tab);
}
async function stopDupScan(tab) { if(DupState[tab].jobId){await API.post('api/dup/stop',{jobId:DupState[tab].jobId});DupState[tab].checking=false;} }

function showDupDeleteModal(tab) {
  const ids=getDupIds(tab); const dl=$(ids.dupList); if(!dl)return;
  const files=[...dl.querySelectorAll('.file-checkbox:checked')].map(cb=>cb.closest('.dup-file-item')).filter(Boolean).map(it=>it.dataset.filePath).filter(Boolean);
  if(files.length===0){showToast('请选择文件','error');return;}
  pendingDupTab=tab; pendingDupFiles=files;
  const d=$('dupDeleteModalDesc'); if(d)d.innerHTML='删除 <strong>'+files.length+'</strong> 个重复文件？';
  $('dupDeleteModal')?.classList.add('visible');
}
function hideDupDeleteModal(){ $('dupDeleteModal')?.classList.remove('visible'); pendingDupTab=null; pendingDupFiles=[]; }
async function confirmDupDelete() {
  const mode=document.querySelector('input[name="dupDeleteMode"]:checked')?.value||'trash';
  const tab=pendingDupTab, files=pendingDupFiles;
  $('dupDeleteModal')?.classList.remove('visible');
  if(!tab||!files.length)return;
  try {
    const r=await API.post('api/dup/delete',{files,mode});
    showToast('已'+(mode==='trash'?'回收':'删除')+' '+r.deleted+' 个文件','success');
    startDupScan(tab);
  } catch(e){showToast('删除失败: '+e.message,'error');}
  pendingDupTab=null; pendingDupFiles=[];
}
async function exportDup(tab) {
  const jobId=DupState[tab].jobId, dups=DupState[tab].duplicates;
  if(!dups||!dups.length){showToast('没有可导出的数据','error');return;}
  let exp=0;
  for(const g of dups){try{const r=await API.post('api/dup/export',{hash:g.hash,jobId});if(r.exported)exp++;}catch{}}
  showToast('已导出 '+exp+' 个重复组','success');
}

// Exports
window.toggleTheme=toggleTheme; window.switchTab=switchTab; window.doScan=doScan;
window.updateSelectInfo=updateSelectInfo; window.confirmDelete=confirmDelete; window.closeModal=closeModal; window.doDelete=doDelete;
window.showSponsorModal=showSponsorModal; window.showSponsorImgFull=showSponsorImgFull;
window.switchInnerTab=switchInnerTab; window.switchDupInnerTab=switchDupInnerTab;
window.loadDiskMounts=loadDiskMounts; window.updateDiskSelectInfo=updateDiskSelectInfo;
window.confirmDeleteVol02=confirmDeleteVol02;
window.loadDockerVolumes=loadDockerVolumes; window.updateDockerSelectInfo=updateDockerSelectInfo;
window.confirmDeleteDocker=confirmDeleteDocker; window.toggleDockerInuseList=toggleDockerInuseList;
window.doNetworksScan=doNetworksScan; window.updateNetworkSelectInfo=updateNetworkSelectInfo; window.confirmDeleteNetworks=confirmDeleteNetworks;
window.doImagesScan=doImagesScan; window.updateImagesSelectInfo=updateImagesSelectInfo; window.confirmDeleteImages=confirmDeleteImages;
window.doTempScan=doTempScan; window.updateTempSelectInfo=updateTempSelectInfo; window.confirmDeleteTemp=confirmDeleteTemp;
window.startDupScan=startDupScan; window.pauseDupScan=pauseDupScan; window.resumeDupScan=resumeDupScan; window.stopDupScan=stopDupScan;
window.showDupDeleteModal=showDupDeleteModal; window.hideDupDeleteModal=hideDupDeleteModal; window.confirmDupDelete=confirmDupDelete;
window.exportDup=exportDup;

// Auto-init
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>doScan());
else doScan();

})();
