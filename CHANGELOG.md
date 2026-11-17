# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。
破坏性变更会标 **BREAKING**。

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
