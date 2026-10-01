/**
 * storage_profile.js — 介质类型探测与扫描并发调优 (P0)
 *
 * 背景
 * 原实现固定 4 个哈希 worker。在本机(Intel Celeron J3355 双核 + WD43PURZ
 * 机械盘 RAID1)上这是 2 倍超订, 且机械盘多线程随机读会因寻道竞争而
 * 显著变慢。fclones 官方文档明确建议: 机械盘上做大批量文件哈希时用
 * --threads 1, 报告过 2x~10x 的性能差异。
 *
 * 策略
 *   - 读 /sys/block/<dev>/queue/rotational 判定目标路径所在卷是机械盘还是固态盘
 *     (1 = 机械, 0 = 固态; 读不到时保守当作机械盘)
 *   - 机械盘: 1 个 worker, 避免寻道竞争
 *   - 固态盘: min(4, CPU 核数), 避免超订
 *   - 部分路径落在机械盘、部分落在固态盘时, 取更保守的一侧
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cpus } from 'node:os';

const SYS_BLOCK = '/sys/block';

let _mountCache = null;   // [{ mount, dev, rotational }]

/** 解析 mountPoint → 设备, 一次 shell 调用搞定 */
function loadMounts() {
  if (_mountCache) return _mountCache;
  const list = [];
  try {
    const out = execFileSync('sh', ['-c',
      "df -P -x tmpfs -x devtmpfs 2>/dev/null | awk 'NR>1{print $6\"\\t\"$1}'"], {
      encoding: 'utf8', timeout: 5000,
    });
    for (const line of out.split('\n')) {
      const [mount, dev] = line.split('\t');
      if (!mount || !dev) continue;
      list.push({ mount: mount.trim(), dev: dev.trim() });
    }
  } catch { /* df 不可用则退化为保守策略 */ }

  // 展开 LVM / dm 设备 → 真实块设备
  const resolved = [];
  for (const m of list) {
    let base = m.dev.replace(/^\/dev\//, '').split('/').pop();
    try {
      const real = execFileSync('readlink', ['-f', m.dev], { encoding: 'utf8', timeout: 2000 }).trim();
      base = real.replace(/^\/dev\//, '').split('/').pop();
    } catch { /* 读不到就沿用原名 */ }
    resolved.push({ ...m, base });
  }
  _mountCache = resolved;
  return resolved;
}

/**
 * 该块设备是否机械盘 (找不到判定信息时返回 null)
 *
 * 注意: 必须用 readFileSync 而非 statSync —— statSync 默认返回 fs.Stats 对象,
 * 其 toString() 恒为 "[object Object]", 会把所有介质都误判为固态盘。
 * 2026-09-30 实测踩过这个坑。
 */
function isRotational(devBase) {
  if (!devBase) return null;
  try {
    const v = readFileSync(`${SYS_BLOCK}/${devBase}/queue/rotational`, 'utf8').trim();
    if (v !== '0' && v !== '1') return null;
    return v === '1';
  } catch { return null; }
}

/** 找到 path 所属的挂载点 (最长前缀匹配) */
function mountOf(path) {
  let p;
  try { p = resolve(path); } catch { return null; }
  let best = null;
  for (const m of loadMounts()) {
    if (p === m.mount || p.startsWith(m.mount.endsWith('/') ? m.mount : m.mount + '/')) {
      if (!best || m.mount.length > best.mount.length) best = m;
    }
  }
  return best;
}

/**
 * 为一组待扫描路径推导哈希并发度。
 * @param {string[]} paths  扫描路径
 * @returns {{poolSize:number, rotational:boolean|null, mount:string, cpus:number, reason:string}}
 */
export function profileFor(paths) {
  const nCpus = Math.max(1, cpus().length);
  const arr = Array.isArray(paths) ? paths : [paths];

  let sawRotational = null;      // null = 未知
  let hitMount = null;
  let anyHdd = false;
  let anyUnknown = false;

  for (const p of arr) {
    const m = mountOf(p);
    if (!m) { anyUnknown = true; continue; }
    if (!hitMount) hitMount = m.mount;
    const rot = isRotational(m.base);
    if (rot === null) anyUnknown = true;
    else if (rot === true) anyHdd = true;
    if (sawRotational === null) sawRotational = rot;
  }

  // 判定为机械盘的条件: 明确命中机械盘, 或介质类型完全无法确定(保守)
  const treatAsHDD = anyHdd || (sawRotational === null && anyUnknown);

  if (treatAsHDD) {
    return {
      poolSize: 1,
      rotational: anyHdd ? true : null,
      mount: hitMount,
      cpus: nCpus,
      reason: anyHdd
        ? `机械盘(${hitMount}) — 单线程避免寻道竞争, 固定 4 worker 反而更慢`
        : '无法确定介质类型 — 保守按机械盘单线程',
    };
  }
  return {
    poolSize: Math.min(4, nCpus),
    rotational: false,
    mount: hitMount,
    cpus: nCpus,
    reason: `固态盘(${hitMount}) — ${nCpus} 核, 取 min(4, 核数)=${Math.min(4, nCpus)}`,
  };
}

/** partial 哈希每段字节数: 头尾各取 N 字节 (seek 次数恒为 2, 只加大单段读取) */
export const PARTIAL_SEGMENT_BYTES = 32768;
