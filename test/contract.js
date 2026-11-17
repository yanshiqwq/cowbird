#!/usr/bin/env node
// 契约与注册表测试：不联网、不 spawn 进程，秒级跑完。
//   node test/contract.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// config 在 import 时就算 HOME，必须先设
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cowbird-contract-'));
process.env.COWBIRD_HOME = TMP;
process.env.COWBIRD_LOCAL = '1';
delete process.env.COWBIRD_PLATFORM;
delete process.env.COWBIRD_PLATFORM_MODULE;

// 不论怎么退出（含中途 process.exit），临时目录都不许留在 /tmp 里
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const { CAP, EVENT, defineProvider, execResult } = require('../lib/platform/contract');
const { validateShape } = require('../lib/platform/validate');
const registry = require('../lib/platform');
const example = require('../lib/platform/_example');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  \u2713 ' + name); } catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + e.message); } };
const okA = async (name, fn) => { try { await fn(); pass++; console.log('  \u2713 ' + name); } catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + e.message); } };

(async () => {
  console.log('\n契约校验');
  ok('缺 id / displayName 要拒绝', () => {
    assert.throws(() => defineProvider({ displayName: 'x', capabilities: [CAP.LIST, CAP.AGENT], instances: { list() {} }, agent: { stream() {}, send() {} } }), /缺 id/);
    assert.throws(() => defineProvider({ id: 'x', capabilities: [CAP.LIST, CAP.AGENT], instances: { list() {} }, agent: { stream() {}, send() {} } }), /displayName/);
  });
  ok('未知能力位要拒绝', () => {
    assert.throws(() => defineProvider({
      id: 'x', displayName: 'x', capabilities: [CAP.LIST, CAP.AGENT, 'exec.telepathy'],
      instances: { list() {} }, agent: { stream() {}, send() {} },
    }), /未知能力位/);
  });
  ok('缺必需能力要拒绝', () => {
    assert.throws(() => defineProvider({ id: 'x', displayName: 'x', capabilities: [CAP.LIST], instances: { list() {} }, agent: { stream() {}, send() {} } }), /必需能力/);
  });
  ok('声明了能力却没有实现要拒绝（exec 缺 run）', () => {
    assert.throws(() => defineProvider({
      id: 'x', displayName: 'x', capabilities: [CAP.LIST, CAP.AGENT, CAP.EXEC],
      instances: { list() {} }, agent: { stream() {}, send() {} }, exec: { probe() {} },
    }), /缺 exec\.run\(\)/);
  });
  ok('limits 有默认值且 defaultSyncMs 不会超过 maxSyncMs', () => {
    const p = defineProvider({
      id: 'x', displayName: 'x', capabilities: [CAP.LIST, CAP.AGENT],
      instances: { list() {} }, agent: { stream() {}, send() {} },
      limits: { maxSyncMs: 30000, defaultSyncMs: 60000 },
    });
    assert.strictEqual(p.limits.maxSyncMs, 30000);
    assert.strictEqual(p.limits.defaultSyncMs, 30000);
    assert.strictEqual(p.limits.maxBackground, false);
  });
  ok('require() 抛可识别的能力错误', () => {
    const p = defineProvider({ id: 'x', displayName: 'x', capabilities: [CAP.LIST, CAP.AGENT], instances: { list() {} }, agent: { stream() {}, send() {} } });
    assert.strictEqual(p.has(CAP.EXEC), false);
    assert.throws(() => p.require(CAP.EXEC), (e) => e.code === 'E_CAPABILITY' && /不支持/.test(e.message));
  });
  ok('validateShape 拒绝 id 与目录名不一致', () => {
    assert.throws(() => validateShape(example, 'qoder'), /不一致/);
    assert.doesNotThrow(() => validateShape(example, '_example'));
  });

  console.log('\n注册表');
  ok('内置列表包含四个真实平台 + 样例', () => {
    const inv = registry.inventory();
    const ids = inv.map((x) => x.id);
    for (const id of ['workbuddy', 'codearts', 'qoder', 'minimax', '_example']) assert.ok(ids.includes(id), '缺少 ' + id);
  });
  ok('未知平台报明确错误并列出可用项', () => {
    assert.throws(() => registry.use('nope'), (e) => /没有内置平台|加载失败/.test(e.message));
  });
  okA('use("_example") 能拿到 provider 且能力位正确', async () => {
    const p = registry.use('_example');
    assert.strictEqual(p.id, '_example');
    assert.ok(p.has(CAP.EXEC));
    assert.ok(p.has(CAP.EXEC_BG));
    assert.ok(!p.has(CAP.AUTH_RENEW));
  });
  ok('context() 提供隔离的 store 目录', () => {
    const p = registry.use('_example');
    const ctx = registry.context(p);
    assert.strictEqual(ctx.store.dir, path.join(TMP, 'platform', '_example'));
    ctx.store.write('probe', { a: 1 });
    assert.deepStrictEqual(ctx.store.read('probe'), { a: 1 });
    assert.strictEqual(fs.existsSync(path.join(ctx.store.dir, 'probe.json')), true);
  });

  console.log('\n样例平台端到端（内核视角）');
  const p = registry.use('_example');
  const ctx = registry.context(p);

  await okA('list → create → rename → remove', async () => {
    const before = await p.instances.list(ctx);
    assert.ok(before.length >= 1);
    const inst = await p.instances.create(ctx, { name: 'probe-02' });
    assert.strictEqual(inst.name, 'probe-02');
    const list = await p.instances.list(ctx);
    assert.ok(list.some((i) => i.id === inst.id));
    await p.instances.rename(ctx, inst.id, 'probe-renamed');
    assert.strictEqual((await p.instances.get(ctx, inst.id)).name, 'probe-renamed');
    await p.instances.remove(ctx, inst.id);
    assert.ok(!(await p.instances.list(ctx)).some((i) => i.id === inst.id));
  });

  await okA('exec.run：echo / id / false / cat', async () => {
    const id = (await p.instances.list(ctx))[0].id;
    assert.strictEqual((await p.exec.run(ctx, id, { command: 'echo hi' })).out, 'hi\n');
    assert.match((await p.exec.run(ctx, id, { command: 'id' })).out, /uid=1000/);
    assert.strictEqual((await p.exec.run(ctx, id, { command: 'false' })).code, 1);
    const cat = await p.exec.run(ctx, id, { command: 'cat hello.txt' });
    assert.match(cat.out, /hello from _example/);
    assert.strictEqual((await p.exec.run(ctx, id, { command: 'nope' })).code, 127);
  });

  await okA('exec 后台：start → poll 到 done', async () => {
    const id = (await p.instances.list(ctx))[0].id;
    const job = await p.exec.start(ctx, id, { command: 'echo bg' });
    assert.ok(job.jobId);
    let st = await p.exec.poll(ctx, id, { jobId: job.jobId });
    for (let i = 0; i < 50 && !st.done; i++) { await new Promise((r) => setTimeout(r, 10)); st = await p.exec.poll(ctx, id, { jobId: job.jobId }); }
    assert.strictEqual(st.done, true);
    assert.strictEqual(st.out, 'bg\n');
  });

  await okA('fs 写读列 + put/get', async () => {
    const id = (await p.instances.list(ctx))[0].id;
    await p.fs.write(ctx, id, { path: '/workspace/a.txt', content: 'A' });
    assert.strictEqual((await p.fs.read(ctx, id, { path: '/workspace/a.txt' })).content, 'A');
    assert.ok((await p.fs.list(ctx, id, { path: '/workspace' })).some((f) => f.path === '/workspace/a.txt'));
    const local = path.join(TMP, 'from-remote.txt');
    await p.exec.get(ctx, id, { remotePath: '/workspace/a.txt', localPath: local });
    assert.strictEqual(fs.readFileSync(local, 'utf8'), 'A');
  });

  await okA('agent.stream 产出归一化事件且以 done 结尾', async () => {
    const id = (await p.instances.list(ctx))[0].id;
    await p.agent.send(ctx, id, { text: '你好' });
    const kinds = [];
    let text = '';
    for await (const ev of p.agent.stream(ctx, id, { text: '你好' })) {
      kinds.push(ev.kind);
      if (ev.kind === EVENT.TEXT) text += ev.data.text;
    }
    assert.ok(kinds.includes(EVENT.STATUS), kinds.join(','));
    assert.ok(kinds.includes(EVENT.TEXT));
    assert.ok(kinds.includes(EVENT.USAGE));
    assert.strictEqual(kinds[kinds.length - 1], EVENT.DONE);
    assert.ok(text.length > 0);
  });

  await okA('info 同时给「可见」与「配额」两组容量', async () => {
    const id = (await p.instances.list(ctx))[0].id;
    const i = await p.instances.info(ctx, id);
    assert.ok(i.visible.cpu > i.quota.cpu, '可见应大于配额（这正是 WorkBuddy 的坑）');
    assert.ok(i.quota.memBytes > 0);
  });

  ok('execResult 归一', () => {
    const r = execResult({ out: 'x', code: 0, ms: 5 });
    assert.deepStrictEqual(Object.keys(r).sort(), ['code', 'err', 'ms', 'out', 'truncated']);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? '\u2717' : '\u2713'} ${pass} 通过${fail ? '，' + fail + ' 失败' : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('契约测试自身出错：' + e.stack); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(1); });
