import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendJSON } from '../lib/util.js';

// GET /api/mounts
export function handleMounts(req, res) {
  try {
    if (existsSync('/etc/mountmgr/mount_info.json')) {
      const raw = JSON.parse(readFileSync('/etc/mountmgr/mount_info.json', 'utf-8'));
      const mounts = [];
      for (const uidEntry of Object.values(raw)) {
        for (const me of Object.values(uidEntry)) {
          if (me.mountPoint) mounts.push(me);
        }
      }
      sendJSON(res, 200, { mounts, success: true });
      return;
    }
  } catch { console.error('[disk.js]'); }
  sendJSON(res, 200, { mounts: [], success: false, message: 'mount_info.json not found' });
}

// GET /api/vol02
export function handleVol02(req, res) {
  let dirs = [];
  if (existsSync('/vol02')) {
    dirs = readdirSync('/vol02').filter(e => statSync(join('/vol02', e)).isDirectory()).sort();
  }
  let mounts = [];
  try {
    if (existsSync('/etc/mountmgr/mount_info.json')) {
      const raw = JSON.parse(readFileSync('/etc/mountmgr/mount_info.json', 'utf-8'));
      for (const uidEntry of Object.values(raw)) {
        for (const me of Object.values(uidEntry)) {
          if (me.mountPoint) mounts.push(me.mountPoint);
        }
      }
    }
  } catch { console.error('[disk.js]'); }
  sendJSON(res, 200, { vol02_dirs: dirs, mounted_points: mounts, success: true });
}
