/**
 * FnClearup Node.js — TDD Test Suite
 * Tests all API endpoints by starting the server and making HTTP requests.
 * Usage: node tests/test_api.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 47939; // Use different port to avoid conflict with running instance
const BASE = `http://127.0.0.1:${PORT}`;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'ui');
const TEST_TMP = '/tmp/fnclearup_test';

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { method, hostname: url.hostname, port: PORT, path: url.pathname + url.search, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
    }
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

// Setup test data
function setupTestData() {
  if (!existsSync(TEST_TMP)) mkdirSync(TEST_TMP, { recursive: true });
  // Create some temp files
  const oldDir = join(TEST_TMP, 'old');
  if (!existsSync(oldDir)) mkdirSync(oldDir);
  writeFileSync(join(TEST_TMP, 'test1.txt'), 'hello');
  writeFileSync(join(TEST_TMP, 'test2.txt'), 'world');
  writeFileSync(join(oldDir, 'old_file.txt'), 'old data');
}

function cleanupTestData() {
  // Best-effort recursive cleanup of TEST_TMP (incl. subdirs dup_test, exports, data)
  try { rmSync(TEST_TMP, { recursive: true, force: true }); } catch {}
}

// Start server
before(async () => {
  setupTestData();
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(PORT), TRM_PKGVAR: TEST_TMP, TRM_FNCLEARUP_TEST: '1' };
    server = spawn(process.execPath, ['app/ui/server.js'], { cwd: join(dirname(fileURLToPath(import.meta.url)), '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let started = false;
    const timeout = setTimeout(() => { if (!started) reject(new Error('Server start timeout')); }, 10000);
    server.stdout.on('data', (data) => {
      if (!started && data.toString().includes('listening')) {
        started = true;
        clearTimeout(timeout);
        setTimeout(resolve, 500); // Wait a bit for server to be ready
      }
    });
    server.stderr.on('data', (data) => {
      console.error('Server stderr:', data.toString());
    });
    server.on('error', (err) => { clearTimeout(timeout); reject(err); });
    // Fallback if server starts too fast
    setTimeout(() => {
      if (!started) { started = true; clearTimeout(timeout); setTimeout(resolve, 1000); }
    }, 2000);
  });
});

after(() => {
  cleanupTestData();
  if (server) server.kill('SIGTERM');
});

// ══════════════════════════════════════
// Tests
// ══════════════════════════════════════

describe('API: Version & Ping', () => {
  it('GET /api/version returns version', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/version');
    assert.strictEqual(status, 200);
    assert.ok(data.version);
    assert.strictEqual(data.success, true);
  });

  it('GET /api/ping returns ok', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/ping');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.ok, true);
  });
});

describe('API: App Scan & Delete', () => {
  it('POST /api/scan returns installed + orphan', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/scan');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.installed));
    assert.ok(Array.isArray(data.orphan));
  });

  it('POST /api/delete with empty paths returns zero deletes', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/delete', { paths: [] });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 0);
  });
});

describe('API: Mounts & Vol02', () => {
  it('GET /api/mounts returns mounts array', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/mounts');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.mounts));
  });

  it('GET /api/vol02 returns dirs + mounted points', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/vol02');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.vol02_dirs));
    assert.ok(Array.isArray(data.mounted_points));
  });
});

describe('API: Docker', () => {
  it('GET /api/volumes returns volume info', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/volumes');
    assert.strictEqual(status, 200);
    assert.ok(data.volumes);
    assert.ok(Array.isArray(data.volumes.all));
  });

  it('GET /api/networks returns network info', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/networks');
    assert.strictEqual(status, 200);
    assert.ok(data.networks);
    assert.ok(Array.isArray(data.networks.all));
  });

  it('GET /api/images returns image info', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/images');
    assert.strictEqual(status, 200);
    assert.ok(data.images);
    assert.ok(Array.isArray(data.images.all));
  });

  it('POST /api/volumes/delete with empty array returns zero', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/volumes/delete', { volumes: [] });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 0);
  });

  it('POST /api/networks/delete with empty array returns zero', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/networks/delete', { networks: [] });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 0);
  });

  it('POST /api/images/delete with empty array returns zero', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/images/delete', { images: [] });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 0);
  });
});

describe('API: System Info', () => {
  it('GET /api/system returns disk, memory, docker info', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/system');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(data.data);
    assert.ok(data.data.disk !== undefined);
    assert.ok(data.data.memory !== undefined);
    assert.ok(data.data.docker !== undefined);
  });
});

describe('API: Temp Files', () => {
  it('GET /api/temp/scan returns temp file list', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/temp/scan');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.files));
    assert.ok(Array.isArray(data.dirs));
    assert.ok(typeof data.total_size === 'number');
  });

  it('POST /api/temp/delete with empty paths returns zero', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/temp/delete', { paths: [] });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 0);
  });
});

describe('API: Static Files', () => {
  it('GET /app/fnclearup/ returns index.html', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/');
    assert.strictEqual(status, 200);
    assert.ok(typeof data === 'string');
    assert.ok(data.includes('<html'));
  });

  it('GET /app/fnclearup/main.js returns JS', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/main.js');
    assert.strictEqual(status, 200);
    assert.ok(typeof data === 'string');
  });

  it('GET /app/fnclearup/styles/style.css returns CSS', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/styles/style.css');
    assert.strictEqual(status, 200);
    assert.ok(typeof data === 'string');
  });
});

describe('API: Duplicate File Scan', () => {
  const dupTestDir = join(TEST_TMP, 'dup_test');

  before(() => {
    if (!existsSync(dupTestDir)) mkdirSync(dupTestDir, { recursive: true });
    writeFileSync(join(dupTestDir, 'a.txt'), 'content a');
    writeFileSync(join(dupTestDir, 'a_dup.txt'), 'content a');
    writeFileSync(join(dupTestDir, 'b.txt'), 'content b');
  });

  after(() => {
    try { unlinkSync(join(dupTestDir, 'a.txt')); } catch {}
    try { unlinkSync(join(dupTestDir, 'a_dup.txt')); } catch {}
    try { unlinkSync(join(dupTestDir, 'b.txt')); } catch {}
    try { rmdirSync(dupTestDir); } catch {}
  });

  it('POST /api/dup/scan starts scan', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', path: dupTestDir });
    assert.strictEqual(status, 200);
    assert.ok(data.jobId);
    assert.strictEqual(data.status, 'started');
  });

  it('POST /api/dup/scan with invalid path returns error', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', path: '/nonexistent' });
    assert.strictEqual(status, 400);
    assert.ok(data.error);
  });

  it('POST /api/dup/scan with invalid type returns error', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'invalid', path: dupTestDir });
    assert.strictEqual(status, 400);
  });

  it('GET /api/dup/status returns progress or complete', async () => {
    // Start a scan first
    const scanRes = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', path: dupTestDir });
    const jobId = scanRes.data.jobId;

    // Poll for completion (up to 10s)
    let status = 'counting';
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const res = await httpRequest('GET', `/app/fnclearup/api/dup/status?jobId=${jobId}`);
      if (res.status === 200 && res.data.status === 'complete') {
        status = 'complete';
        assert.ok(res.data.stats.totalFiles >= 2);
        assert.ok(Array.isArray(res.data.duplicates));
        if (res.data.duplicates.length > 0) {
          assert.ok(res.data.duplicates[0].files.length >= 2);
          assert.ok(res.data.duplicates[0].wastedHuman);
        }
        break;
      }
    }
    assert.strictEqual(status, 'complete', 'Scan did not complete in time');
  });

  it('GET /api/dup/status with invalid jobId returns 404', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/dup/status?jobId=nonexistent');
    assert.strictEqual(status, 404);
  });

  it('GET /api/jobs returns job list', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/jobs');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data));
  });

  it('POST /api/dup/pause with invalid jobId returns error gracefully', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/pause', { jobId: 'nonexistent' });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.paused, false);
  });

  it('POST /api/dup/resume with invalid jobId returns error gracefully', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/resume', { jobId: 'nonexistent' });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.resumed, false);
  });

  it('POST /api/dup/stop with invalid jobId returns error gracefully', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/stop', { jobId: 'nonexistent' });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.stopped, false);
  });

  it('POST /api/dup/delete returns deleted count', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/delete', { files: [], mode: 'trash' });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.deleted, 0);
  });

  it('POST /api/dup/export with valid jobId exports reports', async () => {
    const scanRes = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', path: dupTestDir });
    const jobId = scanRes.data.jobId;
    // Wait for completion
    let complete = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const res = await httpRequest('GET', `/app/fnclearup/api/dup/status?jobId=${jobId}`);
      if (res.data.status === 'complete') { complete = true; break; }
    }
    if (complete) {
      const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/export', { jobId, outputDir: join(TEST_TMP, 'exports') });
      assert.strictEqual(status, 200);
      assert.ok(data.exported > 0);
    }
  });

  it('POST /api/dup/export without jobId returns error', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/export', {});
    assert.strictEqual(status, 400);
  });
});

describe('API: Empty Dir Scan', () => {
  const emptyTestDir = join(TEST_TMP, 'empty_test');

  before(() => {
    if (!existsSync(emptyTestDir)) mkdirSync(emptyTestDir, { recursive: true });
    mkdirSync(join(emptyTestDir, 'empty_a'), { recursive: true });
    mkdirSync(join(emptyTestDir, 'empty_b'), { recursive: true });
    writeFileSync(join(emptyTestDir, 'has_file.txt'), 'data');
    mkdirSync(join(emptyTestDir, 'has_file_dir'), { recursive: true });
  });

  it('POST /api/empty_dir/scan starts scan and completes', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/empty_dir/scan', { path: emptyTestDir });
    assert.strictEqual(status, 200);
    assert.ok(data.jobId);
    // Poll for completion
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      const res = await httpRequest('GET', `/app/fnclearup/api/empty_dir/status?jobId=${data.jobId}`);
      if (res.data && res.data.status === 'complete') {
        assert.ok(res.data.total >= 2, 'should find at least 2 empty dirs');
        return;
      }
    }
    assert.fail('empty_dir scan did not complete in time');
  });

  it('POST /api/empty_dir/scan reports currentDir during scan', async () => {
    // Create a wider tree so the scan has at least 5 dirs and runs long enough
    // to observe the first progress update (which now fires at visitCount === 1).
    const wideDir = join(TEST_TMP, 'empty_wide');
    if (!existsSync(wideDir)) mkdirSync(wideDir, { recursive: true });
    for (let i = 0; i < 20; i++) mkdirSync(join(wideDir, `d${i}`), { recursive: true });

    const { data } = await httpRequest('POST', '/app/fnclearup/api/empty_dir/scan', { path: wideDir });
    assert.ok(data.jobId);
    // Poll quickly — we want to catch a "scanning" state with currentDir set
    let sawCurrentDir = null;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 20));
      const res = await httpRequest('GET', `/app/fnclearup/api/empty_dir/status?jobId=${data.jobId}`);
      if (res.data && res.data.status === 'scanning' && res.data.currentDir) {
        sawCurrentDir = res.data.currentDir;
        break;
      }
      if (res.data && res.data.status === 'complete') {
        // Scan was too fast — but we can still verify the final state had a currentDir
        sawCurrentDir = res.data.currentDir;
        break;
      }
    }
    assert.ok(sawCurrentDir, 'should have observed a currentDir at some point (scanning or complete)');
    assert.ok(sawCurrentDir.startsWith(wideDir), `currentDir should be under wideDir, got: ${sawCurrentDir}`);
  });

  it('POST /api/empty_dir/scan with /etc path is rejected (whitelist)', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/empty_dir/scan', { path: '/etc' });
    assert.strictEqual(status, 403);
    assert.ok(data.error);
  });

  it('POST /api/empty_dir/delete with empty paths returns zero', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/empty_dir/delete', { paths: [] });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 0);
  });
});

describe('API: Path Whitelist (Security)', () => {
  it('POST /api/dup/scan with /etc is rejected', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', path: '/etc' });
    assert.strictEqual(status, 403);
    assert.ok(data.error);
  });

  it('POST /api/dup/delete with /etc/passwd is rejected (whitelist)', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/delete', { files: ['/etc/passwd'], mode: 'permanent' });
    assert.strictEqual(status, 200);
    // returns deleted: 0 because path was filtered out
    assert.strictEqual(data.deleted, 0);
    assert.ok(data.skipped >= 1, 'should report skipped paths');
  });

  it('POST /api/temp/delete with /etc/passwd is rejected (whitelist)', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/temp/delete', { paths: ['/etc/passwd'], mode: 'permanent' });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 0);
    assert.ok(data.skipped >= 1);
  });

  it('GET /api/browse with /etc is rejected (whitelist)', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/browse?path=/etc');
    assert.strictEqual(status, 403);
    assert.ok(data.error);
  });
  it('GET /api/browse with /vol2 is allowed (the dir itself, not just subdirs)', async () => {
    // Reproduces fnOS UI bug: browse modal could not list /vol2 because isSafePath
    // only matched "/volN/" prefix, not the bare "/volN" dir.
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/browse?path=/vol2');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.entries), 'entries should be an array');
  });
  it('GET /api/browse with /vol2/1000 is allowed (subdir)', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/browse?path=/vol2/1000');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.entries));
  });
  it('GET /api/browse with /vol20 is rejected (not in /vol1-10)', async () => {
    const { status } = await httpRequest('GET', '/app/fnclearup/api/browse?path=/vol20');
    assert.strictEqual(status, 403);
  });
  it('GET /api/browse with /vol2/../etc is rejected (path traversal)', async () => {
    // resolve('/vol2/../etc') === '/etc', so this must be rejected
    const { status } = await httpRequest('GET', '/app/fnclearup/api/browse?path=/vol2/../etc');
    assert.strictEqual(status, 403);
  });
  it('GET /api/browse with /vol02 is allowed (fnOS netdisk mount root)', async () => {
    // /vol02 is fnOS's real netdisk mount root, NOT /vol2. Netdisk residuals like
    // /vol02/1000-1-HEXHASH/... must be browsable.
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/browse?path=/vol02');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.entries));
  });
  it('GET /api/browse with /vol02/1000-1-HEXHASH is allowed (netdisk residual)', async () => {
    // Use whatever subdir actually exists in dev (may differ from production)
    const scan = await httpRequest('GET', '/app/fnclearup/api/browse?path=/vol02');
    if (!scan.data.entries || scan.data.entries.length === 0) return; // skip on dev
    const subdir = scan.data.entries[0].name;
    const { status, data } = await httpRequest('GET', `/app/fnclearup/api/browse?path=/vol02/${subdir}`);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.entries));
  });
});

describe('API: 404 Handling', () => {
  it('GET /api/nonexistent returns 404', async () => {
    const { status } = await httpRequest('GET', '/app/fnclearup/api/nonexistent');
    assert.strictEqual(status, 404);
  });
});

describe('API: System Cache Cleaning (sysclean)', () => {
  before(async () => {
    // Create a fake cache dir under process.env.HOME/.cache/fakeapp — the SCAN_TARGETS
    // list uses HOME, so this is where the scan will discover it.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const fakeCache = path.join(process.env.HOME, '.cache', 'fakeapp_test_' + process.pid);
    fs.mkdirSync(fakeCache, { recursive: true });
    fs.writeFileSync(path.join(fakeCache, 'data.bin'), Buffer.alloc(1024 * 1024)); // 1MB
  });

  it('GET /api/sysclean/scan returns items array with sizes', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.items), 'items should be array');
    assert.ok(data.count >= 0);
    assert.ok(typeof data.total_size === 'number');
    assert.ok(typeof data.total_size_str === 'string');
    // Each item has the required fields
    for (const it of data.items) {
      assert.ok(it.id, 'item must have id');
      assert.ok(it.path, 'item must have path');
      assert.ok(typeof it.size === 'number', 'size must be number');
      assert.ok(['low', 'medium', 'high', 'dangerous'].includes(it.risk), 'risk must be valid');
      assert.ok(typeof it.recommended === 'boolean', 'recommended must be bool');
    }
  });

  it('GET /api/sysclean/scan includes the test fixture cache', async () => {
    // /home/admin/.cache/fakeapp_test_<pid> should be discovered as a "其它 ~/.cache" item
    const { data } = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
    const found = data.items.find(it => it.path.includes('fakeapp_test_' + process.pid));
    assert.ok(found, 'fakeapp_test cache should be in scan results');
    assert.ok(found.size >= 1024 * 1024, 'fakeapp_test should be at least 1MB');
  });

  it('POST /api/sysclean/clean rejects unknown ids', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/sysclean/clean', { ids: ['unknown_id', 'also_unknown'] });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total, 0);
    assert.strictEqual(data.failures, 2);
    assert.ok(data.failed[0].reason, 'failed item should have reason');
  });

  it('POST /api/sysclean/clean rejects path-traversal ids', async () => {
    const { data } = await httpRequest('POST', '/app/fnclearup/api/sysclean/clean', { ids: ['../../etc', '..', '/etc'] });
    assert.strictEqual(data.total, 0);
    // All should fail with "unknown id"
    for (const f of data.failed) {
      assert.strictEqual(f.reason, 'unknown id');
    }
  });

  it('POST /api/sysclean/clean actually deletes the targeted cache', async () => {
    const fs = await import('node:fs');
    // Find the fakeapp_test item id
    const scan = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
    const item = scan.data.items.find(it => it.path.includes('fakeapp_test_' + process.pid));
    assert.ok(item, 'fakeapp_test should be in scan results');

    // Verify it exists
    assert.ok(fs.existsSync(item.path), 'fakeapp_test dir should exist before delete');

    // Delete it
    const { data } = await httpRequest('POST', '/app/fnclearup/api/sysclean/clean', { ids: [item.id] });
    assert.strictEqual(data.total, 1, 'should delete 1 item');
    assert.strictEqual(data.failures, 0);

    // Verify it's gone
    assert.ok(!fs.existsSync(item.path), 'fakeapp_test dir should be deleted');
  });

  it('POST /api/sysclean/clean with backup:true writes a manifest file', async () => {
    const fs = await import('node:fs');
    // Re-create fixture
    const path = await import('node:path');
    const cacheDir = path.join(process.env.HOME, '.cache', 'fakeapp_test_backup_' + process.pid);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'data.bin'), Buffer.alloc(512 * 1024));

    // Find it
    const scan = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
    const item = scan.data.items.find(it => it.path === cacheDir);
    assert.ok(item, 'fakeapp_test_backup fixture should be in scan results');

    // Delete with backup
    const { data } = await httpRequest('POST', '/app/fnclearup/api/sysclean/clean', {
      ids: [item.id],
      backup: true,
    });
    assert.strictEqual(data.failures, 0, 'delete should succeed');
    assert.ok(data.backup_path, 'backup_path should be returned');
    assert.ok(data.backup_path.includes('fnclearup_pre_clean_manifest_'), 'backup file name should match pattern');
    assert.ok(fs.existsSync(data.backup_path), 'manifest file should be created on disk');

    // Verify manifest content
    const manifest = JSON.parse(fs.readFileSync(data.backup_path, 'utf8'));
    assert.strictEqual(manifest.tool, 'fnclearup sysclean');
    assert.ok(Array.isArray(manifest.items));
    assert.ok(manifest.items.find(it => it.path === cacheDir), 'manifest should contain deleted item path');
    assert.ok(manifest.items.find(it => it.path === cacheDir).size >= 512 * 1024);

    // Verify the cache itself is gone
    assert.ok(!fs.existsSync(cacheDir), 'cache dir should be deleted after clean');
  });

  it('POST /api/sysclean/clean with backup:false does NOT write a manifest', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cacheDir = path.join(process.env.HOME, '.cache', 'fakeapp_test_nobackup_' + process.pid);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'data.bin'), Buffer.alloc(256 * 1024));

    const scan = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
    const item = scan.data.items.find(it => it.path === cacheDir);
    assert.ok(item, 'nobackup fixture should be in scan results');

    // Count manifests before (ensure base dir exists for the readdir)
    const manifestsBase = '/tmp/fnclearup_test/data/manifests';
    if (!fs.existsSync(manifestsBase)) fs.mkdirSync(manifestsBase, { recursive: true });
    const before = fs.readdirSync(manifestsBase).filter(f => f.startsWith('fnclearup_pre_clean_manifest_')).length;

    const { data } = await httpRequest('POST', '/app/fnclearup/api/sysclean/clean', {
      ids: [item.id],
      backup: false,
    });
    assert.strictEqual(data.failures, 0);
    assert.strictEqual(data.backup_path, null, 'backup_path should be null when backup:false');

    const after = fs.readdirSync(manifestsBase).filter(f => f.startsWith('fnclearup_pre_clean_manifest_')).length;
    assert.strictEqual(after, before, 'no new manifest should be created');
  });

  it('GET /api/sysclean/manifests lists past manifests', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/sysclean/manifests');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.manifests), 'manifests should be array');
    assert.ok(data.count >= 1, 'should have at least 1 manifest from previous test');
    assert.ok(data.base_dir, 'should report base_dir');
    // Verify sorted by mtime desc
    for (let i = 1; i < data.manifests.length; i++) {
      assert.ok(data.manifests[i-1].mtime >= data.manifests[i].mtime, 'should be sorted desc');
    }
  });

  it('GET /api/sysclean/manifest?path=... returns manifest content', async () => {
    // Get a manifest path
    const list = await httpRequest('GET', '/app/fnclearup/api/sysclean/manifests');
    const first = list.data.manifests[0];
    assert.ok(first, 'should have at least one manifest');

    const { status, data } = await httpRequest('GET', `/app/fnclearup/api/sysclean/manifest?path=${encodeURIComponent(first.path)}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.tool, 'fnclearup sysclean');
    assert.ok(Array.isArray(data.items));
  });

  it('GET /api/sysclean/manifest rejects path-traversal', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/sysclean/manifest?path=' + encodeURIComponent('/etc/passwd'));
    assert.strictEqual(status, 403);
    assert.ok(data.error.includes('not allowed'));
  });

  it('GET /api/sysclean/manifest rejects missing path', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/sysclean/manifest');
    assert.strictEqual(status, 400);
    assert.ok(data.error.includes('missing'));
  });

  it('GET /api/sysclean/manifests reports base_dir under TRM_PKGVAR/data/manifests', async () => {
    // Server was started with TRM_PKGVAR=/tmp/fnclearup_test, so base_dir should be
    // /tmp/fnclearup_test/data/manifests (test mode) — i.e. always under data/ subdir
    // of PKGVAR, NOT under the user's vol trash.
    const { data } = await httpRequest('GET', '/app/fnclearup/api/sysclean/manifests');
    assert.ok(data.base_dir, 'should report base_dir');
    assert.ok(data.base_dir.endsWith('/data/manifests'), `base_dir should end with /data/manifests, got: ${data.base_dir}`);
    assert.ok(data.base_dir.includes('manifests'), 'base_dir should contain manifests segment');
  });

  it('POST /api/sysclean/clean backup:true writes under data/manifests subdir', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cacheDir = path.join(process.env.HOME, '.cache', 'fakeapp_test_path_' + process.pid);
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'data.bin'), Buffer.alloc(128 * 1024));

    const scan = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
    const item = scan.data.items.find(it => it.path === cacheDir);
    assert.ok(item, 'path test fixture should be in scan results');

    const { data } = await httpRequest('POST', '/app/fnclearup/api/sysclean/clean', {
      ids: [item.id],
      backup: true,
    });
    assert.strictEqual(data.failures, 0);
    assert.ok(data.backup_path, 'should return backup_path');
    // The path must include the data/manifests segment — not legacy /vol*/UID/.@#local
    assert.ok(data.backup_path.includes('/data/manifests/'),
      `backup_path should be under data/manifests, got: ${data.backup_path}`);
    assert.ok(fs.existsSync(data.backup_path), 'manifest file should exist on disk');
  });
});

// ══════════════════════════════
// Frontend HTML/JS contract
// ══════════════════════════════
describe('Frontend: Modal onclick functions exist in main.js', () => {
  it('all modal confirm buttons reference exported functions', async () => {
    const fs = await import('node:fs');
    const html = fs.readFileSync(join(UI_DIR, 'index.html'), 'utf-8');
    const main = fs.readFileSync(join(UI_DIR, 'main.js'), 'utf-8');

    // Extract every inline onclick="fnName(...)" — skip raw expression handlers like if(...)/this.x/event.x
    const onclickRegex = /onclick="([a-zA-Z_$][\w$]*)\s*\([^"]*\)"/g;
    const STATEMENT_KEYWORDS = new Set(['if','for','while','return','this','event','document','window']);
    const fns = new Set();
    let m;
    while ((m = onclickRegex.exec(html)) !== null) {
      if (STATEMENT_KEYWORDS.has(m[1])) continue;
      fns.add(m[1]);
    }

    // For each onclick fn, assert it appears in the exports block OR is defined before use
    // (doXxx is the executed function; confirmXxx is the entry that opens the modal)
    for (const fn of fns) {
      // Allow closeModal/hideXxx which are simple toggles; just check they are defined
      assert.ok(main.includes(`function ${fn}`) || main.includes(`${fn}:`), `function ${fn} not defined in main.js`);
      // And that the function is reachable: either in exports block, or it's an external API like closeModal
      // exports block items are comma-separated across multiple lines — check the substring exists as a list item
      const exportsBlock = main.split('const exports')[1] || '';
      const isExported = new RegExp(`(?:^|\\n|,\\s*|\\s)${fn}\\s*[,}]`).test(exportsBlock);
      const isBuiltin = ['closeModal', 'showSponsorModal', 'showSponsorImgFull'].includes(fn);
      assert.ok(isExported || isBuiltin, `function ${fn} is not exported to window and not a builtin`);
    }
  });
});
