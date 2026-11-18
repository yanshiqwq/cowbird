// Qoder 的 HTTP 传输层：cookie 鉴权 + 平台要求的两个头 + 401 → AuthError。
//
// 实测事实（2026-11-17）：
//   - 鉴权**只用 cookie**，不绑 UA（把 UA 换成 curl/8.5.0 照样 200）；
//   - 每个请求都要 `x-requested-with: XMLHttpRequest`；
//   - `/api/v1/remote/*` 还要 `X-Qoder-Remote-Api-Version: 4`；
//   - 未登录是干净的 401 JSON：业务接口 `{"errorCode":"Unauthorized"}`，
//     remote 接口 `{"code":"UNAUTHORIZED","message":"missing cookie header"}`；
//   - CSRF 头不需要（XSRF-TOKEN cookie 在，但 POST 不带也成功）。
//
// 这里只做一件事：把「cookie 快照 + 路径」变成一次干净的请求，其余判断留给调用方。
'use strict';
const wire = require('./wire');
const cookie = require('../cookie');
const http = require('../http');

/** 登录态问题统一用它，内核据此提示「去 login」而不是「去查网络」 */
class AuthError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'AuthError';
    this.code = 'E_AUTH';
    if (extra) Object.assign(this, extra);
  }
}

// ---------------- cookie 快照 ----------------

/** 读登录态快照（不存在就是空对象，不抛） */
function readAuth(ctx) {
  try {
    const st = ctx && ctx.store && ctx.store.read('auth', null);
    return st && typeof st === 'object' ? st : {};
  } catch { return {}; }
}

function writeAuth(ctx, st) {
  // 登录态是凭据：写失败要炸（login 会当场报错），不能静默
  if (ctx && ctx.store && ctx.store.writeStrict) ctx.store.writeStrict('auth', st);
  else if (ctx && ctx.store && ctx.store.write) ctx.store.write('auth', st);
}

/**
 * 拼 Cookie 头。快照支持两种形态：
 *   - { cookie: 'a=1; b=2' }              —— 直接粘的一整条（login --cookie 用）
 *   - { cookies: [{name,value,domain,path}] } —— 浏览器导出的数组（首选）
 * 域名/路径都要匹配：passport.aliyun.com 的 SSO cookie 不该跟着发到 qoder.cn 业务接口。
 */
function cookieHeader(st, host = 'qoder.cn', reqPath = '/') {
  if (!st) return '';
  if (typeof st.cookie === 'string' && st.cookie.trim()) return st.cookie.trim();
  const jar = Array.isArray(st.cookies) ? st.cookies : [];
  return cookie.header(jar, { host, path: reqPath });
}

function hasLogin(st) {
  return !!cookieHeader(st, 'qoder.cn', '/');
}

function cookieKey(c) {
  return cookie.key(c);
}

/**
 * 把 Set-Cookie 并回快照。只在 2xx 时调用 —— 401 的响应体里常带
 * `session=; Max-Age=0`（服务端在清理失效会话），照收会把还能救的登录态清空。
 * 复合键 name|path|domain，不能只按 name（同一个 name 可能有 / 和 /console 两条）。
 */
function mergeSetCookies(st, setCookies) {
  const prev = st && typeof st === 'object' ? st : {};
  const jar = Array.isArray(prev.cookies) ? prev.cookies : [];
  const r = cookie.absorb(jar, setCookies, { defaultDomain: 'qoder.cn' });
  return r.changed ? { ...prev, cookies: r.cookies } : prev;
}

// ---------------- 请求 ----------------

function buildUrl(path, query) {
  const p = String(path || '');
  const base = /^https?:\/\//i.test(p) ? p : wire.ORIGIN + (p.startsWith('/') ? p : '/' + p);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${base}${base.includes('?') ? '&' : '?'}${s}` : base;
}

function baseHeaders(st, method, path, body, extra) {
  const h = {
    accept: 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    referer: `${wire.ORIGIN}/agents`,
    cookie: cookieHeader(st, 'qoder.cn', path),
    ...(extra || {}),
  };
  // remote 系接口要版本头（实测缺了会被当旧客户端）
  if (String(path).startsWith(wire.API_PREFIX)) h['x-qoder-remote-api-version'] = '4';
  if (body !== undefined) h['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') h.origin = wire.ORIGIN;
  return h;
}

function authErrorFrom(text, json) {
  const detail = (json && (json.errorCode || json.code || json.errorMessage || json.message)) || String(text || '').slice(0, 120) || '401';
  return new AuthError(`Qoder 401：登录态无效（${detail}）。重跑 cowbird login 换一份 cookie。`, { status: 401, detail });
}

/**
 * @param {Function} [fetchImpl] 注入的 fetch（selftest 用假的，平时就是全局 fetch）
 */
function createTransport(fetchImpl) {
  const f = fetchImpl || ((url, init) => globalThis.fetch(url, init));

  /**
   * 发一次请求。
   * @returns {Promise<{status,ok,text,json,headers,setCookies}>}
   *   —— 只有网络错误/超时/401 会抛；4xx/5xx 原样返回，让调用方按业务语义处理。
   */
  async function request(ctx, method, path, opts = {}) {
    const { query, body, headers: extra, timeout = 20000, signal, absorbCookies = true } = opts;
    const st = readAuth(ctx);
    if (!hasLogin(st)) {
      throw new AuthError('没有 Qoder 登录态：先跑 cowbird login（或 login --cookie "acw_tc=…; qoder_visitor_id=…" 粘一份浏览器里的 cookie）。');
    }

    let res;
    try {
      res = await http.fetchWithTimeout(buildUrl(path, query), {
        method,
        headers: baseHeaders(st, method, path, body, extra),
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        timeoutMs: timeout,
        signal,
        fetchImpl: f,
      });
    } catch (e) {
      const x = new Error(e.code === 'E_TIMEOUT'
        ? `请求超时（${timeout}ms）：${method} ${path}`
        : `网络错误：${method} ${path} → ${(e && e.message) || e}`);
      x.code = e.code || 'E_NETWORK';
      x.cause = e;
      throw x;
    }

    const text = await res.text();
    const json = http.tryJson(text);
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];

    if (absorbCookies && res.status >= 200 && res.status < 300 && setCookies.length) {
      try {
        const next = mergeSetCookies(st, setCookies);
        if (next !== st) writeAuth(ctx, next);
      } catch {}
    }
    if (res.status === 401) throw authErrorFrom(text, json);

    return { status: res.status, ok: res.status >= 200 && res.status < 300, text, json, headers: res.headers, setCookies };
  }

  /**
   * 读 SSE 流（全局会话状态用）。回调式；流断/超时都往上抛，由调用方决定要不要重连。
   */
  async function stream(ctx, path, opts = {}) {
    const { query, signal, onEvent, timeout = 0 } = opts;
    const st = readAuth(ctx);
    if (!hasLogin(st)) throw new AuthError('没有 Qoder 登录态：先跑 cowbird login。');

    const controller = new AbortController();
    const relay = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', relay, { once: true });
    }
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;

    try {
      const res = await f(buildUrl(path, query), {
        method: 'GET',
        headers: { ...baseHeaders(st, 'GET', path), accept: 'text/event-stream', 'cache-control': 'no-cache' },
        signal: controller.signal,
      });
      if (res.status === 401) throw authErrorFrom('', null);
      if (!res.ok || !res.body) {
        const e = new Error(`订阅 ${path} 失败（HTTP ${res.status}）`);
        e.code = 'E_STREAM';
        e.status = res.status;
        throw e;
      }

      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let m;
        while ((m = buf.match(/\r?\n\r?\n/))) {
          const idx = m.index;
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + m[0].length);
          const frame = wire.parseSseBlock(block);
          if (frame.data !== null && onEvent) await onEvent(frame);
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) { try { signal.removeEventListener('abort', relay); } catch {} }
    }
  }

  return { request, stream, AuthError, buildUrl, baseHeaders };
}

module.exports = { createTransport, AuthError, cookieHeader, hasLogin, mergeSetCookies, readAuth, writeAuth, buildUrl, baseHeaders };
