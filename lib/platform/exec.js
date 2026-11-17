// 执行编排：内核里唯一「怎么跑一条命令」的地方。
//
// 四个平台的实际形状差得很大（E2B 五字节帧 / 裸 HTTP 30s 顶 / MCP 120–600s / 完全没有），
// 但内核只需要做三件事：
//   ① 确认沙箱醒着（ensureReady，带唤醒预算与 flake 重试）
//   ② 按 provider 声明的 limits 决定「同步 / 后台」还是「拒绝」
//   ③ 把 busy / 超时 / 被截断 这些平台特性统一成可读的结果
const { CAP } = require('./contract');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function capabilityError(p, cap) {
  const e = new Error(`本平台（${p.displayName}）不提供 ${cap} 能力`);
  e.code = 'E_CAPABILITY';
  e.capability = cap;
  return e;
}

/** 唤醒预算：默认每实例每小时 2 次、每天 10 次（唤醒要花 LLM 额度，不能无脑重试） */
function wakeBudget(ctx, id) {
  const conf = (ctx.config().exec || {}).wakeBudget || {};
  const perHour = conf.perHour === undefined ? 2 : conf.perHour;
  const perDay = conf.perDay === undefined ? 10 : conf.perDay;
  const key = `wake-${id}`;
  const now = Date.now();
  const rec = ctx.store.read(key, { hour: [], day: [] }) || { hour: [], day: [] };
  rec.hour = (rec.hour || []).filter((t) => now - t < 3600e3);
  rec.day = (rec.day || []).filter((t) => now - t < 86400e3);
  return {
    ok: rec.hour.length < perHour && rec.day.length < perDay,
    usedHour: rec.hour.length, usedDay: rec.day.length, perHour, perDay,
    take() { rec.hour.push(now); rec.day.push(now); ctx.store.write(key, rec); },
    snapshot: () => ({ usedHour: rec.hour.length, usedDay: rec.day.length, perHour, perDay }),
  };
}

/**
 * 确保可以执行：probe → （必要时）wake → 再 probe。
 * @returns {Promise<{ready:boolean, woke:boolean, why?:string}>}
 */
async function ensureReady(ctx, id, { wake = true, log = () => {} } = {}) {
  const p = ctx.provider;
  if (!p.has(CAP.EXEC)) throw capabilityError(p, 'exec');
  const pf = p.instances && p.instances.info ? `（${p.displayName}）` : '';

  let st = await p.exec.probe(ctx, id);
  if (st && st.ready) return { ready: true, woke: false };

  if (!p.has(CAP.WAKE) || !wake) {
    return { ready: false, woke: false, why: (st && st.why) || 'not-ready' };
  }

  const budget = wakeBudget(ctx, id);
  if (!budget.ok) {
    return { ready: false, woke: false, why: `唤醒次数已达上限（${budget.usedHour}/${budget.perHour} 每小时，${budget.usedDay}/${budget.perDay} 每天）` };
  }

  // flake 容忍：一次唤醒可能因为"模型没调工具"而没建沙箱，允许再补一次
  for (let attempt = 1; attempt <= 2; attempt++) {
    budget.take();
    log(`沙箱 ${id} 未就绪，第 ${attempt} 次唤醒${pf}…`);
    await p.exec.wake(ctx, id);
    const deadline = Date.now() + (p.limits.wakeTimeoutMs || 60e3);
    while (Date.now() < deadline) {
      await sleep(1500);
      st = await p.exec.probe(ctx, id);
      if (st && st.ready) return { ready: true, woke: true };
    }
    log(`唤醒后仍未就绪${st && st.why ? '（' + st.why + '）' : ''}`);
  }
  return { ready: false, woke: false, why: (st && st.why) || 'wake-timeout' };
}

/**
 * 跑一条命令。返回 { out, err, code, ms, truncated, via, job? }
 * @param {object} opts { command, timeoutMs, cwd, env, background, wake, log }
 */
async function run(ctx, id, opts = {}) {
  const p = ctx.provider;
  const { command, cwd, env, log = () => {}, background = false, wake = true } = opts;
  if (!p.has(CAP.EXEC)) throw capabilityError(p, 'exec');
  if (!command) throw new Error('命令为空');

  const lim = p.limits;
  const wantMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : lim.defaultSyncMs;

  const ready = await ensureReady(ctx, id, { wake, log });
  if (!ready.ready) {
    const e = new Error(`沙箱不可用：${ready.why || 'unknown'}`);
    e.code = 'E_NOT_READY';
    throw e;
  }

  const goBackground = background || wantMs > lim.maxSyncMs;
  if (goBackground) {
    if (!p.has(CAP.EXEC_BG)) {
      // 没有后台能力就只能把同步上限压到 provider 能接受的范围
      log(`本平台没有后台任务能力，超时压到 ${lim.maxSyncMs}ms`);
      return runSync(ctx, id, { command, cwd, env, timeoutMs: lim.maxSyncMs, log });
    }
    const job = await p.exec.start(ctx, id, { command, cwd, env });
    log(`已转后台：${job.jobId}${job.outputPath ? '（输出 ' + job.outputPath + '）' : ''}`);
    return follow(ctx, id, job, { log, timeoutMs: Number(opts.waitMs) || 0 });
  }
  return runSync(ctx, id, { command, cwd, env, timeoutMs: wantMs, log });
}

async function runSync(ctx, id, { command, cwd, env, timeoutMs, log }) {
  const p = ctx.provider;
  const maxRetry = 3;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      const r = await p.exec.run(ctx, id, { command, timeoutMs, cwd, env });
      if (r && r.truncated) {
        log(`命令在 ${timeoutMs}ms 处被平台截断（沙箱内可能仍在跑）`);
      }
      return { ...r, via: 'sync' };
    } catch (e) {
      // 平台忙（上一个命令还在跑）：退避重试，别把它报成失败
      const busy = e && (e.code === 'E_BUSY' || /busy/i.test(String(e.message)));
      if (!busy || attempt === maxRetry) throw e;
      const wait = Math.min(5000, 500 * Math.pow(2, attempt - 1));
      log(`沙箱忙，${wait}ms 后重试（${attempt}/${maxRetry - 1}）`);
      await sleep(wait);
    }
  }
  throw new Error('unreachable');
}

/** 轮询后台任务直到结束（或按 waitMs 给个上限） */
async function follow(ctx, id, job, { log = () => {}, timeoutMs = 0, intervalMs = 1500 } = {}) {
  const p = ctx.provider;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  for (;;) {
    const st = await p.exec.poll(ctx, id, job);
    if (st && st.done) return { out: st.out || '', err: st.err || '', code: st.code === undefined ? null : st.code, ms: 0, truncated: false, via: 'bg', job };
    if (deadline && Date.now() > deadline) {
      return { out: st && st.out || '', err: '', code: null, ms: 0, truncated: true, via: 'bg', job, running: true };
    }
    await sleep(intervalMs);
  }
}

module.exports = { ensureReady, run, follow, wakeBudget };
