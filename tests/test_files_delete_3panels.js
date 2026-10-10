// 相似 / 异常 / 重名 三分区新增删除功能 — 2026-10-09
//
// 用户需求: 文件清理里原本只有「去重」有删除功能, 相似/异常/重名三个分区只能看不能删。
//
// 本文件覆盖:
//   后端  app/ui/api/files_delete.js  三分区共用删除端点
//         - trash / permanent 两种模式
//         - 安全闸门(系统目录 / 卷内回收站 / 非 /vol* 路径)
//         - 符号链接只删链接本身, 不动目标(异常分区的「无效链接」依赖这条)
//         - 回收站同名冲突自动加 _1 后缀
//   前端  main.js                  filesCollect / filesSelectAll / filesUpdateSelectInfo
//         index.html                三个删除按钮 + 共用确认弹窗
//         style.css                 .delete-ack
//
// 关键安全断言: 重名分区按组选择, 勾一组只删副本、永远保留每组第一份。
// 逐文件勾选的话全选会把仅存的一份也删掉。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const backendSrc = rd('app/ui/api/files_delete.js');
const mainSrc = rd('app/ui/main.js');
const htmlSrc = rd('app/ui/index.html');
const cssSrc = rd('app/ui/styles/style.css');
const serverSrc = rd('app/ui/server.js');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function fnBody(src, sig) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + sig + '\\s*\\(').exec(src);
  if (!m) return null;
  let p = src.indexOf('(', m.index), d = 0, k = p;
  for (; k < src.length; k++) {
    if (src[k] === '(') d++;
    else if (src[k] === ')') { d--; if (d === 0) break; }
  }
  const bodyStart = src.indexOf('{', k);
  if (bodyStart < 0) return null;
  d = 0;
  for (let x = bodyStart; x < src.length; x++) {
    if (src[x] === '{') d++;
    else if (src[x] === '}') { d--; if (d === 0) return src.slice(m.index, x + 1); }
  }
  return null;
}
const code = stripComments(mainSrc);
const bcode = stripComments(backendSrc);

/* ══════════ 后端 ══════════ */

test('后端: 端点已注册到路由', () => {
  assert.match(serverSrc, /import \{ handleFilesDelete \} from '\.\/api\/files_delete\.js';/);
  assert.match(serverSrc,
    /if \(method === 'POST' && path === '\/api\/files\/delete'\) \{ await handleFilesDelete\(req, res\); return; \}/);
});

test('后端: 复用既有的安全闸门, 不自己另写一套', () => {
  assert.match(bcode, /partitionDeletable\(rawPaths\)/,
    '必须走 partitionDeletable —— 它拦 @appcenter/@appdata 等系统目录与卷内回收站');
  assert.match(bcode, /skipped = rawPaths\.length - paths\.length/, '应回报被拦下的数量');
  assert.match(bcode, /blocked: blocked\.slice\(0, 50\)/, '应回报拦截明细, 让前端能如实告知用户');
});

test('后端: 符号链接只删链接, 不动目标', () => {
  // 「无效链接」分区的项就是符号链接。若跟随链接删除, 会连带删掉
  // 链接指向的真实目录 —— 这是灾难性的。renameSync / rmSync 都不跟随,
  // 但必须有测试锁住这个行为, 防止将来换成 cpSync+unlink 之类会跟随的写法。
  assert.match(bcode, /lstatSync/, '应使用 lstat 判断符号链接');
  assert.match(bcode, /renameSync\(fp, finalDest\)/, 'trash 模式用 rename 移动链接本身');
  assert.match(bcode, /rmSync\(fp, \{ recursive: true, force: true \}\)/, 'permanent 模式删除链接本身');
});

test('后端: trash 模式路径不匹配 /volN/UID/ 时报失败而非静默永久删', () => {
  const body = fnBody(bcode, 'trashTarget');
  assert.ok(body, '应有 trashTarget');
  const f = new Function(body + '\nreturn trashTarget;')();
  assert.strictEqual(f('/vol1/1000/a/b.txt'), '/vol1/1000/.@#local/trash/a/b.txt');
  assert.strictEqual(f('/mnt/vol2/1000-1-0985cb1/x'), '/vol2/1000-1-0985cb1/.@#local/trash/x');
  assert.strictEqual(f('/tmp/foo/a.txt'), null, '非 /volN/UID/ 形状必须返回 null');
  assert.strictEqual(f('/etc/passwd'), null);
  // UID 段必须数字开头。放宽成 [^/]+ 时 /vol1/a/b 会把目录名 a 当 UID,
  // 回收站被塞到非 UID 目录里 —— 这条断言就是防这个。
  assert.strictEqual(f('/vol1/a/b'), null, 'UID 段非数字开头, 不能当 UID 用');
  assert.strictEqual(f('/vol1/userdata/b'), null, '目录名不能被误当 UID');
  assert.strictEqual(f('/vol1/1000'), null, '卷根下没有 UID 段, 不能直接进回收站');
  // 网盘 /vol02 建不了 .@#local/trash(fuse 拒绝 mkdir), 必须返回 null —— 与
  // api/trash.js 的 moveToTrash 一致。放行的话会走到 mkdir 抛错, 用户看到"删除失败"。
  assert.strictEqual(f('/vol02/1000-1-abc/深/层/f.mp4'), null,
    '/vol02 是网盘 fuse 挂载, 建不了回收站, 必须拒绝而不是尝试 mkdir');
  assert.strictEqual(f('/mnt/vol02/1000-1-abc/x.bin'), null);
  // 其他卷的带后缀 UID 仍应可用
  assert.strictEqual(f('/vol3/1000-1-abc/x.bin'), '/vol3/1000-1-abc/.@#local/trash/x.bin');
  // null 时 deleteOne 必须抛错, 不能走到 unlink
  const del = fnBody(bcode, 'deleteOne');
  assert.match(del, /if \(!dest\) \{\s*throw new Error\('路径格式不支持回收站/, 'dest 为 null 必须抛错');
});

test('后端: 回收站同名冲突自动改名', () => {
  const body = fnBody(bcode, 'uniqueDest');
  assert.ok(body, '应有 uniqueDest');
  assert.match(body, /while \(existsSync\(cand\)\)/, '冲突时要继续递增, 不能只试一次');
  assert.match(body, /_\$\{counter\}/, '应生成 _1 / _2 后缀');
});

test('后端: 路径已不存在算 gone 而不是失败', () => {
  // 被其他程序移走的文件不该报红 —— 与 dup/bigfiles 的既有行为一致
  const body = fnBody(bcode, 'deleteOne');
  assert.match(body, /return 'gone'/, '不存在的路径应返回 gone');
  const h = fnBody(bcode, 'handleFilesDelete');
  assert.match(h, /else gone\.push\(fp\)/, 'gone 应单独收集');
  assert.match(h, /if \(r === 'deleted'\) deleted\+\+;\s*else gone\.push\(fp\);/, 'gone 不应计入 failed');
});

test('后端: mode 只接受 trash / permanent, 其他值归一化为 trash', () => {
  const h = fnBody(bcode, 'handleFilesDelete');
  assert.match(h, /const mode = data\.mode === 'permanent' \? 'permanent' : 'trash';/,
    '未知 mode 必须回退 trash(最安全的默认), 不能落到永久删除');
});

test('后端: 空 paths 返回 400', () => {
  const h = fnBody(bcode, 'handleFilesDelete');
  assert.match(h, /if \(!rawPaths\.length\) \{[\s\S]{0,80}400/);
});

/* ══════════ 前端: 选择模型 ══════════ */

test('前端: 重名分区按组选择, 副本才可删', () => {
  const body = fnBody(code, 'nmRender');
  assert.ok(body, '应有 nmRender');
  assert.match(body, /const files = g\.files \|\| \[\];/,
    '应先取出组内文件列表');
  assert.match(body, /const dupFiles = files\.slice\(1\);/,
    '必须 slice(1) 保留第一份 —— 这是重名分区的核心安全约束');
  assert.match(body, /data-paths=/, '组 checkbox 要带待删路径数组');
  assert.match(body, /data-keep=/, '要记录保留的那一份(用于提示)');
  assert.match(body, /dupFiles\.length \? '' : 'disabled'/,
    '只有一份的组没有副本可删, 必须 disabled');
});

test('前端: filesCollect 按分区语义分派', () => {
  const body = fnBody(code, 'filesCollect');
  assert.ok(body, '应有 filesCollect');
  // 相似也改成组粒度了: 「相似」与「重名」一样, 组内只需留一份推荐保留的,
  // 逐文件勾选时全选会把每组仅存的那份也删掉。异常仍是文件粒度。
  assert.match(body, /if \(mod === 'namematch' \|\| mod === 'simdup'\)/,
    '相似与重名都应走组粒度');
  assert.match(body, /JSON\.parse\(el\.dataset\.paths/, '重名解析 data-paths');
  assert.match(body, /paths\.push\(el\.dataset\.path\)/, '相似/异常走文件粒度');
  assert.match(body, /Array\.from\(new Set\(paths\.filter\(Boolean\)\)\)/,
    '路径要保序去重 —— 全选时同一文件可能出现在多组');
});

test('前端: 三个分区都有 checkbox 列与删除按钮', () => {
  for (const mod of ['simdup', 'broken', 'namematch']) {
    assert.match(htmlSrc, new RegExp("id=\"" + mod + "DeleteBtn\""), mod + ' 缺删除按钮');
    // 相似是组卡片布局, 没有表头全选框, 改用 HTML 里的「全选各组」按钮
    if (mod === 'simdup') {
      assert.match(htmlSrc, /filesSelectAll\('simdup'\)/, 'simdup 缺全选各组按钮');
      continue;
    }
    assert.ok(htmlSrc.includes('class="fd-cb-all" data-mod="' + mod + '"') ||
              code.includes('fd-cb-all" data-mod="' + mod + '"'),
      mod + ' 缺表头全选框');
  }
  // 每个分区都要有行 checkbox
  // 相似改成组卡片后, checkbox 在组头上(data-group 携带组号), 不再是每行一个
  assert.match(code, /class="fd-cb" data-mod="simdup" data-group=/, 'simdup 组头 checkbox');
  assert.equal((code.match(/class="fd-cb" data-mod="broken"/g) || []).length, 1, 'broken 行 checkbox');
  assert.equal((code.match(/class="fd-cb" data-mod="namematch"/g) || []).length, 1, 'namematch 行 checkbox');
});

test('前端: 三个分区渲染后都要刷新选择计数', () => {
  // 必须断言在**渲染函数体内**, 而不是"文件里出现过" —— brokSwitchCat 也会调
  // filesUpdateSelectInfo('broken'), 只看全文件存在性的话删掉渲染函数里那处
  // 测试照样全绿(注入验证时真的漏过这一项)。
  const cases = [
    ['simDupRenderResult', 'simdup'],
    ['brokRender', 'broken'],
    ['nmRender', 'namematch'],
  ];
  for (const [fn, mod] of cases) {
    const body = fnBody(code, fn);
    assert.ok(body, '应能找到 ' + fn);
    // 三个渲染函数都要**两处**: 空状态分支里一次(那里会提前 return,
    // 末尾那次根本执行不到, 少了它按钮会停留在上一次扫描的数量), 正常分支末尾一次。
    // 断言"至少一处"是不够的 —— 注入验证时删掉其中一处, 测试照样全绿。
    // 统计要排除两类干扰: onchange="filesUpdateSelectInfo('x')" 属性(那是绑定
    // 不是调用), 以及解释这行的注释(否则加了注释就变成 3 处)。
    const n = body.split('\n')
      .filter(l => !/onchange\s*=/.test(l) && !l.trim().startsWith('//'))
      .join('\n')
      .split("filesUpdateSelectInfo('" + mod + "')").length - 1;
    assert.strictEqual(n, 2,
      fn + ' 内应有 2 处 filesUpdateSelectInfo(\'' + mod + '\')'
      + '(空状态分支 + 正常分支末尾), 实际 ' + n);
  }
});

test('前端: 未勾选时删除按钮禁用, 弹窗也打不开', () => {
  const body = fnBody(code, 'filesUpdateSelectInfo');
  assert.match(body, /btn\.disabled = paths\.length === 0/, 'paths 为空时应禁用按钮');
  const open = fnBody(code, 'openFilesDeleteModal');
  assert.match(open, /if \(!paths\.length\) \{ showToast\('请先勾选要删除的文件', 'error'\); return; \}/,
    '空选择应提示并 return, 不能打开空弹窗');
});

test('前端: 表头全选跳过 disabled 的行', () => {
  const body = fnBody(code, 'filesSelectAll');
  assert.match(body, /if \(!el\.disabled\) el\.checked = on/,
    '只有一份的组(disabled)不能被全选勾上 —— 否则会把唯一那份加入待删');
});

test('前端: 表头全选框有半选态', () => {
  const body = fnBody(code, 'filesUpdateSelectInfo');
  assert.match(body, /all\.indeterminate = checked > 0 && checked < total/,
    '部分勾选时应显示半选横杠');
});

/* ══════════ 前端: 确认弹窗 ══════════ */

test('前端: 永久删除需二次勾选确认', () => {
  // 与 bigfiles 的既有模式一致: 光选模式不够, 还要勾"我已确认"
  assert.match(htmlSrc, /id="filesDeleteAck"/);
  assert.match(htmlSrc, /id="filesDeleteConfirmBtn"[^>]*disabled/, '确认按钮初始应禁用');
  const body = fnBody(code, 'filesRefreshConfirmBtn');
  assert.match(body, /btn\.disabled = !\$\('filesDeleteAck'\)\?\.checked/);
  // 每次打开弹窗重置勾选与模式
  const open = fnBody(code, 'openFilesDeleteModal');
  assert.match(open, /if \(ack\) ack\.checked = false/, '打开弹窗应重置确认勾选');
  assert.match(open, /trashRadio\.checked = true/, '打开弹窗应重置为回收站模式(最安全默认)');
});

test('前端: 弹窗展示来源分区/数量/大小/路径预览', () => {
  for (const id of ['filesDeleteSrcLabel', 'filesDeleteCount', 'filesDeleteSize',
                    'filesDeletePaths', 'filesDeleteWarn']) {
    assert.ok(htmlSrc.includes('id="' + id + '"'), '弹窗缺 #' + id);
  }
  const open = fnBody(code, 'openFilesDeleteModal');
  assert.match(open, /paths\.slice\(0, 20\)/, '路径预览应限制条数, 否则几千个文件会卡住弹窗');
  // 代码里是字符串拼接: '>… 另有 ' + (paths.length - 20) + ' 项</div>'
  // 注意这里是字符串结束引号, 不是独立的一对引号, 所以不能带引号去 match
  assert.ok(open.includes('… 另有 ') && open.includes('paths.length - 20') && open.includes(' 项'),
    '超出部分应给出汇总, 避免用户以为只删了前 20 个');
});

test('前端: 分区特有风险提示', () => {
  const open = fnBody(code, 'openFilesDeleteModal');
  assert.match(open, /将保留每组第一份/, '重名要说明保留第一份');
  assert.match(open, /删除的是链接本身/, '异常要说明死链只删链接');
  assert.match(open, /相似文件不等于重复文件/, '相似要提醒先确认');
});

test('前端: 删除后按分区重新扫描刷新', () => {
  const body = fnBody(code, 'confirmFilesDelete');
  assert.match(body, /if \(mod === 'simdup'\) simDupScan\(\);/, '相似应重扫');
  assert.match(body, /else if \(mod === 'broken'\) brokScan\(\);/, '异常应重扫');
  assert.match(body, /else nmScan\(\);/, '重名应重扫');
});

test('前端: 删除结果要如实回报分类计数', () => {
  const body = fnBody(code, 'confirmFilesDelete');
  assert.match(body, /r\.gone\.length/, '已被移走的要单独提示');
  assert.match(body, /r\.blockedCount/, '被安全策略拦截的要提示 —— 用户要知道有没删掉');
  assert.match(body, /r\.failures/, '失败数要提示');
  assert.match(body, /\(r\.failures \|\| r\.blockedCount\) \? 'error' : 'success'/,
    '有失败或拦截时用 error 样式, 不能显示成全成功');
});

test('前端: 所有函数都导出到 window(inline onclick 必需)', () => {
  for (const fn of ['filesCollect', 'filesSelectAll', 'filesUpdateSelectInfo',
                    'openFilesDeleteModal', 'closeFilesDeleteModal',
                    'confirmFilesDelete', 'filesRefreshConfirmBtn']) {
    assert.ok(code.includes(fn), fn + ' 未导出到 window');
  }
});

/* ══════════ CSS ══════════ */

test('CSS: .delete-ack 已定义且变量都存在', () => {
  assert.match(cssSrc, /\.delete-ack\{/, '.delete-ack 样式缺失');
  const defined = new Set([...cssSrc.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  const block = /\.delete-ack\{[^}]*\}/.exec(cssSrc);
  assert.ok(block, '应有 .delete-ack 规则块');
  for (const v of [...block[0].matchAll(/var\((--[\w-]+)/g)].map(m => m[1])) {
    assert.ok(defined.has(v), '.delete-ack 引用了未定义变量 ' + v);
  }
});

test('CSS: 括号配平', () => {
  assert.strictEqual(cssSrc.split('{').length, cssSrc.split('}').length);
});