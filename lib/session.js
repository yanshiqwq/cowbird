// 会话层：把「登录态」抽象成一份可复用的 cookie jar + UA，之后所有网页接口走纯 HTTP。
//
// 为什么必须记 UA（2026-11-11 实采结论）：
//   APISIX 把有效会话跟 **User-Agent 精确绑定** —— 同一个 cookie，UA 一模一样就 200，
//   改一个版本号、去掉尾巴、甚至改大小写都是 401（错误页是 nginx 默认的 401 页，不是业务 JSON）。
//   跟 TLS 指纹无关：curl_cffi 模拟 Chrome 指纹照样 401；也跟 HTTP 版本无关，h2 一样 401。
//   现场对比：浏览器发 /console/as/conversations/ 是 200，同一个 cookie 换 UA 立刻 401。
//   ⇒ 结论：cookie 必须配「登录时那个 UA」使用。UA 存进 state.json，别再猜。
//
// 浏览器于是只剩一个用途：扫码登录（wbsbx login）。之后 30 天内全走纯 HTTP。
const fs = require('fs');
const cfg = require('./config');
const creds = require('./creds');

// ---------- 存取 ----------
// 同步版：只读本地文件。用于「显示一下本机登录态」（doctor / 离线场景）。
function load() {
  return creds.readLocalState();
}

// 异步版：优先问 daemon（它维护的那份通常更新）。所有真实请求走这个。
async function loadAsync() {
  return creds.loginState();
}

function save(prev, patch = {}) {
  return creds.writeLocalState({
    ua: patch.ua !== undefined ? patch.ua : (prev && prev.ua),
    cookies: patch.cookies || (prev && prev.cookies) || [],
    extra: patch.extra,
  });
}

// ---------- cookie → 请求头 ----------
// 域名 + path 双重匹配（cookie 有 path=/connsole 这种历史遗留，别混发）
function cookieHeader(cookies, host, reqPath) {
  const h = host || 'www.workbuddy.cn';
  const p = reqPath || '/';
  return cookies
    .filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '');
      const domainOk = d === h || h.endsWith('.' + d) || d === 'workbuddy.cn';
      if (!domainOk) return false;
      const cp = c.path || '/';
      return cp === '/' || p === cp || p.startsWith(cp.endsWith('/') ? cp : cp + '/');
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// 响应里的 Set-Cookie 合并回 jar。
//
// ⚠ 必须按 name+path+domain 复合键，不能只按 name：
//   服务端每次响应都会下发
//     session=; Path=/console; Max-Age=0; Expires=Thu, 01-Jan-70 ...
//   这是**删除历史遗留的 /console 路径 cookie**，不是"把 session 置空"。
//   只按 name 匹配就会把 path=/ 那条 4001 字符的好 cookie 覆盖成空值，
//   下一轮请求立刻 401（2026-11-11 亲手踩的）。
function cookieKey(c) {
  return `${c.name}|${c.path || '/'}|${String(c.domain || '').replace(/^\./, '')}`;
}

function absorbSetCookie(s, setCookies) {
  if (!setCookies || !setCookies.length) return s;
  let changed = false;
  let cookies = s.cookies.slice();

  for (const raw of setCookies) {
    const parts = raw.split(';').map((x) => x.trim());
    const first = parts.shift() || '';
    const i = first.indexOf('=');
    if (i < 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1);
    const attrs = {};
    for (const p of parts) { const k = p.indexOf('='); if (k > 0) attrs[p.slice(0, k).toLowerCase()] = p.slice(k + 1); }

    const path = attrs.path || '/';
    const domain = attrs.domain || 'www.workbuddy.cn';
    const key = cookieKey({ name, path, domain });
    const idx = cookies.findIndex((c) => cookieKey(c) === key);

    const maxAge = attrs['max-age'] !== undefined ? Number(attrs['max-age']) : null;
    const expiresAt = attrs.expires ? Math.floor(Date.parse(attrs.expires) / 1000) : null;
    const dead = (maxAge !== null && maxAge <= 0) || (expiresAt !== null && expiresAt * 1000 <= Date.now());

    if (dead) {
      if (idx >= 0) { cookies.splice(idx, 1); changed = true; }
      continue;
    }
    if (!value && maxAge === null && expiresAt === null) continue;  // 空值又没有指令，忽略（防御）

    const cur = {
      name, value, path, domain,
      expires: maxAge !== null ? Date.now() / 1000 + maxAge : expiresAt !== null ? expiresAt : (idx >= 0 ? cookies[idx].expires : -1),
      httpOnly: 'httponly' in attrs ? true : (idx >= 0 ? cookies[idx].httpOnly : false),
      secure: 'secure' in attrs ? true : (idx >= 0 ? cookies[idx].secure : true),
      sameSite: attrs.samesite || (idx >= 0 ? cookies[idx].sameSite : 'Lax'),
    };
    if (idx >= 0) {
      if (cookies[idx].value !== value || cookies[idx].expires !== cur.expires) changed = true;
      cookies[idx] = cur;
    } else { cookies.push(cur); changed = true; }
  }
  return changed ? { ...s, cookies } : s;
}

// ---------- 主请求 ----------
class AuthError extends Error {}

async function http(method, path, { body, headers, timeout = 20000, saveRolling = true } = {}) {
  const s = await loadAsync();
  if (!s || !s.cookies.length) {
    throw new AuthError('没有登录态：先跑 wbsbx login（或者 wbsbx login --import 从现有浏览器 profile 导入）');
  }
  if (!s.ua) {
    throw new AuthError('state.json 里没有 UA —— 这套接口把会话跟 UA 精确绑定，缺了就必然 401。重跑 wbsbx login 会写入。');
  }
  const h = {
    'user-agent': s.ua,
    accept: 'application/json',
    referer: cfg.AGENTS_URL,
    cookie: cookieHeader(s.cookies, undefined, path),
    ...headers,
  };
  if (body !== undefined) h['content-type'] = 'application/json';
  // 浏览器的同源 GET 不带 Origin，POST 带 —— 照抄，别自作聪明全带
  if (method !== 'GET') h.origin = cfg.ORIGIN;

  const r = await fetch(cfg.ORIGIN + path, {
    method, headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];

  if (setCookies.length && saveRolling) {
    const merged = absorbSetCookie(s, setCookies);
    if (merged !== s) { try { save(s, { cookies: merged.cookies }); } catch {} }
  }
  if (r.status === 401) {
    throw new AuthError('接口 401：登录态或 UA 对不上（UA 必须跟登录时完全一致）。跑 wbsbx login 重新登一次。');
  }
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, setCookies };
}

const get = (p, o) => http('GET', p, o);
const post = (p, body, o) => http('POST', p, { ...o, body });

// 登录态是否可用（一次轻量请求）
async function alive() {
  try {
    const r = await get('/console/as/conversations/?page=1&pageSize=1', { timeout: 15000 });
    return { ok: r.status === 200, status: r.status };
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, status: 401, reason: e.message };
    return { ok: false, status: -1, reason: e.message };
  }
}

// ---------- 从浏览器导入（login / --import 用）----------
// UA 一定要从浏览器自己身上拿：Page.navigate 里看到的 UA 才是服务端绑定的那个。
async function fromBrowser(ctx, page) {
  const cookies = await ctx.cookies(cfg.ORIGIN);
  let ua = null;
  try { ua = await page.evaluate(() => navigator.userAgent); } catch {}
  if (!ua) { try { ua = ctx._options && ctx._options.userAgent; } catch {} }
  if (!ua) throw new Error('拿不到浏览器 UA，无法建立可用登录态');
  return save({ cookies: [], ua: null }, { cookies, ua });
}

// 登录还能用几天 —— 只看 session* 那几条真正决定鉴权的。
// （别取全部 cookie 的最小值：tgw_l7_route 之类网关粘滞 cookie 常年是 0 天，会把结果带偏）
function ttlDays(cookies) {
  const now = Date.now() / 1000;
  const all = cookies || [];
  const key = all.filter((c) => /^session/i.test(c.name) && c.expires > 0);
  const use = key.length ? key : all.filter((c) => c.expires > 0);
  if (!use.length) return null;
  const min = Math.min(...use.map((c) => c.expires));
  return min > now ? (min - now) / 86400 : 0;
}

module.exports = { load, loadAsync, save, cookieHeader, absorbSetCookie, http, get, post, alive, fromBrowser, ttlDays, AuthError };
