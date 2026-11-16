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
lib/          ← 纯能力，不认识「谁在调用」
  session.js    登录态 → HTTP 请求（cookie jar / UA / Set-Cookie 合并）
  cloud.js      控制面接口
  e2b.js        数据面 exec/put/get
  acp.js        对话流
  resolve.js    实例引用解析
  creds.js      ★ 凭据门面：daemon 优先、本地兜底
  api.js        daemon 的 HTTP 客户端

bin/wbsbx.js        ← 客户端：解析命令、调 lib、打印
bin/wbsbx-daemon.js ← 守护：调度循环 + 起 HTTP 服务
lib/daemon/         ← 只被 daemon 用
  scheduler.js   三条循环的编排与状态
  heal.js        保活一轮
  renew.js       SSO 续登录态
  server.js      HTTP 接口与鉴权
  logstore.js    日志
```

## 凭据是怎么流动的

`lib/creds.js` 是唯一的读取入口，所有命令都通过它拿凭据，因此**命令层不需要知道自己在哪种模式下运行**。

```
getToken(id)
  ├─ 内存缓存（30s）
  ├─ 本地 tokens/token-<id>.json 够新 → 直接用
  ├─ daemon 在线 → GET /api/token/:id（daemon 会顺手刷新）
  └─ 都没有 → 本地 session 自己发一次请求换
```

登录态同理（`loginState()`）：daemon 优先，本地文件兜底。

几个刻意的选择：

- **daemon 只读不写**：CLI 请求过程中滚动出来的 `Set-Cookie` 只写本地文件。两边各维护一份副本，谁也别覆盖谁。两份 cookie 用同一个 UA，都能鉴权。
- **daemon 不代理业务请求**。`exec` 的结果不经过 daemon 转发，CLI 拿到凭据后自己直连 E2B。这样长命令、大文件传输不会在 daemon 那里排队，daemon 也不需要懂 protobuf 帧。
- **daemon 自己永远是 `local` 模式**（启动时设 `WBSBX_LOCAL=1`）。否则它会通过 `creds` 请求到自己身上，形成回环。

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
| 单机 + 不常驻 | 偶尔用 | 本机 | `--local` 或干脆不启 daemon |
| 服务器 + 多客户端 | 关电脑也要续命 | 服务器 | `daemon pair http://host:8787 --token ...` |
| 容器 | 服务器上隔离部署 | 挂载卷 | 同上，端口映射到宿主回环 |

多客户端场景下，**只有 daemon 那台需要登录态**。其他机器只要能连上 daemon 就行（记得带令牌）。

## 扩展点

**加一个命令**：在 `commands/` 新建文件，导出 `{ run, usage }`，在 `bin/wbsbx.js` 的 `COMMANDS` 里登记。命令只管参数解析和输出，凭据从 `cloud.getSession()` / `session.*` 拿，别自己读文件。

**加一条后台循环**：在 `lib/daemon/scheduler.js` 里加一个方法 + 在 `start()` 里挂 `_loop(name, intervalFn, runFn, initialDelay)`。注意两件事：`busy[name]` 防重入，每轮结束 `_save()` 落状态。

**加一个 daemon 接口**：`lib/daemon/server.js` 里加分支，同时在 `lib/api.js` 的 `DaemonClient` 加对应方法。

## 已知取舍

- **daemon 是单点**。它挂了不影响 CLI 操作，但没人保活。补救办法是接受「实例可能被回收」，或者换个地方再起一个（幂等，不会互相干扰）。
- **保活要配置目标**。不做「自动保活所有实例」—— 那会替你访问一堆你根本不用的会话，既浪费也容易误伤。
- **`renew` 依赖真浏览器**。纯 HTTP 走不通那条 OIDC 链（网关会拦容器内发起的 token 请求）。所以镜像分成 slim / full 两档，不用续期就永远用不上 chromium。
- **cookie 副本会分叉**。CLI 和 daemon 各有一份，正常情况下都能用；万一某一方被网关清了 cookie，另一方还能顶上。这是特性，也是为什么不做「强制单写」。
