/* cloud-pc-e2e.js - 顺网云电脑(网页版) 全流程一键跑通 + 键鼠连通性判决
 * 前置: 页面需先注入 takeover-inject.js 与 cloud-pc-state-machine.js (得到 __kbd/__mouse/__state)
 * 用法:
 *    await __e2e.run()             // 完整流程: 进桌面 -> 门控 -> 键鼠探针 -> 判决
 *    await __e2e.run({skipEntry:true})  // 已确认在桌面时跳过自动进场
 *    await __e2e.probeAction('win')     // 单项探针(带门控)
 *
 * 判决原则(重要):
 *   - 唯一真值是"远端画素差分", 不是"事件发出去了/没报错"。
 *   - 探针必须可逆: 动作 -> 观察 -> 复原 -> 再观察。两个方向都有信号才算通。
 *   - 每次探针前先过帧存活门控; maxNoisePx===0 时本次测量作废(标 INVALID), 不下结论。
 *   - 分辨率切换(1920x1080 <-> 1280x720)本身就会造成巨大差分, 属假阳性, 需单变量复测排除。
 *   - 远端光标不在视频流内(站点用本地覆盖层画), 靠像素找光标必然失败, 不要用。
 */
(function () {
  'use strict';
  async function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function deps() {
    var miss = [];
    if (!window.__kbd) miss.push('__kbd (takeover-inject.js)');
    if (!window.__mouse) miss.push('__mouse (takeover-inject.js)');
    if (!window.__state) miss.push('__state (cloud-pc-state-machine.js)');
    return miss;
  }

  // 一次"可逆动作"探针。action/restore 为 async 函数。
  async function probeAction(name, action, restore, opt) {
    opt = opt || {};
    var S = window.__state;
    var rec = { name: name, steps: [] };

    // 0) 前置门控: 帧必须活着
    var gate0 = await S.probe({ frames: opt.gateFrames || 4, gap: opt.gap || 110 });
    rec.gate = { maxNoisePx: gate0.maxNoisePx, brightness: gate0.brightness, black: gate0.black, frameLive: gate0.frameLive };
    if (!gate0.frameLive) {
      rec.verdict = 'INVALID';
      rec.reason = '门控未通过: 帧完全静止(远端停帧/重连中), 像素探针无意义。' + (gate0.black ? ' 且画面为黑屏(mean<8)。' : '');
      return rec;
    }

    var before = S.grab();
    var t0 = Date.now();
    if (action) await action();
    await sleep(opt.settle || 700);
    var after = S.grab();
    var d1 = S.diff(before, after);
    rec.steps.push({ phase: 'action', ms: Date.now() - t0, diff: d1 });

    var d2 = null;
    if (restore) {
      var t1 = Date.now();
      await restore();
      await sleep(opt.settle || 700);
      var back = S.grab();
      d2 = S.diff(after, back);
      rec.steps.push({ phase: 'restore', ms: Date.now() - t1, diff: d2 });
    }

    var ON = (opt.threshold || 50);
    var acted = d1 && d1.px >= ON;
    var restored = !restore || (d2 && d2.px >= ON * 0.2);
    rec.diffAction = d1; rec.diffRestore = d2;
    rec.verdict = (acted && restored) ? 'OK' : (acted ? 'OK_NO_RESTORE' : 'NO_EFFECT');
    rec.noiseBaselinePx = gate0.maxNoisePx;
    rec.snr = d1 && gate0.maxNoisePx > 0 ? +(d1.px / gate0.maxNoisePx).toFixed(1) : (d1 && d1.px > 0 ? 'inf' : 0);
    return rec;
  }

  async function run(opt) {
    opt = opt || {};
    var miss = deps();
    if (miss.length) return { ok: false, reason: 'missing-deps', missing: miss };

    var out = { ok: false, startedAt: new Date().toISOString(), steps: {}, verdicts: {} };

    // 1) 确保进入桌面(若已在桌面且 skipEntry 则跳过)
    var s0 = await window.__state.scan();
    out.steps.initialState = s0.state;
    out.steps.initialEvidence = s0.evidence;

    if (!(opt.skipEntry && s0.state === 'DESKTOP')) {
      var entry = await window.__state.ensureDesktop(opt);
      out.steps.entry = { ok: entry.ok, state: entry.state, log: entry.log };
      if (!entry.ok) { out.reason = 'enter-desktop-failed'; return out; }
    }

    // 2) 注入层自检(重连会让闭包里的实例过期)
    if (window.__takeover) {
      var ck = window.__takeover.check();
      out.steps.takeoverCheck = ck;
      if (ck.stale) {
        out.reason = 'stale-closure: airLinks 实例已被替换, 请重新注入 takeover-inject.js';
        return out;
      }
    }

    // 3) 就绪门控
    var gate = await window.__state.probe({ frames: opt.frames || 6, gap: opt.gap || 120 });
    out.steps.gate = { frameLive: gate.frameLive, maxNoisePx: gate.maxNoisePx, brightness: gate.brightness, std: gate.std, black: gate.black };
    if (!gate.frameLive && !opt.force) {
      out.reason = 'frozen-frame: 帧静止, 键鼠探针全部作废(不做假结论)。' + (gate.reason || '');
      out.verdicts = { keyboard: 'INVALID', mouse: 'INVALID' };
      return out;
    }

    // 4) 键盘探针: 快按 Win(打开开始菜单) -> Esc 复原
    //    注意: 长按 Win 无效(远端不支持 Win 当修饰键长按), hotkey('win','r') 实测失败。
    var k = await probeAction('keyboard:win+esc',
      function () { return window.__kbd.tap('win', 30); },
      function () { return window.__kbd.tap('esc', 30); }, opt);
    out.steps.keyboard = k;
    out.verdicts.keyboard = k.verdict;

    // 5) 鼠标探针: 右键(弹菜单) -> Esc 复原
    var m = await probeAction('mouse:rightclick+esc',
      function () { return window.__mouse.click(2, 40); },
      function () { return window.__kbd.tap('esc', 30); }, opt);
    out.steps.mouse = m;
    out.verdicts.mouse = m.verdict;

    // 6) 鼠标左键探针: 点桌面(取消选中) —— 信号通常弱于右键, 仅作参考
    if (opt.sampleLeft) {
      var ml = await probeAction('mouse:leftclick',
        function () { return window.__mouse.click(0, 40); }, null, opt);
      out.steps.mouseLeft = ml;
    }

    out.ok = out.verdicts.keyboard === 'OK' && (out.verdicts.mouse === 'OK' || out.verdicts.mouse === 'OK_NO_RESTORE');
    out.finishedAt = new Date().toISOString();
    return out;
  }

  window.__e2e = {
    run: run, probeAction: probeAction,
    // 快速连通性自检(等价于 run 但只在桌面态执行, 不自动进场)
    quick: function () { return run({ skipEntry: true, frames: 5 }); },
    // 单键判决: await __e2e.key('win')
    key: function (name, restoreKey) {
      return probeAction('key:' + name,
        function () { return window.__kbd.tap(name, 30); },
        function () { return window.__kbd.tap(restoreKey || 'esc', 30); });
    },
    // 鼠标判决: await __e2e.click(2)  0左 1中 2右
    click: function (btn) {
      return probeAction('mouse:' + btn,
        function () { return window.__mouse.click(btn || 0, 40); },
        function () { return window.__kbd.tap('esc', 30); });
    }
  };
  console.log('[e2e] ready. try: await __e2e.run()');
  return { ok: true };
})();
