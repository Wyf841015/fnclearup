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

const $ = id => document.getElementById(id.replace(/^#/, ''));

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
function showSponsorImgFull(img) { const o=document.getElementById('sponsorImgOverlay'); if(o){o.classList.add('show');document.getElementById('sponsorImgFull').src=img.src;} }

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
async function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tabName);b.setAttribute('aria-selected',b.dataset.tab===tabName?'true':'false');});
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.dataset.panel===tabName));
  if(tabName==='app') await doScan();
  else if(tabName==='disk') { App.diskMountsLoaded=false; await loadDiskMounts(true); }
  else if(tabName==='docker') { App.dockerVolumesLoaded=false; await loadDockerVolumes(); switchInnerTab('volumes'); }
  else if(tabName==='temp'&&!App.tempScanned) { App.tempScanned=true; await doTempScan(); }
  else if(tabName==='empty') { EmptyDirState.items=[]; $('empty-empty').style.display=''; $('empty-results').style.display='none'; $('empty-list').innerHTML=''; $('empty-status').textContent=''; $('empty-count').textContent='-'; $('empty-pending').textContent='-'; $('empty-elapsed').textContent='-'; }
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
const DupState = { music: { jobId: null, duplicates: [], checking: false }, files: { jobId: null, duplicates: [], checking: false } };

function getDupIds(tab) {
  return { pathInput: tab+'Path', scanBtn: tab+'ScanBtn', stopBtn: tab+'StopBtn', deleteBtn: tab+'DeleteBtn', exportBtn: tab+'ExportBtn', progress: tab+'Progress', progressBar: tab+'ProgressBar', progressText: tab+'ProgressText', progressCount: tab+'ProgressCount', currentFile: tab+'CurrentFile', status: tab+'Status', results: tab+'Results', stats: tab+'Stats', dupList: tab+'DupList', actions: tab+'Actions', selectedCount: tab+'SelectedCount', selectedSize: tab+'SelectedSize', empty: tab+'Empty' };
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

  const scanBtn=$(ids.scanBtn), stopBtn=$(ids.stopBtn);
  if(scanBtn){scanBtn.disabled=true;scanBtn.style.display='none';}
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
      cb.dataset.path=file.path; cb.dataset.size=file.size; cb.checked=isChecked;
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
    const db=$(tab+'DeleteBtn');
    if(db)db.disabled=count===0;
  });
}

function formatBytes(b){if(b===0)return'0 B';const u=['B','KB','MB','GB','TB'];const i=Math.floor(Math.log(b)/Math.log(1024));return(b/Math.pow(1024,i)).toFixed(1)+' '+u[i];}

// ── Version Check ──
function checkVersion() {
  const badge = document.getElementById('versionBadge');
  if (!badge) return;
  // Try to get current version from API
  fetch('/app/fnclearup/api/version').then(r=>r.json()).then(d=>{
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
  const paths=[...document.querySelectorAll('.dup-file-cb:checked:not(.group-select-all)')].map(cb=>cb.dataset.path);
  if(!paths.length){hideDupDeleteModal();return;}
  hideDupDeleteModal();
  try{
    const r=await API.post('api/dup/delete',{files:paths,mode});
    const msg=`已删除 ${r.deleted||0} 个文件`;
    if(r.failed&&r.failed.length) showToast(msg+'，失败 '+r.failed.length+' 个: '+r.failed.map(f=>f.reason).join('; '),'warning');
    else showToast(msg,'success');
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
function showBrowseModal(inputId) {
  _browseTargetId = inputId;
  const input = document.getElementById(inputId);
  const path = input ? input.value || '/' : '/';
  document.getElementById('browseModal').classList.add('visible');
  loadBrowseDir(path);
}
function hideBrowseModal() {
  document.getElementById('browseModal')?.classList.remove('visible');
}
async function loadBrowseDir(dirPath) {
  const list = document.getElementById('browseList');
  const pathEl = document.getElementById('browsePath');
  if (pathEl) pathEl.textContent = dirPath;
  if (list) list.innerHTML = '<div class="browse-item" style="justify-content:center;color:var(--color-text-secondary);cursor:default">⏳ 加载中...</div>';
  try {
    const r = await fetch('/app/fnclearup/api/browse?path=' + encodeURIComponent(dirPath));
    const data = await r.json();
    if (!data.success) { if (list) list.innerHTML = '<div class="browse-item" style="justify-content:center;color:var(--color-danger);cursor:default">❌ ' + (data.error||'加载失败') + '</div>'; return; }
    if (list) {
      let html = '';
      if (data.parent) html += '<div class="browse-item dir" onclick="browseGoUp()" style="color:var(--color-primary)">⬆ ..</div>';
      for (const e of data.entries) {
        if (e.isDirectory) html += '<div class="browse-item dir" onclick="loadBrowseDir(\'' + e.path.replace(/'/g,"\\'") + '\')">📁 ' + escHtml(e.name) + '</div>';
        else html += '<div class="browse-item file">📄 ' + escHtml(e.name) + '</div>';
      }
      if (data.entries.length === 0) html = '<div class="browse-item" style="justify-content:center;color:var(--color-text-secondary);cursor:default">📂 空目录</div>';
      list.innerHTML = html;
    }
  } catch(e) { if (list) list.innerHTML = '<div class="browse-item" style="justify-content:center;color:var(--color-danger);cursor:default">❌ ' + e.message + '</div>'; }
}
function browseGoUp() {
  const p = document.getElementById('browsePath');
  if (!p) return;
  const cur = p.textContent;
  const parent = cur === '/' ? null : cur.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  if (parent) loadBrowseDir(parent);
}
function browseSelect() {
  const p = document.getElementById('browsePath');
  if (!p || !_browseTargetId) return;
  const input = document.getElementById(_browseTargetId);
  if (input) input.value = p.textContent;
  hideBrowseModal();
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
      '<td><button type="button" class="btn btn-danger btn-sm" onclick="confirmEmptyDeleteOne(\'' + item.path.replace(/'/g, "\\'") + '\')">🗑</button></td>';
    tbody.appendChild(tr);
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
    const msg = '已删除 ' + (r.deleted || 0) + ' 个空目录';
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

function getSysCleanRiskFilter() {
  return document.querySelector('input[name="syscleanRiskFilter"]:checked')?.value || 'all';
}

async function doSysCleanScan() {
  const btn = $('syscleanScanBtn');
  const status = $('sysclean-status');
  const list = $('sysclean-list');
  const empty = $('sysclean-empty');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span><span>扫描中...</span>'; }
  if (status) { status.className = 'loading'; status.textContent = '⏳ 正在扫描系统缓存...'; }
  if (list) list.innerHTML = '';
  if (empty) empty.style.display = 'none';
  try {
    const data = await API.get('api/sysclean/scan');
    SysCleanState.items = data.items || [];
    SysCleanState.scanLoaded = true;
    if ($('sysclean-count')) $('sysclean-count').textContent = data.count || 0;
    if ($('sysclean-total')) $('sysclean-total').textContent = data.total_size_str || '0 B';
    renderSysCleanList();
    if (status) { status.className = 'success'; status.textContent = `✅ 共 ${data.count} 项，可释放 ${data.total_size_str}`; }
  } catch (e) {
    if (status) { status.className = 'error'; status.textContent = '❌ 扫描失败: ' + e.message; }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>🔍</span><span>扫描缓存</span>'; }
  }
}

function renderSysCleanList() {
  const list = $('sysclean-list');
  if (!list) return;
  const filter = getSysCleanRiskFilter();
  const items = SysCleanState.items.filter(it => {
    if (filter === 'low') return it.risk === 'low';
    if (filter === 'medium') return it.risk === 'low' || it.risk === 'medium';
    return true; // 'all' shows everything
  });
  if (items.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--color-text-secondary)">没有匹配的项</div>';
    return;
  }
  let html = '<div class="list-scroll"><table class="data-table" id="sysclean-table"><thead><tr>' +
    '<th style="width:36px"><input type="checkbox" class="select-all-cb" onchange="selectAllSysClean(this)"></th>' +
    '<th style="width:64px">风险</th><th>名称</th><th>路径</th><th style="text-align:right">大小</th>' +
    '</tr></thead><tbody>';
  for (const it of items) {
    const r = RISK_LABELS[it.risk] || RISK_LABELS.low;
    const isDangerous = it.risk === 'dangerous';
    const checked = it.recommended ? 'checked' : '';
    const disabled = isDangerous ? 'disabled' : '';
    const rowStyle = isDangerous ? 'style="opacity:0.6"' : '';
    const riskBadge = `<span class="file-badge" style="background:${r.bg};color:${r.color}">${r.label}</span>`;
    html += `<tr ${rowStyle}>
      <td><input type="checkbox" class="sysclean-cb" value="${escHtml(it.id)}" data-size="${it.size}" data-label="${escHtml(it.label)}" onchange="updateSysCleanSelectInfo()" ${checked} ${disabled}></td>
      <td>${riskBadge}</td>
      <td style="white-space:nowrap" title="${escHtml(it.label)}">${escHtml(it.name || it.label)}</td>
      <td style="font-family:monospace;font-size:12px;color:var(--color-text-secondary);max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(it.path)}">${escHtml(it.path)}</td>
      <td style="text-align:right;font-family:monospace;font-size:13px">${escHtml(it.size_str)}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  list.innerHTML = html;
  updateSysCleanSelectInfo();
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
  try { localStorage.setItem(SYSCLEAN_BACKUP_KEY, cb.checked ? '1' : '0'); } catch {}
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
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = `下载失败 (HTTP ${res.status})`;
      try { const j = await res.json(); if (j.error) msg = `下载失败: ${j.error}`; } catch {}
      showToast(msg, 'error', 5000);
      return;
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name || 'manifest.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    showToast(`✅ 已下载 ${name}`, 'success', 3000);
  } catch (e) {
    showToast('下载失败: ' + e.message, 'error', 5000);
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
    const res = await fetch(`api/sysclean/manifest?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = `加载失败 (HTTP ${res.status})`;
      try { const j = await res.json(); if (j.error) msg = `加载失败: ${j.error}`; } catch {}
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
// Startup warning modal
// ════════════════════════════════
let _startupCountdownTimer = null;
let _startupCountdownLeft = 3;

// Show the warning modal on every app open. The "我已知晓风险" button is
// disabled for 3 seconds (forces user to actually read the message). "稍后再说"
// closes the modal but does NOT mark anything — the warning re-appears the
// next time the user clicks any delete button (we re-call showStartupWarning()
// from there too, see _bumpStartupWarning()).
function showStartupWarning() {
  const modal = $('startupWarningModal');
  if (!modal) return;
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
  }
}

// ════════════════════════════════
// Init
// ════════════════════════════════
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
else init();

function init() {
  doScan();

  // Check version from FnDepot
  checkVersion();

  // Export all functions to window for inline onclick and event delegation
  const exports = {
    toggleTheme, showSponsorModal, showSponsorImgFull,
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
    updateDupSelectedCount,
    showBrowseModal, hideBrowseModal, loadBrowseDir, browseGoUp, browseSelect,
    startEmptyScan, stopEmptyScan, selectAllEmpty, updateEmptySelectInfo,
    showEmptyDeleteModal, hideEmptyDeleteModal, confirmEmptyDelete, confirmEmptyDeleteOne,
    doSysCleanScan, renderSysCleanList, selectAllSysClean, selectAllSysCleanRecommended,
    updateSysCleanSelectInfo, showSysCleanDeleteModal, hideSysCleanDeleteModal, doSysCleanDelete,
    toggleSysCleanBackup, getSysCleanBackupEnabled, showSysCleanManifests, hideSysCleanManifests,
    downloadSysCleanManifest, viewSysCleanManifest,
    showStartupWarning, closeStartupWarning,
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

  // Show startup warning modal on every app open (force user to acknowledge risk)
  showStartupWarning();
}

})();
