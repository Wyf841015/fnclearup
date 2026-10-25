/**
 * 用户清理（GET /api/users + POST /api/users/delete）测试
 *
 * 两段：
 *   1) 纯函数单测 —— parsePasswd / classifyUser / isHomeSafeToRemove
 *   2) 端到端 —— 起一个真实 server 实例，用夹具 passwd + mock userdel/appcenter-cli/id
 *      验证「列表分类」和「删除全链路（含 userdel -r 参数）」
 *
 * 为什么要夹具 passwd：本机测试账号是 admin，既不能建用户也不能删用户。
 * users.js 支持 TRM_PASSWD_FILE 指到夹具文件，mock 掉 userdel 只记录参数，
 * 这样「删除成功」这条路径可以真跑，而不是只跑失败分支。
 *
 * Usage: node --test tests/test_users.js
 */
import { test as T, describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/fnclearup_users_test';
const BIN = join(TMP, 'bin');
const PASSWD = join(TMP, 'passwd');
const USERDEL_LOG = join(TMP, 'userdel.log');
const PORT = 47945;   // 47944 被 test_namematch 占用，别撞
const BASE = `http://127.0.0.1:${PORT}`;

const { parsePasswd, classifyUser, isHomeSafeToRemove, SYSTEM_UID_MAX, MAX_DELETE_PER_RUN } =
  await import('../app/ui/api/users.js');

// 夹具账号：系统账号 / 应用账号 / 真实用户 / 应用仍安装 / gid 不对 / 受保护名字
const FIXTURE = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'package:x:964:901::/home/package:/usr/sbin/nologin',
  'installed:x:960:901::/home/installed:/usr/sbin/nologin',
  'fakeapp:x:950:901::/home/fakeapp:/usr/sbin/nologin',
  'badgid:x:955:1234::/home/badgid:/usr/sbin/nologin',
  'fakereal:x:1001:1001::/home/fakereal:/bin/bash',
  'nodir:x:951:901:::/usr/sbin/nologin',
  '',
  '# 注释行会被跳过',
  'broken:only:three:fields',
].join('\n');

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

before(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(BIN, { recursive: true });
  writeFileSync(PASSWD, FIXTURE + '\n');

  // mock userdel：只记录参数，绝不真删
  const userdel = join(BIN, 'userdel');
  writeFileSync(userdel, ['#!/bin/bash', `echo "$@" >> ${USERDEL_LOG}`, 'exit 0', ''].join('\n'));
  chmodSync(userdel, 0o755);

  // mock appcenter-cli：声称 installed 这个应用已安装
  const appcli = join(BIN, 'appcenter-cli');
  writeFileSync(appcli, [
    '#!/bin/bash',
    'if [ "$1" = "list" ]; then',
    "  echo 'APPNAME   │ DISPLAY  │ VERSION'",
    "  echo 'installed │ 假应用   │ 1.0.0'",
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(appcli, 0o755);

  // mock id：夹具账号 installed(960) 能查到 uid，其余交给真 id
  const idScript = join(BIN, 'id');
  writeFileSync(idScript, [
    '#!/bin/bash',
    'if [ "$1" = "-u" ] && [ "$2" = "installed" ]; then echo 960; exit 0; fi',
    'exec /usr/bin/id "$@"',
    '',
  ].join('\n'));
  chmodSync(idScript, 0o755);

  await new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['app/ui/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        TRM_PKGVAR: TMP,
        TRM_FNCLEARUP_TEST: '1',
        TRM_PASSWD_FILE: PASSWD,                       // 用夹具账号库
        PATH: BIN + ':' + (process.env.PATH || ''),    // mock userdel / appcenter-cli / id
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    const timer = setTimeout(() => { if (!started) reject(new Error('server start timeout')); }, 10000);
    server.stdout.on('data', (d) => {
      if (!started && d.toString().includes('listening')) { started = true; clearTimeout(timer); setTimeout(resolve, 300); }
    });
    server.stderr.on('data', () => { /* 忽略：测试实例的常规日志 */ });
    setTimeout(() => { if (!started) { started = true; clearTimeout(timer); setTimeout(resolve, 800); } }, 2000);
  });
});

after(() => {
  if (server) server.kill('SIGTERM');
  rmSync(TMP, { recursive: true, force: true });
});

// ───────────────────────── 纯函数 ─────────────────────────
describe('用户清理：纯函数', () => {
  it('parsePasswd 跳过注释/坏行，字段解析正确', () => {
    const list = parsePasswd(FIXTURE);
    const names = list.map(u => u.name);
    assert.deepStrictEqual(names, ['root', 'daemon', 'package', 'installed', 'fakeapp', 'badgid', 'fakereal', 'nodir']);
    const fake = list.find(u => u.name === 'fakeapp');
    assert.strictEqual(fake.uid, 950);
    assert.strictEqual(fake.gid, 901);
    assert.strictEqual(fake.home, '/home/fakeapp');
    const nodir = list.find(u => u.name === 'nodir');
    assert.strictEqual(nodir.home, '');
  });

  it('classifyUser: root / 受保护 / 系统账号一律不可删', () => {
    assert.strictEqual(classifyUser({ name: 'root', uid: 0, gid: 0 }).deletable, false);
    assert.strictEqual(classifyUser({ name: 'package', uid: 964, gid: 901 }).deletable, false);
    // daemon 在 PROTECTED_USERS 里（走「核心账号」分支），这里用没被点名保护的系统账号
    const sys = classifyUser({ name: 'lp', uid: 7, gid: 7 });
    assert.strictEqual(sys.deletable, false);
    assert.match(sys.reason, /系统\/服务账号/);
    assert.strictEqual(classifyUser({ name: 'daemon', uid: 1, gid: 1 }).deletable, false);
  });

  it('classifyUser: 应用仍在安装中 → 不可删（并说明是哪个应用）', () => {
    const c = classifyUser({ name: 'installed', uid: 960, gid: 901 }, { installedApp: 'installed' });
    assert.strictEqual(c.deletable, false);
    assert.match(c.reason, /仍在安装中/);
    assert.match(c.reason, /installed/);
  });

  it('classifyUser: 有进程在运行 → 不可删', () => {
    const c = classifyUser({ name: 'fakeapp', uid: 950, gid: 901 }, { activeCount: 3 });
    assert.strictEqual(c.deletable, false);
    assert.match(c.reason, /3 个进程/);
  });

  it('classifyUser: gid 不是 901 的应用账号 → 不可删；正常应用账号/真实用户 → 可删', () => {
    assert.strictEqual(classifyUser({ name: 'badgid', uid: 955, gid: 1234 }).deletable, false);
    assert.strictEqual(classifyUser({ name: 'fakeapp', uid: 950, gid: 901 }).deletable, true);
    assert.strictEqual(classifyUser({ name: 'fakereal', uid: 1001, gid: 1001 }).deletable, true);
  });

  it('classifyUser: 目录仍在（ownedDir）只作为提示，不影响可删', () => {
    const c = classifyUser({ name: 'fakeapp', uid: 950, gid: 901 }, { ownedDir: '/vol3/@appcenter/fakeapp' });
    assert.strictEqual(c.deletable, true);
    assert.match(c.warn, /\/vol3\/@appcenter\/fakeapp/);
  });

  it('isHomeSafeToRemove 拒绝根目录/系统目录/卷根，只放过具体家目录', () => {
    for (const bad of ['', '/', '/home', '/root', '/vol3', '/vol02', '/usr', 'relative/path']) {
      assert.strictEqual(isHomeSafeToRemove(bad), false, bad + ' 不应允许 -r');
    }
    for (const ok of ['/home/fakeapp', '/home/EmbyServer', '/vol2/1000/someone']) {
      assert.strictEqual(isHomeSafeToRemove(ok), true, ok + ' 应允许 -r');
    }
  });
});

// ───────────────────────── 端到端 ─────────────────────────
describe('用户清理：API', () => {
  it('GET /api/users 返回分类正确、默认数据齐全', async () => {
    const { status, data } = await httpRequest('GET', '/app/fnclearup/api/users');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.success, true);
    const m = new Map(data.users.map(u => [u.name, u]));
    assert.strictEqual(m.get('root').deletable, false);
    assert.strictEqual(m.get('daemon').kind, 'system');
    assert.strictEqual(m.get('installed').deletable, false, '应用仍在安装的账号不该可删');
    assert.match(m.get('installed').reason, /仍在安装/);
    assert.strictEqual(m.get('fakeapp').deletable, true);
    assert.strictEqual(m.get('fakeapp').kind, 'app');
    assert.strictEqual(m.get('fakereal').kind, 'user');
    assert.strictEqual(m.get('nodir').home_removable, false, '空家目录不能 -r');
    assert.strictEqual(m.get('fakeapp').home_removable, true);
    // stats 与实际列表一致
    assert.strictEqual(data.stats.total, data.users.length);
    assert.strictEqual(data.stats.deletable, data.users.filter(u => u.deletable).length);
    // 按 uid 升序
    const uids = data.users.map(u => u.uid);
    assert.deepStrictEqual(uids, [...uids].sort((a, b) => a - b));
  });

  it('POST /api/users/delete 缺少 ack → 400（前端必须确认过）', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/users/delete', { users: [{ name: 'fakeapp' }] });
    assert.strictEqual(status, 400);
    assert.strictEqual(data.success, false);
    assert.match(data.error, /确认标记/);
  });

  it('POST /api/users/delete 拒绝系统/受保护/已安装账号，不调用 userdel', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/users/delete', {
      ack: true,
      users: [{ name: 'root' }, { name: 'package' }, { name: 'installed' }],
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.deleted.length, 0);
    assert.strictEqual(data.failed.length, 3);
    const reasons = data.failed.map(f => f.reason).join(' | ');
    assert.match(reasons, /root 账号/);
    assert.match(reasons, /核心账号/);
    assert.match(reasons, /仍在安装/);
    assert.strictEqual(existsSync(USERDEL_LOG), false, '被拒绝的账号不该触发 userdel');
  });

  it('POST /api/users/delete 删除可删账号：默认不带 -r，勾了才带 -r', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/users/delete', {
      ack: true,
      users: [
        { name: 'fakeapp', removeHome: false },
        { name: 'fakereal', removeHome: true },
        { name: 'nodir', removeHome: true },     // 家目录为空 → 不允许 -r
      ],
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.deleted.length, 3);
    assert.strictEqual(data.failed.length, 0);
    const log = readFileSync(USERDEL_LOG, 'utf8').trim().split('\n');
    assert.ok(log.includes('fakeapp'), 'fakeapp 应原样 userdel：' + log.join(','));
    assert.ok(log.includes('-r fakereal'), 'fakereal 应带 -r：' + log.join(','));
    assert.ok(log.includes('nodir'), 'nodir 家目录为空，不该带 -r：' + log.join(','));
    const fake = data.deleted.find(d => d.name === 'fakeapp');
    assert.strictEqual(fake.home_removed, false);
    const real = data.deleted.find(d => d.name === 'fakereal');
    assert.strictEqual(real.home_removed, true);
    assert.strictEqual(real.home, '/home/fakereal');
  });

  it('POST /api/users/delete 超过单次上限 → 400', async () => {
    const many = Array.from({ length: MAX_DELETE_PER_RUN + 1 }, (_, i) => ({ name: 'u' + i }));
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/users/delete', { ack: true, users: many });
    assert.strictEqual(status, 400);
    assert.match(data.error, /一次最多/);
  });

  it('POST /api/users/delete 不存在/非法用户名：跳过或拒绝，不出错', async () => {
    const { status, data } = await httpRequest('POST', '/app/fnclearup/api/users/delete', {
      ack: true,
      users: [{ name: 'nosuchuser' }, { name: '../etc/passwd' }, { name: '' }],
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.deleted.length, 0);
    assert.ok(data.skipped.some(s => s.name === 'nosuchuser'));
    assert.ok(data.failed.some(f => f.reason === '用户名非法'));
  });
});
