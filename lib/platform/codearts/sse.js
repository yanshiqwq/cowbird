// 回合 SSE 解析与事件映射（纯函数，离线可测）。
//
// 本平台的回合流是**具名 SSE**：一次 `POST …/sessions/:id/messages` 的响应体就是整轮，
// 帧形如：
//     event: message
//     data: {"content":"…","index":0,"part_id":"…"}
//
// 两个必须记住的语义（实测）：
//   1. `error` 帧兼任「流正常结束」哨兵：
//        type === 'stream_ended'  或  error_code === 'CODEBASE.00010628.200'
//      这时它是 done，不是失败。当成失败会把每一轮都误判成报错。
//   2. `heartbeat` 在提问挂起期间约 15 秒一条，是唯一的"还活着"信号。
//      解析层不丢弃它 —— 交给上层刷新存活时间（这里映射成 raw + alive:true），
//      否则挂起提问时会被空闲超时误杀。

const { EVENT } = require('../contract');

const STREAM_ENDED_CODE = 'CODEBASE.00010628.200';

/** 平台状态词 → 归一状态词（原始值放 original 里，别丢） */
const STATUS_MAP = { initializing: 'starting', processing: 'running', retry: 'retrying' };

function isStreamEnded(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.type === 'stream_ended') return true;
  if (d.error_code === STREAM_ENDED_CODE) return true;
  if (d.errorCode === STREAM_ENDED_CODE) return true;
  return false;
}

/** 空块/纯注释块丢弃；具名事件即使没有 data 也保留。
 *  增量解析已上提到 lib/platform/sse.js（qoder / minimax 共用同一份）。 */
const { createParser, framesFromText } = require('../sse');

/** questions[] 归一（question 事件与提问回答都用它） */
function normalizeQuestions(list) {
  return (Array.isArray(list) ? list : []).map((q) => {
    const o = q || {};
    return {
      header: o.header || o.title || '',
      question: o.question || o.text || o.prompt || '',
      multiple: !!o.multiple,
      options: (Array.isArray(o.options) ? o.options : []).map((x) => ({
        label: x && x.label !== undefined ? String(x.label) : String((x && x.value) || ''),
        description: x && x.description !== undefined ? String(x.description) : '',
      })),
      raw: o,
    };
  });
}

function asText(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : String(v);
}

/**
 * 一帧 → 若干归一化事件（数组：可能一帧带 0 个或 2 个）。
 *
 * | 原始 | kind |
 * | status(processing/initializing/retry) | status |
 * | message | text |
 * | thought | thinking |
 * | tool_call / tool_call_delta | tool |
 * | tool_result | tool_result |
 * | question | question |
 * | tool_authorization | permission |
 * | step_finish | usage |
 * | done / stopped / error(stream_ended…) | done |
 * | heartbeat / file_diff / session_title / 其它 | raw |
 */
function mapFrame(frame) {
  if (!frame || !frame.event) return [];
  const ev = String(frame.event);
  const d = (frame.json && typeof frame.json === 'object') ? frame.json : {};
  const out = [];

  // 不是 JSON 的帧（极少见）不要静默丢掉：原样交给上层，出问题时能看见
  if (frame.json === null && frame.text) {
    return [{ kind: EVENT.RAW, data: { raw: { event: ev, text: frame.text }, unparsed: true } }];
  }

  switch (ev) {
    case 'status': {
      const raw = asText(d.status) || 'processing';
      out.push({ kind: EVENT.STATUS, data: { status: STATUS_MAP[raw] || raw, original: raw, turnId: d.turn_id || null, messageId: d.message_id || null } });
      break;
    }
    case 'message': {
      const text = asText(d.content);
      if (text) out.push({ kind: EVENT.TEXT, data: { text, partId: d.part_id || null, index: d.index ?? null, messageType: d.message_type || null } });
      break;
    }
    case 'thought': {
      const text = asText(d.content);
      if (text) out.push({ kind: EVENT.THINKING, data: { text, partId: d.part_id || null, index: d.index ?? null } });
      break;
    }
    case 'tool_call': {
      const params = d.params && typeof d.params === 'object' ? d.params : {};
      out.push({
        kind: EVENT.TOOL,
        data: {
          id: d.call_id || d.part_id || d.id || null,
          name: asText(d.tool || d.name),
          input: params,
          partial: Object.keys(params).length === 0,   // 首帧 params 恒为 {}，随后同 id 再来一帧补全
          partId: d.part_id || null,
          callId: d.call_id || null,
        },
      });
      break;
    }
    case 'tool_call_delta': {
      // input 是流式拼接的参数片段，可能已经是对象也可能还是字符串
      const input = d.input && typeof d.input === 'object' && 'input' in d.input ? d.input.input : d.input;
      out.push({ kind: EVENT.TOOL, data: { id: d.call_id || d.part_id || null, name: asText(d.tool || d.name), input, delta: true, partId: d.part_id || null } });
      break;
    }
    case 'tool_result': {
      const status = asText(d.status);
      const failed = !!d.error || /error|fail/i.test(status);
      out.push({
        kind: EVENT.TOOL_RESULT,
        data: {
          id: d.call_id || d.part_id || d.id || null,
          name: asText(d.tool || d.name),
          ok: !failed && (status === '' || /complet|success|ok/i.test(status)),
          status,
          out: d.result !== undefined ? d.result : (d.output !== undefined ? d.output : ''),
          error: d.error || null,
          title: d.title || null,
        },
      });
      break;
    }
    case 'question': {
      out.push({
        kind: EVENT.QUESTION,
        data: {
          requestId: d.question_id || d.questionId || null,
          callId: d.call_id || d.callId || null,
          turnId: d.turn_id || null,
          questions: normalizeQuestions(d.questions),
          raw: d,
        },
      });
      break;
    }
    case 'tool_authorization': {
      out.push({
        kind: EVENT.PERMISSION,
        data: {
          requestId: d.permission_id || d.permissionId || null,
          tool: asText(d.permission || d.tool),
          detail: d.patterns !== undefined ? d.patterns : (d.reply !== undefined ? d.reply : null),
          auto: !!d.auto,
          raw: d,
        },
      });
      break;
    }
    case 'step_finish': {
      const t = d.tokens || {};
      const cache = t.cache || {};
      out.push({
        kind: EVENT.USAGE,
        data: {
          inputTokens: Number(t.input) || 0,
          outputTokens: Number(t.output) || 0,
          totalTokens: Number(t.total) || (Number(t.input) || 0) + (Number(t.output) || 0),
          reasoningTokens: Number(t.reasoning) || 0,
          cacheReadTokens: Number(cache.read) || 0,
          cacheWriteTokens: Number(cache.write) || 0,
          cost: d.cost ?? null,
          reason: d.reason || null,
        },
      });
      break;
    }
    case 'done': {
      const c = d.credit_cost_for_web || {};
      out.push({
        kind: EVENT.DONE,
        data: {
          reason: 'done',
          turnId: d.turn_id || null,
          latencyMs: d.latency_ms ?? null,
          credits: c.credit_cost ?? null,
          tokens: d.tokens || null,
          artifacts: d.artifact_summary || null,
        },
      });
      break;
    }
    case 'stopped': {
      out.push({ kind: EVENT.DONE, data: { reason: 'stopped', partialMessageId: d.partial_message_id || null } });
      break;
    }
    case 'error': {
      if (isStreamEnded(d)) {
        // ★ 哨兵：这一轮服务端正常结束了
        out.push({ kind: EVENT.DONE, data: { reason: 'stream_ended', platformCode: d.error_code || null } });
      } else {
        out.push({
          kind: EVENT.ERROR,
          data: {
            message: asText(d.error_msg || d.error || d.message) || '平台返回了一个错误帧',
            code: d.error_code || d.type || null,
            type: d.type || null,
            raw: d,
          },
        });
      }
      break;
    }
    case 'heartbeat': {
      // 不丢：上层靠它刷新"还活着"。kind 用 raw，但要带 alive 标记
      out.push({ kind: EVENT.RAW, data: { raw: d, heartbeat: true, alive: true, ts: d.ts ?? null } });
      break;
    }
    case 'file_diff': {
      out.push({ kind: EVENT.RAW, data: { raw: d, fileDiff: true, diff: d.diff || [] } });
      break;
    }
    case 'session_title': {
      // agent 自动起标题，一轮里可能发多次 —— 上面可以据此改名
      out.push({ kind: EVENT.RAW, data: { raw: d, title: asText(d.title), turnId: d.turn_id || null } });
      break;
    }
    default: {
      out.push({ kind: EVENT.RAW, data: { raw: { event: ev, data: frame.json !== null ? frame.json : frame.text } } });
    }
  }

  return out.filter((x) => x.kind);
}

module.exports = {
  STREAM_ENDED_CODE, STATUS_MAP,
  createParser, framesFromText, parseFrame: (f) => f, normalizeQuestions, mapFrame, isStreamEnded,
};
