#!/usr/bin/env node
/**
 * dup_hash_worker.js — Worker thread for parallel SHA-256 hash computation.
 * Receives file paths via parentPort, returns hash results.
 * Uses streaming reads (256KB-4MB chunks) to avoid memory spikes on large files.
 */
import { createHash } from 'node:crypto';
import { createReadStream, openSync, readSync, closeSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { PARTIAL_SEGMENT_BYTES } from './storage_profile.js';

const ID3_READ_SIZE = 10240;

function readId3Tags(fp) {
  try {
    const fd = openSync(fp, 'r');
    const buf = Buffer.alloc(ID3_READ_SIZE);
    const bytesRead = readSync(fd, buf, 0, ID3_READ_SIZE, 0);
    closeSync(fd);
    if (bytesRead >= 10 && buf.slice(0, 3).toString() === 'ID3') {
      const headerSize = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
      const end = Math.min(10 + headerSize, bytesRead);
      const tags = { title: '', artist: '', album: '' };
      let pos = 10;
      while (pos + 10 <= end) {
        const fid = buf.slice(pos, pos + 4).toString();
        const fsize = buf.readUInt32BE(pos + 4);
        if (fid === '\x00\x00\x00\x00' || fsize === 0) break;
        if (['TIT2', 'TPE1', 'TALB'].includes(fid) && pos + 10 + fsize <= end) {
          const val = buf.slice(pos + 11, pos + 10 + fsize).toString('utf-8').replace(/\x00/g, '').trim();
          if (fid === 'TIT2') tags.title = val;
          else if (fid === 'TPE1') tags.artist = val;
          else if (fid === 'TALB') tags.album = val;
        }
        pos += 10 + fsize;
      }
      return tags;
    }
  } catch (e) {
    // ID3 read failure is non-fatal
  }
  return null;
}

async function hashFile(fp, batchId, mode) {
  try {
    const st = statSync(fp);

    // Partial mode (Czkawka two-ended pre-filter): hash the first
    // PARTIAL_SEGMENT_BYTES AND the last PARTIAL_SEGMENT_BYTES (or the whole
    // file if smaller). Two-ended pre-hash rejects files that differ at head
    // OR tail (e.g. truncated/cut files with identical headers) BEFORE paying
    // for a full-stream read. Group key in the parent is size + partial, so
    // files differing in size are already out.
    //
    // P0 (2026-09-30): 4KB -> 32KB per segment. 原实现 4KB 太小, 大量文件
    // (尤其 MP4/MOV/ISO/压缩包, 文件头高度雷同) 区分度不足, 被迫进入全量
    // SHA-256。这里只加大单段读取、保持 seek 次数恒为 2 —— 机械盘上多一次
    // seek 的成本(数毫秒)远高于多读几十 KB, 所以不能加采样点, 只能加长度。
    if (mode === 'partial') {
      const PARTIAL_BYTES = PARTIAL_SEGMENT_BYTES;
      const hash = createHash('sha256');
      const fd = openSync(fp, 'r');
      if (st.size <= PARTIAL_BYTES) {
        // small file: single read covers everything
        const buf = Buffer.alloc(PARTIAL_BYTES);
        const n = readSync(fd, buf, 0, PARTIAL_BYTES, 0);
        hash.update(buf.slice(0, n));
      } else {
        // head 4KB
        const head = Buffer.alloc(PARTIAL_BYTES);
        const nh = readSync(fd, head, 0, PARTIAL_BYTES, 0);
        hash.update(head.slice(0, nh));
        // tail 4KB (only if file is larger than head segment)
        const tail = Buffer.alloc(PARTIAL_BYTES);
        const nt = readSync(fd, tail, 0, PARTIAL_BYTES, st.size - PARTIAL_BYTES);
        hash.update(tail.slice(0, nt));
      }
      closeSync(fd);
      return { path: fp, size: st.size, mtimeMs: st.mtimeMs, partial: hash.digest('hex') };
    }

    // Adaptive chunk size: 4MB for huge files, 1MB for large, 256KB for small
    let chunkSize = 256 * 1024;
    if (st.size > 500 * 1024 * 1024) chunkSize = 4 * 1024 * 1024;       // >500MB
    else if (st.size > 100 * 1024 * 1024) chunkSize = 1 * 1024 * 1024;  // >100MB

    const hash = createHash('sha256');
    const stream = createReadStream(fp, { highWaterMark: chunkSize });

    // Read ID3 tags before hashing (only for MP3s)
    let id3 = null;
    if (fp.toLowerCase().endsWith('.mp3')) {
      id3 = readId3Tags(fp);
    }

    // Stream hash: update incrementally, report progress every 2s
    let bytesRead = 0;
    let lastProgressReport = Date.now();
    for await (const chunk of stream) {
      hash.update(chunk);
      bytesRead += chunk.length;
      const now = Date.now();
      if (now - lastProgressReport > 2000) {
        lastProgressReport = now;
        parentPort.postMessage({
          type: 'file-hash-progress',
          batchId: batchId,
          file: fp,
          bytesRead: bytesRead,
          totalSize: st.size,
        });
      }
    }

    const digest = hash.digest('hex');
    return { path: fp, size: st.size, mtimeMs: st.mtimeMs, hash: digest, ext: extname(fp).toLowerCase(), id3 };
  } catch (e) {
    // Return error info so parent can track failures
    return { path: fp, error: e.message || String(e), size: 0, mtimeMs: 0, hash: null, partial: null, ext: null, id3: null };
  }
}

// Wrap message handler in try-catch to prevent worker crash from propagating
parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'hash') {
      const results = [];
      const mode = msg.mode || 'full';
      for (let idx = 0; idx < msg.files.length; idx++) {
        const fp = msg.files[idx];
        const r = await hashFile(fp, msg.batchId, mode);
        results.push(r);
        // Report progress after each file
        parentPort.postMessage({ type: 'partial', batchId: msg.batchId, index: idx, total: msg.files.length, file: fp, result: r });
      }
      parentPort.postMessage({ type: 'result', batchId: msg.batchId, results });
    } else if (msg.type === 'exit') {
      process.exit(0);
    }
  } catch (err) {
    // Prevent unhandled rejection from crashing the worker
    parentPort.postMessage({
      type: 'error',
      batchId: msg?.batchId || 0,
      error: err.message || String(err),
    });
  }
});

// Signal ready
parentPort.postMessage({ type: 'ready' });
