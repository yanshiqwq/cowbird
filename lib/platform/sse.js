// SSE 帧解析（纯函数，零依赖）。
//
// 三个驱动以前各写一份（codearts 的增量解析器、qoder 的按块解析、minimax 的按行解析），
// 语义细节已经漂移。这里只保留一份，形状是其中最强的那个（codearts 版）：
//   { event, id, text, json, data }
//   · text  data: 行拼起来的原文
//   · json  能 JSON.parse 就给出对象，否则 null
//   · data  json !== null ? json : (text === '' ? null : text)
//
// 语义要点：
//   · `:` 开头是注释/心跳，丢弃；
//   · 具名事件即使没有 data 也保留（上层要靠它判类型）；
//   · data 多行用 \n 拼接（SSE 规范）；
//   · 增量解析要处理 \r\n 跨块：末位单个 \r 先扣住，等下一块再拼。

function parseBlock(block) {
  const lines = String(block === undefined || block === null ? '' : block).split('\n');
  let event = 'message';
  let sawEvent = false;
  let sawData = false;
  const data = [];
  let id = null;

  for (const line of lines) {
    if (!line) continue;
    if (line[0] === ':') continue;                     // 注释 / 心跳行
    const c = line.indexOf(':');
    const field = c === -1 ? line : line.slice(0, c);
    let value = c === -1 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') { event = value.trim() || 'message'; sawEvent = true; }
    else if (field === 'data') { data.push(value); sawData = true; }
    else if (field === 'id') { id = value; }
    // retry / 未知字段：忽略
  }

  if (!sawData && !sawEvent) return null;              // 纯注释块
  const text = data.join('\n');
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  return { event, id, text, json, data: json !== null ? json : (text === '' ? null : text) };
}

/** 增量解析器：喂字节块，返回凑齐的帧 */
function createParser() {
  let buf = '';
  let held = '';

  const drain = () => {
    const out = [];
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i < 0) break;
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f = parseBlock(block);
      if (f) out.push(f);
    }
    return out;
  };

  return {
    push(chunk) {
      buf += String(chunk === undefined || chunk === null ? '' : chunk);
      // 末位的 \r 可能是下一块 \r\n 的前半截：先扣住，否则会被当成换行切错帧
      if (buf.endsWith('\r')) { held = '\r'; buf = buf.slice(0, -1); } else { held = ''; }
      buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const out = drain();
      if (held) buf += held;                           // 放回去等下一块
      return out;
    },
    /** 流结束：把残留的半块也解出来 */
    end() {
      buf += held;
      held = '';
      buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const out = drain();
      if (buf.trim()) { const f = parseBlock(buf); if (f) out.push(f); }
      buf = '';
      return out;
    },
    get pending() { return buf + held; },
  };
}

/** 整段文本 → 帧数组（自测与落盘回放用） */
function framesFromText(text) {
  const p = createParser();
  return [...p.push(text), ...p.end()];
}

module.exports = { parseBlock, createParser, framesFromText };
