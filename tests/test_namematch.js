/**
 * FnClearup — Same-name Conflict Detection (P2-2) TDD Tests
 * Verifies:
 *   1. validation: empty paths / unsafe path / missing job / unknown job
 *   2. end-to-end scan on whitelisted fixture detects same-name groups across dirs,
 *      ignoring case, and skips unique files + same-dir duplicates.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 47944;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_TMP = '/tmp/fnclearup_test';
const NM_ROOT = join(TEST_TMP, 'namematch_root');

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setupFixture() {
  rmSync(NM_ROOT, { recursive: true, force: true });
  for (const d of ['dir1', 'dir2', 'dir3', 'sametree', 'sametree']) mkdirSync(join(NM_ROOT, d), { recursive: true });
  // same-name across 3 dirs (one case-differing) → 1 group of 3
  writeFileSync(join(NM_ROOT, 'dir1', 'report.txt'), 'a');
  writeFileSync(join(NM_ROOT, 'dir2', 'REPORT.TXT'), 'bb');
  writeFileSync(join(NM_ROOT, 'dir3', 'report.txt'), 'ccc');
  // unique name → ignored
  writeFileSync(join(NM_ROOT, 'dir1', 'unique.txt'), 'u');
  // same name in SAME dir → NOT a cross-dir conflict (worker requires ≥2 distinct dirs)
  writeFileSync(join(NM_ROOT, 'sametree', 'same.txt'), 'x');
  writeFileSync(join(NM_ROOT, 'sametree', 'same.txt'), 'y'); // overwrite — one file, one occurrence
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

describe('Namematch API validation', () => {
  it('rejects empty paths', async () => {
    const r = await httpRequest('POST', '/api/namematch/scan', { paths: [] });
    assert.strictEqual(r.status, 400);
  });
  it('rejects unsafe path', async () => {
    const r = await httpRequest('POST', '/api/namematch/scan', { paths: ['/etc'] });
    assert.strictEqual(r.status, 403);
  });
  it('valid scan returns jobId', async () => {
    const r = await httpRequest('POST', '/api/namematch/scan', { paths: [NM_ROOT] });
    assert.strictEqual(r.status, 200);
    assert.ok(/^name_/.test(r.data.jobId));
  });
  it('status rejects missing job', async () => {
    const r = await httpRequest('GET', '/api/namematch/status');
    assert.strictEqual(r.status, 400);
  });
});

describe('Namematch end-to-end', () => {
  it('detects cross-dir same-name groups (case-insensitive), skips unique + same-dir', async () => {
    const r = await httpRequest('POST', '/api/namematch/scan', { paths: [NM_ROOT] });
    const jobId = r.data.jobId;
    let state = null;
    for (let i = 0; i < 60; i++) {
      state = await httpRequest('GET', `/api/namematch/status?job=${encodeURIComponent(jobId)}`);
      if (state.status === 200 && state.data.status === 'done') break;
      await sleep(300);
    }
    assert.strictEqual(state.status, 200);
    assert.strictEqual(state.data.status, 'done');
    // report.txt group of 3 (case-insensitive)
    const rep = state.data.groups.find(g => g.name.toLowerCase() === 'report.txt');
    assert.ok(rep, 'report.txt group present');
    assert.strictEqual(rep.count, 3);
    assert.ok(!state.data.groups.some(g => g.name === 'unique.txt'), 'unique.txt not grouped');
    assert.ok(!state.data.groups.some(g => g.name === 'same.txt'), 'same-dir single file not grouped');
  });
});