#!/usr/bin/env node
/**
 * dup_hash_worker.js — Worker thread for parallel SHA-256 hash computation.
 * Receives file paths via parentPort, returns hash results.
 * Uses streaming reads (256KB chunks) to avoid memory spikes on large files.
 */
import { createHash } from 'node:crypto';
import { createReadStream, openSync, readSync, closeSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

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
  } catch {}
  return null;
}

async function hashFile(fp) {
  try {
    const st = statSync(fp);
    // Adaptive chunk size: 4MB for huge files, 1MB for large, 256KB for small
    let chunkSize = 256 * 1024;
    if (st.size > 500 * 1024 * 1024) chunkSize = 4 * 1024 * 1024;       // >500MB
    else if (st.size > 100 * 1024 * 1024) chunkSize = 1 * 1024 * 1024;  // >100MB

    const hash = createHash('sha256');
    const stream = createReadStream(fp, { highWaterMark: chunkSize });

    // Read ID3 tags before hashing (read first 10KB separately, then start hash from byte 0)
    let id3 = null;
    if (fp.toLowerCase().endsWith('.mp3')) {
      id3 = readId3Tags(fp);
    }

    // Stream hash: update incrementally, no memory accumulation
    for await (const chunk of stream) {
      hash.update(chunk);
    }

    const digest = hash.digest('hex');
    return { path: fp, size: st.size, hash: digest, ext: extname(fp).toLowerCase(), id3 };
  } catch {
    return null;
  }
}

// Listen for batch messages from parent
parentPort.on('message', async (msg) => {
  if (msg.type === 'hash') {
    const results = [];
    for (const fp of msg.files) {
      const r = await hashFile(fp);
      if (r) results.push(r);
    }
    parentPort.postMessage({ type: 'result', batchId: msg.batchId, results });
  } else if (msg.type === 'exit') {
    process.exit(0);
  }
});

// Signal ready
parentPort.postMessage({ type: 'ready' });
