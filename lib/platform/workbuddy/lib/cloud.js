// 云端控制面接口（网页版 /console/as/*，Bearer accessToken 鉴权）
// 接口清单、为什么不能用 /v2/* 的老路径，见 docs/protocol.md
//
// 全部走纯 HTTP（lib/session.js），不开浏览器 —— 前提是当前账号的登录态在 ctx.store 里。
// 每个函数都收 ctx 并往下传：多账号并存时，"用谁的身份"只由 ctx 决定。
const session = require('./session');
const cache = require('./token-cache');

// 会话列表缓存的名字：accounts/<账号>/conversations.json（老布局的
// ~/.cowbird/conversations.json 由内核搬到 default 账号下，名字不变）
const CONV_NAME = 'conversations';

// ---------- 会话列表 ----------
// 改名是异步的：刚 POST 完 title，紧接着拉列表可能拿到 name='' 的瞬时状态。
// 如果直接把空名字写进缓存，后面按名字引用就会突然"找不到实例"（2026-11-11 踩的）。
// ⇒ 空名字一律沿用缓存里的旧值。
function mergeNames(ctx, list) {
  let prev = {};
  try {
    prev = Object.fromEntries((ctx.store.read(CONV_NAME, []) || [])
      .map((x) => [String(x.id), x.name || x.title || '']));
  } catch {}
  for (const x of list) {
    if (!(x.name || x.title) && prev[String(x.id)]) x.name = prev[String(x.id)];
  }
  return list;
}

async function listConversations(ctx, { save = true } = {}) {
  const r = await session.get(ctx, '/console/as/conversations/?page=1&pageSize=50');
  if (r.status !== 200 || !r.json) throw new Error(`列表失败 http=${r.status} ${(r.text || '').slice(0, 200)}`);
  const list = mergeNames(ctx, (r.json.data && r.json.data.conversations) || []);
  if (save) {
    try { ctx.store.write(CONV_NAME, list); } catch { /* 缓存写失败不影响这次列表 */ }
  }
  return list;
}

// 本地缓存的会话列表（不联网）。可能为空或过期，调用方自己兜底。
function cachedConversations(ctx) {
  try { return ctx.store.read(CONV_NAME, []) || []; } catch { return []; }
}

async function getConversation(ctx, id) {
  const r = await session.get(ctx, '/console/as/conversations/' + id);
  if (r.status !== 200) throw new Error(`详情失败 http=${r.status}`);
  return (r.json && r.json.data) || {};
}

// ---------- 连接凭据 ----------
// E2B 的 X-Access-Token 是短命凭据：缓存里有就直接用，别每次都打一次控制面；
// 缓存里没有才自己发一次 /session 换（daemon 的 refresh 循环也会提前续）。
//
// 这份凭据按实例 id 缓存在全局目录（见 lib/token-cache.js 的说明）：
// 实例 id 是平台侧的雪花号，跨账号不重号，所以不必再按账号分一层。
async function getSession(ctx, id, log = () => {}) {
  const cached = await cache.readToken(id);
  if (cached && cached.token) return cached;
  return refreshSession(ctx, id, log);
}

async function refreshSession(ctx, id, log = () => {}) {
  log('刷新会话凭据…');
  const r = await session.get(ctx, '/console/as/conversations/' + id + '/session');
  if (r.status !== 200 || !r.json || !r.json.data) {
    throw new Error(`取凭据失败 http=${r.status} ${(r.text || '').slice(0, 200)}`);
  }
  return cache.writeToken(id, r.json.data);
}

// ---------- 建 / 改名 / 删 ----------
// 创建接口只认 prompt(≤100字) 和 model，不认名字 —— 名字得建完再改一次
async function createConversation(ctx, { name, model = require('../constants').DEFAULT_MODEL, prompt = '你好，先不要做任何事，等我指令。' }, log = () => {}) {
  const r = await session.post(ctx, '/console/as/conversations/', { prompt: String(prompt).slice(0, 100), model });
  if (r.status >= 300 || !r.json) throw new Error(`创建失败 http=${r.status} ${(r.text || '').slice(0, 300)}`);
  const d = (r.json.data) || {};
  const id = d.id;
  if (!id) throw new Error('创建返回里没有 id：' + (r.text || '').slice(0, 200));
  log(`已创建 id=${id}`);

  if (name) {
    const rr = await session.post(ctx, '/console/as/conversations/' + id, { title: name });
    log(`改名 http=${rr.status} → ${name}`);
  }

  const s = await session.get(ctx, '/console/as/conversations/' + id + '/session');
  const sd = (s.json && s.json.data) || {};
  if (sd.token) cache.writeToken(id, sd);
  return { id, session: sd, raw: d };
}

async function renameConversation(ctx, id, title) {
  const r = await session.post(ctx, '/console/as/conversations/' + id, { title });
  if (r.status >= 300) throw new Error(`改名失败 http=${r.status} ${(r.text || '').slice(0, 200)}`);
  return true;
}

async function deleteConversation(ctx, id, { archive = false } = {}) {
  const p = '/console/as/conversations/' + id + (archive ? '/archive' : '/delete');
  const r = await session.post(ctx, p, archive ? undefined : { id });
  if (r.status >= 300) throw new Error(`${archive ? '归档' : '删除'}失败 http=${r.status} ${(r.text || '').slice(0, 200)}`);
  // 本地凭据缓存跟着清掉，免得后面一直拿死 token
  cache.dropToken(id);
  return true;
}

// ---------- 登录态自检 ----------
async function probeLogin(ctx) {
  const r = await session.alive(ctx);
  return { ok: r.ok, status: r.status };
}

module.exports = {
  listConversations, cachedConversations, getConversation,
  getSession, refreshSession, createConversation, renameConversation, deleteConversation, probeLogin,
  mergeNames,
};
