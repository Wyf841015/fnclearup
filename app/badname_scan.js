#!/usr/bin/env node
/**
 * badname_scan.js — 不规范文件名检测（Bad Names）
 * Launched as a subprocess by server.js（与 broken_scan.js / namematch_scan.js 同模式）。
 *
 * Usage: node badname_scan.js <scan_paths> <job_id> <state_dir>
 *
 * 为什么 NAS 上要看这个：Linux 允许的字符集比 Windows/macOS 宽得多，
 * 从 Linux 侧写进去的文件名到 SMB 共享里可能直接打不开、复制失败、
 * 同步工具报错。常见来源是下载器、爬虫、以及从其他系统迁移过来的数据。
 *
 * 检测项（severity 从高到低）：
 *   high   —— Windows 保留字符 < > : " | ? * 、控制字符(0x00-0x1F)、
 *             Windows 保留名(CON/PRN/AUX/NUL/COM1-9/LPT1-9)
 *   medium —— 首尾空格或点(Windows 会自动去掉，导致名字对不上)、
 *             组件超长(>255 字节)、零宽字符(U+200B/U+FEFF)
 *   low    —— 双向控制字符(U+202A-202E，会让路径显示顺序错乱)
 *
 * 纯 fs walk + 字符串检查，不读文件内容，10 万文件秒级。
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const POLL_MS = 1000;
const MAX_FILES = 300000;
const MAX_NAME_BYTES = 255;        // ext4/btrfs 单个组件上限
const YIELD_EVERY = 1000;

/** 仅在作为脚本直接执行时做 IO 初始化；被 import 时（单测取 checkName）
 *  不能碰 argv 与文件系统 —— 否则会拿 undefined 去 mkdirSync。 */
const isMainScript = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch { return false; }
})();

const [scanPathsRaw, jobId, stateDir] = isMainScript ? process.argv.slice(2) : ['', '', ''];
const scanPaths = String(scanPathsRaw || '').split(',').map(s => s.trim()).filter(Boolean);
if (isMainScript && stateDir && !existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

function writeState(data) {
  const p = join(stateDir, `${jobId}.json`);
  const tmp = p + '.tmp';
  try { writeFileSync(tmp, JSON.stringify(data, (k, v) => v === undefined ? null : v)); renameSync(tmp, p); }
  catch (e) { process.stderr.write(`writeState error: ${e}\n`); }
}

// Windows 保留字符（Linux 允许、SMB 侧会失败）
const WIN_RESERVED = /[<>:"|?*\\/:]/;
// Windows 保留设备名（不分大小写，带扩展名也算）
const WIN_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
// 控制字符
const CTRL_CHARS = /[\x00-\x1F\x7F]/;
// 零宽 / BOM / 方向控制
const ZERO_WIDTH = /[\u200B-\u200F\uFEFF]/;
const BIDI_CTRL = /[\u202A-\u202E\u2066-\u2069]/;

/**
 * 检查单个文件名，返回问题数组 [{ code, severity, detail, fixable }]
 * @param {string} name 文件名（不含路径）
 */
export function checkName(name) {
  const issues = [];
  if (!name || name === '.' || name === '..') return issues;

  // ① Windows 保留字符
  const m1 = name.match(WIN_RESERVED);
  if (m1) {
    // 注意：要替换**全部**非法字符，不能只替换第一个匹配到的那个 ——
    // 名字里常同时出现 : 和 ? 等多个保留字符，只换第一个会留下剩下的。
    const allBad = /[<>:"|?*\\/]/g;
    issues.push({
      code: 'win_reserved_char', severity: 'high', fixable: true,
      detail: `含 Windows 保留字符 "${m1[0]}"，SMB 共享/Windows 客户端无法访问`,
      suggest: name.replace(allBad, '_'),
    });
  }

  // ② 控制字符
  if (CTRL_CHARS.test(name)) {
    issues.push({
      code: 'control_char', severity: 'high', fixable: true,
      detail: '含控制字符（0x00-0x1F / 0x7F），多数文件管理器和同步工具会出错',
      suggest: name.replace(new RegExp(CTRL_CHARS.source, 'g'), ''),
    });
  }

  // ③ Windows 保留设备名
  if (WIN_RESERVED_NAMES.test(name)) {
    issues.push({
      code: 'win_reserved_name', severity: 'high', fixable: true,
      detail: '是 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9），Windows 无法创建或访问',
      suggest: '_' + name,
    });
  }

  // ④ 首尾空格或点
  if (/^\s|\s$/.test(name) || /^\.$|\.$/.test(name)) {
    const trimmed = name.replace(/^[\s.]+|[\s.]+$/g, '');
    if (trimmed && trimmed !== name) {
      issues.push({
        code: 'leading_trailing', severity: 'medium', fixable: true,
        detail: '首/尾有空格或点，Windows 会自动去掉，导致两边名字对不上',
        suggest: trimmed,
      });
    }
  }

  // ⑤ 超长
  const nameBytes = Buffer.byteLength(name, 'utf8');
  if (nameBytes > MAX_NAME_BYTES) {
    issues.push({
      code: 'too_long', severity: 'medium', fixable: false,
      detail: `文件名 ${nameBytes} 字节，超过文件系统上限 ${MAX_NAME_BYTES}（多为中文/表情占多字节）`,
    });
  }

  // ⑥ 零宽字符
  if (ZERO_WIDTH.test(name)) {
    issues.push({
      code: 'zero_width', severity: 'medium', fixable: true,
      detail: '含零宽字符或 BOM，肉眼看不见但会导致搜索/比对失败',
      suggest: name.replace(new RegExp(ZERO_WIDTH.source, 'g'), ''),
    });
  }

  // ⑦ 双向控制字符
  if (BIDI_CTRL.test(name)) {
    issues.push({
      code: 'bidi_control', severity: 'low', fixable: true,
      detail: '含双向文本控制字符，路径显示顺序会被打乱（伪装扩展名常用手法）',
      suggest: name.replace(new RegExp(BIDI_CTRL.source, 'g'), ''),
    });
  }

  return issues;
}

/** 单条建议名去重（同一条 issue 可能带多个问题） */
function dedupeIssues(list) {
  const seen = new Set();
  return list.filter(x => {
    const k = x.code;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const state = {
  id: jobId, type: 'badname', rootPaths: scanPaths,
  status: 'scanning',
  progress: { scanned: 0, currentFile: '' },
  items: [],       // [{ path, name, dir, size, issues:[...], severity }]
  stats: { scanned: 0, bad: 0, high: 0, medium: 0, low: 0, byCode: {}, skipped: 0 },
  error: null, startTime: Date.now(), _aborted: false,
};

let total = 0;

function recordIssue(full, name, st, issues) {
  if (!issues.length) return;
  const uniq = dedupeIssues(issues);
  if (!uniq.length) return;
  const sev = uniq.some(x => x.severity === 'high') ? 'high'
            : uniq.some(x => x.severity === 'medium') ? 'medium' : 'low';
  state.items.push({
    path: full,
    name,
    dir: full.slice(0, full.length - name.length - 1) || '/',
    size: st ? st.size : 0,
    isDir: st ? st.isDirectory() : false,
    issues: uniq,
    severity: sev,
  });
  state.stats.bad++;
  state.stats[sev]++;
  for (const i of uniq) state.stats.byCode[i.code] = (state.stats.byCode[i.code] || 0) + 1;
}

async function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (state._aborted) return;
    if (total >= MAX_FILES) return;

    total++;
    const full = join(dir, e.name);

    if (total % 100 === 0) {
      state.progress.scanned = total;
      state.progress.currentFile = e.name;
      writeState(state);
      try {
        const raw = JSON.parse(readFileSync(join(stateDir, `${jobId}.json`), 'utf8'));
        if (raw._aborted) { state._aborted = true; state.status = 'aborted'; writeState(state); return; }
      } catch { /* ignore */ }
      if (total % YIELD_EVERY === 0) await sleep(0);
    }

    let st = null;
    try { st = statSync(full); } catch { state.stats.skipped++; }

    // 目录名和文件名都要检查 —— SMB 里打不开的目录同样影响很大
    const issues = checkName(e.name);
    recordIssue(full, e.name, st, issues);

    if (e.isDirectory()) await walk(full);
  }
}

async function main() {
  writeState(state);
  for (const p of scanPaths) {
    if (!existsSync(p)) {
      state.status = 'error'; state.error = `目录不存在: ${p}`; writeState(state); return;
    }
    await walk(p);
    if (state._aborted) return;
  }
  await sleep(POLL_MS);
  state.status = 'complete';
  state.progress.scanned = total;
  state.stats.scanned = total;   // 前端 KPI/状态文案读的是 stats.scanned
  state.progress.currentFile = '';
  // high 优先，其次按问题数量
  const rank = { high: 0, medium: 1, low: 2 };
  state.items.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.issues.length - a.issues.length));
  writeState(state);
}

if (isMainScript) {
  main().catch(e => {
    state.status = 'error';
    state.error = String(e && e.stack || e);
    writeState(state);
    process.exit(1);
  });
}

export { MAX_NAME_BYTES };
