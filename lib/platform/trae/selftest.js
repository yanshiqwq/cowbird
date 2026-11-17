#!/usr/bin/env node
// trae 驱动的离线自测：不联网、不碰真登录态。
//   node lib/platform/trae/selftest.js
'use strict';
const assert = require('assert');

const { CAP, EVENT } = require('../contract');
const auth = require('./auth');
const map = require('./map');
const transport = require('./http');
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

okA('instances.create：返回 id，名字用我们给的那个（平台不回显 title）', async () => {
  const { ctx, t } = fakeCtx();
  let body = null;
  t.request = async (method, path, opts = {}) => { body = opts.body; return { data: { chat_session_id: 'new1', status: 1 } }; };
  const inst = await provider.instances.create(ctx, { name: 'cowbird-probe' });
  assert.strictEqual(inst.id, 'new1');
  assert.strictEqual(inst.name, 'cowbird-probe');
  assert.strictEqual(body.mode, 'code');
  assert.strictEqual(body.title, 'cowbird-probe');
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

okA('agent.send：上游 991102 时说明"网页端走 protobuf WS"，而不是让人对着 invalid parameter 猜', async () => {
  const { ctx, t } = fakeCtx();
  t.request = async () => { const e = new Error('invalid parameter'); e.code = 991102; throw e; };
  await assert.rejects(() => provider.agent.send(ctx, 's1', { text: 'hi' }), (e) => e.code === 'E_UNSUPPORTED' && /protobuf/.test(e.message));
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

ok('能力声明：有 AGENT 没有 EXEC（这是诚实的能力位，不是漏了）', () => {
  assert.ok(provider.has(CAP.AGENT));
  assert.ok(!provider.has(CAP.EXEC), '网页版没有直连执行通道，不能声明 exec');
  assert.ok(!provider.has(CAP.EXEC_BG));
  assert.ok(!provider.has(CAP.AUTH_RENEW), 'cookie 型平台没有 refresh_token');
});

ok('sendBody：形状里必须有 userMessage（未打通但结构要稳定）', () => {
  const b = map.buildSendBody('你好');
  assert.ok(b.userMessage && b.userMessage.content, 'body 必须带 userMessage.content');
  assert.strictEqual(JSON.parse(b.userMessage.content)[0].text_content, '你好');
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
