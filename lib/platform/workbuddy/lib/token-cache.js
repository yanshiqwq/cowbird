// 会话级凭据缓存（E2B 的 X-Access-Token）。
//
// 这是**每个会话一份**的短期凭据，与"登录态"无关 —— 登录现在只有一条路
// （插件 accessToken，见 token-store.js），所以这里只负责：
//   拿过的 /session 结果缓存起来，别每次都去刷；缓存里没有时才去控制面换
//   （daemon 的 refresh 循环按剩余时间提前换）。
//
// 为什么它还留在全局目录、不跟着 ctx.store 走：
//   实例 id 是平台侧发的雪花号（19 位，高 41 位是毫秒时间戳），全平台一个号池，
//   跨账号不会重号；而这份凭据本来就只对那一个沙箱有效，按账号再分一层没有意义。
//   —— 这是**唯一**一处驱动自己拼数据目录的地方，其余账号数据一律走 ctx.store。
//
// 以前 creds.js 还兼管 cookie+UA 那套登录态，2026-11 废掉 cookie 模式后只剩这半边。
const fs = require('fs');
const path = require('path');
const cfg = require('../../../config');

const DIR = path.join(cfg.HOME, 'tokens');

function file(id) { return path.join(DIR, String(id) + '.json'); }

function readToken(id) {
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
}

function writeToken(id, data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const f = file(id);
    fs.writeFileSync(f, JSON.stringify(data, null, 1));
    try { fs.chmodSync(f, 0o600); } catch { /* Windows 无 chmod */ }
  } catch { /* 缓存写失败不影响主流程 */ }
  return data;
}

function dropToken(id) { try { fs.unlinkSync(file(id)); } catch { /* 本来就没有 */ } }

/** 缓存里的 id 列表（doctor 的「凭据缓存 N 份」用） */
function cachedIds() {
  try { return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')); } catch { return []; }
}

module.exports = { readToken, writeToken, dropToken, cachedIds, DIR };
