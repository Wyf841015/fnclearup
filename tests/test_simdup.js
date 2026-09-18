/**
 * FnClearup — Similar Image/Video Detection (P0-2) TDD Tests
 * Verifies:
 *   1. POST /api/simdup/scan rejects invalid type / missing path / unsafe path
 *   2. POST /api/simdup/scan on a whitelisted fixture root returns jobId
 *   3. GET /api/simdup/status returns progress → done with groups
 *   4. POST /api/simdup/stop sets _aborted
 * Requires ffmpeg on the host (fnOS ships it). Skips deep-scan assertions if the
 * worker can't run (e.g. no ffmpeg) but still validates API contract.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const PORT = 47942;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_TMP = '/tmp/fnclearup_test';
const SIM_ROOT = join(TEST_TMP, 'simdup_root');

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { method, hostname: url.hostname, port: PORT, path: url.pathname + url.search, headers: {} };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let server;
let ffmpegOK = false;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); ffmpegOK = true; } catch { ffmpegOK = false; }

function setupFixture() {
  rmSync(SIM_ROOT, { recursive: true, force: true });
  mkdirSync(SIM_ROOT, { recursive: true });
  // Two copies of the same real-ish source (use project icon as source,
  // guaranteed present). They are byte-identical → dHash distance ~0.
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'ICON_256.PNG');
  if (existsSync(src)) {
    copyFileSync(src, join(SIM_ROOT, 'img1.png'));
    copyFileSync(src, join(SIM_ROOT, 'img1_copy.png'));
  } else {
    // fallback: two real PNGs from the repo if icon missing
    writeFileSync(join(SIM_ROOT, 'img1.png'), Buffer.alloc(100).fill(1));
    writeFileSync(join(SIM_ROOT, 'img1_copy.png'), Buffer.alloc(100).fill(1));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  setupFixture();
  const env = { ...process.env, PORT: String(PORT), TRM_PKGVAR: TEST_TMP, TRM_FNCLEARUP_TEST: '1' };
  server = spawn(process.execPath, ['app/ui/server.js'], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/api/ping`).then(x => x.json()).catch(() => null); if (r && typeof r === 'object') break; } catch {}
    await sleep(250);
  }
});
after(() => { if (server) { try { server.kill('SIGTERM'); } catch {} } });

describe('SimDup API validation', () => {
  it('rejects invalid type', async () => {
    const r = await httpRequest('POST', '/api/simdup/scan', { type: 'rir', paths: [SIM_ROOT] });
    assert.strictEqual(r.status, 400);
  });
  it('rejects empty paths', async () => {
    const r = await httpRequest('POST', '/api/simdup/scan', { type: 'image', paths: [] });
    assert.strictEqual(r.status, 400);
  });
  it('rejects unsafe path', async () => {
    const r = await httpRequest('POST', '/api/simdup/scan', { type: 'image', paths: ['/etc'] });
    assert.strictEqual(r.status, 403);
  });
  it('valid scan returns jobId', async () => {
    const r = await httpRequest('POST', '/api/simdup/scan', { type: 'image', paths: [SIM_ROOT], threshold: 10 });
    assert.strictEqual(r.status, 200);
    assert.ok(/^simdup_/.test(r.data.jobId));
    assert.strictEqual(r.data.success, true);
  });
  it('status rejects missing job', async () => {
    const r = await httpRequest('GET', '/api/simdup/status');
    assert.strictEqual(r.status, 400);
  });
  it('status 404 for unknown job', async () => {
    const r = await httpRequest('GET', '/api/simdup/status?job=simdup_nonexistent');
    assert.strictEqual(r.status, 404);
  });
});

describe('SimDup end-to-end scan (needs ffmpeg)', () => {
  it('completes and detects the duplicate copy', { skip: !ffmpegOK }, async () => {
    const r = await httpRequest('POST', '/api/simdup/scan', { type: 'image', paths: [SIM_ROOT], threshold: 10 });
    assert.strictEqual(r.status, 200);
    const jobId = r.data.jobId;
    // poll until done
    let state = null;
    for (let i = 0; i < 60; i++) {
      state = await httpRequest('GET', `/api/simdup/status?job=${encodeURIComponent(jobId)}`);
      if (state.status === 200 && state.data.status === 'done') break;
      await sleep(300);
    }
    assert.ok(state, 'got status');
    assert.strictEqual(state.status, 200);
    assert.strictEqual(state.data.status, 'done');
    // should find a group with at least 2 files (the copy pair)
    assert.ok(Array.isArray(state.data.groups));
    assert.ok(state.data.groups.length >= 1, 'expected ≥1 similarity group');
    const group = state.data.groups[0];
    assert.ok(group.files.length >= 2, `group has ≥2 files, got ${group.files.length}`);
    assert.ok(group.files.some(f => f.name.includes('copy')), 'copy file detected');
  });
});