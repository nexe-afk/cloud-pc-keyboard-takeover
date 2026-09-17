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
