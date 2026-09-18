/**
 * FnClearup — Abnormal File Detection (P0-3) TDD Tests
 * Verifies:
 *   1. validation: empty paths / unsafe path / missing job / unknown job
 *   2. end-to-end scan on whitelisted fixture detects empty + invalid link
 *      + (if ffmpeg) broken media
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, execSync } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 47943;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_TMP = '/tmp/fnclearup_test';
const BROKEN_ROOT = join(TEST_TMP, 'broken_root');

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
try { execSync('ffmpeg -version', { stdio: 'ignore' }); ffmpegOK = true; } catch {}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setupFixture() {
  rmSync(BROKEN_ROOT, { recursive: true, force: true });
  mkdirSync(BROKEN_ROOT, { recursive: true });
  writeFileSync(join(BROKEN_ROOT, 'empty.txt'), '');                                   // empty file
  writeFileSync(join(BROKEN_ROOT, 'ok.txt'), 'hello');                                 // valid target first
  try { symlinkSync('/nonexistent_target_xyz', join(BROKEN_ROOT, 'dead_link')); } catch {} // invalid link
  symlinkSync(join(BROKEN_ROOT, 'ok.txt'), join(BROKEN_ROOT, 'good_link'));           // valid link
  // corrupt jpg (truncated header-only) + valid png bytes
  writeFileSync(join(BROKEN_ROOT, 'corrupt.jpg'), Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x00,0x00]));
  // valid tiny png
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfab4d', 'hex');
  writeFileSync(join(BROKEN_ROOT, 'good.png'), png);
  // download residue fixtures
  writeFileSync(join(BROKEN_ROOT, 'movie.mp4.part'), Buffer.alloc(2048));
  writeFileSync(join(BROKEN_ROOT, 'setup.exe.crdownload'), Buffer.alloc(1024));
}

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

describe('Broken API validation', () => {
  it('rejects empty paths', async () => {
    const r = await httpRequest('POST', '/api/broken/scan', { paths: [] });
    assert.strictEqual(r.status, 400);
  });
  it('rejects unsafe path', async () => {
    const r = await httpRequest('POST', '/api/broken/scan', { paths: ['/etc'] });
    assert.strictEqual(r.status, 403);
  });
  it('valid scan returns jobId', async () => {
    const r = await httpRequest('POST', '/api/broken/scan', { paths: [BROKEN_ROOT] });
    assert.strictEqual(r.status, 200);
    assert.ok(/^broken_/.test(r.data.jobId));
  });
  it('status rejects missing job', async () => {
    const r = await httpRequest('GET', '/api/broken/status');
    assert.strictEqual(r.status, 400);
  });
});

describe('Broken end-to-end (needs ffmpeg for media)', () => {
  it('detects empty files + invalid symlinks (+ broken media if ffmpeg)', async () => {
    const r = await httpRequest('POST', '/api/broken/scan', { paths: [BROKEN_ROOT], checkBroken: true });
    const jobId = r.data.jobId;
    let state = null;
    for (let i = 0; i < 60; i++) {
      state = await httpRequest('GET', `/api/broken/status?job=${encodeURIComponent(jobId)}`);
      if (state.status === 200 && state.data.status === 'done') break;
      await sleep(300);
    }
    assert.strictEqual(state.status, 200);
    assert.strictEqual(state.data.status, 'done');
    // empty
    assert.ok(state.data.empty.some(f => f.name === 'empty.txt'), 'detects empty.txt');
    // invalid link
    assert.ok(state.data.invalid_links.some(l => l.name === 'dead_link'), 'detects dead_link');
    assert.ok(!state.data.invalid_links.some(l => l.name === 'good_link'), 'valid link not flagged');
    // broken media (if ffmpeg present)
    if (ffmpegOK) {
      assert.ok(state.data.broken.some(f => f.name === 'corrupt.jpg'), 'detects corrupt.jpg');
    }
    // download residue
    assert.ok(state.data.download_residue.some(f => f.name === 'movie.mp4.part'), 'detects .part residue');
    assert.ok(state.data.download_residue.some(f => f.name === 'setup.exe.crdownload'), 'detects .crdownload residue');
  });
});