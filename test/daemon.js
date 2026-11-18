#!/usr/bin/env node
// daemon 的离线测试：调度器的状态机 + HTTP 接口的鉴权/路由。
// 以前这两块（552 行）完全没有覆盖，而它们错了的表现是"看起来在保活，其实没有"。
//
//   node test/daemon.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

// config 在 import 时就算 HOME，必须先设
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cowbird-daemon-'));
process.env.COWBIRD_HOME = TMP;
process.env.COWBIRD_DAEMON_TOKEN = '';

process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const cfg = require('../lib/config');
const channels = require('../lib/platform/channels');

// ---- 假渠道：不联网、不落盘，只够调度器跑一轮 ----
const provider = {
  id: 'fake',
  displayName: 'Fake',
  has: () => false,
  limits: {},
  capabilityList: () => [],
  instances: {},
  agent: {},
  auth: { state: async () => ({ cookies: [], savedAt: null }) },
};
const ctx = {
  provider,
  channel: 'fake:default',
  account: 'default',
  effective: {},
  defaults: {},
  store: { read: () => null, write: () => {}, writeStrict: () => {}, remove: () => {}, list: () => [] },
  log: () => {},
  config: () => cfg.readConfig(),
};
const fakeCh = { key: 'fake:default', platform: 'fake', account: 'default', provider, ctx, hasCred: false };
channels.preferred = () => fakeCh;      // 调度器通过模块对象调用，打桩即可
channels.all = () => [fakeCh];

const { Scheduler } = require('../lib/daemon/scheduler');
const { createServer } = require('../lib/daemon/server');
const { LogStore } = require('../lib/daemon/logstore');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}
async function okA(name, fn) {
  try { await fn(); pass++; console.log('  \u2713 ' + name); }
  catch (e) { fail++; console.error('  \u2717 ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(cfg.PATHS.daemonState, 'utf8')); } catch { return null; }
}

(async () => {
  console.log('\n调度器');
  await okA('busy 互斥：同一轮在跑时第二次调用直接 skipped', async () => {
    const s = new Scheduler({ log: () => {} });
    s.busy.heal = true;                       // 模拟"正在跑"
    const r = await s.healNow();
    assert.deepStrictEqual(r, { skipped: 'busy' });
  });

  await okA('没有目标时也要落盘（daemon status 才看得见）', async () => {
    cfg.writeConfig({ heal: { targets: [] } });
    const s = new Scheduler({ log: () => {} });
    const r = await s.healNow();
    assert.strictEqual(r.skipped, 'no-targets');
    const st = readState();
    assert.ok(st && st.lastHeal && st.lastHeal.skipped === 'no-targets', '状态文件里应有 lastHeal.skipped');
  });

  await okA('平台没有 exec 时，目标记为 skipped 而不是失败', async () => {
    cfg.writeConfig({ heal: { targets: [{ id: '2123456789012345678', name: 'x' }] } });
    const s = new Scheduler({ log: () => {} });
    const r = await s.healNow();
    assert.ok(!r.failed, '没有执行通道不算失败');
    assert.ok(r.skipped >= 1, 'skipped 计数要透出来：' + JSON.stringify(r));
  });

  await okA('_load：沿用历史结果，但 startedAt 用本次进程的', () => {
    const old = { startedAt: '2020-01-01T00:00:00.000Z', lastHealAt: '2026-01-01T00:00:00.000Z', lastHeal: { at: 'x', ok: 3 }, errors: 7 };
    fs.writeFileSync(cfg.PATHS.daemonState, JSON.stringify(old));
    const s = new Scheduler({ log: () => {} });
    assert.strictEqual(s.state.errors, 7, '历史计数要留着');
    assert.strictEqual(s.state.lastHeal.ok, 3);
    assert.notStrictEqual(s.state.startedAt, old.startedAt, 'startedAt 必须是本次进程的');
    assert.ok(Date.now() - Date.parse(s.state.startedAt) < 5000);
  });

  await okA('setTargets 走配置落盘（daemon 不在时也生效）', () => {
    const s = new Scheduler({ log: () => {} });
    s.setTargets([{ id: 123, name: 'a' }, '456']);
    const t = cfg.readConfig().heal.targets;
    assert.strictEqual(t.length, 2);
    assert.strictEqual(t[0].id, '123', 'id 统一成字符串（JSON 数字会丢精度）');
    assert.strictEqual(t[1].id, '456');
  });

  console.log('\n服务安装（纯函数）');
  const service = require('../lib/daemon/service');
  await okA('systemd unit：ExecStart 是两个绝对路径，HOME 走 Environment', async () => {
    const unit = service.systemdUnit();
    assert.ok(/^Description=cowbird daemon/m.test(unit));
    assert.ok(unit.includes(`ExecStart=${process.execPath} `), 'ExecStart 要带 node 绝对路径');
    assert.ok(/Environment=COWBIRD_HOME=/.test(unit));
    assert.ok(/Restart=always/.test(unit));
    assert.ok(/WantedBy=multi-user\.target/.test(unit));
  });
  await okA('schtasks 命令：登录触发 + 路径带引号', async () => {
    const cmd = service.schtasksCommand();
    assert.ok(cmd.startsWith('schtasks /Create'));
    assert.ok(cmd.includes('/SC ONLOGON'));
    assert.ok(/\/TR "\\"/.test(cmd), '路径要转义引号，否则带空格的用户名就断');
    assert.ok(cmd.includes('cowbird-daemon.js'));
  });
  await okA('plan：只按平台给方案，不写盘', async () => {
    const linux = service.plan('linux');
    assert.strictEqual(linux.path, service.UNIT_PATH);
    assert.ok(linux.unit && linux.hint);
    const win = service.plan('win32');
    assert.ok(win.command && !win.path);
    const other = service.plan('freebsd');
    assert.strictEqual(other.platform, 'other');
    assert.ok(other.hint);
  });
  console.log('\nHTTP 接口');
  const logstore = new LogStore(path.join(cfg.PATHS.logs, 'daemon.log'));
  const schedulerStub = { state: { startedAt: new Date().toISOString() }, snapshot: async () => ({ ok: true }) };
  const server = createServer({ scheduler: schedulerStub, log: () => {}, logstore, token: 'tk' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const req = (method, p, { token, body } = {}) => new Promise((resolve, reject) => {
    const h = { accept: 'application/json' };
    if (token) h.authorization = 'Bearer ' + token;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: b }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });

  await okA('/health 免鉴权', async () => {
    const r = await req('GET', '/health');
    assert.strictEqual(r.status, 200);
    assert.ok(/cowbird-daemon/.test(r.text));
  });

  await okA('没有令牌 → 401', async () => {
    assert.strictEqual((await req('GET', '/api/status')).status, 401);
    assert.strictEqual((await req('GET', '/api/status', { token: 'bad' })).status, 401);
  });

  await okA('带令牌 → 200', async () => {
    const r = await req('GET', '/api/status', { token: 'tk' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.text), { ok: true });
  });

  await okA('凭据接口已删除：/api/state 与 /api/token 一律 404', async () => {
    assert.strictEqual((await req('GET', '/api/state', { token: 'tk' })).status, 404);
    assert.strictEqual((await req('PUT', '/api/state', { token: 'tk', body: {} })).status, 404);
    assert.strictEqual((await req('GET', '/api/token/1', { token: 'tk' })).status, 404);
  });

  await okA('未知路由 404，且错误体是 JSON', async () => {
    const r = await req('GET', '/api/nope', { token: 'tk' });
    assert.strictEqual(r.status, 404);
    assert.ok(JSON.parse(r.text).error);
  });

  await okA('PUT /api/targets 缺 targets 数组 → 400', async () => {
    const r = await req('PUT', '/api/targets', { token: 'tk', body: { nope: 1 } });
    assert.strictEqual(r.status, 400);
  });

  server.close();

  console.log(`\n${fail ? '\u2717' : '\u2713'} ${pass} 通过${fail ? '，' + fail + ' 失败' : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('自测崩了：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
