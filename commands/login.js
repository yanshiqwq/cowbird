// cowbird login —— 登录（唯一可能用到浏览器的命令）
//
// 登录落在**账号**上：`--as <名字>` 就往那个账号目录里写，不写就是该平台的默认账号。
// 同一个平台可以挂多个账号，各自的凭据互相看不见（见 lib/platform/accounts.js）。
//
// 两种登录形态，由驱动决定：
//   ① 打印链接授权（默认）：在微信/浏览器里打开链接完成授权，不需要本地浏览器。
//   ② 驱动自己实现 auth.login()：浏览器或粘 cookie。
const fs = require('fs');
const path = require('path');
const { parse, num } = require('../lib/args');
const ui = require('../lib/ui');
const cfg = require('../lib/config');
const accounts = require('../lib/platform/accounts');
const channels = require('../lib/platform/channels');
const { CAP } = require('../lib/platform/contract');
const { log } = require('../lib/log');

const USAGE = 'login [--as <账号>] [--max-wait <分钟>] [--cookie "<串>"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function run(argv) {
  const args = parse(argv, {
    flags: ['import', 'print-only', 'device', 'oauth'],
    values: ['max-wait', 'max-min', 'cookie', 'as', 'account', 'callback'],
    aliases: { m: 'max-wait', a: 'as' },
  });
  const explicit = args.opts.as || args.opts.account || '';
  const ch = channels.preferred({ account: explicit || undefined });
  const p = ch.provider;

  if (!p.has(CAP.AUTH)) throw new Error(`本平台 ${p.displayName} 没有登录态概念`);

  // 驱动可以有多套登录：默认 `auth.device`（无头），`auth.oauth` 是另一面凭据（--oauth 才走）
  const impl = args.opts.oauth && p.auth && p.auth.oauth ? p.auth.oauth : (p.auth && p.auth.device);
  const canDevice = Boolean(impl && typeof impl.start === 'function');
  if (!canDevice && (!p.auth || typeof p.auth.login !== 'function')) {
    throw new Error(`本平台 ${p.displayName} 既没有无头登录（auth.device）也没有 auth.login()`);
  }

  const ctx = ch.ctx;
  ctx.log = (m) => log(m);
  const opts = {
    importOnly: !!args.opts.import,
    maxWaitMin: num(args.opts['max-wait'] || args.opts['max-min'], Number(process.env.LOGIN_MAX_MIN) || 20),
    impl: canDevice ? impl : null,
  };
  if (args.opts.cookie) opts.cookie = String(args.opts.cookie);
  if (args.opts.callback) opts.callback = String(args.opts.callback);

  process.on('unhandledRejection', (e) => log('warn ' + String(e).slice(0, 160)));
  process.on('uncaughtException', (e) => log('warn ' + String(e).slice(0, 160)));

  // 没写 --as 就是「给默认账号续一次」，但云端的身份可能换了 —— 先备份，换人了就还原，
  // 免得「想加第二个账号」的人一不留神把第一个账号的登录态顶掉。
  const prev = accounts.meta(ch.platform, ch.account) || {};
  const prevId = prev.uid || prev.nickname || null;
  const bak = explicit ? null : snapshot(ch);

  let r;
  if (canDevice) r = await deviceLogin(p, ctx, opts);
  else {
    const out = await p.auth.login(ctx, opts);
    r = out && out.ok
      ? { code: 0, identity: (out.user && (out.user.name || out.user.uid)) || null, label: out.user && out.user.name }
      : { code: 1, reason: out && out.reason, hint: out && out.hint };
    if (r.code === 0) {
      const bits = [];
      if (r.label) bits.push('账号 ' + r.label);
      if (out.ttlDays != null) bits.push('还能用 ' + Number(out.ttlDays).toFixed(1) + ' 天');
      console.log(ui.c.green('OK') + ' 已登录' + (bits.length ? '（' + bits.join(' · ') + '）' : ''));
    } else {
      console.log(ui.c.yellow('未登录') + (r.reason ? '：' + r.reason : ''));
      if (r.hint) console.log(ui.c.dim(r.hint));
    }
  }

  if (r.code !== 0) {
    // 失败/超时**不动现场**：驱动都是「成功之后一次写盘」，失败时什么都没改。
    // 早先这里是 restore()，两个终端同时登录同一账号时会把另一个刚写好的凭据删掉。
    drop(bak);
    return 1;
  }

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
  drop(bak);
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
}

module.exports = {
  run,
  usage: USAGE,
  help: [
    '选项:',
    '  -a, --as <账号>        登录到指定账号（同平台可以挂多个），默认用该平台的默认账号',
    '  -m, --max-wait <分钟>  等待授权的有效期，默认 20',
    '  --cookie "<串>"        粘一串 cookie（只对 cookie 型平台有用，如码道/Qoder）',
    '  --oauth                走 OAuth(PKCE+DPoP) 换 STS 凭据（码道：snap-access 那一面，非控制面 cookie）',
    '  --callback "<地址>"    浏览器在另一台机器时，把跳转回来的 http://127.0.0.1:…/oauth/callback?code=… 粘回来',
    '',
    '说明:',
    '  打印一个链接，在微信/浏览器里打开并授权，这边自动收到登录态。',
    '  加第二个账号：cowbird login --as 别名。不加 --as 时若授权的是别的账号，会还原原凭据并提示。',
    '  --platform 是全局开关（写在 login 之前）：cowbird --platform codearts login',
    '  码道的 --oauth 走「本地回调 + 轮询 ticket」两条腿，够不着时用 --callback 手动补。',
    '  想看现有账号：cowbird account ls。',
    '',
    '退出码:',
    '  0  登录成功',
    '  1  超时 / 未取得登录态 / 平台不支持 / 授权了别的账号',
  ],
};
