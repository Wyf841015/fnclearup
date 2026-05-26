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

export function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
  return [...SAFE_PREFIXES].some(pre => n.startsWith(pre));
}

export function parseQuery(url) {
  const q = url.searchParams;
  const o = {};
  for (const [k, v] of q) o[k] = v;
  return o;
}
