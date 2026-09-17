# 免令牌往 GitHub 仓库写文件（网页路径 Runbook）

> 记录时间：2026-09-17 · 站点：github.com · 目的：在没有 PAT 的浏览器会话里，把内容写进远端仓库并**核验**。

## 1. 为什么需要这条路径

GitHub 的经典/细粒度令牌创建页 **被 sudo 二次认证挡住**：

- 访问 `https://github.com/settings/tokens/new` 会跳到 `/sessions/sudo` 的 **Confirm access** 页；
- 只给两条路：`Use GitHub Mobile`（手机确认）或 `Use your password`（密码 + 2FA）；
- 表单是 `POST /sessions/sudo`，字段 `credential_type=password` + `sudo_password`。

**自动化过不了这一步**（也不应该去要账号密码）。所以没有令牌时，写文件走仓库页面自身的编辑器。

```
# sudo 门槛的现场判据
location.href  -> https://github.com/settings/tokens/new
document.title -> "Confirm access"
form.action    -> https://github.com/sessions/sudo
form.fields    -> authenticity_token / sudo_return_to / credential_type / sudo_password
```

## 2. 已验证的写入方法（CodeMirror 6）

1. 打开新建/编辑页：`https://github.com/<owner>/<repo>/new/main/<dir>`（新建）或 `/edit/main/<path>`（改已有）。
2. 等编辑器就绪：`document.querySelector(".cm-content")` 存在，且 `.cmTile.view` 是真值（CM6 的 EditorView 实例）。初始 `view.state.doc.length === 0` 表示空文件。
3. **用 view 自己的 dispatch 改文档**——不要找 textarea（新版编辑器没有），`form` 也不存在，改 DOM 改不到真实文档。

```js
const view = document.querySelector(".cm-content").cmTile.view;
view.dispatch({
  changes: { from: 0, to: view.state.doc.length, insert: text }
});
// 校验：view.state.doc.length === 期望长度
```

4. 文件名输入框用 **React 原生 setter + input 事件**写入（直接赋 value 不生效）。
5. `Commit changes...` 按钮此时才从 disabled 变可用（**它就是 GitHub 认了这次改动的信号**）→ 点开提交对话框 → 选 **Direct commit to main** → 确认。
6. **回读核验**，见下一节。

## 3. 核验纪律（关键）

- `raw.githubusercontent.com` 带 **CDN 缓存 `max-age=300`**，提交后短时间内仍吐旧内容。**别拿 raw 当唯一证据。**
- 权威来源：`api.github.com`
  - 单文件：`GET /repos/<o>/<r>/contents/<path>?ref=main`（`Accept: application/vnd.github.raw`）
  - 提交：`GET /repos/<o>/<r>/commits/<sha>`（含 `files[].patch`）
- 判定"真写进去了"的强证据：
  1. commit 存在且 `parent` = 上一次的 HEAD（链不断）；
  2. 新增文件断言 `new === inserted`；改已有文件断言 `new === inserted + old`（前缀/后缀相等）；
  3. 长度与 sha 对得上。

## 4. 踩过的坑

- 提交对话框里点错按钮（选中了空文本按钮）→ 对话框关闭、草稿丢失，必须重做；**提交后一律 API 查证（404 = 没写进去）**。
- commit message 常被 GitHub 自动生成的建议覆盖，改动内容无碍，不值得为此 force-push。
- 单次页面脚本调用控制在 **10s 内**（长阻塞式调用会打断站点自身心跳；本站云电脑场景曾因此掉线）。

## 5. 边界

- 该方法需要**已登录且已过 sudo 的浏览器会话**，与"产物不依赖浏览器"无关（这里是仓库维护，不是逆向产物）。
- 令牌若已存在，用 `Authorization: Bearer <PAT>` 走 API 更直接；本文只覆盖无令牌时的兜底。
