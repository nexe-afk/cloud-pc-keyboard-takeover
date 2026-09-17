# examples — 顺网云电脑(网页版) 键鼠接管可复用脚本

三个脚本按**顺序**注入即可（每个都是 IIFE，粘贴到控制台回车）：

| 顺序 | 文件 | 作用 | 产出全局 |
|---|---|---|---|
| 1 | `takeover-inject.js` | 复用站点已建好的 `window.airLinks`，投递键鼠事件 | `__kbd` / `__mouse` / `__takeover` |
| 2 | `cloud-pc-state-machine.js` | 界面状态识别 + 帧存活门控 + 自动进桌面 | `__state` |
| 3 | `cloud-pc-e2e.js` | 全流程编排 + 键鼠连通性判决 | `__e2e` |

> 前置：页面必须**已经进入桌面**（`window.airLinks` 存在且 `airLinks.pc` 非空）。
> 本套脚本**不负责连接** —— WebRTC 信令/DataChannel 由站点自建，这里只做输入注入与验证。

## 最小用法

```js
// 0) 若还没进桌面，交给状态机自动点（进入桌面 / 重新连接 / 点击开始游戏）
await __state.ensureDesktop();

// 1) 一键全流程：进场 -> 门控 -> 键鼠探针 -> 判决
await __e2e.run();
// => { ok:true, verdicts:{ keyboard:'OK', mouse:'OK' }, steps:{ gate:{...}, keyboard:{...}, mouse:{...} } }

// 2) 日常操作
await __kbd.tap('enter');                 // 单键
await __kbd.hotkey('ctrl','c');           // 组合键（可靠性有限，见下）
__mouse.abs(0.5, 0.5);                    // 绝对移动 —— 归一化坐标 0~1
__mouse.px(960, 540);                     // 像素写法（内部按 video 显示尺寸归一化）
await __mouse.click(2);                   // 0 左 / 1 中 / 2 右
__mouse.wheel(-120);                      // 负 = 上滚
```

## 五个必须知道的坑

### 1. `sendAbs` 吃归一化坐标 0~1，不是像素 ★
传像素（如 `sendAbs(960,540)`）**不报错**，会被钳到屏幕角落 —— 表现就是"鼠标完全没反应"。
源码铁证（`swRTC.js`）：

```js
e.sendAbs(n.offsetX / e.videoRect.w, n.offsetY / e.videoRect.h)
videoElement.addEventListener("mousedown", e.sendMousedown)  // 内部读 e.button
```

### 2. 键盘参数名叫 `charCode`，装的却是 Windows 虚拟键码 VK
A=65、Enter=13、Esc=27、Win=91、Ctrl=17、Shift=16。调用方传标准 VK 即可，SDK 出口会重编码
（Enter 13→130、Esc 27→133、Win 91→148、F1..F12 112..123→1..12）。
另外每个键事件必须带一个 `preventDefault` 函数（站点内部会调用），省略会抛错。

### 3. 组合键不可靠：远端不支持把 Win 当修饰键长按
| 操作 | 实测结果 |
|---|---|
| `tap('win')` 快按快抬 | 开始菜单打开 ✔ |
| 长按 Win 800ms 不抬 | 无反应 ✘ |
| `hotkey('win','r')` | 运行框不出现 ✘ |

=> 组合键需求改走**鼠标点击 + 单键序列**。

### 4. 帧存活门控：`readyState=4` 不等于画面在动 ★★
实测到「`pc` 为真、`readyState=4`、`currentTime` 在走、心跳正常（58ms），但两次采样画面逐字节相同」。
此时**任何像素探针恒为 0**，会导出"键鼠不通"的**假结论**（本仓库作者在实测中因此误判过两次）。
规则：探针前先跑 `__state.probe()`，`maxNoisePx===0` → 该次测量作废，标 `INVALID`，不许下结论。

### 5. 重连/刷新会让注入层静默失效
`takeover-inject.js` 注入时闭包捕获了 `airLinks` 与 `pc`。会话中途重连后实例被**替换**，
`__kbd` 仍指向旧实例 —— **调用不报错、返回值正常，事件全部进黑洞**。
自检：`__takeover.stale()`（或 `__takeover.AL === window.airLinks`）返回 `true` 时重新注入。

## 两个假阳性陷阱

- **远端分辨率会切换**（1920×1080 ↔ 1280×720），切换本身造成巨大差分 —— 测按键时若撞上会误判为"通了"。需单变量复测。
- **远端光标不在视频流内**：站点用 `cursor-img` 覆盖层在**本地**画光标，所以靠像素找光标必然失败。

## 运行约束

- 单次 `page_eval` 控制在 **10s 内**：阻塞式长调用会打断站点自身的信令心跳，导致掉线（实测复现过一次）。
- 帧停住时 `currentTime` 照常前进，`getVideoPlaybackQuality().totalVideoFrames` 在本站 MediaStream 管线里**恒为 0** —— 两者都不能当存活证据。

## 验证方法（本项目一贯采用）

对**远端视频画面**做像素差分，用**可逆动作**当探针：

1. 测底噪（空闲若干帧）→ 确认帧活着、拿到噪声基线；
2. 做动作 → 差分；再复原 → 差分；
3. 两个方向都有显著信号（信噪比 >100）才判 `OK`。

实测样例（探针全部可逆复原）：

| 探针 | 画面变化 | 复原后 | 判定 |
|---|---|---|---|
| `tap('win')` | mean 37.08 / 33138 px | Esc → 97 px | 键盘 OK |
| 右键 `click(2)` | mean 5.03 / 9647 px | Esc → 复位 | 鼠标 OK |
| 左键 `click(0)` | mean 1.02 / 4567 px | Esc → 复位 | 鼠标 OK |
| 仅 `abs` 移动 | 1 px | — | 无信号（光标是本地覆盖层，预期如此） |
| 空闲基线 | — | 0~28 px | — |

E2E：鼠标点开始按钮 → 单键输入 `notepad` → 回车，信号 3277 → 212 → 5436 px。
