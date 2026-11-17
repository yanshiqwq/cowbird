// WorkBuddy 控制面的 HTTP 层 —— **只走 accessToken**（Authorization: Bearer）。
//
// 历史：2026-11 之前这条路是 cookie + 登录时的 UA（APISIX 把会话跟 UA 逐字节绑定，
// 改一个字符就 401，极其脆弱）。实测 CodeBuddy 插件登录拿到的 accessToken 能打同一套
// 控制面（列表/详情/会话凭据/E2B exec 全部 200），于是 cookie 模式整条删掉：
//   · 不用维护 cookie jar，也就没有「UA 必须一字不差」这种坑；
//   · 不用浏览器，登录是"打印链接 + 轮询"；
//   · 有 refreshToken，过期自动续。
const cfg = require('../../../config');
const C = require('../constants');
const tokenStore = require('../token-store');
const deviceLogin = require('../device-login');

class AuthError extends Error {}

/**
 * 发一个控制面请求。
 * @param {'GET'|'POST'|'DELETE'|'PATCH'} method
 * @param {string} path  以 / 开头的路径
 */
async function http(method, path, { body, headers, timeout = 20000 } = {}) {
  const tk = await tokenStore.usable();
  if (!tk) {
    throw new AuthError('没有可用的 accessToken：先跑 wbsbx login --print-only（打印链接授权）');
  }
  const h = {
    'user-agent': deviceLogin.UA,
    accept: 'application/json',
    authorization: 'Bearer ' + tk.accessToken,
    referer: C.AGENTS_URL,
    ...headers,
  };
  if (body !== undefined) h['content-type'] = 'application/json';
  // 浏览器的同源 GET 不带 Origin，POST 带 —— 照抄，别自作聪明全带
  if (method !== 'GET' && !h.origin) h.origin = C.ORIGIN;

  const send = async (hdrs) => {
    const r = await fetch(C.ORIGIN + path, {
      method,
      headers: hdrs,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(timeout),
    });
    return { r, text: await r.text() };
  };

  let { r, text } = await send(h);
  if (r.status === 401) {
    // token 可能刚被服务端作废：续一次再试（只试一次，避免死循环）
    try {
      const fresh = await tokenStore.refresh(tk);
      h.authorization = 'Bearer ' + fresh.accessToken;
      ({ r, text } = await send(h));
    } catch { /* 续不了就走下面的统一错误 */ }
  }
  if (r.status === 401) {
    throw new AuthError('接口 401：accessToken 失效且续期失败。重跑 wbsbx login --print-only 授权。');
  }

  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, ok: r.ok, text, json };
}

const get = (p, o) => http('GET', p, o);
const post = (p, body, o) => http('POST', p, { ...o, body });

/** 登录态是否可用（一次轻量请求） */
async function alive() {
  try {
    const r = await get('/console/as/conversations/?page=1&pageSize=1', { timeout: 15000 });
    return { ok: r.status === 200, status: r.status };
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, status: 401, reason: e.message };
    return { ok: false, status: -1, reason: e.message };
  }
}

module.exports = { http, get, post, alive, AuthError };
