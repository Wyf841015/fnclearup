// ── Docker Cleanup ──
// Scans + cleans up two common sources of disk bloat on fnOS hosts:
//
//   1. Stopped containers (`docker ps -f status=exited -f status=created`).
//      These accumulate from one-off scripts, failed CI runs, and apps that
//      crashed before starting. They take up image layers + writable layers
//      but no longer run anything.
//
//   2. Build cache (`docker builder prune -af`). Layer cache from `docker
//      build` / `docker compose build` lingers forever unless pruned. On
//      devs who build often this can hit tens of GB.
//
// Safety:
//   - All docker calls go through `execFile`-style `execCmd` (no shell).
//   - Removal endpoints default to `dry_run: true` and require explicit
//     `dry_run: false` to actually delete anything.
//   - All endpoints return `{available: false, ...}` if docker isn't
//     installed (no /var/run/docker.sock) so the UI can render a clean
//     "Docker not detected" state instead of crashing.
//   - Container IDs are validated against /^[a-f0-9]{12,64}$/i before being
//     passed to `docker rm` to prevent argument injection.
//   - `TRM_DOCKER_BIN` env var lets tests point at a mock binary.
//
// Test mode:
//   When `TRM_DOCKER_BIN=/path/to/mock` is set, execCmd uses that path
//   instead of `/usr/bin/docker`. The mock script should accept the same
//   args as docker and emit JSON on stdout for `ps` and `system df`.

import { existsSync } from 'node:fs';
import { execCmd, sendJSON, parseBody, formatBytes } from '../lib/util.js';

const DOCKER_TIMEOUT = 30000; // 30s per docker call (faster than scan 5min)
const DOCKER_SOCK = '/var/run/docker.sock';
const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/i;

function dockerBin() {
  return process.env.TRM_DOCKER_BIN || 'docker';
}

function isDockerAvailable() {
  // /var/run/docker.sock is the canonical signal; in test mode the env var
  // is enough to declare docker "available" (we trust the mock).
  if (process.env.TRM_DOCKER_BIN) return true;
  return existsSync(DOCKER_SOCK);
}

async function dockerOk() {
  // Cheap health-check: `docker info` exits non-zero when daemon unreachable
  const r = await execCmd(dockerBin(), ['info'], 5000);
  return r.code === 0;
}

// GET /api/docker/stopped
// Returns: {
//   available: bool,
//   daemon: bool,                    // is docker daemon reachable?
//   containers: [{id, names, image, status, created, size, size_bytes}],
//   total_count: n,
//   total_bytes: n,
//   error?: string
// }
export async function handleDockerStopped(req, res) {
  if (!isDockerAvailable()) {
    sendJSON(res, 200, { available: false, daemon: false, containers: [], total_count: 0, total_bytes: 0 });
    return;
  }
  if (!(await dockerOk())) {
    sendJSON(res, 200, { available: true, daemon: false, containers: [], total_count: 0, total_bytes: 0, error: 'docker daemon not responding' });
    return;
  }
  // -a includes stopped + created; -f status filters narrows to non-running
  const r = await execCmd(dockerBin(), [
    'ps', '-a',
    '-f', 'status=exited',
    '-f', 'status=created',
    '-f', 'status=dead',
    '--format', '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.CreatedAt}}|{{.Size}}'
  ], DOCKER_TIMEOUT);
  if (r.code !== 0) {
    sendJSON(res, 200, { available: true, daemon: true, containers: [], total_count: 0, total_bytes: 0, error: r.stderr || `docker ps failed (code ${r.code})` });
    return;
  }
  const containers = [];
  let totalBytes = 0;
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 6) continue;
    const id = parts[0];
    if (!CONTAINER_ID_RE.test(id)) continue;
    const sizeStr = parts[5] || '0 B';
    const sizeBytes = parseSizeToBytes(sizeStr);
    totalBytes += sizeBytes;
    containers.push({
      id,
      names: parts[1],
      image: parts[2],
      status: parts[3],
      created: parts[4],
      size: sizeStr,
      size_bytes: sizeBytes,
      size_str: formatBytes(sizeBytes),
    });
  }
  containers.sort((a, b) => b.size_bytes - a.size_bytes);
  sendJSON(res, 200, {
    available: true,
    daemon: true,
    containers,
    total_count: containers.length,
    total_bytes: totalBytes,
    total_size: formatBytes(totalBytes),
  });
}

// GET /api/docker/build_cache
// Returns: {
//   available, daemon,
//   build_cache: { reclaimable_bytes, reclaimable_str, total_bytes, total_str, layers?: n },
//   error?: string
// }
export async function handleDockerBuildCache(req, res) {
  if (!isDockerAvailable()) {
    sendJSON(res, 200, { available: false, daemon: false, build_cache: null });
    return;
  }
  if (!(await dockerOk())) {
    sendJSON(res, 200, { available: true, daemon: false, build_cache: null, error: 'docker daemon not responding' });
    return;
  }
  // `docker system df -v` emits JSON with --format json (Docker 23+)
  const r = await execCmd(dockerBin(), ['system', 'df', '-v', '--format', 'json'], DOCKER_TIMEOUT);
  if (r.code !== 0) {
    sendJSON(res, 200, { available: true, daemon: true, build_cache: null, error: r.stderr || `docker system df failed (code ${r.code})` });
    return;
  }
  // Output is a stream of JSON objects, one per line (NDJSON)
  let buildCache = null;
  for (const line of r.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      // `obj.Type === 'Build cache'` is the new shape (Docker 25+);
      // older Docker returns `Type === 'Build Cache'` or no Type at all
      // and groups everything under `LayersSize` in a single object.
      if (obj.Type === 'Build cache' || obj.Type === 'Build Cache') {
        const reclaimable = parseSizeToBytes(obj.Reclaimable || '0 B');
        const total = parseSizeToBytes(obj.Size || '0 B');
        buildCache = {
          reclaimable_bytes: reclaimable,
          reclaimable_str: formatBytes(reclaimable),
          total_bytes: total,
          total_str: formatBytes(total),
          layers: typeof obj.SharedSize === 'string' ? null : null,
        };
      } else if (obj.BuildCache && typeof obj.BuildCache === 'object') {
        // Fallback shape: { BuildCache: { ... } } (very old)
        const reclaimable = parseSizeToBytes(obj.BuildCache.Reclaimable || '0 B');
        const total = parseSizeToBytes(obj.BuildCache.Size || '0 B');
        buildCache = {
          reclaimable_bytes: reclaimable,
          reclaimable_str: formatBytes(reclaimable),
          total_bytes: total,
          total_str: formatBytes(total),
        };
      }
    } catch { /* skip non-JSON line */ }
  }
  sendJSON(res, 200, { available: true, daemon: true, build_cache: buildCache });
}

// POST /api/docker/stopped/remove
// Body: { ids: string[], dry_run?: bool }
// Returns: { removed: [{id, dry_run, ok, error?}], total: { requested, deleted, dry_run } }
export async function handleDockerStoppedRemove(req, res) {
  const body = await parseBody(req);
  const ids = Array.isArray(body?.ids) ? body.ids : [];
  const dryRun = body?.dry_run !== false; // default true (safe)

  if (!isDockerAvailable()) {
    sendJSON(res, 200, { available: false, removed: [], total: { requested: 0, deleted: 0, dry_run: dryRun } });
    return;
  }
  // Validate every id strictly — defense-in-depth against argument injection
  const valid = ids.filter(id => typeof id === 'string' && CONTAINER_ID_RE.test(id));
  const skipped = ids.length - valid.length;
  if (!valid.length) {
    sendJSON(res, 200, {
      available: true,
      removed: [],
      total: { requested: ids.length, deleted: 0, dry_run: dryRun, skipped },
      error: ids.length ? 'no valid container ids' : 'ids array required',
    });
    return;
  }
  if (dryRun) {
    sendJSON(res, 200, {
      available: true,
      dry_run: true,
      removed: valid.map(id => ({ id, dry_run: true, ok: true })),
      total: { requested: ids.length, deleted: 0, dry_run: true, skipped },
    });
    return;
  }
  // Real removal: docker rm <id1> <id2> ...
  const r = await execCmd(dockerBin(), ['rm', ...valid], DOCKER_TIMEOUT);
  let deleted = 0;
  const removed = valid.map(id => {
    // We don't have per-id stdout mapping when docker rm exits 0 — treat
    // exit code 0 as "all deleted". If rm printed errors to stderr, surface.
    const ok = r.code === 0;
    if (ok) deleted++;
    return { id, dry_run: false, ok, error: ok ? null : r.stderr };
  });
  sendJSON(res, 200, {
    available: true,
    dry_run: false,
    removed,
    total: { requested: ids.length, deleted, dry_run: false, skipped },
    error: r.code !== 0 ? r.stderr : null,
  });
}

// POST /api/docker/build_cache/prune
// Body: { dry_run?: bool }
// Returns: { dry_run, ok, reclaimed_bytes, reclaimed_str, error? }
export async function handleDockerBuildCachePrune(req, res) {
  const body = await parseBody(req);
  const dryRun = body?.dry_run !== false; // default true (safe — prune is destructive)
  if (!isDockerAvailable()) {
    sendJSON(res, 200, { available: false, dry_run: dryRun });
    return;
  }
  if (dryRun) {
    // Read current reclaimable and report as "would reclaim"
    const infoR = await execCmd(dockerBin(), ['system', 'df', '-v', '--format', 'json'], DOCKER_TIMEOUT);
    let wouldReclaim = 0;
    if (infoR.code === 0) {
      for (const line of infoR.stdout.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.Type === 'Build cache' || obj.Type === 'Build Cache') {
            wouldReclaim = parseSizeToBytes(obj.Reclaimable || '0 B');
            break;
          }
        } catch { console.error('[docker_cleanup.js]'); }
      }
    }
    sendJSON(res, 200, {
      available: true,
      dry_run: true,
      ok: true,
      reclaimed_bytes: wouldReclaim,
      reclaimed_str: formatBytes(wouldReclaim),
    });
    return;
  }
  // Real prune. -a removes all unused build cache, not just dangling.
  // -f skips confirmation prompt (we already showed UI confirm).
  const r = await execCmd(dockerBin(), ['builder', 'prune', '-af'], 60000);
  // Parse "Total reclaimed space: 1.234GB" from stderr (docker emits summary there)
  let reclaimedBytes = 0;
  const m = (r.stderr || '').match(/Total reclaimed space:\s*([\d.]+\s*\w+)/i);
  if (m) reclaimedBytes = parseSizeToBytes(m[1]);
  sendJSON(res, 200, {
    available: true,
    dry_run: false,
    ok: r.code === 0,
    reclaimed_bytes: reclaimedBytes,
    reclaimed_str: formatBytes(reclaimedBytes),
    error: r.code !== 0 ? r.stderr : null,
  });
}

// ── helpers ──

// Parse docker's human-readable size strings ("1.5 GB", "234 MB", "0 B")
// into bytes. Falls back to 0 on unparseable input.
function parseSizeToBytes(s) {
  if (!s) return 0;
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return 0;
  const unit = (m[2] || 'B').toUpperCase();
  const mult = {
    B: 1, KIB: 1024, KB: 1000,
    MIB: 1024 ** 2, MB: 1000 ** 2,
    GIB: 1024 ** 3, GB: 1000 ** 3,
    TIB: 1024 ** 4, TB: 1000 ** 4,
    PIB: 1024 ** 5, PB: 1000 ** 5,
  }[unit];
  return mult ? Math.round(n * mult) : 0;
}