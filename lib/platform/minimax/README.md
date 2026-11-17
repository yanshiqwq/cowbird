# minimax —— MiniMax Code（agent.minimax.cn）平台驱动

> 平台：<https://agent.minimax.cn>（产品名 MiniMax Agent / MiniMax Code，agent 自称 **Mavis**）
> 底座：云端 K8s Pod，**工具由服务端派发**，Web 客户端没有 exec / 文件 / 终端入口。
> 本目录只做「会话管理 + 对话」，**刻意不声明 exec / fs**。

```
lib/platform/minimax/
  index.js       provider 定义：能力位 / auth / instances / agent / model / doctor
  transport.js   HTTP 层：公共 query、x-signature、yy 提供器、SSE 解析、token 轮换回收
  map.js         会话 → Instance、消息/SSE 负载 → 契约 Event（纯函数）
  selftest.js    纯离线自检（33 项，不联网、不需要凭据）
  README.md      本文件
```

自检：

```bash
node lib/platform/minimax/selftest.js        # ✓ 33/33，退出 0
node --check lib/platform/minimax/index.js
node test/contract.js                        # 18 项（内核契约，不受本驱动影响）
```

---

## 1. 能力位：声明什么、为什么不声明

| 能力 | 声明 | 依据 |
|---|---|---|
| `auth` | ✅ | `token` JWT 快照 + cookies；每次请求从 store 重读（token 会静默轮换） |
| `auth.browser` | ✅ | 登录只有短信验证码（`/v1/api/user/login/sms/send` → `/login/phone`），只能在浏览器里完成 |
| `instances.list` | ✅ | `GET /minimax-cloud/api/v1/sidebar/session/tree`（需要 `yy`） |
| `instances.meta` | ✅ | `GET /minimax-cloud/api/v1/session/{id}`（需要 `yy`） |
| `agent` | ✅ | SSE `agent-stream…/events` + 轮询 `/session/{id}/message` |
| `model` | ✅ | `/minimax-cloud/api/v1/config`（**不需要 `yy`**，是唯一纯 HTTP 可自证的端点） |
| `instances.create` / `rename` / `remove` | ❌ | 写接口**未实测**，不猜 |
| `exec` / `exec.background` / `fs` | ❌ | **平台没有这条通道**（见第 5 节，这是结论不是遗漏） |
| `agent.question` / `agent.interrupt` | ❌ | `agent/{id}/questionnaire/pending` 只看到 GET，回答/打断的写接口未实测 |
| `auth.renew` | ❌ | 没有 SSO/刷新令牌链路，token 只能重抓 |

`limits`：`{ maxSyncMs: 15000, defaultSyncMs: 10000, maxBackground: false }` —— 没有 exec 通道，这两个数字只是让内核的"同步/后台"决策不报错。

---

## 2. 鉴权：三件套 + 公共 query

每个请求都要带：

| 位置 | 值 | 状态 |
|---|---|---|
| 头 `token` | JWT（约 385 字符，HS256） | ✅ 已验证 |
| 头 `x-timestamp` | 秒级时间戳 | ✅ |
| 头 `x-signature` | `md5(timestamp + "I*7Cf%WZ#S&%1RlZJ&C2" + body)` | ✅ **已逆出**，逐字节验证过 |
| 头 `yy` | 32 hex，每请求不同 | ❌ **算法未逆出**（见第 3 节） |
| query | 22 个公共参数（含 `token` 本身、`unix` 毫秒、`uuid`、`device_id`、`user_id`） | ✅ 已对齐 |

签名的两个关键点（selftest 里都有硬编码期望值守着）：

- **GET 的空 body 就是空字符串**：`md5(ts + SECRET)`，不是 `md5(ts + SECRET + "{}")`；
- **签名用的 body 与发出去的 body 必须是同一份字节**：`build()` 只 stringify 一次，`init.body` 与 `x-signature` 用的是同一个变量。

token 会**静默轮换**（同一账号，旧 token 打 `/tree` 直接 401，新 token 200）。所以：

- `transport` 每次请求都从 `ctx.store.read('auth')` 重读 token，**模块级不缓存**；
- 响应里出现新的 `_token`（`Set-Cookie` 或 `token` 响应头）时顺手写回快照（`absorbToken`）—— 这条**未验证**（不知道平台是否在响应头里轮换），是尽力而为。

公共 query 的拼装规则：固定字段按实测顺序排；调用方额外参数同名**就地覆盖**、异名**追加**；最后无条件把 `token` 覆盖成最新值。selftest 断言了逐字顺序、`token` 只出现一次、以及"传旧 token 也会被覆盖"。

UA 用桌面上同一版本的 Chrome 串（与 query 里自称的 `os_name=Windows` / `browser_name=Chrome` 一致）；Node 默认的 `node` UA 容易被网关直接拦。**UA 是否被强校验未验证**。

---

## 3. yy 的现状与绕过（本驱动最诚实的部分）

> **2026-11-17 真机结论（重要）**：**照抄的 `yy` 不能复用**。
> 用 CDP 从浏览器里抓到某个端点**当时**的 `yy`（同路径、1 分钟内），注入 `captureYY` 后
> 用新的 `x-timestamp` 重放 —— `/sidebar/session/tree` **仍然 401（空体）**。
> 也就是说 `yy` 不是"按路径缓存的令牌"，而是**与那一次请求（时间戳/参数）绑定的签名**，
> 一次一用。**在不逆出 `yy` 算法的前提下，MiniMax 无法纯 HTTP 驱动**；
> 本驱动因此只能读"已经能读的那两个端点"（`/v1/api/user/info`、`/minimax-cloud/api/v1/config`），
> 其余一律诚实报错，不假装有数据。
> `captureYY` 现在只保留作**调试/取证**用途，`doctor` 会写明"复用不可行"。

**现状**：`yy` 是一个每请求变化的 32 位 hex。bundle 里能看到结构：

```js
yy = hash( encodeURIComponent(url + params) + "_" + bodyJSON + hash(ts) + "ooui" )
```

但 `wQ(url, params)` 的参数**序列化顺序**与最终 URL 对不上 —— 四种候选（原始/编码 × 带域名/只路径）全部不匹配。**结论：不算出来，照抄。**

**实测约束**：

- `/minimax-cloud/*` **全部**要求 `yy`，不带一律 401 空体；
- 只有 `/v1/api/user/info` 与 `/minimax-cloud/api/v1/config` 例外（这两条可用纯 HTTP 自证签名与 token）；
- 实测**无防重放**：旧 `yy` + 旧 `ts` 照样 200 ⇒ 抓一份可以重复用；
- SSE（`agent-stream` 域）把 `token` 放在 query 里，**不需要 `yy`**。

**本驱动的绕过方式：把 yy 变成"可由用户投放的凭据"。**

`transport` 每次发要 `yy` 的请求时，按下面的顺序找一份：

1. 环境变量 `MINIMAX_YY`（临时试跑用，视为对所有路径生效）；
2. `ctx.store` 的 `yy`（推荐；形状三种都认）：

```jsonc
// 单一全局（最省事）
"abcdef0123456789abcdef0123456789"

// 绑定某条路径（推荐：yy 很可能与 URL 绑定，我们没验证过）
{ "yy": "abcdef…", "path": "/minimax-cloud/api/v1/sidebar/session/tree", "capturedAt": 1794876062782 }

// 多份，按路径挑
{ "entries": [ { "yy": "…", "path": "/minimax-cloud/api/v1/sidebar/session/tree" },
               { "yy": "…", "path": "/minimax-cloud/api/v1/session/*" } ] }
```

匹配优先级：**路径完全匹配 > 前缀通配（`*` 结尾）> 未绑定路径的全局默认**。都命中不了 → 抛 `E_NEED_YY`：

```
该端点需要 yy 头，算法未逆出；请用浏览器侧或以只读端点代替。缺失端点：/minimax-cloud/api/v1/sidebar/session/tree
```

> 缺 yy 时**绝不发请求** —— 发出去必然是 401，还会被后面的人误判成"登录态坏了"。

**怎么抓一份**：浏览器登录 agent.minimax.cn → F12 → Network → 任意 `/minimax-cloud/api/v1/*` 请求 → Request Headers 里复制 `yy`（32 hex）。然后：

```js
const registry = require('./lib/platform');
const p = registry.use('minimax');
const ctx = registry.context(p);
await p.auth.captureYY(ctx, { yy: 'abcdef…', path: '*' });                    // 全局
await p.auth.captureYY(ctx, { yy: '…', path: '/minimax-cloud/api/v1/sidebar/session/tree' }); // 绑路径
```

**没 yy 的时候会怎样**（不崩、也不静默）：

| 调用 | 行为 |
|---|---|
| `instances.list` | 有上次快照 → 返回快照，数组上挂 `stale:true` + `warning`；连快照都没有 → 返回空数组 + `stale:true` + `warning`（**不抛**） |
| `instances.get` | 快照里有 → 返回；没有 → 抛 `E_NEED_YY`（带提示） |
| `instances.info` | 降级成静态说明 + `facts` 里注明"数据来源：本地快照/无数据"（**不抛**） |
| `agent.stream` | SSE 先跑（不需要 yy）；SSE 不可用时轮询 `/message`（**需要 yy**）→ 抛 `E_NEED_YY` 事件，然后 `done` |
| `model.list` / `model.refresh` | 不受影响（`/config` 不需要 yy） |

`stale` 是挂在数组上的自有属性：

```js
const list = await p.instances.list(ctx);
list.stale;    // true = 本地快照
list.source;   // 'live' | 'cache' | 'none'
list.at;       // 快照时间
list.warning;  // 给人看的一句话
list.reason;   // 'E_NEED_YY' / 'E_UNAUTHORIZED' / …
```

---

## 4. 接口与事件映射

| 方法 | 路径 | yy | 驱动里在哪 |
|---|---|---|---|
| GET | `/v1/api/user/info` | 否 | `doctor.checks({probe:true})` |
| GET | `/minimax-cloud/api/v1/config` | 否 | `model.refresh` |
| GET | `/minimax-cloud/api/v1/sidebar/session/tree` | 是 | `instances.list` |
| GET | `/minimax-cloud/api/v1/session/{id}` | 是 | `instances.get` |
| GET | `/minimax-cloud/api/v1/session/{id}/message` | 是 | `agent.stream`（轮询）/ `agent.history` |
| GET | `agent-stream.minimax.cn/minimax-cloud/api/v1/events` | **否** | `agent.stream`（首选） |
| POST | `/minimax-cloud/api/v1/session/{id}/message` | 是 | `agent.send`（**默认禁用**，见第 6 节） |

`/queue`、`/input-summaries`、`/agent`、`/skill`、`/plugins/*`、`/cron`、`/project`、`/channel*`、`/interaction/capabilities`、`/agent/{id}/questionnaire/pending` 的路径都登记在 `transport.P` 里，但驱动**没有**把它们包装成能力位 —— 没实测语义就不声明。

事件映射（`map.js`，全部纯函数）：

| 原始 | kind | 说明 |
|---|---|---|
| `status.status_type`（0 正常 / 3 `user_aborted`） | `status` | `{status, statusType, message}`；0→`idle`、3→`aborted`、其它→`unknown_<n>`（只有 0/3 是实测的） |
| `msg_type:2` 的 `msg_content` | `text` | 差分吐字（累计快照只吐新增部分） |
| `thinking_content` | `thinking` | 附 `durationMs = thinking_duration_ms` |
| `tool_calls[].tool_name` + `tool_call_args` | `tool` | `{id, name, input}`，`input` 是 `JSON.parse(tool_call_args)` |
| `tool_calls[].tool_call_result_data` | `tool_result` | `{id, name, ok, out, exitCode, durationMs, truncated, dispatchedLocally, skipReason}`；`ok` 由 `details.exit_code` 判（没有就 `null`，不假装成功） |
| `usage` | `usage` | `{inputTokens, outputTokens, totalTokens, cacheRead, contextWindow}` |
| `finish_reason === 'endTurn'` | `done` | 整条流只出现一次，且一定在最后 |
| 其它（用户消息、`finish_reason: toolUse`、认不出的 SSE 帧） | `raw` | 旁路，不丢数据 |

**去重语义**：消息按 `msg_id` 建状态，文本/思维链按"上次快照 → 本次快照"差分（累计式和增量式都兼容），工具结果按 `tool_call_id` 全局去重。所以 SSE 和轮询可以**混着用**，不会重复吐字。

`agent.stream` 的通道顺序：

```
connecting → (可选的 sent) → streaming(SSE)
                             ├─ 正常：…→ usage → done(reason=endTurn)
                             └─ 失败/提前断：error 旁路 + status(polling) → 轮询 /message 差分补齐 → done
```

轮询用 `pollMs`（默认 1500ms）、连续 `idleLimit`（默认 2）轮没有新事件就以 `reason:'idle'` 收尾；总时长受 `streamTimeoutMs`（默认 120s）约束。

---

## 5. 为什么没有 exec / fs（关键结论，不是没写）

三条独立证据：

1. **API 面**：`/session/{id}/…` 下只有 `message` / `queue` / `input-summaries`；全量 bundle 里没有 `exec` / `sandbox` / `terminal` / `file` 端点（`/mavis/api/*` 是 Electron 壳的本地能力，Web 端不可达）。
2. **元数据**：工具结果里带 `details.dispatched_locally: false` + `local_dispatch_skip_reason` —— 工具是**服务端派发**的，客户端只负责显示。
3. **网络面**：Pod 内的 `:49983` 只出现在 conntrack 里，没有对外域名/端口（不像 WorkBuddy 的 E2B、Qoder 的 MCP 预览域）。

⇒ 想在 MiniMax 上跑命令，只能让 agent 的 `bash` 去跑（走 LLM、进对话、耗额度）。本驱动因此**不声明** `exec`/`fs`，也**不**实现 `put/get`。

对应地，`instances.info` 的 `visible` / `quota` **一律 `null`**，并在 `facts` 里写：

> 算力与配额：平台不暴露：控制面没有 CPU/内存/磁盘字段，也没有 exec/fs 通道可以自己量（工具由服务端派发）

—— 免得内核把它显示成"0 核 / 0 B"，被误读成采集失败。

---

## 6. 未验证清单（打 * 的是"默认关掉"的原因）

| 项 | 状态 | 驱动里的处理 |
|---|---|---|
| `yy` 的完整算法 | 未逆出 | 只照抄；缺则 `E_NEED_YY` |
| `yy` 是否与 URL/body 绑定 | 未验 | 支持按路径匹配；`*` 全局默认给"图省事"的人 |
| POST `/session/{id}/message` 的请求体 | **未实测** | 按 `{content}` 实现，**默认禁用**；四个开关任一打开（见下） |
| POST 的响应形状 | 未实测 | 原样返回 `data`，不解析 |
| SSE 的事件名 / 帧格式 / 是否需要别的 query | 未实测 | 宽松解析：标准 SSE、NDJSON、一次性 JSON 都认；认不出落 `raw`；额外参数只加 `session_id` |
| `agent-stream` 是否会断线重连、有无心跳 | 未验 | 靠 `streamTimeoutMs` + 轮询补偿 |
| `instances.create/rename/remove` | 未实测 | 不声明 |
| `agent.interrupt`（`status_type:3` 说明平台能中止） | 未实测 | 不声明 |
| `agent.answer`（questionnaire 只有 GET） | 未实测 | 不声明 |
| token 是否在响应头里轮换 | 未验 | `absorbToken` 尽力而为；主要靠重抓 |
| `status_type` 除 0/3 外的取值 | 未验 | 映射成 `unknown_<n>`，原文保留 |
| `msg_type` 除 1/2 外的取值 | 未验 | 非 2 不当正文，落 `raw` |
| tree 里 `archived` 的语义 | 未验 | 默认过滤，`{includeArchived:true}` 可要回来 |
| 设备标识（`uuid`/`device_id`）是否必须先 `device/register` | 未验 | 缺失时生成一份并落盘，保证"像同一个浏览器" |
| 额度 / 计费 / 并发会话行为 | 未验 | 不暴露，`info` 里也不猜 |

**发消息的总开关**（默认关，任一处打开即可，`doctor` 会显示当前状态）：

```js
await p.agent.send(ctx, id, { text: 'hi', allowUnverified: true });   // ① 单次调用
// ② 环境变量  MINIMAX_ALLOW_UNVERIFIED_SEND=1
// ③ wbsbx.json: { "platforms": { "minimax": { "allowUnverifiedSend": true } } }
// ④ store: settings.json → { "allowUnverifiedSend": true }
```

关掉时抛 `E_UNVERIFIED_SEND`，信息里写清"body 未实测"和三处开关 —— 不静默失败、也不假装成功。想自己定 body：传 `{body:{...}}`（会覆盖默认的 `{content}`）。

---

## 7. 怎么用真账号跑

前提：Node 18+（本仓库跑 Node 24），且**你自己**已在浏览器登录 agent.minimax.cn。

### 7.1 落登录态

浏览器 F12 控制台跑（片段见 `auth.login` 的返回值，也可在命令层 `platform login minimax` 里打印）：

```js
(() => {
  const ls = {}; for (const k of Object.keys(localStorage)) if (/token|uuid|device|user/i.test(k)) ls[k] = localStorage.getItem(k);
  const ck = Object.fromEntries(document.cookie.split(/;\s*/).filter(Boolean).map((s) => s.split("=")).map(([k, ...v]) => [k, v.join("=")]));
  return JSON.stringify({ token: ls._token || ck._token, local: ls, cookieNames: Object.keys(ck) }, null, 1);
})()
```

```js
const registry = require('./lib/platform');
const p = registry.use('minimax');
const ctx = registry.context(p);

await p.auth.login(ctx, { token: '<JWT>', cookies: { _token: '<JWT>' } });
console.log(await p.auth.state(ctx));      // ok / tokenPreview / exp / yy.available
```

临时试跑可以完全不落盘：`MINIMAX_TOKEN=<JWT>`（可选 `MINIMAX_UUID` / `MINIMAX_DEVICE_ID` / `MINIMAX_USER_ID` / `MINIMAX_YY`）。

### 7.2 先跑"不需要 yy"的两条，确认签名与 token 是对的

```js
await p.transport.get(ctx, p.transport.P.info);       // /v1/api/user/info
await p.model.refresh(ctx);                            // /minimax-cloud/api/v1/config
console.log(await p.doctor.checks(ctx, { probe: true }));
```

这两条 200 ⇒ `x-signature` + token + 公共 query 全对。**如果这两条 401，先别怀疑 yy**：那是 token 过期/被轮换，重抓一份。

### 7.3 补 yy，然后读会话

```js
await p.auth.captureYY(ctx, { yy: '<32hex>', path: '*' });

const list = await p.instances.list(ctx);
console.log(list.stale, list.length, list.map((x) => `${x.id} ${x.name} ${x.status}`));

const inst = list[0];
console.log(await p.instances.info(ctx, inst.id));
console.log(await p.agent.history(ctx, inst.id, { limit: 5 }));

for await (const ev of p.agent.stream(ctx, inst.id, { timeoutMs: 60000 })) {
  if (ev.kind === 'text') process.stdout.write(ev.data.text);
  if (ev.kind === 'thinking') process.stderr.write('[思考] ' + ev.data.text);
  if (ev.kind === 'done') break;
}
```

### 7.4 发消息（可选，默认关）

```js
await p.agent.send(ctx, inst.id, { text: '你好', allowUnverified: true });
// 然后 watch：
for await (const ev of p.agent.stream(ctx, inst.id)) { if (ev.kind === 'done') break; }
```

如果 `send` 返回 400/422，多半是 body 猜错了（比如平台要 `messages[]` 或 `chat_type`）。这时不用改代码：传 `{body:{...}}` 覆盖，确认之后再把结论写回本 README 的"未验证"表。

### 7.5 store 里会留下什么

`<WB_CLOUD_HOME>/platform/minimax/`（`registry.context()` 给的目录，权限 0600）：

| 文件 | 内容 |
|---|---|
| `auth.json` | `{token, cookies, uuid, device_id, user_id, savedAt, exp, rotatedAt}` |
| `yy.json` | `{entries:[{yy, path, capturedAt}], updatedAt}` |
| `tree.json` | `{at, data}` 上次成功的 `/tree` 原始响应（缺 yy 时的 stale 来源） |
| `config.json` | `{at, data}` 上次 `model.refresh` 的原始 config |

---

## 8. 错误码

| code | 何时 | 怎么办 |
|---|---|---|
| `E_NO_TOKEN` | 没有任何 token | `auth.login` / `MINIMAX_TOKEN` |
| `E_NEED_YY` | 端点要 yy 而没命中 | `auth.captureYY`（或换只读端点） |
| `E_UNAUTHORIZED` | 401/403 | token 轮换/过期 → 重抓；或这份 yy 对该端点无效 |
| `E_UNVERIFIED_SEND` | 发消息开关没开 | 见第 6 节的四开关 |
| `E_HTTP` | 其它非 2xx | 看 `status` / `body` |
| `E_NETWORK` / `E_ABORTED` | 连不上 / 被取消 | 重试或加 `timeoutMs` |
| `E_PARSE` | 2xx 但不是 JSON | 多半被网关拦了，看 `body` |
| `E_NOT_FOUND` | 会话 id 不存在 | 对一下 `ids` |

---

## 9. 已知取舍

- **yy 没逆出来就不硬猜**。缺 yy 一律早停 + 降级，宁可 stale 也不发注定 401 的请求。
- **不实现 `agent.interrupt`**：`status_type:3` 证明平台能中止，但中止接口没抓到，编一个假的比不支持更坏。
- **轮询也受 yy 约束**：这是平台把 `/session/*` 全放在 yy 后面的结果，不是实现偷懒。所以"没有 yy 时 `watch` 还能看"是不成立的。
- **SSE 帧格式宽松解析**：宁可多吐 `raw`，也别把平台以后加的新字段吃掉。真跑出帧之后，把真实格式补进第 6 节。
- **`token` 在 query 与头里各有一份**：两份都从同一个快照读，不会出现"头是新的、query 是旧的"。
