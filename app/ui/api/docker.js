import { existsSync } from 'node:fs';
import { sendJSON, execCmd, parseBody } from '../lib/util.js';
import { SYSTEM_NETWORKS } from '../lib/config.js';

// GET /api/volumes
export async function handleVolumes(req, res) {
  const r = await execCmd('docker', ['volume', 'ls', '-q']);
  if (r.code !== 0 || !r.stdout) {
    sendJSON(res, 200, { volumes: { all: [], in_use: [], orphan: [] }, success: true, message: 'docker not available' });
    return;
  }
  const names = r.stdout.split('\n').filter(Boolean);
  if (!names.length) {
    sendJSON(res, 200, { volumes: { all: [], in_use: [], orphan: [] }, success: true, counts: { total: 0, in_use: 0, orphan: 0 } });
    return;
  }
  const ri = await execCmd('docker', ['volume', 'inspect', '--format', '{{.Name}}|{{.Driver}}|{{.Mountpoint}}', ...names]);
  const volInfo = {};
  for (const line of ri.stdout.split('\n')) {
    const p = line.split('|');
    if (p[0]) volInfo[p[0]] = { driver: p[1] || '', mountpoint: p[2] || '' };
  }
  const rp = await execCmd('docker', ['ps', '-a', '--format', '{{.ID}}|{{.Names}}']);
  const cidToName = {};
  for (const line of rp.stdout.split('\n')) {
    const p = line.split('|');
    if (p.length === 2) cidToName[p[0]] = p[1];
  }
  const volContainers = {};
  for (const [cid] of Object.entries(cidToName)) {
    const ri2 = await execCmd('docker', ['inspect', '--type', 'container', '--format', '{{json .Mounts}}', cid], 10000);
    if (ri2.code !== 0) continue;
    try {
      const mounts = JSON.parse(ri2.stdout);
      for (const m of mounts) {
        if (m.Name) (volContainers[m.Name] ||= []).push(cidToName[cid]);
      }
    } catch (e) { console.error('[docker] handleVolumes fail', e); }
  }
  const inUse = [], orphan = [];
  for (const name of names) {
    const info = volInfo[name] || {};
    const entry = { name, driver: info.driver, mountpoint: info.mountpoint, containers: volContainers[name] || [] };
    (volContainers[name] ? inUse : orphan).push(entry);
  }
  sendJSON(res, 200, {
    volumes: { all: names, in_use: inUse, orphan },
    success: true,
    counts: { total: names.length, in_use: inUse.length, orphan: orphan.length }
  });
}

// P0 安全: docker CLI 的删除子命令会把以 '-' 开头的参数当成选项
// (如 --force / --all), 用户可控字符串直接拼进 args 即构成选项注入。
// 这里只允许 docker 合法的资源名/ID 字符集: 字母数字与 . _ - : / @,
// 且首字符不得为 '-'。三个删除端点统一走这个校验, 非法值计入 skipped。
function isSafeDockerRef(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 512
    && !name.startsWith('-')
    && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(name);
}

// POST /api/volumes/delete
export async function handleVolumesDelete(req, res) {
  const data = await parseBody(req);
  const names = data.volumes || [];
  const deleted = [], failed = [], errors = [];
  let skipped = 0;
  for (const n of names) {
    if (!isSafeDockerRef(n)) { skipped++; failed.push(n); errors.push(`${n}: 名称非法，已拒绝`); continue; }
    const r = await execCmd('docker', ['volume', 'rm', n]);
    if (r.code === 0) deleted.push(n);
    else { failed.push(n); errors.push(`${n}: ${r.stderr}`); }
  }
  sendJSON(res, 200, { deleted, failed, total: deleted.length, failures: failed.length, errors, success: true });
}

// GET /api/networks
export async function handleNetworks(req, res) {
  const r = await execCmd('docker', ['network', 'ls', '--format', '{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}']);
  if (r.code !== 0) {
    sendJSON(res, 200, { networks: { all: [], used: [], unused: [] }, success: true, message: 'docker not available' });
    return;
  }
  const allNets = [];
  for (const line of r.stdout.split('\n')) {
    const p = line.split('|');
    if (p.length >= 4) allNets.push({ id: p[0], name: p[1], driver: p[2], scope: p[3], containers: 0, unused: false });
  }
  if (allNets.length) {
    const ri = await execCmd('docker', ['network', 'inspect', '--format', '{{.Name}}|{{range .Containers}}{{.Name}}:{{end}}', ...allNets.map(n => n.name)]);
    const connected = {};
    for (const line of ri.stdout.split('\n')) {
      const p = line.split('|');
      if (p.length >= 2) connected[p[0]] = p[1].split(':').filter(Boolean);
    }
    for (const net of allNets) {
      net.containers = (connected[net.name] || []).length;
      net.unused = net.containers === 0 && !SYSTEM_NETWORKS.has(net.name);
    }
  }
  const unused = allNets.filter(n => n.unused);
  sendJSON(res, 200, {
    networks: { all: allNets, used: allNets.filter(n => !n.unused), unused },
    success: true,
    counts: { total: allNets.length, used: allNets.length - unused.length, unused: unused.length }
  });
}

// POST /api/networks/delete
export async function handleNetworksDelete(req, res) {
  const data = await parseBody(req);
  const nets = data.networks || [];
  const deleted = [], failed = [], errors = [];
  let skipped = 0;
  for (const n of nets) {
    if (!isSafeDockerRef(n)) { skipped++; failed.push(n); errors.push(`${n}: 名称非法，已拒绝`); continue; }
    const r = await execCmd('docker', ['network', 'rm', n]);
    if (r.code === 0) deleted.push(n);
    else { failed.push(n); errors.push(`${n}: ${r.stderr}`); }
  }
  sendJSON(res, 200, { deleted, failed, total: deleted.length, failures: failed.length, errors, success: true });
}

// GET /api/images
export async function handleImages(req, res) {
  const r = await execCmd('docker', ['images', '--format', '{{.Repository}}|{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedSince}}']);
  if (r.code !== 0) {
    sendJSON(res, 200, { images: { all: [], used: [], unused: [], dangling: [] }, success: true, message: 'docker not available' });
    return;
  }
  const all = [], dangling = [];
  for (const line of r.stdout.split('\n')) {
    const p = line.split('|');
    if (p.length < 5) continue;
    const isDangling = p[0] === '<none>' && p[1] === '<none>';
    const entry = { id: p[2], repository: p[0], tag: p[1], size: p[3], created: p[4], dangling: isDangling, used: false };
    all.push(entry);
    if (isDangling) dangling.push(entry);
  }
  const rp = await execCmd('docker', ['ps', '-a', '--format', '{{.Image}}']);
  const usedNames = new Set(rp.stdout.split('\n').filter(Boolean));
  for (const img of all) {
    const name = img.tag !== '<none>' ? `${img.repository}:${img.tag}` : img.id;
    img.used = usedNames.has(name) || usedNames.has(img.id) || usedNames.has(img.id.replace('sha256:', ''));
  }
  const used = all.filter(i => i.used);
  const unused = all.filter(i => !i.used && !i.dangling);
  sendJSON(res, 200, {
    images: { all, used, unused, dangling, counts: { total: all.length, used: used.length, unused: unused.length, dangling: dangling.length } },
    success: true
  });
}

// POST /api/images/delete
export async function handleImagesDelete(req, res) {
  const data = await parseBody(req);
  const ids = data.images || [];
  let deleted = 0, failures = 0;
  const errors = [];
  for (const id of ids) {
    if (!isSafeDockerRef(id)) { failures++; errors.push(`${id}: 名称非法，已拒绝`); continue; }
    const r = await execCmd('docker', ['rmi', id], 60000);
    if (r.code === 0) deleted++;
    else { failures++; errors.push(`${id}: ${r.stderr}`); }
  }
  sendJSON(res, 200, { success: true, total: deleted, failures, errors });
}

// GET /api/system
export async function handleSystem(req, res) {
  const info = {};
  try {
    const r = await execCmd('df', ['-B1', '--output=target,size,used,avail,pcent', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs']);
    const lines = r.stdout.split('\n').filter(Boolean);
    const disks = [];
    for (const line of lines.slice(1)) {
      const p = line.split(/\s+/);
      if (p.length >= 5) disks.push({ mount: p[0], total: parseInt(p[1]) || 0, used: parseInt(p[2]) || 0, avail: parseInt(p[3]) || 0, pcent: parseInt((p[4] || '0').replace('%', '')) });
    }
    info.disk = { partitions: disks };
  } catch { info.disk = {}; }
  try {
    const r = await execCmd('free', ['-b']);
    const mem = {};
    for (const line of r.stdout.split('\n')) {
      const p = line.split(/\s+/);
      if (p[0] && p.length >= 3) mem[p[0].replace(':', '')] = { total: parseInt(p[1]) || 0, used: parseInt(p[2]) || 0, free: parseInt(p[3]) || 0 };
    }
    info.memory = mem;
  } catch { info.memory = {}; }
  info.docker = { available: false, running_containers: 0, total_volumes: 0, total_networks: 0 };
  const rd = await execCmd('docker', ['info'], 5000);
  if (rd.code === 0) {
    info.docker.available = true;
    const rp = await execCmd('docker', ['ps', '-q']);
    info.docker.running_containers = rp.stdout.split('\n').filter(Boolean).length;
    const rv = await execCmd('docker', ['volume', 'ls', '-q']);
    info.docker.total_volumes = rv.stdout.split('\n').filter(Boolean).length;
    const rn = await execCmd('docker', ['network', 'ls', '-q']);
    info.docker.total_networks = rn.stdout.split('\n').filter(Boolean).length;
  }
  sendJSON(res, 200, { success: true, data: info });
}
