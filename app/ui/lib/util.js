import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { SAFE_PREFIXES } from './config.js';

export function formatBytes(b) {
  if (b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
}

export async function parseBody(req) {
  if (req.method === 'GET') return {};
  const bufs = [];
  for await (const chunk of req) bufs.push(chunk);
  try { return JSON.parse(Buffer.concat(bufs).toString()); }
  catch { return {}; }
}

// CORS origins: comma-separated env var, or specific dev defaults
export const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:9633,http://127.0.0.1:9633').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_ANY_ORIGIN = CORS_ORIGINS.includes('*');

export function sendJSON(res, code, data) {
  const origin = res.req?.headers?.origin;
  const allowOrigin = ALLOW_ANY_ORIGIN ? '*' : (origin && CORS_ORIGINS.includes(origin) ? origin : CORS_ORIGINS[0] || '*');
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
  });
  res.end(JSON.stringify(data));
}

export function execCmd(cmd, args, timeout = 30000) {
  return new Promise((resolve2) => {
    const proc = spawn(cmd, args, { timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => stdout += c);
    proc.stderr.on('data', c => stderr += c);
    proc.on('close', code => resolve2({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    proc.on('error', e => resolve2({ code: -1, stdout: '', stderr: e.message }));
  });
}

export function isSafePath(p) {
  const n = resolve(p);
  // Standard whitelist: /vol* paths
  if ([...SAFE_PREFIXES].some(pre => n.startsWith(pre))) return true;
  // Test fixture allowlist: when TRM_FNCLEARUP_TEST=1, allow /tmp/fnclearup_test paths
  if (process.env.TRM_FNCLEARUP_TEST === '1' && n.startsWith('/tmp/fnclearup_test')) return true;
  return false;
}

export function parseQuery(url) {
  const q = url.searchParams;
  const o = {};
  for (const [k, v] of q) o[k] = v;
  return o;
}
