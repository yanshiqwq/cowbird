# 协议细节（2026-11-03 实测，2026-11-11 补鉴权）

## 〇、鉴权：cookie **+ UA**（2026-11-11 更正）

以前记的是「鉴权就是登录 cookie，纯 HTTP 打过去 401 是因为 APISIX 卡 TLS 指纹」——
**后半句是错的**，逐项排除如下：

| 变量 | 结果 |
|---|---|
| TLS 指纹（curl_cffi 模拟 chrome / edge101 / safari17） | 全 401 |
| HTTP 版本（node fetch h1.1 / http2 模块 h2） | 都 401 |
| 静态页 `/agents/`、`/login/` | 纯 HTTP 200 ⇒ 站点本身不拦 node |
| 带 / 不带 cookie | 响应逐字节相同（len=653）⇒ 服务端没读到我们的 cookie |
| 浏览器真实 cookie + **浏览器 UA** 1:1 复放 | **200** |
| 只把 UA 改一个字符（Chrome↔HeadlessChrome、版本号、大小写、去 `Edg/` 尾巴） | 全 401 |

⇒ APISIX 把有效会话跟 **`User-Agent` 精确绑定**（尾随空格可以，说明服务端会 trim）。
所以 `state.json` 必须同时保存 `ua` 和 `cookies`，请求时原样发；
`x-user-id` / `x-request-id` 是前端自己加的，**不是**鉴权所需（去掉照样 200）。

另一个坑：响应里每次都带
`session=; Path=/console; Max-Age=0; Expires=Thu, 01-Jan-70 ...`
—— 这是**删除历史遗留的 `/console` 路径 cookie**，不是把 session 置空。
合并 Set-Cookie 必须按 `name + path + domain` 复合键；只按 name 会把 `path=/` 那条
4001 字符的有效 cookie 覆盖成空值，下一轮立刻 401。

## 一、网页版接口

baseURL `https://www.workbuddy.cn`，鉴权是**登录 cookie + 登录时的 UA**（见上）。
`lib/session.js` 负责拿这份状态发纯 HTTP 请求，浏览器只在 `wbsbx login` 时出现。

| 用途 | 接口 | 备注 |
|---|---|---|
| 会话列表 | `GET /console/as/conversations/?page=1&pageSize=50` | 含 `status`/`sessionStatus`/`link`/`manifest`/`runtimeId` |
| 会话详情 | `GET /console/as/conversations/{id}` | |
| **连接凭据** | `GET /console/as/conversations/{id}/session` | 返回 `{link, token, cwd, sessionStatus, e2bEndpoint}` |
| **建容器** | `POST /console/as/conversations/` | body `{prompt(≤100字), model, plugins?}` → 返回含 `session{link,token,sandboxId}` |
| **改名** | `POST /console/as/conversations/{id}` | body `{title}` |
| **删 / 归档** | `POST .../{id}/delete` / `.../archive` | delete body `{id}` |
| 项目列表 | `GET /console/as/projects` | |
| 额度 | `GET /console/user/cloudagent/entitlement` | 个人号 403 |

创建只认 `prompt` + `model`，**名字不在创建参数里**，必须建完再用 `{title}` 改一次。
客户端建会话时还会塞一个内置插件声明，不传也能建成功。

- ❌ 客户端包里那几条 `/v2/...` 旧路径，网页登录态打过去仍 401。以 `/console/as/…` 为准。
- ❌ `.../messages`、`/events`、`/history` 全 404 —— **历史不走接口，在 ACP 里重放**。
- `platform` 取值只有 `admin`（企业控制台）和 `agents`（个人号）。

## 二、ACP 握手

`link = https://<port>-<convId>.workbuddy.agentos-worker.net/acp`，`token` 是 HS256 JWT（`aud=sandbox-gateway`、有效期 3 天）。

```
① POST {link}/bootstrap   headers: Bearer
   body: {initialize:{...}, sessionLoad:{...}}
   ← 响应头 Acp-Connection-Id，body 是 text/event-stream
② POST {link}             headers: Bearer + Acp-Connection-Id
   body: JSON-RPC（session/prompt 等）
③ DELETE {link}           headers: Acp-Connection-Id
```

bootstrap body 照抄这个结构：

```json
{
  "initialize": {"jsonrpc":"2.0","id":900001,"method":"initialize",
    "params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}},
  "sessionLoad": {"jsonrpc":"2.0","id":900002,"method":"session/load",
    "params":{"sessionId":"<convId>","cwd":"/workspace","mcpServers":[]}}
}
```

`session/load` 会把**全部历史**重放成 `session/update`：`params.update._meta['codebuddy.ai'].mode='history'`、`offset` 0..N 递增，带 `sourceContentBlocks`（用户原文）、`toolName`、`timestamp`、`traceparent`。

`session/load` 的**响应体**里还有 `models._meta.codebuddy.ai.availableModels` —— 每个模型带 `id`/`name`/`credits`（如 `x0.29 credits`）/`maxInputTokens`/`supportsToolCall`，想换模型先从这里挑 id。

## 三、事件表

| 方向 | 名称 | 说明 |
|---|---|---|
| ← | `session/update` | 主流。`sessionUpdate` 取值 `session_info_update`（含 `_meta['codebuddy.ai'].status`）、`agent_message_chunk`、`agent_thought_chunk`、工具调用等 |
| ← | `_codebuddy.ai/artifact` | 产物事件 `event: created/updated/deleted`，`uri` 形如 `agent:///workspace/xxx` |
| ← **请求** | `_codebuddy.ai/question` | **AskUserQuestion**。带 `id`，必须回 |
| ← **请求** | `session/request_permission` | 权限审批，也要回 |
| ← **请求** | `mcp/message` | 客户端侧 MCP（`workbuddy-device`）。**不回会卡住那个工具调用**，回 `{tools:[]}` 即可 |
| ← **请求** | `elicitation/create` | 回 `{action:'decline'}` |
| ← | `_codebuddy.ai/interaction_timeout` | `{id, kind:'question'|'permission'}`，服务端宣称超时 |
| ← | `session/endTurn` | 一轮结束 |
| → | `session/prompt` | `params: {sessionId, prompt:[{type:'text',text}]}` |

## 四、AskUserQuestion 回填

```json
{"jsonrpc":"2.0","id":<收到的id>,"result":{"outcome":"submitted","answers":{"<question的id>":["选项label"]}}}
```

放弃：`{"outcome":"cancelled","reason":"..."}`。

**关键：默认 5 分钟超时是客户端 `setTimeout`（`3e5` ms），服务端不计时。** 客户端不回应，这条提问就永远挂着 —— 「永不回答」不需要额外手段，只要别回。

## 五、从客户端包里挖到的常量（`<安装目录>/resources/app.asar`）

```
session/request_permission      _codebuddy.ai/question      elicitation/create
_codebuddy.ai/resolveInterruption   _codebuddy.ai/interaction_timeout
```
响应头 `Acp-Connection-Id` 缺失时报 `{"error":"Acp-Connection-Id required"}`（400）。
旧版尝试里 `GET /acp` 直接返回 `text/event-stream` 但不给 connection id，所以必须走 `/acp/bootstrap`。

## 六、排查建议

遇到 401 先怀疑 **UA 不匹配**，其次才是 cookie 过期：这两件事的响应体不一样，前者是默认的
nginx 401 页，后者是业务 JSON（`invalid_token` + `session expired or invalid`）。
长命进程（daemon）在 Windows 上必须挂在计划任务里，否则注销就没了。
