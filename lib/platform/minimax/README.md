# minimax —— MiniMax Code（agent.minimax.cn）平台驱动

> 平台：<https://agent.minimax.cn>（产品名 MiniMax Agent / MiniMax Code，agent 自称 **Mavis**）
> 底座：云端 K8s Pod，**工具由服务端派发**，Web 客户端没有 exec / 文件 / 终端入口。
> 本目录只做「会话管理 + 对话」，**刻意不声明 exec / fs**。

```
lib/platform/minimax/
  index.js       provider 定义：能力位 / auth / instances / agent / model / doctor
  transport.js   HTTP 层：公共 query、x-signature、yy 自算、SSE 解析、token 轮换回收
  map.js         会话 → Instance、消息/SSE 负载 → 契约 Event（纯函数）
  selftest.js    纯离线自检（42 项，不联网、不需要凭据；含 yy 的真机抓包复算）
  README.md      本文件
```

自检：

```bash
node lib/platform/minimax/selftest.js        # ✓ 42/42，退出 0
node --check lib/platform/minimax/index.js
node test/contract.js                        # 18 项（内核契约，不受本驱动影响）
```

---

## 1. 能力位：声明什么、为什么不声明

| 能力 | 声明 | 依据 |
|---|---|---|
| `auth` | ✅ | `token` JWT 快照 + cookies；每次请求从 store 重读（token 会静默轮换） |
| `auth.browser` | ✅ | 登录只有短信验证码（`/v1/api/user/login/sms/send` → `/login/phone`），只能在浏览器里完成 |
| `instances.list` | ✅ | `GET /minimax-cloud/api/v1/sidebar/session/tree`（**纯 HTTP**，2026-11-17 打通） |
| `instances.meta` | ✅ | `GET /minimax-cloud/api/v1/session/{id}`（**纯 HTTP**，实测输出见 §7.2） |
| `agent` | ✅ | SSE `agent-stream…/events` + 轮询 `/session/{id}/message` |
| `model` | ✅ | `/minimax-cloud/api/v1/config`（纯 HTTP） |
| `instances.create` / `rename` / `remove` | ❌ | 写接口**未实测**，不猜 |
| `exec` / `exec.background` / `fs` | ❌ | **平台没有这条通道**（见第 5 节，这是结论不是遗漏） |
| `agent.question` / `agent.interrupt` | ❌ | `agent/{id}/questionnaire/pending` 只看到 GET，回答/打断的写接口未实测 |
| `auth.renew` | ❌ | 没有 SSO/刷新令牌链路，token 只能重抓 |

`limits`：`{ maxSyncMs: 15000, defaultSyncMs: 10000, maxBackground: false }` —— 没有 exec 通道，这两个数字只是让内核的"同步/后台"决策不报错。

---

## 2. 鉴权：三件套 + 两个身份参数 + 公共 query

每个请求都要带：

| 位置 | 值 | 状态 |
|---|---|---|
| 头 `token` | JWT（约 385 字符，HS256） | ✅ 已验证 |
| 头 `x-timestamp` | 秒级时间戳 | ✅ |
| 头 `x-signature` | `md5(timestamp + "I*7Cf%WZ#S&%1RlZJ&C2" + body)` | ✅ **已逆出**，逐字节验证过 |
| 头 `yy` | 32 hex，每请求不同 | ✅ **已逆出**（§3），但**服务端不校验**——不带也 200 |
| query `user_id` | **必须是 `userInfo.realUserID`**（≠ JWT 的 `user.id`） | ✅ 硬门禁：错/缺 → **401 空体** |
| query `device_id` | 纯数字（浏览器是 8 位随机数）；不传也行 | ✅ 硬门禁：UUID/空串 → **401 空体** |
| query | 22 个公共参数（含 `token` 本身、`unix` 毫秒、`uuid`） | ✅ 已对齐 |

签名的两个关键点（selftest 里都有硬编码期望值守着）：

- **GET 的空 body 就是空字符串**：`md5(ts + SECRET)`，不是 `md5(ts + SECRET + "{}")`；
- **签名用的 body 与发出去的 body 必须是同一份字节**：`build()` 只 stringify 一次，`init.body` 与 `x-signature` 用的是同一个变量。

token 会**静默轮换**（同一账号，旧 token 打 `/tree` 直接 401，新 token 200）。所以：

- `transport` 每次请求都从 `ctx.store.read('auth')` 重读 token，**模块级不缓存**；
- 响应里出现新的 `_token`（`Set-Cookie` 或 `token` 响应头）时顺手写回快照（`absorbToken`）—— 这条**未验证**（不知道平台是否在响应头里轮换），是尽力而为。

公共 query 的拼装规则：固定字段按实测顺序排；调用方额外参数同名**就地覆盖**、异名**追加**；最后无条件把 `token` 覆盖成最新值。selftest 断言了逐字顺序、`token` 只出现一次、以及"传旧 token 也会被覆盖"。

UA 用桌面上同一版本的 Chrome 串（与 query 里自称的 `os_name=Windows` / `browser_name=Chrome` 一致）；Node 默认的 `node` UA 容易被网关直接拦。**UA 是否被强校验未验证**。

---

## 3. yy：逆出来了，而且**它不是门禁**（2026-11-17 定论）

一句话：**`yy` 的算法已经完全还原（与浏览器逐字节一致），但服务端根本不校验它 ——
所以 MiniMax 现在可以纯 HTTP 驱动，不需要浏览器、不需要抓包、不需要 Playwright 常驻。**

### 3.1 算法（bundle 原文 + 逐字节验证）

前端 `prod-web-sh-0.1.269` 里两个模块拼起来就是全部（`52724` 算，`65776` 拼）：

```js
// 65776: wQ —— 把参数对象拼成 "url?k=v&..."
function wQ(e, t) {
  const i = new URLSearchParams(t).toString();
  return e.includes('?') ? `${e}&${i}` : `${e}?${i}`;
}

// 52724: yy —— 两次 md5，中间夹一个 time
function yy({ hasSearchParamsPath: t, bodyToYY: i, method: a, time: n, body: s }) {
  let o = '{}';
  if (a && a.toLowerCase() === 'post') o = s ? JSON.stringify(s) : '{}';
  if (i) o = i;
  return md5(`${encodeURIComponent(t)}_${o}${md5(n.toString())}ooui`);
}
```

驱动里就是 [`transport.computeYY(url, params, ts, body, method)`](transport.js)。

**三个坑**（当初「四种候选全不匹配」就卡在第 2 条，绕了大半天）：

| # | 坑 | 具体 |
|---|---|---|
| 1 | `encodeURIComponent` 的位置 | 它作用在 `wQ(...)` 那一整个 **`path?query`** 字符串上，不是分段编、也不是先 hash 再编 |
| 2 | **`op_ticket=undefined`** | 公共参数里 `op_ticket = userInfo.op_ticket`（本账号是 `undefined`）。`URLSearchParams` 会把它序列化成字面量 `op_ticket=undefined`，而 **axios 拼真 URL 时会把 `undefined` 丢掉** ⇒ yy 的输入比你在 Network 面板看到的 URL **多一段**。位置在 `user_id` 之后、`screen_width` 之前 |
| 3 | `time` 是**整秒**毫秒 | 前端用 `Date.parse(new Date().toString())`，毫秒位恒为 `000`，等于 URL 上的 `unix=` 参数；**不是** `Date.now()` 的原始毫秒 |

### 3.2 自证方式（都在 `selftest.js` 里，期望值硬编码）

- **真机 19/19**：CDP 里 hook `fetch` 抓到 19 条带 `yy` 的请求（完整 URL + `x-timestamp` + `yy`），
  用 `computeYY` 复算 —— **19 条全部逐字节相同**；
- **反向 200**：把复算出来的 yy 拿去真打 `/sidebar/session/tree` → **200**（不是"算得对但没用"）；
- **离线固化成用例**：`selftest.js` 里 3 组硬编码期望值（tree / config / POST），
  数据是抓包原值，**只有 token 换成了假串**（真 token 是凭据，不能进代码）。

### 3.3 决定性反证：yy **不参与校验**

抓到 yy 之后，最省事的做法是"验证一下它到底管什么"，结果直接把前提推翻了：

| 实验（同一条 `/sidebar/session/tree`，身份参数都正确） | 结果 |
|---|---|
| `yy` = 复算值（浏览器等价） | **200** |
| `yy` = 随机 32 hex | **200** |
| `yy` = 32 个 `0` | **200** |
| `yy` = 空串 `''` | **200** |
| **不带 `yy` 头** | **200** |
| `x-signature` = 错的（32 个 `0`） | **400 `{"error":"invalid signature"}`** |

⇒ **`yy` 是前端自己加的一层"看着像安全"的装饰**，服务端不验。
`/minimax-cloud/*` 的其它读接口（`/session/{id}`、`/session/{id}/message`、`/agent`、`/skill`、
`/plugins/enabled`、`/interaction/capabilities`）不带 yy 也全部 **200**。

### 3.4 那当初的 401 是什么？—— 真凶是 `user_id` 和 `device_id`

「缺 yy 一律 401」这个结论是**错的归因**。逐项做差分（每次只改一个参数、重算 yy）才定位到：

| 变量 | 传什么 | 结果 |
|---|---|---|
| `user_id` | `userInfo.realUserID`（如 `578884…795`） | **200** |
| `user_id` | JWT 里的 `user.id`（同一账号，但是另一个数） | **401 空体** |
| `user_id` | 不传 | **401 空体** |
| `device_id` | 纯数字（浏览器里是 8 位随机数，换个随机数也行） | **200** |
| `device_id` | UUID 形态（我们早期就存的是 uuid） | **401 空体** |
| `device_id` | 空串 | **401 空体** |
| `device_id` | **不传** | **200** |
| `uuid` | 随便改 / 不传 | **200**（只管埋点） |

也就是说：**JWT 的 `user.id` ≠ `userInfo.realUserID`**，早期版本把前者塞进 query，
每条受保护请求都 401 —— 而当时恰好"没带 yy"，于是 yy 背了锅。

驱动的处理：

- `auth.login()` 落地 token 后**立刻探一次** `/v1/api/user/info` 把 `realUserID` 写进快照；
  快照里没有时，`transport.request()` 会**自动补一次**（`ensureRealUserId()`），补到的值缓存下来；
- `device_id` 不是纯数字时自动换成 8 位数字并落盘（`ensureDeviceIds()`）；
- `yy` 照算（为了"和浏览器逐字节一致"这件事可自证），但**缺了不抛**，`yy:false` 还能整个不发。

### 3.5 还剩什么自由度没拿下

- **写接口**（`POST /session/{id}/message`、`/queue`、`/interaction/*` 的提交）没实测 ——
  yy 不校验这条结论只在 **GET 读接口**上验证过（19 条抓包全是 GET；POST 只做了离线自证）。
  `agent.send` 依旧默认关着，就是这个原因。
- `agent-stream.minimax.cn/.../events`（SSE）也是 GET，同样不带 yy 走通；但帧格式未固化（见第 6 节）。

---

### 3.6 请求失败时的降级（不再是"缺 yy"）

| 调用 | 行为 |
|---|---|
| `instances.list` | 实时拉 `/tree`；请求失败（401/网络）→ 返回上次快照，数组上挂 `stale:true` + `warning`；连快照都没有 → 空数组 + `stale:true` + `warning`（**不抛**） |
| `instances.get` | 失败时先看快照；快照里没有才抛 `E_UNAUTHORIZED` / `E_NO_TOKEN` |
| `instances.info` | 降级成静态说明 + `facts` 里注明"数据来源：本地快照/无数据"（**不抛**） |
| `agent.stream` | SSE 优先；不可用时轮询 `/message`；两条路都是纯 HTTP |
| `model.list` / `model.refresh` | 不受影响 |

`stale` 是挂在数组上的自有属性：

```js
const list = await p.instances.list(ctx);
list.stale;    // true = 本地快照
list.source;   // 'live' | 'cache' | 'none'
list.at;       // 快照时间
list.warning;  // 给人看的一句话
list.reason;   // 'E_UNAUTHORIZED' / 'E_NO_TOKEN' / …
```

## 4. 接口与事件映射

| 方法 | 路径 | 实测 | 驱动里在哪 |
|---|---|---|---|
| GET | `/v1/api/user/info` | 200（不带 yy） | `doctor.checks({probe:true})` / 取 realUserID |
| GET | `/minimax-cloud/api/v1/config` | 200（不带 yy） | `model.refresh` |
| GET | `/minimax-cloud/api/v1/sidebar/session/tree` | 200（不带 yy） | `instances.list` |
| GET | `/minimax-cloud/api/v1/session/{id}` | 200（不带 yy） | `instances.get` |
| GET | `/minimax-cloud/api/v1/session/{id}/message` | 200（不带 yy） | `agent.stream`（轮询）/ `agent.history` |
| GET | `/agent`、`/skill`、`/plugins/enabled`、`/interaction/capabilities` | 200（不带 yy） | 未包装成能力位 |
| GET | `agent-stream.minimax.cn/minimax-cloud/api/v1/events` | 200（不带 yy，SSE） | `agent.stream`（首选） |
| POST | `/minimax-cloud/api/v1/session/{id}/message` | **未实测** | `agent.send`（**默认禁用**，见第 6 节） |

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
| `yy` 的完整算法 | **已逆出**（§3） | 自算并带上；`yy:false` 可整个不发（服务端不校验） |
| 写接口是否也校验 yy | 未验（抓包全是 GET） | 读接口已证明不校验；POST 仍默认关着 |
| `yy` 是否与 URL/body 绑定 | 已验：**是**（每请求算一次） | 但服务端不验，所以无所谓 |
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
| 设备标识是否必须先 `device/register` | 未验 | 不需要：`device_id` 换成任意纯数字照样 200（UUID 会 401）；`uuid` 随便改也 200 |
| 额度 / 计费 / 并发会话行为 | 未验 | 不暴露，`info` 里也不猜 |

**发消息的总开关**（默认关，任一处打开即可，`doctor` 会显示当前状态）：

```js
await p.agent.send(ctx, id, { text: 'hi', allowUnverified: true });   // ① 单次调用
// ② 环境变量  MINIMAX_ALLOW_UNVERIFIED_SEND=1
// ③ cowbird.json: { "platforms": { "minimax": { "allowUnverifiedSend": true } } }
// ④ store: settings.json → { "allowUnverifiedSend": true }
```

关掉时抛 `E_UNVERIFIED_SEND`，信息里写清"body 未实测"和三处开关 —— 不静默失败、也不假装成功。想自己定 body：传 `{body:{...}}`（会覆盖默认的 `{content}`）。

---

## 7. 怎么用真账号跑

前提：Node 18+（本仓库跑 Node 24），且**你自己**已在浏览器登录 agent.minimax.cn。
**登录只需要做一次**；之后全程纯 HTTP，不需要浏览器开着、也不需要抓 yy。

### 7.1 落登录态（唯一需要浏览器的一步）

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

const r = await p.auth.login(ctx, { token: '<JWT>', cookies: { _token: '<JWT>' } });
console.log(r.realUserId);           // 落地时会自动探一次 /v1/api/user/info 拿 realUserID
console.log(await p.auth.state(ctx)); // ok / tokenPreview / exp / realUserId / yy.mode
```

`auth.login` 会顺手补两件**必需**的东西（不补就会 401，且看起来像"登录态坏了"）：

1. `realUserID` —— query 里 `user_id` 必须用它（≠ JWT 的 `user.id`）；
2. `device_id` —— 强制成纯数字（早期存的是 UUID，会 401）。

临时试跑可以完全不落盘：`MINIMAX_TOKEN=<JWT>`（可选 `MINIMAX_UUID` / `MINIMAX_DEVICE_ID` /
`MINIMAX_REAL_USER_ID`；`MINIMAX_YY` 只剩调试意义）。

### 7.2 真机实跑输出（2026-11-17，同一个账号，纯 HTTP）

```console
$ node bin/cowbird.js --platform minimax ls
ID               名字                状态     最近活动
───────────────  ──────────────────  ───────  ────────────────
464000000000001  示例会话 A  idle     2026-11-17 00:55
464000000000004  示例会话 B        aborted  2026-11-17 00:40

共 2 个 · 平台 MiniMax Code（agent.minimax.cn）
```

```console
$ node bin/cowbird.js --platform minimax info 464000000000001
项目        值
ID          464000000000001
名字        示例会话 A
状态        idle
平台        MiniMax Code（agent.minimax.cn），agent 跑在云端 K8s Pod 上
会话        464000000000001 · 示例会话 A
状态        idle（status_type=0）
Agent       464087654089272
模型        MiniMax-M3.1-Flash（provider=minimax）
上下文窗口  512000 tokens
思考链      variant=thinking，effort=max
创建时间    2026-11-17T00:41:00.900Z
更新时间    2026-11-17T00:55:16.458Z
类型        session_type=0，team_mode=off，project_id=0
算力与配额  平台不暴露：控制面没有 CPU/内存/磁盘字段，也没有 exec/fs 通道可以自己量（工具由服务端派发）
数据来源    实时读取（/session/{id}）
```

```console
$ node bin/cowbird.js --platform minimax history 464000000000001 --json
{"platform":"minimax","id":"464000000000001","messages":20,"lines":10,"truncated":false,
 "raw":"…/history-464000000000001.jsonl","txt":"…/history-464000000000001.txt"}
```

```console
$ node bin/cowbird.js --platform minimax doctor
✓  登录态               token eyJhbGciOi…（已截断，来源 store）
✓  yy                   自算（…md5(enc(path?query) + "_" + body + md5(整秒毫秒) + "ooui")，与浏览器抓包逐字节一致）。
                         实测服务端**根本不校验** yy（整个删掉也 200），所以它不是门禁
✓  user_id / device_id  query 的 user_id = 578884…795（realUserID，不是 JWT 的 user.id 578884…149）；device_id = 20555806
✓  会话快照             2026-11-17T03:04:33.794Z（2 个会话）
```

### 7.3 代码里怎么用

```js
const list = await p.instances.list(ctx);        // 实时（不再有 yy 门禁）
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

出问题先按这个顺序排（**别再怀疑 yy**）：

| 现象 | 先看 |
|---|---|
| 401 空响应体 | `auth.state().realUserId` 有没有；`device_id` 是不是纯数字 |
| 400 `invalid signature` | `x-signature` 的 body 与发出去的 body 是否同一份字节 |
| 200 但字段为空 | 可能被网关拦成 HTML 了，看 `E_PARSE` 的 `body` |

### 7.4 发消息（可选，默认关）

```js
await p.agent.send(ctx, inst.id, { text: '你好', allowUnverified: true });
// 然后 watch：
for await (const ev of p.agent.stream(ctx, inst.id)) { if (ev.kind === 'done') break; }
```

如果 `send` 返回 400/422，多半是 body 猜错了（比如平台要 `messages[]` 或 `chat_type`）。这时不用改代码：传 `{body:{...}}` 覆盖，确认之后再把结论写回本 README 的"未验证"表。
**注意**：yy 不校验这条结论只在 GET 读接口上验证过，写接口未实测 —— 这是 `send` 仍然默认关着的原因。

### 7.5 store 里会留下什么

`<COWBIRD_HOME>/platform/minimax/`（`registry.context()` 给的目录，权限 0600）：

| 文件 | 内容 |
|---|---|
| `auth.json` | `{token, cookies, uuid, device_id, user_id, realUserID, savedAt, exp, rotatedAt}` |
| `yy.json` | `{entries:[{yy, path, capturedAt}], updatedAt}` —— **只剩调试用途**（覆盖自算值） |
| `tree.json` | `{at, data}` 上次成功的 `/tree` 原始响应（请求失败时的 stale 来源） |
| `config.json` | `{at, data}` 上次 `model.refresh` 的原始 config |

---

## 8. 错误码

| code | 何时 | 怎么办 |
|---|---|---|
| `E_NO_TOKEN` | 没有任何 token | `auth.login` / `MINIMAX_TOKEN` |
| `E_UNAUTHORIZED` | 401/403 | ① token 轮换/过期 → 重抓；② query 的 `user_id` ≠ realUserID；③ `device_id` 不是纯数字 |
| `E_HTTP` 400 `invalid signature` | 签名错 | 检查签名用的 body 与发出的 body 是否同一份字节 |
| `E_UNVERIFIED_SEND` | 发消息开关没开 | 见第 6 节的四开关 |
| `E_HTTP` | 其它非 2xx | 看 `status` / `body` |
| `E_NETWORK` / `E_ABORTED` | 连不上 / 被取消 | 重试或加 `timeoutMs` |
| `E_PARSE` | 2xx 但不是 JSON | 多半被网关拦了，看 `body` |
| `E_NOT_FOUND` | 会话 id 不存在 | 对一下 `ids` |

---

## 9. 已知取舍

- **yy 照算但不依赖它**：算法还原到逐字节（§3），实测服务端不校验；既不拿它当门禁，也不拿它当"安全"来吹。
- **不实现 `agent.interrupt`**：`status_type:3` 证明平台能中止，但中止接口没抓到，编一个假的比不支持更坏。
- **写接口仍然默认关**：GET 读接口已证明不需要 yy，但 `POST /session/{id}/message` 的 body、以及"写接口是否也跳过 yy 校验"都没实测，宁可挡住。
- **SSE 帧格式宽松解析**：宁可多吐 `raw`，也别把平台以后加的新字段吃掉。真跑出帧之后，把真实格式补进第 6 节。
- **`token` 在 query 与头里各有一份**：两份都从同一个快照读，不会出现"头是新的、query 是旧的"。
