/**
 * dup_hash_pool.js — Worker thread pool for parallel file hashing.
 * Spawns N workers and distributes file batches to them.
 * Each worker streams-hashes files (256KB chunks, no memory accumulation).
 */
import { Worker } from 'node:worker_threads';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, 'dup_hash_worker.js');

const DEFAULT_POOL_SIZE = 4;

export class HashPool {
  constructor(poolSize = 4) {
    this.poolSize = poolSize;
    this.workers = [];
    this.readyWorkers = [];
    this.pendingBatches = [];
    this.batchIdCounter = 0;
    this.activeBatches = new Map();
    this._initialized = false;
    this._resolveInit = null;
    this.initPromise = null;
  }

  async init() {
    if (this._initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve) => {
      let readyCount = 0;
      for (let i = 0; i < this.poolSize; i++) {
        const worker = new Worker(WORKER_SCRIPT);
        worker.on('message', (msg) => {
          if (msg.type === 'ready') {
            readyCount++;
            this.readyWorkers.push(worker);
            if (readyCount === this.poolSize) {
              this._initialized = true;
              resolve();
              // Process any queued batches
              this._processQueue();
            }
          } else if (msg.type === 'result') {
            const batch = this.activeBatches.get(msg.batchId);
            if (batch) {
              batch.resolve(msg.results);
              this.activeBatches.delete(msg.batchId);
            }
            // Return worker to ready pool
            this.readyWorkers.push(worker);
            this._processQueue();
          }
        });
        worker.on('error', (err) => {
          console.error(`[HashPool] Worker ${i} error:`, err.message);
          // Replace dead worker
          const idx = this.workers.indexOf(worker);
          if (idx >= 0) this.workers[idx] = null;
          this._spawnReplacement(i);
        });
        this.workers.push(worker);
      }
    });

    return this.initPromise;
  }

  _spawnReplacement(idx) {
    const worker = new Worker(WORKER_SCRIPT);
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        this.readyWorkers.push(worker);
        this._processQueue();
      } else if (msg.type === 'result') {
        const batch = this.activeBatches.get(msg.batchId);
        if (batch) { batch.resolve(msg.results); this.activeBatches.delete(msg.batchId); }
        this.readyWorkers.push(worker);
        this._processQueue();
      }
    });
    worker.on('error', () => { this._spawnReplacement(idx); });
    this.workers[idx] = worker;
  }

  _processQueue() {
    while (this.readyWorkers.length > 0 && this.pendingBatches.length > 0) {
      const worker = this.readyWorkers.shift();
      const batch = this.pendingBatches.shift();
      worker.postMessage({ type: 'hash', files: batch.files, batchId: batch.batchId });
    }
  }

  /**
   * Hash a batch of files. Returns Promise<HashResult[]>
   */
  async hashFiles(files) {
    await this.init();
    const batchId = ++this.batchIdCounter;

    return new Promise((resolve) => {
      this.activeBatches.set(batchId, { resolve });
      this.pendingBatches.push({ batchId, files });
      this._processQueue();
    });
  }

  /**
   * Hash files and push results to a callback as each batch completes.
   * Returns total results count.
   */
  async hashFilesStream(files, onBatch, batchSize = 20) {
    const results = [];
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchResults = await this.hashFiles(batch);
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
        try { w.postMessage({ type: 'exit' }); } catch {}
        try { w.terminate(); } catch {}
      }
    }
    this.workers = [];
    this.readyWorkers = [];
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
    defaultPool = new HashPool(poolSize || 4);
  }
  return defaultPool;
}
