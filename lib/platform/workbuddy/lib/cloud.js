// 云端控制面接口（网页版 /console/as/*，cookie + UA 鉴权）
// 接口清单、为什么不能用 /v2/* 的老路径，见 docs/protocol.md
//
// 全部走纯 HTTP（lib/session.js），不开浏览器 —— 前提是 state.json 里有登录态和当初那个 UA。
const fs = require('fs');
const cfg = require('../../../config');
const session = require('./session');
const creds = require('./creds');

// ---------- 会话列表 ----------
// 改名是异步的：刚 POST 完 title，紧接着拉列表可能拿到 name='' 的瞬时状态。
// 如果直接把空名字写进缓存，后面按名字引用就会突然"找不到实例"（2026-11-11 踩的）。
// ⇒ 空名字一律沿用缓存里的旧值。
function mergeNames(list) {
  let prev = {};
  try {
    prev = Object.fromEntries((JSON.parse(fs.readFileSync(cfg.PATHS.conversations, 'utf8')) || [])
      .map((x) => [String(x.id), x.name || x.title || '']));
  } catch {}
  for (const x of list) {
    if (!(x.name || x.title) && prev[String(x.id)]) x.name = prev[String(x.id)];
  }
  return list;
}

async function listConversations({ save = true } = {}) {
  const r = await session.get('/console/as/conversations/?page=1&pageSize=50');
  if (r.status !== 200 || !r.json) throw new Error(`列表失败 http=${r.status} ${(r.text || '').slice(0, 200)}`);
  const list = mergeNames((r.json.data && r.json.data.conversations) || []);
  if (save) {
    try { fs.writeFileSync(cfg.PATHS.conversations, JSON.stringify(list, null, 1)); } catch {}
  }
  return list;
}

// 本地缓存的会话列表（不联网）。可能为空或过期，调用方自己兜底。
function cachedConversations() {
  try { return JSON.parse(fs.readFileSync(cfg.PATHS.conversations, 'utf8')); } catch { return []; }
}

async function getConversation(id) {
  const r = await session.get('/console/as/conversations/' + id);
  if (r.status !== 200) throw new Error(`详情失败 http=${r.status}`);
  return (r.json && r.json.data) || {};
}

// ---------- 连接凭据 ----------
// 先问凭据门面（daemon 模式的 token 由 daemon 维护，且它过期前会主动刷新）；
// 它说没有/不够新，才自己发一次请求去换。
async function getSession(id, log = () => {}) {
  const cached = await creds.getToken(id);
  if (cached && cached.token) return cached;
  return refreshSession(id, log);
}

async function refreshSession(id, log = () => {}) {
  log('刷新会话凭据…');
  const r = await session.get('/console/as/conversations/' + id + '/session');
  if (r.status !== 200 || !r.json || !r.json.data) {
    throw new Error(`取凭据失败 http=${r.status} ${(r.text || '').slice(0, 200)}`);
  }
  return creds.setToken(id, r.json.data);
}

// ---------- 建 / 改名 / 删 ----------
// 创建接口只认 prompt(≤100字) 和 model，不认名字 —— 名字得建完再改一次
async function createConversation({ name, model = require('../constants').DEFAULT_MODEL, prompt = '你好，先不要做任何事，等我指令。' }, log = () => {}) {
  const r = await session.post('/console/as/conversations/', { prompt: String(prompt).slice(0, 100), model });
  if (r.status >= 300 || !r.json) throw new Error(`创建失败 http=${r.status} ${(r.text || '').slice(0, 300)}`);
  const d = (r.json.data) || {};
  const id = d.id;
  if (!id) throw new Error('创建返回里没有 id：' + (r.text || '').slice(0, 200));
  log(`已创建 id=${id}`);

  if (name) {
    const rr = await session.post('/console/as/conversations/' + id, { title: name });
    log(`改名 http=${rr.status} → ${name}`);
  }

  const s = await session.get('/console/as/conversations/' + id + '/session');
  const sd = (s.json && s.json.data) || {};
  if (sd.token) creds.setToken(id, sd);
  return { id, session: sd, raw: d };
}

async function renameConversation(id, title) {
  const r = await session.post('/console/as/conversations/' + id, { title });
  if (r.status >= 300) throw new Error(`改名失败 http=${r.status} ${(r.text || '').slice(0, 200)}`);
  return true;
}

async function deleteConversation(id, { archive = false } = {}) {
  const p = '/console/as/conversations/' + id + (archive ? '/archive' : '/delete');
  const r = await session.post(p, archive ? undefined : { id });
  if (r.status >= 300) throw new Error(`${archive ? '归档' : '删除'}失败 http=${r.status} ${(r.text || '').slice(0, 200)}`);
  // 本地凭据缓存跟着清掉，免得后面一直拿死 token
  creds.dropToken(id);
  return true;
}

// ---------- 登录态自检 ----------
async function probeLogin() {
  const r = await session.alive();
  return { ok: r.ok, status: r.status };
}

module.exports = {
  listConversations, cachedConversations, getConversation,
  getSession, refreshSession,
  createConversation, renameConversation, deleteConversation, probeLogin,
};
