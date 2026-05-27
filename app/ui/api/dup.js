import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync, mkdirSync, renameSync, cpSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, extname, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { sendJSON, execCmd, parseBody, formatBytes } from '../lib/util.js';
import { MUSIC_EXTS } from '../lib/config.js';
import { getHashPool } from '../../dup_hash_pool.js';

export const dupJobs = new Map();
let DUP_STATE_DIR = '';
let DUP_SCAN_SCRIPT = '';

export function setDupPaths(stateDir, scanScript) {
  DUP_STATE_DIR = stateDir;
  DUP_SCAN_SCRIPT = scanScript;
  mkdirSync(stateDir, { recursive: true });
}

// POST /api/dup/scan
export async function handleDupScan(req, res) {
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

  const initialState = {
    id: jobId, scanType, rootPath: scanPath,
    status: 'counting',
    progress: { total: 0, processed: 0, currentFile: '' },
    files: [], duplicates: [], stats: { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 },
    error: null, startTime: Date.now(), _aborted: false, _paused: false, _prev_status: 'counting',
  };
  writeFileSync(stateFile, JSON.stringify(initialState));

  if (existsSync(DUP_SCAN_SCRIPT)) {
    const proc = spawn(process.execPath, [DUP_SCAN_SCRIPT, scanType, scanPath, jobId, DUP_STATE_DIR], {
      stdio: 'ignore', detached: false,
    });
    proc.on('exit', () => { dupJobs.delete(jobId); });
    dupJobs.set(jobId, { stateFile, scanType, scanPath, proc });
  } else {
    runDupScanInline(jobId, scanType, scanPath, stateFile).catch(() => {});
  }

  sendJSON(res, 200, { jobId, status: 'started', success: true });
}

async function runDupScanInline(jobId, scanType, scanPath, stateFile) {
  const extensions = scanType === 'music' ? MUSIC_EXTS : null;
  const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  const update = () => writeFileSync(stateFile, JSON.stringify(state));
  try {
    state.status = 'counting';
    const allFiles = [];         // {path, size}[]
    for await (const fp of walkDir(scanPath, extensions)) {
      if (state._aborted) { state.status = 'aborted'; update(); return; }
      let st;
      try { st = statSync(fp); } catch { continue; }
      allFiles.push({ path: fp, size: st.size });
      state.progress.total = allFiles.length;
      if (allFiles.length % 50 === 0) update();
    }
    if (!allFiles.length) { state.status = 'complete'; update(); return; }

    // Phase 1.5: group by file size — only hash files where ≥2 share the same size
    const sizeMap = new Map();
    for (const f of allFiles) {
      if (!sizeMap.has(f.size)) sizeMap.set(f.size, []);
      sizeMap.get(f.size).push(f);
    }
    const filesToHash = [];
    for (const group of sizeMap.values()) {
      if (group.length >= 2) filesToHash.push(...group);
    }
    const skippedCount = allFiles.length - filesToHash.length;
    if (!filesToHash.length) {
      state.status = 'complete';
      state.files = [];
      state.duplicates = [];
      state.stats = { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 };
      update();
      return;
    }

    state.status = 'hashing';
    state.progress.total = filesToHash.length;
    state.progress.processed = 0;
    update();

    // Use worker thread pool for parallel streaming hash (only files sharing a size)
    const pool = getHashPool(4);
    const batchSize = 20;
    const fileHashes = [];

    for (let i = 0; i < filesToHash.length; i += batchSize) {
      if (state._aborted) { state.status = 'aborted'; update(); await pool.terminate(); return; }
      const batch = filesToHash.slice(i, i + batchSize);
      const paths = batch.map(f => f.path);
      let results;
      try {
        results = await pool.hashFiles(paths);
      } catch (e) {
        console.error('[DupScan] batch ' + i + '-' + (i + batchSize) + ' failed: ' + e.message + ', skipping');
        state.error = state.error || '部分批次失败: ' + e.message;
        continue;
      }
      for (const r of results) {
        if (r) fileHashes.push(r);
      }
      state.progress.processed = Math.min(i + batchSize, filesToHash.length);
      state.progress.currentFile = batch[batch.length - 1].path;
      if ((i + batchSize) % 50 === 0 || i + batchSize >= filesToHash.length) update();
    }
    await pool.terminate();

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

// GET /api/dup/status?jobId=xxx
export function handleDupStatus(req, res) {
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

// GET /api/jobs
export function handleDupJobs(req, res) {
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
export async function handleDupDelete(req, res) {
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
            const ext2 = extname(dest);
            finalDest = join(dirname(dest), `${basename(dest).slice(0, -ext2.length)}_${counter}${ext2}`);
            counter++;
          }
          try { renameSync(fp, finalDest); }
          catch (e2) { if (e2.code === 'EXDEV') { cpSync(fp, finalDest); unlinkSync(fp); } else throw e2; }
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
export async function handleDupExport(req, res) {
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
export async function handleDupStop(req, res) {
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
export async function handleDupPause(req, res) {
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
export async function handleDupResume(req, res) {
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
