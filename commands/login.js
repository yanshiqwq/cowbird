// wbsbx login —— 唯一还需要浏览器的命令：扫码/短信登录个人号，把 cookie 和 **UA** 一起存下来
// 入口必须是 platform=agents（admin 是企业控制台，个人号会报"没有企业"）
//
// 存 UA 是必须的：服务端把会话跟 UA 精确绑定（改一个字符就 401），
// 之后所有接口都靠 lib/session.js 拿这份 cookie + UA 走纯 HTTP，不再开浏览器。
//
// 两种模式：
//   默认        开可见窗口，等扫码
//   --import    不开窗口，直接看现有 profile 还登录着没有，登录着就静默导入（不扫码）
const { parse, num } = require('../lib/args');
const cfg = require('../lib/config');
const browser = require('../lib/browser');
const session = require('../lib/session');
const creds = require('../lib/creds');
const { log } = require('../lib/log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROBE = '/console/as/conversations/?page=1&pageSize=1';

async function grab(ctx, page) {
  const st = await session.fromBrowser(ctx, page);
  log('LOGIN_OK cookies=' + st.cookies.map((x) => x.name).join(',') + ' ua=' + st.ua.slice(0, 40) + '…');
  const d = session.ttlDays(st.cookies);
  if (d !== null) log(`凭据还能用 ${d.toFixed(1)} 天`);
  // daemon 在跑就把新登录态推过去，否则它会一直用旧 cookie 打接口（表现为「本机好了，后台还是 401」）
  const pushed = await creds.publishLoginState(st);
  if (pushed.pushed) log('已同步给 daemon');
  else if (pushed.reason && pushed.reason !== 'local-mode') log('没同步给 daemon：' + String(pushed.reason).slice(0, 80));
  return st;
}

async function run(argv) {
  const args = parse(argv, { flags: ['import'], values: ['max-min'], aliases: { m: 'max-min' } });
  const IMPORT = !!args.opts.import;
  const MAX_MIN = num(args.opts['max-min'], Number(process.env.LOGIN_MAX_MIN) || 20);

  process.on('unhandledRejection', (e) => log('warn ' + String(e).slice(0, 160)));
  process.on('uncaughtException', (e) => log('warn ' + String(e).slice(0, 160)));

  const { ctx, page } = await browser.openPage({ headless: IMPORT });
  ctx.on('close', () => log('浏览器已关闭'));
  if (!IMPORT) { try { await page.bringToFront(); } catch {} }

  try { await page.goto(IMPORT ? cfg.AGENTS_URL : cfg.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
  catch (e) { log('打开页面失败 ' + e.message.slice(0, 100)); }

  // 先探一次：profile 里本来就有登录态的话，--import 直接收工
  const first = await browser.api(page, PROBE).catch(() => ({ s: -1 }));
  if (first.s === 200) {
    log('现有 profile 已登录，直接导入');
    await grab(ctx, page);
    await sleep(300);
    try { await ctx.close(); } catch {}
    return 0;
  }
  if (IMPORT) {
    log(`profile 里没有有效登录态（http=${first.s}）。要扫码请跑 wbsbx login（不带 --import）`);
    try { await ctx.close(); } catch {}
    return 1;
  }

  log('OPENED 请扫码 / 短信登录（个人号入口 platform=agents）');
  const deadline = Date.now() + MAX_MIN * 60 * 1000;
  let tick = 0;
  while (Date.now() < deadline) {
    tick++;
    await sleep(3000);
    const r = await browser.api(page, PROBE).catch(() => ({ s: -1 }));
    if (r.s === 200) {
      await grab(ctx, page);
      await sleep(600);
      try { await ctx.close(); } catch {}
      return 0;
    }
    if (tick % 5 === 0) log(`等待中 http=${r.s}`);
  }
  log('超时未登录（profile 保留，重跑 wbsbx login 即可继续）');
  try { await ctx.close(); } catch {}
  return 1;
}

module.exports = { run, usage: 'login [--import] [--max-min 20]' };
