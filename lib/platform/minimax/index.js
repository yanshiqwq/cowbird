'use strict';
// minimax —— MiniMax Code（agent.minimax.cn，产品名 MiniMax Agent / Mavis）平台驱动。
//
// 一句话结论：**能管会话、能对话，没有执行通道。**
//   - 会话与消息都在 `/minimax-cloud/*` 上，**纯 HTTP 可读**（2026-11-17 已打通）：
//     门是 `token` + `x-signature` + query 里的 `user_id`(=realUserID) + 纯数字 `device_id`；
//     `yy` 的算法也逆出来了（transport.computeYY），但实测服务端**根本不校验它**；
//   - `/session/{id}/...` 下只有 message / queue / input-summaries，没有 exec/fs/沙箱入口，
//     工具由服务端派发（`details.dispatched_locally:false`）⇒ 本驱动**不声明 exec/fs**；
//   - 发消息的请求体没实测 ⇒ 默认禁用，留一个显式开关打开。
//
// 能力位取舍（与 README 一致）：
//   声明：auth / auth.browser / instances.list / instances.meta / agent / model
//   不声明：instances.create|rename|remove（未实测）、exec/fs（没有通道）、agent.question / agent.interrupt（未实测）
const { defineProvider, CAP, EVENT } = require('../contract');
const transport = require('./transport');
const map = require('./map');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 模型清单：来自实测报告（/minimax-cloud/api/v1/config 里也能读到，但形状未固化，
// 所以这里以报告为基线，refresh() 只把原始 config 存进快照供人工核对）。
const MODEL_CATALOG = [
  {
    id: 'MiniMax-M3.1-Flash',
    contextLimit: 512000,
    contextOptions: [{ tokens: 1000000, note: 'higher_usage' }],
    variants: ['', 'thinking'],
    thinking: { forced: true, efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'] },
    source: 'report',
  },
  {
    id: 'MiniMax-M3',
    contextLimit: 400000,
    contextOptions: [],
    variants: ['', 'thinking'],
    thinking: { forced: false, efforts: null },
    source: 'report',
  },
];

// 浏览器控制台里取登录态的片段（只是给人复制，本驱动不执行它）
const CAPTURE_SNIPPET = [
  '(() => {',
  '  const ls = {}; for (const k of Object.keys(localStorage)) if (/token|uuid|device|user/i.test(k)) ls[k] = localStorage.getItem(k);',
  '  const ck = Object.fromEntries(document.cookie.split(/;\\s*/).filter(Boolean).map((s) => s.split("=")).map(([k, ...v]) => [k, v.join("=")]));',
  '  return JSON.stringify({ token: ls._token || ck._token, local: ls, cookieNames: Object.keys(ck) }, null, 1);',
  '})()',
].join('\n');
// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function positive(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function safeRead(ctx, name, dflt = null) {
  try { return ctx && ctx.store ? ctx.store.read(name, dflt) : dflt; } catch { return dflt; }
}

function safeWrite(ctx, name, value) {
  try { if (ctx && ctx.store) ctx.store.write(name, value); } catch { /* 落盘失败不影响主流程 */ }
}

function localConf(ctx) {
  let conf = {};
  try { conf = (ctx && ctx.config && ctx.config()) || {}; } catch { conf = {}; }
  return (conf.platforms && conf.platforms.minimax) || {};
}

/** 平台设置：wbsbx.json 的 platforms.minimax 覆盖 provider.defaults */
function settingsOf(ctx) {
  const d = (ctx && ctx.defaults) || {};
  const p = localConf(ctx);
  return {
    pollMs: positive(p.pollMs, positive(d.pollMs, 1500)),
    streamTimeoutMs: positive(p.streamTimeoutMs, positive(d.streamTimeoutMs, 120000)),
    yyMaxAgeMs: positive(p.yyMaxAgeMs, positive(d.yyMaxAgeMs, 24 * 3600e3)),
    idleLimit: positive(p.idleLimit, positive(d.idleLimit, 2)),
    includeArchived: p.includeArchived === true || d.includeArchived === true,
    model: p.model || d.model || 'MiniMax-M3.1-Flash',
    variant: p.variant || d.variant || 'thinking',
    thinkingEffort: p.thinkingEffort || d.thinkingEffort || 'max',
  };
}

/**
 * 「未实测的发消息」总开关。默认关，四个地方任一打开即可：
 *   调用参数 allowUnverified:true / MINIMAX_ALLOW_UNVERIFIED_SEND=1 /
 *   wbsbx.json platforms.minimax.allowUnverifiedSend / store 的 settings.allowUnverifiedSend
 */
function allowUnverifiedSend(ctx, opts = {}) {
  if (opts && opts.allowUnverified === true) return { ok: true, via: 'call' };
  const env = String((process.env && process.env.MINIMAX_ALLOW_UNVERIFIED_SEND) || '').trim().toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes') return { ok: true, via: 'env' };
  const p = localConf(ctx);
  if (p.allowUnverifiedSend === true) return { ok: true, via: 'config' };
  const s = safeRead(ctx, 'settings');
  if (s && s.allowUnverifiedSend === true) return { ok: true, via: 'store' };
  if (ctx && ctx.defaults && ctx.defaults.allowUnverifiedSend === true) return { ok: true, via: 'defaults' };
  return { ok: false, via: null };
}

/** 给数组挂元信息：数组本身仍是数组（ls/解析都不用改），但能看出"这是旧数据" */
function annotate(list, meta) {
  for (const [k, v] of Object.entries(meta)) list[k] = v;
  return list;
}

// ---------------------------------------------------------------------------
// 缓存与快照
// ---------------------------------------------------------------------------

function saveTree(ctx, data) {
  safeWrite(ctx, 'tree', { at: new Date().toISOString(), data });
}

function cachedInstances(ctx, { includeArchived = false } = {}) {
  const snap = safeRead(ctx, 'tree');
  if (!snap || !snap.data) return null;
  return { at: snap.at || null, list: map.treeToInstances(snap.data, { includeArchived }) };
}

function findInCache(ctx, sid, opts = {}) {
  const snap = cachedInstances(ctx, opts);
  if (!snap) return null;
  return snap.list.find((x) => x.id === String(sid)) || null;
}

// ---------------------------------------------------------------------------
// 具体实现
// ---------------------------------------------------------------------------

const instancesApi = {
  /**
   * 会话列表 → Instance[]。
   * 实时读 `/sidebar/session/tree`（纯 HTTP，不需要浏览器）；请求失败才退化成上次快照，
   * 并把 `stale:true` 挂在数组上。一个会话都拿不到时返回空数组 + warning，不抛到命令层崩掉。
   */
  async list(ctx, opts = {}) {
    const includeArchived = opts.includeArchived === undefined ? settingsOf(ctx).includeArchived : !!opts.includeArchived;
    try {
      const r = await transport.get(ctx, transport.P.tree);
      const list = map.treeToInstances(r.data, { includeArchived });
      saveTree(ctx, r.data);
      return annotate(list, {
        stale: false,
        source: 'live',
        at: new Date().toISOString(),
        count: list.length,
      });
    } catch (e) {
      const snap = cachedInstances(ctx, { includeArchived });
      if (snap) {
        return annotate(snap.list, {
          stale: true,
          source: 'cache',
          at: snap.at,
          count: snap.list.length,
          reason: e.code || 'E_REQUEST',
          error: e.message,
          warning: `拉不到会话列表（${e.code || e.message}），下面显示的是 ${snap.at || '更早'} 的本地快照`,
        });
      }
      // 连快照都没有：只对"已知的不可读"（没 token / 401）降级成空列表
      if (e.code === 'E_NO_TOKEN' || e.code === 'E_UNAUTHORIZED') {
        return annotate([], {
          stale: true,
          source: 'none',
          at: null,
          count: 0,
          reason: e.code,
          error: e.message,
          warning: `没有可用的会话数据：${e.message}`,
        });
      }
      throw e;
    }
  },

  /** 单会话详情 → Instance。实时读 `/session/{id}`；失败时先看快照，快照里没有才抛。 */
  async get(ctx, id, opts = {}) {
    const sid = String(id);
    if (!sid) throw err('E_ARGS', 'instances.get() 需要会话 id');
    try {
      const r = await transport.get(ctx, transport.P.session(sid));
      const s = map.pickSession(r.data);
      const inst = map.sessionToInstance(s || {});
      if (!inst.id) inst.id = sid;
      return inst;
    } catch (e) {
      const hit = findInCache(ctx, sid, opts);
      if (hit) return hit;
      if (e.code === 'E_HTTP' && e.status === 404) {
        throw err('E_NOT_FOUND', `MiniMax 上没有会话 ${sid}`, { id: sid });
      }
      if (e.code === 'E_NO_TOKEN' || e.code === 'E_UNAUTHORIZED') {
        throw err(e.code, `读不到会话 ${sid}：${e.message}`, { id: sid, hint: e.hint });
      }
      throw e;
    }
  },

  /**
   * 元数据整理成 facts。**平台不暴露算力配额**（没有 exec/fs 可以自己量，控制面也没这些字段），
   * 所以 visible / quota 一律 null，并在 facts 里写明原因，免得被误读成"没采到"。
   */
  async info(ctx, id, opts = {}) {
    const sid = String(id);
    let inst = null;
    let source = 'live';
    let warning = null;
    try {
      inst = await instancesApi.get(ctx, sid, opts);
    } catch (e) {
      if (e.code === 'E_NOT_FOUND') throw e;
      const hit = findInCache(ctx, sid, opts);
      warning = e.message;
      if (hit) { inst = hit; source = 'cache'; }
      else {
        inst = { id: sid, name: sid, title: '', status: 'unknown', statusType: null, statusMessage: '', model: null, raw: null };
        source = 'none';
      }
    }

    const m = inst.model || {};
    const st = inst.statusType === null || inst.statusType === undefined
      ? '未知（拿不到会话详情）'
      : `${inst.status}（status_type=${inst.statusType}${inst.statusMessage ? '，' + inst.statusMessage : ''}）`;
    const think = m.thinking
      ? `variant=${m.variant === null || m.variant === undefined ? '?' : (m.variant || '（空）')}，effort=${m.thinking.effort || '?'}`
      : '未知';

    const facts = [
      { label: '平台', value: 'MiniMax Code（agent.minimax.cn），agent 跑在云端 K8s Pod 上' },
      { label: '会话', value: `${inst.id}${inst.title ? ' · ' + inst.title : ''}` },
      { label: '状态', value: st },
      { label: 'Agent', value: inst.agentName || '未知' },
      { label: '模型', value: m.modelId ? `${m.modelId}（provider=${m.providerId || '?'}）` : '未知' },
      { label: '上下文窗口', value: m.contextLimit ? `${m.contextLimit} tokens` : '未知' },
      { label: '思考链', value: think },
      { label: '创建时间', value: inst.createdAt || '未知' },
      { label: '更新时间', value: inst.updatedAt || '未知' },
      { label: '类型', value: `session_type=${inst.sessionType === null || inst.sessionType === undefined ? '?' : inst.sessionType}，team_mode=${inst.teamMode ? 'on' : 'off'}，project_id=${inst.projectId === null || inst.projectId === undefined ? '?' : inst.projectId}` },
      { label: '算力与配额', value: '平台不暴露：控制面没有 CPU/内存/磁盘字段，也没有 exec/fs 通道可以自己量（工具由服务端派发）' },
      { label: '数据来源', value: source === 'live' ? '实时读取（/session/{id}）' : `本地快照（stale${warning ? '：' + warning : ''}）` },
    ];

    return { visible: null, quota: null, facts, source, stale: source !== 'live', warning };
  },
};

/** 发消息（请求体未实测，默认被开关挡住） */
async function sendMessage(ctx, id, opts = {}) {
  const sid = String(id);
  const text = String(opts.text !== undefined ? opts.text : (opts.content !== undefined ? opts.content : '')).trim();
  if (!text) throw err('E_ARGS', '消息内容为空');
  const gate = allowUnverifiedSend(ctx, opts);
  if (!gate.ok) {
    throw err(
      'E_UNVERIFIED_SEND',
      '发消息被禁用：POST /minimax-cloud/api/v1/session/{id}/message 的请求体未实测（只按 {content} 猜的），默认不开',
      {
        hint: '确认要用就显式打开：agent.send(ctx, id, {text, allowUnverified:true})，或设 MINIMAX_ALLOW_UNVERIFIED_SEND=1，'
          + '或在 wbsbx.json 的 platforms.minimax.allowUnverifiedSend=true；想完全自己定 body 就传 {body:{...}}',
        verified: false,
      },
    );
  }
  const body = { content: text, ...(opts.extra && typeof opts.extra === 'object' ? opts.extra : {}) };
  if (opts.body && typeof opts.body === 'object') Object.assign(body, opts.body);
  const r = await transport.postJson(ctx, transport.P.messages(sid), body);
  return { ok: true, status: r.status, data: r.data, sent: body, unverified: true, gate: gate.via };
}

const agentApi = {
  async send(ctx, id, opts = {}) { return sendMessage(ctx, id, opts); },

  /**
   * 事件流：
   *   ① 先试 `agent-stream.minimax.cn/.../events`（SSE，token 在 query 里）；
   *   ② 拿不到就轮询 `/session/{id}/message` 做增量（按 msg_id + 文本长度差分去重）。
   *      两条路都是纯 HTTP（yy 自算，服务端也不校验），不再有"必须借用浏览器"的限制。
   * 事件顺序保证：text/thinking/tool/tool_result/usage 之后才是 done；done 只出现一次。
   */
  async *stream(ctx, id, opts = {}) {
    const sid = String(id);
    const settings = settingsOf(ctx);
    const st = map.newState();
    const timeoutMs = positive(opts.timeoutMs, settings.streamTimeoutMs);
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const mode = String(opts.mode || 'auto').toLowerCase();
    let channel = mode === 'poll' ? 'poll' : 'sse';
    let done = false;
    let reason = null;

    yield { kind: EVENT.STATUS, data: { status: 'connecting', session: sid, mode } };

    // 带 text 就是在"说一句再听"，先发（send 自己有开关）
    if (opts.text !== undefined && opts.text !== null && opts.text !== '') {
      const sent = await sendMessage(ctx, sid, { text: opts.text, allowUnverified: opts.allowUnverified, extra: opts.extra, body: opts.body });
      yield { kind: EVENT.STATUS, data: { status: 'sent', messageId: (sent.data && (sent.data.msg_id || sent.data.message_id)) || null, unverified: true } };
    }

    if (mode !== 'poll') {
      try {
        // 注意：给整个 stream 预算做超时，而不是"连上就砍 60s"——
        // 一轮 turn 可能跑几分钟，提前 abort 会把正常的长答切坏。
        const { res, url } = await transport.openStream(ctx, {
          path: transport.P.events,
          query: { session_id: sid },
          signal: opts.signal,
          timeoutMs,
        });
        yield { kind: EVENT.STATUS, data: { status: 'streaming', channel: 'sse', url } };
        for await (const payload of transport.iterPayloads(res, { signal: opts.signal })) {
          for (const ev of map.payloadToEvents(payload, st)) {
            if (ev.kind === EVENT.DONE) { done = true; reason = (ev.data && ev.data.reason) || 'endTurn'; }
            yield ev;
          }
          if (done) break;
          if (Date.now() > deadline) { reason = 'timeout'; break; }
        }
        if (!done && !reason) reason = 'stream_end';
      } catch (e) {
        // 到点被自己 abort 掉不算"事件流坏了"，别吐误导性的 error
        const aborted = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.code === 'E_ABORTED');
        if (aborted && Date.now() >= deadline - 50) {
          reason = 'timeout';
        } else {
          yield {
            kind: EVENT.ERROR,
            data: { message: `事件流不可用（${e.code || 'E_REQUEST'}）：${transport.snippet(e.message)}`, code: e.code || null },
          };
          channel = 'poll';
          reason = null;
        }
      }
    }

    // SSE 没给出 done（没连上 / 提前断了）→ 轮询补齐
    if (!done && mode !== 'sse') {
      channel = 'poll';
      reason = null;
      yield { kind: EVENT.STATUS, data: { status: 'polling', channel, intervalMs: settings.pollMs } };
      let emptyRounds = 0;
      for (;;) {
        if (Date.now() > deadline) { reason = 'timeout'; break; }
        let r;
        try {
          r = await transport.get(ctx, transport.P.messages(sid), {
            signal: opts.signal,
            // 单次轮询也要有上限，否则一个挂起的连接会把整条流拖死
            timeoutMs: Math.max(1000, Math.min(20000, deadline - Date.now())),
          });
        } catch (e) {
          yield {
            kind: EVENT.ERROR,
            data: { message: `轮询 /message 失败（${e.code || 'E_REQUEST'}）：${transport.snippet(e.message)}`, code: e.code || null },
          };
          reason = e.code || 'poll_error';
          break;
        }
        let produced = 0;
        for (const m of map.pickMessages(r.data)) {
          for (const ev of map.messageToEvents(m, st)) {
            produced++;
            if (ev.kind === EVENT.DONE) { done = true; reason = (ev.data && ev.data.reason) || 'endTurn'; }
            yield ev;
          }
        }
        if (done) break;
        if (opts.once) { reason = 'once'; break; }
        emptyRounds = produced > 0 ? 0 : emptyRounds + 1;
        if (emptyRounds >= settings.idleLimit) { reason = 'idle'; break; }
        await sleep(settings.pollMs);
      }
    }

    if (!done) {
      yield {
        kind: EVENT.STATUS,
        data: { status: reason || 'closed', channel, elapsedMs: Date.now() - startedAt },
      };
      yield { kind: EVENT.DONE, data: { reason: reason || 'stream_end' } };
    }
  },

  /** 历史消息（原样返回 + 条数；映射成事件用 map.messageToEvents） */
  async history(ctx, id, opts = {}) {
    const sid = String(id);
    const r = await transport.get(ctx, transport.P.messages(sid));
    const all = map.pickMessages(r.data);
    const limit = Number(opts.limit);
    const messages = Number.isFinite(limit) && limit > 0 ? all.slice(-limit) : all;
    return { messages, nextCursor: null, total: all.length, source: 'live' };
  },
};

// ---------------------------------------------------------------------------
// provider 定义
// ---------------------------------------------------------------------------

module.exports = defineProvider({
  id: 'minimax',
  displayName: 'MiniMax Code（agent.minimax.cn）',
  version: '0.2.0',
  capabilities: [
    CAP.AUTH,          // 有登录态（token 快照）
    CAP.LOGIN_BROWSER, // 登录只能走浏览器（短信验证码）
    CAP.LIST,          // 会话列表
    CAP.META,          // 会话详情/元数据
    CAP.AGENT,         // 对话流
    CAP.MODEL,         // 模型/档位
    // 刻意不声明：
    //   instances.create / rename / remove —— 写接口未实测
    //   exec / exec.background / fs —— 平台没有执行/文件通道（工具由服务端派发）
    //   agent.question / agent.interrupt —— 未实测，不写假的
  ],
  defaults: {
    model: 'MiniMax-M3.1-Flash',
    variant: 'thinking',
    thinkingEffort: 'max',
    pollMs: 1500,
    streamTimeoutMs: 120000,
    yyMaxAgeMs: 24 * 3600e3,
    idleLimit: 2,
    includeArchived: false,
    allowUnverifiedSend: false,
  },
  limits: { maxSyncMs: 15000, defaultSyncMs: 10000, maxBackground: false },

  // provider 专属 HTTP 层（内核不碰；selftest/调试可直接用）
  transport,

  auth: {
    /** 登录态快照的形状：{token, cookies, uuid, device_id, user_id, savedAt, exp} */
    async state(ctx) {
      const idn = transport.identity(ctx);
      const snap = idn.snapshot || {};
      const exp = idn.exp;
      return {
        ok: !!idn.token,
        tokenPreview: transport.preview(idn.token),
        tokenSource: idn.source,          // env / store / none
        exp: exp || null,
        expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
        expired: exp ? exp * 1000 <= Date.now() : null,
        savedAt: snap.savedAt || null,
        rotatedAt: snap.rotatedAt || null,
        cookies: snap.cookies ? Object.keys(snap.cookies) : [],
        uuid: idn.uuid || null,
        deviceId: idn.deviceId || null,
        userId: idn.userId || null,                 // JWT 里的 user.id（仅展示用）
        realUserId: idn.realUserId || null,         // query 里真正要用的那个
        queryUserId: idn.queryUserId || null,
        yy: transport.yyStatus(ctx),
      };
    },

    /**
     * 取/补 realUserID —— query 里的 `user_id` 必须是它（不是 JWT 的 user.id）。
     * 已经补过一次就返回快照里的值；没有就打一次 /v1/api/user/info（这条不需要 yy）。
     * @returns {Promise<{ok:boolean, realUserId:string|null, from:string}>}
     */
    async userId(ctx, opts = {}) {
      const idn = transport.identity(ctx);
      if (idn.realUserId) return { ok: true, realUserId: idn.realUserId, from: 'store' };
      const real = await transport.ensureRealUserId(ctx, opts);
      return real
        ? { ok: true, realUserId: real, from: 'probe:/v1/api/user/info' }
        : { ok: false, realUserId: null, from: 'none', hint: '打不通 /v1/api/user/info：token 过期或没有 token' };
    },

    /** 剩余天数（token 会被静默轮换，所以这只是"JWT 上的名义有效期"） */
    ttlDays(ctx) {
      const idn = transport.identity(ctx);
      if (!idn.exp) return 7;
      const days = (idn.exp * 1000 - Date.now()) / 86400e3;
      return Math.max(0, Math.round(days * 10) / 10);
    },

    /**
     * 落地登录态。不自动登录：MiniMax 走短信验证码，自动化不在本驱动范围；
     * 给一份 {token, cookies} 快照就够用。不传 token 时返回"该怎么抓"的说明书。
     */
    async login(ctx, opts = {}) {
      const token = String(opts.token || (opts.auth && opts.auth.token) || '').trim();
      if (!token) {
        return {
          ok: false,
          needBrowser: true,
          reason: 'MiniMax 用短信验证码登录（/v1/api/user/login/sms/send → /v1/api/user/login/phone），没有可自动化的用户名密码/SSO 通道',
          target: 'provider.auth.login(ctx, { token, cookies })',
          steps: [
            '1. 浏览器登录 https://agent.minimax.cn/（任意已登录的标签页即可）',
            '2. F12 控制台执行下面的片段，复制输出的 token',
            '3. 调 auth.login(ctx, {token}) —— 或者设环境变量 MINIMAX_TOKEN 临时试跑',
            '4. 落地后会自动补一次 /v1/api/user/info 拿 realUserID —— query 里的 user_id 必须用它，'
              + '用 JWT 的 user.id 会 401（yy 早就不是门禁了，见 README §3）',
          ],
          snippet: CAPTURE_SNIPPET,
        };
      }
      if (token.split('.').length !== 3 || token.length < 40) {
        throw err('E_ARGS', 'token 看起来不是 JWT（应为三段、约 385 字符）；别把 cookie 串当 token 传进来');
      }
      const payload = transport.jwtPayload(token);
      const snap = {
        token,
        cookies: opts.cookies || opts.cookie || null,
        uuid: opts.uuid || opts.deviceUuid || (transport.readAuth(ctx) || {}).uuid || null,
        device_id: opts.device_id || opts.deviceId || (transport.readAuth(ctx) || {}).device_id || null,
        user_id: opts.user_id || opts.userId || (payload && payload.user && payload.user.id ? String(payload.user.id) : null),
        savedAt: new Date().toISOString(),
        exp: payload && payload.exp ? Number(payload.exp) : null,
        savedBy: 'auth.login',
      };
      safeWrite(ctx, 'auth', snap);
      // 顺手把 realUserID 补进快照（query 里的 user_id 必须用它；JWT 的 user.id 会 401）。
      // 拿不到不算失败：后面每条请求还会再试一次，doctor 里也能看到状态。
      const realUserId = await transport.ensureRealUserId(ctx, {}).catch(() => null);
      return {
        ok: true,
        tokenPreview: transport.preview(token),
        exp: snap.exp,
        expiresAt: snap.exp ? new Date(snap.exp * 1000).toISOString() : null,
        savedAt: snap.savedAt,
        realUserId: realUserId || null,
        realUserIdSource: realUserId ? 'probe:/v1/api/user/info' : 'unknown',
      };
    },

    /**
     * 记一份 yy 覆盖（**调试/取证用**）。
     * yy 已经能自算（transport.computeYY，与浏览器逐字节一致），服务端也不校验，
     * 所以这里唯一还有用的场景是：把某次抓包里的 yy 钉进 store 复现当时那条请求。
     * @param {object} entry {yy:'32hex', path:'/minimax-cloud/api/v1/sidebar/session/tree'|'*'}
     */
    async captureYY(ctx, entry = {}) {
      const yy = String(entry.yy || entry.value || '').trim();
      if (!/^[0-9a-f]{32}$/i.test(yy)) throw err('E_ARGS', 'yy 应为 32 位十六进制');
      const path = String(entry.path || entry.url_path || '*');
      const prev = transport.readYYEntries(ctx)
        .filter((e) => e.source !== 'env')
        .map((e) => ({ yy: e.yy, path: e.path || '*', capturedAt: e.capturedAt }));
      const next = prev.filter((e) => (e.path || '*') !== path);
      next.push({ yy, path, capturedAt: transport.numOrNull(entry.capturedAt) || Date.now() });
      safeWrite(ctx, 'yy', { entries: next, updatedAt: new Date().toISOString() });
      return {
        ok: true,
        path,
        entries: transport.yyStatus(ctx).entries,
        // 覆盖只影响"发什么 yy"，不再决定"能不能读"
        effect: 'override',
        warning: 'yy 不再是门禁：覆盖只是把你这一份发出去，用来复现某次抓包；'
          + '正常请求会自己按算法算（服务端实测也不校验 yy）。',
      };
    },
  },

  instances: {
    list: (ctx, opts) => instancesApi.list(ctx, opts),
    get: (ctx, id, opts) => instancesApi.get(ctx, id, opts),
    info: (ctx, id, opts) => instancesApi.info(ctx, id, opts),
  },

  agent: {
    send: (ctx, id, opts) => agentApi.send(ctx, id, opts),
    stream: (ctx, id, opts) => agentApi.stream(ctx, id, opts),
    history: (ctx, id, opts) => agentApi.history(ctx, id, opts),
  },

  model: {
    /** 可选模型（报告基线；refresh 后的原始 config 存快照，不硬解） */
    list(ctx) {
      const snap = safeRead(ctx, 'config');
      const list = MODEL_CATALOG.map((m) => ({
        ...m,
        contextOptions: m.contextOptions.map((o) => ({ ...o })),
        variants: m.variants.slice(),
        thinking: { ...m.thinking, efforts: m.thinking.efforts ? m.thinking.efforts.slice() : null },
      }));
      return annotate(list, {
        source: snap && snap.at ? `平台 config 快照（${snap.at}）` : '实测报告',
        at: snap && snap.at ? snap.at : null,
      });
    },

    /** 拉一次 `/minimax-cloud/api/v1/config`（纯 HTTP；yy 自算，服务端也不校验） */
    async refresh(ctx) {
      const r = await transport.get(ctx, transport.P.config);
      const at = new Date().toISOString();
      safeWrite(ctx, 'config', { at, data: r.data });
      return { ok: true, at, data: r.data };
    },
  },

  doctor: {
    /**
     * 默认**不联网**：只检查本地快照/开关够不够把命令跑起来。
     * probe:true 时才打一次 /v1/api/user/info（纯 HTTP，可用来单独验证 token + x-signature + realUserID）。
     */
    async checks(ctx, opts = {}) {
      const out = [];
      const idn = transport.identity(ctx);

      if (!idn.token) {
        out.push({ level: 'error', name: '登录态', detail: '没有 token：auth.login(ctx,{token}) 或设 MINIMAX_TOKEN' });
      } else {
        const expired = idn.exp ? idn.exp * 1000 <= Date.now() : null;
        out.push({
          level: expired ? 'error' : 'ok',
          name: '登录态',
          detail: `token ${transport.preview(idn.token)}（来源 ${idn.source}${idn.exp ? '，到期 ' + new Date(idn.exp * 1000).toISOString() : '，无 exp'}）${expired ? ' —— 已过期，重抓一份' : ''}`,
        });
      }

      const yys = transport.yyStatus(ctx);
      out.push({
        level: 'ok',
        name: 'yy',
        detail: '自算（transport.computeYY：md5(enc(path?query) + "_" + body + md5(整秒毫秒) + "ooui")，'
          + '与浏览器抓包逐字节一致）。实测服务端**根本不校验** yy（整个删掉也 200），所以它不是门禁'
          + (yys.overrides ? `；store 里另有 ${yys.overrides} 份覆盖会盖过自算值（仅调试用）` : ''),
      });

      out.push({
        level: idn.realUserId ? 'ok' : 'warn',
        name: 'user_id / device_id',
        detail: (idn.realUserId
          ? `query 的 user_id = ${idn.realUserId}（realUserID，不是 JWT 的 user.id ${idn.userId || '?'}）`
          : `快照里没有 realUserID，query 只能退回 JWT 的 user.id=${idn.userId || '?'} —— 服务端会 401；`
            + '跑一次 auth.userId(ctx) 或 doctor --probe 会自动补')
          + `；device_id = ${/^\d+$/.test(String(idn.deviceId || '')) ? idn.deviceId : `（非纯数字，将自动换成数字）`}`,
      });

      const snap = safeRead(ctx, 'tree');
      out.push(snap && snap.at
        ? { level: 'ok', name: '会话快照', detail: `${snap.at}（${map.treeToInstances(snap.data, { includeArchived: true }).length} 个会话）` }
        : { level: 'warn', name: '会话快照', detail: '还没有本地快照（不影响 ls：ls 会实时拉 /sidebar/session/tree）' });

      out.push({
        level: 'ok',
        name: '执行通道',
        detail: '无：平台没有 exec/fs 端点（工具由服务端 bash 派发，dispatched_locally:false），这是设计结论不是故障',
      });

      const gate = allowUnverifiedSend(ctx);
      out.push({
        level: gate.ok ? 'warn' : 'ok',
        name: '发消息',
        detail: gate.ok
          ? `已启用（via ${gate.via}）；请求体 {content} 未实测，出问题先看这里`
          : '默认禁用（POST /session/{id}/message 的 body 未实测）：要用就 MINIMAX_ALLOW_UNVERIFIED_SEND=1 或 platforms.minimax.allowUnverifiedSend',
      });

      if (opts.probe) {
        try {
          const r = await transport.get(ctx, transport.P.info);
          const info = (r.data && (r.data.userInfo || r.data.data || r.data)) || {};
          out.push({
            level: 'ok',
            name: '连通性',
            detail: `GET /v1/api/user/info 200（${info.name || '已鉴权'}；realUserID=${info.realUserID || '?'}）`,
          });
        } catch (e) {
          out.push({ level: 'error', name: '连通性', detail: `GET /v1/api/user/info 失败：${e.code || ''} ${transport.snippet(e.message)}` });
        }
      }
      return out;
    },
  },

  // 给 selftest 与排查用的内部件（不属于契约）
  _internal: { transport, map, settingsOf, allowUnverifiedSend, MODEL_CATALOG },
});
