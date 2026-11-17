// wbsbx login —— 登录（唯一可能用到浏览器的命令）
//
// 两种登录形态，由驱动决定：
//   ① 浏览器扫描（默认）：WorkBuddy 扫码 + 存 UA；码道/Qoder 粘 cookie。需要本机能起浏览器。
//   ② 无头登录（--print-only）：驱动实现 auth.device 时可用 —— 打印一个链接，
//      用户在任意设备打开完成授权，CLI 这边轮询拿 token。不需要本地浏览器，
//      SSH / 无 GUI 服务器上也能用。（这套交互借鉴自 codearts2api 的 -print-only
//      与 CangShui/workbuddy-gateway 的「打印链接 + 轮询状态机」。）
const { parse, num } = require('../lib/args');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const { CAP } = require('../lib/platform/contract');
const cfg = require('../lib/config');
const { log } = require('../lib/log');

const USAGE = 'login [--print-only] [--import] [--max-wait <分钟>] [--cookie "<cookie 串>"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 无头登录：打印链接 → 轮询 → 成功/超时。状态机 pending/done/failed/expired/cancelled。 */
async function deviceLogin(p, ctx, opts) {
  const d = p.auth.device;
  const s = await d.start(ctx);
  const timeoutMs = Math.max(1, opts.maxWaitMin) * 60e3;

  console.log(ui.c.bold('='.repeat(60)));
  console.log(ui.c.bold(`  ${p.displayName} 登录（无头模式，不需要本机浏览器）`));
  console.log(ui.c.bold('='.repeat(60)));
  console.log('步骤：');
  console.log('  1. 在任意设备（手机也行）打开下面的链接');
  console.log('  2. 按页面提示完成授权（扫码 / 登录）');
  console.log('  3. 这边会自动收到凭据，无需回到终端操作');
  console.log('');
  console.log(ui.c.bold('  登录链接：'));
  console.log('    ' + s.url);
  console.log('');
  if (s.qr) console.log('  二维码内容与上面这个链接相同（终端里没法画图，直接打开链接即可）\n');
  console.log(ui.c.dim(`等待授权完成（最多 ${opts.maxWaitMin} 分钟，Ctrl-C 取消）…`));

  const started = Date.now();
  let tick = 0;
  for (;;) {
    await sleep(2000);
    tick++;
    let r;
    try {
      r = await d.poll(ctx, s.state);
    } catch (e) {
      log(`轮询出错（继续重试）：${String(e.message).slice(0, 120)}`);
      continue;
    }
    if (r.status === 'done') {
      const desc = typeof d.describe === 'function' ? d.describe(r) : {};
      console.log('');
      console.log(ui.c.green('登录成功'));
      if (desc.account) console.log(`  账号：${desc.account}${desc.uid ? '（' + desc.uid + '）' : ''}`);
      if (r.expiresAt) console.log(`  令牌有效期至：${new Date(r.expiresAt * 1000).toLocaleString('zh-CN')}`);
      if (r.probe) {
        console.log(r.probe.ok
          ? ui.c.green('  实测：这个 token 能打控制面')
          : ui.c.yellow(`  实测：这个 token 打不了控制面（http=${r.probe.status}）—— 控制面仍需浏览器登录`));
      }
      console.log(ui.c.dim('\n下一步：wbsbx doctor  看整体状态；wbsbx ls  列实例'));
      return 0;
    }
    if (r.status === 'failed') {
      console.log(ui.c.red('\n登录失败：') + (r.error || '原因不明'));
      return 1;
    }
    if (Date.now() - started > timeoutMs) {
      console.log(ui.c.yellow('\n登录已超时，请重新执行 wbsbx login --print-only'));
      return 1;
    }
    if (tick % 15 === 0) log(`仍在等待授权…（${Math.round((Date.now() - started) / 1000)}s）`);
  }
}

async function run(argv) {
  const args = parse(argv, {
    flags: ['import', 'print-only', 'device'],
    values: ['max-wait', 'max-min', 'cookie'],
    aliases: { m: 'max-wait' },
  });
  const p = registry.get();
  if (!p.has(CAP.AUTH)) throw new Error(`本平台（${p.displayName}）没有登录态概念`);
  const canDevice = Boolean(p.auth && p.auth.device && typeof p.auth.device.start === 'function');
  if (!canDevice && (!p.auth || typeof p.auth.login !== 'function')) {
    throw new Error(`本平台（${p.displayName}）既没有无头登录（auth.device）也没有 auth.login()`);
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

  // ---- 无头模式（有 auth.device 就是默认路径：不需要本机浏览器）----
  if (canDevice) return deviceLogin(p, ctx, opts);

  // ---- 浏览器 / 粘 cookie ----
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
    '  --print-only           无头登录：打印一个链接，在任意设备打开即可（不需要本机浏览器）',
    '  --import               不弹窗，从已有浏览器 profile 静默导入（已登录时有效）',
    '  -m, --max-wait <分钟>  等待授权上限，默认 20',
    '  --cookie "<串>"        直接粘浏览器里的 Cookie 头（不支持的平台会报错）',
    '',
    '说明:',
    '  登录方式由驱动决定：WorkBuddy 扫码并**连同 User-Agent 一起**存（服务端把会话跟 UA 绑定，',
    '  改一个字符就 401，所以别手改 state.json）；码道/Qoder 粘一串 cookie 就行；MiniMax 是 token。',
    '  --print-only 需要驱动实现了 auth.device（目前 WorkBuddy 有）—— 它借的是 CodeBuddy CLI',
    '  的插件登录接口，换到的是插件 accessToken；这个 token 能不能打沙箱控制面由 probe 实测报告。',
    '  找不到 Edge/Chromium 时用环境变量 WBSBX_BROWSER 指定可执行文件路径。',
    '',
    '退出码:',
    '  0  登录成功（或导入成功）',
    '  1  超时 / 未取得登录态 / 平台不支持',
  ],
};
