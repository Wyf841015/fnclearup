// ── Scheduled Cleanup Module ──
// Reliable periodic cleanup scheduler with disk-persisted config and detailed reports.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import http from 'node:http';
import { sendJSON } from '../lib/util.js';

// ── Default config ──
const DEFAULT_CONFIG = {
  enabled: false,
  hour: 3,
  minute: 0,
  intervalHours: 24,
  cleanupTypes: {
    app: { enabled: false, cleanOrphans: true, scanPath: '/vol1,/vol2,/vol3' },
    disk: { enabled: false, cleanResiduals: true },
    docker: { enabled: false, images: true, volumes: true, networks: true },
    temp: { enabled: false, olderThanHours: 24 },
    trash: { enabled: false, olderThanDays: 30 },
  },
  lastRun: null,
  nextRun: null,
  runCount: 0,
};

let configPath = null;
let reportsDir = null;
let config = { ...DEFAULT_CONFIG };
let timerHandle = null;
let isRunning = false;
let httpPort = 47938;

// ── Init ──
export function initSchedule(dataDir, port) {
  httpPort = port || 47938;
  configPath = join(dataDir, 'schedule.json');
  reportsDir = join(dataDir, 'schedule_reports');
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
  } catch (e) {
    console.warn('[schedule] failed to create data/reports dir:', e.message);
  }

  if (existsSync(configPath)) {
    try {
      const saved = JSON.parse(readFileSync(configPath, 'utf8'));
      if (saved.cleanupTypes) {
        for (const [k, v] of Object.entries(saved.cleanupTypes)) {
          if (typeof v === 'boolean') {
            saved.cleanupTypes[k] = { ...DEFAULT_CONFIG.cleanupTypes[k], enabled: v };
          }
        }
      }
      config = { ...DEFAULT_CONFIG, ...saved };
    } catch (e) {
      console.warn('[schedule] failed to load config, using defaults');
      config = { ...DEFAULT_CONFIG };
    }
  }
  saveConfig();

  if (config.enabled) scheduleNext();
  console.log(`[schedule] initialized, enabled=${config.enabled}, next=${config.nextRun || 'none'}`);
}

function saveConfig() {
  if (!configPath) return;
  try {
    const tmp = configPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, configPath);
  } catch (e) { console.error('[schedule] save error:', e.message); }
}

function calcNextRun() {
  const now = Date.now();
  const { hour, minute, intervalHours } = config;
  if (intervalHours >= 24) {
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  } else {
    return new Date(now + intervalHours * 3600000).toISOString();
  }
}

function scheduleNext() {
  if (timerHandle) clearTimeout(timerHandle);
  config.nextRun = calcNextRun();
  saveConfig();
  const delay = Math.max(1000, new Date(config.nextRun).getTime() - Date.now());
  timerHandle = setTimeout(executeCleanup, delay);
  console.log(`[schedule] next run at ${new Date(config.nextRun).toLocaleString()} (in ${Math.round(delay/60000)}min)`);
}

// ── Call local API via HTTP ──
function callLocalAPI(method, path, body) {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: '127.0.0.1', port: httpPort,
      path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('API timeout')); });
    if (b) req.write(b);
    req.end();
  });
}

// ── Execute cleanup ──
async function executeCleanup() {
  if (isRunning) { console.log('[schedule] previous cleanup still running, skipping'); scheduleNext(); return; }
  isRunning = true;
  try {
  const startedAt = new Date().toISOString();
  const report = { startedAt, types: {}, errors: [], deleted: [], totalBytes: 0 };

  console.log(`[schedule] cleanup started at ${startedAt}`);
  const { cleanupTypes } = config;

  // ── App cleanup ──
  const appCfg = cleanupTypes.app || {};
  if (appCfg.enabled) {
    try {
      const scanRes = await callLocalAPI('POST', '/api/scan', {});
      const data = scanRes.data || {};
      let orphanPaths = [];
      const orphans = data.orphan;
      if (Array.isArray(orphans)) {
        orphanPaths = orphans.map(o => o.path).filter(Boolean);
      } else if (orphans && typeof orphans === 'object') {
        for (const paths of Object.values(orphans)) {
          if (Array.isArray(paths)) orphanPaths.push(...paths);
        }
      }
      if (orphanPaths.length > 0 && appCfg.cleanOrphans) {
        const delRes = await callLocalAPI('POST', '/api/delete', { paths: orphanPaths });
        const deleted = delRes.data?.total || 0;
        report.deleted.push({ type: 'app', paths: orphanPaths.length, deleted, files: [...orphanPaths], detail: `${deleted}/${orphanPaths.length} 应用残留已清理` });
        report.types.app = { status: 'done', found: orphanPaths.length, deleted };
      } else {
        report.types.app = { status: 'done', found: orphanPaths.length, deleted: 0, note: '未发现残余或未启用清理' };
      }
    } catch (e) { report.errors.push({ type: 'app', error: e.message }); report.types.app = { status: 'error', error: e.message }; }
  }

  // ── Disk cleanup ──
  const diskCfg = cleanupTypes.disk || {};
  if (diskCfg.enabled) {
    try {
      const scanRes = await callLocalAPI('GET', '/api/vol02');
      const volDirs = scanRes.data?.vol02_dirs || [];
      if (scanRes.data?.success && volDirs.length > 0) {
        report.types.disk = { status: 'done', found: volDirs.length };
        if (diskCfg.cleanResiduals) {
          report.types.disk.note = `${volDirs.length} 个挂载残余待手动确认`;
        }
      } else {
        report.types.disk = { status: 'done', found: 0 };
      }
    } catch (e) { report.errors.push({ type: 'disk', error: e.message }); }
  }

  // ── Docker cleanup ──
  const dockerCfg = cleanupTypes.docker || {};
  if (dockerCfg.enabled) {
    const dockerResults = {};
    try {
      if (dockerCfg.images) {
        const imgRes = await callLocalAPI('GET', '/api/images');
        const unused = imgRes.data?.images?.unused || [];
        if (unused.length > 0) {
          const ids = unused.map(i => i.id);
          const delRes = await callLocalAPI('POST', '/api/images/delete', { images: ids });
          const deleted = delRes.data?.total || 0;
          report.deleted.push({ type: 'docker-images', count: deleted, detail: `${deleted} 个未使用镜像` });
          dockerResults.images = { found: unused.length, deleted };
        } else {
          dockerResults.images = { found: 0, deleted: 0 };
        }
      }
      if (dockerCfg.volumes) {
        const volRes = await callLocalAPI('GET', '/api/volumes');
        const orphans = volRes.data?.volumes?.orphan || [];
        if (orphans.length > 0) {
          const names = orphans.map(v => v.name);
          const delRes = await callLocalAPI('POST', '/api/volumes/delete', { volumes: names });
          const deleted = delRes.data?.deleted || 0;
          report.deleted.push({ type: 'docker-volumes', count: deleted, detail: `${deleted} 个孤立卷` });
          dockerResults.volumes = { found: orphans.length, deleted };
        } else {
          dockerResults.volumes = { found: 0, deleted: 0 };
        }
      }
      if (dockerCfg.networks) {
        const netRes = await callLocalAPI('GET', '/api/networks');
        const unused = netRes.data?.networks?.unused || [];
        if (unused.length > 0) {
          const ids = unused.map(n => n.id);
          const delRes = await callLocalAPI('POST', '/api/networks/delete', { networks: ids });
          const deleted = delRes.data?.deleted || 0;
          report.deleted.push({ type: 'docker-networks', count: deleted, detail: `${deleted} 个未使用网络` });
          dockerResults.networks = { found: unused.length, deleted };
        } else {
          dockerResults.networks = { found: 0, deleted: 0 };
        }
      }
      report.types.docker = { status: 'done', ...dockerResults };
    } catch (e) { report.errors.push({ type: 'docker', error: e.message }); }
  }

  // ── Temp cleanup ──
  const tempCfg = cleanupTypes.temp || {};
  if (tempCfg.enabled) {
    try {
      const scanRes = await callLocalAPI('GET', '/api/temp/scan');
      const files = scanRes.data?.files || [];
      const olderThan = tempCfg.olderThanHours || 24;
      const expired = files.filter(f => f.age_hours >= olderThan);
      if (expired.length > 0) {
        const paths = expired.map(f => f.path);
        const totalSize = expired.reduce((s, f) => s + (f.size || 0), 0);
        const delRes = await callLocalAPI('POST', '/api/temp/delete', { paths });
        const deleted = delRes.data?.total || 0;
        report.deleted.push({ type: 'temp', count: deleted, bytes: totalSize, files: [...paths], detail: `${deleted} 个过期临时文件 (${formatBytes(totalSize)})` });
        report.totalBytes += totalSize;
        report.types.temp = { status: 'done', found: expired.length, deleted, bytes: totalSize };
      } else {
        report.types.temp = { status: 'done', found: 0, note: '无过期临时文件' };
      }
    } catch (e) { report.errors.push({ type: 'temp', error: e.message }); }
  }

  // ── Trash cleanup ──
  const trashCfg = cleanupTypes.trash || {};
  if (trashCfg.enabled) {
    try {
      const scanRes = await callLocalAPI('GET', '/api/trash/scan');
      const data = scanRes.data || {};
      const olderThanDays = trashCfg.olderThanDays || 30;
      const totals = data.totals || {};
      const totalItems = (totals.files || 0) + (totals.dirs || 0);
      const totalSize = totals.size || 0;
      if (totalItems > 0) {
        const cleanRes = await callLocalAPI('POST', '/api/trash/clean', { ageDays: olderThanDays, withManifest: true });
        const deletedArr = cleanRes.data?.deleted || [];
        const cleaned = deletedArr.length;
        const trashFiles = deletedArr.map(d => d.path);
        report.deleted.push({ type: 'trash', count: cleaned, bytes: totalSize, files: trashFiles, detail: `${cleaned} 个回收站文件 (${olderThanDays}天+, ${formatBytes(totalSize)})` });
        report.totalBytes += totalSize;
        report.types.trash = { status: 'done', found: totalItems, cleaned, days: olderThanDays };
      } else {
        report.types.trash = { status: 'done', found: 0 };
      }
    } catch (e) { report.errors.push({ type: 'trash', error: e.message }); }
  }

  // ── Finalize report ──
  const completedAt = new Date().toISOString();
  report.completedAt = completedAt;
  report.duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();

  config.lastRun = completedAt;
  config.runCount = (config.runCount || 0) + 1;
  saveConfig();

  isRunning = false;
  console.log(`[schedule] cleanup completed in ${report.duration}ms, deleted ${report.deleted.length} items, errors: ${report.errors.length}`);

  // Save detailed report file
  saveDetailedReport(report);
  // Log to history
  logRunHistory(report);
  // Schedule next run
  scheduleNext();
  } finally { isRunning = false; }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

// ── Save detailed report to file ──
function saveDetailedReport(report) {
  if (!reportsDir) return;
  const timestamp = new Date(report.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportFile = join(reportsDir, `cleanup_${timestamp}.json`);
  try {
    const tmp = reportFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, reportFile);
    console.log(`[schedule] report saved: ${reportFile}`);
  } catch (e) {
    console.error('[schedule] failed to save report:', e.message);
  }
}

function logRunHistory(report) {
  if (!configPath) return;
  const historyPath = join(dirname(configPath), 'schedule_history.json');
  let history = [];
  try {
    if (existsSync(historyPath)) history = JSON.parse(readFileSync(historyPath, 'utf8'));
  } catch {}
  // Lightweight summary for history
  const summary = {
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    duration: report.duration,
    types: Object.fromEntries(
      Object.entries(report.types).map(([k, v]) => [k, typeof v === 'object' ? v.status || 'done' : v])
    ),
    deleted: report.deleted.map(d => ({ type: d.type, count: d.count || d.deleted || d.paths || 0, detail: d.detail, files: d.files || [] })),
    errors: report.errors,
    totalBytes: report.totalBytes,
    reportFile: `cleanup_${new Date(report.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 16)}.json`,
  };
  history.push(summary);
  if (history.length > 100) history = history.slice(-100);
  try { const tmp = historyPath + '.tmp'; writeFileSync(tmp, JSON.stringify(history, null, 2)); renameSync(tmp, historyPath); } catch (e) { console.error('[schedule] history write error:', e.message); }
}

// ── API: GET/POST /api/schedule ──
export async function handleSchedule(req, res) {
  if (req.method === 'GET') {
    sendJSON(res, 200, {
      success: true,
      enabled: config.enabled,
      hour: config.hour,
      minute: config.minute,
      intervalHours: config.intervalHours,
      cleanupTypes: config.cleanupTypes,
      lastRun: config.lastRun,
      nextRun: config.nextRun,
      runCount: config.runCount,
    });
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    try {
      for await (const chunk of req) body += chunk.toString();
      const data = JSON.parse(body);
      if (typeof data.enabled === 'boolean') config.enabled = data.enabled;
      if (typeof data.hour === 'number' && data.hour >= 0 && data.hour <= 23) config.hour = data.hour;
      if (typeof data.minute === 'number' && data.minute >= 0 && data.minute <= 59) config.minute = data.minute;
      if (typeof data.intervalHours === 'number' && data.intervalHours >= 1) config.intervalHours = data.intervalHours;
      if (data.cleanupTypes && typeof data.cleanupTypes === 'object') {
        for (const [k, v] of Object.entries(data.cleanupTypes)) {
          if (!(k in config.cleanupTypes)) continue;
          if (typeof v === 'object' && v !== null) {
            config.cleanupTypes[k] = { ...DEFAULT_CONFIG.cleanupTypes[k], ...v };
          } else if (typeof v === 'boolean') {
            config.cleanupTypes[k] = { ...DEFAULT_CONFIG.cleanupTypes[k], enabled: v };
          }
        }
      }
      saveConfig();
      if (timerHandle) clearTimeout(timerHandle);
      if (config.enabled) { scheduleNext(); }
      else { config.nextRun = null; saveConfig(); timerHandle = null; console.log('[schedule] disabled'); }
      sendJSON(res, 200, { success: true, nextRun: config.nextRun, enabled: config.enabled });
    } catch (e) { sendJSON(res, 400, { error: '无效的请求数据: ' + e.message }); }
    return;
  }
  sendJSON(res, 405, { error: 'Method not allowed' });
}

// ── Manual trigger ──
export async function handleScheduleTrigger(req, res) {
  if (req.method !== 'POST') { sendJSON(res, 405, { error: 'Method not allowed' }); return; }
  executeCleanup().catch(e => console.error('[schedule] trigger error:', e));
  sendJSON(res, 200, { success: true, message: '定时清理已触发，在后台执行' });
}

// ── History + Reports ──
export async function handleScheduleHistory(req, res) {
  const historyPath = configPath ? join(dirname(configPath), 'schedule_history.json') : null;
  if (!historyPath || !existsSync(historyPath)) {
    sendJSON(res, 200, { success: true, history: [], reports: [] });
    return;
  }
  try {
    const history = JSON.parse(readFileSync(historyPath, 'utf8'));
    // List available report files
    let reportFiles = [];
    if (reportsDir && existsSync(reportsDir)) {
      const fs = await import('node:fs');
      reportFiles = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 50);
    }
    sendJSON(res, 200, { success: true, history: history.slice(-20).reverse(), reports: reportFiles });
  } catch {
    sendJSON(res, 200, { success: true, history: [], reports: [] });
  }
}

// ── Read a specific report ──
export async function handleScheduleReport(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const name = url.searchParams.get('name');
  if (!name || name.includes('..') || !name.endsWith('.json')) {
    sendJSON(res, 400, { error: '无效的报告名称' });
    return;
  }
  const reportFile = join(reportsDir, name);
  if (!reportFile.startsWith(reportsDir) || !existsSync(reportFile)) {
    sendJSON(res, 404, { error: '报告不存在' });
    return;
  }
  try {
    const content = JSON.parse(readFileSync(reportFile, 'utf8'));
    sendJSON(res, 200, { success: true, report: content });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}