import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { handleDelete } from '../app/ui/api/app.js';

const APP_JS = readFileSync(new URL('../app/ui/api/app.js', import.meta.url), 'utf8');

/* ── mock req/res ───────────────────────────────────────────── */
function mockReq(body) {
  const raw = Buffer.from(JSON.stringify(body));
  let pos = 0;
  const stream = {
    on(ev, cb) { if (ev === 'data' && pos === 0) { pos = raw.length; cb(raw); } if (ev === 'end') cb(); },
    resume() {},
    readable: true,
  };
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(raw.length) },
    on: stream.on.bind(stream),
    [Symbol.asyncIterator]: async function* () { yield raw; },
  };
}

function mockRes() {
  const out = { status: null, body: null };
  return {
    statusCode: 200,
    writeHead(s) { out.status = s; return this; },
    setHeader() { return this; },
    end(b) {
      if (b) { try { out.body = JSON.parse(b.toString()); } catch { out.body = b.toString(); } }
      out.done = true;
      return this;
    },
    _out: out,
  };
}

// 一条确定不存在的路径, 但必须能通过 isSafePath (在 /vol* 之下)
const GONE = '/vol3/@appdata/fnc-test-nonexistent-' + process.pid;

/* ══════════════════════════════════════════════════════════════
   回归: TypeError: Assignment to constant variable

   触发条件: 勾选的残余目录里, 至少有一条在扫描之后已被卸载/清理,
             于是 handleDelete 走进 else 分支执行 skipped++。
   原实现把 skipped 声明成 const, 这一行直接抛 TypeError,
   整个 /api/delete 500 —— 用户看到的就是 "Assignment to constant variable"。
   ══════════════════════════════════════════════════════════════ */

test('回归: 路径已不存在时 skipped++ 不再抛 Assignment to constant variable', async () => {
  const res = mockRes();
  await handleDelete(mockReq({ paths: [GONE] }), res);
  assert.ok(res._out.done, '响应应正常结束, 而不是 500');
  assert.strictEqual(res._out.status, 200);
  assert.ok(res._out.body && res._out.body.success, 'success 应为 true');
  assert.strictEqual(res._out.body.skipped, 1, '不存在的路径应计入 skipped');
  assert.strictEqual(res._out.body.deleted.length, 0);
});

test('回归: 不存在路径 + 已通过 isSafePath 过滤掉的路径, skipped 累加正确', async () => {
  const res = mockRes();
  // 第二条是非法路径(应被 isSafePath 过滤), 第一条合法但不存在(应走 else 分支)
  await handleDelete(mockReq({ paths: [GONE, '/etc/passwd'] }), res);
  assert.strictEqual(res._out.status, 200);
  assert.strictEqual(res._out.body.skipped, 2, '过滤掉的 1 条 + 不存在的 1 条');
});

test('回归: delete_users 打开且路径不存在时同样不炸', async () => {
  const res = mockRes();
  await handleDelete(mockReq({ paths: [GONE], delete_users: true }), res);
  assert.strictEqual(res._out.status, 200, '开启删除用户时也不能因为 skipped++ 而 500');
  assert.strictEqual(res._out.body.skipped, 1);
});

test('回归: 用户正则提取路径不存在时跳过, 不影响 skipped 计数', async () => {
  const res = mockRes();
  // /vol3/@appdata/fnc-test-nonexistent-xxx 不匹配 /(@app[^/]+)\/([^/]+)$ 的尾段形式
  await handleDelete(mockReq({
    paths: [GONE],
    delete_users: true,
  }), res);
  assert.strictEqual(res._out.body.users_failed.length, 0);
  assert.strictEqual(res._out.body.users_deleted.length, 0);
});

/* ══════════════════════════════════════════════════════════════
   源码级防线: skipped 必须声明为 let
   这条会在有人改回 const 时立刻 FAIL —— 上面那些行为测试是第二道网。
   ══════════════════════════════════════════════════════════════ */

test('源码防线: skipped 必须是 let 而不是 const', () => {
  assert.ok(
    /\blet\s+skipped\s*=/.test(APP_JS),
    'app.js 里 `const skipped = ...` 会被循环内的 skipped++ 抛 ' +
    'TypeError: Assignment to constant variable, 必须改成 let'
  );
  assert.ok(
    !/\bconst\s+skipped\s*=/.test(APP_JS),
    'app.js 里不允许再出现 const skipped'
  );
});
