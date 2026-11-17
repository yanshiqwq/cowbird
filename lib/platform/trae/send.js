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
async function turn(ctx, id, text, { timeoutMs = 180000, pollMs = 3000, log = () => {}, onPending } = {}) {
  const before = await fetchMessages(ctx, id).catch(() => []);
  const n0 = before.length;
  const sent = await sendMessage(ctx, id, { text });
  const t0 = Date.now();
  let sawNew = false;
  let triedPending = false;

  // 把这一轮新增的 plan_item 摊平成 {name,text,exitCode,status}，顺带留 finish 的 summary
  const collect = (items) => {
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
    return { tools: outs, summary };
  };

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

    // 8 = 这一轮停住了（要么在等用户回答确认卡片，要么 agent 自己 finish 了就停在这）。
    // 先看有没有卡片可答；没有就当结束 —— 之前把它一律当成"在提问"，结果白等到超时。
    if (status === 'pending') {
      if (onPending && !triedPending) {
        triedPending = true;
        const r = await onPending().catch((e) => ({ ok: false, err: String(e.message) }));
        if (r && r.ok) {
          sawNew = true;
          await sleep(pollMs);
          continue;                       // 卡片答掉了，继续等它跑
        }
      }
      log('  这一轮停住了（status=pending，没有可答的卡片），按结束处理');
      const c = collect(items || []);
      return { sent, ms: Date.now() - t0, tools: c.tools, summary: c.summary, stopped: true };
    }

    if (sawNew && status === 'completed') {
      log(`  这一轮跑完了（${Math.round((Date.now() - t0) / 1000)}s，消息 +${(items || []).length - n0}）`);
      const c = collect(items || []);
      return { sent, ms: Date.now() - t0, tools: c.tools, summary: c.summary };
    }
  }
  return { sent, ms: Date.now() - t0, tools: [], timeout: true };
}

/**
 * 回答沙箱里 agent 弹出来的确认卡片（AskUserQuestion）。
 *
 * 平台把这类确认做成「plan_item + confirm_info」，答案走
 * `POST /chat_sessions/:id/user_decision`（普通 HTTP，不需要 WS）：
 *   { chat_session_id, type:"tool_confirm", plan_item_id, tool_name:"AskUserQuestion",
 *     decision:"confirm", params: JSON.stringify({questions, answers}) }
 *
 * 卡片上的选项**每次都不一样**（"先不安装"/"只加全局"/"按原样"…），所以不走预设选项，
 * 统一用「其他 + 自定义文本」：answers 里给 custom_input。
 */
async function answerPendingQuestion(ctx, id, { text = '确认执行', log = () => {}, tries = 6, gapMs = 2000 } = {}) {
  // 时序：会话状态先变 pending，AskUserQuestion 那条 plan_item 落库晚一两秒 —— 必须轮询等它出现
  const find = async () => {
    const items = await fetchMessages(ctx, id, 100);
    let hit = null;
    for (const m of items) {
      if (!m || m.role === 'user') continue;
      let task = m.content;
      if (typeof task === 'string') { try { task = JSON.parse(task); } catch { continue; } }
      for (const sub of (task && task.messages) || []) {
        const pi = sub && sub.plan_item;
        const tc = pi && pi.tool_call_info;
        if (tc && /^AskUserQuestion$/i.test(String(tc.name || ''))) hit = pi;
      }
    }
    return hit;
  };
  let hit = await find();
  for (let i = 1; !hit && i < tries; i++) {
    await sleep(gapMs);
    hit = await find();
  }
  if (!hit) return { ok: false, why: 'no-question' };

  const questions = (hit.tool_call_info.params && hit.tool_call_info.params.questions) || [];
  const answers = questions.length ? questions.map(() => ({ custom_input: text })) : [{ custom_input: text }];
  const t = transport.createTransport(ctx);
  await t.request('POST', `/api/remote/v1/chat_sessions/${encodeURIComponent(id)}/user_decision`, {
    body: {
      chat_session_id: String(id),
      type: 'tool_confirm',
      plan_item_id: hit.id,
      tool_name: 'AskUserQuestion',
      decision: 'confirm',
      params: JSON.stringify({ questions, answers }),
    },
  });
  log(`它弹了确认卡片（${questions.length} 题），已按「其他」填「${text}」提交`);
  return { ok: true, planItemId: hit.id, questions: questions.length };
}

module.exports = { sendMessage, turn, fetchMessages, answerPendingQuestion };
