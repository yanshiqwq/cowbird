// TRAE 的登录态：**cookies 就是全部**（.trae.cn 域，含 HttpOnly 的 sessionid / sid_guard /
// X-Cloudide-Session / ttwid）。所有 API 调用都靠它换出 8h 的 Cloud-IDE-JWT，再带
// `x-cloudide-token` 头。
//
// 实测（2026-11-17）：控制面没有 bearer/cookie 之外的鉴权方式；STS 式的设备码/扫码
// 都需要装华为云那种客户端，TRAE 这边网页版就是 cookie。所以 login 只支持粘 cookie：
//   DevTools → Console: document.cookie                        （非 HttpOnly 那部分）
//   DevTools → Application → Cookies 里补 sessionid / sid_guard / X-Cloudide-Session
// 登录后 daemon 的 warm 循环会每 10 分钟 CheckLogin 一次，让服务端把会话当活跃。
const KEY = 'auth';
const DOMAIN = '.trae.cn';

/** 粘进来的 `a=1; b=2` → cookie 数组（同名后者覆盖） */
function parseCookieString(raw) {
  const out = new Map();
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name) continue;
    out.set(name, { name, value, domain: DOMAIN, path: '/' });
  }
  return [...out.values()];
}

function read(ctx) {
  try { return (ctx && ctx.store && ctx.store.read(KEY)) || null; } catch { return null; }
}

function save(ctx, st) {
  const out = { savedAt: new Date().toISOString(), source: 'paste', ...st, cookies: (st && st.cookies) || [] };
  try { if (ctx && ctx.store) ctx.store.write(KEY, out); } catch { /* 落盘失败不影响本次 */ }
  return out;
}

function clear(ctx) {
  try { if (ctx && ctx.store) ctx.store.remove(KEY); } catch { /* 本来就没有 */ }
}

function cookieValue(cookies, name) {
  const hit = (cookies || []).find((c) => c && c.name === name);
  return hit ? String(hit.value === undefined ? '' : hit.value) : null;
}

/** 有没有登录态：至少要有 sessionid（其余是附随） */
function isLoggedIn(st) {
  if (!st || !Array.isArray(st.cookies) || !st.cookies.length) return false;
  return Boolean(cookieValue(st.cookies, 'sessionid') || cookieValue(st.cookies, 'sid_tt') || cookieValue(st.cookies, 'X-Cloudide-Session'));
}

/** 业务 cookie 的可读摘要（doctor/account ls 用；不泄露值） */
async function state(ctx) {
  const st = read(ctx);
  if (!isLoggedIn(st)) return null;
  return {
    token: null,                                  // 这一层没有 bearer token，只有 cookie
    cookies: st.cookies.length,
    hasSession: Boolean(cookieValue(st.cookies, 'sessionid')),
    hasCloudideSession: Boolean(cookieValue(st.cookies, 'X-Cloudide-Session')),
    savedAt: st.savedAt || null,
    expiresAt: null,                              // 都是 session cookie，没有固定期限
    ttlDays: null,
    source: st.source || 'unknown',
  };
}

/** cookie 型平台没有固定期限 —— 返回 null 表示"未知"，不是"已过期" */
function ttlDays() { return null; }

/** 登录：只接受粘 cookie（网页版没有可脚本化的登录流） */
async function login(ctx, opts = {}) {
  const raw = String(opts.cookie || '').trim();
  if (!raw) {
    throw new Error(
      'TRAE 登录需要粘 cookie（网页版没有可脚本化的登录流）：\n' +
      '  1) 浏览器打开 https://work.trae.cn/ 并登录\n' +
      '  2) DevTools → Console 执行 document.cookie，复制整串\n' +
      '  3) Application → Cookies → https://work.trae.cn 里补上 HttpOnly 的\n' +
      '     sessionid / sid_guard / X-Cloudide-Session（名字照抄即可）\n' +
      '  4) cowbird --platform trae login --cookie "<整串>"'
    );
  }
  const cookies = parseCookieString(raw);
  if (!cookies.length) throw new Error('这串 cookie 里一条都解析不出来（格式应为 a=1; b=2; …）');
  if (!cookieValue(cookies, 'sessionid') && !cookieValue(cookies, 'sid_tt')) {
    throw new Error('这串 cookie 里没有 sessionid —— 它看起来不是 TRAE（.trae.cn）的登录态');
  }
  const st = save(ctx, { cookies, source: 'paste' });
  return { ok: true, user: null, cookieCount: cookies.length, savedAt: st.savedAt };
}

/** 登录态还能不能用（会打一次真接口；daemon 的 warm 循环用它） */
async function alive(ctx) {
  const transport = require('./http');
  const t = transport.createTransport(ctx);
  try {
    const r = await t.cloudide('POST', '/cloudide/api/v3/trae/CheckLogin', { ReqSource: 'Web' });
    return { ok: r.status === 200, status: r.status, json: r.json };
  } catch (e) {
    return { ok: false, status: e.status || -1, reason: String(e.message).slice(0, 200), code: e.code || null };
  }
}

module.exports = { KEY, DOMAIN, parseCookieString, read, save, clear, cookieValue, isLoggedIn, state, ttlDays, login, alive };
