// QQ群号复制 — 源码级回归测试
//
// 背景 (2026-09-26): 用户两次报"复制群号没反应"。
//   第1次根因: copyQQNumber 未 export 到 window → inline onclick 静默 ReferenceError
//   第2次根因: fnOS WebView 走 http(非安全上下文) navigator.clipboard 为 undefined,
//              旧 fallback 用 ta.select() 但不 focus, CEF 里 select 失败,
//              且 execCommand 失败时旧代码无任何 UI 反馈 → 完全静默
//
// 注: 不用 happy-dom 跑真实复制路径 —— 该环境对 textarea.select /
// execCommand / getSelection 支持不完整, 模拟结果不可信(实测插桩跑不到分支)。
// 改为锁定源码结构, 真实行为在 fnOS WebView 里人工验证。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'ui');
const MAIN = readFileSync(join(UI_DIR, 'main.js'), 'utf8');
const HTML = readFileSync(join(UI_DIR, 'index.html'), 'utf8');

describe('copyQQNumber — 必须导出到 window', () => {
  it('在 exports 块中', () => {
    const start = MAIN.indexOf('const exports');
    assert.ok(start > 0, '未找到 exports 块');
    const block = MAIN.slice(start, MAIN.indexOf('};', start));
    assert.ok(new RegExp(`(?:^|\\n|,\\s*|\\s)copyQQNumber\\s*[,}]`).test(block),
      'copyQQNumber 未 export → inline onclick 静默 ReferenceError');
  });
  it('index.html 的复制按钮确实用 inline onclick 调用它', () => {
    assert.ok(HTML.includes('onclick="copyQQNumber()"'), 'HTML 未通过 inline onclick 调用');
  });
});

describe('copyQQNumber — 三级降级链必须完整', () => {
  it('第1级 navigator.clipboard.writeText', () => {
    assert.ok(/navigator\.clipboard\s*&&\s*navigator\.clipboard\.writeText/.test(MAIN));
  });
  it('第2级 execCommand 兜底且先 focus()（CEF select 前提）', () => {
    assert.ok(/ta\.focus\(\)/.test(MAIN), 'execFallback 缺 focus() → CEF 下 select() 失败');
    assert.ok(/ta\.select\(\)/.test(MAIN));
    assert.ok(/ta\.setSelectionRange\(/.test(MAIN));
    assert.ok(/document\.execCommand\('copy'\)/.test(MAIN));
  });
  it('第3级 手动选中兜底（最后手段）', () => {
    assert.ok(/selectNodeContents/.test(MAIN), '缺手动选中兜底');
    assert.ok(/manualFallback/.test(MAIN));
  });
  it('writeText 拒绝时降级到 execFallback', () => {
    assert.ok(/\.catch\(execFallback\)/.test(MAIN), 'clipboard 拒绝后未降级');
  });
});

describe('copyQQNumber — 绝不静默失败', () => {
  it('成功与失败都有可见文字反馈', () => {
    assert.ok(/ok \? '✓ 已复制' : '复制失败/.test(MAIN), '缺成功/失败双路反馈');
  });
  it('失败时选中文本让用户可手动复制', () => {
    assert.ok(/addRange/.test(MAIN), '失败时未选中文本');
  });
  it('临时 textarea 必被清理（不残留 DOM）', () => {
    assert.ok(/ta\.remove\(\)/.test(MAIN), '临时 textarea 未清理');
  });
  it('外层 try/catch 兜住同步抛错', () => {
    const fn = MAIN.slice(MAIN.indexOf('function copyQQNumber('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(/catch \(e\) \{ execFallback\(\); \}/.test(body),
      '缺少外层 catch → 同步异常会中断整个点击处理');
  });
  it('execFallback / manualFallback 内部各自兜住异常', () => {
    assert.ok(MAIN.includes('catch (e) { /* 落到 manualFallback */ }'),
      'execFallback 缺内部兜底');
    assert.ok(MAIN.includes('catch (e) { /* ignore — 反馈仍要给 */ }'),
      'manualFallback 缺内部兜底');
  });
});

describe('rewire 绑定方式 — CEF 兼容性', () => {
  it('使用 DOM-0 (el.onclick=) 而非 addEventListener', () => {
    assert.ok(/el\.onclick = function\(e\)/.test(MAIN), 'rewire 未用 DOM-0 绑定');
    assert.ok(!/el\.addEventListener\('click', function\(e\)/.test(MAIN),
      'rewire 仍用 addEventListener（fnOS WebView 下可能不触发）');
  });
  it('带幂等标记 __rewired，避免重复绑定', () => {
    assert.ok(/if \(el\.__rewired\) return;/.test(MAIN), 'rewire 缺幂等保护');
    assert.ok(/el\.__rewired = true;/.test(MAIN));
  });
  it('绑定后移除原生 onclick 属性', () => {
    assert.ok(/el\.removeAttribute\('onclick'\)/.test(MAIN));
  });
});
