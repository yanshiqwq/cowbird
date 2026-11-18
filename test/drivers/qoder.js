// 本文件由 lib/platform/qoder/selftest.js 迁来：驱动自测不随 npm 包发布（见 package.json files）。
// 跑法：node test/drivers/qoder.js（lib 里的 selftest.js 只是入口壳，仍然可用）
// Qoder 驱动的**纯离线**自测：不联网、无凭据、不起进程。
//
//   node lib/platform/qoder/selftest.js
//
// 覆盖硬要求的五块：
//   事件映射（含 tool_use / tool_result / usage / done）
//   JWT 里取沙箱前缀（sid + sandbox id）
//   grant URL 拼装
//   cgroup 解析
//   CloudSandboxNotReady 判定
// 另外加了几条：假 MCP 响应解包、401 → AuthError、请求头、以及**用假 fetch 跑完整
// exec.run / exec.start+poll / agent.stream**（网络层整体注入，业务代码一行不改）。
'use strict';
const assert = require('assert');
const wire = require('../../lib/platform/qoder/wire');
const provider = require('../../lib/platform/qoder/index');
const { EVENT } = require('../../lib/platform/contract');
const { AuthError } = require('../../lib/platform/qoder/http');

let pass = 0;
let fail = 0;

function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    console.error('  \u2717 ' + name + '\n      ' + (e && e.message));
  }
}

async function okA(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    fail++;
    console.error('  \u2717 ' + name + '\n      ' + (e && e.message));
  }
}

// ---------------- 假世界 ----------------

/** 假 ctx：store 用 JSON 克隆，行为跟真实的「读文件/写文件」一致（不能靠对象引用互通） */
function makeCtx() {
  const mem = new Map();
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    store: {
      dir: '/tmp/fake-qoder',
      read(name, dflt = null) { return mem.has(name) ? clone(mem.get(name)) : dflt; },
      write(name, value) { mem.set(name, clone(value)); },
      remove(name) { mem.delete(name); },
    },
    defaults: { model: 'qfmodel', workMode: 'general' },
    config: () => ({}),
    now: () => Date.now(),
    _mem: mem,
  };
}

function resp(status, body, headers = {}) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null),
      getSetCookie: () => (headers['set-cookie'] ? [].concat(headers['set-cookie']) : []),
    },
    async text() { return text; },
    async arrayBuffer() { return new ArrayBuffer(0); },
  };
}

/** 造一个结构合法的假 JWT（不验签，驱动也只用 payload） */
function fakeJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'ES256', typ: 'JWT' })}.${enc(payload)}.fakesig`;
}

const WRAP_OK = 'hello\n\n__COWBIRD_CODE__0\n__COWBIRD_STDERR__\nwarn\n';
const WRAP_BG = 'work in progress\n\n[backgrounded] pid: 4242, output_file:/tmp/tool-outputs/bash_42.log';

/**
 * 假世界：一张 URL → 响应的小路由表，外加几个可以随时翻的状态位。
 * 全部行为都照实测报告里的真实响应形状写（含 201/204/303/503 与 MCP 信封）。
 */
function makeWorld(opts = {}) {
  const state = {
    grantStatus: opts.grantStatus || 200,
    grantReason: opts.grantReason || 'CloudSandboxNotReady',
    alive: true,
    runningText: 'still running…\n',
    finalText: 'done-output\n\n__COWBIRD_CODE__7\n__COWBIRD_STDERR__\nboom\n',
    calls: [],
    events: opts.events || [],
    sentSeq: opts.sentSeq || 10,
    bashText: opts.bashText || WRAP_OK,
  };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = String(init.method || 'GET').toUpperCase();
    let body = null;
    if (init.body) {
      const raw = init.body;
      try { body = JSON.parse(raw); } catch { body = String(raw); }
    }
    state.calls.push({ url: String(url), path: u.pathname, method, headers: init.headers || {}, body });
    const textResult = (t) => ({ jsonrpc: '2.0', id: body && body.id, result: { content: [{ type: 'text', text: t }] } });

    if (u.pathname === '/api/v1/me') return resp(200, { id: 'u_1', name: '测试账号', username: 'tester' });

    if (u.pathname === '/api/v1/remote/environments') {
      return resp(200, {
        data: [{
          id: 'env_1', name: 'Default', is_default: true, type: 'cloud',
          metadata: {
            available_models: [
              { model_id: 'qfmodel', display_name: 'Qwen3.8-Flash', price_factor: 0.04 },
              { model_id: 'kmodel_latest', display_name: 'Kimi-K3.1-Pro', price_factor: 1 },
            ],
          },
        }],
      });
    }

    if (u.pathname === '/api/v1/remote/sessions' && method === 'GET') {
      return resp(200, {
        data: [
          {
            session_id: 'qs_a', cma_session_id: 'sess_a', title: '会话 A', session_status: 'idle',
            session_context: { model: 'qfmodel', work_mode: 'general' },
            environment_id: 'env_1', updated_at: '2026-11-17T08:00:00+08:00', origin: 'web',
          },
          {
            session_id: 'qs_b', cma_session_id: 'sess_b', title: '会话 B', session_status: 'running',
            session_context: { model: 'qfmodel' }, origin: 'ios',
          },
        ],
        has_more: false,
      });
    }
    if (u.pathname === '/api/v1/remote/sessions' && method === 'POST') {
      return resp(201, {
        session_id: 'qs_new', cma_session_id: 'sess_new', title: body.title, session_status: 'idle',
        session_context: body.session_context, environment_id: body.environment_id,
      });
    }

    const evMatch = u.pathname.match(/^\/api\/v1\/remote\/sessions\/([^/]+)\/events$/);
    if (evMatch && method === 'POST') return resp(200, { results: [{ event_id: 'evt_sent', sequence_num: state.sentSeq }] });
    if (evMatch && method === 'GET') {
      const after = Number(u.searchParams.get('after_sequence_num') || 0);
      const data = state.events
        .filter((e) => Number(e.sequence_num) > after)
        .sort((a, b) => a.sequence_num - b.sequence_num);
      return resp(200, { data, has_more: false });
    }

    const oneMatch = u.pathname.match(/^\/api\/v1\/remote\/sessions\/([^/]+)$/);
    if (oneMatch && method === 'GET') {
      if (oneMatch[1] === 'nope') return resp(404, { code: 'NOT_FOUND' });
      return resp(200, {
        session_id: oneMatch[1], cma_session_id: 'sess_a', title: '会话 A', session_status: 'idle',
        session_context: { model: 'qfmodel', work_mode: 'general' },
      });
    }
    if (oneMatch && method === 'DELETE') return resp(204, '');
    const archiveMatch = u.pathname.match(/^\/api\/v1\/remote\/sessions\/([^/]+)\/archive$/);
    if (archiveMatch && method === 'POST') return resp(200, { ok: true });

    if (u.pathname === '/api/v1/remote/preview/grant') {
      if (state.grantStatus !== 200) return resp(state.grantStatus, { code: state.grantReason });
      return resp(200, {
        url: 'https://3001-sess_a.preview.qoderwork.cn',
        grant: fakeJwt({ sid: 'sess_a', port: 3001, up: { addr: 'http://cloud-sandbox-manager.qoder.svc:8091/preview/sandboxes/sd-test01' }, exp: Math.floor(Date.now() / 1000) + 1800 }),
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      });
    }
    if (u.pathname === '/_preview/bootstrap') return resp(303, '', { 'set-cookie': 'preview_sess=abc123; Path=/; HttpOnly' });

    if (u.pathname === '/mcp') {
      const m = body && body.method;
      if (m === 'initialize') {
        return resp(200, {
          jsonrpc: '2.0', id: body.id,
          result: { protocolVersion: '2025-06-18', serverInfo: { name: 'sandbox-runtime-tools', version: '0.1.0' }, capabilities: {} },
        }, { 'mcp-session-id': 'mcp-1' });
      }
      if (m === 'notifications/initialized') return resp(202, '');
      if (m === 'tools/list') return resp(200, { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'bash' }, { name: 'file_read' }, { name: 'glob' }] } });
      if (m === 'tools/call') {
        const name = body.params && body.params.name;
        const args = (body.params && body.params.arguments) || {};
        if (name === 'bash') {
          if (String(args.command).includes('kill -0')) return resp(200, textResult(state.alive ? 'ALIVE\n' : 'GONE\n'));
          if (args.on_timeout === 'background') return resp(200, textResult(state.bashText === WRAP_OK ? WRAP_BG : state.bashText));
          return resp(200, textResult(state.bashText));
        }
        if (name === 'file_read') return resp(200, textResult(state.alive ? state.runningText : state.finalText));
        if (name === 'file_write') return resp(200, textResult('written'));
        if (name === 'glob') return resp(200, textResult('a.txt\nsub/\n/pinned/abs.txt\n'));
      }
    }
    return resp(404, { error: `unexpected ${method} ${u.pathname}` });
  };

  return { fetch: fetchImpl, state };
}

/** 登录态：直接往 store 里塞一份（跳过 login 的网络动作） */
function seedAuth(ctx) {
  ctx.store.write('auth', {
    cookies: [{ name: 'acw_tc', value: 'x', domain: 'qoder.cn', path: '/', expires: -1 },
      { name: 'qoder_session', value: 'sess-cookie', domain: '.qoder.cn', path: '/', expires: Math.floor(Date.now() / 1000) + 86400 * 10 }],
    savedAt: '2026-11-17T08:00:00.000Z',
  });
}

// ---------------- 用例 ----------------

(async () => {
  console.log('\n1. 事件映射（协议 → 归一化事件）');

  ok('assistant: text / reasoning / tool_use 各归各位，stop_reason=tool_use 不结案', () => {
    const ev = {
      event_type: 'assistant', source: 'worker', sequence_num: 6,
      payload: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先想一下' },
            { type: 'text', text: '我来跑个命令。' },
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
        stop_reason: 'tool_use',
      },
    };
    const out = wire.mapEvent(ev);
    assert.deepStrictEqual(out.map((e) => e.kind), [EVENT.THINKING, EVENT.TEXT, EVENT.TOOL]);
    assert.strictEqual(out[0].data.text, '先想一下');
    assert.strictEqual(out[2].data.name, 'Bash');
    assert.deepStrictEqual(out[2].data.input, { command: 'echo hi' });
  });

  ok('user 事件里的 tool_result → tool_result（工具结果就是伪装成 user 的）', () => {
    const ev = {
      event_type: 'user', source: 'worker', sequence_num: 8,
      payload: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ text: 'hi\n' }] }] },
      },
    };
    const out = wire.mapEvent(ev);
    assert.deepStrictEqual(out.map((e) => e.kind), [EVENT.TOOL_RESULT]);
    assert.strictEqual(out[0].data.id, 'tu_1');
    assert.strictEqual(out[0].data.ok, true);
    assert.strictEqual(out[0].data.out, 'hi\n');
  });

  ok('session.usage → usage（含 credit 拆项）', () => {
    const out = wire.mapEvent({
      event_type: 'session.usage', sequence_num: 31,
      payload: { model_credits: 0.02, sandbox_runtime_credits: 0.01, total_credits: 0.03 },
    });
    assert.deepStrictEqual(out.map((e) => e.kind), [EVENT.USAGE]);
    assert.strictEqual(out[0].data.credits, 0.03);
    assert.strictEqual(out[0].data.modelCredits, 0.02);
    assert.strictEqual(out[0].data.sandboxCredits, 0.01);
  });

  ok('thread_status_idle 同时给 status( idle ) 和 done', () => {
    const out = wire.mapEvent({ event_type: 'session.thread_status_idle', payload: { stop_reason: 'end_turn' } });
    assert.deepStrictEqual(out.map((e) => e.kind), [EVENT.STATUS, EVENT.DONE]);
    assert.strictEqual(out[0].data.status, 'idle');
    assert.strictEqual(out[1].data.reason, 'end_turn');
  });

  ok('assistant stop_reason=end_turn → done', () => {
    const out = wire.mapEvent({
      event_type: 'assistant',
      payload: { message: { content: [{ type: 'text', text: '好了' }] }, stop_reason: 'end_turn' },
    });
    assert.deepStrictEqual(out.map((e) => e.kind), [EVENT.TEXT, EVENT.DONE]);
    assert.strictEqual(out[1].data.reason, 'end_turn');
  });

  ok('worker.status.changed / stream_event(session.status_*) → status；其它 stream_event → raw', () => {
    const a = wire.mapEvent({ event_type: 'worker.status.changed', payload: { worker_status: 'busy', session_status: 'running' } });
    assert.deepStrictEqual(a.map((e) => e.kind), [EVENT.STATUS]);
    assert.strictEqual(a[0].data.status, 'running');

    const b = wire.mapEvent({ event_type: 'stream_event', payload: { type: 'session.status_idle' } });
    assert.strictEqual(b[0].kind, EVENT.STATUS);
    assert.strictEqual(b[0].data.status, 'idle');

    const c = wire.mapEvent({ event_type: 'stream_event', payload: { type: 'agent.tool_use' } });
    assert.strictEqual(c[0].kind, EVENT.RAW);

    const d = wire.mapEvent({ event_type: 'sandbox.boot_progress', payload: { stages: [] } });
    assert.strictEqual(d[0].kind, EVENT.RAW);
  });

  console.log('\n2. grant / JWT / 隧道 URL');

  ok('JWT payload 里取 sid、sandbox id、port', () => {
    const jwt = fakeJwt({
      sid: 'sess_00vpneqgjtkhsr7guvoa', port: 3001,
      up: { addr: 'http://cloud-sandbox-manager.qoder.svc:8091/preview/sandboxes/sd-dbtparusjef8jjhigdpg', h: { 'X-Access-Token': 'x' } },
      exp: 4102444800,
    });
    const info = wire.grantInfo(jwt);
    assert.strictEqual(info.sid, 'sess_00vpneqgjtkhsr7guvoa');
    assert.strictEqual(info.sandboxId, 'sd-dbtparusjef8jjhigdpg');
    assert.strictEqual(info.port, 3001);
    assert.strictEqual(info.exp, 4102444800);
  });

  ok('隧道 URL 拼装：https://<port>-<cma_session_id>.preview.qoderwork.cn', () => {
    assert.strictEqual(
      wire.previewUrl(3001, 'sess_00vpneqgjtkhsr7guvoa'),
      'https://3001-sess_00vpneqgjtkhsr7guvoa.preview.qoderwork.cn'
    );
    // grant 只给 JWT 不给 url 时，从 JWT 里拼
    const jwt = fakeJwt({ sid: 'sess_abc', port: 3001 });
    assert.strictEqual(wire.tunnelUrl({ grant: jwt, port: 3001 }), 'https://3001-sess_abc.preview.qoderwork.cn');
    // 平台给了 url 就优先用它（去掉尾斜杠）
    assert.strictEqual(wire.tunnelUrl({ url: 'https://3001-sess_a.preview.qoderwork.cn/', grant: jwt }), 'https://3001-sess_a.preview.qoderwork.cn');
    assert.throws(() => wire.previewUrl(3001, ''), /缺 cma_session_id/);
  });

  ok('grant 过期时间三种写法都归一成毫秒', () => {
    const now = Date.now();
    assert.strictEqual(wire.grantExpiryAt({ expires_at: 1800000000 }), 1800000000000);
    assert.strictEqual(wire.grantExpiryAt({ expires_at: 1800000000000 }), 1800000000000);
    const iso = new Date(now + 60000).toISOString();
    assert.ok(Math.abs(wire.grantExpiryAt({ expires_at: iso }) - (now + 60000)) < 2000);
    assert.strictEqual(wire.grantExpiryAt({}, { exp: 4102444800 }), 4102444800000);
  });

  console.log('\n3. CloudSandboxNotReady 判定');

  ok('503 + CloudSandboxNotReady（对象/字符串）都判定为未唤醒', () => {
    assert.strictEqual(wire.notReadyReason(503, { code: 'CloudSandboxNotReady' }), 'CloudSandboxNotReady');
    assert.strictEqual(wire.notReadyReason(503, '{"code":"CloudSandboxNotReady"}'), 'CloudSandboxNotReady');
    assert.strictEqual(wire.notReadyReason(503, { code: 'catalog_unavailable' }), 'catalog_unavailable');
  });

  ok('非 503 / 其它 503 不误判成未唤醒', () => {
    assert.strictEqual(wire.notReadyReason(200, { code: 'CloudSandboxNotReady' }), null);
    assert.strictEqual(wire.notReadyReason(404, { code: 'X' }), null);
    assert.strictEqual(wire.notReadyReason(503, { code: 'Preview service has stopped' }), null);
  });

  console.log('\n4. cgroup 解析（可见 vs 配额）');

  ok('cgroup v2：cpu.max + memory.max', () => {
    const text = [
      'COWBIRD_NPROC=8',
      'COWBIRD_CPU_MAX=400000 100000',
      'COWBIRD_MEM_MAX=8589934592',
      'COWBIRD_MEMTOTAL_KB=16613344',
      'COWBIRD_DF_KB=1048576',
      'COWBIRD_KERNEL=5.10.134-18.0.13.lifsea8.x86_64',
      'COWBIRD_VIRT=docker',
      'COWBIRD_UID=0',
      'COWBIRD_CWD=/data',
      'COWBIRD_BOOTID=abcdef0123456789',
      'COWBIRD_UPTIME=2779',
    ].join('\n');
    const cap = wire.parseCapacity(text);
    assert.strictEqual(cap.visible.cpu, 8);
    assert.strictEqual(cap.quota.cpu, 4);                       // 400000/100000
    assert.strictEqual(cap.quota.memBytes, 8589934592);
    assert.strictEqual(cap.visible.memBytes, 16613344 * 1024);
    assert.strictEqual(cap.visible.diskBytes, 1048576 * 1024);
    assert.strictEqual(cap.facts.kernel, '5.10.134-18.0.13.lifsea8.x86_64');
    assert.strictEqual(cap.facts.virt, 'docker');
    assert.strictEqual(cap.facts.uptimeSec, 2779);
  });

  ok('cgroup v1 + 无限制哨兵：max/-1/超大值都当「没有配额」', () => {
    const v1 = [
      'COWBIRD_NPROC=4',
      'COWBIRD_CPU_QUOTA=200000',
      'COWBIRD_CPU_PERIOD=100000',
      'COWBIRD_MEM_LIMIT=9223372036854771712',
      'COWBIRD_MEMTOTAL_KB=7940000',
    ].join('\n');
    const cap = wire.parseCapacity(v1);
    assert.strictEqual(cap.quota.cpu, 2);
    assert.strictEqual(cap.quota.memBytes, null);               // v1 的「无限制」

    const unlimited = wire.parseCapacity('COWBIRD_NPROC=4\nCOWBIRD_CPU_MAX=max 100000\nCOWBIRD_MEM_MAX=max\n');
    assert.strictEqual(unlimited.quota.cpu, null);
    assert.strictEqual(unlimited.quota.memBytes, null);
    assert.strictEqual(unlimited.visible.cpu, 4);
  });

  console.log('\n5. exec 包装脚本与 MCP 结果解包');

  ok('包装脚本：命令进 {} 块、stderr 先落临时文件、末尾打退出码标记', () => {
    const s = wire.wrapCommand('echo hi');
    assert.match(s, /\{\necho hi\n\} 2>"\$__cowbird_err"/);
    assert.match(s, /printf '\\n__COWBIRD_CODE__%s\\n' "\$__cowbird_code"/);
    assert.match(wire.wrapCommand(''), /\{:\n|\{\n:\n/);      // 空命令退化成 `:`，不能是 `{ }`
  });

  ok('解析：out / err / code 三段分得开', () => {
    const p = wire.parseWrapper(WRAP_OK);
    assert.strictEqual(p.out, 'hello\n');
    assert.strictEqual(p.err, 'warn\n');
    assert.strictEqual(p.code, 0);
    assert.strictEqual(p.backgrounded, false);
  });

  ok('解析：没有标记（被超时 kill / 截断）→ code=null + truncated', () => {
    const p = wire.parseWrapper('partial output only\n');
    assert.strictEqual(p.code, null);
    assert.strictEqual(p.truncated, true);
    assert.strictEqual(p.out, 'partial output only\n');
  });

  ok('解析：[backgrounded] → pid + output_file', () => {
    const p = wire.parseWrapper(WRAP_BG);
    assert.strictEqual(p.backgrounded, true);
    assert.strictEqual(p.pid, 4242);
    assert.strictEqual(p.outputFile, '/tmp/tool-outputs/bash_42.log');
  });

  ok('假 MCP 响应：unwrapRpc → mcpText → parseWrapper 联调', () => {
    const envelope = {
      jsonrpc: '2.0', id: 3,
      result: { content: [{ type: 'text', text: WRAP_OK }] },
    };
    const p = wire.parseWrapper(wire.mcpText(wire.unwrapRpc(envelope)));
    assert.strictEqual(p.out, 'hello\n');
    assert.strictEqual(p.err, 'warn\n');
    assert.strictEqual(p.code, 0);
  });

  ok('MCP error 信封 → E_MCP（不当成功）', () => {
    assert.throws(
      () => wire.unwrapRpc({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }),
      (e) => e.code === 'E_MCP' && /method not found/.test(e.message)
    );
  });

  ok('SSE 帧解析（MCP 走 text/event-stream 时用）', () => {
    const frames = wire.parseSseFrames('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\nevent: system_event\ndata: {"session_id":"qs_a","session_status":"idle"}\n\n');
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].data.result.ok, true);
    assert.strictEqual(frames[1].event, 'system_event');
    assert.strictEqual(frames[1].data.session_status, 'idle');
  });

  console.log('\n5.5 file_read 的行号（真机踩过：get 把内容存成 "1\t…"）');
  ok('stripLineNumbers：全行带行号才剥', () => {
    assert.strictEqual(wire.stripLineNumbers('1\tqoder fs test'), 'qoder fs test');
    assert.strictEqual(wire.stripLineNumbers('1\ta\n2\tb\n'), 'a\nb\n');
    assert.strictEqual(wire.stripLineNumbers('10\tx\n11\ty'), 'x\ny');
  });
  ok('stripLineNumbers：有一行不带行号就原样返回（宁可多带，也不误删正文）', () => {
    assert.strictEqual(wire.stripLineNumbers('1\tx\ny'), '1\tx\ny');
    assert.strictEqual(wire.stripLineNumbers('plain text'), 'plain text');
    assert.strictEqual(wire.stripLineNumbers(''), '');
    assert.strictEqual(wire.stripLineNumbers(null), '');
  });

  console.log('\n6. 传输层（cookie / 头 / 401）');
  await okA('cookie + x-requested-with + X-Qoder-Remote-Api-Version: 4', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    await provider.instances.list(ctx);
    const call = w.state.calls.find((c) => c.path === '/api/v1/remote/sessions');
    assert.ok(call, '没有打到 /sessions');
    assert.strictEqual(call.headers['x-requested-with'], 'XMLHttpRequest');
    assert.strictEqual(call.headers['x-qoder-remote-api-version'], '4');
    assert.match(call.headers.cookie, /qoder_session=sess-cookie/);
    assert.strictEqual(call.headers.accept, 'application/json');
  });

  await okA('401 → AuthError（code=E_AUTH），不是普通 Error', async () => {
    provider._internals.useFetch(async () => resp(401, { code: 'UNAUTHORIZED', message: 'missing cookie header' }));
    const ctx = makeCtx();
    seedAuth(ctx);
    await assert.rejects(() => provider.instances.list(ctx), (e) => {
      assert.ok(e instanceof AuthError, '应抛 AuthError');
      assert.strictEqual(e.code, 'E_AUTH');
      assert.match(e.message, /UNAUTHORIZED|登录态/);
      return true;
    });
  });

  await okA('没有登录态时给的是「去 login」而不是「查网络」', async () => {
    provider._internals.useFetch(async () => resp(200, {}));
    const ctx = makeCtx();     // 故意不 seedAuth
    await assert.rejects(() => provider.instances.list(ctx), (e) => {
      assert.strictEqual(e.code, 'E_AUTH');
      assert.match(e.message, /login/);
      return true;
    });
  });

  console.log('\n7. 驱动契约面');

  ok('能力位与 limits 符合约定', () => {
    const caps = provider.capabilityList();
    for (const c of ['auth', 'instances.list', 'instances.create', 'instances.rename',
      'instances.remove', 'instances.meta', 'agent', 'agent.interrupt',
      'exec', 'exec.background', 'exec.wake', 'fs']) {
      assert.ok(caps.includes(c), '缺能力位 ' + c);
    }
    assert.ok(!caps.includes('agent.question'), '不该声明 agent.question（answer 未实现）');
    assert.strictEqual(provider.limits.maxSyncMs, 590000);
    assert.strictEqual(provider.limits.defaultSyncMs, 120000);
    assert.strictEqual(provider.limits.maxBackground, true);
  });

  await okA('agent.answer 明确抛 E_UNSUPPORTED（不假装成功）', async () => {
    const ctx = makeCtx();
    await assert.rejects(() => provider.agent.answer(ctx, 'qs_a', { requestId: 'x' }), (e) => {
      assert.strictEqual(e.code, 'E_UNSUPPORTED');
      assert.strictEqual(e.capability, 'agent.question');
      return true;
    });
  });

  await okA('会话 → 实例映射（list / get）', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const list = await provider.instances.list(ctx);
    assert.strictEqual(list.length, 2);
    assert.deepStrictEqual([list[0].id, list[0].name, list[0].status], ['qs_a', '会话 A', 'idle']);
    assert.strictEqual(list[0].model, 'qfmodel');
    assert.strictEqual(list[1].origin, 'ios');
    const one = await provider.instances.get(ctx, 'qs_a');
    assert.strictEqual(one.cmaSessionId, 'sess_a');
    await assert.rejects(() => provider.instances.get(ctx, 'nope'), (e) => e.code === 'E_NOT_FOUND');
  });

  await okA('建会话：带上 environment_id + session_context 走 POST（201 也认）', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const inst = await provider.instances.create(ctx, { name: '新会话' });
    assert.strictEqual(inst.id, 'qs_new');
    const call = w.state.calls.filter((c) => c.path === '/api/v1/remote/sessions' && c.method === 'POST').pop();
    assert.deepStrictEqual(call.body, {
      title: '新会话', origin: 'web', environment_id: 'env_1',
      session_context: { model: 'qfmodel', work_mode: 'general' },
    });
  });

  await okA('models：从 environments.metadata.available_models 取，按倍率排序', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const models = await provider.model.list(ctx);
    assert.strictEqual(models.length, 2);
    assert.strictEqual(models[0].id, 'qfmodel');
    assert.strictEqual(models[0].priceFactor, 0.04);
    assert.strictEqual(models[1].id, 'kmodel_latest');
  });

  console.log('\n8. 端到端（假 fetch，业务代码不改）');

  await okA('agent.stream：增量 yield + 事件顺序 + done 在最后，且不丢 idle 后的 usage', async () => {
    const w = makeWorld({
      events: [
        { event_id: 'e11', sequence_num: 11, source: 'worker', event_type: 'worker.status.changed', payload: { worker_status: 'running', session_status: 'running' } },
        {
          event_id: 'e12', sequence_num: 12, source: 'worker', event_type: 'assistant',
          payload: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '先看一眼' }, { type: 'text', text: '我来跑。' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo hi' } }] }, stop_reason: 'tool_use' },
        },
        { event_id: 'e13', sequence_num: 13, source: 'worker', event_type: 'user', payload: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ text: 'hi\n' }] }] } } },
        { event_id: 'e14', sequence_num: 14, source: 'worker', event_type: 'assistant', payload: { message: { role: 'assistant', content: [{ type: 'text', text: '完成。' }] }, stop_reason: 'tool_use' } },
        { event_id: 'e15', sequence_num: 15, source: 'worker', event_type: 'session.thread_status_idle', payload: { stop_reason: 'end_turn' } },
        { event_id: 'e16', sequence_num: 16, source: 'worker', event_type: 'session.usage', payload: { model_credits: 0.02, sandbox_runtime_credits: 0.01, total_credits: 0.03 } },
      ],
    });
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);

    const got = [];
    for await (const ev of provider.agent.stream(ctx, 'qs_a', { text: '执行 echo hi' })) got.push(ev);
    const kinds = got.map((e) => e.kind);
    for (const k of [EVENT.STATUS, EVENT.THINKING, EVENT.TEXT, EVENT.TOOL, EVENT.TOOL_RESULT, EVENT.USAGE, EVENT.DONE]) {
      assert.ok(kinds.includes(k), '缺 ' + k + ' → ' + kinds.join(','));
    }
    assert.strictEqual(kinds[kinds.length - 1], EVENT.DONE, 'done 必须是最后一条');
    assert.strictEqual(got.find((e) => e.kind === EVENT.USAGE).data.credits, 0.03);
    assert.strictEqual(got.filter((e) => e.kind === EVENT.DONE).length, 1);

    // 发出去的那条 user 事件形状要对（实测格式）
    const post = w.state.calls.find((c) => c.method === 'POST' && /\/events$/.test(c.path));
    assert.strictEqual(post.body.events[0].event_type, 'user');
    assert.strictEqual(post.body.events[0].payload.message.content[0].type, 'text');
    assert.strictEqual(post.body.events[0].payload.message.content[0].text, '执行 echo hi');
    assert.match(post.body.events[0].payload.uuid, /^controller-user:/);
    assert.strictEqual(post.body.events[0].payload.session_id, '');
  });

  await okA('exec.run：grant → bootstrap → initialize → tools/call bash → out/err/code', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);

    const r = await provider.exec.run(ctx, 'qs_a', { command: 'echo hi', timeout: 30 });
    assert.strictEqual(r.out, 'hello\n');
    assert.strictEqual(r.err, 'warn\n');
    assert.strictEqual(r.code, 0);
    assert.ok(r.ms >= 0);

    // 三步都发生了，顺序也对
    const paths = w.state.calls.map((c) => c.path);
    const iGrant = paths.indexOf('/api/v1/remote/preview/grant');
    const iBoot = paths.indexOf('/_preview/bootstrap');
    const iInit = w.state.calls.findIndex((c) => c.path === '/mcp' && c.body && c.body.method === 'initialize');
    const iCall = w.state.calls.findIndex((c) => c.path === '/mcp' && c.body && c.body.method === 'tools/call');
    assert.ok(iGrant >= 0 && iBoot > iGrant && iInit > iBoot && iCall > iInit, `顺序不对：${paths.join(' → ')}`);

    // 命令确实套了包装脚本，且用了 on_timeout=kill
    const call = w.state.calls[iCall];
    assert.strictEqual(call.body.params.name, 'bash');
    assert.match(call.body.params.arguments.command, /echo hi/);
    assert.match(call.body.params.arguments.command, /__COWBIRD_CODE__/);
    assert.strictEqual(call.body.params.arguments.on_timeout, 'kill');
    assert.strictEqual(call.body.params.arguments.timeout, 30);

    // 隧道 cookie 与 MCP session 头都带上了
    assert.match(call.headers.cookie, /preview_sess=abc123/);
    assert.strictEqual(call.headers['mcp-session-id'], 'mcp-1');

    // 第二个隧道：缓存命中，不再重复 grant（30 分钟有效）
    const before = w.state.calls.filter((c) => c.path === '/api/v1/remote/preview/grant').length;
    await provider.exec.run(ctx, 'qs_a', { command: 'echo again' });
    const after = w.state.calls.filter((c) => c.path === '/api/v1/remote/preview/grant').length;
    assert.strictEqual(after, before, '隧道应该被缓存复用');
  });

  await okA('exec.run：沙箱没起（503 CloudSandboxNotReady）→ E_NOT_READY，别硬报成功', async () => {
    const w = makeWorld({ grantStatus: 503, grantReason: 'CloudSandboxNotReady' });
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    await assert.rejects(() => provider.exec.run(ctx, 'qs_a', { command: 'id' }), (e) => {
      assert.strictEqual(e.code, 'E_NOT_READY');
      assert.match(e.message, /wake/);
      return true;
    });
  });

  await okA('exec.probe：503 时 ready=false 并说明原因（不抛）', async () => {
    const w = makeWorld({ grantStatus: 503, grantReason: 'CloudSandboxNotReady' });
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const p = await provider.exec.probe(ctx, 'qs_a');
    assert.strictEqual(p.ready, false);
    assert.strictEqual(p.reason, 'CloudSandboxNotReady');
  });

  await okA('instances.info：沙箱没起就 {ready:false}，不编配额数字', async () => {
    const w = makeWorld({ grantStatus: 503, grantReason: 'CloudSandboxNotReady' });
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const info = await provider.instances.info(ctx, 'qs_a');
    assert.strictEqual(info.ready, false);
    assert.strictEqual(info.reason, 'CloudSandboxNotReady');
    assert.ok(Array.isArray(info.facts) && info.facts.length > 0);
    assert.strictEqual(info.visible, undefined);
  });

  await okA('instances.info：沙箱在跑时读 cgroup，给出可见 / 配额两组数', async () => {
    const probeOut = [
      'COWBIRD_NPROC=8', 'COWBIRD_CPU_MAX=400000 100000', 'COWBIRD_MEM_MAX=8589934592',
      'COWBIRD_MEMTOTAL_KB=16613344', 'COWBIRD_DF_KB=1048576',
      'COWBIRD_KERNEL=5.10.134-18.0.13.lifsea8.x86_64', 'COWBIRD_VIRT=docker',
      'COWBIRD_UID=0', 'COWBIRD_CWD=/data', 'COWBIRD_BOOTID=abcdef0123456789', 'COWBIRD_UPTIME=2779',
    ].join('\n') + '\n';
    const w = makeWorld({ bashText: `${probeOut}\n__COWBIRD_CODE__0\n__COWBIRD_STDERR__\n` });
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const info = await provider.instances.info(ctx, 'qs_a');
    assert.strictEqual(info.ready, true);
    assert.strictEqual(info.visible.cpu, 8);
    assert.strictEqual(info.quota.cpu, 4);
    assert.strictEqual(info.quota.memBytes, 8589934592);
    assert.ok(info.facts.some((f) => f.label === '沙箱 ID' && /sd-test01/.test(f.value)));
  });

  await okA('exec.start → poll：background 拿 pid + output_file，跑完才 done', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);

    const job = await provider.exec.start(ctx, 'qs_a', { command: 'sleep 5 && echo done' });
    assert.strictEqual(job.backgrounded, true);
    assert.strictEqual(job.jobId, '4242');
    assert.strictEqual(job.outputPath, '/tmp/tool-outputs/bash_42.log');

    const s1 = await provider.exec.poll(ctx, 'qs_a', { jobId: job.jobId });
    assert.strictEqual(s1.done, false, '还活着就不该报完成');
    assert.strictEqual(s1.out, 'still running…\n');

    w.state.alive = false;               // 进程结束
    const s2 = await provider.exec.poll(ctx, 'qs_a', { jobId: job.jobId });
    assert.strictEqual(s2.done, true);
    assert.strictEqual(s2.code, 7);
    assert.strictEqual(s2.out, 'done-output\n');
    assert.strictEqual(s2.err, 'boom\n');

    await assert.rejects(() => provider.exec.poll(ctx, 'qs_a', { jobId: 'nope' }), (e) => e.code === 'E_NO_JOB');
  });

  await okA('fs.list：glob 文本 → 文件条目（相对路径补 base，目录标 dir）', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const list = await provider.fs.list(ctx, 'qs_a', { path: '/data' });
    const byPath = Object.fromEntries(list.map((f) => [f.path, f]));
    assert.ok(byPath['/data/a.txt'], '缺 a.txt：' + list.map((f) => f.path).join(','));
    assert.strictEqual(byPath['/data/a.txt'].type, 'file');
    assert.strictEqual(byPath['/data/sub'].type, 'dir');
    assert.ok(byPath['/pinned/abs.txt'], '绝对路径应该原样保留');
  });

  await okA('fs.write / fs.read 走 file_write / file_read', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const wr = await provider.fs.write(ctx, 'qs_a', { path: '/data/x.txt', content: 'ABC' });
    assert.strictEqual(wr.size, 3);
    const rd = await provider.fs.read(ctx, 'qs_a', { path: '/data/x.txt' });
    assert.strictEqual(rd.content, 'still running…\n');
  });

  await okA('auth.state / ttlDays：跳过 acw_tc 这类短命 cookie', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const st = await provider.auth.state(ctx);
    assert.strictEqual(st.hasCookie, true);
    assert.strictEqual(st.cookieCount, 2);
    assert.match(st.token, /^qoder-cookie:[0-9a-f]{12}$/);      // 只放指纹，不放 cookie 本身
    const ttl = provider.auth.ttlDays(ctx);
    assert.ok(ttl > 9 && ttl <= 10, 'ttl 应该是 ~10 天，实际 ' + ttl);
  });

  await okA('auth.login：粘一条 cookie 就能存下并校验 /api/v1/me', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    const r = await provider.auth.login(ctx, { cookie: 'acw_tc=zzz; qoder_session=sess-cookie' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.user.name, '测试账号');
    const st = await provider.auth.state(ctx);
    assert.strictEqual(st.hasCookie, true);
    assert.strictEqual(st.source, 'cookie');
  });

  await okA('auth.login：/me 401 时把这份 cookie 丢掉并报错（不留假登录态）', async () => {
    provider._internals.useFetch(async () => resp(401, { code: 'UNAUTHORIZED' }));
    const ctx = makeCtx();
    await assert.rejects(() => provider.auth.login(ctx, { cookie: 'a=b' }), (e) => {
      assert.strictEqual(e.code, 'E_AUTH');
      return true;
    });
    assert.strictEqual(ctx.store.read('auth', null), null);
  });

  console.log('\n9. 内核调用约定（签名对齐 lib/platform/*.js）');

  await okA('exec.run 认 timeoutMs（毫秒）+ cwd（内核传的是这两个）', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    await provider.exec.run(ctx, 'qs_a', { command: 'id', timeoutMs: 45000, cwd: '/workspace' });
    const call = w.state.calls.filter((c) => c.path === '/mcp' && c.body && c.body.method === 'tools/call').pop();
    assert.strictEqual(call.body.params.arguments.timeout, 45);
    assert.strictEqual(call.body.params.arguments.work_dir, '/workspace');
  });

  await okA('exec.poll 收整个 job 对象（exec.js 的 follow 就是这么传的）', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const job = await provider.exec.start(ctx, 'qs_a', { command: 'sleep 9' });
    const s1 = await provider.exec.poll(ctx, 'qs_a', job);        // 传对象而不是 {jobId}
    assert.strictEqual(s1.done, false);
    w.state.alive = false;
    const s2 = await provider.exec.poll(ctx, 'qs_a', job);
    assert.strictEqual(s2.done, true);
    assert.strictEqual(s2.code, 7);
  });

  await okA('exec.probe 未就绪时给 why（内核编排层读的就是这个字段）', async () => {
    const w = makeWorld({ grantStatus: 503, grantReason: 'CloudSandboxNotReady' });
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const p = await provider.exec.probe(ctx, 'qs_a');
    assert.strictEqual(p.ready, false);
    assert.strictEqual(p.why, 'CloudSandboxNotReady');
    assert.strictEqual(p.reason, 'CloudSandboxNotReady');
  });

  await okA('create(ctx, {name, prompt}, {log})：首条指令建完补发，extra.sessionStatus 可供 ls 用', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const logs = [];
    const ctx = makeCtx();
    seedAuth(ctx);
    const inst = await provider.instances.create(ctx, { name: '带指令的会话', prompt: '先别动，等我指令' }, { log: (m) => logs.push(m) });
    assert.strictEqual(inst.extra.promptSent, true);
    assert.strictEqual(inst.extra.sessionStatus, 'idle');
    // 建会话时会补发**一条** user 事件；随后为了压住「平台拿首条消息自动改标题」
    // 还会尝试一次改名（可能产生 control_request 事件），所以只数 event_type=user 的。
    const posts = w.state.calls.filter((c) => c.method === 'POST' && /\/events$/.test(c.path));
    const userEvents = posts.filter((c) => {
      const evs = (c.body && (c.body.events || (c.body.event ? [c.body] : []))) || [];
      return evs.some((e) => e && e.event_type === 'user');
    });
    assert.strictEqual(userEvents.length, 1, '应该只有一条 user 事件');
    assert.ok(inst.extra.titleRestored === true || inst.extra.titleRestored === false, '改名尝试要有结果标记');
    assert.strictEqual(posts[0].body.events[0].payload.message.content[0].text, '先别动，等我指令');
  });

  await okA('rm --archive 走 /archive（不认才退回 DELETE）', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    assert.strictEqual(await provider.instances.remove(ctx, 'qs_a', { archive: true }), true);
    assert.ok(
      w.state.calls.some((c) => c.path === '/api/v1/remote/sessions/qs_a/archive' && c.method === 'POST'),
      '没打到 archive 端点'
    );
    assert.strictEqual(await provider.instances.remove(ctx, 'qs_a', {}), true);
    assert.ok(w.state.calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/remote/sessions/qs_a'));
  });

  await okA('doctor.checks(ctx, {net:false}) 一个请求都不发（--no-net 契约）', async () => {
    const w = makeWorld();
    provider._internals.useFetch(w.fetch);
    const ctx = makeCtx();
    seedAuth(ctx);
    const checks = await provider.doctor.checks(ctx, { net: false });
    assert.strictEqual(w.state.calls.length, 0, '不该有网络调用：' + JSON.stringify(w.state.calls.map((c) => c.path)));
    assert.ok(checks.some((c) => /登录态/.test(c.name)));
    assert.ok(checks.some((c) => /未联网/.test(c.detail)));
    // 内核 doctor 只认 ok / warn / bad / info 四种 level（写 'error' 会渲染成空图标、也不计入异常数）
    for (const c of checks) assert.ok(['ok', 'warn', 'bad', 'info'].includes(c.level), '非法 level: ' + c.level);
  });

  console.log(`\n${fail ? '\u2717' : '\u2713'} ${pass} 通过${fail ? '，' + fail + ' 失败' : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自测自身出错：' + (e && e.stack));
  process.exit(1);
});
