// TRAE（字节的 work.trae.cn 网页工作台）驱动。
//
// 平台形态（2026-11-17 实测，详见 README）：
//   · 一个「会话」= 一台云端沙箱，而且是 **KVM 真 VM**（Ubuntu 24.04 / 3 vCPU / 每次全新）；
//   · 网页版**没有直连 exec 的接口**：156 条端点里没有 terminal/pty/shell/exec。
//     沙箱里的真 shell 只有三个入口：agent 的 Shell 工具、VNC 桌面、IDE/文件通道。
//   · 所以本驱动**不声明 exec / fs**：`cowbird exec` 会按契约直接报能力缺失（退出码 2）。
//     这是诚实的能力声明，不是没做完 —— 沙箱数据面（`agent-sandbox-*.trae.cn`）还在打通中。
//
// 已实测可用的能力：会话列表/详情/建/删、消息历史、换 token、登录态探活。
const { defineProvider, CAP, EVENT } = require('../contract');
const auth = require('./auth');
const transport = require('./http');
const map = require('./map');
const C = require('./constants');

const pkg = require('../../../package.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (ctx) => transport.createTransport(ctx);
const PAGE = 50;

// ---------- instances ----------
async function listInstances(ctx, { pageSize = PAGE, max = 300, refresh = false } = {}) {
  void refresh;                       // TRAE 没有本地缓存，refresh 无意义
  const t = api(ctx);
  const size = Math.max(1, Math.min(Number(pageSize) || PAGE, 100));
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const j = await t.request('GET', `${C.Ep.sessions}?page_size=${size}&page_num=${page}`);
    const items = map.itemList(j);
    out.push(...items.map(map.normalizeSession));
    const total = Number(j && j.data && j.data.total);
    if (!items.length) break;
    if (Number.isFinite(total) && out.length >= total) break;
    if (items.length < size) break;
    if (out.length >= max) break;
  }
  return out;
}

async function getInstance(ctx, id) {
  const t = api(ctx);
  const j = await t.request('GET', C.Ep.session(id));
  const s = (j && j.data) || {};
  if (!s.chat_session_id) throw new Error(`没有会话 ${id}（返回：${JSON.stringify(j).slice(0, 160)}）`);
  return map.normalizeSession(s);
}

async function createInstance(ctx, { name, title, prompt } = {}) {
  const t = api(ctx);
  const want = String(name || title || '').trim() || `cowbird-${Date.now().toString(36)}`;
  const j = await t.request('POST', C.Ep.sessions, { body: { mode: 'code', title: want } });
  const s = (j && j.data) || {};
  if (!s.chat_session_id) throw new Error(`建会话没有返回 id（返回：${JSON.stringify(j).slice(0, 200)}）`);
  const inst = { id: String(s.chat_session_id), name: want, status: map.statusOf(s.status), platformStatus: s.status, updatedAt: new Date().toISOString(), archived: false, extra: { mode: 'code', remoteProjectId: s.remote_project_id || null, prompt: prompt || null }, raw: s };
  return inst;
}

async function renameInstance(ctx, id, title) {
  const t = api(ctx);
  // 前端 renameSession 走的是 commitSession（带 title），不是 PATCH
  await t.request('POST', C.Ep.commit(id), { body: { chat_session_id: id, title: String(title || '') } });
  return true;
}

async function removeInstance(ctx, id) {
  const t = api(ctx);
  await t.request('DELETE', C.Ep.session(id));
  return true;
}

async function wakeInstance(ctx, id) {
  const t = api(ctx);
  const j = await t.request('POST', C.Ep.wakeup(id), { body: {} });
  return { ok: !j || j.code === 0, raw: j };
}

// ---------- agent ----------
async function fetchMessages(ctx, id, pageSize = 100) {
  const t = api(ctx);
  const j = await t.request('GET', `${C.Ep.messages(id)}?page_size=${pageSize}`);
  return map.itemList(j);
}

/**
 * 事件流：**轮询增量**（不是 SSE）。
 * 消息列表里每条都有稳定的 `message_id` + `message_index`，用它做 diff 就够了；
 * 官方 `subscribe` 是带 heartbeat 的 SSE，但服务端帧格式还没摸（见 README 待办），
 * 与其猜一个格式，不如先用能验证的轮询 —— 语义一样：新内容 → 归一事件。
 */
async function* stream(ctx, id, opts = {}) {
  const { timeoutMs = 60000, pollMs = 2000, onEvent } = opts;
  const seen = new Set();
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  const before = await fetchMessages(ctx, id);
  for (const m of before) if (m && m.message_id) seen.add(m.message_id);

  let idleRounds = 0;
  while (Date.now() < deadline) {
    await sleep(Math.max(500, pollMs));
    let items = [];
    try { items = await fetchMessages(ctx, id); } catch { continue; }
    const fresh = items.filter((m) => m && m.message_id && !seen.has(m.message_id));
    for (const m of fresh) {
      seen.add(m.message_id);
      for (const ev of map.itemEvents(m)) { if (onEvent) onEvent(ev); yield ev; }
    }
    idleRounds = fresh.length ? 0 : idleRounds + 1;
    if (idleRounds >= 2) {
      let st = null;
      try { st = await getInstance(ctx, id); } catch { /* 查不到就按超时收 */ }
      if (st && st.status === 'completed') {
        const done = { kind: EVENT.DONE, data: { reason: 'completed' } };
        if (onEvent) onEvent(done);
        yield done;
        return;
      }
    }
  }
  const done = { kind: EVENT.DONE, data: { reason: 'timeout' } };
  if (onEvent) onEvent(done);
  yield done;
}

async function sendMessage(ctx, id, { text } = {}) {
  const t = api(ctx);
  const body = map.buildSendBody(text);
  try {
    return await t.request('POST', C.Ep.messages(id), { body });
  } catch (e) {
    // 991102 = 上游参数校验没过。当前 body 形状还没从浏览器真实请求里抓到，
    // 与其让人对着 "invalid parameter" 猜，不如把话说清楚。
    if (e && e.code === 991102) {
      throw Object.assign(new Error(
        'TRAE 网页端发消息不是 HTTP，而是 wss://frontier.zijieapi.com/ws/v2 上的二进制 protobuf 流；' +
        'HTTP 的 POST /messages 是给别的客户端用的，body schema 很严（991102 就是它）。' +
        'ls / info / create / rm / rename / history 都能用，只有 prompt 这条走不通。'
      ), { code: 'E_UNSUPPORTED' });
    }
    throw e;
  }
}

async function history(ctx, id, { limit } = {}) {
  const items = await fetchMessages(ctx, id, 100);
  const msgs = map.messagesToHistory(items);
  return { messages: limit ? msgs.slice(-limit) : msgs, truncated: false };
}

async function interrupt(ctx, id) {
  const t = api(ctx);
  await t.request('POST', C.Ep.stop(id), { body: {} });
  return true;
}

// ---------- 导出 ----------
module.exports = defineProvider({
  id: 'trae',
  displayName: 'TRAE（字节 work.trae.cn）',
  version: pkg.version,
  capabilities: [
    CAP.AUTH, CAP.LIST, CAP.CREATE, CAP.RENAME, CAP.REMOVE, CAP.META,
    CAP.AGENT, CAP.AGENT_INTERRUPT,
    // 故意不声明：
    //   CAP.EXEC / CAP.EXEC_BG / CAP.FS / CAP.WAKE —— 网页版没有直连执行/文件通道
    //   （沙箱数据面 agent-sandbox-*.trae.cn 的鉴权还没打通，打通后再加）
    //   CAP.AUTH_RENEW —— cookie 型，没有 refresh_token
  ],
  defaults: {},
  requiresPromptOnCreate: false,
  // 没有 exec，这些字段照样要有；内核只用它们做"同步/后台/拒绝"的三选一
  limits: { maxSyncMs: 30000, defaultSyncMs: 20000, maxBackground: false, wakeTimeoutMs: 60000 },

  auth: {
    async state(ctx) { return auth.state(ctx); },
    ttlDays(st) { return auth.ttlDays(st); },
    async login(ctx, opts) { return auth.login(ctx, opts); },
    async alive(ctx) { return auth.alive(ctx); },
    async logout(ctx) { auth.clear(ctx); return true; },
  },

  instances: {
    list: listInstances,
    get: getInstance,
    create: createInstance,
    rename: renameInstance,
    remove: removeInstance,
  },

  agent: {
    stream,
    send: sendMessage,
    history,
    interrupt,
  },

  // 沙箱唤醒（没有 exec，所以不是 exec.wake；留给将来数据面打通后用）
  sandbox: { wake: wakeInstance, sessionToken: (ctx, id) => api(ctx).sessionToken(id) },

  transport,

  doctor: {
    async checks(ctx, { net = true } = {}) {
      const out = [];
      const st = auth.read(ctx);
      if (!auth.isLoggedIn(st)) {
        out.push({ level: 'error', name: '登录态', detail: '没有 cookie：跑 cowbird --platform trae login --cookie "<串>"（网页版没有可脚本化的登录流）' });
        return out;
      }
      out.push({ level: 'ok', name: '登录态', detail: `${st.cookies.length} 条 cookie（含 ${auth.cookieValue(st.cookies, 'sessionid') ? 'sessionid' : 'sid_tt'}）` });
      if (!net) {
        out.push({ level: 'info', name: '接口', detail: '--no-net：跳过（需要真请求才能验登录态）' });
        return out;
      }
      const a = await auth.alive(ctx);
      out.push({ level: a.ok ? 'ok' : 'error', name: '接口连通', detail: a.ok ? 'CheckLogin 200' : String(a.reason || a.status).slice(0, 160) });
      if (a.ok) {
        try {
          const t = transport.createTransport(ctx);
          const ui = await t.cloudide('POST', C.Ep.userInfo, { ReqSource: 'Web' });
          const u = (ui.json && ui.json.Result) || {};
          out.push({ level: 'ok', name: '账号', detail: `${u.UserName || u.NickName || '(未命名)'}${u.UserID || u.Uid ? '（' + (u.UserID || u.Uid) + '）' : ''} · 区域 ${u.AIRegion || '?'}` });
        } catch (e) {
          out.push({ level: 'warn', name: '账号', detail: String(e.message).slice(0, 160) });
        }
        try {
          const list = await listInstances(ctx, { pageSize: 20 });
          out.push({ level: 'info', name: '会话', detail: `${list.length} 个（${list.filter((x) => x.extra.sandboxType).length} 个带沙箱类型标记）` });
        } catch (e) {
          out.push({ level: 'warn', name: '会话', detail: String(e.message).slice(0, 160) });
        }
      }
      out.push({ level: 'info', name: '能力边界', detail: '网页版没有直连执行通道：exec/fs 不可用（沙箱数据面未打通）' });
      return out;
    },
  },
});
