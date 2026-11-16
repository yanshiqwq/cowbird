// 登录态续期：靠底下的 Keycloak SSO 会话，把 7 天硬顶的 session cookie 换成新的。
//
// 为什么需要它：session / session_2 的 expires 恒等于「首次下发 + 7 天」，
// 单纯刷新 token 不会延期。但 Keycloak 那边的 SSO 会话还在，注入 KEYCLOAK_* cookie
// 打开一次授权页，Keycloak 认出已登录 → 302 回 APISIX → 换发新的 +7 天 session。
// 全程无人工，几秒钟。
//
// ⚠ 必须用「原来那个 UA」起浏览器。
//   服务端把 session 跟 UA 绑定，用默认 headless UA 换来的 session，之后纯 HTTP 请求会 401 ——
//   表现为「续期显示成功，但 CLI 立刻就登不上了」，极难查。
const cfg = require('../config');
const creds = require('../creds');
const browser = require('../browser');

const APISIX_CB = 'https://www.workbuddy.cn/console/accounts/.apisix/redirect';
const ONE_YEAR = Math.floor(Date.now() / 1000) + 365 * 86400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const authUrl = (clientId, redirect, state) => {
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect,
    scope: 'openid offline_access', state,
  });
  return 'https://www.workbuddy.cn/auth/realms/copilot/protocol/openid-connect/auth?' + q.toString();
};

function shape(c, extra = {}) {
  return {
    name: c.name, value: c.value,
    domain: c.domain, path: c.path || '/',
    expires: c.expires > 0 ? c.expires : -1,
    httpOnly: !!c.httpOnly, secure: c.secure !== false,
    sameSite: (c.sameSite === 'Strict' || c.sameSite === 'None') ? c.sameSite : 'Lax',
    ...extra,
  };
}

// 自证：拿新 cookie 在页面里打一次真接口，通了才算数（宁可不写，也不写一份坏的进去）
async function verify(page, ids) {
  if (!ids.length) return { ok: null, detail: '没有可自证的实例 id' };
  const out = await page.evaluate(async (list) => {
    const r = [];
    for (const id of list.slice(0, 3)) {
      try {
        const x = await fetch('/console/as/conversations/' + id, { credentials: 'include' });
        r.push({ id, s: x.status, t: (await x.text()).slice(0, 120) });
      } catch (e) { r.push({ id, s: 0, t: String(e) }); }
    }
    return r;
  }, ids);
  const bad = out.filter((x) => x.s !== 200);
  return { ok: bad.length === 0, detail: out.map((x) => `${x.id}:${x.s}`).join(' ') };
}

async function runRenew({ verifyIds = [], dry = false } = {}, log = () => {}) {
  const st = creds.readLocalState();
  if (!st || !st.cookies || !st.cookies.length) {
    return { ok: false, code: 'NO_STATE', message: '没有登录态，先跑 wbsbx login' };
  }
  const sso = st.cookies.filter((c) => /KEYCLOAK_/i.test(c.name));
  if (!sso.length) {
    return { ok: false, code: 'NO_SSO', message: '登录态里没有 Keycloak cookie（旧版登录态），需要重新 wbsbx login 一次' };
  }
  if (!browser.hasPlaywright()) {
    return { ok: false, code: 'NO_BROWSER', message: '没装 playwright-core，无法走浏览器续期' };
  }

  log(`开始续期（注入 ${sso.length} 条 Keycloak cookie）`);
  const { browser: b, ctx } = await browser.launchEphemeral({ headless: true, userAgent: st.ua });
  try {
    await ctx.addCookies(sso.map((c) => shape(c, { expires: ONE_YEAR })));
    const page = await ctx.newPage();
    await page.goto(authUrl('console', APISIX_CB, 'r' + Date.now().toString(36)), {
      waitUntil: 'domcontentloaded', timeout: 45000,
    }).catch((e) => log('授权页跳转异常：' + String(e.message).slice(0, 120)));

    for (let i = 0; i < 7; i++) await sleep(700);   // 给 302 链和前端脚本一点时间
    const finalUrl = page.url();
    if (/\/login|\/auth\/realms/.test(finalUrl)) {
      log('被踢回登录页 —— Keycloak SSO 会话已失效，需要人工重新登录', { url: finalUrl.slice(0, 120) });
      return { ok: false, code: 'KICKED', message: 'SSO 会话失效，需要人工 wbsbx login' };
    }

    const all = await ctx.cookies();
    const fresh = all.filter((c) => /workbuddy/.test(c.domain || '') && !/KEYCLOAK_/i.test(c.name));
    if (!fresh.length) return { ok: false, code: 'NO_SESSION', message: '没拿到新的 session cookie' };

    const v = await verify(page, verifyIds);
    if (v.ok === false) {
      log('新 session 打不通接口，本次不写盘', { detail: v.detail });
      return { ok: false, code: 'VERIFY_FAILED', message: '新 cookie 自证失败：' + v.detail };
    }

    const expired = fresh.filter((c) => c.expires > 0);
    const ttl = expired.length ? Math.min(...expired.map((c) => c.expires)) : null;
    if (dry) return { ok: true, dry: true, ttl, verify: v.detail };

    // 保留原 UA：这份 cookie 是用它换来的，UA 一换全部作废
    creds.writeLocalState({
      ua: st.ua,
      cookies: [...fresh.map(shape), ...sso.map(shape)].filter(
        (c, i, arr) => arr.findIndex((x) => x.name === c.name && x.path === c.path && x.domain === c.domain) === i
      ),
    });
    log('续期成功', { ttl: ttl ? new Date(ttl * 1000).toISOString().slice(0, 16) : 'unknown' });
    return { ok: true, ttl, verify: v.detail };
  } finally {
    try { await b.close(); } catch {}
  }
}

module.exports = { runRenew };
