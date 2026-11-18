'use strict';
// MiniMax 的会话 / 消息 → 内核形状（Instance / Event）的映射。
//
// 这里是**纯函数**：不联网、不读 store、不看时间，selftest 直接喂假响应就能验。
// 消息模型（实测）：
//   { msg_id, msg_type:1|2, role:'user'|'assistant', msg_content, thinking_content,
//     thinking_duration_ms, finish_reason, turn_id, usage{...},
//     tool_calls:[{tool_name, tool_call_id, tool_call_status,
//                  tool_call_args(JSON 字符串),
//                  tool_call_result_data(JSON 字符串，含 content[].text 与 details{exit_code,duration_ms})}] }
//
// 关键设计：SSE 与轮询拿到的可能是**同一条消息的累计快照**（也可能只是增量）。
// 所以文本类事件一律走「快照 → 增量」的差分，而不是"见过这个 msg_id 就丢掉"，
// 这样两种语义都不会重复吐字，也不会漏字。
const { EVENT } = require('../contract');

// status_type 实测只有两个值：0 正常、3 user_aborted。其余一律 unknown_<n>，不瞎猜。
const STATUS_NAMES = { 0: 'idle', 3: 'aborted' };

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(ms) {
  const n = numOrNull(ms);
  if (n === null) return null;
  try { return new Date(n).toISOString(); } catch { return null; }
}

function parseJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * 快照差分：把「这次看到的全文」与「上次看到的全文」比出新增部分。
 * - next 以 prev 开头 → 累计式，取后缀；
 * - prev 以 next 结尾 → 重复帧，无新增；
 * - 否则当增量式，整段都是新的。
 */
function deltaOf(prev, next) {
  const p = String(prev == null ? '' : prev);
  const n = String(next == null ? '' : next);
  if (!n) return '';
  if (!p) return n;
  if (n === p) return '';
  if (n.startsWith(p)) return n.slice(p.length);
  if (p.endsWith(n)) return '';
  return n;
}

// ---------------------------------------------------------------------------
// 会话 → Instance
// ---------------------------------------------------------------------------

function modelOf(m) {
  if (!m || typeof m !== 'object') return null;
  const thinking = m.thinking && typeof m.thinking === 'object'
    ? { effort: m.thinking.effort || null, forced: m.thinking.forced === undefined ? null : !!m.thinking.forced }
    : null;
  return {
    providerId: m.provider_id || null,
    modelId: m.model_id || null,
    variant: m.variant === undefined ? null : m.variant,
    contextLimit: numOrNull(m.context_limit),
    supportedVariants: Array.isArray(m.supported_variants) ? m.supported_variants.slice() : null,
    reasoning: m.reasoning === undefined ? null : !!m.reasoning,
    thinking,
  };
}

function statusOf(status) {
  const raw = status && typeof status === 'object' ? status : {};
  const type = numOrNull(raw.status_type !== undefined ? raw.status_type : raw.type);
  const t = type === null ? 0 : type;
  return {
    statusType: t,
    status: STATUS_NAMES[t] || `unknown_${t}`,
    message: raw.message || '',
  };
}

/**
 * 单个 session → Instance。
 * 会话本身没有「名字」，用 title 当 name（ls / 按名字解析都靠它）。
 */
function sessionToInstance(s) {
  const src = s && typeof s === 'object' ? s : {};
  const id = String(src.session_id || src.sessionId || '');
  const st = statusOf(src.status);
  const createdMs = numOrNull(src.created_at !== undefined ? src.created_at : src.createdAt);
  const updatedMs = numOrNull(src.updated_at !== undefined ? src.updated_at : src.updatedAt);
  return {
    id,
    name: String(src.title || id),
    title: String(src.title || ''),
    status: st.status,
    statusType: st.statusType,
    statusMessage: st.message,
    archived: !!src.archived,
    createdAt: isoOrNull(createdMs),
    createdAtMs: createdMs,
    updatedAt: isoOrNull(updatedMs),
    updatedAtMs: updatedMs,
    agentName: String(src.agent_name || ''),
    sessionType: src.session_type === undefined ? null : src.session_type,
    teamMode: !!src.team_mode,
    projectId: src.project_id === undefined ? null : src.project_id,
    model: modelOf(src.model),
    raw: src,
  };
}

/**
 * `/sidebar/session/tree` → Instance[]（按 updated_at 倒序，最新的在前）。
 * 该端点返回 {sessions:[{session:{...}}]}，但别把形状写死：也认裸数组与 {data:{sessions}}。
 */
function treeToInstances(data, { includeArchived = false } = {}) {
  let rows = [];
  if (Array.isArray(data)) rows = data;
  else if (data && Array.isArray(data.sessions)) rows = data.sessions;
  else if (data && data.data && Array.isArray(data.data.sessions)) rows = data.data.sessions;
  else if (data && data.data && Array.isArray(data.data)) rows = data.data;

  const out = [];
  for (const row of rows) {
    const s = row && row.session && typeof row.session === 'object' ? row.session : row;
    if (!s || typeof s !== 'object') continue;
    if (!s.session_id && !s.sessionId) continue;
    const inst = sessionToInstance(s);
    if (!includeArchived && inst.archived) continue;
    out.push(inst);
  }
  out.sort((a, b) => (numOrNull(b.updatedAtMs) || 0) - (numOrNull(a.updatedAtMs) || 0));
  return out;
}

/** `/session/{id}` 的响应可能是 {session}, {data:{session}} 或裸 session */
function pickSession(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.session && typeof data.session === 'object') return data.session;
  if (data.data && data.data.session && typeof data.data.session === 'object') return data.data.session;
  if (data.session_id) return data;
  if (data.data && typeof data.data === 'object' && data.data.session_id) return data.data;
  return data;
}

/** `/session/{id}/message` → 消息数组 */
function pickMessages(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.messages)) return data.messages;
  if (data.data) {
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.data.messages)) return data.data.messages;
  }
  if (data.msg_id) return [data];
  return [];
}

// ---------------------------------------------------------------------------
// 消息 → 事件
// ---------------------------------------------------------------------------

/** 一条流的映射状态：跨多次轮询/多帧 SSE 复用，保证不重复吐字 */
function newState() {
  return {
    seenMessages: new Set(),   // 非 assistant 消息（只吐一次 raw 旁路）
    messages: new Map(),       // msg_id → 该消息已吐到哪儿
    toolResults: new Set(),    // 全局工具结果去重（跨消息）
    done: false,
  };
}

function messageState(state, id) {
  let st = state.messages.get(id);
  if (!st) {
    st = { thinkSnap: '', textSnap: '', tools: new Set(), usageKey: null, done: false, finishSeen: '' };
    state.messages.set(id, st);
  }
  return st;
}

function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const input = numOrNull(u.input_tokens !== undefined ? u.input_tokens : u.inputTokens) || 0;
  const output = numOrNull(u.output_tokens !== undefined ? u.output_tokens : u.outputTokens) || 0;
  const total = numOrNull(u.total_tokens !== undefined ? u.total_tokens : u.totalTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total === null ? input + output : total,
    cacheRead: numOrNull(u.cache_read !== undefined ? u.cache_read : u.cacheRead),
    contextWindow: numOrNull(u.context_window !== undefined ? u.context_window : u.contextWindow),
  };
}

/**
 * tool_call_result_data → tool_result 事件数据。
 * details.exit_code 存在时以它判 ok；否则看 is_error；都没有就给 null（别假装成功）。
 */
function toolResultOf(tc) {
  const cid = String(tc.tool_call_id || tc.id || '');
  const name = String(tc.tool_name || tc.name || '');
  const raw = tc.tool_call_result_data;
  const parsed = parseJson(raw);
  const content = parsed && Array.isArray(parsed.content) ? parsed.content : [];
  const texts = content
    .map((c) => (c && typeof c.text === 'string' ? c.text : (typeof c === 'string' ? c : '')))
    .filter((t) => t !== '');
  let out = texts.join('\n');
  if (!out && typeof raw === 'string' && !parsed) out = raw;
  const d = (parsed && parsed.details) || {};
  const exitCode = numOrNull(d.exit_code !== undefined ? d.exit_code : d.exitCode);
  let ok = null;
  if (exitCode !== null) ok = exitCode === 0;
  else if (parsed && parsed.is_error !== undefined) ok = !parsed.is_error;
  return {
    id: cid,
    name,
    ok,
    out,
    exitCode,
    durationMs: numOrNull(d.duration_ms !== undefined ? d.duration_ms : d.durationMs),
    truncated: d.output_truncated === true,
    dispatchedLocally: d.dispatched_locally === undefined ? null : !!d.dispatched_locally,
    skipReason: d.local_dispatch_skip_reason || null,
    status: numOrNull(tc.tool_call_status),
  };
}

/**
 * 单条消息 → 事件数组（顺序：thinking → text → tool → tool_result → usage → done）。
 * 对同一条消息反复调用是安全的：只会吐出"新增"的部分。
 */
/**
 * 首轮快照里"已经结束"的消息 id。
 *
 * 用途：`/message` 每次返回**全量历史**，驱动没有游标。开流第一帧里那些
 * `finish_reason === 'endTurn'` 的消息就是历史 —— 把它们记成基线、逐帧跳过，
 * 才不会被当成"本轮新回复"重放。
 *
 * 为什么只收"已结束"的：首帧里还没结束的那条可能正是用户刚发/正在流的回复，
 * 必须照常处理（否则会漏字甚至漏 done）。没有 msg_id 的消息一律不收 —— 宁可维持
 * 旧行为（可能重放），也不猜。
 */
function baselineIds(msgs) {
  const out = new Set();
  for (const m of msgs || []) {
    if (!m || typeof m !== 'object') continue;
    const id = String(m.msg_id || m.message_id || '');
    if (!id) continue;
    const role = String(m.role || 'assistant');
    // 真机实测（2026-11-18）：用户消息没有 finish_reason；assistant 拿到的值是 stop / toolUse。
    // 用户消息天然"已完成"；assistant 只有 finish_reason 非空才算结束（空 = 还在流）。
    if (role !== 'assistant' || String(m.finish_reason || '') !== '') out.add(id);
  }
  return out;
}
function messageToEvents(msg, state = newState()) {
  const out = [];
  if (!msg || typeof msg !== 'object') return out;

  const id = String(msg.msg_id || msg.message_id || '');
  const msgType = numOrNull(msg.msg_type);
  const role = String(msg.role || (msgType === 1 ? 'user' : 'assistant'));

  // 用户消息 → raw 旁路（回看历史用），并且只吐一次
  if (role !== 'assistant') {
    const key = id || '__user_anon__';
    if (state.seenMessages.has(key)) return out;
    state.seenMessages.add(key);
    out.push({ kind: EVENT.RAW, data: { raw: msg, source: 'user_message' } });
    return out;
  }

  const st = messageState(state, id || '__assistant_anon__');

  // 1) 思维链（全量返回 + 时长，实测是这样）
  const think = typeof msg.thinking_content === 'string' ? msg.thinking_content : '';
  const thinkDelta = deltaOf(st.thinkSnap, think);
  if (thinkDelta) {
    out.push({
      kind: EVENT.THINKING,
      data: { text: thinkDelta, durationMs: numOrNull(msg.thinking_duration_ms) },
    });
  }
  if (think) st.thinkSnap = think;

  // 2) 正文：按 role 判断。**真机实测 msg_type 恒为 1**（user 与 assistant 都是 1），
  //    早先拿 `msg_type===2` 当"助手可见文本"的门，结果真实回复一个字的正文都吐不出来。
  if (role === 'assistant') {
    const text = typeof msg.msg_content === 'string' ? msg.msg_content : '';
    const textDelta = deltaOf(st.textSnap, text);
    if (textDelta) out.push({ kind: EVENT.TEXT, data: { text: textDelta } });
    if (text) st.textSnap = text;
  }

  // 3) 工具调用与结果
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const tc of calls) {
    if (!tc || typeof tc !== 'object') continue;
    const cid = String(tc.tool_call_id || tc.id || '');
    const name = String(tc.tool_name || tc.name || '');
    const key = cid || `${name}@${out.length}`;
    if (!st.tools.has(key)) {
      const input = parseJson(tc.tool_call_args);
      out.push({
        kind: EVENT.TOOL,
        data: {
          id: cid,
          name,
          input: input === null ? null : input,
          // 参数是 JSON 字符串；解析失败时留原文，别把信息吞了
          rawArgs: typeof tc.tool_call_args === 'string' && input === null ? tc.tool_call_args : null,
          status: numOrNull(tc.tool_call_status),
        },
      });
      st.tools.add(key);
    }
    if (tc.tool_call_result_data && !state.toolResults.has(cid || key)) {
      out.push({ kind: EVENT.TOOL_RESULT, data: toolResultOf(tc) });
      state.toolResults.add(cid || key);
    }
  }

  // 4) 用量（只在变化时吐，避免每帧重复）
  if (msg.usage && typeof msg.usage === 'object') {
    const u = usageOf(msg.usage);
    const key = `${u.inputTokens}/${u.outputTokens}/${u.totalTokens}/${u.cacheRead}`;
    if (key !== st.usageKey) {
      out.push({ kind: EVENT.USAGE, data: u });
      st.usageKey = key;
    }
  }

  // 5) 结束：finish_reason==='endTurn'
  const finish = String(msg.finish_reason || '');
  if (finish === 'endTurn') {
    if (!st.done && !state.done) {
      out.push({ kind: EVENT.DONE, data: { reason: 'endTurn' } });
      st.done = true;
      state.done = true;
    }
  } else if (finish && finish !== st.finishSeen) {
    // toolUse / maxTokens 之类：不当作结束，但留一条 raw 旁路便于排障
    st.finishSeen = finish;
    out.push({ kind: EVENT.RAW, data: { raw: { msg_id: id, finish_reason: finish }, source: 'finish_reason' } });
  }

  return out;
}

function statusEvent(statusObj) {
  const st = statusOf(statusObj);
  return { kind: EVENT.STATUS, data: { status: st.status, statusType: st.statusType, message: st.message } };
}

/** 去掉 {type, data}/{event, payload} 这种外面一层壳 */
function unwrap(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
  for (const k of ['data', 'payload', 'body']) {
    const inner = p[k];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      if (inner.msg_id || inner.msg_type !== undefined || inner.session_id || inner.status_type !== undefined || inner.status || inner.messages) return inner;
    }
  }
  return p;
}

/**
 * 任意 SSE 负载 → 事件。
 * 覆盖面：整条消息 / 消息数组 / {messages} / 会话状态 / {type:'done'} / {type:'error'}，
 * 认不出来的一律 raw（宁多吐一条旁路，也别把平台的新字段吃掉）。
 */
function payloadToEvents(payload, state = newState()) {
  const out = [];
  if (payload === null || payload === undefined) return out;

  if (Array.isArray(payload)) {
    for (const m of payload) out.push(...messageToEvents(m, state));
    return out;
  }
  if (typeof payload !== 'object') {
    out.push({ kind: EVENT.RAW, data: { raw: payload } });
    return out;
  }
  if (payload.__done) {
    if (!state.done) { state.done = true; out.push({ kind: EVENT.DONE, data: { reason: 'endTurn' } }); }
    return out;
  }
  if (payload.__text !== undefined) {
    out.push({ kind: EVENT.RAW, data: { raw: payload.__text, event: payload.event || null } });
    return out;
  }

  const p = unwrap(payload);

  if (Array.isArray(p)) return payloadToEvents(p, state);
  if (Array.isArray(p.messages)) return payloadToEvents(p.messages, state);

  if (p.msg_id || p.msg_type !== undefined || p.msg_content !== undefined) {
    return messageToEvents(p, state);
  }

  if (p.status && typeof p.status === 'object' && (p.status.status_type !== undefined || p.status.message !== undefined)) {
    out.push(statusEvent(p.status));
    return out;
  }
  if (p.status_type !== undefined) {
    out.push(statusEvent(p));
    return out;
  }

  const type = String(p.type || p.event || '').toLowerCase();
  if (type === 'done' || type === 'end' || type === 'finish' || type === 'endturn') {
    if (!state.done) { state.done = true; out.push({ kind: EVENT.DONE, data: { reason: p.reason || 'endTurn' } }); }
    return out;
  }
  if (type === 'error' || p.error) {
    out.push({ kind: EVENT.ERROR, data: { message: String((p.error && (p.error.message || p.error)) || p.message || 'unknown'), code: (p.error && p.error.code) || p.code || null } });
    return out;
  }

  out.push({ kind: EVENT.RAW, data: { raw: payload, event: p.type || p.event || null } });
  return out;
}

module.exports = {
  STATUS_NAMES,
  baselineIds,
  newState,
  deltaOf,
  parseJson,
  modelOf,
  statusOf,
  sessionToInstance,
  treeToInstances,
  pickSession,
  pickMessages,
  usageOf,
  toolResultOf,
  messageToEvents,
  payloadToEvents,
  statusEvent,
  numOrNull,
  isoOrNull,
};
