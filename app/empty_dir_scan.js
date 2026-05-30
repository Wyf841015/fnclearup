#!/usr/bin/env node
// empty_dir_scan.js — 后台空目录扫描脚本（单遍遍历）
// Usage: node empty_dir_scan.js <scanPath> <jobId> <stateDir>

import { readdirSync, lstatSync, existsSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [, , scanPath, jobId, stateDir] = process.argv;
const stateFile = join(stateDir, `empty_${jobId}.json`);
const MAX_DIRS = 200000; // 最多扫描 20 万个目录，防止意外长时间扫描
const PROGRESS_INTERVAL = 10; // 每扫描 10 个目录更新一次进度

function updateState(status, items, error = null, currentDir = null) {
  try {
    const raw = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, 'utf-8'))
      : { id: jobId, rootPath: scanPath, startTime: Date.now() };
    raw.status = status;
    raw.items = items;
    raw.total = items.length || 0;
    raw.error = error;
    if (currentDir !== null) raw.currentDir = currentDir;
    const tmp = stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(raw));
    renameSync(tmp, stateFile);
  } catch {}
}

// 捕获未预期的错误（如 import 失败等）
process.on('uncaughtException', (err) => {
  try { writeFileSync(stateFile, JSON.stringify({ id: jobId, rootPath: scanPath, status: 'error', error: '未捕获异常: ' + (err.message || String(err)) })); } catch {}
  process.exit(1);
});

// ── 单遍遍历 ──
const dirMap = new Map();
const allPaths = [];
let visitCount = 0;

function scanDir(dirPath, visited = new Set()) {
  if (visited.has(dirPath)) return null;
  visited.add(dirPath);
  visitCount++;

  if (visitCount > MAX_DIRS) {
    updateState('error', [], '扫描目录超过上限 ' + MAX_DIRS + ' 个，已终止', dirPath);
    process.exit(1);
  }

  // 每 PROGRESS_INTERVAL 个目录更新一次进度
  if (visitCount % PROGRESS_INTERVAL === 0) {
    updateState('scanning', [], null, dirPath);
  }

  let entries;
  try { entries = readdirSync(dirPath); } catch { return null; }

  const info = { hasFile: false, children: new Set() };

  for (const name of entries) {
    const fp = join(dirPath, name);
    let st;
    try { st = lstatSync(fp); } catch { continue; }

    if (st.isFile()) {
      info.hasFile = true;
    } else if (st.isDirectory() && !st.isSymbolicLink()) {
      info.children.add(fp);
      const childInfo = scanDir(fp, visited);
      if (childInfo && childInfo.hasFile) info.hasFile = true;
    }
  }

  dirMap.set(dirPath, info);
  allPaths.push(dirPath);
  return info;
}

try {
  // Step 1: 扫描整棵树
  scanDir(scanPath);

  // Step 2: 自底向上传播 hasFile
  for (let i = allPaths.length - 1; i >= 0; i--) {
    const info = dirMap.get(allPaths[i]);
    if (!info) continue;
    for (const childPath of info.children) {
      const childInfo = dirMap.get(childPath);
      if (childInfo && childInfo.hasFile) info.hasFile = true;
    }
  }

  // Step 3: 自上而下收集空目录
  const results = [];
  function collect(dirPath) {
    const info = dirMap.get(dirPath);
    if (!info) return;
    if (!info.hasFile) {
      results.push({ path: dirPath, name: basename(dirPath), type: 'dir' });
      return;
    }
    for (const childPath of info.children) collect(childPath);
  }
  collect(scanPath);

  updateState('complete', results, null, null);
} catch (e) {
  updateState('error', [], e.message || '扫描异常', null);
}
process.exit(0);
