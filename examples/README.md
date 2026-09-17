# examples — 顺网云电脑(网页版) 键鼠接管可复用脚本

三个脚本按**顺序**注入即可（每个都是 IIFE，可直接从 raw URL `eval` 进页面，站点 CSP 允许）：

| 顺序 | 文件 | 作用 | 产出全局 |
|---|---|---|---|
| 1 | `takeover-inject.js` | 复用站点已建好的 `window.airLinks`，投递键鼠事件 | `__kbd` / `__mouse` / `__takeover` |
| 2 | `cloud-pc-state-machine.js` | 界面状态机 + 存活门控 + 自动进桌面 | `__state` |
| 3 | `cloud-pc-e2e.js` | 键鼠连通性判决 | `__e2e` |

> 本套脚本**不负责连接** —— WebRTC 信令/DataChannel 由站点自建，这里只做输入注入与验证。
> 页面刷新/断线重连后，注入层闭包捕获的 `airLinks` 实例会失效，**必须重新注入**（`__takeover.stale()` 自检）。

## 全流程一键跑通（实测可用）

```js
// 1) 注入三个脚本后，一条命令走完：自动进场 -> 存活门控 -> 键鼠判决
await __e2e.verify({ skipEntry: false });

// 输出(实测):
// { ok: true, verdicts: { keyboard:'OK', mouse:'OK' } }
// keyboard: action 3256px(22.6%) / roundTrip 5px
// mouse   : action 3256px(22.6%) / roundTrip 2px
```

日常操作：

```js
await __kbd.tap('enter');            // 单键（Enter/Esc/Win/space/... 用名字或数字键码）
await __kbd.type('hello');           // 逐字符（自动处理 Shift）
__mouse.abs(0.5, 0.5);               // 绝对移动 —— 归一化 0~1
__mouse.px(960, 540);                // 像素写法（内部按 video 显示尺寸归一化）
await __mouse.click(2);              // 0 左 / 1 中 / 2 右
__mouse.wheel(-120);                 // 负 = 上滚
await __state.scan();                // 当前界面状态
await __state.enter();               // 自动点按钮直到进入桌面
```

## 界面状态机（全部现场实测）

| 状态 | 判据 | 该做什么 |
|---|---|---|
| `IDLE` | 有『启动云电脑』/多个『快速启动』，无 video | 点上机（消耗时长） |
| `INSTANCE_PANEL` | `pc` 在，但 video 未起或覆盖层可见 | 点『进入桌面』 |
| `LANDING` | video 已出流，但 `start-tip` 覆盖层可见（『点击开始游戏』） | **必须先点它** |
| `DESKTOP` | `pc` 在 + video 播放中 + `start-tip` 隐藏 | 就绪 |
| `RECONNECTING` | 正文含『正在重连中...』，`pc` 变 null、videoCount 归零 | 等 |
| `RECONNECT` | 弹窗『连接失败，请重新连接』+ 按钮『重新连接』 | 点『重新连接』（约 4~8s 恢复） |
| `TIME_LOW` | 正文含『您的可用时长不足 N 分钟』 | 先关弹窗（会挡交互） |

**实测的完整进出链路**（从零到可操作）：`IDLE` →（启动云电脑）→ `INSTANCE_PANEL` →（进入桌面）→ `LANDING` →（点击开始游戏）→ `DESKTOP`。
掉线后：`RECONNECTING` → `RECONNECT` →（重新连接）→ `LANDING` →（点击开始游戏）→ `DESKTOP`。

## 五个必须知道的坑

### 1. ★ 不能用"像素有没有变"判帧死没死
静止的 Windows 桌面**本来就不产生新帧** —— WebRTC 编码器无变化就不发帧，此时
`requestVideoFrameCallback` 恒为 0、像素逐字节相同（实测连续 20 分钟零变化）。
早期版本拿它当门控，会把"远端静止等待"误判成"帧冻结/键鼠不通"，**导出过两次假结论**。

正确做法：
- **存活门控看播放态**：`readyState >= 2 && !paused && videoWidth > 0`；
- **通路是否可用看正向对照**：发 Win 键 → 若画面显著变化，说明显示与输入通路都活着。

### 2. ★ 『进入桌面』『结束订单』是常驻元素，不能用来判状态
进桌面后这两个元素**依然在 DOM 里**（实例卡片的一部分）。早期版本据此判断，导致扫描
**连续 6 轮误判为 `INSTANCE_PANEL` 空转**。真正的判据是 `start-tip` 覆盖层是否可见：
`document.querySelector('[class*=start-tip]')` 的 `getBoundingClientRect().width > 0`。

### 3. `sendAbs` 吃归一化坐标 0~1，不是像素
传像素（`sendAbs(960,540)`）**不报错**，会被钳到屏幕角落 —— 表现是"鼠标完全没反应"。
源码铁证（`swRTC.js`）：
```js
e.sendAbs(n.offsetX / e.videoRect.w, n.offsetY / e.videoRect.h)
videoElement.addEventListener("mousedown", e.sendMousedown)  // 内部读 e.button
```

### 4. 键盘参数叫 `charCode`，装的却是 Windows 虚拟键码 VK
A=65、Enter=13、Esc=27、Win=91、Ctrl=17、Shift=16。传标准 VK 即可，SDK 出口会重编码
（Enter 13→130、Esc 27→133、Win 91→148、F1..F12 112..123→1..12）。
每个键事件必须带 `preventDefault` 空函数（站点内部会调用）。

### 5. 组合键不可靠 + 判鼠标要用"靶心"
| 操作 | 实测结果 |
|---|---|
| `tap('win')` 快按快抬 | 开始菜单打开 ✔（3256px） |
| 长按 Win 800ms 不抬 | 无反应 ✘ |
| `hotkey('win','r')` | 运行框不出现 ✘ |
| 点任务栏开始按钮（0.02, 0.985） | 菜单开 ✔（3256px），Esc 关闭，往返差 2px |
| 桌面空白处左键 / 右键 | 常无可见变化（**正常**，不是不通） |

=> 判鼠标必须用**可逆靶心**（任务栏开始按钮），不是屏幕中心随便点一下。

## 验证方法（本项目一贯采用）

1. **门控**：确认视频处于播放态（不是看像素）；
2. **可逆探针**：动作 → 采样 → 复原 → 采样；
3. **判决**：`action.px` 显著 且 `roundTrip.px` 远小于动作幅度（相对阈值 5%）→ `OK`。
   实测信噪比：动作 ~3256px vs 往返差 2~5px（约 1000 倍）。

探针实测汇总：

| 探针 | action | roundTrip | 判定 |
|---|---|---|---|
| `tap('win')` + Esc | 3256 px (22.6%) | 5 px | 键盘 OK |
| 开始按钮左键 + Esc | 3256 px (22.6%) | 2 px | 鼠标 OK |
| 空闲无输入 | 0~1 px | — | 基线 |
| `rel(40,30)` 相对移动 | 0 px | — | 无信号（远端光标是本地覆盖层，预期） |

## 两个假阳性陷阱

- **远端分辨率会切换**（1920×1080 ↔ 1280×720），切换本身造成巨大差分，需单变量复测排除。
- **远端光标不在视频流内**：站点用 `cursor-img` 覆盖层在**本地**画光标，靠像素找光标必然失败。

## 运行约束（重要）

- 单次 `page_eval` 控在 **10s 内**：阻塞式长调用会打断站点自身的信令心跳，**实测导致掉线一次**（表现为 `paused:true` + `readyState` 从 4 掉到 0，随后弹『连接失败，请重新连接』）。
- 掉线后**不要急着点『点击开始游戏』**：连接未就绪时点它会再次触发重连。等 `readyState=4 && !paused` 再点。
- **实测：这条是真会发生的**。掉线恢复时会先出现 `LANDING` 态的覆盖层，但此时 `readyState` 仍是 0；
  在这个窗口点『点击开始游戏』会立刻再次断线（本次实测连续复现）。状态机 v3 已在 `enter()` 里加了 `liveness().alive` 前置门控。
- 会话稳定性与调用方式有关：单次 `page_eval` 短(≤10s)时全程稳定；一旦发起 20s+ 阻塞调用就掉线。
- `getVideoPlaybackQuality().totalVideoFrames` 在本站 MediaStream 管线里**恒为 0**，不能当存活证据。
