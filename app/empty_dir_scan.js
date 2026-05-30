#!/usr/bin/env node
// empty_dir_scan.js — 后台空目录扫描脚本（单遍遍历）
// Usage: node empty_dir_scan.js <scanPath> <jobId> <stateDir>

import { readdirSync, lstatSync, existsSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [, , scanPath, jobId, stateDir] = process.argv;
const stateFile = join(stateDir, `empty_${jobId}.json`);

function updateState(status, items, error = null, currentDir = null) {
  try {
    const raw = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, 'utf-8'))
      : { id: jobId, rootPath: scanPath, startTime: Date.now() };
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

// ── 单遍遍历 ──
// 扫描树一次，记录每个目录是否有文件（含子目录的文件）
// 然后自底向上传播 hasFile 标记，最后自上而下输出空目录

const dirMap = new Map(); // path -> { hasFile, children: Set<string> }
const allPaths = [];      // 保留遍历顺序供后续使用
let visitCount = 0;

function scanDir(dirPath, visited = new Set()) {
  if (visited.has(dirPath)) return null;
  visited.add(dirPath);
  visitCount++;

  // 每 50 个目录更新一次进度
  if (visitCount % 50 === 0) {
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
      if (childInfo) {
        if (childInfo.hasFile) info.hasFile = true;
      }
    }
    // symlink / socket / fifo → 跳过
  }

  dirMap.set(dirPath, info);
  allPaths.push(dirPath);
  return info;
}

// Step 1: 扫描整棵树
scanDir(scanPath);

// Step 2: 自底向上 propagate hasFile（倒序遍历）
for (let i = allPaths.length - 1; i >= 0; i--) {
  const p = allPaths[i];
  const info = dirMap.get(p);
  if (!info) continue;
  for (const childPath of info.children) {
    const childInfo = dirMap.get(childPath);
    if (childInfo && childInfo.hasFile) {
      info.hasFile = true;
    }
  }
}

// Step 3: 自上而下收集无文件的目录
const results = [];

function collect(dirPath) {
  const info = dirMap.get(dirPath);
  if (!info) return;

  if (!info.hasFile) {
    // 该目录及其所有子目录都没有任何文件 → 标记为空目录
    results.push({ path: dirPath, name: basename(dirPath), type: 'dir' });
    return; // 不递归子目录（它们已被当前目录覆盖）
  }

  for (const childPath of info.children) {
    collect(childPath);
  }
}

collect(scanPath);

updateState('complete', results, null, null);
process.exit(0);
