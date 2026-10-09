// 通用文件删除端点 — 供「相似」「异常」「重名」三个分区使用。
//
// 这三个分区的结果都是"一组文件路径", 删除逻辑与 empty_dir 完全一致:
//   trash     移到 /volN/UID/.@#local/trash(可恢复)
//   permanent 直接删除(不可恢复)
//
// 为什么单独建文件而不是各自加到 simdup.js / broken.js / namematch.js:
// 三个模块的删除逻辑 100% 相同(逐路径 trash/permanent + EXDEV 兜底 + 冲突改名),
// 复制三份意味着三处都要同步修同一个 bug。集中在这里, 路由层只做转发。
//
// 安全约束(与 dup / empty_dir / bigfiles 一致, 不因是新代码而放宽):
//   - partitionDeletable: 拦 fnOS 系统目录(@appcenter/@appdata)与卷内回收站,
//     并要求路径在 /vol* 下
//   - trash 模式路径必须是 /volN/UID/... 才能进回收站, 否则报失败而不是静默永久删除
//   - lstat 而非 stat 判断类型: 符号链接按链接本身处理。实测 rmSync / renameSync
//     都不跟随符号链接(只删链接, 目标文件完好), 所以「无效链接」分区删的是
//     那个死链本身, 不会连带删掉它指向的目录。
import {
  existsSync, lstatSync, rmSync, mkdirSync, renameSync, cpSync, unlinkSync,
} from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { sendJSON, partitionDeletable, parseBody } from '../lib/util.js';

/** 把 /volN/UID/rest 映射到该卷回收站下的目标路径; 非 /volN/UID/ 形状返回 null */
function trashTarget(fp) {
  // UID 段匹配 \d[^/]* 而不是 \d+:
  //   - 纯 \d+ 匹配不到网盘。fnOS 网盘挂载的 UID 形如 1000-1-0985cb1(带 -1-
  //     后缀), /vol02 下的文件会永远收到"路径格式不支持回收站"的失败。
  //   - 用 [^/]+ 又太宽: /vol1/a/b 会把目录名 a 当成 UID, 映射到
  //     /vol1/a/.@#local/trash/ —— 回收站被塞到非 UID 目录里。
  // \d[^/]* 两者兼顾: 要求数字开头(fnOS UID 的确定特征), 又允许带后缀。
  const m = fp.match(/^\/(?:mnt\/)?(vol\d+)\/(\d[^/]*)\/(.+)/);
  if (!m) return null;
  const root = `/${m[1]}/${m[2]}`;
  // /vol02 是 fnOS 网盘 fuse 挂载, 建不了 .@#local/trash(mkdir 会被 fuse 拒绝)。
  // 这一点与 api/trash.js 的 moveToTrash 一致 —— 不能只按 UID 段判断就放行,
  // 否则网盘路径会走到 mkdir 然后抛错, 用户看到的是"删除失败"。
  if (root.startsWith('/vol02/')) return null;
  return `${root}/.@#local/trash/${m[3]}`;
}

/** 目标已存在时追加 _1 / _2 … 后缀, 与 dup/empty_dir 的行为一致 */
function uniqueDest(dest) {
  if (!existsSync(dest)) return dest;
  const ext2 = extname(dest);
  const bn = basename(dest);
  const stem = bn.slice(0, ext2.length ? -ext2.length : bn.length);
  let counter = 1;
  let cand = join(dirname(dest), `${stem}_${counter}${ext2}`);
  while (existsSync(cand)) {
    counter++;
    cand = join(dirname(dest), `${stem}_${counter}${ext2}`);
  }
  return cand;
}

/** 单条删除。返回 'deleted' 或抛出(由调用方收集到 failed) */
function deleteOne(fp, mode) {
  // 路径已不在磁盘上: 算成功(与 dup/bigfiles 一致, 不当作失败)
  if (!existsSync(fp) && !isSymlink(fp)) return 'gone';

  if (mode === 'permanent') {
    rmSync(fp, { recursive: true, force: true });
    return 'deleted';
  }

  // trash 模式
  const dest = trashTarget(fp);
  if (!dest) {
    throw new Error('路径格式不支持回收站: ' + fp + ' (需 /volN/UID/... 格式)');
  }
  mkdirSync(dirname(dest), { recursive: true });
  const finalDest = uniqueDest(dest);
  try {
    renameSync(fp, finalDest);   // 同卷内原子移动, 符号链接只移动链接本身
  } catch (e) {
    // 跨设备(EXDEV): 卷回收站与源不同设备时 rename 不可用, 退化为复制+删除
    if (e.code !== 'EXDEV') throw e;
    cpSync(fp, finalDest);
    rmSync(fp, { recursive: true, force: true });
  }
  return 'deleted';
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * POST /api/files/delete
 * body: { paths: string[], mode: 'trash' | 'permanent' }
 */
export async function handleFilesDelete(req, res) {
  const data = await parseBody(req);
  const rawPaths = Array.isArray(data.paths)
    ? data.paths.filter(p => typeof p === 'string' && p.length > 0)
    : [];
  const mode = data.mode === 'permanent' ? 'permanent' : 'trash';

  if (!rawPaths.length) {
    sendJSON(res, 400, { error: 'paths 为空', success: false });
    return;
  }

  // 安全闸门: 与其他删除端点同一套判定
  const { ok: paths, blocked } = partitionDeletable(rawPaths);
  const skipped = rawPaths.length - paths.length;

  let deleted = 0;
  const gone = [];
  const failed = [];
  for (const fp of paths) {
    try {
      const r = deleteOne(fp, mode);
      if (r === 'deleted') deleted++;
      else gone.push(fp);
    } catch (e) {
      failed.push({ path: fp, reason: e.message });
    }
  }

  sendJSON(res, 200, {
    success: true,
    mode,
    deleted,
    gone,                                  // 已被其他程序移走, 不算失败
    failed,
    skipped,
    total: paths.length,
    failures: failed.length,
    blockedCount: blocked.length,
    blocked: blocked.slice(0, 50),
  });
}