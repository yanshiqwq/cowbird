// TRAE 的 HTTP 层：三条实测出来的规矩。
//
// 1. **远端控制面是同源的** `/api/remote/v1/*`（`https://work.trae.cn`），不是 `api.trae.cn`。
//    我开始按 `api.trae.cn/api/remote/v1/...` 打，回的是 TLB 的 404 —— 别重犯。
// 2. **两层令牌**：
//      cookie（.trae.cn）  ──POST /cloudide/api/v3/common/GetUserToken──▶  Cloud-IDE-JWT（8h）
//      Cloud-IDE-JWT 用 `x-cloudide-token: <jwt>` 头（另有 `authorization: Cloud-IDE-JWT <jwt>` 并存）
//    只带 cookie 打 /api/remote/v1 会 401 `{"code":401,"message":"authentication required"}`。
// 3. 少一个 `referer: https://work.trae.cn/` 或 `origin` 时会被挡（与浏览器行为对齐）。
//
// 令牌只在内存 + ctx.store 里缓存（按账号目录），过期前 5 分钟自动换。
const auth = require('./auth');
const constants = require('./constants');

class ApiError extends Error {
  constructor(message, { status = null, code = null, json = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.json = json;
  }
}

class AuthError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AuthError';
    this.code = 'E_NOT_LOGGED_IN';
    this.auth = true;
    this.detail = detail || null;
  }
}

const TOKEN_KEY = 'token';
const REFRESH_MARGIN_MS = 5 * 60e3;

function cookiesHeader(st) {
  return (st.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
}

// 每个 ctx 一份（selftest 就靠"先取再打桩"来注入假传输）
const cache = new WeakMap();

function createTransport(ctx) {
  if (ctx && typeof ctx === 'object' && cache.has(ctx)) return cache.get(ctx);

  const st = auth.read(ctx);
  const ua = constants.UA;

  function baseHeaders() {
    return {
      'user-agent': ua,
      cookie: cookiesHeader(st || { cookies: [] }),
      referer: constants.SITE + '/',
      origin: constants.SITE,
      'accept-language': 'zh-CN,zh;q=0.9',
    };
  }

  function cachedToken() {
    try {
      const t = ctx.store.read(TOKEN_KEY);
      if (t && t.token && Number(t.exp) - Date.now() > REFRESH_MARGIN_MS) return t;
    } catch { /* 没缓存 */ }
    return null;
  }

  const t = {
    base: constants.SITE,
    /** 网站 API（api.trae.cn 那套：登录态/用户信息/换 token） */
    async cloudide(method, path, body, { timeoutMs = 20000 } = {}) {
      const url = constants.API + path;
      const headers = { ...baseHeaders(), 'content-type': 'application/json', accept: 'application/json' };
      let r;
      try {
        r = await fetch(url, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new ApiError(`连不上 ${url}：${e.message}`);
      }
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      return { status: r.status, ok: r.ok, text, json };
    },

    /** 远端控制面（同源 /api/remote/v1/*）：自动带 Cloud-IDE-JWT */
    async request(method, path, { body, timeoutMs = 30000, retryAuth = true } = {}) {
      if (!auth.isLoggedIn(st)) {
        throw new AuthError('没有 TRAE 登录态：先跑 `cowbird --platform trae login --cookie "<串>"`（网页版没有可脚本化的登录流）');
      }
      let tok = cachedToken();
      if (!tok) {
        const r = await t.cloudide('POST', '/cloudide/api/v3/common/GetUserToken', { ReqSource: 'Web' });
        const jwt = r.json && r.json.Result && r.json.Result.Token;
        if (r.status !== 200 || !jwt) {
          throw new AuthError(`换不到 Cloud-IDE-JWT（http=${r.status}）：cookie 可能过期了`, r.json || r.text);
        }
        const exp = Date.parse((r.json.Result && r.json.Result.ExpiredAt) || 0) || Date.now() + 3600e3;
        tok = { token: jwt, exp };
        try { ctx.store.write(TOKEN_KEY, tok); } catch { /* 缓存失败也能继续 */ }
      }
      const headers = {
        ...baseHeaders(),
        accept: 'application/json, text/plain, */*',
        'x-cloudide-token': tok.token,
        authorization: 'Cloud-IDE-JWT ' + tok.token,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const url = t.base + path;
      let r;
      try {
        r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new ApiError(`连不上 ${url}：${e.message}`);
      }
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      // 401 两种形态：HTTP 401，或 200 里 {code:401}
      const unauthorized = r.status === 401 || (json && json.code === 401);
      if (unauthorized && retryAuth) {
        try { ctx.store.remove(TOKEN_KEY); } catch { /* 忽略 */ }
        return t.request(method, path, { body, timeoutMs, retryAuth: false });
      }
      if (unauthorized) throw new AuthError('TRAE 控制面回 401：登录态失效，重新粘一次 cookie', json || text);
      if (!r.ok || (json && json.code !== 0 && json.code !== undefined)) {
        const msg = (json && (json.message || json.msg)) || text.slice(0, 200) || `http=${r.status}`;
        throw new ApiError(`TRAE ${method} ${path} 失败：${msg}`, { status: r.status, code: json && json.code, json });
      }
      return json || {};
    },

    /** 会话级令牌（2h，aud=trae-resource）——给将来的沙箱数据面用，现在只做能力预留 */
    async sessionToken(sessionId) {
      const j = await t.request('POST', `/api/remote/v1/auth/session/${encodeURIComponent(sessionId)}/token`, { body: {} });
      return (j && j.data) || {};
    },
  };

  if (ctx && typeof ctx === 'object') cache.set(ctx, t);
  return t;
}

module.exports = { createTransport, ApiError, AuthError, TOKEN_KEY };
