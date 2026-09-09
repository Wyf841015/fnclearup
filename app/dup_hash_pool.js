/**
 * dup_hash_pool.js — Worker thread pool for parallel file hashing.
 * Spawns N workers and distributes file batches to them.
 * Each worker streams-hashes files (256KB-4MB chunks, no memory accumulation).
 *
 * Crash safety: when a worker dies, its pending batch is rejected
 * with an error message (not silently hung). Batches also have a
 * configurable timeout of 10 minutes.
 */
import { Worker } from 'node:worker_threads';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, 'dup_hash_worker.js');

const DEFAULT_POOL_SIZE = 4;
const DEFAULT_BATCH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per batch

export class HashPool {
  constructor(poolSize = DEFAULT_POOL_SIZE, batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS) {
    this.poolSize = poolSize;
    this.batchTimeoutMs = batchTimeoutMs;
    this.workers = [];           // index -> Worker | null
    this.readyWorkers = [];      // Worker[] (free workers)
    this.pendingBatches = [];    // queued batches
    this.batchIdCounter = 0;
    this.activeBatches = new Map();  // batchId -> { resolve, reject, timeout, worker, onProgress, onFileHashProgress }
    this._initialized = false;
    this.initPromise = null;
  }

  _setupWorker(worker, idx) {
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        this.readyWorkers.push(worker);
        // Process queue whenever a worker becomes ready (no need to wait all 4)
        this._processQueue();
        if (!this._initialized) {
          let readyCount = 0;
          for (const w of this.workers) {
            if (w && this.readyWorkers.includes(w)) readyCount++;
          }
          if (readyCount === this.poolSize) {
            this._initialized = true;
          }
        }
      } else if (msg.type === 'result') {
        const batch = this.activeBatches.get(msg.batchId);
        if (batch) {
          clearTimeout(batch.timeout);
          // Filter: keep results that actually produced a value (full hash OR partial
          // header hash, depending on the batch mode). Partial results carry `.partial`,
          // full results carry `.hash`.
          const good = [];
          const wantPartial = batch.mode === 'partial';
          for (const r of msg.results) {
            if (!r) continue;
            if (wantPartial) {
              if (r.partial) good.push(r);
              else if (r.error) console.error('[HashPool] Partial hash error: ' + r.path + ': ' + r.error);
            } else {
              if (r.hash) good.push(r);
              else if (r.error) console.error('[HashPool] File hash error: ' + r.path + ': ' + r.error);
            }
          }
          batch.resolve(good);
          this.activeBatches.delete(msg.batchId);
        }
        this.readyWorkers.push(worker);
        this._processQueue();
      } else if (msg.type === 'partial') {
        // Per-file progress update — forward to callback
        const batch = this.activeBatches.get(msg.batchId);
        if (batch && typeof batch.onProgress === 'function') {
          batch.onProgress(msg.index, msg.total, msg.file, msg.result);
        }
      } else if (msg.type === 'file-hash-progress') {
        // Per-file hash progress (within a file) — forward to callback
        const batch = this.activeBatches.get(msg.batchId);
        if (batch && typeof batch.onFileHashProgress === 'function') {
          batch.onFileHashProgress(msg.file, msg.bytesRead, msg.totalSize);
        }
      } else if (msg.type === 'error') {
        console.error('[HashPool] Worker reported error: ' + msg.error);
        const batch = this.activeBatches.get(msg.batchId);
        if (batch) {
          clearTimeout(batch.timeout);
          batch.reject(new Error('Worker error on batch ' + msg.batchId + ': ' + msg.error));
          this.activeBatches.delete(msg.batchId);
        }
        // Worker is still alive (clean error), return to pool
        this.readyWorkers.push(worker);
        this._processQueue();
      }
    });

    worker.on('error', (err) => {
      console.error('[HashPool] Worker ' + idx + ' crashed: ' + err.message);
      this._rejectWorkerBatches(worker);
      const idx2 = this.workers.indexOf(worker);
      if (idx2 >= 0) {
        this.workers[idx2] = null;
        this._spawnReplacement(idx2);
      }
      const ri = this.readyWorkers.indexOf(worker);
      if (ri >= 0) this.readyWorkers.splice(ri, 1);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error('[HashPool] Worker ' + idx + ' exited with code ' + code);
        this._rejectWorkerBatches(worker);
        const idx2 = this.workers.indexOf(worker);
        if (idx2 >= 0) {
          this.workers[idx2] = null;
          this._spawnReplacement(idx2);
        }
        const ri = this.readyWorkers.indexOf(worker);
        if (ri >= 0) this.readyWorkers.splice(ri, 1);
      }
    });
  }

  _rejectWorkerBatches(worker) {
    for (const [batchId, batch] of this.activeBatches) {
      if (batch.worker === worker) {
        clearTimeout(batch.timeout);
        batch.reject(new Error('Worker crashed while processing batch ' + batchId));
        this.activeBatches.delete(batchId);
      }
    }
  }

  _spawnReplacement(idx) {
    const worker = new Worker(WORKER_SCRIPT);
    this._setupWorker(worker, idx);
    this.workers[idx] = worker;
  }

  _processQueue() {
    while (this.readyWorkers.length > 0 && this.pendingBatches.length > 0) {
      const worker = this.readyWorkers.shift();
      const batch = this.pendingBatches.shift();
      const entry = this.activeBatches.get(batch.batchId);
      if (entry) entry.worker = worker;
      worker.postMessage({ type: 'hash', files: batch.files, batchId: batch.batchId, mode: batch.mode || 'full' });
    }
  }

  /**
   * Hash a batch of files. Returns Promise<HashResult[]>
   * Throws on timeout or worker crash.
   * @param {string[]} files - file paths to hash
   * @param {object} [opts] - { mode: 'full'|'partial', onProgress, onFileHashProgress }
   */
  async hashFiles(files, opts) {
    await this._waitInit();
    const batchId = ++this.batchIdCounter;
    const mode = (opts && opts.mode) || 'full';
    const onProgress = opts && opts.onProgress;
    const onFileHashProgress = opts && opts.onFileHashProgress;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(function() {
        this.activeBatches.delete(batchId);
        this.pendingBatches = this.pendingBatches.filter(b => b.batchId !== batchId);
        reject(new Error('Batch ' + batchId + ' timed out after ' + (this.batchTimeoutMs / 1000) + 's (' + files.length + ' files)'));
      }.bind(this), this.batchTimeoutMs);

      this.activeBatches.set(batchId, { resolve: resolve, reject: reject, timeout: timeout, worker: null, mode: mode, onProgress: onProgress || null, onFileHashProgress: onFileHashProgress || null });
      this.pendingBatches.push({ batchId: batchId, files: files, mode: mode });
      this._processQueue();
    });
  }

  async _waitInit() {
    if (this._initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve) => {
      // Workers created lazily on first hash request
      for (let i = 0; i < this.poolSize; i++) {
        const worker = new Worker(WORKER_SCRIPT);
        this._setupWorker(worker, i);
        this.workers.push(worker);
      }
      // Resolve immediately — workers signal ready asynchronously.
      // _processQueue won't dispatch until at least one worker is ready.
      resolve();
    });
    return this.initPromise;
  }

  /**
   * Hash files in streaming batches, calling onBatch callback after each batch.
   * Skips failed batches gracefully instead of crashing the whole scan.
   */
  async hashFilesStream(files, onBatch, batchSize) {
    if (!batchSize) batchSize = 20;
    const results = [];
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      let batchResults;
      try {
        batchResults = await this.hashFiles(batch);
      } catch (e) {
        console.error('[HashPool] hashFilesStream batch error: ' + e.message);
        continue; // Skip failed batch, continue with next
      }
      for (const r of batchResults) {
        if (r) results.push(r);
      }
      if (typeof onBatch === 'function') onBatch(results.length, batch);
    }
    return results;
  }

  async terminate() {
    for (const w of this.workers) {
      if (w) {
        try { w.postMessage({ type: 'exit' }); } catch { console.error('[dup_hash_pool.js]'); }
        try { w.terminate(); } catch { console.error('[dup_hash_pool.js]'); }
      }
    }
    this.workers = [];
    this.readyWorkers = [];
    for (const [, batch] of this.activeBatches) {
      clearTimeout(batch.timeout);
      batch.reject(new Error('Pool terminated'));
    }
    this.activeBatches.clear();
    this.pendingBatches = [];
    this._initialized = false;
    this.initPromise = null;
  }
}

// Singleton for reuse
let defaultPool = null;

export function getHashPool(poolSize) {
  if (!defaultPool) {
    defaultPool = new HashPool(poolSize || DEFAULT_POOL_SIZE);
  }
  return defaultPool;
}
