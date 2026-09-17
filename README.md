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
| `airLinks.pc.sendAbs(x, y)` | 鼠标绝对定位（native） |
| `airLinks.pc.sendrel({x, y})` | 鼠标相对移动（native） |
| `airLinks.changeMouseMode(n)` | 切换鼠标模式 |

`airLinks.send*` 只是转发到 `airLinks.pc.send*`；`pc` 是 WebRTC 连接封装，其方法为 `[native code]`，内部把事件序列化后经 DataChannel 发往云端。

> 关键坑：字段名 `charCode` 里装的其实是 **Windows 虚拟键码 (VK)**，不是字符编码。例如 A = 65，回车 = 13，Ctrl = 17。

## 为什么不直接用合成 DOM 事件

`new KeyboardEvent('keydown', ...)` 属于不可信事件（`isTrusted === false`），会被页面输入层拦掉（实测合成事件派发后 `defaultPrevented === true`），无法可靠下发到远端。直连 SDK 绕开了这一层。

## 用法

~~~js
// 键盘
const K = window.__frxKbd;       // 注入后可用，或直接调 airLinks
K.down(65);                      // A 按下
K.up(65);                        // A 抬起
await K.tap(13);                 // 回车
await K.type('hello world');     // 逐字符输入（自动处理 Shift）
await K.hotkey('ctrl', 'c');     // 组合键
await K.combo([17, 16], 27);     // Ctrl+Shift+Esc 风格

// 鼠标
const M = window.__frxMouse;
M.abs(960, 540);                 // 绝对移动到 (960,540)
M.rel(10, -5);                   // 相对移动
await M.click(0);                // 左键单击
M.wheel(-120);                   // 滚轮（负 = 向上）
~~~

## 目录

~~~
src/vkmap.js              VK 码表（字符 -> VK，含 Shift 映射）与具名键
src/takeover.js           键盘/鼠标控制层（注入到页面上下文）
examples/drive-demo.js    直接在控制台运行的驱动示例
~~~

## 免责声明

本项目仅用于 **自有设备 / 已授权环境** 的自动化与测试。使用者须自行确保对目标云电脑拥有合法控制权，不得用于未授权访问或任何违法用途。代码中引用的第三方 SDK 接口仅作技术记录。

MIT License
