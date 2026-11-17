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
- ✅ **`fs`（读/写/列）**：数据面打通后可用 ——
  读 `GET /explorer/<sid>/file/<相对路径>`、写 `PUT` 同一路径、列目录走 WS `fs.readdir`
  （没有 HTTP 版本，所以列目录要求 Node ≥ 22 的内置 WebSocket）：

  ```bash
  cowbird --platform trae get <会话> src/index.js        # 读工作区文件
  cowbird --platform trae put <会话> ./local.js src/x.js # 写回工作区
  ```
- ❌ **`exec` / `fs`**：网页版 156 条端点里没有 terminal/pty/shell/exec。沙箱里的真 shell 只有
  三个入口：agent 的 `Shell` 工具（走模型回合）、VNC 桌面（`wss://<sandbox>…/websockify`）、
  IDE/文件通道（`/explorer/<sid>` WS）。数据面鉴权还差一个头，见下。
- ❌ **`agent.send`（`prompt`）走不了 HTTP**：网页端发消息不是 `POST /messages`，而是
  `wss://frontier.zijieapi.com/ws/v2?…&Authorization=Cloud-IDE-JWT%20<jwt>&productCode=solo_web`
  上的**二进制 protobuf 双向流**（opcode=2，帧里有 `x_frontier_*` 字段）。HTTP 的
  `POST /chat_sessions/:sid/messages` 是给 lite/IDE/IM 客户端用的，body 有严格 schema，
  连「回读出来的 user message 镜像字段」都被 `991102 invalid parameter` 打回。
  ⇒ 要做 `prompt` 得实现 protobuf WS，不在本期范围；驱动会明确报这条未打通。
- ⚠️ **事件流是轮询**：官方 `subscribe` 是带 heartbeat 的 SSE，但帧格式未摸；先用
  `messages` 做 diff（语义等价：新消息 → 归一事件 → 完成时 `done`）。

## 5. 数据面：鉴权已破解（`exec` 仍然没有）

**要什么**（2026-11-18 实测，别再用 Bearer 试了）：

```http
Authorization: Cloud-IDE-JWT <Cloud-IDE-JWT>      ← 字面的 scheme 名，14 字符含空格
X-Trae-Client-Type: web
```

- 后面跟的是 `GetUserToken` 换到的那个 8h JWT，**不是** `Bearer <会话令牌>`、**不是**
  `Bearer <Cloud-IDE-JWT>`、也不是 `x-cloudide-token`。之前 401 的唯一原因是 scheme 前缀写错。
- WS 形态：浏览器 JS 不能设请求头，前端把空格换成点塞进子协议 ——
  `Sec-WebSocket-Protocol: Cloud-IDE-JWT.<jwt>`，服务端 101 并回显该子协议。
- WS 协议是 **JSON-RPC 2.0**（`system.ping` 回 ts，`fs.readdir` 可用），心跳 30s。

**数据面有什么**（12 条路由，bundle 里 `transport:"dataPlane"` 的全部）：

```
/file/:path          读工作区文件（**只认 git 树里的相对路径**，/etc/hostname 读不到）
/uploadFile          上传
/slash/list, /slash/:type/:scope/:name      slash 补全
/diffview/*          turn / toolcall / products 的 diff
/atfile, /archive.zip, /convert/file/:path
```

**有没有 exec —— 没有**（三条独立证据）：
① 数据面 12 条路由里没有 terminal/pty/shell/exec/process；
② WS 的 JSON-RPC 方法空间只有 `fs.*` 与 `system.ping`；
③ VNC（`wss://<sandbox>.…/websockify`）是 RFB 像素协议，不是命令行。
⇒ 沙箱里跑命令的唯一入口仍是 agent 的 `Shell` 工具（走模型回合、消耗额度）。

**`fs` 已落地**（`fs.list` = WS `fs.readdir`，`fs.read`/`fs.write` = `/file/:path` 的 GET/PUT）。
三条限制必须知道：

1. 路径是**工作区相对路径**（git 树的路径），`/etc/hostname` 这种绝对路径读不到；
2. 会话**离线**时（`x-explorer-mode: offline`）数据面读的是 **restic 备份的 git 快照**，
   即「最后一次提交」的状态，不是沙箱当前状态；
3. 列目录只有 WS 一条路，需要 Node ≥ 22（低版本会明确报 `E_UNSUPPORTED`）。

## 6. 自测

```bash
node lib/platform/trae/selftest.js     # 19 项，全离线（假传输）
```

覆盖：cookie 解析、登录指引与校验、status 映射、会话归一、消息 → 归一事件（含非零退出码）、
历史摊平、分页收尾、create/remove/rename 的请求形状、`agent.send` 991102 的明确报错、
`agent.stream` 的轮询增量与 `done`、能力位（有 AGENT 没 EXEC）。
