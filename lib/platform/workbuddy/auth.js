'use strict';
// 登录态：cookie jar + UA（APISIX 把会话跟 User-Agent 逐字节绑定，UA 换一个字符就 401）。
//
// 这里只做适配，真正的实现都在仓库既有模块里：
//   读态        lib/creds.js  readLocalState / loginState
//   扫码登录    ./login-flow.js（浏览器流程在本目录里，内核不再认识它）
//   SSO 续期    lib/daemon/renew.js（注入 Keycloak cookie 换新的 +7 天 session）
//   还能用几天  lib/session.js  ttlDays
const creds = require('../../creds');
const session = require('../../session');
const cloud = require('../../cloud');
const browser = require('../../browser');
const { logf } = require('./util');

/** 本机登录态：就是 state.json 的 {cookies, ua, savedAt}（同步、不联网） */
function state() {
  return creds.readLocalState();
}

/** 还剩几天（只算 session* 那几条：网关粘滞 cookie 常年 0 天，会把结果带偏） */
function ttlDays(st) {
  return session.ttlDays((st && st.cookies) || []);
}

/** login 的参数字面量（纯函数，selftest 也测这个） */
function loginArgv(opts = {}) {
  const argv = [];
  if (opts.import) argv.push('--import');
  const min = Number(opts.maxWaitMin);
  if (Number.isFinite(min) && min > 0) argv.push('--max-wait', String(Math.round(min)));
  return argv;
}

/**
 * auth.login：扫码 / 短信登录。
 * 浏览器流程在本目录的 login-flow.js 里（从 commands/login.js 搬过来的，逻辑没变）——
 * 放在驱动里之后，commands/login.js 才能变成「调 provider.auth.login」的通用壳。
 */
async function login(ctx, opts = {}) {
  const log = logf(ctx);
  if (opts.cookie) {
    // WorkBuddy 不接受"粘一串 cookie"：UA 是登录态的一部分，缺了它每条请求都 401
    throw new Error('WorkBuddy 不支持 --cookie 导入：会话跟 User-Agent 逐字节绑定，' +
      '必须用浏览器登录（wbsbx login）或 --import 复用已有 profile');
  }
  log('开始登录' + (opts.importOnly || opts.import ? '（从现有浏览器 profile 静默导入）' : '（浏览器扫码）'));
  const r = await require('./login-flow').run({
    importOnly: !!(opts.importOnly || opts.import),
    maxWaitMin: Number(opts.maxWaitMin),
    log,
  });
  const st = (r && r.state) || creds.readLocalState();
  const ttl = ttlDays(st);
  return {
    ok: Boolean(r && r.ok),
    state: st,
    ttlDays: ttl,
    cookieCount: (st && st.cookies && st.cookies.length) || 0,
    ...(r && r.ok ? {} : { reason: (r && r.reason) || '登录没成功' }),
  };
}

/**
 * auth.renew：不扫码把登录态续上。
 * 走 Keycloak SSO（lib/daemon/renew.js 的实现）：注入 KEYCLOAK_* cookie、用**原 UA** 开一次授权页，
 * 换发新的 +7 天 session。没有 playwright 时会如实返回 NO_BROWSER。
 */
async function renew(ctx, opts = {}) {
  const { runRenew } = require('../../daemon/renew');
  const log = logf(ctx);
  const verifyIds = Array.isArray(opts.verifyIds) && opts.verifyIds.length
    ? opts.verifyIds.map(String)
    : cloud.cachedConversations().map((c) => String(c.id)).slice(0, 3);
  return runRenew({ verifyIds, dry: !!opts.dry }, log);
}

/** 登录态还能不能用（会打一次真接口） */
async function alive() {
  return cloud.probeLogin();
}

/**
 * 异步读态：daemon 在跑时用它维护的那份（会自己续期，比本地文件新）。
 * 内核的 cookie 命令优先用这个，没有就退回同步的 state()。
 */
async function stateAsync() {
  try {
    const s = await session.loadAsync();
    return s && s.cookies && s.cookies.length ? s : state();
  } catch {
    return state();
  }
}

module.exports = {
  state, stateAsync, ttlDays, loginArgv, login, renew, alive,
  // doctor 用
  browserAvailable: () => browser.hasPlaywright(),
  browserDescribe: () => browser.describe(),
};
