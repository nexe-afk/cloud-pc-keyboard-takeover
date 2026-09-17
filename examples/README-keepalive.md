# keepalive.js — 3 分钟保活巡检 + 弹窗守卫（v2.3）

> 目标页面：`cpc.icloud.cn/gamputer/web/cloud`（顺网云电脑网页版）
> 配套脚本：[`keepalive.js`](./keepalive.js)

## 用法

```js
await __keep.start();     // 启动：每 3 分钟一轮；若本轮有弹窗，则 15 秒后复查
__keep.state();          // 状态 + 最近帧指纹 + 最近日志
__keep.log(10);          // 最近 10 轮明细（popups / actions / skipped）
__keep.shot();           // 立刻取一张缩略图（含 dataURL）
__keep.selfTest();       // 纯决策自测（11 例，不碰 DOM）
__keep.stop();
```

## 「不影响观看体验」是怎么做到的

- 不改页面布局、不动全局样式、不抢焦点、**不发键鼠事件给远端**
- 取画面 = 把视频帧画到**离屏 canvas** 读像素（192x108 缩略图）；不插入 DOM、不显示、不做整屏截图
- 单轮开销毫秒级；日志/缩略图均有上限（60 轮 / 6 张），不会无限增长
- 只有「识别到弹窗」时才会点击，其余时间纯观察

## 弹窗识别与安全铁律（血泪换来的）

1. 「结束订单」出现在 *退出云电脑 / 订单到期* 类弹窗里 —— **盲点它会直接下机**（实测踩过，可用时长还剩 24 分钟就被点掉）
2. 「确认 / 确定」必须**同时命中无害上下文**（时长不足/公告/温馨提示…）才允许点；判不出就不点
3. 「去充值 / 前往充值 / 支付 / 购买」是消费按钮，永久拒点
4. 「重新连接」只在**视频流已死**（无 video 或 paused）时才点；流活着时点它会打断用户观看
5. 弹窗正文必须**剔除按钮文字**，否则「请前往充值」这种正文会把无害弹窗误判成含危险动作
6. DOM 里有按钮 != 能点：必须用 `elementFromPoint` 命中自己/后代，否则说明被遮罩压着

### 判定优先级（decide）

```
按钮名 ∈ DANGER_BTN          -> 拒点 (DANGER_BUTTON)
按钮名 == 重新连接            -> 流死才点 (RECONNECT_DEAD_STREAM) / 流活跳过 (STREAM_ALIVE_SKIP)
正文含 DANGER_TOPIC          -> 拒点 (DANGER_TOPIC)
按钮名 ∈ {确定,确认,好的}     -> 必须命中 HARMLESS 才放行 (否则 STRICT_BTN_NO_CONTEXT)
按钮名 == 取消               -> 拒点 (CANCEL_AMBIGUOUS)
按钮名 ∈ {知道了,关闭,好的…}  -> 放行 (SAFE_CLOSE)
其它                          -> 拒点 (UNKNOWN_BUTTON)
```

## 界面状态判据（实测）

```
IDLE      无 video / airLinks.pc 为假
TUTORIAL  [class*=tutorial-Container] 可见（全屏引导遮罩，会挡掉所有点击）
LANDING   [class*=start-tip___] 可见且宽度 > 40% 视口
DIALOG    [class*=mask-container] / [class*=popup-container] 可见
DESKTOP   video.readyState>=2 && !paused && airLinks.pc 为真
```

站点弹窗组件的真实类名（来自源码）：

| 组件 | 类名 |
|---|---|
| 主弹窗遮罩 | `mask-container___hMK7A` |
| 次级弹窗 | `popup-container___rdhyF` |
| 轻提示 | `toast-container___yxEUj` |
| 引导遮罩 | `tutorial-Container___XTFJh` / `clickArea___ruRIF` |
| 开局覆盖层 | `start-tip___D5l8Z` |

> 注意：这些类自带 `opacity:0`（靠入场动画才变 1）与 `pointer-events` 相关规则；
> 做合成节点测试时必须显式覆盖 `opacity:1; pointer-events:auto`，否则会被判为不可见/不可点。

## 验证情况

| 项 | 结果 |
|---|---|
| 纯决策自测 `selfTest()` | **11/11** |
| DOM 对照实验（合成与真实重连弹窗同构的节点） | **6/6** |
| 定时器实跑 | 10 秒档连续三次触发、间隔精确；随后切回 180000ms |
| 产物本体回读执行 | 从仓库 raw 拉回 `eval` 后 `VERSION=2.3`、`selfTest 11/11`、干净页误报 0 |

**未覆盖**：真实弹窗只实测过「重新连接」一类；破坏性/无害判定来自合成对照实验，
不等同于覆盖了全部线上弹窗。
