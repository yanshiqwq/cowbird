# workbuddy —— WorkBuddy 平台 provider

WorkBuddy（`www.workbuddy.cn`）的云沙箱：一个会话 = 一个容器，控制面走 REST，
执行面走 E2B 的 `envd`（端口 49983），对话走 ACP over SSE。

**鉴权只有一条路：`Authorization: Bearer <accessToken>`。**

> 2026-11 的改动：原来用 cookie + 登录时的 User-Agent（APISIX 把会话跟 UA 逐字节绑定，
> 改一个字符就 401）。实测 CodeBuddy CLI 插件登录拿到的 accessToken **能打同一套控制面**
> （列表 / 详情 / 会话凭据 / E2B exec 全部 200），于是 cookie 模式整条删掉 ——
> 少了 cookie jar、UA 绑定、Keycloak 续期、playwright 依赖，也少了那堆"UA 一字不差"的坑。

---

## 能力与方法

| 能力位 | 方法 | 说明 |
|---|---|---|
| `auth` | `auth.state()` | `{mode:'token', token, refreshToken, tokenExpiresAt, account}` |
| `auth` | `auth.ttlDays(state)` | 按 accessToken 到期算 |
| `auth.renew` | `auth.renew()` | 用 refreshToken 换新的 |
| — | `auth.device.{start,poll,describe}` | 无头登录（打印链接 + 轮询），内核 `login` 直接调 |
| `instances.*` | list/get/create/rename/remove | 控制面 `/console/as/conversations/*` |
| `instances.meta` | `info()` | 进容器读 cgroup，同时给「可见」与「真配额」 |
| `instances` | `refresh()` / `token()` | 会话级 E2B 凭据（daemon 的 refresh 循环与 `/api/token` 用） |
| `agent` | `stream/send/history/answer/interrupt` | ACP over SSE |
| `exec` | `run/start/poll/put/get` + `probe` | E2B `process.Process/Start`（connect+json 五字节帧） |
| `fs` | `list/read/write` | 复用 exec 通道（find / base64） |
| `model` | `list/current` | 模型目录 |
| 扩展点 | `keepalive.create` | 「提问挂着不答」的保活（其它平台没有这套语义） |

## 登录（唯一需要用户操作的一步）

```bash
cowbird login                 # 打印一个链接，在任意设备（手机也行）打开授权
```

流程：`POST copilot.tencent.com/v2/plugin/auth/state?platform=VSCode` → `{state, authUrl}`
→ 打印 authUrl → 轮询 `GET /v2/plugin/auth/token?state=…`
（未授权时 `code:11217 "login ing..."`）→ 拿到 `accessToken` / `refreshToken` / `expiresIn`
→ 落盘 `~/.cowbird/platform/workbuddy/device-token.json`（600）→ 顺手实测一次控制面并写日志。

- **不需要浏览器**，服务器 / SSH 里也能登录（不依赖 playwright / Edge）。
- accessToken 约 28 天，refreshToken 可续；daemon 的 renew 循环会定期续。
- 换账号就是重新跑一次 `cowbird login`。

---

## 一、已验证（真机）

| 项 | 证据 |
|---|---|
| token 能打控制面 | 列表 / 详情 / `/session` 全 200；`exec` 跑到 `uid=0(root)`、`nproc=32` |
| 两代沙箱 | cgroup **v2**（tl4 大容器：`nproc=32` 但配额 `400000/100000`=4 核、`memory.max`=8 GiB）与 **v1**（cube 微VM：`nproc=5`，`cfs_quota_us=400000`=4 核） |
| exec | 单行 / 多行、退出码透传、`--background` 起后台 + poll 收输出 |
| 文件 | `put`/`get` 往返字节一致（走 E2B base64 分块） |
| 对话 | `agent.send` + `stream` 拿到正文与 `done(endTurn)` |
| artifact | `_codebuddy.ai/artifact` → `EVENT.ARTIFACT`（实测抓到会话里 2 个 HTML 报告） |
| 否证 | ACP **不提供 token 用量**（raw 里没有任何 `usage`/`*Tokens` 字段） |

## 二、未验证 / 已知边界

- `agent.interrupt`：ACP 没有验证过的"打断正在跑的一轮"方法，只做挂起提问的取消。
- `agent.answer` 的权限回执形状（照 ACP 草案）。
- ACP 里 `session/steer`、`session/queue_*` 这些 extensions 还没接（`session/steer` 才是插入话的正规口）。
- 后台任务的跨重启存活（`nohup` 起来的东西在沙箱重启后会没）。
- 两代沙箱是随机分配还是按容量，未验证。

## 三、自检

```bash
node --check lib/platform/workbuddy/*.js
node lib/platform/workbuddy/selftest.js     # 46 项，纯离线，exit 0
node -e "require('./lib/platform').use('workbuddy')"
```

自检覆盖：cgroup v1/v2 解析、ACP 帧映射（含 artifact / 历史重放跳过）、
执行/文件/后台的输出解析、token 有效期与缓存、契约形状。

## 四、注意

- token 等价于账号在**控制面 + 沙箱执行面**的全部权限，`~/.cowbird/` 下那几个文件别外传。
- `exec` 是沙箱内 root 任意执行，但**不经过 LLM、不进对话轨迹**；平台侧仍按 API 调用计费/计量。
- 与仓库 `DISCLAIMER.md` 口径一致：非官方用法，风险自负。
