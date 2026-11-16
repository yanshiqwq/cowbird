// 浏览器侧：登录态（Edge profile）+ 在页面里发 cookie 请求
// 只有「登录 / 列会话 / 建会话 / 刷新凭据」这些走网页接口的动作需要浏览器；
// exec / put / get / history / watch 只用 token，不需要 playwright。
const path = require('path');
const fs = require('fs');
const cfg = require('./config');

let _pw = null;
function pw() {
  if (_pw) return _pw;
  const tries = [
    // 显式指定：容器/服务器上常常把 playwright-core 装在镜像里某个固定路径，
    // 既不在项目 node_modules 也不在 NODE_PATH，只能靠环境变量告诉它。
    () => {
      if (!process.env.WBSBX_PW_MODULE) throw new Error('（未设置 WBSBX_PW_MODULE）');
      return require(process.env.WBSBX_PW_MODULE);
    },
    () => require('playwright-core'),
    () => require(path.join(cfg.HOME, 'node_modules', 'playwright-core')),   // 旧 skill 布局
  ];
  const errs = [];
  for (const t of tries) {
    try { _pw = t(); return _pw; } catch (e) { errs.push(e.message.split('\n')[0]); }
  }
  throw new Error(
    '找不到 playwright-core。装一份（npm i playwright-core），或用 WBSBX_PW_MODULE 指向已有的副本\n  ' +
    errs.join('\n  ')
  );
}

function hasPlaywright() {
  try { pw(); return true; } catch { return false; }
}

// 「装了 playwright-core」≠「能起浏览器」：包里只有驱动，浏览器是单独的东西。
// WSL 里最典型 —— 包能 require，但没装 Linux 版 Edge，也没有 playwright 的 Linux chromium
//（默认缓存 ~/.cache/ms-playwright 是空的），一 launch 就 Executable doesn't exist。
// 返回可执行文件路径（找不到返回 null），doctor 用它判断网页接口这一半到底能不能用。
function chromeBin() {
  const explicit = process.env.WBSBX_BROWSER;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const cands = process.platform === 'win32'
    ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
       'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
       'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
       '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// 起浏览器的方式：优先用找到的可执行文件；找不到时 Win/mac 还能靠 channel 让 playwright
// 走注册表/标准安装位置。都没有就返回 null —— 不要再拿一个假字符串当路径用。
function launchOpts() {
  const exe = chromeBin();
  if (exe) return { executablePath: exe };
  if (process.env.WBSBX_BROWSER) return { channel: process.env.WBSBX_BROWSER };
  if (process.platform === 'win32' || process.platform === 'darwin') return { channel: 'msedge' };
  return null;
}

// 给人看的一句话（doctor 用）
function describe() {
  const exe = chromeBin();
  if (exe) return exe;
  const o = launchOpts();
  return o && o.channel ? `channel:${o.channel}（按注册表解析）` : null;
}

// profile 同一时刻只能一个进程用：残留的 Singleton 锁会让启动直接失败
function cleanLocks() {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(cfg.PROFILE, f), { force: true, recursive: true }); } catch {}
  }
}

async function openPage({ headless = true } = {}) {
  cfg.ensureDirs();
  cleanLocks();
  const how = launchOpts();
  if (!how) {
    throw new Error(
      '起不了浏览器：这台机器上没有 Edge/chromium。\n' +
      '  login 这类走网页接口的命令需要它；exec / put / get / history / watch 只要 token，不受影响。\n' +
      '  自定义路径：WBSBX_BROWSER=/path/to/chromium\n' +
      (process.platform === 'linux' ? '  WSL 里通常没有 Linux 版浏览器 —— 这几条命令在 Windows/macOS 侧执行即可。' : ''));
  }
  const ctx = await pw().chromium.launchPersistentContext(cfg.PROFILE, {
    ...how,
    headless,
    viewport: null,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

// 在已登录的页面里发请求（cookie 自动带上，绕开 APISIX 的 TLS 指纹拦截）
async function api(page, p, opt) {
  return page.evaluate(async ([p, opt]) => {
    try {
      const r = await fetch(p, Object.assign({ credentials: 'include' }, opt || {}));
      return { s: r.status, t: await r.text() };
    } catch (e) { return { s: -1, t: 'ERR ' + e.message }; }
  }, [p, opt]);
}

async function gotoSignedIn(page) {
  try {
    await page.goto(cfg.AGENTS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch {}
  await new Promise((r) => setTimeout(r, 2500));
}

// 打开浏览器干一件事然后关掉 —— 所有网页接口动作都套这个壳
async function withPage(fn, opts) {
  const { ctx, page } = await openPage(opts);
  try { return await fn(page, ctx); } finally { try { await ctx.close(); } catch {} }
}

// 一次性的干净上下文（用完就关）：给「注入 cookie 走 SSO 续期」这种场景用。
// 和 openPage 的区别：不碰持久 profile，所以可以跑在服务器/容器里。
// userAgent 必须由调用方给 —— 换 session 时要跟原来登录态保持同一个 UA，
// 否则服务端会把新 session 绑到浏览器默认 UA 上，下次纯 HTTP 请求照样 401。
async function launchEphemeral({ headless = true, userAgent } = {}) {
  const how = launchOpts();
  if (!how) throw new Error('这台机器上没有 Edge/chromium，无法走浏览器续期（可用 WBSBX_BROWSER 指定路径）');
  const opt = { ...how, headless, args: ['--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage'] };
  const browser = await pw().chromium.launch(opt);
  const ctx = await browser.newContext({
    userAgent,
    viewport: { width: 1100, height: 720 },
  });
  return { browser, ctx };
}

module.exports = { hasPlaywright, chromeBin, launchOpts, describe, openPage, api, gotoSignedIn, withPage, launchEphemeral };
