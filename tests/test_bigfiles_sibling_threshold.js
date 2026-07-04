// Standalone test for bigfiles sibling threshold.
// Runs in a separate node process so TRM_FNCLEARUP_SIBLING_THRESHOLD
// is set before the bigfiles.js module is loaded (avoids ESM caching).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Set low threshold BEFORE any import of bigfiles.js
process.env.TRM_FNCLEARUP_SIBLING_THRESHOLD = '5';
// Also set test mode so isSafePath works
process.env.TRM_FNCLEARUP_TEST = '1';
// Add test root to extra roots to pass SAFE_PREFIXES check
process.env.TRM_BIGFILES_EXTRA_ROOTS = '/tmp/fnclearup_test/sibling_threshold_test';

const TEST_ROOT = '/tmp/fnclearup_test/sibling_threshold_test';
const HUGE_DIR = join(TEST_ROOT, '.huge_sibling');

describe('bigfiles sibling threshold (TRM_FNCLEARUP_SIBLING_THRESHOLD=5)', () => {
  before(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(HUGE_DIR, { recursive: true });
    // Create 7 entries: 1 big file + 6 tiny siblings → entries.length=7 > threshold=5
    writeFileSync(join(HUGE_DIR, 'big_one.bin'), Buffer.alloc(2 * 1024 * 1024));
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(HUGE_DIR, `tiny_${i}.tmp`), 'x');
    }
  });

  after(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('skipped_subtree is true for entries in dirs exceeding sibling threshold', async () => {
    // Dynamic import so SIBLING_THRESHOLD picks up process.env at module load time
    const { handleBigFilesScan } = await import('../app/ui/api/bigfiles.js');

    // Build a fake req/res
    const url = `/api/bigfiles/scan?path=${encodeURIComponent(TEST_ROOT)}&minSize=1&topN=50`;
    const req = { url, method: 'GET', headers: { host: 'localhost' } };
    let statusCode, body;
    const res = {
      writeHead: (code, h) => { statusCode = code; },
      end: (data) => { body = JSON.parse(data); },
    };
    await handleBigFilesScan(req, res);

    assert.strictEqual(statusCode, 200, `scan should return 200, got ${statusCode}`);
    assert.ok(Array.isArray(body.files), 'files should be an array');

    // Find the big_one.bin entry
    const bigFile = body.files.find(f => f.name === 'big_one.bin');
    assert.ok(bigFile, 'big_one.bin should be found in results');
    assert.strictEqual(bigFile.skipped_subtree, true,
      `big_one.bin in a 7-entry dir (threshold=5) should have skipped_subtree=true, got ${bigFile.skipped_subtree}`);

    // Total files should include sibling tiny files too (they stay picked up)
    assert.ok(body.files.length >= 1, 'should find at least 1 file');
    console.log(`✓ sibling_threshold test: ${body.files.length} files, big_one.skipped_subtree=${bigFile.skipped_subtree}`);
  });
});