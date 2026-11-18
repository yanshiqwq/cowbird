// 登录态有**两条**路，各管一面，互不干扰：
//
//   cookie（主用）  控制面的 `/chat/*`（列会话、建会话、预览代理 shell）只认它。
//                   `devclouddevuibjJ_SESSION_ID` 是 HttpOnly 的 session cookie（无 expires），
//                   CSRF 靠 `devclouddevuibjtcftk` 走 double-submit（请求头 `cftk`）。
//                   **UA 不参与鉴权**（curl 自带 UA 全程 200），与 WorkBuddy 那种"UA 逐字节
//                   绑定"是两套模型，别照抄那边。
//   oauth（另一面）  官方码道插件那套 OAuth2 + PKCE + DPoP，换回来的是 STS 临时 AK/SK 与
//                   security_token，用来打 `snap-access` 那侧的 agent/chat 接口。
//                   它**不是**控制面 cookie，换不了 `devcloud` 的会话（见 oauth.js 的头注）。
//
// 所以 `login` 现在给两个入口：
//   `cowbird --platform codearts login`              浏览器/无头登录，抓控制面 cookie（主用）
//   `cowbird --platform codearts login --cookie "…"` 手动粘 cookie（无浏览器场景）
//   （`--platform` / `--channel` / `--account` 是全局开关，必须写在命令名之前）
// 而 OAuth 那条（打印链接 + 回调/轮询）也在下面实现了，但只在 `--oauth` 时走 ——
// 它落的是另一面凭据，能不能替控制面用还没实测，默认不掺和主流程。
//
// 未登录的表现不是 401，而是 HTTP 200 + 空体 + `HW-AJAX-REDIRECT: …authui/login…`
// —— 判定逻辑在 transport.js，这一层只负责存取。

const SESSION_COOKIE = 'devclouddevuibjJ_SESSION_ID';
const CFTK_COOKIE = 'devclouddevuibjtcftk';
const AGENCY_COOKIE = 'devclouddevuibjagencyID';
const DOMAIN = '.devcloud.cn-north-4.huaweicloud.com';
const KEY = 'auth';              // ctx.store 里的文件名（→ platform/codearts/auth.json）
const OAUTH_KEY = 'oauth';       // 另一面：STS 凭据（含 DPoP 私钥与 PKCE verifier）
const PENDING_KEY = 'oauth-pending';

const oauth = require('./oauth');
const oauthFlow = require('./oauth-flow');

const { sleep } = require('../util');

// ---------- 存取 ----------
function read(ctx) {
  try { return (ctx && ctx.store && ctx.store.read(KEY)) || null; } catch { return null; }
}

function save(ctx, st) {
  const out = {
    savedAt: new Date().toISOString(),
    ...st,
    cookies: (st && st.cookies) || [],
  };
  // 凭据写不进去必须当场炸：否则 login 报"已登录"，下一条命令却说"没有登录态"
  if (ctx && ctx.store) ctx.store.writeStrict(KEY, out);
  return out;
}

function clear(ctx) {
  try { if (ctx && ctx.store) ctx.store.remove(KEY); } catch {}
}

// ---------- cookie 小工具（通用实现在 lib/platform/cookie.js） ----------
const cookie = require('../cookie');

function cookieValue(cookies, name) {
  return cookie.value(cookies, name);
}

/** cookie jar → Cookie 请求头。域名/路径双重匹配（本平台全在 / 下，但别写死） */
function cookieHeader(cookies, { host = 'devcloud.cn-north-4.huaweicloud.com', path = '/' } = {}) {
  return cookie.header(cookies, { host, path, extraDomains: ['huaweicloud.com'] });
}

/** 从浏览器 cookie 列表里只留本平台相关的（别把别的站 cookie 写进文件） */
function keepRelevant(cookies) {
  return (cookies || []).filter((c) => {
    const d = String((c && c.domain) || '').replace(/^\./, '');
    return !d || d.endsWith('huaweicloud.com') || d.endsWith('devcloud.cn-north-4.huaweicloud.com');
  });
}

/**
 * 用户手动粘一串 `a=1; b=2` 时用。
 * 这是无浏览器环境（WSL/容器）最实用的登录方式：从自己浏览器的 DevTools 里复制。
 */
function parseCookieString(raw, { domain = DOMAIN, path = '/' } = {}) {
  return cookie.parse(raw, { domain, path });
}

/** 滚动刷新：Set-Cookie 合并回本地 jar（只为"HWWAFSESID 之类"可能轮换的 cookie） */
function absorb(ctx, setCookies) {
  if (!setCookies || !setCookies.length) return null;
  const st = read(ctx);
  if (!st || !(st.cookies || []).length) return null;
  const r = cookie.absorb(st.cookies, setCookies, { defaultDomain: DOMAIN });
  if (!r.changed) return null;
  return save(ctx, { ...st, cookies: r.cookies });
}

// ---------- 判定 ----------
function isLoggedIn(st) {
  return !!(st && cookieValue(st.cookies, SESSION_COOKIE));
}

/**
 * 还能用几天。
 * 本平台的三条 cookie 全是 session cookie（无 expires）⇒ 返回 null（未知）。
 * 有明确 expires 的（如果有的话）取最小剩余天数。
 */
function ttlDays(stOrCookies) {
  const isState = !Array.isArray(stOrCookies) && stOrCookies && typeof stOrCookies === 'object';
  const cookies = Array.isArray(stOrCookies) ? stOrCookies : ((stOrCookies && stOrCookies.cookies) || []);
  const withExp = cookies.filter((c) => c && Number(c.expires) > 0);
  if (withExp.length) {
    const now = Date.now() / 1000;
    const min = Math.min(...withExp.map((c) => Number(c.expires)));
    return min > now ? (min - now) / 86400 : 0;
  }
  // session cookie 报不出期限，但 OAuth 那面有 expiration —— 有就用它当「凭据剩余」，
  // 否则 account ls / doctor 里这一列永远是「未知」。
  const oa = isState && stOrCookies.oauth ? stOrCookies.oauth.ttlDays : null;
  return Number.isFinite(oa) ? oa : null;
}

// ---------- 对外：state ----------
async function state(ctx) {
  const st = read(ctx);
  const oa = readOauth(ctx);
  if (!isLoggedIn(st) && !oa) return null;
  const base = isLoggedIn(st) ? {
    // `token` 只在"有没有登录态"这一层有意义：本平台用的是 cookie，没有 bearer token
    token: cookieValue(st.cookies, SESSION_COOKIE),
    cookies: st.cookies,
    cftk: cookieValue(st.cookies, CFTK_COOKIE),
    agencyId: cookieValue(st.cookies, AGENCY_COOKIE),
    savedAt: st.savedAt || null,
    expiresAt: null,                       // session cookie：没有固定期限
    ttlDays: ttlDays(st),
    source: st.source || 'unknown',
  } : { token: null, cookies: [], savedAt: null, expiresAt: null, ttlDays: null, source: 'none' };

  // OAuth 那一面（STS 凭据）有的话一起报出来 —— 它的 expiration 是唯一能算出剩余天数的东西
  if (oa) {
    base.oauth = {
      userId: oa.userId || null,
      userName: oa.userName || null,
      expiresAt: oa.expiration || null,
      ttlDays: oauth.ttlDays(oa.expiration),
      hasRefresh: Boolean(oa.refreshToken),
      accessKeyId: oa.accessKeyId ? String(oa.accessKeyId).slice(0, 8) + '…' : null,
      savedAt: oa.savedAt || null,
    };
    if (base.ttlDays == null) base.ttlDays = base.oauth.ttlDays;
  }
  return base;
}

/** 手动导入（无浏览器场景）：把一串 `a=1; b=2` 存成登录态 */
async function importCookies(ctx, raw, opts = {}) {
  const cookies = keepRelevant(parseCookieString(raw, opts));
  if (!cookieValue(cookies, SESSION_COOKIE)) {
    throw new Error(`这串 cookie 里没有 ${SESSION_COOKIE} —— 它不是本平台的登录态（HttpOnly 那条必须一起复制）`);
  }
  return save(ctx, { cookies, source: 'paste' });
}

/** 本地登录态是否还活着（发一次真请求；只有 doctor 用） */
async function alive(ctx, { probePath = '/rest/me', timeoutMs = 12000 } = {}) {
  const transport = require('./transport');
  const t = transport.createTransport(ctx);
  try {
    const r = await t.request('GET', probePath, { timeoutMs });
    return { ok: r.status === 200 && !!r.text.trim(), status: r.status, me: r.json };
  } catch (e) {
    return { ok: false, status: e.status || -1, reason: e.message, code: e.code || null };
  }
}

// ---------- 对外：login（只写代码，不执行） ----------
// 与 WorkBuddy 的 login 不同：不用持久 profile（那是 WorkBuddy 的登录态容身之处），
// 这里用一次性上下文 —— 因为本平台不绑 UA、也不需要保留浏览器痕迹，
// 拿完 cookie 立刻关掉更干净，也能跑在无头服务器上。
async function login(ctx, opts = {}) {
  const {
    headless = false,
    timeoutMin = 20,
    loginUrl = 'https://devcloud.cn-north-4.huaweicloud.com/chat/',
    probePath = '/rest/me',
    onTick = null,
  } = opts;

  const browser = require('../../browser');           // 懒加载：没装 playwright 也不该拖垮 provider
  if (!browser.hasPlaywright || !browser.hasPlaywright()) {
    throw new Error('login 需要 playwright-core（npm i playwright-core，或用 COWBIRD_PW_MODULE 指向已有副本）。\n' +
      '  没有浏览器也可以：把浏览器 DevTools 里那串 cookie 粘进来 → cowbird --platform codearts login --cookie "<串>"');
  }

  const { browser: b, ctx: bctx } = await browser.launchEphemeral({ headless });
  try {
    const page = await bctx.newPage();
    try { await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { /* 跳登录页本身可能超时，继续轮询 */ }

    // 页面里探活：同源 fetch 自动带 cookie；缺 agent-type 会 400 TM.00001001，所以必须自己补头
    const probe = async () => page.evaluate(async ([p, cookieName]) => {
      const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + cookieName + '=([^;]*)'));
      const cftk = m ? decodeURIComponent(m[1]) : '';
      const h = { 'x-requested-with': 'XMLHttpRequest', 'agent-type': 'CodeBase', 'x-codearts-doer-scenario-type': 'web' };
      if (cftk) h.cftk = cftk;
      try {
        const r = await fetch(p, { credentials: 'include', headers: h });
        return { status: r.status, redirect: r.headers.get('hw-ajax-redirect') || '', body: (await r.text()).slice(0, 200) };
      } catch (e) { return { status: -1, redirect: '', body: 'ERR ' + e.message }; }
    }, [probePath, CFTK_COOKIE]).catch(() => ({ status: -1, redirect: '', body: '' }));

    const deadline = Date.now() + Math.max(1, timeoutMin) * 60e3;
    let tick = 0;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(3000);
      tick++;
      last = await probe();
      const ok = last.status === 200 && !last.redirect && String(last.body || '').trim().length > 0;
      if (onTick) { try { onTick({ tick, ...last, ok }); } catch {} }
      if (ok) {
        const cookies = keepRelevant(await bctx.cookies('https://devcloud.cn-north-4.huaweicloud.com/chat/'));
        if (!cookieValue(cookies, SESSION_COOKIE)) {
          throw new Error(`接口通了但没拿到 ${SESSION_COOKIE}（可能登录到了别的域）。换用 --cookie 手动粘贴。`);
        }
        const st = save(ctx, { cookies, source: 'browser' });
        return { ok: true, cookies, savedAt: st.savedAt };
      }
    }
    throw new Error(`登录超时（${timeoutMin} 分钟）最后状态 http=${last && last.status}。重跑即可继续；或改用 --cookie 手动粘贴。`);
  } finally {
    try { await b.close(); } catch {}
  }
}

// ---------- OAuth 那一面（STS 凭据）：打印链接 + 回调 / 轮询 ----------
//
// 与 WorkBuddy 的 device 登录同构，只是「回调」比「轮询」更靠前：
//   1. 起一个 127.0.0.1:<随机端口> 的回调服务，把端口写进授权链接；
//   2. 打印链接，用户在任何浏览器里打开、授权；
//   3. 浏览器被打回本地端口，接住 `?code=`，拿它去 STS 换凭据（DPoP 签名）；
//   4. 回调够不着（浏览器在另一台机器）就退回轮询 `snap-manager/v1/login/ticket`；
//      再不行就用 `--callback '<粘回来的地址>'` 在第二次运行时补上。
//
// pending（verifier + DPoP 私钥 + ticket）落在 ctx.store 里而不是内存：
// 这样第二次运行（粘贴回调）还能接着用同一套 PKCE 参数 —— 换 token 时两者必须成对。

const flows = new Map();          // id → 进行中的登录（只在本进程活几分钟）

function readOauth(ctx) {
  try { return (ctx && ctx.store && ctx.store.read(OAUTH_KEY)) || null; } catch { return null; }
}

function saveOauth(ctx, cred) {
  const out = { ...cred, savedAt: new Date().toISOString() };
  if (ctx && ctx.store) {
    if (typeof ctx.store.writeStrict === 'function') ctx.store.writeStrict(OAUTH_KEY, out);
    else ctx.store.write(OAUTH_KEY, out);
  }
  return out;
}

function readPending(ctx) {
  try { return (ctx && ctx.store && ctx.store.read(PENDING_KEY)) || null; } catch { return null; }
}

function savePending(ctx, p) {
  try { if (ctx && ctx.store) ctx.store.write(PENDING_KEY, p); } catch {}
}

function clearPending(ctx) {
  try { if (ctx && ctx.store) ctx.store.remove(PENDING_KEY); } catch {}
}

/** 把 STS 凭据落盘（DPoP 私钥与 verifier 必须一起存，否则续期报 InvalidDPoPHeader） */
async function commitOauth(ctx, tok, { verifier, jwk, clientId, stsHost, snapManager }) {
  // 换票响应里没有人身份，补问一次「我是谁」（AK/SK 签名，失败就算了）
  let who = null;
  try { who = await oauth.whoami({ ...tok, snapManager }); } catch { who = null; }
  const cred = saveOauth(ctx, {
    userId: tok.userId || (who && who.userId) || null,
    userName: tok.userName || (who && who.userName) || null,
    domainId: tok.domainId || (who && who.domainId) || null,
    securityToken: tok.securityToken,
    accessKeyId: tok.accessKeyId,
    secretAccessKey: tok.secretAccessKey,
    expiration: tok.expiration,
    refreshToken: tok.refreshToken || '',
    verifier, jwk, clientId: clientId || oauth.DEFAULTS.clientId,
    // 记住是从哪个 STS 换来的：续期必须回同一个地方（也方便自测指向假服务）
    stsHost: stsHost || oauth.DEFAULTS.stsHost,
    snapManager: snapManager || oauth.DEFAULTS.snapManager,
  });
  clearPending(ctx);
  return cred;
}

function describeOauth(cred) {
  if (!cred) return null;
  return {
    account: cred.userName || cred.userId || null,
    uid: cred.userId || null,
    expiresAt: Number.isFinite(Date.parse(cred.expiration || '')) ? Math.floor(Date.parse(cred.expiration) / 1000) : null,
  };
}

/** 起一次 OAuth 登录：返回要打印的链接 */
async function oauthStart(ctx, opts = {}) {
  const key = opts.key || oauth.newKey();
  const { verifier, challenge } = oauth.pkce();
  const ticketId = oauth.randomHex(16);
  const stsHost = opts.stsHost || oauth.DEFAULTS.stsHost;

  // 粘贴模式：调用方已经拿着上次打印链接的回调地址，不需要再起服务
  if (opts.callback) return { state: null, url: '', steps: ['使用已提供的回调地址完成换票'] };

  const srv = await oauthFlow.open({
    onCallback: (q) => {
      const p = [...flows.values()].find((x) => x.ticketId === ticketId);
      if (!p) return;
      if (q.get('code')) p.code = q.get('code');
      if (q.get('secret')) p.secret = q.get('secret');
    },
  });

  const id = oauth.randomHex(8);
  flows.set(id, { id, ticketId, code: '', secret: '', result: null, error: null, close: srv.close });
  savePending(ctx, {
    verifier, jwk: key.jwk, ticketId, port: srv.port, stsHost,
    clientId: oauth.DEFAULTS.clientId, createdAt: new Date().toISOString(),
  });

  return {
    state: id,
    url: oauth.authorizeUrl({ port: srv.port, challenge, ticketId }),
    steps: [
      '在浏览器中打开下面的链接（别用无痕窗口）',
      '用华为云账号登录并同意授权',
      '页面会跳回本机一个随机端口；看到「授权完成」就可以回终端',
      '若浏览器在另一台机器上：把地址栏那串 http://127.0.0.1:…/oauth/callback?code=… 复制回来，',
      '  改跑 cowbird --platform codearts login --oauth --callback "<那串>"',
    ],
  };
}

/** 轮询一次：完成/失败/仍在等 */
async function oauthPoll(ctx, id, opts = {}) {
  const pend = readPending(ctx);

  // 粘贴模式：id 为空时走这里 —— 直接从回调地址换票
  if (!id && opts.callback) {
    const cb = oauth.parseCallback(opts.callback);
    if (!cb.code) throw new Error('这个回调地址里没有 code（它是旧式 portal 回调？那种只能等轮询）');
    if (!pend) throw new Error('找不到这次登录的 PKCE 参数（可能是上一次的登录已过期）。先跑一次 cowbird login 重新拿链接。');
    const key = oauth.keyFromJwk(pend.jwk);
    const tok = await oauth.exchange({ code: cb.code, verifier: pend.verifier, port: cb.port, key, stsHost: pend.stsHost });
    const cred = await commitOauth(ctx, tok, {
      verifier: pend.verifier, jwk: pend.jwk, clientId: pend.clientId,
      stsHost: pend.stsHost, snapManager: pend.snapManager,
    });
    return { status: 'done', oauth: cred, ...describeOauth(cred) };
  }

  const p = flows.get(id);
  if (!p) return { status: 'failed', error: '这次登录已经结束或进程重启过，重新跑 cowbird login 即可' };
  if (!pend) return { status: 'failed', error: '这次登录的 PKCE 参数丢了，重新跑 cowbird login' };

  if (!p.result && p.code) {
    try {
      const key = oauth.keyFromJwk(pend.jwk);
      p.result = await oauth.exchange({ code: p.code, verifier: pend.verifier, port: pend.port, key, stsHost: pend.stsHost });
    } catch (e) {
      p.error = e.message;               // 授权码只能用一次：失败就别再试了
    }
  }
  // 回调只给了 secret（旧式 portal）：改走 ticket 轮询
  if (!p.result && !p.error && p.secret) {
    try {
      const t = await oauth.pollTicket({ ticketId: pend.ticketId, secret: p.secret, snapManager: pend.snapManager });
      if (t && t.securityToken) p.result = t;
    } catch { /* 网络抖动就下一轮再试 */ }
  }

  if (p.error) {
    try { await p.close(); } catch {}
    flows.delete(id);
    return { status: 'failed', error: p.error };
  }
  if (p.result) {
    try { await p.close(); } catch {}
    flows.delete(id);
    const cred = await commitOauth(ctx, p.result, {
      verifier: pend.verifier, jwk: pend.jwk, clientId: pend.clientId,
      stsHost: pend.stsHost, snapManager: pend.snapManager,
    });
    return { status: 'done', oauth: cred, ...describeOauth(cred) };
  }
  return { status: 'pending', message: p.secret ? '等待 portal 完成授权…' : '等待浏览器回调…' };
}

/** 用 refresh_token 换一份新的 STS 凭据（与 cookie 无关） */
async function oauthRenew(ctx) {
  const cur = readOauth(ctx);
  if (!cur || !cur.refreshToken) return { ok: false, reason: '没有 OAuth 凭据或 refresh_token' };
  try {
    const key = oauth.keyFromJwk(cur.jwk);
    const tok = await oauth.refresh({
      refreshToken: cur.refreshToken, verifier: cur.verifier, key, clientId: cur.clientId, stsHost: cur.stsHost,
    });
    const cred = saveOauth(ctx, {
      ...cur, ...{
        securityToken: tok.securityToken, accessKeyId: tok.accessKeyId, secretAccessKey: tok.secretAccessKey,
        expiration: tok.expiration, refreshToken: tok.refreshToken || cur.refreshToken,
      },
    });
    return { ok: true, expiresAt: describeOauth(cred).expiresAt, ttlDays: oauth.ttlDays(cred.expiration) };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 200), terminal: e.status >= 400 && e.status < 500 };
  }
}

const oauthDevice = {
  start: (ctx, opts) => oauthStart(ctx, opts),
  poll: (ctx, id, opts) => oauthPoll(ctx, id, opts),
  describe: (st) => ({ account: st && st.account, uid: st && st.uid, expiresAt: st && st.expiresAt }),
};

module.exports = {
  SESSION_COOKIE, CFTK_COOKIE, AGENCY_COOKIE, DOMAIN,
  read, save, clear, importCookies,
  cookieValue, cookieHeader, parseCookieString, keepRelevant, absorb,
  isLoggedIn, ttlDays, state, alive, login,
  readOauth, saveOauth, describeOauth, oauthDevice, oauthRenew,
};
