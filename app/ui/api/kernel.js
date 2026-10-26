// 内核清理 —— /boot 里的旧内核 + APT 下载缓存 + rc 残留包
//
// 为什么单独做：fnOS 每次系统升级都会装一套新内核（image + modules + headers），
// 旧的不会被自动清掉。实测本机 10 套内核占 /boot 和 /lib/modules 共 3G+，
// 而 /boot 是个很小的分区（常常几 G），堆满之后系统更新直接失败，
// 而且只报「磁盘空间不足」，很难联想到是旧内核。
//
// 安全边界（硬性，不可通过参数绕过）：
//   1. 正在运行的内核（uname -r）永远不可删 —— 前端不给勾，后端再拦一次
//   2. 只接受「扫描结果里真实存在的版本」，且包名来自 dpkg 实测，
//      不接受前端传来的任意包名/路径（防命令注入、防误删别的包）
//   3. 用 spawn 数组参数调 apt-get，全程不过 shell
//   4. 同一时间只允许一个清理任务在跑（busy 锁）
//   5. 必须带 confirm='PURGE' 才执行
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sendJSON, execCmd, parseBody, formatBytes } from '../lib/util.js';

const BOOT_DIR = '/boot';
const MODULES_DIR = '/lib/modules';
const GRUB_DEFAULT_FILE = '/etc/default/grub';
const GRUB_CFG_FILE = '/boot/grub/grub.cfg';

// 同一时间只允许一个清理任务
let kernelBusy = false;

import { readFileSync } from 'node:fs';
function readFile(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function listDir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * du -sk 取目录大小（字节）。
 *
 * 注意：**不能用退出码判断成败**。du 遇到读不了的子目录（如 /var/cache/apt/archives/partial
 * 属主是 _apt）会打一行 "Permission denied" 然后以 exit 1 结束，但它对能读的部分
 * 仍然照常打印了正确总量。按退出码返回 0 会把 179MB 的 apt 缓存报成 0B。
 * 所以：只要 stdout 第一列能解析就用它，解析不了才退化成 0。
 */
async function dirSize(path) {
  if (!existsSync(path)) return 0;
  const r = await execCmd('du', ['-sk', path], 60000);
  const first = String(r.stdout || '').trim().split(/\s+/)[0];
  const kb = parseInt(first, 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/** dpkg 包清单：返回 [{ pkg, statusOk, statusRaw }] */
async function dpkgList(pattern = 'linux-*') {
  const r = await execCmd('dpkg-query', ['-W', '-f=${Package}\t${Status}\n', pattern], 30000);
  const out = String(r.stdout || '');
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [pkg, ...rest] = line.split('\t');
    const statusRaw = rest.join('\t').trim();
    if (!pkg) continue;
    // Status 形如 "install ok installed" / "hold ok not-installed" / "deinstall ok config-files"
    // 陷阱：不能写 statusRaw.includes('installed') —— "not-installed" 也包含它，
    // 实测本机 345 个 never-installed 的候选内核包会被全判成已安装。
    const parts = statusRaw.split(/\s+/);
    const want = parts[0] || '';
    const state = parts[2] || '';
    rows.push({
      pkg: pkg.trim(),
      statusRaw, want, state,
      installed: state === 'installed',
      rc: state === 'config-files',
      held: want === 'hold',
    });
  }
  return rows;
}

/** 当前挂起的包（apt-mark showhold） */
async function holdSet() {
  const r = await execCmd('apt-mark', ['showhold'], 20000);
  const set = new Set();
  for (const line of String(r.stdout || '').split('\n')) {
    const p = line.trim();
    if (p) set.add(p);
  }
  return set;
}

/** GRUB_DEFAULT 是否指向一个真实存在的 menuentry id */
function grubInfo(entries) {
  const txt = readFile(GRUB_DEFAULT_FILE);
  const m = txt.match(/^\s*GRUB_DEFAULT\s*=\s*(.+)$/m);
  const raw = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  // "0" / "saved" / 菜单标题 都算「有效写法」；带 gnulinux- 的 id 必须能在 grub.cfg 里找到
  if (!raw) return { value: '', set: false, valid: false, note: '未设置 GRUB_DEFAULT（BIOS 默认取第一项）' };
  const isId = /gnulinux-|advanced-/.test(raw);
  if (!isId) return { value: raw, set: true, valid: true, note: '' };
  const exists = entries.some(e => e.includes(raw));
  // 从 "gnulinux-6.12.18-trim-advanced-<uuid>" 里抠出内核版本
  let kernelVersion = '';
  const km = raw.match(/gnulinux-(.+?)-advanced-/);
  if (km) kernelVersion = km[1];
  return {
    value: raw, set: true, valid: exists, kernel_version: kernelVersion,
    note: exists ? '' : 'GRUB_DEFAULT 指向一个已不存在的菜单项 —— 开机会回退到第一个内核。',
  };
}

/** 从 /boot/grub/grub.cfg 抽出 menuentry 的 id */
function grubEntryIds() {
  const txt = readFile(GRUB_CFG_FILE);
  const ids = [];
  const re = /menuentry\s+'([^']*)'[^{]*?(?:--id\s+|\$menuentry_id_option\s+)'?([^\s'{]+)'?/g;
  let m;
  while ((m = re.exec(txt)) !== null) ids.push(m[2]);
  // 兜底：把所有 gnulinux-xxx 形态的串都抓出来
  const re2 = /gnulinux-[0-9A-Za-z._\-]+/g;
  while ((m = re2.exec(txt)) !== null) ids.push(m[0]);
  return Array.from(new Set(ids));
}

/**
 * 收集内核信息。扫描与删除共用这一份逻辑 —— 删除时重新扫一遍拿权威包名，
 * 绝不信任前端传来的包名。
 */
async function collectKernels() {
  // 1) 运行中的内核
  let running = '';
  const un = await execCmd('uname', ['-r'], 10000);
  if (un.code === 0 && String(un.stdout || '').trim()) running = String(un.stdout).trim();
  if (!running) {
    try { running = (await import('node:os')).release(); } catch { running = ''; }
  }

  // 2) 版本来源：/lib/modules 目录 + /boot/vmlinuz-* + dpkg 包名
  const versions = new Set();
  for (const name of listDir(MODULES_DIR)) {
    if (/^\d/.test(name)) versions.add(name);
  }
  const bootFiles = listDir(BOOT_DIR);
  for (const f of bootFiles) {
    const m = f.match(/^(?:vmlinuz|initrd\.img|initramfs|config|System\.map|vmlinux)[-.]?(.+)$/);
    if (m && /\d/.test(m[1])) versions.add(m[1]);
  }

  // 版本只认「磁盘上真有东西」的：/lib/modules/<ver> 或 /boot/*<ver>*
  // 不从 dpkg 包名反推 —— dpkg 数据库里躺着几百个 never-installed 的候选包
  // （linux-image-6.1.0-53-amd64 之类），按包名取版本会凭空多出三百多个"内核"。
  if (running) versions.add(running);
  // 版本号至少得像版本号：带数字和点（排除 trim/generic 这类元包后缀）
  for (const v of Array.from(versions)) {
    if (!/\d/.test(v) || !/[-.]/.test(v)) versions.delete(v);
  }

  const pkgs = await dpkgList('linux-*');

  const holds = await holdSet();

  // 3) 逐版本算体积 / 关联包 / 状态
  const kernels = [];
  for (const version of versions) {
    const modDir = join(MODULES_DIR, version);
    let size = 0;
    const parts = [];
    if (existsSync(modDir)) {
      const s = await dirSize(modDir);
      size += s;
      parts.push({ path: modDir, size: s });
    }
    const bfiles = bootFiles.filter(f => f.includes(version));
    for (const f of bfiles) {
      const full = join(BOOT_DIR, f);
      let sz = 0;
      try { const st = statSync(full); if (st.isFile()) sz = st.size; } catch { /* ignore */ }
      size += sz;
      parts.push({ path: full, size: sz });
    }

    // 例：版本 6.18.18.c1107-trim 对应
    //   linux-image-6.18.18.c1107-trim / linux-headers-6.18.18.c1107-trim /
    //   linux-modules-6.18.18.c1107-trim / linux-headers-6.18.18.c1107-trim-common
    const own = pkgs.filter(r => r.installed && (
      r.pkg.endsWith('-' + version) || r.pkg.includes('-' + version + '-')
    )).map(r => r.pkg);
    const ownHold = pkgs.filter(r => own.includes(r.pkg) && (r.held || holds.has(r.pkg))).map(r => r.pkg);

    const isRunning = version === running;
    // 只有 modules 目录或 vmlinuz 都不在、dpkg 也没有包时才认为「只是残留」
    const hasFiles = existsSync(modDir) || bfiles.length > 0;
    kernels.push({
      version,
      running: isRunning,
      size,
      size_str: formatBytes(size),
      parts,
      packages: own,
      hold: ownHold.length > 0,
      hold_packages: ownHold,
      has_files: hasFiles,
      // 前端据此决定能不能勾；后端删除时会再校验一次
      deletable: !isRunning && own.length > 0,
      reason: isRunning ? '正在运行的内核，不能删除'
        : own.length === 0 ? '找不到对应的 dpkg 包（可能已被手动清理文件），需要手工处理'
          : ownHold.length > 0 ? '包处于 hold 状态，删除前会自动 unhold'
            : '',
    });
  }

  // 标出 GRUB 默认启动项（多半不是正在运行的那个 —— 这点必须让用户看见，
  // 否则他删掉「默认启动」的内核后，下次开机会回退到菜单第一条，很容易误以为出问题）
  const grub = grubInfo(grubEntryIds());
  if (grub.kernel_version) {
    for (const k of kernels) k.grub_default = (k.version === grub.kernel_version);
  }

  // 排序：运行中的排最前，其余按版本号从新到旧
  kernels.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return String(b.version).localeCompare(String(a.version), undefined, { numeric: true });
  });

  // 4) 建议保留：运行中 + 最新的一个非运行内核（出事能回退）
  const newestOther = kernels.find(k => !k.running && k.has_files);
  for (const k of kernels) {
    k.suggest_keep = k.running || (newestOther && k.version === newestOther.version);
  }

  // 5) APT 下载缓存
  const cacheDir = '/var/cache/apt/archives';
  const cacheSize = await dirSize(cacheDir);
  const cacheFiles = listDir(cacheDir).filter(f => /\.deb$/.test(f)).length;

  // 6) rc 残留包（已删但留着配置）
  const rcPackages = pkgs.filter(r => r.rc).map(r => r.pkg);

  const reclaimable = kernels.filter(k => k.deletable && !k.suggest_keep).reduce((s, k) => s + k.size, 0);

  return {
    running,
    kernels,
    count: kernels.length,
    deletable_count: kernels.filter(k => k.deletable && !k.suggest_keep).length,
    reclaimable,
    reclaimable_str: formatBytes(reclaimable),
    total_size: kernels.reduce((s, k) => s + k.size, 0),
    total_size_str: formatBytes(kernels.reduce((s, k) => s + k.size, 0)),
    apt_cache: { dir: cacheDir, size: cacheSize, size_str: formatBytes(cacheSize), files: cacheFiles },
    rc_packages: rcPackages,
    grub,
  };
}

// GET /api/kernel/scan
export async function handleKernelScan(req, res) {
  try {
    const data = await collectKernels();
    sendJSON(res, 200, { ...data, success: true });
  } catch (e) {
    sendJSON(res, 500, { success: false, error: e.message });
  }
}

// POST /api/kernel/delete  body: { versions: [...], confirm: 'PURGE', clean_apt_cache: bool }
export async function handleKernelDelete(req, res) {
  const data = await parseBody(req);
  if (String(data.confirm || '') !== 'PURGE') {
    return sendJSON(res, 400, { success: false, error: '缺少确认标记（confirm 必须是 PURGE）' });
  }
  const want = Array.isArray(data.versions) ? data.versions.filter(v => typeof v === 'string' && v) : [];
  // 允许「只清 APT 缓存」：versions 为空但明确要求清缓存时不算错
  if (want.length === 0 && !data.clean_apt_cache) {
    return sendJSON(res, 400, { success: false, error: '没有选择要清理的内核' });
  }
  if (kernelBusy) {
    return sendJSON(res, 409, { success: false, error: '已有清理任务在执行，请等它结束' });
  }
  kernelBusy = true;
  try {
    // 重新扫一遍拿权威包名 —— 绝不信任前端传来的包名
    const scan = await collectKernels();
    const known = new Map(scan.kernels.map(k => [k.version, k]));

    const results = [];
    let freed = 0;
    for (const version of want) {
      const k = known.get(version);
      if (!k) {
        results.push({ version, ok: false, error: '扫描结果里没有这个内核（可能已删），请重新扫描' });
        continue;
      }
      if (k.running) {
        results.push({ version, ok: false, error: '正在运行的内核，禁止删除' });
        continue;
      }
      if (!k.packages || k.packages.length === 0) {
        results.push({ version, ok: false, error: '找不到对应的 dpkg 包，已跳过（需要手工处理）' });
        continue;
      }
      try {
        // hold 住的包 apt 会拒绝，先解除
        if (k.hold_packages && k.hold_packages.length > 0) {
          await execCmd('apt-mark', ['unhold', ...k.hold_packages], 30000);
        }
        const r = await execCmd('apt-get', [
          '-o', 'Dpkg::Options::=--force-confdef',
          '-o', 'Dpkg::Options::=--force-confold',
          '-y', 'purge', ...k.packages,
        ], 300000);
        const ok = r.code === 0;
        if (ok) freed += k.size;
        results.push({
          version, ok,
          packages: k.packages,
          size: k.size, size_str: k.size_str,
          error: ok ? '' : String(r.stderr || r.stdout || '').slice(-400),
        });
      } catch (e) {
        results.push({ version, ok: false, error: e.message });
      }
    }

    // 顺带清 APT 下载缓存（可选）
    let cache_cleaned = 0;
    if (data.clean_apt_cache) {
      const before = (await collectKernels()).apt_cache.size;
      const r = await execCmd('apt-get', ['clean'], 120000);
      if (r.code === 0) cache_cleaned = before;
      else results.push({ version: 'APT 缓存', ok: false, error: String(r.stderr || '').slice(-300) });
    }

    const done = results.filter(r => r.ok).length;
    sendJSON(res, 200, {
      success: true,
      results,
      removed: done,
      failed: results.length - done,
      freed,
      freed_str: formatBytes(freed),
      cache_cleaned,
      cache_cleaned_str: formatBytes(cache_cleaned),
      reboot_hint: done > 0 ? '已清理的内核会从下次启动菜单里消失，当前运行的内核不受影响，无需立即重启。' : '',
    });
  } catch (e) {
    sendJSON(res, 500, { success: false, error: e.message });
  } finally {
    kernelBusy = false;
  }
}
