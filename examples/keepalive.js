/**
 * keepalive.js — 顺网云电脑网页端（cpc.icloud.cn）定时保活 + 弹窗识别
 * 版本 2.3   目标页面: https://cpc.icloud.cn/gamputer/web/cloud
 *
 * 设计原则：不能影响用户的观看体验
 *   - 不改页面布局、不动全局样式、不发键鼠事件给远端
 *   - 每 3 分钟一次「零干扰巡检」：视频帧缩略图 + DOM 弹窗识别 + 关引导遮罩
 *   - 绝不全屏截图、绝不遮挡、绝不抢焦点
 *
 * 用法：
 *   await __keep.start();            // 每 3 分钟一轮
 *   __keep.state();                  // 状态 + 最近帧指纹 + 最近日志
 *   __keep.log(10);                  // 最近 10 轮明细（含每轮 popups/actions/skipped）
 *   __keep.shot();                   // 立刻取一张缩略图（含 dataURL）
 *   __keep.stop();                   // 停止
 *
 * 界面状态判据（实测）
 *   IDLE            无 video / airLinks.pc 为假
 *   TUTORIAL        [class*=tutorial-Container] 可见（全屏引导遮罩，会挡掉所有点击）
 *   LANDING         [class*=start-tip___] 可见且宽度 > 40% 视口
 *   DIALOG          [class*=mask-container] / [class*=popup-container] 可见
 *   DESKTOP         video.readyState>=2 && !paused && airLinks.pc 为真
 *
 * 安全铁律（血泪换来的）
 *   1. 「结束订单」出现在 退出云电脑 / 订单到期 类弹窗里 —— 盲点它会直接下机（实测踩过）。
 *   2. 「确认/确定」必须同时命中无害上下文（时长不足/公告/温馨提示…）才允许点，判不出就不点。
 *   3. 「去充值/前往充值」是消费按钮，永久拒点。
 *   4. 「重新连接」只在视频流已死（无 video 或 paused）时才点；流活着时点它会打断用户观看。
 *   5. 弹窗正文必须剔除按钮文字，否则「请前往充值」这种正文会把无害弹窗误判成含危险动作。
 *   6. DOM 里有按钮 != 能点：必须用 elementFromPoint 命中自己/后代，否则说明被遮罩压着。
 */
(() => {
  const VERSION = '2.3';
  const cfg = { intervalMs: 180000, urgentMs: 15000, shotW: 192, keepShots: 6, cooldownMs: 20000, logMax: 60 };

  const ZW = /[\u200B-\u200D\uFEFF\u2060]/g;
  const clean = t => (t || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
  const vis = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return !(cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || 1) < 0.05);
  };
  const hittable = el => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return !!(hit && (hit === el || el.contains(hit)));
  };

  // 按钮名（精确匹配）与正文话题（包含匹配）语义不同，必须分开判定
  const DANGER_BTN = ['结束订单','结束云电脑','去充值','立即充值','前往充值','返回桌面','启动云电脑','下机','挂机','退出云电脑','确认退出','退出登录','支付','购买','重启','充值','续费','立即续费'];
  const DANGER_TOPIC = ['结束订单','结束云电脑','退出云电脑','退出登录','重启','关机','下机','挂机','删除','清空','格式化','卸载','续费'];
  const SAFE_BTN = ['知道了','我知道了','好的','确定','确认','关闭','取消','稍后再说','下次再说'];
  const STRICT_BTN = ['确定','确认','好的'];
  const HARMLESS = ['时长不足','可用时长','公告','温馨提示','云币','数据盘','预约','排队','教程','快捷键','通知','活动','奖励','更新','新版本'];
  const RECONNECT = '重新连接';

  function decide(bodyText, word, streamAlive) {
    const dt = clean(bodyText), w = clean(word);
    if (DANGER_BTN.includes(w)) return { act: false, why: 'DANGER_BUTTON' };
    if (w === RECONNECT) return streamAlive ? { act: false, why: 'STREAM_ALIVE_SKIP' } : { act: true, why: 'RECONNECT_DEAD_STREAM' };
    if (DANGER_TOPIC.some(k => dt.includes(k))) return { act: false, why: 'DANGER_TOPIC' };
    if (SAFE_BTN.includes(w)) {
      const harmless = HARMLESS.some(k => dt.includes(k));
      if (STRICT_BTN.includes(w) && !harmless) return { act: false, why: 'STRICT_BTN_NO_CONTEXT' };
      if (w === '取消') return { act: false, why: 'CANCEL_AMBIGUOUS' };
      return { act: true, why: 'SAFE_CLOSE' };
    }
    return { act: false, why: 'UNKNOWN_BUTTON' };
  }
  // 正文 = 弹窗文本剔除按钮标签（否则按钮文字会污染危险词判定）
  const bodyOf = (root, words) => {
    let t = clean(root.innerText);
    words.forEach(w => { const i = t.indexOf(w); if (i >= 0) t = t.slice(0, i) + ' ' + t.slice(i + w.length); });
    return t;
  };

  const getVideo = () => { const l = [...document.querySelectorAll('video')]; return l.find(v => v.videoWidth > 0) || l[0] || null; };
  const streamAlive = () => { const v = getVideo(); return !!(v && v.readyState >= 2 && !v.paused); };

  // 缩略图：绘制到离屏 canvas 再读像素，不插入 DOM、不显示、不影响观看
  function snapshot(keepData) {
    const v = getVideo();
    if (!v || !v.videoWidth || !v.videoHeight) return { ok: false, reason: 'NO_VIDEO' };
    const w = cfg.shotW, h = Math.max(1, Math.round(w * v.videoHeight / v.videoWidth));
    const c = (S.c || (S.c = document.createElement('canvas')));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try { ctx.drawImage(v, 0, 0, w, h); } catch (e) { return { ok: false, reason: 'DRAW_FAIL:' + e.message }; }
    const d = ctx.getImageData(0, 0, w, h).data;
    const n = w * h; let sum = 0, sum2 = 0, black = 0, hash = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      sum += g; sum2 += g * g; if (g < 8) black++;
      hash = (Math.imul(hash, 31) + (g | 0)) | 0;
    }
    const mean = sum / n, std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const r = { ok: true, w, h, mean: +mean.toFixed(2), std: +std.toFixed(2), blackRatio: +(black / n).toFixed(3), hash: hash >>> 0, t: Date.now() };
    if (keepData) { try { r.data = c.toDataURL('image/jpeg', 0.5); } catch (e) { r.tainted = true; } }
    return r;
  }

  const POPUP_ROOTS = '[class*="mask-container"],[class*="popup-container"]';
  const TUTORIAL = '[class*="tutorial-Container"]';
  const dkey = el => {
    const c = clean(el.className || '').split(' ')[0].split('___')[0].slice(0, 24) || el.tagName;
    const sig = clean(el.innerText).slice(0, 40);
    let h = 0; for (let i = 0; i < sig.length; i++) h = (Math.imul(h, 31) + sig.charCodeAt(i)) | 0;
    return c + '#' + (h >>> 0).toString(36);
  };
  function collectButtons(root) {
    const out = [];
    root.querySelectorAll('div,span,button,a,p').forEach(el => {
      if (el.children.length) return;
      const t = clean(el.innerText);
      if (!t || t.length > 8) return;
      if (!vis(el) || !hittable(el)) return;
      if (!out.some(b => b.word === t)) out.push({ word: t, el });
    });
    return out;
  }
  function scanPopups() {
    const found = new Map();
    document.querySelectorAll(TUTORIAL).forEach(tut => {
      if (!vis(tut)) return;
      const ca = tut.querySelector('[class*="clickArea"]');
      found.set('TUTORIAL#' + dkey(tut), { kind: 'TUTORIAL', el: tut, node: ca && vis(ca) ? ca : tut, text: clean(tut.innerText).slice(0, 60), buttons: [] });
    });
    document.querySelectorAll(POPUP_ROOTS).forEach(root => {
      if (!vis(root)) return;
      const btns = collectButtons(root);
      const k = dkey(root);
      if (!found.has(k)) found.set(k, { kind: 'DIALOG', el: root, bodyText: bodyOf(root, btns.map(b => b.word)), text: clean(root.innerText).slice(0, 140), buttons: [] });
      const rec = found.get(k);
      btns.forEach(b => { if (!rec.buttons.some(x => x.word === b.word)) rec.buttons.push(b); });
    });
    return [...found.values()];
  }
  function landingVisible() {
    const st = document.querySelector('[class*="start-tip___"]');
    if (!st || !vis(st)) return false;
    return st.getBoundingClientRect().width > innerWidth * 0.4;
  }

  const S = { VERSION, started: false, timer: null, ticks: 0, log: [], shots: [], lastAction: {}, nextDelay: cfg.intervalMs };
  function clickNode(el, dx, dy) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const x = r.left + (dx !== undefined ? r.width * dx : r.width / 2);
    const y = r.top + (dy !== undefined ? r.height * dy : r.height / 2);
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return true;
  }

  const API = {};
  function tick(opts) {
    opts = opts || {};
    const t0 = Date.now(); S.ticks++;
    const rec = { n: S.ticks, t: new Date().toISOString(), popups: [], actions: [], skipped: [] };
    rec.shot = snapshot(!!opts.keepData);
    rec.streamAlive = streamAlive();
    rec.pc = !!(window.airLinks && window.airLinks.pc);
    rec.landing = landingVisible();
    const pops = scanPopups();
    rec.popupCount = pops.length;
    pops.forEach(p => {
      const k0 = dkey(p.el);
      rec.popups.push({ kind: p.kind, key: k0, text: p.text, bodyText: p.bodyText, buttons: p.buttons.map(b => b.word) });
      if (p.kind === 'TUTORIAL') {
        if (Date.now() - (S.lastAction[k0] || 0) < cfg.cooldownMs) { rec.skipped.push({ key: k0, why: 'COOLDOWN' }); return; }
        S.lastAction[k0] = Date.now();
        clickNode(p.node);
        rec.actions.push({ key: k0, act: 'CLOSE_TUTORIAL', gone: !document.querySelector(TUTORIAL) });
        return;
      }
      let acted = false;
      for (const b of p.buttons) {
        let body = p.bodyText;
        if (clean(body).length < 4) body = p.text;   // 弹窗极短时回退取完整文本
        const d = API.decide(body, b.word, rec.streamAlive);
        if (!d.act) { rec.skipped.push({ key: k0, word: b.word, why: d.why }); continue; }
        const k1 = k0 + '|' + b.word;
        if (Date.now() - (S.lastAction[k1] || 0) < cfg.cooldownMs) { rec.skipped.push({ key: k1, why: 'COOLDOWN' }); continue; }
        S.lastAction[k1] = Date.now();
        clickNode(b.el);
        rec.actions.push({ key: k1, word: b.word, why: d.why, stillThere: document.body.contains(p.el) && vis(p.el) });
        acted = true; break;
      }
      if (!acted) rec.note = p.buttons.length ? 'NO_SAFE_ACTION' : 'NO_BUTTONS';
    });
    rec.ms = Date.now() - t0;
    S.nextDelay = rec.popupCount > 0 ? cfg.urgentMs : cfg.intervalMs;  // 有弹窗则 15s 后复查
    S.log.push(rec);
    if (S.log.length > cfg.logMax) S.log.shift();
    if (rec.shot && rec.shot.ok) { S.shots.push(rec.shot); if (S.shots.length > cfg.keepShots) S.shots.shift(); }
    return rec;
  }
  function schedule(ms) {
    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(() => { try { tick(); } catch (e) { S.log.push({ err: e.message }); } schedule(S.nextDelay); }, ms);
  }
  function start(o) {
    Object.assign(cfg, o || {});
    if (S.started) { schedule(S.nextDelay); return { already: true, intervalMs: cfg.intervalMs }; }
    S.started = true;
    const first = tick({ keepData: true });
    schedule(S.nextDelay);
    return { started: true, intervalMs: cfg.intervalMs, first: { popups: first.popupCount, landing: first.landing, shot: first.shot && { ok: first.shot.ok, mean: first.shot.mean }, actions: first.actions.map(a => a.word || a.act) } };
  }
  function stop() { S.started = false; if (S.timer) clearTimeout(S.timer); S.timer = null; return 'stopped'; }
  function selfTest() {
    const cases = [
      ['您的可用时长不足，请前往充值！', '知道了', false, true],
      ['您的可用时长不足，请前往充值！', '去充值', false, false],
      ['温馨提示：数据盘相关', '确定', false, true],
      ['是否结束订单？', '确认', false, false],
      ['确认要退出云电脑吗？', '确认', false, false],
      ['连接失败，请重新连接 若多次重连失败，建议结束订单重新运行云电脑', '重新连接', false, true],
      ['连接失败，请重新连接 若多次重连失败，建议结束订单重新运行云电脑', '重新连接', true, false],
      ['某个没见过的提示', '确认', false, false],
      ['某个没见过的提示', '取消', false, false],
      ['公告：新版本上线', '知道了', true, true],
      ['是否重启云电脑？', '确认', false, false]
    ];
    const res = cases.map(c => { const d = decide(c[0], c[1], c[2]); return { text: c[0].slice(0, 16), word: c[1], expect: c[3], got: d.act, why: d.why, pass: d.act === c[3] }; });
    res._pass = res.filter(r => r.pass).length + '/' + res.length;
    res._allPass = res.every(r => r.pass);
    return res;
  }
  function state() {
    return {
      VERSION, started: S.started, ticks: S.ticks, intervalMs: cfg.intervalMs, nextDelay: S.nextDelay,
      streamAlive: streamAlive(), pc: !!(window.airLinks && window.airLinks.pc), landing: landingVisible(),
      video: (() => { const v = getVideo(); return v ? { rs: v.readyState, paused: v.paused, w: v.videoWidth, h: v.videoHeight } : null; })(),
      popupsNow: scanPopups().map(p => p.kind + ':' + p.text.slice(0, 30)),
      shots: S.shots.map(s => ({ t: new Date(s.t).toISOString().slice(11, 19), mean: s.mean, std: s.std, blackRatio: s.blackRatio, hash: s.hash })),
      log: S.log.slice(-8).map(r => ({ n: r.n, t: r.t.slice(11, 19), popups: r.popupCount, landing: r.landing, actions: r.actions.map(a => a.word || a.act), skipped: r.skipped.map(s => (s.word || '') + ':' + s.why), note: r.note, ms: r.ms }))
    };
  }
  Object.assign(API, { VERSION, cfg, start, stop, tick, snapshot, scanPopups, decide, bodyOf, selfTest, state, clickNode,
    log: n => S.log.slice(-(n || 5)), shot: () => snapshot(true), _s: S });
  window.__keep = API;
})();
