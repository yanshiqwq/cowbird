// cowbird login —— 登录（唯一可能用到浏览器的命令）
//
// 两种登录形态，由驱动决定：
//   ① 打印链接授权（默认，WorkBuddy）：在微信里打开链接完成授权，不需要浏览器。
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

const USAGE = 'login [--max-wait <分钟>] [--cookie "<cookie 串>"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 无头登录：打印链接 → 轮询 → 成功/超时。状态机 pending/done/failed/expired/cancelled。 */
async function deviceLogin(p, ctx, opts) {
  const d = p.auth.device;
  const s = await d.start(ctx);
  const timeoutMs = Math.max(1, opts.maxWaitMin) * 60e3;
  // 步骤文案由驱动给（不同平台的授权方式不一样：微信授权 / 网页登录 / 短信）
  const steps = Array.isArray(s.steps) && s.steps.length
    ? s.steps
    : ['打开下面的链接', '按页面提示完成授权'];

  console.log(ui.c.bold('='.repeat(60)));
  console.log(ui.c.bold(`  ${p.displayName} 登录`));
  console.log(ui.c.bold('='.repeat(60)));
  console.log('步骤：');
  steps.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log('');
  console.log(ui.c.bold('  登录链接：'));
  console.log('    ' + s.url);
  console.log('');
  console.log(ui.c.dim(`（有效期 ${opts.maxWaitMin} 分钟，Ctrl-C 取消）…`));

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
      if (desc.account) {
        console.log(`  账号：${desc.account}${desc.uid ? '（' + desc.uid + '）' : ''}`);
      }
      if (r.expiresAt) console.log(`  令牌有效期至：${new Date(r.expiresAt * 1000).toLocaleString('zh-CN')}`);
      // 只在"这个 token 打不了控制面"时才出声 —— 正常情况别刷屏
      if (r.probe && !r.probe.ok) {
        console.log(ui.c.yellow(`  注意：这个 token 目前打不了控制面（http=${r.probe.status}）`));
      }
      return 0;
    }
    if (r.status === 'failed') {
      console.log(ui.c.red('\n登录失败：') + (r.error || '原因不明'));
      return 1;
    }
    if (Date.now() - started > timeoutMs) {
      console.log(ui.c.yellow('\n登录已超时，请重新执行 cowbird login --print-only'));
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
    '  -m, --max-wait <分钟>  等待授权的有效期，默认 20',
    '  --cookie "<串>"        粘一串 cookie（只对 cookie 型平台有用，如码道/Qoder）',
    '',
    '说明:',
    '  打印一个链接，在微信里打开并授权，这边自动收到 accessToken。不需要浏览器。',
    '  换账号就是重新跑一次。',
    '',
    '退出码:',
    '  0  登录成功',
    '  1  超时 / 未取得登录态 / 平台不支持',
  ],
};
