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

## 实测记录（真实会话，从零到可操作）

完整链路（一次成功）：
`IDLE` →(点『启动云电脑』)→ `INSTANCE_PANEL` →(点『进入桌面』)→ `LANDING` →(点『点击开始游戏』)→ `DESKTOP`

掉线恢复链路：
`RECONNECTING` →(等)→ `RECONNECT` →(点『重新连接』)→ `LANDING` →(**等 `readyState=4 && !paused`**)→(点『点击开始游戏』)→ `DESKTOP`

判决输出（`await __e2e.verify({skipEntry:true})`）：
```
{ ok: true, verdicts: { keyboard: 'OK', mouse: 'OK' } }
keyboard tap('win') + Esc     : action 3256px (22.6%) / roundTrip 5px
mouse    点任务栏开始按钮 + Esc : action 3256px (22.6%) / roundTrip 2px
```

多字符打字链路（`__kbd.type()`，实测）：
开开始菜单(4028px) → `type('notepad')`（134px，搜索框出现文字）→ `tap('enter')` → **2568px (17.8%)，应用被启动**

### 追加踩坑

6. **弹窗关闭后文本仍留在 DOM**：`document.body.innerText` 里仍能搜到「连接失败，请重新连接」，
   于是用字符串包含判状态会在订单已结束、页面回到 `IDLE` 时误报 `RECONNECT`。
   必须要求承载提示的元素【可见】（v4 的 `visibleText()`）。
   **判别技巧**：若 `buttons` 列表里**没有**『重新连接』而状态却是 `RECONNECT`，那就是残留文本造成的假判。

7. **弹窗会叠加**：实测同时存在可见的『退出后将清空所有数据…』（z-index 9999、全屏 1268×898）
   与『连接失败，请重新连接』。`document.querySelector('[class*=modal-container]')` 取到的未必是
   当前该处理的那一个，需按文本匹配遍历。

8. **结束订单要过两道确认**：『结束订单』→『退出后将清空所有数据…[确认]』→『温馨提示 是否直接关闭该订单？[确定]』。
   只点第一个不会真的结束订单。

9. **`type()` 很慢**：逐字符（含 Shift 处理）实测 7 字符约 2.8s，≈400ms/字符（含字符间 12ms 间隔）。
   长文本请分段调用，避免单次 `page_eval` 超 10s。

## 保活模块 keepalive.js（每 3 分钟巡检弹窗）

长会话/自动化期间每 N 分钟（默认 180000ms = 3 分钟）巡检页面弹窗并处理，防止弹窗挡住后续操作。

```js
await __keep.start()     // 3 分钟一次，且立刻先跑一次
await __keep.checkNow()  // 手动跑一次
__keep.status()          // 是否运行中 / 上次状态 / 视频存活
__keep.log(10)           // 最近 10 次巡检记录
__keep.skipped(10)       // 被守卫拒绝的点击 + 原因
__keep.stop()
```

### 血泪教训：禁止盲点「确认 / 确定」

实测：在顺网云电脑页盲点「确认」会把**正在运行的会话直接结束**（随后 hasPc=false、video 数=0，而可用时长还剩 24 分钟——不是时长耗尽）。
=> 本模块所有点击必须过 `guard()` 白/黑名单：

- **永久拒绝**：结束订单 / 去充值 / 返回桌面 / 启动云电脑 / 快速启动
- **确认|确定**：弹窗文本命中破坏性关键词（`退出云电脑|退出后|结束订单|下机|清空数据`）→ 拒绝；必须命中无害关键词（`时长不足|温馨提示|公告|购买|充值|云币|数据盘`）才放行；两者都不匹配 → 拒绝（不可判定就不点）
- **重新连接**：仅当视频流不存活（alive=false）才点（link-looks-alive-skip 防止在健康会话上乱重连）
- **点击开始游戏|开始游戏**：仅当 `readyState>=2 && !paused && videoWidth>0` 才点（否则实测会再次掉线）
- **我知道了 / 取消 / 关闭**：放行

### 可点击性判定（elementFromPoint），别只看 DOM 是否存在

同一时刻实测：`重新连接` hittable=1（真可点），而 `进入桌面 / 确认 / 去充值 / 点击开始游戏` hittable=0（被 mask-container 盖住）。
**文本/DOM 存在 ≠ 能点** → 判据：元素中心点上的最顶层元素是否为自己或自己的后代。

### 已验证（A/B 对照，合成弹窗）

| 用例 | 期望 | 实测 |
|---|---|---|
| 只有破坏性弹窗时 pick(确认) | null | null |
| 同弹窗 raw pick(确认) | 找到 | 找到 |
| 只有无害弹窗时 pick(确认) | 找到 | 找到 |
| pick(结束订单) | null | null |
| 弹窗文本提取 dialogTextOf() | 含关键词 | 含 |

---

## keepalive.js — 每 3 分钟巡检弹窗（v2.3）

非侵入式保活：不改布局、不抢焦点、不发键鼠给远端；取画面用**离屏 canvas 缩略图**（不显示、不整屏截图）。
检测到弹窗时按白/黑名单安全关闭（**永久拒点 结束订单 / 去充值 / 支付**，「确认」需命中无害上下文才放行），
且「重新连接」只在视频流已死时才点。

```js
await __keep.start();   // 3 分钟一轮；本轮有弹窗则 15 秒后复查
__keep.state(); __keep.log(10); __keep.shot(); __keep.selfTest(); __keep.stop();
```

完整说明见 [`README-keepalive.md`](./README-keepalive.md)；验证：自测 11/11、DOM 对照 6/6。
