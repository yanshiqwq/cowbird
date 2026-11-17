'use strict';
// 对话通道：ACP over SSE（`POST {link}/bootstrap` 拿 Acp-Connection-Id，然后读事件流）。
//
// 协议实现在 lib/acp.js（bootstrap / JSON-RPC / SSE 帧解析 / 服务端请求的自动回应），
// 这里只做适配层该做的事：
//   · 把回调式的 ACP 事件流桥接成契约要的 async generator
//   · 把原始帧映射成归一化事件（events.js）
//   · 历史重放（session/load）默认不当成新消息
//   · 记住「本进程内挂着的提问」，让 agent.answer 能回到那个提问所在的连接上
const cloud = require('../../cloud');
const { Acp, withAcp } = require('../../acp');
const { EVENT } = require('../contract');
const { logf, sleep } = require('./util');
const events = require('./events');

const BOOTSTRAP_SETTLE_MS = 2000;   // 等 session/load 把通道铺好（commands/prompt.js 也是 2s）

/**
 * 本进程内活着的 ACP 连接：id → {acp, pending:Map(requestId → {kind, questions})}
 * answer/interrupt 优先走这里 —— 提问是绑在**收到它的那条连接**上的，
 * 换一条连接去回属于未验证路径（服务端认不认是另一回事）。
 */
const LIVE = new Map();

/**
 * 回调 → async iterator 的桥。ACP 的事件只能从 onEvent 回调里拿，而契约要 generator。
 * 关闭后 push 一律丢弃（断开时还会有零星回调进来）。
 */
function createQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(v) {
      if (closed) return;
      const w = waiters.shift();
      if (w) w.resolve({ value: v, done: false });
      else items.push(v);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true });
    },
    get closed() { return closed; },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length) return Promise.resolve({ value: items.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
            // 兜底：连接既不结束也不来数据时，别让调用方永远挂着（由 idleTimeoutMs 之外的场景触发）
          });
        },
        return() {
          closed = true;
          for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function statusEvent(status, extra) {
  return { kind: EVENT.STATUS, data: { status, ...(extra || {}) } };
}

function errorEventOf(e) {
  return { kind: EVENT.ERROR, data: { message: String((e && e.message) || e), code: (e && e.code) || null } };
}

/**
 * 起一条连接跑 fn。
 * 默认走 lib/acp.js 的 withAcp；`opts.acpFactory` 是给离线自检留的注入口
 * （selftest 用假连接跑通「回调 → async generator」这条最容易写错的桥）。
 */
async function withConnection(creds, acpOpts, acpFactory, fn) {
  if (typeof acpFactory === 'function') {
    const acp = acpFactory(creds, acpOpts);
    try { return await fn(acp); } finally { try { await acp.close(); } catch { /* noop */ } }
  }
  return withAcp(creds, acpOpts, fn);
}

/**
 * agent.stream：连上 ACP，把事件按契约吐出来。
 *
 * @param {object} ctx
 * @param {string} id
 * @param {object} [opts]
 * @param {string} [opts.text]           给了就先发这句话（session/prompt），再收事件
 * @param {boolean} [opts.includeHistory=false]  历史重放降级成 raw 交出来（默认整条丢弃）
 * @param {boolean} [opts.stopOnEndTurn=true]    收到 session/endTurn 就收工
 * @param {number} [opts.maxMs]          整体上限（0 = 不限，默认 0）
 * @param {number} [opts.idleTimeoutMs]  N 毫秒没事件就收工（0 = 不限，默认 0）
 * @param {number} [opts.connectTimeoutMs]  bootstrap 等响应头的上限（默认 20000，lib/acp.js 的默认）
 */
async function* stream(ctx, id, opts = {}) {
  const sid = String(id);
  const log = logf(ctx);
  const o = {
    text: opts.text === undefined || opts.text === null ? '' : String(opts.text),
    includeHistory: !!opts.includeHistory,
    // 默认**不**因为见到 done 就收工：刚连上时 session/load 会把历史重放一遍，
    // 里面带着上一轮的 endTurn，一见面就 break 会得到「零正文 + 一堆旧产物」。
    // 什么时候算结束由调用方定（超时 / idle / 流自然结束），要"见 done 就停"得显式传 true。
    stopOnEndTurn: opts.stopOnEndTurn === true,
    maxMs: Number(opts.maxMs) > 0 ? Number(opts.maxMs) : 0,
    idleTimeoutMs: Number(opts.idleTimeoutMs) > 0 ? Number(opts.idleTimeoutMs) : 0,
    settleMs: Number.isFinite(Number(opts.settleMs)) ? Number(opts.settleMs) : BOOTSTRAP_SETTLE_MS,
    connectTimeoutMs: Number(opts.connectTimeoutMs) > 0 ? Number(opts.connectTimeoutMs) : undefined,
    postTimeoutMs: Number(opts.postTimeoutMs) > 0 ? Number(opts.postTimeoutMs) : undefined,
  };

  const q = createQueue();
  const rec = { acp: null, pending: new Map(), at: Date.now() };
  let idleTimer = null;
  let hardTimer = null;
  let reason = 'eof';
  let sawDone = false;
  let lastStatus = null;

  const stopWith = (why) => {
    if (reason === 'eof') reason = why;
    try { if (rec.acp && rec.acp._ac) rec.acp._ac.abort(); } catch { /* 已经断了就算了 */ }
  };
  const touch = () => {
    if (!o.idleTimeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    // ⚠ 不要 unref：这是一个「看门狗」，它得能把事件循环撑住。
    //   unref 之后，如果调用方正 await 在这条流上、而底层连接恰好在收尾，Node 会认为
    //   没有活动句柄而**静默退出（退出码 0）** —— 表现为「stream 什么都没吐就没了」。
    //   （2026-11-17 写 selftest 时真踩到：80ms 的 idle 超时根本没机会触发。）
    idleTimer = setTimeout(() => stopWith('idle-timeout'), o.idleTimeoutMs);
  };

  // 一个原始帧 → 若干归一化事件。状态去重（同一状态会跟着每个内容块重复出现）
  const emit = (m) => {
    const mapped = events.mapMessage(m, { includeHistory: o.includeHistory });
    for (const ev of mapped) {
      if (ev.kind === EVENT.STATUS) {
        if (ev.data.status === lastStatus) continue;
        lastStatus = ev.data.status;
      }
      if (ev.kind === EVENT.QUESTION) {
        rec.pending.set(ev.data.requestId, { kind: 'question', questions: ev.data.questions });
      }
      if (ev.kind === EVENT.PERMISSION) {
        rec.pending.set(ev.data.requestId, { kind: 'permission', questions: [] });
      }
      if (ev.kind === EVENT.DONE) sawDone = true;
      touch();
      q.push(ev);
    }
  };

  let loopP = null;
  try {
    // opts.creds / opts.acpFactory 是离线自检的注入口；正常调用一律走真网络
    const creds = opts.creds || await cloud.getSession(sid, log);
    const makeAcp = typeof opts.acpFactory === 'function' ? opts.acpFactory : (c, oo) => new Acp(c, oo);
    rec.acp = makeAcp(creds, {
      id: sid,
      connectTimeoutMs: o.connectTimeoutMs,
      postTimeoutMs: o.postTimeoutMs,
      onEvent: emit,
      // 提问/权限：lib/acp.js 刻意不替我们回（回了就等于替用户作答），只交给上层观察
      onServerRequest: (m) => emit(m),
    });
    LIVE.set(sid, rec);

    const res = await rec.acp.connect();
    if (!rec.acp.connId) {
      const t = await res.text().catch(() => '');
      throw new Error(`bootstrap 没给 Acp-Connection-Id（http=${res.status}）${String(t).slice(0, 200)}`);
    }
    log(`ACP 连接建立 id=${sid} conn=${rec.acp.connId}`);

    loopP = rec.acp.loop()
      .catch((e) => {
        // 主动 abort 不算错误（收工时我们自己断的）
        if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')))) return;
        q.push(errorEventOf(e));
      })
      .finally(() => q.close());

    if (o.maxMs) {
      // 同上：整体上限也是一个看门狗，unref 会让「等流的人」被静默丢弃
      hardTimer = setTimeout(() => stopWith('max-ms'), o.maxMs);
    }
    touch();

    yield statusEvent('connected', { via: 'acp' });

    if (o.text) {
      // 先让 session/load 的历史重放走一段，否则我们的 prompt 可能排在重放帧后面
      await sleep(o.settleMs);
      const r = await rec.acp.prompt(o.text);
      if (r.status >= 400) {
        q.push({ kind: EVENT.ERROR, data: { message: `session/prompt 失败 http=${r.status}`, code: String(r.status) } });
      } else {
        log(`已发送 session/prompt http=${r.status}`);
      }
    }

    for await (const ev of q) {
      yield ev;
      if (ev.kind === EVENT.DONE && o.stopOnEndTurn) { reason = ev.data.reason || 'endTurn'; break; }
    }
  } catch (e) {
    yield errorEventOf(e);
    reason = 'error';
  } finally {
    LIVE.delete(sid);
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    // 先断开再等 loop 收尾：不 abort 的话 loopP 会一直挂在 reader.read() 上
    try { if (rec.acp && rec.acp._ac) rec.acp._ac.abort(); } catch { /* noop */ }
    if (loopP) { try { await loopP; } catch { /* 收尾失败不影响已经吐出去的事件 */ } }
    if (rec.acp) { try { await rec.acp.close(); } catch { /* noop */ } }
  }

  // DONE 只在没收过的时候补一条，避免 endTurn 之后再来一条
  if (!sawDone) yield { kind: EVENT.DONE, data: { reason } };
}

/** agent.send：只发一句，不观察（要观察用 stream） */
async function send(ctx, id, opts = {}) {
  const sid = String(id);
  const text = opts.text === undefined || opts.text === null ? '' : String(opts.text);
  if (!text.trim()) throw new Error('agent.send 需要非空 text');
  const log = logf(ctx);
  const settleMs = Number.isFinite(Number(opts.settleMs)) ? Number(opts.settleMs) : BOOTSTRAP_SETTLE_MS;
  const creds = await cloud.getSession(sid, log);

  return withAcp(creds, {
    id: sid,
    postTimeoutMs: Number(opts.postTimeoutMs) > 0 ? Number(opts.postTimeoutMs) : 300e3,
  }, async (acp) => {
    const loopP = acp.loop().catch(() => { /* 只是为了不被背压堵住，事件不要 */ });
    await sleep(settleMs);
    const r = await acp.prompt(text);
    try { if (acp._ac) acp._ac.abort(); } catch { /* noop */ }
    await loopP;
    if (r.status >= 400) throw new Error(`session/prompt 失败 http=${r.status} ${String(r.text).slice(0, 200)}`);
    log('已发送 session/prompt');
    return { ok: true, status: r.status, id: sid };
  });
}

/**
 * agent.history：把 session/load 的重放抓成一份「消息列表」。
 * 历史没有 HTTP 接口（/messages、/history 全 404），只能这样抓一段流下来（对齐 commands/history.js）。
 *
 * @param {{maxWaitMs?:number, maxEvents?:number, raw?:boolean}} [opts]
 * @returns {Promise<{messages:Array, events:number, nextCursor:null, truncated:boolean}>}
 */
async function history(ctx, id, opts = {}) {
  const sid = String(id);
  const log = logf(ctx);
  const maxWaitMs = Number(opts.maxWaitMs) > 0 ? Number(opts.maxWaitMs) : 8000;
  const maxEvents = Number(opts.maxEvents) > 0 ? Number(opts.maxEvents) : 5000;

  const messages = [];
  const raws = [];
  let count = 0;
  let truncated = false;

  const collect = (m) => {
    if (count >= maxEvents) { if (!truncated) { truncated = true; } return; }
    count++;
    if (opts.raw) raws.push(m);
    if (!m || m.method !== 'session/update') return;
    const params = m.params || {};
    const u = params.update || {};
    const meta = events.metaOf(u, params);
    if (meta.mode !== 'history') return;             // 只收历史重放，实时事件不掺进来
    const su = String(u.sessionUpdate || '');
    const push = (role, text, extra) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role && text !== null && text !== undefined) { last.text += text; return; }
      messages.push({ role, ...(text !== null && text !== undefined ? { text } : {}), ...(extra || {}) });
    };
    if (su === 'agent_message_chunk') push('agent', events.textOf(u));
    else if (su === 'agent_thought_chunk') push('thinking', events.textOf(u));
    else if (su === 'user_message_chunk') push('user', events.textOf(u));
    else if (su === 'tool_call') {
      messages.push({ role: 'tool', tool: u.toolName || u.title || null, id: u.toolCallId === undefined ? null : String(u.toolCallId) });
    }
  };

  const creds = opts.creds || await cloud.getSession(sid, log);
  await withConnection(creds, { id: sid, onEvent: collect }, opts.acpFactory, async (acp) => {
    // 不 unref：这是「最多等多久」的看门狗，必须能把事件循环撑住
    const t = setTimeout(() => { try { if (acp._ac) acp._ac.abort(); } catch { /* noop */ } }, maxWaitMs);
    try { await acp.loop(); } catch { /* 到点主动断开，正常路径 */ } finally { clearTimeout(t); }
  });

  const out = { messages, events: count, nextCursor: null, truncated };
  if (opts.raw) out.raw = raws;
  return out;
}

/**
 * agent.answer：回答 `_codebuddy.ai/question`（AskUserQuestion）或 `session/request_permission`。
 *
 * 回填体形状见 docs/protocol.md「四、AskUserQuestion 回填」。优先在本进程的活动连接上回
 * （提问绑在那条连接上）；没有活动连接时另开一条去回 —— 那条路**未验证**，返回值里会标明。
 */
async function answer(ctx, id, opts = {}) {
  const sid = String(id);
  const requestId = opts.requestId;
  if (requestId === undefined || requestId === null) throw new Error('agent.answer 需要 requestId');
  const log = logf(ctx);

  const rec = LIVE.get(sid);
  const known = rec ? rec.pending.get(requestId) : null;
  const kind = opts.kind || (known && known.kind) || 'question';
  const questionIds = known && known.questions ? known.questions.map((q) => q.id) : [];
  const body = events.buildAnswerResult({
    requestId,
    kind,
    answers: opts.answers,
    outcome: opts.outcome,
    reason: opts.reason,
    questionIds,
  });

  if (rec && rec.acp) {
    const r = await rec.acp.post(body);
    rec.pending.delete(requestId);
    if (r.status >= 400) {
      throw new Error(`回填失败 http=${r.status} ${String(r.text).slice(0, 200)}（提问 id=${requestId}）`);
    }
    log(`已回填 ${kind} id=${requestId}`);
    return { ok: true, status: r.status, requestId, kind, via: 'live-connection' };
  }

  const creds = opts.creds || await cloud.getSession(sid, log);
  return withConnection(creds, { id: sid }, opts.acpFactory, async (acp) => {
    const r = await acp.post(body);
    return {
      ok: r.status < 400,
      status: r.status,
      requestId,
      kind,
      via: 'fresh-connection',
      // 服务端是否接受「另一条连接上的回填」没有实测过，别让调用方以为这是稳的
      verified: false,
      note: '当前进程没有该实例的活动 ACP 连接，这次是另开一条连接回的；服务端是否接受未验证',
    };
  });
}

/**
 * agent.interrupt：停掉正在跑的一轮。
 *
 * ⚠ ACP 侧**没有**验证过的「取消正在跑的一轮」的方法（客户端包里有个
 *   `_codebuddy.ai/resolveInterruption`，语义未验证，不拿它瞎试）。所以：
 *   · 有挂着的提问 → 对每条回 `{outcome:'cancelled'}`（这条是 lib/keepalive.js 在用的、
 *     有代码依据的取消手段），如实返回取消了几条；
 *   · 没有挂着的提问 → 明确返回 {ok:false, reason:'unsupported'}，**不假装成功**。
 */
async function interrupt(ctx, id, opts = {}) {
  const sid = String(id);
  const log = logf(ctx);
  const rec = LIVE.get(sid);
  const ids = rec ? [...rec.pending.keys()] : [];

  if (rec && rec.acp && ids.length) {
    const statuses = [];
    for (const requestId of ids) {
      const body = events.buildAnswerResult({
        requestId,
        kind: (rec.pending.get(requestId) || {}).kind || 'question',
        outcome: 'cancelled',
        reason: opts.reason || 'user interrupt',
      });
      const r = await rec.acp.post(body).catch((e) => ({ status: 0, text: String(e.message || e) }));
      statuses.push(r.status);
      if (r.status < 400) rec.pending.delete(requestId);
    }
    const ok = statuses.length > 0 && statuses.every((s) => s < 400);
    if (ok) log(`已取消挂起提问 ${ids.length} 条`);
    return { ok, cancelled: statuses.filter((s) => s < 400).length, total: ids.length, via: 'question-cancel', statuses };
  }

  return {
    ok: false,
    reason: 'unsupported',
    detail: 'ACP 没有验证过的「取消正在执行的一轮」的方法；当前也没有挂起的提问可以取消。' +
      '要打断 agent，目前只能等它自己结束（或断开连接 = 不再观察，但那不会让它停下）。',
  };
}

/** model.list：可用模型。控制面有 manifest.model（当前模型），ACP 的 session/load 回执里带 availableModels */
async function listModels(ctx, id, opts = {}) {
  const sid = String(id);
  const log = logf(ctx);
  const waitMs = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : 4000;

  const conv = await cloud.getConversation(sid).catch(() => null);
  const current = (conv && conv.manifest && conv.manifest.model) || null;

  let found = null;
  const creds = opts.creds || await cloud.getSession(sid, log);
  await withConnection(creds, {
    id: sid,
    onEvent: (m) => { if (!found) found = events.findAvailableModels(m); },
  }, opts.acpFactory, async (acp) => {
    // 不 unref：理由同 stream 的 idle 看门狗
    const t = setTimeout(() => { try { if (acp._ac) acp._ac.abort(); } catch { /* noop */ } }, waitMs);
    try { await acp.loop(); } catch { /* 到点断开 */ } finally { clearTimeout(t); }
  });

  return {
    current,
    available: (found || []).map((x) => ({
      id: x.id === undefined ? null : x.id,
      name: x.name === undefined ? null : x.name,
      credits: x.credits === undefined ? null : x.credits,
      maxInputTokens: x.maxInputTokens === undefined ? null : x.maxInputTokens,
      supportsToolCall: x.supportsToolCall === undefined ? null : x.supportsToolCall,
    })),
    // available 为空多半是「这一帧没抓到」（availableModels 出现在 session/load 回执里，位置未固定）
    source: found ? 'acp' : 'control-plane-only',
  };
}

async function currentModel(ctx, id) {
  const conv = await cloud.getConversation(String(id));
  return {
    model: (conv && conv.manifest && conv.manifest.model) || null,
    agentId: (conv && conv.manifest && conv.manifest.id) || null,
  };
}

module.exports = {
  BOOTSTRAP_SETTLE_MS, LIVE, createQueue, withConnection,
  stream, send, history, answer, interrupt,
  model: { list: listModels, current: currentModel },
};
