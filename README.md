# Cloud PC Keyboard / Mouse Takeover

用代码直接遥控 **顺网云电脑**（cpc.icloud.cn）的远端桌面。不是模拟 DOM 事件，而是直接调用网页内置的 **AirLink SDK**，把按键与鼠标输入送进 WebRTC DataChannel。

## 原理

顺网云电脑 Web 端把远端控制能力挂在全局对象 `window.airLinks`（内部 `class J` 的实例）上：

| 成员 | 作用 |
| --- | --- |
| `airLinks.sendKeydown({charCode})` | 远端按键按下 |
| `airLinks.sendKeyup({charCode})` | 远端按键抬起 |
| `airLinks.sendMousedown({button, preventDefault})` | 远端鼠标按下 |
| `airLinks.sendMouseup({button, preventDefault})` | 远端鼠标抬起 |
| `airLinks.sendMousewheel({deltaY})` | 远端滚轮 |
| `airLinks.pc.sendAbs(x, y)` | 鼠标绝对定位（native，**坐标须归一化 0~1**） |
| `airLinks.pc.sendrel({x, y})` | 鼠标相对移动（native） |
| `airLinks.pc.switchMouseMode(n)` | 切换鼠标模式（native） |

`airLinks.send*` 只是转发到 `airLinks.pc.send*`；`pc` 是 WebRTC 连接封装，其**输入类方法**被转成 `[native code]`，内部把事件序列化后经 DataChannel 发往云端。
注意 `airLinks.changeMouseMode` 这个名字**不存在**，真名是 `pc.switchMouseMode`。

> **坑 1：字段名 `charCode` 里装的其实是 Windows 虚拟键码 (VK)**，不是字符编码。例如 A = 65，回车 = 13，Ctrl = 17。标准 VK 由 SDK 负责重编码，调用方不必关心。
>
> **坑 2：`pc.sendAbs(x, y)` 吃的是归一化坐标 0~1，不是像素。** 传像素（如 `sendAbs(960, 540)`）会被钳到屏幕角落，表现是「鼠标完全没反应」。
>
> 判定依据：向 video 元素派发合成 `mousemove(clientX=400, clientY=300)`，站点自己算出来调用的是 `pc.sendAbs(0.3155818540433925, 0.2916228531370487)`，即 `clientX / videoRect.w`。所以 `M.abs(960, 540)` 这种写法是错的，正确用法见下方。

## 为什么不直接用合成 DOM 事件

`new KeyboardEvent(keydown, ...)` 属于不可信事件（`isTrusted === false`），会被页面输入层拦掉（实测合成事件派发后 `defaultPrevented === true`），无法可靠下发到远端。直连 SDK 绕开了这一层。

## 用法

`src/takeover.js` 注入成功后会挂载三个全局对象：`window.__kbd`（键盘）、`window.__mouse`（鼠标）、`window.__takeover`（含 `AL` / `pc` / `VK` / `NAMED`）。

~~~js
// 键盘
const K = window.__kbd;          // 注入 src/takeover.js 后可用，或直接调 airLinks
K.down(65);                      // A 按下
K.up(65);                        // A 抬起
await K.tap(13);                 // 回车
await K.type(hello world);       // 逐字符输入（自动处理 Shift）
await K.key(enter);              // 按名称敲键：enter/esc/tab/f1..f12/up/down/win...
await K.hotkey(ctrl, c);         // 组合键
await K.combo([17, 16], 27);     // Ctrl+Shift+Esc 风格

// 鼠标 —— 注意 abs 用归一化 0~1
const M = window.__mouse;
M.abs(0.5, 0.5);                 // 绝对移动到屏幕正中（不是像素！）
M.moveTo(0.02, 0.985);           // 同 abs（别名）；此为任务栏最左下角 = 开始按钮
await M.click(0);                // 左键单击
await M.click(2);                // 右键单击
M.rel(10, -5);                   // 相对移动（像素，可正可负）
M.wheel(-120);                   // 滚轮（负 = 向上）
~~~

> 若你希望保持像素习惯，可自行换算：`M.abs(px / videoRect.w, py / videoRect.h)`。


## 目录

~~~
src/vkmap.js              VK 码表（字符 -> VK，含 Shift 映射）与具名键
src/takeover.js           键盘/鼠标控制层（注入到页面上下文）
examples/drive-demo.js    直接在控制台运行的驱动示例
~~~

## 注意：断线重连后必须重新注入

云电脑会话中途重连会**替换** `airLinks` 实例，而注入时闭包捕获的 `pc` 仍指向旧实例。
此时 `__kbd` / `__mouse` 看起来完全正常，但事件**静默丢失、无任何报错**。使用前务必自检：

~~~js
window.__takeover.pc === window.airLinks.pc   // 必须为 true，否则重新注入
~~~

> 补充实测：即使 `pc` 实例没换，**`pc.p2p` 也会被换掉**。任何挂在 `pc.p2p.send` 上的探针/计数会静默失效（表现为「事件发不出去」的假象）。做 wire 级验证时，每次测试前都要重新武装当前实例。

另：`pc` 是普通 JS 类实例，仅输入类方法（sendKeydown / sendAbs / sendrel 等）被转成 `[native code]`。

## 实测结论（连接与投递）

- **连接就绪判据**：`airLinks.pc` 存在，且 `pc.__private_36_connected === true`、`pc.__private_14_isAuthAck === true`、`pc.__private_12_reconnect_times === 0`。视频出流看 `pc.videoElement`（注意不是 `pc.video`）：`readyState === 4` 且 `paused === false`。
- **投递是 1:1 的**：对 20 次 `tap`（40 个键事件）计数 `pc.p2p.send`，得到 41 次调用（空闲心跳另计，心跳包长 24 字节）。鼠标事件同样 1:1。即每个输入事件恰好一次出站发送。
- **端到端有效性（以远端画面为真值）**：空闲时相邻帧平均像素差约 0.003 / 4 个像素（右下角时钟）；按 Win+D 后平均差 52.5、42335/57600 像素（73% 画面）变化，再按一次复原 —— 键盘确证有效。归一化点击任务栏左下角 `(0.02, 0.985)` 弹出开始菜单（13619 像素变化），再点一次关闭并复原 —— 鼠标确证有效。
- **坐标空间会变**：远端分辨率可能在 1920x1080 与 1280x720 之间切换，而 `pc.remoteSolution` 报的值可能与视频流实际尺寸不一致（实测 `videoWidth/Height` = 1920x1080 而 `remoteSolution` = 1280x720）。做像素差分验证时必须先确认分辨率没变，否则会得到巨大的假阳性。
- **远端光标不在视频流里**：站点用 `cursor-img` 覆盖层在本地绘制光标（`__private_18_isDrawCursor` / `__private_85_drawIconCursor`），所以靠画面像素去找光标必然失败。

详细实证（含 wire 包结构解码、VK 内部码映射表、已排除的探测路径）见 [docs/cloud-pc-takeover-notes.md](docs/cloud-pc-takeover-notes.md)。

## 免责声明

本项目仅用于 **自有设备 / 已授权环境** 的自动化与测试。使用者须自行确保对目标云电脑拥有合法控制权，不得用于未授权访问或任何违法用途。代码中引用的第三方 SDK 接口仅作技术记录。

MIT License
