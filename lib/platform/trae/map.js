// 纯函数：TRAE 的原始结构 → 内核认的形状。
//
// 消息体是三层嵌套：「消息 → task → plan_item → tool_call_info{name,params,result}」。
// 解析它的目的只有一个：把 agent 干了什么还原成归一事件（tool/tool_result/text/done），
// 让 `cowbird watch` / `prompt` 在 TRAE 上看到的东西和别的平台一致。
const { EVENT } = require('../contract');
const { STATUS } = require('./constants');

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** epoch 毫秒（字符串或数字）→ ISO */
function toIso(v) {
  const n = toNum(v);
  if (!n) return null;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

function statusOf(raw) {
  const n = toNum(raw);
  if (n === null) return String(raw || 'unknown');
  return STATUS[n] || `status-${n}`;
}

/** 会话 → Instance */
function normalizeSession(raw = {}) {
  const extra = raw.extra || {};
  const sandbox = raw.sandbox || null;
  return {
    id: String(raw.chat_session_id || raw.id || ''),
    name: raw.title || raw.name || '',
    status: statusOf(raw.status),
    platformStatus: raw.status === undefined ? null : raw.status,
    updatedAt: toIso(raw.updated_at || raw.updatedAt),
    createdAt: toIso(raw.created_at || raw.createdAt),
    archived: Boolean(raw.is_archived),
    extra: {
      mode: raw.mode || null,
      origin: raw.origin || null,
      sandboxType: extra.primary_sandbox_type || null,     // harness / agent
      explorerUrl: raw.explorer_url || null,                // 沙箱数据面（WS）
      vncUrl: raw.vnc_url || null,
      previewUrl: raw.preview_url || null,
      workspacePath: raw.workspace_path || null,
      remoteProjectId: raw.remote_project_id || null,
      projectId: raw.project_id || null,
      unread: Boolean(raw.is_unread),
      sandbox: sandbox && {
        name: sandbox.name || null,
        cluster: sandbox.cluster_name || null,
        pod: sandbox.pod_name || null,
        allocationStatus: sandbox.allocation_status || null,
      },
    },
    raw,
  };
}

/** 消息列表（`data.items`）→ 数组，容错几种包装 */
function itemList(json) {
  const d = (json && json.data) || {};
  if (Array.isArray(json)) return json;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(json.items)) return json.items;
  return [];
}

/** 用户消息的正文（content 是 JSON 字符串数组） */
function userText(m) {
  let c = m && m.content;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch { return String(m.content).slice(0, 4000); }
  }
  if (!Array.isArray(c)) return '';
  return c.map((x) => (x && (x.text_content || (x.data && x.data.content))) || '').join('').slice(0, 4000);
}

/** 单条消息 → 归一事件数组 */
function itemEvents(m) {
  const out = [];
  if (!m) return out;
  const role = m.role;
  if (role === 'user') {
    const t = userText(m);
    if (t) out.push({ kind: EVENT.TEXT, data: { text: t, role: 'user' } });
    return out;
  }
  let task = m.content;
  if (typeof task === 'string') {
    try { task = JSON.parse(task); } catch { task = null; }
  }
  const subs = (task && task.messages) || [];
  for (const sub of subs) {
    const pi = (sub && sub.plan_item) || null;
    const tc = pi && pi.tool_call_info;
    if (!tc) {
      // 只有文本的 plan_item：thought 里往往就是 agent 的正文
      const thought = pi && (pi.thought || pi.text);
      if (thought) out.push({ kind: EVENT.TEXT, data: { text: String(thought) } });
      continue;
    }
    out.push({
      kind: EVENT.TOOL,
      data: {
        id: tc.id || null,
        name: tc.name || 'tool',
        input: tc.params || {},
      },
    });
    const res = tc.result || {};
    const data = (res && res.data) || {};
    const textOut = data.stdout !== undefined || data.stderr !== undefined
      ? `${data.stdout || ''}${data.stderr ? '\n' + data.stderr : ''}`.trim()
      : (data.content || data.text || data.output || '');
    out.push({
      kind: EVENT.TOOL_RESULT,
      data: {
        id: tc.id || null,
        name: tc.name || 'tool',
        ok: res.status !== 'error' && (data.exit_code === undefined || data.exit_code === 0),
        out: String(textOut || '').slice(0, 4000),
        exitCode: data.exit_code === undefined ? null : data.exit_code,
      },
    });
  }
  if (m.token_usage) {
    const u = typeof m.token_usage === 'string' ? safeJson(m.token_usage) : m.token_usage;
    if (u) out.push({ kind: EVENT.USAGE, data: { totalTokens: u.total_tokens || u.totalTokens || null, inputTokens: u.input_tokens || null, outputTokens: u.output_tokens || null } });
  }
  return out;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

/** 整页消息 → 归一事件（历史回放用） */
function messagesToEvents(items) {
  const out = [];
  for (const m of items || []) out.push(...itemEvents(m));
  return out;
}

/** 整页消息 → 人类可读历史（history 命令用） */
function messagesToHistory(items) {
  const out = [];
  for (const m of items || []) {
    if (!m) continue;
    if (m.role === 'user') {
      const text = userText(m);
      if (text) out.push({ role: 'user', text, index: m.message_index, at: toIso(m.created_at) });
      continue;
    }
    const evs = itemEvents(m);
    for (const ev of evs) {
      if (ev.kind === EVENT.TEXT) out.push({ role: 'assistant', text: ev.data.text, index: m.message_index, at: toIso(m.created_at) });
      else if (ev.kind === EVENT.TOOL) out.push({ role: 'tool', text: `[${ev.data.name}] ${JSON.stringify(ev.data.input).slice(0, 300)}`, index: m.message_index });
      else if (ev.kind === EVENT.TOOL_RESULT) out.push({ role: 'tool', text: `[${ev.data.name}] ${ev.data.ok ? 'ok' : 'exit=' + ev.data.exitCode} ${String(ev.data.out || '').slice(0, 300)}`, index: m.message_index });
    }
  }
  return out;
}

/**
 * sendMessage 的请求体。
 *
 * ⚠ **未打通**：13 种形状全被上游回 `400 {"code":991102,"message":"invalid parameter"}`
 * （camel/snake、数组/JSON 字符串、userMessage 包裹、messages/parts/query…）。
 * 前端是通用 adapter，静态代码读不出字段名，只能从浏览器真实请求里抓 —— 已派给
 * `trae-dataplane` 子代理，拿到形状后改这一个函数即可。
 */
function buildSendBody(text) {
  const t = String(text || '');
  return {
    userMessage: {
      content: JSON.stringify([{ type: 'text', text_content: t }]),
      query: JSON.stringify([{ type: 'text', data: { content: t } }]),
      references: '[]',
    },
    forceNewTurn: true,
  };
}

module.exports = {
  toIso, statusOf, normalizeSession, itemList, userText, itemEvents,
  messagesToEvents, messagesToHistory, buildSendBody, safeJson,
};
