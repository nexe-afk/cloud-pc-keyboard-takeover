/* takeover-inject.js — 顺网云电脑(网页版) 键鼠接管注入层
 * 用法: 在「已连接桌面」的页面控制台粘贴执行, 得到 window.__kbd / __mouse / __takeover
 * 依赖: 页面已存在 window.airLinks 且 airLinks.pc 非空 (即已进入桌面)
 *
 * 关键事实(实测):
 *  1) 本层不负责连接, 只复用站点自建 WebRTC 已达成的 airLinks 实例投递输入事件。
 *  2) 键盘参数名是 charCode, 但装的是 Windows 虚拟键码 VK (A=65, Enter=13, Esc=27, Win=91, Ctrl=17, Shift=16)。
 *     SDK 内部会把 VK 重编码(Enter 13->130, Esc 27->133, Win 91->148, F1..F12 112..123 -> 1..12), 调用方传标准 VK 即可。
 *  3) 鼠标绝对定位 pc.sendAbs(x, y) 吃的是 [0,1] 归一化坐标, 不是像素! 传像素会被钳到角落且不报错(表现为"鼠标完全没反应")。
 *  4) 页面刷新/断线重连后 airLinks 实例会被替换, 本层闭包捕获的是旧实例 -> 调用不报错但事件进黑洞。
 *     因此提供 __takeover.stale() 自检, 返回 true 时请重新注入。
 *  5) 组合键不可靠: 远端不接受把 Win 当修饰键长按 (hotkey('win','r') 实测无效)。优先用鼠标点击 + 单键序列。
 */
(function () {
  'use strict';
  var VALIDATE_EVERY = 0; // 0=不自动重注入
  function hasAL() { return typeof window.airLinks === 'object' && window.airLinks !== null; }
  function hasPC() { return hasAL() && !!window.airLinks.pc; }
  if (!hasAL()) {
    console.error('[takeover] window.airLinks 不存在 —— 页面还没进入已连接桌面, 先走站点流程(进入桌面/开始游戏/重新连接)');
    return { ok: false, reason: 'no-airLinks' };
  }
  if (!hasPC()) {
    console.error('[takeover] airLinks.pc 为空 —— 传输层未就绪(可能正在重连), 稍后重试或点「重新连接」');
    return { ok: false, reason: 'no-pc' };
  }

  var AL = window.airLinks;      // 闭包捕获 —— 重连后会失效, 见 stale()
  var PC = AL.pc;

  // ---- 虚拟键码表 ----
  var VK = {
    backspace: 8, tab: 9, enter: 13, return: 13, shift: 16, ctrl: 17, control: 17, alt: 18,
    pause: 19, capslock: 20, esc: 27, escape: 27, space: 32, pageup: 33, pagedown: 34,
    end: 35, home: 36, left: 37, up: 38, right: 39, down: 40, insert: 45, delete: 46, del: 46,
    win: 91, meta: 91, cmd: 91, 'super': 91, contextmenu: 93,
    num0: 96, num1: 97, num2: 98, num3: 99, num4: 100, num5: 101, num6: 102, num7: 103,
    num8: 104, num9: 105, multiply: 106, add: 107, subtract: 109, decimal: 110, divide: 111,
    f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117, f7: 118, f8: 119, f9: 120,
    f10: 121, f11: 122, f12: 123,
    numlock: 144, scrolllock: 145,
    semicolon: 186, ';': 186, equal: 187, '=': 187, comma: 188, ',': 188,
    minus: 189, '-': 189, period: 190, '.': 190, slash: 191, '/': 191, backquote: 192, '\u0060': 192,
    bracketleft: 219, '[': 219, backslash: 220, '\\': 220, bracketright: 221, ']': 221, quote: 222, "'": 222
  };
  var SHIFTED = { '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 58,
    '_': 189, '+': 187, '{': 219, '}': 221, '|': 220, ':': 186, '"': 222, '<': 188, '>': 190, '?': 191, '~': 192 };

  function vk(key) {
    if (typeof key === 'number') return key;
    if (typeof key !== 'string' || !key) throw new Error('[takeover] bad key: ' + key);
    var k = key.toLowerCase();
    if (VK[k] !== undefined) return VK[k];
    if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(k)) return k.charCodeAt(0);
    throw new Error('[takeover] unknown key: ' + key);
  }

  // 每个键事件必须带一个 preventDefault 函数(站点内部会调用), 省略会抛错
  function payload(extra) {
    var o = { preventDefault: function () {} };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
    return o;
  }

  function down(key) {
    var v = vk(key);
    if (typeof AL.sendKeydown === 'function') return AL.sendKeydown(payload({ charCode: v }));
    return PC.sendKeydown(payload({ charCode: v }));
  }
  function up(key) {
    var v = vk(key);
    if (typeof AL.sendKeyup === 'function') return AL.sendKeyup(payload({ charCode: v }));
    return PC.sendKeyup(payload({ charCode: v }));
  }

  var K = {
    VK: VK, vk: vk,
    down: down,
    up: up,
    tap: function (key, holdMs) {
      down(key);
      return new Promise(function (r) { setTimeout(function () { up(key); r(true); }, holdMs || 30); });
    },
    key: function (name, holdMs) { return K.tap(name, holdMs); },
    // 逐字符输入: 大写/符号自动加 Shift。注意远端对修饰键长按支持有限, 遇到不发字符时改用"鼠标点焦点 + 只打小写数字"
    type: function (text) {
      var chars = String(text).split('');
      var i = 0;
      function step() {
        if (i >= chars.length) return Promise.resolve(true);
        var ch = chars[i++], shifted = false, base = ch;
        if (/[A-Z]/.test(ch)) { shifted = true; base = ch.toLowerCase(); }
        else if (SHIFTED[ch] !== undefined) { shifted = true; base = SHIFTED[ch]; }
        var seq = [];
        if (shifted) seq.push(function () { return down('shift'); });
        seq.push(function () { return down(base); });
        seq.push(function () { return up(base); });
        if (shifted) seq.push(function () { return up('shift'); });
        return seq.reduce(function (p, f) { return p.then(function () { return f(); }); }, Promise.resolve())
          .then(function () { return new Promise(function (r) { setTimeout(r, 12); }); })
          .then(step);
      }
      return step();
    },
    // 组合键: 按下全部(逆序释放为常规做法, 但本站可靠性有限, 见文件头说明)
    hotkey: function () {
      var keys = Array.prototype.slice.call(arguments);
      keys.forEach(function (k) { down(k); });
      return new Promise(function (r) {
        setTimeout(function () {
          keys.slice().reverse().forEach(function (k) { up(k); });
          r(true);
        }, 60);
      });
    },
    combo: function (mods, key) {
      (mods || []).forEach(function (m) { down(m); });
      return new Promise(function (r) {
        setTimeout(function () {
          down(key); up(key);
          (mods || []).slice().reverse().forEach(function (m) { up(m); });
          r(true);
        }, 60);
      });
    }
  };

  // ---- 鼠标 ----
  var BUTTON_MAP = [1, 5, 3, 7, 9];
  function videoRect() {
    var v = (PC && PC.videoElement) || document.querySelector('video');
    if (!v) return null;
    var r = v.getBoundingClientRect();
    return r && r.width ? { w: r.width, h: r.height, top: r.top, left: r.left } : null;
  }
  function clamp01(n) { n = Number(n); if (!isFinite(n)) n = 0; return n < 0 ? 0 : (n > 1 ? 1 : n); }

  var M = {
    // 绝对移动到归一化坐标 (0..1) —— 这是 sendAbs 的真实坐标空间
    abs: function (nx, ny) { var buf = PC; if (typeof buf.sendAbs === 'function') return buf.sendAbs(clamp01(nx), clamp01(ny)); },
    // 像素习惯的写法: 自动按 video 元素的显示尺寸归一化
    px: function (x, y) {
      var r = videoRect();
      if (!r) { console.warn('[takeover] 找不到 video 元素, px() 无法换算'); return; }
      return M.abs(x / r.w, y / r.h);
    },
    rel: function (dx, dy) { if (typeof PC.sendrel === 'function') return PC.sendrel({ x: dx, y: dy }); },
    down: function (btn) { return AL.sendMousedown(payload({ button: (btn || 0) })); },
    up: function (btn) { return AL.sendMouseup(payload({ button: (btn || 0) })); },
    click: function (btn, holdMs) {
      M.down(btn);
      return new Promise(function (r) { setTimeout(function () { M.up(btn); r(true); }, holdMs || 40); });
    },
    // 移动到位再点击(近端交互常用)
    moveClick: function (nx, ny, btn, holdMs) {
      return Promise.resolve(M.abs(nx, ny))
        .then(function () { return new Promise(function (r) { setTimeout(r, 60); }); })
        .then(function () { return M.click(btn, holdMs); });
    },
    wheel: function (deltaY) { return AL.sendMousewheel(payload({ deltaY: Number(deltaY) || 0 })); },
    switchMode: function (n) {
      if (PC && typeof PC.switchMouseMode === 'function') return PC.switchMouseMode(n);
      if (typeof AL.changeMouseMode === 'function') return AL.changeMouseMode(n);
      console.warn('[takeover] 未找到鼠标模式切换接口');
    },
    rect: videoRect
  };

  var api = {
    version: '2.0-normalized',
    AL: AL, pc: PC, VK: VK,
    // 重连/刷新后闭包里的实例是否已过期
    stale: function () { return !(hasAL() && window.airLinks === AL && AL.pc === PC); },
    check: function () {
      var v = (PC && PC.videoElement) || document.querySelector('video');
      return {
        stale: api.stale(),
        pc: !!PC,
        readyState: v ? v.readyState : null,
        paused: v ? v.paused : null,
        videoW: v ? v.videoWidth : null,
        videoH: v ? v.videoHeight : null,
        rect: videoRect()
      };
    }
  };

  window.__kbd = K;
  window.__mouse = M;
  window.__takeover = api;
  console.log('[takeover] injected v' + api.version, api.check());
  return { ok: true, check: api.check() };
})();
