// wbsbx login —— 登录（唯一可能用到浏览器的命令）
//
// 内核只做一件事：把选项交给 provider.auth.login()，把结果讲清楚。
// 「入口 URL 是哪个、探活端点打哪、要不要存 UA」这些平台知识都在驱动里
// （WorkBuddy 还必须存 UA —— 服务端把会话跟 UA 逐字节绑定，改一个字符就 401）。
const { parse, num } = require('../lib/args');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const { CAP } = require('../lib/platform/contract');
const cfg = require('../lib/config');
const { log } = require('../lib/log');

const USAGE = 'login [--import] [--max-wait <分钟>] [--cookie "<cookie 串>"]';

async function run(argv) {
  const args = parse(argv, { flags: ['import'], values: ['max-wait', 'max-min', 'cookie'], aliases: { m: 'max-wait' } });
  const p = registry.get();
  if (!p.has(CAP.AUTH)) throw new Error(`本平台（${p.displayName}）没有登录态概念`);
  if (!p.auth || typeof p.auth.login !== 'function') {
    throw new Error(`本平台（${p.displayName}）没有实现 auth.login()`);
  }

  const ctx = registry.context(p);
  ctx.log = (m) => log(m);

  const opts = {
    importOnly: !!args.opts.import,
    maxWaitMin: num(args.opts['max-wait'] || args.opts['max-min'], Number(process.env.LOGIN_MAX_MIN) || 20),
  };
  if (args.opts.cookie) opts.cookie = String(args.opts.cookie);

  process.on('unhandledRejection', (e) => log('warn ' + String(e).slice(0, 160)));
  process.on('uncaughtException', (e) => log('warn ' + String(e).slice(0, 160)));

  const r = await p.auth.login(ctx, opts);
  if (r && r.ok) {
    const bits = [];
    if (r.user && r.user.name) bits.push('账号 ' + r.user.name);
    if (r.cookieCount) bits.push(r.cookieCount + ' 条 cookie');
    if (r.ttlDays != null) bits.push('还能用 ' + Number(r.ttlDays).toFixed(1) + ' 天');
    console.log(ui.c.green('OK') + ' 已登录' + (bits.length ? '（' + bits.join(' · ') + '）' : ''));
    console.log(ui.c.dim('登录态：' + cfg.PATHS.state + '（别手改：WorkBuddy 的 UA 是绑定的一部分）'));
    return 0;
  }
  console.log(ui.c.yellow('未登录') + (r && r.reason ? '：' + r.reason : ''));
  if (r && r.hint) console.log(ui.c.dim(r.hint));
  return 1;
}

module.exports = {
  run,
  usage: USAGE,
  help: [
    '选项:',
    '  --import               不弹窗，从已有浏览器 profile 静默导入（已登录时有效）',
    '  -m, --max-wait <分钟>  扫码等待上限，默认 20',
    '  --cookie "<串>"        直接粘浏览器里的 Cookie 头（不支持的平台会报错）',
    '',
    '说明:',
    '  登录方式由驱动决定：WorkBuddy 扫码并**连同 User-Agent 一起**存（服务端把会话跟 UA 绑定，',
    '  改一个字符就 401，所以别手改 state.json）；码道/Qoder 粘一串 cookie 就行；MiniMax 是 token。',
    '  找不到 Edge/Chromium 时用环境变量 WBSBX_BROWSER 指定可执行文件路径。',
    '',
    '退出码:',
    '  0  登录成功（或导入成功）',
    '  1  超时 / 未取得登录态',
  ],
};
