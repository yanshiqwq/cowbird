# wbsbx

> **非官方项目。** 用你自己的账号登录、只管你自己的实例，不自带任何凭据、不做提权、不绕过计费。
> 使用的是该服务的网页接口，**可能违反其服务条款**，风险自负。详见 [DISCLAIMER.md](DISCLAIMER.md)。

WorkBuddy 云沙箱管理器。分两半：

- **`wbsbx`（客户端）** —— 列实例、建删改、在容器里直接跑命令、收发文件、看对话历史。纯 CLI，不常驻。
- **`wbsbx-daemon`（守护进程）** —— 替你把实例「续着」，顺手维护登录态。跑在哪儿都行：自己的电脑、一台小 VPS、一个容器。

## 它到底解决什么问题

云沙箱的容器不是你的机器，是平台的临时资源。有两个坑：

1. **没人访问就会被回收。** 控制台上显示「completed」只说明会话结束了，不代表容器还在。
2. **登录态有硬期限。** 访问凭据 72 小时过期；登录 cookie 写死「首次下发 + 7 天」，滚动刷新不会延期。

于是这件事得有人一直做：

```
        ┌──────────────┐        每隔 10 分钟 exec 一下
        │  wbsbx-daemon│ ───────────────────────────────► 云端实例
        │  （常驻）     │        到期前刷 token / 换 cookie
        └──────┬───────┘
               │  HTTP（凭据 + 状态）
        ┌──────▼───────┐
        │  wbsbx CLI   │ ──── 你敲命令的地方，可以在另一台机器上
        └──────────────┘
```

CLI 和 daemon 共享同一个数据目录，但**谁都不依赖谁**：daemon 挂了，CLI 用本地缓存的凭据照样能干活（只是凭据会慢慢变旧）；CLI 从没跑过，daemon 也照样在保活。

## 安装

**还没发到 npm**，目前只有源码安装：

```bash
git clone https://github.com/yanshiqwq/wbsbx.git
cd wbsbx
node bin/wbsbx.js --help          # 不安装，直接用

# 想当全局命令用
npm link                          # 或者 npm i -g .

# 或者跑容器（推荐给服务器）
docker compose up -d
```

要求 node ≥ 18（用了内置 fetch）。浏览器不是必需的 —— 只有「扫码登录」和「自动续登录态」要用它。

## 五分钟

```bash
# 1. 登录（唯一需要浏览器的一步，会弹窗扫码）
wbsbx login

# 2. 看看有哪些实例
wbsbx ls
# ID                   名字        状态                  最近活动  凭据剩余
# 2120000000000000000  work-01     completed/completed   2.8d      2.9d

# 3. 进去跑条命令（走 E2B，不惊动 Agent，也不进对话记录）
wbsbx exec work-01 "uname -a"

# 4. 让它别被回收
wbsbx daemon start --detach
wbsbx daemon targets add work-01
wbsbx daemon status
```

想让一台服务器替你续命（关掉电脑也不影响）：

```bash
# 服务器上
docker compose up -d          # 或者 npm i -g wbsbx && wbsbx-daemon

# 把登录态推过去（在你本机做，因为要扫码）
wbsbx login
scp ~/.wbsbx/state.json 服务器:/path/to/data/

# 本机指向那台 daemon
wbsbx daemon pair http://服务器:8787 --token <它生成的令牌>
wbsbx daemon status
```

## 命令

| 命令 | 作用 |
|---|---|
| `ls [--refresh] [--all]` | 列实例：状态、最近活动、凭据剩余 |
| `info <实例> [--api-only]` | 探活：CPU 配额 / 可见核 / 内存 / uptime |
| `create <名字>` | 新建实例（= 新会话 + 新容器） |
| `rm <实例> [--yes]` | 删除，默认 dry-run |
| `rename <实例> <新名字>` | 改名 |
| `exec [--timeout 秒] <实例> <命令...>` | 在容器里执行，退出码透传。实例之后全归命令，`exec 01 ls -la` 不用加引号 |
| `put` / `get` | 传文件进出（分块 base64，不需要额外通道） |
| `history <实例>` | 拉对话历史到本地 |
| `watch <实例>` | 连上去看一会儿输出 |
| `prompt <实例> <文本...>` | 给会话发一句话（同样：实例之后全是文本） |
| `keepalive <实例>` | 长驻：把会话钉在「等回答」上，防闲置回收 |
| `login [--import]` | 扫码登录 / 从现有浏览器导入 |
| `cookie [dump\|check\|export]` | 看登录态、实测可用性 |
| `doctor` | 体检：数据目录 / 登录态 / 接口 / 实例 / daemon |
| `daemon ...` | 起停、状态、日志、保活目标、连远程 |

实例可以用三种写法引用：完整 id、名字、短序号（`01` 匹配 `work-01`）。

全局开关：`--local` 这次不走 daemon；`--remote <url> [--token <t>]` 这次换成另一台 daemon。

## daemon

```bash
wbsbx daemon start [--detach]    # 启动
wbsbx daemon status              # 各轮结果、登录态还剩几天
wbsbx daemon logs -f             # 跟踪日志
wbsbx daemon targets add 01      # 加进保活名单
wbsbx daemon heal|refresh|renew  # 立刻跑一轮
wbsbx daemon install             # 生成 systemd / 计划任务配置（只打印，不擅自改系统）
```

它在做三件事，周期不同、互不影响：

| 循环 | 默认周期 | 干什么 | 挂了会怎样 |
|---|---|---|---|
| `heal` | 10 分钟 | 对名单里的实例 exec 一个探针命令（默认 `uptime`） | 实例开始倒计时被回收 |
| `refresh` | 6 小时（剩余 < 12h 才动） | 换新 E2B token | 拿旧 token 会 401，CLI 也不好使 |
| `renew` | 按需（cookie < 2 天） | 走 SSO 静默换新登录 cookie | 满 7 天得人工重新登录 |

`renew` 需要真浏览器，默认关。开了但机器上没有 chromium，它会自己跳过并说明原因。

保活探针可以改（不一定要 `uptime`，任何不产生副作用、能快速返回的命令都行）：

```json
{
  "heal": {
    "targets": [{ "id": "2120000000000000000", "name": "work-01" }],
    "intervalMs": 600000,
    "probe": "uptime"
  }
}
```

配置在 `$WB_CLOUD_HOME/wbsbx.json`（默认 `~/.wbsbx/wbsbx.json`）。改完不用重启，下一轮就生效。

## keepalive —— 另一种续命方式

`heal` 和 `keepalive` 解决的不是同一件事，**两个都要**：

| | `heal`（daemon 里） | `keepalive`（独立长驻） |
|---|---|---|
| 手段 | 每 10 分钟一次 E2B exec | 维持一条 ACP 长连接 + 挂着的提问 |
| 成本 | 一次 API 调用，几百毫秒 | 一条常驻 SSE + 每秒一次本地 tick |
| 留痕 | **不进对话历史** | 催话会写进该会话的历史 |
| 作用 | 让平台看到"有人在访问"，不被回收 | 让会话状态停在 `pending`/`working` |

原理：agent 发出 `AskUserQuestion` 之后这一轮会一直等客户端回答，而**服务端不计时**
（默认 5 分钟超时是客户端本地 `setTimeout`）。所以连上去、收到提问不回，会话就钉在那儿了。
掉出这个状态时会补一句催话让它重新提问。

```bash
# 前台跑，Ctrl-C 结束
wbsbx keepalive work-01

# 只观察不催话（验证链路用，不留痕）
wbsbx keepalive work-01 --no-nudge

# 催话间隔 5 分钟、最多催 10 次、跑 2 小时后自动退
wbsbx keepalive work-01 --nudge 300 --max-nudges 10 --sec 7200

# 长期跑（Windows 计划任务 / Linux 同理）
nohup wbsbx keepalive work-01 > keepalive.log 2>&1 &
```

⚠ 三个前提：① 那个 agent 会**永远停在那句提问上**，别对还要继续干活的会话开；
② 催话文案可配（`--prompt`），它在替你对 agent 说话；③ 一个 keepalive 占一条长连接。

配置默认值在 `wbsbx.json` 的 `keepalive` 段：`nudgeSec` / `maxNudges` / `questionTimeoutSec` / `stallAfterNudgeSec` / `leadMs` / `prompt`。
凭据在每次重连前检查，剩不到 `leadMs`（默认 6 小时）就先续一次 —— 纯 HTTP，不需要浏览器。

### 断线了怎么办

长连接最常见的坏法不是"断开"，而是"**没断，但再也不来数据**"（NAT 超时、网关回收订阅、
TCP 半开）。这时候 socket 还开着、`reader.read()` 永远不返回，程序看起来一切正常。四道防线：

| 情况 | 处理 |
|---|---|
| bootstrap 迟迟不给响应头 | `connectTimeoutMs`（20s）后放弃重试 —— 否则 fetch 会永远挂着 |
| 单条 POST 挂住 | `postTimeoutMs`（15s）超时 |
| 催话后一个字节都收不到 | `stallAfterNudgeSec`（30s）后判定连接已死，主动断开重连 |
| 连续 3 次发送失败 | 主动断开重连，计数器归零 |

重连本身也退避：活不过 30 秒的连接算"短连接"，间隔 5s → 10s → 20s → 40s → 60s 封顶，
避免对着一个坏网关每 5 秒锤一次。

**仍有一处检测不到**：如果流已经半开、而上面正好挂着一个提问，进程会认为"正在等用户回答"
（这本来就是它该有的样子）。好在这种情况下那一轮**已经被钉住了**，保活目的已经达到；
要恢复观测能力，重启一次进程即可。

## HTTP 接口

daemon 暴露的东西很少，除 `/health` 外全部要 Bearer 令牌：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 探活，无鉴权，不泄露内容 |
| GET | `/api/status` | 状态 + 最近各轮结果 + 登录态剩余 |
| GET/PUT | `/api/state` | 读 / 推登录态（cookie + UA） |
| GET | `/api/token/:id` | 取实例的 E2B 凭据 |
| POST | `/api/heal` | 立即保活一轮 |
| POST | `/api/refresh` | 立即刷 token |
| POST | `/api/renew` | 立即续登录态 |
| PUT | `/api/targets` | 改保活目标 |
| GET | `/api/logs?limit=100` | 最近日志 |

令牌在 daemon 首次启动时随机生成并写进 `wbsbx.json`（权限 600）。**监听非回环地址却没令牌时，daemon 直接拒绝启动** —— 免得把整份登录态挂在公网门口。

## 几个必须知道的坑

**401 基本都是 UA 对不上。** 这套接口把会话跟 `User-Agent` 逐字节绑定：同一个 cookie，UA 一模一样就 200，改一个版本号就 401。所以 `state.json` 里存了 `ua`，别手动编辑，也别拿同一份 cookie 换个客户端去试。看起来像 TLS 指纹，其实不是（模拟 Chrome 指纹照样 401）。

**Set-Cookie 要按 name+path+domain 合并。** 服务端每次响应都会下发 `session=; Path=/console; Max-Age=0`，那是在删一条历史遗留的 `/console` 路径 cookie。只按 name 合并会把 `path=/` 那条 4001 字符的好 cookie 覆盖成空值，下一轮必 401。

**`nproc` 会说谎。** 它读 CPU 亲和性（cpuset），不是 cgroup 配额。共享宿主的池子里 `nproc` 能看到 32，实际只给你 4 核的带宽。`wbsbx info` 特意把「配额 / 可见 / nproc」分三行列出来。

**成功时没有 exitCode。** E2B 的 end 帧是 proto3 JSON，成功时 `exitCode` 字段被省略。见到 end 而没写退出码 ⇒ 就是 0。

**登录态写盘前会留上一版。** 每次覆盖 `state.json` 都会把上一份存成 `state.json.last-good`。滚动刷新写坏或误清空时，`cp $WB_CLOUD_HOME/state.json.last-good $WB_CLOUD_HOME/state.json` 就能回到上一份可用凭据。

## 安全

- 凭据（cookie、UA、token）全部落本地 `$WB_CLOUD_HOME`，权限 600，不上传任何地方。
- **本项目不是官方客户端**，见 [DISCLAIMER.md](DISCLAIMER.md)。
- daemon 默认只听 `127.0.0.1`。跨机用请走 SSH 隧道或反代 + 令牌，别把 8787 直接暴露到公网。
- `login` 是唯一会打开浏览器窗口的动作，登录完就关。
- 这个工具做的事等于「你自己在控制台点来点去」，没有提权，也没有绕过任何权限。

## 目录

```
bin/wbsbx.js            CLI 入口与分发
bin/wbsbx-daemon.js     守护进程入口
lib/session.js          登录态 → 请求（cookie jar + UA + Set-Cookie 合并）
lib/creds.js            凭据门面：daemon 优先、本地兜底
lib/cloud.js            控制面接口（/console/as/*）
lib/e2b.js              数据面（exec / put / get，5 字节帧）
lib/acp.js              ACP 客户端（对话历史 / watch / prompt）
lib/keepalive.js        长驻保活：连接循环 + 挂起提问 + 催话
lib/api.js              daemon 的 HTTP 客户端
lib/daemon/             守护进程：scheduler / heal / renew / server / 日志
commands/               每个子命令一个文件
docs/protocol.md        接口与协议细节（含踩过的坑）
docs/architecture.md    client/daemon 分层与扩展点
```

## License

MIT
