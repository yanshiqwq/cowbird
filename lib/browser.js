// 浏览器：给「必须过网页登录」的平台用的通用助手。
//
// 只有 login 这类动作需要它；exec / put / get / history / watch 全部走纯 HTTP，不碰 playwright。
// 内核里之所以留这一层：playwright 的加载与浏览器路径在每台机器上都不一样（容器把包装在
// 别处、WSL 里没有 Linux 版 Edge、Windows 侧要指定 msedge.exe），这套「怎么找到浏览器」
// 的逻辑与任何具体平台无关，平台自己不该各写一份。
//
// 依赖是可选的：没装 playwright-core 时 hasPlaywright() 返回 false，调用方给个人话提示即可。
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

let _pw = null;

function pw() {
  if (_pw) return _pw;
  const tries = [
    // 显式指定：容器/服务器上常把 playwright-core 装在镜像里某个固定路径，
    // 既不在项目 node_modules 也不在 NODE_PATH，只能靠环境变量告诉它。
    () => {
      if (!process.env.COWBIRD_PW_MODULE) throw new Error('（未设置 COWBIRD_PW_MODULE）');
      return require(process.env.COWBIRD_PW_MODULE);
    },
    () => require('playwright-core'),
    () => require(path.join(cfg.HOME, 'node_modules', 'playwright-core')),
  ];
  const errs = [];
  for (const t of tries) {
    try { _pw = t(); return _pw; } catch (e) { errs.push(e.message.split('\n')[0]); }
  }
  throw new Error(
    '找不到 playwright-core。装一份（npm i playwright-core），或用 COWBIRD_PW_MODULE 指向已有的副本\n  ' +
    errs.join('\n  ')
  );
}

function hasPlaywright() {
  try { pw(); return true; } catch { return false; }
}

// 「装了 playwright-core」≠「能起浏览器」：包里只有驱动，浏览器是单独的东西。
// WSL 里最典型 —— 包能 require，但没装 Linux 版 chromium，一 launch 就 Executable doesn't exist。
// 返回可执行文件路径（找不到返回 null）。
function chromeBin() {
  const explicit = process.env.COWBIRD_BROWSER;
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
// 走注册表/标准安装位置。都没有就返回 null —— 别拿一个假字符串当路径用。
function launchOpts() {
  const exe = chromeBin();
  if (exe) return { executablePath: exe };
  if (process.env.COWBIRD_BROWSER) return { channel: process.env.COWBIRD_BROWSER };
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

/**
 * 一次性的干净上下文（用完就关）：拿 cookie 这种一次性动作都用它。
 * 不碰持久 profile，所以能跑在服务器/容器里。
 * userAgent 由调用方给 —— 有的平台把登录态跟 UA 绑在一起，换 UA 等于换账号。
 */
async function launchEphemeral({ headless = true, userAgent } = {}) {
  const how = launchOpts();
  if (!how) {
    const e = new Error(
      '起不了浏览器：这台机器上没有 Edge/chromium（可用 COWBIRD_BROWSER 指定路径）。\n' +
      (process.platform === 'linux' ? '  WSL 里通常没有 Linux 版浏览器 —— 这类命令在 Windows/macOS 侧执行即可。' : '')
    );
    e.code = 'E_NO_BROWSER';
    throw e;
  }
  const browser = await pw().chromium.launch({
    ...how,
    headless,
    args: ['--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ userAgent, viewport: { width: 1100, height: 720 } });
  return { browser, ctx };
}

module.exports = { pw, hasPlaywright, chromeBin, launchOpts, describe, launchEphemeral };
