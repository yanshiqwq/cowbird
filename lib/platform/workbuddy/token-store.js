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
const fs = require('fs');
const path = require('path');
const cfg = require('../../config');

const DIR = path.join(cfg.HOME, 'platform', 'workbuddy');
const TOKEN_FILE = path.join(DIR, 'device-token.json');

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 已存在 */ }
}

function read() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}

function write(t) {
  ensureDir();
  const f = TOKEN_FILE;
  fs.writeFileSync(f, JSON.stringify(t, null, 1));
  try { fs.chmodSync(f, 0o600); } catch { /* Windows 上没有 chmod */ }
  return t;
}

function clear() {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* 本来就没有 */ }
}

/** 还有效吗（留 60s 余量） */
function valid(t) {
  if (!t || !t.accessToken) return false;
  if (!t.expiresAt) return true;             // 没给到期时间就当它有效，401 时再刷
  return Number(t.expiresAt) * 1000 - Date.now() > 60e3;
}

/** 用 refreshToken 换一份新的；失败抛错（调用方决定要不要回退 cookie） */
async function refresh(t) {
  if (!t || !t.refreshToken) throw new Error('没有 refreshToken，无法续期');
  const r = await fetch('https://copilot.tencent.com/v2/plugin/auth/token/refresh', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': require('./device-login').UA,
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
  return write(next);
}

/** 拿一份「现在能用」的 token：有效就直接给，过期就续，续不了返回 null */
async function usable() {
  const t = read();
  if (!t) return null;
  if (valid(t)) return t;
  try { return await refresh(t); } catch { return null; }
}

module.exports = { read, write, clear, valid, refresh, usable, TOKEN_FILE };
