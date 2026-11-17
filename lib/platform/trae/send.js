// 发消息 / 等一轮跑完。
//
// 2026-11-18 实测：发消息就是 HTTP，`POST /api/remote/v1/chat_sessions/:id/messages`，
// body 是前端 buildSendMessageRequest() 那个**摊平**对象（见 model.js）。
// 之前一直 400 991102 是因为外面多包了一层 initial_message —— 不是协议不通。
const C = require('./constants');
const transport = require('./http');
const map = require('./map');
const model = require('./model');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchMessages(ctx, id, pageSize = 100) {
  const t = transport.createTransport(ctx);
  const j = await t.request('GET', `${C.Ep.messages(id)}?page_size=${pageSize}`);
  return map.itemList(j);
}

/** 发一条文本消息 → { messageId, raw } */
async function sendMessage(ctx, id, { text, query, forceNewTurn } = {}) {
  const t = transport.createTransport(ctx);
  const body = {
    chat_session_id: String(id),
    ...model.messageFields(ctx, query !== undefined ? { query } : { text }),
    ...(forceNewTurn === undefined ? {} : { force_new_turn: !!forceNewTurn }),
    origin: model.resolve(ctx).origin,
  };
  const j = await t.request('POST', C.Ep.messages(id), { body });
  const d = (j && j.data) || {};
  if (j && j.code !== undefined && j.code !== 0) {
    throw Object.assign(new Error(`发消息失败：${j.message || JSON.stringify(j).slice(0, 200)}`), { code: j.code });
  }
  return { messageId: d.message_id || null, status: d.status || null, raw: j };
}

/**
 * 发一条消息并等这一轮结束（消息数变多 + 会话状态回到 completed）。
 * agent 跑一轮要几秒到几十秒，所以必须有界。
 */
async function turn(ctx, id, text, { timeoutMs = 180000, pollMs = 3000, log = () => {} } = {}) {
  const before = await fetchMessages(ctx, id).catch(() => []);
  const n0 = before.length;
  const sent = await sendMessage(ctx, id, { text });
  const t0 = Date.now();
  let sawNew = false;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(pollMs);
    const items = await fetchMessages(ctx, id).catch(() => null);
    if (items && items.length > n0) sawNew = true;
    const inst = await (async () => {
      try {
        const t = transport.createTransport(ctx);
        const j = await t.request('GET', C.Ep.session(id));
        return map.normalizeSession((j && j.data) || {});
      } catch { return null; }
    })();
    const status = inst && inst.status;
    // 8 = 它在等用户回答（弹了确认卡片）。这一轮不会自己结束 —— 立刻返回，
    // 让上层决定是"去网页上答一下"还是换会话，别傻等到超时。
    if (status === 'pending') return { sent, ms: Date.now() - t0, tools: [], pending: true, status };
    if (sawNew && status === 'completed') {
      log(`  这一轮跑完了（${Math.round((Date.now() - t0) / 1000)}s，消息 +${(items || []).length - n0}）`);
      const outs = [];
      let summary = null;
      for (const m of (items || []).slice(n0)) {
        if (!m || m.role === 'user') continue;
        let task = m.content;
        if (typeof task === 'string') { try { task = JSON.parse(task); } catch { continue; } }
        for (const sub of (task && task.messages) || []) {
          const tc = sub && sub.plan_item && sub.plan_item.tool_call_info;
          if (!tc) continue;
          const d = (tc.result && tc.result.data) || {};
          // 拒绝执行时 agent 会调 finish，理由在 params.summary 里 —— 留着给人看
          if (/^finish$/i.test(String(tc.name || '')) && tc.params && tc.params.summary) summary = String(tc.params.summary);
          const text2 = d.output !== undefined ? d.output : (d.stdout !== undefined ? d.stdout : (d.content || ''));
          outs.push({
            name: tc.name,
            text: String(text2 || ''),
            exitCode: d.exit_code === undefined ? undefined : d.exit_code,
            status: (tc.result && tc.result.status) || null,
          });
        }
      }
      return { sent, ms: Date.now() - t0, tools: outs, summary };
    }
  }
  return { sent, ms: Date.now() - t0, tools: [], timeout: true };
}

module.exports = { sendMessage, turn, fetchMessages };
