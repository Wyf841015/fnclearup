import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync, mkdirSync, renameSync, cpSync, linkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, extname, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { sendJSON, execCmd, parseBody, formatBytes, isSafePath, isDeletablePath, partitionDeletable, protectedReason, parseQuery, safeReadJSON } from '../lib/util.js';
import { MUSIC_EXTS } from '../lib/config.js';
import { loadPatterns, DEFAULT_PATTERNS } from '../../exclude_rules.js';
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
  const scanPaths = Array.isArray(data.paths) ? data.paths.map(p => p.trim()).filter(Boolean) : [];
  const minSize = (data.minSize === undefined || data.minSize === null) ? 0 : (Number(data.minSize) || 0);
  const keepMode = data.keepMode || 'first';   // first | newest | deepest
  if (!['music', 'files'].includes(scanType)) {
    sendJSON(res, 400, { error: '无效的扫描类型', success: false });
    return;
  }
  if (scanPaths.length === 0) {
    sendJSON(res, 400, { error: '请至少选择一个扫描目录', success: false });
    return;
  }
  for (const p of scanPaths) {
    if (!existsSync(p)) {
      sendJSON(res, 400, { error: `目录不存在: ${p}`, success: false });
      return;
    }
    if (!isSafePath(p)) {
      sendJSON(res, 403, { error: `路径越界：${p} 仅允许 /vol* 下的目录`, success: false });
      return;
    }
  }
  const jobId = `dup_${randomUUID().slice(0, 8)}`;
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);

  const initialState = {
    id: jobId, scanType, rootPaths: scanPaths, minSize, keepMode,
    status: 'counting',
    progress: { total: 0, processed: 0, currentFile: '' },
    files: [], duplicates: [], stats: { totalFiles: 0, duplicateGroups: 0, duplicateFiles: 0, wastedBytes: 0 },
    error: null, startTime: Date.now(), _aborted: false, _paused: false, _prev_status: 'counting',
  };
  // Atomic write via temp file + rename
  const tmpInit = stateFile + '.tmp';
  writeFileSync(tmpInit, JSON.stringify(initialState));
  renameSync(tmpInit, stateFile);

  if (existsSync(DUP_SCAN_SCRIPT)) {
    const proc = spawn(process.execPath, [DUP_SCAN_SCRIPT, scanType, scanPaths.join(','), jobId, DUP_STATE_DIR, String(minSize), keepMode], {
      stdio: 'ignore', detached: false, timeout: 3600000,
    });
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { console.error('[dup.js]'); } }, 3660000);
    proc.on('exit', () => { clearTimeout(killTimer); dupJobs.delete(jobId); });
    proc.on('error', () => { clearTimeout(killTimer); dupJobs.delete(jobId); });
    dupJobs.set(jobId, { stateFile, scanType, scanPaths, proc });
  } else {
    runDupScanInline(jobId, scanType, scanPaths, stateFile).catch(() => {});
  }

  sendJSON(res, 200, { jobId, status: 'started', success: true });
}

async function runDupScanInline(jobId, scanType, scanPaths, stateFile) {
  const extensions = scanType === 'music' ? MUSIC_EXTS : null;
  const state = safeReadJSON(stateFile, 'utf-8');
  const minSize = state.minSize || 0;
  const keepMode = state.keepMode || 'first';
  const update = () => {
    const tmp = stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, stateFile);
  };
  try {
    state.status = 'counting';
    const allFiles = [];         // {path, size, mtimeMs}[]
    for (const sp of scanPaths) {
      if (state._aborted) { state.status = 'aborted'; update(); return; }
      if (await checkPause(state, stateFile, update)) { state.status = 'aborted'; update(); return; }
      for await (const fp of walkDir(sp, extensions)) {
        if (state._aborted) { state.status = 'aborted'; update(); return; }
        if (await checkPause(state, stateFile, update)) { state.status = 'aborted'; update(); return; }
        let st;
        try { st = statSync(fp); } catch { continue; }
        if (minSize > 0 && st.size < minSize) continue;   // min-size filter
        allFiles.push({ path: fp, size: st.size, mtimeMs: st.mtimeMs });
        state.progress.total = allFiles.length;
        if (allFiles.length % 50 === 0) update();
      }
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
      if (await checkPause(state, stateFile, update)) { state.status = 'aborted'; update(); await pool.terminate(); return; }
      const batch = filesToHash.slice(i, i + batchSize);
      const paths = batch.map(f => f.path);
      let results;
      try {
        results = await pool.hashFiles(paths, {
          onProgress: function(idx, total, filePath, result) {
            state.progress.processed = Math.min(state.progress.processed + 1, state.progress.total);
            state.progress.currentFile = filePath;
            state.progress.hashProgress = '';
            if (result && result.error) {
              if (!state.failedFiles) state.failedFiles = [];
              state.failedFiles.push({ path: filePath, error: result.error });
            }
            update();
          },
          onFileHashProgress: function(filePath, bytesRead, totalSize) {
            const pct = totalSize > 0 ? Math.round((bytesRead / totalSize) * 100) : 0;
            state.progress.currentFile = filePath;
            state.progress.hashProgress = pct + '%';
            update();
          },
        });
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
        // Smart keep (mirrors dup_scan.js): files[0] is the file to KEEP
        let kept;
        if (keepMode === 'newest') {
          kept = files.slice().sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
        } else if (keepMode === 'deepest') {
          kept = files.slice().sort((a, b) => b.path.split('/').length - a.path.split('/').length)[0];
        } else {
          kept = files.slice().sort((a, b) => a.path.localeCompare(b.path))[0];
        }
        const rest = files.filter(f => f.path !== kept.path)
          .sort((a, b) => a.path.localeCompare(b.path));
        const ordered = [kept, ...rest];
        const wasted = rest.reduce((s, f) => s + (f.size || 0), 0);
        duplicates.push({ hash, count: ordered.length, files: ordered, wasted, keepMode });
        dupFiles += ordered.length;
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

// Check if scan should pause — re-read state file, wait in loop until resumed
async function checkPause(state, stateFile, update) {
  // Re-read from file to detect external pause/abort signals
  try {
    const fresh = safeReadJSON(stateFile, 'utf-8');
    state._paused = fresh._paused;
    state._aborted = fresh._aborted;
  } catch (e) { console.error('[dup.js]', e); }
  if (!state._paused) return false;
  state._prev_status = state.status;
  state.status = 'paused';
  update();
  while (state._paused && !state._aborted) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const fresh = safeReadJSON(stateFile, 'utf-8');
      state._paused = fresh._paused;
      state._aborted = fresh._aborted;
    } catch (e) { console.error('[dup.js]', e); }
  }
  const wasAborted = state._aborted;
  if (!wasAborted && state._prev_status) {
    state.status = state._prev_status;
    update();
  }
  return wasAborted;
}

// P0 安全: jobId 直接拼进状态文件路径 join(DUP_STATE_DIR, `dup_${jobId}.json`),
// 而 stop/pause/resume 会 writeFileSync(tmp)+renameSync 覆盖目标文件。
// jobId 含 '../' 即可写到状态目录之外(进程 root 运行)。
// 生成侧 jobId = 'dup_' + randomUUID().slice(0,8) (见 handleDupStart),
// 这里按同样形状校验, 与 broken.js(/^broken_/)/namematch.js(/^name_/)/simdup.js(/^simdup_/) 一致。
function isValidDupJobId(jobId) {
  return typeof jobId === 'string' && /^dup_[0-9a-f]{1,32}$/.test(jobId);
}

// GET /api/dup/status?jobId=xxx&start=0&limit=50
export function handleDupStatus(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const params = parseQuery(url);
  const jobId = params.jobId || '';
  if (!isValidDupJobId(jobId)) { sendJSON(res, 400, { error: 'jobId 非法', success: false }); return; }
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
  if (!existsSync(stateFile)) { sendJSON(res, 404, { error: '任务不存在', success: false }); return; }
  try {
    const raw = safeReadJSON(stateFile, 'utf-8');
    const stats = raw.stats || {};
    const allDups = raw.duplicates || [];
    const total = allDups.length;

    // 分页参数: start 不存在时只返回 stats/进度（轮询节省带宽）
    const hasStart = params.start !== undefined;
    const start = hasStart ? Math.max(0, parseInt(params.start) || 0) : 0;
    const limit = hasStart ? Math.min(200, Math.max(1, parseInt(params.limit) || 50)) : 0;
    const page = allDups.slice(start, start + limit);

    const formatted = {
      id: raw.id, scanType: raw.scanType, status: raw.status, progress: raw.progress, rootPaths: raw.rootPaths,
      duplicates: page.map(g => ({
        hash: g.hash, count: g.count, wasted: g.wasted, wastedHuman: formatBytes(g.wasted),
        files: g.files.map(f => ({ path: f.path, name: basename(f.path), size: f.size, sizeHuman: formatBytes(f.size), ext: f.ext, id3: f.id3 })),
      })),
      stats: { totalFiles: stats.totalFiles || 0, duplicateGroups: stats.duplicateGroups || 0, duplicateFiles: stats.duplicateFiles || 0, wastedBytes: stats.wastedBytes || 0, wastedHuman: formatBytes(stats.wastedBytes || 0) },
      error: raw.error, startTime: raw.startTime, failedFiles: raw.failedFiles || [],
      pagination: { total, start, limit, hasMore: start + limit < total },
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
        const raw = safeReadJSON(join(DUP_STATE_DIR, f), 'utf-8');
        list.push({ id: raw.id, scanType: raw.scanType, status: raw.status, rootPaths: raw.rootPaths, progress: raw.progress, stats: raw.stats, startTime: raw.startTime });
      } catch { console.error('[dup.js]'); }
    }
  } catch { console.error('[dup.js]'); }
  sendJSON(res, 200, list);
}

// POST /api/dup/delete
export async function handleDupDelete(req, res) {
  const data = await parseBody(req);
  // P0 安全: 重复文件删除不得触及 fnOS 系统目录(@appcenter/@appdata/...)与
  // 卷内回收站(.@#local)。这些目录常与其他应用共享同名文件(各应用的 LICENSE、
  // 图标、依赖), 误删会导致对应应用无法启动。
  const { ok: files, blocked } = partitionDeletable(data.files || []);
  const skipped = (data.files || []).length - files.length;
  const mode = data.mode || 'trash';   // trash | permanent | hardlink
  const keep = data.keep || '';        // for hardlink mode: the file to KEEP (others become hard links to it)
  let deleted = 0;
  const linked = [];
  const failed = [];
  const emptyDirs = [];   // P2-6: dirs that became empty after deletion (link scan notification)

  for (const fp of files) {
    try {
      if (mode === 'permanent') {
        if (existsSync(fp)) unlinkSync(fp);
        deleted++;
      } else if (mode === 'hardlink') {
        // P1-4: replace a duplicate with a hard link to the kept file — frees space for
        // the dupe's data blocks WITHOUT deleting it (data remains reachable). Only valid
        // when the original is on the same filesystem.
        if (!keep || !existsSync(fp)) throw new Error('硬链接去重需要有效的原始文件');
        // P1-2 fix: the kept file must still exist BEFORE we unlink the duplicate,
        // otherwise unlinkSync destroys the only copy and linkSync(keep,...) fails
        // below (keep vanished) → the duplicate is unrecoverable. Also verify they
        // share a filesystem so linkSync won't throw EXDEV after unlink.
        if (!existsSync(keep)) throw new Error('原始文件不存在: ' + keep);
        if (!isDeletablePath(keep)) throw new Error('原始文件路径不可操作：' + (protectedReason(keep) || '路径越界'));
        if (fp === keep) continue;
        // Same-filesystem guard: linkSync throws EXDEV across devices, but that
        // happens AFTER unlinkSync destroyed the duplicate. Check st_dev up front.
        const fpSt = statSync(fp), keepSt = statSync(keep);
        if (fpSt.ino === keepSt.ino) throw new Error('文件已硬链接过');
        if (fpSt.dev !== keepSt.dev) throw new Error('跨文件系统无法硬链接: ' + fp);
        unlinkSync(fp);                    // remove the duplicate inode
        linkSync(keep, fp);                // link fp → keep (shares data blocks)
        linked.push(fp);
      } else {  // trash
        const m = fp.match(/^\/(?:mnt\/)?(vol\d+)\/(\d+)\/(.+)/);
        if (m) {
          const trashDir = `/${m[1]}/${m[2]}/.@#local/trash`;
          const dest = join(trashDir, m[3]);
          mkdirSync(dirname(dest), { recursive: true });
          let finalDest = dest;
          let counter = 1;
          while (existsSync(finalDest)) {
            const ext2 = extname(dest);
            finalDest = join(dirname(dest), `${basename(dest).slice(0, -ext2.length)}_${counter}${ext2}`);
            counter++;
          }
          try { renameSync(fp, finalDest); deleted++; }
          catch (e2) { if (e2.code === 'EXDEV') { cpSync(fp, finalDest); unlinkSync(fp); deleted++; } else throw e2; }
        } else {
          failed.push({ path: fp, reason: '路径格式不支持回收站: ' + fp + ' (需 /volN/UID/... 格式)' });
        }
      }
      // P2-6: after any deletion/link, check whether the file's parent dir is now empty
      try {
        const parent = dirname(fp);
        if (existsSync(parent) && readdirSync(parent).length === 0) {
          emptyDirs.push(parent);
        }
      } catch { /* ignore — parent may be inaccessible, not an error */ }
    } catch (e) { failed.push({ file: fp, reason: e.message }); }
  }
  sendJSON(res, 200, {
    deleted, linked, failed, skipped,
    total: deleted + linked.length, failures: failed.length,
    // P0: 回传被拦截的路径与原因, 前端可提示「这 N 个因位于系统目录/回收站而跳过」
    blockedCount: blocked.length, blocked: blocked.slice(0, 50),
    emptyDirs: [...new Set(emptyDirs)].slice(0, 100),   // dedupe, cap
    success: true,
  });
}

// POST /api/dup/export
export async function handleDupExport(req, res) {
  const data = await parseBody(req);
  const jobId = data.jobId;
  const filterHash = data.hash || '';
  // Whitelist outputDir: must be under DATA_DIR (or its subdir 'exports')
  const defaultOutDir = join(DUP_STATE_DIR, 'exports');
  const requestedOut = data.outputDir || defaultOutDir;
  const outDir = isSafePath(requestedOut) ? requestedOut : defaultOutDir;
  let duplicates = [];
  if (data.duplicates && Array.isArray(data.duplicates)) {
    // Frontend sends raw duplicates data directly
    duplicates = data.duplicates;
  } else if (jobId) {
    // Backend reads from state file
    const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
    if (!existsSync(stateFile)) { sendJSON(res, 404, { error: '任务不存在', success: false }); return; }
    const raw = safeReadJSON(stateFile, 'utf-8');
    duplicates = raw.duplicates || [];
  } else {
    sendJSON(res, 400, { error: '缺少 jobId 或 duplicates 数据', success: false }); return;
  }
  mkdirSync(outDir, { recursive: true });
  let exported = 0;
  for (const g of duplicates) {
    if (filterHash && g.hash !== filterHash) continue;
    const hShort = (g.hash || 'unknown').slice(0, 8);
    const expPath = join(outDir, `dup_${hShort}`);
    mkdirSync(expPath, { recursive: true });
    // CSV injection prevention: prefix leading =, +, -, @, \t, \r with single-quote
    const sanitize = (v) => {
      const s = String(v ?? '');
      return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    };
    const csvEscape = (v) => {
      const s = sanitize(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvLines = ['路径,文件名,大小,扩展名,艺术家,标题,专辑'];
    for (const f of g.files) {
      const id3 = f.id3 || {};
      csvLines.push([
        csvEscape(f.path), csvEscape(basename(f.path)), f.size, csvEscape(f.ext),
        csvEscape(id3.artist||''), csvEscape(id3.title||''), csvEscape(id3.album||'')
      ].join(','));
    }
    const csvPath = join(expPath, 'report.csv');
    const csvTmp = csvPath + '.tmp';
    writeFileSync(csvTmp, '\uFEFF' + csvLines.join('\n'));
    renameSync(csvTmp, csvPath);
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
    const readmePath = join(expPath, 'README.md');
    const readmeTmp = readmePath + '.tmp';
    writeFileSync(readmeTmp, readme);
    renameSync(readmeTmp, readmePath);
    exported++;
  }
  sendJSON(res, 200, { exported, outputDir: outDir, success: true });
}

// POST /api/dup/stop
export async function handleDupStop(req, res) {
  const data = await parseBody(req);
  const jobId = data.jobId;
  if (!isValidDupJobId(jobId)) { sendJSON(res, 400, { success: false, error: 'jobId 非法' }); return; }
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
  if (!existsSync(stateFile)) { sendJSON(res, 200, { success: false, stopped: false }); return; }
  try {
    const raw = safeReadJSON(stateFile, 'utf-8');
    raw._aborted = true;
    const tmp = stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(raw));
    renameSync(tmp, stateFile);
    sendJSON(res, 200, { success: true, stopped: true });
  } catch { sendJSON(res, 200, { success: false, stopped: false }); }
}

// POST /api/dup/pause
export async function handleDupPause(req, res) {
  const data = await parseBody(req);
  const jobId = data.jobId;
  if (!isValidDupJobId(jobId)) { sendJSON(res, 400, { success: false, error: 'jobId 非法' }); return; }
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
  if (!existsSync(stateFile)) { sendJSON(res, 200, { success: false, paused: false }); return; }
  try {
    const raw = safeReadJSON(stateFile, 'utf-8');
    raw._paused = true;
    raw._prev_status = raw.status;
    raw.status = 'paused';
    const tmpP = stateFile + '.tmp';
    writeFileSync(tmpP, JSON.stringify(raw));
    renameSync(tmpP, stateFile);
    sendJSON(res, 200, { success: true, paused: true });
  } catch { sendJSON(res, 200, { success: false, paused: false }); }
}

// POST /api/dup/resume
export async function handleDupResume(req, res) {
  const data = await parseBody(req);
  const jobId = data.jobId;
  if (!isValidDupJobId(jobId)) { sendJSON(res, 400, { success: false, error: 'jobId 非法' }); return; }
  const stateFile = join(DUP_STATE_DIR, `dup_${jobId}.json`);
  if (!existsSync(stateFile)) { sendJSON(res, 200, { success: false, resumed: false }); return; }
  try {
    const raw = safeReadJSON(stateFile, 'utf-8');
    raw._paused = false;
    if (raw._prev_status) raw.status = raw._prev_status;
    const tmpR = stateFile + '.tmp';
    writeFileSync(tmpR, JSON.stringify(raw));
    renameSync(tmpR, stateFile);
    sendJSON(res, 200, { success: true, resumed: true });
  } catch { sendJSON(res, 200, { success: false, resumed: false }); }
}


// ── 扫描排除规则 (P1-1) ───────────────────────────────────────────────────
// GET  /api/dup/exclude-rules → { patterns, isDefault, defaultPatterns }
// POST /api/dup/exclude-rules { patterns: string[] } → 保存
// 规则文件落在 <TRM_PKGVAR>/data/scan_exclude.json, 扫描子进程通过 TRM_PKGVAR 自读。
function rulesFile() {
  const base = process.env.TRM_PKGVAR || '/vol3/@appdata/fnclearup';
  return join(base, 'data', 'scan_exclude.json');
}

export function handleGetExcludeRules(req, res) {
  const cur = loadPatterns();
  const isDefault = cur.length === DEFAULT_PATTERNS.length
    && cur.every((x, i) => x === DEFAULT_PATTERNS[i]);
  return sendJSON(res, 200, {
    success: true,
    patterns: cur,
    isDefault,
    defaultPatterns: DEFAULT_PATTERNS,
    file: rulesFile(),
  });
}

export async function handleSaveExcludeRules(req, res) {
  const data = await parseBody(req);
  if (!Array.isArray(data.patterns)) {
    return sendJSON(res, 400, { success: false, error: 'patterns 必须是字符串数组' });
  }
  const pats = data.patterns
    .map(x => String(x).trim())
    .filter(x => x && x.length <= 200)
    .slice(0, 200);
  const f = rulesFile();
  try {
    mkdirSync(join(f, '..'), { recursive: true });
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, patterns: pats }, null, 2), 'utf8');
    renameSync(tmp, f);
  } catch (e) {
    return sendJSON(res, 500, { success: false, error: '保存失败: ' + e.message });
  }
  return sendJSON(res, 200, { success: true, patterns: pats, count: pats.length, file: f });
}
