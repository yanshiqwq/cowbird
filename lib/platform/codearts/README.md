# codearts —— 华为云「码道 CodeArts」平台驱动

`wbsbx` 的第二个真实平台驱动。基址 `https://devcloud.cn-north-4.huaweicloud.com/chat`。

一句话概括：**会话/回合走云侧 REST + 具名 SSE，免 LLM 的 exec 走"预览代理 → 沙箱内 agentkernel 的 `/shell`"这条隐藏隧道**，同步上限 30 秒。所有协议事实来自 `码道CodeArts-平台完整调查报告.md`（实测为主），本目录是把那份报告变成契约形状的代码。

```
lib/platform/codearts/
├── index.js        provider 定义与全部能力实现（唯一导出）
├── transport.js    HTTP：必需头、HW-AJAX-REDIRECT→AuthError、busy→E_BUSY、SSE 打开与读帧
├── sse.js          具名 SSE 帧解析 + 15 种事件 → 归一化事件
├── shell.js        命令包装（退出码/stderr 分离）、30s 截断识别、后台任务脚本
├── cgroup.js       cgroup v2/v1 容量采集与解析
├── answers.js      提问回答的 answers 形状（数组的数组 + `"label" - description`）
├── auth.js         登录态（cookie 文件）、手动粘贴导入、浏览器登录（代码，未在此机执行）
├── selftest.js     纯离线自测：99 项，零网络、零副作用
└── README.md       本文件
```

自测：

```bash
node lib/platform/codearts/selftest.js     # 全 ✓，退出码 0
```

---

## 1. 能力与 limits

| 能力 | 实现方式 |
|---|---|
| `auth` / `auth.browser` | cookie 文件（`<HOME>/platform/codearts/auth.json`）+ 浏览器取 cookie 或手动粘贴 |
| `instances.list` | `GET /v1/cloudagent/sessions?page_num&page_size` |
| `instances.create` | `POST /v1/cloudagent/sessions`（body `{}`）→ 需要名字再 `PUT {title}`；`--model` 记在该实例名下（平台建会话不收 model/prompt） |
| `instances.rename` | `PUT /v1/cloudagent/sessions/{id}` body `{title}` |
| `instances.remove` | `DELETE /v1/cloudagent/sessions/{id}` |
| `instances.meta`（`get`） | `GET /v1/cloudagent/sessions/{id}`（含 `agent_session_id`） |
| `agent`（`stream`/`send`/`history`） | `POST …/messages`（响应即 SSE）/ 同接口不回放 / `GET …/messages?page_num&page_size` |
| `agent.question`（`answer`） | `POST /v1/cloudagent/sessions/{id}/messages/reply` |
| `agent.interrupt` | `POST /v1/cloudagent/sessions/{id}/messages/stop` |
| `exec`（`probe`/`run`） | 预览隧道 `POST …/sessions/{sid}/9800/preview/session/{ksid}/shell` |
| `exec.background`（`start`/`poll`） | `nohup … &` 写 `/workspace/.wbsbx/<job>.log`，`poll` 用 shell `cat` |
| `exec.wake` | 发一条最小 prompt（"执行 `true` 并回复 ok。"）→ 轮询详情直到 `agent_session_id` 出现 |
| `fs`（`list`/`read`/`write`） | `files/tree`、`files/content`；写走 shell base64 分块（60KB/块） |
| `model` | `GET /PromptCenterService/v1/model/builtin` |

```js
limits: { maxSyncMs: 28000, defaultSyncMs: 20000, maxBackground: true, wakeTimeoutMs: 90000 }
```

`maxSyncMs = 28s` 是**故意**小于网关的 30s 硬上限的：实测 29s 能成、32s 在 30.1s 被截断，
留 2 秒余量才能在"被截断"和"正常返回"之间做确定判断。

**故意不声明**：
- `auth.renew` —— 三条 cookie 全是 session cookie（无 `expires`），平台没有可续期的固定期限，过期只能重抓；
- `heal`/`keepalive` 语义 —— 沙箱按**运行时长**回收（约 30–40 分钟），心跳与访问活跃度都不参与判定，
  自建 `busy` 心跳每 30s 一条、前端 20 分钟 492 次请求，实测都没能续命。本驱动改成"用之前先 `wake`"。

几个跟内核（`lib/platform/exec.js` 与命令层）对齐过的地方：

- `exec.run` 接受 `{command, timeoutMs, cwd, env, wake, raw}`：`cwd` 用 `cd` 前缀、`env` 用 `export K='V'` 前缀
  （内核 `execCore.run` 会把这些原样传下来）。`wake` 默认 **false** —— 唤醒要花 credit，内核的 `ensureReady` 已经负责。
- `exec.poll(ctx, id, job)` 直接吃内核的 `follow()` 传来的整个 job 对象（里面有 `jobId`）。
- `instances.remove` 遇到 `--archive` 会**拒绝**：平台只有 `DELETE`（真删），没有归档语义，不能"归档"变成误删。
- `doctor.checks(ctx, {net})` 尊重 `--no-net`：`net:false` 时一个请求都不发。
- `instances.info` 不抛错（`{ready:false, why, hint}`）—— `commands/info.js` 就是按 `ready` 分支显示的。

---

## 2. 已验证（实测或报告里的实测结论）

> "已验证"= 协议事实由真实请求证实（报告标注「实测」）；本驱动对这些事实的**编码**另有离线自测兜底（`selftest.js`）。

| # | 结论 | 驱动里的落点 |
|---|---|---|
| 1 | 基址 `/chat`，SPA 也挂在 `/chat/` | `transport.BASE` |
| 2 | 鉴权 = cookie `devclouddevuibjJ_SESSION_ID` + 头 `cftk`（取 `devclouddevuibjtcftk` 的值）+ `x-requested-with: XMLHttpRequest` + **`agent-type: CodeBase`** + `x-codearts-doer-scenario-type: web`；**不绑 UA** | `transport.buildHeaders()`；不存 UA |
| 3 | **未登录 = HTTP 200 + 空体 + `HW-AJAX-REDIRECT: …authui/login…`**（不是 401） | `transport.isNotLoggedIn()` → `AuthError(code=E_NOT_LOGGED_IN)` |
| 4 | 缺 `agent-type` → `400 TM.00001001` | `CODES['TM.00001001'] → E_NO_AGENT_TYPE` |
| 5 | 会话 CRUD 四个端点与 `{status:'ok', result:…, total}` 信封 | `instances.*` |
| 6 | 会话状态枚举 `ACTIVE/IDLE/RUNNING/COMPLETED/FAILED/CANCELED/WAITING_APPROVAL/CLOSED` | `STATUS_MAP` → idle/running/… |
| 7 | 发一轮 = `POST …/messages`，响应体即具名 SSE；`parts` 不是有效字段 | `agent.stream`、`messageBody()`（自测断言不带 `parts`） |
| 8 | 15 种 SSE 事件名与字段（`status/thought/message/tool_call/tool_call_delta/tool_result/question/tool_authorization/file_diff/step_finish/session_title/heartbeat/error/stopped/done`） | `sse.mapFrame()` 全表映射 |
| 9 | **`error` 帧兼任「流正常结束」哨兵**：`type==='stream_ended'` 或 `error_code==='CODEBASE.00010628.200'` | `sse.isStreamEnded()` → `done` |
| 10 | `heartbeat` 是提问挂起期间唯一的活命信号（约 15s 一条） | 映射成 `raw+alive:true`（不丢），流空闲超时 120s |
| 11 | 提问回答形状 = `{"question_id":…, "answers":[[ "\"苹果\" - 清脆多汁，香甜可口" ]]} `；抄错 → `400 CODEBASE.00011002.400` | `answers.buildAnswers()`；自测逐字节比对报告原文 |
| 12 | 历史分页参数是 **snake_case**（`pageNum/pageSize` 被忽略），返回**倒序**，用 `total` 自己算页 | `agent.history()`（按 `message_index` 升序还原） |
| 13 | ★ 免 LLM exec：`POST …/sessions/{sid}/{PORT}/preview/session/{ksid}/shell` body `{command, agent:'build'}` → `parts[0].state.output`；tokens/cost 全 0、不进历史 | `exec.run()`、`shellPath()` |
| 14 | 同步上限 30s；**超时返回 200 但 `state.status` 空、输出空**，命令仍在沙箱里跑 | `shell.parseShellResult()` → `truncated:true` |
| 15 | 超时后再请求 → `400 {"name":"UnknownError","data":{"message":"Session … is busy"}}`，跑完自动恢复 | `apiError()` → `E_BUSY`（`retryable`, `retryAfterMs:2000`） |
| 16 | 同一 kernel session **串行**，并发只有第一条拿到输出 | 驱动不做并发；busy 交给上层退避 |
| 17 | 沙箱**只在真跑一轮 agent 时创建**；`POST /start` 无效（75s 仍 `00010605.200`）；`agent_session_id` 此时才出现 | `exec.probe()`（`no-sandbox`）、`exec.wake()` |
| 18 | 错误码：`00010605.200` 从未创建 / `00010610.409` 曾创建但不可用 / `00010606.200` 预览服务未启动 / `00010609.502` 预览暂不可用 / `00010611.413` 超限 / `00011003.401` 缺 AtomGit token / `TM.00001050` 排队不重试 | `transport.CODES` 全表 → 语义码 + 处置建议 |
| 19 | 文件通道：`/v1/…/files/tree[?path=]`、`/v1/…/files/content?path=`、`/codebaseservice/…/files/{raw-content,download,artifacts}` | `fs.list/read`（`content` 读不到时退回 shell `base64`） |
| 20 | 模型：`GET /PromptCenterService/v1/model/builtin`，12 个，含 `deepseek-v4.1-flash-1017` | `model.list()`；`defaults.model` |
| 21 | 输出能力：`seq 1 20000` → 108,894 字符全返回；shell 身份 root、cwd `/workspace`；`base64 -w0` 取二进制可行 | `exec.run` 不设输出上限；`fs.write` 分块；`pullFile` base64 |

### 自测覆盖（`selftest.js`，99 项，全离线）

- SSE：整段 / 逐字节 / CRLF（含 `\r|\n` 跨块边界）/ 多行 `data` / 注释行 / `id`,`retry` 忽略 / 非 JSON 不丢帧；
- 事件：15 种逐一映射、`error` 哨兵算 done、普通 `error` 仍是 error、`stopped`→done、`heartbeat`→raw+alive、未知事件→raw；
- `answers`：标准形状、只给 label 自动补 description、选项对象/单字符串/已格式化串、多选、多题、空 description 保持固定格式；
- cgroup：v2（含 `max` 不限）、v1（含 quota `-1`、内存 2^63 魔数）、`CG=none`、df 缺失；
- shell：`shQuote`、包装往返（out/rc/stderr）、命令自己打印同名标记不会骗过、30s 截断特征、`completed` 空输出不算截断、后台脚本与 poll 解析；
- 认证：`parseCookieString`、`isLoggedIn`、`ttlDays===null`、四个必需头、`HW-AJAX-REDIRECT` 判定、401 空体、错误码全表、busy→E_BUSY；
- 归一化：会话字段/状态枚举/消息/`messageBody`/文件树；
- **编排（假 transport，零网络）**：`agent.stream` 事件序列与 done 收尾、断流补 `E_STREAM_CUT`+done、`answer` 出站 body、`send` 只发不回放、`exec.run` 包装与截断、无沙箱报 `E_NO_SANDBOX`、`start/poll` 闭环、`fs.write` 3 块 60KB、`fs.list/read`、分页、`create`（改名 + 记住 model）、`remove --archive` 拒绝、`info` 的"可见/配额"两组数、`doctor --no-net` 不发请求。

---

## 3. 未验证（代码写完，但**没有**用真账号跑过）

任务约束是"不许发真实网络请求（没有凭据）"，所以下面这些只有代码与离线单测，**没有一条经过线上校验**。按风险从高到低：

| # | 未验证项 | 现在的做法 | 万一不对的表现 / 怎么改 |
|---|---|---|---|
| 1 | **命令包装层**（`( cmd ) 2>tmp` + `__WBSBX_RC=` + `__WBSBX_STDERR__`）能否被 agentkernel 的 bash 工具原样接受 | 每条命令多打两行标记，驱动负责拆回 out/err/code | 若内核改写输出或裁剪尾部，标记会找不到 → 驱动自动降级为 `wrapped:false`（只给原始输出、退出码 null），不会谎报 0。真实环境请先跑 `wbsbx exec <id> 'echo hi; exit 3'`，看 code 是否为 3 |
| 2 | `files/content` 的**信封嵌套**（`{result:{type:'text',content}}` 还是平铺 / `{data:…}`） | 三个候选都试（`result`/`data`/根），读不到就退回 shell `base64` | 退回路径是通的（19 已验证），只是慢一点；看到 `via:'shell'` 就说明信封猜错了 |
| 3 | `files/tree` 的信封与 `path` 语义（根固定 `/workspace`） | `treeNode()` 试 `result`/`data`/`tree`/根；`findNode()` 按 `path` 精确定位 | 列表为空但文件其实存在 → 调 `fs.list` 时把 `path` 传成根或改成 `recursive:true` |
| 4 | `PUT /sessions/{id}` 改名后详情是否立刻反映新标题 | 改完再 `GET` 一次；失败则用传入的 title 兜底 | 名字短暂为空是平台已知的异步改名行为，内核侧应保留旧名 |
| 5 | 历史消息的字段名（报告只确证 `message_index`、倒序、`total`） | `normalizeMessage` 取 `content` 或 `parts[].text`，`role` 取 `role`/`message_type` | 文本取不到就只留在 `raw` 里；分页与倒序修正不受影响 |
| 6 | 模型列表的信封（`result`/`data`/`models`） | 三个候选 | 返回空数组；此时手写 `model_id` 仍能发消息（`defaults.model` 是实测值） |
| 7 | `401` 后"重读 cookie 再试一次"的补偿 | 重读本地文件后递归一次（`retried`） | 平台实测未出现 401；真没登录是 `HW-AJAX-REDIRECT`（已验证） |
| 8 | `login` 的页面探活走 `GET /rest/me`（该端点在报告里标「实测」返回身份信息） | 轮询 `/rest/me`，判据 = `200 && 无 HW-AJAX-REDIRECT && 有 body` | 若 SPA 不加载导致同源 fetch 被 CSP 拦，改用 `--cookie` 手动粘贴（这条路不依赖浏览器） |
| 9 | 60KB 的 base64 分块作为**单条命令**是否被网关/内核接受（实测只验过 108KB **输出**，没验过 108KB **命令**） | 每块 60KB，`printf '%s' … >>` 追加 | 若 400/截断，把 `CHUNK_BYTES` 调小（`index.js` 顶部常量）；分块数在 `fs.write` 返回值里能看到 |
| 10 | `pullFile` 的一次性读取上限（4 MiB → base64 约 5.4 MB 响应） | 超过就报 `E_TOO_LARGE` 并指向 `files/download` | 大文件请用 `files/download`；这条路径驱动里没实现（契约未要求） |
| 11 | `exec.put/get`（二进制往返） | base64 分块写 / `base64 -w0` 读 | 与 `fs.write` 同一条路，风险也相同 |
| 12 | `tool_authorization` 的真实帧 | 映射成 `permission`，`requestId=permission_id` | 当前账号 bash 是 `always_allow`、`CODEAGENT_PERMISSION_AUTO_ALLOW=true`，实测不触发；**平台没有暴露回复权限的接口**，所以驱动只报告不回复 |
| 13 | 沙箱精确回收 TTL（两次观测 30–40 分钟） | 不猜：每次 exec 前 `probe`，不 ready 就报 `no-sandbox` 让上层 `wake` | 被回收后 `agent_session_id` 是否复用同样未知；驱动不缓存它，每次现取 |
| 14 | 重建后 `/workspace` 从 OBS 快照异步恢复（会覆盖新写入） | 驱动无对策（平台行为） | 长任务日志建议放 `/mnt/data/`（报告建议） |
| 15 | 沙箱内 `mktemp` / `base64 -d` / `wc -c` / `nohup` / `kill -0` 都在 | 依赖 coreutils（EulerOS 3.0 自带） | `mktemp` 已带 `/tmp/.wbsbx-err-$$` 兜底；其余若缺失会体现在 `wrapped:false` 或 rc≠0 |

---

## 4. 用真账号怎么跑

> 前提：你自己有一个已登录的码道账号（本驱动用的是**自己账号、自己会话**，见仓库 `DISCLAIMER.md`）。
> 平台改版会先打断下文第 1 步之前的准备，最脆弱的是 `/shell` 这条隐藏隧道（它不在内核 `/doc` 里）。

### 4.1 取登录态（二选一）

**A. 有浏览器（本机 Win/mac，或装了 playwright-core 的 Linux）**

```bash
npm i playwright-core            # 可选依赖；没有就用 B 方案
wbsbx login --platform codearts  # 打开登录页，扫码/短信；登进去后自动抓 cookie 存盘
```

`login` 用的是**一次性上下文**（不是 WorkBuddy 那种持久 profile）：本平台不绑 UA，也不需要留浏览器痕迹。

**B. 没浏览器（WSL/容器/服务器，最省事）**

在已登录的浏览器 DevTools → Console 里：

```js
document.cookie   // 复制整串（注意 HttpOnly 的 J 那一条在 Application→Cookies 里能看到并复制）
```

```bash
wbsbx login --platform codearts --cookie 'devclouddevuibjJ_SESSION_ID=…; devclouddevuibjtcftk=…; devclouddevuibjagencyID=…'
```

驱动只保留 `huaweicloud.com` 域的 cookie，并校验 `devclouddevuibjJ_SESSION_ID` 必须在。

### 4.2 逐条验证（每条都能判真假）

```bash
wbsbx doctor --platform codearts          # 登录态 / GET /rest/me / 会话列表 / 浏览器
wbsbx ls --platform codearts              # 列表；注意 total 与页大小
wbsbx ls --platform codearts --refresh
```

> 若 `doctor` 报 `登录态` error，先确认是不是**过期**：cookie 全是 session cookie，关浏览器/SSO 空闲超时即失效，只能重抓。

```bash
# 新建（建完没有沙箱，agent_session_id 为空 —— 这是正常的）
wbsbx create --platform codearts --name probe-01

# 一定要先 wake：沙箱只能靠"真跑一轮 agent"创建，POST /start 实测无效
wbsbx wake --platform codearts <实例>     # 约 0.2 credit

# 免 LLM exec（tokens=0、cost=0、不进对话历史）
wbsbx exec --platform codearts <实例> 'id; uname -smr; df -h / | tail -1'
wbsbx exec --platform codearts <实例> 'echo hi; exit 3'     # 校验退出码是不是 3
wbsbx info --platform codearts <实例>                       # 可见 vs 配额（cgroup v2/v1）
```

30 秒是硬顶，长任务用后台：

```bash
wbsbx exec --platform codearts --background <实例> 'sleep 45; echo LONG-DONE'
wbsbx exec --platform codearts --poll <实例> <jobId>
```

回合与提问：

```bash
wbsbx prompt --platform codearts <实例> '只回复 ok'
wbsbx prompt --platform codearts <实例> '问我最喜欢哪种水果'   # 出现提问 → 记下 question_id
wbsbx answer --platform codearts <实例> --question <question_id> --option 苹果
```

### 4.3 判断"驱动是对的"的最小证据集

| 现象 | 说明什么 |
|---|---|
| `exec 'echo hi; exit 3'` → `code === 3` | 包装层与退出码通道成立（未验证项 #1） |
| `exec 'id'` → `uid=0(root)` | 隧道打通且身份符合预期 |
| `exec 'sleep 40'` → `truncated:true`、`code:null`，紧接着一次 `exec` 得到 `E_BUSY` | 30s 截断与 busy 识别都成立 |
| `fs.read` 返回里没有 `via:'shell'` | `files/content` 信封猜对了（未验证项 #2） |
| `fs.write` 写 100KB 后 `wc -c` 对得上 | 60KB 分块成立（未验证项 #9） |
| `answer` 不返回 `CODEBASE.00011002.400` | `answers` 形状对（这条自测已逐字节对齐报告原文） |

### 4.4 已知的坑（照抄别人的驱动会栽）

1. **`agent-type: CodeBase` 少一个就 400 `TM.00001001`** —— 很多调用方只加 `cftk`。
2. **未登录是 200 + 空体**，不是 401。看成"空列表"会让 `ls` 静默返回 0 条。
3. **`error` 帧不是错误** —— `stream_ended` / `00010628.200` 是正常结束哨兵。当失败处理会把每一轮都标红。
4. **`answers` 是"数组的数组"**，元素是 `"label" - description`（带引号、空格、连字符）。`[{answer:'苹果'}]` 必 400。
5. **分页参数是 `page_num`/`page_size`**，`pageNum` 会被忽略并返回 50 条；返回是倒序。
6. **`POST …/start` 不建沙箱** —— 只有 agent 回合能建，且这一步要花 credit。
7. **`heartbeat` 是提问挂起时的活命信号**，别当成空帧丢掉，否则空闲超时会把挂起的提问误杀。
8. **同一 kernel session 串行**：并发的第二条只会 400 busy。
9. 沙箱回收看**运行时长**，`heal` 那套每 10 分钟 exec 一次在这里完全无效。

---

## 5. 给内核（命令层）的接口约定

本驱动只输出契约里的五种形状。额外需要内核注意的几点：

1. **`exec` 前先 `wake`**：`exec` 能力与 `exec.wake` 是分开声明的。`exec.run()` 默认**不会**自动 wake（那要花 credit），
   但它接受 `{wake:true}`。内核应该在 `probe()` 返回 `{ready:false, why:'no-sandbox'}` 时显式问用户要不要 wake。
2. **`truncated:true` 必须被尊重**：它意味着"命令还在沙箱里跑，输出没拿到"，不是"成功但没有输出"。
   正确的下一步是 `poll` 或等它跑完，**不要立刻重试**（会 400 busy）。
3. **`done` 一定会有**：正常结束、`stopped`、断流三种情况都以 `done` 收尾；断流时会先给一个 `error(E_STREAM_CUT)`。
4. **`tool` 事件可能同 id 出现多次**（首帧 `partial:true`、`delta:true`、补全帧），按 `data.id` 去重更稳。
5. **`question` 事件的 `requestId` 会存进 store**，`answer` 不带 `requestId` 也能工作；但同一个会话换题时会以最后一次为准。
6. **`instances.info` 不抛错**：没沙箱返回 `{ready:false, why, hint}`；采集失败返回 `{ready:true, partial:true}`。展示层按 `ready` 分支。

---

## 6. 与 WorkBuddy 驱动的差异（为什么不能照抄）

| 维度 | WorkBuddy | 码道 CodeArts |
|---|---|---|
| 鉴权 | cookie + **UA 逐字节绑定** | cookie + `cftk` 头 + `agent-type`，**不绑 UA** |
| 未登录信号 | 真 401 | **200 + 空体 + `HW-AJAX-REDIRECT`** |
| 登录态寿命 | 硬顶 7 天、可 SSO 续期 | session cookie，**不可续**，只能重抓 |
| 对话通道 | ACP JSON-RPC over SSE | **具名 SSE**（15 种事件） |
| 提问 | `_codebuddy.ai/question`（不答即挂起） | `question` 事件 + `messages/reply`（形状怪） |
| 免 LLM exec | E2B 数据面（独立通道） | **预览代理 → 内核 `/session/{id}/shell`**（30s 顶、串行） |
| 文件 | base64 over exec | 独立 `files/*` 接口 + shell |
| 保活 | `heal` 每 10 分钟一次 exec（有效） | **无效**（按运行时长判定），只能重跑回合 |

---

## 7. 风险与边界

- `/shell` 是**未写进内核 `/doc` 的隐藏路由**，平台改版随时可能消失。驱动已经做到"探测失败就明确报错"（`E_NO_SANDBOX` / `E_NO_PREVIEW`），不会假装成功。
- 该通道等价于沙箱内 root 任意执行 —— 但平台自身把 bash 设为 `always_allow`、`CODEAGENT_PERMISSION_AUTO_ALLOW=true`，所以**不是绕过审批**。
- `cost=0`、不进历史是平台的内部行为；大规模滥用可能触发风控，风险自负（同仓库 `DISCLAIMER.md`）。
- 本驱动**不发起任何网络请求**，除非你调用它的方法。`selftest.js` 与 `node --check` 都是纯离线的。

---

## 真机实测补记（2026-11-17，一次性探针会话，测完已删）

| 动作 | 结果 |
|---|---|
| `ls` | 4 个真实会话 |
| `create` | 建会话接口只吃空 body，名字要建完再 PATCH |
| `exec` 单行 | `uid=0`、`nproc=2`、内核 **`6.6.0-72.0.0.76.r1014_62.hce3.aarch64`**（欧拉 ARM！） |
| `exec` 多行 + 子 shell + 退出码 | `exit 5` → `[exit=5]`，stdout/stderr 分离 |
| 截断 | `--timeout 5` 跑 `sleep 20` → 正确标 `truncated`，并提示"别马上重试（会 busy）" |
| busy 退避 | 命中后按 2s 退避重试，退避用完才报错（不假装成功） |
| `info` | **配额 2 核 / 7.8 GiB**、`credit=1.21`、内核会话 `ses_…`、`agent=build` |
| `fs.list` | `files/tree` 的信封解析正确（`/workspace` 下有 `.codeartsdoer`） |
| `put`/`get` | 29 B 与 **264 KiB** 都是字节一致（分块走单条命令没问题） |

### 三个只有真机才会踩到的坑（已修）

1. **`/shell` 不是通用 bash**：
   - **换行会被吞**：`echo a\necho b` 的输出是 `anecho b`；
   - **shell 变量不保留**：`X=1; echo X=$X` 输出 `X=`，连 `f=$(mktemp)` 都拿不到值。
   → 原来的多行包装器必然报 `syntax error near unexpected token '('`。
   **修法**：外层命令改成"零变量、零换行"的 `echo '<b64>' | base64 -d | bash -s`，
   脚本内容 base64 化后由沙箱里的 bash 解码执行 —— 变量、子 shell、引号、退出码全保住。
2. **沙箱在 ≠ 能插命令**：agent 自己也在用同一条 kernel session（串行）。wake 刚发完一轮
   prompt 就去 exec 会连续撞 `Session … is busy`。
   → `exec.probe` 现在要求「有 kernel session **且** 会话不在跑」才算 ready；
   内核见到 `why==='busy'` **不去 wake**（那是白花钱），只等它空下来。
3. **平台会拿首条消息自动改标题**：`create --name wbsbx-probe` 之后 wake 那一轮就变成
   `执行 true 命令并回复 ok`，`exec wbsbx-probe` 直接找不到实例。
   → `create` 把名字记进 store，`execWake` 结束时 best-effort 改回来；**但用 id 永远最稳**。

另外记两条实测数字：`create` 不花 credit 也不建沙箱（沙箱只在真正一轮 agent 时才建）；
`wake` 一轮（"执行 true 并回复 ok"）约 **1.2 credit**，比预估的 0.2 高，批量唤醒要注意。
