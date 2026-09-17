/**
 * takeover.js — 云电脑远端键盘/鼠标控制层
 *
 * 通过页面全局的 AirLink SDK (window.airLinks) 直接下发输入到远端桌面。
 * 在目标页面控制台 / 自动化工具的 page context 中执行本文件即可注入
 * window.__kbd / window.__mouse。
 *
 * 依赖：window.airLinks（云电脑 Web 端 SDK 实例，class J）
 */

(function () {
  var AL = window.airLinks;
  if (!AL || !AL.pc) throw new Error('airLinks SDK 未就绪：请确认已在云电脑连接页面执行');

  var pc = AL.pc;

  // ---- 常量 ----
  var SHIFT = 16;
  var CTRL = 17;
  var ALT = 18;

  // 字符 -> VK（与 src/vkmap.js 保持一致的精简版）
  var VK = {
    ' ': 32, '0': 48, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53, '6': 54, '7': 55, '8': 56, '9': 57,
    'a': 65, 'b': 66, 'c': 67, 'd': 68, 'e': 69, 'f': 70, 'g': 71, 'h': 72, 'i': 73, 'j': 74, 'k': 75,
    'l': 76, 'm': 77, 'n': 78, 'o': 79, 'p': 80, 'q': 81, 'r': 82, 's': 83, 't': 84, 'u': 85, 'v': 86,
    'w': 87, 'x': 88, 'y': 89, 'z': 90,
    '.': 190, ',': 188, '/': 191, ';': 186, "'": 222, '[': 219, ']': 221, '-': 189, '=': 187, '\\': 220,
    '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 48,
    '_': 189, '+': 187, '{': 219, '}': 221, '|': 220, ':': 186, '"': 222, '<': 188, '>': 190, '?': 191, '~': 192
  };
  var SHIFTED_RE = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;

  var NAMED = {
    enter: 13, esc: 27, space: 32, tab: 9, backspace: 8, delete: 46, insert: 45,
    home: 36, end: 35, pageup: 33, pagedown: 34,
    up: 38, down: 40, left: 37, right: 39,
    shift: 16, ctrl: 17, alt: 18, win: 91,
    f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117, f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123
  };

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  // SDK 字段名是 charCode，装的其实是 VK 码
  var ev = function (code) { return { charCode: code }; };

  function vkOf(ch) {
    var vk = VK[ch];
    if (vk === undefined) return null;
    return { vk: vk, sh: SHIFTED_RE.test(ch) };
  }

  // ---- 键盘 ----
  var kbd = {
    down: function (code) { AL.sendKeydown(ev(code)); },
    up: function (code) { AL.sendKeyup(ev(code)); },

    tap: function (code, hold) {
      var s = this; hold = hold === undefined ? 50 : hold;
      s.down(code);
      return sleep(hold).then(function () { s.up(code); });
    },

    type: function (str, gap) {
      var s = this; gap = gap === undefined ? 25 : gap;
      var args = [];
      String(str).split('').forEach(function (ch) { var v = vkOf(ch); if (v) args.push(v); });
      var p = Promise.resolve();
      args.forEach(function (v) {
        p = p.then(function () {
          if (v.sh) s.down(SHIFT);
          return s.tap(v.vk, 20).then(function () {
            if (v.sh) s.up(SHIFT);
            return sleep(gap);
          });
        });
      });
      return p;
    },

    // 按名称敲一个键：await K.key('enter')
    key: function (name, hold) {
      var c = NAMED[String(name).toLowerCase()];
      if (c === undefined) return Promise.resolve(false);
      return this.tap(c, hold).then(function () { return c; });
    },

    // 组合键：await K.hotkey('ctrl', 'shift', 'esc')
    hotkey: function () {
      var names = [].slice.call(arguments);
      var s = this;
      var codes = names.map(function (n) { return NAMED[String(n).toLowerCase()]; });
      if (codes.some(function (c) { return c === undefined; })) return Promise.resolve(false);
      var main = codes.pop();
      codes.forEach(function (m) { s.down(m); });
      return sleep(20)
        .then(function () { s.down(main); return sleep(40); })
        .then(function () { s.up(main); return sleep(20); })
        .then(function () {
          codes.slice().reverse().forEach(function (m) { s.up(m); });
          return codes.concat(main);
        });
    },

    // 原始 VK 组合：await K.combo([17, 16], 27)  => Ctrl+Shift+Esc
    combo: function (mods, code, hold) {
      var s = this;
      mods.forEach(function (m) { s.down(m); });
      return sleep(20)
        .then(function () { s.down(code); return sleep(hold || 40); })
        .then(function () { s.up(code); return sleep(20); })
        .then(function () { mods.slice().reverse().forEach(function (m) { s.up(m); }); });
    }
  };

  // ---- 鼠标 ----
  var mouse = {
    abs: function (x, y) { pc.sendAbs(x, y); },              // 绝对坐标
    rel: function (x, y) { pc.sendrel({ x: x, y: y }); },    // 相对位移
    moveTo: function (x, y) { pc.sendAbs(x, y); },

    down: function (btn) { AL.sendMousedown({ button: btn || 0, preventDefault: function () {} }); },
    up: function (btn) { AL.sendMouseup({ button: btn || 0, preventDefault: function () {} }); },

    click: function (btn, hold) {
      var s = this; btn = btn || 0; hold = hold === undefined ? 40 : hold;
      s.down(btn);
      return sleep(hold).then(function () { s.up(btn); });
    },

    wheel: function (deltaY) { AL.sendMousewheel({ deltaY: deltaY === undefined ? -120 : deltaY }); }
  };

  window.__kbd = kbd;
  window.__mouse = mouse;
  window.__takeover = { kbd: kbd, mouse: mouse, AL: AL, pc: pc, VK: VK, NAMED: NAMED };

  return window.__takeover;
})();
