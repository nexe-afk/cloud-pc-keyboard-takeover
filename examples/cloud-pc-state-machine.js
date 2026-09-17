/* cloud-pc-state-machine.js - 顺网云电脑(网页版) 状态机识别 + 帧存活门控 + 自动进桌面
 * 用法: 进入 /gamputer/web/cloud 后粘贴执行, 然后:
 *        await __state.scan()             // 识别当前处于哪个界面
 *        await __state.ensureDesktop()    // 自动点按钮直到进入桌面(最多 6 步)
 *        await __state.probe({frames:6})  // 帧存活门控 + 像素差分探针
 *
 * 实测到的界面状态(四态 + 桌面):
 *   INSTANCE_PANEL  '进入桌面' 与 '结束订单' 同屏          -> 点「进入桌面」
 *   RECONNECT       正文含 '连接失败，请重新连接'           -> 点「重新连接」(约 4s 恢复, 不用刷新)
 *   LANDING         DOM 出现 '点击开始游戏', 画面静止但非黑 -> 点「点击开始游戏」
 *   TIME_LOW        正文含 '您的可用时长不足'               -> 先关掉弹窗(它会挡交互)
 *   DESKTOP         airLinks.pc 非空 + video readyState=4   -> 就绪
 *
 * 三条硬规则(踩过的坑):
 *  1) pc 为真 + readyState=4 不等于进了桌面 -- 传输层活着但渲染可能停帧。必须过帧存活门控。
 *  2) 门控不过(maxNoisePx===0)时, 任何像素探针结论都作废, 禁止下结论。
 *  3) DOM 关键字必须用包含判断, 按钮常包嵌套 span, 按叶子节点精确匹配会漏。
 *  4) 单次 page_eval 控在 10s 内, 阻塞式长调用会打断站点信令心跳导致掉线。
 */
(function () {
  'use strict';
  var STATE = {
    INSTANCE_PANEL: 'INSTANCE_PANEL', RECONNECT: 'RECONNECT', LANDING: 'LANDING',
    TIME_LOW: 'TIME_LOW', DESKTOP: 'DESKTOP', LOADING: 'LOADING', UNKNOWN: 'UNKNOWN'
  };

  function pc() { return window.airLinks && window.airLinks.pc; }
  function video() {
    var p = pc();
    var v = (p && p.videoElement) || null;
    if (!v) { var list = document.querySelectorAll('video'); if (list.length === 1) v = list[0]; }
    return v;
  }
  function txt() { return (document.body && document.body.innerText) || ''; }
  function has(s) { return txt().indexOf(s) >= 0; }

  // 找可见且文本包含 s 的可点元素(按钮/链接/div 都可能, 不假定标签)
  function findClickable(s) {
    var all = document.querySelectorAll('button,a,div,span,li,input[type=button],input[type=submit]');
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = (el.innerText || el.value || '').trim();
      if (t.indexOf(s) < 0) continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      var st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
      hits.push({ el: el, area: r.width * r.height, text: t.slice(0, 40) });
    }
    hits.sort(function (a, b) { return a.area - b.area; });  // 取最内层命中
    return hits.length ? hits[0] : null;
  }

  async function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function scan() {
    var p = pc(), v = video();
    var out = { state: STATE.UNKNOWN, evidence: {}, buttons: [] };
    out.evidence = {
      hasAirLinks: typeof window.airLinks === 'object' && window.airLinks !== null,
      hasPc: !!p,
      readyState: v ? v.readyState : null,
      paused: v ? v.paused : null,
      currentTime: v ? Number(v.currentTime.toFixed(2)) : null,
      videoW: v ? v.videoWidth : null,
      videoH: v ? v.videoHeight : null,
      videoCount: document.querySelectorAll('video').length,
      textLen: txt().length
    };
    var probes = [['进入桌面', 'enter'], ['结束订单', 'endOrder'], ['重新连接', 'reconnect'],
                  ['点击开始游戏', 'startGame'], ['开始游戏', 'startGame2'], ['进入游戏', 'enterGame'],
                  ['可用时长不足', 'timeLow'], ['连接失败', 'connFailed'], ['正在重连', 'reconnecting']];
    for (var i = 0; i < probes.length; i++) {
      var hit = findClickable(probes[i][0]);
      if (hit) out.buttons.push({ label: probes[i][0], key: probes[i][1], text: hit.text });
    }

    if (has('可用时长不足')) out.state = STATE.TIME_LOW;
    else if (has('连接失败') || findClickable('重新连接')) out.state = STATE.RECONNECT;
    else if (findClickable('进入桌面') && findClickable('结束订单')) out.state = STATE.INSTANCE_PANEL;
    else if (findClickable('点击开始游戏') || findClickable('开始游戏') || findClickable('进入游戏')) out.state = STATE.LANDING;
    else if (!!p && v && v.readyState === 4) out.state = STATE.DESKTOP;
    else if (has('正在重连')) out.state = STATE.LOADING;
    return out;
  }

  // ---- 像素探针 + 帧存活门控 ----
  var _cv = null, _ctx = null;
  function grab() {
    var v = video();
    if (!v || !v.videoWidth) return null;
    if (!_cv) { _cv = document.createElement('canvas'); _ctx = _cv.getContext('2d', { willReadFrequently: true }); }
    var W = 160, H = 90; // 小尺寸够做差分且快
    if (_cv.width !== W) { _cv.width = W; _cv.height = H; }
    try { _ctx.drawImage(v, 0, 0, W, H); } catch (e) { return { err: String(e) }; }
    var d = _ctx.getImageData(0, 0, W, H).data;
    var sum = 0, n = W * H, px = new Uint8Array(n);
    for (var i = 0, j = 0; i < d.length; i += 4, j++) {
      var g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      sum += g; px[j] = g | 0;
    }
    var mean = sum / n, vs = 0;
    for (var k = 0; k < n; k++) { var dv = px[k] - mean; vs += dv * dv; }
    return { mean: +mean.toFixed(3), std: +Math.sqrt(vs / n).toFixed(3), px: px, w: W, h: H };
  }
  function diff(a, b) {
    if (!a || !b || !a.px || !b.px) return null;
    var n = a.px.length, sum = 0, cnt = 0;
    for (var i = 0; i < n; i++) { var d = Math.abs(a.px[i] - b.px[i]); sum += d; if (d > 8) cnt++; }
    return { mean: +(sum / n).toFixed(3), px: cnt, pct: +(cnt * 100 / n).toFixed(2) };
  }

  async function probe(opt) {
    opt = opt || {};
    var frames = opt.frames || 6, gap = opt.gap || 120;
    var snaps = [];
    for (var i = 0; i < frames; i++) { var s = grab(); if (s && !s.err) snaps.push(s); await sleep(gap); }
    if (snaps.length < 2) return { ok: false, reason: 'no-video-frame', snaps: snaps.length };
    var noise = [], maxPx = 0;
    for (var j = 1; j < snaps.length; j++) { var d = diff(snaps[j - 1], snaps[j]); if (d) { noise.push(d); if (d.px > maxPx) maxPx = d.px; } }
    var meanSum = 0, stdSum = 0;
    for (var m = 0; m < snaps.length; m++) { meanSum += snaps[m].mean; stdSum += snaps[m].std; }
    var res = {
      frames: snaps.length,
      brightness: +(meanSum / snaps.length).toFixed(3),
      std: +(stdSum / snaps.length).toFixed(3),
      maxNoisePx: maxPx,
      noise: noise,
      black: (meanSum / snaps.length) < 8
    };
    res.frameLive = maxPx > 0;
    res.measurementValid = res.frameLive;
    if (!res.frameLive) res.reason = 'FROZEN: 帧完全未变(即使 currentTime 在走)。像素探针无效, 禁止下结论。';
    return res;
  }

  // ---- 自动进桌面 ----
  async function clickLabel(s) {
    var hit = findClickable(s);
    if (!hit) return { ok: false, reason: 'not-found:' + s };
    var r = hit.el.getBoundingClientRect();
    var opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    hit.el.dispatchEvent(new MouseEvent('mousedown', opts));
    hit.el.dispatchEvent(new MouseEvent('mouseup', opts));
    hit.el.dispatchEvent(new MouseEvent('click', opts));
    if (typeof hit.el.click === 'function') { try { hit.el.click(); } catch (e) {} }
    return { ok: true, clicked: hit.text };
  }

  async function ensureDesktop(opt) {
    opt = opt || {};
    var maxSteps = opt.maxSteps || 6, log = [];
    for (var step = 0; step < maxSteps; step++) {
      var s = await scan();
      log.push({ step: step, state: s.state, buttons: s.buttons.map(function (b) { return b.label; }) });
      if (s.state === STATE.DESKTOP) {
        var pr = await probe({ frames: opt.frames || 5 });
        log[log.length - 1].probe = { frameLive: pr.frameLive, maxNoisePx: pr.maxNoisePx, brightness: pr.brightness };
        return { ok: true, state: s.state, probe: pr, log: log };
      }
      if (s.state === STATE.TIME_LOW) {
        var c = findClickable('关闭') || findClickable('确定') || findClickable('我知道了');
        if (c) { await clickLabel(c.text); await sleep(600); }
        else { log[log.length - 1].note = '时长不足弹窗, 未找到关闭按钮, 需人工续时'; return { ok: false, state: s.state, log: log }; }
        continue;
      }
      if (s.state === STATE.RECONNECT) { await clickLabel('重新连接'); await sleep(opt.reconnectWait || 5000); continue; }
      if (s.state === STATE.INSTANCE_PANEL) { await clickLabel('进入桌面'); await sleep(opt.enterWait || 6000); continue; }
      if (s.state === STATE.LANDING) { await clickLabel('点击开始游戏'); await sleep(opt.startWait || 6000); continue; }
      await sleep(opt.idleWait || 3000);
    }
    return { ok: false, reason: 'max-steps', log: log };
  }

  window.__state = {
    S: STATE, scan: scan, probe: probe, grab: grab, diff: diff,
    ensureDesktop: ensureDesktop, clickLabel: clickLabel, findClickable: findClickable,
    ready: async function () {
      var s = await scan();
      if (s.state !== STATE.DESKTOP) return { ok: false, state: s.state };
      var pr = await probe({ frames: 5 });
      return { ok: !!pr.measurementValid, state: s.state,
               probe: { brightness: pr.brightness, maxNoisePx: pr.maxNoisePx, frameLive: pr.frameLive },
               check: window.__takeover ? window.__takeover.check() : null };
    }
  };
  console.log('[state] ready. try: __state.scan() / __state.ensureDesktop()');
  return { ok: true };
})();
