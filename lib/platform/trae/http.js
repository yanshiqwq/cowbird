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
// 发送/超时/JSON 解析走 lib/platform/http.js；cookie 拼头走 lib/platform/cookie.js。
const auth = require('./auth');
const constants = require('./constants');
const http = require('../http');
const cookie = require('../cookie');

class ApiError extends Error {
  constructor(message, { status = null, code = null, json = null, retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.json = json;
    if (retryable) this.retryable = true;
  }
}

class AuthError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AuthError';
    this.code = 'E_NOT_AUTH';
    this.auth = true;
    this.detail = detail || null;
  }
}

const TOKEN_KEY = 'token';
const REFRESH_MARGIN_MS = 5 * 60e3;

/** cookie 头：只发 .trae.cn 能用的那几条（早先是"全发"，换账号时会把无关 cookie 带出去） */
function cookiesHeader(st) {
  return cookie.header((st && st.cookies) || [], {
    host: 'work.trae.cn',
    extraDomains: ['trae.cn'],
  });
}

// 每个 ctx 一份（selftest 就靠"先取再打桩"来注入假传输）
const cache = new WeakMap();

function createTransport(ctx) {
  if (ctx && typeof ctx === 'object' && cache.has(ctx)) return cache.get(ctx);

  const ua = constants.UA;

  // 每次请求现读登录态：重新粘过 cookie 之后不必重建 transport
  const current = () => auth.read(ctx) || {};

  function baseHeaders(st) {
    const s = st || current();
    return {
      'user-agent': ua,
      cookie: cookiesHeader(s),
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

  let inflight = null;
  /** 拿（或换）Cloud-IDE-JWT：缓存命中就直接用，否则打 GetUserToken */
  async function token() {
    const hit = cachedToken();
    if (hit) return hit.token;
    if (inflight) return inflight;
    inflight = (async () => {
      const r = await t.cloudide('POST', constants.Ep.userToken, { ReqSource: 'Web' });
      const jwt = r.json && r.json.Result && r.json.Result.Token;
      if (r.status !== 200 || !jwt) {
        throw new AuthError(`换不到 Cloud-IDE-JWT（http=${r.status}）：cookie 可能过期了`, r.json || r.text);
      }
      const exp = Date.parse((r.json.Result && r.json.Result.ExpiredAt) || 0) || Date.now() + 3600e3;
      const rec = { token: jwt, exp };
      try { ctx.store.write(TOKEN_KEY, rec); } catch { /* 缓存失败也能继续 */ }
      return jwt;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  /** 统一的一次发送：网络/超时错误翻成 ApiError（带可重试标记） */
  async function send(url, { method = 'GET', headers, body, timeoutMs = 20000, label = '' } = {}) {
    try {
      const res = await http.fetchWithTimeout(url, { method, headers, body, timeoutMs });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text, json: http.tryJson(text) };
    } catch (e) {
      throw new ApiError(`连不上${label ? ' ' + label : ''} ${url}：${(e && e.message) || e}`,
        { code: e && e.code, retryable: !!(e && e.retryable) });
    }
  }

  const t = {
    base: constants.SITE,
    /** 数据面（沙箱网关）要的那把 JWT，暴露给 fs/ws 用 */
    cloudideToken: () => token(),
    /** 网站 API（api.trae.cn 那套：登录态/用户信息/换 token） */
    async cloudide(method, path, body, { timeoutMs = 20000 } = {}) {
      const url = constants.API + path;
      const headers = { ...baseHeaders(), 'content-type': 'application/json', accept: 'application/json' };
      return send(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
        label: 'TRAE 网站 API',
      });
    },

    /** 远端控制面（同源 /api/remote/v1/*）：自动带 Cloud-IDE-JWT */
    async request(method, path, { body, timeoutMs = 30000, retryAuth = true } = {}) {
      const st = current();
      if (!auth.isLoggedIn(st)) {
        throw new AuthError('没有 TRAE 登录态：先跑 `cowbird --platform trae login --cookie "<串>"`（网页版没有可脚本化的登录流）');
      }
      const jwt = await token();
      const headers = {
        ...baseHeaders(st),
        accept: 'application/json, text/plain, */*',
        'x-cloudide-token': jwt,
        authorization: 'Cloud-IDE-JWT ' + jwt,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const r = await send(t.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
        label: 'TRAE 控制面',
      });
      // 401 两种形态：HTTP 401，或 200 里 {code:401}
      const unauthorized = r.status === 401 || (r.json && r.json.code === 401);
      if (unauthorized && retryAuth) {
        try { ctx.store.remove(TOKEN_KEY); } catch { /* 忽略 */ }
        return t.request(method, path, { body, timeoutMs, retryAuth: false });
      }
      if (unauthorized) throw new AuthError('TRAE 控制面回 401：登录态失效，重新粘一次 cookie', r.json || r.text);
      if (!r.ok || (r.json && r.json.code !== 0 && r.json.code !== undefined)) {
        const msg = (r.json && (r.json.message || r.json.msg)) || r.text.slice(0, 200) || `http=${r.status}`;
        throw new ApiError(`TRAE ${method} ${path} 失败：${msg}`, { status: r.status, code: r.json && r.json.code, json: r.json });
      }
      return r.json || {};
    },

    /**
     * 沙箱数据面的 HTTP 请求。**和远端控制面的头不一样**：
     *   Authorization: Cloud-IDE-JWT <jwt>   ← 字面 scheme 名，不是 Bearer
     *   X-Trae-Client-Type: web
     * 少一个就 401（而且错误体会伪装成"控制面鉴权失败"，很有误导性）。
     */
    async dataRequest(explorerUrl, method, path, { body, raw, contentType, timeoutMs = 20000 } = {}) {
      const jwt = await token();
      const url = String(explorerUrl).replace(/\/+$/, '') + path;
      const headers = {
        authorization: 'Cloud-IDE-JWT ' + jwt,
        'x-trae-client-type': 'web',
        'x-trae-user-timezone': 'Asia/Shanghai',
        'user-agent': ua,
        referer: constants.SITE + '/',
        accept: '*/*',
      };
      // raw=true：body 原样发（写文件就是这条 —— 数据面把 body 直接当文件内容落盘，
      // 发 {content:...} 会把整段 JSON 写进文件，bash 跑起来第一行就语法错误）
      if (body !== undefined) headers['content-type'] = raw ? (contentType || 'text/plain; charset=utf-8') : 'application/json';
      const r = await send(url, {
        method,
        headers,
        body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
        timeoutMs,
        label: '沙箱数据面',
      });
      if (r.status === 401) throw new AuthError('沙箱数据面回 401：Cloud-IDE-JWT 可能过期（换一次再试）', r.json || r.text.slice(0, 200));
      return r;
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
