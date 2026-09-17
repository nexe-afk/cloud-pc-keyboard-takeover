/* cloud-pc-state-machine.js v2 - 顺网云电脑(网页版) 状态机识别 + 存活门控 + 自动进桌面
 * 用法: 进入 /gamputer/web/cloud 后注入, 然后:
 *        await __state.scan()            // 当前处于哪个界面
 *        await __state.enter()           // 自动点按钮直到进入桌面(含每步复验)
 *        await __state.liveness()        // 存活判据(看播放态)
 *        await __state.positiveControl() // 正向对照: Win键 -> 画面是否响应
 *
 * ===== 实测状态表(全部现场验证过) =====
 *   IDLE            未上机: 有『启动云电脑』/多个『快速启动』, 无 video
 *   INSTANCE_PANEL  已上机未进桌面: 实例卡片出现, 但 video 未起或 start-tip 可见
 *   LANDING         视频已出流, 但 start-tip 覆盖层可见(『点击开始游戏』)  <-- 必须先于点它!
 *   DESKTOP         真正进桌面: pc 在 + video 播放中 + start-tip 隐藏
 *   RECONNECTING    『正在重连中...』: pc 变 null, videoCount 归零
 *   RECONNECT       弹窗『连接失败，请重新连接』+ 按钮『重新连接』
 *   TIME_LOW        『您的可用时长不足 N 分钟』
 *
 * ===== 三个决定性教训(前几轮踩坑, 已修正) =====
 *  1) ★ 不能拿像素变化当"帧死没死"的判据。静止的 Windows 桌面本就不会产生新帧
 *     (WebRTC 编码器无变化不发帧 => requestVideoFrameCallback 恒 0, 像素逐字节相同)。
 *     存活门控必须看播放态: video.readyState>=2 && !video.paused && videoWidth>0。
 *     而"输入是否真的到达远端"只能靠【正向对照】: 发 Win 键, 若画面有显著变化则通路可用。
 *  2) ★ 『进入桌面』『结束订单』是实例卡片上的常驻元素, 进桌面后 DOM 里依然存在!
 *     绝不能用它俩判断状态 —— 曾导致扫描连续 6 轮误判为 INSTANCE_PANEL 而空转。
 *     真判据是 start-tip 覆盖层是否可见。
 *  3) start-tip 选择器: [class*=start-tip] 容器(内含 [class*=start-tip-content])。
 *     元素常驻但会隐藏(0x0), 必须用 getBoundingClientRect().width>0 判可见。
 */
(function () {
  'use strict';
  var STATE = {
    IDLE: 'IDLE', INSTANCE_PANEL: 'INSTANCE_PANEL', LANDING: 'LANDING', DESKTOP: 'DESKTOP',
    RECONNECTING: 'RECONNECTING', RECONNECT: 'RECONNECT', TIME_LOW: 'TIME_LOW', UNKNOWN: 'UNKNOWN'
  };

  function pc() { return window.airLinks && window.airLinks.pc; }
  function vid() {
    var p = pc();
    return (p && p.videoElement) || document.querySelector('video') || null;
  }
  function txt() { return (document.body && document.body.innerText) || ''; }
  function has(s) { return txt().indexOf(s) >= 0; }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0;
  }
  function startTipVisible() { return visible(document.querySelector('[class*=start-tip]')); }
  function reconnecting() { return has('正在重连'); }

  function findClickable(s) {
    var all = document.querySelectorAll('button,a,div,span,li,input[type=button],input[type=submit]');
    var best = null, bestArea = Infinity;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = (el.innerText || el.value || '').trim();
      if (t.indexOf(s) < 0) continue;
      if (t.length > s.length * 6) continue;
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect(), a = r.width * r.height;
      if (a < bestArea) { bestArea = a; best = el; }
    }
    return best;
  }
  async function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function liveness() {
    var v = vid();
    if (!v) return { alive: false, reason: 'no-video-element' };
    return { alive: v.readyState >= 2 && !v.paused && v.videoWidth > 0,
             readyState: v.readyState, paused: v.paused, videoW: v.videoWidth, videoH: v.videoHeight };
  }
  function desktopReady() {
    if (!pc()) return false;
    if (startTipVisible()) return false;
    if (reconnecting() || has('连接失败')) return false;
    return liveness().alive;
  }

  async function scan() {
    var v = vid();
    var st = { state: STATE.UNKNOWN, evidence: {
        hasAirLinks: typeof window.airLinks === 'object' && window.airLinks !== null,
        hasPc: !!pc(), videoCount: document.querySelectorAll('video').length,
        readyState: v ? v.readyState : null, paused: v ? v.paused : null,
        videoW: v ? v.videoWidth : null, videoH: v ? v.videoHeight : null,
        startTipVisible: startTipVisible(), reconnecting: reconnecting(), textLen: txt().length
      }, buttons: [] };
    var labels = ['启动云电脑','快速启动','进入桌面','结束订单','返回桌面','重新连接','点击开始游戏','开始游戏','进入游戏','可用时长不足','连接失败'];
    for (var i = 0; i < labels.length; i++) if (findClickable(labels[i])) st.buttons.push(labels[i]);

    if (has('可用时长不足')) st.state = STATE.TIME_LOW;
    else if (has('连接失败') || findClickable('重新连接')) st.state = STATE.RECONNECT;
    else if (reconnecting()) st.state = STATE.RECONNECTING;
    else if (startTipVisible() || findClickable('点击开始游戏')) st.state = STATE.LANDING;
    else if (desktopReady()) st.state = STATE.DESKTOP;
    else if (!pc() && (findClickable('启动云电脑') || findClickable('快速启动'))) st.state = STATE.IDLE;
    else if (pc()) st.state = STATE.INSTANCE_PANEL;
    return st;
  }

  var _cv = null, _ctx = null;
  function grab() {
    var v = vid();
    if (!v || !v.videoWidth) return null;
    if (!_cv) { _cv = document.createElement('canvas'); _ctx = _cv.getContext('2d', { willReadFrequently: true }); }
    if (_cv.width !== 160) { _cv.width = 160; _cv.height = 90; }
    try { _ctx.drawImage(v, 0, 0, 160, 90); } catch (e) { return { err: String(e) }; }
    var d = _ctx.getImageData(0, 0, 160, 90).data, n = 160 * 90, px = new Uint8Array(n), sum = 0;
    for (var i = 0, j = 0; i < d.length; i += 4, j++) {
      var g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      sum += g; px[j] = g | 0;
    }
    var mean = sum / n, vs = 0;
    for (var k = 0; k < n; k++) { var dv = px[k] - mean; vs += dv * dv; }
    return { mean: +mean.toFixed(3), std: +Math.sqrt(vs / n).toFixed(3), px: px };
  }
  function diff(a, b) {
    if (!a || !b || !a.px || !b.px) return null;
    var n = a.px.length, s = 0, c = 0;
    for (var i = 0; i < n; i++) { var d = Math.abs(a.px[i] - b.px[i]); s += d; if (d > 8) c++; }
    return { mean: +(s / n).toFixed(3), px: c, pct: +(c * 100 / n).toFixed(2) };
  }

  async function positiveControl(opt) {
    opt = opt || {};
    if (!window.__kbd) return { ok: false, reason: 'no-__kbd' };
    var a = grab();
    window.__kbd.tap('win', 30);
    await sleep(opt.settle || 1500);
    var b = grab();
    window.__kbd.tap('esc', 30);
    await sleep(opt.restore || 1300);
    var c = grab();
    var act = diff(a, b), rt = diff(a, c);
    return { responded: !!(act && act.px >= (opt.threshold || 50)), action: act, roundTrip: rt,
      note: (!act || act.px === 0)
        ? 'Win 键无任何画面变化: 远端可能静止等待(锁屏/未登录)或输入未到达。此时不要判定键盘/鼠标不通。'
        : 'Win 键引起画面变化且 Esc 后复原 => 显示与输入通路均可用。' };
  }

  async function enter(opt) {
    opt = opt || {};
    var maxSteps = opt.maxSteps || 8, log = [];
    for (var step = 0; step < maxSteps; step++) {
      var s = await scan();
      log.push({ step: step, state: s.state, buttons: s.buttons, startTip: s.evidence.startTipVisible });
      if (s.state === STATE.DESKTOP) return { ok: true, state: s.state, log: log, liveness: liveness() };
      if (s.state === STATE.TIME_LOW) {
        var c = findClickable('关闭') || findClickable('确定') || findClickable('我知道了');
        if (!c) { log[log.length - 1].note = '时长不足, 需人工续时'; return { ok: false, state: s.state, log: log }; }
        c.click(); await sleep(600); continue;
      }
      if (s.state === STATE.RECONNECT) { var rb = findClickable('重新连接'); if (rb) rb.click(); await sleep(opt.reconnectWait || 6000); continue; }
      if (s.state === STATE.RECONNECTING) { await sleep(opt.reconnectingWait || 3000); continue; }
      if (s.state === STATE.LANDING) { var sb = findClickable('点击开始游戏') || findClickable('开始游戏'); if (sb) sb.click(); await sleep(opt.startWait || 5000); continue; }
      if (s.state === STATE.IDLE) {
        var lb = findClickable('启动云电脑') || findClickable('快速启动');
        if (!lb) return { ok: false, state: s.state, log: log };
        if (opt.allowStart === false) { log[log.length - 1].note = '需要上机(消耗时长), 未授权'; return { ok: false, state: s.state, log: log }; }
        lb.click(); await sleep(opt.bootWait || 8000); continue;
      }
      if (s.state === STATE.INSTANCE_PANEL) { var eb = findClickable('进入桌面'); if (eb) eb.click(); await sleep(opt.enterWait || 5000); continue; }
      await sleep(opt.idleWait || 2000);
    }
    return { ok: false, reason: 'max-steps', log: log };
  }

  window.__state = {
    S: STATE, scan: scan, enter: enter, liveness: liveness, desktopReady: desktopReady,
    grab: grab, diff: diff, positiveControl: positiveControl,
    startTipVisible: startTipVisible, findClickable: findClickable,
    ensureDesktop: enter,
    clickLabel: function (s) { var el = findClickable(s); if (!el) return { ok: false, reason: 'not-found' }; el.click(); return { ok: true, clicked: s }; }
  };
  console.log('[state v2] ready. try: await __state.scan()');
  return { ok: true };
})();
