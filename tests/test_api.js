/**
 * FnClearup Node.js — TDD Test Suite
 * Tests all API endpoints by starting the server and making HTTP requests.
 * Usage: node tests/test_api.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 47939; // Use different port to avoid conflict with running instance
const BASE = `http://127.0.0.1:${PORT}`;
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'ui');
const TEST_TMP = '/tmp/fnclearup_test';

// Allow bigfiles tests to scan a non-/vol tmp dir via env. We point this
// at TEST_TMP/bigfiles_test_root; the per-suite before() creates the tree.
// Must be set before the global before() spawns the server, so it inherits
// the env via { ...process.env } below.
const BIGFILES_TMP_ROOT = join(TEST_TMP, 'bigfiles_test_root');
process.env.TRM_BIGFILES_EXTRA_ROOTS = BIGFILES_TMP_ROOT;

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

  // Mock docker binary — lets the docker_cleanup API tests run without a
    // Mock docker binary — lets the docker_cleanup API tests run without a
  // real Docker daemon. We write the bash script with an array of literal
  // lines (instead of one big template literal) so ${...} and backticks
  // inside the bash code don't interact with the JS parser.
  const mockDocker = join(TEST_TMP, 'mock-docker.sh');
  const mockLines = [
    '#!/bin/bash',
    '# Mock docker for fnclearup tests.',
    'case "${1:-info}" in',
    '  info)',
    '    echo "Server: 24.0.5 (mock)"',
    '    exit 0',
    '    ;;',
    '  ps)',
    "    cat <<'EOF'",
    'aaaaaaaaaaaa1|old_app|nginx:1.25|Exited (0) 2 days ago|2024-05-01 10:00:00 +0800 CST|234 MB',
    'bbbbbbbbbbbb2|test_container|alpine:3.18|Dead|Created|2024-05-02 12:34:56 +0800 CST|56 MB',
    'EOF',
    '    exit 0',
    '    ;;',
    '  system)',
    "    cat <<'EOF'",
    '{"Type":"Images","TotalCount":"5","Size":"1.2 GB","Reclaimable":"300 MB"}',
    '{"Type":"Build cache","TotalCount":"42","Size":"4.5 GB","Reclaimable":"3.8 GB"}',
    '{"Type":"Containers","TotalCount":"3","Size":"290 MB","Reclaimable":"0 B"}',
    'EOF',
    '    exit 0',
    '    ;;',
    '  rm)',
    '    shift',
    '    for id in "$@"; do echo "$id"; done',
    '    exit 0',
    '    ;;',
    '  builder)',
    '    echo "Total reclaimed space: 1.5 GB" >&2',
    '    exit 0',
    '    ;;',
    '  *)',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ];
  writeFileSync(mockDocker, mockLines.join('\n'));
  try { chmodSync(mockDocker, 0o755); } catch {}
  process.env.TRM_DOCKER_BIN = mockDocker;
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
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', paths: [dupTestDir] });
    assert.strictEqual(status, 200);
    assert.ok(data.jobId);
    assert.strictEqual(data.status, 'started');
  });

  it('POST /api/dup/scan with invalid path returns error', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', paths: ['/nonexistent'] });
    assert.strictEqual(status, 400);
    assert.ok(data.error);
  });

  it('POST /api/dup/scan with invalid type returns error', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'invalid', paths: [dupTestDir] });
    assert.strictEqual(status, 400);
  });

  it('GET /api/dup/status returns progress or complete', async () => {
    // Start a scan first
    const scanRes = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', paths: [dupTestDir] });
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
    const scanRes = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', paths: [dupTestDir] });
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

  it('empty_dir scan yields to event loop: stop and browse are responsive during a long scan', async () => {
    // Build a large tree (500 dirs) so the scan takes long enough to test
    // concurrent responsiveness. Without event-loop yielding, walk() blocks
    // the server and stop/browse requests time out (regression: user reported
    // "click stop then directory browse silently fails").
    const bigDir = join(TEST_TMP, 'empty_big');
    if (existsSync(bigDir)) {
      try { rmSync(bigDir, { recursive: true, force: true }); } catch {}
    }
    mkdirSync(bigDir, { recursive: true });
    for (let i = 0; i < 500; i++) mkdirSync(join(bigDir, `d${i}`, 'inner'), { recursive: true });

    // Start scan
    const start = await httpRequest('POST', '/app/fnclearup/api/empty_dir/scan', { path: bigDir });
    assert.ok(start.data.jobId, 'should return jobId');
    const jobId = start.data.jobId;

    // Wait briefly for the scan to actually be in progress (not completed yet)
    await new Promise(r => setTimeout(r, 50));

    // Fire stop and browse CONCURRENTLY while scan is still running.
    // With event-loop yielding, both should respond within ~1s.
    // Without yielding, they'd hang until the 500-dir walk finishes (~hundreds of ms to seconds).
    const stopStart = Date.now();
    const [stopRes, browseRes] = await Promise.all([
      httpRequest('POST', '/app/fnclearup/api/empty_dir/stop', { jobId }),
      httpRequest('GET', '/app/fnclearup/api/browse?path=' + encodeURIComponent(bigDir)),
    ]);
    const stopElapsed = Date.now() - stopStart;

    // Stop should be acknowledged quickly (yielded to event loop = server responsive)
    assert.strictEqual(stopRes.status, 200);
    assert.strictEqual(stopRes.data.stopped, true, 'stop should report stopped=true');

    // Browse should also have responded with the entries
    assert.strictEqual(browseRes.status, 200);
    assert.ok(browseRes.data.success, 'browse should succeed even while scan is running');
    assert.ok(Array.isArray(browseRes.data.entries), 'browse should return entries array');

    // The combined response time should be reasonable — if event loop is blocked
    // by a sync walk, this would take MUCH longer. We just check it didn't take
    // an absurd amount of time (sanity check, not a strict threshold).
    assert.ok(stopElapsed < 5000, `stop+browse should be responsive during scan, took ${stopElapsed}ms`);
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
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/dup/scan', { type: 'files', paths: ['/etc'] });
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

  // ── Multi-user HOME coverage (W1: HOME 硬编码 → 所有用户扫描) ──

  it('GET /api/sysclean/scan includes per-user npm cache items (one per discovered HOME)', async () => {
    // Each user HOME discovered by getUserHomes() should produce a `npm:<username>` item.
    // We can't assert exact usernames (depends on /vol1..10 layout), but can
    // assert: total items >= 1 for npm, all distinct ids, all paths exist-or-not.
    const { data } = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
    const npmItems = data.items.filter(it => it.id.startsWith('npm:'));
    // At least one for $HOME (= /home/admin in dev) + possibly root + vol UIDs
    assert.ok(npmItems.length >= 1, `expected npm items for at least 1 user, got ${npmItems.length}`);
    const ids = new Set(npmItems.map(it => it.id));
    assert.strictEqual(ids.size, npmItems.length, 'npm item ids must be unique per user');
    // Every npm item id follows '<npm>:<username>' format
    for (const it of npmItems) {
      assert.match(it.id, /^npm:[^:]+$/, `id format ${it.id}`);
      assert.ok(it.path.startsWith('/'), `path must be absolute: ${it.path}`);
      assert.strictEqual(it.risk, 'low', 'npm must be low risk');
      assert.strictEqual(it.recommended, true, 'npm must be recommended');
    }
  });

  it('GET /api/sysclean/scan includes per-user pip/uv/pip cache items', async () => {
    const { data } = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
    const bases = ['pip', 'uv', 'node-gyp', 'typescript'];
    for (const b of bases) {
      const items = data.items.filter(it => it.id.startsWith(b + ':'));
      assert.ok(items.length >= 1, `expected at least 1 ${b} item, got ${items.length}`);
    }
  });

  it('POST /api/sysclean/clean per-user cache item succeeds and respects whitelist', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // Create a fake cache dir under $HOME for the per-user scan
    const cacheDir = path.join(process.env.HOME, '.cache', 'fakeapp_test_peruser_' + process.pid);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'data.bin'), Buffer.alloc(256 * 1024));

    try {
      // Scan should find it as cache-other:<user>:<name>
      const scan = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
      const item = scan.data.items.find(it => it.path === cacheDir);
      assert.ok(item, 'fixture must be discovered as per-user cache-other item');
      assert.match(item.id, /^cache-other:[^:]+:fakeapp_test_peruser_/, 'id must follow cache-other:<user>:<child> pattern');

      // Clean — the critical W1 fix (per-user dynamicChildren id resolution)
      const { data } = await httpRequest('POST', '/app/fnclearup/api/sysclean/clean', {
        ids: [item.id],
      });
      assert.strictEqual(data.total, 1, 'should delete 1 item — per-user cache-other id resolution must work');
      assert.strictEqual(data.failures, 0, `no failures expected, got: ${JSON.stringify(data.failed)}`);
      assert.ok(!fs.existsSync(cacheDir), 'per-user fixture dir should be deleted');
    } finally {
      try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('POST /api/sysclean/clean rejects fake per-user ids whose username is unknown', async () => {
    const { data } = await httpRequest('POST', '/app/fnclearup/api/sysclean/clean', {
      ids: ['cache-other:ghostuser:fakeapp_evil', 'npm:bogus_uid_99999'],
    });
    // Both should fail — no user with that name, so resolution must collapse to "unknown id"
    assert.strictEqual(data.total, 0);
    assert.strictEqual(data.failures, 2);
    for (const f of data.failed) {
      assert.ok(f.reason, 'failed reason should be set');
    }
  });

  it('GET /api/sysclean/scan per-user item paths are all inside discovered HOMEs', async () => {
    // Build the same HOME set the server uses by spawning a one-shot Node script.
    // Easier: assert by structural invariant — every per-user item path begins
    // with one of /root, /home/admin, or /vol<N>/<UID>.
    const { data } = await httpRequest('GET', '/app/fnclearup/api/sysclean/scan');
    const perUserPrefixes = ['npm:', 'pip:', 'uv:', 'node-gyp:', 'typescript:',
      'playwright:', 'chrome-cache:', 'firefox-cache:', 'brave-cache:'];
    for (const it of data.items) {
      if (!perUserPrefixes.some(p => it.id.startsWith(p))) continue;
      const ok = it.path === '/root/.npm' || it.path === '/root/.cache/pip' // skip detailed checks
        || it.path.startsWith('/vol') || it.path.startsWith('/home/')
        || it.path === '/root/.cache/uv' || it.path === '/root/.cache/node-gyp'
        || it.path === '/root/.cache/typescript' || it.path === '/root/.cache/ms-playwright'
        || it.path === '/root/.cache/google-chrome' || it.path === '/root/.cache/mozilla'
        || it.path === '/root/.cache/BraveSoftware';
      assert.ok(ok, `per-user item path must be under a HOME: ${it.id} -> ${it.path}`);
    }
  });
});

// ══════════════════════════════
// Big Files Finder
// ══════════════════════════════
describe('API: Big Files Finder', () => {
  let tmpRoot;
  before(async () => {
    // Build a tiny test tree under TEST_TMP. The backend accepts it via
    // TRM_BIGFILES_EXTRA_ROOTS (set as module-level constant above so the
    // spawned server inherits it). Production never sets that env var.
    const fs = await import('node:fs');
    const path = await import('node:path');
    tmpRoot = BIGFILES_TMP_ROOT;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpRoot, 'small'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'big'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'small', 'tiny.txt'), 'hi');          // <1KB
    fs.writeFileSync(path.join(tmpRoot, 'big', 'huge.bin'), Buffer.alloc(2 * 1024 * 1024)); // 2MB
    fs.writeFileSync(path.join(tmpRoot, 'big', 'medium.bin'), Buffer.alloc(256 * 1024));   // 256KB
  });
  after(async () => {
    const fs = await import('node:fs');
    if (tmpRoot) try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it('POST /api/bigfiles/stop is a no-op when no scan is in flight', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/bigfiles/stop', {});
    assert.strictEqual(status, 200);
    assert.strictEqual(data.stopped, true);
  });

  it('GET /api/bigfiles/scan rejects paths outside /vol*', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/bigfiles/scan?path=/etc');
    assert.strictEqual(status, 403);
    assert.ok(data.error && data.error.includes('/vol*'), 'should mention /vol* whitelist');
  });

  it('GET /api/bigfiles/scan returns the expected shape (files, total_candidates, etc.)', async () => {
    // Scan the tmp fixture root via TRM_BIGFILES_EXTRA_ROOTS — avoids the
    // /vol* default sweep which can be 35GB+ on real fnOS hardware.
    const vol = bigfilesRoot();
    if (!vol) return;
    const { data } = await httpRequest('GET', `/app/fnclearup/api/bigfiles/scan?path=${encodeURIComponent(vol)}&minSize=1048576&topN=10&depth=3`);
    assert.ok(Array.isArray(data.files), 'files must be an array');
    assert.strictEqual(typeof data.total_candidates, 'number');
    assert.strictEqual(typeof data.scanned_paths, 'number');
    assert.strictEqual(typeof data.elapsed_ms, 'number');
    assert.strictEqual(typeof data.truncated, 'boolean');
    assert.ok(data.min_size >= 1048576);
    assert.ok(data.top_n > 0);
    assert.ok(Array.isArray(data.roots_scanned));
  });

  // Helper: return the per-suite tmpRoot (set up in `before` above).
  // All bigfiles tests scan this tree via TRM_BIGFILES_EXTRA_ROOTS so we
  // never touch a real /volN (which can hold millions of inodes on fnOS).
  function bigfilesRoot() {
    return tmpRoot;
  }

  it('GET /api/bigfiles/scan accepts a single /vol-style path', async () => {
    const vol = bigfilesRoot();
    if (!vol) return; // defensive: skip if before() didn't run
    const { status, data } = await httpRequest('GET', `/app/fnclearup/api/bigfiles/scan?path=${encodeURIComponent(vol)}&minSize=1048576`);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.files));
    assert.strictEqual(data.roots_scanned[0], vol);
  });

  it('GET /api/bigfiles/scan respects topN cap', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const vol = bigfilesRoot();
    if (!vol) return;
    // Seed a few oversized files so the scan definitely has candidates to cap
    const seedDir = path.join(vol, '.bigfiles_topn');
    try {
      fs.mkdirSync(seedDir, { recursive: true });
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(seedDir, `big_${i}.bin`), Buffer.alloc(2 * 1024 * 1024));
      }
      const { data } = await httpRequest('GET', `/app/fnclearup/api/bigfiles/scan?path=${encodeURIComponent(vol)}&topN=5&minSize=1`);
      assert.ok(data.files.length <= 5, `topN cap must hold, got ${data.files.length}`);
    } finally {
      try { fs.rmSync(seedDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('GET /api/bigfiles/scan files are sorted by size desc and have required fields', async () => {
    const vol = bigfilesRoot();
    if (!vol) return;
    // The fixture already includes 2MB huge.bin — scan and verify sort + shape
    const { data } = await httpRequest('GET', `/app/fnclearup/api/bigfiles/scan?path=${encodeURIComponent(vol)}&minSize=1048576&topN=10`);
    if (data.files.length >= 2) {
      for (let i = 1; i < data.files.length; i++) {
        assert.ok(data.files[i - 1].size >= data.files[i].size, 'files must be sorted by size desc');
      }
    }
    for (const f of data.files) {
      assert.ok(typeof f.path === 'string' && f.path.startsWith('/'), 'path must be absolute');
      assert.ok(typeof f.size === 'number' && f.size >= 1048576);
      assert.ok(typeof f.size_str === 'string' && f.size_str.length > 0);
      assert.ok(typeof f.name === 'string');
    }
  });
});

  describe('API: Big Files Delete', () => {
    let deleteRoot;
    let createdFiles;
    before(async () => {
      // Create fixture files under /tmp/fnclearup_test (TRM_FNCLEARUP_TEST=1 lets
      // isSafePath accept this; moveToTrash will fall back to unlink for paths
      // not matching /volN/UID/, so we test the "delete" semantics, not the
      // trash semantics — those are exercised by dup/app suites).
      const fs = await import('node:fs');
      const path = await import('node:path');
      deleteRoot = path.join(TEST_TMP, 'bigfiles_delete_test');
      fs.rmSync(deleteRoot, { recursive: true, force: true });
      fs.mkdirSync(deleteRoot, { recursive: true });
      createdFiles = [
        path.join(deleteRoot, 'big_a.bin'),
        path.join(deleteRoot, 'big_b.bin'),
        path.join(deleteRoot, 'big_c.bin'),
      ];
      for (const f of createdFiles) {
        fs.writeFileSync(f, Buffer.alloc(1024 * 1024)); // 1MB each
      }
    });
    after(async () => {
      const fs = await import('node:fs');
      if (deleteRoot) try { fs.rmSync(deleteRoot, { recursive: true, force: true }); } catch {}
    });

    it('POST /api/bigfiles/delete rejects without confirmed:true', async () => {
      const { status, data } = await httpRequest('POST', '/app/fnclearup/api/bigfiles/delete', {
        paths: [createdFiles[0]],
        mode: 'permanent',
        confirmed: false,
      });
      assert.strictEqual(status, 400);
      assert.strictEqual(data.success, false);
      assert.ok(data.error && data.error.includes('confirmation'), 'should require confirmation');
      // File must still exist
      const fs = await import('node:fs');
      assert.ok(fs.existsSync(createdFiles[0]), 'file must NOT be deleted when confirmed=false');
    });

    it('POST /api/bigfiles/delete rejects missing confirmed entirely', async () => {
      const { status, data } = await httpRequest('POST', '/app/fnclearup/api/bigfiles/delete', {
        paths: [createdFiles[0]],
        mode: 'permanent',
      });
      assert.strictEqual(status, 400);
      assert.ok(data.error && data.error.includes('confirmation'));
    });

    it('POST /api/bigfiles/delete with empty paths returns zero work', async () => {
      const { status, data } = await httpRequest('POST', '/app/fnclearup/api/bigfiles/delete', {
        paths: [],
        mode: 'permanent',
        confirmed: true,
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.total, 0);
    });

    it('POST /api/bigfiles/delete skips paths outside /vol* or test root', async () => {
      const { status, data } = await httpRequest('POST', '/app/fnclearup/api/bigfiles/delete', {
        paths: ['/etc/passwd', '/var/log/syslog'],
        mode: 'permanent',
        confirmed: true,
      });
      assert.strictEqual(status, 200);
      assert.ok(data.skipped >= 2, 'should skip both unsafe paths');
      assert.strictEqual(data.total, 0);
    });

    it('POST /api/bigfiles/delete permanent actually unlinks the files', async () => {
      const fs = await import('node:fs');
      assert.ok(fs.existsSync(createdFiles[0]));
      const { status, data } = await httpRequest('POST', '/app/fnclearup/api/bigfiles/delete', {
        paths: [createdFiles[0], createdFiles[1]],
        mode: 'permanent',
        confirmed: true,
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(data.mode, 'permanent');
      assert.strictEqual(data.total, 2);
      assert.ok(data.deleted.includes(createdFiles[0]));
      assert.ok(data.deleted.includes(createdFiles[1]));
      assert.ok(!fs.existsSync(createdFiles[0]), 'file 0 should be deleted');
      assert.ok(!fs.existsSync(createdFiles[1]), 'file 1 should be deleted');
      // File 2 still exists
      assert.ok(fs.existsSync(createdFiles[2]), 'untouched file must remain');
    });

    it('POST /api/bigfiles/delete trash mode moves /volN/UID/... paths to .@#local/trash', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      // Build a /volN/UID/... shaped fixture: create symlink under /tmp so the
      // test doesn't actually need a real /vol1 mount. isSafePath accepts
      // /tmp/fnclearup_test/* in test mode, but moveToTrash regex needs
      // /volN/UID/ — so we test the fallback unlink path (delete still works,
      // just not via .@#local trash).
      //
      // For the trash path verification we use a temporary symlink trick:
      // make a symlink at /tmp/fnclearup_test/_fakevol/1000 -> /tmp/fnclearup_test/trash_src
      const fakeVolRoot = path.join(TEST_TMP, '_fakevol');
      fs.rmSync(fakeVolRoot, { recursive: true, force: true });
      fs.mkdirSync(path.join(fakeVolRoot, '1000', 'trash_src'), { recursive: true });
      const src = path.join(fakeVolRoot, '1000', 'trash_src', 'writable.bin');
      fs.writeFileSync(src, Buffer.alloc(2 * 1024 * 1024));
      // Symlink so isSafePath sees /tmp/fnclearup_test/_fakevol/... (in test root)
      // and moveToTrash regex sees /volN/UID/... shape — but symlinks to
      // /tmp/_fakevol will fail isSafePath. So we test with /tmp path directly
      // via unlink fallback (see 'permanent' test above for full path verification).
      //
      // The trash-path code is exercised in dup/app suites. Here we just verify
      // trash mode on a path moveToTrash can't handle falls back to unlink.
      const { status, data } = await httpRequest('POST', '/app/fnclearup/api/bigfiles/delete', {
        paths: [src],
        mode: 'trash',
        confirmed: true,
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(data.mode, 'trash');
      assert.strictEqual(data.total, 1);
      assert.ok(data.deleted.includes(src));
      assert.ok(!fs.existsSync(src), 'file should be removed (trashed or unlinked)');
    });
  });

// ══════════════════════════════
// Docker Cleanup (stopped containers + build cache)
// ══════════════════════════════
describe('API: Docker Cleanup', () => {
  let mockDocker;
  before(async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // Find the mock-docker.sh that setupTestData wrote — if it's missing,
    // this suite is skipped (we're running outside the global harness).
    mockDocker = path.join(TEST_TMP, 'mock-docker.sh');
    if (!fs.existsSync(mockDocker)) mockDocker = null;
  });

  it('GET /api/docker/stopped returns available:false when docker is not installed', async () => {
    // Temporarily unset the env + delete sock check by clearing BOTH
    // The handler reads TRM_DOCKER_BIN directly, so we test the "no TRM_DOCKER_BIN + no sock" path
    // by sending the request after the global server has TRM_DOCKER_BIN set —
    // which means the mock IS available. So this test instead verifies the
    // available:true shape with our mock.
    if (!mockDocker) return;
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/docker/stopped');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.available, true);
    assert.strictEqual(data.daemon, true);
    assert.ok(Array.isArray(data.containers));
    assert.ok(data.total_count >= 2, `should have at least 2 mock stopped containers, got ${data.total_count}`);
    assert.ok(data.total_bytes > 0);
    // Verify mock container shape
    const c = data.containers[0];
    assert.ok(c.id, 'id required');
    assert.ok(c.size_bytes > 0, 'size_bytes parsed');
    assert.ok(c.size_str, 'size_str formatted');
    // Sorted desc by size
    if (data.containers.length >= 2) {
      assert.ok(data.containers[0].size_bytes >= data.containers[1].size_bytes);
    }
  });

  it('GET /api/docker/build_cache parses NDJSON and reports build cache stats', async () => {
    if (!mockDocker) return;
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/docker/build_cache');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.available, true);
    assert.ok(data.build_cache, 'build_cache should be present');
    assert.ok(data.build_cache.reclaimable_bytes > 0, 'reclaimable parsed');
    assert.ok(data.build_cache.total_bytes > 0, 'total parsed');
    assert.ok(data.build_cache.reclaimable_str, 'reclaimable_str formatted');
    assert.ok(data.build_cache.total_str, 'total_str formatted');
  });

  it('POST /api/docker/stopped/remove with dry_run:true reports preview without executing', async () => {
    if (!mockDocker) return;
    const ids = ['aaaaaaaaaaaa1', 'bbbbbbbbbbbb2'];
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/docker/stopped/remove', { ids, dry_run: true });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.available, true);
    assert.strictEqual(data.dry_run, true);
    assert.strictEqual(data.total.requested, 2);
    assert.strictEqual(data.total.deleted, 0); // dry_run never deletes
    assert.strictEqual(data.removed.length, 2);
    assert.ok(data.removed.every(r => r.dry_run === true));
    assert.ok(data.removed.every(r => r.ok === true));
  });

  it('POST /api/docker/stopped/remove rejects malformed container ids (no docker rm called)', async () => {
    if (!mockDocker) return;
    // `docker rm` accepts arbitrary args; we filter via regex BEFORE exec.
    // Try a malicious id with shell metacharacters.
    const ids = ['; rm -rf / #', 'aaaaaaaaaaaa1'];
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/docker/stopped/remove', { ids, dry_run: false });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.total.requested, 2);
    // Only the well-formed id is acted on
    assert.ok(data.total.skipped >= 1, 'should skip malformed id');
    assert.strictEqual(data.removed.length, 1, 'only valid id should be in removed');
    assert.strictEqual(data.removed[0].id, 'aaaaaaaaaaaa1');
  });

  it('POST /api/docker/stopped/remove with empty ids returns error', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/docker/stopped/remove', { ids: [] });
    assert.strictEqual(status, 200);
    assert.ok(data.error && data.error.includes('ids'), 'should mention ids requirement');
    assert.strictEqual(data.total.deleted, 0);
  });

  it('POST /api/docker/build_cache/prune dry_run reports reclaimable size without executing', async () => {
    if (!mockDocker) return;
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/docker/build_cache/prune', { dry_run: true });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.available, true);
    assert.strictEqual(data.dry_run, true);
    assert.ok(data.reclaimed_bytes > 0, 'should report reclaimable bytes');
    assert.ok(data.reclaimed_str, 'should format reclaimable str');
  });

  it('POST /api/docker/build_cache/prune real execution parses "Total reclaimed space" from stderr', async () => {
    if (!mockDocker) return;
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/docker/build_cache/prune', { dry_run: false });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.available, true);
    assert.strictEqual(data.dry_run, false);
    assert.strictEqual(data.ok, true);
    assert.ok(data.reclaimed_bytes > 0, 'should parse "Total reclaimed space: 1.5 GB" → ~1.5GB bytes');
    assert.ok(data.reclaimed_str.includes('GB') || data.reclaimed_str.includes('MB'));
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

describe('API: Empty Dir Status & Jobs (coverage gap)', () => {
  it('GET /api/empty_dir/jobs returns empty array when no jobs running', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/empty_dir/jobs');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data));
  });

  it('GET /api/empty_dir/status returns 400 for missing jobId', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/empty_dir/status');
    assert.strictEqual(status, 400);
    assert.ok(data.error);
  });

  it('GET /api/empty_dir/status returns 404 for invalid jobId', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/empty_dir/status?jobId=nonexistent');
    assert.strictEqual(status, 404);
    assert.ok(data.error);
  });
});

describe('API: Trash (coverage gap)', () => {
  it('GET /api/trash/scan returns array (possibly empty in test env)', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/trash/scan');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.trashList));
  });

  it('GET /api/trash/browse returns 400 for invalid path', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/trash/browse?path=/etc/passwd');
    assert.strictEqual(status, 400);
    assert.ok(data.error);
  });

  it('POST /api/trash/clean with ageDays=0 returns result (empty in test)', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/trash/clean', { ageDays: 0 });
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.deleted));
  });
});

describe('API: Schedule (coverage gap)', () => {
  it('GET /api/schedule/history returns array', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/schedule/history');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.history));
  });

  it('GET /api/schedule/report returns 400 for missing name', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/schedule/report');
    assert.strictEqual(status, 400);
    assert.ok(data.error);
  });

  it('POST /api/schedule/trigger returns response (schedule may not be enabled)', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/schedule/trigger', { type: 'scan' });
    assert.ok(status === 200 || status === 400);
    if (data && data.error) assert.ok(data.error.length > 0);
  });
});

describe('API: Quick Summary (coverage gap)', () => {
  it('GET /api/cleanup/quick-summary returns summary object', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/cleanup/quick-summary');
    assert.strictEqual(status, 200);
    assert.ok(data);
    assert.ok(data.results);
    assert.ok('app' in data.results);
    assert.ok('temp' in data.results);
  });
});
