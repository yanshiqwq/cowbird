'use strict';
// 登录态：cookie jar + UA（APISIX 把会话跟 User-Agent 逐字节绑定，UA 换一个字符就 401）。
//
// 这里只做适配，真正的实现都在仓库既有模块里：
//   读态        lib/creds.js  readLocalState / loginState
//   扫码登录    commands/login.js（浏览器流程留在原处，这里只薄封装）
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
 * 薄封装 —— 浏览器怎么开、怎么等扫码、什么时候算登录成功，全留在 commands/login.js 里，
 * 这里只负责调它、再把新的登录态读回来给你。
 */
async function login(ctx, opts = {}) {
  const log = logf(ctx);
  // 延迟 require：commands/login.js 会拉 lib/args、lib/log、lib/ui，provider 平时不需要这些
  const loginCmd = require('../../../commands/login');
  const argv = loginArgv(opts);
  log('开始登录' + (opts.import ? '（从现有浏览器 profile 静默导入）' : '（浏览器扫码）'));
  const code = await loginCmd.run(argv);
  const st = creds.readLocalState();
  const ttl = ttlDays(st);
  return {
    ok: code === 0,
    code,
    state: st,
    ttlDays: ttl,
    ...(code === 0 ? {} : { hint: '登录没成功：确认这台机器上能起 Edge/Chromium（WBSBX_BROWSER 可指定路径），再重试' }),
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

module.exports = {
  state, ttlDays, loginArgv, login, renew, alive,
  // doctor 用
  browserAvailable: () => browser.hasPlaywright(),
  browserDescribe: () => browser.describe(),
};
