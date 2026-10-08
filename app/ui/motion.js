/* ═══════════════════════════════════════════════════════════════════
   motion.js — 动效编排层 (2026-10-02, v0.13.0)
   ═══════════════════════════════════════════════════════════════════
   为什么是独立文件而不是写进 main.js:
     main.js 是传统 <script src> + IIFE(非 ESM, 无 import), 往里塞代码会让
     已经 3375 行的文件继续膨胀, 且这段逻辑与业务无关、应该能被单独测试。
     这里暴露 window.Motion, 由 main.js 的 init() 调一次 Motion.init()。

   为什么用 MutationObserver 而不是改 20+ 个渲染函数:
     扫描结果分别由 renderDupPaths / renderSysCleanList / simDupRenderResult /
     trashScan ... 等一堆函数渲染, 逐个加动画钩子等于改 20 处, 且以后新增
     扫描器必然又漏掉。观察 DOM 变化是唯一能"新增渲染器自动获得动画"的做法。

   性能约束:
     1. 只动 transform / opacity / background-position, 不触发布局重排;
     2. 节流: 一次扫描结果 500 行也只跑一次批处理, 不是 500 次;
     3. prefers-reduced-motion 时整体短路, 不做任何 DOM 写入。
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  var STAGGER_MAX = 20;      // 超过 20 项不再累加延迟, 避免长列表末尾等太久
  var STAGGER_STEP = 18;     // 每项 18ms
  var COUNT_MS = 420;        // 数字滚动时长

  // 结果容器: 这些容器的新增子元素视为"一条扫描结果", 逐条进场
  var LIST_SELECTORS = [
    '[id$="-list"]', '[id$="-results"]', '#dup-list', '#empty-list',
    '#trash-list', '#broken-list', '#bigfiles-list'
  ];
  // 一行结果的常见形态
  var ITEM_SELECTOR = '.file-row, .trash-card, .dup-file-item, .dup-group-header, ' +
                     '.dup-empty-state, [data-stagger-item]';

  var countTimers = new WeakMap();

  /* ── 数字滚动的互斥标志 ──
     ⚠️ 这里必须有互斥, 否则是死循环:
       animateNumber 里写 el.textContent
         → 触发 valueObserver(characterData)
         → observer 又调 animateNumber
         → 再写 textContent …… 无限循环, 直接把渲染进程卡死。
     滚动期间用 data-counting 标记, observer 见到就跳过。 */
  function isSelfWriting(el) { return el.dataset.counting === '1'; }

  function isReduce() { return reduceMotion.matches; }

  /* ── 数字滚动 ──
     只对「纯数字或纯数字+单位」的文本生效, 跳过 "3.2 GiB" 这类已经格式化好的
     字符串(滚动它们没有意义, 且容易与扫描结果的真实值不同步导致误读)。 */
  function parseCountable(text) {
    if (!text) return null;
    var t = String(text).trim();
    // 只允许 纯数字 / 千分位 / 小数 / 结尾的 %
    if (!/^-?[\d,]+(\.\d+)?\s*%?$/.test(t)) return null;
    var n = parseFloat(t.replace(/,/g, ''));
    return isFinite(n) ? { n: n, suffix: t.replace(/^[\d,.\s]+/, '') } : null;
  }

  function animateNumber(el, to, parsed) {
    var prev = countTimers.get(el);
    if (prev) cancelAnimationFrame(prev);
    var from = parseFloat(el.dataset.countFrom || '0');
    if (!isFinite(from)) from = 0;
    el.dataset.countFrom = String(to);
    el.dataset.countFromValue = String(to);   // 供 observer 做同值短路判断

    if (isReduce() || from === to) {
      el.dataset.counting = '1';
      el.textContent = formatNum(to) + parsed.suffix;
      delete el.dataset.counting;      // 同步清掉, MutationObserver 回调在微任务里跑, 已无残留
      return;
    }

    var t0 = performance.now();
    var suffix = parsed.suffix;
    // easeOutExpo: 前段快后段慢, 数字停止加速的观感比线性自然
    el.dataset.counting = '1';          // ← 互斥: observer 见此标志会跳过
    function step(now) {
      var p = Math.min(1, (now - t0) / COUNT_MS);
      var e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      el.textContent = formatNum(Math.round(from + (to - from) * e)) + suffix;
      el.classList.add('is-counting');
      if (p < 1) {
        countTimers.set(el, requestAnimationFrame(step));
      } else {
        countTimers.set(el, 0);
        delete el.dataset.counting;
        setTimeout(function () { el.classList.remove('is-counting'); }, 340);
      }
    }
    countTimers.set(el, requestAnimationFrame(step));
  }

  function formatNum(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* ── stagger: 给一批结果项加序号 ── */
  function applyStagger(root) {
    if (isReduce()) return;
    var items = root.querySelectorAll(ITEM_SELECTOR);
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      if (el.dataset.staggered === '1') continue;
      el.dataset.staggered = '1';
      el.classList.add('stagger-item');
      el.style.setProperty('--i', String(Math.min(i, STAGGER_MAX)));
    }
  }

  /* ── KPI 数字: 监听文本变化 ──
     用 MutationObserver 的 characterData, 而不是每处渲染后手动调 —— 手动调
     就得去改 56 个 kpi-value 的赋值点, 漏一个就少一个动画。 */
  var VALUE_BUDGET = 24;   // 每轮最多处理的 KPI 数量, 见下方说明

  var valueObserver = new MutationObserver(function (records) {
    // 硬保险: 即使上面的互斥标志将来因为重构失效, 单轮也只处理有限条。
    // MutationObserver 回调里再触发自身变更会形成死循环并卡死渲染进程,
    // 加上限之后最坏情况只是"这一帧少滚几个数字", 而不是整页假死。
    if (records.length > VALUE_BUDGET * 8) return;
    var budget = VALUE_BUDGET;
    for (var i = 0; i < records.length && budget > 0; i++) {
      budget--;
      var el = records[i].target;
      if (!el.classList || !el.classList.contains('kpi-value')) continue;
      if (isSelfWriting(el)) continue;            // ← 死循环防线
      var parsed = parseCountable(el.textContent);
      if (!parsed) continue;
      // 目标值与当前记录值相同就不启动动画, 避免「改 A 再改回 A」触发无意义的滚动
      if (Math.abs(el.dataset.countFromValue ? parseFloat(el.dataset.countFromValue) : NaN) === parsed.n) continue;
      animateNumber(el, parsed.n, parsed);
    }
  });

  function attachValueObserver() {
    var nodes = document.querySelectorAll('.kpi-value');
    for (var i = 0; i < nodes.length; i++) {
      valueObserver.observe(nodes[i], { childList: true, characterData: true, subtree: true });
      // 记下初值, 后续滚动从它开始
      var p = parseCountable(nodes[i].textContent);
      if (p) { nodes[i].dataset.countFrom = String(p.n); nodes[i].dataset.countFromValue = String(p.n); }
    }
  }

  /* ── 结果容器观察: 新增子元素时批处理一次 stagger ── */
  var pending = new Set();
  var flushTimer = 0;

  function flush() {
    flushTimer = 0;
    pending.forEach(function (root) {
      try { applyStagger(root); } catch (e) { /* 单个容器失败不影响其他 */ }
    });
    pending.clear();
  }

  function scheduleFlush(root) {
    pending.add(root);
    if (!flushTimer) flushTimer = setTimeout(flush, 40);   // 合并同一帧内的多次变更
  }

  var listObserver = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type !== 'childList' || !r.addedNodes.length) continue;
      // 整块替换(innerHTML 重渲染)直接扫整个容器, 增量追加只扫新节点
      var host = r.target;
      if (host && host.nodeType === 1) scheduleFlush(host);
    }
  });

  function attachListObserver() {
    var roots = document.querySelectorAll(LIST_SELECTORS.join(','));
    for (var i = 0; i < roots.length; i++) {
      listObserver.observe(roots[i], { childList: true });
      applyStagger(roots[i]);      // 首屏已有内容也排一次
    }
  }

  /* ── 进度条运行态: 扫描中加 .is-running 让 CSS 的流光生效 ── */
  var barObserver = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var el = records[i].target;
      if (!el.classList) continue;
      if (el.matches && el.matches('.progress-bar,.progress > .progress-bar')) {
        var busy = el.dataset.running === '1' || /width\s*:/.test(el.getAttribute('style') || '');
        el.classList.toggle('is-running', busy);
      }
    }
  });
  function attachBarObserver() {
    var bars = document.querySelectorAll('.progress-bar,.progress > .progress-bar');
    for (var i = 0; i < bars.length; i++) barObserver.observe(bars[i], { attributes: true });
  }

  /* ── 骨架屏工具: 供后续扫描器接入, 这里只提供渲染函数 ── */
  function skeleton(rows) {
    var n = rows || 3;
    var html = '<div class="skeleton skeleton-block" aria-hidden="true">';
    for (var i = 0; i < n; i++) {
      html += '<div class="skeleton skeleton-row' +
        (i === 0 ? ' is-title' : i === 1 ? ' is-meta' : '') + '"></div>';
    }
    return html + '</div>';
  }
  function showSkeleton(host, rows) {
    if (!host || isReduce()) return;
    host.innerHTML = skeleton(rows);
  }

  var started = false;
  function init() {
    if (started) return;
    started = true;
    attachListObserver();
    attachValueObserver();
    attachBarObserver();
    // 运行中改系统设置时同步降级判定
    if (reduceMotion.addEventListener) {
      reduceMotion.addEventListener('change', function () {
        if (isReduce()) {
          document.querySelectorAll('.stagger-item').forEach(function (el) {
            el.classList.remove('stagger-item');
          });
        }
      });
    }
  }

  window.Motion = {
    init: init,
    skeleton: skeleton,
    showSkeleton: showSkeleton,
    applyStagger: applyStagger,
    parseCountable: parseCountable,
    formatNum: formatNum,
    prefersReduced: isReduce
  };
})();