// 「弹一个浏览器，让用户自己登录，然后把登录态抓回来」——驱动共用的那一小段。
//
// 只依赖可选的 playwright-core（lib/browser.js 负责找到它和浏览器）：
//   · 有 playwright → 起系统已装的 Edge/Chrome，打开登录页，用户手动登；
//   · 没有 → 抛 E_NO_BROWSER，命令层会改成「让用户粘 cookie」。
//
// 为什么要抓 cookie 而不是 document.cookie：会话 cookie 基本都带 HttpOnly，
// 页面 JS 看不见；而 context.cookies() 走的是浏览器内部，能拿到全部（含 HttpOnly）。
const browser = require('../browser');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读一次当前登录态：{ cookies, storage }（storage 是 localStorage 的字符串快照） */
async function snapshot(ctx, page) {
  const cookies = await ctx.cookies().catch(() => []);
  let storage = {};
  try {
    storage = await page.evaluate(() => {
      const out = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
      } catch { /* 有些页面禁 localStorage */ }
      return out;
    });
  } catch { /* 页面还在跳转 */ }
  return { cookies, storage };
}

/**
 * 打开登录页，等 ready(state) 为真。
 * @param {object} o
 * @param {string} o.url           登录页
 * @param {(s:{cookies:Array,storage:object})=>boolean} o.ready
 * @param {number} [o.timeoutMs]   默认 20 分钟
 * @param {boolean} [o.headless]
 * @param {Function} [o.log]
 * @returns {Promise<{cookies:Array, storage:object, waited:number}>}
 */
async function loginAndCapture({ url, ready, timeoutMs = 20 * 60e3, pollMs = 1500, headless = false, log = () => {} }) {
  if (!browser.hasPlaywright || !browser.hasPlaywright()) {
    const e = new Error('这台机器没有 playwright-core，不能弹浏览器');
    e.code = 'E_NO_BROWSER';
    throw e;
  }
  const { browser: b, ctx } = await browser.launchEphemeral({ headless });
  try {
    const page = await ctx.newPage();
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { /* 跳转/超时都继续轮询 */ }
    const t0 = Date.now();
    for (;;) {
      const st = await snapshot(ctx, page);
      if (ready(st)) return { ...st, waited: Date.now() - t0 };
      if (Date.now() - t0 > timeoutMs) {
        const e = new Error(`等登录超时（${Math.round(timeoutMs / 60000)} 分钟）`);
        e.code = 'E_LOGIN_TIMEOUT';
        throw e;
      }
      await sleep(pollMs);
      if (Math.round((Date.now() - t0) / pollMs) % 40 === 0) log('还在等你在浏览器里登录…');
    }
  } finally {
    try { await b.close(); } catch { /* 关不掉就算了 */ }
  }
}

module.exports = { loginAndCapture, snapshot };
