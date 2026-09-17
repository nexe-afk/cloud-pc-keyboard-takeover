# 键鼠连通性实测（第二轮：运行期证据）

> 站点 https://cpc.icloud.cn/gamputer/web/cloud
> 本文所有数字均为运行期实测（页面内 pixel-diff 探针），可复现。
> 本文用于**修正** cloud-pc-takeover-notes.md 中几条被证伪或不可靠的结论。

## 1. 判决：键盘、鼠标均连通

| 探针 | 画面变化 | 复原 | 判定 |
|---|---|---|---|
| K.tap('win') 打开开始菜单 | mean 37.08 / 33138 px | Esc → 97 px | 键盘 OK |
| M.click(2) 右键 (0.5,0.5) | mean 5.03 / 9647 px | Esc → 复位 | 右键 OK |
| M.click(0) 左键 (0.5,0.5) | mean 1.02 / 4567 px | Esc → 复位 | 左键 OK |

空闲噪声基线 mean 0.037 / 28 px（来源：远端任务栏时钟）。
信噪比 > 100 倍，且全部探针**可逆复原**（Esc 后回到基线），无假阳性空间。

注入后自测：
~~~~js
await __kbd.tap('win');    // 33138 px
await __mouse.click(2);    // 9647 px
await __mouse.click(0);    // 4567 px
~~~~

## 2. 修正上文（重要）

1. **sendAbs 坐标 = 归一化 0~1**。源码 swRTC.js 铁证：
   e.sendAbs(n.offsetX / e.videoRect.w, n.offsetY / e.videoRect.h)
   传像素会被钳到屏幕角落且**不报错**，表现为"鼠标完全无反应"。
2. **鼠标事件参数 = MouseEvent 形态**（源码铁证）：
   videoElement.addEventListener("mousedown", e.sendMousedown)，SDK 内部读 e.button，
   再经 [1,5,3,7,9] 映射表转内部码。所以 { button: 0 } 直接可用（DOM 约定 0左/1中/2右）。
   相对位移路径：sendrel({x,y}) 配 mouseSens / mouseLockStatus。
3. **撤回**"pc.p2p.send 每个键事件恰好 1 次出站、40 事件 = 41 次发送"。
   该计数是**心跳噪声**造成的假证据。实测 pc.sendKeydown 是 native
   （function(){ [native code] }），**键盘根本不经 pc.p2p.send**，无法用计数证明。
   可靠替代：包 AL.sendKeydown / AL.sendKeyup（真 JS 转发层
   e=>{ this.pc && this.pc.sendKeydown(e) }）做计数。
4. **撤回**用 getVideoPlaybackQuality().totalVideoFrames 判流存活：本站 MediaStream
   管线里它**恒为 0**（currentTime 却正常前进）。若 12.x 节引用它，请删除。
5. changeMouseMode：AL 上确实存在（typeof 为 function）；pc 上的真名是 switchMouseMode。
   两者并存，不要互相否定。

## 3. 最大陷阱：媒体流会间歇停帧，停帧时像素探针恒为 0

现象（组合出现）：
- video.readyState = 4，paused = false，currentTime 持续前进
- pc.datachannelDelay 正常抖动（实测 69~92 ms，说明 DataChannel 心跳活着）
- 但 drawImage 出来的帧**完全不变**，连任务栏时钟都不跳，像素差分 mean/px **精确为 0**

后果：极易误判成"输入不通"。本轮回测中我因此两次得出错误结论
（先判"鼠标无效"，再判"键盘也是 0 变化"），随后用同源 A/B 推翻。

铁律：**像素探针必须先过存活性门控**
~~~~js
// 1) 先等帧真的在动（期间可用 Win+Esc 唤醒远端），连续帧差 > 50px 才算 live
// 2) live 才做探针；否则该次测量一律视为无效，重试
~~~~
currentTime 前进**不代表**有新帧（MediaStream 上它按挂钟走）。

## 4. 客户端会话会被自己搞挂：禁止 > 30s 的阻塞式 page_eval

实测时间线：一次 60 秒阻塞式 page_eval 结束后，页面随即进入
「正在重连中...」→ 弹出「连接失败，请重新连接」，
空气 links.pc 变 null、video 元素消失、body 退回实例卡片。

原因：阻塞渲染进程会打断站点自己的 WebSocket 信令心跳。

恢复办法：整页重载 → 点「进入桌面」（订单不会结束，页面仍显示"已连接 N 分钟"）。
注意重载后 window.airLinks 不存在，必须**重新注入** src/takeover.js
（与 README 的"断线重连需重注入"是同一类坑）。

=> 自动化时单次 page_eval 控制在 20s 内；长等待分段做。

## 5. 排除的死路（勿重走）

- getVideoPlaybackQuality().totalVideoFrames 判存活：恒 0，无效。
- 只靠 pc.p2p.send 计数证明键鼠出站：心跳噪声 + pc 接口为 native，不可靠。
- 在停帧窗口做像素差分：恒 0，必然误判。
- 单次阻塞 > 30s 的 page_eval：会把会话搞掉线。
- 依赖远端布局的探针（如"点任务栏开始按钮位"）：远端是否自动隐藏任务栏未知，无效。
  改用**自包含可逆探针**：右键 → 期望出现菜单 → Esc → 期望精确复原。
- scripts_capture_all 会带进大量埋点 beacon（本例 57 个脚本里大半是 beehive/alback
  的 jsReport），噪声大；主脚本为 swRTC.js（SDK，含 sendAbs/sendMousedown 定义）。

## 6. 可复现的判定逻辑（本轮实际使用）

~~~~js
// 0) 存活性门控（必须先做）
//    连续两帧像素差 > 50px 视为 live，否则重试（可发 Win+Esc 唤醒）
// 1) 键盘
const A = grab();
await K.tap(91);                 // Win
await sleep(1300); const B = grab();
await K.tap(27);                 // Esc
await sleep(1300); const C = grab();
// 判定：px(A,B) > 1500 && px(A,C) < 300  =>  键盘通
// 2) 鼠标
await M.abs(0.5, 0.5); await sleep(250);
await M.click(2);                // 右键
await sleep(1300); const D = grab();
// 判定：px(C,D) > 1500  =>  鼠标通
~~~~

## 7. 免责声明

仅用于本人自有账号/自购实例的连通性自查与自动化研究，含实测踩坑记录。
请遵守站点服务条款，勿用于未授权访问。
