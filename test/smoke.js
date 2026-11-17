#!/usr/bin/env node
// 离线冒烟测试：不联网、不需要登录态、不碰真实数据目录。
//
//   node test/smoke.js        （或 npm test）
//
// 覆盖的是"改坏了会被立刻发现"的那部分纯逻辑：
// 参数解析、cookie jar 的合并规则、401 不写盘、帧解析、会话名匹配、表格对齐。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// ⚠ 必须在 require 任何读配置的模块之前设好：config.js 在 import 时就把 HOME 算出来了。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cowbird-smoke-'));
process.env.COWBIRD_HOME = TMP;
process.env.COWBIRD_LOCAL = '1';        // 不探测 daemon，避免 4 秒网络超时

const args = require('../lib/args');
const ui = require('../lib/ui');
const cfg = require('../lib/config');
const tokenStore = require('../lib/platform/workbuddy/token-store');
const tokenCache = require('../lib/platform/workbuddy/lib/token-cache');
const e2b = require('../lib/platform/workbuddy/lib/e2b');
const resolve = require('../lib/resolve');
const { Keepalive } = require('../lib/platform/workbuddy/lib/keepalive');
const { runHeal, normalizeTargets } = require('../lib/daemon/heal');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}

// 造一个假的 fetch 响应：只实现 session.http 真正用到的两个成员
function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const hdr = Buffer.alloc(5);
  hdr[0] = 0;
  hdr.writeUInt32BE(payload.length, 1);
  return Buffer.concat([hdr, payload]);
}

(async () => {
  console.log('\nargs');
  ok('布尔 / 取值 / 短别名', () => {
    const a = args.parse(['x', '--flag', '--k=v', '--n', '5', '-f'], { flags: ['flag'], values: ['k', 'n'], aliases: { f: 'flag' } });
    assert.deepStrictEqual(a._, ['x']);
    assert.deepStrictEqual(a.opts, { flag: true, k: 'v', n: '5' });
  });
  ok('未知选项要报错', () => {
    assert.throws(() => args.parse(['-la'], {}), /未知选项/);
  });
  ok('stopAfter: 实例之后的内容原样收下（exec 01 ls -la 能用）', () => {
    const a = args.parse(['01', 'ls', '-la', '/etc'], { stopAfter: 1 });
    assert.deepStrictEqual(a._, ['01', 'ls', '-la', '/etc']);
  });
  ok('stopAfter 之前的选项仍被解析', () => {
    const a = args.parse(['--timeout', '30', '01', 'sleep', '--json'], { values: ['timeout'], stopAfter: 1 });
    assert.strictEqual(a.opts.timeout, '30');
    assert.deepStrictEqual(a._.slice(1), ['sleep', '--json']);
  });

  console.log('\n登录态（只有 accessToken 一条路）');
  ok('token 有效性：有到期时间就比时间，没给就当它有效', () => {
    const now = Math.floor(Date.now() / 1000);
    assert.strictEqual(tokenStore.valid({ accessToken: 'a', expiresAt: now + 3600 }), true);
    assert.strictEqual(tokenStore.valid({ accessToken: 'a', expiresAt: now - 10 }), false);
    assert.strictEqual(tokenStore.valid({ accessToken: 'a' }), true, '没给 expiresAt 就当有效，401 时再刷');
    assert.strictEqual(tokenStore.valid({}), false);
    assert.strictEqual(tokenStore.valid(null), false);
  });
  ok('token 存取：写进去能读回来，clear 之后读不到', () => {
    tokenStore.write({ accessToken: 'tk-1', refreshToken: 'rf-1', expiresAt: Math.floor(Date.now() / 1000) + 60 });
    assert.strictEqual(tokenStore.read().accessToken, 'tk-1');
    tokenStore.clear();
    assert.strictEqual(tokenStore.read(), null);
  });
  ok('会话级凭据缓存（E2B token）独立于登录态', () => {
    tokenCache.writeToken('123', { token: 'e2b-abc', expireAt: 1 });
    assert.strictEqual(tokenCache.readToken('123').token, 'e2b-abc');
    assert.ok(tokenCache.cachedIds().includes('123'));
    tokenCache.dropToken('123');
    assert.strictEqual(tokenCache.readToken('123'), null);
  });

  console.log('\nE2B 帧');
  ok('stdout 拼接 + end 帧没有 exitCode 时按 0 处理（proto3 省略默认值）', () => {
    const buf = Buffer.concat([
      frame({ event: { data: { stdout: Buffer.from('hi\n').toString('base64') } } }),
      frame({ event: { end: {} } }),
    ]);
    const r = e2b.parseExecFrames(buf);
    assert.strictEqual(r.out, 'hi\n');
    assert.strictEqual(r.code, 0);
  });
  ok('非零 exitCode 透传', () => {
    const r = e2b.parseExecFrames(frame({ event: { end: { exitCode: 3 } } }));
    assert.strictEqual(r.code, 3);
  });

  console.log('\n实例引用');
  const LIST = [{ id: '2120000000000000000', name: 'wb-sandbox-01' }];
  ok('完整 id / 名字 / 短序号都能命中', () => {
    assert.strictEqual(resolve.match(LIST, '2120000000000000000')[0].id, LIST[0].id);
    assert.strictEqual(resolve.match(LIST, 'wb-sandbox-01')[0].id, LIST[0].id);
    assert.strictEqual(resolve.match(LIST, '01')[0].id, LIST[0].id);
  });

  console.log('\n表格');
  ok('中文按两列宽算，每行视觉宽度一致', () => {
    // 用跟 ui.width 完全相同的字符集来量，否则会把制表符 '-' 也算成两列
    const wide = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
    const t = ui.table(['名字', '值'], [['中文名', 'x'], ['ab', 'yy']]);
    const w = t.split('\n').map((l) => [...l].reduce((n, ch) => n + (wide.test(ch) ? 2 : 1), 0));
    assert.strictEqual(new Set(w).size, 1, '各行宽度应相同：' + w.join(','));
  });

  console.log('\n配置');
  ok('COWBIRD_HOME 覆盖数据目录', () => {
    assert.strictEqual(cfg.HOME, TMP);
    assert.strictEqual(cfg.PATHS.config, path.join(TMP, 'cowbird.json'));
    assert.strictEqual(cfg.PATHS.daemonState, path.join(TMP, 'daemon-state.json'));
  });
  ok('老环境变量名有兜底（WB_CLOUD_HOME → COWBIRD_HOME）', () => {
    const before = process.env.COWBIRD_HOME;
    delete process.env.COWBIRD_HOME;
    process.env.WB_CLOUD_HOME = '/tmp/legacy-home';
    assert.strictEqual(cfg.envVal('COWBIRD_HOME'), '/tmp/legacy-home');
    delete process.env.WB_CLOUD_HOME;
    if (before !== undefined) process.env.COWBIRD_HOME = before;
  });

  console.log('\nkeepalive 策略');
  function mkKp(over) {
    const calls = [];
    const kp = new Keepalive({ sessionId: 's1', token: 't', link: 'https://x' }, { log: () => {}, ...over });
    kp._acp = { post: async (b) => { calls.push(b); return { status: 200, text: '' }; } };
    kp.state.connected = true;
    return { kp, calls };
  }
  const QMSG = (id) => ({ id, method: '_codebuddy.ai/question', params: { schema: { questions: [{ header: 'h', options: [{ label: 'A' }, { label: 'B' }] }] } } });

  ok('收到提问：登记但不回答（保活的核心）', () => {
    const { kp, calls } = mkKp();
    kp.onServerRequest(QMSG(7));
    assert.ok(kp.state.pending.has(7));
    assert.strictEqual(calls.length, 0, '绝不能回，回了就等于替用户作答');
  });
  ok('重连重放的同一提问不重复登记', () => {
    const { kp } = mkKp();
    kp.onServerRequest(QMSG(7));
    kp.onServerRequest(QMSG(7));
    assert.strictEqual(kp.state.pending.size, 1);
  });
  ok('权限请求同样不回应', () => {
    const { kp, calls } = mkKp();
    kp.onServerRequest({ id: 9, method: 'session/request_permission', params: {} });
    assert.strictEqual(calls.length, 0);
  });
  ok('endTurn 清空挂起（否则变成永远不催的僵尸）', () => {
    const { kp } = mkKp();
    kp.onServerRequest(QMSG(7));
    kp.onEvent({ method: 'session/endTurn' });
    assert.strictEqual(kp.state.pending.size, 0);
    assert.strictEqual(kp.state.busy, false);
  });
  ok('状态 completed 也清空挂起', () => {
    const { kp } = mkKp();
    kp.onServerRequest(QMSG(7));
    kp.onEvent({ method: 'session/update', params: { update: { _meta: { 'codebuddy.ai': { status: 'completed' } } } } });
    assert.strictEqual(kp.state.pending.size, 0);
  });
  ok('服务端说超时也清空', () => {
    const { kp } = mkKp();
    kp.onServerRequest(QMSG(7));
    kp.onEvent({ method: '_codebuddy.ai/interaction_timeout', params: { id: 7 } });
    assert.strictEqual(kp.state.pending.size, 0);
  });
  ok('历史重放不算「正在干活」', () => {
    const { kp } = mkKp();
    kp.onEvent({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', _meta: { 'codebuddy.ai': { mode: 'history' } } } } });
    assert.strictEqual(kp.state.busy, false);
  });
  await okAsync('空闲时发催话，且文案可配', async () => {
    const { kp, calls } = mkKp({ nudgeSec: 0, prompt: 'PLEASE-ASK' });
    kp._lastNudgeAt = 0;
    await kp.tick();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'session/prompt');
    assert.strictEqual(calls[0].params.prompt[0].text, 'PLEASE-ASK');
  });
  await okAsync('maxNudges 到顶后不再催', async () => {
    const { kp, calls } = mkKp({ nudgeSec: 0, maxNudges: 1 });
    kp._lastNudgeAt = 0;
    await kp.tick();
    kp._lastNudgeAt = 0;
    await kp.tick();
    assert.strictEqual(calls.length, 1);
  });
  await okAsync('noNudge 只观察不动手', async () => {
    const { kp, calls } = mkKp({ nudgeSec: 0, noNudge: true });
    kp._lastNudgeAt = 0;
    await kp.tick();
    assert.strictEqual(calls.length, 0);
  });

  await okAsync('催话失败后不会每秒重试（时间戳先推进）', async () => {
    const { kp } = mkKp({ nudgeSec: 0 });
    kp._acp.post = async () => { throw new Error('boom'); };
    kp._lastNudgeAt = 0;
    await kp.tick();
    assert.strictEqual(kp.state.nudges, 1);
    assert.strictEqual(kp._nudgeFails, 1);
    assert.ok(Date.now() - kp._lastNudgeAt < 1000, '失败也要推进，否则 1 秒一次重试风暴');
  });
  await okAsync('催话后收不到任何字节 ⇒ 判定半开并重连', async () => {
    let closed = 0;
    const kp = new Keepalive({ sessionId: 's1', token: 't', link: 'https://x' },
      { nudgeSec: 9999, stallAfterNudgeSec: 30, log: () => {} });
    kp._acp = { lastByteAt: 0, post: async () => ({ status: 200, text: '' }), close: () => { closed++; } };
    kp.state.connected = true;
    kp._silentFrom = Date.now() - 31000;       // 31 秒前开始催，此后零字节
    await kp.tick();
    assert.strictEqual(closed, 1, '应主动断开，交给连接循环重连');
    assert.strictEqual(kp._silentFrom, 0);
  });
  await okAsync('催话后收到过字节 ⇒ 不判死', async () => {
    let closed = 0;
    const kp = new Keepalive({ sessionId: 's1', token: 't', link: 'https://x' },
      { nudgeSec: 9999, stallAfterNudgeSec: 30, log: () => {} });
    kp._acp = { lastByteAt: Date.now(), post: async () => ({ status: 200, text: '' }), close: () => { closed++; } };
    kp.state.connected = true;
    kp._silentFrom = Date.now() - 31000;
    await kp.tick();
    assert.strictEqual(closed, 0);
  });
  await okAsync('连续失败 3 次才重连，且计数器归零不会累积', async () => {
    let closed = 0;
    const kp = new Keepalive({ sessionId: 's1', token: 't', link: 'https://x' },
      { nudgeSec: 0, log: () => {} });
    kp._acp = { lastByteAt: 0, post: async () => { throw new Error('boom'); }, close: () => { closed++; } };
    kp.state.connected = true;
    for (let i = 0; i < 3; i++) { kp._lastNudgeAt = 0; await kp.tick(); }
    assert.strictEqual(closed, 1, '第 3 次失败才重连');
    assert.strictEqual(kp._nudgeFails, 0, '重连后必须归零');
  });

  await okAsync('连续短连接按 2 的幂退避、封顶 60s', async () => {
    const kp = new Keepalive({ sessionId: 's1', token: 't', link: 'https://x' }, { reconnectMs: 5000, log: () => {} });
    assert.strictEqual(kp.backoffMs(), 5000);
    kp._shortSessions = 1; assert.strictEqual(kp.backoffMs(), 10000);
    kp._shortSessions = 3; assert.strictEqual(kp.backoffMs(), 40000);
    kp._shortSessions = 9; assert.strictEqual(kp.backoffMs(), 60000);
  });

  await okAsync('催话 POST 超时、但连接有事件回来 ⇒ 不算失败', async () => {
    const { kp } = mkKp();
    kp._acp.post = async () => { kp._acp.lastByteAt = Date.now() + 1000; throw new Error('timeout'); };
    kp._lastNudgeAt = 0;
    await kp.tick();
    assert.strictEqual(kp.state.nudges, 1);
    assert.strictEqual(kp._nudgeFails, 0, 'agent 都动了，不能记成失败');
  });

  console.log('\nheal（probe / script 双模式）');
  // heal 的执行器现在是 `run(id, cmd, timeoutSec, {refresh})`（内核 exec 编排）。
  // 这里保留原来的 exec(creds, cmd, opts) 形状做适配，测试断言不用改。
  const mkDeps = (over = {}) => {
    const calls = [];
    const deps = {
      calls,
      refreshSession: over.refreshSession || (async () => ({ token: 'b' })),
      run: async (id, cmd, timeoutSec, { refresh } = {}) => {
        if (refresh) await deps.refreshSession(id);
        const exec = over.exec || (async (creds, c, o) => { calls.push({ cmd: c, o }); return { out: '', err: '', code: 0 }; });
        return exec({ token: 'a' }, cmd, { timeout: timeoutSec });
      },
    };
    return deps;
  };

  ok('normalizeTargets 保留 script、id 转字符串', () => {
    const t = normalizeTargets([{ id: 2118, name: 'a', script: 'heal/x.sh' }, '123']);
    assert.deepStrictEqual(t[0], { id: '2118', name: 'a', script: 'heal/x.sh' });
    assert.deepStrictEqual(t[1], { id: '123', name: '', script: '' });
  });
  ok('id 写成 JSON 数字会丢精度（所以文档要求写字符串）', () => {
    // 2120000000000000000 > 2^53，作为 Number 已经不准；这不是 bug，是必须写引号的原因
    assert.notStrictEqual(String(2120000000000000000), '2120000000000000000');
    assert.strictEqual(String(normalizeTargets([{ id: '2120000000000000000' }])[0].id), '2120000000000000000');
  });

  await okAsync('没有 script 的目标仍然跑 probe', async () => {
    const deps = mkDeps();
    const r = await runHeal({ targets: [{ id: '1' }], probe: 'uptime' }, () => {}, deps);
    assert.deepStrictEqual(deps.calls.map((c) => c.cmd), ['uptime']);
    assert.strictEqual(r.results[0].mode, 'probe');
    assert.strictEqual(r.ok, 1);
  });

  await okAsync('script 模式：把文件内容当命令送进去', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowbird-heal-'));
    fs.writeFileSync(path.join(dir, 'h.sh'), '#!/bin/sh\necho "ACTION: 修好了"\necho "STATE: ok"\n');
    const deps = mkDeps({ exec: async (c, cmd, o) => { deps.calls.push({ cmd, o }); return { out: 'ACTION: 修好了\nSTATE: ok\n', err: '', code: 0 }; } });
    const r = await runHeal({ targets: [{ id: '1', script: 'h.sh' }], scriptsDir: dir }, () => {}, deps);
    assert.strictEqual(deps.calls.length, 1);
    assert.match(deps.calls[0].cmd, /echo "ACTION: 修好了"/, '送进去的应是脚本正文');
    assert.strictEqual(r.results[0].mode, 'script');
    assert.deepStrictEqual(r.results[0].actions, ['ACTION: 修好了']);
    assert.strictEqual(r.warned, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await okAsync('脚本路径写错：算失败，且不静默退回 probe', async () => {
    const deps = mkDeps();
    const r = await runHeal({ targets: [{ id: '1', script: 'no-such-file.sh' }] }, () => {}, deps);
    assert.strictEqual(deps.calls.length, 0, '读不到文件就不该去连远端');
    assert.strictEqual(r.failed, 1);
    assert.match(r.results[0].error, /脚本读不到/);
  });

  await okAsync('脚本输出 ERROR: 不算失败，但计入告警', async () => {
    const deps = mkDeps({ exec: async () => ({ out: 'ERROR: pivot 没挂\nSTATE: x=1\n', err: '', code: 0 }) });
    const r = await runHeal({ targets: [{ id: '1' }] }, () => {}, deps);
    assert.strictEqual(r.ok, 1);
    assert.strictEqual(r.failed, 0);
    assert.strictEqual(r.warned, 1);
    assert.deepStrictEqual(r.results[0].errors, ['ERROR: pivot 没挂']);
  });

  await okAsync('exec 失败后强制换凭据重试一次', async () => {
    let n = 0;
    let refreshed = 0;
    const deps = mkDeps({
      exec: async () => { n++; if (n === 1) throw new Error('401 boom'); return { out: '', err: '', code: 0 }; },
      refreshSession: async () => { refreshed++; return { token: 'b' }; },
    });
    const r = await runHeal({ targets: [{ id: '1' }] }, () => {}, deps);
    assert.strictEqual(n, 2);
    assert.strictEqual(refreshed, 1);
    assert.strictEqual(r.ok, 1);
    assert.strictEqual(r.results[0].attempt, 2);
  });

  await okAsync('日志里的状态以控制面为准（同 ls --refresh 取法）', async () => {
    const lines = [];
    const kp = new Keepalive({ sessionId: 's1', token: 't', link: 'https://x' }, {
      nudgeSec: 9999, probeMs: 0, logEveryMs: 0,
      probeStatus: async () => ({ status: 'pending', sessionStatus: 'pending' }),
      log: (m) => lines.push(m),
    });
    kp._acp = { lastByteAt: 0, post: async () => ({ status: 200, text: '' }), close: () => {} };
    kp.state.connected = true;
    await kp.tick();
    assert.ok(lines.some((l) => /平台=pending\/pending/.test(l)), '应带上平台状态：' + lines.join(' | '));
    assert.ok(lines.some((l) => /sse=/.test(l)), 'SSE 侧的值也要保留，方便看是否陈旧');
  });
  await okAsync('控制面取不到时降级成 平台=?，不抛错', async () => {
    const lines = [];
    const kp = new Keepalive({ sessionId: 's1', token: 't', link: 'https://x' }, {
      nudgeSec: 9999, probeMs: 0, logEveryMs: 0,
      probeStatus: async () => { throw new Error('boom'); },
      log: (m) => lines.push(m),
    });
    kp._acp = { lastByteAt: 0, post: async () => ({ status: 200, text: '' }), close: () => {} };
    kp.state.connected = true;
    await kp.tick();
    assert.ok(lines.some((l) => /平台=\?\(boom\)/.test(l)), lines.join(' | '));
  });

  await okAsync('平台说 pending 时不补催（重放没带回提问的兜底）', async () => {
    const { kp, calls } = mkKp({ nudgeSec: 0 });
    kp.opts.probeMs = 0;
    kp.opts.probeStatus = async () => ({ status: 'pending', sessionStatus: 'pending' });
    kp._lastNudgeAt = 0;
    await kp.tick();
    assert.strictEqual(calls.length, 0, '平台已经钉住了，不该再往历史里写');
  });

  // 收尾
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '\u2717' : '\u2713'} ${pass} 通过${fail ? '，' + fail + ' 失败' : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('冒烟测试自身出错：' + e.stack);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
