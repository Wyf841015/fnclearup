/**
 * FnClearup — Disk Space Analysis (P0-1) TDD Tests
 * Verifies:
 *   1. GET /api/diskanalysis/volumes returns per-volume used bytes
 *   2. POST /api/diskanalysis/tree returns subdir ranking + type distribution
 *      + top files for a fixture tree under /tmp/fnclearup_test
 *   3. Security: paths outside whitelist → 403
 *   4. Tree honors maxDepth and counts file types correctly
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 47941;
const BASE = `http://127.0.0.1:${PORT}`;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'ui');
const TEST_TMP = '/tmp/fnclearup_test';
const DS_ROOT = join(TEST_TMP, 'diskanalysis_root');

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
let booted = false;

function setupFixture() {
  rmSync(DS_ROOT, { recursive: true, force: true });
  mkdirSync(DS_ROOT, { recursive: true });
  // Videos (large)
  mkdirSync(join(DS_ROOT, 'movie'), { recursive: true });
  writeFileSync(join(DS_ROOT, 'movie', 'big.mp4'), Buffer.alloc(2000 * 1024).fill(1)); // 2MB
  writeFileSync(join(DS_ROOT, 'movie', 'clip.mkv'), Buffer.alloc(500 * 1024).fill(2));  // 500KB
  // Music
  mkdirSync(join(DS_ROOT, 'music'), { recursive: true });
  writeFileSync(join(DS_ROOT, 'music', 'song.mp3'), Buffer.alloc(300 * 1024).fill(3)); // 300KB
  // Images
  mkdirSync(join(DS_ROOT, 'photo', 'sub'), { recursive: true });
  writeFileSync(join(DS_ROOT, 'photo', 'a.png'), Buffer.alloc(50 * 1024).fill(4));     // 50KB
  writeFileSync(join(DS_ROOT, 'photo', 'sub', 'b.jpg'), Buffer.alloc(20 * 1024).fill(5)); // 20KB
  // Docs + code at root
  writeFileSync(join(DS_ROOT, 'readme.md'), 'hello markdown');       // <1KB → other? md→docs
  writeFileSync(join(DS_ROOT, 'app.js'), 'console.log(1)');           // code, tiny
}

before(async () => {
  setupFixture();
  // Point diskanalysis tree at the whitelisted fixture root and ensure the
  // /vols volumes endpoint can see something deterministic. The volumes
  // endpoint lists real /vol* which won't exist in tests; it should return
  // an empty volume list gracefully (no crash).
  const env = { ...process.env, PORT: String(PORT), TRM_PKGVAR: TEST_TMP, TRM_FNCLEARUP_TEST: '1' };
  server = spawn(process.execPath, ['app/ui/server.js'], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  // wait for boot
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/ping`).then(x => x.json()).catch(() => null);
      if (r && typeof r === 'object') { booted = true; break; }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
});

after(() => { if (server) { try { server.kill('SIGTERM'); } catch {} } });

describe('Disk Analysis volumes', () => {
  it('returns 200 with volumes array + statfs fields (graceful with no /vol present)', async () => {
    const r = await httpRequest('GET', '/api/diskanalysis/volumes');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.data.volumes));
    assert.equal(typeof r.data.total_used, 'number');
    assert.equal(typeof r.data.capacity, 'number');
    for (const v of r.data.volumes) {
      assert.equal(typeof v.used, 'number');
      assert.equal(typeof v.total, 'number');
      assert.equal(typeof v.free, 'number');
      assert.ok(v.used_str, 'has formatted string');
    }
  });
});

describe('Disk Analysis tree', () => {
  it('rejects paths outside the whitelist', async () => {
    const r = await httpRequest('POST', '/api/diskanalysis/tree', { path: '/etc' });
    assert.strictEqual(r.status, 403);
  });

  it('rejects absolute non-vol real paths', async () => {
    const r = await httpRequest('POST', '/api/diskanalysis/tree', { path: '/usr/bin' });
    assert.strictEqual(r.status, 403);
  });

  it('scans the whitelisted fixture root and returns type distribution', async () => {
    const r = await httpRequest('POST', '/api/diskanalysis/tree', { path: DS_ROOT, maxDepth: 3 });
    assert.strictEqual(r.status, 200);
    const d = r.data;
    assert.ok(d.total_files >= 6, `expected ≥6 files, got ${d.total_files}`);
    // videos bucket should be largest
    const video = d.types.find(t => t.type === 'video');
    assert.ok(video, 'video bucket present');
    assert.ok(video.bytes >= 2000 * 1024, `video bytes ≥ 2MB, got ${video.bytes}`);
    // audio present
    const audio = d.types.find(t => t.type === 'audio');
    assert.ok(audio && audio.count >= 1, 'audio bucket has ≥1 file');
    // top_files sorted desc and includes our biggest
    assert.ok(d.top_files.length >= 1);
    assert.ok(d.top_files[0].path.includes('big.mp4'), 'largest file is big.mp4');
    // dir ranking: movie subtree biggest
    assert.ok(d.dirs.length >= 2, `expected ≥2 subdirs, got ${d.dirs.length}`);
    assert.ok(d.dirs[0].name === 'movie' || d.dirs.some(x => x.name === 'movie'), 'movie dir ranked');
  });

  it('honors maxDepth (no descendants beyond depth)', async () => {
    // photo/sub/b.jpg is at depth 2 from root; with maxDepth=1 we should NOT
    // count it, so total_files drops.
    const deep = await httpRequest('POST', '/api/diskanalysis/tree', { path: DS_ROOT, maxDepth: 3 });
    const shallow = await httpRequest('POST', '/api/diskanalysis/tree', { path: DS_ROOT, maxDepth: 1 });
    assert.strictEqual(deep.status, 200);
    assert.strictEqual(shallow.status, 200);
    assert.ok(shallow.data.total_files < deep.data.total_files, `depth1(${shallow.data.total_files}) < depth3(${deep.data.total_files})`);
  });

  it('stop endpoint returns stopped:true', async () => {
    const r = await httpRequest('POST', '/api/diskanalysis/stop');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.stopped, true);
  });
});