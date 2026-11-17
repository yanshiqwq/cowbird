'use strict';
// ACP 原始消息 → 契约里的归一化事件（EVENT.*）。**纯函数**，selftest 直接喂假帧。
//
// 事件从哪来：lib/acp.js 把 SSE 里的 `data:` 逐条 JSON.parse 后交出来，形状是 JSON-RPC：
//   ① 通知：{jsonrpc, method:'session/update', params:{update:{...}}}     ← 主流
//   ② 服务端→客户端的请求：{jsonrpc, id, method:'_codebuddy.ai/question', params}
//   ③ 一行的结束：{method:'session/endTurn'}
//   ④ 我们发出去的请求的回执：{id, result}
// 映射表见 README「事件映射」，与任务书里的表格一一对应。
const { EVENT } = require('../contract');

const META = 'codebuddy.ai';

/** `_meta['codebuddy.ai']`：状态、历史重放标记、工具名都在这里 */
function metaOf(update, params) {
  const a = update && update._meta && update._meta[META];
  if (a && typeof a === 'object') return a;
  const b = params && params._meta && params._meta[META];
  return b && typeof b === 'object' ? b : {};
}

/** 文本块可能是 {text}、{content:{text}}、[{type,text}] —— 都吃 */
function textOf(update) {
  if (!update) return '';
  const c = update.content;
  if (typeof c === 'string') return c;
  if (c && typeof c.text === 'string') return c.text;
  if (Array.isArray(c)) {
    return c.map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b.text === 'string') return b.text;
      return '';
    }).join('');
  }
  if (typeof update.text === 'string') return update.text;
  return '';
}

function toolIdOf(update, meta) {
  const id = update.toolCallId !== undefined ? update.toolCallId
    : update.toolCallID !== undefined ? update.toolCallID
      : update.id !== undefined ? update.id
        : meta.toolCallId !== undefined ? meta.toolCallId : null;
  return id === null || id === undefined ? null : String(id);
}

function toolNameOf(update, meta) {
  return update.toolName || update.title || meta.toolName || update.kind || null;
}

function toolInputOf(update) {
  if (update.rawInput !== undefined) return update.rawInput;
  if (update.input !== undefined) return update.input;
  if (update.arguments !== undefined) return update.arguments;
  if (update.content !== undefined) return update.content;
  return null;
}

/** 工具调用的进度/结果：status 只在 update.status 上，别跟 meta.status（会话状态）混 */
function toolResultOf(update, meta, status) {
  const outRaw = update.rawOutput !== undefined ? update.rawOutput
    : update.output !== undefined ? update.output
      : update.content !== undefined ? update.content : null;
  const s = String(status || '');
  const ok = s === 'completed' || s === 'success' ? true
    : s === 'failed' || s === 'error' || s === 'cancelled' ? false : null;
  return { kind: EVENT.TOOL_RESULT, data: { id: toolIdOf(update, meta), name: toolNameOf(update, meta), ok, out: outRaw } };
}

/** usage 目前没有实测样本：见到就转，见不到就安静跳过 */
function usageOf(params) {
  if (!params || typeof params !== 'object') return null;
  const meta = params._meta && params._meta[META];
  const u = params.usage || (meta && meta.usage) || null;
  if (!u || typeof u !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      const n = Number(u[k]);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const inputTokens = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens');
  const outputTokens = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens');
  const totalTokens = pick('totalTokens', 'total_tokens') !== null
    ? pick('totalTokens', 'total_tokens')
    : (inputTokens || 0) + (outputTokens || 0);
  if (inputTokens === null && outputTokens === null) return null;
  const data = { inputTokens, outputTokens, totalTokens };
  const credits = u.credits !== undefined ? u.credits : (meta && meta.credits);
  if (credits !== undefined) data.credits = credits;
  return { kind: EVENT.USAGE, data };
}

/** `_codebuddy.ai/question`（AskUserQuestion）：params.schema.questions[] */
function questionEvent(m) {
  const qs = ((m.params && m.params.schema && m.params.schema.questions) || []).map((q) => ({
    id: q.id !== undefined ? q.id : (q.questionId !== undefined ? q.questionId : null),
    header: q.header || '',
    question: q.question || '',
    multiSelect: !!(q.multiSelect || q.multiple),
    options: (q.options || []).map((o) => ({
      label: o.label || o.value || '',
      description: o.description || '',
    })),
  }));
  return { kind: EVENT.QUESTION, data: { requestId: m.id, questions: qs } };
}

/** `session/request_permission`：把工具名和原始 params 一起交出去，怎么批由内核决定 */
function permissionEvent(m) {
  const p = m.params || {};
  const tool = (p.toolCall && (p.toolCall.toolName || p.toolCall.title)) || p.toolName || '';
  return { kind: EVENT.PERMISSION, data: { requestId: m.id, tool, detail: p } };
}

/**
 * session/update 的细分映射。
 *
 * ⚠ session/load 会把**全部历史**重放成 session/update，重放事件带 `_meta['codebuddy.ai'].mode==='history'`。
 *   默认整条丢掉（否则「上次说过的话」会被当成新消息再推给内核一次）；
 *   includeHistory=true 时降级成 raw 并标 history:true，供 agent.history() 之类单独使用。
 */
function mapUpdate(m, opts = {}) {
  const params = (m && m.params) || {};
  const update = params.update || {};
  const meta = metaOf(update, params);
  if (meta.mode === 'history') {
    return opts.includeHistory ? [{ kind: EVENT.RAW, data: { raw: m, history: true } }] : [];
  }

  const su = String(update.sessionUpdate || '');
  const out = [];

  // 会话状态（status=working/pending/completed…）在 _meta 上，不属于任何内容块
  if (meta.status) out.push({ kind: EVENT.STATUS, data: { status: String(meta.status) } });

  switch (su) {
    case 'agent_message_chunk': {
      const text = textOf(update);
      if (text) out.push({ kind: EVENT.TEXT, data: { text } });
      break;
    }
    case 'agent_thought_chunk': {
      const text = textOf(update);
      if (text) out.push({ kind: EVENT.THINKING, data: { text } });
      break;
    }
    case 'tool_call': {
      out.push({ kind: EVENT.TOOL, data: { id: toolIdOf(update, meta), name: toolNameOf(update, meta), input: toolInputOf(update) } });
      break;
    }
    case 'tool_call_update': {
      const status = String(update.status || '');
      if (status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled') {
        out.push(toolResultOf(update, meta, status));
      } else {
        // 还在跑：当成进度事件（带 status），内核可以只更新界面不追加内容
        out.push({ kind: EVENT.TOOL, data: { id: toolIdOf(update, meta), name: toolNameOf(update, meta), input: toolInputOf(update), status: status || null } });
      }
      break;
    }
    case 'user_message_chunk':
      // 我们自己发出去的话被回显；不当作新内容，走 raw 旁路
      out.push({ kind: EVENT.RAW, data: { raw: m } });
      break;
    default:
      break;
  }

  if (!out.length) out.push({ kind: EVENT.RAW, data: { raw: m } });
  return out;
}

/**
 * 一条 ACP 消息 → 0..n 个归一化事件。
 * @param {object} m SSE 里的原始 JSON
 * @param {{includeHistory?: boolean, rawServerRequests?: boolean}} [opts]
 */
function mapMessage(m, opts = {}) {
  if (!m || typeof m !== 'object') return [];
  const method = typeof m.method === 'string' ? m.method : '';
  const hasId = m.id !== undefined && m.id !== null;

  // ① 服务端 → 客户端的**请求**。question / permission 必须由人来决定，
  //    lib/acp.js 刻意不替我们回（回了就等于替用户作答），这里原样交给内核。
  if (method && hasId) {
    if (method === '_codebuddy.ai/question') return [questionEvent(m)];
    if (method === 'session/request_permission') return [permissionEvent(m)];
    // mcp/message、elicitation/create 由 lib/acp.js 自动回；其它请求它回 -32601。这里只旁路。
    return opts.rawServerRequests === false ? [] : [{ kind: EVENT.RAW, data: { raw: m } }];
  }

  // ② 主流：会话更新
  if (method === 'session/update') return mapUpdate(m, opts);

  // ③ 一轮结束
  if (method === 'session/endTurn') {
    const out = [];
    const usage = usageOf(m.params);
    if (usage) out.push(usage);
    out.push({ kind: EVENT.DONE, data: { reason: 'endTurn' } });
    return out;
  }

  // ④ 服务端宣称提问超时（提问本身不会再来事件）
  if (method === '_codebuddy.ai/interaction_timeout') {
    return [{ kind: EVENT.RAW, data: { raw: m, note: '服务端说这条提问超时了' } }];
  }

  // ⑤ 其它（artifact、回执、心跳等）一律 raw 旁路 —— 契约要求「其它 → raw」，别私自丢
  return [{ kind: EVENT.RAW, data: { raw: m } }];
}

/**
 * 构造回填体。形状取自 docs/protocol.md「四、AskUserQuestion 回填」：
 *   {"jsonrpc":"2.0","id":<提问 id>,"result":{"outcome":"submitted","answers":{"<question id>":["选项 label"]}}}
 * 放弃则回 {"outcome":"cancelled","reason":...}（keepalive 的超时分支就是这么用的）。
 *
 * @param {{requestId:any, kind?:'question'|'permission', answers?:any, outcome?:string,
 *          reason?:string, questionIds?:any[]}} a
 */
function buildAnswerResult(a = {}) {
  const { requestId, kind = 'question', answers, outcome = 'submitted', reason, questionIds = [] } = a;
  const body = { jsonrpc: '2.0', id: requestId };

  if (outcome === 'cancelled') {
    body.result = { outcome: 'cancelled', reason: reason || 'user cancelled' };
    return body;
  }

  if (kind === 'permission') {
    // ⚠ ACP 的 permission 回执形状**没有实测样本**（仓库里只有「不回」的用法），
    //   这里按 ACP 草案写成 {outcome:'selected', optionId}，README 标了未验证。
    const optionId = answers && typeof answers === 'object' && !Array.isArray(answers)
      ? (answers.optionId !== undefined ? answers.optionId : answers.id)
      : (Array.isArray(answers) ? answers[0] : answers);
    body.result = optionId
      ? { outcome: 'selected', optionId }
      : { outcome: 'cancelled', reason: reason || 'no option selected' };
    return body;
  }

  body.result = { outcome: 'submitted', answers: normalizeAnswers(answers, questionIds) };
  return body;
}

/** answers 允许写成 {'question-id': ['标签']}、{'question-id': '标签'}、['标签1','标签2']（按题序） */
function normalizeAnswers(answers, questionIds = []) {
  if (answers === undefined || answers === null) return {};
  const out = {};
  if (Array.isArray(answers)) {
    answers.forEach((a, i) => {
      const key = questionIds[i] !== undefined && questionIds[i] !== null ? questionIds[i] : i;
      out[String(key)] = Array.isArray(a) ? a : [a];
    });
    return out;
  }
  if (typeof answers !== 'object') return {};
  for (const [k, v] of Object.entries(answers)) out[String(k)] = Array.isArray(v) ? v : [v];
  return out;
}

/**
 * 深度找一个 availableModels 数组（session/load 的回执里带，位置未固定）。
 * 有界递归：ACP 帧可以很大，别为了找模型列表把整棵树扫穿。
 */
function findAvailableModels(obj, maxDepth = 6) {
  let hit = null;
  const walk = (node, depth) => {
    if (hit || depth > maxDepth || !node || typeof node !== 'object') return;
    if (Array.isArray(node.availableModels)) { hit = node.availableModels; return; }
    const meta = node._meta && node._meta[META];
    if (meta && Array.isArray(meta.availableModels)) { hit = meta.availableModels; return; }
    for (const v of Object.values(node)) {
      if (hit) return;
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(obj, 0);
  return hit;
}

module.exports = {
  META, metaOf, textOf, mapMessage, mapUpdate, questionEvent, permissionEvent,
  usageOf, buildAnswerResult, normalizeAnswers, findAvailableModels,
};
