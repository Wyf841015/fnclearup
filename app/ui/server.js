import { existsSync, statSync, readdirSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, rmSync, renameSync, cpSync, lstatSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { MIME, VERSION } from './lib/config.js';
import { sendJSON, parseBody, isSafePath, CORS_ORIGINS } from './lib/util.js';
import { handleScan, handleDelete } from './api/app.js';
import { handleMounts, handleVol02 } from './api/disk.js';
import { handleVolumes, handleVolumesDelete, handleNetworks, handleNetworksDelete, handleImages, handleImagesDelete, handleSystem } from './api/docker.js';
import { handleTempScan, handleTempDelete } from './api/temp.js';
import { handleDupScan, handleDupStatus, handleDupJobs, handleDupDelete, handleDupExport, handleDupStop, handleDupPause, handleDupResume, dupJobs, setDupPaths } from './api/dup.js';
import { handleEmptyDirScan, handleEmptyDirStop, handleEmptyDirDelete, handleEmptyDirStatus, emptyDirJobs, setEmptyDirPaths } from './api/empty_dir.js';
import { handleSysCleanScan, handleSysCleanClean, handleSysCleanListManifests, handleSysCleanGetManifest } from './api/sysclean.js';
import { scanTrash, browseTrash, cleanTrash, isTrashPath } from './api/trash.js';
import { initSchedule, handleSchedule, handleScheduleTrigger, handleScheduleHistory, handleScheduleReport } from './api/schedule.js';
import { handleBigFilesScan, handleBigFilesStop } from './api/bigfiles.js';
import { handleDockerStopped, handleDockerStoppedRemove, handleDockerBuildCache, handleDockerBuildCachePrune } from './api/docker_cleanup.js';

// ── Paths ──
const UI_DIR = dirname(fileURLToPath(import.meta.url));
const TARGET_DIR = dirname(UI_DIR);
const PKGVAR = process.env.TRM_PKGVAR || null;
const DATA_DIR = PKGVAR ? join(PKGVAR, 'data') : join(TARGET_DIR, 'data');
const PORT = parseInt(process.env.PORT || '47938', 10);
const SOCK_PATH = join(TARGET_DIR, 'fnclearup.sock');
const DUP_STATE_DIR = join(DATA_DIR, 'dup');
const DUP_SCAN_SCRIPT = join(TARGET_DIR, 'dup_scan.js');

// Init dup state
setDupPaths(DUP_STATE_DIR, DUP_SCAN_SCRIPT);

const EMPTY_STATE_DIR = join(DATA_DIR, 'empty_dir');
const EMPTY_SCAN_SCRIPT = join(TARGET_DIR, 'empty_dir_scan.js');
setEmptyDirPaths(EMPTY_STATE_DIR, EMPTY_SCAN_SCRIPT);

// GET /api/browse?path=/vol2
function handleBrowse(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const dirPath = url.searchParams.get('path') || '/';
  if (dirPath === '/') {
    // Show only safe volumes at root instead of exposing system directories
    const entries = VOL_GLOBS.filter(v => existsSync(v)).map(v => {
      const st = statSync(v);
      return { name: v.slice(1), path: v, type: 'dir', size: st.size, mtime: st.mtimeMs };
    });
    sendJSON(res, 200, { success: true, path: '/', entries, parent: null });
    return;
  }
  if (!isSafePath(dirPath)) {
    sendJSON(res, 403, { error: '路径越界：仅允许 /vol* 下的目录' });
    return;
  }
  try {
    const st = statSync(dirPath);
    if (!st.isDirectory()) { sendJSON(res, 400, { error: '不是目录' }); return; }
    const entries = readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.name !== '.' && e.name !== '..' && e.name !== '.@#local' && !e.name.startsWith('@app'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => ({ name: e.name, isDirectory: e.isDirectory(), path: join(dirPath, e.name) }));
    const parent = dirPath === '/' ? null : join(dirPath, '..');
    sendJSON(res, 200, { path: dirPath, parent, entries, success: true });
  } catch (e) { sendJSON(res, 500, { error: e.message }); }
}

// ── HTTP Router ──
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cleanPath = url.pathname.replace(/^\/app\/fnclearup/, '') || '/';
  const method = req.method;

  // CORS (re-import constants from lib/util.js for handle())
  const corsHeaders = {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGINS === '*' ? '*' :
      ((req.headers.origin && CORS_ORIGINS.includes(req.headers.origin)) ? req.headers.origin : (CORS_ORIGINS[0] || '*')),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  };
  for (const k of Object.keys(corsHeaders)) res.setHeader(k, corsHeaders[k]);
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // API routes
    if (cleanPath.startsWith('/api/')) {
      const path = cleanPath;
      // GET
      if (method === 'GET' && path === '/api/version') { sendJSON(res, 200, { version: VERSION, success: true }); return; }
      if (method === 'GET' && path === '/api/ping') { sendJSON(res, 200, { ok: true, method: req.method, uri: req.url }); return; }
      if (method === 'GET' && path === '/api/mounts') { handleMounts(req, res); return; }
      if (method === 'GET' && path === '/api/vol02') { handleVol02(req, res); return; }
      if (method === 'GET' && path === '/api/volumes') { await handleVolumes(req, res); return; }
      if (method === 'GET' && path === '/api/networks') { await handleNetworks(req, res); return; }
      if (method === 'GET' && path === '/api/images') { await handleImages(req, res); return; }
      if (method === 'GET' && path === '/api/system') { await handleSystem(req, res); return; }
      if (method === 'GET' && path === '/api/temp/scan') { handleTempScan(req, res); return; }
      if (method === 'GET' && path === '/api/dup/status') { handleDupStatus(req, res); return; }
      if (method === 'GET' && path === '/api/jobs') { handleDupJobs(req, res); return; }
      if (method === 'GET' && path === '/api/browse') { handleBrowse(req, res); return; }
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
      if (method === 'POST' && path === '/api/empty_dir/scan') { await handleEmptyDirScan(req, res); return; }
      if (method === 'POST' && path === '/api/empty_dir/stop') { await handleEmptyDirStop(req, res); return; }
      if (method === 'POST' && path === '/api/empty_dir/delete') { await handleEmptyDirDelete(req, res); return; }
      if (method === 'GET' && path === '/api/empty_dir/status') { handleEmptyDirStatus(req, res); return; }
      if (method === 'GET' && path === '/api/empty_dir/jobs') {
        const list = [...emptyDirJobs].map(([id, j]) => ({ id, scanPath: j.scanPath, status: 'running' }));
        sendJSON(res, 200, list); return;
      }
      if (method === 'GET' && path === '/api/sysclean/scan') { handleSysCleanScan(req, res); return; }
      if (method === 'POST' && path === '/api/sysclean/clean') { await handleSysCleanClean(req, res); return; }
      if (method === 'GET' && path === '/api/sysclean/manifests') { handleSysCleanListManifests(req, res); return; }
      if (method === 'GET' && path === '/api/sysclean/manifest') { await handleSysCleanGetManifest(req, res); return; }
      if (method === 'GET' && path === '/api/trash/scan') { handleTrashScan(req, res); return; }
      if (method === 'GET' && path === '/api/trash/browse') { handleTrashBrowse(req, res); return; }
      if (method === 'POST' && path === '/api/trash/clean') { await handleTrashClean(req, res); return; }
      // Schedule
      if (path === '/api/schedule') { await handleSchedule(req, res); return; }
      if (method === 'POST' && path === '/api/schedule/trigger') { await handleScheduleTrigger(req, res); return; }
      if (method === 'GET' && path === '/api/schedule/history') { await handleScheduleHistory(req, res); return; }
      if (method === 'GET' && path === '/api/schedule/report') { await handleScheduleReport(req, res); return; }
      // Big files
      if (method === 'GET' && path === '/api/bigfiles/scan') { await handleBigFilesScan(req, res); return; }
      if (method === 'POST' && path === '/api/bigfiles/stop') { handleBigFilesStop(req, res); return; }
      // Docker cleanup (stopped containers + build cache)
      if (method === 'GET' && path === '/api/docker/stopped') { await handleDockerStopped(req, res); return; }
      if (method === 'POST' && path === '/api/docker/stopped/remove') { await handleDockerStoppedRemove(req, res); return; }
      if (method === 'GET' && path === '/api/docker/build_cache') { await handleDockerBuildCache(req, res); return; }
      if (method === 'POST' && path === '/api/docker/build_cache/prune') { await handleDockerBuildCachePrune(req, res); return; }
      sendJSON(res, 404, { error: 'API endpoint not found' });
      return;
    }

    // Static file serving
    let filePath;
    if (cleanPath === '' || cleanPath === '/') {
      filePath = 'index.html';
    } else {
      filePath = cleanPath.replace(/^\//, '');
    }
    filePath = filePath.split('?')[0];
    if (filePath.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
    const requestedPath = join(UI_DIR, filePath);

    // Try exact file match first
    if (existsSync(requestedPath) && statSync(requestedPath).isFile()) {
      const ext = extname(requestedPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(readFileSync(requestedPath));
      return;
    }
    // SPA fallback
    const indexPath = join(UI_DIR, 'index.html');
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

// ── HTTP Server ──
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
httpServer.listen(httpPort, '127.0.0.1', () => {
  console.log(`fnclearup HTTP listening on ${httpPort}`);
  console.log(`BUILD: ${VERSION} (${new Date().toISOString()})`);
  // Init schedule after server is ready
  initSchedule(DATA_DIR, httpPort);
});

// ── UNIX socket server ──
try {
  if (existsSync(SOCK_PATH)) {
    try { unlinkSync(SOCK_PATH); console.log('[sock] removed stale socket'); }
    catch(e) { console.warn('[sock] could not remove stale socket:', e.message); }
  }
} catch(e) {}

const sockServer = createServer(handle);
sockServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.warn('[sock] address in use, cleaning up...');
    try { unlinkSync(SOCK_PATH); } catch(e) {}
    sockServer.listen(SOCK_PATH);
  } else {
    console.error('[FATAL] UNIX socket server error:', e.message);
  }
});
sockServer.listen(SOCK_PATH, () => console.log(`fnclearup UNIX socket listening on ${SOCK_PATH}`));

// ── Trash handlers ──
function handleTrashScan(req, res) {
  try {
    const data = scanTrash();
    sendJSON(res, 200, { ok: true, ...data });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || String(err) });
  }
}

function handleTrashBrowse(req, res) {
  const u = new URL(req.url, 'http://x');
  const dir = u.searchParams.get('path') || '';
  if (typeof dir !== 'string') {
    sendJSON(res, 400, { error: 'path must be a string' });
    return;
  }
  try {
    const tree = browseTrash(dir);
    if (tree && tree.error) {
      sendJSON(res, 400, tree);
      return;
    }
    sendJSON(res, 200, { ok: true, tree });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || String(err) });
  }
}

async function handleTrashClean(req, res) {
  let body = {};
  try { body = await parseBody(req); } catch {}
  const ageDays = Number(body.ageDays);
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    sendJSON(res, 400, { error: 'ageDays must be a non-negative number (0 = clean all)' });
    return;
  }
  const withManifest = body.manifest !== false;
  try {
    const result = cleanTrash(ageDays, withManifest);
    sendJSON(res, 200, { ok: true, ...result });
  } catch (err) {
    sendJSON(res, 500, { error: err.message || String(err) });
  }
}

// ── Shutdown ──
function shutdown() {
  for (const [jobId, job] of dupJobs) {
    if (job.proc) { try { job.proc.kill(); } catch(e) {} }
    try {
      const raw = JSON.parse(readFileSync(job.stateFile, 'utf-8'));
      raw._aborted = true; raw.status = 'aborted';
      const tmpS = job.stateFile + '.tmp';
      writeFileSync(tmpS, JSON.stringify(raw));
      renameSync(tmpS, job.stateFile);
    } catch(e) {}
  }
  try { httpServer.close(); } catch(e) {}
  try { sockServer.close(); } catch(e) {}
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
