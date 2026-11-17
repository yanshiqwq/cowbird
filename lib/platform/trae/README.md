# trae —— 字节 TRAE（work.trae.cn）驱动

> 调查时间 2026-11-17。结论：**一个会话 = 一台云端 KVM 真 VM**，但网页版**没有直连执行通道**。
> 本驱动因此不声明 `exec` / `fs`（`cowbird exec` 会直接报能力缺失，退出码 2）。

## 1. 平台形态（实测）

| 项 | 值 |
|---|---|
| 控制台 | `https://work.trae.cn`（SPA `trae-web-mono`，CDN `lf-cdn.marscode.cn`） |
| 会话面 | 同源 `/api/remote/v1/*`（156 条端点） |
| 网站面 | `https://api.trae.cn`（`/cloudide/api/v3/*`：登录态、用户、换 token） |
| 沙箱 | `agent-sandbox-bj-c1-gw.trae.cn/explorer/<sid>`（WebSocket，未打通） |
| 沙箱内的机器 | Ubuntu 24.04 LTS、内核 6.18.5、KVM/QEMU、3 vCPU、每次会话全新 |
| 沙箱目录 | `/workspace`、`/data/user/{work,shared-artifact,skills,plugins}`、`/app/bin` |
| 沙箱出网 | 沙箱内本地代理 `127.0.0.1:18080` |
| 并发 | 单账号会话数未知；`extra.primary_sandbox_type` 有 `harness` / `agent` 两种 |

这些是从「用户历史会话里 agent 自己的环境调查」中读出来的（`messages` 接口能拿到完整的
`plan_item → tool_call_info{name,params,result}`，包括每条 shell 命令和它的 stdout）。

## 2. 鉴权

```
cookie（.trae.cn，含 HttpOnly：sessionid / sid_guard / X-Cloudide-Session / ttwid）
  │  POST https://api.trae.cn/cloudide/api/v3/common/GetUserToken
  ▼
Cloud-IDE-JWT（8h）  →  请求头 x-cloudide-token: <jwt>（同时带 authorization: Cloud-IDE-JWT <jwt>）
```

- 只带 cookie 打 `/api/remote/v1/*` → `401 {"code":401,"message":"authentication required"}`
- 换 token 的响应里 `Result.ExpiredAt` 是 8 小时后；本驱动把它缓存在账号目录的 `token` 里，过期前 5 分钟自动换
- 会话级令牌 `POST /api/remote/v1/auth/session/:sid/token`（2h，`aud:["trae-resource"]`）由
  `provider.sandbox.sessionToken()` 暴露，等数据面打通后用

登录只有一条路：**粘 cookie**（网页版没有可脚本化的登录流）。

```bash
# 浏览器登录 work.trae.cn 后：
#   Console: document.cookie            → 非 HttpOnly 的部分
#   Application → Cookies              → 补 sessionid / sid_guard / X-Cloudide-Session
cowbird --platform trae login --cookie 'sessionid=…; sid_guard=…; X-Cloudide-Session=…; …'
```

`daemon` 的 `warm` 循环每 10 分钟调一次 `POST /cloudide/api/v3/trae/CheckLogin`，
让服务端把这条会话当活跃（cookie 型平台没有 refresh_token，这是唯一可能的"续命"）。

## 3. 已验证的接口

| 方法 | 路径 | 结果 |
|---|---|---|
| GET | `/api/remote/v1/chat_sessions?page_size=&page_num=` | 200，`data.items[] + total` |
| GET | `/api/remote/v1/chat_sessions/:id` | 200（`explorer_url` / `workspace_path` / `sandbox`） |
| GET | `/api/remote/v1/chat_sessions/:id/messages?page_size=100` | 200（160KB/2 会话，结构见下） |
| POST | `/api/remote/v1/chat_sessions` `{mode:"code",title}` | 200 → `{chat_session_id,status}` |
| POST | `/api/remote/v1/chat_sessions/:id/commit` `{chat_session_id,title}` | 改名（前端 renameSession 走这条） |
| DELETE | `/api/remote/v1/chat_sessions/:id` | 200 `{code:0}` |
| POST | `/api/remote/v1/auth/session/:id/token` | 200 → 2h 会话令牌 |
| POST | `/api/cloudide/api/v3/common/GetUserToken` | 200 → Cloud-IDE-JWT |
| POST | `/api/cloudide/api/v3/trae/GetUserInfo` / `CheckLogin` | 200 |

消息结构（`messages` 接口）：

```
data.items[] = { message_id, role, message_type, message_index, content, token_usage, … }
  role=user       content = JSON 字符串 → [{type:"text", text_content:"…"}]
  role=assistant  message_type=task
                  content = JSON 字符串 → { task_id, messages:[ {type:"plan_item", plan_item:{
                      thought, tool_call_info:{ id, name, params, result:{status,data:{stdout,stderr,exit_code}} } }} ] }
```

## 4. 能力边界（重要）

- ✅ `instances.list/get/create/rename/remove`、`agent.history`、`agent.stream`（轮询增量）、
  `agent.interrupt`（`/stop`）、`auth.alive`（`CheckLogin`）
- ❌ **`exec` / `fs`**：网页版 156 条端点里没有 terminal/pty/shell/exec。沙箱里的真 shell 只有
  三个入口：agent 的 `Shell` 工具（走模型回合）、VNC 桌面（`wss://<sandbox>…/websockify`）、
  IDE/文件通道（`/explorer/<sid>` WS）。数据面鉴权还差一个头，见下。
- ⚠️ **`agent.send`（`prompt`）未打通**：请求体形状没拿到，试过 13 种全回
  `400 {"code":991102,"message":"invalid parameter"}`。`ls / info / create / rm / rename / history`
  都正常，只有 `prompt` 会明确告诉你这条未打通（不是让你对着 invalid parameter 猜）。
- ⚠️ **事件流是轮询**：官方 `subscribe` 是带 heartbeat 的 SSE，但帧格式未摸；先用
  `messages` 做 diff（语义等价：新消息 → 归一事件 → 完成时 `done`）。

## 5. 数据面（未打通，留给后续）

`GET https://agent-sandbox-bj-c1-gw.trae.cn/explorer/<sid>` 回
`400 "Connection header did not include 'upgrade'"` ⇒ 这是 WebSocket；WS 握手无条件 101
（`Server: volcclb`）⇒ 鉴权在应用层。它的 HTTP 子路径（`/file/:path`、`/slash/list`）回 401，
错误体暴露了校验方式：

```
User authentication failed: Control plane authentication failed:
GET https://trae-api-cn.mchost.guru/api/remote/v1/chat_sessions/<sid> - 401
```

即网关把凭据转给控制面回查。已试过并失败的头：`authorization: Bearer <会话令牌|Cloud-IDE-JWT>`、
`x-trae-token`、`x-sandbox-token`、`x-cloudide-token`、`cookie`、`x-forwarded-cookie`。
**下一步**：在一次性浏览器里打开该会话的 explorer，用 CDP 抓真实请求头/首帧 —— 拿到后
`exec`/`fs` 才可能加进来（届时把能力位补上，内核不用改）。

## 6. 自测

```bash
node lib/platform/trae/selftest.js     # 19 项，全离线（假传输）
```

覆盖：cookie 解析、登录指引与校验、status 映射、会话归一、消息 → 归一事件（含非零退出码）、
历史摊平、分页收尾、create/remove/rename 的请求形状、`agent.send` 991102 的明确报错、
`agent.stream` 的轮询增量与 `done`、能力位（有 AGENT 没 EXEC）。
