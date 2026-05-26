import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, readdirSync, unlinkSync, writeFileSync, readFileSync, renameSync, cpSync, readlinkSync } from 'node:fs';
import { readdir, stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, extname, basename, dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// ── Config ──
const UI_DIR     = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = dirname(UI_DIR);
const PKGVAR     = process.env.TRM_PKGVAR || null;
const DATA_DIR   = PKGVAR ? join(PKGVAR, 'data') : join(TARGET_DIR, 'data');
const PORT       = parseInt(process.env.PORT || '47938', 10);
const SOCK_NAME  = 'fnclearup.sock';
const SOCK_PATH  = join(TARGET_DIR, SOCK_NAME);
const DUP_STATE_DIR = join(DATA_DIR, 'dup');
const VERSION    = '0.7.0';

const VOL_GLOBS = ['/vol1','/vol2','/vol3','/vol4','/vol5','/vol6','/vol7','/vol8','/vol9','/vol10'];
const SAFE_PREFIXES = new Set(VOL_GLOBS.map(v => v + '/'));
const MUSIC_EXTS = new Set(['.mp3','.flac','.wav','.aac','.ogg','.m4a','.wma','.alac','.ape','.dsf']);
const SYSTEM_NETWORKS = new Set(['bridge','host','none','container']);
const TEMP_DIRS = ['/tmp', '/var/tmp'];
const DUP_SCAN_SCRIPT = join(TARGET_DIR, 'dup_scan.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Helpers ──
function formatBytes(b) {
  if (b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

async function parseBody(req) {
  if (req.method === 'GET') return {};
  const bufs = [];
  for await (const chunk of req) bufs.push(chunk);
  try { return JSON.parse(Buffer.concat(bufs).toString()); }
  catch { return {}; }
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function execCmd(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => stdout += c);
    proc.stderr.on('data', c => stderr += c);
    proc.on('close', code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    proc.on('error', e => resolve({ code: -1, stdout: '', stderr: e.message }));
  });
}

function isSafePath(p) {
  const n = resolve(p);
  return [...SAFE_PREFIXES].some(pre => n.startsWith(pre));
}

function parseQuery(url) {
  const q = url.searchParams;
  const o = {};
  for (const [k, v] of q) o[k] = v;
  return o;
}

// ── Version / Ping ──
// GET /api/version
function handleVersion(req, res) {
  sendJSON(res, 200, { version: VERSION, success: true });
}

// GET /api/ping
function handlePing(req, res) {
  sendJSON(res, 200, { ok: true, method: req.method, uri: req.url });
}

// ── App Scan / Delete ──
// POST /api/scan
async function handleScan(req, res) {
  const result = await execCmd('appcenter-cli', ['list'], 30000);
  const installed = [];
  if (result.code === 0) {
    for (const line of result.stdout.split('\n')) {
      const parts = line.split('│').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 3 && parts[0] !== 'APP') {
        installed.push({ appname: parts[0], display_name: parts[1] });
      }
    }
  }
  // Collect @app* dirs
  const allAppDirs = [];
  for (const vp of VOL_GLOBS) {
    if (existsSync(vp)) {
      const entries = readdirSync(vp, { withFileTypes: true }).filter(e => e.name.startsWith('@app') && e.isDirectory());
      for (const e of entries) allAppDirs.push(join(vp, e.name));
    }
  }
  const allInstDirs = [];
  for (const ad of allAppDirs) {
    if (existsSync(ad)) {
      const entries = readdirSync(ad, { withFileTypes: true }).filter(e => e.isDirectory());
      for (const e of entries) allInstDirs.push(join(ad, e.name));
    }
  }
  const installedNames = new Set(installed.map(a => a.appname.toLowerCase()));
  const orphanDirs = [];
  for (const d of allInstDirs) {
    const name = basename(d).toLowerCase();
    let isInstalled = installedNames.has(name);
    if (!isInstalled && name.endsWith('-docker')) isInstalled = installedNames.has(name.slice(0, -7));
    if (!isInstalled && name.startsWith('docker-')) isInstalled = installedNames.has(name.slice(7));
    if (!isInstalled) {
      let subdirs = [];
      try { subdirs = readdirSync(d); } catch {}
      orphanDirs.push({ app: basename(d), vol: dirname(dirname(d)), path: d, dirs: subdirs });
    }
  }
  sendJSON(res, 200, { installed, orphan: orphanDirs, success: true });
}

// POST /api/delete
async function handleDelete(req, res) {
  const data = await parseBody(req);
  const deleteUsers = !!data.delete_users;
  const paths = (data.paths || []).filter(p => isSafePath(p));
  const deleted = [], failed = [], usersDeleted = [], usersFailed = [];
  for (const p of paths) {
    try {
      await execCmd('chattr', ['-i', p], 5000).catch(() => {});
      if (existsSync(p)) {
        const r = await execCmd('rm', ['-rf', p], 60000);
        if (r.code === 0) deleted.push(p);
        else failed.push(p);
      }
    } catch { failed.push(p); }
  }
  if (deleteUsers) {
    for (const p of paths) {
      const m = p.match(/(@app\d+)\/([^/]+)/);
      if (!m) continue;
      const username = m[2];
      const r = await execCmd('id', [username], 5000);
      if (r.code === 0) {
        const dr = await execCmd('userdel', ['-r', username], 30000);
        if (dr.code === 0) usersDeleted.push(username);
        else usersFailed.push(username);
      } else usersFailed.push(username);
    }
  }
  sendJSON(res, 200, { deleted, failed, total: deleted.length, failures: failed.length, users_deleted: usersDeleted, users_failed: usersFailed, success: true });
}

// ── Mounts / Vol02 ──
// GET /api/mounts
function handleMounts(req, res) {
  try {
    if (existsSync('/etc/mountmgr/mount_info.json')) {
      const raw = JSON.parse(readFileSync('/etc/mountmgr/mount_info.json', 'utf-8'));
      const mounts = [];
      for (const uidEntry of Object.values(raw)) {
        for (const me of Object.values(uidEntry)) {
          if (me.mountPoint) mounts.push(me);
        }
      }
      sendJSON(res, 200, { mounts, success: true });
      return;
    }
  } catch {}
  sendJSON(res, 200, { mounts: [], success: false, message: 'mount_info.json not found' });
}

// GET /api/vol02
function handleVol02(req, res) {
  let dirs = [];
  if (existsSync('/vol02')) {
    dirs = readdirSync('/vol02').filter(e => statSync(join('/vol02', e)).isDirectory()).sort();
  }
  let mounts = [];
  try {
    if (existsSync('/etc/mountmgr/mount_info.json')) {
      const raw = JSON.parse(readFileSync('/etc/mountmgr/mount_info.json', 'utf-8'));
      for (const uidEntry of Object.values(raw)) {
        for (const me of Object.values(uidEntry)) {
          if (me.mountPoint) mounts.push(me.mountPoint);
        }
      }
    }
  } catch {}
  sendJSON(res, 200, { vol02_dirs: dirs, mounted_points: mounts, success: true });
}

// ── Docker ──
// GET /api/volumes
async function handleVolumes(req, res) {
  const r = await execCmd('docker', ['volume', 'ls', '-q']);
  if (r.code !== 0 || !r.stdout) {
    sendJSON(res, 200, { volumes: { all: [], in_use: [], orphan: [] }, success: true, message: 'docker not available' });
    return;
  }
  const names = r.stdout.split('\n').filter(Boolean);
  if (!names.length) {
    sendJSON(res, 200, { volumes: { all: [], in_use: [], orphan: [] }, success: true, counts: { total: 0, in_use: 0, orphan: 0 } });
    return;
  }
  const ri = await execCmd('docker', ['volume', 'inspect', '--format', '{{.Name}}|{{.Driver}}|{{.Mountpoint}}', ...names]);
  const volInfo = {};
  for (const line of ri.stdout.split('\n')) {
    const p = line.split('|');
    if (p[0]) volInfo[p[0]] = { driver: p[1] || '', mountpoint: p[2] || '' };
  }
  const rp = await execCmd('docker', ['ps', '-a', '--format', '{{.ID}}|{{.Names}}']);
  const cidToName = {};
  for (const line of rp.stdout.split('\n')) {
    const p = line.split('|');
    if (p.length === 2) cidToName[p[0]] = p[1];
  }
  const volContainers = {};
  for (const [cid] of Object.entries(cidToName)) {
    const ri2 = await execCmd('docker', ['inspect', '--type', 'container', '--format', '{{json .Mounts}}', cid], 10000);
    if (ri2.code !== 0) continue;
    try {
      const mounts = JSON.parse(ri2.stdout);
      for (const m of mounts) {
        if (m.Name) (volContainers[m.Name] ||= []).push(cidToName[cid]);
      }
    } catch {}
  }
  const inUse = [], orphan = [];
  for (const name of names) {
    const info = volInfo[name] || {};
    const entry = { name, driver: info.driver, mountpoint: info.mountpoint, containers: volContainers[name] || [] };
    (volContainers[name] ? inUse : orphan).push(entry);
  }
  sendJSON(res, 200, {
    volumes: { all: names, in_use: inUse, orphan },
    success: true,
    counts: { total: names.length, in_use: inUse.length, orphan: orphan.length }
  });
}

// POST /api/volumes/delete
async function handleVolumesDelete(req, res) {
  const data = await parseBody(req);
  const names = data.volumes || [];
  const deleted = [], failed = [], errors = [];
  for (const n of names) {
    const r = await execCmd('docker', ['volume', 'rm', n]);
    if (r.code === 0) deleted.push(n);
    else { failed.push(n); errors.push(`${n}: ${r.stderr}`); }
  }
  sendJSON(res, 200, { deleted, failed, total: deleted.length, failures: failed.length, errors, success: true });
}

// GET /api/networks
async function handleNetworks(req, res) {
  const r = await execCmd('docker', ['network', 'ls', '--format', '{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}']);
  if (r.code !== 0) {
    sendJSON(res, 200, { networks: { all: [], used: [], unused: [] }, success: true, message: 'docker not available' });
    return;
  }
  const allNets = [];
  for (const line of r.stdout.split('\n')) {
    const p = line.split('|');
    if (p.length >= 4) allNets.push({ id: p[0], name: p[1], driver: p[2], scope: p[3], containers: 0, unused: false });
  }
  if (allNets.length) {
    const ri = await execCmd('docker', ['network', 'inspect', '--format', '{{.Name}}|{{range .Containers}}{{.Name}}:{{end}}', ...allNets.map(n => n.name)]);
    const connected = {};
    for (const line of ri.stdout.split('\n')) {
      const p = line.split('|');
      if (p.length >= 2) connected[p[0]] = p[1].split(':').filter(Boolean);
    }
    for (const net of allNets) {
      net.containers = (connected[net.name] || []).length;
      net.unused = net.containers === 0 && !SYSTEM_NETWORKS.has(net.name);
    }
  }
  const unused = allNets.filter(n => n.unused);
  sendJSON(res, 200, {
    networks: { all: allNets, used: allNets.filter(n => !n.unused), unused },
    success: true,
    counts: { total: allNets.length, used: allNets.length - unused.length, unused: unused.length }
  });
}

// POST /api/networks/delete
async function handleNetworksDelete(req, res) {
  const data = await parseBody(req);
  const nets = data.networks || [];
  const deleted = [], failed = [], errors = [];
  for (const n of nets) {
    const r = await execCmd('docker', ['network', 'rm', n]);
    if (r.code === 0) deleted.push(n);
    else { failed.push(n); errors.push(`${n}: ${r.stderr}`); }
  }
  sendJSON(res, 200, { deleted, failed, total: deleted.length, failures: failed.length, errors, success: true });
}

// GET /api/images
async function handleImages(req, res) {
  const r = await execCmd('docker', ['images', '--format', '{{.Repository}}|{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedSince}}']);
  if (r.code !== 0) {
    sendJSON(res, 200, { images: { all: [], used: [], unused: [], dangling: [] }, success: true, message: 'docker not available' });
    return;
  }
  const all = [], dangling = [];
  for (const line of r.stdout.split('\n')) {
    const p = line.split('|');
    if (p.length < 5) continue;
    const isDangling = p[0] === '<none>' && p[1] === '<none>';
    const entry = { id: p[2], repository: p[0], tag: p[1], size: p[3], created: p[4], dangling: isDangling, used: false };
    all.push(entry);
    if (isDangling) dangling.push(entry);
  }
  const rp = await execCmd('docker', ['ps', '-a', '--format', '{{.Image}}']);
  const usedNames = new Set(rp.stdout.split('\n').filter(Boolean));
  for (const img of all) {
    const name = img.tag !== '<none>' ? `${img.repository}:${img.tag}` : img.id;
    img.used = usedNames.has(name) || usedNames.has(img.id) || usedNames.has(img.id.replace('sha256:', ''));
  }
  const used = all.filter(i => i.used);
  const unused = all.filter(i => !i.used && !i.dangling);
  sendJSON(res, 200, {
    images: { all, used, unused, dangling, counts: { total: all.length, used: used.length, unused: unused.length, dangling: dangling.length } },
    success: true
  });
}

// POST /api/images/delete
async function handleImagesDelete(req, res) {
  const data = await parseBody(req);
  const ids = data.images || [];
  let deleted = 0, failures = 0;
  const errors = [];
  for (const id of ids) {
    const r = await execCmd('docker', ['rmi', id], 60000);
    if (r.code === 0) deleted++;
    else { failures++; errors.push(`${id}: ${r.stderr}`); }
  }
  sendJSON(res, 200, { success: true, total: deleted, failures, errors });
}

// GET /api/system
async function handleSystem(req, res) {
  const info = {};
  // Disk
  try {
    const r = await execCmd('df', ['-B1', '--output=target,size,used,avail,pcent', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs']);
    const lines = r.stdout.split('\n').filter(Boolean);
    const disks = [];
    for (const line of lines.slice(1)) {
      const p = line.split(/\s+/);
      if (p.length >= 5) disks.push({ mount: p[0], total: parseInt(p[1]) || 0, used: parseInt(p[2]) || 0, avail: parseInt(p[3]) || 0, pcent: parseInt((p[4] || '0').replace('%', '')) });
    }
    info.disk = { partitions: disks };
  } catch { info.disk = {}; }
  // Memory
  try {
    const r = await execCmd('free', ['-b']);
    const mem = {};
    for (const line of r.stdout.split('\n')) {
      const p = line.split(/\s+/);
      if (p[0] && p.length >= 3) mem[p[0].replace(':', '')] = { total: parseInt(p[1]) || 0, used: parseInt(p[2]) || 0, free: parseInt(p[3]) || 0 };
    }
    info.memory = mem;
  } catch { info.memory = {}; }
  // Docker
  info.docker = { available: false, running_containers: 0, total_volumes: 0, total_networks: 0 };
  const rd = await execCmd('docker', ['info'], 5000);
  if (rd.code === 0) {
    info.docker.available = true;
    const rp = await execCmd('docker', ['ps', '-q']);
    info.docker.running_containers = rp.stdout.split('\n').filter(Boolean).length;
    const rv = await execCmd('docker', ['volume', 'ls', '-q']);
    info.docker.total_volumes = rv.stdout.split('\n').filter(Boolean).length;
    const rn = await execCmd('docker', ['network', 'ls', '-q']);
    info.docker.total_networks = rn.stdout.split('\n').filter(Boolean).length;
  }
  sendJSON(res, 200, { success: true, data: info });
}

// ── Temp files ──
// GET /api/temp/scan
function handleTempScan(req, res) {
  const result = { dirs: [], files: [], total_size: 0, counts: { dirs: 0, files: 0 } };
  let totalSize = 0;
  for (const dir of TEMP_DIRS) {
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        const ageHours = (Date.now() / 1000 - st.atimeMs / 1000) / 3600;
        if (ageHours < 24) continue;
        const isDir = st.isDirectory();
        const item = { path: full, name: entry, dir, age_hours: Math.round(ageHours * 10) / 10, size: st.size, size_str: formatBytes(st.size), is_dir: isDir, type: isDir ? 'dir' : 'file' };
        (isDir ? result.dirs : result.files).push(item);
        totalSize += st.size;
      } catch {}
    }
  }
  result.dirs.sort((a, b) => b.age_hours - a.age_hours);
  result.files.sort((a, b) => b.age_hours - a.age_hours);
  result.total_size = totalSize;
  result.total_size_str = formatBytes(totalSize);
  result.counts.dirs = result.dirs.length;
  result.counts.files = result.files.length;
  sendJSON(res, 200, { ...result, success: true });
}

// POST /api/temp/delete
async function handleTempDelete(req, res) {
  const data = await parseBody(req);
  const paths = data.paths || [];
  const deleted = [], failed = [], errors = [];
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const st = statSync(p);
        if (st.isDirectory()) {
          const r = await execCmd('rm', ['-rf', p], 30000);
          if (r.code !== 0) throw new Error(r.stderr);
        } else unlinkSync(p);
      }
      deleted.push(p);
    } catch (e) { failed.push(p); errors.push(`${p}: ${e.message}`); }
  }
  sendJSON(res, 200, { deleted, failed, total: deleted.length, failures: failed.length, errors, success: true });
}

// ── Duplicate file scanning ──
const dupJobs = new Map();
mkdirSync(DUP_STATE_DIR, { recursive: true });

// POST /api/dup/scan
async function handleDupScan(req, res) {
  const data = await parseBody(req);
  const scanType = data.type || 'files';
  const scanPath = (data.path || '').trim();
  if (!['music', 'files'].includes(scanType)) {
    sendJSON(res, 400, { error: '无效的扫描类型', success: false });
    return;
  }
  if (!scanPath || !existsSync(scanPath)) {
    sendJSON(res, 400, { error: scanPath ? `目录不存在: ${scanPath}` : '无效的扫描路径', success: false });
    return;
  }
  const jobId = `dup_${randomUUID().slice(0, 8)}`;
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);

  // Write initial state
  const initialState = {
    id: jobId, scanType, rootPath: scanPath,
    status: 'counting',
    progress: { total: 0, processed: 0, currentFile: '' },
    files: [], duplicates: [], stats: { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 },
    error: null, startTime: Date.now(), _aborted: false, _paused: false, _prev_status: 'counting',
  };
  writeFileSync(stateFile, JSON.stringify(initialState));
  dupJobs.set(jobId, { stateFile, scanType, scanPath });

  // Launch scan in background via dup_scan.js
  if (existsSync(DUP_SCAN_SCRIPT)) {
    const proc = spawn(process.execPath, [DUP_SCAN_SCRIPT, scanType, scanPath, jobId, DUP_STATE_DIR], {
      stdio: 'ignore', detached: true,
    });
    proc.unref();
  } else {
    // Fallback: run scan inline (separate Promise to not block)
    runDupScanInline(jobId, scanType, scanPath, stateFile).catch(() => {});
  }

  sendJSON(res, 200, { jobId, status: 'started', success: true });
}

// Inline scan fallback (used when dup_scan.js doesn't exist)
async function runDupScanInline(jobId, scanType, scanPath, stateFile) {
  const extensions = scanType === 'music' ? MUSIC_EXTS : null;
  const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  const update = () => writeFileSync(stateFile, JSON.stringify(state));

  try {
    // Phase 1: count
    state.status = 'counting';
    const allFiles = [];
    for await (const fp of walkDir(scanPath, extensions)) {
      if (state._aborted) { state.status = 'aborted'; update(); return; }
      allFiles.push(fp);
      state.progress.total = allFiles.length;
      if (allFiles.length % 50 === 0) update();
    }
    if (!allFiles.length) { state.status = 'complete'; update(); return; }

    // Phase 2: hash (sequential if no dup_scan.js)
    state.status = 'hashing';
    state.progress.total = allFiles.length;
    update();
    const fileHashes = [];
    for (let i = 0; i < allFiles.length; i++) {
      if (state._aborted) { state.status = 'aborted'; update(); return; }
      state.progress.processed = i + 1;
      state.progress.currentFile = allFiles[i];
      try {
        const fh = await hashFile(allFiles[i]);
        if (fh) fileHashes.push(fh);
      } catch {}
      if ((i + 1) % 20 === 0) update();
    }

    // Group
    const groups = new Map();
    for (const f of fileHashes) {
      if (!groups.has(f.hash)) groups.set(f.hash, []);
      groups.get(f.hash).push(f);
    }
    const duplicates = [];
    let dupFiles = 0, wastedBytes = 0;
    for (const [hash, files] of groups) {
      if (files.length >= 2) {
        files.sort((a, b) => a.path.localeCompare(b.path));
        const wasted = files.slice(1).reduce((s, f) => s + f.size, 0);
        duplicates.push({ hash, count: files.length, files, wasted });
        dupFiles += files.length;
        wastedBytes += wasted;
      }
    }
    duplicates.sort((a, b) => b.wasted - a.wasted);
    state.status = 'complete';
    state.files = fileHashes;
    state.duplicates = duplicates;
    state.stats = { totalFiles: fileHashes.length, duplicateGroups: duplicates.length, duplicateFiles: dupFiles, wastedBytes };
    update();
  } catch (e) { state.status = 'error'; state.error = e.message; update(); }
}

async function* walkDir(dirPath, extensions) {
  let entries;
  try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = join(dirPath, e.name);
    if (e.isDirectory()) yield* walkDir(fp, extensions);
    else if (e.isFile() && (!extensions || extensions.has(extname(e.name).toLowerCase()))) yield fp;
  }
}

async function hashFile(fp) {
  const hash = createHash('sha256');
  try {
    const stream = createReadStream(fp, { highWaterMark: 256 * 1024 });
    for await (const chunk of stream) hash.update(chunk);
    const digest = hash.digest('hex');
    const st = statSync(fp);
    let id3 = null;
    if (fp.toLowerCase().endsWith('.mp3')) id3 = readId3Tags(fp);
    return { path: fp, size: st.size, hash: digest, ext: extname(fp).toLowerCase(), id3 };
  } catch { return null; }
}

function readId3Tags(fp) {
  const tags = { title: '', artist: '', album: '' };
  try {
    const buf = Buffer.alloc(10240);
    const fd = createReadStream(fp, { start: 0, end: 10239 });
    let bytesRead = 0;
    fd.on('data', chunk => { chunk.copy(buf, bytesRead); bytesRead += chunk.length; });
    fd.on('end', () => {
      if (bytesRead >= 10 && buf.slice(0, 3).toString() === 'ID3') {
        const headerSize = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
        const end = Math.min(10 + headerSize, bytesRead);
        let pos = 10;
        while (pos + 10 <= end) {
          const fid = buf.slice(pos, pos + 4).toString();
          const fsize = buf.readUInt32BE(pos + 4);
          if (fid === '\x00\x00\x00\x00' || fsize === 0) break;
          if (['TIT2', 'TPE1', 'TALB'].includes(fid) && pos + 10 + fsize <= end) {
            const val = buf.slice(pos + 11, pos + 10 + fsize).toString('utf-8').replace(/\x00/g, '').trim();
            if (fid === 'TIT2') tags.title = val;
            else if (fid === 'TPE1') tags.artist = val;
            else if (fid === 'TALB') tags.album = val;
          }
          pos += 10 + fsize;
        }
      }
    });
  } catch {}
  return tags;
}

// GET /api/dup/status?jobId=xxx
function handleDupStatus(req, res) {
  // Parse query from the raw URL
  const rawUrl = typeof req.url === 'string' ? req.url : String(req.url);
  const qIndex = rawUrl.indexOf('?');
  const params = {};
  if (qIndex >= 0) {
    const qs = rawUrl.slice(qIndex + 1).split('&');
    for (const p of qs) {
      const [k, v] = p.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  const jobId = params.jobId || '';
  if (!jobId) { sendJSON(res, 400, { error: '缺少 jobId 参数', success: false }); return; }
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
  if (!existsSync(stateFile)) { sendJSON(res, 404, { error: '任务不存在', success: false }); return; }
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    const stats = raw.stats || {};
    const formatted = {
      id: raw.id, scanType: raw.scanType, status: raw.status, progress: raw.progress, rootPath: raw.rootPath,
      duplicates: (raw.duplicates || []).map(g => ({
        hash: g.hash, count: g.count, wasted: g.wasted, wastedHuman: formatBytes(g.wasted),
        files: g.files.map(f => ({ path: f.path, name: basename(f.path), size: f.size, sizeHuman: formatBytes(f.size), ext: f.ext, id3: f.id3 })),
      })),
      stats: { totalFiles: stats.totalFiles || 0, duplicateGroups: stats.duplicateGroups || 0, duplicateFiles: stats.duplicateFiles || 0, wastedBytes: stats.wastedBytes || 0, wastedHuman: formatBytes(stats.wastedBytes || 0) },
      error: raw.error, startTime: raw.startTime,
    };
    sendJSON(res, 200, formatted);
  } catch (e) { sendJSON(res, 500, { error: e.message, success: false }); }
}

// GET /api/jobs - list dup jobs
function handleDupJobs(req, res) {
  const list = [];
  try {
    const files = readdirSync(DUP_STATE_DIR).filter(f => f.startsWith('dup_') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(join(DUP_STATE_DIR, f), 'utf-8'));
        list.push({ id: raw.id, scanType: raw.scanType, status: raw.status, rootPath: raw.rootPath, progress: raw.progress, stats: raw.stats, startTime: raw.startTime });
      } catch {}
    }
  } catch {}
  sendJSON(res, 200, list);
}

// POST /api/dup/delete
async function handleDupDelete(req, res) {
  const data = await parseBody(req);
  const files = data.files || [];
  const mode = data.mode || 'trash';
  let deleted = 0;
  const failed = [];
  for (const fp of files) {
    try {
      if (mode === 'permanent') {
        if (existsSync(fp)) unlinkSync(fp);
      } else {
        const m = fp.match(/^\/(?:mnt\/)?(vol\d+)\/(.+)/);
        if (m) {
          const trashDir = `/${m[1]}/1000/.@#local/trash`;
          const dest = join(trashDir, m[2]);
          mkdirSync(dirname(dest), { recursive: true });
          let finalDest = dest;
          let counter = 1;
          while (existsSync(finalDest)) {
            const ext = extname(dest);
            finalDest = join(dirname(dest), `${basename(dest).slice(0, -ext.length)}_${counter}${ext}`);
            counter++;
          }
          try { renameSync(fp, finalDest); }
          catch (e) { if (e.code === 'EXDEV') { cpSync(fp, finalDest); unlinkSync(fp); } else throw e; }
        } else {
          if (existsSync(fp)) unlinkSync(fp);
        }
      }
      deleted++;
    } catch (e) { failed.push({ file: fp, reason: e.message }); }
  }
  sendJSON(res, 200, { deleted, failed, success: true });
}

// POST /api/dup/export
async function handleDupExport(req, res) {
  const data = await parseBody(req);
  const jobId = data.jobId;
  const filterHash = data.hash || '';
  const outDir = data.outputDir || join(DUP_STATE_DIR, 'exports');
  if (!jobId) { sendJSON(res, 400, { error: '缺少 jobId', success: false }); return; }
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
  if (!existsSync(stateFile)) { sendJSON(res, 404, { error: '任务不存在', success: false }); return; }
  const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
  const duplicates = raw.duplicates || [];
  mkdirSync(outDir, { recursive: true });
  let exported = 0;
  for (const g of duplicates) {
    if (filterHash && g.hash !== filterHash) continue;
    const hShort = (g.hash || 'unknown').slice(0, 8);
    const expPath = join(outDir, `dup_${hShort}`);
    mkdirSync(expPath, { recursive: true });
    const csvLines = ['路径,文件名,大小,扩展名,艺术家,标题,专辑'];
    for (const f of g.files) {
      const id3 = f.id3 || {};
      csvLines.push(`"${f.path}","${basename(f.path)}",${f.size},"${f.ext}","${(id3.artist||'').replace(/"/g,'""')}","${(id3.title||'').replace(/"/g,'""')}","${(id3.album||'').replace(/"/g,'""')}"`);
    }
    writeFileSync(join(expPath, 'report.csv'), '\uFEFF' + csvLines.join('\n'));
    const readme = [
      `# 重复文件报告 - ${hShort}`,
      `**哈希**: ${g.hash}`,
      `**文件数**: ${g.count}`,
      `**浪费空间**: ${formatBytes(g.wasted)}`,
      '',
      '## 文件列表',
      ...g.files.map((f, i) => {
        const id3 = f.id3 || {};
        const tags = id3.artist || id3.title ? ` [${id3.artist||''} - ${id3.title||''}]` : '';
        return `${i + 1}. ${f.path} (${formatBytes(f.size)})${tags}`;
      }),
    ].join('\n');
    writeFileSync(join(expPath, 'README.md'), readme);
    exported++;
  }
  sendJSON(res, 200, { exported, outputDir: outDir, success: true });
}

// POST /api/dup/stop
async function handleDupStop(req, res) {
  const data = await parseBody(req);
  const jobId = data.jobId;
  if (!jobId) { sendJSON(res, 400, { success: false }); return; }
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
  if (!existsSync(stateFile)) { sendJSON(res, 200, { success: false, stopped: false }); return; }
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    raw._aborted = true;
    writeFileSync(stateFile, JSON.stringify(raw));
    sendJSON(res, 200, { success: true, stopped: true });
  } catch { sendJSON(res, 200, { success: false, stopped: false }); }
}

// POST /api/dup/pause
async function handleDupPause(req, res) {
  const data = await parseBody(req);
  const jobId = data.jobId;
  if (!jobId) { sendJSON(res, 400, { success: false }); return; }
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
  if (!existsSync(stateFile)) { sendJSON(res, 200, { success: false, paused: false }); return; }
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    raw._paused = true;
    writeFileSync(stateFile, JSON.stringify(raw));
    sendJSON(res, 200, { success: true, paused: true });
  } catch { sendJSON(res, 200, { success: false, paused: false }); }
}

// POST /api/dup/resume
async function handleDupResume(req, res) {
  const data = await parseBody(req);
  const jobId = data.jobId;
  if (!jobId) { sendJSON(res, 400, { success: false }); return; }
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
  if (!existsSync(stateFile)) { sendJSON(res, 200, { success: false, resumed: false }); return; }
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    raw._paused = false;
    writeFileSync(stateFile, JSON.stringify(raw));
    sendJSON(res, 200, { success: true, resumed: true });
  } catch { sendJSON(res, 200, { success: false, resumed: false }); }
}

// ── HTTP Router ──
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cleanPath = url.pathname.replace(/^\/app\/fnclearup/, '') || '/';
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // API routes
    if (cleanPath.startsWith('/api/')) {
      const path = cleanPath;
      // GET
      if (method === 'GET' && path === '/api/version') { handleVersion(req, res); return; }
      if (method === 'GET' && path === '/api/ping') { handlePing(req, res); return; }
      if (method === 'GET' && path === '/api/mounts') { handleMounts(req, res); return; }
      if (method === 'GET' && path === '/api/vol02') { handleVol02(req, res); return; }
      if (method === 'GET' && path === '/api/volumes') { await handleVolumes(req, res); return; }
      if (method === 'GET' && path === '/api/networks') { await handleNetworks(req, res); return; }
      if (method === 'GET' && path === '/api/images') { await handleImages(req, res); return; }
      if (method === 'GET' && path === '/api/system') { await handleSystem(req, res); return; }
      if (method === 'GET' && path === '/api/temp/scan') { handleTempScan(req, res); return; }
      if (method === 'GET' && path === '/api/dup/status') { handleDupStatus(req, res); return; }
      if (method === 'GET' && path === '/api/jobs') { handleDupJobs(req, res); return; }
      // POST
      if (method === 'POST' && path === '/api/scan') { await handleScan(req, res); return; }
      if (method === 'POST' && path === '/api/delete') { await handleDelete(req, res); return; }
      if (method === 'POST' && path === '/api/volumes/delete') { await handleVolumesDelete(req, res); return; }
      if (method === 'POST' && path === '/api/networks/delete') { await handleNetworksDelete(req, res); return; }
      if (method === 'POST' && path === '/api/images/delete') { await handleImagesDelete(req, res); return; }
      if (method === 'POST' && path === '/api/temp/delete') { await handleTempDelete(req, res); return; }
      if (method === 'POST' && path === '/api/dup/scan') { await handleDupScan(req, res); return; }
      if (method === 'POST' && path === '/api/dup/delete') { await handleDupDelete(req, res); return; }
      if (method === 'POST' && path === '/api/dup/export') { await handleDupExport(req, res); return; }
      if (method === 'POST' && path === '/api/dup/stop') { await handleDupStop(req, res); return; }
      if (method === 'POST' && path === '/api/dup/pause') { await handleDupPause(req, res); return; }
      if (method === 'POST' && path === '/api/dup/resume') { await handleDupResume(req, res); return; }
      sendJSON(res, 404, { error: 'API endpoint not found' });
      return;
    }

    // Static file serving (aligned with fnm3u8dl pattern)
    const staticDir = UI_DIR;
    let filePath;
    if (cleanPath === '' || cleanPath === '/') {
      filePath = 'index.html';
    } else {
      filePath = cleanPath.replace(/^\//, '');
    }
    // Remove query string
    filePath = filePath.split('?')[0];
    // Security: prevent directory traversal
    if (filePath.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
    const requestedPath = join(staticDir, filePath);
    if (existsSync(requestedPath) && statSync(requestedPath).isFile()) {
      const ext = extname(requestedPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(readFileSync(requestedPath));
      return;
    }
    // SPA fallback to index.html
    const indexPath = join(staticDir, 'index.html');
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(indexPath));
      return;
    }
    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

// ── HTTP server (direct access) ──
const httpServer = createServer(handle);
let httpPort = PORT;
httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.warn(`[http] port ${httpPort} in use, trying ${httpPort + 1}...`);
    httpPort++;
    httpServer.listen(httpPort, '0.0.0.0');
  } else {
    console.error('[FATAL] HTTP server error:', e.message);
  }
});
httpServer.listen(httpPort, '0.0.0.0', () => {
  console.log(`fnclearup HTTP listening on ${httpPort}`);
});

// ── UNIX socket server (fnOS gateway proxy) ──
try {
  if (existsSync(SOCK_PATH)) {
    try { unlinkSync(SOCK_PATH); console.log('[sock] removed stale socket'); }
    catch(e) { console.warn('[sock] could not remove stale socket:', e.message); }
  }
} catch(e) {}

const sockServer = createServer(handle);
sockServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.warn('[sock] address in use, cleaning up and retrying...');
    try { unlinkSync(SOCK_PATH); } catch(e) {}
    sockServer.listen(SOCK_PATH);
  } else {
    console.error('[FATAL] UNIX socket server error:', e.message);
  }
});
sockServer.listen(SOCK_PATH, () => console.log(`fnclearup UNIX socket listening on ${SOCK_PATH}`));

// Graceful shutdown
function shutdown() {
  try { httpServer.close(); } catch(e) {}
  try { sockServer.close(); } catch(e) {}
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
