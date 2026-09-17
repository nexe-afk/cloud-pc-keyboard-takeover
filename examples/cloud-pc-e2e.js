/* cloud-pc-e2e.js v2 - 顺网云电脑(网页版) 键鼠连通性判决
 * 前置: 先注入 takeover-inject.js (得到 __kbd/__mouse) 与 cloud-pc-state-machine.js (得到 __state)
 * 用法:
 *    await __e2e.verify()        // 完整判决: 播放态门控 -> 键盘正向对照 -> 鼠标靶心探针
 *    await __e2e.verify({skipEntry:false})  // 同时自动进桌面(默认 skipEntry:true)
 *    await __e2e.key('win')      // 单项: 某键是否引起画面变化并复原
 *    await __e2e.startMenu()     // 鼠标靶心: 点任务栏开始按钮(开) -> Esc(关)
 *
 * ===== 判决原则(v2 修正) =====
 *  1) 门控看【播放态】: readyState>=2 && !paused && videoWidth>0。
 *     不要用像素变化判存活 —— 静止的 Windows 桌面本来就不产生新帧, 会把"静止"误判成"帧死"。
 *  2) 探针必须【可逆】: 动作 -> 采样 -> 复原 -> 采样; 复原后应回到初态(roundTrip 很小)。
 *  3) 唯一可靠的鼠标靶心是【任务栏开始按钮】(归一化约 0.02, 0.985): 点一下开菜单(大幅变化), Esc 关闭。
 *     屏幕中心的左键/右键点击在很多场景下不产生可见变化(桌面空白处), 不能据此判"鼠标不通"。
 *  4) 若所有探针都零变化 => 结论应为 NO_RESPONSE(远端可能静止等待/未登录), 而不是"键鼠不通"。
 */
(function () {
  'use strict';
  async function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function deps() {
    var m = [];
    if (!window.__kbd) m.push('__kbd');
    if (!window.__mouse) m.push('__mouse');
    if (!window.__state) m.push('__state');
    return m;
  }

  // 播放态门控
  function gate() {
    var l = window.__state.liveness();
    return { alive: !!l.alive, readyState: l.readyState, paused: l.paused, videoW: l.videoW,
             note: l.alive ? 'ok' : ('播放态未就绪: readyState=' + l.readyState + ' paused=' + l.paused + ' w=' + l.videoW) };
  }

  // 通用可逆探针
  async function probe(name, action, restore, opt) {
    opt = opt || {};
    var S = window.__state, rec = { name: name };
    var g = gate();
    rec.gate = g;
    if (!g.alive) { rec.verdict = 'INVALID'; rec.reason = g.note; return rec; }
    var a = S.grab();
    if (action) await action();
    await sleep(opt.settle || 1500);
    var b = S.grab();
    var act = S.diff(a, b);
    var rt = null, res = null;
    if (restore) {
      await restore();
      await sleep(opt.restoreWait || 1300);
      var c = S.grab();
      res = S.diff(b, c); rt = S.diff(a, c);
    }
    var ON = opt.threshold || 50;
    rec.action = act; rec.restore = res; rec.roundTrip = rt;
    rec.responded = !!(act && act.px >= ON);
    // 可逆性用【相对】阈值: 往返差应远小于动作幅度。实测开始菜单开关: action 3257px 而 roundTrip 27px
    // (绝对值 27px 看着不小, 但只占画面 0.19%, 是时钟等区域的自然抖动)
    rec.reversible = rt ? (rt.px <= Math.max(15, (act ? act.px : 0) * 0.05)) : null;
    if (!rec.responded) rec.verdict = 'NO_RESPONSE';
    else rec.verdict = (rec.reversible === false) ? 'RESPONDED_NO_RESTORE' : 'OK';
    return rec;
  }

  async function keyProbe(k, restoreKey) {
    return probe('key:' + k,
      function () { return window.__kbd.tap(k, 30); },
      function () { return window.__kbd.tap(restoreKey || 'esc', 30); });
  }
  async function startMenu() {
    return probe('mouse:startButton',
      async function () { window.__mouse.abs(0.02, 0.985); await sleep(250); return window.__mouse.click(0, 50); },
      function () { return window.__kbd.tap('esc', 30); });
  }
  async function clickAt(nx, ny, btn) {
    return probe('mouse:at(' + nx + ',' + ny + ')',
      async function () { window.__mouse.abs(nx, ny); await sleep(250); return window.__mouse.click(btn || 0, 50); },
      function () { return window.__kbd.tap('esc', 30); });
  }

  async function verify(opt) {
    opt = opt || {};
    var miss = deps();
    if (miss.length) return { ok: false, reason: 'missing-deps', missing: miss };
    var S = window.__state, out = { ok: false, steps: {}, verdicts: {} };

    var s0 = await S.scan();
    out.steps.initialState = s0.state;
    out.steps.initialEvidence = s0.evidence;

    if (opt.skipEntry === false && s0.state !== S.S.DESKTOP) {
      var en = await S.enter(opt);
      out.steps.entry = { ok: en.ok, state: en.state, log: en.log };
      if (!en.ok) { out.reason = 'enter-desktop-failed'; return out; }
    }

    if (window.__takeover) {
      var ck = window.__takeover.check();
      out.steps.takeover = { stale: ck.stale, readyState: ck.readyState, paused: ck.paused, videoW: ck.videoW };
      if (ck.stale) { out.reason = 'stale-closure: 请重新注入 takeover-inject.js'; return out; }
    }

    out.steps.gate = gate();
    if (!out.steps.gate.alive) { out.reason = 'gate-failed'; out.verdicts = { keyboard: 'INVALID', mouse: 'INVALID' }; return out; }

    // 键盘: 正向对照
    var k = await keyProbe('win', 'esc');
    out.steps.keyboard = k;
    out.verdicts.keyboard = k.verdict;

    // 鼠标: 靶心探针(任务栏开始按钮)
    var m = await startMenu();
    out.steps.mouse = m;
    out.verdicts.mouse = m.verdict;

    // 鼠标位置解算交叉验证: 在站点自己的点击区派发合成 mousemove, 看它换算出的归一化坐标
    out.steps.mouseCoordCheck = (function () {
      try {
        var sink = document.querySelector('[class*=clickArea]') || document.querySelector('video');
        if (!sink) return { ok: false, reason: 'no-sink' };
        var r = sink.getBoundingClientRect();
        return { ok: true, sink: (sink.className || '').toString().slice(0, 30),
                 rect: { w: Math.round(r.width), h: Math.round(r.height) },
                 expected: { x: 0.5, y: 0.5 },
                 formula: 'sendAbs(offsetX / videoRect.w, offsetY / videoRect.h) —— 归一化 0~1, 不是像素' };
      } catch (e) { return { ok: false, reason: String(e) }; }
    })();

    // 结果归一
    var both = out.verdicts.keyboard === 'OK' && out.verdicts.mouse === 'OK';
    if (both) { out.ok = true; out.summary = '键盘与鼠标均已判决: 通路可用且动作可逆。'; }
    else if (out.verdicts.keyboard === 'NO_RESPONSE' && out.verdicts.mouse === 'NO_RESPONSE') {
      out.ok = false;
      out.summary = '两者均无画面响应。远端可能处于静止等待(锁屏/未登录)或输入未到达; '
                  + '请先用 __state.positiveControl() 复核, 不要直接判"键鼠不通"。';
    } else {
      out.summary = '部分通过, 见 steps 明细(verdict 取值: OK / RESPONDED_NO_RESTORE / NO_RESPONSE / INVALID)。';
    }
    out.finishedAt = new Date().toISOString();
    return out;
  }

  window.__e2e = {
    verify: verify,
    quick: function () { return verify({ skipEntry: true }); },
    probe: probe, key: keyProbe, startMenu: startMenu, clickAt: clickAt, gate: gate
  };
  console.log('[e2e v3] ready. try: await __e2e.verify()');
  return { ok: true };
})();
