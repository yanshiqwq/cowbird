// WorkBuddy 的浏览器登录流程（从原 commands/login.js 搬过来，逻辑不变）
//
// 为什么在驱动里：登录流程本身就是平台知识（入口 URL、探活端点、UA 绑定），
// 放在内核里就等于把"WorkBuddy 怎么登录"钉死在命令层。搬进来之后 commands/login.js
// 变成「调 provider.auth.login」的通用壳，别的平台各写各的。
const cfg = require('../../config');
const browser = require('../../browser');
const session = require('../../session');
const creds = require('../../creds');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 用"列一页会话"当登录探针：200 才算真的拿到会话，401/302 都不算
const PROBE = '/console/as/conversations/?page=1&pageSize=1';

/**
 * @param {{importOnly?:boolean, maxWaitMin?:number, log?:(m:string)=>void}} opts
 * @returns {Promise<{ok:boolean, state:object|null, ttlDays:number|null, reason?:string}>}
 */
async function run(opts = {}) {
  const log = opts.log || (() => {});
  const IMPORT = !!opts.importOnly;
  const MAX_MIN = Number(opts.maxWaitMin) > 0 ? Number(opts.maxWaitMin) : (Number(process.env.LOGIN_MAX_MIN) || 20);

  const grab = async (page) => {
    const st = await session.fromBrowser(null, page);
    log('LOGIN_OK cookies=' + st.cookies.map((x) => x.name).join(',') + ' ua=' + st.ua.slice(0, 40) + '…');
    const d = session.ttlDays(st.cookies);
    if (d !== null) log(`凭据还能用 ${d.toFixed(1)} 天`);
    // daemon 在跑就把新登录态推过去，否则它会一直用旧 cookie（表现为「本机好了，后台还是 401」）
    const pushed = await creds.publishLoginState(st);
    if (pushed.pushed) log('已同步给 daemon');
    else if (pushed.reason && pushed.reason !== 'local-mode') log('没同步给 daemon：' + String(pushed.reason).slice(0, 80));
    return { ok: true, state: st, ttlDays: d };
  };

  const { ctx, page } = await browser.openPage({ headless: IMPORT });
  ctx.on('close', () => log('浏览器已关闭'));
  if (!IMPORT) { try { await page.bringToFront(); } catch {} }

  try {
    await page.goto(IMPORT ? cfg.AGENTS_URL : cfg.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    log('打开页面失败 ' + String(e.message).slice(0, 100));
  }

  try {
    // 先探一次：profile 里本来就有登录态的话，--import 直接收工
    const first = await browser.api(page, PROBE).catch(() => ({ s: -1 }));
    if (first.s === 200) {
      log('现有 profile 已登录，直接导入');
      const out = await grab(page);
      await sleep(300);
      return out;
    }
    if (IMPORT) {
      return { ok: false, state: null, ttlDays: null, reason: `profile 里没有有效登录态（http=${first.s}）` };
    }

    log('OPENED 请扫码 / 短信登录（个人号入口 platform=agents）');
    const deadline = Date.now() + MAX_MIN * 60 * 1000;
    let tick = 0;
    while (Date.now() < deadline) {
      tick++;
      await sleep(3000);
      const r = await browser.api(page, PROBE).catch(() => ({ s: -1 }));
      if (r.s === 200) {
        const out = await grab(page);
        await sleep(600);
        return out;
      }
      if (tick % 5 === 0) log(`等待中 http=${r.s}`);
    }
    return { ok: false, state: null, ttlDays: null, reason: '超时未登录（profile 保留，重跑即可继续）' };
  } finally {
    try { await ctx.close(); } catch {}
  }
}

module.exports = { run, PROBE };
