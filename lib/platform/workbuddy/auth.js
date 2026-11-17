// WorkBuddy 的登录态：**只有一个 accessToken**（外加 refreshToken）。
//
// 2026-11 之后的现实：cookie+UA 那条路整条删掉了 —— 实测插件 accessToken 能打
// /console/as/*（含 /session 与 E2B exec），于是登录、续期、鉴权都收敛成一份 token。
//   登录   打印链接 + 轮询（device-login.js，不需要浏览器）
//   续期   token-store.refresh()（有 refreshToken）
//   读态   token-store.read()
const tokenStore = require('./token-store');
const deviceLogin = require('./device-login');
const cloud = require('./lib/cloud');
const { logf } = require('./util');

/** 当前登录态：{ mode:'token', token, tokenExpiresAt, account } */
function state() {
  const t = tokenStore.read();
  return {
    mode: 'token',
    token: t ? t.accessToken : null,
    refreshToken: t ? t.refreshToken : null,
    tokenExpiresAt: t ? t.expiresAt : null,
    account: (t && t.account) || null,
    savedAt: t ? t.savedAt : null,
  };
}

/** 还剩几天（accessToken 的到期时间） */
function ttlDays(st) {
  const t = (st && st.tokenExpiresAt) || (tokenStore.read() || {}).expiresAt;
  if (!t) return null;
  return (Number(t) * 1000 - Date.now()) / 86400e3;
}

/** 续期：用 refreshToken 换新的 accessToken */
async function renew(ctx, opts = {}) {
  const log = logf(ctx);
  const cur = tokenStore.read();
  if (!cur) return { ok: false, reason: '没有登录态，先跑 wbsbx login --print-only' };
  try {
    const next = await tokenStore.refresh(cur);
    log(`accessToken 已续期（${new Date(next.expiresAt * 1000).toISOString()}）`);
    return { ok: true, expiresAt: next.expiresAt };
  } catch (e) {
    log('续期失败：' + String(e.message).slice(0, 160));
    return { ok: false, error: String(e.message) };
  }
}

/** 登录态还能不能用（会打一次真接口） */
async function alive() {
  return cloud.probeLogin();
}

/** 接收另一台机器推来的 token（daemon 的 PUT /api/state 用） */
async function importState(ctx, st = {}) {
  const accessToken = String(st.accessToken || st.token || '').trim();
  if (!accessToken) throw new Error('缺 accessToken');
  const out = {
    accessToken,
    refreshToken: String(st.refreshToken || ''),
    expiresAt: Number(st.expiresAt) || null,
    account: st.account || null,
    savedAt: new Date().toISOString(),
  };
  tokenStore.write(out);
  return { ok: true, expiresAt: out.expiresAt, hasRefresh: Boolean(out.refreshToken) };
}

/**
 * 无头登录：打印链接 → 轮询 → 落盘。内核的 login 命令直接调这三个方法。
 * 返回的 probe 是「这个 token 能不能打控制面」的实测结论（打不了就只能当纯 API token）。
 */
const device = {
  async start() {
    const r = await deviceLogin.start();
    return {
      state: r.state,
      url: r.url,
      // 步骤文案由驱动给：WorkBuddy 是微信授权，换个平台就是另一套
      steps: ['在微信中打开下面的链接', '按页面提示完成授权'],
    };
  },

  async poll(ctx, state) {
    const r = await deviceLogin.poll(state);
    if (r.status !== 'done') return r;
    const acct = await deviceLogin.account(state, r.token.accessToken);
    const expiresAt = r.token.expiresIn ? Math.floor(Date.now() / 1000) + r.token.expiresIn : null;
    tokenStore.write({
      accessToken: r.token.accessToken,
      refreshToken: r.token.refreshToken,
      expiresAt,
      account: acct,
      savedAt: new Date().toISOString(),
    });
    const probe = await deviceLogin.probeConsole(r.token.accessToken);
    // 只在「打不了控制面」时才出声：正常情况命令层已经报过登录成功，别刷屏
    if (!probe.ok) logf(ctx)(`注意：这个 token 打不了控制面（http=${probe.status}），后续命令可能 401`);
    return { status: 'done', token: r.token, account: acct, expiresAt, probe };
  },

  /** 命令层打印用 */
  describe(st) {
    const t = st || {};
    const a = t.account || {};
    return { account: a.nickname || a.uid || null, uid: a.uid || null, expiresAt: t.expiresAt || null };
  },
};

module.exports = { state, ttlDays, renew, alive, importState, device };
