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
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
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
 * 内核相关的 dpkg 包名前缀。
 *
 * 注意本机实测的真实命名（跟 Debian 上游不完全一样）：
 *   linux-image-6.18.18.c788-trim
 *   linux-headers-6.18.18.c788-trim
 *   linux-modules-**trim**-6.18.18.c788-trim     ← 带 trim 中缀！
 * 所以不能只认 linux-modules-<ver>，否则会漏掉模块包 —— 那会留下 /lib/modules/<ver>
 * 变成「包删了、文件还在」的半清理状态。
 */
const KERNEL_PKG_PREFIXES = [
  'linux-image-unsigned', 'linux-image',
  'linux-headers',
  'linux-modules-trim-extra', 'linux-modules-trim', 'linux-modules-extra', 'linux-modules',
  'linux-tools', 'linux-buildinfo', 'linux-source',
];

/**
 * 这个包是不是属于某个内核版本。
 *
 * 以前用 pkg.includes('-' + version + '-')，是子串匹配 —— 一旦同时存在
 * `6.18.18` 和 `6.18.18-trim` 两个版本，删前者会把后者的包一起带走。
 * 这里改成「前缀 + 完整版本号」精确匹配，只允许版本号后面再跟 -common/-dbg 这类后缀。
 */
export const KERNEL_PKG_SUFFIXES = new Set([
  'common', 'dbg', 'unsigned', 'signed-template', 'extra', 'source', 'buildinfo', 'tools',
]);

export function pkgBelongsToVersion(pkg, version) {
  if (!pkg || !version) return false;
  for (const p of KERNEL_PKG_PREFIXES) {
    if (pkg === p + '-' + version) return true;
    const rest = pkg.slice((p + '-' + version + '-').length);
    // 只允许白名单后缀（-common / -dbg 等）。
    // **不能**写成「版本号 + 任意后缀都算」—— 那样版本 6.18.18 会把
    // linux-image-6.18.18-trim 也算进去，删一个内核连带删另一个。
    if (pkg.startsWith(p + '-' + version + '-') && KERNEL_PKG_SUFFIXES.has(rest)) return true;
  }
  return false;
}

/** 系统里是否有 apt/dpkg 正在跑（此时 purge 会抢锁或把 dpkg 数据库搞一半）。 */
function aptBusyProcesses() {
  const hits = [];
  let pids = [];
  try { pids = readdirSync('/proc').filter(x => /^\d+$/.test(x)); } catch { return hits; }
  const names = new Set(['apt', 'apt-get', 'dpkg', 'aptitude', 'unattended-upgrade', 'dpkg-deb']);
  for (const pid of pids) {
    try {
      const cmd = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0')[0];
      if (!cmd) continue;
      if (names.has(basename(cmd))) hits.push(pid + ':' + basename(cmd));
    } catch { /* 进程已退出 */ }
  }
  return hits;
}

/**
 * 跑一个「绝对不能被 SIGKILL 打断」的长命令（apt/dpkg 这类）。
 *
 * execCmd 超时后会 SIGTERM + 5s 后 SIGKILL。对 apt-get purge 来说，
 * dpkg 事务做到一半被 SIGKILL 会留下「包半配置」的坏状态，比不删更糟。
 * 所以这里自己 spawn：只收集输出，超时只标记「可能仍在跑」，绝不杀进程。
 */
function runUnkillable(cmd, args, budgetMs = 600000) {
  return new Promise((resolve2) => {
    let stdout = '', stderr = '';
    const t0 = Date.now();
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; }, budgetMs);
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve2({ code, stdout, stderr, timedOut, ms: Date.now() - t0 });
    });
    proc.on('error', e => {
      clearTimeout(timer);
      resolve2({ code: -1, stdout, stderr: e.message, timedOut, ms: Date.now() - t0 });
    });
  });
}

/**
 * 用 `apt-get -s purge` 预演，看 apt 到底会动哪些包。
 * -s 是只模拟、不写系统，随便调。
 */
async function simulatePurge(pkgList) {
  if (!pkgList || pkgList.length === 0) return { ok: true, removed: [], extras: [], hitsRunning: [], raw: '' };
  const r = await runUnkillable('apt-get', ['-s', 'purge', ...pkgList], 180000);
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  const removed = new Set();
  // 优先用 Purg/Remv 行（最准），失败再退回 "will be REMOVED" 段落
  for (const m of out.matchAll(/^(?:Purg|Remv) (\S+)/gm)) removed.add(m[1]);
  if (removed.size === 0) {
    let inBlock = false;
    for (const ln of out.split('\n')) {
      if (/^The following .*will be REMOVED/.test(ln)) { inBlock = true; continue; }
      if (inBlock) {
        if (!/^\s/.test(ln) && ln.trim()) { inBlock = false; continue; }
        for (const tok of ln.trim().split(/\s+/)) if (tok) removed.add(tok.replace(/\*$/, ''));
      }
    }
  }
  const normalized = Array.from(removed).filter(Boolean).map(x => x.split(':')[0]);
  return {
    ok: r.code === 0,
    error: r.code === 0 ? '' : (r.stderr || r.stdout || '').trim().slice(-400),
    removed: Array.from(new Set(normalized)),
    requested: pkgList.slice(),
    raw: out,
  };
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

    const own = pkgs.filter(r => r.installed && pkgBelongsToVersion(r.pkg, version)).map(r => r.pkg);
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

// POST /api/kernel/delete
//
// body:
//   { versions: [...], confirm: 'PURGE', clean_apt_cache?: bool,
//     dry_run?: bool,              // true = 只预演，绝不改动系统
//     allow_extra_removals?: bool  // 允许 apt 连带删掉范围外的包（元包等）
//   }
//
// 为什么要有预演这一步：实测 purge **正在运行的**内核时 apt 会连带删掉
// linux-image-amd64 / linux-headers-amd64 / linux-modules-trim-extra 共 6 个包
// （元包 + extra 模块），而老内核则恰好只删自己那 3 个。也就是说 apt 的连带范围
// 不是固定的，必须先 `apt-get -s purge` 看一眼。前端在确认弹窗里就展示这份预演。
export async function handleKernelDelete(req, res) {
  const data = await parseBody(req);
  if (String(data.confirm || '') !== 'PURGE') {
    return sendJSON(res, 400, { success: false, error: '缺少确认标记（confirm 必须是 PURGE）' });
  }
  const want = Array.isArray(data.versions) ? data.versions.filter(v => typeof v === 'string' && v) : [];
  const dryRun = !!data.dry_run;
  const allowExtra = !!data.allow_extra_removals;
  // 允许「只清 APT 缓存」：versions 为空但明确要求清缓存时不算错
  if (want.length === 0 && !data.clean_apt_cache) {
    return sendJSON(res, 400, { success: false, error: '没有选择要清理的内核' });
  }
  // 预演是只读的（apt-get -s 不写系统、不抢锁），**不能**占清理锁 ——
  // 否则用户在多选后刚打开确认弹窗（后台正在预演 8 个版本）时点确认，
  // 就会被自己刚才那次预演挡在门外，报「已有清理任务在执行」。
  // 这正是用户遇到的多选清理失败。
  if (!dryRun) {
    if (kernelBusy) {
      return sendJSON(res, 409, { success: false, error: '上一个清理任务还在执行，请等它结束' });
    }
    kernelBusy = true;
  }
  try {
    // 重新扫一遍拿权威包名 —— 绝不信任前端传来的包名
    const scan = await collectKernels();
    const known = new Map(scan.kernels.map(k => [k.version, k]));
    const runningVersion = scan.running;

    // 正在运行内核的「包集合」：任何情况下都不允许出现在删除列表里
    const pkgsAll = await dpkgList('linux-*');
    const runningPkgs = new Set(
      pkgsAll.filter(r => r.installed && pkgBelongsToVersion(r.pkg, runningVersion)).map(r => r.pkg)
    );

    const plan = [];
    const rejected = [];
    for (const version of want) {
      const k = known.get(version);
      if (!k) { rejected.push({ version, error: '扫描结果里没有这个内核（可能已删），请重新扫描' }); continue; }
      if (k.running) { rejected.push({ version, error: '正在运行的内核，禁止删除' }); continue; }
      if (!k.packages || k.packages.length === 0) {
        rejected.push({ version, error: '找不到对应的 dpkg 包，已跳过（需要手工处理）' }); continue;
      }
      // 交叉校验 ①：这套内核的包与运行中内核的包不能有交集
      const overlap = k.packages.filter(x => runningPkgs.has(x));
      if (overlap.length) {
        rejected.push({ version, error: '要删的包里混进了正在运行内核的包（' + overlap.join(', ') + '），已拒绝' });
        continue;
      }
      plan.push({ version, k, removed: [], extras: [] });
    }

    // 交叉校验 ②：让 apt 自己说会删什么。
    // 并行跑（限 3 个），8 个版本串行要 12s+，并行约 2s —— 用户在弹窗里等得起。
    // apt-get -s 是纯模拟，不需要 dpkg 锁，并发安全。
    const CONCURRENCY = 3;
    for (let i = 0; i < plan.length; i += CONCURRENCY) {
      const batch = plan.slice(i, i + CONCURRENCY);
      const sims = await Promise.all(batch.map(x => simulatePurge(x.k.packages)));
      batch.forEach((item, idx) => {
        const sim = sims[idx];
        if (!sim.ok) {
          item.bad = 'apt 预演失败：' + (sim.error || '未知错误');
          return;
        }
        const runningHit = sim.removed.filter(x => runningPkgs.has(x));
        if (runningHit.length) {
          item.bad = 'apt 预演显示会连带删掉运行中内核的包（' + runningHit.join(', ') + '），已拒绝';
          return;
        }
        item.removed = sim.removed;
        item.extras = sim.removed.filter(x => !item.k.packages.includes(x));
      });
    }
    const planOk = plan.filter(x => !x.bad);
    for (const x of plan) if (x.bad) rejected.push({ version: x.version, error: x.bad });

    const allExtras = Array.from(new Set(planOk.flatMap(x => x.extras)));

    // ── 预演返回：只读，不改系统
    if (dryRun) {
      return sendJSON(res, 200, {
        success: true,
        dry_run: true,
        running: runningVersion,
        plan: planOk.map(x => ({
          version: x.version,
          size_str: x.k.size_str,
          requested: x.k.packages,
          apt_removes: x.removed,
          extras: x.extras,
        })),
        extras: allExtras,
        needs_extra_ack: allExtras.length > 0,
        rejected,
        note: allExtras.length > 0
          ? 'apt 预演显示除了这些内核包，还会连带删除 ' + allExtras.length + ' 个范围外的包（通常是依赖它们的元包）。'
          : 'apt 预演显示只会删除所选内核自己的包，没有连带。',
      });
    }

    // ── 真删前的最后一道闸：有没有「范围外」的连带删除
    if (allExtras.length > 0 && !allowExtra) {
      return sendJSON(res, 200, {
        success: false,
        needs_extra_ack: true,
        extras: allExtras,
        error: 'apt 预演发现会额外删除 ' + allExtras.length + ' 个包（' + allExtras.slice(0, 5).join(', ')
          + '）。这些通常是依赖内核的元包；确认可以一并删除后重试。',
      });
    }

    // ── apt/dpkg 正忙时不要抢锁（会把 dpkg 数据库搞成半配置状态）
    const busy = aptBusyProcesses();
    if (busy.length > 0) {
      return sendJSON(res, 200, {
        success: false,
        error: '系统里已经有 apt/dpkg 在运行（' + busy.join(', ') + '），等它结束再试',
      });
    }

    // ── 一次 apt 事务删掉全部选中内核（不再逐个 purge）
    //
    // 为什么合并：实测单套约 29s（apt 24s，且**每次**都要跑一遍 update-grub）。
    // 8 套串行 ≈ 200s+，直接顶到 fnOS 网关 `location /app/` 的
    // proxy_read_timeout 300s 上限 → 浏览器收到 504 / 请求中断，
    // 表现就是「全选清理等很久然后失败」。
    // 合并成一次事务后 dpkg 只跑一轮、update-grub 只跑一次，8 套约 40~60s。
    const allPkgs = [...new Set(planOk.flatMap(x => x.k.packages))];
    const allHolds = [...new Set(planOk.flatMap(x => x.k.hold_packages || []))];
    let purgeMs = 0, purgeCode = 0, purgeTimedOut = false, purgeErr = '';

    if (allPkgs.length > 0) {
      if (allHolds.length > 0) {
        // hold 住的包 apt -y 会直接报 "Held packages were changed" 中止，先全部解除
        const uh = await execCmd('apt-mark', ['unhold', ...allHolds], 60000);
        console.log(`[kernel] apt-mark unhold ${allHolds.length} 个包 → code=${uh.code}`);
      }
      const r = await runUnkillable('apt-get', [
        '-o', 'Dpkg::Options::=--force-confdef',
        '-o', 'Dpkg::Options::=--force-confold',
        '-y', 'purge', ...allPkgs,
      ], 900000);
      purgeCode = r.code; purgeMs = r.ms; purgeTimedOut = r.timedOut;
      purgeErr = r.code === 0 ? '' : String(r.stderr || r.stdout || '').trim().slice(-600);
      console.log(`[kernel] purge ${allPkgs.length} 包 / ${planOk.length} 套 → code=${r.code} ms=${r.ms}${r.timedOut ? ' (超时但未杀进程)' : ''}`);
      if (r.code !== 0) {
        console.log('[kernel] apt 错误: ' + purgeErr.replace(/\s*\n\s*/g, ' | ').slice(0, 600));
        // 失败把 hold 还回去，别留下「本来锁着、现在能删」的状态
        if (allHolds.length > 0) {
          try { await execCmd('apt-mark', ['hold', ...allHolds], 60000); } catch { /* ignore */ }
        }
      }
    }

    // 顺带清 APT 下载缓存（可选）
    let cache_cleaned = 0;
    if (data.clean_apt_cache) {
      const before = (await collectKernels()).apt_cache.size;
      const r = await execCmd('apt-get', ['clean'], 120000);
      if (r.code === 0) cache_cleaned = before;
      else console.log('[kernel] apt-get clean 失败: ' + String(r.stderr || '').slice(-300));
    }

    // ── 删完复核（也是给每个版本下结论的唯一依据）
    // 判定口径：看文件真没了没有，而不是只看 apt 退出码 ——
    // apt 可能返回非 0（例如更新 initramfs 有 warning）但包其实已经删干净。
    let after = { kernels: [], running: runningVersion };
    let results = [];
    let freed = 0;
    try {
      after = await collectKernels();
    } catch { /* 复核失败就用空表，下面会全部标失败 */ }
    const afterMap = new Map((after.kernels || []).map(k => [k.version, k]));
    results = planOk.map(item => {
      const left = afterMap.get(item.version);
      const gone = !left || !left.has_files;
      if (gone) freed += item.k.size;
      return {
        version: item.version,
        ok: gone,
        packages: item.k.packages,
        size: item.k.size, size_str: item.k.size_str,
        ms: purgeMs,
        timed_out: purgeTimedOut,
        error: gone ? '' : (purgeTimedOut
          ? 'apt 超过 15 分钟仍在跑（没有杀进程，请勿重复操作；必要时手工 dpkg --configure -a）'
          : (purgeErr || '包仍然存在，未删除成功')),
      };
    });

    // ── 残留检查：包删了但 /lib/modules 或 /boot 还在 = 半清理，必须报出来
    let leftover = [];
    try {
      leftover = (after.kernels || [])
        .filter(k => want.includes(k.version) && k.has_files)
        .map(k => ({ version: k.version, size_str: k.size_str, packages: k.packages }));
    } catch { /* 复核失败不影响主结果 */ }

    const done = results.filter(r => r.ok).length;
    sendJSON(res, 200, {
      success: true,
      results,
      rejected,
      removed: done,
      failed: results.length - done,
      freed,
      freed_str: formatBytes(freed),
      cache_cleaned,
      cache_cleaned_str: formatBytes(cache_cleaned),
      leftover,
      reboot_hint: done > 0
        ? '已清理的内核会从启动菜单消失，当前运行的内核不受影响，无需立即重启。'
        : '',
    });
  } catch (e) {
    sendJSON(res, 500, { success: false, error: e.message });
  } finally {
    if (!dryRun) kernelBusy = false;
  }
}
