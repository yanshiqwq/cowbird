# workbuddy —— WorkBuddy 平台 provider（适配层）

WorkBuddy（腾讯，`www.workbuddy.cn`）云沙箱平台的驱动。**这个目录只做适配**：
WorkBuddy 的协议实现（cookie+UA 鉴权、控制面、E2B 数据面、ACP 对话流）本来就在仓库里，
这里把它们拼成 `lib/platform/contract.js` 要求的形状（`Instance / Event / ExecResult / FileEntry`）。

```
lib/platform/workbuddy/
  index.js      defineProvider：能力位、limits、defaults、auth/instances/agent/exec/fs/model、doctor、transport
  auth.js       登录态（读 state.json / 扫码登录 / SSO 续期 / 还剩几天）
  instances.js  会话增删改查 + info（进容器读 cgroup）
  probe.js      容器指纹探针：一条 shell 命令 + 纯函数解析（v2/v1/可见资源）
  cgroup.js     cgroup v1/v2、meminfo、space.yaml、字节格式化的纯函数
  exec.js       exec / 后台任务 / put/get（薄封装 lib/e2b.js）
  fsops.js      fs.list/read/write（全部走 exec 通道）
  agent.js      ACP 对话通道：stream / send / history / answer / interrupt / model
  events.js     ACP 原始帧 → 归一化事件（纯函数）
  util.js       日志、单引号转义、输出截断
  selftest.js   纯离线自检（46 项）
```

复用的现成模块（**一个字节都没改**）：

| 模块 | 用途 |
|---|---|
| `lib/session.js` | cookie jar + UA 绑定、`ttlDays` |
| `lib/cloud.js` | `/console/as/conversations/*` 列表/详情/凭据/建/改名/删 |
| `lib/e2b.js` | `process.Process/Start`（connect+json 五字节帧）、`put/get` |
| `lib/acp.js` | `POST {link}/bootstrap` 取 `Acp-Connection-Id`、SSE、JSON-RPC |
| `lib/creds.js` | 登录态与 token 的门面（daemon 优先、本地兜底） |
| `lib/browser.js` | 登录/续期用的 playwright（可选依赖） |
| `commands/login.js` | 扫码登录流程（原样调用） |
| `lib/daemon/renew.js` | Keycloak SSO 续期（原样调用） |
| `lib/keepalive.js` | 「收到提问不回 ⇒ 那一轮挂住」的机制依据 |

## 能力与方法

```js
const p = require('./lib/platform').use('workbuddy');
p.capabilityList(); // agent, agent.interrupt, agent.question, auth, auth.browser,
                    // auth.renew, exec, exec.background, fs, instances.*, model
```

| 方法 | 行为 |
|---|---|
| `auth.state(ctx)` | `creds.readLocalState()` → `{cookies, ua, savedAt}`（同步、不联网） |
| `auth.ttlDays(state)` | `session.ttlDays` —— 只算 `session*` 那几条 cookie |
| `auth.login(ctx,{import,maxWaitMin})` | 薄封装 `commands/login.js`，成功后把新登录态读回来 |
| `auth.renew(ctx,{dry,verifyIds})` | 薄封装 `lib/daemon/renew.js`（注入 Keycloak cookie 换 +7 天 session） |
| `instances.list/get/create/rename/remove` | 映射成 `{id,name,status,updatedAt,extra}`；名字为空时沿用旧名（服务端改名是异步的） |
| `instances.info(ctx,id)` | 进容器读 cgroup，**同时**返回 `visible`（nproc/free/df）与 `quota`（真配额） |
| `agent.stream(ctx,id,{text,includeHistory,stopOnEndTurn,maxMs,idleTimeoutMs})` | async generator，产出归一化事件 |
| `agent.send(ctx,id,{text})` | ACP `session/prompt` |
| `agent.history(ctx,id,{maxWaitMs,raw})` | 抓 `session/load` 的重放，按角色合并成消息列表 |
| `agent.answer(ctx,id,{requestId,answers,outcome,kind})` | 回填 `_codebuddy.ai/question` / `session/request_permission` |
| `agent.interrupt(ctx,id)` | 只能取消**挂起的提问**；否则如实 `{ok:false, reason:'unsupported'}` |
| `exec.probe(ctx,id)` | `getSession` 成功 + `exec('true')` 不报错 → ready |
| `exec.run(ctx,id,{command,timeoutMs,cwd,env})` | `e2b.exec` → `execResult`（`ms`/`truncated` 都填） |
| `exec.start/poll/kill` | `nohup` 起后台 + 输出落文件 + 退出码落文件（先写 `.tmp` 再 `mv`，poll 不会读到半个数字） |
| `exec.put/get` | 复用 `e2b.put/get`（60KB 分块 base64 + 大小校验） |
| `fs.list/read/write` | `find -printf` / `stat`+`base64` / 临时文件 + `e2b.put` |
| `model.list/current` | 控制面 `manifest.model` + ACP 里的 `availableModels` |

事件映射（`events.js`，与任务书表格逐行对应）：

| ACP 原始 | 归一化 |
|---|---|
| `session/update` 且 `_meta['codebuddy.ai'].status` | `status` |
| `agent_message_chunk` | `text` |
| `agent_thought_chunk` | `thinking` |
| `tool_call` / `tool_call_update`（未完成） | `tool`（`{id,name,input,status?}`） |
| `tool_call_update`（completed/failed/cancelled） | `tool_result`（`{id,name,ok,out}`） |
| `_codebuddy.ai/question` | `question`（`{requestId, questions:[{id,header,question,options}]}`） |
| `session/request_permission` | `permission`（`{requestId, tool, detail}`） |
| `session/endTurn` | `done` |
| 其它（artifact、回执、心跳…） | `raw`（`{raw: 原始对象}`） |
| `mode === 'history'` 的重放 | 默认**整条丢弃**；`includeHistory:true` → `raw` + `history:true` |

### 与内核（`lib/platform/*`）的具体对齐

内核这几个文件是本 provider 的真实调用方，逐条对过（本目录只适配它们，不反过来要求内核改）：

| 内核调用点 | 本 provider 的返回 |
|---|---|
| `commands/exec.js` → `platform/exec.run` → `p.exec.probe` | `{ready, why}`（**`why` 必填**：内核把它抄进「沙箱不可用：…」） |
| 同上 → `p.exec.run(ctx,id,{command,timeoutMs,cwd,env})` | `{out,err,code,ms,truncated}` |
| 同上 → `p.exec.start(ctx,id,{command,cwd,env})` / `poll(ctx,id,job)` | `{jobId,outputPath}` / `{done,out,code}`（`env` 由后台 shell 继承） |
| `commands/info.js` → `p.instances.info` | `quota.{cpu,memBytes}` + `visible.{cpu,memBytes}` + `facts[{label,value}]` |
| `commands/ls.js` → `p.instances.list(ctx,{refresh})` / `p.instances.expiry` | `archived` 在**顶层**（`ls` 按 `x.archived` 过滤）；`expiry` 回 **epoch 秒**（`ui.til()` 要秒），只读本地 token 缓存 |
| `commands/create.js` → `p.instances.create(ctx,{name,model,prompt})` | 模型优先级：显式 `model` → `ctx.effective.model`（`platforms.workbuddy.model` 可覆盖）→ `config.DEFAULT_MODEL` |
| `commands/doctor.js` → `p.doctor.checks(ctx,{net})` | `{level,name,detail}`，level 必须是 `ok/warn/bad/info`（写 `error` 会被渲染成 `-`） |
| `commands/transfer.js` → `p.fs.write` / `p.exec.put` / `p.exec.get` | 字符串 content / 本地文件分块上传下载 |

另外 `commands/platform.js` 直接读 `capabilityList() / limits / defaults / version`；`platform/target.js`
用 `instances.list()` + `lib/resolve.js` 的匹配规则做 `01` / 名字 / id 的解析 —— 都无需额外实现。

---

## 一、已验证（来自实测）

这里的「已验证」指：**有实测证据（本目录之外的真实抓包/报告），且本目录的实现只做形状转换**。

| # | 事实 | 证据 |
|---|---|---|
| 1 | 鉴权是 **cookie + 登录时那个 UA 逐字节绑定**；UA 改一个字符就 401，且 401 响应体里的 `session=; Path=/console` 是删历史 cookie，**不能**回写本地 jar | `docs/protocol.md` §〇（2026-11-11 实测）、`lib/session.js` 头部注释、回查报告 §2.2 |
| 2 | 控制面端点：`GET /console/as/conversations/?page&pageSize`、`/{id}`、`/{id}/session`、`POST /`、`POST /{id}`、`/{id}/delete` | 报告 §3（列表/详情/凭据实测 200） |
| 3 | `/session` 返回 `e2bDataEndpoint` + `token` + `cwd` + `link`；`link` 是 ACP 入口（端口可变） | 报告 §3 字段全量清单 |
| 4 | E2B 数据面：`POST {e2bDataEndpoint}/process.Process/Start`、`Content-Type: application/connect+json`、5 字节帧头、成功时 `event.end.exitCode` 被 proto3 省略 ⇒ **见 end 帧无 exitCode 就是 0** | 报告 §6、`lib/e2b.js` 注释、`test/smoke.js` 的帧解析用例 |
| 5 | 两代沙箱 + **真实配额一致**：v2 `cpu.max = 400000 100000`（4 核）、`memory.max = 8589934592`（8 GiB）；v1 `cpu.cfs_quota_us=400000` / `cfs_period_us=100000`、`memory.limit_in_bytes=8589934592` | 报告 §4.2（4 个样本补读 cgroups） |
| 6 | A 代的「32 核 / 123 GiB / 256 GiB」是**宿主**数字：`nproc=32`、`MemTotal=126277 MB`、`cpuset.cpus.effective=0-31`、根盘 256G；且已被限流 `nr_throttled=5` | 报告 §4.1、§4.2 |
| 7 | cgroup 版本判据：v2 挂 `cgroup2fs`（`/init.scope`）、v1 挂 `tmpfs`（`/default/cubebox-<id>_1`）；v1 下 `cpuset.effective_cpus` 为空 | 报告 §4.1、§4.3 |
| 8 | ACP 握手必须 `POST {link}/bootstrap`（`GET /acp` 不给 connection id）；`session/load` 把**全部历史**重放成 `session/update`，重放帧带 `_meta['codebuddy.ai'].mode='history'` | `docs/protocol.md` §二/§三（实测）、`lib/acp.js` |
| 9 | AskUserQuestion 回填形状：`{outcome:'submitted', answers:{'<question id>':['选项 label']}}`；放弃用 `{outcome:'cancelled', reason}`；**服务端不计时**，不回就一直挂着 | `docs/protocol.md` §四、`lib/keepalive.js` 的 `questionTimeoutSec` 分支 |
| 10 | 提问/权限请求**默认不回**是刻意设计（回了就等于替用户作答/授权） | `lib/acp.js` 的 `dispatch()` 注释 |
| 11 | 探针脚本本身在真 Linux 上跑通：本机 WSL（cgroup v2，配额不限）26/26 键都有值，`summarize()` 对真实输出无告警 | 本次实现时实跑（`sh -n` + 实执行 + 解析），见下「locale 陷阱」 |
| 12 | 纯离线自检 46 项全过；`node test/contract.js` 18 项全绿 | `node lib/platform/workbuddy/selftest.js` |
| 13 | 真实内核里跑通（离线）：`wbsbx platform show` 显示 15 项能力与 60s 上限、`platform ls` 正确列出四个平台、`doctor --no-net` 正常渲染本 provider 的检查项、`ls` 在无登录态时给中文报错且**不打网络**（`lib/session.js` 在发请求前就抛 AuthError） | 本次实跑 `bin/wbsbx.js platform show/ls`、`doctor --no-net`、`ls` |

**实跑中发现并修掉的三个真 bug（都属于「不真跑就发现不了」）**：

1. `free` / `df -h` / `uptime -p` 的输出是**本地化**的。在 zh_CN 环境下 `free` 打印的是「内存：」而不是
   「Mem:」，按 `/^Mem:/` 匹配会**静默拿到空值**。修法两条：探针开头 `export LC_ALL=C LANG=C`，
   且 `free` 改成按行号取字段（`NR==2{print $2}`）。
2. `doctor` 的 level 词表是内核定的 `ok/warn/bad/info`。最初写成 `error` 时**不报错、也不显示**，
   只在表里变成一个 `-` —— 等于这条体检项白写。改成 `bad` 后正常显示 ✗。
3. `setTimeout(...).unref()` 用在「看门狗」上是错的。`stream` 的 `idleTimeoutMs` / `maxMs`
   原来都 unref 了：调用方正 `await` 在这条流上、底层连接又在收尾时，Node 认为没有活动句柄，
   于是**静默退出（退出码 0）**，表现为「stream 什么都没吐就没了」。写 selftest 时真踩到
   （80ms 的 idle 超时根本没机会触发）。改成不 unref，并由新增的 idle 超时用例锁住。

## 二、未验证

下面每一条都是**照文档/照协议写的**，没有实测样本；返回里也没假装成功。

| # | 未验证项 | 现状与兜底 |
|---|---|---|
| 1 | **打断正在跑的一轮** | ACP 没有验证过的取消方法（客户端包里有 `_codebuddy.ai/resolveInterruption`，语义未验证，不用）。`agent.interrupt` 只能取消**挂起的提问**（对每条回 `{outcome:'cancelled'}`，这条有 `lib/keepalive.js` 的代码依据）；没有挂起提问时返回 `{ok:false, reason:'unsupported'}` 并带上说明 |
| 2 | `session/request_permission` 的**回执形状** | 仓库里只有「不回」的用法。这里按 ACP 草案写 `{outcome:'selected', optionId}` / `{outcome:'cancelled'}`，`selftest` 只验结构不验语义 |
| 3 | `availableModels` 出现在哪一帧 | 文档说在 `session/load` 的回执里，具体层级未固定。`model.list` 用**有界深度扫描**（`findAvailableModels`，深度 6）兜，抓不到就只回控制面的 `manifest.model` 并标 `source:'control-plane-only'` |
| 4 | `agent.answer` 在**另一条连接**上回填 | 提问绑在收到它的那条连接上。本进程有活动 `stream` 时走那条连接（`via:'live-connection'`，稳）；没有时另开一条去回，返回里明确写 `verified:false` + 说明 |
| 5 | `exec.start` 的后台任务在真实沙箱里存活 | 用 `nohup ... &` + 输出/退出码落文件（对齐报告 §6「自己 `nohup &` + 轮询」）。E2B 通道本身没有原生后台任务，命令通道断开后子进程是否一定留下未实测 |
| 6 | `fs.list/read/write` 在真实沙箱 | 走 `find -printf` / `stat`+`base64` / 临时文件 + `e2b.put`。`find` 不支持 `-printf` 时用 `ls -A` 退化（只给名字）。逻辑与解析都单测过，**没在真沙箱跑过** |
| 7 | `usage` 事件 | WorkBuddy 未见 usage 帧。见到 `params.usage` / `_meta.usage` 才转，见不到就安静跳过（不编 token 数） |
| 8 | 提问里题目 id 的字段名 | `docs/protocol.md` 只说 `answers` 的键是「question 的 id」。这里按 `q.id → q.questionId → 下标` 依次兜 |
| 9 | `create` 会落到哪一代沙箱 | 报告 §9 明确未验（本次不新建会话，避免烧 token） |
| 10 | `instances.rename` 的最终标题 | 改名异步。这里先返回我们刚设的名字，服务端生效后再拉到就以服务端为准 |
| 11 | 全部**真实网络调用** | 按任务约束，本次**一次真实请求都没发**（没有可用凭据）。所有网络路径只写代码不执行 |

另外两个**刻意的取舍**（不是没做完，是想清楚不做）：

* **不声明 `exec.wake`**。WorkBuddy 沙箱长寿（抽样里最长 22 小时），也没有独立唤醒接口，
  `exec` 本来就能直连 —— 声明 wake 只会让内核多打一次无意义的往返。`exec.wake()` 方法仍然实现着
  （重取凭据 + 探活重试），需要时显式调用。
* **`auth.renew` 需要 playwright**。没有 `playwright-core` 时 `runRenew` 如实返回 `NO_BROWSER`；
  纯 HTTP 走不通那条 Keycloak 链（见 `docs/architecture.md`「已知取舍」）。

## 三、怎么用真账号跑一次

前提：Node ≥ 18（本机 Node 24）、`playwright-core` 若要扫码/续期才需要、一把能登录 workbuddy.cn 的账号。

```bash
cd wbsbx

# 0) 数据目录（默认 ~/.wbsbx；想隔离就指个别处）
export WB_CLOUD_HOME=$HOME/.wbsbx-wbtest

# 1) 扫码登录（唯一需要浏览器的步骤；写完 state.json 里的 cookie + UA）
node bin/wbsbx.js login
node bin/wbsbx.js cookie check          # 期望：登录态有效
```

```bash
# 2) 平台层冒烟：只读、不新建会话、不烧 token
node -e '
const reg = require("./lib/platform");
const p = reg.use("workbuddy");
const ctx = reg.context(p);
(async () => {
  console.log("auth", p.auth.state(ctx) && p.auth.ttlDays(p.auth.state(ctx)));

  const list = await p.instances.list(ctx);
  console.log("instances", list.length, list.slice(0, 3).map((x) => x.id + " " + x.name));
  const id = list[0].id;

  console.log("probe", await p.exec.probe(ctx, id));                       // {ready:true}
  console.log("nproc", (await p.exec.run(ctx, id, { command: "nproc" })).out.trim());

  // ★ 重点：两组数字都要出来，且 quota 明显小于 visible（A 代沙箱）
  const info = await p.instances.info(ctx, id);
  console.log("visible", info.visible);   // {cpu:32, memBytes:≈123GiB, diskText:"256G"...}
  console.log("quota  ", info.quota);     // {cgroupVersion:"v2", cpu:4, memBytes:8589934592...}
  console.log("warnings", info.warnings); // 有 nr_throttled>0 时会额外报一句

  console.log("fs", await p.fs.list(ctx, id, { path: "/workspace" }));
  console.log("model", await p.model.list(ctx, id));
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
'
```

期望看到的两种沙箱（判据见报告 §4.3）：

```
A 代：quota.cgroupVersion=v2 / visible.cpu=32 / quota.cpu=4 / visible.memBytes≈123GiB / quota.memBytes=8GiB
       kernel 含 tl4、pid1=/sbin/docker-init…
B 代：quota.cgroupVersion=v1 / visible.cpu=5  / quota.cpu=4 / visible.memBytes≈8.2GiB / quota.memBytes=8GiB
       kernel 含 cube.bm.guest、pid1=supervisord…
```

```bash
# 3) 对话通道（会触发 agent 干活，会产生会话内容 —— 用你愿意留痕的实例）
node -e '
const reg = require("./lib/platform"); const p = reg.use("workbuddy"); const ctx = reg.context(p);
(async () => {
  const id = (await p.instances.list(ctx))[0].id;
  await p.agent.send(ctx, id, { text: "只回一句：收到。" });
  for await (const ev of p.agent.stream(ctx, id, { maxMs: 120000 })) {
    if (ev.kind === "status") console.log("[status]", ev.data.status);
    else if (ev.kind === "text") process.stdout.write(ev.data.text);
    else if (ev.kind === "thinking") process.stdout.write("(thinking)");
    else if (ev.kind === "question") { console.log("\n[question]", JSON.stringify(ev.data)); }  // 需要人答
    else if (ev.kind === "done") { console.log("\n[done]", ev.data.reason); break; }
    else if (ev.kind === "error") { console.error("\n[error]", ev.data.message); break; }
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
'

# 4) 后台任务：起 / 轮询 / 收尾
node -e '
const reg = require("./lib/platform"); const p = reg.use("workbuddy"); const ctx = reg.context(p);
(async () => {
  const id = (await p.instances.list(ctx))[0].id;
  const job = await p.exec.start(ctx, id, { command: "for i in 1 2 3; do echo tick$i; sleep 1; done" });
  console.log(job);                                  // {jobId, outputPath, pid}
  for (;;) {
    const st = await p.exec.poll(ctx, id, { jobId: job.jobId });
    if (st.done) { console.log("exit", st.code, JSON.stringify(st.out)); break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(await p.exec.kill(ctx, id, { jobId: job.jobId }));   // 已结束则 gone
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
'
```

排错：

| 现象 | 原因 | 处理 |
|---|---|---|
| `接口 401` | UA 跟登录时不一致 / 登录态过期 | 重跑 `node bin/wbsbx.js login`；**不要**手改 `state.json` 里的 `ua` |
| `bootstrap 没给 Acp-Connection-Id` | 网关半开或 `link` 过期 | 重取凭据（`cloud.refreshSession`）后重试；网关问题只能等 |
| `quota.cpu = null` + 告警 | 这台沙箱读不到 cgroup 文件 | 看 `info.probe.raw` 原始键值；`visible` 仍然可用但不可信 |
| `fs.list` 返回空但目录非空 | `find` 不支持 `-printf` | 代码会退化成 `ls -A`；若仍空，用 `exec.run(ctx,id,{command:"ls -la /workspace"})` 对照 |
| `auth.renew` 返回 `NO_BROWSER` | 没装 playwright-core | `npm i playwright-core`，或干脆只跑 exec/agent（不需要浏览器） |

## 四、自检

```bash
node --check lib/platform/workbuddy/index.js      # 逐个文件（或下面那条循环）
node lib/platform/workbuddy/selftest.js           # 纯离线，46 项，退出码 0
node -e "require('./lib/platform').use('workbuddy')"   # defineProvider 校验通过
node test/contract.js                             # 18 项全绿
```

`selftest.js` 覆盖：cgroup v2/v1 两种配额解析（含 `max` 与 v1 无限制哨兵）、可见 vs 配额与告警、
探针脚本的键与 locale 固定（含真机上「不限配额」那种形态）、ACP→事件的整张映射表
（含历史重放 / 提问 / 权限 / 工具调用）、回填体三种形状、会话对象映射与 `expiry`、
后台任务 / `find` / `base64` 解析、`loginArgv`/`ttlDays`、provider 形状与能力位，
以及**用假 ACP 连接跑通 stream → 问答 → endTurn / idle 超时 / 连接失败**这条最易写错的回调桥。

跑内核侧的联调（离线即可，不需要登录态）：

```bash
export WB_CLOUD_HOME=$HOME/.wbsbx-offline-check   # 用临时数据目录，别碰真凭据
WBSBX_LOCAL=1 node bin/wbsbx.js platform show     # 能力表 + 60s 上限 + 默认模型
WBSBX_LOCAL=1 node bin/wbsbx.js platform ls       # 四个平台都能加载
WBSBX_LOCAL=1 node bin/wbsbx.js doctor --no-net   # 本 provider 的体检项（登录态应显示 ✗）
```
