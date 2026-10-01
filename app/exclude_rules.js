/**
 * exclude_rules.js — 扫描排除规则 (P1-1)
 *
 * 背景
 * 原先扫描除最小体积外没有任何路径排除, 每次扫 /vol1 都要把 @appdata 里的
 * SQLite、node_modules、.git、Docker overlay 全部走一遍。虽然哈希缓存能跳过
 * 重复计算, 但 walk + statSync 的元数据开销跑不掉, 而且系统目录里发现的
 * "重复文件"多半是各应用共用的 LICENSE/图标, 对用户毫无价值。
 *
 * 对标 fclones 的 .hashignore / dupeGuru 的 exclude 列表 / Czkawka 的排除目录。
 * 零依赖: 只支持最实用的两类写法, 不引入 minimatch。
 *
 * 规则文件: <TRM_PKGVAR>/data/scan_exclude.json
 *   {
 *     "patterns": [
 *       "@*",                  // 段名: 任意层级的 @ 开头目录(fnOS 系统目录)
 *       "node_modules",
 *       "**.git",              // 路径模式: 任意层级下的 .git(双星=任意层)
 *       "*.log",              // 段名 glob: 所有 .log 文件
 *       "/vol1/1000/tmp"      // 绝对路径前缀
 *     ]
 *   }
 *
 * 匹配语义
 *   - pattern 不含 "/"        → 按"路径段"匹配(任一层的目录名/文件名满足即排除)
 *                                支持 * ? glob; 目录匹配时其下全部内容都被跳过
 *   - pattern 含 "/"          → 转正则对相对路径匹配; 支持 ** (任意层) 与 * (单层)
 *   - pattern 以 "/" 开头     → 绝对路径前缀匹配
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';

const RULE_FILE = 'scan_exclude.json';

/** 内置默认规则: 永远不合理的目录, 不该出现在"清理工具"的可扫范围里 */
export const DEFAULT_PATTERNS = [
  // fnOS 系统与应用目录: 覆盖 @appcenter/@appconf/@appdata/@apphome/@appmeta/
  // @appshare/@apptemp/@sysappmeta 全部 8 个, 但不误伤用户自建的 @xxx 目录
  // (如 /vol1/1000/@我的相册 —— 中文目录名不会匹配 @app* / @sysapp*)。
  // 注意: 这是"跳过扫描"(性能), 与 util.js 的 isDeletablePath(安全删除保护)
  // 是两回事 —— 后者用精确名单, 从严。
  '@app*',
  '@sysapp*',
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.Trash',
  '.Trashes',
  'lost+found',
  '.pyc',
  '__pycache__',
  '.cache',
  '.gradle',
  '.npm',
  '.pnpm-store',
  'overlay2',       // Docker
];

function rulesPath(stateDir) {
  if (stateDir) return join(stateDir, RULE_FILE);
  const base = process.env.TRM_PKGVAR || '/vol3/@appdata/fnclearup';
  return join(base, 'data', RULE_FILE);
}

/** 读取规则; 文件不存在/损坏时回落到默认规则, 绝不因此中断扫描 */
export function loadPatterns(stateDir) {
  const p = rulesPath(stateDir);
  try {
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      const pats = Array.isArray(raw && raw.patterns) ? raw.patterns : null;
      if (pats) {
        const clean = pats.map(x => String(x).trim()).filter(Boolean);
        if (clean.length) return clean;
        return [];                       // 用户显式清空 → 不排除任何东西
      }
    }
  } catch { /* 损坏则用默认 */ }
  return DEFAULT_PATTERNS.slice();
}

/** 段名 glob → 正则 (只处理 * 与 ?, 逐字符转义) */
function segToRegExp(seg) {
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

/** 路径模式 → 正则 (支持 ** 与 *) */
function pathToRegExp(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === '*' && pat[i + 1] === '*') {
      if (pat[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }   // **/ → 可选多层前缀
      else { out += '.*'; i += 1; }
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('(?:^|/)' + out + '(?:/|$)');
}

/**
 * 编译成 matcher。
 * @param {string[]} patterns
 * @returns {(absPath:string, isDir:boolean, root:string)=>boolean}
 */
export function compileMatcher(patterns) {
  const segs = [];
  const paths = [];
  const prefixes = [];
  for (const raw of patterns || []) {
    const p = String(raw).trim();
    if (!p || p.startsWith('#')) continue;
    if (p.startsWith('/')) prefixes.push(resolve(p));
    else if (p.includes('/')) paths.push({ re: pathToRegExp(p.replace(/^\.\//, '')) });
    else segs.push({ re: segToRegExp(p), dirOnly: p === p.replace(/\/?\*+$/, '') && p.endsWith('*') });
  }
  if (!segs.length && !paths.length && !prefixes.length) return () => false;

  return function isExcluded(absPath, isDir) {
    const ap = resolve(absPath);
    for (const pre of prefixes) {
      if (ap === pre || ap.startsWith(pre + '/')) return true;
    }
    for (const { re } of paths) {
      if (re.test(ap)) return true;
    }
    if (segs.length) {
      // 逐段比对(比 split 更省, 也不必处理末尾斜杠)
      const segRe = [];
      for (const s of segs) segRe.push(s.re);
      let i = 0;
      while (i < ap.length) {
        let j = ap.indexOf('/', i + 1);
        if (j < 0) j = ap.length;
        const seg = ap.slice(i + 1, j);
        for (const re of segRe) if (re.test(seg)) return true;
        i = j;
      }
    }
    return false;
  };
}

/** 一步到位: 读规则 + 编译 */
export function buildMatcher(stateDir) {
  return compileMatcher(loadPatterns(stateDir));
}
