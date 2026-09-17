(function () {
  if (window.__keep && window.__keep.__v === '1.2') return { ok: true, already: '1.1' };
  var DEF = { intervalMs: 180000, settleMs: 2500, allowStart: true, autoReconnect: true, reconnectCooldownMs: 90000, logSize: 50 };
  var cfg = {}, kk; for (kk in DEF) cfg[kk] = DEF[kk];
  var timer = null, logBuf = [], lastReconnectAt = 0, last = null, ticks = 0, skipped = [];

  var DESTRUCTIVE = ['退出云电脑', '退出后', '结束订单', '下机', '清空数据', '关闭云电脑', '关机', '确定退出', '确认退出'];
  var BENIGN = ['时长不足', '温馨提示', '公告', '购买', '充值', '新人', '云币', '数据盘', '即将到期', '提示'];
  var NEVER = ['结束订单', '去充值', '返回桌面', '启动云电脑', '快速启动'];

  function tsStr() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function vid() { var v = document.querySelectorAll('video'); for (var i = 0; i < v.length; i++) if (v[i].videoWidth) return v[i]; return v[0] || null; }
  function liveness() {
    var v = vid();
    if (!v) return { alive: false, reason: 'no-video' };
    return { alive: v.readyState >= 2 && !v.paused && v.videoWidth > 0, rs: v.readyState, paused: v.paused, w: v.videoWidth, h: v.videoHeight };
  }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }
  function hitTest(el) {
    if (!visible(el)) return false;
    var r = el.getBoundingClientRect();
    var x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    var y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    var top = document.elementFromPoint(x, y);
    if (!top) return false;
    return el === top || el.contains(top);
  }
  function dialogTextOf(el) {
    var p = el, best = '';
    for (var i = 0; i < 8 && p; i++) {
      if (p.tagName === 'BODY') break;
      var c = String(p.className || '');
      if (/modal|dialog|popup|tip|container|content/i.test(c)) {
        var t = (p.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 500) { best = t; if (t.length < 240) break; }
      }
      p = p.parentElement;
    }
    return best;
  }
  function hasAny(s, arr) { for (var i = 0; i < arr.length; i++) if (s.indexOf(arr[i]) >= 0) return true; return false; }
  function guard(label, el) {
    var dt = dialogTextOf(el);
    if (hasAny(label, NEVER)) return { ok: false, reason: 'never-click-list' };
    if (label === '确认' || label === '确定') {
      if (hasAny(dt, DESTRUCTIVE)) return { ok: false, reason: 'destructive-dialog', dialog: dt.slice(0, 80) };
      if (!hasAny(dt, BENIGN)) return { ok: false, reason: 'unknown-dialog-cannot-judge', dialog: dt.slice(0, 80) };
      return { ok: true, reason: 'benign-dialog', dialog: dt.slice(0, 80) };
    }
    if (label === '关闭' || label === '我知道了' || label === '取消') return { ok: true, reason: 'safe-dismiss', dialog: dt.slice(0, 60) };
    if (label === '重新连接') return { ok: liveness().alive ? false : true, reason: liveness().alive ? 'link-looks-alive-skip' : 'link-dead-reconnect' };
    if (label === '点击开始游戏' || label === '开始游戏') return { ok: liveness().alive, reason: liveness().alive ? 'stream-ready' : 'stream-not-ready' };
    return { ok: false, reason: 'not-allowed' };
  }
  function pick(label, opt) {
    opt = opt || {};
    var all = document.querySelectorAll('button,a,div,span,li');
    var best = null, bestA = Infinity, why = null;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = (el.innerText || el.value || '').trim();
      if (t !== label) continue;
      if (!hitTest(el)) continue;
      if (!opt.raw) { var g = guard(label, el); if (!g.ok) { why = g; continue; } }
      var r = el.getBoundingClientRect(), a = r.width * r.height;
      if (a < bestA) { bestA = a; best = el; }
    }
    if (!best && why) skipped.push({ at: tsStr(), label: label, reason: why.reason, dialog: why.dialog });
    return best;
  }
  var WATCH = ['重新连接', '点击开始游戏', '开始游戏', '进入桌面', '结束订单', '返回桌面', '确认', '确定', '我知道了', '取消', '关闭', '去充值', '启动云电脑', '快速启动'];
  function watch() {
    var out = [];
    for (var i = 0; i < WATCH.length; i++) {
      var all = document.querySelectorAll('button,a');
      var n = 0, hit = 0;
      for (var j = 0; j < all.length; j++) {
        var t = (all[j].innerText || '').trim();
        if (t !== WATCH[i]) continue;
        if (!visible(all[j])) continue;
        n++;
        if (hitTest(all[j])) hit++;
      }
      if (n) out.push({ label: WATCH[i], visible: n, hittable: hit });
    }
    return out;
  }
  async function stateNow() {
    if (window.__state && window.__state.scan) { try { return (await window.__state.scan()).state; } catch (x) { return 'scan-err'; } }
    return 'no-state-mod';
  }
  async function act(label, kind, settle) {
    var el = pick(label);
    if (!el) return null;
    el.click();
    return { act: kind, label: label, settle: settle };
  }
  async function check(opt) {
    opt = opt || {};
    ticks++;
    var t0 = Date.now();
    var e = { n: ticks, at: tsStr(), before: null, after: null, watch: [], actions: [], notes: [] };
    e.before = await stateNow();
    e.watch = watch();
    var v = vid();
    if (v && v.paused) { try { await v.play(); e.actions.push({ act: 'video.play' }); } catch (x) { e.notes.push('play-fail'); } }
    var settle = (opt.settleMs === undefined) ? cfg.settleMs : opt.settleMs;

    if (pick('重新连接')) {
      if (!cfg.autoReconnect) e.notes.push('reconnect-disabled');
      else if (Date.now() - lastReconnectAt < cfg.reconnectCooldownMs) e.notes.push('reconnect-cooldown');
      else { lastReconnectAt = Date.now(); var a1 = await act('重新连接', 'reconnect', settle); if (a1) { e.actions.push(a1); await sleep(settle); } }
    }
    var sb = pick('点击开始游戏') || pick('开始游戏');
    if (sb) {
      if (!cfg.allowStart) e.notes.push('start-disabled');
      else { var lb = (sb.innerText || '').trim(); var a2 = await act(lb, 'start', settle); if (a2) { e.actions.push(a2); await sleep(settle); } }
    }
    for (var i = 0; i < 3; i++) {
      var d = pick('我知道了') || pick('取消') || pick('关闭') || pick('确认') || pick('确定');
      if (!d) break;
      var lab = (d.innerText || '').trim();
      var a3 = await act(lab, 'dismiss', settle);
      if (a3) { e.actions.push(a3); await sleep(settle); } else break;
    }
    e.after = await stateNow();
    e.changed = e.before !== e.after;
    e.ms = Date.now() - t0;
    last = e; logBuf.push(e); if (logBuf.length > cfg.logSize) logBuf.shift();
    return e;
  }
  window.__keep = {
    __v: '1.2',
    start: function (o) {
      o = o || {}; var k2; for (k2 in o) cfg[k2] = o[k2];
      if (timer) clearInterval(timer);
      var iv = Math.max(10000, cfg.intervalMs);
      if (o.noImmediate !== true) check();
      timer = setInterval(function () { check(); }, iv);
      return { ok: true, intervalMs: iv };
    },
    stop: function () { if (timer) clearInterval(timer); timer = null; return { ok: true, stopped: true, ticks: ticks }; },
    checkNow: function (o) { return check(o || {}); },
    status: function () { return { running: !!timer, intervalMs: cfg.intervalMs, ticks: ticks, lastAt: last ? last.at : null, lastState: last ? (last.before + ' -> ' + last.after) : null, video: liveness(), skippedCount: skipped.length }; },
    log: function (n) { return logBuf.slice(-(n || 20)); },
    skipped: function (n) { return skipped.slice(-(n || 20)); },
    watch: watch, pick: pick, hitTest: hitTest, guard: guard, dialogTextOf: dialogTextOf, cfg: cfg
  };
  console.log('[keepalive v1.2] ready');
  return { ok: true, v: '1.1' };
})();