// 无头登录（不需要本地浏览器）：借用 CodeBuddy CLI 的官方插件登录接口。
//
// 协议（实测，2026-11-17）：
//   POST https://copilot.tencent.com/v2/plugin/auth/state?platform=VSCode   （不需要鉴权）
//     → {code:0, data:{state, authUrl}}
//        authUrl = https://copilot.tencent.com/login?platform=VSCode&state=<uuid>
//        这个 authUrl 就是二维码里编的东西 —— 把它打印出来，用户在任意设备打开即可。
//   GET  /v2/plugin/auth/token?state=<state>   （头 X-No-Authorization: 1）
//     未扫码 → {code:11217, msg:"login ing..."}
//     已授权 → {code:0, data:{accessToken, refreshToken, expiresIn, domain}}
//   GET  /v2/plugin/login/account?state=<state>   （Bearer <accessToken>）
//     → 账号信息（uid / nickname / enterpriseId）
//   POST /v2/plugin/auth/token/refresh  → 续 accessToken
//
// ⚠ 这套 token 属于**插件/CLI 那条 API**（/v2/chat/completions）。
//   我们控制面用的是 www.workbuddy.cn/console/as/*（cookie + UA 绑定），
//   两者是否互通**尚未验证** —— 所以这里只负责把 token 拿到手，并由 probeConsole()
//   去实测它能不能打控制面；不能就如实告诉用户"控制面仍需 cookie 登录"。
'use strict';

const BASE = 'https://copilot.tencent.com';
const UA = 'CLI/2.143.1 CodeBuddy/2.143.1';
const ORIGIN = 'https://www.codebuddy.cn';

const HEAD = {
  'user-agent': UA,
  'x-client-id': 'codebuddy-cli',
  'x-client-version': '2.143.1',
  'x-product': 'SaaS',
  origin: ORIGIN,
  referer: ORIGIN + '/',
};

const PENDING_CODE = 11217;

async function req(method, path, { body, token, extraHeaders } = {}) {
  const h = { ...HEAD, ...(extraHeaders || {}) };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（比如 APISIX 的 401 页面） */ }
  return { status: r.status, json, text };
}

/** 开始一次无头登录：拿到 state 与给用户打开的链接 */
async function start({ platform = 'VSCode' } = {}) {
  const r = await req('POST', `/v2/plugin/auth/state?platform=${encodeURIComponent(platform)}`, { body: {} });
  const d = (r.json && r.json.data) || {};
  if (!d.state || !d.authUrl) {
    throw new Error(`拿登录态失败：http=${r.status} ${String(r.text).slice(0, 200)}`);
  }
  return { state: d.state, url: d.authUrl, platform };
}

/**
 * 轮询一次。返回：
 *   { status:'pending' }                         还没扫码
 *   { status:'done', token }                     已授权
 *   { status:'failed', error }                   登录失败
 */
async function poll(state) {
  const r = await req('GET', `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
    extraHeaders: { 'x-no-authorization': '1' },
  });
  const j = r.json || {};
  if (j.code === 0 && j.data && (j.data.accessToken || j.data.AccessToken)) {
    const d = j.data;
    return {
      status: 'done',
      token: {
        accessToken: d.accessToken || d.AccessToken,
        refreshToken: d.refreshToken || d.RefreshToken || '',
        expiresIn: Number(d.expiresIn || d.ExpiresIn) || 0,
        domain: d.domain || d.Domain || '',
      },
    };
  }
  if (j.code === PENDING_CODE || /login ing/i.test(String(j.msg || ''))) return { status: 'pending' };
  if (r.status === 0 || j.code === undefined) {
    return { status: 'failed', error: `轮询失败：http=${r.status} ${String(r.text).slice(0, 160)}` };
  }
  return { status: 'failed', error: `${j.code || r.status} ${j.msg || ''}`.trim() };
}

/** 用 accessToken 取账号信息（拿不到就返回 null，不影响登录成功） */
async function account(state, token) {
  try {
    const r = await req('GET', `/v2/plugin/login/account?state=${encodeURIComponent(state)}`, { token });
    const d = (r.json && (r.json.data || r.json)) || null;
    if (!d) return null;
    return {
      uid: d.uid || d.UID || null,
      nickname: d.nickname || d.NickName || d.nickName || null,
      enterpriseId: d.enterpriseId || d.EnterpriseID || null,
    };
  } catch {
    return null;
  }
}

/**
 * 实测：这个 accessToken 能不能打我们的控制面（cookie+UA 那套）。
 * 只发一次 GET，不写任何东西。
 */
async function probeConsole(token) {
  try {
    const r = await fetch('https://www.workbuddy.cn/console/as/conversations/?page=1&pageSize=1', {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + token,
        referer: 'https://www.workbuddy.cn/agents/',
        'user-agent': UA,
      },
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    return { ok: r.status === 200 && /^[[{]/.test(text.trim()), status: r.status, sample: text.slice(0, 120) };
  } catch (e) {
    return { ok: false, status: 0, sample: String(e.message).slice(0, 120) };
  }
}

module.exports = { start, poll, account, probeConsole, BASE, UA, PENDING_CODE };
