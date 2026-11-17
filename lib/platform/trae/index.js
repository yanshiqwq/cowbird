// TRAE（字节的 work.trae.cn 网页工作台）驱动。
//
// 平台形态（2026-11-18 实测，详见 README）：
//   · 一个「会话」= 一台云端沙箱，而且是 **KVM 真 VM**（Ubuntu 24.04 / 3 vCPU / 每次全新）；
//   · 网页版没有给 CLI 用的执行端点（156 条里没有 terminal/pty/shell），但沙箱里的
//     agent-tool-host 在 9003 上开了个 MCP JSON-RPC 网关。`create` 时顺手在沙箱里装一个
//     只跑 `sh` 的执行端，之后 exec 就能直连 `tools/call`（0.3–1.2s 一条，不烧额度）；
//     装不上（例如沙箱里的 agent 拒执行）时自动退回"发消息让 agent 跑一轮"。
//   · 沙箱不跨会话复用：每个会话一台新的，所以执行端是每个会话装一次（create 里做完）。
//
// 能力：会话列表/详情/建/删/改名、消息历史、发消息、换 token、文件通道、exec。
const { defineProvider, CAP, EVENT } = require('../contract');
const auth = require('./auth');
const transport = require('./http');
const map = require('./map');
const fsApi = require('./fs');
const sendApi = require('./send');
const execApi = require('./exec');
const primeApi = require('./prime');
const model = require('./model');
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
  // 平台会拿首条消息自动改会话标题（实测：装了执行端之后标题变成
  // "Install Cowbird Sandbox Exec End"），于是我们建实例时起的名字就丢了，
  // 后续 `cowbird exec <名字>` 会找不到。所以**登记簿里的名字优先**。
  try {
    const sandboxes = require('../sandboxes');
    const reg = sandboxes.read(ctx);
    for (const x of out) {
      const rec = reg[String(x.id)];
      if (rec && rec.name) x.name = rec.name;
    }
  } catch { /* 登记簿坏了不该拖垮 ls */ }
  return out;
}

async function getInstance(ctx, id) {
  const t = api(ctx);
  const j = await t.request('GET', C.Ep.session(id));
  const s = (j && j.data) || {};
  if (!s.chat_session_id) throw new Error(`没有会话 ${id}（返回：${JSON.stringify(j).slice(0, 160)}）`);
  return map.normalizeSession(s);
}

/**
 * 建实例 = 建会话 + 在沙箱里装执行端。
 *
 * 装执行端要沙箱里的 agent 跑一段脚本，**它有权拒绝**；而它一旦在某个会话里拒了，
 * 那个会话的上下文就脏了 —— 同会话里换说法它也只会说"上一轮的判断不变"（实测原话）。
 * 所以策略是：**拒了就删掉这个会话，换一个干净的会话重来**，最多 SHOTS 次。
 * 都失败就把最后一个也删掉并报错 —— 不留半成品，用户重跑一次就是全新的上下文。
 */
const SHOTS = 3;

async function spawnSession(ctx, want, promptText) {
  const t = api(ctx);
  // 建会话的正确姿势：mode=code（否则没沙箱/没工具）+ env=remote（远端沙箱）。
  // 不用 initial_message：第一轮留给"装执行端"，用户给的 prompt 当第二轮，
  // 正好拿它去触发 TurnStart 的插件合并 —— 两件事一轮干完，不多烧额度。
  const body = { mode: 'code', env: 'remote', auto_create_project: false, origin: model.resolve(ctx).origin };
  const j = await t.request('POST', C.Ep.sessions, { body });
  const s = (j && j.data) || {};
  const id = s.chat_session_id || s.id;
  if (!id) throw new Error(`建会话没有返回 id（返回：${JSON.stringify(j).slice(0, 200)}）`);
  // 平台建会话不认名字（建出来没标题），而后续命令都靠名字/前缀找实例 —— 建完立刻改名
  try { await renameInstance(ctx, id, want); } catch { /* 改不了就继续，id 也能用 */ }
  return {
    id: String(id),
    name: want,
    status: map.statusOf(s.status),
    platformStatus: s.status,
    updatedAt: new Date().toISOString(),
    archived: false,
    extra: { mode: 'code', remoteProjectId: s.remote_project_id || null, prompt: promptText || null },
    raw: s,
  };
}

async function createInstance(ctx, { name, title, prompt, noPrime } = {}, extra = {}) {
  const log = (extra && typeof extra.log === 'function') ? extra.log : () => {};
  const want = String(name || title || '').trim() || `cowbird-${Date.now().toString(36)}`;
  const text = String(prompt || '').trim();
  const shots = noPrime ? 1 : SHOTS;
  let lastRefusal = null;

  for (let i = 1; i <= shots; i++) {
    if (i > 1) log(`上一次它拒了，删掉那个会话，换个干净的再来（第 ${i}/${shots} 次）…`);
    const inst = await spawnSession(ctx, want, text);
    if (noPrime) { inst.extra.execReady = null; return inst; }
    try {
      await primeApi.install(ctx, inst.id, { log, secondTurnText: text || undefined });
      inst.extra.execReady = true;
      return inst;
    } catch (e) {
      if (e.code !== 'E_PRIME_REFUSED' && e.code !== 'E_PRIME_SLOW') {
        // 不是"它不干"，是别的问题（网络/接口）—— 留着这个会话，别乱删
        inst.extra.execReady = false;
        inst.extra.execReason = String(e.message).slice(0, 300);
        log(`装执行端出错（${String(e.message).slice(0, 120)}），会话先留着`);
        return inst;
      }
      lastRefusal = e;
      log(`被拒：${String(e.message).slice(0, 200)}`);
      // 拒答 = 上下文已脏，别在同会话里纠缠；直接删掉换新会话
      try { await removeInstance(ctx, inst.id); } catch { /* 删不掉也不阻塞 */ }
    }
  }

  throw Object.assign(
    new Error(`${shots} 次都是新会话，执行端仍然没装上。最后一次：${lastRefusal ? lastRefusal.message : '(无)'}`),
    { code: 'E_PRIME_REFUSED', refusal: lastRefusal && lastRefusal.refusal },
  );
}

async function renameInstance(ctx, id, title) {
  const t = api(ctx);
  // 前端 renameSession 走的是 commitSession（带 title），不是 PATCH
  await t.request('POST', C.Ep.commit(id), { body: { chat_session_id: id, title: String(title || '') } });
  try { require('../sandboxes').record(ctx, { id, name: String(title || '') }, 'create'); } catch { /* 登记失败不影响改名 */ }
  return true;
}

async function removeInstance(ctx, id) {
  const t = api(ctx);
  await t.request('DELETE', C.Ep.session(id));
  return true;
}

async function wakeInstance(ctx, id, opts) {
  // 唤醒 = 让它跑一轮（这个平台是"跑一轮才分配沙箱"的模型）
  return execApi.wake(ctx, id, opts);
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
  return sendApi.sendMessage(ctx, id, { text });
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
    CAP.FS,          // 数据面：读/写 /file/:path，列目录走 WS fs.readdir
    CAP.EXEC,        // 由沙箱里的 agent 代执行：一条命令一轮（没有直连端点）
    CAP.WAKE,        // 唤醒 = 发一条消息让它跑一轮
    // 故意不声明：
    //   CAP.EXEC_BG   —— 一条命令一个 MCP 往返，没有后台任务通道
    //   CAP.AUTH_RENEW—— cookie 型，没有 refresh_token
  ],
  // 默认值都能被 cowbird.json 的 platforms.trae.* 覆盖
  defaults: { model: model.DEFAULTS.model, execExtId: execApi.DEFAULT_EXT },
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

  fs: {
    list: fsApi.list,
    read: fsApi.read,
    write: fsApi.write,
  },

  agent: {
    stream,
    send: sendMessage,
    history,
    interrupt,
  },

  exec: {
    probe: execApi.probe,
    run: execApi.run,
    wake: wakeInstance,
  },

  // 沙箱（数据面）—— 唤醒已经挪到 exec.wake，这里只留会话令牌
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
      out.push({ level: 'info', name: '能力边界', detail: 'exec 由 agent 代执行：一条命令一轮，约 10–25 秒（网页版没有直连 shell 端点）' });
      return out;
    },
  },
});
