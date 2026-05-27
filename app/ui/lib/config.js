// ── Global constants ──
export const VERSION = '0.7.0';

export const VOL_GLOBS = ['/vol1','/vol2','/vol3','/vol4','/vol5','/vol6','/vol7','/vol8','/vol9','/vol10'];
export const SAFE_PREFIXES = new Set(VOL_GLOBS.map(v => v + '/'));

export const MUSIC_EXTS = new Set(['.mp3','.flac','.wav','.aac','.ogg','.m4a','.wma','.alac','.ape','.dsf']);
export const SYSTEM_NETWORKS = new Set(['bridge','host','none','container']);
export const TEMP_DIRS = ['/tmp', '/var/tmp'];

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};
