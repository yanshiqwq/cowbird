// 凭据门面：所有「登录态」和「E2B token」都从这里取。
//
// 存在的理由：同一个工具要能跑两种形态 ——
//   ① 单机：自己 login、自己刷新，凭据就在本地文件；
//   ② 挂 daemon：daemon 24 小时维护登录态，任何一台机器上的 CLI 都能拿到新鲜凭据。
// 把「从哪拿」收敛到一个函数里，上层命令就完全不用知道自己是哪种形态（也就不必改 15 个命令）。
//
// 顺序是 daemon 优先、本地兜底：
//   daemon 的 cookie 是它自己 6 小时一刷的，通常比本地新；
//   但 daemon 挂了不该让 CLI 整个瘫掉 —— 本地缓存照样能连一阵子。
//
// ⚠ 只读不写 daemon：CLI 请求过程中滚动出来的 Set-Cookie 只落本地文件。
//   两边各自维护自己的副本，谁也别覆盖谁（UA 一样，两份 cookie 都能用）。
const fs = require('fs');
const cfg = require('./config');
const api = require('./api');

const MODE_TTL = 60e3;        // 多久重新判断一次「daemon 在不在」
const STATE_TTL = 30e3;       // 登录态内存缓存
const TOKEN_TTL = 30e3;

const memo = {
  mode: null,
  modeAt: 0,
  state: null,
  stateAt: 0,
  tokens: new Map(),
};

function reset() {
  memo.mode = null; memo.modeAt = 0;
  memo.state = null; memo.stateAt = 0;
  memo.tokens.clear();
}

// ---------- 本地文件 ----------
function readLocalState() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(cfg.PATHS.state, 'utf8')); } catch { return null; }
  const cookies = j.cookies || (j.storageState && j.storageState.cookies) || [];
  return { cookies, ua: j.ua || null, savedAt: j.savedAt || null };
}

function writeLocalState(next) {
  cfg.ensureDirs();
  const out = {
    savedAt: new Date().toISOString(),
    ua: next.ua,
    cookies: next.cookies || [],
    ...(next.extra || {}),
  };
  fs.writeFileSync(cfg.PATHS.state, JSON.stringify(out, null, 1));
  try { fs.chmodSync(cfg.PATHS.state, 0o600); } catch {}
  memo.state = out; memo.stateAt = Date.now();
  return out;
}

// ---------- 模式判定 ----------
async function mode() {
  if (process.env.WBSBX_LOCAL === '1') return 'local';
  if (process.env.WBSBX_DAEMON_URL) return 'daemon';
  if (memo.mode && Date.now() - memo.modeAt < MODE_TTL) return memo.mode;
  const c = cfg.readConfig();
  let m = 'local';
  if (c.daemon.prefer && c.daemon.url) {
    try { await new api.DaemonClient().probe(); m = 'daemon'; } catch { m = 'local'; }
  }
  memo.mode = m; memo.modeAt = Date.now();
  return m;
}

function client() { return new api.DaemonClient(); }

// ---------- 登录态 ----------
async function loginState({ force = false } = {}) {
  if (!force && memo.state && Date.now() - memo.stateAt < STATE_TTL) return memo.state;
  if (await mode() === 'daemon') {
    try {
      const s = await client().loginState();
      if (s && s.cookies && s.cookies.length) {
        memo.state = { cookies: s.cookies, ua: s.ua, savedAt: s.savedAt, source: 'daemon' };
        memo.stateAt = Date.now();
        return memo.state;
      }
    } catch { /* 掉线了就走本地 */ }
  }
  const local = readLocalState();
  memo.state = local ? { ...local, source: 'local' } : null;
  memo.stateAt = Date.now();
  return memo.state;
}

// ---------- E2B token ----------
async function getToken(id, { force = false } = {}) {
  const key = String(id);
  const hit = memo.tokens.get(key);
  if (!force && hit && Date.now() - hit.at < TOKEN_TTL) return hit.v;

  const fresh = (t) => t && t.token && t.expireAt && t.expireAt * 1000 > Date.now() + 600e3;

  // 本地已有一份够新的，直接给（少一次往返）
  const local = cfg.readToken(key);
  if (!force && fresh(local)) { memo.tokens.set(key, { v: local, at: Date.now() }); return local; }

  if (await mode() === 'daemon') {
    try {
      const t = await client().token(key);
      if (t && t.token) {
        cfg.writeToken(key, t);                     // 顺手在本机留一份，daemon 挂了还能顶一阵
        memo.tokens.set(key, { v: t, at: Date.now() });
        return t;
      }
    } catch { /* 回退本地 */ }
  }
  if (local && local.token) { memo.tokens.set(key, { v: local, at: Date.now() }); return local; }
  return null;
}

function setToken(id, data) {
  cfg.writeToken(String(id), data);
  memo.tokens.set(String(id), { v: data, at: Date.now() });
  return data;
}

function dropToken(id) {
  cfg.dropToken(String(id));
  memo.tokens.delete(String(id));
}

// ---------- 登录后同步 ----------
// login 在本机扫码完成 → 把新的 cookie+UA 推给 daemon，避免「本机登录了但 daemon 还在用旧凭据」。
async function publishLoginState(state) {
  if (await mode() !== 'daemon') return { pushed: false, reason: 'local-mode' };
  try {
    await client().pushState({ cookies: state.cookies, ua: state.ua });
    reset();
    return { pushed: true };
  } catch (e) {
    return { pushed: false, reason: e.message };
  }
}

module.exports = {
  reset, mode, client,
  readLocalState, writeLocalState, loginState,
  getToken, setToken, dropToken,
  publishLoginState,
};
