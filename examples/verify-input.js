/**
 * verify-input.js — 云电脑键盘/鼠标连通性自检（自带真值判定）
 *
 * 在已连接的云电脑页面控制台里运行。不依赖 __kbd / __mouse，直接用 airLinks SDK。
 * 判定方式：把远端画面当唯一真值，用可逆动作做探针。
 *
 * ⚠️ 已被 examples/cloud-pc-e2e.js (__e2e.verify) 取代, 本文件保留作参考。
 *    新版修正了状态机与门控判据: 存活要看播放态(readyState/paused)而非像素变化 ——
 *    静止的 Windows 桌面本就不产生新帧, 用像素判断"是否就绪"会误判。
 * 用法：
 *   await verifyInput()                    // 跑全套：连接态 + 键盘 + 鼠标
 *   await verifyInput({ probe: "kbd" })     // 只测键盘
 *   await verifyInput({ probe: "mouse" })   // 只测鼠标
 */
(function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---- 连接就绪判据 ----
  function ready() {
    var AL = window.airLinks;
    if (!AL || !AL.pc) return { ok: false, why: "airLinks SDK 未就绪" };
    var pc = AL.pc;
    var v = pc.videoElement;
    return {
      ok: true,
      connected: pc.__private_36_connected === true,
      authAck: pc.__private_14_isAuthAck === true,
      reconnects: pc.__private_12_reconnect_times,
      loginState: pc.__private_17_loginState,
      video: v ? { readyState: v.readyState, paused: v.paused, w: v.videoWidth, h: v.videoHeight } : null,
      remoteSolution: pc.remoteSolution,
      videoRect: pc.videoRect,
      staleClosure: !!window.__takeover && window.__takeover.pc !== pc
    };
  }

  // ---- 画面探针：返回亮度均值 + 变化像素数 ----
  function makeProbe(pc) {
    var W = 320, H = 180;
    var cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    return {
      snap: function () {
        ctx.drawImage(pc.videoElement, 0, 0, W, H);
        return ctx.getImageData(0, 0, W, H).data;
      },
      diff: function (a, b) {
        var s = 0, n = 0;
        for (var i = 0; i < a.length; i += 4) {
          var d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          s += d; if (d > 40) n++;
        }
        return { mean: +(s / (a.length / 4) / 3).toFixed(3), px: n };
      }
    };
  }

  // ---- 键盘 ----
  function kd(c) { window.airLinks.pc.sendKeydown({ charCode: c }); }
  function ku(c) { window.airLinks.pc.sendKeyup({ charCode: c }); }
  async function combo(mods, key) {
    mods.forEach(kd); await sleep(60); kd(key); await sleep(60); ku(key); await sleep(60);
    mods.slice().reverse().forEach(ku);
  }

  // ---- 鼠标：注意 abs 用归一化 0~1 ----
  function abs(nx, ny) { window.airLinks.pc.sendAbs(nx, ny); }
  async function clickAt(nx, ny, btn) {
    abs(nx, ny); await sleep(900);
    var pc = window.airLinks.pc;
    pc.sendMousedown({ button: btn || 0, preventDefault: function () {} }); await sleep(90);
    pc.sendMouseup({ button: btn || 0, preventDefault: function () {} });
  }

  window.verifyInput = async function (opts) {
    opts = opts || {};
    var pc = window.airLinks.pc;
    var P = makeProbe(pc);
    var out = { ready: ready(), steps: [] };

    // 关键护栏：远端分辨率会变，分辨率切换本身就是巨大假阳性
    var res0 = JSON.stringify(pc.remoteSolution) + "|" + pc.videoElement.videoWidth + "x" + pc.videoElement.videoHeight;

    // 空闲噪声基线
    var a = P.snap(); await sleep(1200); var b = P.snap();
    out.noise = P.diff(a, b);

    if (opts.probe !== "mouse") {
      var k0 = P.snap();
      await combo([91], 68);            // Win+D 最小化全部窗口
      await sleep(3000);
      var k1 = P.snap();
      var open = P.diff(k0, k1);
      await combo([91], 68);            // 再按一次复原
      await sleep(2500);
      var k2 = P.snap();
      out.steps.push({ name: "keyboard Win+D", open: open, restore: P.diff(k1, k2),
        verdict: open.px > out.noise.px * 100 ? "KEYBOARD-OK" : "inconclusive" });
    }

    if (opts.probe !== "kbd") {
      var m0 = P.snap();
      await clickAt(0.02, 0.985);       // 任务栏左下角 = 开始按钮
      await sleep(2800);
      var m1 = P.snap();
      await clickAt(0.02, 0.985);       // 再点一次关闭
      await sleep(2800);
      var m2 = P.snap();
      out.steps.push({ name: "mouse click Start(0.02,0.985)", open: P.diff(m0, m1), restore: P.diff(m0, m2),
        verdict: P.diff(m0, m1).px > 5000 ? "MOUSE-OK" : "inconclusive" });
    }

    var res1 = JSON.stringify(pc.remoteSolution) + "|" + pc.videoElement.videoWidth + "x" + pc.videoElement.videoHeight;
    out.resolutionStable = res0 === res1;
    if (!out.resolutionStable) out.warn = "远端分辨率在测试期间变化 —— 上面的像素差不可信，请重跑";
    out.ok = out.steps.every(function (s) { return /-OK$/.test(s.verdict); });
    return out;
  };

  return "verifyInput() 已就绪";
})();
