# 架构：client / daemon

## 一句话

**CLI 做操作，daemon 做维持。** 两者共享一个数据目录，通过一个很小的 HTTP 接口交换「凭据」和「状态」。

## 为什么不是「CLI 直连 + daemon 后台」

早期版本就是这样：所有命令自己读 `state.json`，另外有三个独立脚本在后台刷 token。问题在第 18 天暴露出来：

- 三份进程各自起浏览器、各自写 `cookies.json`，靠文件锁排队，锁一残留就卡住；
- 刷新出来的 cookie 只有那个进程知道，其他进程读到的是旧的；
- 换个机器用，得把凭据目录手工同步过去，同步漏一次就是 401。

把「谁维护凭据」收敛成一个进程之后，这三个问题一起消失了。所以现在：

```
lib/                ← 纯能力，不认识「谁在调用」
  api.js            daemon 的 HTTP 客户端（只发请求，不代理凭据）
  args.js / ui.js / log.js / config.js / fsx.js（原子写）
  browser.js        playwright 的加载与浏览器路径（只有 login 用）
  resolve.js        实例引用解析（纯函数）
  platform/         ← 平台层：内核与驱动之间的唯一约定
    contract.js     能力位 / 事件 / 错误码 / limits
    validate.js     驱动形状校验（没有"已定义就跳过"的快路径）
    index.js        注册表 + ctx（store / effective 配置 / log）
    channels.js     渠道 = 平台 × 账号
    accounts.js     账号目录与迁移
    target.js       跨渠道解析实例
    sandboxes.js    沙箱登记簿（哪些会话是"我们建的"）
    exec.js         执行编排（唤醒预算 / busy 退避 / 后台 follow）
    caps.js         能力缺失的唯一出口（退出码 2）
    util.js / shell.js / cookie.js / sse.js / http.js / settings.js  ← 跨驱动共用的原语
    codearts/ qoder/ minimax/ workbuddy/ trae/                    ← 每个平台一个目录

bin/cowbird.js        ← 客户端：解析命令、调内核、打印
bin/cowbird-daemon.js ← 守护：调度循环 + 起 HTTP 服务
lib/daemon/         ← 只被 daemon 用
  scheduler.js   四条循环（heal / refresh / renew / warm）的编排与状态
  heal.js        保活一轮
  server.js      HTTP 接口与鉴权（**不代理凭据**）
  logstore.js    日志（0600、脱敏、8MB 轮转）
```

## 凭据是怎么流动的

一条规矩：**凭据只以「账号」为单位存放，账号只以目录为单位存在。**

```
~/.cowbird/platform/<平台>/accounts/<账号>/
    device-token.json / auth.json    登录态（形状由平台自己定，内核不看内容）
    conversations.json / jobs.json   驱动自己的缓存与游标
    account.json                     内核写的名片（昵称、uid、登录时间）
```

内核构造 `ctx` 时把 `ctx.store` 指向这个目录，驱动只用 `ctx.store.read/write`，
于是「多账号隔离」是目录带来的，而不是一段特判代码。同一个进程里换账号＝换一个 `ctx`。

```
渠道 = 平台 × 账号            workbuddy:main / qoder:alt
  ctx.channel                'workbuddy:main'
  ctx.account                'main'
  ctx.store.dir              …/platform/workbuddy/accounts/main
```

按实例的短期凭据（WorkBuddy 的 E2B token）留在全局 `tokens/<实例 id>.json` ——
实例 id 是平台侧主键，跨账号不冲突，没必要按账号再切一份。

几个刻意的选择：

- **「没写账号」= 默认账号**：`--channel` > `COWBIRD_CHANNEL` > 配置 `accounts.<平台>` > `default`。
  命令行里 `workbuddy/main` 与 `workbuddy` 的区别只是后者走默认账号。
- **daemon 不代理业务请求**。`exec` 的结果不经过 daemon 转发，CLI 拿到凭据后自己直连数据面。
  这样长命令、大文件传输不会在 daemon 那里排队，daemon 也不需要懂 protobuf 帧。
- **daemon 只读本地凭据**：它不通过 HTTP 去问自己（`/api/state` 这类代理接口已删除）。
  请求到自己身上，形成回环。
- **daemon 按渠道逐个动作**：一轮 heal 里 A 账号的实例和 B 账号的实例各用自己的 `ctx`；
  唯一不能并行的东西（模块级缓存）在驱动里已经被清干净 —— 这是 `test/contract.js` 里
  「两个账号的 store 互不相通」那条用例守着的东西。

## 会话 / 沙箱 / 渠道

三层概念，别混：

| 概念 | 是什么 | 谁决定 |
|---|---|---|
| 渠道 | 平台 × 账号（`workbuddy:main`、`qoder:alt`） | 登录态目录 —— **唯一寻址单位** |
| 会话 | 平台侧的一个对话；用户自己在网页里聊出来的也算 | 平台 |
| 沙箱 | 能塞命令进去的容器：`exec` / `fs` 的目标 | 平台（一个会话一般挂一个） |

平台不区分「用户会话」和「工具建的沙箱」（WorkBuddy 上一个会话就自带一个容器），
所以这件事只能由**本地登记簿**决定：`lib/platform/sandboxes.js`，落在
`platform/<平台>/accounts/<账号>/sandboxes.json`。三个入口：
`cowbird create`（自动）、`cowbird adopt`（显式收编）、`cowbird daemon targets add`（保活目标）。
登记过的算沙箱会话，其余算用户会话 —— `cowbird ls` 默认只列前者，`--all` 全看。

**没有「当前平台」。** 渠道是并行的（几个平台、同平台几个账号同时挂着），平台只是驱动的
命名空间；有「默认」的只有默认渠道（`cowbird account use`）。所以 `cowbird platform` 是
全平台的能力对照，`platform show <id>` 才是单平台细节，「切换当前平台」这个概念已删除。

## 三条生命周期，三种维持手段

这三个东西经常被混为一谈，实际上互相独立：

| 层面 | 靠什么活着 | 谁在管 | 反证 |
|---|---|---|---|
| 容器 | 周期性的真实 API 访问 | `heal`，10 分钟 | 会话 `status=completed` 的实例照样能跑几十小时 |
| 会话状态（pending/active） | 发消息起一轮 agent，或把提问挂着不回答 | `keepalive`（独立命令，长驻） | 只靠 heal 时 UI 会一直显示「已完成」 |
| 凭据 | 到期前刷新 / SSO 换 session | `refresh` + `renew` | token 过期后所有接口 401，但容器还在 |

**`heal` 是基础，`keepalive` 是补强。** 一次 `exec` 就是一次真实的 API 调用，平台的"最近访问"因此被刷新 ——
不需要在容器里装任何东西，也不需要发一句话打扰 agent，这是它便宜且通用的原因。
但"最近访问"和"会话状态"是两套判定，前者可能不足以阻止某些回收策略；要连状态一起钉住，
就用 `keepalive`（收到提问不回 ⇒ 那一轮一直挂着）。两者不互斥，代价是后者会占用一条长连接，
且催话会写进对话历史。

## HTTP 契约

见 README 的接口表。设计上约束了三点：

1. **默认只听回环**，跨机用要显式配 `--host` + 令牌，缺令牌直接拒绝启动。
2. **`/health` 不带任何业务信息**，方便容器探活。
3. **所有写操作幂等**：`PUT /api/targets` 是整表替换，`POST /api/heal` 重复调用只是多访问一次。

## 部署形态

| 形态 | 场景 | 凭据在哪 | CLI 怎么连 |
|---|---|---|---|
| 单机 | 一台电脑用 | 本机 | 自动发现 `127.0.0.1:8787`，没有就用本地文件 |
| 单机 + 不常驻 | 偶尔用 | 本机 | 干脆不启 daemon |
| 服务器 + 多客户端 | 关电脑也要续命 | 服务器 | `daemon pair http://host:8787 --token ...` |
| 容器 | 服务器上隔离部署 | 挂载卷 | 同上，端口映射到宿主回环 |

多客户端场景下，**只有 daemon 那台需要登录态**。其他机器只要能连上 daemon 就行（记得带令牌）。

## 平台驱动（多平台）

平台相关的实现全部关在 `lib/platform/` 下，内核只认五样东西：`Instance / Access / Event / ExecResult / FileEntry`。
**加平台 = 新建 `lib/platform/<id>/` 并实现契约，内核零改动**，详见 [providers.md](providers.md)。

三条约束：

1. **exec 是能力位**，不是命令 —— 平台没有执行通道就不声明，`cowbird exec` 会报"不支持"并以退出码 2 结束；
2. **同步上限由 provider 的 `limits` 决定** —— 内核只做「同步 / 后台 / 拒绝」三选一，不写死 30s 或 600s；
3. **网络与签名全归 provider 的 `transport`** —— 内核里不出现 `fetch`，cookie/UA 绑定/CSRF/签名/轮换都在驱动内部。

当前内置驱动：`workbuddy`（E2B 数据面）、`codearts`（内核 shell）、`qoder`（沙箱 MCP）、`minimax`（无执行通道）、`trae`（无执行通道，有 fs）。
第三方驱动可用 `COWBIRD_PLATFORM_MODULE=<路径|包名>` 挂进来，不需要改内核。

`test/guard.js` 是一道棘轮：内核里出现平台主机名或对 WorkBuddy 实现的直接依赖就失败。

## 扩展点

**加一个命令**：在 `commands/` 新建文件，导出 `{ run, usage }`，在 `bin/cowbird.js` 的 `COMMANDS` 里登记。命令只管参数解析和输出，凭据从 `cloud.getSession()` / `session.*` 拿，别自己读文件。

**加一条后台循环**：在 `lib/daemon/scheduler.js` 里加一个方法 + 在 `start()` 里挂 `_loop(name, intervalFn, runFn, initialDelay)`。注意两件事：`busy[name]` 防重入，每轮结束 `_save()` 落状态。

**加一个 daemon 接口**：`lib/daemon/server.js` 里加分支，同时在 `lib/api.js` 的 `DaemonClient` 加对应方法。

## 已知取舍

- **daemon 是单点**。它挂了不影响 CLI 操作，但没人保活。补救办法是接受「实例可能被回收」，或者换个地方再起一个（幂等，不会互相干扰）。
- **保活要配置目标**。不做「自动保活所有实例」—— 那会替你访问一堆你根本不用的会话，既浪费也容易误伤。
- **`renew` 只对能续的平台有**。WorkBuddy 有 refreshToken，纯 HTTP 就能续（无需浏览器）；
  码道/Qoder 是会话 cookie，不可续，过期只能重新登录。没有该能力的渠道在 renew 那一轮直接跳过。
- **同名实例优先默认渠道**。跨渠道查找是「按顺序命中即停」，不做全局唯一性检查 ——
  这样 `ls` 里看得到的名字永远 `exec` 得到，代价是重名时要写渠道前缀。
- **账号名是目录名**。改名就是改目录（`cowbird account mv`），别手工把凭据挪到另一个目录，
  否则 `account.json` 里的身份会对不上（下次登录会被当成「换了个人」而提示还原）。
