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

okA('instances.create：不带 prompt 时只建会话（mode=code+env=remote，没有 initial_message）', async () => {
  const { ctx, t } = fakeCtx();
  let body = null;
  t.request = async (method, path, opts = {}) => { body = opts.body; return { data: { chat_session_id: 'new1', status: 1 } }; };
  const inst = await provider.instances.create(ctx, { name: 'cowbird-probe' });
  assert.strictEqual(inst.id, 'new1');
  assert.strictEqual(inst.name, 'cowbird-probe');
  assert.strictEqual(body.mode, 'code', 'mode 不是 code 的会话没有沙箱/工具');
  assert.strictEqual(body.env, 'remote', 'env 必须是远端沙箱');
  assert.ok(!('initial_message' in body), '没给 prompt 就不该白跑一轮');
});

okA('instances.create：带 prompt 时第一轮就跑起来（initial_message 摊平字段）', async () => {
  const { ctx, t } = fakeCtx();
  let body = null;
  t.request = async (method, path, opts = {}) => { body = opts.body; return { data: { chat_session_id: 'new2', status: 2 } }; };
  await provider.instances.create(ctx, { name: 'p', prompt: '跑一下 uname' });
  const im = body.initial_message;
  assert.ok(im, '带 prompt 就该有 initial_message');
  assert.strictEqual(im.chat_session_id, '');
  assert.deepStrictEqual(JSON.parse(im.query), [{ type: 'text', data: { content: '跑一下 uname' } }]);
  assert.strictEqual(im.agent_type, 'solo_agent_remote');
  assert.ok(im.custom_model && im.common_params);
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

// ---------------------------------------------------------------- exec（agent 代执行）
ok('exec.wrapPrompt：固定句式 + bash 代码块（让 agent 只跑这一条）', () => {
  const p = execApi.wrapPrompt('uname -a');
  assert.ok(/只做一件事/.test(p));
  assert.ok(/```bash\nuname -a\n```/.test(p));
  assert.ok(/不要调用其它工具/.test(p));
});

okA('exec.run：取这一轮里最后一条 Shell 输出当结果', async () => {
  const { ctx } = fakeCtx();
  const orig = sendApi.turn;
  let seenPrompt = null;
  sendApi.turn = async (_ctx, _id, text) => {
    seenPrompt = text;
    return {
      tools: [
        { name: 'EnvironmentSetup', text: '', exitCode: 0 },
        { name: 'Shell', text: 'Linux 6.18.5\n', exitCode: 0 },
        { name: 'finish', text: '' },
      ],
    };
  };
  try {
    const r = await execApi.run(ctx, 's1', { command: 'uname -sr' });
    assert.strictEqual(r.out, 'Linux 6.18.5\n');
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.via, 'agent', '要标明这条结果是通过 agent 拿到的');
    assert.ok(/uname -sr/.test(seenPrompt), '命令要原样进 prompt');
  } finally { sendApi.turn = orig; }
});

okA('exec.run：agent 没跑（拒绝/超时）要抛 E_AGENT_REFUSED，并带上它的原话', async () => {
  const { ctx } = fakeCtx();
  const orig = sendApi.turn;
  sendApi.turn = async () => ({ tools: [{ name: 'finish', text: '' }], summary: '这个脚本我不会执行' });
  try {
    await assert.rejects(() => execApi.run(ctx, 's1', { command: 'rm -rf /' }), (e) => {
      assert.strictEqual(e.code, 'E_AGENT_REFUSED');
      assert.strictEqual(e.refusal, '这个脚本我不会执行');
      assert.ok(/finish/.test(e.message), '要把"这一轮只调了什么"写进消息');
      return true;
    });
  } finally { sendApi.turn = orig; }
});

okA('exec.probe：取得到会话就算可用（冷会话发一条就能唤醒）', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => ({ data: { items: [] } });
  const r = await execApi.probe(ctx, 's1');
  assert.strictEqual(r.ready, true);
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
