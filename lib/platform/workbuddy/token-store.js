// 访问令牌的存取与续期（token 模式）。
//
// 背景：实测（2026-11-17）CodeBuddy 插件登录拿到的 accessToken **能打控制面**
// （/console/as/conversations/*、/{id}/session、乃至 E2B exec 全部 200），
// 所以除了老的 cookie+UA 之外，我们还可以用「Authorization: Bearer」这一条干净路子：
//   · 不依赖 cookie jar，也就不怕 UA 改一个字符就 401；
//   · 不用开浏览器 —— 登录是"打印链接 + 轮询"；
//   · 有 refreshToken，可以续。
//
// 2026-11 起 cookie 模式整条删除：登录态只有这里的 accessToken 一条路。
//
// 存在哪：ctx.store —— 一个平台可以有多份登录态，store 目录已经按账号分好了
// （~/.cowbird/platform/workbuddy/accounts/<账号>/device-token.json）。daemon 会在
// 同一个进程里轮流拿不同账号的 ctx 进来，所以这里**不留任何进程内状态**：
// 每次调用都问 ctx 要，状态只在磁盘上（读一次盘几微秒，换来的是不会串账号）。
const deviceLogin = require('./device-login');

// 读写的名字就是文件名（不含 .json）：老布局迁移过来时文件名不变，所以老的
// ~/.cowbird/platform/workbuddy/device-token.json 会被内核搬成 accounts/default/device-token.json。
const NAME = 'device-token';

/**
 * 取 ctx 的 store。离线自检（以及任何只给了 {log} 的裸 ctx）没有 store，
 * 这时按「没有登录态」处理 —— 抛 TypeError 只会让调用方看不到真正的原因。
 */
function storeOf(ctx) {
  return ctx && ctx.store && typeof ctx.store.read === 'function' ? ctx.store : null;
}

/** 读当前账号的 token；没有就是 null */
function read(ctx) {
  const s = storeOf(ctx);
  return s ? s.read(NAME, null) : null;
}

/** 写当前账号的 token，返回写进去的那份（writeStrict 失败会抛，调用方拿不到半成品） */
function write(ctx, t) {
  const s = storeOf(ctx);
  if (!s) throw new Error('ctx.store 缺失：登录态只能按账号存进 ctx.store，驱动不再自己拼路径');
  if (typeof s.writeStrict === 'function') s.writeStrict(NAME, t);
  else s.write(NAME, t);
  return t;
}

/** 清掉当前账号的 token（退出登录 / 410 之类） */
function clear(ctx) {
  const s = storeOf(ctx);
  if (s) s.remove(NAME);
}

/** 还有效吗（留 60s 余量） */
function valid(t) {
  if (!t || !t.accessToken) return false;
  if (!t.expiresAt) return true;             // 没给到期时间就当它有效，401 时再刷
  return Number(t.expiresAt) * 1000 - Date.now() > 60e3;
}

/** 用 refreshToken 换一份新的，写回**这个账号**的 store；失败抛错（调用方决定要不要回退） */
async function refresh(ctx, t) {
  if (!t || !t.refreshToken) throw new Error('没有 refreshToken，无法续期');
  const r = await fetch('https://copilot.tencent.com/v2/plugin/auth/token/refresh', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': deviceLogin.UA,
      'x-client-id': 'codebuddy-cli',
      'x-client-version': '2.143.1',
      'x-product': 'SaaS',
      origin: 'https://www.codebuddy.cn',
      referer: 'https://www.codebuddy.cn/',
    },
    body: JSON.stringify({ refreshToken: t.refreshToken }),
    signal: AbortSignal.timeout(25000),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  const d = (j && (j.data || j)) || {};
  const accessToken = d.accessToken || d.AccessToken;
  if (!accessToken) throw new Error(`续期失败：http=${r.status} ${text.slice(0, 160)}`);
  const next = {
    ...t,
    accessToken,
    refreshToken: d.refreshToken || d.RefreshToken || t.refreshToken,
    expiresIn: Number(d.expiresIn || d.ExpiresIn) || t.expiresIn || 0,
    expiresAt: Number(d.expiresIn || d.ExpiresIn)
      ? Math.floor(Date.now() / 1000) + Number(d.expiresIn || d.ExpiresIn)
      : t.expiresAt,
    refreshedAt: new Date().toISOString(),
  };
  return write(ctx, next);
}

/** 拿一份「现在能用」的 token：有效就直接给，过期就续，续不了返回 null */
async function usable(ctx) {
  const t = read(ctx);
  if (!t) return null;
  if (valid(t)) return t;
  try { return await refresh(ctx, t); } catch { return null; }
}

module.exports = { read, write, clear, valid, refresh, usable, NAME };
