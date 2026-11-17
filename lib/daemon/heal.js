// 保活：对配置里的实例做一次「真实 API 访问」。
//
// 为什么这就够：平台按「有没有人在访问这个会话」决定要不要回收，而一次 exec
// 就是货真价实的 API 调用。不需要在容器里装任何东西，也不需要发一句话打扰 agent。
//
// 两种模式，由目标自己声明：
//   probe（默认）  在容器里跑一条短命令（默认 uptime）。便宜，只证明"能进去"。
//   script         把本地脚本文件的内容送进去跑。用于全量自愈 —— 脚本自己负责检测、
//                  修复、并把结果以 ACTION: / ERROR: / STATE: 三种前缀打出来。
//   ⚠ 声明了 script 但读不到文件时**不会**退回 probe：配置写错要能被看见，而不是静默降级。
//
// ⚠ 一次不成就**强制刷新凭据**再来一次：老脚本的坑是「缓存 token 已失效但代码不重取」，
//   表现是每天 5xx/401 静默刷屏。这里把「失败 → 刷新 → 重试」固化成规则；
//   平台没有 refresh 能力时（码道/Qoder）就只是再跑一次。
//
// 目标带渠道：`{ id, name?, script?, channel? }`。不写 channel 就用默认渠道 ——
// 这样多账号共存时，一轮 heal 里 A 账号的实例和 B 账号的实例各自用自己的凭据。
const fs = require('fs');
const path = require('path');
const channels = require('../platform/channels');
const execCore = require('../platform/exec');

const head = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const lines = (out, prefix) => String(out || '').split('\n').filter((l) => l.startsWith(prefix));

function normalizeTargets(list) {
  return (list || [])
    .map((t) => (typeof t === 'string' ? { id: t } : t))
    .filter((t) => t && t.id)
    .map((t) => ({ id: String(t.id), name: t.name || '', script: t.script || '', channel: t.channel || '' }));
}

// 把目标声明的脚本读成文本。相对路径按 scriptsDir 解析（不给就用当前目录）。
function readScript(target, scriptsDir) {
  const p = path.isAbsolute(target.script)
    ? target.script
    : path.resolve(scriptsDir || '.', target.script);
  return { path: p, body: fs.readFileSync(p, 'utf8') };
}

/** 默认执行器：走内核的 exec 编排（含唤醒预算、busy 退避） */
function defaultRunner(ctx, log) {
  return async (id, command, timeoutSec, { refresh } = {}) => {
    const p = ctx.provider;
    if (refresh && typeof p.instances.refresh === 'function') {
      try { await p.instances.refresh(ctx, id); } catch { /* 刷新失败就按原凭据再试一次 */ }
    }
    return execCore.run(ctx, id, {
      command,
      timeoutMs: Number(timeoutSec) > 0 ? Number(timeoutSec) * 1000 : undefined,
      wake: false,
      log,
    });
  };
}

async function healOne(target, opts, log, run) {
  const { probe, timeoutSec, scriptsDir } = opts;
  const started = Date.now();
  const rec = {
    id: target.id, name: target.name, channel: target.channel || '', mode: target.script ? 'script' : 'probe',
    ok: false, code: null, attempt: 0, ms: 0, out: '',
    actions: [], errors: [], error: '',
  };
  const who = `${rec.channel ? rec.channel + ' ' : ''}${rec.name || rec.id}`;

  let payload = probe;
  if (target.script) {
    try {
      const s = readScript(target, scriptsDir);
      payload = s.body;
      rec.script = s.path;
    } catch (e) {
      rec.error = `脚本读不到：${String(e.message).slice(0, 120)}`;
      rec.ms = Date.now() - started;
      log(`${who} FAIL ${rec.error}`, { id: rec.id });
      return rec;
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    rec.attempt = attempt;
    try {
      const r = await run(target.id, payload, timeoutSec, { refresh: attempt > 1 });
      rec.code = r.code;
      rec.out = head(r.out);
      rec.actions = lines(r.out, 'ACTION:');
      rec.errors = lines(r.out, 'ERROR:');
      rec.ok = r.code === 0 || r.code === null;
      if (rec.ok) break;
      rec.error = 'exit=' + r.code + ' ' + head(r.err, 120);
    } catch (e) {
      rec.error = head(e.message, 200);
    }
  }

  rec.ms = Date.now() - started;
  const tail = rec.ok
    ? (rec.actions.length || rec.errors.length ? ` (${rec.actions.length} 动作, ${rec.errors.length} 告警)` : '')
    : ' ' + rec.error;
  log(
    `${who} ${rec.ok ? 'ok' : 'FAIL'} ${rec.ms}ms` +
      (rec.attempt > 1 ? ` (第${rec.attempt}次尝试)` : '') + tail,
    rec.ok ? undefined : { id: rec.id }
  );
  // 脚本自己报的问题单独成行 —— 它们不等于本轮失败，但必须让人看见
  for (const l of rec.errors.slice(0, 5)) log(`${who} ! ${head(l, 200)}`);
  return rec;
}

/**
 * @param {{targets:any[], probe?:string, timeoutSec?:number, scriptsDir?:string}} opts
 * @param {(m:string, extra?:any)=>void} log
 * @param {{ctx?:object, run?:Function}} [deps] 测试注入口
 */
async function runHeal({ targets, probe = 'uptime', timeoutSec = 120, scriptsDir = '' }, log = () => {}, deps = {}) {
  const list = normalizeTargets(targets);
  if (!list.length) return { at: new Date().toISOString(), results: [], skipped: 'no-targets' };

  // 每个渠道一个 ctx（懒建、进程内复用）。deps.ctx 就是默认渠道，别重复造。
  const base = deps.ctx || channels.preferred().ctx;
  const cache = new Map([[base.channel, base]]);
  const ctxOf = (key) => {
    if (!key) return base;
    if (cache.has(key)) return cache.get(key);
    const ch = channels.get(key);
    ch.ctx.log = base.log;                 // 日志归调用方
    cache.set(key, ch.ctx);
    return ch.ctx;
  };

  const results = [];
  for (const t of list) {
    let ctx;
    try {
      ctx = ctxOf(t.channel);
      t.channel = ctx.channel;             // 记下真正的渠道（配置里可能是空的）
    } catch (e) {
      results.push({ id: t.id, name: t.name, channel: t.channel, ok: false, skipped: 'bad-channel', error: head(e.message) });
      log(`${t.channel} ${t.name || t.id} 跳过：${head(e.message)}`);
      continue;
    }
    if (!ctx.provider.has('exec')) {
      // 没执行通道的平台（MiniMax）不该让整轮 heal 变成"失败"——它只是做不到这件事
      results.push({
        id: t.id, name: t.name, channel: ctx.channel, ok: false, skipped: 'unsupported',
        error: `${ctx.provider.displayName} 没有执行通道`,
      });
      log(`${ctx.channel} ${t.name || t.id} 跳过：${ctx.provider.displayName} 没有执行通道`);
      continue;
    }
    const run = deps.run || defaultRunner(ctx, log);
    results.push(await healOne(t, { probe, timeoutSec, scriptsDir }, log, run));
  }

  const skipped = results.filter((r) => r.skipped);
  const failed = results.filter((r) => !r.ok && !r.skipped);
  return {
    at: new Date().toISOString(),
    results,
    ok: results.filter((r) => r.ok).length,
    failed: failed.length,
    warned: results.filter((r) => r.ok && r.errors.length).length,
    skipped: skipped.length || undefined,
  };
}

module.exports = { runHeal, normalizeTargets };
