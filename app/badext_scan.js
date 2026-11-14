#!/usr/bin/env node
/**
 * badext_scan.js — 扩展名与内容不符检测（Bad Extensions）
 * Launched as a subprocess by server.js（与 broken_scan.js / namematch_scan.js 同模式）。
 *
 * Usage: node badext_scan.js <scan_paths> <job_id> <state_dir>
 *
 * 只读文件头 magic bytes（12~32 字节），不读全文件、不解码，
 * 所以 10 万文件的扫描也是秒级。NAS 上常见场景：下载器把 .jpg 写成
 * 实际 PNG/HEIC，或者手机导入时扩展名丢失、变成 .bin/.dat。
 *
 * 报三类：
 *   mismatch  —— 扩展名与实际内容类型不一致（可一键改名修复）
 *   no_ext    —— 没有扩展名但识别出了内容类型
 *   unknown   —— 读不出 magic（空白文件/加密文件/无头格式），不算错，单独统计
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const POLL_MS = 1000;
const MAX_FILES = 200000;
const HEAD_BYTES = 32;        // 读 32 字节足够判定所有常见格式
const YIELD_EVERY = 500;

const [scanPathsRaw, jobId, stateDir] = process.argv.slice(2);
const scanPaths = String(scanPathsRaw || '').split(',').map(s => s.trim()).filter(Boolean);
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

function writeState(data) {
  const p = join(stateDir, `${jobId}.json`);
  const tmp = p + '.tmp';
  try { writeFileSync(tmp, JSON.stringify(data, (k, v) => v === undefined ? null : v)); renameSync(tmp, p); }
  catch (e) { process.stderr.write(`writeState error: ${e}\n`); }
}

// ── magic 签名表 ──
// 每条: { kind: 内容类型, exts: 该类型允许的扩展名(不含点, 小写), test: bytes => bool }
const SIGS = [
  // 图片
  { kind: 'JPEG', exts: ['jpg', 'jpeg', 'jpe', 'jfif', 'thm'], test: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { kind: 'PNG', exts: ['png', 'apng'], test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { kind: 'GIF', exts: ['gif'], test: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { kind: 'WEBP', exts: ['webp'], test: b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { kind: 'BMP', exts: ['bmp', 'dib'], test: b => b[0] === 0x42 && b[1] === 0x4D },
  { kind: 'TIFF', exts: ['tif', 'tiff'], test: b => (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A) || (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00) },
  { kind: 'HEIC', exts: ['heic', 'heif', 'hif'], test: b => str(b, 4, 4).startsWith('ftyp') && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(str(b, 8, 4)) },
  { kind: 'AVIF', exts: ['avif'], test: b => str(b, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(str(b, 8, 4)) },
  { kind: 'PSD', exts: ['psd'], test: b => str(b, 0, 4) === '8BPS' },
  { kind: 'ICO', exts: ['ico'], test: b => b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },
  // 视频
  { kind: 'MKV', exts: ['mkv', 'webm', 'mka'], test: b => b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3 },
  { kind: 'AVI', exts: ['avi', 'divx'], test: b => str(b, 0, 4) === 'RIFF' && str(b, 8, 4) === 'AVI ' },
  { kind: 'MP4', exts: ['mp4', 'm4v', 'm4a', 'mov', 'qt', '3gp', 'f4v'], test: b => str(b, 4, 4) === 'ftyp' },
  { kind: 'FLV', exts: ['flv'], test: b => str(b, 0, 3) === 'FLV' },
  { kind: 'WMV', exts: ['wmv', 'wma', 'asf'], test: b => b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75 },
  // 音频
  { kind: 'MP3', exts: ['mp3', 'mp2'], test: b => str(b, 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) },
  { kind: 'FLAC', exts: ['flac'], test: b => str(b, 0, 4) === 'fLaC' },
  { kind: 'OGG', exts: ['ogg', 'oga', 'opus', 'ogv'], test: b => str(b, 0, 4) === 'OggS' },
  { kind: 'WAV', exts: ['wav'], test: b => str(b, 0, 4) === 'RIFF' && str(b, 8, 4) === 'WAVE' },
  { kind: 'APE', exts: ['ape'], test: b => str(b, 0, 4) === 'MAC ' },
  // 文档 / 归档
  { kind: 'PDF', exts: ['pdf'], test: b => str(b, 0, 4) === '%PDF' },
  { kind: 'ZIP', exts: ['zip', 'docx', 'xlsx', 'pptx', 'epub', 'jar', 'apk', 'odt', 'ods', 'odp', 'cbz'], test: b => b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { kind: 'RAR', exts: ['rar'], test: b => str(b, 0, 4) === 'Rar!' },
  { kind: '7Z', exts: ['7z'], test: b => b[0] === 0x37 && b[1] === 0x7A && b[2] === 0xBC && b[3] === 0xAF },
  { kind: 'GZIP', exts: ['gz', 'tgz'], test: b => b[0] === 0x1F && b[1] === 0x8B },
  { kind: 'BZIP2', exts: ['bz2'], test: b => str(b, 0, 3) === 'BZh' },
  { kind: 'XZ', exts: ['xz', 'txz'], test: b => b[0] === 0xFD && str(b, 1, 3) === '7zX' },
  { kind: 'OLE', exts: ['doc', 'xls', 'ppt', 'msi', 'msg'], test: b => b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0 },
  { kind: 'RTF', exts: ['rtf'], test: b => str(b, 0, 5) === '{\\rtf' },
  // 可执行 / 其他
  { kind: 'ELF', exts: ['so', 'elf', 'bin', 'o', 'ko'], test: b => b[0] === 0x7F && b[1] === 0x45 && b[2] === 0x4C && b[3] === 0x46 },
  { kind: 'EXE', exts: ['exe', 'dll', 'sys', 'ocx'], test: b => b[0] === 0x4D && b[1] === 0x5A },
  { kind: 'ISO', exts: ['iso', 'img'], test: b => str(b, 1, 5) === 'CD001' },
  { kind: 'SQLITE', exts: ['db', 'sqlite', 'sqlite3', 'db3'], test: b => str(b, 0, 6) === 'SQLite' },
];

// 文本类没有 magic，靠启发式：全是可打印 ASCII/UTF-8
const TEXT_EXTS = ['txt', 'log', 'md', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf',
  'cfg', 'sh', 'py', 'js', 'ts', 'css', 'html', 'htm', 'php', 'c', 'h', 'cpp', 'go', 'rs', 'java',
  'sql', 'toml', 'srt', 'ass', 'vtt', 'nfo', 'svg2'];
const TEXT_KIND = 'TEXT';

function str(buf, offset, len) {
  if (buf.length < offset + len) return '';
  return buf.slice(offset, offset + len).toString('latin1');
}

/** 根据 magic 判定内容类型；返回 null 表示无法识别 */
function detectKind(head) {
  if (!head || head.length < 4) return null;
  for (const s of SIGS) {
    try { if (s.test(head)) return s; } catch { /* 越界读忽略 */ }
  }
  return null;
}

/** 内容是否像文本（可打印比例 > 90% 且无 NUL） */
function looksLikeText(head) {
  if (!head || head.length === 0) return false;
  let printable = 0;
  for (const c of head) {
    if (c === 0) return false;                       // NUL 字节 → 二进制
    if (c === 9 || c === 10 || c === 13) { printable++; continue; }
    if (c >= 32 && c <= 126) { printable++; continue; }
    if (c >= 0xC0) { printable++; continue; }        // UTF-8 多字节首/续字节
  }
  return printable / head.length >= 0.9;
}

function readHead(fp) {
  let fd;
  try {
    fd = openSync(fp, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return n > 0 ? buf.slice(0, n) : Buffer.alloc(0);
  } catch { return Buffer.alloc(0); }
  finally { try { if (fd !== undefined) closeSync(fd); } catch { /* ignore */ } }
}

const state = {
  id: jobId, type: 'badext', rootPaths: scanPaths,
  status: 'scanning',
  progress: { scanned: 0, currentFile: '' },
  items: [],          // [{ path, name, ext, actualKind, expectedExts, category, size }]
  stats: { scanned: 0, mismatch: 0, no_ext: 0, unknown: 0, text_ok: 0, skipped: 0, byKind: {} },
  error: null, startTime: Date.now(), _aborted: false,
};

let total = 0;

async function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (state._aborted) return;
    if (total >= MAX_FILES) return;

    const full = join(dir, e.name);
    // 跳过应用/系统目录（与 dup_scan 保持一致的排除思路）
    if (e.isDirectory()) {
      if (/^\..+$/.test(e.name) && e.name !== '.') continue;    // 隐藏目录
      await walk(full);
      continue;
    }
    if (!e.isFile()) continue;

    total++;
    if (total % 50 === 0) {
      state.progress.scanned = total;
      state.progress.currentFile = e.name;
      writeState(state);
      // 支持外部 stop
      try {
        const raw = JSON.parse(readFileSync(join(stateDir, `${jobId}.json`), 'utf8'));
        if (raw._aborted) { state._aborted = true; state.status = 'aborted'; writeState(state); return; }
      } catch { /* ignore */ }
      if (total % YIELD_EVERY === 0) await sleep(0);
    }

    let st;
    try { st = statSync(full); } catch { state.stats.skipped++; continue; }
    if (st.size === 0) { state.stats.skipped++; continue; }   // 空文件交给 broken 扫描

    const ext = extname(e.name).toLowerCase().replace(/^\./, '');
    const head = readHead(full);
    if (head.length === 0) { state.stats.skipped++; continue; }

    const sig = detectKind(head);

    if (sig) {
      state.stats.byKind[sig.kind] = (state.stats.byKind[sig.kind] || 0) + 1;
      if (!ext) {
        // 无扩展名但识别出类型 → 建议补上
        state.stats.no_ext++;
        state.items.push({
          path: full, name: e.name, ext: '', size: st.size,
          actualKind: sig.kind, expectedExts: sig.exts, category: 'no_ext',
          suggest: sig.exts[0],
        });
      } else if (!sig.exts.includes(ext)) {
        state.stats.mismatch++;
        state.items.push({
          path: full, name: e.name, ext, size: st.size,
          actualKind: sig.kind, expectedExts: sig.exts, category: 'mismatch',
          suggest: sig.exts[0],
        });
      }
      continue;
    }

    // magic 无法识别：看是否像文本
    if (looksLikeText(head)) {
      if (ext && TEXT_EXTS.includes(ext)) { state.stats.text_ok++; }
      else if (!ext) {
        state.stats.no_ext++;
        state.items.push({
          path: full, name: e.name, ext: '', size: st.size,
          actualKind: TEXT_KIND, expectedExts: ['txt'], category: 'no_ext', suggest: 'txt',
        });
      }
      continue;    // 扩展名是别的但内容是文本 → 不报（可能是 .log/.conf 等未收录后缀）
    }

    state.stats.unknown++;
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
  await sleep(POLL_MS);   // 让前端有一次机会看到 100%
  state.status = 'complete';
  state.progress.scanned = total;
  state.stats.scanned = total;   // 前端 KPI/状态文案读的是 stats.scanned，不是 progress
  state.progress.currentFile = '';
  // 按类别+大小排序，界面默认看最大的
  state.items.sort((a, b) => (b.size || 0) - (a.size || 0));
  writeState(state);
}

main().catch(e => {
  state.status = 'error';
  state.error = String(e && e.stack || e);
  writeState(state);
  process.exit(1);
});
