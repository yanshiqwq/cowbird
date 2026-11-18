# cowbird

[![CI](https://github.com/yanshiqwq/cowbird/actions/workflows/ci.yml/badge.svg)](https://github.com/yanshiqwq/cowbird/actions/workflows/ci.yml)

> 用的是各平台的网页接口，**可能违反其服务条款**，风险自负 → [DISCLAIMER.md](DISCLAIMER.md)

把各家网页 agent 自带的沙箱，包成一套 `ls / exec / cp / daemon` 的命令行工具。名字来自**牛鹂**：自己不筑巢，把蛋下在别人的巢里。

| 平台 | 执行通道 | 登录方式 |
|---|---|---|
| WorkBuddy | E2B `envd` | 打印链接 + 轮询，不需要浏览器 |
| 码道 CodeArts | 内核 `/9800/shell` | 弹浏览器手动登录，或粘 cookie |
| Qoder | 沙箱 MCP | 弹浏览器手动登录，或粘 cookie |
| MiniMax | 无执行通道（只读） | 弹浏览器取 token，或粘 token |
| TRAE | 沙箱 MCP（一条命令一轮） | 弹浏览器手动登录，或粘 cookie |

## 安装

```bash
git clone https://github.com/yanshiqwq/cowbird.git
cd cowbird
node bin/cowbird.js --help      # 直接用
npm link                        # 或 npm i -g . 当成全局命令
```

GitHub Packages（私有/测试发布，装的时候要一个带 `read:packages` 的 PAT）：

```bash
npm login --scope=@yanshiqwq --registry=https://npm.pkg.github.com
npm i -g @yanshiqwq/cow-bird
```

容器：`docker compose up -d`（先在宿主机跑一次 `cowbird login`，把 `./data` 挂进容器）。

要求 **Node ≥ 20**。弹浏览器要可选依赖 `npm i playwright-core`；**不装也不影响使用**——登录会改成让你粘一串。

## 五分钟

```bash
cowbird login                    # 弹浏览器登录；没 playwright 就提示你粘一串
cowbird ls                       # 有哪些沙箱
cowbird exec work-01 "uname -a"  # 在沙箱里跑命令
cowbird daemon start --detach    # 让它们别被回收
cowbird daemon targets add work-01
```

同一个平台挂第二个账号：`cowbird login --as alt`，之后用 `workbuddy:alt/work-01` 引用；
换账号是换目录（`platform/<平台>/accounts/<账号>/`），不是改配置。

## 命令

| 命令 | 干什么 |
|---|---|
| `ls` / `create` / `rm` / `rename` | 列、建、删、改名 |
| `exec` / `put` / `get` | 跑命令、传文件 |
| `prompt` / `watch` / `history` / `answer` | 发消息、看流、拉历史、答提问 |
| `info` / `doctor` | 单个实例详情、体检 |
| `account` / `platform` / `login` | 账号、平台能力矩阵、登录 |
| `daemon` | 保活守护进程（start/stop/status/targets/logs/install…） |

`cowbird <命令> --help` 看具体用法；`cowbird --help` 看全局开关
（`--platform` / `--channel` / `--account` / `--json` 等）。

## 登录

按顺序挑一条：

1. **弹浏览器**（默认）：`cowbird login` 起一个临时 profile 的 Edge/Chrome，你在窗口里登完，它自动把 cookie（含 HttpOnly）抓回来。要 `playwright-core`。
2. **粘一串**：`cowbird login --cookie "<串>"`，或没装 playwright 时它当场问你。cookie 从 DevTools → Network → 任一请求 → **Copy as cURL** 里取；MiniMax 粘的是 `localStorage._token`。
3. **链接授权**：WorkBuddy 专用，`cowbird login` 打印链接，在微信/浏览器里打开即可。

## daemon

```bash
cowbird daemon start --detach          # 后台起
cowbird daemon targets add work-01     # 加一个要保活的
cowbird daemon status                  # 看它在不在干活
cowbird daemon logs -n 50              # 最近日志
cowbird daemon install --systemd       # 生成 unit（Linux）/ 计划任务（Windows）
```

它是**只读凭据**的：只从磁盘读登录态，不通过 HTTP 转发凭据。HTTP 接口见
[docs/architecture.md](docs/architecture.md)。

## 已知限制

- 各平台都有"没真机验证"的角落，逐条列在 `lib/platform/<平台>/README.md` 的「未验证」表里，用之前扫一眼。
- 实例 id 超过 2^53，**一律当字符串写**，写成 JSON 数字会被静默舍入成"实例不存在"。
- `nproc` 读的是 cpuset 不是配额，共享宿主上会虚高；`cowbird info` 把配额/可见/nproc 分三行给。
- E2B 成功时 end 帧不带 `exitCode`：见到 end 没写退出码就是 0。
- 退出码：`0` 成功、`1` 执行失败、`2` 平台没有这个能力。

## 文档

- [docs/architecture.md](docs/architecture.md) —— 分层、daemon、数据目录
- [docs/providers.md](docs/providers.md) —— provider 契约与各平台能力对照
- [docs/protocol.md](docs/protocol.md) —— WorkBuddy 的接口细节
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT，见 [LICENSE](LICENSE)。非任何平台的官方客户端。
