// 登录态：一个 cookie 文件就是全部。
//
// 实测结论（调查报告 2 节）：
//   · 业务会话 = cookie `devclouddevuibjJ_SESSION_ID`（HttpOnly，48 字符）
//   · CSRF     = cookie `devclouddevuibjtcftk` 的值 → 请求头 `cftk`（double-submit）
//   · 附随     = `devclouddevuibjagencyID`
//   · **UA 不参与鉴权**（curl 自带 UA 全程 200）—— 所以这里不存 UA，
//     与 WorkBuddy 那种"UA 逐字节绑定"是两套完全不同的模型，别照抄那边。
//   · 三条 cookie 都是 **session cookie（无 expires）** ⇒ 没有可续期的固定期限，
//     过期只能重新抓一份；`ttlDays()` 因此返回 null（未知），不是 0。
//
// 未登录的表现也不是 401，而是 HTTP 200 + 空体 + `HW-AJAX-REDIRECT: …authui/login…`
// —— 判定逻辑在 transport.js，这一层只负责存取。
//
// login 走 lib/browser.js（playwright-core，可选依赖），**只写代码不执行**：
// 没有凭据的机器上这些路径一次都不会跑到。

const SESSION_COOKIE = 'devclouddevuibjJ_SESSION_ID';
const CFTK_COOKIE = 'devclouddevuibjtcftk';
const AGENCY_COOKIE = 'devclouddevuibjagencyID';
const DOMAIN = '.devcloud.cn-north-4.huaweicloud.com';
const KEY = 'auth';              // ctx.store 里的文件名（→ platform/codearts/auth.json）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  try { if (ctx && ctx.store) ctx.store.write(KEY, out); } catch {}
  return out;
}

function clear(ctx) {
  try { if (ctx && ctx.store) ctx.store.remove(KEY); } catch {}
}

// ---------- cookie 小工具 ----------
function cookieValue(cookies, name) {
  const hit = (cookies || []).find((c) => c && c.name === name);
  return hit ? String(hit.value === undefined ? '' : hit.value) : null;
}

/** cookie jar → Cookie 请求头。域名/路径双重匹配（本平台全在 / 下，但别写死） */
function cookieHeader(cookies, { host = 'devcloud.cn-north-4.huaweicloud.com', path = '/' } = {}) {
  return (cookies || [])
    .filter((c) => {
      if (!c || !c.name) return false;
      const d = String(c.domain || '').replace(/^\./, '');
      const domainOk = !d || d === host || host.endsWith('.' + d) || d.endsWith('huaweicloud.com');
      if (!domainOk) return false;
      const cp = c.path || '/';
      return cp === '/' || path === cp || path.startsWith(cp.endsWith('/') ? cp : cp + '/');
    })
    .map((c) => `${c.name}=${c.value === undefined ? '' : c.value}`)
    .join('; ');
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
  const out = [];
  for (const part of String(raw || '').split(';')) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out.push({ name: t.slice(0, i).trim(), value: t.slice(i + 1).trim(), domain, path, expires: -1, httpOnly: false, secure: true });
  }
  return out;
}

/** 滚动刷新：Set-Cookie 合并回本地 jar（只为"HWWAFSESID 之类"可能轮换的 cookie） */
function absorb(ctx, setCookies) {
  if (!setCookies || !setCookies.length) return null;
  const st = read(ctx);
  if (!st || !(st.cookies || []).length) return null;
  let changed = false;
  const cookies = st.cookies.slice();

  for (const raw of setCookies) {
    const parts = String(raw).split(';').map((x) => x.trim());
    const first = parts.shift() || '';
    const i = first.indexOf('=');
    if (i < 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1);
    const attrs = {};
    for (const p of parts) { const k = p.indexOf('='); if (k > 0) attrs[p.slice(0, k).toLowerCase()] = p.slice(k + 1); }

    const path = attrs.path || '/';
    const domain = attrs.domain || DOMAIN;
    const key = `${name}|${path}|${String(domain).replace(/^\./, '')}`;
    const idx = cookies.findIndex((c) => `${c.name}|${c.path || '/'}|${String(c.domain || '').replace(/^\./, '')}` === key);

    const maxAge = attrs['max-age'] !== undefined ? Number(attrs['max-age']) : null;
    const expiresAt = attrs.expires ? Math.floor(Date.parse(attrs.expires) / 1000) : null;
    const dead = (maxAge !== null && maxAge <= 0) || (expiresAt !== null && expiresAt * 1000 <= Date.now());

    if (dead) { if (idx >= 0) { cookies.splice(idx, 1); changed = true; } continue; }
    if (!value && maxAge === null && expiresAt === null) continue;

    const cur = {
      name, value, path, domain,
      expires: maxAge !== null ? Math.floor(Date.now() / 1000) + maxAge : (expiresAt !== null ? expiresAt : (idx >= 0 ? cookies[idx].expires : -1)),
      httpOnly: 'httponly' in attrs,
      secure: 'secure' in attrs,
    };
    if (idx >= 0) { cookies[idx] = cur; } else { cookies.push(cur); }
    changed = true;
  }

  if (!changed) return null;
  return save(ctx, { ...st, cookies });
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
  const cookies = Array.isArray(stOrCookies) ? stOrCookies : ((stOrCookies && stOrCookies.cookies) || []);
  const withExp = cookies.filter((c) => c && Number(c.expires) > 0);
  if (!withExp.length) return null;
  const now = Date.now() / 1000;
  const min = Math.min(...withExp.map((c) => Number(c.expires)));
  return min > now ? (min - now) / 86400 : 0;
}

// ---------- 对外：state ----------
async function state(ctx) {
  const st = read(ctx);
  if (!isLoggedIn(st)) return null;
  return {
    // `token` 只在"有没有登录态"这一层有意义：本平台用的是 cookie，没有 bearer token
    token: cookieValue(st.cookies, SESSION_COOKIE),
    cookies: st.cookies,
    cftk: cookieValue(st.cookies, CFTK_COOKIE),
    agencyId: cookieValue(st.cookies, AGENCY_COOKIE),
    savedAt: st.savedAt || null,
    expiresAt: null,                       // session cookie：没有固定期限
    ttlDays: ttlDays(st),
    source: st.source || 'unknown',
  };
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
      '  没有浏览器也可以：把浏览器 DevTools 里那串 cookie 粘进来 → cowbird login --platform codearts --cookie "<串>"');
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

module.exports = {
  SESSION_COOKIE, CFTK_COOKIE, AGENCY_COOKIE, DOMAIN,
  read, save, clear, importCookies,
  cookieValue, cookieHeader, parseCookieString, keepRelevant, absorb,
  isLoggedIn, ttlDays, state, alive, login,
};
