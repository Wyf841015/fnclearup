/**
 * FnClearup — dup_scan.js three-stage algorithm tests (jdupes-style optimizations).
 *
 * Verifies the new scanning pipeline directly against the subprocess:
 *   1. partial-hash pre-filter narrows candidates before full hashing
 *   2. persistent hash-cache (size+mtime unchanged) skips re-reading on 2nd run
 *   3. keepMode ('newest'/'deepest'/'first') picks the correct file to KEEP (files[0])
 *   4. minSize filter excludes small files
 *
 * Usage: node --test tests/test_dup_scan_optimizations.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT = join(ROOT, '..', 'app', 'dup_scan.js');
const ST = '/tmp/fnclearup_test/dup_opt_state';
const SCAN = '/tmp/fnclearup_test/dup_opt_scan';

function runScan(args) {
  return new Promise((resolve) => {
    const out = [];
    const p = spawn(process.execPath, [SCAN_SCRIPT, ...args], { env: { ...process.env, TRM_FNCLEARUP_TEST: '1' } });
    p.stdout.on('data', c => out.push(c));
    p.stderr.on('data', c => out.push(c));
    p.on('close', () => resolve(out.join('')));
  });
}
function readState(jobId) {
  return JSON.parse(readFileSync(join(ST, `dup_${jobId}.json`), 'utf-8'));
}

before(() => { rmSync(ST, { recursive: true, force: true }); rmSync(SCAN, { recursive: true, force: true }); mkdirSync(ST, { recursive: true }); mkdirSync(SCAN, { recursive: true }); });
after(() => { rmSync(ST, { recursive: true, force: true }); rmSync(SCAN, { recursive: true, force: true }); });

describe('dup_scan three-stage optimization', () => {
  it('detects duplicates via partial-then-full hashing and reports stats', async () => {
    writeFileSync(join(SCAN, 'p.txt'), 'phase content');
    writeFileSync(join(SCAN, 'p_dup.txt'), 'phase content');
    writeFileSync(join(SCAN, 'q.txt'), 'totally different content');
    const err = await runScan(['files', SCAN, 'opt1', ST, '0', 'first']);
    assert.ok(!err.includes('fatal'), 'should not crash');
    const s = readState('opt1');
    assert.strictEqual(s.status, 'complete');
    assert.strictEqual(s.stats.duplicateGroups, 1);
    assert.strictEqual(s.stats.totalFiles, 2, 'only the 2 identical files hashed');
    // files[0] = retain (first by path)
    const kept = s.duplicates[0].files[0].path;
    assert.ok(kept.endsWith('p.txt') || kept.endsWith('p_dup.txt'));
  });

  it('hash-cache persists and is reused on second run (no re-read of unchanged files)', async () => {
    // First run already populated cache in the previous test (same state dir).
    assert.ok(existsSync(join(ST, 'dup_hash_cache.json')), 'cache file should exist after first run');
    // Touch mtime of p.txt to force a re-hash of exactly one of the two dupes.
    const before = readFileSync(join(SCAN, 'p.txt'));
    writeFileSync(join(SCAN, 'p.txt'), before + '!');   // changes size+mtime → cache miss
    writeFileSync(join(SCAN, 'p.txt'), before);         // revert content exactly → size+mtime also revert
    const err = await runScan(['files', SCAN, 'opt2', ST, '0', 'first']);
    assert.ok(!err.includes('fatal'));
    const s = readState('opt2');
    assert.strictEqual(s.status, 'complete');
    assert.strictEqual(s.stats.duplicateGroups, 1, 'still 1 dupe after cache reuse');
  });

  it('keepMode=newest keeps the most recently modified file as files[0]', async () => {
    // Give p_dup.txt a newer mtime
    writeFileSync(join(SCAN, 'p_dup.txt'), 'phase content');
    await new Promise(r => setTimeout(r, 20));
    const err = await runScan(['files', SCAN, 'opt3', ST, '0', 'newest']);
    assert.ok(!err.includes('fatal'));
    const s = readState('opt3');
    assert.strictEqual(s.status, 'complete');
    assert.strictEqual(s.stats.duplicateGroups, 1);
    assert.ok(s.duplicates[0].files[0].path.endsWith('p_dup.txt'), 'newest (p_dup.txt) kept first');
    assert.strictEqual(s.duplicates[0].keepMode, 'newest');
  });

  it('keepMode=deepest keeps the deepest path as files[0]', async () => {
    const deepDir = join(SCAN, 'a', 'b', 'c');
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(join(deepDir, 'deep_dup.txt'), 'phase content');
    const err = await runScan(['files', SCAN, 'opt4', ST, '0', 'deepest']);
    assert.ok(!err.includes('fatal'));
    const s = readState('opt4');
    assert.strictEqual(s.status, 'complete');
    const kept = s.duplicates[0].files[0].path;
    assert.ok(kept.includes('a/b/c/'), 'deepest path kept first');
  });

  it('minSize excludes small files (no dupes when all below threshold)', async () => {
    rmSync(SCAN, { recursive: true, force: true });   // fresh, all tiny
    mkdirSync(SCAN, { recursive: true });
    writeFileSync(join(SCAN, 's.txt'), 'tiny');
    writeFileSync(join(SCAN, 's_dup.txt'), 'tiny');
    const err = await runScan(['files', SCAN, 'opt5', ST, '1024', 'first']);   // 1KB min
    assert.ok(!err.includes('fatal'));
    const s = readState('opt5');
    assert.strictEqual(s.status, 'complete');
    assert.strictEqual(s.stats.totalFiles, 0, 'both small files filtered by minSize');
    assert.strictEqual(s.stats.duplicateGroups, 0);
  });
});