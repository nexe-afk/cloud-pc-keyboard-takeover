> ⚠️ **修正提示**：本文件部分运行时条目已被证伪或修正 —— 见 [`runtime-verification-round2.md`](./runtime-verification-round2.md)（第二轮实测：`sendAbs` 实际吃归一化坐标 0~1、停帧门控、会话掉线复现与恢复）。

# 顺网云电脑 Web 遥控：接管要点与踩坑记录

> 站点：https://cpc.icloud.cn/gamputer/web/cloud
> 本文件结论均来自本仓库 src/ 与 README 的源码核对，可复核。
> 标注 **[未复核]** 的条目为推断，未做运行时实证。

## 0. 证据等级
- **[源码]** 直接读本仓库文件得到
- **[README]** 原 README 论断
- **[未复核]** 未跑通验证，仅供参考

## 1. 架构定位：本库不负责"连接"
WebRTC 信令、DataChannel、视频流由顺网云电脑网页端自行建立。本库只是**输入注入层**：
连接就绪后复用页面全局 window.airLinks，把键鼠事件塞进已存在的 DataChannel。

=> 「连接云电脑」= 走官网流程进入桌面；「接管」= 在**已连接的那个页面上下文**里注入。
   [源码 src/takeover.js 头部]

## 2. 就绪判据
airLinks 存在，且 airLinks.pc 存在。takeover.js 入口第一句即校验：

~~~js
var AL = window.airLinks;
if (!AL || !AL.pc) throw new Error('airLinks SDK 未就绪：请确认已在云电脑连接页面执行');
~~~

[源码]

## 3. 按键下发链路
~~~js
AL.sendKeydown ({ charCode: vk });
AL.sendKeyup   ({ charCode: vk });
AL.sendMousedown({ button, preventDefault: function () {} });
AL.sendMouseup  ({ button, preventDefault: function () {} });
AL.sendMousewheel({ deltaY });
pc.sendAbs(x, y);        // 绝对定位
pc.sendrel({ x, y });    // 相对移动
AL.changeMouseMode(n);
~~~
[源码 src/takeover.js + README]

## 4. 三个真坑

### 4.1 charCode 里装的是 Windows 虚拟键码 VK
不是字符编码。A=65、回车=13、Ctrl=17、Shift=16、Alt=18、Win=91、Esc=27。
裸 ASCII 字母恰好相同，但符号键不同（例如分号 = 186）。
[源码 README + src/vkmap.js 头部]

### 4.2 文档 bug：README 的全局名与源码不一致
- README 用法示例写 window.__frxKbd / window.__frxMouse
- takeover.js 实际只挂 window.__kbd / window.__mouse / window.__takeover

照 README 抄会拿到 undefined。**以 __kbd / __mouse 为准。**
[源码交叉核对，建议同步修 README]

### 4.3 preventDefault 是必带的空函数
sendMousedown / sendMouseup 的入参形如 { button: 0, preventDefault: function () {} }。
自行拼参数时不要省掉该字段。
[源码]

## 5. 自带工具函数
__kbd: down(vk) up(vk) tap(vk) type(str[, delay]) hotkey(mod, key) combo([mods], vk[, hold])
- type() 对匹配 SHIFTED_RE = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/ 的字符自动加 Shift
- hotkey / combo 自动逆序释放修饰键，带 20~40ms 间隔

__mouse: abs(x,y) rel(x,y) moveTo(x,y) down(btn) up(btn) click(btn[, hold=40]) wheel([deltaY=-120])
- btn: 0 左 / 1 中 / 2 右；deltaY 负 = 上滚
[源码]

## 6. 注入后自检
~~~js
window.__takeover.pc === window.airLinks.pc   // true
typeof window.__kbd.type                      // 'function'
~~~

## 7. 生命周期 [未复核]
airLinks 是页面运行时对象，刷新 / 断线重连后注入的 __kbd 会丢失，需重新注入。
建议封装成 bookmarklet，或监听 SPA 路由变化自动重注。

## 8. 为什么不退回合成 DOM 事件 [README]
new KeyboardEvent('keydown', ...) 的 isTrusted === false，会被页面输入层拦掉，
无法可靠到达远端。必须直连 SDK。

## 9. 验证思路（别只看"没报错"）
用**可逆动作**当探针，观察远端画面是否真的变化：
- Win 键 -> 远端出现开始菜单 -> Esc 复位
- 右键   -> 远端出现右键菜单 -> Esc 复位
- type('abc') 到已聚焦输入框，回读远端文本

事件发出去不等于远端收到，必须以远端画面/回显为准。

## 10. 免责声明
仅用于自有设备 / 已授权环境的自动化与测试。使用者须自行确保对目标云电脑
拥有合法控制权。

---

## 11. 运行时实证（本次复核）

> 本章为实跑取值所得，非推断。上一版标 [未复核] 的条目在此升级为已验证或已修正。

### 11.1 修正：pc 并非"方法全是 native code 的黑盒"
实测 pc 是普通 JS 类 n 的实例。sendKeydown/sendKeyup/sendMousedown/sendMouseup/sendMousewheel/
sendAbs/sendrel/sendTouchEvent 的 toString() 确为 [native code]；pc.sendGamePad 是普通 JS，
pc 上大量 __private_NN_* 亦为 JS 方法。该论断对"输入类方法"成立，对 pc 整体不成立。

### 11.2 证实：airLinks.send* 确为转发；changeMouseMode 存在
~~~js
AL.sendKeydown     = function(e){ (this.pc) && this.pc.sendKeydown(e) }
AL.changeMouseMode = function(e){ (this.pc) && this.pc.switchMouseMode(e) }
~~~
=> README 的"转发"说法成立。changeMouseMode 存在，真正的方法名是 pc.switchMouseMode。

### 11.3 运行期真实结构
- window.airLinks 是 class J 实例；原型另有 switchDisplayMode。
- window.airLinks.pc 是 class n 实例，属性以 __private_NN_xxx 命名（0..99），组合出 videoElement/audioElement/canvas/p2p/signal。
- pc.p2p 是 class je 实例（connect/disconnect/publish/send/getStats/allowedRemoteIds）——P2P 管理器。
- pc.signal 是 class Bt 实例（onMessage/onServerDisconnected/send/connect/disconnect）——信令通道。
- 画面源 = pc.videoElement（HTMLVideoElement，1920x1080），不是全局 querySelector("video")。

### 11.4 最重要的坑：断线重连会让注入层"静默失效"
takeover.js 注入时把 var AL = window.airLinks 与 pc 闭包捕获。
会话中途重连（页面出现"正在重连中..."，且 airLinks.pc 短时为 null）后实例被替换，
而已注入的 __kbd/__mouse 仍指向旧实例：调用不报错、返回值正常，但事件全丢进黑洞，远端无反应、无异常。

自检（重连后必查）：
~~~js
window.__takeover.AL === window.airLinks      // 重连后变为 false
window.__takeover.pc === window.airLinks.pc  // 重连后变为 false
~~~
=> 任何刷新/重连后必须重新注入。不要把"注入过"当成常驻状态。

### 11.5 客观验证法（别靠肉眼，也别靠"没报错"）
A) 帧哈希差分：pc.videoElement drawImage 到 64 宽 canvas，对像素做 FNV 哈希 + 平均亮度。
   注意：远端静态桌面或视频流冻结时哈希恒定，此法会静默失效，不能据此断定输入没发出去。

B) P2P 出站计数（本次采用的 wire 级判据）：包住 window.airLinks.pc.p2p.send 计数。实测：

| 条件（1 秒窗口） | p2p.send 次数 |
| --- | --- |
| 空闲 | 1（心跳） |
| 发 20 个按键（down+up = 40 事件） | 41 = 40 + 1 心跳 |

=> 每个按键事件恰好触发一次出站发送，证明输入确实到达传输层。

### 11.6 已排除的探测路径（勿重复走）
- RTCDataChannel.prototype.send 原型 hook：0 命中（实例藏在 pc.p2p(class je) 闭包内，属性扫不到）。
- pc.__private_60_sendControlByte：按键时不触发，不是键鼠编码出口。
- pc.p2p.publish：不是键鼠出口。
- pc.p2p.getStats()：抛 No PeerConnection between current endpoint and specific remote endpoint.

### 11.7 一句话结论
airLinks/pc 的 API 名与 README 表基本相符；真正坑人的不是 API 名，而是实例生命周期——
重连换实例后旧闭包静默失效、零报错。自动化应在"使用前"校验 __takeover.pc === airLinks.pc。


---

## 12. 键鼠连通性实证（本轮新增，均为运行期实测）

### 12.1 ★ 最重要的修正：`sendAbs` 吃归一化坐标，不是像素

**结论：`pc.sendAbs(x, y)` 的 x / y 是 0~1 的归一化坐标。**
传像素（例如 `sendAbs(960, 540)`）不会报错，但会被钳到屏幕角落，表现为「鼠标完全没反应」——极易误判成「鼠标没接通」。

**判定方法（白盒、可复现）**：向 `pc.videoElement` 派发一个合成 mousemove，看站点自己算出的调用：

~~~js
const pc = window.airLinks.pc, v = pc.videoElement;
const o = pc.sendAbs; pc.sendAbs = function(...a){ console.log("sendAbs", a); return o.apply(pc, a); };
v.dispatchEvent(new MouseEvent("mousemove", {clientX: 400, clientY: 300, bubbles: true, view: window}));
// 实测输出: sendAbs [0.3155818540433925, 0.2916228531370487]
// 400 / videoRect.w(1267.5) = 0.31558   ✓  300 落在 videoRect 内 -> 0.29162
~~~

所以 `src/takeover.js` 的 `abs(x, y)` 是**纯透传、不做归一化**；库 README 里的 `M.abs(960, 540)` 用法在鼠标上是错的（已在本轮修正）。

- 绝对定位：`pc.sendAbs(nx, ny)`，`nx, ny ∈ [0, 1]`。
- 相对移动：`pc.sendrel({x, y})` 是**像素**级位移（可正可负），实测有效。

**端到端确证（可逆探针）**：`sendAbs(0.02, 0.985)`（任务栏最左下角 = 开始按钮）→ 弹出开始菜单，13619 像素变化；再点一次 → 关闭并复原（与初始画面差 < 500 像素）。

### 12.2 wire 协议（`pc.p2p.send(remoteId, ArrayBuffer)` 出站）

统一头：`LE32 总长` + `LE32 操作码`；载荷开头再一个 `LE32 bodyLen`。

| 操作码 | 含义 | 载荷字段 |
| --- | --- | --- |
| `0x01030005` | 按键 | `[28]` = 内部键码，`[32]` = 1 按下 / 0 抬起 |
| `0x01030004` | 鼠标键 / 滚轮 | `[28]` 恒 0；`[32]` = 1 左键下 / 2 左键上；滚轮时 `[32]` = deltaY（0x78 = 120） |
| `0x0103000b` | 绝对移动 | `float32@24` = x，`float32@28` = y |

实例（keydown A）：`04 00 00 00 | 05 00 03 01 | 29 00 00 00 | ... | 41 00 00 00 | 01 00 00 00 | ...`

### 12.3 charCode = 标准 Windows VK，站点在出口重编码

`charCode` 入参用**标准 VK** 即可，SDK 内部会转成自己的内部码。实测映射（入参 VK → wire 内部码）：

| 入参 VK | wire | 说明 |
| --- | --- | --- |
| 65-90 / 48-57 | 同值 | A-Z / 0-9 直通 |
| 96-111 | 同值 | 小键盘直通 |
| 112-123 | 1-12 | F1-F12 |
| 13 | 130 | Enter |
| 27 | 133 | Esc |
| 8 / 9 / 32 | 128 / 129 / 134 | Backspace / Tab / Space |
| 20 / 19 | 132 / 131 | CapsLock / Pause |
| 91 | 148 | Win |
| 16 / 17 / 18 | 150 / 152 / 154 | Shift / Ctrl / Alt |
| 37-40 | 138-141 | Left / Up / Right / Down |
| 33 / 34 / 35 / 36 | 142 / 143 / 144 / 145 | PageUp / PageDown / End / Home |
| 45 / 46 | 146 / 147 | Insert / Delete |
| 144 / 145 | 136 / 137 | NumLock / ScrollLock |
| 186-222 | 192-202 | 各类符号键 |

### 12.4 端到端验证方法（把「画面」当唯一真值）

**空闲噪声极小，所以像素差分非常灵敏**：空闲时相邻帧平均像素差约 0.003、变化像素 4 个（右下角时钟）。

| 动作 | 平均像素差 | 变化像素 |
| --- | --- | --- |
| 空闲（基线） | 0.003 / 0.008 | 4 |
| **键盘：Win+D** | **52.5** | **42335 / 57600（73% 画面）** |
| 再按一次 Win+D（复原） | 52.74 | 42551 |
| **鼠标：点击 (0.02, 0.985)** | 39.1 | 13619（开始菜单弹出） |
| 再点一次（关闭并复原） | 38.9 | 13498 |

结论：**键盘、鼠标均端到端确证有效**（不是「看着对」，是可逆探针 + 量级对比）。

### 12.5 验证时必须避开的三个假阳性

1. **远端分辨率会变**：实测在 1920x1080 与 1280x720 之间切换，且 `pc.remoteSolution` 可能与视频流实际尺寸**不一致**（实测 `videoWidth/Height` = 1920x1080 而 `remoteSolution` = 1280x720）。分辨率切换本身会造成巨大的像素差分——必须单变量复测、并确认分辨率没变。
2. **远端光标不在视频流里**：站点用 `cursor-img` 覆盖层在**本地**绘制光标（`__private_18_isDrawCursor` / `__private_85_drawIconCursor` / `__private_49_createMouseEl`），所以靠画面像素找光标必然失败。
3. **`pc.p2p` 实例会被换掉**（`pc` 实例不变）：任何挂在 `pc.p2p.send` 上的计数探针会静默失效，制造出「事件发不出去」的假象。做 wire 计数必须**每次测试前重新武装当前实例**。

### 12.6 本轮新增的已排除路径

- 用 `RTCDataChannel.prototype.send` 原型 hook 抓键鼠出站包：**0 命中**（实例在闭包内）。
- 用像素坐标调 `sendAbs`：**无效**（见 12.1）。
- 用像素差分找远端光标移动：**无效**（光标本地绘制，见 12.5）。
- `pc.__private_1_keyMap` 不是权威键表（运行时是空对象），只能用 12.3 的实测映射。
- 只听 `pc.p2p.send` 做一次性计数：会被实例换代替换，结论不可靠。
