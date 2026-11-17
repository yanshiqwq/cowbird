#!/usr/bin/env node
'use strict';
// 纯离线自检：不联网、不要登录态、不 spawn 进程、不碰真实数据目录。
//
//   node lib/platform/workbuddy/selftest.js
//
// 覆盖的是「照文档写的那些字段映射」里最容易写错、且**不联网也能验**的部分：
//   · cgroup v2 / v1 两种配额解析（含 'max' 与 v1 的无限制哨兵）
//   · 「看得见 vs 真配额」两组数字与告警
//   · ACP → 归一化事件的整张映射表（含历史重放、提问、权限、工具调用）
//   · AskUserQuestion 回填体形状
//   · 会话对象 → Instance 映射
//   · 后台任务 / find 输出 / base64 读取 这些纯解析
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// config.js 在 import 时就把 HOME 算出来了，必须先指到临时目录；
// WBSBX_LOCAL=1 避免 creds 去探测 daemon（那样会等 4 秒网络超时）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wbsbx-wb-selftest-'));
process.env.WB_CLOUD_HOME = TMP;
process.env.WBSBX_LOCAL = '1';
delete process.env.WBSBX_PLATFORM;
delete process.env.WBSBX_PLATFORM_MODULE;

const { CAP, EVENT } = require('../contract');
const registry = require('..');
const config = require('../../config');
const cgroup = require('./cgroup');
const probe = require('./probe');
const events = require('./events');
const instances = require('./instances');
const exec = require('./exec');
const fsops = require('./fsops');
const auth = require('./auth');
const agent = require('./agent');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}
function okAsync(name, fn) {
  return (async () => {
    try { await fn(); pass++; console.log('  \u2713 ' + name); }
    catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + String(e.message).split('\n')[0]); }
  })();
}

// ── 实测样本（脱敏，数值来自 WorkBuddy-平台回查报告 §4）──────────────────────────
const KV_V2 = {                       // A 代：tl4 大容器，nproc 报 32 / 123 GiB，配额 4 核 / 8 GiB
  'cg.mount': 'cgroup2fs',
  'cg.self': '0::/init.scope;',
  'v2.cpu.max': '400000 100000',
  'v2.cpu.stat': 'nr_periods=2626 nr_throttled=5 throttled_usec=1262552 ',
  'v2.mem.max': '8589934592',
  'v2.mem.swap.max': '8589934592',
  'v2.cpuset': '0-31',
  'v1.cfs.quota': '',
  'v1.cfs.period': '',
  'v1.mem.limit': '',
  'v1.cpuset': '',
  'nproc': '32',
  'nproc.all': '32',
  'memtotal.kb': '129306112',        // 126277 MB ≈ 123 GiB
  'free.m': '123302',
  'free.h': '121Gi',
  'df.bytes': '274877906944',        // 256 GiB
  'df.h': '256G',
  host: 'wb-sandbox-01',
  kernel: '6.6.117-45.19.1.tl4.x86_64',
  virt: 'docker',
  uptime: '3 hours, 12 minutes',
  'uptime.sec': '11520',
  'cpu.model': 'AMD EPYC 9K65 192-Core Processor',
  pid1: '/sbin/docker-init -- bash -c mkdir -p /workspace;',
  'space.yaml': 'cpu: 4 mem: 8Gi region: ap-guangzhou ',
};

const KV_V1 = {                       // B 代：Cube 微 VM，v1 cgroup，nproc 与配额基本一致
  'cg.mount': 'tmpfs',
  'cg.self': '2:cpu:/default/cubebox-1234_1;',
  'v2.cpu.max': '',
  'v2.cpu.stat': '',
  'v2.mem.max': '',
  'v2.mem.swap.max': '',
  'v2.cpuset': '',
  'v1.cfs.quota': '400000',
  'v1.cfs.period': '100000',
  'v1.mem.limit': '8589934592',
  'v1.cpuset': '',
  'nproc': '5',
  'nproc.all': '5',
  'memtotal.kb': '8570964',
  'free.m': '8369',
  'free.h': '8.2Gi',
  'df.bytes': '134217728000',
  'df.h': '125G',
  host: 'wb-sandbox-02',
  kernel: '6.6.69-cube.bm.guest.005.x-g039db8913c80',
  virt: 'docker',
  uptime: '12 minutes',
  'uptime.sec': '720',
  'cpu.model': 'AMD EPYC 9K65 192-Core Processor',
  pid1: '/.PlnPyKFp4CRfFtgC1/bin/supervisord -c /etc/supervisord.conf',
  'space.yaml': 'cpu: 4 mem: 8Gi region: ap-guangzhou ',
};

console.log('\ncgroup 解析（v2 / v1 两代各一例）');

ok('v2：cpu.max "400000 100000" → 4 核；memory.max → 8 GiB', () => {
  const s = probe.summarize(KV_V2);
  assert.strictEqual(s.quota.cgroupVersion, 'v2');
  assert.strictEqual(s.quota.cpu, 4);
  assert.strictEqual(s.quota.cpuQuotaUs, 400000);
  assert.strictEqual(s.quota.cpuPeriodUs, 100000);
  assert.strictEqual(s.quota.cpuText, '400000 100000');
  assert.strictEqual(s.quota.memBytes, 8589934592);
  assert.strictEqual(s.quota.cpuset, '0-31');
  assert.strictEqual(s.quota.swapBytes, 8589934592);
});

ok('v2：可见资源是宿主的（32 核 / 123 GiB / 256G），必须与配额同时返回', () => {
  const s = probe.summarize(KV_V2);
  assert.strictEqual(s.visible.cpu, 32);
  assert.strictEqual(s.visible.cpuAll, 32);
  assert.strictEqual(s.visible.memBytes, 129306112 * 1024);
  assert.strictEqual(s.visible.freeM, 123302);
  assert.strictEqual(s.visible.memText, '121Gi');
  assert.strictEqual(s.visible.diskBytes, 274877906944);
  assert.strictEqual(s.visible.diskText, '256G');
  assert.ok(s.visible.cpu > s.quota.cpu, '这正是「nproc 会说谎」的核心');
});

ok('v2：两句告警都要出（nproc 撒谎 + 已被限流），facts 里配额写 "4 核"', () => {
  const s = probe.summarize(KV_V2);
  assert.ok(s.warnings.some((w) => /nproc 报 32 核/.test(w)), s.warnings.join(' | '));
  assert.ok(s.warnings.some((w) => /限流过 5 次/.test(w)), s.warnings.join(' | '));
  assert.strictEqual(s.quota.throttled.throttled, 5);
  assert.strictEqual(s.quota.throttled.throttledUsec, 1262552);
  const cpuFact = s.facts.find((f) => f.label === 'CPU 配额');
  assert.strictEqual(cpuFact.value, '4 核');
  const memFact = s.facts.find((f) => f.label === '内存配额');
  assert.strictEqual(memFact.value, '8 GiB');
  assert.strictEqual(s.quota.spaceYaml.memBytes, 8 * 1024 ** 3, 'space.yaml 与 cgroup 应互相印证');
});

ok('v1：cpu.cfs_quota_us/period + memory.limit_in_bytes → 4 核 / 8 GiB', () => {
  const s = probe.summarize(KV_V1);
  assert.strictEqual(s.quota.cgroupVersion, 'v1');
  assert.strictEqual(s.quota.cpu, 4);
  assert.strictEqual(s.quota.cpuQuotaUs, 400000);
  assert.strictEqual(s.quota.memBytes, 8589934592);
  assert.strictEqual(s.visible.cpu, 5);
  assert.strictEqual(s.visible.memBytes, 8570964 * 1024);
  // 内存可见 8.17 GiB 与配额 8 GiB 差 2%，不该报「撒谎」告警
  assert.ok(!s.warnings.some((w) => /meminfo/.test(w)), s.warnings.join(' | '));
  assert.strictEqual(s.quota.throttled, null, 'v1 没有 cpu.stat 可读，不该编一个出来');
});

ok("v2 'max' 与 v1 无限制哨兵都当「不限」，别当成 0 或 8 EiB", () => {
  const max = cgroup.parseCpuMax('max 100000');
  assert.strictEqual(max.unlimited, true);
  assert.strictEqual(max.cores, null);

  const memMax = cgroup.parseMemoryMax('max');
  assert.strictEqual(memMax.unlimited, true);
  assert.strictEqual(memMax.bytes, null);

  const v1 = cgroup.parseMemoryMax(String(cgroup.V1_MEM_UNLIMITED), { v1: true });
  assert.strictEqual(v1.unlimited, true);
  assert.strictEqual(v1.bytes, null);

  const cfs = cgroup.parseCfsQuota('-1', '100000');
  assert.strictEqual(cfs.unlimited, true);
  assert.strictEqual(cfs.cores, null);
});

ok('读不到 cgroup 时给告警，而不是假装 0 核', () => {
  const s = probe.summarize({ nproc: '5', 'memtotal.kb': '8570964' });
  assert.strictEqual(s.quota.cpu, null);
  assert.strictEqual(s.quota.cgroupVersion, null);
  assert.ok(s.warnings.some((w) => /读不到 cgroup CPU 配额/.test(w)), s.warnings.join(' | '));
});

ok('fmtBytes / parseSize：8 GiB 不带小数点，123.3 GiB 带一位', () => {
  assert.strictEqual(cgroup.fmtBytes(8589934592), '8 GiB');
  assert.strictEqual(cgroup.fmtBytes(129306112 * 1024), '123.3 GiB');
  assert.strictEqual(cgroup.fmtBytes(null), null);
  assert.strictEqual(cgroup.parseSize('8Gi'), 8 * 1024 ** 3);
  assert.strictEqual(cgroup.parseSize('512Mi'), 512 * 1024 ** 2);
  assert.strictEqual(cgroup.parseSize('8589934592'), 8589934592);
  assert.strictEqual(cgroup.parseSize('乱写'), null);
});

ok('探针脚本一条命令覆盖 v2/v1/可见资源，且值走 $(...) 不写死', () => {
  const sh = probe.buildProbeScript();
  for (const need of ['/sys/fs/cgroup/cpu.max', 'cpu.cfs_quota_us', 'memory.limit_in_bytes',
    'cpuset.cpus.effective', 'nproc', 'free -m', 'df -P -B1 /', 'space.yaml']) {
    assert.ok(sh.includes(need), '探针缺 ' + need);
  }
  for (const key of probe.KEYS) assert.ok(sh.includes(key + '='), '探针缺键 ' + key);
  assert.ok(!/\$\{[a-z]/i.test(sh), '不该有 JS 模板插值残留');
  // locale 必须钉死：zh_CN 下 free 打印「内存：」，按 /^Mem:/ 匹配会静默拿到空值（真踩过）
  assert.ok(/^export LC_ALL=C LANG=C$/m.test(sh), '探针必须先 export LC_ALL=C');
  // 解析侧：一行一个 key=value
  assert.deepStrictEqual(probe.parseKv('a=1\nb=x=y\n\nc='), { a: '1', b: 'x=y', c: '' });
});

ok('真机上常见的「不限配额」形态（cpu.max=max / memory.max=max）不会被误报', () => {
  // 样本取自本机 WSL 的真实输出（cgroup v2，无配额限制）
  const s = probe.summarize({
    'cg.mount': 'cgroup2fs', 'cg.self': '0::/non-systemd;',
    'v2.cpu.max': 'max 100000', 'v2.cpu.stat': 'usage_usec=35498 nr_periods=0 nr_throttled=0 ',
    'v2.mem.max': 'max', 'v2.mem.swap.max': 'max', 'v2.cpuset': '0-23',
    nproc: '24', 'nproc.all': '24', 'memtotal.kb': '57586248',
    'free.m': '56236', 'free.h': '54Gi', 'df.bytes': '1081101176832', 'df.h': '1007G',
    host: 'wsl', kernel: '6.18.0-microsoft-standard-WSL2', virt: 'wsl',
  });
  assert.strictEqual(s.quota.cpuUnlimited, true);
  assert.strictEqual(s.quota.cpu, null);
  assert.strictEqual(s.quota.memUnlimited, true);
  assert.deepStrictEqual(s.warnings, [], '不限配额时不该有任何「撒谎」告警');
  assert.strictEqual(s.facts.find((f) => f.label === 'CPU 配额').value, '不限');
  assert.strictEqual(s.facts.find((f) => f.label === '内存配额').value, '不限');
  assert.ok(!s.facts.some((f) => /已被限流/.test(f.label)), '限流 0 次不该占一行');
});

console.log('\nACP → 归一化事件');

const U = (update) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } });
const kinds = (m, opts) => events.mapMessage(m, opts).map((e) => e.kind);

ok('session/update 带 _meta.status → status', () => {
  const m = U({ sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai': { status: 'working' } } });
  const ev = events.mapMessage(m);
  assert.deepStrictEqual(ev.map((e) => e.kind), [EVENT.STATUS]);
  assert.strictEqual(ev[0].data.status, 'working');
});

ok('agent_message_chunk → text；agent_thought_chunk → thinking', () => {
  const t = events.mapMessage(U({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } }));
  assert.deepStrictEqual(t, [{ kind: EVENT.TEXT, data: { text: '你好' } }]);

  const th = events.mapMessage(U({ sessionUpdate: 'agent_thought_chunk', content: [{ type: 'text', text: '想一想' }] }));
  assert.deepStrictEqual(th, [{ kind: EVENT.THINKING, data: { text: '想一想' } }]);
});

ok('工具调用：tool_call → tool；tool_call_update completed/failed → tool_result', () => {
  const call = events.mapMessage(U({ sessionUpdate: 'tool_call', toolCallId: 'c1', toolName: 'Bash', rawInput: { cmd: 'ls' } }));
  assert.strictEqual(call[0].kind, EVENT.TOOL);
  assert.deepStrictEqual(call[0].data, { id: 'c1', name: 'Bash', input: { cmd: 'ls' } });

  const done = events.mapMessage(U({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', toolName: 'Bash', status: 'completed', rawOutput: 'ok' }));
  assert.strictEqual(done[0].kind, EVENT.TOOL_RESULT);
  assert.deepStrictEqual(done[0].data, { id: 'c1', name: 'Bash', ok: true, out: 'ok' });

  const bad = events.mapMessage(U({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', toolName: 'Edit', status: 'failed' }));
  assert.strictEqual(bad[0].data.ok, false);

  const running = events.mapMessage(U({ sessionUpdate: 'tool_call_update', toolCallId: 'c3', toolName: 'Bash', status: 'in_progress' }));
  assert.strictEqual(running[0].kind, EVENT.TOOL, '还在跑的工具更新仍是 tool（带 status）');
  assert.strictEqual(running[0].data.status, 'in_progress');
});

ok('提问请求 → question（带 requestId 与选项）；权限请求 → permission', () => {
  const q = events.mapMessage({
    jsonrpc: '2.0', id: 7, method: '_codebuddy.ai/question',
    params: { schema: { questions: [{ id: 'q1', header: '继续吗', question: '要继续？', options: [{ label: '是', description: '继续做' }, { label: '否' }] }] } },
  });
  assert.strictEqual(q[0].kind, EVENT.QUESTION);
  assert.strictEqual(q[0].data.requestId, 7);
  assert.strictEqual(q[0].data.questions[0].header, '继续吗');
  assert.strictEqual(q[0].data.questions[0].id, 'q1');
  assert.strictEqual(q[0].data.questions[0].options[0].label, '是');
  assert.strictEqual(q[0].data.questions[0].options[0].description, '继续做');

  const p = events.mapMessage({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { toolCall: { toolName: 'Bash' } } });
  assert.strictEqual(p[0].kind, EVENT.PERMISSION);
  assert.strictEqual(p[0].data.requestId, 9);
  assert.strictEqual(p[0].data.tool, 'Bash');
});

ok('session/endTurn → done；其它未知方法 → raw（带 raw 原对象）', () => {
  assert.deepStrictEqual(kinds({ jsonrpc: '2.0', method: 'session/endTurn' }), [EVENT.DONE]);
  const odd = { jsonrpc: '2.0', method: '_codebuddy.ai/artifact', params: { event: 'created' } };
  const raws = events.mapMessage(odd);
  assert.deepStrictEqual(raws.map((e) => e.kind), [EVENT.RAW]);
  assert.deepStrictEqual(raws[0].data.raw, odd);
});

ok('历史重放（mode=history）：默认跳过，includeHistory 时降级成 raw + history:true', () => {
  const replay = U({ sessionUpdate: 'agent_message_chunk', content: { text: '上次说过的话' }, _meta: { 'codebuddy.ai': { mode: 'history', offset: 3 } } });
  assert.deepStrictEqual(events.mapMessage(replay), [], '绝不能把历史重放当成新消息');
  const asRaw = events.mapMessage(replay, { includeHistory: true });
  assert.strictEqual(asRaw.length, 1);
  assert.strictEqual(asRaw[0].kind, EVENT.RAW);
  assert.strictEqual(asRaw[0].data.history, true);
  assert.strictEqual(asRaw[0].data.raw.params.update.content.text, '上次说过的话');
});

ok('同一状态跟着每个内容块重复出现时，mapMessage 不做去重（去重在 stream 层）', () => {
  const m = U({ sessionUpdate: 'agent_message_chunk', content: { text: 'x' }, _meta: { 'codebuddy.ai': { status: 'working' } } });
  assert.deepStrictEqual(kinds(m), [EVENT.STATUS, EVENT.TEXT]);
});

ok('usage：见到就转，见不到不编', () => {
  const withUsage = events.mapMessage({ jsonrpc: '2.0', method: 'session/endTurn', params: { usage: { inputTokens: 10, outputTokens: 5 } } });
  const u = withUsage.find((e) => e.kind === EVENT.USAGE);
  assert.deepStrictEqual(u.data, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.strictEqual(events.mapMessage({ jsonrpc: '2.0', method: 'session/endTurn' }).some((e) => e.kind === EVENT.USAGE), false);
});

console.log('\nAskUserQuestion 回填');

ok('submitted：answers 用 question id 当键，值一律是数组', () => {
  const body = events.buildAnswerResult({ requestId: 7, answers: { q1: '是', q2: ['A', 'B'] } });
  assert.deepStrictEqual(body, {
    jsonrpc: '2.0', id: 7,
    result: { outcome: 'submitted', answers: { q1: ['是'], q2: ['A', 'B'] } },
  });
});

ok('位置式 answers（数组）按题目顺序对齐到 question id', () => {
  const body = events.buildAnswerResult({ requestId: 8, answers: ['是', '否'], questionIds: ['q1', 'q2'] });
  assert.deepStrictEqual(body.result.answers, { q1: ['是'], q2: ['否'] });
});

ok('取消：{"outcome":"cancelled","reason":...}', () => {
  const body = events.buildAnswerResult({ requestId: 9, outcome: 'cancelled', reason: 'user interrupt' });
  assert.deepStrictEqual(body, { jsonrpc: '2.0', id: 9, result: { outcome: 'cancelled', reason: 'user interrupt' } });
});

ok('权限：选了选项给 selected+optionId，没选就给 cancelled（形状未验证，至少别装成功）', () => {
  const sel = events.buildAnswerResult({ requestId: 10, kind: 'permission', answers: { optionId: 'allow' } });
  assert.deepStrictEqual(sel.result, { outcome: 'selected', optionId: 'allow' });
  const cancel = events.buildAnswerResult({ requestId: 11, kind: 'permission' });
  assert.strictEqual(cancel.result.outcome, 'cancelled');
});

ok('模型列表深度扫描（session/load 回执里带 availableModels）', () => {
  const frame = { jsonrpc: '2.0', id: 900002, result: { models: { _meta: { 'codebuddy.ai': { availableModels: [{ id: 'hy4free' }] } } } } };
  assert.deepStrictEqual(events.findAvailableModels(frame), [{ id: 'hy4free' }]);
  assert.strictEqual(events.findAvailableModels({ result: {} }), null);
});

console.log('\n实例与控制面映射');

ok('会话对象 → Instance {id,name,status,updatedAt,extra}', () => {
  const conv = {
    // id 一定要当字符串：2120000000000000000 > 2^53，写成 JSON 数字会丢精度
    id: '2120000000000000000', name: 'wb-sandbox-01', status: 'completed', sessionStatus: 'running',
    lastActivityAt: '2026-11-17T09:00:00.000Z', sandboxId: 'sbx-1', link: 'https://65225-1.workbuddy.agentos-worker.net/acp',
    runtimeId: '2120000000000000000', acpBackend: 'sandbox_gateway', conversationOrigin: 'agents',
    isPlayground: false, manifest: { id: 'default-codebuddy-agent', model: 'hy4free' },
  };
  const i = instances.mapConversation(conv);
  assert.strictEqual(i.id, '2120000000000000000');
  assert.strictEqual(i.name, 'wb-sandbox-01');
  assert.strictEqual(i.status, 'completed');
  assert.strictEqual(i.updatedAt, '2026-11-17T09:00:00.000Z');
  assert.strictEqual(i.extra.sessionStatus, 'running');
  assert.strictEqual(i.extra.sandboxId, 'sbx-1');
  assert.strictEqual(i.extra.model, 'hy4free');
  assert.strictEqual(i.extra.agentId, 'default-codebuddy-agent');
});

ok('没有名字时留空串（服务端改名是异步的，别把 undefined 传下去）', () => {
  const i = instances.mapConversation({ id: '1', title: '', status: null });
  assert.strictEqual(i.name, '');
  assert.strictEqual(i.status, null);
  assert.strictEqual(i.updatedAt, null);
  assert.strictEqual(instances.mapConversation(null), null);
});

ok('archived 放在顶层（wbsbx ls 按 x.archived 过滤），expiry 只读本地 token 缓存', () => {
  assert.strictEqual(instances.mapConversation({ id: '1', archived: true }).archived, true);
  assert.strictEqual(instances.mapConversation({ id: '1' }).archived, false);

  assert.strictEqual(instances.expiry({}, 'nope'), null, '没有缓存时给 null，别编一个到期时间');
  config.writeToken('42', { token: 't', sandboxId: 's', expireAt: 1795133007 });
  assert.strictEqual(instances.expiry({}, '42'), 1795133007, 'ui.til() 收的是 epoch 秒');
});

console.log('\nexec / fs 纯解析');

ok('timeoutMs → E2B 的秒：默认上限、超限截断、非法值兜底', () => {
  assert.strictEqual(exec.timeoutSeconds(30000), 30);
  assert.strictEqual(exec.timeoutSeconds(600000), 60, '超过 E2B 的 60s 天花板要截断');
  assert.strictEqual(exec.timeoutSeconds(0), 60);
  assert.strictEqual(exec.timeoutSeconds('abc'), 60);
  assert.strictEqual(exec.timeoutSeconds(100), 1, '最小 1 秒');
});

ok('后台任务：非法 jobId 直接拒绝（它会被拼进 shell）', () => {
  assert.throws(() => exec.jobPaths('job-1; rm -rf /'), /非法 jobId/);
  const p = exec.jobPaths('job-abc123');
  assert.strictEqual(p.outputPath, '/workspace/.wbsbx/jobs/job-abc123.log');
  assert.strictEqual(p.exitPath, '/workspace/.wbsbx/jobs/job-abc123.exit');
});

ok('poll 输出解析：done / running / missing 三态，退出码空串不算 0', () => {
  const done = exec.parsePollOutput('__WBSBX_STATE__=done:0\n__WBSBX_LOG__\nhello\n');
  assert.deepStrictEqual([done.done, done.state, done.code, done.out], [true, 'done', 0, 'hello\n']);

  const bg = exec.parsePollOutput('__WBSBX_STATE__=running:4242\n__WBSBX_LOG__\nworking…\n');
  assert.deepStrictEqual([bg.done, bg.pid, bg.code], [false, 4242, null]);

  const missing = exec.parsePollOutput('__WBSBX_STATE__=missing:\n__WBSBX_LOG__\n');
  assert.deepStrictEqual([missing.done, missing.state], [false, 'missing']);

  const racy = exec.parsePollOutput('__WBSBX_STATE__=done:\n__WBSBX_LOG__\n');
  assert.strictEqual(racy.done, false, '退出码还没落盘时不能报 done/code=0');
});

ok('find 输出 → FileEntry（类型/大小/mtime），并认出 ERR/CNT 控制行', () => {
  const out = [
    'f\t12\t1763366400.1234000000\thello.txt',
    'd\t4096\t1763366401.0000000000\tsub',
    'l\t7\t1763366402.5000000000\tlink -> a\ttabbed',
    'CNT\t3',
  ].join('\n');
  const p = fsops.parseFindOutput(out, '/workspace');
  assert.strictEqual(p.count, 3);
  assert.strictEqual(p.error, null);
  assert.strictEqual(p.entries[0].path, '/workspace/hello.txt');
  assert.strictEqual(p.entries[0].type, 'file');
  assert.strictEqual(p.entries[0].size, 12);
  assert.strictEqual(p.entries[0].mtime, new Date(1763366400123).toISOString());
  assert.strictEqual(p.entries[1].type, 'dir');
  assert.strictEqual(p.entries[1].size, null);
  assert.strictEqual(p.entries[2].type, 'link');
  assert.strictEqual(p.entries[2].name, 'link -> a\ttabbed', '名字里的 tab 要拼回去');

  const err = fsops.parseFindOutput('ERR\t路径不存在或不是目录\n', '/nope');
  assert.match(err.error, /路径不存在/);
});

ok('read 输出解析：大小在前、base64 在后（空文件也不会被当成不存在）', () => {
  const empty = fsops.parseReadOutput('__WBSBX_SIZE__=0\n');
  assert.deepStrictEqual(empty, { size: 0, b64: '' });
  const notFound = fsops.parseReadOutput('__WBSBX_SIZE__=-1\n');
  assert.strictEqual(notFound.size, -1);
  const body = Buffer.from('hi\n').toString('base64');
  const r = fsops.parseReadOutput(`__WBSBX_SIZE__=3\n${body}`);
  assert.strictEqual(r.size, 3);
  assert.strictEqual(Buffer.from(r.b64, 'base64').toString('utf8'), 'hi\n');
});

ok('env 归一：对象与 K=V 数组都吃，值统一成字符串', () => {
  assert.deepStrictEqual(exec.normalizeEnv({ A: 1, B: null }), { A: '1', B: '' });
  assert.deepStrictEqual(exec.normalizeEnv(['A=1', 'B=x=y', 'bad']), { A: '1', B: 'x=y' });
  assert.deepStrictEqual(exec.normalizeEnv(null), {});
});

console.log('\n登录态');

ok('loginArgv：--import / --max-wait 只在需要时出现', () => {
  assert.deepStrictEqual(auth.loginArgv({}), []);
  assert.deepStrictEqual(auth.loginArgv({ import: true }), ['--import']);
  assert.deepStrictEqual(auth.loginArgv({ import: true, maxWaitMin: 30 }), ['--import', '--max-wait', '30']);
  assert.deepStrictEqual(auth.loginArgv({ maxWaitMin: 'x' }), []);
});

ok('ttlDays 传的是 cookie 数组（没登录态时给 null，而不是 0）', () => {
  assert.strictEqual(auth.ttlDays(null), null);
  assert.strictEqual(auth.ttlDays({ cookies: [] }), null);
  const ttl = auth.ttlDays({ cookies: [{ name: 'session', value: 'x', expires: Date.now() / 1000 + 86400 * 3 }] });
  assert.ok(ttl > 2.9 && ttl < 3.1, '约 3 天，实际 ' + ttl);
});

console.log('\nprovider 形状（defineProvider 校验过）');

const p = registry.use('workbuddy');

ok('id / displayName / 能力位与任务书一致', () => {
  assert.strictEqual(p.id, 'workbuddy');
  assert.ok(p.displayName);
  for (const c of [CAP.AUTH, CAP.AUTH_RENEW, CAP.LOGIN_BROWSER, CAP.LIST, CAP.CREATE, CAP.RENAME,
    CAP.REMOVE, CAP.META, CAP.AGENT, CAP.AGENT_QUESTION, CAP.AGENT_INTERRUPT, CAP.EXEC, CAP.EXEC_BG,
    CAP.FS, CAP.MODEL]) {
    assert.ok(p.has(c), '缺能力 ' + c);
  }
});

ok('没声明 exec.wake（WorkBuddy 没有唤醒接口，别误导内核），但方法仍在', () => {
  assert.strictEqual(p.has(CAP.WAKE), false);
  assert.strictEqual(typeof p.exec.wake, 'function');
  assert.throws(() => p.require(CAP.WAKE), (e) => e.code === 'E_CAPABILITY');
});

ok('契约要求的方法一个都不缺', () => {
  for (const [mod, methods] of [
    ['auth', ['state', 'ttlDays', 'login', 'renew']],
    ['instances', ['list', 'get', 'create', 'rename', 'remove', 'info']],
    ['agent', ['stream', 'send', 'answer', 'interrupt', 'history']],
    ['exec', ['probe', 'run', 'start', 'poll', 'put', 'get']],
    ['fs', ['list', 'read', 'write']],
    ['model', ['list', 'current']],
  ]) {
    for (const m of methods) assert.strictEqual(typeof p[mod][m], 'function', `缺 ${mod}.${m}()`);
  }
  assert.strictEqual(typeof p.doctor.checks, 'function');
});

ok('limits：同步 60s（E2B 天花板）、支持后台、输出 1 MiB', () => {
  assert.strictEqual(p.limits.maxSyncMs, 60000);
  assert.strictEqual(p.limits.defaultSyncMs, 60000);
  assert.strictEqual(p.limits.maxBackground, true);
  assert.strictEqual(p.limits.maxOutputBytes, 1 << 20);
});

(async () => {
  // ── 假 ACP 连接：把「回调 → async generator」这条最容易写错的桥离线跑通 ──────────
  const allFake = [];
  function fakeAcpFactory(spec = {}) {
    class FakeAcp {
      constructor(creds, opts) {
        this.creds = creds;
        this.opts = opts;
        this.connId = 'conn-test';
        this.posted = [];
        this.prompted = null;
        this.aborted = false;
        this.closed = false;
        this._ac = { abort: () => { this.aborted = true; if (this._release) this._release(); } };
        allFake.push(this);
      }
      async connect() { return { status: 200, text: async () => '' }; }
      async loop() {
        const emit = (m) => { if (!this.aborted && this.opts.onEvent) this.opts.onEvent(m); };
        for (const m of spec.events || []) emit(m);
        if (!spec.gate) return;
        await new Promise((res) => { this._release = res; });
        if (this.aborted) return;
        for (const m of spec.afterGate || []) emit(m);
      }
      async prompt(t) { this.prompted = t; return { status: 200, text: '' }; }
      async post(b) { this.posted.push(b); return { status: 200, text: '' }; }
      async close() { this.closed = true; }
    }
    return (creds, opts) => new FakeAcp(creds, opts);
  }
  const FAKE_CREDS = { token: 't', link: 'https://fake/acp', sessionId: 'inst-1' };
  const hist = (text, su = 'agent_message_chunk') => U({ sessionUpdate: su, content: { text }, _meta: { 'codebuddy.ai': { mode: 'history' } } });

  console.log('\nACP 流（假连接，纯离线）');

  await okAsync('stream：历史重放跳过、状态去重、提问交给上层、endTurn 收工', async () => {
    allFake.length = 0;
    const factory = fakeAcpFactory({
      gate: true,
      events: [
        hist('历史里的旧话'),
        U({ sessionUpdate: 'session_info_update', _meta: { 'codebuddy.ai': { status: 'working' } } }),
        U({ sessionUpdate: 'agent_message_chunk', content: { text: '你好' }, _meta: { 'codebuddy.ai': { status: 'working' } } }),
        { jsonrpc: '2.0', id: 42, method: '_codebuddy.ai/question', params: { schema: { questions: [{ id: 'q1', header: '继续吗', options: [{ label: '是' }] }] } } },
      ],
      afterGate: [{ jsonrpc: '2.0', method: 'session/endTurn' }],
    });
    const it = agent.stream({ log: () => {} }, 'inst-1', {
      creds: FAKE_CREDS, acpFactory: factory, text: '帮我看看', settleMs: 0,
    });

    const seen = [];
    let question = null;
    for (;;) {
      const step = await it.next();
      if (step.done) break;
      seen.push(step.value);
      if (step.value.kind === EVENT.QUESTION) { question = step.value; break; }
    }
    assert.ok(question, '应收到提问事件');
    assert.strictEqual(question.data.requestId, 42);
    assert.strictEqual(question.data.questions[0].id, 'q1');
    assert.ok(!seen.some((e) => e.kind === EVENT.TEXT && /历史/.test(e.data.text)), '历史重放不能当新消息');
    assert.strictEqual(seen.filter((e) => e.kind === EVENT.STATUS).length, 2, 'connected + working（同一状态只报一次）');
    assert.strictEqual(allFake[0].prompted, '帮我看看');
    assert.strictEqual(agent.LIVE.has('inst-1'), true);

    // 活着的时候回答：必须回到同一条连接上（提问是绑在它上面的）
    const ans = await agent.answer({ log: () => {} }, 'inst-1', { requestId: 42, answers: { q1: '是' } });
    assert.strictEqual(ans.ok, true);
    assert.strictEqual(ans.via, 'live-connection');
    assert.deepStrictEqual(allFake[0].posted[0], {
      jsonrpc: '2.0', id: 42, result: { outcome: 'submitted', answers: { q1: ['是'] } },
    });

    allFake[0]._release();
    let done = null;
    for (;;) {
      const step = await it.next();
      if (step.done) break;
      seen.push(step.value);
      if (step.value.kind === EVENT.DONE) done = step.value;
    }
    assert.ok(done, '应以 done 结尾');
    assert.strictEqual(done.data.reason, 'endTurn');
    assert.strictEqual(seen.filter((e) => e.kind === EVENT.DONE).length, 1, 'done 只能有一条');
    assert.strictEqual(agent.LIVE.has('inst-1'), false, '结束后必须注销 LIVE');
  });

  await okAsync('stream：idleTimeoutMs 到点收工（不让内核挂在一条不说话的连接上）', async () => {
    allFake.length = 0;
    const factory = fakeAcpFactory({
      gate: true,
      events: [U({ sessionUpdate: 'agent_message_chunk', content: { text: '先说一句' } })],
    });
    const seen = [];
    for await (const ev of agent.stream({ log: () => {} }, 'inst-3', {
      creds: FAKE_CREDS, acpFactory: factory, idleTimeoutMs: 80,
    })) seen.push(ev);
    assert.ok(seen.some((e) => e.kind === EVENT.TEXT));
    const last = seen[seen.length - 1];
    assert.strictEqual(last.kind, EVENT.DONE);
    assert.strictEqual(last.data.reason, 'idle-timeout');
    assert.strictEqual(agent.LIVE.has('inst-3'), false, '超时收工也要注销 LIVE');
  });

  await okAsync('stream：连不上时给 error + done(error)，不把异常抛给调用方', async () => {
    const factory = () => ({
      connId: null,
      connect: async () => { throw new Error('bootstrap boom'); },
      close: async () => {},
    });
    const seen = [];
    for await (const ev of agent.stream({ log: () => {} }, 'inst-4', { creds: FAKE_CREDS, acpFactory: factory })) seen.push(ev);
    assert.deepStrictEqual(seen.map((e) => e.kind), [EVENT.ERROR, EVENT.DONE]);
    assert.match(seen[0].data.message, /bootstrap boom/);
    assert.strictEqual(seen[1].data.reason, 'error');
    assert.strictEqual(agent.LIVE.has('inst-4'), false);
  });

  await okAsync('answer：没有活动连接时另开一条回，且如实标 verified:false', async () => {
    allFake.length = 0;
    const factory = fakeAcpFactory({ gate: false, events: [] });
    const r = await agent.answer({ log: () => {} }, 'inst-2', {
      creds: FAKE_CREDS, acpFactory: factory, requestId: 77, answers: ['是'],
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.via, 'fresh-connection');
    assert.strictEqual(r.verified, false);
    assert.deepStrictEqual(allFake[0].posted[0].result, { outcome: 'submitted', answers: { 0: ['是'] } });
  });

  await okAsync('interrupt：没有挂起提问时如实说 unsupported，不假装成功', async () => {
    const r = await agent.interrupt({ log: () => {} }, 'inst-2', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'unsupported');
  });

  await okAsync('history：只收 mode=history 的重放，连续块按角色合并', async () => {
    allFake.length = 0;
    const factory = fakeAcpFactory({
      gate: false,
      events: [
        hist('你好', 'user_message_chunk'),
        hist('你', 'agent_message_chunk'),
        hist('好', 'agent_message_chunk'),
        U({ sessionUpdate: 'agent_message_chunk', content: { text: '实时事件不该进历史' } }),
      ],
    });
    const h = await agent.history({ log: () => {} }, 'inst-1', { creds: FAKE_CREDS, acpFactory: factory, maxWaitMs: 50 });
    assert.deepStrictEqual(h.messages, [{ role: 'user', text: '你好' }, { role: 'agent', text: '你好' }]);
    assert.strictEqual(h.nextCursor, null);
  });

  await okAsync('doctor 离线可跑（不联网、不开浏览器；level 用内核的 ok/warn/bad/info）', async () => {
    const checks = await p.doctor.checks({ log: () => {} });
    assert.ok(Array.isArray(checks) && checks.length >= 3);
    for (const c of checks) assert.ok(['ok', 'warn', 'bad', 'info'].includes(c.level), 'level 非法：' + c.level);
    assert.ok(checks.some((c) => /登录态/.test(c.name)));
    // 临时 HOME 里没有 state.json，所以登录态那条必须是 bad（bad 会渲染成 ✗）
    const login = checks.find((c) => /登录态/.test(c.name));
    assert.strictEqual(login.level, 'bad', '没有登录态时应报 bad');
  });

  await okAsync('exec.probe 在没有登录态时返回 ready:false 而不是抛错', async () => {
    const r = await p.exec.probe({ log: () => {} }, '123');
    assert.strictEqual(r.ready, false);
    assert.ok(r.error && /登录态|401/.test(r.error), String(r.error));
  });

  await okAsync('instances.list 没有登录态时抛明确的错（而不是返回空数组）', async () => {
    await assert.rejects(() => p.instances.list({ log: () => {} }), /登录态|401/);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  console.log(`\n${fail ? '\u2717' : '\u2713'} ${pass} 通过${fail ? '，' + fail + ' 失败' : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自检自身出错：' + e.stack);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
