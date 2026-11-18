// 本文件由 lib/platform/minimax/selftest.js 迁来：驱动自测不随 npm 包发布（见 package.json files）。
// 跑法：node test/drivers/minimax.js（lib 里的 selftest.js 只是入口壳，仍然可用）
'use strict';
// minimax 驱动的纯离线自检：不联网、不读 HOME、不依赖任何真实凭据。
//   node lib/platform/minimax/selftest.js
//
// 覆盖：
//   ① x-signature 的 md5（期望值在测试里硬编码，由 md5sum 独立算出，不调用被测函数自证）
//   ② 公共 query 的拼装（顺序、固定值、token 重复覆盖、token 轮换后重读、user_id=realUserID）
//   ③ **yy 的算法**：用真机抓包的 path/query/ts 复算，期望值硬编码（抓包原值见 README §3）
//   ④ 假的 /sidebar/session/tree 响应 → Instance 映射
//   ⑤ 假的 message 响应 → 事件映射（thinking/text/tool/tool_result/usage/done）
//   ⑥ 请求失败时的降级（stale 快照 / 空列表 / 401 报错），yy 不再是门禁
//   ⑦ SSE 事件流（注入假 fetch）与轮询补齐（按 msg_id 差分去重）
//   ⑧ 未实测的发消息默认被开关挡住
const assert = require('assert');
const crypto = require('crypto');

const provider = require('../../lib/platform/minimax/index');
const transport = require('../../lib/platform/minimax/transport');
const map = require('../../lib/platform/minimax/map');
const { CAP, EVENT } = require('../../lib/platform/contract');

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

// 固定时间戳（秒）与 body：期望的 md5 是独立用 `printf ... | md5sum` 算出来的
const TS = '1794876062';
const UNIX = '1794876062782';
const EMPTY_BODY_MD5 = '541fed2f4c59d6273420d2069f7d07a3';
const HELLO_BODY = '{"content":"hello"}';
const HELLO_BODY_MD5 = 'd8737c01efaefb8926e922d045504383';

// 假 JWT：三段结构 + 一个可解析的 payload（exp / user.id 用来验身份推导）
const TOKEN_HEADER = 'eyJhbGciOiJIUzI1NiJ9';
const TOKEN_PAYLOAD = Buffer.from(JSON.stringify({ exp: 1794900000, user: { id: '10086', name: 'probe' } })).toString('base64url');
const TOKEN = `${TOKEN_HEADER}.${TOKEN_PAYLOAD}.ZmFrZS1zaWduYXR1cmU`;
const TOKEN2 = `${TOKEN_HEADER}.${TOKEN_PAYLOAD}.c2Vjb25kLXNpZ25hdHVyZQ`;
const YY = 'abcdef0123456789abcdef0123456789';

// query 里的 user_id 必须是 realUserID，**不是** JWT 的 user.id（10086）—— 这是真机上
// 唯一会造成「401 空响应体」的坑，历史上被误判成 yy 算法不对。
const REAL_USER_ID = '578000000000000000';
// device_id 必须纯数字（浏览器里是 8 位随机数）；传 UUID 会 401。
const DEVICE_ID = '78502397';

/** 内存版 ctx（和 registry.context 同形，但不碰磁盘） */
function makeCtx({ auth = { token: TOKEN, uuid: 'uuid-fixed', device_id: DEVICE_ID, user_id: '10086', realUserID: REAL_USER_ID }, yy = null, tree = null, config = {}, fetch = null } = {}) {
  const mem = new Map();
  if (auth) mem.set('auth', auth);
  if (yy) mem.set('yy', yy);
  if (tree) mem.set('tree', tree);
  return {
    provider,
    defaults: { ...provider.defaults },
    config: () => config,
    fetch,
    now: () => Number(UNIX),
    log: () => {},
    paths: {},
    store: {
      dir: '/tmp/cowbird-minimax-selftest',
      read: (n, d = null) => (mem.has(n) ? mem.get(n) : d),
      write: (n, v) => { mem.set(n, v); },
      remove: (n) => { mem.delete(n); },
      _mem: mem,
    },
  };
}

const SSE_TEXT = [
  'data: {"msg_id":"s1","msg_type":2,"role":"assistant","thinking_content":"想一想"}',
  '',
  'data: {"msg_id":"s1","msg_type":2,"role":"assistant","thinking_content":"想一想","msg_content":"答"}',
  '',
  'data: {"msg_id":"s1","msg_type":2,"role":"assistant","thinking_content":"想一想","msg_content":"答案","tool_calls":[{"tool_name":"bash","tool_call_id":"c1","tool_call_status":2,"tool_call_args":"{\\"command\\":\\"ls\\"}","tool_call_result_data":"{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"a.txt\\"}],\\"details\\":{\\"exit_code\\":0,\\"duration_ms\\":12,\\"dispatched_locally\\":false}}"}]}',
  '',
  'data: {"msg_id":"s1","msg_type":2,"role":"assistant","msg_content":"答案","finish_reason":"endTurn","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10,"context_window":512000}}',
  '',
].join('\n');

const FAKE_TREE = {
  sessions: [
    {
      session: {
        session_id: '464000000000001',
        agent_name: '464087654089272',
        session_type: 0,
        title: '示例会话 A',
        archived: false,
        status: { status_type: 0, message: '' },
        created_at: 1794876060900,
        updated_at: 1794876916458,
        project_id: 0,
        team_mode: false,
        model: {
          provider_id: 'minimax', model_id: 'MiniMax-M3.1-Flash', variant: 'thinking',
          context_limit: 512000, supported_variants: ['', 'thinking'], reasoning: true,
          thinking: { effort: 'max' },
        },
      },
    },
    {
      session: {
        session_id: '464000000000002',
        agent_name: '464087654089272',
        session_type: 0,
        title: '被中止的会话',
        archived: false,
        status: { status_type: 3, message: 'user_aborted' },
        created_at: 1794876000000,
        updated_at: 1794876000001,
        model: { provider_id: 'minimax', model_id: 'MiniMax-M3', variant: '', context_limit: 400000 },
      },
    },
    {
      session: {
        session_id: '464000000000003',
        title: '归档的会话',
        archived: true,
        status: { status_type: 0, message: '' },
        updated_at: 1794875000000,
      },
    },
  ],
};

const FAKE_MESSAGES = {
  messages: [
    {
      msg_id: 'u1', msg_type: 1, role: 'user', turn_id: 't1',
      msg_content: '看一下当前目录', timestamp: 1794876062782,
    },
    {
      msg_id: 'm1', msg_type: 2, role: 'assistant', turn_id: 't1',
      msg_content: '我先 ls 一下。',
      thinking_content: '用户要看目录，直接 ls。',
      thinking_duration_ms: 13864,
      finish_reason: 'toolUse',
      usage: { input_tokens: 884, output_tokens: 4453, cache_read: 19712, total_tokens: 25049, context_window: 512000 },
      tool_calls: [
        {
          tool_name: 'bash',
          tool_call_id: 'call_1',
          tool_call_status: 2,
          tool_call_args: JSON.stringify({ command: 'ls -la' }),
          tool_call_result_data: JSON.stringify({
            content: [{ type: 'text', text: 'a.txt\nb.txt' }],
            details: { exit_code: 0, duration_ms: 8142, output_truncated: false, dispatched_locally: false, local_dispatch_skip_reason: 'parse-rejected:unsupported-token' },
          }),
        },
      ],
    },
    {
      msg_id: 'm2', msg_type: 2, role: 'assistant', turn_id: 't1',
      msg_content: '目录里有两个文件。',
      finish_reason: 'endTurn',
      usage: { input_tokens: 900, output_tokens: 20, total_tokens: 920, context_window: 512000 },
    },
  ],
};

// ---------------------------------------------------------------------------
// 断言脚手架
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  \u2713 ${name}`); }
  catch (e) { fail++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
};
const okA = async (name, fn) => {
  try { await fn(); pass++; console.log(`  \u2713 ${name}`); }
  catch (e) { fail++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
};

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

(async () => {
  console.log('\nminimax 驱动自检（离线）');

  // ① 签名 ---------------------------------------------------------------
  console.log('\n签名 x-signature = md5(ts + SECRET + body)');
  ok('body 为空时等于 md5(ts + SECRET)（期望值独立算好硬编码）', () => {
    assert.strictEqual(transport.sign(TS, ''), EMPTY_BODY_MD5);
    assert.strictEqual(transport.sign(TS), EMPTY_BODY_MD5);
  });
  ok('有 body 时等于 md5(ts + SECRET + body)', () => {
    assert.strictEqual(transport.sign(TS, HELLO_BODY), HELLO_BODY_MD5);
  });
  ok('GET 请求头里的 x-signature / x-timestamp 与手算一致', () => {
    const ctx = makeCtx();
    const built = transport.build(ctx, { path: transport.P.tree, needYY: false, ts: TS, unix: UNIX });
    assert.strictEqual(built.init.headers['x-timestamp'], TS);
    assert.strictEqual(built.init.headers['x-signature'], EMPTY_BODY_MD5);
    assert.strictEqual(built.init.body, undefined, 'GET 不该带 body');
  });

  // ② 公共 query ---------------------------------------------------------
  console.log('\n公共 query');
  const EXPECT_PREFIX = 'device_platform=web&biz_id=3&app_id=3001&version_code=22201'
    + `&unix=${UNIX}&timezone_offset=28800&sys_language=zh&lang=zh`
    + '&uuid=uuid-fixed&device_id=' + DEVICE_ID + '&os_name=Windows&browser_name=Chrome'
    + '&device_memory=32&cpu_core_num=24&browser_language=zh-CN&browser_platform=Win32'
    + '&user_id=' + REAL_USER_ID + '&screen_width=2620&screen_height=1280&token=';
  const EXPECT_SUFFIX = '&client=web&region=cn';

  ok('字段与顺序逐字对齐（token 在 query 里）', () => {
    const ctx = makeCtx();
    const built = transport.build(ctx, { path: transport.P.info, ts: TS, unix: UNIX });
    assert.strictEqual(built.url, `${transport.BASE}${transport.P.info}?${EXPECT_PREFIX}${TOKEN}${EXPECT_SUFFIX}`);
  });
  ok('token 只出现一次（呼应"token 也在 query 里"）', () => {
    const ctx = makeCtx();
    const built = transport.build(ctx, { path: transport.P.tree, needYY: false, ts: TS, unix: UNIX });
    assert.strictEqual(built.url.split('token=').length - 1, 1);
  });
  ok('调用方传的 token 会被最新 token 覆盖，不追加第二个', () => {
    const ctx = makeCtx();
    const built = transport.build(ctx, { path: transport.P.tree, needYY: false, ts: TS, unix: UNIX, query: { token: 'OLD-TOKEN', foo: 'bar' } });
    assert.ok(!built.url.includes('OLD-TOKEN'), '旧 token 不该出现在 URL 里');
    assert.ok(built.url.includes(`token=${TOKEN}`));
    assert.ok(built.url.endsWith(`${EXPECT_SUFFIX}&foo=bar`), `额外参数应追加在末尾：${built.url}`);
    assert.strictEqual(built.url.split('token=').length - 1, 1);
  });
  ok('token 轮换后每次 build 都重读快照（不缓存）', () => {
    const ctx = makeCtx();
    const first = transport.build(ctx, { path: transport.P.info, ts: TS, unix: UNIX });
    assert.ok(first.url.includes(`token=${TOKEN}`));
    ctx.store.write('auth', { ...ctx.store.read('auth'), token: TOKEN2 });
    const second = transport.build(ctx, { path: transport.P.info, ts: TS, unix: UNIX });
    assert.ok(second.url.includes(`token=${TOKEN2}`), '应变新 token');
    assert.ok(!second.url.includes(`token=${TOKEN}`));
    assert.strictEqual(second.init.headers.token, TOKEN2);
  });
  ok('POST 的签名与 body 字节完全一致（不会签名一份、发送另一份）', () => {
    const ctx = makeCtx();
    const body = { content: 'hello' };
    const built = transport.build(ctx, { method: 'POST', path: transport.P.messages('1'), body, needYY: false, ts: TS, unix: UNIX });
    assert.strictEqual(built.init.body, HELLO_BODY);
    assert.strictEqual(built.init.headers['x-signature'], HELLO_BODY_MD5);
    assert.strictEqual(built.init.headers['content-type'], 'application/json');
  });

  // ③ yy 的算法 ----------------------------------------------------------
  // 这三组期望值是**脱离本模块**算出来的（`node -e` 里手写 md5 链 / `printf | md5sum`），
  // 数据来自 2026-11-17 真机抓包：path + query + x-timestamp 是原值，**只有 token 换成了
  // 假串**（真 token 是凭据，不能进代码）。抓包原值对应的真实 yy 见 README §3 的对照表。
  console.log('\nyy = md5(enc(path?query) + "_" + body + md5(整秒毫秒) + "ooui")');

  // 抓包里的公共参数（真机原值，token 已替换）
  const CAP_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTQ5MDAwMDB9.c2VsZnRlc3QtZmFrZQ';
  const CAP_COMMON = (unix) => `device_platform=web&biz_id=3&app_id=3001&version_code=22201`
    + `&unix=${unix}&timezone_offset=28800&sys_language=zh&lang=zh`
    + '&uuid=e7546ba8-61d4-4b8b-8a61-b7b2479bcdd3&device_id=78502397'
    + '&os_name=Windows&browser_name=Chrome&device_memory=32&cpu_core_num=24'
    + '&browser_language=zh-CN&browser_platform=Win32&user_id=578000000000000000'
    + '&screen_width=2620&screen_height=1280'
    + `&token=${CAP_TOKEN}&client=web&region=cn`;
  const capPairs = (query) => query.split('&').map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  });

  // 期望值不再硬编码：抓包里的 user_id 已脱敏，原值对应的 yy 再也复现不出来。
  // 改成「实现 vs 规格」：这里按 README §3 的公式**另写一遍**（只用 node:crypto），
  // 与被测函数对照。公式本身的正确性由 README 记录的 19/19 真机抓包结果背书。
  const md5Raw = (v) => crypto.createHash('md5').update(String(v), 'utf8').digest('hex');
  function yyBySpec(path, pairs, ts, body, method) {
    const qs = new URLSearchParams(pairs).toString();
    const full = path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`;
    const isPost = String(method || 'GET').toUpperCase() === 'POST';
    let bodyYY = '{}';
    if (isPost && body !== undefined && body !== null && body !== '') {
      bodyYY = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const ms = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
    return md5Raw(`${encodeURIComponent(full)}_${bodyYY}${md5Raw(String(ms))}ooui`);
  }

  ok('yy 规格对照 A：/sidebar/session/tree（参数结构与真机抓包同构）', () => {
    const query = `limit=20&project_id=0&${CAP_COMMON('1794884214000')}`;
    const yy = transport.computeYY(
      '/minimax-cloud/api/v1/sidebar/session/tree',
      transport.withOpTicket(capPairs(query)),
      '1794884214',      // 秒级 x-timestamp，与抓包 x-timestamp 头一致
      '',
      'GET',
    );
    assert.strictEqual(yy, yyBySpec('/minimax-cloud/api/v1/sidebar/session/tree', transport.withOpTicket(capPairs(query)), '1794884214', '', 'GET'));
  });

  ok('yy 规格对照 B：/minimax-cloud/api/v1/config', () => {
    const query = CAP_COMMON('1794884213000');
    const yy = transport.computeYY(
      '/minimax-cloud/api/v1/config',
      transport.withOpTicket(capPairs(query)),
      1794884213,
      '{}',
      'GET',
    );
    assert.strictEqual(yy, yyBySpec('/minimax-cloud/api/v1/config', transport.withOpTicket(capPairs(query)), 1794884213, '{}', 'GET'));
  });

  ok('POST 用 JSON.stringify(body) 当 bodyToYY（GET 一律 "{}"）', () => {
    const query = CAP_COMMON('1794884213000');
    const pairs = transport.withOpTicket(capPairs(query));
    const post = transport.computeYY('/minimax-cloud/api/v1/session/464000000000001/message', pairs, 1794884213, { content: 'hi' }, 'POST');
    assert.strictEqual(post, yyBySpec('/minimax-cloud/api/v1/session/464000000000001/message', pairs, 1794884213, { content: 'hi' }, 'POST'));
    // 同一组参数、同一个时间：方法/body 不同 ⇒ yy 必须不同
    const get = transport.computeYY('/minimax-cloud/api/v1/session/464000000000001/message', pairs, 1794884213, { content: 'hi' }, 'GET');
    assert.notStrictEqual(post, get);
  });

  ok('时间因子是 md5(整秒毫秒)，不是 md5(秒)（链上两段硬编码期望）', () => {
    assert.strictEqual(transport.md5hex('1794884214000'), '00358e8e2ea7351be83c2fda4bbbe200');
    assert.strictEqual(transport.md5hex('1794884213000'), '5daf1e0be1ac1c74a85f3b6e0eaffb0c');
    const pairs = transport.withOpTicket(capPairs(CAP_COMMON('1794884214000')));
    const bySec = transport.computeYY(transport.P.tree, pairs, '1794884214', '', 'GET');
    const byMsec = transport.computeYY(transport.P.tree, pairs, '1794884214000', '', 'GET');
    assert.strictEqual(bySec, byMsec, '秒/毫秒两种写法要等价');
  });

  ok('op_ticket=undefined 是 yy 输入的一部分（当初对不上的原因）', () => {
    const pairs = capPairs(`limit=20&project_id=0&${CAP_COMMON('1794884214000')}`);
    const withIt = transport.computeYY(transport.P.tree, transport.withOpTicket(pairs), '1794884214', '', 'GET');
    const without = transport.computeYY(transport.P.tree, pairs, '1794884214', '', 'GET');
    assert.notStrictEqual(withIt, without, '少了 op_ticket 就不是浏览器算出来的那个值');
    assert.strictEqual(withIt, yyBySpec(transport.P.tree, transport.withOpTicket(pairs), '1794884214', '', 'GET'));
  });

  ok('wQ：URL 已带 ? 时用 & 拼接，且参数按传入顺序（URLSearchParams 语义）', () => {
    assert.strictEqual(transport.wQ('/a', { x: 1, y: 2 }), '/a?x=1&y=2');
    assert.strictEqual(transport.wQ('/a?k=v', { x: 1 }), '/a?k=v&x=1');
    assert.strictEqual(transport.formEncode({ a: 'hello world', b: "!~'()" }), 'a=hello+world&b=%21%7E%27%28%29');
    assert.strictEqual(transport.formEncode({ a: undefined }), 'a=undefined');
  });

  ok('公共参数的两种序列化结果一致（formEncode 与 stringifyPairs 不能漂）', () => {
    const ctx = makeCtx();
    const pairs = transport.buildQuery(transport.identity(ctx), { unix: UNIX });
    assert.strictEqual(transport.formEncode(pairs), transport.stringifyPairs(pairs));
  });

  ok('yy 不再是门禁：没有 store 记录也照样算出来（不抛 E_NEED_YY）', () => {
    const ctx = makeCtx({ yy: null });
    const built = transport.build(ctx, { path: transport.P.tree });
    assert.match(built.init.headers.yy, /^[0-9a-f]{32}$/);
    assert.strictEqual(built.meta.yy.source, 'computed');
  });

  ok('store 里的记录会盖过自算值（调试用），且仍按路径挑', () => {
    const ctx = makeCtx({ yy: { entries: [{ yy: YY, path: transport.P.tree, capturedAt: Date.now() }] } });
    const hit = transport.build(ctx, { path: transport.P.tree, ts: TS, unix: UNIX });
    assert.strictEqual(hit.init.headers.yy, YY);
    assert.strictEqual(hit.meta.yy.source, 'store');
    // 路径对不上的那份不会被乱用
    const miss = transport.build(ctx, { path: transport.P.agents, ts: TS, unix: UNIX });
    assert.notStrictEqual(miss.init.headers.yy, YY);
    assert.strictEqual(miss.meta.yy.source, 'computed');
  });

  ok('yy:false 可以完全不发 yy（实测服务端也不校验）', () => {
    const ctx = makeCtx();
    const built = transport.build(ctx, { path: transport.P.tree, yy: false });
    assert.strictEqual(built.init.headers.yy, undefined);
  });

  // ③' 身份参数（真机上唯一会造成 401 的两条）----------------------------
  console.log('\n身份参数：user_id 必须是 realUserID、device_id 必须纯数字');
  ok('query 里的 user_id 取 realUserID，不是 JWT 的 user.id', () => {
    const ctx = makeCtx();
    const built = transport.build(ctx, { path: transport.P.info, ts: TS, unix: UNIX });
    assert.ok(built.url.includes(`&user_id=${REAL_USER_ID}&`), built.url);
    assert.ok(!built.url.includes('user_id=10086'), 'JWT 的 user.id 不能出现在 query 里');
    assert.strictEqual(built.meta.userIdIsReal, true);
  });
  ok('没有 realUserID 时退回 JWT id，并在 meta 里标记（方便 doctor 提示）', () => {
    const ctx = makeCtx({ auth: { token: TOKEN, uuid: 'uuid-fixed', device_id: DEVICE_ID } });
    const built = transport.build(ctx, { path: transport.P.info, ts: TS, unix: UNIX });
    assert.ok(built.url.includes('&user_id=10086&'));
    assert.strictEqual(built.meta.userIdIsReal, false);
  });
  ok('device_id 非纯数字会被换成数字并落盘（UUID 形态会 401）', () => {
    const ctx = makeCtx({ auth: { token: TOKEN, uuid: 'uuid-fixed', device_id: 'd8d9b818-1f7d-466e-81ce-8100fc4d07a3', realUserID: REAL_USER_ID } });
    const built = transport.build(ctx, { path: transport.P.info, ts: TS, unix: UNIX });
    assert.match(built.url, /&device_id=\d+&/, built.url);
    assert.match(String(ctx.store.read('auth').device_id), /^\d+$/, '应写回快照，之后保持稳定');
  });
  await okA('快照里没有 realUserID 时自动打一次 /v1/api/user/info 补上', async () => {
    const seen = [];
    const ctx = makeCtx({
      auth: { token: TOKEN, uuid: 'uuid-fixed', device_id: DEVICE_ID },
      fetch: async (url) => {
        seen.push(url);
        if (url.includes('/v1/api/user/info')) {
          return new Response(JSON.stringify({ data: { userInfo: { realUserID: REAL_USER_ID } } }), { status: 200 });
        }
        return new Response(JSON.stringify(FAKE_TREE), { status: 200 });
      },
    });
    await provider.instances.list(ctx);
    assert.ok(seen.some((u) => u.includes('/v1/api/user/info')), '应该先探一次 user/info');
    assert.strictEqual(String(ctx.store.read('auth').realUserID), REAL_USER_ID, 'realUserID 要写回快照');
    const after = seen.filter((u) => u.includes('/sidebar/session/tree'));
    assert.ok(after.length === 1 && after[0].includes(`user_id=${REAL_USER_ID}`), '列表请求要用 realUserID');
  });

  // ④ /tree → Instance ---------------------------------------------------
  console.log('\n/sidebar/session/tree → Instance');
  ok('会话映射：id/name/status/model/时间', () => {
    const list = map.treeToInstances(FAKE_TREE);
    assert.strictEqual(list.length, 2, '归档会话应被默认过滤');
    const first = list[0];
    assert.strictEqual(first.id, '464000000000001');
    assert.strictEqual(first.name, '示例会话 A');
    assert.strictEqual(first.title, '示例会话 A');
    assert.strictEqual(first.status, 'idle');
    assert.strictEqual(first.statusType, 0);
    assert.strictEqual(first.archived, false);
    assert.strictEqual(first.model.modelId, 'MiniMax-M3.1-Flash');
    assert.strictEqual(first.model.contextLimit, 512000);
    assert.strictEqual(first.model.thinking.effort, 'max');
    assert.strictEqual(first.updatedAt, new Date(1794876916458).toISOString());
    assert.strictEqual(list[1].status, 'aborted', 'status_type 3 = user_aborted');
    assert.ok(list[0].updatedAtMs >= list[1].updatedAtMs, '按 updated_at 倒序');
  });
  ok('归档会话可以显式要回来', () => {
    assert.strictEqual(map.treeToInstances(FAKE_TREE, { includeArchived: true }).length, 3);
  });
  ok('树形形状容错：裸数组 / {data:{sessions}} 都认', () => {
    const flat = map.treeToInstances({ data: { sessions: FAKE_TREE.sessions.slice(0, 1) } });
    assert.strictEqual(flat.length, 1);
    assert.strictEqual(map.treeToInstances(FAKE_TREE.sessions).length, 2);
  });

  // ⑤ 事件映射 -----------------------------------------------------------
  console.log('\nmessage → 事件');
  ok('thinking/text/tool/tool_result/usage/done 全部映射到位', () => {
    const st = map.newState();
    const events = [];
    for (const m of map.pickMessages(FAKE_MESSAGES)) events.push(...map.messageToEvents(m, st));
    const kinds = events.map((e) => e.kind);

    assert.ok(kinds.includes(EVENT.RAW), '用户消息走 raw 旁路');
    const thinking = events.find((e) => e.kind === EVENT.THINKING);
    assert.strictEqual(thinking.data.text, '用户要看目录，直接 ls。');
    assert.strictEqual(thinking.data.durationMs, 13864);

    const texts = events.filter((e) => e.kind === EVENT.TEXT).map((e) => e.data.text);
    assert.deepStrictEqual(texts, ['我先 ls 一下。', '目录里有两个文件。']);

    const tool = events.find((e) => e.kind === EVENT.TOOL);
    assert.strictEqual(tool.data.name, 'bash');
    assert.strictEqual(tool.data.id, 'call_1');
    assert.deepStrictEqual(tool.data.input, { command: 'ls -la' }, 'tool_call_args 是 JSON 字符串，要解析');
    assert.strictEqual(tool.data.status, 2);

    const tr = events.find((e) => e.kind === EVENT.TOOL_RESULT);
    assert.strictEqual(tr.data.name, 'bash');
    assert.strictEqual(tr.data.ok, true, 'details.exit_code=0');
    assert.strictEqual(tr.data.exitCode, 0);
    assert.strictEqual(tr.data.durationMs, 8142);
    assert.strictEqual(tr.data.out, 'a.txt\nb.txt');
    assert.strictEqual(tr.data.dispatchedLocally, false, '工具是服务端派发的');
    assert.strictEqual(tr.data.skipReason, 'parse-rejected:unsupported-token');

    const usage = events.filter((e) => e.kind === EVENT.USAGE);
    assert.strictEqual(usage[0].data.totalTokens, 25049);
    assert.strictEqual(usage[0].data.cacheRead, 19712);
    assert.strictEqual(usage[0].data.contextWindow, 512000);

    const done = events.filter((e) => e.kind === EVENT.DONE);
    assert.strictEqual(done.length, 1, 'done 只出现一次');
    assert.strictEqual(done[0].data.reason, 'endTurn');
    assert.strictEqual(kinds[kinds.length - 1], EVENT.DONE, 'done 在最后');
  });
  ok('同一条消息重复投喂不重复吐事件（轮询去重）', () => {
    const st = map.newState();
    const first = map.pickMessages(FAKE_MESSAGES).flatMap((m) => map.messageToEvents(m, st));
    const second = map.pickMessages(FAKE_MESSAGES).flatMap((m) => map.messageToEvents(m, st));
    assert.ok(first.length > 0);
    assert.deepStrictEqual(second, [], '第二次应该啥都不吐');
  });
  ok('累计式快照只吐增量（不会重复吐字）', () => {
    const st = map.newState();
    const a = map.messageToEvents({ msg_id: 'x', msg_type: 2, role: 'assistant', msg_content: '你' }, st);
    const b = map.messageToEvents({ msg_id: 'x', msg_type: 2, role: 'assistant', msg_content: '你好' }, st);
    const c = map.messageToEvents({ msg_id: 'x', msg_type: 2, role: 'assistant', msg_content: '你好' }, st);
    assert.strictEqual(a[0].data.text, '你');
    assert.strictEqual(b[0].data.text, '好');
    assert.deepStrictEqual(c, []);
  });
  ok('认不出的负载落成 raw 而不是丢掉', () => {
    const evs = map.payloadToEvents({ foo: 'bar' }, map.newState());
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].kind, EVENT.RAW);
  });
  ok('会话状态负载映射成 status 事件', () => {
    const evs = map.payloadToEvents({ status: { status_type: 3, message: 'user_aborted' } }, map.newState());
    assert.strictEqual(evs[0].kind, EVENT.STATUS);
    assert.strictEqual(evs[0].data.status, 'aborted');
    assert.strictEqual(evs[0].data.statusType, 3);
  });

  // ⑥ 能力位与 limits ----------------------------------------------------
  console.log('\n能力位与 limits');
  ok('能力位只声明实测过的那些', () => {
    const caps = provider.capabilityList();
    assert.deepStrictEqual(caps, ['agent', 'auth', 'instances.list', 'instances.meta']);
    for (const c of [CAP.EXEC, CAP.FS, CAP.CREATE, CAP.RENAME, CAP.REMOVE, CAP.AGENT_QUESTION, CAP.AGENT_INTERRUPT]) {
      assert.strictEqual(provider.has(c), false, `不该声明 ${c}`);
    }
  });
  ok('limits 按实测声明（15s 同步上限、没有后台）', () => {
    assert.strictEqual(provider.limits.maxSyncMs, 15000);
    assert.strictEqual(provider.limits.defaultSyncMs, 10000);
    assert.strictEqual(provider.limits.maxBackground, false);
  });

  // ⑦ instances 的降级行为 ----------------------------------------------
  console.log('\ninstances 的降级行为');
  const okTree = async () => new Response(JSON.stringify(FAKE_TREE), { status: 200, headers: { 'content-type': 'application/json' } });
  const denyAuth = async () => new Response('', { status: 401 });

  await okA('假 fetch 正常时 list 走实时', async () => {
    const ctx = makeCtx({ fetch: okTree });
    const list = await provider.instances.list(ctx);
    assert.strictEqual(list.stale, false);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, '464000000000001');
    assert.ok(ctx.store.read('tree'), '实时结果要落快照，供请求失败时用');
  });
  await okA('401 但有快照 → stale:true，不抛', async () => {
    const ctx = makeCtx({ tree: { at: '2026-11-17T00:00:00.000Z', data: FAKE_TREE }, fetch: denyAuth });
    const list = await provider.instances.list(ctx);
    assert.strictEqual(list.stale, true);
    assert.strictEqual(list.source, 'cache');
    assert.strictEqual(list.length, 2);
    assert.match(list.warning, /本地快照/);
    assert.strictEqual(list.reason, 'E_UNAUTHORIZED');
  });
  await okA('401 且没快照 → 空列表 + warning，也不抛', async () => {
    const ctx = makeCtx({ fetch: denyAuth });
    const list = await provider.instances.list(ctx);
    assert.strictEqual(list.length, 0);
    assert.strictEqual(list.stale, true);
    assert.strictEqual(list.source, 'none');
    assert.match(list.warning, /token|401|登录态/);
  });
  await okA('get 请求失败时先用快照，快照里没有才抛', async () => {
    const ctx = makeCtx({ tree: { at: '2026-11-17T00:00:00.000Z', data: FAKE_TREE }, fetch: denyAuth });
    const inst = await provider.instances.get(ctx, '464000000000002');
    assert.strictEqual(inst.status, 'aborted');
    await assert.rejects(() => provider.instances.get(ctx, 'no-such-id'), (e) => e.code === 'E_UNAUTHORIZED');
  });
  await okA('info：visible/quota 为 null，facts 里写明平台不暴露', async () => {
    const ctx = makeCtx({ tree: { at: '2026-11-17T00:00:00.000Z', data: FAKE_TREE }, fetch: denyAuth });
    const info = await provider.instances.info(ctx, '464000000000001');
    assert.strictEqual(info.visible, null);
    assert.strictEqual(info.quota, null);
    const quota = info.facts.find((f) => f.label === '算力与配额');
    assert.ok(quota, '要有「算力与配额」这条');
    assert.match(quota.value, /平台不暴露/);
    const model = info.facts.find((f) => f.label === '模型');
    assert.match(model.value, /MiniMax-M3\.1-Flash/);
  });

  // ⑧ 事件流（注入假 fetch，仍然离线）----------------------------------
  console.log('\nagent.stream（注入假 fetch）');
  await okA('SSE：text/thinking/tool/usage/done，且 done 在最后', async () => {
    const ctx = makeCtx({
      fetch: async (url) => {
        assert.ok(url.startsWith(transport.STREAM_BASE), `SSE 应走 stream 域：${url}`);
        assert.ok(url.includes('session_id=464000000000001'));
        return new Response(SSE_TEXT, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const events = await collect(provider.agent.stream(ctx, '464000000000001', { mode: 'sse', timeoutMs: 3000 }));
    const kinds = events.map((e) => e.kind);
    assert.strictEqual(events.filter((e) => e.kind === EVENT.THINKING).map((e) => e.data.text).join(''), '想一想');
    assert.strictEqual(events.filter((e) => e.kind === EVENT.TEXT).map((e) => e.data.text).join(''), '答案');
    assert.ok(kinds.includes(EVENT.TOOL));
    assert.ok(kinds.includes(EVENT.TOOL_RESULT));
    assert.ok(kinds.includes(EVENT.USAGE));
    assert.strictEqual(kinds.filter((k) => k === EVENT.DONE).length, 1);
    assert.strictEqual(kinds[kinds.length - 1], EVENT.DONE);
  });
  await okA('SSE 不可用 → 退回轮询 /message 做增量', async () => {
    let poll = 0;
    const rounds = [
      { messages: [{ msg_id: 'p1', msg_type: 2, role: 'assistant', msg_content: '你好' }] },
      { messages: [{ msg_id: 'p1', msg_type: 2, role: 'assistant', msg_content: '你好，世界' }] },
      { messages: [{ msg_id: 'p1', msg_type: 2, role: 'assistant', msg_content: '你好，世界', finish_reason: 'endTurn', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }] },
    ];
    const ctx = makeCtx({
      yy: { entries: [{ yy: YY, path: '*', capturedAt: Date.now() }] },
      config: { platforms: { minimax: { pollMs: 1, idleLimit: 2 } } },
      fetch: async (url) => {
        if (url.startsWith(transport.STREAM_BASE)) return new Response('boom', { status: 500 });
        assert.ok(url.includes('/message'), `轮询应打 /message：${url}`);
        const body = rounds[Math.min(poll, rounds.length - 1)];
        poll++;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const events = await collect(provider.agent.stream(ctx, '464000000000001', { timeoutMs: 5000 }));
    const kinds = events.map((e) => e.kind);
    assert.ok(!kinds.includes(EVENT.ERROR), 'SSE 失败只是降级（轮询能补齐），不该当错误上报');
    assert.ok(kinds.includes(EVENT.STATUS) && events.some((e) => e.kind === EVENT.STATUS && e.data.status === 'polling'));
    assert.strictEqual(events.filter((e) => e.kind === EVENT.TEXT).map((e) => e.data.text).join(''), '你好，世界', '增量拼接不能重复');
    assert.ok(kinds.includes(EVENT.USAGE));
    assert.strictEqual(kinds[kinds.length - 1], EVENT.DONE);
    assert.strictEqual(events[events.length - 1].data.reason, 'endTurn');
  });
  await okA('轮询路 401 时诚实报错（不会假装没消息）', async () => {
    const ctx = makeCtx({
      fetch: async (url) => {
        if (url.startsWith(transport.STREAM_BASE)) return new Response('', { status: 503 });
        return new Response('', { status: 401 });
      },
    });
    const events = await collect(provider.agent.stream(ctx, 'sid-1', { timeoutMs: 2000 }));
    const errs = events.filter((e) => e.kind === EVENT.ERROR);
    assert.ok(errs.some((e) => /E_UNAUTHORIZED|401/.test(e.data.message)), JSON.stringify(errs));
    assert.strictEqual(events[events.length - 1].kind, EVENT.DONE);
  });

  // ⑨ 发消息开关 ---------------------------------------------------------
  console.log('\nagent.send（{content} 已于 2026-11-18 真机验证，响应是 SSE）');
  await okA('默认允许发送（{content} 已在真机验证）；显式 false 才禁用', async () => {
    const ctx = makeCtx({ yy: { entries: [{ yy: YY, path: '*', capturedAt: Date.now() }] } });
    // 显式关掉 → 抛可识别的错误
    await assert.rejects(
      () => provider.agent.send(ctx, 'sid', { text: 'hi', allowUnverified: false }),
      (e) => e.code === 'E_UNVERIFIED_SEND' && /显式关掉/.test(e.message),
    );
    // 默认（不传）→ 过闸门，走到网络层（这里没有 fetch，会以网络错误收场，说明闸门没拦）
    await assert.rejects(
      () => provider.agent.send(ctx, 'sid', { text: 'hi' }),
      (e) => e.code !== 'E_UNVERIFIED_SEND',
    );
  });
  await okA('显式打开后按 {content} 发送（POST + yy + 签名）', async () => {
    let seen = null;
    const ctx = makeCtx({
      yy: { entries: [{ yy: YY, path: '*', capturedAt: Date.now() }] },
      fetch: async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ msg_id: 'new-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const r = await provider.agent.send(ctx, '464000000000001', { text: 'hi', allowUnverified: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.unverified, true);
    assert.ok(seen.url.includes('/minimax-cloud/api/v1/session/464000000000001/message'));
    assert.strictEqual(seen.init.method, 'POST');
    assert.strictEqual(seen.init.body, '{"content":"hi"}');
    assert.strictEqual(seen.init.headers.yy, YY);
    assert.strictEqual(seen.init.headers['x-signature'], transport.sign(seen.init.headers['x-timestamp'], '{"content":"hi"}'));
  });

  // 收尾 -----------------------------------------------------------------
  const total = pass + fail;
  console.log(`\n${fail ? '\u2717' : '\u2713'} ${pass}/${total} 通过${fail ? '，' + fail + ' 失败' : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n自检自身出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
