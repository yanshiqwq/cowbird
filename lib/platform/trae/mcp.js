// 沙箱里的 MCP over HTTP 通道（preview 网关 9003）。
//
// 为什么有这条路：TRAE 网页端没有 terminal/pty/shell 端点，但沙箱里的 agent-tool-host
// 在 9003 上开了个 MCP JSON-RPC 网关（鉴权和其它数据面一样是 Cloud-IDE-JWT）。
// 只要带上正确的 `_meta["trae/extensionId"]`，就能直接 `tools/call`，不必每轮都惊动 agent。
//
// 注册名规则（2026-11-18 从 toolhost 启动日志实测）：
//   runtime_id   = user::<server_name>
//   server_name  = <registry>_plugin_<plugin>_<serverKey>
//   例：trae-remote-official_plugin_deployment_exec
// 注意：写成 `user::builtin::x` 会被当成 server 名 `builtin::x` 去找 → 404。
const C = require('./constants');
const transport = require('./http');

const MCP_PORT = 9003;
const PROTOCOL = '2024-11-05';

/** 从会话详情拼出 preview 网关地址（模板里是 `{port}` 占位符） */
function gatewayFor(sess, port = MCP_PORT) {
  const tpl = sess && sess.preview_url_template;
  if (!tpl) return null;
  return String(tpl).replace('{port}', String(port)).replace(/\/+$/, '');
}

/** 会话 id → { base, headers, session }（每次调用重新取，避免 token 过期后用旧的） */
async function connect(ctx, id, { timeoutMs = 20000 } = {}) {
  const t = transport.createTransport(ctx);
  const j = await t.request('GET', C.Ep.session(id));
  const sess = (j && j.data) || {};
  const base = gatewayFor(sess);
  if (!base) {
    throw Object.assign(new Error(`会话 ${id} 还没有 preview 网关（沙箱未分配）`), { code: 'E_NO_SANDBOX' });
  }
  const tk = await t.request('POST', C.Ep.sessionToken(id), { body: {} }).catch(() => null);
  const jwt = (tk && tk.data && tk.data.token) || (await t.cloudideToken());
  return {
    base,
    session: sess,
    headers: {
      authorization: 'Cloud-IDE-JWT ' + jwt,
      'x-trae-client-type': 'web',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
      'user-agent': C.UA,
      referer: C.SITE + '/',
    },
    timeoutMs,
  };
}

async function rpc(conn, extId, id, method, params) {
  const body = { jsonrpc: '2.0', id, method, params: { ...(params || {}), _meta: { 'trae/extensionId': extId } } };
  const r = await fetch(conn.base + '/', {
    method: 'POST',
    headers: conn.headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(conn.timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：原样带回去 */ }
  return { http: r.status, json, text };
}

/** MCP 错误码 → 人能看的结论 */
function classify(res) {
  const err = res && res.json && res.json.error;
  if (!err) return null;
  const msg = String(err.message || '');
  if (/not found/i.test(msg)) return { kind: 'no-server', code: err.code, message: msg };
  if (/invalid canonical extensionId/i.test(msg)) return { kind: 'bad-id', code: err.code, message: msg };
  if (/unsupported MCP-Protocol-Version/i.test(msg)) return { kind: 'protocol', code: err.code, message: msg };
  return { kind: 'rpc', code: err.code, message: msg };
}

/** initialize 一次，确认这个 extId 真的注册上了 */
async function handshake(ctx, id, extId, opts) {
  const conn = await connect(ctx, id, opts);
  const res = await rpc(conn, extId, 1, 'initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'cowbird', version: require('../../../package.json').version },
  });
  const bad = classify(res);
  return {
    ok: res.http === 200 && !bad,
    conn,
    http: res.http,
    serverInfo: (res.json && res.json.result && res.json.result.serverInfo) || null,
    problem: bad,
  };
}

/** 调一个工具，返回 MCP 的 result 原样（调用方自己拆 content） */
async function callTool(ctx, id, extId, name, args, { timeoutMs = 60000 } = {}) {
  const hs = await handshake(ctx, id, extId, { timeoutMs: timeoutMs + 20000 });
  if (!hs.ok) {
    const e = new Error(`MCP 通道不可用（${hs.problem ? hs.problem.message : 'http=' + hs.http}）`);
    e.code = hs.problem && hs.problem.kind === 'no-server' ? 'E_NOT_PRIMED' : 'E_MCP';
    throw e;
  }
  const res = await rpc(hs.conn, extId, 3, 'tools/call', { name, arguments: args || {} });
  const bad = classify(res);
  if (bad || res.http !== 200 || !res.json || !res.json.result) {
    const e = new Error(`tools/call ${name} 失败：${bad ? bad.message : String(res.text).slice(0, 200)}`);
    e.code = 'E_MCP';
    throw e;
  }
  return res.json.result;
}

module.exports = { MCP_PORT, PROTOCOL, gatewayFor, connect, handshake, callTool, classify };
