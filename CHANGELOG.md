# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。
破坏性变更会标 **BREAKING**。

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
