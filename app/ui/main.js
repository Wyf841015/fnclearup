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

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

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
    }
  });
}

// ════════════════════════════════
// Tab switching
// ════════════════════════════════
async function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tabName);b.setAttribute('aria-selected',b.dataset.tab===tabName?'true':'false');});
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.dataset.panel===tabName));
  if(tabName==='app') await doScan();
  else if(tabName==='disk') { App.diskMountsLoaded=false; await loadDiskMounts(true); }
  else if(tabName==='docker') { App.dockerVolumesLoaded=false; await loadDockerVolumes(); switchInnerTab('volumes'); }
  else if(tabName==='temp'&&!App.tempScanned) { App.tempScanned=true; await doTempScan(); }
}

// ════════════════════════════════
// App Scan
// ════════════════════════════════
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
          <td style="font-family:monospace;font-size:13px;white-space:nowrap">${escHtml(row.appname)}</td>
          <td style="font-size:13px">${escHtml(row.displayName)}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(volsUsed||'-')}</td>
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
  try {
    const r=await API.post('api/delete',{paths:allPaths,delete_users:delUsers,delete_appshare_residual:delAppshare});
    const msg=`已删除 ${r.total||0} 个，失败 ${r.failures||0} 个`;
    if(r.users_deleted&&r.users_deleted.length) msg+=`，已删用户 ${r.users_deleted.join(',')}`;
    showToast(msg,'success');
    await doScan();
  } catch(e){showToast('删除失败: '+e.message,'error');}
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
          <td style="font-family:monospace;font-size:13px;white-space:nowrap" title="${escHtml(fullPath)}">${escHtml(dirName)}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${mountDisplay}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${cstStr}</td>
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
  document.querySelectorAll('.inner-tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.innerTab===tabName));
  document.querySelectorAll('.inner-panel').forEach(p=>p.classList.toggle('active',p.dataset.innerPanel===tabName));
  if(tabName==='images'&&!App.dockerImagesLoaded){App.dockerImagesLoaded=true;doImagesScan();}
  else if(tabName==='volumes'&&!App.dockerVolumesLoaded)loadDockerVolumes();
  else if(tabName==='networks'&&!App.dockerNetworksLoaded){App.dockerNetworksLoaded=true;doNetworksScan();}
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
          <td style="font-family:monospace;font-size:13px;white-space:nowrap">${escHtml(vol.name)}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(vol.driver||'-')}</td>
          <td style="font-family:monospace;font-size:12px;color:var(--color-text-secondary);max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(vol.mountpoint||'-')}">${escHtml(vol.mountpoint||'-')}</td>
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
  doDeleteDocker();
}
async function doDeleteDocker() {
  const vols=[...document.querySelectorAll('.docker-cb:checked')].map(cb=>cb.value);
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
          <td style="font-family:monospace;font-size:13px;white-space:nowrap">${escHtml(net.name)}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(net.driver)}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(net.scope)}</td>
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
  doDeleteNetworks();
}
async function doDeleteNetworks() {
  const nets=[...document.querySelectorAll('.network-cb:checked')].map(cb=>cb.value);
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
          <td style="font-family:monospace;font-size:13px;white-space:nowrap" title="${escHtml(img.repository)}">${escHtml(img.repository)}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(img.tag)}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(img.id)}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(img.size)}</td>
          <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(img.created)}</td>
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
            <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(item.dir)}</td>
            <td>${typeLabel}</td>
            <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${escHtml(item.size_str||'-')}</td>
            <td style="font-family:monospace;font-size:13px;color:var(--color-text-secondary)">${item.age_hours}h</td>
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

// ════════════════════════════════
// Duplicate File Scanning
// ════════════════════════════════
const DupState = { music: { jobId: null, duplicates: [], checking: false }, files: { jobId: null, duplicates: [], checking: false } };

function getDupIds(tab) {
  return { pathInput: tab+'Path', scanBtn: tab+'ScanBtn', pauseBtn: tab+'PauseBtn', resumeBtn: tab+'ResumeBtn', stopBtn: tab+'StopBtn', deleteBtn: tab+'DeleteBtn', exportBtn: tab+'ExportBtn', progress: tab+'Progress', progressBar: tab+'ProgressBar', progressText: tab+'ProgressText', progressCount: tab+'ProgressCount', currentFile: tab+'CurrentFile', status: tab+'Status', results: tab+'Results', stats: tab+'Stats', dupList: tab+'DupList', actions: tab+'Actions', selectedCount: tab+'SelectedCount', selectedSize: tab+'SelectedSize', empty: tab+'Empty' };
}

function switchDupInnerTab(tabName) {
  document.querySelectorAll('.dup-inner-tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.dupTab===tabName));
  document.querySelectorAll('.dup-inner-panel').forEach(p=>p.classList.toggle('active',p.dataset.dupPanel===tabName));
  updateDupSelectedCount();
}

async function startDupScan(tab) {
  const ids = getDupIds(tab);
  if (DupState[tab].checking) { showToast('已有扫描任务进行中', 'error'); return; }
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
      else if(data.status==='hashing'){if(txt)txt.textContent='正在计算哈希值...';if(statusEl)statusEl.innerHTML='<span class="dup-spinner"></span> 哈希 ('+processed+'/'+total+')';if(cur){var hp=p.hashProgress||'';cur.textContent=p.currentFile+(hp?' ('+hp+')':'');}}
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
    // Per-group delete button
    (function(t, b){
      var btn = document.createElement('button');
      btn.className = 'dup-group-delete-btn';
      btn.textContent = '\u{1F5D1}';
      btn.title = '删除本组重复文件（保留第一个原始文件）';
      btn.onclick = function(e){
        e.stopPropagation();
        document.querySelectorAll('.dup-file-cb:not(.group-select-all)').forEach(function(c){c.checked=false;});
        b.querySelectorAll('.dup-file-cb:not(.group-select-all)').forEach(function(c){c.checked=true;c.dispatchEvent(new Event('change'));});
        showDupDeleteModal(t);
      };
      hdr.appendChild(btn);
    })(tab, body);
    hdr.addEventListener('click', function(e){if(e.target.closest('input')||e.target.closest('button'))return;this.classList.toggle('open');this.nextElementSibling.classList.toggle('open');this.querySelector('.dup-toggle').textContent=this.classList.contains('open')?'\u25BC':'\u25B6';});
    const body = document.createElement('div'); body.className='dup-group-body open';
    hdr.classList.add('open');

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
      cb.dataset.path=file.path; cb.dataset.size=file.size; cb.checked=isChecked;
      if(isFirst)cb.disabled=true;
      cb.addEventListener('change', function(){updateDupSelectedCount();});
      const label = document.createElement('span'); label.className='dup-file-label';
      const sizeSpan = document.createElement('span'); sizeSpan.className='dup-file-size'; sizeSpan.textContent=' ('+group.sizeHuman+')';
      label.textContent=' '+file.path; label.prepend(cb);
      const tag = document.createElement('span'); tag.className='dup-file-tag'; tag.textContent=isFirst?'原始文件':'重复文件';
      item.appendChild(label); item.appendChild(sizeSpan); item.appendChild(tag); body.appendChild(item);
    });
    div.appendChild(hdr); div.appendChild(body); container.appendChild(div);
  });
  updateDupSelectedCount();
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
    const db=$(tab+'DeleteBtn'); const eb=$(tab+'ExportBtn');
    if(db)db.disabled=count===0; if(eb)eb.disabled=count===0;
  });
}

function formatBytes(b){if(b===0)return'0 B';const u=['B','KB','MB','GB','TB'];const i=Math.floor(Math.log(b)/Math.log(1024));return(b/Math.pow(1024,i)).toFixed(1)+' '+u[i];}

function pauseDupScan(tab){
  const jobId=DupState[tab].jobId; if(!jobId)return;
  API.post('api/dup/pause',{jobId}).then(r=>{if(r.success)showToast('已暂停','info');else showToast(r.error||'暂停失败','error');}).catch(e=>showToast('暂停失败','error'));
}
function resumeDupScan(tab){
  const jobId=DupState[tab].jobId; if(!jobId)return;
  API.post('api/dup/resume',{jobId}).then(r=>{if(r.success)showToast('已继续','info');else showToast(r.error||'继续失败','error');}).catch(e=>showToast('继续失败','error'));
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
  const paths=[...document.querySelectorAll('.dup-file-cb:checked:not(.group-select-all)')].map(cb=>cb.dataset.path);
  if(!paths.length){hideDupDeleteModal();return;}
  hideDupDeleteModal();
  try{
    const r=await API.post('api/dup/delete',{files:paths,mode});
    showToast(`已删除 ${r.deleted||0} 个文件`,'success');
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
  const dups=DupState[tab].duplicates; if(!dups||!dups.length){showToast('无重复数据可导出','error');return;}
  try{
    const r=await API.post('api/dup/export',{type:tab==='music'?'music':'files',duplicates:dups});
    if(r.filename)showToast('报告已导出: '+r.filename,'success');
    else showToast(JSON.stringify(r),'info');
  }catch(e){showToast('导出失败: '+e.message,'error');}
}

// ════════════════════════════════
// Init
// ════════════════════════════════
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
else init();

function init() {
  doScan();

  // Export all functions to window for inline onclick and event delegation
  const exports = {
    toggleTheme, showSponsorModal, showSponsorImgFull,
    switchTab,
    doScan, selectAllApp, updateSelectInfo,
    confirmDelete, doDelete, closeModal,
    loadDiskMounts, selectAllDisk, updateDiskSelectInfo,
    confirmDeleteVol02,
    switchInnerTab, loadDockerVolumes,
    selectAllDockerVol, updateDockerSelectInfo,
    confirmDeleteDocker,
    doNetworksScan, selectAllNetworks,
    updateNetworkSelectInfo, confirmDeleteNetworks,
    doImagesScan, selectAllImages,
    updateImagesSelectInfo, confirmDeleteImages,
    doTempScan, selectAllTemp, updateTempSelectInfo,
    confirmDeleteTemp,
    switchDupInnerTab, startDupScan,
    pauseDupScan, resumeDupScan, stopDupScan,
    showDupDeleteModal, hideDupDeleteModal,
    confirmDupDelete, exportDup,
    updateDupSelectedCount,
  };
  Object.assign(window, exports);

  // Convert all inline [onclick] buttons to event listeners (bypass IIFE scope issue)
  document.querySelectorAll('[onclick]').forEach(el => {
    const attr = el.getAttribute('onclick');
    const fnName = attr.replace(/\(.*\)/, '').trim();
    if (typeof window[fnName] === 'function') {
      el.removeAttribute('onclick');
      el.addEventListener('click', function(e) {
        const match = attr.match(/\(([^)]*)\)/);
        if (match && match[1].trim()) {
          const args = match[1].split(',').map(a => a.trim().replace(/^['"]|['"]$/g, ''));
          window[fnName](...args);
        } else {
          window[fnName]();
        }
      });
    }
  });

  // Direct bind for sponsor button (addEventListener version, bypassing the above in case of issues)
  const sponsorBtn = document.querySelector('.sponsor-btn');
  if (sponsorBtn) sponsorBtn.addEventListener('click', function(e) {
    document.querySelector('#sponsorModal').classList.add('show');
  });
}

})();
