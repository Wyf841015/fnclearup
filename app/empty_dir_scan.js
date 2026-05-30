#!/usr/bin/env node
// empty_dir_scan.js — 后台空目录扫描脚本
// Usage: node empty_dir_scan.js <scanPath> <jobId> <stateDir>

import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [, , scanPath, jobId, stateDir] = process.argv;
const stateFile = join(stateDir, `empty_${jobId}.json`);

function isDirEmptySync(dirPath) {
  try {
    const entries = readdirSync(dirPath);
    if (entries.length === 0) return { empty: true, children: [] };
    const subInfo = [];
    for (const name of entries) {
      const fp = join(dirPath, name);
      try {
        const st = statSync(fp);
        if (st.isDirectory()) {
          subInfo.push({ name, path: fp, isDir: true, ...isDirEmptySync(fp) });
        } else {
          subInfo.push({ name, path: fp, isDir: false, size: st.size });
        }
      } catch {}
    }
    const childDirs = subInfo.filter(s => s.isDir);
    const childFiles = subInfo.filter(s => !s.isDir);
    if (childFiles.length > 0) return { empty: false, children: [] };
    if (childDirs.length === 0) return { empty: true, children: [] };
    const allChildDirsEmpty = childDirs.every(d => d.empty);
    if (allChildDirsEmpty) return { empty: true, children: childDirs.map(d => d.path) };
    const emptyChildDirs = childDirs.filter(d => d.empty);
    return { empty: false, children: emptyChildDirs.map(d => d.path) };
  } catch {
    return { empty: false, children: [] };
  }
}

function updateState(status, items, error = null, currentDir = null) {
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    raw.status = status;
    raw.items = items;
    raw.total = items.length;
    raw.error = error;
    if (currentDir !== null) raw.currentDir = currentDir;
    const tmp = stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(raw));
    renameSync(tmp, stateFile);
  } catch {}
}

const results = [];
const visited = new Set();

function walk(dir) {
  if (visited.has(dir)) return;
  visited.add(dir);
  // Update currentDir periodically (every 20 dirs to reduce I/O)
  if (visited.size % 20 === 0) updateState('scanning', results, null, dir);
  try {
    const { empty, children } = isDirEmptySync(dir);
    if (empty) {
      // Only add if not covered by an existing result
      const covered = results.some(r => children.some(c => c.startsWith(r.path + '/')));
      if (!covered) {
        // If children exist, add only those not covered
        if (children.length > 0) {
          for (const c of children) {
            if (!results.some(r => r.path === c)) results.push({ path: c, name: basename(c), type: 'dir' });
          }
        } else {
          results.push({ path: dir, name: basename(dir), type: 'dir' });
        }
      }
    } else {
      for (const c of children) {
        if (!visited.has(c)) walk(c);
      }
    }
  } catch {}
}

walk(scanPath);

// Final dedup — child paths should not appear if parent is already added
const filtered = results.filter(r => !results.some(r2 => r2.path !== r.path && r.path.startsWith(r2.path + '/')));
updateState('complete', filtered, null, null);
process.exit(0);