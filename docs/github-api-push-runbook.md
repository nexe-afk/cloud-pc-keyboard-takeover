# 用 PAT 走 GitHub API 推送（无工作目录方案）

> 记录时间：2026-09-17。与 `github-web-write-runbook.md`（网页编辑器路线）互补。

## 1. 为什么需要这条路线

Agent 侧**没有工作目录**时，`fs_write` / `run_node` / git 全部不可用。可用的替代：

| 路线 | 手段 | 特点 |
|---|---|---|
| A. 网页编辑器 | CodeMirror 6 的 `cmTile.view` → `dispatch({changes})` | 无需凭证；但改大文件有风险、拿不到状态码 |
| B. **PAT + REST API**（本文） | `fetch('https://api.github.com/...')` | **可脚本化、有权威状态码、blob sha 可核验** |

## 2. 创建 classic PAT

1. 打开 `https://github.com/settings/tokens/new`
2. **会被 sudo 关卡拦截** → 重定向到 `/sessions/sudo`（标题 `Confirm access`）：
   ```
   form.action -> https://github.com/sessions/sudo
   fields      -> authenticity_token / sudo_return_to / credential_type=password / sudo_password
   选项        -> Use GitHub Mobile | Use your password
   ```
   **这是账号级安全关卡，自动化过不去，必须人工过。** 未过时 `/settings/tokens/new` 根本不渲染表单（`hasTokenForm: false`）。
3. Note 填用途；Expiration 选 90 days；Scope **只勾 `repo`**。
   - GitHub 会自动把 `repo` 展开成 `repo, repo:status, repo_deployment, public_repo, repo:invite, security_events`，**这是正常的**，不是误勾。
   - 回读响应头 `x-oauth-scopes` 确认为 `repo`（单个）即符合最小权限。
4. 点 **Generate token** → 令牌值**只显示一次**，当场读回。
   - 成功判据：页面跳到 `/settings/tokens`，且可见 flash `Make sure to copy your personal access token now.`
   - 令牌形态：`ghp_` + 36 位。

## 3. 实测验证（必做，别跳）

创建完立刻打三枪确认它真能用：

```js
const r = await fetch('https://api.github.com/user',
  { headers: { Authorization: 'Bearer ' + T } });
r.status          // 200
r.headers.get('x-oauth-scopes')   // "repo"  ← 权威 scope 回读
```

再查目标仓库权限，必须看到 `push: true`：

```js
const j = await (await fetch('https://api.github.com/repos/'+REPO,
  { headers: { Authorization: 'Bearer ' + T } })).json();
j.permissions   // {admin,maintain,push:true,triage,pull}
j.default_branch // "main"
```

> 注意：从 `github.com` 页面上下文 fetch `api.github.com` 可用（API 返回 `Access-Control-Allow-Origin`），所以**不需要工作目录、不需要 curl**。

## 4. 写文件（Contents API）

```js
const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
await fetch('https://api.github.com/repos/'+REPO+'/contents/'+PATH, {
  method: 'PUT',
  headers: { Authorization: 'Bearer '+T, 'Content-Type':'application/json' },
  body: JSON.stringify({ message: 'docs: ...', content: b64(md), branch: 'main' })
});
```

- **新建**：不需要 `sha`。
- **更新**：必须先 `GET` 该文件拿 `sha`，否则报 409。
- 返回体含 `commit.sha` 与 `content.sha`（新 blob sha），**用它做核验**。

## 5. 核验纪律

1. 拿返回的 `content.sha` 与 `commit.sha`，再 `GET` 一次比对。
2. **别用 `raw.githubusercontent.com` 当唯一证据** —— 它有 CDN 缓存（`max-age=300`），常吐旧内容，会误判成"提交失败"。用 `api.github.com` 或网页版。
3. 更新类提交额外断言：`newContent === inserted + oldContent`（前缀/后缀精确匹配），确认没改坏其它段落。

## 6. 安全纪律

- **令牌绝不写入仓库、绝不 commit、绝不进日志文件。**
- 令牌值出现在对话/终端即已暴露 → 用完建议 **Settings → Developer settings → Tokens (classic) → Delete** 立即吊销。
- 生产用途优先用 **fine-grained token** 限定到单仓库 + 最小权限。

## 补充（实测）：可以不离开当前页面直接推

**结论：在被分析页面自身的 JS 上下文里直接 `fetch` GitHub API 是可行的**（浏览器 CORS 允许），因此**不必导航到 github.com 去用网页编辑器**。
这一条很关键：如果当前页面正是一个**已连接的云电脑 / 长会话**，导航离开会中断它；而在页面里 fetch 则不影响会话。

实测数据：

- `GET /repos/{r}/contents/{path}` → 200，正常
- `PUT /repos/{r}/contents/{path}`（新建）→ **201**，约 1.3s（body base64 约 10.9KB）
- `DELETE` → 200
- `OPTIONS` 预检 → 报 NetworkError（不碍事，浏览器缓存/真实预检自行处理，实际 PUT 成功）

### 两个坑

1. **偶发 `JSON.parse: unexpected end of data at line 1 column 1`**：单次 eval 里串行打多个 fetch（>=3 个）时被超时中断，页面侧改动已生效但网络请求没跑完 —— 看起来像 JSON 解析错误，其实是**调用被中断**。
   => **一次 eval 只发 1~2 个请求**；发 PUT 前先把待写内容 `window.__src` 缓存好，重试时不必重新嵌源码。
2. 更新已存在文件**必须带 `sha`**（先 GET 拿 sha），否则 409。
