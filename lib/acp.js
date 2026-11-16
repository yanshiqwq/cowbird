// ACP 客户端：bootstrap → SSE 读事件 → POST 回话
// watch / history / prompt 共用这一层，省得各写一遍帧解析。
//
// 要点（都是踩出来的）：
// · 必须 POST {link}/bootstrap，响应头里有 Acp-Connection-Id；GET /acp 不给 id
// · session/load 会把整段历史重放成 session/update（_meta['codebuddy.ai'].mode='history'）
// · 服务端发来的「请求」（带 id + method）必须回，否则那个工具调用会卡住：
//     mcp/message        → 回 {tools:[]}（不回会卡住客户端侧 MCP 调用）
//     elicitation/create → 回 decline
//     _codebuddy.ai/question（AskUserQuestion）/ session/request_permission → **故意不回**
//       （客户端的超时是本地计时 ⇒ 不回就永挂；旧 keepalive 靠这个钉住会话，现网已不用）
class Acp {
  constructor(creds, opts = {}) {
    this.creds = creds;
    this.sessionId = creds.sessionId || opts.id;
    this.cwd = creds.cwd || '/workspace';
    this.onEvent = opts.onEvent || (() => {});
    this.connId = null;
    this._ac = null;
    this._rpcId = 1000;
  }

  get link() { return (this.creds.link || '').replace(/\/$/, ''); }

  headers(extra) {
    return Object.assign({ authorization: 'Bearer ' + this.creds.token }, extra || {});
  }

  async connect() {
    this._ac = new AbortController();
    const res = await fetch(this.link + '/bootstrap', {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify({
        initialize: {
          jsonrpc: '2.0', id: 900001, method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
        },
        sessionLoad: {
          jsonrpc: '2.0', id: 900002, method: 'session/load',
          params: { sessionId: this.sessionId, cwd: this.cwd, mcpServers: [] },
        },
      }),
      signal: this._ac.signal,
    });
    this.connId = res.headers.get('acp-connection-id');
    this.res = res;
    return res;
  }

  async post(body) {
    const r = await fetch(this.link, {
      method: 'POST',
      headers: this.headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'Acp-Connection-Id': this.connId,
      }),
      body: JSON.stringify(body),
    });
    const t = await r.text();
    return { status: r.status, text: t };
  }

  // 发一条用户消息
  async prompt(text) {
    return this.post({
      jsonrpc: '2.0', id: this._rpcId++, method: 'session/prompt',
      params: { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
    });
  }

  async close() {
    try { if (this._ac) this._ac.abort(); } catch {}
    try {
      await fetch(this.link, {
        method: 'DELETE',
        headers: this.headers({ 'Acp-Connection-Id': this.connId }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  }

  // 读 SSE 直到断开；每条消息交给 dispatch
  async loop() {
    const reader = this.res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return 'eof';
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (!d) continue;
          let m;
          try { m = JSON.parse(d); } catch { continue; }
          await this.dispatch(m);
        }
      }
    }
  }

  async dispatch(m) {
    const method = m.method || '';

    // 服务端 → 客户端 的请求
    if (method && m.id !== undefined && m.id !== null) {
      if (method === '_codebuddy.ai/question' || method === 'session/request_permission') {
        return;                                   // 故意不回：回了就等于替用户作答/授权
      }
      if (method === 'mcp/message') {
        const inner = (m.params && m.params.message) || {};
        const reply = inner.method === 'tools/list' ? { tools: [] } : { content: [], isError: false };
        await this.post({ jsonrpc: '2.0', id: m.id, result: { message: { jsonrpc: '2.0', id: inner.id, result: reply } } });
        return;
      }
      if (method === 'elicitation/create') {
        await this.post({ jsonrpc: '2.0', id: m.id, result: { action: 'decline' } });
        return;
      }
      await this.post({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported by wbsbx client' } });
      return;
    }

    this.onEvent(m);
  }
}

// 连一次、跑 fn、断开。watch/history 这种一次性命令用。
async function withAcp(creds, opts, fn) {
  const acp = new Acp(creds, opts);
  const res = await acp.connect();
  if (!acp.connId) {
    const t = await res.text().catch(() => '');
    throw new Error('bootstrap 没给 Acp-Connection-Id http=' + res.status + ' ' + String(t).slice(0, 200));
  }
  try { return await fn(acp); } finally { await acp.close(); }
}

// 连一次、读流 ms 毫秒后主动断开（watch / history 这类"看一会儿就走"的命令用）。
// 正常到点断开返回 null；链路出错返回 Error，交给调用方决定要不要记一笔。
async function tap(creds, opts, ms) {
  return withAcp(creds, opts, async (acp) => {
    const t = setTimeout(() => { try { acp._ac.abort(); } catch {} }, ms);
    try { await acp.loop(); return null; }
    catch (e) { return e.name === 'AbortError' ? null : e; }
    finally { clearTimeout(t); }
  });
}

module.exports = { withAcp, tap };
