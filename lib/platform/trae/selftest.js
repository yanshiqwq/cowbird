#!/usr/bin/env node
// trae 驱动的离线自测：不联网、不碰真登录态。
//   node lib/platform/trae/selftest.js
'use strict';
const assert = require('assert');

const { CAP, EVENT } = require('../contract');
const auth = require('./auth');
const map = require('./map');
const transport = require('./http');
const ws = require('./ws');
const fsApi = require('./fs');
const execApi = require('./exec');
const sendApi = require('./send');
const mcpApi = require('./mcp');
const primeApi = require('./prime');
const provider = require('./index');
const C = require('./constants');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  \u2713 ' + name); } catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + (e && e.message)); } };
const asyncQueue = [];
const okA = (name, fn) => { asyncQueue.push({ name, fn }); };

function memStore() {
  const d = {};
  return { dir: '(内存)', read: (k) => (d[k] === undefined ? null : d[k]), write: (k, v) => { d[k] = v; }, remove: (k) => { delete d[k]; } };
}

const COOKIE = 'sessionid=abc123; sid_guard=xyz; X-Cloudide-Session=cloud9; ttwid=t1; passport_csrf_token=csrf1';

function fakeCtx() {
  const ctx = { store: memStore(), defaults: provider.defaults, config: () => ({}), channel: 'trae:default', account: 'default', log: () => {} };
  auth.save(ctx, { cookies: auth.parseCookieString(COOKIE), source: 'test' });
  const t = transport.createTransport(ctx);
  // 令牌固定，省掉换票（换票本身在 http.js 里，不走网络就没法测）
  ctx.store.write(transport.TOKEN_KEY, { token: 'jwt-fake', exp: Date.now() + 3600e3 });
  return { ctx, t };
}

// ---------------------------------------------------------------- 登录态
ok('parseCookieString：拆开、去重、补 domain', () => {
  const cs = auth.parseCookieString('a=1; b=2; a=3');
  assert.deepStrictEqual(cs.map((c) => c.name), ['a', 'b']);
  assert.strictEqual(cs.find((c) => c.name === 'a').value, '3');
  assert.strictEqual(cs[0].domain, '.trae.cn');
  assert.deepStrictEqual(auth.parseCookieString(''), []);
});

okA('login：没有 cookie 时给的是可操作的指引，不是一句"失败"', async () => {
  const { ctx } = fakeCtx();
  await assert.rejects(() => auth.login(ctx, {}), (e) => /document\.cookie/.test(e.message) && /sessionid/.test(e.message));
});

okA('login：缺 sessionid 的串要拒绝（别把别人的 cookie 当登录态）', async () => {
  const { ctx } = fakeCtx();
  await assert.rejects(() => auth.login(ctx, { cookie: 'foo=1; bar=2' }), /没有 sessionid/);
});

okA('login → state：能读回，且 ttlDays 是 null（session cookie 没有期限）', async () => {
  const { ctx } = fakeCtx();
  assert.strictEqual(auth.isLoggedIn(auth.read(ctx)), true);
  const st = await auth.state(ctx);
  assert.strictEqual(st.hasSession, true);
  assert.strictEqual(st.ttlDays, null);
  assert.strictEqual(st.cookies, 5);
});

// ---------------------------------------------------------------- 归一
ok('statusOf：1=creating、5=completed、未知值原样透出', () => {
  assert.strictEqual(map.statusOf(1), 'creating');
  assert.strictEqual(map.statusOf(5), 'completed');
  assert.strictEqual(map.statusOf(9), 'status-9');
  assert.strictEqual(map.statusOf('idle'), 'idle');
});

ok('normalizeSession：把沙箱线索都摊到 extra 里', () => {
  const inst = map.normalizeSession({
    chat_session_id: 's1', title: '全面调查当前环境', status: 5, mode: 'code', origin: 'web',
    created_at: '1794913386856', updated_at: '1794915513931',
    explorer_url: 'https://agent-sandbox-bj-c1-gw.trae.cn/explorer/s1',
    workspace_path: '/workspace', remote_project_id: 'rp_1',
    extra: { primary_sandbox_type: 'harness' },
    sandbox: { name: 'sb1', cluster_name: 'c1', pod_name: 'p1', allocation_status: 'ready' },
  });
  assert.strictEqual(inst.id, 's1');
  assert.strictEqual(inst.name, '全面调查当前环境');
  assert.strictEqual(inst.status, 'completed');
  assert.strictEqual(inst.extra.sandboxType, 'harness');
  assert.strictEqual(inst.extra.workspacePath, '/workspace');
  assert.strictEqual(inst.extra.sandbox.pod, 'p1');
  assert.match(inst.updatedAt, /^20\d\d-\d\d-\d\dT/);
});

// 一条真实的 task 消息（plan_item → tool_call_info），字段名照抄线上
const TASK_MSG = {
  message_id: 'm2', role: 'assistant', message_type: 'task', message_index: 3,
  content: JSON.stringify({
    task_id: 't1',
    messages: [
      { id: 'a', type: 'plan_item', plan_item: { thought: '先看看环境' } },
      {
        id: 'b', type: 'plan_item', plan_item: {
          tool_call_info: {
            id: 'tc1', name: 'Shell',
            params: { command: 'uname -a', cwd: '/workspace' },
            result: { status: 'success', data: { stdout: 'Linux all-in-one 6.18.5', stderr: '', exit_code: 0 } },
          },
        },
      },
    ],
  }),
};

ok('itemEvents：task → thought(text) + tool + tool_result（带 exitCode）', () => {
  const evs = map.itemEvents(TASK_MSG);
  const kinds = evs.map((e) => e.kind);
  assert.deepStrictEqual(kinds, [EVENT.TEXT, EVENT.TOOL, EVENT.TOOL_RESULT]);
  assert.strictEqual(evs[1].data.name, 'Shell');
  assert.strictEqual(evs[1].data.input.command, 'uname -a');
  assert.strictEqual(evs[2].data.ok, true);
  assert.strictEqual(evs[2].data.exitCode, 0);
  assert.match(evs[2].data.out, /Linux all-in-one/);
});

ok('itemEvents：非零退出码要标成不 ok', () => {
  const msg = JSON.parse(JSON.stringify(TASK_MSG));
  msg.content = JSON.parse(msg.content);
  msg.content.messages[1].plan_item.tool_call_info.result.data.exit_code = 2;
  msg.content = JSON.stringify(msg.content);
  const ev = map.itemEvents(msg).find((e) => e.kind === EVENT.TOOL_RESULT);
  assert.strictEqual(ev.data.ok, false);
  assert.strictEqual(ev.data.exitCode, 2);
});

ok('userText：content 是 JSON 字符串数组时也能拼出正文', () => {
  const m = { role: 'user', content: JSON.stringify([{ type: 'text', text_content: '调查一下 cgroups' }]) };
  assert.strictEqual(map.userText(m), '调查一下 cgroups');
  assert.strictEqual(map.userText({ role: 'user', content: 'plain' }), 'plain');
});

ok('messagesToHistory：用户/工具都能摊成可读行', () => {
  const items = [{ role: 'user', content: JSON.stringify([{ type: 'text', text_content: '你好' }]), message_index: 2 }, TASK_MSG];
  const h = map.messagesToHistory(items);
  assert.strictEqual(h[0].role, 'user');
  assert.strictEqual(h[0].text, '你好');
  assert.ok(h.some((x) => x.role === 'tool' && /Shell/.test(x.text)));
});

// ---------------------------------------------------------------- 实例
okA('instances.list：分页按 total 收尾，字段归一', async () => {
  const { ctx, t } = fakeCtx();
  let page = 0;
  t.request = async (method, path) => {
    page++;
    assert.match(path, /page_size=\d+&page_num=\d+/, '参数必须是 snake_case 的 page_size/page_num');
    return page === 1
      ? { data: { items: [{ chat_session_id: 's1', title: '一号', status: 5 }], total: 2 } }
      : { data: { items: [{ chat_session_id: 's2', title: '二号', status: 1 }], total: 2 } };
  };
  const list = await provider.instances.list(ctx, { pageSize: 1 });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].status, 'completed');
  assert.strictEqual(list[1].status, 'creating');
});

okA('instances.create：只建会话（mode=code + env=remote，没有 initial_message）', async () => {
  const { ctx, t } = fakeCtx();
  let created = null;
  t.request = async (method, path, opts = {}) => {
    if (method === 'POST' && path === C.Ep.sessions) created = opts.body;
    return { data: { chat_session_id: 'new1', status: 1 } };
  };
  const inst = await provider.instances.create(ctx, { name: 'cowbird-probe', noPrime: true });
  assert.strictEqual(inst.id, 'new1');
  assert.strictEqual(inst.name, 'cowbird-probe');
  assert.strictEqual(created.mode, 'code', 'mode 不是 code 的会话没有沙箱/工具');
  assert.strictEqual(created.env, 'remote', 'env 必须是远端沙箱');
  assert.ok(!('initial_message' in created), '第一轮留给装执行端，不在这里塞 prompt');
});

okA('instances.create：建完立刻把标题改成我们给的名字（否则命令找不到实例）', async () => {
  const { ctx, t } = fakeCtx();
  let committed = null;
  t.request = async (method, path, opts = {}) => {
    if (method === 'POST' && /\/commit$/.test(path)) committed = opts.body;
    return { data: { chat_session_id: 'new2', status: 1 } };
  };
  await provider.instances.create(ctx, { name: 'nice-name', noPrime: true });
  assert.ok(committed, '应该调一次 commit 存标题');
  assert.strictEqual(committed.title, 'nice-name');
});

okA('instances.create：默认会在沙箱里装执行端（create 的一部分，不是单独命令）', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ data: { chat_session_id: 'new3', status: 1 } });
  const orig = primeApi.install;
  let called = 0;
  primeApi.install = async () => { called++; return { primed: true, extId: 'x' }; };
  try {
    const inst = await provider.instances.create(ctx, { name: 'p1', prompt: '跑个 nproc' });
    assert.strictEqual(called, 1, 'create 要装一次执行端');
    assert.strictEqual(inst.extra.execReady, true);
  } finally { primeApi.install = orig; }
});

okA('instances.create：一直被拒就删会话 + 换新会话重来，最后抛 E_PRIME_REFUSED（不留半成品）', async () => {
  const { ctx, t } = fakeCtx();
  let created = 0; let deleted = [];
  t.request = async (method, path) => {
    if (method === 'POST' && path === C.Ep.sessions) { created++; return { data: { chat_session_id: 's' + created, status: 1 } }; }
    if (method === 'DELETE') deleted.push(path.split('/').pop());
    return { data: {} };
  };
  const orig = primeApi.install;
  primeApi.install = async () => { const e = new Error('agent 拒了'); e.code = 'E_PRIME_REFUSED'; e.refusal = '我不做'; throw e; };
  try {
    await assert.rejects(() => provider.instances.create(ctx, { name: 'p2' }), (e) => {
      assert.strictEqual(e.code, 'E_PRIME_REFUSED');
      assert.ok(/3 次/.test(e.message), '要说清试了几次');
      return true;
    });
    assert.strictEqual(created, 3, '每次被拒都要换一个**新**会话');
    assert.deepStrictEqual(deleted, ['s1', 's2', 's3'], '被拒的会话要删掉，不留脏上下文');
  } finally { primeApi.install = orig; }
});

okA('instances.remove：走 DELETE 单会话', async () => {
  const { ctx, t } = fakeCtx();
  let seen = null;
  t.request = async (method, path) => { seen = method + ' ' + path; return {}; };
  await provider.instances.remove(ctx, 's9');
  assert.strictEqual(seen, 'DELETE /api/remote/v1/chat_sessions/s9');
});

okA('instances.rename：走 commitSession 的 body（不是 PATCH）', async () => {
  const { ctx, t } = fakeCtx();
  let seen = null;
  t.request = async (method, path, opts = {}) => { seen = { method, path, body: opts.body }; return {}; };
  await provider.instances.rename(ctx, 's9', '新名字');
  assert.strictEqual(seen.method, 'POST');
  assert.match(seen.path, /\/commit$/);
  assert.deepStrictEqual(seen.body, { chat_session_id: 's9', title: '新名字' });
});

okA('agent.send：真的 POST /messages，body 摊平且把 id 放顶层', async () => {
  const { ctx, t } = fakeCtx();
  let seen = null;
  t.request = async (method, path, opts = {}) => { seen = { method, path, body: opts.body }; return { code: 0, data: { message_id: 'm9', status: 'in_progress' } }; };
  const r = await provider.agent.send(ctx, 's1', { text: 'hi' });
  assert.strictEqual(r.messageId, 'm9');
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(seen.path, '/api/remote/v1/chat_sessions/s1/messages');
  assert.strictEqual(seen.body.chat_session_id, 's1');
  assert.deepStrictEqual(JSON.parse(seen.body.query), [{ type: 'text', data: { content: 'hi' } }]);
  assert.ok(!('initial_message' in seen.body), '发消息没有外壳（991102 就是多包了一层）');
});

okA('agent.send：上游非 0 code 要把原始信息带出来，别吞成"失败"', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ code: 991102, message: 'invalid parameter' });
  await assert.rejects(() => provider.agent.send(ctx, 's1', { text: 'hi' }), (e) => String(e.code) === '991102' && /invalid parameter/.test(e.message));
});

okA('agent.stream：轮询增量 → tool/tool_result → 会话完成时 done', async () => {
  const { ctx, t } = fakeCtx();
  let polls = 0;
  t.request = async (method, path) => {
    if (path.startsWith(C.Ep.messages('s1'))) {
      polls++;
      if (polls === 1) return { data: { items: [{ message_id: 'm0', role: 'user', content: 'hi' }] } };
      if (polls === 2) return { data: { items: [{ message_id: 'm0', role: 'user', content: 'hi' }, TASK_MSG] } };
      return { data: { items: [{ message_id: 'm0', role: 'user', content: 'hi' }, TASK_MSG] } };
    }
    if (path === C.Ep.session('s1')) return { data: { chat_session_id: 's1', status: 5 } };
    throw new Error('假传输没准备好的请求：' + path);
  };
  const got = [];
  for await (const ev of provider.agent.stream(ctx, 's1', { timeoutMs: 5000, pollMs: 1 })) got.push(ev.kind);
  assert.ok(got.includes(EVENT.TOOL), '应该看到 tool 事件');
  assert.ok(got.includes(EVENT.TOOL_RESULT), '应该看到 tool_result 事件');
  assert.strictEqual(got[got.length - 1], EVENT.DONE);
});

okA('agent.history：拿不到消息时空数组，不抛', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ data: {} });
  const h = await provider.agent.history(ctx, 's1', {});
  assert.deepStrictEqual(h.messages, []);
});

ok('能力声明：AGENT / FS / EXEC / WAKE 都有，EXEC_BG 没有', () => {
  assert.ok(provider.has(CAP.AGENT));
  assert.ok(provider.has(CAP.FS), '数据面已打通，fs 读/写/列 都可用');
  assert.ok(provider.has(CAP.EXEC), '9003 的 MCP 通道打通后 exec 是有的（需先 prime）');
  assert.ok(provider.has(CAP.WAKE), '唤醒 = 跑一轮，顺带铺路');
  assert.ok(!provider.has(CAP.EXEC_BG), '一条命令一个 MCP 往返，没有后台任务通道');
  assert.ok(!provider.has(CAP.AUTH_RENEW), 'cookie 型平台没有 refresh_token');
});

ok('sendBody：摊平形状（chat_session_id 在顶层，没有 initial_message 外壳）', () => {
  const b = map.buildSendBody({}, { text: '你好' });
  assert.strictEqual(b.content.length, 0, 'content 必须是空数组');
  assert.deepStrictEqual(JSON.parse(b.query), [{ type: 'text', data: { content: '你好' } }]);
  assert.strictEqual(b.model_selection_strategy, 'manual');
  assert.strictEqual(b.agent_type, 'solo_agent_remote');
  assert.ok(b.custom_model && b.custom_model.config_name === b.model_name, 'custom_model 要跟 model_name 对齐');
  assert.strictEqual(typeof b.common_params, 'string', 'common_params 是**字符串化**的 JSON');
  assert.ok(!('userMessage' in b), '旧的 {userMessage} 外壳是错的（991102 就是它）');
  assert.ok(!('initial_message' in b), '发消息没有 initial_message 这层壳');
  assert.ok('chat_session_id' in b, 'chat_session_id 在顶层（调用方覆盖成真实 id）');
});

ok('model：用户配置能覆盖模型，custom_model 跟着走', () => {
  const b = map.buildSendBody({ effective: { model: 'other-model' } }, { text: 'x' });
  assert.strictEqual(b.model_name, 'other-model');
  assert.strictEqual(b.custom_model.config_name, 'other-model');
  assert.strictEqual(b.custom_model.display_model_name, 'other-model');
});

// ---------------------------------------------------------------- 文件（数据面）
ok('encodePath：容忍沙箱绝对路径，去掉 /workspace 前缀', () => {
  assert.strictEqual(fsApi.encodePath('/workspace/src/a.js'), 'src/a.js');
  assert.strictEqual(fsApi.encodePath('/src/a.js'), 'src/a.js');
  assert.strictEqual(fsApi.encodePath('src/a.js'), 'src/a.js');
  assert.strictEqual(fsApi.encodePath('.'), '.');
  assert.strictEqual(fsApi.encodeUrlPath('src/a b.js'), 'src/a%20b.js');
});

okA('fs.list：WS fs.readdir → FileEntry（目录标 dir、大小/时间带上）', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ data: { explorer_url: 'https://agent-sandbox-x.example/explorer/s1' } });
  const orig = ws.rpc;
  let seen = null;
  ws.rpc = async (opts) => {
    seen = opts;
    return [
      { name: 'src', isDir: true },
      { name: 'a.txt', size: 12, mtime: 1794913386000 },
    ];
  };
  try {
    const list = await fsApi.list(ctx, 's1', { path: '/workspace' });
    assert.strictEqual(seen.method, 'fs.readdir');
    assert.strictEqual(seen.params.path, '.');
    assert.match(seen.explorerUrl, /^https:\/\//);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].type, 'dir');
    assert.strictEqual(list[1].type, 'file');
    assert.strictEqual(list[1].size, 12);
    assert.match(list[1].mtime, /^20\d\d-/);
  } finally { ws.rpc = orig; }
});

okA('fs.read：404 要说清"只认工作区相对路径 + 离线读的是快照"', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ data: { explorer_url: 'https://agent-sandbox-x.example/explorer/s1' } });
  t.dataRequest = async () => ({ ok: false, status: 404, text: '{"success":false,"error":{"message":"FileNotFound"}}' });
  await assert.rejects(() => fsApi.read(ctx, 's1', { path: '/etc/hostname' }), (e) => /工作区相对路径/.test(e.message) && /快照/.test(e.message));
});

okA('fs.read：成功时返回 {path, content}', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ data: { explorer_url: 'https://agent-sandbox-x.example/explorer/s1' } });
  let seenPath = null;
  t.dataRequest = async (base, method, p2) => { seenPath = method + ' ' + p2; return { ok: true, status: 200, text: 'hello' }; };
  const r = await fsApi.read(ctx, 's1', { path: '/workspace/README.md' });
  assert.strictEqual(r.content, 'hello');
  assert.strictEqual(r.path, 'README.md');
  assert.strictEqual(seenPath, 'GET /file/README.md');
});

okA('fs.write：PUT 到 /file/<相对路径>，body 带 content', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ data: { explorer_url: 'https://agent-sandbox-x.example/explorer/s1' } });
  let seen = null;
  t.dataRequest = async (base, method, p2, opts) => { seen = { method, path: p2, body: opts && opts.body }; return { ok: true, status: 200, text: '' }; };
  const r = await fsApi.write(ctx, 's1', { path: 'notes/a.txt', content: 'hi' });
  assert.strictEqual(seen.method, 'PUT');
  assert.strictEqual(seen.path, '/file/notes/a.txt');
  assert.deepStrictEqual(seen.body, { content: 'hi' });
  assert.strictEqual(r.size, 2);
});

okA('fs：没有 explorer_url 的会话要报清楚（沙箱还没分配）', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ data: { chat_session_id: 's1' } });
  await assert.rejects(() => fsApi.list(ctx, 's1', {}), /没有 explorer_url/);
});

// ---------------------------------------------------------------- exec（直连 MCP 通道）
ok('parseShellText：exec-server 的文本协议拆回结构（含非零退出码与 signal）', () => {
  const r = execApi.parseShellText('exit=0\n--- stdout ---\nhi\n--- stderr ---\n');
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out, 'hi');
  assert.strictEqual(r.err, '');
  const r2 = execApi.parseShellText('exit=7 signal=SIGKILL\n--- stdout ---\na\nb\n--- stderr ---\nboom\n');
  assert.strictEqual(r2.code, 7);
  assert.strictEqual(r2.signal, 'SIGKILL');
  assert.strictEqual(r2.out, 'a\nb');
  assert.strictEqual(r2.err, 'boom');
  // 认不出来就整段留在 out，别吞
  const r3 = execApi.parseShellText('完全不是这个格式');
  assert.strictEqual(r3.code, null);
  assert.strictEqual(r3.out, '完全不是这个格式');
});

ok('mcp.gatewayFor：{port} 占位符替换 + 去尾斜杠', () => {
  const s = { preview_url_template: 'https://run-agent-abc-p-{port}.agent-sandbox-bj-c1-gw.trae.cn/' };
  assert.strictEqual(mcpApi.gatewayFor(s), 'https://run-agent-abc-p-9003.agent-sandbox-bj-c1-gw.trae.cn');
  assert.strictEqual(mcpApi.gatewayFor(s, 9000), 'https://run-agent-abc-p-9000.agent-sandbox-bj-c1-gw.trae.cn');
  assert.strictEqual(mcpApi.gatewayFor({}), null, '没模板就返回 null，别编一个地址出来');
});

ok('mcp.classify：not found / 格式不合法 / 协议版本要分开', () => {
  assert.strictEqual(mcpApi.classify({ json: { error: { code: -32602, message: "MCP server 'user::x' not found" } } }).kind, 'no-server');
  assert.strictEqual(mcpApi.classify({ json: { error: { code: -32000, message: 'invalid canonical extensionId' } } }).kind, 'bad-id');
  assert.strictEqual(mcpApi.classify({ json: { error: { code: -32602, message: 'unsupported MCP-Protocol-Version' } } }).kind, 'protocol');
  assert.strictEqual(mcpApi.classify({ json: { result: {} } }), null, '正常响应不该被当成错误');
});

ok('execExtId：默认按 runtime_id 规则，且可被渠道配置覆盖', () => {
  assert.strictEqual(execApi.extIdOf({}), 'user::trae-remote-official_plugin_deployment_exec');
  assert.strictEqual(execApi.extIdOf({ effective: { execExtId: 'user::custom' } }), 'user::custom');
});

ok('stripComments：注释去掉、字符串里的 // 保留、去完仍然合法', () => {
  const src = [
    '#!/usr/bin/env node',
    '// 这是行注释',
    'const a = 1; // 尾注释',
    '/* 块注释',
    '   多行 */',
    "const url = 'http://x/y';",
    'const t = `// 不是注释`;',
    'console.log(a, url, t);',
  ].join('\n');
  const out = primeApi.stripComments(src);
  assert.ok(!/(^|\n)\s*\/\//.test(out), '行注释要没了');
  assert.ok(!out.includes('块注释'), '块注释要没了');
  assert.ok(out.includes("'http://x/y'"), '字符串里的 // 不能动');
  assert.ok(out.includes('`// 不是注释`'), '模板串里的 // 不能动');
  assert.ok(out.startsWith('#!'), 'shebang 不是注释，必须留着');
  new (require('node:vm').Script)(out);      // 去完还得能解析
});

ok('primeScript：内嵌的是**去注释后**的 server 源码（发出去更短、更少歧义）', () => {
  const s = primeApi.primeScript();
  assert.ok(/COWBIRD_PRIME_OK/.test(s), '要有终态标记，调用方靠它判成功');
  assert.ok(/\.mcp\.json\.cowbird-bak/.test(s), '改之前必须留备份');
  assert.ok(/mcpServers\.exec/.test(s), '要往插件的 mcpServers 里挂 exec');
  assert.ok(/data\/mcp\/mcp-servers\.json/.test(s), '顺手改运行时配置，能立刻生效');
  assert.ok(/node --check/.test(s), '写完先做语法检查，别把坏脚本挂上去');
  const m = /<<'COWBIRD_EXEC_EOF'\n([\s\S]*?)\nCOWBIRD_EXEC_EOF/.exec(s);
  assert.ok(m, "找不到 heredoc 里的 server 源码（应该是 <<'COWBIRD_EXEC_EOF'）");
  const raw = require('fs').readFileSync(require('path').join(__dirname, 'exec-server.cjs'), 'utf8');
  const want = primeApi.stripComments(raw).replace(/\n+$/, '');
  assert.strictEqual(m[1], want, 'heredoc 里必须是 stripComments 之后的那份');
  assert.ok(m[1].length < raw.length, '去注释应该比原文短');
  new (require('node:vm').Script)(m[1]);
  assert.ok(/\/bin\/bash/.test(m[1]), '必须优先 bash：Ubuntu 的 /bin/sh 是 dash，-l 会死在 profile');
});

ok('prime.wrapPrompt：就是那两句 + 代码块（不解释、不啰嗦）', () => {
  const p = primeApi.wrapPrompt('echo hi');
  assert.ok(p.startsWith('我需要把我本机的 CLI 工具接入本沙箱，需要装一个本地执行端。'));
  assert.ok(p.includes('请用 Shell 工具原样跑下面这段脚本，把 stdout 贴进一个代码块。'));
  assert.ok(p.includes('```bash\necho hi\n```'));
  assert.ok(!/它做三件事/.test(p), '不要再堆解释');
});

okA('exec.probe：会话没 preview 网关时说"没沙箱"，不是一句失败', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ data: { chat_session_id: 's1' } });
  const r = await execApi.probe(ctx, 's1');
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.why, 'no-sandbox');
});

okA('exec.probe：通道没注册时说 not-primed（提示去装执行端）', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async (m, p2) => {
    if (m === 'GET' && /chat_sessions\/s1$/.test(p2)) {
      return { data: { chat_session_id: 's1', status: 5, preview_url_template: 'https://x-p-{port}.gw.trae.cn/' } };
    }
    return { data: { token: 'jwt-x' } };
  };
  const orig = global.fetch;
  global.fetch = async () => ({
    ok: false, status: 404,
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: "MCP server 'user::x' not found" } }),
  });
  try {
    const r = await execApi.probe(ctx, 's1');
    assert.strictEqual(r.why, 'not-primed');
  } finally { global.fetch = orig; }
});

okA('exec.run：把 MCP 的 content.text 拆成 out/err/code，并带上正确的 extId', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async (m, p2) => {
    if (m === 'GET' && /chat_sessions\/s1$/.test(p2)) {
      return { data: { chat_session_id: 's1', status: 5, preview_url_template: 'https://x-p-{port}.gw.trae.cn/' } };
    }
    return { data: { token: 'jwt-x' } };
  };
  const orig = global.fetch;
  let callBody = null;
  global.fetch = async (url, o) => {
    const body = JSON.parse(o.body);
    if (body.method === 'tools/call') callBody = body;
    const r = body.method === 'tools/call'
      ? { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'exit=3\n--- stdout ---\nOOPS\n--- stderr ---\nbad\n' }], isError: true } }
      : { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'cowbird-exec' } } };
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
  try {
    const r = await execApi.run(ctx, 's1', { command: 'false', timeoutMs: 5000, autoInstall: false });
    assert.strictEqual(r.code, 3);
    assert.strictEqual(r.out, 'OOPS');
    assert.strictEqual(r.err, 'bad');
    assert.strictEqual(r.via, 'mcp');
    assert.strictEqual(callBody.params.name, 'sh');
    assert.strictEqual(callBody.params.arguments.cmd, 'false');
    assert.strictEqual(callBody.params._meta['trae/extensionId'], execApi.DEFAULT_EXT);
  } finally { global.fetch = orig; }
});

okA('exec.run：没执行端又装不上时，直说 E_NOT_PRIMED（不再偷偷让 agent 代跑）', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async (m, p2) => {
    if (m === 'GET' && /chat_sessions\/s1$/.test(p2)) {
      return { data: { chat_session_id: 's1', status: 5, preview_url_template: 'https://x-p-{port}.gw.trae.cn/' } };
    }
    return { data: { token: 'jwt-x' } };
  };
  const orig = global.fetch;
  global.fetch = async () => ({
    ok: false, status: 404,
    text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: "MCP server 'user::x' not found" } }),
  });
  try {
    await assert.rejects(() => execApi.run(ctx, 's1', { command: 'uname', autoInstall: false }), (e) => {
      assert.strictEqual(e.code, 'E_NOT_PRIMED');
      return true;
    });
  } finally { global.fetch = orig; }
});

// ---------------------------------------------------------------- 收尾
(async () => {
  for (const { name, fn } of asyncQueue) {
    try { await fn(); pass++; console.log('  \u2713 ' + name); }
    catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + (e && e.message)); }
  }
  console.log(`\n${fail ? '\u2717' : '\u2713'} ${pass} 通过${fail ? '，' + fail + ' 失败' : ''}\n`);
  if (fail) { console.error('自测失败：上面的 ✗ 是硬问题，别跳过。\n'); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('自测自身出错：' + (e && e.stack ? e.stack : e)); process.exit(1); });
