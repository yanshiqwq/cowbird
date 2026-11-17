// 沙箱隧道 + MCP（JSON-RPC over HTTP）：Qoder 的 exec / fs 数据面全在这里。
//
// 三步（2026-11-17 实测打通）：
//   1) POST /api/v1/remote/preview/grant  {session_id, port:3001}
//        → {url:'https://3001-<cma_session_id>.preview.qoderwork.cn', grant:'<ES256 JWT>', expires_at}
//   2) POST <url>/_preview/bootstrap     form-urlencoded grant=<JWT>
//        → 303 + 会话 cookie（约 624 字节，30 分钟有效）
//   3) POST <url>/mcp                    JSON-RPC：
//        initialize → notifications/initialized → tools/call {name:'bash', arguments:{…}}
//
// 两个缓存事实：
//   - grant 30 分钟过期 → 到期前重取（幂等、无副作用）；
//   - MCP 的 initialize **每个隧道只需一次** → 缓存到 ctx.store 的隧道记录里。
//
// 一个关键前提：**沙箱只有在第一次工具调用时才创建**。没起时 grant 返回
// 503 CloudSandboxNotReady，这里抛 E_NOT_READY，由 exec.wake 负责发消息拉起。
'use strict';
const wire = require('./wire');

const CLIENT_INFO = { name: 'cowbird', version: '1.0.0' };
const GUARD_MS = 60e3;          // 隧道到期前留 60 秒余量
const FALLBACK_TTL_MS = 29 * 60e3;  // 平台没给 expires_at 时按 30 分钟减一点算

const tunnelKey = (sessionId) => `tunnel_${sessionId}`;

function tunnelAuthError(status) {
  const e = new Error(`预览隧道鉴权失败（HTTP ${status}）：cookie 可能过期`);
  e.code = 'E_TUNNEL_AUTH';
  e.status = status;
  return e;
}

function createTunnel({ request, fetchImpl, now } = {}) {
  const f = fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const clock = now || (() => Date.now());
  const post = request;
  if (typeof post !== 'function') throw new Error('createTunnel 需要 request 函数');

  let seq = 0;
  const nextId = () => ++seq;

  // ---------- 1) grant ----------

  /**
   * 要一份隧道凭证。503 不抛：返回 {ok:false, reason}，因为「沙箱没起」是常态而不是异常。
   */
  async function tryGrant(ctx, sessionId, port = wire.MCP_PORT, opts = {}) {
    const r = await post(ctx, 'POST', `${wire.API_PREFIX}/preview/grant`, {
      body: { session_id: String(sessionId), port: Number(port) || wire.MCP_PORT },
      timeout: opts.timeout || 25000,
    });
    if (r.ok && r.json) {
      const info = wire.grantInfo(r.json.grant);
      return {
        ok: true,
        status: r.status,
        url: wire.tunnelUrl({ url: r.json.url, grant: r.json.grant, port, cmaSessionId: info.sid }),
        grant: r.json.grant || null,
        expiresAt: wire.grantExpiryAt(r.json, info),
        info,
        raw: r.json,
      };
    }
    const reason = wire.notReadyReason(r.status, r.json || r.text);
    if (reason) return { ok: false, status: r.status, reason, info: { sid: null, sandboxId: null } };
    const e = new Error(`取隧道凭证失败（HTTP ${r.status}）：${String(r.text || '').slice(0, 200)}`);
    e.code = 'E_HTTP';
    e.status = r.status;
    throw e;
  }

  /** 同 tryGrant，但 503 也抛（exec.run 用：拿不到就明说没准备好） */
  async function grant(ctx, sessionId, port = wire.MCP_PORT, opts = {}) {
    const r = await tryGrant(ctx, sessionId, port, opts);
    if (r.ok) return r;
    const cacheMiss = r.reason === 'CloudSandboxNotReady';
    const e = new Error(
      cacheMiss
        ? '沙箱还没起来（preview/grant 503 CloudSandboxNotReady）：Qoder 的沙箱只在第一次工具调用时创建，先跑 cowbird wake 把会话唤醒。'
        : `这个端口不给隧道（503 ${r.reason}）：preview 网关只开放白名单端口（实测 3001/8931 可，49983 不行）。`
    );
    e.code = cacheMiss ? 'E_NOT_READY' : 'E_PORT_BLOCKED';
    e.reason = r.reason;
    e.status = r.status;
    e.ready = false;
    throw e;
  }

  // ---------- 2) bootstrap（grant → 隧道 cookie） ----------

  async function bootstrap(url, grantToken, opts = {}) {
    if (!grantToken) {
      const e = new Error('bootstrap 缺 grant：preview/grant 没返回 grant 字段');
      e.code = 'E_TUNNEL';
      throw e;
    }
    const res = await f(`${url}/_preview/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant: String(grantToken) }).toString(),
      redirect: 'manual',        // 303 要自己接，别跟过去
      signal: AbortSignal.timeout(opts.timeout || 25000),
    });
    try { await res.arrayBuffer(); } catch {}

    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cookie = setCookies.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ');
    if (!cookie) {
      const e = new Error(`bootstrap 没拿到隧道 cookie（HTTP ${res.status}）：grant 可能已过期，重取一份再试`);
      e.code = 'E_TUNNEL';
      e.status = res.status;
      throw e;
    }
    return { cookie, status: res.status };
  }

  // ---------- 3) MCP JSON-RPC ----------

  async function rpc(tunnel, payload, opts = {}) {
    const { timeout = 120e3, notify = false } = opts;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      cookie: tunnel.cookie,
    };
    if (tunnel.mcpSessionId) headers['mcp-session-id'] = tunnel.mcpSessionId;

    const res = await f(`${tunnel.url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });

    // Streamable HTTP 规范：服务端可能下发 Mcp-Session-Id，后续请求要回带
    const sid = res.headers.get('mcp-session-id');
    if (sid) tunnel.mcpSessionId = sid;

    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw tunnelAuthError(res.status);
    if (notify) return null;                       // 通知没有响应体，也不该因为 202 空体报错

    const ct = String(res.headers.get('content-type') || '');
    let envelope = null;
    if (ct.includes('text/event-stream')) {
      const frames = wire.parseSseFrames(text).filter((x) => x && x.id === payload.id);
      envelope = frames.length ? frames[frames.length - 1] : (wire.parseSseFrames(text).pop() || null);
    } else {
      try { envelope = text ? JSON.parse(text) : null; } catch { envelope = null; }
    }
    if (!envelope) {
      const e = new Error(`MCP 返回无法解析（HTTP ${res.status}，content-type=${ct || '无'}）：${text.slice(0, 200)}`);
      e.code = 'E_MCP_FORMAT';
      e.status = res.status;
      throw e;
    }
    return envelope;
  }

  async function notify(tunnel, payload) {
    try { return await rpc(tunnel, payload, { notify: true, timeout: 20000 }); } catch { return null; }
  }

  // ---------- 隧道生命周期 ----------

  /** 拿一条可用隧道：缓存命中就不重申；否则 grant → bootstrap → initialize */
  async function ensure(ctx, sessionId, opts = {}) {
    const key = tunnelKey(sessionId);
    if (!opts.force) {
      const cached = ctx.store.read(key, null);
      if (cached && cached.url && cached.cookie && Number(cached.expiresAt) > clock() + GUARD_MS) return cached;
    }

    const g = await grant(ctx, sessionId, opts.port || wire.MCP_PORT);
    const bs = await bootstrap(g.url, g.grant);
    const tunnel = {
      url: g.url,
      grant: g.grant,
      expiresAt: g.expiresAt || clock() + FALLBACK_TTL_MS,
      cookie: bs.cookie,
      cmaSessionId: g.info.sid || null,
      sandboxId: g.info.sandboxId || null,
      at: clock(),
      inited: false,
      mcpSessionId: null,
      serverInfo: null,
    };

    try {
      const init = await rpc(tunnel, {
        jsonrpc: '2.0',
        id: nextId(),
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: CLIENT_INFO },
      }, { timeout: 30000 });
      tunnel.serverInfo = wire.unwrapRpc(init).serverInfo || null;
      await notify(tunnel, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      tunnel.inited = true;
    } catch (e) {
      // 初始化没成功就别留半条隧道，否则后面每次调用都会撞同一个错
      try { ctx.store.remove(key); } catch {}
      throw e;
    }

    ctx.store.write(key, tunnel);
    return tunnel;
  }

  function clear(ctx, sessionId) {
    try { ctx.store.remove(tunnelKey(sessionId)); } catch {}
  }

  /** 调一个 MCP 工具；隧道 cookie 过期时自动重取一次 */
  async function call(ctx, sessionId, name, args, opts = {}) {
    const timeout = opts.timeout || 180e3;
    const make = () => ({
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: { name, arguments: args || {} },
    });

    let tunnel = await ensure(ctx, sessionId, opts);
    let env;
    try {
      env = await rpc(tunnel, make(), { timeout });
    } catch (e) {
      if (e.code !== 'E_TUNNEL_AUTH') throw e;
      clear(ctx, sessionId);
      tunnel = await ensure(ctx, sessionId, { ...opts, force: true });
      env = await rpc(tunnel, make(), { timeout });
    }
    // 服务端可能在任意一次响应里换 Mcp-Session-Id：换过就落盘，别让下个进程丢掉它
    if (tunnel.mcpSessionId) {
      try { ctx.store.write(tunnelKey(sessionId), tunnel); } catch {}
    }

    const result = wire.unwrapRpc(env);
    return {
      text: wire.mcpText(result),
      isError: !!result.isError,
      structured: result.structuredContent || null,
      serverInfo: tunnel.serverInfo,
      sandboxId: tunnel.sandboxId,
      cmaSessionId: tunnel.cmaSessionId,
      raw: result,
    };
  }

  /** tools/list（能力探测 / doctor 用；实测 14 个工具） */
  async function listTools(ctx, sessionId) {
    const tunnel = await ensure(ctx, sessionId);
    const env = await rpc(tunnel, { jsonrpc: '2.0', id: nextId(), method: 'tools/list' }, { timeout: 30000 });
    const result = wire.unwrapRpc(env);
    return {
      serverInfo: tunnel.serverInfo,
      tools: (result.tools || []).map((t) => ({ name: t.name, description: t.description || '' })),
    };
  }

  /**
   * 轻量探测：只问 preview/grant 是否 200（不 bootstrap、不 initialize）。
   * ready=false 时 reason 是 CloudSandboxNotReady（没起）或 catalog_unavailable（端口被挡）。
   */
  async function probe(ctx, sessionId, opts = {}) {
    const cached = ctx.store.read(tunnelKey(sessionId), null);
    const r = await tryGrant(ctx, sessionId, opts.port || wire.MCP_PORT, opts);
    if (!r.ok) {
      return { ready: false, reason: r.reason, status: r.status, cached: !!(cached && cached.url), sandboxId: (cached && cached.sandboxId) || null };
    }
    return {
      ready: true,
      reason: null,
      status: r.status,
      url: r.url,
      expiresAt: r.expiresAt,
      sandboxId: r.info.sandboxId || (cached && cached.sandboxId) || null,
      cmaSessionId: r.info.sid || (cached && cached.cmaSessionId) || null,
    };
  }

  return { tryGrant, grant, bootstrap, rpc, ensure, clear, call, listTools, probe, key: tunnelKey };
}

module.exports = { createTunnel, tunnelKey, CLIENT_INFO };
