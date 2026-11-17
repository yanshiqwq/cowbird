#!/usr/bin/env node
// codearts 驱动的离线自测：**不联网、不 spawn、不读真实登录态**。
//
// 覆盖的都是"抄错了会很难查"的地方：
//   · 具名 SSE 的帧解析（含分块边界、CRLF、多行 data、注释行）
//   · 15 种事件 → 归一化事件（尤其 error 帧兼任 done 哨兵、heartbeat 不能被丢）
//   · 提问回答的 answers 形状（数组的数组 + `"label" - description`）
//   · cgroup v1 / v2 双模式解析
//   · 命令包装层（退出码 / stderr 分离）与 30s 截断识别
//   · HW-AJAX-REDIRECT 判定（200 + 空体 = 没登录）与平台错误码映射
//
//   node lib/platform/codearts/selftest.js
'use strict';
const assert = require('assert');

const { CAP, EVENT } = require('../contract');
const answers = require('./answers');
const cgroup = require('./cgroup');
const shell = require('./shell');
const sse = require('./sse');
const transport = require('./transport');
const auth = require('./auth');
const provider = require('./index');

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + (e && e.message)); }
};
// 异步用例必须排队到末尾统一 await。
// 踩过的坑：直接写 `okA(...)` 而不 await，顶层同步代码跑完就 process.exit()，
// 这些用例**一个都不会执行**，而计数器看起来还挺好看。
const asyncQueue = [];
const okA = (name, fn) => { asyncQueue.push({ name, fn }); };
const kindsOf = (frames) => frames.flatMap((f) => sse.mapFrame(f).map((e) => e.kind));

// ---------------------------------------------------------------- 假数据
// 一轮真实形状的 SSE（照报告 3.3 的事件目录造，字段名与线上一致）
const TURN = [
  'event: status',
  'data: {"status":"processing","turn_id":"t-1","message_id":"m-1","pool_used":false,"ts":1763000001}',
  '',
  'event: thought',
  'data: {"content":"先看看环境。","index":0,"part_id":"p0"}',
  '',
  'event: tool_call',
  'data: {"part_id":"p1","tool":"bash","call_id":"c1","params":{}}',
  '',
  'event: tool_call_delta',
  'data: {"part_id":"p1","input":{"input":{"command":"uname -a"}}}',
  '',
  'event: tool_call',
  'data: {"part_id":"p1","tool":"bash","call_id":"c1","params":{"command":"uname -a"}}',
  '',
  'event: tool_result',
  'data: {"part_id":"p1","tool":"bash","status":"completed","result":"Linux h 6.6.0 aarch64","title":"uname -a"}',
  '',
  'event: message',
  'data: {"content":"这是 Linux。","index":1,"part_id":"p2"}',
  '',
  'event: step_finish',
  'data: {"reason":"stop","tokens":{"total":100,"input":80,"output":20,"reasoning":0,"cache":{"read":10,"write":2}},"cost":0.27}',
  '',
  'event: question',
  'data: {"question_id":"que_1","call_id":"c2","turn_id":"t-1","questions":[{"header":"水果偏好","question":"你最喜欢哪种水果？","options":[{"label":"苹果","description":"清脆多汁，香甜可口"},{"label":"香蕉","description":"绵软香甜，方便携带"}]}]}',
  '',
  'event: tool_authorization',
  'data: {"permission_id":"per_1","permission":"external_directory","patterns":["/root/.ssh/*"],"auto":false}',
  '',
  'event: file_diff',
  'data: {"diff":[{"file":"/workspace/a.txt","before":"","after":"x"}]}',
  '',
  'event: session_title',
  'data: {"title":"环境调查","turn_id":"t-1"}',
  '',
  'event: heartbeat',
  'data: {"ts":1763000002}',
  '',
  'event: done',
  'data: {"latency_ms":1234,"turn_id":"t-1","tokens":{"total":100},"credit_cost_for_web":{"credit_cost":0.27}}',
  '',
].join('\n');

const flat = (stream, f) => [...stream].flatMap((x) => sse.mapFrame(x)).filter((e) => (f ? f(e) : true));

// ---------------------------------------------------------------- 1. SSE 帧解析
console.log('\nSSE 帧解析');
ok('整段解析：14 帧、事件名正确', () => {
  const frames = sse.framesFromText(TURN);
  assert.strictEqual(frames.length, 14, '帧数=' + frames.length);
  assert.strictEqual(frames[0].event, 'status');
  assert.strictEqual(frames[6].event, 'message');
  assert.strictEqual(frames[13].event, 'done');
  assert.deepStrictEqual(frames[0].json, { status: 'processing', turn_id: 't-1', message_id: 'm-1', pool_used: false, ts: 1763000001 });
});

ok('按 1 字节喂：帧数与整段一致（分块边界不能切错帧）', () => {
  const p = sse.createParser();
  const got = [];
  for (const ch of TURN) got.push(...p.push(ch));
  got.push(...p.end());
  assert.strictEqual(got.length, 14, '帧数=' + got.length);
  assert.deepStrictEqual(got.map((f) => f.event), sse.framesFromText(TURN).map((f) => f.event));
});

ok('CRLF：连续 \\r\\n 也算空行分隔（且不能在 \\r|\\n 边界误切）', () => {
  const crlf = TURN.replace(/\n/g, '\r\n');
  assert.strictEqual(sse.framesFromText(crlf).length, 14);
  // 逐字符喂一遍，专门撞 \r 与 \n 分处两块的边界
  const p = sse.createParser();
  const got = [];
  for (const ch of crlf) got.push(...p.push(ch));
  got.push(...p.end());
  assert.strictEqual(got.length, 14, '帧数=' + got.length);
});

ok('多行 data 用 \\n 拼回；注释行与 id/retry 忽略', () => {
  const text = ': keep-alive\n\nid: 7\nretry: 3000\nevent: message\ndata: {"content":"a"}\n\n: 另一条注释\n\n';
  const frames = sse.framesFromText(text);
  assert.strictEqual(frames.length, 1, '帧数=' + frames.length);
  assert.strictEqual(frames[0].event, 'message');
  assert.strictEqual(frames[0].json.content, 'a');
});

ok('非 JSON 的 data 不丢：text 原样保留', () => {
  const f = sse.framesFromText('event: message\ndata: line1\ndata: line2\n\n')[0];
  assert.strictEqual(f.text, 'line1\nline2');
  assert.strictEqual(f.json, null);
  const ev = sse.mapFrame(f);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].kind, EVENT.RAW);
});

ok('只有 data 没有 event 时默认 message', () => {
  const f = sse.framesFromText('data: {"content":"hi"}\n\n')[0];
  assert.strictEqual(f.event, 'message');
});

// ---------------------------------------------------------------- 2. 事件映射
console.log('\n事件映射（SSE → 归一化）');
ok('15 种事件逐帧映射成期望的 kind 序列', () => {
  const frames = sse.framesFromText(TURN);
  assert.deepStrictEqual(kindsOf(frames), [
    EVENT.STATUS,       // status
    EVENT.THINKING,     // thought
    EVENT.TOOL,         // tool_call（首帧 params={}）
    EVENT.TOOL,         // tool_call_delta
    EVENT.TOOL,         // tool_call（参数补全）
    EVENT.TOOL_RESULT,  // tool_result
    EVENT.TEXT,         // message
    EVENT.USAGE,        // step_finish
    EVENT.QUESTION,     // question
    EVENT.PERMISSION,   // tool_authorization
    EVENT.RAW,          // file_diff
    EVENT.RAW,          // session_title
    EVENT.RAW,          // heartbeat
    EVENT.DONE,         // done
  ]);
});

ok('status：processing→running，原始词留在 original', () => {
  const [ev] = flat(sse.framesFromText('event: status\ndata: {"status":"processing"}\n\n'));
  assert.strictEqual(ev.kind, EVENT.STATUS);
  assert.strictEqual(ev.data.status, 'running');
  assert.strictEqual(ev.data.original, 'processing');
  const [ev2] = flat(sse.framesFromText('event: status\ndata: {"status":"initializing"}\n\n'));
  assert.strictEqual(ev2.data.status, 'starting');
  const [ev3] = flat(sse.framesFromText('event: status\ndata: {"status":"retry"}\n\n'));
  assert.strictEqual(ev3.data.status, 'retrying');
});

ok('tool_call：首帧标 partial，补全帧带完整 params', () => {
  const evs = flat(sse.framesFromText(TURN), (e) => e.kind === EVENT.TOOL);
  assert.strictEqual(evs.length, 3);
  assert.strictEqual(evs[0].data.partial, true);
  assert.strictEqual(evs[0].data.name, 'bash');
  assert.strictEqual(evs[1].data.delta, true);
  assert.strictEqual(evs[2].data.partial, false);
  assert.deepStrictEqual(evs[2].data.input, { command: 'uname -a' });
  assert.strictEqual(evs[2].data.id, 'c1');
});

ok('tool_result：completed → ok:true，结果进 out', () => {
  const [ev] = flat(sse.framesFromText(TURN), (e) => e.kind === EVENT.TOOL_RESULT);
  assert.strictEqual(ev.data.ok, true);
  assert.strictEqual(ev.data.name, 'bash');
  assert.match(String(ev.data.out), /Linux/);
});

ok('tool_result：failed → ok:false，带 error', () => {
  const [ev] = flat(sse.framesFromText('event: tool_result\ndata: {"tool":"bash","status":"failed","error":"boom"}\n\n'));
  assert.strictEqual(ev.data.ok, false);
  assert.strictEqual(ev.data.error, 'boom');
});

ok('question：requestId + questions[].options[{label,description}]', () => {
  const [ev] = flat(sse.framesFromText(TURN), (e) => e.kind === EVENT.QUESTION);
  assert.strictEqual(ev.data.requestId, 'que_1');
  assert.strictEqual(ev.data.questions.length, 1);
  assert.strictEqual(ev.data.questions[0].header, '水果偏好');
  assert.deepStrictEqual(ev.data.questions[0].options[1], { label: '香蕉', description: '绵软香甜，方便携带' });
});

ok('tool_authorization：requestId/tool/detail', () => {
  const [ev] = flat(sse.framesFromText(TURN), (e) => e.kind === EVENT.PERMISSION);
  assert.strictEqual(ev.data.requestId, 'per_1');
  assert.strictEqual(ev.data.tool, 'external_directory');
  assert.deepStrictEqual(ev.data.detail, ['/root/.ssh/*']);
});

ok('step_finish：tokens → usage', () => {
  const [ev] = flat(sse.framesFromText(TURN), (e) => e.kind === EVENT.USAGE);
  assert.strictEqual(ev.data.inputTokens, 80);
  assert.strictEqual(ev.data.outputTokens, 20);
  assert.strictEqual(ev.data.totalTokens, 100);
  assert.strictEqual(ev.data.cacheReadTokens, 10);
  assert.strictEqual(ev.data.cost, 0.27);
});

ok('done：credits 与 latency', () => {
  const [ev] = flat(sse.framesFromText(TURN), (e) => e.kind === EVENT.DONE);
  assert.strictEqual(ev.data.reason, 'done');
  assert.strictEqual(ev.data.credits, 0.27);
  assert.strictEqual(ev.data.latencyMs, 1234);
});

ok('★ error(type=stream_ended) 当 done，不是错误', () => {
  const evs = flat(sse.framesFromText('event: error\ndata: {"type":"stream_ended"}\n\n'));
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].kind, EVENT.DONE);
  assert.strictEqual(evs[0].data.reason, 'stream_ended');
});

ok('★ error(error_code=CODEBASE.00010628.200) 也当 done', () => {
  const evs = flat(sse.framesFromText('event: error\ndata: {"error_code":"CODEBASE.00010628.200","error_msg":"ended"}\n\n'));
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].kind, EVENT.DONE);
});

ok('普通 error 帧仍是 error（带平台码）', () => {
  const evs = flat(sse.framesFromText('event: error\ndata: {"error_code":"CODEBASE.00010606.200","error_msg":"预览服务未启动"}\n\n'));
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].kind, EVENT.ERROR);
  assert.strictEqual(evs[0].data.code, 'CODEBASE.00010606.200');
  assert.match(evs[0].data.message, /预览服务未启动/);
});

ok('stopped → done(reason=stopped)', () => {
  const [ev] = flat(sse.framesFromText('event: stopped\ndata: {"partial_message_id":"p9"}\n\n'));
  assert.strictEqual(ev.kind, EVENT.DONE);
  assert.strictEqual(ev.data.reason, 'stopped');
});

ok('heartbeat 忽略但不丢：raw + alive:true', () => {
  const [ev] = flat(sse.framesFromText('event: heartbeat\ndata: {"ts":1763000002}\n\n'));
  assert.strictEqual(ev.kind, EVENT.RAW);
  assert.strictEqual(ev.data.heartbeat, true);
  assert.strictEqual(ev.data.alive, true);
});

ok('未知事件 → raw（原样旁路）', () => {
  const [ev] = flat(sse.framesFromText('event: telemetry\ndata: {"x":1}\n\n'));
  assert.strictEqual(ev.kind, EVENT.RAW);
  assert.deepStrictEqual(ev.data.raw, { event: 'telemetry', data: { x: 1 } });
});

ok('空 message 帧不产出事件', () => {
  assert.strictEqual(flat(sse.framesFromText('event: message\ndata: {"content":""}\n\n')).length, 0);
});

// ---------------------------------------------------------------- 3. answers 形状
console.log('\n提问回答（answers 形状）');
const Q1 = [{
  header: '水果偏好',
  question: '你最喜欢哪种水果？',
  options: [
    { label: '苹果', description: '清脆多汁，香甜可口' },
    { label: '香蕉', description: '绵软香甜，方便携带' },
  ],
}];

ok('★ 标准形状：数组的数组，元素是 `"label" - description`', () => {
  const got = answers.buildAnswers([['苹果']], Q1);
  assert.deepStrictEqual(got, [['"苹果" - 清脆多汁，香甜可口']]);
  // 和报告里那份实测原文逐字节比对
  assert.strictEqual(JSON.stringify(got), JSON.stringify([['"苹果" - 清脆多汁，香甜可口']]));
});

ok('只给 label：自动从题目里补 description', () => {
  assert.deepStrictEqual(answers.buildAnswers(['香蕉'], Q1), [['"香蕉" - 绵软香甜，方便携带']]);
});

ok('给选项对象 / 单字符串 / 已格式化的串都能收', () => {
  const want = [['"苹果" - 清脆多汁，香甜可口']];
  assert.deepStrictEqual(answers.buildAnswers([{ label: '苹果', description: '清脆多汁，香甜可口' }], Q1), want);
  assert.deepStrictEqual(answers.buildAnswers('苹果', Q1), want);
  assert.deepStrictEqual(answers.buildAnswers(['"苹果" - 清脆多汁，香甜可口'], Q1), want);
});

ok('多选题：同一题的多个选项进同一个内层数组', () => {
  assert.deepStrictEqual(answers.buildAnswers([['苹果', '香蕉']], Q1), [['"苹果" - 清脆多汁，香甜可口', '"香蕉" - 绵软香甜，方便携带']]);
});

ok('多题：外层按题序一一对应', () => {
  const Q2 = [Q1[0], { header: '颜色', question: '喜欢哪种颜色？', options: [{ label: '红', description: '热烈' }] }];
  assert.deepStrictEqual(answers.buildAnswers(['苹果', '红'], Q2), [
    ['"苹果" - 清脆多汁，香甜可口'],
    ['"红" - 热烈'],
  ]);
});

ok('没有 description 时保持固定格式（补空串），不是漏掉连字符', () => {
  assert.deepStrictEqual(answers.buildAnswers(['自定义'], []), [['"自定义" - ']]);
});

ok('空输入 → 空数组（不能编出一个空选项）', () => {
  assert.deepStrictEqual(answers.buildAnswers([], Q1), []);
  assert.deepStrictEqual(answers.buildAnswers(null, Q1), []);
  assert.deepStrictEqual(answers.buildAnswers(undefined, Q1), []);
});

ok('formatChoice 逐字对齐 `"<label>" - <desc>`', () => {
  assert.strictEqual(answers.formatChoice('苹果', '清脆多汁，香甜可口'), '"苹果" - 清脆多汁，香甜可口');
});

// ---------------------------------------------------------------- 4. cgroup
console.log('\ncgroup 容量解析（v2 / v1）');
const V2 = [
  'WBSBX_NPROC=2',
  'WBSBX_MEMTOTAL_KB=8192000',
  'WBSBX_CG=v2',
  'WBSBX_CPU_MAX=400000 100000',
  'WBSBX_MEM_MAX=8589934592',
  'WBSBX_DF=31268748 12345678',
  'WBSBX_UNAME=Linux 6.6.0 aarch64',
  'WBSBX_HOST=nacre-2026-11-17-01-17-22',
  'WBSBX_ROOTFS=overlay',
].join('\n');

ok('v2：cpu.max=400000 100000 → 4 核；memory.max → GiB', () => {
  const cg = cgroup.parseCgroup(V2);
  assert.strictEqual(cg.mode, 'v2');
  assert.strictEqual(cg.cpu.visible, 2);
  assert.strictEqual(cg.cpu.quota, 4);
  assert.strictEqual(cg.cpu.unlimited, false);
  assert.strictEqual(cg.mem.visibleBytes, 8192000 * 1024);
  assert.strictEqual(cg.mem.quotaBytes, 8589934592);
  assert.strictEqual(cg.disk.totalBytes, 31268748 * 1024);
  assert.strictEqual(cg.disk.availBytes, 12345678 * 1024);
  assert.strictEqual(cg.kernel, 'Linux 6.6.0 aarch64');
});

ok('v2 不设上限：max / max → quota 为 null 且标 unlimited', () => {
  const cg = cgroup.parseCgroup('WBSBX_NPROC=2\nWBSBX_CG=v2\nWBSBX_CPU_MAX=max 100000\nWBSBX_MEM_MAX=max\n');
  assert.strictEqual(cg.cpu.quota, null);
  assert.strictEqual(cg.cpu.unlimited, true);
  assert.strictEqual(cg.mem.quotaBytes, null);
  assert.strictEqual(cg.mem.unlimited, true);
  assert.strictEqual(cg.disk.totalBytes, null, '没有 df 行时不能瞎编');
});

ok('v1：cfs_quota_us/cfs_period_us → 核数；memory.limit_in_bytes 魔数当不限', () => {
  const cg = cgroup.parseCgroup(
    'WBSBX_NPROC=8\nWBSBX_CG=v1\nWBSBX_CPU_QUOTA=200000\nWBSBX_CPU_PERIOD=100000\n' +
    'WBSBX_MEM_MAX=9223372036854771712\nWBSBX_DF=1000 500\n'
  );
  assert.strictEqual(cg.mode, 'v1');
  assert.strictEqual(cg.cpu.quota, 2);
  assert.strictEqual(cg.mem.quotaBytes, null, 'v1 的 2^63 魔数是"无限制"');
  assert.strictEqual(cg.mem.unlimited, true);
});

ok('v1：quota=-1 也是不限', () => {
  const cg = cgroup.parseCgroup('WBSBX_CG=v1\nWBSBX_CPU_QUOTA=-1\nWBSBX_CPU_PERIOD=100000\nWBSBX_MEM_MAX=1073741824\n');
  assert.strictEqual(cg.cpu.quota, null);
  assert.strictEqual(cg.mem.quotaBytes, 1073741824);
});

ok('没有 cgroup（CG=none）：不炸，全部 null', () => {
  const cg = cgroup.parseCgroup('WBSBX_NPROC=2\nWBSBX_CG=none\nWBSBX_MEMTOTAL_KB=100\n');
  assert.strictEqual(cg.mode, null);
  assert.strictEqual(cg.cpu.quota, null);
  assert.strictEqual(cg.mem.quotaBytes, null);
  assert.strictEqual(cg.mem.visibleBytes, 100 * 1024);
});

ok('采集脚本里含 v1/v2 两条分支与 df', () => {
  const s = cgroup.cgroupScript();
  assert.match(s, /\/sys\/fs\/cgroup\/cpu\.max/);
  assert.match(s, /cpu\.cfs_quota_us/);
  assert.match(s, /memory\.max/);
  assert.match(s, /memory\.limit_in_bytes/);
  assert.match(s, /WBSBX_DF=/);
});

ok('humanBytes', () => {
  assert.strictEqual(cgroup.humanBytes(8 * 1024 ** 3), '8.0 GB');
  assert.strictEqual(cgroup.humanBytes(null), '未知');
});

// ---------------------------------------------------------------- 5. shell 包装
console.log('\n命令包装 / 截断识别');
ok('shQuote 处理单引号', () => {
  assert.strictEqual(shell.shQuote("a'b"), `'a'\\''b'`);
  assert.strictEqual(shell.shQuote('/workspace/x y.txt'), `'/workspace/x y.txt'`);
});

/** 包装器现在是 base64 → bash -s（平台吞换行、不保留变量），断言前先解出来 */
function unwrap(s) {
  const m = String(s).match(/^echo '([A-Za-z0-9+/=]+)' \| base64 -d \| bash -s$/);
  assert.ok(m, '外层应是 echo <b64> | base64 -d | bash -s，实得：' + String(s).slice(0, 80));
  return Buffer.from(m[1], 'base64').toString('utf8');
}

/** 同一个解码，但解不出来就原样返回（假传输里用：让旧的断言/桩按键仍然能匹配到命令内容） */
function innerOf(s) {
  const m = String(s).match(/^echo '([A-Za-z0-9+/=]+)' \| base64 -d \| bash -s$/);
  if (!m) return String(s);
  try { return Buffer.from(m[1], 'base64').toString('utf8'); } catch { return String(s); }
}

ok('wrapCommand：外层零变量零换行，脚本走 base64（平台会吞换行、丢变量）', () => {
  const s = shell.wrapCommand('echo "hi"');
  assert.ok(!s.includes('\n'), '外层命令必须是单行');
  assert.ok(!/\$/.test(s), '外层不能有 shell 变量（平台不保留）');
  const inner = unwrap(s);
  assert.match(inner, /\( echo "hi" \)/);
  assert.match(inner, /__WBSBX_RC=/);
  assert.match(inner, /__WBSBX_STDERR__/);
  const withCwd = unwrap(shell.wrapCommand('ls', { cwd: '/workspace' }));
  assert.match(withCwd, /cd '\/workspace'/);
});

ok('env：合法变量名才进 export，非法名/空值按规矩处理', () => {
  assert.deepStrictEqual(shell.envPrefix({ FOO: 'a b', 'bad-name': 'x', EMPTY: '' }), ["export FOO='a b'", "export EMPTY=''"]);
  assert.deepStrictEqual(shell.envPrefix(null), []);
  assert.match(unwrap(shell.wrapCommand('echo hi', { env: { LANG: 'zh_CN.UTF-8' } })), /export LANG='zh_CN\.UTF-8'/);
  // 后台脚本整段要再过一次 shQuote，所以这里只能断言"变量确实进去了"（引号会被转义成 '\''）
  assert.match(shell.buildJobScript({ jobId: 'j1', command: 'x', env: { A: '1' }, dir: '/d' }), /export A=/);
});

ok('★ 往返：output/rc/stderr 三样都能拆回来', () => {
  const r0 = shell.parseWrapped('hi\n\n__WBSBX_RC=0\n__WBSBX_STDERR__\n');
  assert.strictEqual(r0.out, 'hi\n');
  assert.strictEqual(r0.err, '');
  assert.strictEqual(r0.code, 0);
  assert.strictEqual(r0.wrapped, true);

  const r1 = shell.parseWrapped('out\n\n__WBSBX_RC=1\n__WBSBX_STDERR__\nerr text\n');
  assert.strictEqual(r1.out, 'out\n');
  assert.strictEqual(r1.code, 1);
  assert.strictEqual(r1.err, 'err text\n');

  const r2 = shell.parseWrapped('\n__WBSBX_RC=127\n__WBSBX_STDERR__\nsh: nope: not found\n');
  assert.strictEqual(r2.out, '');
  assert.strictEqual(r2.code, 127);
  assert.match(r2.err, /not found/);
});

ok('没有标记 → wrapped:false，不谎报退出码', () => {
  const r = shell.parseWrapped('just output');
  assert.strictEqual(r.wrapped, false);
  assert.strictEqual(r.code, null);
  assert.strictEqual(r.out, 'just output');
});

ok('命令自己打印了同名文本也骗不过（从后往前取最后一次）', () => {
  const r = shell.parseWrapped('echo __WBSBX_RC=9\n\n__WBSBX_RC=0\n__WBSBX_STDERR__\n');
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /echo __WBSBX_RC=9/);
});

ok('★ 正常执行：state.output/status 取出', () => {
  const doc = {
    info: { tokens: { input: 0, output: 0 } },
    parts: [{ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', output: 'root\n/workspace\n' } }],
  };
  const r = shell.parseShellResult(doc);
  assert.strictEqual(r.out, 'root\n/workspace\n');
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.tokens.input, 0);
});

ok('★ 30s 截断特征：200 + status 空 + output 空 → truncated:true', () => {
  const r = shell.parseShellResult({ parts: [{ type: 'tool', state: { status: '', output: '' } }] });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.out, '');
});

ok('完成但输出为空（如 true）不算截断：status=completed 就在', () => {
  const r = shell.parseShellResult({ parts: [{ type: 'tool', state: { status: 'completed', output: '' } }] });
  assert.strictEqual(r.truncated, false);
});

ok('空响应体（网关直接断）按截断处理', () => {
  assert.strictEqual(shell.parseShellResult(null).truncated, true);
  assert.strictEqual(shell.parseShellResult({}).truncated, true);
});

ok('metadata.output 兜底', () => {
  const r = shell.parseShellResult({ parts: [{ type: 'tool', state: { status: 'completed', metadata: { output: 'x' } } }] });
  assert.strictEqual(r.out, 'x');
});

ok('后台任务脚本/轮询脚本成对', () => {
  const s = shell.buildJobScript({ jobId: 'j1', command: 'sleep 45; echo done', dir: '/workspace/.wbsbx' });
  assert.match(s, /nohup sh -c /);
  assert.match(s, /\/workspace\/\.wbsbx\/j1\.log/);
  assert.match(s, /__WBSBX_JOB_RC=/);
  const p = shell.buildPollScript({ jobId: 'j1', dir: '/workspace/.wbsbx' });
  assert.match(p, /__WBSBX_BEGIN__/);
  assert.match(p, /kill -0/);
});

ok('poll 解析：跑完（有 JOB_RC）', () => {
  const st = shell.parsePoll('__WBSBX_SIZE=42\n__WBSBX_PID=123\n__WBSBX_ALIVE=0\n__WBSBX_BEGIN__\nhello\n__WBSBX_JOB_RC=0\n');
  assert.strictEqual(st.done, true);
  assert.strictEqual(st.code, 0);
  assert.strictEqual(st.out, 'hello');
  assert.strictEqual(st.alive, false);
  assert.strictEqual(st.size, 42);
});

ok('poll 解析：还在跑（无 JOB_RC、进程活着）', () => {
  const st = shell.parsePoll('__WBSBX_SIZE=5\n__WBSBX_PID=9\n__WBSBX_ALIVE=1\n__WBSBX_BEGIN__\nrun..');
  assert.strictEqual(st.done, false);
  assert.strictEqual(st.code, null);
  assert.strictEqual(st.alive, true);
  assert.match(st.out, /^run/);
});

ok('poll 解析：job 不存在', () => {
  const st = shell.parsePoll('__WBSBX_MISSING=1\n');
  assert.strictEqual(st.missing, true);
  assert.strictEqual(st.done, false);
});

// ---------------------------------------------------------------- 6. 认证与传输判定
console.log('\n认证 / 传输判定');
const COOKIE_STR = 'devclouddevuibjJ_SESSION_ID=SESSIONVALUE1234567890; devclouddevuibjtcftk=CFTKVALUE; devclouddevuibjagencyID=AGENCY; HWWAFSESID=waf1';
const fakeState = {
  cookies: auth.parseCookieString(COOKIE_STR),
  savedAt: '2026-11-17T00:00:00.000Z',
};

ok('parseCookieString：拆出三条关键 cookie', () => {
  assert.strictEqual(fakeState.cookies.length, 4);
  assert.strictEqual(auth.cookieValue(fakeState.cookies, auth.SESSION_COOKIE), 'SESSIONVALUE1234567890');
  assert.strictEqual(auth.cookieValue(fakeState.cookies, auth.CFTK_COOKIE), 'CFTKVALUE');
  assert.strictEqual(auth.cookieValue(fakeState.cookies, auth.AGENCY_COOKIE), 'AGENCY');
});

ok('isLoggedIn 只看 SESSION_ID', () => {
  assert.strictEqual(auth.isLoggedIn(fakeState), true);
  assert.strictEqual(auth.isLoggedIn({ cookies: [] }), false);
  assert.strictEqual(auth.isLoggedIn(null), false);
});

ok('ttlDays：session cookie（无 expires）返回 null，不是 0', () => {
  assert.strictEqual(auth.ttlDays(fakeState), null);
  const withExp = [{ name: 'x', value: '1', expires: Math.floor(Date.now() / 1000) + 86400 }];
  assert.ok(auth.ttlDays(withExp) > 0.9 && auth.ttlDays(withExp) < 1.1);
});

ok('★ buildHeaders 带齐四个必需头，cftk 取自 cookie', () => {
  const h = transport.buildHeaders(fakeState, { method: 'POST' });
  assert.strictEqual(h['x-requested-with'], 'XMLHttpRequest');
  assert.strictEqual(h['agent-type'], 'CodeBase');
  assert.strictEqual(h['x-codearts-doer-scenario-type'], 'web');
  assert.strictEqual(h.cftk, 'CFTKVALUE');
  assert.match(h.cookie, /devclouddevuibjJ_SESSION_ID=SESSIONVALUE1234567890/);
  assert.strictEqual(h.origin, transport.ORIGIN, 'POST 带 Origin');
  const g = transport.buildHeaders(fakeState, { method: 'GET' });
  assert.strictEqual(g.origin, undefined, 'GET 不带 Origin（照抄浏览器行为）');
});

ok('★ 未登录判定：200 + 空体 + HW-AJAX-REDIRECT', () => {
  const headers = new Headers({ 'HW-AJAX-REDIRECT': 'https://auth.huaweicloud.com/authui/login?service=x' });
  assert.match(transport.isNotLoggedIn({ status: 200, headers, text: '' }), /authui\/login/);
  // 普通对象头也要认（自测/单测里常这样造）
  assert.match(transport.isNotLoggedIn({ status: 200, headers: { 'hw-ajax-redirect': 'x' }, text: '' }), /x/);
  // 正常响应不能误判
  assert.strictEqual(transport.isNotLoggedIn({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: '{"status":"ok"}' }), '');
  // 401 空体也算
  assert.ok(transport.isNotLoggedIn({ status: 401, headers: {}, text: '' }));
});

ok('AuthError 带 E_NOT_LOGGED_IN 且 auth=true', () => {
  const e = new transport.AuthError('没登录');
  assert.strictEqual(e.code, 'E_NOT_LOGGED_IN');
  assert.strictEqual(e.auth, true);
  assert.ok(e instanceof Error);
});

ok('★ busy 400 → E_BUSY（可重试）', () => {
  const body = { name: 'UnknownError', data: { message: 'Session ses_e2070 is busy' } };
  assert.strictEqual(transport.isBusy(body), true);
  const e = transport.apiError(400, body, JSON.stringify(body));
  assert.strictEqual(e.code, 'E_BUSY');
  assert.strictEqual(e.retryable, true);
  assert.strictEqual(e.retryAfterMs, 2000);
});

ok('平台错误码 → 语义码', () => {
  const table = [
    ['CODEBASE.00010605.200', 'E_NO_SANDBOX', false],
    ['CODEBASE.00010610.409', 'E_SANDBOX_UNAVAILABLE', true],
    ['CODEBASE.00010606.200', 'E_NO_PREVIEW', false],
    ['CODEBASE.00011002.400', 'E_BAD_PARAMS', false],
    ['TM.00001001', 'E_NO_AGENT_TYPE', false],
    ['TM.00001050', 'E_QUEUE', false],
  ];
  for (const [platformCode, want, retryable] of table) {
    const e = transport.apiError(400, { error_code: platformCode, error_msg: 'x' }, '');
    assert.strictEqual(e.code, want, platformCode + ' → ' + e.code);
    assert.strictEqual(e.platformCode, platformCode);
    assert.strictEqual(e.retryable, retryable, platformCode + ' retryable');
    assert.ok(e.hint && e.hint.length > 0, platformCode + ' 要带处置建议');
  }
});

ok('未知码 / 5xx 兜底', () => {
  assert.strictEqual(transport.apiError(400, { error_code: 'X.Y', error_msg: 'm' }, '').code, 'E_HTTP_400');
  assert.strictEqual(transport.apiError(502, null, 'bad gateway').code, 'E_SERVER');
  assert.strictEqual(transport.apiError(429, null, '').code, 'E_RATE_LIMIT');
});

ok('codeOf 认 result.data 嵌套与 null', () => {
  assert.strictEqual(transport.codeOf({ error_code: 'A' }), 'A');
  assert.strictEqual(transport.codeOf({ data: { error_code: 'B' } }), 'B');
  assert.strictEqual(transport.codeOf(null), '');
});

// 内存版 store（不落盘、不碰真登录态）
function memStore() {
  const d = {};
  return { dir: '(内存)', read: (k) => d[k] || null, write: (k, v) => { d[k] = v; }, remove: (k) => { delete d[k]; } };
}

okA('auth.state：没有 cookie 就是 null（未登录）', async () => {
  const ctx = { store: memStore(), defaults: provider.defaults, config: () => ({}) };
  assert.strictEqual(await auth.state(ctx), null);
});

okA('auth.importCookies → auth.state 能读回，ttlDays 为 null', async () => {
  const ctx = { store: memStore(), defaults: provider.defaults, config: () => ({}) };
  await auth.importCookies(ctx, COOKIE_STR);
  const st = await auth.state(ctx);
  assert.ok(st);
  assert.strictEqual(st.token, 'SESSIONVALUE1234567890');
  assert.strictEqual(st.cftk, 'CFTKVALUE');
  assert.strictEqual(st.ttlDays, null);
  assert.strictEqual(st.expiresAt, null);
});

okA('auth.importCookies：粘错串要报清楚', async () => {
  const ctx = { store: memStore(), defaults: provider.defaults, config: () => ({}) };
  await assert.rejects(() => auth.importCookies(ctx, 'foo=1; bar=2'), /没有 devclouddevuibjJ_SESSION_ID/);
});

okA('auth.absorb：Max-Age=0 删 cookie，新值更新', async () => {
  const ctx = { store: memStore(), defaults: provider.defaults, config: () => ({}) };
  await auth.importCookies(ctx, COOKIE_STR);
  auth.absorb(ctx, ['HWWAFSESID=waf2; Path=/; Secure', 'devclouddevuibjagencyID=; Path=/; Max-Age=0']);
  const st = await auth.state(ctx);
  assert.strictEqual(auth.cookieValue(st.cookies, 'HWWAFSESID'), 'waf2');
  assert.strictEqual(auth.cookieValue(st.cookies, auth.AGENCY_COOKIE), null);
  assert.strictEqual(auth.cookieValue(st.cookies, auth.SESSION_COOKIE), 'SESSIONVALUE1234567890', '别的 cookie 不能被动到');
});

// ---------------------------------------------------------------- 7. 归一化
console.log('\n会话 / 消息归一');
const norm = provider._internal;

ok('normalizeSession：平台字段 → 内核实例形状', () => {
  const s = norm.normalizeSession({
    session_id: '45bd5f66-aaaa',
    title: '在 workspace 安装 Tails',
    status: 'IDLE',
    streaming: false,
    agent_session_id: 'ses_e20709562ffe7',
    last_active_time: '2026-11-16 08:28:14',
    create_time: '2026-11-15 22:15:00',
    runtime_name: 'runtime-codeartsdoer-v3',
    client_type: 'web',
    stats: { model: { id: 'deepseek-v4.1-flash-1017', providerID: 'inferhub-provider' }, agent: 'build', credit_cost_for_web: { credit_cost: 221.9 } },
  });
  assert.strictEqual(s.id, '45bd5f66-aaaa');
  assert.strictEqual(s.name, '在 workspace 安装 Tails');
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.platformStatus, 'IDLE');
  assert.strictEqual(s.updatedAt, '2026-11-16T08:28:14');
  assert.strictEqual(s.agentSessionId, 'ses_e20709562ffe7');
  assert.strictEqual(s.model, 'deepseek-v4.1-flash-1017');
  assert.strictEqual(s.agent, 'build');
  assert.strictEqual(s.credits, 221.9);
});

ok('状态枚举全表', () => {
  const want = {
    ACTIVE: 'idle', IDLE: 'idle', RUNNING: 'running', COMPLETED: 'completed',
    FAILED: 'failed', CANCELED: 'canceled', WAITING_APPROVAL: 'waiting', CLOSED: 'closed',
  };
  for (const [k, v] of Object.entries(want)) assert.strictEqual(norm.normStatus(k), v, k);
  assert.strictEqual(norm.normStatus(null), 'unknown');
});

ok('normalizeMessage：text/content 两种形状', () => {
  assert.strictEqual(norm.normalizeMessage({ content: 'hi', role: 'user', message_index: 3 }).text, 'hi');
  const p = norm.normalizeMessage({ parts: [{ type: 'text', text: 'a' }, { type: 'tool', text: 'x' }, { type: 'text', text: 'b' }] });
  assert.strictEqual(p.text, 'ab');
});

ok('messageBody：默认模型与 agent，且**不带 parts 字段**（那是踩过的坑）', () => {
  const ctx = { defaults: provider.defaults, config: () => ({}) };
  const b = norm.messageBody(ctx, { text: '你好' });
  assert.deepStrictEqual(b, { content: '你好', model_id: 'deepseek-v4.1-flash-1017', repos: [], agent: 'build' });
  assert.strictEqual('parts' in b, false);
  const b2 = norm.messageBody(ctx, { text: 'x', model: 'kimi-k3', agent: 'plan', command: '/explain' });
  assert.strictEqual(b2.model_id, 'kimi-k3');
  assert.strictEqual(b2.agent, 'plan');
  assert.strictEqual(b2.command, '/explain');
});

ok('文件树：treeNode/findNode/flattenNode', () => {
  const tree = {
    name: 'workspace', path: '/workspace', type: 'directory', children: [
      { name: 'a.txt', path: '/workspace/a.txt', type: 'file', size: 3 },
      { name: 'src', path: '/workspace/src', type: 'directory', children: [{ name: 'b.js', path: '/workspace/src/b.js', type: 'file', size: 9 }] },
    ],
  };
  assert.strictEqual(norm.treeNode({ result: tree }), tree);
  assert.strictEqual(norm.findNode(tree, '/workspace/src').name, 'src');
  const all = norm.flattenNode(tree);
  assert.deepStrictEqual(all.map((x) => x.path), ['/workspace/a.txt', '/workspace/src', '/workspace/src/b.js']);
  assert.strictEqual(all[0].type, 'file');
  assert.strictEqual(all[1].type, 'dir');
});

// ---------------------------------------------------------------- 8. provider 形状
console.log('\nprovider 形状');
ok('能力位齐全（含 exec.wake / fs / model）', () => {
  const want = [
    CAP.AUTH, CAP.LOGIN_BROWSER, CAP.LIST, CAP.CREATE, CAP.RENAME, CAP.REMOVE, CAP.META,
    CAP.AGENT, CAP.AGENT_QUESTION, CAP.AGENT_INTERRUPT, CAP.EXEC, CAP.EXEC_BG, CAP.WAKE, CAP.FS, CAP.MODEL,
  ];
  for (const c of want) assert.ok(provider.has(c), '缺能力 ' + c);
  assert.strictEqual(provider.has(CAP.AUTH_RENEW), false, 'session cookie 不可续期，别声明 renew');
});

ok('limits 与契约一致：28s / 20s / 后台可用', () => {
  assert.strictEqual(provider.limits.maxSyncMs, 28000);
  assert.strictEqual(provider.limits.defaultSyncMs, 20000);
  assert.strictEqual(provider.limits.maxBackground, true);
  assert.ok(provider.limits.maxSyncMs < 30000, '必须给网关 30s 顶留余量');
});

ok('必需方法都在', () => {
  const need = {
    instances: ['list', 'get', 'create', 'rename', 'remove', 'info'],
    agent: ['stream', 'send', 'history', 'answer', 'interrupt'],
    exec: ['probe', 'run', 'start', 'poll', 'wake', 'put', 'get'],
    fs: ['list', 'read', 'write', 'remove'],
    auth: ['state', 'ttlDays', 'login', 'importCookies'],
    model: ['list'],
    doctor: ['checks'],
  };
  for (const [mod, ms] of Object.entries(need)) {
    assert.ok(provider[mod], '缺 ' + mod);
    for (const m of ms) assert.strictEqual(typeof provider[mod][m], 'function', `缺 ${mod}.${m}()`);
  }
});

ok('id / displayName / 默认值 / 预览端口', () => {
  assert.strictEqual(provider.id, 'codearts');
  assert.match(provider.displayName, /CodeArts/);
  assert.strictEqual(provider.defaults.model, 'deepseek-v4.1-flash-1017');
  assert.strictEqual(provider.defaults.agent, 'build');
  assert.strictEqual(provider.defaults.baseUrl, 'https://devcloud.cn-north-4.huaweicloud.com/chat');
  assert.strictEqual(norm.PREVIEW_PORT, 9800);
  assert.strictEqual(norm.CHUNK_BYTES, 60 * 1024, 'base64 分块 60KB，别更大');
});

ok('exec 的预览隧道路径形状正确', () => {
  const p = norm.shellPath('sid-1', 'ses_abc');
  assert.strictEqual(p, '/codebaseservice/v1/cloudagent/sessions/sid-1/9800/preview/session/ses_abc/shell');
});

ok('EXEC 上限是硬承诺：28s < 网关 30s', () => {
  assert.ok(provider.limits.maxSyncMs <= 28000);
});

// ---------------------------------------------------------------- 9. 驱动编排（假传输）
// 用一个假 transport 把网络挡住，验证驱动自己的编排逻辑：
// SSE → 归一事件、提问落 store、answers 出站形状、exec 包装/截断、后台任务、文件分块。
// 这样"没凭据也能验协议"这件事就不是嘴上说说。
console.log('\n驱动编排（假传输，零网络）');

function fakeCtx() {
  return { store: memStore(), defaults: provider.defaults, config: () => ({}), paths: {}, log: () => {} };
}

/** 给某个 ctx 挂一套假的 request/openStream/frames */
function fakeTransport(ctx, { session = { session_id: 'sid-1', status: 'IDLE', agent_session_id: 'ses_k1' }, shell: shellHandler, frames } = {}) {
  const t = transport.createTransport(ctx);
  t.openStream = async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream;charset=UTF-8' }),
    res: { body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }), cancel: async () => {} }) } },
    async close() {},
  });
  t.frames = async function* () { for (const f of (frames || sse.framesFromText(TURN))) yield f; };
  t.request = async (method, path, opts = {}) => {
    if (method === 'GET' && /^\/v1\/cloudagent\/sessions\/[^/]+$/.test(path)) {
      return { status: 200, headers: new Headers(), json: { status: 'ok', result: session }, text: JSON.stringify(session) };
    }
    if (method === 'POST' && path.includes('/9800/preview/')) {
      // 用例断言的是"命令内容"，所以先把 base64 包装解回内层脚本文本
      const cmd = innerOf(String((opts.body && opts.body.command) || ''));
      const out = shellHandler ? shellHandler(cmd) : { out: '' };
      const payload = out.json || { parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', output: out.out || '' } }] };
      return { status: 200, headers: new Headers(), json: payload, text: JSON.stringify(payload) };
    }
    throw new Error('假传输没准备的请求：' + method + ' ' + path);
  };
  return t;
}

okA('★ agent.stream：逐帧映射、以 done 收尾、提问落 store', async () => {
  const ctx = fakeCtx();
  fakeTransport(ctx);
  const evs = [];
  let pendDuring = null;
  for await (const ev of provider.agent.stream(ctx, 'sid-1', { text: '你好' })) {
    evs.push(ev);
    // 提问一出现就要能被 answer 找到（这是 answer 不带 requestId 也能工作的前提）
    if (ev.kind === EVENT.QUESTION) pendDuring = provider.agent.pendingQuestion(ctx, 'sid-1');
  }
  assert.deepStrictEqual(evs.map((e) => e.kind), [
    EVENT.STATUS, EVENT.THINKING, EVENT.TOOL, EVENT.TOOL, EVENT.TOOL, EVENT.TOOL_RESULT,
    EVENT.TEXT, EVENT.USAGE, EVENT.QUESTION, EVENT.PERMISSION, EVENT.RAW, EVENT.RAW, EVENT.RAW, EVENT.DONE,
  ]);
  assert.strictEqual(evs[evs.length - 1].kind, EVENT.DONE, '必须以 done 结尾');
  const text = evs.filter((e) => e.kind === EVENT.TEXT).map((e) => e.data.text).join('');
  assert.strictEqual(text, '这是 Linux。');
  assert.ok(pendDuring, '提问期间 store 里要有挂起提问');
  assert.strictEqual(pendDuring.requestId, 'que_1');
  // 一轮正常结束（done）之后要清掉，避免把上一次的提问当成这一次的
  assert.strictEqual(provider.agent.pendingQuestion(ctx, 'sid-1'), null);
});

okA('★ agent.stream：流在 done 前断掉 → error(E_STREAM_CUT) + done(eof)', async () => {
  const ctx = fakeCtx();
  fakeTransport(ctx, { frames: [
    { event: 'status', json: { status: 'processing' }, text: '', id: null, data: null },
    { event: 'message', json: { content: '半句' }, text: '', id: null, data: null },
  ] });
  const evs = [];
  for await (const ev of provider.agent.stream(ctx, 'sid-1', { text: 'x' })) evs.push(ev);
  assert.deepStrictEqual(evs.map((e) => e.kind), [EVENT.STATUS, EVENT.TEXT, EVENT.ERROR, EVENT.DONE]);
  assert.strictEqual(evs[2].data.code, 'E_STREAM_CUT');
  assert.strictEqual(evs[3].data.reason, 'eof');
});

okA('★ agent.answer：出站 body 就是 [[`"苹果" - description`]]', async () => {
  const ctx = fakeCtx();
  // 只喂一帧 question、不给 done —— 模拟"提问挂起中"，此时挂起信息必须还在 store 里
  const t = fakeTransport(ctx, {
    frames: [{
      event: 'question', id: null, text: '', data: null,
      json: {
        question_id: 'que_1', call_id: 'c2', turn_id: 't-1',
        questions: [{ header: '水果偏好', question: '你最喜欢哪种水果？', options: [
          { label: '苹果', description: '清脆多汁，香甜可口' },
          { label: '香蕉', description: '绵软香甜，方便携带' },
        ] }],
      },
    }],
  });
  for await (const _ of provider.agent.stream(ctx, 'sid-1', { text: '问一下' })) { /* 消费掉 */ }
  assert.ok(provider.agent.pendingQuestion(ctx, 'sid-1'), '挂起的提问要留下来');

  let seen = null;
  t.request = async (method, path, opts) => {
    seen = { method, path, body: opts.body };
    return { status: 200, headers: new Headers(), json: { status: 'ok', result: { questionId: 'que_1', answered: true } }, text: '' };
  };
  const r = await provider.agent.answer(ctx, 'sid-1', { answers: ['苹果'] });
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(seen.path, '/v1/cloudagent/sessions/sid-1/messages/reply');
  assert.strictEqual(seen.body.question_id, 'que_1', 'requestId 从挂起提问里取');
  assert.deepStrictEqual(seen.body.answers, [['"苹果" - 清脆多汁，香甜可口']]);
  assert.strictEqual(JSON.stringify(seen.body.answers), JSON.stringify([['"苹果" - 清脆多汁，香甜可口']]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(provider.agent.pendingQuestion(ctx, 'sid-1'), null, '答完就清掉');
});

okA('agent.answer：没有提问又没给 requestId → 明确报错，别瞎发', async () => {
  const ctx = fakeCtx();
  fakeTransport(ctx);
  await assert.rejects(() => provider.agent.answer(ctx, 'sid-1', { answers: ['苹果'] }), /缺 question_id/);
});

okA('agent.send：只发不回放（读到首块就断开）', async () => {
  const ctx = fakeCtx();
  const t = transport.createTransport(ctx);
  let closed = false;
  t.openStream = async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    res: { body: { getReader: () => ({ read: async () => ({ done: false, value: new TextEncoder().encode('event: status\ndata: {}\n\n') }), cancel: async () => {} }) } },
    async close() { closed = true; },
  });
  const r = await provider.agent.send(ctx, 'sid-1', { text: '只发' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.bytes > 0);
  assert.strictEqual(closed, true, '流必须被关掉');
});

okA('★ exec.run：命令被包了一层，退出码/stderr 拆得回来', async () => {
  const ctx = fakeCtx();
  let seenCmd = null;
  fakeTransport(ctx, {
    shell: (cmd) => { seenCmd = cmd; return { out: 'hi\n\n__WBSBX_RC=7\n__WBSBX_STDERR__\nboom\n' }; },
  });
  const r = await provider.exec.run(ctx, 'sid-1', { command: 'echo hi; exit 7' });
  assert.strictEqual(r.out, 'hi\n');
  assert.strictEqual(r.code, 7);
  assert.strictEqual(r.err, 'boom\n');
  assert.strictEqual(r.truncated, false);
  // seenCmd 是假传输解包后的**内层脚本**（包装器本身是 base64，断言包装没意义）
  assert.match(String(seenCmd), /\( echo hi; exit 7 \)/, '发出去的必须是被包起来的命令');
  assert.match(String(seenCmd), /__WBSBX_RC=/);
});

okA('★ exec.run：200 + status/output 双空 → truncated:true（而不是"成功空输出"）', async () => {
  const ctx = fakeCtx();
  fakeTransport(ctx, { shell: () => ({ json: { parts: [{ type: 'tool', state: { status: '', output: '' } }] } }) });
  const r = await provider.exec.run(ctx, 'sid-1', { command: 'sleep 40' });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.code, null, '不知道退出码就别报 0');
  assert.match(r.err, /被截断|截断/);
  assert.match(r.err, /后台/, '错误信息要给出处置办法');
});

okA('exec.run：没有 agent_session_id → E_NO_SANDBOX（不假装能跑）', async () => {
  const ctx = fakeCtx();
  fakeTransport(ctx, { session: { session_id: 'sid-1', status: 'ACTIVE' } });
  await assert.rejects(
    () => provider.exec.run(ctx, 'sid-1', { command: 'true' }),
    (e) => e.code === 'E_NO_SANDBOX' && /no-sandbox/.test(e.message)
  );
});

okA('exec.probe：有/没有沙箱两种结论', async () => {
  const ctx1 = fakeCtx();
  fakeTransport(ctx1);
  const p1 = await provider.exec.probe(ctx1, 'sid-1');
  assert.strictEqual(p1.ready, true);
  assert.strictEqual(p1.kernelSessionId, 'ses_k1');

  const ctx2 = fakeCtx();
  fakeTransport(ctx2, { session: { session_id: 'sid-2', status: 'ACTIVE' } });
  const p2 = await provider.exec.probe(ctx2, 'sid-2');
  assert.strictEqual(p2.ready, false);
  assert.strictEqual(p2.why, 'no-sandbox');
});

okA('exec.start → exec.poll：jobId 一路穿过去，poll 能读到退出码', async () => {
  const ctx = fakeCtx();
  const seen = [];
  // 假 shell：命令输出之后还要带上包装层的 RC/STDERR 标记（真实链路就是这样）
  const wrapOut = (text) => text + '\n__WBSBX_RC=0\n__WBSBX_STDERR__\n';
  fakeTransport(ctx, {
    shell: (cmd) => {
      seen.push(cmd);
      if (cmd.includes('nohup sh -c')) return { out: wrapOut('4242\n') };
      if (cmd.includes('__WBSBX_BEGIN__')) {
        return {
          out: wrapOut([
            '__WBSBX_SIZE=6',
            '__WBSBX_PID=4242',
            '__WBSBX_ALIVE=0',
            '__WBSBX_BEGIN__',
            'done!',
            '__WBSBX_JOB_RC=0',
          ].join('\n') + '\n'),
        };
      }
      return { out: wrapOut('') };
    },
  });
  const job = await provider.exec.start(ctx, 'sid-1', { command: 'sleep 45; echo done!' });
  assert.match(job.jobId, /^j[a-z0-9]+/);
  assert.strictEqual(job.pid, '4242');
  assert.strictEqual(job.outputPath, `/workspace/.wbsbx/${job.jobId}.log`);
  assert.ok(seen[0].includes(job.jobId), '脚本里必须带这个 jobId');

  const st = await provider.exec.poll(ctx, 'sid-1', { jobId: job.jobId });
  assert.strictEqual(st.done, true);
  assert.strictEqual(st.code, 0);
  assert.match(st.out, /done!/);
});

okA('★ fs.write：base64 按 60KB 分块（100KB → 3 块），最后校验字节数', async () => {
  const ctx = fakeCtx();
  const chunks = [];
  fakeTransport(ctx, {
    shell: (cmd) => {
      const m = /printf '%s' '([A-Za-z0-9+/=]*)' >>/.exec(cmd);
      if (m) { chunks.push(m[1]); return { out: '' }; }
      if (cmd.includes('base64 -d')) return { out: '100000\n' };
      return { out: '' };
    },
  });
  const content = 'A'.repeat(100000);
  const r = await provider.fs.write(ctx, 'sid-1', { path: '/workspace/big.txt', content });
  assert.strictEqual(r.size, 100000);
  assert.strictEqual(r.chunks, 3, 'base64 长 133336，按 61440 切是 3 块');
  assert.ok(chunks.every((c) => c.length <= 60 * 1024), '每块都不能超过 60KB');
  assert.strictEqual(chunks.join('').length, Buffer.from(content).toString('base64').length);
});

okA('fs.read：优先走 files/content，读到 text 就返回', async () => {
  const ctx = fakeCtx();
  const t = transport.createTransport(ctx);
  t.request = async (method, path) => {
    assert.match(path, /\/files\/content\?path=/);
    return { status: 200, headers: new Headers(), json: { result: { type: 'text', content: 'hello' } }, text: '' };
  };
  const r = await provider.fs.read(ctx, 'sid-1', { path: '/workspace/a.txt' });
  assert.strictEqual(r.content, 'hello');
  assert.strictEqual(r.encoding, 'utf8');
});

okA('fs.list：树 → 文件条目（目录标 dir）', async () => {
  const ctx = fakeCtx();
  const t = transport.createTransport(ctx);
  t.request = async () => ({
    status: 200, headers: new Headers(), text: '',
    json: { result: { name: 'workspace', path: '/workspace', type: 'directory', children: [
      { name: 'a.txt', path: '/workspace/a.txt', type: 'file', size: 3 },
      { name: 'src', path: '/workspace/src', type: 'directory', children: [] },
    ] } },
  });
  const list = await provider.fs.list(ctx, 'sid-1', { path: '/workspace' });
  assert.deepStrictEqual(list.map((x) => [x.name, x.type]), [['a.txt', 'file'], ['src', 'dir']]);
});

okA('instances.list：分页 + 归一', async () => {
  const ctx = fakeCtx();
  const t = transport.createTransport(ctx);
  let page = 0;
  t.request = async (method, path) => {
    page++;
    assert.match(path, /page_num=\d+&page_size=\d+/, '参数必须是 snake_case');
    return {
      status: 200, headers: new Headers(), text: '',
      json: {
        status: 'ok',
        total: 2,
        result: page === 1
          ? [{ session_id: 's1', title: '一号', status: 'IDLE', agent_session_id: 'ses_1' }]
          : [{ session_id: 's2', title: '二号', status: 'RUNNING' }],
      },
    };
  };
  const list = await provider.instances.list(ctx, { pageSize: 50 });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].status, 'idle');
  assert.strictEqual(list[1].status, 'running');
  assert.strictEqual(list[0].agentSessionId, 'ses_1');
});

okA('instances.info：没沙箱时返回 {ready:false} 而不是抛错', async () => {
  const ctx = fakeCtx();
  fakeTransport(ctx, { session: { session_id: 'sid-1', status: 'ACTIVE', title: '空的' } });
  const info = await provider.instances.info(ctx, 'sid-1');
  assert.strictEqual(info.ready, false);
  assert.strictEqual(info.why, 'no-sandbox');
  assert.ok(Array.isArray(info.facts) && info.facts.length >= 2);
  assert.ok(info.hint, '要告诉人下一步怎么办');
});

okA('instances.info：有沙箱时给「可见 / 配额」两组容量', async () => {
  const ctx = fakeCtx();
  fakeTransport(ctx, {
    shell: () => ({
      out: [
        'WBSBX_NPROC=2', 'WBSBX_MEMTOTAL_KB=8192000', 'WBSBX_CG=v2',
        'WBSBX_CPU_MAX=400000 100000', 'WBSBX_MEM_MAX=8589934592',
        'WBSBX_DF=31268748 12345678', 'WBSBX_UNAME=Linux 6.6.0 aarch64', 'WBSBX_HOST=nacre-x',
        '', '__WBSBX_RC=0', '__WBSBX_STDERR__',
      ].join('\n'),
    }),
  });
  const info = await provider.instances.info(ctx, 'sid-1');
  assert.strictEqual(info.ready, true);
  assert.strictEqual(info.visible.cpu, 2);
  assert.strictEqual(info.quota.cpu, 4);
  assert.strictEqual(info.visible.memBytes, 8192000 * 1024);
  assert.strictEqual(info.quota.memBytes, 8589934592);
  assert.strictEqual(info.limits.memUnlimited, false);
  assert.ok(info.facts.some((f) => f.label === 'cgroup' && f.value === 'v2'));
});

okA('instances.create：改名 + 记下 model（平台建会话只认空 body）', async () => {
  const ctx = fakeCtx();
  const calls = [];
  const t = transport.createTransport(ctx);
  t.request = async (method, path) => {
    calls.push(method + ' ' + path);
    if (method === 'POST' && path === '/v1/cloudagent/sessions') {
      return { status: 200, headers: new Headers(), json: { status: 'ok', result: { session_id: 'new-1', status: 'ACTIVE' } }, text: '' };
    }
    if (method === 'PUT') return { status: 200, headers: new Headers(), json: { status: 'ok' }, text: '' };
    if (method === 'GET') {
      return { status: 200, headers: new Headers(), json: { result: { session_id: 'new-1', title: 'probe-01', status: 'ACTIVE' } }, text: '' };
    }
    throw new Error('假传输没准备的请求：' + method + ' ' + path);
  };
  const inst = await provider.instances.create(ctx, { name: 'probe-01', model: 'kimi-k3', prompt: '先别动' }, { log: () => {} });
  assert.strictEqual(inst.id, 'new-1');
  assert.strictEqual(inst.name, 'probe-01');
  assert.strictEqual(inst.pendingPrompt, '先别动', '初始指令不能悄悄丢掉');
  assert.ok(calls.includes('PUT /v1/cloudagent/sessions/new-1'), '名字要建完再改一次');
  assert.strictEqual(norm.messageBody(ctx, { id: 'new-1', text: 'x' }).model_id, 'kimi-k3', 'create 时指定的模型要跟着实例');
});

okA('instances.remove：--archive 明确拒绝（本平台只有真删）', async () => {
  const ctx = fakeCtx();
  transport.createTransport(ctx);
  await assert.rejects(
    () => provider.instances.remove(ctx, 'sid-1', { archive: true }),
    (e) => e.code === 'E_UNSUPPORTED' && /归档/.test(e.message)
  );
});

okA('doctor --no-net：一个请求都不发，仍给登录态与提示', async () => {
  const ctx = fakeCtx();
  await auth.importCookies(ctx, COOKIE_STR);
  const t = transport.createTransport(ctx);
  let hit = 0;
  t.request = async () => { hit++; throw new Error('--no-net 不该发请求'); };
  const list = await provider.doctor.checks(ctx, { net: false });
  assert.strictEqual(hit, 0);
  assert.ok(list.some((c) => c.name === '登录态' && c.level === 'ok'));
  assert.ok(list.some((c) => c.name === '网络'), '要明说跳过了什么');
});

okA('doctor：没有登录态直接报 error，也不联网', async () => {
  const ctx = fakeCtx();
  const t = transport.createTransport(ctx);
  let hit = 0;
  t.request = async () => { hit++; throw new Error('不该发请求'); };
  const list = await provider.doctor.checks(ctx, { net: true });
  assert.strictEqual(hit, 0);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].level, 'error');
});

okA('★ agent.history：倒序响应还原成时间顺序（按 message_index），参数是 snake_case', async () => {
  const ctx = fakeCtx();
  const t = transport.createTransport(ctx);
  let page = 0;
  t.request = async (method, path) => {
    page++;
    assert.match(path, /\/messages\?page_num=\d+&page_size=\d+/, '分页参数必须是 page_num/page_size');
    return {
      status: 200, headers: new Headers(), text: '',
      json: {
        total: 3,
        result: page === 1
          ? [{ message_index: 3, content: 'c' }, { message_index: 2, content: 'b' }]   // 服务端是倒序
          : [{ message_index: 1, content: 'a' }],
      },
    };
  };
  const h = await provider.agent.history(ctx, 'sid-1', { pageSize: 50 });
  assert.deepStrictEqual(h.messages.map((m) => m.text), ['a', 'b', 'c']);
  assert.strictEqual(h.total, 3);
  assert.strictEqual(h.nextCursor, null);
});

okA('agent.history：没有 message_index 时按"整体反过来"兜底', async () => {
  const ctx = fakeCtx();
  const t = transport.createTransport(ctx);
  t.request = async () => ({
    status: 200, headers: new Headers(), text: '',
    json: { total: 2, result: [{ content: 'second' }, { content: 'first' }] },
  });
  const h = await provider.agent.history(ctx, 'sid-1', {});
  assert.deepStrictEqual(h.messages.map((m) => m.text), ['first', 'second']);
});

// ---------------------------------------------------------------- 收尾（异步用例在这里统一执行）
(async () => {
  console.log('\n异步用例（登录态读写 / 驱动编排）');
  for (const { name, fn } of asyncQueue) {
    try { await fn(); pass++; console.log('  \u2713 ' + name); }
    catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + (e && e.message)); }
  }

  console.log(`\n${fail ? '\u2717' : '\u2713'} ${pass} 通过${fail ? '，' + fail + ' 失败' : ''}\n`);
  if (fail) {
    console.error('自测失败：上面的 ✗ 是硬问题，别跳过。\n');
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('自测自身出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
