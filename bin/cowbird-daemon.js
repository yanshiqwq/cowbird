#!/usr/bin/env node
// cowbird-daemon —— 常驻侧：维护登录态、续 token、给实例保活，并把凭据通过 HTTP 发给客户端。
//
// 它自己不提供任何「操作实例」的能力，只做三件长期没人做就会断的事：
//   ① 定期 exec 一下目标实例（这就是「保活」，平台看到访问才不会回收）
//   ② 在 token 到期前刷新（纯 HTTP，很便宜）
//   ③ cookie 快满 7 天时走 SSO 静默续期（需要浏览器，可选）
//
// 跑法：
//   cowbird-daemon                       前台跑，Ctrl-C 停
//   cowbird daemon start --detach        后台起（CLI 帮你拉起）
//   docker run -v ./data:/data ...     见仓库里的 Dockerfile
process.env.COWBIRD_LOCAL = '1';        // ★ 必须最先设：daemon 永远读本地凭据，不去请求自己

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = require('../lib/config');
const { LogStore } = require('../lib/daemon/logstore');
const { Scheduler } = require('../lib/daemon/scheduler');
const { createServer } = require('../lib/daemon/server');

const VERSION = require('../package.json').version;

function parseArgs(argv) {
  const o = { host: null, port: null, token: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') o.host = argv[++i];
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--token') o.token = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') { o.help = true; }
  }
  return o;
}

function ensureToken(explicit) {
  if (explicit) return explicit;
  const c = cfg.readConfig();
  if (c.daemon.token) return c.daemon.token;
  const t = crypto.randomBytes(24).toString('hex');
  cfg.writeConfig({ daemon: { token: t } });
  return t;
}

function isLoopbackHost(h) {
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`cowbird-daemon ${VERSION}

用法: cowbird-daemon [--host 127.0.0.1] [--port 8787] [--token <令牌>] [--quiet]

配置（$COWBIRD_HOME/cowbird.json）:
  heal.targets[]      要保活的实例 [{ "id": "2123456789012345678", "name": "work-01" }]
  heal.intervalMs     保活周期，默认 600000（10 分钟）
  refresh.intervalMs  刷新 token 周期，默认 21600000（6 小时）
  renew.enabled       是否走 SSO 续登录态（需要 playwright-core），默认 false

接口:
  GET  /health            健康检查（无鉴权）
  GET  /api/status        状态 + 最近各轮结果
  GET  /api/state         登录态（cookie + UA）
  PUT  /api/state         推入新登录态（供另一台机器 login 后同步）
  GET  /api/token/:id     E2B 访问凭据
  POST /api/heal          立即保活一轮
  POST /api/refresh       立即刷 token
  POST /api/renew         立即续登录态
  PUT  /api/targets       设置保活目标
  GET  /api/logs          最近日志`);
    return 0;
  }

  cfg.ensureDirs();
  const c = cfg.readConfig();
  const host = args.host || c.http.host || '127.0.0.1';
  const port = args.port || c.http.port || 8787;
  const token = ensureToken(args.token);

  // 监听公网却没令牌 = 把整份登录态挂在门口。宁可不启动。
  if (!isLoopbackHost(host) && !token) {
    console.error('拒绝启动：监听 ' + host + ' 时必须配置令牌（--token 或 cowbird.json 的 daemon.token）');
    return 2;
  }

  const logstore = new LogStore(path.join(cfg.PATHS.logs, 'daemon.log'));
  const log = (msg, extra) => {
    const line = logstore.push('daemon', msg, extra);
    if (!args.quiet) console.log(line);
  };

  log(`cowbird-daemon ${VERSION} 启动 · ${host}:${port} · 数据目录 ${cfg.HOME}`);
  if (cfg.HOME_INFO.source === 'legacy ~/.workbuddy/wb-cloud') {
    log('沿用旧数据目录（~/.workbuddy/wb-cloud）。想换到 ~/.cowbird 就把 state.json 和 tokens/ 拷过去');
  }

  const scheduler = new Scheduler({ log });
  const server = createServer({ scheduler, log, logstore, token });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  log(`接口就绪 http://${host}:${port}` + (token ? '（需要 Bearer 令牌）' : '（本机免令牌）'));

  try { fs.writeFileSync(cfg.PATHS.daemonPid, String(process.pid)); } catch {}
  scheduler.start();

  // 启动先跑一轮：容器重启后立刻确认三个实例还在，别等 10 分钟
  scheduler.healNow().catch((e) => log('首轮保活异常：' + e.message));

  const shutdown = (sig) => {
    log(`收到 ${sig}，正在退出`);
    scheduler.stop();
    try { fs.unlinkSync(cfg.PATHS.daemonPid); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (e) => log('未处理的 Promise 异常：' + String((e && e.message) || e)));
  process.on('uncaughtException', (e) => log('未捕获异常：' + String((e && e.message) || e)));

  return new Promise(() => {});   // 常驻
}

main()
  .then((code) => { if (code !== undefined) process.exit(code || 0); })
  .catch((e) => {
    console.error('daemon 启动失败：' + String((e && e.message) || e));
    if (process.env.COWBIRD_DEBUG) console.error(e.stack);
    process.exit(1);
  });
