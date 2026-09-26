// 应用系统用户删除守卫测试 (canDeleteAppUser)
//
// 背景 bug (2026-09-26): 旧守护只判 `uid < 900`，而实测 fnOS 上
// admin uid=1000 / polkitd uid=995 / systemd-network uid=998 全部 >= 900
// → 守护形同虚设，`userdel -r admin` 会连带删除用户全部数据。
//
// 真实数据来源: 本机 /etc/passwd (2026-09-26 核对)
//   第三方应用账号  uid 944-989  gid=901   ← 唯一该删的目标
//   fnOS 组件账号   uid 960-999  gid=901   ← 同 gid，靠黑名单排除
//   admin           uid=1000     gid=1001
//   polkitd         uid=995      gid=995
//   systemd-network uid=998      gid=998
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canDeleteAppUser, APP_USER_GID, APP_USER_UID_MIN, APP_USER_UID_MAX,
} from '../app/ui/api/app.js';

// 实测快照
const APP_USER = { username: 'fnclearup',   uid: 971, gid: 901 };
const APP_USER2 = { username: 'netwatch',   uid: 949, gid: 901 };
const APP_USER3 = { username: 'dupcleaner', uid: 962, gid: 901 };

describe('canDeleteAppUser — 真实第三方应用账号应放行', () => {
  for (const u of [APP_USER, APP_USER2, APP_USER3]) {
    it(`${u.username}(uid=${u.uid},gid=${u.gid}) 可删`, () => {
      assert.equal(canDeleteAppUser(u).ok, true);
    });
  }
});

describe('canDeleteAppUser — 真实用户 admin 必须拦截 (原 P0)', () => {
  it('admin(uid=1000,gid=1001) 被拦下', () => {
    const v = canDeleteAppUser({ username: 'admin', uid: 1000, gid: 1001 });
    assert.equal(v.ok, false);
    // admin 命中黑名单最优先；若将来移出黑名单，也必须被 uid 上界 / gid 拦下
    assert.match(v.reason, /系统核心账号|uid|gid/);
  });
  it('admin 即使 uid 伪装进区间也靠黑名单+gid 拦下', () => {
    // 极端假设: admin 被人为改成 uid=950/gid=901
    assert.equal(canDeleteAppUser({ username: 'admin', uid: 950, gid: 901 }).ok, false);
  });
});

describe('canDeleteAppUser — 系统服务账号必须拦截', () => {
  const SYS = [
    ['polkitd', 995, 995],
    ['systemd-network', 998, 998],
    ['systemd-timesync', 997, 997],
    ['libvirt-qemu', 64055, 104],
    ['wsdd2', 61623, 61623],
    ['nobody', 65534, 65534],
    ['root', 0, 0],
  ];
  for (const [username, uid, gid] of SYS) {
    it(`${username}(uid=${uid},gid=${gid}) 被拦`, () => {
      assert.equal(canDeleteAppUser({ username, uid, gid }).ok, false);
    });
  }
});

describe('canDeleteAppUser — fnOS 核心组件账号必须拦截', () => {
  const CORE = [
    ['fnos-apps-store', 974, 901],
    ['package', 964, 901],
    ['supervisor', 960, 901],
    ['nodejs_v22', 965, 901],
    ['nodejs_v24', 972, 901],
  ];
  for (const [username, uid, gid] of CORE) {
    it(`${username}(uid=${uid},gid=${gid}) 被黑名单拦下`, () => {
      const v = canDeleteAppUser({ username, uid, gid });
      assert.equal(v.ok, false);
      assert.match(v.reason, /系统核心账号/);
    });
  }
});

describe('canDeleteAppUser — 边界与非法输入', () => {
  it(`uid 下界 ${APP_USER_UID_MIN - 1} 被拒`, () => {
    assert.equal(canDeleteAppUser({ username: 'x', uid: APP_USER_UID_MIN - 1, gid: 901 }).ok, false);
  });
  it(`uid 下界 ${APP_USER_UID_MIN} 放行(gid 正确时)`, () => {
    assert.equal(canDeleteAppUser({ username: 'x', uid: APP_USER_UID_MIN, gid: 901 }).ok, true);
  });
  it(`uid 上界 ${APP_USER_UID_MAX} 被拒(admin 所在)`, () => {
    assert.equal(canDeleteAppUser({ username: 'x', uid: APP_USER_UID_MAX, gid: 901 }).ok, false);
  });
  it(`uid 上界 ${APP_USER_UID_MAX - 1} 放行`, () => {
    assert.equal(canDeleteAppUser({ username: 'x', uid: APP_USER_UID_MAX - 1, gid: 901 }).ok, true);
  });
  it(`gid != ${APP_USER_GID} 一律拒绝(哪怕 uid 合法)`, () => {
    assert.equal(canDeleteAppUser({ username: 'x', uid: 971, gid: 1001 }).ok, false);
  });
  it('uid 非整数拒绝', () => {
    assert.equal(canDeleteAppUser({ username: 'x', uid: NaN, gid: 901 }).ok, false);
    assert.equal(canDeleteAppUser({ username: 'x', uid: '971', gid: 901 }).ok, false);
  });
  it('空用户名拒绝', () => {
    assert.equal(canDeleteAppUser({ username: '', uid: 971, gid: 901 }).ok, false);
  });
  it('以 - 开头的用户名拒绝(防选项注入)', () => {
    const v = canDeleteAppUser({ username: '--help', uid: 971, gid: 901 });
    assert.equal(v.ok, false);
    assert.match(v.reason, /非法/);
  });
});

describe('源码级回归: 旧漏洞不得复现', () => {
  it('handleDelete 不再使用旧的 uid<900 单层守护', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'ui', 'api', 'app.js'), 'utf8');
    assert.ok(!/uid < 900\)/.test(src), '旧的 uid < 900 单层守护仍在');
    assert.ok(src.includes('canDeleteAppUser'), 'handleDelete 未调用 canDeleteAppUser');
    assert.ok(src.includes("id', ['-g'"), '未取 gid');
  });
});
