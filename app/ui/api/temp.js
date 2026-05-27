import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sendJSON, execCmd, parseBody, formatBytes } from '../lib/util.js';
import { TEMP_DIRS } from '../lib/config.js';

// GET /api/temp/scan
export function handleTempScan(req, res) {
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
export async function handleTempDelete(req, res) {
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
