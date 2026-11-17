// 事件流工具：把 provider 归一化后的 Event 流变成命令层好用的东西。
//
// core 不关心平台怎么产出事件，只做「收集 / 等待结束 / 打印」。
const { EVENT } = require('./contract');

/** 采集整条流（可选超时）。返回汇总，不抛异常（错误进 errors） */
async function collect(stream, { timeoutMs = 0, onEvent } = {}) {
  const sum = {
    text: '', thinking: '', tools: [], toolResults: [], usage: null,
    done: false, doneReason: null, errors: [], raw: [], events: 0,
  };
  const timer = timeoutMs > 0
    ? setTimeout(() => { try { stream.return && stream.return(); } catch {} }, timeoutMs)
    : null;
  try {
    for await (const ev of stream) {
      sum.events++;
      if (onEvent) { try { onEvent(ev); } catch {} }
      switch (ev.kind) {
        case EVENT.TEXT: sum.text += (ev.data && ev.data.text) || ''; break;
        case EVENT.THINKING: sum.thinking += (ev.data && ev.data.text) || ''; break;
        case EVENT.TOOL: sum.tools.push(ev.data); break;
        case EVENT.TOOL_RESULT: sum.toolResults.push(ev.data); break;
        case EVENT.USAGE: sum.usage = ev.data; break;
        case EVENT.DONE: sum.done = true; sum.doneReason = (ev.data && ev.data.reason) || null; break;
        case EVENT.ERROR: sum.errors.push(ev.data); break;
        case EVENT.RAW: sum.raw.push(ev.data); break;
        default: break;
      }
      if (sum.done) break;
    }
  } catch (e) {
    sum.errors.push({ message: String((e && e.message) || e) });
  } finally {
    if (timer) clearTimeout(timer);
  }
  return sum;
}

/** 等到 done 或超时（期间 onEvent 可用来实时打印） */
async function waitDone(stream, { timeoutMs = 0, onEvent } = {}) {
  return collect(stream, { timeoutMs, onEvent });
}

/** 单行事件摘要（watch 命令用） */
function describe(ev) {
  const d = (ev && ev.data) || {};
  switch (ev && ev.kind) {
    case EVENT.STATUS: return `状态 ${d.status || '?'}`;
    case EVENT.TEXT: return String(d.text || '').replace(/\n/g, '\\n');
    case EVENT.THINKING: return '思考 ' + String(d.text || '').replace(/\n/g, '\\n').slice(0, 80);
    case EVENT.TOOL: return `工具 ${d.name || '?'} ${JSON.stringify(d.input || {}).slice(0, 120)}`;
    case EVENT.TOOL_RESULT: return `工具结果 ${d.name || '?'} ${d.ok === false ? '失败' : '完成'}`;
    case EVENT.QUESTION: return `提问 ${JSON.stringify(d.questions || d).slice(0, 120)}`;
    case EVENT.PERMISSION: return `权限请求 ${d.tool || ''}`;
    case EVENT.USAGE: return `用量 ${d.totalTokens || '?'} tokens${d.credits ? ' / ' + d.credits + ' credit' : ''}`;
    case EVENT.DONE: return `结束${d.reason ? '（' + d.reason + '）' : ''}`;
    case EVENT.ERROR: return `错误 ${d.message || ''}`;
    case EVENT.RAW: return `原始 ${JSON.stringify(d.raw || d).slice(0, 120)}`;
    default: return JSON.stringify(ev).slice(0, 160);
  }
}

module.exports = { collect, waitDone, describe };
