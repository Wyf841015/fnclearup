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
});

describe('API: 404 Handling', () => {
  it('GET /api/nonexistent returns 404', async () => {
    const { status } = await httpRequest('GET', '/app/fnclearup/api/nonexistent');
    assert.strictEqual(status, 404);
  });
});
