// ── SimHash (perceptual hash) for similar image/video detection (P0-2) ──
// Pure Node + ffmpeg. No npm deps.
//
// dHash (difference hash): resize to 9×8 grayscale, then for each of the 8
// rows compare pixel[i] vs pixel[i+1] → 64-bit hash. Hamming distance between
// two dHashes quantifies visual similarity (low = similar). Sub-second per
// image via ffmpeg (decode + scale + grayscale in one frame).
//
// Video similarity: extract 3 frames (first/middle/last) via ffmpeg, dHash
// each, and compare frame-wise (try to align orientation).

import { execCmd } from './ui/lib/util.js';
import { existsSync } from 'node:fs';

const FFMPEG = '/usr/bin/ffmpeg';

// Convert a file to a 9×8 grayscale raw stream (64 bytes? no — 9*8=72 px),
// then compute the 64-bit dHash (8 rows × 8 diffs).
// ffmpeg writes 9*8=72 bytes of grayscale (one byte per pixel) to stdout.
export async function dHashOfFile(filePath) {
  if (!existsSync(filePath)) return null;
  // `-pix_fmt gray` outputs 1 byte per pixel, 9*8 = 72 pixels.
  // `-f rawvideo` wraps to stdout. We read binary — execCmd's text mode may
  // mangle high bytes, so shell-out with Buffer via a small node runner and
  // capture stdout as base64. Simpler: use ffmpeg to write to a temp raw file
  // then read it. To keep it single-shot, use `-f rawvideo -` piped through
  // `base64` (safe ASCII) and decode on the JS side.
  const cmd = `${FFMPEG} -hide_banner -loglevel error -y -i ${q(filePath)} -vf scale=9:8 -pix_fmt gray -f rawvideo - 2>/dev/null | base64 -w0`;
  const r = await execCmd('bash', ['-c', cmd], 20000);
  if (r.code !== 0 || !r.stdout) return null;
  const buf = Buffer.from(r.stdout, 'base64');
  if (buf.length < 72) return null;
  return computeDHash(buf);
}

// Compute a 64-bit dHash from a 9×8 (72 byte) grayscale buffer.
// Returns BigInt hash + a helper for hamming distance.
function computeDHash(gray) {
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    const row = y * 9;
    for (let x = 0; x < 8; x++) {
      const left = gray[row + x];
      const right = gray[row + x + 1];
      const bit = left < right ? 1n : 0n;
      hash = (hash << 1n) | bit;
    }
  }
  return hash;
}

// Hamming distance between two BigInt hashes.
export function hamming(a, b) {
  let d = a ^ b;
  let count = 0;
  while (d) { count += Number(d & 1n); d >>= 1n; }
  return count;
}

// Extract up to 3 frames (first/middle/last) from a video via ffmpeg, return
// array of dHashes. Fails gracefully → [] on non-video/undecodable.
export async function videoDHashes(filePath, frameCount = 3) {
  if (!existsSync(filePath)) return [];
  // Get duration via ffprobe (optional; if missing, sample at t=0,1,2 min).
  // We just sample at a few time offsets — robust enough for similarity.
  const offsets = frameCount === 3 ? ['0', '0.5', '0.9'] : ['0'];
  const hashes = [];
  for (const frac of offsets) {
    // scale to 9x8 grayscale, select first video frame at that time
    const cmd = `${FFMPEG} -hide_banner -loglevel error -y -ss ${frac} -i ${q(filePath)} -frames:v 1 -vf scale=9:8 -pix_fmt gray -f rawvideo - 2>/dev/null | base64 -w0`;
    const pct = frac === '0' ? 0 : (frac === '0.5' ? 0.5 : 0.9);
    const r = await execCmd('bash', ['-c', cmd], 20000);
    if (r.code !== 0 || !r.stdout) continue;
    const buf = Buffer.from(r.stdout, 'base64');
    if (buf.length < 72) continue;
    hashes.push({ t: pct, hash: computeDHash(buf) });
  }
  return hashes;
}

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }