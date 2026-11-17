# 加一个平台：写一个目录

cowbird 现在把「平台」关在 `lib/platform/` 里。**加一个平台 = 新建一个目录 + 实现契约**，内核（命令、daemon、配置、实例解析）一行都不用改。

现有四个驱动可以直接抄：

| 驱动 | 目录 | 它示范了什么 |
|---|---|---|
| WorkBuddy | `lib/platform/workbuddy/` | 有独立数据面（E2B 帧）、ACP 对话、cgroup 两代沙箱 |
| 码道 CodeArts | `lib/platform/codearts/` | 具名 SSE、预览代理直达内核、30s 截断与 busy 重试 |
| Qoder | `lib/platform/qoder/` | event-sourcing 增量拉取、preview/grant → MCP tools/call |
| MiniMax | `lib/platform/minimax/` | **没有执行通道**时怎么优雅降级、签名鉴权 |
| 样例 | `lib/platform/_example/` | 80 行跑通全部契约（也是契约测试的桩） |

---

## 一、目录长这样

```
lib/platform/<id>/
  index.js      ← module.exports = defineProvider({...})   ← 唯一必须的文件
  transport.js  ← 本平台专属 HTTP（cookie/签名/轮换/重试）
  map.js        ← 纯函数：原始响应 → 归一化结构（好测）
  selftest.js   ← 离线自检：node lib/platform/<id>/selftest.js 必须 exit 0
  README.md     ← 已验证 / 未验证 / 用真账号怎么跑
```

`id` 用小写字母数字与连字符（`workbuddy`、`codearts`），下划线开头留给内置样例。

---

## 二、契约速查

```js
const { defineProvider, CAP, EVENT, execResult, fileEntry } = require('../contract');

module.exports = defineProvider({
  id: 'myplatform',
  displayName: '我的平台',
  version: '1.0.0',
  capabilities: [CAP.LIST, CAP.AGENT /* … */],
  defaults: { model: 'xxx' },                       // 进 cowbird.json 的 platforms.<id>
  limits: { maxSyncMs: 60000, defaultSyncMs: 20000, maxBackground: true },

  transport: { request(ctx, req) },                 // 可选，但强烈建议单独一层
  auth:      { state, ttlDays, login, renew, headersFor },
  instances: { list, get, create, rename, remove, info, expiry },
  agent:     { stream, send, history, interrupt, answer },
  exec:      { probe, wake, run, start, poll, put, get },
  fs:        { list, read, write },
  doctor:    { checks },
});
```

**能力位（`CAP`）**：`auth` / `auth.renew` / `auth.browser` / `instances.list|create|rename|remove|meta` / `agent` / `agent.question` / `agent.interrupt` / `exec` / `exec.background` / `fs` / `exec.wake` / `model`

**必需**：`instances.list` 与 `agent`。**声明了能力就必须有对应方法**，否则 `defineProvider` 直接抛错（这一步能挡掉大半手误）。

**`ctx` 里有什么**（驱动只从这里拿内核能力，别 `require('../../config')`）：

| 字段 | 说明 |
|---|---|
| `ctx.provider` | provider 自身（互调方便） |
| `ctx.account` | 账号名（`main` / `default`…）——**同一个平台可以有多份登录态共用你的驱动** |
| `ctx.channel` | `平台:账号`，例如 `workbuddy:main` |
| `ctx.paths` | 数据目录下的标准路径（tokens / logs…） |
| `ctx.config()` | 读全局配置 |
| `ctx.effective` | provider `defaults` + 用户 `platforms.<id>` 合并结果（取默认模型用这个） |
| `ctx.store` | 本驱动**本账号**的私有 KV（`read/write/remove`，落在 `<数据目录>/platform/<id>/accounts/<账号>/`，600） |
| `ctx.log` | 命令层注入的日志函数（默认空） |
| `ctx.now()` | 当前时间（测试可注入） |

### 账号隔离（写驱动时必须读这一段）

一个平台可以挂多个账号，daemon 会在**同一个进程里**交替用不同账号的 `ctx` 调你。所以：

- 登录态、cookie/token、会话列表缓存、游标、隧道……**全部走 `ctx.store`**，
  不要拼 `~/.cowbird/...`，不要 `require('../../config')` 之后自己落盘。目录按账号切分，
  这一条做到了，多账号就是免费的。
- **不要用模块级变量缓存账号数据**（`let cache = null`、`new Map()` 记住上次的 token…）。
  真要缓存，key 必须含 `ctx.store.dir`；能不做就不做 —— 读盘几微秒，串号是事故。
- 平台级配置（baseUrl、默认模型、能力和 limits）放 `defaults`，那本来就与账号无关。
- 按实例的短期凭据（如 E2B 的 `X-Access-Token`）若实例 id 在平台内全局唯一，可以留在全局
  `tokens/<id>.json`；不确定唯一就挪进 `ctx.store`。

自检里请加两条：同一 provider 两个账号的 `store.dir` 不同、A 写的凭据 B 读不到
（`lib/platform/workbuddy/selftest.js` 的 `makeCtx(账号)` 就是现成写法）。

---

## 三、三条硬约束

### 1. `exec` 是能力位，不是命令

没有执行通道就**别声明** `exec`。内核会：

```
cowbird exec …  →  本平台（X）没有执行通道。
                 可用的命令：ls / info / prompt / history / watch / doctor
```

退出码 `2`（与"命令失败=1"区分）。详见 `lib/platform/minimax/`。

### 2. 同步上限由 `limits` 决定，不是内核写死

```js
limits: { maxSyncMs: 28000,   // 平台硬顶（码道 30s → 留 2s 余量）
          defaultSyncMs: 20000,
          maxBackground: true } // 有没有原生后台任务
```

内核的 `lib/platform/exec.js` 据此三选一：
- `timeout ≤ maxSyncMs` → 同步 `exec.run`
- 超了且有 `EXEC_BACKGROUND` → `exec.start` + `exec.poll`
- 超了但没有后台能力 → 把超时压到 `maxSyncMs` 并告警

### 3. 网络与签名全归 provider

内核连 `fetch` 都不出现。Bearer/CSRF 头/JWT 签名/token 轮换一律在驱动的 transport 里。四个真实例子：

| 平台 | 鉴权要点 | 坑 |
|---|---|---|
| WorkBuddy | **仅 accessToken**（Bearer）；无头登录：打印链接 + 轮询 | 老路 cookie+UA 绑定已废弃 |
| 码道 | cookie + `cftk`（CSRF）+ `agent-type` | 未登录是 **200 + 空体 + `HW-AJAX-REDIRECT`**，不是 401 |
| Qoder | **仅 cookie** | token 静默轮换，旧 token 打某些端点 401 |
| MiniMax | JWT + `x-signature=md5(ts+SECRET+body)` + `yy` | `yy` 已自算（且实测服务端不校验）；真正的坑是 query 里 `user_id` 必须用 realUserID、`device_id` 必须纯数字 |

---

## 四、四种执行面的实现模板

写 `exec.run` 之前先确认你的平台属于哪一类：

### A. 独立数据面（帧协议）—— 参考 `workbuddy/exec.js`
拿一次凭据 → 按协议发请求 → 解析 → `execResult({out, err, code, ms})`。
注意 proto3 JSON 省略默认值：**见到 end 帧但没有 exitCode 就是 0**。

### B. 裸 HTTP（30s 顶）—— 参考 `codearts/shell.js`
命令包一层（`( cmd ) 2>tmp; echo __RC=$?`）拿退出码；**200 + 状态空 + 输出空 = 被截断**（不是成功）；`busy` 翻成 `E_BUSY` 让内核退避重试。

### C. MCP over HTTP —— 参考 `qoder/mcp.js`
`initialize` 一次 → `tools/list` → `tools/call`。`on_timeout='background'` 会返回 pid + output_file，`poll` 用 `file_read` 读。
隧道/授权（grant → bootstrap → cookie）要缓存并在 30 分钟过期后重取。

### D. 没有 —— 参考 `minimax/`
不声明 `exec`/`fs`，`doctor` 里写清"这是设计结论不是故障"。

---

## 五、事件映射

`agent.stream()` 必须是 **async generator**，只吐归一化事件：

| kind | 典型来源 |
|---|---|
| `status` | 平台的 running/idle 状态变化 |
| `text` | 助手正文分片 |
| `thinking` | 思维链分片（有的平台一次给全量） |
| `tool` | 工具调用（`{id, name, input}`） |
| `tool_result` | 工具结果（`{id, name, ok, out}`） |
| `question` | AskUserQuestion（`{requestId, questions[]}`） |
| `permission` | 权限审批请求 |
| `usage` | token / credit 用量 |
| `done` | 回合结束（**必须最后吐，且只吐一次**） |
| `error` | 出错 |
| `raw` | 认不出的原始事件（**别丢**，`--raw` 要能看） |

两条经验（都是实测踩出来的）：
- **重放要跳过**：ACP 的 `session/load` 会把全部历史重放一遍；不要把历史当新消息。
- **`done` 别急着吐**：有的平台是 `idle → usage`，先吐 `done` 会把上一轮的 usage 算到下一轮。

---

## 六、自检与验收

```bash
node --check lib/platform/<id>/*.js
node lib/platform/<id>/selftest.js      # 纯离线，必须 exit 0
node -e "require('./lib/platform').use('<id>')"   # 契约校验通过
npm test                                # contract + guard + smoke
```

**`selftest.js` 的硬要求**：不发任何真实网络请求（假 `fetch` 注入，或纯函数断言）。现有四个驱动共 **224 项**离线用例，都是这么来的。

`test/guard.js` 是解耦棘轮：内核（`lib/`、`commands/`，排除 `lib/platform/`）里出现平台主机名或对 WorkBuddy 实现的直接依赖就失败。**新驱动不该改 `BASELINE`。**

---

## 七、接上去

```bash
# 内置目录：天然可用
cowbird platform ls
cowbird platform use myplatform

# 第三方驱动：不改内核，用环境变量指过去（路径/包名都行）
COWBIRD_PLATFORM_MODULE=/path/to/my-provider.js cowbird ls
```

`COWBIRD_PLATFORM_MODULE` 加载的模块只要 `module.exports = defineProvider({...})`，形状与内置驱动完全一致。

---

## 八、踩坑清单

| 坑 | 说明 |
|---|---|
| `nproc` / `free` 会说谎 | 容器里可能报宿主的 32 核 / 123 GB，而 cgroup 只给 4 核 / 8 GiB。`instances.info` 必须同时给 `visible` 与 `quota`（v2 读 `cpu.max`/`memory.max`，v1 读 `cpu.cfs_quota_us`+`period`/`memory.limit_in_bytes`） |
| 沙箱是懒创建的 | 很多平台「发消息」不建沙箱，**只有真正用到工具才建**。所以 `exec.probe` 要能返回 `{ready:false}`，由 `exec.wake` 补一轮 |
| 唤醒要花钱 | `exec.wake` 常常等于一轮最小 LLM 回合（0.03–0.2 credit）。内核有唤醒预算（每小时 2 次/每天 10 次）与 flake 重试，驱动只需实现 `wake` |
| 截断 ≠ 成功 | 200 + 空输出 + 状态空，通常是平台超时截断；要标 `truncated:true` |
| `busy` 不是失败 | 上一个命令还在跑，抛 `E_BUSY`，内核会退避重试 |
| 认证态会轮换 | 不要缓存 token；每次请求从 `ctx.store` 重读（也是多账号不串的前提） |
| 模块级缓存会串号 | 同一进程会交替用不同账号的 `ctx`，任何「记住上次的凭据」的写法都是事故 |
| 未登录的判定各不相同 | 401 / 200+空体+重定向头 / 业务 JSON，`transport` 里统一翻成一个可识别的 `AuthError` |
| 别假装成功 | 没实测过的接口就抛 `E_UNSUPPORTED` 并在 README 写清楚 —— 静默失败比报错更难查 |
