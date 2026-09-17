# 顺网云电脑 Web 版：连接 + 键鼠接管 全流程 Runbook

> 实测日期 2026-09-17 · 站点 `cpc.icloud.cn/gamputer/web/cloud` · 库 `nexe-afk/cloud-pc-keyboard-takeover`
> 证据等级：本轮**现场实测**（远端画面像素差分），与 `docs/cloud-pc-takeover-notes.md` 的 [未复核] 条目区分开。

## 0. 全流程（一句话）

进入 `/gamputer/web/cloud` → **判断当前是哪种界面** → 点「进入桌面」/「重新连接」→ 等 `airLinks.pc` 就绪 → 注入控制层（归一化坐标版）→ 先过**帧存活性门控** → 用**可逆探针 + 远端画面差分**验证键鼠 → 操作。

## 1. 两种界面怎么判（关键第一步）

| 类型 | 特征 | 该做什么 |
|---|---|---|
| **A. 需重连** | body 下有 `div[class*=modal-container][class*=open]`，正文 `连接失败，请重新连接 / 若多次重连失败，建议结束订单重新运行云电脑`，两个按钮 `[结束订单]` `[重新连接]`（后者 class 含 `primary`） | 点 **重新连接** |
| **B. 正常未连接** | 无该 modal；可见 `进入桌面`（注入器加的 id 是 `#__frxEnter`）/ `点击开始游戏` / `结束订单` / `返回桌面` | 点 **进入桌面**（或 开始游戏） |

判据代码：

```js
const modal = document.querySelector('[class*=modal-container][class*=open]');
const kind = /重新连接/.test(modal ? modal.innerText : '') ? 'RECONNECT' : 'ENTER';
```

## 2. 重连实测（本轮）

点「重新连接」后 **4 秒恢复，无需刷新页面**：

```
t=0.0  pc=false
t=1.0  pc=true   readyState=0  paused=true
t=4.0  pc=true   readyState=4  paused=false   modal=closed
```

## 3. 连接就绪判据

```js
const pc = window.airLinks && window.airLinks.pc;
const ready = !!(pc && pc.videoElement && pc.videoElement.readyState >= 3 && !pc.videoElement.paused);
```

## 4. 注入控制层（v2.1-normalized）

> **`pc.sendAbs(x, y)` 吃 0~1 归一化坐标**，不是像素。`pc.videoRect` 是**本地显示尺寸**（本次 1267.5 x 713.25），远端是 1920x1080。
> 传像素（如 `sendAbs(960,540)`）**不报错**，但会被钳到屏幕角落 → 表现成「鼠标完全没反应」。

```js
const AL = window.airLinks, pc = AL.pc, NOP = () => {};
// 键盘：charCode 传标准 Windows VK，SDK 出口自己重编码
window.__kbd = {
  down: c => pc.sendKeydown({ charCode: c, preventDefault: NOP }),
  up:   c => pc.sendKeyup({ charCode: c, preventDefault: NOP }),
  async tap(c, hold=30){ pc.sendKeydown({charCode:c,preventDefault:NOP}); await new Promise(r=>setTimeout(r,hold)); pc.sendKeyup({charCode:c,preventDefault:NOP}); }
};
// 鼠标
window.__mouse = {
  abs: (nx, ny) => pc.sendAbs(nx, ny),                       // 0~1
  px:  (x, y) => { const r = pc.videoRect; return pc.sendAbs(x/r.w, y/r.h); },
  rel: (x, y) => pc.sendrel({ x, y }),
  click: async (b=0, hold=40) => {
    pc.sendMousedown({ button: b, preventDefault: NOP });
    await new Promise(r=>setTimeout(r,hold));
    pc.sendMouseup({ button: b, preventDefault: NOP });
  },
  wheel: dy => pc.sendMousewheel({ deltaY: dy, preventDefault: NOP })
};
```

注入后自检：`window.__takeover.pc === window.airLinks.pc`（false = 闭包已 stale，重注入）。

## 5. 帧存活性门控（★ 前置必做）

**像素差分只有在帧真的在流动时才是证据。** `readyState=4`、`currentTime` 在走、心跳正常 —— 都**不代表**帧在动。

```js
const a = __grab(); await sleep(1500); const b = __grab();
if (a.hash === b.hash) { /* 停帧 → 本次测量作废，不能判「无效」 */ }
```

## 6. 可逆探针矩阵（本轮实测，160x90 降采样）

| 探针 | 变化 | 复原 | 判定 |
|---|---|---|---|
| 空闲基线 | **0 px** | — | 静止桌面，信噪比极高 |
| `K.tap('win')` | **3905 px** | Esc → 2 px | 键盘 OK |
| `M.abs(.5,.5)` 仅移动 | 1 px | — | **远端光标不在视频流内**（站点用 cursor-img 覆盖层本地画） |
| `M.click(2)` 右键 | 458 px | Esc → 3 px | 鼠标 OK（桌面右键菜单本身小） |
| `M.abs(.02,.985)` + `click(0)` 开始按钮 | **3865 / 8587 px** | 再点 → 7191 px | 鼠标 OK（强信号） |

要点：**每次都用「打开 → 复原 → 回基线」三段式**，只截一帧会被噪声/复位误差骗。

## 7. E2E：启动远端程序

路径必须**只依赖已验证能力**（避免引入未验证的组合键）：

```
鼠标点开始按钮 (0.02, 0.985)  →  K.type('notepad')  →  K.tap('enter')
```

本轮实测：开始菜单 **3277 px** → 搜索打字 212 px → 回车后 **5436 px**（相对基线 7023 px）。

## 8. ✗ 组合键走不通（本站重要结论）

| 操作 | 结果 |
|---|---|
| `K.tap('win')` 快速按下+抬起 | **3905 px，开始菜单打开** ✔ |
| 长按 `kd(91)` 800ms 不抬 | **2 px，开始菜单不开** ✘ |
| `K.hotkey('win','r')` | 2 px，**运行框不出现** ✘ |

**结论：远端不支持把 Win 当修饰键长按，`hotkey()/combo()` 在本站不可靠。**
替代方案：所有组合键需求改走 **鼠标点击 + 单键序列**（第 7 节就是这条路）。

## 9. 运行约束（本轮又踩一次）

单次 `page_eval` 阻塞过久（>20~60s）→ 内容进程繁忙 → **打断站点自己的信令心跳** → 掉线（表现为第 1 节的 A 界面）。
→ 单次调用控制在 **10s 内**；掉线后点「重新连接」4 秒恢复，**订单不必结束**。

## 10. 未定案（勿当结论）

- 在记事本里逐字符 `type()` **没有拿到决定性证据**（暗像素增量 = 0）：当次帧存活、闭包不 stale、鼠标信号强，但打字后画面暗像素不增。
- 怀疑方向：焦点未真正落到编辑区 / `type()` 自造 Shift 修饰与远端不兼容（与第 8 节修饰键问题可能同源）。
- 第 7 节的 launched=5436 px **无法区分**「搜索结果面板」与「程序窗口」。
- 待办：先**用鼠标点窗口取得焦点**再打字；或放弃 Shift 依赖，只打小写字母+数字复测。

## 11. 免责声明

仅用于**自己账号**下的云电脑自动化调试。坐标与选择器随站点改版会失效，判据请以本文的**检测方法**为准而非硬编码常量。
