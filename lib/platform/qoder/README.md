# qoder —— Qoder（qoder.cn）平台驱动

Qoder 是**云 agent 会话**平台（不是云 IDE）：会话跑在阿里云 ACK 沙箱里，agent 只会一个
`Bash` 工具；控制面是 **event-sourcing**（`/api/v1/remote/sessions/{id}/events`），
数据面是沙箱里的 **HTTP MCP**（JSON-RPC）。所以本驱动把「exec / 文件」全部压在 MCP 上，
**不需要 agent 参与**（实测 0 新增事件、不计 `model_credits`）。

```
浏览器/手机 ──cookie──> qoder.cn (Envoy)
                          ├─ /api/v1/remote/sessions…            会话与事件
                          ├─ /api/v1/remote/system-events/stream 全局状态 SSE
                          └─ /api/v1/remote/preview/grant        ★ 按端口发隧道凭证
                                │  → https://<port>-<cma_session_id>.preview.qoderwork.cn
                                ▼     (/_preview/bootstrap 用 grant 换 cookie)
                            沙箱里的 MCP server :3001
                              initialize → tools/call {name:'bash'|'file_*'|'glob'|'grep'}
```

协议事实全部来自实测报告（2026-11-17），本文只标「实测」的部分才会写成断言。

---

## 1. 能力矩阵

| 能力位 | 实现 | 走什么 | 状态 |
|---|---|---|---|
| `auth` / `auth.browser` | `auth.state/login/ttlDays/alive/logout` | cookie 快照存 `ctx.store` | 实测（cookie only，不绑 UA） |
| `instances.list` | `GET /api/v1/remote/sessions?sort_by=updated_at&offset&limit` | 控制面 | 实测 |
| `instances.get` (`meta`) | `GET …/sessions/{id}` | 控制面 | 实测 |
| `instances.create` | `POST …/sessions`（必须带 `environment_id`）+ 建完用 `POST …/events` 补发 `prompt` | 控制面 | 实测（201） |
| `instances.rename` | `PATCH …/sessions/{id} {title}` → 兜底 `control_request{session_title_changed}`，以 GET 复核 | 控制面 | **未实测**（两条路都试） |
| `instances.remove` | `DELETE …/sessions/{id}`；`--archive` 时先 `POST …/archive`，不认再退回 DELETE | 控制面 | 删除实测（204）／归档未实测 |
| `instances.info` | `exec` 读 `/proc` + cgroup，给「可见 / 配额」两组数；沙箱没起就 `{ready:false}` | MCP | 结构同 WorkBuddy，cgroup 字段**未实测** |
| `agent` (`send/stream`) | 发 `user` 事件 + 轮询 `GET …/events?after_sequence_num=` | 控制面 | 实测（发消息 162 ms；事件序列见 §3） |
| `agent.interrupt` | `control_request{subtype:'interrupt'}` | 控制面 | 实测被接受 |
| `agent.question` | **不声明**，`agent.answer` 抛 `E_UNSUPPORTED` | — | 未实现（见 §4） |
| `exec` (`probe/run`) | grant → bootstrap → MCP `initialize` → `tools/call bash` | MCP | **实测**（43 ms 往返，`sleep 40` 同步跑得完） |
| `exec.background` (`start/poll`) | `on_timeout:'background'` → `pid` + `output_file`，`poll` 用 `file_read` 读 + `kill -0` 判活 | MCP | `background` 返回实测；轮询细节未实测 |
| `exec.wake` | 发一条最小消息（`执行 \`true\` 并回复 ok。`）等 `done`，再 probe | 控制面 + MCP | 实测（沙箱懒创建） |
| `fs` (`list/read/write`) | MCP `glob` / `file_read` / `file_write` | MCP | 实测（写→读→grep 全通） |
| `model` | `GET …/environments` 的 `metadata.available_models`（14 个，0.04x–1x） | 控制面 | 实测 |

`limits`：`maxSyncMs: 590000`、`defaultSyncMs: 120000`、`maxBackground: true`
（实测 MCP `bash` 的超时是**默认 120 s / 最大 600 s，没有 30 秒网关硬顶**——这正是它比码道好用的地方）。

---

## 2. 已验证（实测过，可以当契约用）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 鉴权**只用 cookie、不绑 UA**；请求头要 `x-requested-with: XMLHttpRequest`，`/api/v1/remote/*` 还要 `X-Qoder-Remote-Api-Version: 4` | 报告 §2 |
| 2 | 未登录返回干净的 401 JSON：业务接口 `{"errorCode":"Unauthorized"}`，remote 接口 `{"code":"UNAUTHORIZED"}` | 报告 §2 |
| 3 | 会话 CRUD、列表 `{data,has_more}`、删除 **204**、建会话 **201** 且必须带 `environment_id`（否则 `400 MissingSessionTarget`） | 报告 §3.3 |
| 4 | 发用户消息 = `POST …/events` 一条 `event_type:'user'`，`uuid:'controller-user:<uuid>'`、`session_id:''` | 报告 §4.4 |
| 5 | 事件接口**默认倒序**，`after_sequence_num` 增量可用；一回合的真实序列是 `user → status.running → thread_status_running → assistant(tool_use) → user(tool_result) → thread_status_idle → session.usage` | 报告 §4.5 |
| 6 | 一回合约 **0.03 credit**（qfmodel），带工具约 0.11 | 报告 §7 |
| 7 | 控制指令走 `POST …/events` 的 `control_request`（`interrupt` 实测被接受） | 报告 §4.2 |
| 8 | exec 三步：`preview/grant {session_id,port:3001}` → `POST <url>/_preview/bootstrap`（form `grant=`，**303 + cookie**）→ `POST <url>/mcp`（JSON-RPC） | 报告 §5.1 |
| 9 | 隧道 URL 形如 `https://<port>-<cma_session_id>.preview.qoderwork.cn`；grant 是 ES256 JWT，payload 里有 `sid` / `port` / `up.addr`（含 `sandboxes/<sandbox_id>`） | 报告 §5.1 |
| 10 | MCP 里有 **14 个工具**：`bash`/`run_in_terminal`、`container_exec`、`container_up`、`read`/`file_read`、`write`/`file_write`、`edit`/`file_edit`、`glob`/`glob_run`、`grep`/`grep_run`；`serverInfo.version = 0.1.0` | 报告 §5.2 |
| 11 | `bash` 参数：`command`、`timeout`(默认 120/最大 600)、`work_dir`、`env`、`on_timeout:'kill'\|'background'` | 报告 §5.2 |
| 12 | `on_timeout:'background'` 返回 `[backgrounded] pid: 239, output_file:/tmp/tool-outputs/bash_<id>.log`，且后台任务确实继续跑 | 报告 §5.3 |
| 13 | 沙箱**只有在第一次工具调用时才创建**；纯文本回合 `sandbox_runtime_credits=0`，没起时 `preview/grant` → **503 `CloudSandboxNotReady`** | 报告 §0.4 / §5.3 |
| 14 | exec **不写对话**（sequence_num 不涨）、**不计 model_credits**，只延长沙箱存活 | 报告 §5.3 |
| 15 | grant 有效 **30 分钟**；会话内沙箱复用（90 秒空闲后同 sandbox id） | 报告 §5.1 / §6.6.1 |
| 16 | 沙箱池是**异构**的：kvm microVM（385 ms）与 docker 容器（111 ms）混跑，客户端无法选择 | 报告 §6.6 |
| 17 | 模型 14 个，`qfmodel` = Qwen3.8-Flash **0.04x** 最便宜 | 报告 §3.2 |

---

## 3. 未验证 / 明确不做的部分

> 这一节是这份驱动的诚信边界：**没实测过的东西不写成「支持」**。

| 项 | 状态与处理 |
|---|---|
| **`agent.answer`（回答 agent 的提问）** | **未实现，调用直接抛 `E_UNSUPPORTED`**。Qoder 的审批/提问回复走 `control_response`（`{subtype:'success', request_id, response:{outcome:'proceed_once'\|'cancel', allowed, payload}}`，报告 §4.3 只记录了形状），但**提问事件的 `request_id` 从哪来、回复要不要带 `payload.approved`、平台认哪种 outcome，都没实测**。猜一个格式写进去会静默污染会话，比报错糟得多。也不声明 `agent.question` 能力位。临时办法：到网页/APP 里点掉，或 `agent.interrupt` 中断这一轮。 |
| `instances.rename` | 两条路都没单独实测：`PATCH {title}`（会话对象有 `title`，PATCH `{pinned}` 是记录过存在的）与 `control_request{session_title_changed}`（报告 §4.2）。代码两条都试，**以「重新 GET 一眼标题变没变」为准**，都失败就抛 `E_RENAME` 并把两条错误一起给出。 |
| `instances.info` 的 cgroup 读数 | `cpu.max` / `memory.max` / `cpu.cfs_*` / `memory.limit_in_bytes` 这套读法在 Qoder 沙箱里**没实测**（报告里的 4 vCPU / 7940 MB 是 `nproc` 与 `free` 级的观测）。所以两份数字分开给：`visible`（`nproc`/`MemTotal`/`df /`）与 `quota`（cgroup），字段缺失就 `null`，不拿估算值凑。 |
| `exec.start` / `exec.poll` 的轮询 | `background` 返回 `pid`+`output_file` 是实测的；但「`file_read` 读 output_file + `kill -0` 判活」这条闭环没有真跑过。实现方式保守：拿不到 pid 就当还活着（宁可多等一轮也不误报完成），输出文件还没建出来时按「暂无输出」处理。 |
| `exec.put` 二进制分支 | 文本走 `file_write`（实测过）；二进制走 **base64 分块 + `base64 -d`**（每块 192 KiB，上限 16 MiB）**未实测**。文件系统是 rclone WebDAV（只读上传目录 + `/mnt/session/outputs` 可写），`chmod` 无效、`mmap` 写不支持，所以没走「直写挂载」这条路。 |
| `exec.get` 的 base64 分支 | 文本走 `file_read`（实测过）；`--binary` 走 `base64 -w0` **未实测**。 |
| `agent.stream` 的收尾 | 实现依据是实测事件序列：`thread_status_idle`（stop_reason=end_turn）后紧接一条 `session.usage`。所以 `done` **不立刻 yield**，而是先把尾巴排空（最多 3 轮 ×300 ms）再收尾，否则下一轮会把旧 `usage` 当成新回合花费。真回合还没跑过。 |
| `/system-events/stream` | 只实现成可选旁路（`agent.systemEvents` / `stream(..., {systemEvents:true})`），用来「早点知道 idle」；内容永远以轮询事件为准。事件负载形状只确认了 `event: system_event`，**未实测**。 |
| `POST /remote/files`（multipart 上传）、`artifacts/presign` | 未接。`fs` 走 MCP 已经够用，少一条协议少一处坏点。 |
| `container_exec` / `container_up` | 只用 `bash` 与 `file_*`/`glob`；`container_*` 只有工具 schema，没实测效果。 |
| 沙箱回收 TTL / 空闲多久被回收 | 未验（报告 §11）。已知 90 秒空闲后隧道仍可用、sandbox id 不变。 |
| 权限模式对 MCP 通道的约束 | 未验。**实测 MCP 通道在 `permission_mode=default` 下直接放行** —— 也就是说这个通道**不受会话权限模式约束**，等于沙箱内 root 任意执行。风险由使用者承担（见 DISCLAIMER）。 |

另外两个已知的**平台侧**坑，写在这里免得当成驱动的 bug：

- 沙箱池混着两代（kvm / docker），首包延迟 111 ms 与 385 ms 差 3.5 倍。默认超时按 120 s 起，够用但别拿 100 ms 当基准。
- 模型有时**只回文字不调工具**（10 次里 1 次），沙箱因此不会创建 —— 这就是 `exec.wake` 默认给两轮、第二轮换更强制措辞的原因。

---

## 4. 怎么用真账号跑

前提：Node 18+（用全局 `fetch`），**不需要任何依赖**，不需要浏览器（cookie 可以手粘）。

### 4.1 拿 cookie

在浏览器里登录 `https://qoder.cn`，DevTools → Network → 任意 `/api/v1/me` 请求 →
复制请求头里的整条 `Cookie`（`acw_tc`、`qoder_visitor_id` 以及登录后下发的那几条）。
**Cookie 就是全部凭据，不绑 UA**，所以不需要存 UA。

### 4.2 存进驱动

驱动自己不碰文件路径，登录态落在内核给的 `ctx.store`（`$WB_CLOUD_HOME/platform/qoder/auth.json`，0600）：

```bash
cd /path/to/wbsbx
export QODER_COOKIE='acw_tc=...; qoder_visitor_id=...; <session cookie>=...'

node -e "
const reg = require('./lib/platform');
const p = reg.use('qoder');
const ctx = reg.context(p);
p.auth.login(ctx, { cookie: process.env.QODER_COOKIE })
  .then(r => console.log('登录成功：', r.user))
  .catch(e => { console.error(e.message); process.exit(1); });
"
```

`login` 会立刻 `GET /api/v1/me` 验一次；验不过就把快照删掉并抛 `E_AUTH`，不会留下一个假登录态。

> 也可以传数组：`{ cookies: [{name,value,domain,path,expires}] }`（浏览器导出的形状），
> 或由内核注入 `ctx.browser.cookies()` —— 这就是声明 `auth.browser` 的用途。
> **驱动自己不起浏览器**（不引 playwright，也不 require 内核模块）。

### 4.3 看状态、列会话

```bash
node -e "
const reg = require('./lib/platform');
const p = reg.use('qoder'), ctx = reg.context(p);
(async () => {
  console.log(await p.auth.state(ctx));                       // token 只是指纹，不含 cookie
  console.table((await p.instances.list(ctx)).map(({ raw, ...x }) => x));
})();
"
```

### 4.4 唤醒 + 免 LLM exec（推荐路径）

```bash
export SID=qs_xxxxxxxxxxxxxxxxxxxx

node -e "
const reg = require('./lib/platform');
const p = reg.use('qoder'), ctx = reg.context(p);
const sid = process.env.SID;
(async () => {
  console.log('probe:', await p.exec.probe(ctx, sid));       // ready=false 就是沙箱还没起
  console.log('wake :', await p.exec.wake(ctx, sid));        // 发一条最小消息把沙箱拉起来
  const r = await p.exec.run(ctx, sid, { command: 'id; uname -r; nproc', timeout: 60 });
  console.log({ out: r.out, err: r.err, code: r.code, ms: r.ms });
})();
"
```

`exec.run` 的命令外面套了一层壳（stderr 先落临时文件、末尾打 `__WBSBX_CODE__<n>`），
所以 `out` / `err` / `code` 三段分得开。**`err` 是命令跑完才一起回来的，不是实时流**。

后台任务：

```bash
node -e "
const reg = require('./lib/platform');
const p = reg.use('qoder'), ctx = reg.context(p);
const sid = process.env.SID;
(async () => {
  const job = await p.exec.start(ctx, sid, { command: 'for i in \$(seq 1 30); do echo \$i; sleep 1; done' });
  console.log(job);                                          // {jobId:'239', outputPath:'/tmp/tool-outputs/…'}
  for (;;) {
    const s = await p.exec.poll(ctx, sid, { jobId: job.jobId });
    if (s.done) { console.log('done code=', s.code, '\n' + s.out); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
})();
"
```

### 4.5 对话：发一条消息并看归一化事件

```bash
node -e "
const reg = require('./lib/platform');
const p = reg.use('qoder'), ctx = reg.context(p);
const sid = process.env.SID;
(async () => {
  for await (const ev of p.agent.stream(ctx, sid, { text: '用一句话介绍你自己' })) {
    if (ev.kind === 'text') process.stdout.write(ev.data.text);
    else if (ev.kind === 'thinking') console.error('[think]', ev.data.text);
    else if (ev.kind === 'usage') console.error('\n[usage]', ev.data);
    else if (ev.kind === 'done') break;
  }
})();
"
```

### 4.6 建 / 改名 / 删

```bash
node -e "
const reg = require('./lib/platform');
const p = reg.use('qoder'), ctx = reg.context(p);
(async () => {
  const inst = await p.instances.create(ctx, { name: 'wbsbx 试验' });   // model 默认 qfmodel（0.04x）
  console.log(inst.id);
  console.log(await p.instances.rename(ctx, inst.id, '改个名'));        // via: patch | control_request
  console.log(await p.instances.remove(ctx, inst.id));                 // DELETE，204 也算成功
})();
"
```

### 4.7 成本提醒

- `exec` 不计 `model_credits`，但会**延长沙箱存活** → 照样产生 `sandbox_runtime_credits`。
  长期挂着不如按需 `wake`。
- 一回合纯问答约 0.04 credit（qfmodel）、带一次工具约 0.11 credit（实测）。
- `exec.wake` 会真的发一条消息，所以**会**留下对话记录并计一次模型费用（最小回合 0.03）。

---

## 5. 协议速查

### 5.1 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/me` | 账号（登录态是否有效） |
| GET | `/api/v1/remote/environments?limit=100` | 环境 + `metadata.available_models` |
| GET | `/api/v1/remote/sessions?sort_by=updated_at&offset&limit` | 会话列表 `{data,has_more}` |
| POST | `/api/v1/remote/sessions` | 建会话（`title, origin:'web', environment_id, session_context{model,work_mode}`）→ 201 |
| GET/PATCH/DELETE | `/api/v1/remote/sessions/{id}` | 详情 / 改（`{pinned}` 已确认存在）/ 删（204） |
| GET | `/api/v1/remote/sessions/{id}/events?limit&offset&after_sequence_num` | 拉事件（**默认倒序**） |
| POST | `/api/v1/remote/sessions/{id}/events` | 发用户消息 / 控制指令 |
| GET | `/api/v1/remote/system-events/stream` | 全局状态 SSE（`event: system_event`） |
| POST | `/api/v1/remote/preview/grant` | `{session_id, port}` → `{url, grant, expires_at}` |

### 5.2 事件类型 → 归一化

| event_type / 结构 | 归一化 kind |
|---|---|
| `worker.status.changed` / `session.thread_status_*` / `stream_event(session.status_*)` | `status` |
| `assistant` 的 `text` 块 | `text` |
| `assistant` 的 `reasoning` 块 | `thinking` |
| `assistant` 的 `tool_use` 块 | `tool` |
| `user` 的 `tool_result` 块（★ 工具结果伪装成 user 事件） | `tool_result` |
| `session.usage`（`model_credits`/`sandbox_runtime_credits`/`total_credits`） | `usage` |
| `session.thread_status_idle` / `assistant stop_reason=end_turn` | `done` |
| `sandbox.boot_progress`、`available_*_update`、其它 `stream_event`… | `raw` |

### 5.3 隧道与 MCP

```jsonc
// 1) POST /api/v1/remote/preview/grant
{"session_id":"qs_…","port":3001}
// → {"url":"https://3001-<cma_session_id>.preview.qoderwork.cn","grant":"<ES256 JWT>","expires_at":"…"}

// 2) POST <url>/_preview/bootstrap   (form-urlencoded)
grant=<JWT>
// → 303 + Set-Cookie（约 624 字节，30 分钟）

// 3) POST <url>/mcp
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"wbsbx","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"bash","arguments":{"command":"id","timeout":120,"on_timeout":"kill"}}}
// → result.content[].text
```

实现上的三件事：
1. **隧道缓存**：`grant + cookie` 存进 `ctx.store` 的 `tunnel_<session_id>`，到期前 60 秒才重取；
   `initialize` **每个隧道只做一次**（规范也要求后续请求回带 `Mcp-Session-Id`，所以服务端下发了就记住）。
2. **cookie 过期自动重试一次**：MCP 回 401/403 就清隧道、重取 grant、再调一次。
3. **响应两种都接**：`application/json` 直接解，`text/event-stream` 走 SSE 帧解析挑对应 `id`。

---

## 6. 实现要点（读代码前先看这几条）

- **内核调用约定**（对齐 `lib/platform/exec.js` / `target.js` / `commands/*`）：
  `exec.run` 收 `{command, timeoutMs, cwd, env}`（毫秒），`exec.start` 收 `{command, cwd, env}`，
  `exec.poll` 第二参既可以是 `{jobId}` 也可以是 `start` 返回的**整个 job 对象**，
  `exec.probe` 未就绪时要给 `why`（编排层读这个字段读），
  `instances.create(ctx, {name, model, prompt}, {log})` 用 `prompt` 补发首条消息，
  `instances.remove(ctx, id, {archive})` 支持 `--archive`，
  `doctor.checks(ctx, {net:false})` 必须一个请求都不发。这些都有对应的离线用例。
- **游标**：发消息时用 `POST /events` 返回的 `sequence_num` 当起点，之后每次 `after_sequence_num=<cursor>` 增量取。
  所以绝不会把历史当本轮重放；游标另外落盘（`cursor_<session_id>`），进程重启还能接着数。
- **倒序陷阱**：事件接口默认倒序，每页都要按 `sequence_num` 重排再判 `> cursor`，否则 `has_more` 分页会乱。
- **done 的尾巴**：见 §3 的说明。`done` 一定最后一条 yield，`usage` 在它前面。
- **沙箱懒创建**：`exec.probe` 只是 `preview/grant` 是否 200。503 `CloudSandboxNotReady` → `E_NOT_READY`，
  由 `exec.wake` 发消息解决；503 `catalog_unavailable` → 那是端口策略（49983 这类核心端口不给隧道），换端口也没用。
- **两代沙箱**：`instances.info` 里的 `virt` 可能是 `kvm` 也可能是 `docker`，都不该假设；
  `boot_id`/`uptime` 才是判断「是不是同一个沙箱」的锚点，`/dev/vda` 不保证存在。
- **不假设 UA**：cookie 就是全部，UA 随便（实测 `curl/8.5.0` 也 200）。这一点与 WorkBuddy 相反。
- **401 的语义**：直接抛 `AuthError`（`code=E_AUTH`），让内核提示「去 login」，而不是让人去查网络。

---

## 7. 文件

| 文件 | 内容 |
|---|---|
| `index.js` | provider 定义：auth / instances / agent / exec / fs / model / doctor，网络层可整体注入 |
| `wire.js` | 全部纯函数：事件映射、JWT 解析、隧道 URL、cgroup 解析、包装脚本、SSE 帧（不碰网络/磁盘） |
| `http.js` | 传输层：cookie jar、`x-requested-with`、`X-Qoder-Remote-Api-Version: 4`、401 → `AuthError`、SSE |
| `mcp.js` | 隧道三步 + MCP JSON-RPC + 缓存与重试 |
| `selftest.js` | **纯离线**自测：假事件数组 + 假 MCP 响应 + 假 fetch，46 项 |
| `README.md` | 本文 |

```bash
node lib/platform/qoder/selftest.js     # 不联网、无凭据，最后打印 ✓/✗ 并退出 0/1
```

---

## 8. 风险

- `preview/grant` + 沙箱 MCP **不是对外公开 API**，平台随时可能收紧（尤其「按端口任意转发」这点）。
- MCP `bash` 在沙箱里是 **root 任意执行**，且**不受会话权限模式约束**（实测 `default` 下直接放行）。
  只用自己账号、自己的会话；不跨账号、不提权。
- 计费按 credit 倍率 + 沙箱时长，`exec` 不涨 `model_credits` 但会延长沙箱存活。

与仓库 `DISCLAIMER.md` 的口径一致：**非官方用法，风险自负。**
