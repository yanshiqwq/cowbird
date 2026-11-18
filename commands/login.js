// cowbird login —— 登录（唯一可能用到浏览器的命令）
//
// 登录落在**账号**上：`--as <名字>` 就往那个账号目录里写，不写就是该平台的默认账号。
// 同一个平台可以挂多个账号，各自的凭据互相看不见（见 lib/platform/accounts.js）。
//
// 三条路，按顺序挑一条：
//   ① 打印链接授权（auth.device，WorkBuddy）：微信里打开链接即可，不需要本地浏览器。
//   ② 弹浏览器（playwright）：打开登录页，用户手动登录，成功后自动抓 cookie（含 HttpOnly）。
//   ③ 手动粘贴：`--cookie "<串>"`，或没装 playwright 时命令直接问你要。
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { num } = require('../lib/args');
const { defineCommand } = require('../lib/command');
const ui = require('../lib/ui');
const cfg = require('../lib/config');
const browser = require('../lib/platform/browser');    // 内核侧门面，命令层不直接依赖 lib/browser
const accounts = require('../lib/platform/accounts');
const channels = require('../lib/platform/channels');
const { CAP } = require('../lib/platform/contract');
const { capabilityError } = require('../lib/platform/caps');
const { log } = require('../lib/log');

const USAGE = 'login [--as <账号>] [--max-wait <分钟>] [--cookie "<串>"]';
const { sleep } = require('../lib/platform/util');

/** 问一行输入（secret 会显示在终端里，但只在本机、且是用户自己主动粘的） */
function askLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { rl.close(); } catch {} ; resolve(String(v || '').trim()); };
    rl.on('close', () => fin(''));
    try { rl.question(question, fin); } catch { fin(''); }
  });
}

/** 该平台"从哪弄到串"的提示 */
function pasteHint(p) {
  const id = p.id;
  if (id === 'minimax') return '浏览器登录 agent.minimax.cn 后，控制台执行 localStorage.getItem("_token")，把整串粘进来';
  if (id === 'trae') return '浏览器登录 work.trae.cn 后，DevTools → Application → Cookies 复制全部（含 HttpOnly 的 sessionid）';
  return '浏览器登录后，DevTools → Network 里任一请求 → 右键 Copy as cURL，取其中 cookie: 后面的整串';
}

/** 把账号目录整个拷到同级隐藏目录，登录失败/换人了就还原 */
function snapshot(ch) {
  const dir = accounts.dir(ch.platform, ch.account);
  if (!fs.existsSync(dir)) return null;
  // 备份名带 pid：两个终端同时登录同一账号时互不覆盖
  const bak = path.join(accounts.platformDir(ch.platform), 'accounts', `.bak-${ch.account}-${process.pid}`);
  try {
    fs.rmSync(bak, { recursive: true, force: true });
    fs.cpSync(dir, bak, { recursive: true });
    return bak;
  } catch {
    return null;
  }
}

// 只在「确实换上了别的账号、要撤回」时调用。
// ⚠ 顺序不能反：先确认备份在，再动现场。踩过的坑 —— 另一个登录进程超时后走到这里时，
// 备份已被成功那次 drop 掉，于是「删了现场、rename 失败」，整个账号目录连凭据一起没了。
function restore(ch, bak) {
  if (!bak || !fs.existsSync(bak)) return false;
  const dir = accounts.dir(ch.platform, ch.account);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(bak, dir);
    return true;
  } catch {
    return false;
  }
}

function drop(bak) {
  if (!bak) return;
  try { fs.rmSync(bak, { recursive: true, force: true }); } catch {}
}

/** 无头登录：打印链接 → 轮询 → 成功/超时。状态机 pending/done/failed/expired/cancelled。 */
async function deviceLogin(p, ctx, opts) {
  const d = opts.impl || p.auth.device;
  const s = await d.start(ctx, opts);
  const timeoutMs = Math.max(1, opts.maxWaitMin) * 60e3;
  // 步骤文案由驱动给（不同平台的授权方式不一样：微信授权 / 网页登录 / 短信）
  const steps = Array.isArray(s.steps) && s.steps.length
    ? s.steps
    : ['打开下面的链接', '按页面提示完成授权'];

  console.log(ui.c.bold('='.repeat(60)));
  console.log(ui.c.bold(`  ${p.displayName} 登录`) + ui.c.dim(`  渠道 ${ctx.channel}`));
  console.log(ui.c.bold('='.repeat(60)));
  console.log('步骤：');
  steps.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log('');
  if (s.url) {
    console.log(ui.c.bold('  登录链接：'));
    console.log('    ' + s.url);
    console.log('');
  }
  // --print-only：只把链接交出去（给"在另一台机器上开浏览器"的场景），不轮询、不落盘。
  if (opts.printOnly) {
    console.log(ui.c.dim('（--print-only：只打印链接，不在这台机器上等授权）'));
    return { code: 0, printed: true };
  }
  console.log(ui.c.dim(`（有效期 ${opts.maxWaitMin} 分钟，Ctrl-C 取消）…`));

  const started = Date.now();
  let tick = 0;
  for (;;) {
    if (!opts.callback) await sleep(2000);
    tick++;
    let r;
    try {
      r = await d.poll(ctx, s.state, opts);
    } catch (e) {
      log(`轮询出错（继续重试）：${String(e.message).slice(0, 120)}`);
      if (opts.callback) return { code: 1 };
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
      return { code: 0, identity: desc.uid || desc.account || null, label: desc.account || null };
    }
    if (r.status === 'failed') {
      console.log(ui.c.red('\n登录失败：') + (r.error || '原因不明'));
      return { code: 1 };
    }
    if (Date.now() - started > timeoutMs) {
      console.log(ui.c.yellow('\n登录已超时，请重新执行 cowbird login'));
      return { code: 1 };
    }
    if (opts.callback) {
      console.log(ui.c.yellow('\n这次回调没换到凭据：') + (r.message || '未知'));
      return { code: 1 };
    }
    if (tick % 15 === 0) log(`仍在等待授权…（${Math.round((Date.now() - started) / 1000)}s）`);
  }
}

/** 把用户粘的串落到账号上：优先 importCookies，其次 auth.login({token|cookie}) */
async function usePasted(p, ctx, raw, opts) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('粘进来的是空的');
  if (p.auth && typeof p.auth.importCookies === 'function') {
    await p.auth.importCookies(ctx, s, opts);
    return { code: 0, identity: null, label: null, via: 'paste' };
  }
  if (!p.auth || typeof p.auth.login !== 'function') {
    throw capabilityError(`本平台 ${p.displayName} 既不支持粘 cookie，也没有 auth.login()`, { capability: CAP.AUTH });
  }
  // JWT 形态的串当 token 用（minimax 这种只认 token 的平台）
  const looksJwt = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(s);
  const out = await p.auth.login(ctx, { ...opts, ...(looksJwt ? { token: s } : { cookie: s }) });
  if (out && out.ok) {
    return {
      code: 0,
      identity: (out.user && (out.user.name || out.user.uid)) || null,
      label: (out.user && out.user.name) || null,
      via: 'paste',
    };
  }
  return { code: 1, reason: (out && (out.reason || out.hint)) || '驱动不认这串内容' };
}

/** 没有浏览器 / 浏览器起不来时的兜底：让用户粘一串 */
async function pasteFlow(p, ctx, opts, why) {
  console.log(ui.c.yellow('改为手动粘贴登录态') + (why ? '：' + why : ''));
  console.log(ui.c.dim('  ' + pasteHint(p)));
  const raw = await askLine('粘贴后回车（直接回车取消）: ');
  if (!raw) {
    console.log(ui.c.dim('已取消'));
    return { code: 1, reason: '没有输入' };
  }
  return usePasted(p, ctx, raw, opts);
}

/** 弹浏览器：开哪一页由驱动的 auth.login 决定，这里只负责提示与兜底 */
async function browserFlow(p, ctx, opts) {
  console.log(ui.c.dim('已打开浏览器，请在窗口里完成登录（成功后会自动继续；想改粘贴就 Ctrl-C 后加 --cookie）'));
  try {
    const out = await p.auth.login(ctx, { ...opts, browser: true });
    if (out && out.ok) {
      const bits = [];
      if (out.user && out.user.name) bits.push('账号 ' + out.user.name);
      if (out.ttlDays != null) bits.push('还能用 ' + Number(out.ttlDays).toFixed(1) + ' 天');
      console.log(ui.c.green('OK') + ' 已登录' + (bits.length ? '（' + bits.join(' · ') + '）' : ''));
      return { code: 0, identity: (out.user && (out.user.name || out.user.uid)) || null, label: (out.user && out.user.name) || null };
    }
    return pasteFlow(p, ctx, opts, (out && (out.reason || out.hint)) || '驱动没有浏览器登录路径');
  } catch (e) {
    if (e && (e.code === 'E_NO_BROWSER' || e.code === 'E_LOGIN_TIMEOUT')) return pasteFlow(p, ctx, opts, e.message);
    throw e;
  }
}

module.exports = defineCommand({
  usage: USAGE,
  options: [
    { flag: 'as', short: 'a', arg: '<账号>', desc: '登录到指定账号（同平台可以挂多个），默认用该平台的默认账号' },
    { flag: 'account', arg: '<名字>', desc: '--as 的别名（内部统一按账号处理）' },
    { flag: 'max-wait', short: 'm', arg: '<分钟>', desc: '等待授权的有效期，默认 20' },
    { flag: 'max-min', arg: '<分钟>', desc: '--max-wait 的旧名字（兼容）' },
    { flag: 'cookie', arg: '<串>', desc: '直接粘一串登录态（cookie；minimax 这类平台粘 token），跳过浏览器' },
    { flag: 'print-only', desc: '只打印登录链接就退出（不轮询、不落盘；给"在另一台机器开浏览器"用）' },
    { flag: 'oauth', desc: '走 OAuth(PKCE+DPoP) 换 STS 凭据（码道：snap-access 那一面，非控制面 cookie）' },
    { flag: 'callback', arg: '<地址>', desc: '浏览器在另一台机器时，把跳转回来的 http://127.0.0.1:…/oauth/callback?code=… 粘回来' },
  ],
  notes: [
    '默认：弹一个浏览器窗口让你自己登录，登录成功后自动抓登录态（含 HttpOnly cookie）。',
    '这台机器没装 playwright-core 时，不再弹窗，直接提示你粘贴一串（也可以预先 --cookie 给出）。',
    'WorkBuddy 例外：它走「打印链接 + 轮询」，在微信/浏览器里打开授权即可，不需要本地浏览器。',
    '加第二个账号：cowbird login --as 别名。不加 --as 时若授权的是别的账号，会还原原凭据并提示。',
    '--platform 是全局开关（写在 login 之前）：cowbird --platform codearts login',
    '想看现有账号：cowbird account ls。',
  ],
  exits: [
    [0, '登录成功（--print-only 时表示链接已打印）'],
    [1, '超时 / 未取得登录态 / 授权了别的账号'],
    [2, '平台不支持（没有登录态概念，或既不能无头登录也不支持粘 cookie）'],
  ],
  run: async (args) => {
  const explicit = args.opts.as || args.opts.account || '';
  const ch = channels.preferred({ account: explicit || undefined });
  const p = ch.provider;

  if (!p.has(CAP.AUTH)) throw capabilityError(`本平台 ${p.displayName} 没有登录态概念`, { capability: CAP.AUTH });

  // 驱动可以有多套登录，命令层只负责挑一条：
  //   auth.device          无头授权（打印链接 + 轮询）
  //   auth.oauth           OAuth 那一面凭据（--oauth 才走）
  //   auth.importCookies   粘一串 cookie（无浏览器机器上唯一能走的路；不依赖 playwright）
  //   auth.login           驱动自管（可能开浏览器，也可能吃 opts.cookie）
  const impl = args.opts.oauth && p.auth && p.auth.oauth ? p.auth.oauth : (p.auth && p.auth.device);
  const canDevice = Boolean(impl && typeof impl.start === 'function');
  const canImport = Boolean(p.auth && typeof p.auth.importCookies === 'function');
  const cookieIn = args.opts.cookie ? String(args.opts.cookie) : '';
  if (!canDevice && !canImport && (!p.auth || typeof p.auth.login !== 'function')) {
    throw capabilityError(`本平台 ${p.displayName} 既没有无头登录（auth.device）也没有 auth.login()` +
      ' / auth.importCookies()', { capability: CAP.AUTH });
  }

  const ctx = ch.ctx;
  ctx.log = (m) => log(m);
  const opts = {
    maxWaitMin: num(args.opts['max-wait'] || args.opts['max-min'], Number(process.env.LOGIN_MAX_MIN) || 20),
    impl: canDevice ? impl : null,
    printOnly: !!args.opts['print-only'],
  };
  if (args.opts.callback) opts.callback = String(args.opts.callback);

  // 没写 --as 就是「给默认账号续一次」，但云端的身份可能换了 —— 先备份，换人了就还原，
  // 免得「想加第二个账号」的人一不留神把第一个账号的登录态顶掉。
  const prev = accounts.meta(ch.platform, ch.account) || {};
  const prevId = prev.uid || prev.nickname || null;
  const bak = explicit ? null : snapshot(ch);
  // Ctrl-C 是最常见的退出方式（默认等 20 分钟），备份必须跟着回收，否则账号目录里会堆凭据副本
  const onSig = () => { try { drop(bak); } catch { /* 尽力而为 */ } process.exit(130); };
  process.once('SIGINT', onSig);

  try {
    let r;
    if (cookieIn) {
      r = await usePasted(p, ctx, cookieIn, opts);
      if (r.code === 0) console.log(ui.c.green('OK') + ' 已导入粘贴的登录态');
    } else if (canDevice) {
      r = await deviceLogin(p, ctx, opts);
    } else if (p.auth && typeof p.auth.login === 'function') {
      // 有 playwright 就弹浏览器让用户自己登；没有就当场问他要一串
      r = browser.hasPlaywright()
        ? await browserFlow(p, ctx, opts)
        : await pasteFlow(p, ctx, opts, '这台机器没装 playwright-core（npm i playwright-core 才会弹浏览器）');
      if (r.code === 0 && r.via === 'paste') console.log(ui.c.green('OK') + ' 已导入粘贴的登录态');
    } else {
      r = await pasteFlow(p, ctx, opts, '驱动没有 auth.login()');
    }

    if (r.printed) return 0;              // --print-only：链接已打印，不等待、不落盘
    if (r.code !== 0) return 1;

    if (prevId && r.identity && String(prevId) !== String(r.identity)) {
      if (!explicit) {
        restore(ch, bak);
        console.log(ui.c.yellow('这次授权的是另一个账号：') + `${r.label || r.identity}`);
        console.log(ui.c.dim(`账号 ${ch.key} 原本是 ${prev.nickname || prevId}，已还原，没有覆盖。`));
        console.log(ui.c.dim(`要让它和原来的账号共存：cowbird ${ch.platform === cfg.DEFAULT_PLATFORM ? '' : '--platform ' + ch.platform + ' '}login --as <名字>`));
        return 1;
      }
      console.log(ui.c.yellow(`注意：账号 ${ch.key} 从 ${prev.nickname || prevId} 换成了 ${r.label || r.identity}`));
    }
    accounts.writeMeta(ch.platform, ch.account, {
      uid: r.identity || prev.uid || null,
      nickname: r.label || prev.nickname || null,
      savedAt: new Date().toISOString(),
    });
    // 这个平台还没有默认账号时，把刚登录的这个设为默认（免得后面每条命令都回退到空账号）
    const conf = cfg.readConfig();
    if (!conf.accounts || !conf.accounts[ch.platform]) {
      cfg.writeConfig({ accounts: { [ch.platform]: ch.account } });
    }
    console.log(ui.c.dim(`凭据：${accounts.dir(ch.platform, ch.account)}`));
    return 0;
  } finally {
    process.removeListener('SIGINT', onSig);
    drop(bak);
  }
}

});
