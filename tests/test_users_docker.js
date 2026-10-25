/**
 * 用户清理 × Docker 占用判据测试
 *
 * 背景：删账号前必须确认这个账号没被 Docker 容器用着。已停止的容器没有进程，
 * 靠「有没有进程在运行」拦不住 —— 删掉账号后容器再起来就写不进挂载目录了。
 *
 * 覆盖三层：
 *   1) classifyUser 纯函数：dockerUse 命中 → 不可删 + 原因里点出容器名
 *   2) dockerUsageByUid 纯函数：三条来源（/proc 运行账号 / Config.User 数字 / 挂载 owner）
 *      + docker 不可用时不静默（available=false）
 *   3) 端到端：GET /api/users 标灰、POST /api/users/delete 服务端拒绝（userdel 不被调用）
 *
 * docker 用 PATH 里的假脚本 mock，绝不碰真实 Docker。
 * Usage: node --test tests/test_users_docker.js
 */
import { test as T, describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 放在 /tmp/fnclearup_test 之下：isSafePath 在 TRM_FNCLEARUP_TEST=1 时只放行这个前缀，
// 这样「应用残余清理里顺手删用户」那条路径也能真跑（否则路径会被过滤成 skipped）。
const TMP = '/tmp/fnclearup_test/users_docker';
const BIN = join(TMP, 'bin');
const FAKE = join(TMP, 'fake');
const PASSWD = join(TMP, 'passwd');
const USERDEL_LOG = join(TMP, 'userdel.log');
const PORT = 47946;
const BASE = `http://127.0.0.1:${PORT}`;

const { parsePasswd, classifyUser, dockerUsageByUid, installedAppDirByUid } = await import('../app/ui/api/users.js');

// 953 = 一个「没有被安装中心接管、没有进程、但被 Docker 容器用着」的账号
// 这正是本次要拦住的场景：改动前它是 deletable=true。
const FIXTURE = [
  'root:x:0:0:root:/root:/bin/bash',
  'package:x:964:901::/home/package:/usr/sbin/nologin',
  'dockered:x:953:901::/home/dockered:/usr/sbin/nologin',
  'plainapp:x:952:901::/home/plainapp:/usr/sbin/nologin',
  'fakereal:x:1001:1001::/home/fakereal:/bin/bash',
].join('\n');

function writeFakeDocker({ ps = '', inspect = '', fail = false }) {
  mkdirSync(FAKE, { recursive: true });
  writeFileSync(join(FAKE, 'ps'), ps);
  writeFileSync(join(FAKE, 'inspect'), inspect);
  if (fail) writeFileSync(join(FAKE, 'ps_fail'), '1');
  else rmSync(join(FAKE, 'ps_fail'), { force: true });
}

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(path, BASE);
    const req = request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, data: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let server = null;
const ORIGINAL_PATH = process.env.PATH || '';

before(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(BIN, { recursive: true });
  mkdirSync(FAKE, { recursive: true });
  writeFileSync(PASSWD, FIXTURE + '\n');

  // 假 docker：ps / inspect 读夹具文件，ps_fail 存在时模拟无权限
  const docker = join(BIN, 'docker');
  writeFileSync(docker, [
    '#!/bin/bash',
    `FAKE="${FAKE}"`,
    'if [ "$1" = "ps" ]; then',
    '  if [ -f "$FAKE/ps_fail" ]; then echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; fi',
    '  cat "$FAKE/ps" 2>/dev/null',
    '  exit 0',
    'fi',
    'if [ "$1" = "inspect" ]; then',
    '  cat "$FAKE/inspect" 2>/dev/null',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(docker, 0o755);

  // 假 userdel：只记账，绝不真删
  const userdel = join(BIN, 'userdel');
  writeFileSync(userdel, ['#!/bin/bash', `echo "$@" >> ${USERDEL_LOG}`, 'exit 0', ''].join('\n'));
  chmodSync(userdel, 0o755);

  // 假 appcenter-cli：所有账号都「没被应用中心托管」，把判断让给 Docker 这一层
  const appcli = join(BIN, 'appcenter-cli');
  writeFileSync(appcli, ['#!/bin/bash', 'exit 1', ''].join('\n'));
  chmodSync(appcli, 0o755);

  // 假 id：夹具账号的 uid/gid（真 id 不认识它们）；其余透传真 id
  const idScript = join(BIN, 'id');
  writeFileSync(idScript, [
    '#!/bin/bash',
    'if [ "$1" = "-u" ] && [ "$2" = "dockered" ]; then echo 953; exit 0; fi',
    'if [ "$1" = "-g" ] && [ "$2" = "dockered" ]; then echo 901; exit 0; fi',
    'if [ "$1" = "-u" ] && [ "$2" = "plainapp" ]; then echo 952; exit 0; fi',
    'if [ "$1" = "-g" ] && [ "$2" = "plainapp" ]; then echo 901; exit 0; fi',
    'exec /usr/bin/id "$@"',
    '',
  ].join('\n'));
  chmodSync(idScript, 0o755);

  // 默认场景：一个停止的容器，用 uid 953 跑（Config.User=953），没有挂载
  writeFakeDocker({ ps: 'cid0000000001', inspect: '/dockerapp||953||false||0||;' });

  await new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['app/ui/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        TRM_PKGVAR: TMP,
        TRM_FNCLEARUP_TEST: '1',
        TRM_PASSWD_FILE: PASSWD,
        PATH: BIN + ':' + ORIGINAL_PATH,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    const timer = setTimeout(() => { if (!started) reject(new Error('server start timeout')); }, 10000);
    server.stdout.on('data', (d) => {
      if (!started && d.toString().includes('listening')) { started = true; clearTimeout(timer); setTimeout(resolve, 300); }
    });
    server.stderr.on('data', () => { /* 测试实例常规日志 */ });
    setTimeout(() => { if (!started) { started = true; clearTimeout(timer); setTimeout(resolve, 800); } }, 2000);
  });
});

after(() => {
  if (server) server.kill('SIGTERM');
  process.env.PATH = ORIGINAL_PATH;
  rmSync(TMP, { recursive: true, force: true });
});

// ─────────────────── 1) classifyUser ───────────────────
describe('classifyUser：Docker 占用', () => {
  const dockered = { name: 'dockered', uid: 953, gid: 901 };

  it('被 Docker 容器使用 → 不可删，原因点出容器名', () => {
    const c = classifyUser(dockered, { dockerUse: { container: 'dockerapp', via: '容器指定 user=953' } });
    assert.strictEqual(c.deletable, false);
    assert.match(c.reason, /Docker/);
    assert.match(c.reason, /dockerapp/);
    assert.match(c.reason, /user=953/);
  });

  it('没有 Docker 占用且其它条件都满足 → 可删（不能误伤）', () => {
    const c = classifyUser(dockered, { dockerUse: null, activeCount: 0 });
    assert.strictEqual(c.deletable, true);
    assert.strictEqual(c.reason, '');
  });

  it('Docker 判断优先级高于「有进程在运行」：原因要说清是被 Docker 占着', () => {
    const c = classifyUser(dockered, { dockerUse: { container: 'dockerapp', via: '' }, activeCount: 3 });
    assert.strictEqual(c.deletable, false);
    assert.match(c.reason, /dockerapp/);
    assert.doesNotMatch(c.reason, /个进程在运行/);
  });

  it('系统账号 + Docker 占用仍按系统账号拦（不因 Docker 改变分类）', () => {
    const c = classifyUser({ name: 'sysacct', uid: 500, gid: 500 }, { dockerUse: { container: 'x', via: '' } });
    assert.strictEqual(c.deletable, false);
    assert.match(c.reason, /系统\/服务账号/);
  });
});

// ─────────────────── 2) dockerUsageByUid ───────────────────
describe('dockerUsageByUid：占用来源', () => {
  it('Config.User 写死数字 uid → 命中', async () => {
    process.env.PATH = BIN + ':' + ORIGINAL_PATH;
    writeFakeDocker({ ps: 'cid1', inspect: '/c1||953||false||0||;' });
    const r = await dockerUsageByUid();
    assert.strictEqual(r.available, true);
    assert.ok(r.map.has(953));
    assert.strictEqual(r.map.get(953).container, 'c1');
    assert.match(r.map.get(953).via, /user=953/);
  });

  it('Config.User 写成用户名 → 不猜（镜像内 /etc/passwd 与宿主不同，宁可漏判）', async () => {
    process.env.PATH = BIN + ':' + ORIGINAL_PATH;
    writeFakeDocker({ ps: 'cid1', inspect: '/c1||appuser||false||0||;' });
    const r = await dockerUsageByUid();
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.map.size, 0);
  });

  it('容器名去掉前导斜杠，多个容器都收进来', async () => {
    process.env.PATH = BIN + ':' + ORIGINAL_PATH;
    writeFakeDocker({
      ps: 'cid1\ncid2',
      inspect: '/alpha||953||false||0||;\n/beta||952||false||0||;',
    });
    const r = await dockerUsageByUid();
    assert.strictEqual(r.map.get(953).container, 'alpha');
    assert.strictEqual(r.map.get(952).container, 'beta');
  });

  it('运行中容器按 /proc/<pid>/status 的真实 uid 归属（穿透镜像内用户名）', async () => {
    process.env.PATH = BIN + ':' + ORIGINAL_PATH;
    // 用当前测试进程自己的 pid：它的真实 uid 一定读得到
    const myUid = process.getuid ? process.getuid() : null;
    if (myUid === null) return;   // 非 POSIX 平台跳过
    writeFakeDocker({ ps: 'cid1', inspect: `/runner||appuser||true||${process.pid}||;` });
    const r = await dockerUsageByUid();
    assert.strictEqual(r.available, true);
    assert.ok(r.map.has(myUid), `应当识别出运行账号 uid=${myUid}`);
    assert.strictEqual(r.map.get(myUid).container, 'runner');
    assert.match(r.map.get(myUid).via, /容器进程运行账号/);
  });

  it('挂载目录 owner → 命中（容器以该 uid 往目录里写文件）', async () => {
    process.env.PATH = BIN + ':' + ORIGINAL_PATH;
    const myUid = process.getuid ? process.getuid() : null;
    if (myUid === null) return;
    const mnt = join(TMP, 'mnt_owner');
    mkdirSync(mnt, { recursive: true });
    writeFakeDocker({ ps: 'cid1', inspect: `/mounter||root||false||0||bind=${mnt};` });
    const r = await dockerUsageByUid();
    assert.ok(r.map.has(myUid), '应当识别出挂载目录 owner');
    assert.match(r.map.get(myUid).via, /挂载目录/);
  });

  it('挂载源已不存在 → 跳过，不抛错', async () => {
    process.env.PATH = BIN + ':' + ORIGINAL_PATH;
    writeFakeDocker({ ps: 'cid1', inspect: '/gone||root||false||0||bind=/tmp/definitely-not-exist-xyz;' });
    const r = await dockerUsageByUid();
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.map.size, 0);
  });

  it('docker 不可用 → available=false 且带原因（不静默当「没占用」）', async () => {
    process.env.PATH = BIN + ':' + ORIGINAL_PATH;
    writeFakeDocker({ fail: true });
    const r = await dockerUsageByUid();
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.map.size, 0);
    assert.match(r.reason, /permission denied/);
  });

  it('没有任何容器 → available=true，空表', async () => {
    process.env.PATH = BIN + ':' + ORIGINAL_PATH;
    writeFakeDocker({ ps: '', inspect: '' });
    const r = await dockerUsageByUid();
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.map.size, 0);
  });
});

// ─────────────────── 3) 端到端 ───────────────────
describe('端到端：Docker 占用的账号删不掉', () => {
  it('GET /api/users：被 Docker 使用的账号标灰，未被使用的仍可删', async () => {
    writeFakeDocker({ ps: 'cid1', inspect: '/dockerapp||953||false||0||;' });
    const r = await httpRequest('GET', '/api/users');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.docker_available, true);

    const dockered = r.data.users.find(u => u.name === 'dockered');
    assert.ok(dockered, '列表里应有 dockered');
    assert.strictEqual(dockered.deletable, false);
    assert.match(dockered.reason, /Docker/);
    assert.ok(dockered.docker, '行数据应带 docker 字段供前端打标记');
    assert.strictEqual(dockered.docker.container, 'dockerapp');

    const plain = r.data.users.find(u => u.name === 'plainapp');
    assert.ok(plain, '列表里应有 plainapp');
    assert.strictEqual(plain.deletable, true, '没被 Docker 用的账号不能被误伤');
    assert.strictEqual(plain.docker, null);
  });

  it('docker 不可用时 docker_available=false，前端据此提示', async () => {
    writeFakeDocker({ fail: true });
    const r = await httpRequest('GET', '/api/users');
    assert.strictEqual(r.data.docker_available, false);
    assert.ok((r.data.docker_error || '').length > 0, '要带出失败原因');
    // 此时不能因为「查不到」就把账号判成可删又判成不可删，只要求不崩、字段齐全
    const dockered = r.data.users.find(u => u.name === 'dockered');
    assert.ok(dockered);
  });

  it('POST /api/users/delete：服务端拒绝，userdel 一次都不调用', async () => {
    writeFakeDocker({ ps: 'cid1', inspect: '/dockerapp||953||false||0||;' });
    rmSync(USERDEL_LOG, { force: true });
    const r = await httpRequest('POST', '/api/users/delete', {
      ack: true,
      users: [{ name: 'dockered', removeHome: false }],
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.failed.length, 1);
    assert.match(r.data.failed[0].reason, /Docker/);
    assert.strictEqual(r.data.deleted.length, 0);
    assert.strictEqual(existsSync(USERDEL_LOG), false, '被 Docker 占用的账号绝不能被 userdel');
  });

  it('POST /api/users/delete：没被 Docker 用的账号照常删除（不因新判据失效）', async () => {
    writeFakeDocker({ ps: 'cid1', inspect: '/dockerapp||953||false||0||;' });
    rmSync(USERDEL_LOG, { force: true });
    const r = await httpRequest('POST', '/api/users/delete', {
      ack: true,
      users: [{ name: 'plainapp', removeHome: false }],
    });
    assert.strictEqual(r.data.deleted.length, 1, 'plainapp 应被删除');
    assert.ok(existsSync(USERDEL_LOG), 'userdel 应当被执行');
    assert.match(readFileSync(USERDEL_LOG, 'utf8'), /plainapp/);
  });
});

// ─────────────────── 4) 另一条删除路径：应用残余清理顺手删用户 ───────────────────
// /api/delete + delete_users=true 也会 userdel。只在「用户清理」页挡住是不够的，
// 否则从「应用残余」进来照样能把 Docker 在用的账号删掉。
describe('端到端：应用残余清理里顺手删用户，同样要过 Docker 判据', () => {
  const sbxDir = (app) => join(TMP, 'sbx', '@appcenter', app);

  it('被 Docker 占用的账号 → users_failed 里说明原因，userdel 不执行', async () => {
    writeFakeDocker({ ps: 'cid1', inspect: '/dockerapp||953||false||0||;' });
    rmSync(USERDEL_LOG, { force: true });
    const dir = sbxDir('dockered');
    mkdirSync(dir, { recursive: true });

    const r = await httpRequest('POST', '/api/delete', {
      paths: [dir], mode: 'permanent', delete_users: true,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.users_deleted.length, 0, '不能删掉被 Docker 使用的账号');
    assert.strictEqual(r.data.users_failed.length, 1);
    assert.match(r.data.users_failed[0], /Docker/);
    assert.match(r.data.users_failed[0], /dockerapp/);
    assert.strictEqual(existsSync(USERDEL_LOG), false, 'userdel 不该被调用');
  });

  it('没被 Docker 占用的账号 → 照常 userdel -r', async () => {
    writeFakeDocker({ ps: 'cid1', inspect: '/dockerapp||953||false||0||;' });
    rmSync(USERDEL_LOG, { force: true });
    const dir = sbxDir('plainapp');
    mkdirSync(dir, { recursive: true });

    const r = await httpRequest('POST', '/api/delete', {
      paths: [dir], mode: 'permanent', delete_users: true,
    });
    assert.strictEqual(r.data.users_deleted.length, 1, 'plainapp 应被删掉');
    assert.match(readFileSync(USERDEL_LOG, 'utf8'), /-r plainapp/);
  });

  it('docker 不可用时不阻断（安全降级），但要照常删目录', async () => {
    writeFakeDocker({ fail: true });
    rmSync(USERDEL_LOG, { force: true });
    const dir = sbxDir('plainapp');
    mkdirSync(dir, { recursive: true });

    const r = await httpRequest('POST', '/api/delete', {
      paths: [dir], mode: 'permanent', delete_users: true,
    });
    assert.strictEqual(r.data.users_deleted.length, 1, 'docker 查不到时不能把正常清理也卡死');
  });
});

// ─────────────────── 5) 已安装应用 ≠ 账号名（app 目录 owner 兜底） ───────────────────
// 真实案例：netease 应用（running）用的账号叫 docker-netease，`id -u netease` 查不到，
// 于是「应用仍在安装中」这条拦不住，账号被误标成可删。app 目录 owner 才是权威判据。
describe('installedAppDirByUid：账号名 ≠ 应用名时的兜底', () => {
  const myUid = process.getuid ? process.getuid() : null;

  it('按 <卷>/@appcenter/<应用名> 的 owner 反查 uid', { skip: myUid === null }, () => {
    const root = join(TMP, 'fakevol');
    mkdirSync(join(root, '@appcenter', 'netease'), { recursive: true });
    const map = installedAppDirByUid(['netease'], [root]);
    assert.ok(map.has(myUid), '应当按目录 owner 反查出 uid');
    assert.strictEqual(map.get(myUid).name, 'netease');
    assert.match(map.get(myUid).dir, /@appcenter\/netease$/);
  });

  it('没装的应用 / 不存在的卷不产出条目', { skip: myUid === null }, () => {
    const root = join(TMP, 'fakevol');
    const map = installedAppDirByUid(['not-installed-xxx'], [root]);
    assert.strictEqual(map.size, 0);
  });

  it('应用名带 / 时跳过（防拼路径穿越）', { skip: myUid === null }, () => {
    const root = join(TMP, 'fakevol');
    const map = installedAppDirByUid(['../../etc'], [root]);
    assert.strictEqual(map.size, 0, '含斜杠的应用名必须忽略');
  });

  it('多个应用同一 owner 时只记第一个（不覆盖）', { skip: myUid === null }, () => {
    const root = join(TMP, 'fakevol');
    mkdirSync(join(root, '@appcenter', 'appA'), { recursive: true });
    mkdirSync(join(root, '@appcenter', 'appB'), { recursive: true });
    const map = installedAppDirByUid(['appA', 'appB'], [root]);
    assert.strictEqual(map.get(myUid).name, 'appA');
  });
});
