// 介质自适应并发 (P0) 回归测试 — 2026-09-30
//
// 背景: dup_scan.js 原把哈希 worker 硬编码为 4。本机是双核 CPU +
// 机械盘 RAID1 (WD43PURZ), 固定 4 既超订 CPU 又在机械盘上造成寻道竞争。
// fclones 官方文档建议机械盘用 --threads 1, 报告过 2x~10x 性能差异。
//
// 本测试同时锁死一个已踩过的坑: 必须用 readFileSync 读 rotational,
// 用 statSync 会拿到 fs.Stats 对象, toString() 恒为 "[object Object]",
// 导致所有介质都被误判为固态盘。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..', 'app');
const profileSrc = fs.readFileSync(path.join(APP, 'storage_profile.js'), 'utf8');
const scanSrc = fs.readFileSync(path.join(APP, 'dup_scan.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(APP, 'dup_hash_worker.js'), 'utf8');

test('storage_profile: 判定介质必须用 readFileSync 而非 statSync', () => {
  assert.ok(/readFileSync\(`\$\{SYS_BLOCK\}/.test(profileSrc),
    'rotational 未用 readFileSync 读取');
  assert.ok(!/statSync\(`\$\{SYS_BLOCK\}/.test(profileSrc),
    'rotational 仍在用 statSync — fs.Stats.toString() 会得到 "[object Object]"');
  assert.ok(!/import \{[^}]*statSync/.test(profileSrc),
    'storage_profile 不应再引入 statSync');
});

test('storage_profile: 介质判定为机械盘时并发降为 1', () => {
  const body = profileSrc.slice(profileSrc.indexOf('export function profileFor'));
  assert.ok(/treatAsHDD[\s\S]*?poolSize:\s*1/.test(body),
    '机械盘分支未把 poolSize 设为 1');
  assert.ok(/sawRotational === null && anyUnknown/.test(body),
    '介质无法确定时未保守按机械盘处理');
});

test('storage_profile: 固态盘并发不超过 CPU 核数', () => {
  const body = profileSrc.slice(profileSrc.indexOf('export function profileFor'));
  assert.ok(/poolSize:\s*Math\.min\(4,\s*nCpus\)/.test(body),
    '固态盘分支应取 min(4, 核数), 避免超订');
  assert.ok(/cpus\(\)\.length/.test(profileSrc), '未读取 CPU 核数');
});

test('storage_profile: 混合介质路径取更保守的一侧', () => {
  const body = profileSrc.slice(profileSrc.indexOf('export function profileFor'));
  assert.ok(/anyHdd\s*\|\|/.test(body), '任一路径为机械盘时应整体按机械盘处理');
});

test('storage_profile: PARTIAL_SEGMENT_BYTES 提升到 32KB', () => {
  assert.ok(/PARTIAL_SEGMENT_BYTES\s*=\s*32768/.test(profileSrc),
    'partial 每段采样量应为 32768 (原 4096 区分度不足)');
  assert.ok(/export const PARTIAL_SEGMENT_BYTES/.test(profileSrc),
    'PARTIAL_SEGMENT_BYTES 未导出');
});

test('dup_hash_worker: 引用统一的 partial 段大小常量', () => {
  assert.ok(/import \{ PARTIAL_SEGMENT_BYTES \} from '\.\/storage_profile\.js'/.test(workerSrc),
    'worker 未引用 storage_profile 的 PARTIAL_SEGMENT_BYTES');
  assert.ok(/const PARTIAL_BYTES = PARTIAL_SEGMENT_BYTES;/.test(workerSrc),
    'partial 模式未使用 PARTIAL_SEGMENT_BYTES');
});

/** 取 anchor 之后第一个 { 开始的完整代码块(花括号配对, 跳过字符串里的括号) */
function blockAfter(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error('未找到锚点: ' + anchor);
  let d = 0, started = false;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (ch === "'" || ch === '"' || ch === '`') {   // 跳过字符串字面量
      const q = ch;
      for (k++; k < src.length && src[k] !== q; k++) {
        if (src[k] === '\\') k++;
      }
      continue;
    }
    if (ch === '{') { d++; started = true; }
    else if (ch === '}') { d--; if (started && d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('块未闭合: ' + anchor);
}

test('dup_hash_worker: 仍只做头尾两段(不引入中段采样)', () => {
  // 机械盘上多一次 seek 的成本(数毫秒)远高于多读几十 KB,
  // 所以只允许加大单段长度, 不允许增加采样点。
  // 花括号配对取整块, 不用固定 1400 字符切片 —— 1400 已溢出到无关的
  // ID3 读取逻辑(实测切片尾部是 "// Read ID3 tags before hashing"),
  // 之后 worker 里多插一行 readSync(fd, head 就会被误判成"新增中段采样"。
  const seg = blockAfter(workerSrc, "if (mode === 'partial')");
  const head = (seg.match(/readSync\(fd, head/g) || []).length;
  const tail = (seg.match(/readSync\(fd, tail/g) || []).length;
  assert.ok(head === 1 && tail === 1,
    `partial 应恰好读头尾各一段, 实际 head=${head} tail=${tail}`);
  assert.ok(!/readSync\(fd,\s*\w+,\s*0,\s*PARTIAL_BYTES,\s*st\.size\s*>>/.test(seg),
    '不应新增中段采样 — 机械盘上会多一次寻道');
});

test('dup_scan: worker 数由 storage_profile 推导而非硬编码', () => {
  assert.ok(/import \{ profileFor \} from '\.\/storage_profile\.js'/.test(scanSrc),
    'dup_scan 未引入 storage_profile');
  assert.ok(/WORKER_COUNT = storageProfile\.poolSize/.test(scanSrc),
    'WORKER_COUNT 未按 storageProfile 赋值');
  assert.ok(/let WORKER_COUNT = 4/.test(scanSrc),
    'WORKER_COUNT 应为可覆盖的 let (而非 const)');
  assert.ok(!/const WORKER_COUNT = 4;\s*\n/.test(scanSrc),
    'WORKER_COUNT 仍是硬编码 const');
});

test('dup_scan: 把 storageProfile 写进任务状态, 便于日志核对', () => {
  assert.ok(/storageProfile,/.test(scanSrc), 'state 未携带 storageProfile');
  assert.ok(/哈希并发度=/.test(scanSrc), '未输出并发度推导过程的日志');
});
