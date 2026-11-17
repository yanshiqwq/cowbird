# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。
破坏性变更会标 **BREAKING**。

## [0.16.0] - 2026-11-18

**TRAE 打通 `prompt` 与 `exec`：发消息就是 HTTP，exec 交给沙箱里的 agent。**

之前这个驱动只有只读能力，`prompt` 会报"网页端走 protobuf WS"。那个判断是错的：前端 API 表里
`chat.sendMessage` 就是 `POST /api/remote/v1/chat_sessions/:id/messages`，一直吃 `991102`
是因为**把 body 包错了**（多了 `initial_message` 外壳）。真实 body 是前端
`buildSendMessageRequest()` 的**摊平**对象：顶层 `chat_session_id` + `content: []` +
`query`（JSON 字符串）+ 模型那几个字段。

### 新增

- **`prompt`（`agent.send`）可用**：发消息、追加一轮，都是普通 HTTP。
- **`exec` 可用**（由 agent 代执行）：发一条消息让它跑、等这一轮结束、取最后一条 `Shell` 的 stdout。
  一条命令一轮 LLM，约 10–25 秒 —— 平台没有直连 shell 端点，这是它真实的能力边界。
  agent 拒绝执行时抛 `E_AGENT_REFUSED`，并带上它的原话，不编一个"失败"。
- **`create` 修正**：建会话带 `mode:"code"` + `env:"remote"`（少这两个建出来的是没沙箱的死会话）；
  带 `prompt` 就顺手跑第一轮。冷会话也能被第一条消息唤醒（实测 `status 1→3→5`，沙箱自动分配）。
- 模型的 `custom_model` / `common_params` 抽到 `lib/platform/trae/model.js`，
  可用 `cowbird.json` 的 `platforms.trae.model` 覆盖。

### 已知边界

- 没有 `exec.background`：一条命令一个回合，没有后台任务通道。
- **没有直连执行通道**。"往插件 `.mcp.json` 挂执行端、之后外部直连 9003 调 `tools/call`"这条路
  实测可行（0.3–1.2 秒一条、不烧额度），但需要沙箱内的 agent 写宿主配置，agent 判定为
  "绕开审批的常驻远程执行通道"并拒绝。原理与实测记录见 `docs/TRAE-一次性铺路执行通道.md`。
- 官方其实有 `/api/remote/v1/mcp_configs`（支持 `type:"stdio"` + `command/args`），
  但 create 的 body schema 在发版包里找不到，6 种形状都 `991102`；等摸到再换直连。

## [0.15.0] - 2026-11-18

**分清「沙箱会话」与「用户会话」；`platform` 命令对齐多渠道 —— 不再有「当前平台」。**

平台上的会话是用户自己的东西：你在网页里聊两句也是一个会话（WorkBuddy 上一个会话还自带
一个容器），平台没有任何字段能说明「这是我们建的沙箱」。所以判据收回内核：**登记过的才算**。

### 新增

| 项 | 说明 |
|---|---|
| `lib/platform/sandboxes.js` | 沙箱登记簿，按账号落在 `accounts/<账号>/sandboxes.json`；`create` / `adopt` / `daemon targets add` 登记，其余一律按用户会话处理 |
| `cowbird adopt <实例...>` | 把平台上已有的会话收编成沙箱会话（`--release` 只注销登记，云端会话不动） |
| `ls --all` 的「类型」列 | 「沙箱 / 会话」一眼分开；`--json` 里是 `kind` |
| `platform show <id>` | 单平台细节：能力按 实例/对话/执行/文件/认证 分组、同步上限、默认值、**该平台的渠道**（默认渠道打 `*`） |

### 变更（BREAKING）

- **`cowbird ls` 默认只列沙箱会话**。平台上的用户会话要 `--all` 才看得到（并多一列「类型」）。
  空列表时会直接告诉你两条路：`cowbird adopt <引用>` 收编，或 `cowbird create` 开新的。
- **`cowbird platform` 默认变成全平台能力对照表**（每行一个平台，带它自己的渠道），
  不再是「当前平台」的能力卡片；单平台用 `platform show <id>`（也可以直接 `cowbird platform workbuddy`）。
- **删掉 `cowbird platform use`**：平台没有「当前」这个概念。默认值只有一个 —— 默认渠道，
  用 `cowbird account use <平台:账号>` 设置；一次性指定用全局开关 `--platform <id>`。
- `rm` 的 dry-run 会标出目标是「沙箱会话」还是「用户会话」，后者额外提醒会连聊天记录一起删。
- `daemon targets add` 顺手把目标登记成沙箱会话（否则会出现「正在保活的实例不在 ls 里」）。

### 删掉

- 「按平台字段猜存量会话算不算沙箱」的兜底（内测期不留兼容层）。实测那条线索
  （WorkBuddy 的 `extraInfo.clientCreateRequestId`）会把 14 条用户对话误判成沙箱，
  不如让 `adopt` 显式收编；`create` 从这一版起自己记账。

### 测试

`test/contract.js` 25 项 + `test/smoke.js` 43 项全绿；新增登记簿的渠道隔离与上限修剪、
`platform` 表格的纯函数用例、`CAP_NAME` 对能力位的全覆盖检查。

## [0.14.0] - 2026-11-18

**TRAE 补上 `fs`：能读能写沙箱里的工作区文件。**

数据面（`agent-sandbox-*.trae.cn/explorer/<sid>`）的钥匙在 0.13.1 摸清后，文件通道就能用了：

| 能力 | 怎么实现 |
|---|---|
| `fs.read` | `GET /explorer/<sid>/file/<相对路径>`（sessionFs.readFileStream） |
| `fs.write` | `PUT` 同一路径（sessionFs.uploadFile） |
| `fs.list` | WS JSON-RPC `fs.readdir`（没有 HTTP 版本，需 Node ≥ 22 的内置 WebSocket） |

于是 `cowbird get <会话> <路径>` / `cowbird put <会话> <本地> <远端>` 在 TRAE 上可用。
三条限制写进驱动 README：路径只认**工作区相对路径**；会话**离线**时读到的是 restic
备份的 git 快照（不是沙箱当前状态）；列目录需要 Node ≥ 22。

## [0.13.1] - 2026-11-18

**TRAE：补上数据面鉴权的结论，并把 `exec`/`prompt` 两条写成"平台没有"而不是"没做"。**

- 数据面（`agent-sandbox-*.trae.cn/explorer/<sid>`）要的是
  `Authorization: Cloud-IDE-JWT <jwt>` + `X-Trae-Client-Type: web`；
  WS 用子协议 `Cloud-IDE-JWT.<jwt>`，协议为 JSON-RPC 2.0（`fs.*` / `system.ping`）。
  之前 401 的唯一原因是把 scheme 写成了 `Bearer`。
- 12 条数据面路由里没有 terminal/pty/shell/exec，WS 方法空间也只有 `fs.*` + `ping`
  ⇒ **`exec` 这个能力在 TRAE 网页版不存在**，不是尚未打通；`fs` 可在下个增量补上。
- 发消息不是 HTTP：网页端走 `wss://frontier.zijieapi.com/ws/v2` 的二进制 protobuf 流，
  `POST /messages` 是别的客户端用的、schema 校验很严 ⇒ `prompt` 明确报未打通。

## [0.13.0] - 2026-11-17

**新增第五个平台：TRAE（字节 `work.trae.cn`）。** 一个会话 = 一台云端 KVM 真 VM；但网页版**没有直连执行通道**，所以这次是「能管能看，不能 exec」。

### 新增

| 项 | 说明 |
|---|---|
| `lib/platform/trae/` | 驱动：`auth` / `instances.{list,get,create,rename,remove}` / `agent.{stream,send,history,interrupt}` / `doctor` |
| 登录 | `cowbird --platform trae login --cookie "<串>"`（网页版没有可脚本化的登录流，只有 cookie） |
| 两层令牌 | cookie → `POST /cloudide/api/v3/common/GetUserToken` → `Cloud-IDE-JWT`（8h，`x-cloudide-token`），按账号缓存、过期前 5 分钟自动换 |
| `warm` 覆盖 | daemon 每 10 分钟 `CheckLogin` 一次，让 cookie 会话保持活跃 |
| 历史导出 | `cowbird --platform trae history <id>`（把三层嵌套消息摊成可读行） |
| 全离线自测 | 19 项：cookie 解析、登录校验、status 映射、会话归一、消息 → 归一事件、分页、请求形状、能力位 |

### 能力声明（诚实的少声明）

声明了 `auth / instances.list|create|rename|remove|meta / agent / agent.interrupt`。
**不声明** `exec / exec.background / fs / exec.wake` —— 网页版 156 条端点里没有
terminal/pty/shell/exec，沙箱里的真 shell 只有三个入口（agent 的 Shell 工具、VNC、IDE 通道）。
`cowbird exec` 因此按契约直接报能力缺失（退出码 2）。

### 已知未打通（写在这里，免得下次重新查）

- **沙箱数据面已破解**（2026-11-18）：要的是 `Authorization: Cloud-IDE-JWT <jwt>` +
  `X-Trae-Client-Type: web`（`Cloud-IDE-JWT` 是字面 scheme 名，不是 Bearer —— 之前 401 全因前缀写错）。
  WS 用 `Sec-WebSocket-Protocol: Cloud-IDE-JWT.<jwt>`，协议是 JSON-RPC 2.0（`fs.*` / `system.ping`）。
  12 条数据面路由全是文件/slash/diff，**没有任何 terminal/pty/shell/exec** ⇒ `exec` 不存在，
  不是没打通。`fs` 可以加（`/file/:path` + WS `fs.readdir`），留给下一增量。
- **`agent.send`（`cowbird prompt`）走不了 HTTP**：网页端是
  `wss://frontier.zijieapi.com/ws/v2` 上的**二进制 protobuf 双向流**（opcode=2）；
  HTTP 的 `POST /messages` 有严格 schema，连「回读镜像字段」都被 991102 打回。
  驱动明确报 E_UNSUPPORTED，不装死。

## [0.12.0] - 2026-11-17

**daemon 多了第四根循环：`warm`（登录态保活）。** 给没有 refresh_token 的平台上一条可能的"续命"路。

### 新增

| 项 | 说明 |
|---|---|
| `warm` 循环 | 每 10 分钟对每个渠道调一次 `auth.alive()`（码道/Qoder 是 `GET /rest/me`），让服务端把这条会话当活跃。滑动过期的平台等于永续；固定 TTL 的平台无害；没有这个能力的平台跳过 |
| `cowbird daemon warm` | 立刻手动跑一轮，返回每个渠道的 http 码与耗时 |
| `POST /api/warm` | 远端触发同一轮 |
| `daemon status` | 新增「登录态保活」一行：开关、周期、上次跑的时间、成功/失败渠道 |

配置在 `cowbird.json` 的 `warm: { enabled: true, intervalMs: 600000 }`。

### 为什么单独做一个循环而不是塞进 renew

`renew` 的语义是「换一份新凭据」，需要平台提供 refresh_token 那种能力；
`warm` 的语义是「让手上这份别被服务端回收」，只需要一个轻量请求。
混在一起会让「没有续期能力」的平台被误判成"续期失败"，也会把「保活无效」和「凭据过期」两件事
混成同一个错误码。分开之后，`warm` 的失败恰好等于「这条会话真的死了，该重新登录了」，
这正是判断"登录还要不要人管"的那条线。

### 测量用

`warm` 每轮的 `results` 都落在 `daemon-state.json` 的 `lastWarm` 里（含 http 码与耗时）。
把它和历史对比就能回答「服务端到底是不是滑动过期」：如果 12 小时后仍然是 200，
说明保活有效，登录只需做一次；如果是 401，说明会话有硬 TTL，登录必须定期重做。

## [0.11.0] - 2026-11-17

**码道补了第二条登录腿：OAuth2 + PKCE + DPoP（`--oauth`）。** 顺带修掉一个会删账号目录的登录 bug。

### 新增

| 能力 | 说明 |
|---|---|
| `cowbird login --oauth` | 装官方码道插件那套：打印授权链接 → 浏览器回调 `127.0.0.1:<随机端口>/oauth/callback` → 拿 code 去 STS 换临时 AK/SK + security_token + refresh_token |
| `--callback '<回调地址>'` | 浏览器在另一台机器 / 回调够不着时，把地址原样粘回来换票 |
| 本地回调接收器 | 只活几十秒的 `127.0.0.1` 服务；接住 `?code=`，旧式 portal 的 `?secret=&redirect=` 也认（转 ticket 轮询） |
| ticket 轮询兜底 | `GET …/snap-manager/v1/login/ticket?ticket_id=&secret=`，就是「打印链接 + 轮询状态机」那条腿 |
| `oauth.signRequest()` | 华为云 `SDK-HMAC-SHA256` 签名（AK/SK + `x-security-token`），已用真账号打通过 200 |
| 身份回填 | 换票响应里没有人身份，登录后追问 `snap-manager/v1/current/user`，写进 `account.json` —— `account ls` 里码道那行现在有名字了 |

### 修掉

| 问题 | 后果 |
|---|---|
| 登录失败/超时走 `restore()`，且备份已被另一进程清掉 | **先删账号目录、再 rename 一个不存在的备份 ⇒ 凭据整锅没了**（真实事故）。现在失败只清自己那份备份，`restore()` 先确认备份存在，备份名带 pid |
| STS 响应字段名读的是 `credentials.access` / `secret` | 实际是 `access_key_id` / `secret_access_key`，于是换回来的 AK/SK 一直是空的（两种都认了） |
| 码道 `ttlDays` 只看 cookie | session cookie 没有 expires ⇒ `account ls` / `doctor` 永远显示「未知」；现在回落到 OAuth 凭据的 expiration |

### 实测结论（负结果，也是结论）

OAuth 凭据**不能**替控制面 cookie。同一份凭据：

- `snap-access /snap-manager/v1/current/user` + AK/SK 签名 → **200**（凭据本身没问题，身份 `GT-…`）
- `devcloud /chat/v1/cloudagent/sessions` 四条路（`X-Auth-Token` / `Bearer` / AK-SK 签名 / cookie 对照）→ 全部被 `HW-AJAX-REDIRECT` 踢到登录页

所以码道的会话与沙箱仍然只能靠 cookie（12 小时量级过期，`--cookie` 或浏览器登录）。OAuth 那份的用处是身份、以及将来若改用 snap-access 数据面的备料。详见 [lib/platform/codearts/README.md](lib/platform/codearts/README.md) 的 4.1b。

## [0.10.0] - 2026-11-17

**多账号与多渠道共存：一个平台可以挂多个账号，几个平台可以同时挂着。**

渠道（`平台:账号`）成为唯一寻址单位 —— 实例、登录态、保活目标、daemon 的每一轮动作都挂在渠道上。

### 新增

| 能力 | 怎么用 |
|---|---|
| 加第二个账号 | `cowbird login --as alt`（不加 `--as` 就是给默认账号续一次） |
| 看有哪些渠道 | `cowbird account ls`（身份 / 凭据剩余 / 是否默认，一行一个渠道） |
| 切默认渠道 | `cowbird account use workbuddy:alt` |
| 删账号 / 改名 | `cowbird account rm workbuddy:alt` / `cowbird account mv 旧 新` |
| 指定渠道 | 全局开关 `--channel <平台[:账号]>`、`--account <名字>`；或在引用里写 `qoder:alt/01` |
| 聚合列表 | `cowbird ls` 默认把所有已登录渠道合起来列，多一个「渠道」列 |
| 跨渠道找实例 | 默认渠道没命中会自动去别的渠道找，`ls` 里看得到的名字 `exec` 一定找得到 |
| daemon 跨渠道 | 保活目标记下渠道；`refresh` / `renew` 走遍所有支持该能力的渠道 |
| doctor 看渠道 | 每个「平台:账号」一行，掉线/过期单独标色 |

`--channel` / `--account` 都可以写在命令后面（`cowbird ls --channel minimax`），
环境变量是 `COWBIRD_CHANNEL` / `COWBIRD_ACCOUNT`。

### 变化

- 数据目录：`platform/<平台>/<凭据文件>` → `platform/<平台>/accounts/<账号>/<凭据文件>`。
  **老布局首次运行自动搬进 `accounts/default/`**，不用手工迁移；搬的时候会写一份 `account.json`（身份名片）。
- 不加 `--as` 却授权了另一个账号时，登录会**还原原凭据并提示**，不会把现有账号顶掉。
- daemon 的 `/api/state`、`/api/token/:id` 认 `?channel=`；`/api/status` 多一个 `channels` 数组。
- `heal` 目标多了可选字段 `channel`；没有执行通道的平台（MiniMax）在 heal 里算「跳过」而不是「失败」。

### 修掉

| 问题 | 影响 |
|---|---|
| WorkBuddy 的 `agent.LIVE` 按会话 id 索引 | 两个账号撞同一 id 时，回答会被回填到别人的连接上（多账号下的串号事故） |
| `auth.ttlDays` 隐式回读磁盘 | 多账号下读到的是「最后写的那份」，不是传入那次登录态 |
| 会话列表缓存写在全局 `~/.cowbird/conversations.json` | A 的列表会覆盖 B 的，改名还会串名字 |
| `ls` 的「凭据剩余」读错缓存文件 | 该列此前实际恒空（读的是没人写的 `tokens/token-<id>.json`） |
| 码道 `transport.frames()` 把 `{value,done}` 当字节 | 真 SSE 一接上就 `TypeError`（自检全用打桩，一直没抓到）；补了一条走真字节流的用例 |
| 码道 / doctor 里 `require('../../browser')` 悬空 | 那一层在解耦时被搬走了，`cowbird login --platform codearts` 会 `MODULE_NOT_FOUND`；恢复成通用 `lib/browser.js`（playwright 可选依赖） |
| 文档里的 cookie + UA 时代说法 | README / protocol / architecture 与实际实现对齐（鉴权只有 accessToken · Bearer） |

### 升级注意

- 数据会自动搬，**但 `~/.wbsbx` 不会**（0.9.0 起就不再认）。还留着的话手动 `mv ~/.wbsbx ~/.cowbird`。
- 老账号全部落在 `accounts/default/` 下，原来的用法一个字都不用改。
- daemon 需要重启一次才会按渠道跑（`cowbird daemon restart`）。

## [0.9.0] - 2026-11-17

**内测期，直接破坏性清理：删掉 `wbsbx` 时代的所有兼容层。**

| 删掉的东西 | 说明 |
|---|---|
| `bin/wbsbx-alias.js` 与 `wbsbx` 这个 bin | 只剩 `cowbird` / `cowbird-daemon` |
| `WB_CLOUD_HOME` / `WBSBX_*` 环境变量兜底 | 只认 `COWBIRD_*`；旧名不再提示、不再生效 |
| `~/.wbsbx` 自动迁移 | 数据目录只有 `~/.cowbird` |
| `cfg.PROFILE`（cookie 时代留给浏览器登录的 profile 目录） | 登录已无头化，没人用 |
| wrapper 里的旧名提示分支 + `/usr/local/bin/wbsbx` 软链 | 只留 `/usr/local/bin/cowbird` |

`lib/config.js` 因此短了一截：不再有 `OLD_ENV` 映射与 `migrateOldHome()`。

### 升级注意

- 环境变量请改用 `COWBIRD_*`；`~/.wbsbx` 不会再被自动复制。
- 命令名只有 `cowbird`。脚本里还写着 `wbsbx` 的会直接 command not found（内测期就这样，早改早好）。

## [0.8.0] - 2026-11-17

**改名：`wbsbx` → `cowbird`。** 名字来自牛鹂 —— 一种自己不筑巢、把蛋下在别人巢里让别人养大的鸟。
这个工具干的正是这件事：不买机器不开容器，直接借用各平台会话自带的沙箱 shell。

### 变更

| 项 | 旧 | 新 |
|---|---|---|
| 命令 | `wbsbx` | **`cowbird`**（`wbsbx` 保留为别名，打一行弃用提示） |
| daemon | `wbsbx-daemon` | `cowbird-daemon` |
| 环境变量 | `WB_CLOUD_HOME` / `WBSBX_*` | **`COWBIRD_HOME` / `COWBIRD_*`**（旧名继续认，提示一次） |
| 数据目录 | `~/.wbsbx` | **`~/.cowbird`**（首次运行自动从旧目录**复制**，源目录保留） |
| npm 包名 | `wbsbx` | `cow-bird`（`cowbird` 在 npm 已被占；bin 仍叫 `cowbird`） |

- 数据目录迁移只在「新目录不存在且旧目录存在」时做一次，只拷不删 —— 出问题把 `COWBIRD_HOME`
  指回 `~/.wbsbx` 就能退回。
- README 重写了开场：牛鹂的解释 + 四平台能力表（执行通道 / 超时 / 沙箱寿命）。
- DISCLAIMER 从「与 WorkBuddy/CodeBuddy 无关」扩到「与 WorkBuddy / CodeBuddy / 华为云 CodeArts /
  Qoder / MiniMax 都无关」。

## [0.7.0] - 2026-11-17

两条大改：**WorkBuddy 砍掉 cookie 模式（只留 accessToken）**，**MiniMax 的 `yy` 攻破并证明服务端不校验**。

### WorkBuddy：只留 accessToken

实测 CodeBuddy CLI 的插件登录（`copilot.tencent.com/v2/plugin/auth/*`）拿到的 accessToken
**能打同一套控制面**（列表 / 详情 / `/session` / E2B exec 全部 200），于是把 cookie 模式整条删除：

- 删掉 `lib/platform/workbuddy/lib/{creds,browser}.js`、`login-flow.js`、`renew-flow.js`
  与 `test/probe-ua-binding.js`（约 700 行），`session.js` 从 238 行瘦到 79 行，只剩 Bearer。
- 新增 `device-login.js`（打印链接 + 轮询）与 `token-store.js`（存取 / 有效期 / refreshToken 续期）；
  新增 `lib/token-cache.js` 接管原 `creds.js` 里"会话级 E2B 凭据缓存"那一半。
- `wbsbx login` 只剩一条路：无头登录（不需要浏览器 / playwright / Edge）。
- `doctor` 报 `accessToken · 账号 · 剩余 N 天`。
- 副作用（要知道）：登录态绑的是**授权时那个账号**；换账号＝重新 `wbsbx login`。

### MiniMax：`yy` 攻破

- `yy = md5(encodeURIComponent(wQ(url, params)) + '_' + bodyYY + md5(整秒毫秒) + 'ooui')`，
  其中 `wQ` 用 `URLSearchParams` 序列化；**当年对不上是因为公共参数里的 `op_ticket=undefined`
  被序列化成字面量，而 axios 拼真 URL 时把它丢了**。19 条真机抓包 19/19 逐字节复算成功。
- 更关键的否证：**服务端根本不校验 `yy`** —— 换随机值 / 全 0 / 空串 / 完全不带，全部 200；
  而 `x-signature` 填错立刻 400。之前那个 401 的真因是 query 里 `user_id` 必须用
  `userInfo.realUserID`（≠ JWT 的 `user.id`）、`device_id` 必须纯数字。
- 于是删掉 `E_NEED_YY` 门禁与"抓 yy"那套；`captureYY` 降级为调试覆盖。
- 真机验证：`wbsbx --platform minimax ls` / `info` / `history` 全部可用（纯 HTTP，浏览器已关）。

### 其它

- `docs/providers.md` 的鉴权对照表更新（WorkBuddy 改 Bearer；MiniMax 的 yy 结论）。
- 冒烟测试里 5 项 cookie/UA 断言换成 token 有效期与凭据缓存；WorkBuddy 自检 46 项、
  MiniMax 42 项，全离线。

## [0.6.0] - 2026-11-17

**解耦收尾：`lib/` 里不再有任何平台实现，解耦守卫归零（BASELINE 清空）。**

### 变更

- 把 WorkBuddy 的实现整体搬进 `lib/platform/workbuddy/`：
  `lib/{cloud,session,e2b,acp,browser,creds,keepalive}.js` → `lib/platform/workbuddy/lib/`，
  `lib/daemon/renew.js` → `lib/platform/workbuddy/renew-flow.js`，
  `commands/login.js` 的浏览器流程 → `lib/platform/workbuddy/login-flow.js`（0.5.2 已搬）。
  WorkBuddy 的主机名/默认模型 → `lib/platform/workbuddy/constants.js`，
  于是 `lib/config.js` 不再含任何平台常量。
- `lib/daemon/` 三条循环改成平台无关：
  - `heal`：走内核的 exec 编排（`lib/platform/exec.js`），平台没有 `exec` 能力时直接
    `skipped:'unsupported'`；「失败 → 刷新凭据 → 重试一次」保留。
  - `refresh`：改用 `provider.instances.refresh()`；没有这个方法的平台记 `unsupported`。
  - `renew`：改用 `provider.auth.renew()`；只有声明 `auth.renew` 的平台（WorkBuddy）会真跑。
  - `snapshot()` 改成 async，并把 `platform` / `capabilities` 一起报出来。
- `/api/state`、`/api/token/{id}` 改成走驱动（`auth.state` / `auth.importState` / `instances.token`），
  平台不支持时返回 501 而不是 500。
- `keepalive` 变成驱动的扩展点（`provider.keepalive.create`）：只有 WorkBuddy 有
  「提问挂着不答」这套语义，其它平台直接报不支持并建议用 daemon heal。
- `lib/resolve.js` 只保留平台无关的匹配规则，数据来源换成 `provider.instances.list()`。
- `commands/doctor.js` 删掉内核里那套 WorkBuddy 专属检查（接口/实例缓存/凭据缓存/保活目标），
  它们搬进 `workbuddy` 驱动的 `doctor.checks`；内核只留 node / 数据目录 / 平台 / daemon。
- `test/guard.js` 的 BASELINE 清零：内核里再出现平台主机名或对平台实现的直接 require 就失败。

### 结构

```
lib/            api args config log resolve ui
lib/daemon/     heal logstore scheduler server
lib/platform/   contract index validate exec stream target
                workbuddy/ codearts/ qoder/ minimax/ _example/
```

`lib/` 里已经没有任何 `require('./cloud')` 这类平台实现依赖 —— 加平台只该动 `lib/platform/<id>/`。

### 验证

`npm test`（契约 18 + 守卫 + 冒烟 40）与四个驱动的离线自检（47/99/48/33）全绿；
真机回归：`ls` / `doctor --no-net` / 真 daemon 启动（scheduler 报 `平台=workbuddy`）/
`/api/status` / 加一个真保活目标跑一轮 heal（1 正常 0 失败）。

## [0.5.3] - 2026-11-17

码道与 MiniMax 真机实测（第三、四家），修掉三个只有真机才会暴露的问题。

### 修复

- **码道 `/shell` 不是通用 bash**：换行被吞（`echo a\necho b` → `anecho b`）、shell 变量不保留
  （`X=1; echo X=$X` → `X=`）。原来的多行包装器必然语法错误。
  改成外层"零变量零换行"的 `echo '<b64>' | base64 -d | bash -s`，脚本由沙箱 bash 解码执行 ——
  多行、子 shell、引号、退出码、stderr 分离全部保住（实测 `exit 5`、264 KiB 文件往返一致）。
- **码道「沙箱在」≠「能插命令」**：agent 自己也占着同一条 kernel session。
  `exec.probe` 现在要求「有 kernel session 且会话不在跑」；内核遇到 `why==='busy'`
  **不去 wake**（白花钱），只等它空下来；`E_BUSY` 退避从 3 次 × 0.5s 提到 6 次并尊重
  provider 给的 `retryAfterMs`。
- **码道会拿首条消息自动改标题**（同 Qoder）：`create` 把名字记进 store，`execWake` 结束时改回来。
- **MiniMax 的 `yy` 不能复用**：同路径、1 分钟内抓的 yy，配新 `x-timestamp` 重放仍 401。
  `captureYY` 返回 `reusable:false` + 说明，`doctor` 的 yy 行改为 warn ——
  **不逆出 yy 算法就无法纯 HTTP 驱动 MiniMax**，只能读 `/v1/api/user/info` 与 `/config`。

### 实测确认（码道）

`ls` / `create` / `exec`（单行、多行、子 shell、退出码、stderr）/ 截断识别 / busy 退避 /
`info`（配额 2 核 7.8 GiB、credit 1.21）/ `fs.list`（files 信封）/ `put`+`get`（264 KiB 字节一致）。

沙箱画像补充：这次拿到的是 **aarch64 + `hce3` 欧拉内核**（`6.6.0-72.0.0.76…aarch64`），
与此前记录的 x86 不同 —— 码道池子里同时有 x86 与 ARM。

## [0.5.2] - 2026-11-17

把剩下 5 条命令也接到平台门面上（此前只有 exec/ls/create/rm/rename/info/put/get/doctor 接了）。

### 变更

- `prompt` / `watch` / `history` / `login` / `cookie` 全部改走 `lib/platform`：
  内核不再直接碰 `lib/{cloud,acp,session,browser}`。
  - `watch`：只打印归一化事件（text/thinking/tool/tool_result/artifact/usage/question/done），
    所以同一套输出能看 WorkBuddy 的 ACP、码道的具名 SSE、Qoder 的轮询增量。
  - `history`：把各平台的历史形状（Event / 归一消息 / 平台原始消息）统一渲染成可读行，
    仍落 `history-<id>.jsonl` + `.txt` 两份。
  - `login`：通用壳 —— 选项交给 `provider.auth.login()`。WorkBuddy 的浏览器流程
    搬进 `lib/platform/workbuddy/login-flow.js`（逻辑没变），于是命令层与驱动不再互相 require。
    WorkBuddy 会明确拒绝 `--cookie` 导入（UA 是鉴权的一部分，缺了就 401）。
  - `cookie`：`dump/check/export` 通用化；`check` 用「列一次实例」当探针（任何平台都要鉴权）。
- 解耦守卫的 BASELINE 从 16 处降到 11 处（hosts 2 / imports 9）；
  剩下的是 daemon 三条循环、doctor 的 WorkBuddy 专属检查、keepalive（WB 特有）。

### 修复

- **`prompt` 拿不到回复正文**：刚连上的 `session/load` 重放里带着上一轮的 `endTurn`，
  内核 `collect()` 见第一个 `done` 就收工，于是只剩「零正文 + 一堆旧产物」。
  - `collect()` 新增 `breakOnDone`（默认 true），`prompt` 用 `false` 按 `--wait` 计时收工；
  - WorkBuddy 驱动的 `stream()` 默认 **不再**因为见到 `done` 就结束
    （`stopOnEndTurn` 改为显式 opt-in）—— 重放的 endTurn 不该终止实时流；
  - `prompt` 现在**流式**打印正文，而不是等结束才一次性输出。
- `doctor` 的驱动体检项接受 `error/good/pass` 等 level 同义词，并让驱动覆盖同名的历史检查。

## [0.5.1] - 2026-11-17

真机实测一轮（WorkBuddy + Qoder 真账号），修掉四个只有在真机上才会暴露的问题。

### 新增

- 契约加 `EVENT.ARTIFACT`（产物文件）与 `requiresPromptOnCreate`（建实例是否必须带指令）；
  `lib/platform/stream.js` 的汇总里多一项 `artifacts`。
- WorkBuddy：`_codebuddy.ai/artifact` → `artifact` 事件（实测能抓到会话里产出的 HTML 报告）。

### 修复

- **Qoder `get` 把文件写坏**：`file_read` 返回带行号的文本（`1\t…`），落盘后内容被污染
  （实测 "qoder fs test" 被存成 "1\tqoder fs test"）。`fs.read` 现在用 `stripLineNumbers()`
  剥（全行匹配才剥），`exec.get` / `wbsbx get` 一律走 `base64 -w0`，往返字节一致。
- **`wbsbx get` 优先用 fs 通道会坏文件**：现在优先 `exec.put/get`（字节级），fs 只作兜底。
- **Qoder 会自动改标题**：`create --name X` 后第一次对话就被改名，`exec X` 找不到实例。
  驱动在补发首条指令后再改一次名压回去；`create` 也不再给不需要 prompt 的平台默认补一句。
  **平台每轮都可能再改，用 id 或 id 前缀最稳。**
- **Qoder `done` 的 reason 可能是 `[object Object]`**：`stop_reason` 有时是对象；`reasonOf()` 归一。

### 实测确认（此前只是"照文档写"）

- WorkBuddy：`ls` / `info`（cgroup v1 与 v2 都读到真实 4 核 8 GiB）/ `exec`（两代沙箱）/
  `put`/`get` / 后台任务 / `agent.send`+`stream`，全部通过。
- Qoder：`create` / `exec`（lifsea8 容器代，cwd=/data）/ `info`（配额 4 核 8 GiB）/ `put`/`get`
  （字节一致）/ 后台任务 / `agent.send`+`stream`（credits 0.21）/ `rename`，全部通过。
- 否证：WorkBuddy ACP **不提供 token 用量**；Qoder **不给 token 数只有 credit**。

## [0.5.0] - 2026-11-17

### 新增

- **平台驱动架构**：平台实现全部收进 `lib/platform/`，内核只认 `Instance / Access / Event /
  ExecResult / FileEntry`。加平台 = 新建 `lib/platform/<id>/` 并实现契约，内核零改动。
  - `lib/platform/contract.js`：`CAP` 能力位、`EVENT` 归一化事件、`defineProvider()` 校验
    （声明了能力却没有实现会直接报错）。
  - `lib/platform/index.js`：注册表 + 门面 + `ctx`（`store` / `effective` / `log`）；
    支持 `WBSBX_PLATFORM_MODULE=<路径|包名>` 挂第三方驱动。
  - `lib/platform/exec.js`：执行编排 —— `ensureReady()`（唤醒预算 + flake 重试）、
    按 provider 的 `limits` 决定「同步 / 后台 / 拒绝」、`E_BUSY` 退避。
  - `lib/platform/stream.js`、`target.js`：事件流收集与平台无关的实例引用解析。
- **四个平台驱动**（共 224 项离线自检）：
  - `workbuddy`：适配现有 `lib/{session,cloud,e2b,acp,browser}`，15 项能力；
    `info` 同时给 cgroup 真实配额与 `nproc` 可见量；ACP 历史重放默认跳过。
  - `codearts`：cookie + `cftk`、具名 SSE 15 事件、内核 `/9800` shell（30s 截断识别、
    `busy`→`E_BUSY`）、`files/*`、`answers` 怪形状、cgroup v1/v2。
  - `qoder`：仅 cookie、event-sourcing 增量、`preview/grant` → MCP `tools/call`
    （120/600s + 原生后台）；`agent.answer` 未实测故明确不支持。
  - `minimax`：JWT + 自算 `x-signature`；`yy` 未逆出 → `E_NEED_YY` 且**绝不发半成品请求**；
    **没有执行通道**，作为「能力降级」的参照实现。
- `wbsbx platform [show|ls|use <id>]` 与全局开关 `--platform <id>`：
  一条命令看清平台能做什么、同步上限多少、要不要唤醒。
- `test/guard.js`：解耦棘轮 —— 内核里出现平台主机名或对 WorkBuddy 实现的直接依赖就失败。
- `docs/providers.md`：加平台指南（契约速查、四种执行面模板、事件映射、八条踩坑）。

### 变更

- `exec` / `ls` / `create` / `rm` / `rename` / `info` / `put` / `get` / `doctor` 改走平台门面。
- `exec`：短选项与命令串的边界仍是「实例之后全是命令」，但**选项一律写在实例前**；
  同步/后台由平台 `limits` 决定，不再由命令硬编码超时。
- `info`：明确区分「配额」（cgroup）与「可见」（`nproc`/`free`），后者可能远大于前者。
- `doctor`：新增「平台」一行与驱动自己的体检项；同名行以驱动为准。
- `npm test` 改为 `contract + guard + smoke` 三件套。

### 修复

- 能力缺失（例如在不支持 exec 的平台上执行 `exec`）退出码改为 **2**，与「命令失败=1」区分。
- `doctor` 的 level 词表容错：驱动写 `error`/`good`/`pass` 也能正确渲染与计数。

### 未完成（下一版）

- `history` / `watch` / `prompt` / `keepalive` / `login` / `cookie` / daemon 三条循环
  仍走旧的 WorkBuddy 实现（`test/guard.js` 的 BASELINE 里列了这 16 处），
  迁移完即可删掉 `lib/{cloud,session,e2b,acp}`。

## [0.4.0] - 2026-11-16

### 新增

- `wbsbx keepalive <实例>`：把会话钉在「等用户回答」上。收到 `AskUserQuestion` 不回答，
  那一轮就一直挂着，会话停在 pending —— 平台不会把它当闲置回收。掉出该状态时补一句催话。
  与 daemon 的 `heal`（每 10 分钟一次 E2B exec）是两件事，不互斥。
  - 断线处理：连接 20s 超时、单条 POST 60s 超时、催话后无响应 30s 判死；连续短连接按
    5/10/20/40/60s 退避。
  - `--no-nudge` 只连接不催话（不留痕）；`--max-nudges` / `--duration` 控制边界。
- `test/halfopen.js`（`npm run test:net`）：起本地假 ACP 服务端，复现五种"看起来还连着"
  的坏法并断言恢复行为。
- `heal.targets[].script`：目标可以声明一个本地脚本（相对 `heal.scriptsDir`），heal 会把
  脚本内容送进沙箱跑 —— 也就是"全量自愈"而不只是 `uptime` 探针。没声明的仍走 `probe`。
  脚本读不到算本轮失败，不静默降级；输出里的 `ERROR:` 行单独记为告警，出现在
  `daemon status` 的「N 条告警」里。
- `doctor` 新增「保活目标」一项：脚本路径写错在启动前就看得见。
- `WBSBX_PW_MODULE`：显式指定 playwright-core 的位置。容器/服务器上常把它装在镜像某处
  （既不在项目 node_modules 也不在 NODE_PATH），没有这个变量 `renew` 只能报"找不到"。
- `renew.always`：每轮都续登录态，不看剩余天数。用于上游 SSO 会话有空闲超时的场景 ——
  只在快过期时才续会踩线，SSO 一掉就只剩人工扫码一条路。
- `keepalive` 的状态日志改为以**控制面**为准（与 `ls --refresh` 同一来源），SSE 侧的值保留作对照；
  平台已经是 `pending` 时不再补催 —— 重连后重放没带回提问请求时，这个判断能省掉一次无谓的对话污染。
- 每条命令的 `--help` 增加 `选项 / 说明 / 退出码` 三段；主 help 重新分组。

### 变更

- **BREAKING** `exec` / `prompt`：实例之后的内容全部当作命令 / 文本，不再解析为选项。
  `wbsbx exec 01 ls -la` 可以直接用；代价是命令自己的选项要写在实例之前。
- **BREAKING** 全局开关（`--local` / `--remote` / `--token`）只从命令名**之前**摘取。
  原先扫描整条 argv，会把 `exec 01 curl --token x` 里的 `--token` 吃掉。
- **BREAKING** `--sec` → `--duration`，`--max-min` → `--max-wait`（旧名仍接受，不写进文档）。
- 措辞与版式对齐 docker / gh / git：`用法: wbsbx <命令> [选项] [参数]`、`<秒>` 尖括号占位符、
  末尾一行 `运行 wbsbx <命令> --help …`。

### 修复

- **401 会把本地登录态清空**：服务端在 401 响应里下发 `session=; Max-Age=0` 用来清理失效会话，
  原先照收并落盘 —— 一次 UA 不匹配的 401 就把"改回正确 UA 就能救"变成"必须重新扫码"。
  现在只在 2xx 吸收 Set-Cookie，并在写盘前留 `state.json.last-good`。
- `exec 01 ls -h` 被入口当成"看帮助"拦掉。
- 彩色表格把 ANSI 转义算进显示宽度（配色后每列多 9 列空白）。
- `keepalive` 重连后立刻催话（重放期间 `busy` 仍为 false，会多留一条记录）。
- `keepalive` 催话失败时时间戳不推进 → 一秒一次重试风暴。
- `keepalive` 连续失败计数器重连后不清零 → 一次失败即判"连续 3 次"。
- 未知命令把整页 help 打到 stdout（污染管道）。
- `browser` 在 Linux 上默认 `channel=msedge`（必然报 Executable doesn't exist）；
  Windows 上 `chromeBin()` 返回假路径。拆成 `chromeBin` / `launchOpts` / `describe`。

### 移除

- `~/.workbuddy/wb-cloud` 的 legacy 数据目录探测与平铺 token 迁移（该路径已无用户）。
- 死代码：`browser.pwVersion`、`api.probeDefault`、daemon 模块里两个未使用的 import。

## [0.3.0] - 2026-11-11

- 拆成 client / daemon：CLI 管操作，daemon 管续命（heal / refresh / renew 三条循环）。
- 数据目录默认 `~/.wbsbx`；新增 `wbsbx daemon` 子命令与 9 个 HTTP 接口。
- 只保留 `login` 需要浏览器，其余全走纯 HTTP（发现会话与 User-Agent 精确绑定）。

## [0.2.0] - 2026-11-11

- `session.js`：cookie jar + UA，纯 HTTP 发请求；`login --import` 静默导入。
- 修 Set-Cookie 合并键（`name+path+domain`）、改名异步、新实例按名字找不到。

## [0.1.0] - 2026-11-03

- 首个可用版本：列实例、建删改、E2B exec、传文件、ACP 历史与 watch。
