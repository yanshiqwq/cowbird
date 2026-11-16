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
    () => require('playwright-core'),
    () => require(path.join(cfg.HOME, 'node_modules', 'playwright-core')),   // 旧 skill 布局
  ];
  const errs = [];
  for (const t of tries) {
    try { _pw = t(); return _pw; } catch (e) { errs.push(e.message.split('\n')[0]); }
  }
  throw new Error('找不到 playwright-core（仓库里 npm i，或把旧 ~/.workbuddy/wb-cloud/node_modules 留着）\n  ' + errs.join('\n  '));
}

function hasPlaywright() {
  try { pw(); return true; } catch { return false; }
}

function pwVersion() {
  for (const p of [path.join(__dirname, '..', 'node_modules', 'playwright-core', 'package.json'),
    path.join(cfg.HOME, 'node_modules', 'playwright-core', 'package.json')]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).version; } catch {}
  }
  return null;
}

// 「装了 playwright-core」≠「能起浏览器」：包里只有驱动，浏览器是单独的东西。
// WSL 里最典型 —— 包能 require，但没装 Linux 版 Edge，也没有 playwright 的 Linux chromium
//（默认缓存 ~/.cache/ms-playwright 是空的），一 launch 就 Executable doesn't exist。
// 返回可执行文件路径（找不到返回 null），doctor 用它判断网页接口这一半到底能不能用。
function chromeBin() {
  if (process.platform === 'win32') {
    const dirs = [process.env['PROGRAMFILES(X86)'], process.env['PROGRAMFILES'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean);
    for (const d of dirs) {
      for (const r of ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe']) {
        try { if (fs.existsSync(path.join(d, r))) return path.join(d, r); } catch {}
      }
    }
    // 装在非常规位置时 playwright 还能靠 channel 查注册表，别武断报死
    return (process.env.WBSBX_BROWSER || 'msedge') + '（按 channel 解析）';
  }
  for (const p of ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
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
  if (!chromeBin()) {
    throw new Error(
      '起不了浏览器：这台机器上没有 Edge/chromium。\n' +
      '  login / create / ls --refresh / cookie 这类走网页接口的命令需要它；\n' +
      '  exec / put / get / history / watch 只要 token，不受影响。\n' +
      (process.platform === 'linux' ? '  WSL 里通常没有 Linux 版 Edge —— 这几条命令到 Windows 侧执行即可。' : ''));
  }
  const channel = process.env.WBSBX_BROWSER || 'msedge';
  const ctx = await pw().chromium.launchPersistentContext(cfg.PROFILE, {
    channel,
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
  if (!chromeBin()) throw new Error('这台机器上没有 Edge/chromium，无法走浏览器续期');
  const exe = chromeBin();
  const opt = { headless, args: ['--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage'] };
  if (fs.existsSync(exe)) opt.executablePath = exe;
  else opt.channel = process.env.WBSBX_BROWSER || 'msedge';
  const browser = await pw().chromium.launch(opt);
  const ctx = await browser.newContext({
    userAgent,
    viewport: { width: 1100, height: 720 },
  });
  return { browser, ctx };
}

module.exports = { hasPlaywright, pwVersion, chromeBin, openPage, api, gotoSignedIn, withPage, launchEphemeral };
