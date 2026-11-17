// 实例引用解析：把 `01` / 名字 / 完整 id / `渠道/引用` 解析成一个 { 实例, 渠道 }。
//
// 匹配规则复用 lib/resolve.js（完整 id → 精确名字 → 后缀 → id 前缀 → 模糊包含），
// 这里多管一件事：**跨渠道查找**。因为实例可能属于另一个平台或另一个账号，
// 只在一个渠道里找会出现「明明 ls 里有，exec 说找不到」。
//
// 查找顺序：指名渠道 → 默认渠道 → 其它渠道（按 channels.all() 的顺序）。
// 一旦命中就停 —— 同名实例以默认渠道优先，这也解释了「为什么 exec 走的是我常用的那个账号」。
const { match } = require('../resolve');
const channels = require('./channels');

/** `workbuddy:main/01` → { channel:'workbuddy:main', ref:'01' }；普通引用原样返回 */
function splitRef(ref) {
  const s = String(ref == null ? '' : ref).trim();
  const i = s.indexOf('/');
  if (i <= 0 || i === s.length - 1) return { channel: null, ref: s };
  const head = s.slice(0, i);
  // 前半段像渠道才拆（否则名字里带斜杠的实例就再也引用不到了）
  try {
    const { platform } = channels.parse(head);
    if (!platform || platform.startsWith('module:')) return { channel: null, ref: s };
    channels.get(head);                       // 顺带验证这个渠道真的能加载
    return { channel: head, ref: s.slice(i + 1) };
  } catch {
    return { channel: null, ref: s };
  }
}

/**
 * 在**一个**渠道里解析。
 * @param {object} ctx
 * @param {string} ref
 * @param {{refresh?: boolean}} [opts]
 */
async function resolveInstance(ctx, ref, { refresh = false } = {}) {
  const p = ctx.provider;
  let list = await p.instances.list(ctx, { refresh });
  let hits = match(list, ref);

  // 缓存可能是旧的（刚建的实例还没进列表）—— 未命中就强制刷新一次
  if (!hits.length && !refresh) {
    try {
      list = await p.instances.list(ctx, { refresh: true });
      hits = match(list, ref);
    } catch { /* 离线就按原结论报错 */ }
  }

  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const e = new Error(`「${ref}」在 ${ctx.channel} 里匹配到多个实例，请写全一点：\n  ` +
      hits.map((h) => `${h.id}  ${h.name || ''}`).join('\n  '));
    e.code = 'E_AMBIGUOUS';
    throw e;
  }
  const sample = (list || []).slice(0, 8).map((x) => `  ${x.id}  ${x.name || ''}`).join('\n');
  const e = new Error(`找不到实例「${ref}」${sample ? '\n现有：\n' + sample : ''}`);
  e.code = 'E_NOT_FOUND';
  throw e;
}

/** 依次问每个渠道；命中一个就返回，全都没命中就把各渠道的候选带回去（给报错用） */
async function find(cands, ref, opts) {
  const samples = [];
  let lastErr = null;
  for (const ch of cands) {
    let list;
    try {
      list = (await ch.provider.instances.list(ch.ctx, opts)) || [];
    } catch (e) {
      lastErr = lastErr || e;              // 某个渠道掉线不该让整条命令失败
      continue;
    }
    const hits = match(list, ref);
    if (hits.length === 1) return { hit: { inst: hits[0], ctx: ch.ctx, ch } };
    if (hits.length > 1) {
      const e = new Error(`「${ref}」在 ${ch.key} 里匹配到多个实例，写全一点或用渠道前缀：\n  ` +
        hits.map((h) => `${ch.key}/${h.id}  ${h.name || ''}`).join('\n  '));
      e.code = 'E_AMBIGUOUS';
      throw e;
    }
    if (list.length) {
      samples.push(`${ch.key}：\n` + list.slice(0, 8).map((x) => `  ${x.id}  ${x.name || ''}`).join('\n'));
    }
  }
  return { samples, lastErr };
}

/**
 * 跨渠道解析实例引用。
 * @param {object} ctx  调用方的 ctx（默认渠道）
 * @param {string} ref
 * @param {{refresh?: boolean, scoped?: boolean}} [opts] scoped=true 时只在默认渠道里找
 * @returns {Promise<{inst: object, ctx: object, ch: object}>}
 */
async function resolveTarget(ctx, ref, { refresh = false, scoped = false } = {}) {
  const q = splitRef(ref);
  if (q.channel) {
    const ch = channels.get(q.channel);
    ch.ctx.log = ctx.log || ch.ctx.log;
    return { inst: await resolveInstance(ch.ctx, q.ref, { refresh }), ctx: ch.ctx, ch };
  }

  const cands = [channels.fromCtx(ctx)];
  if (!scoped) {
    for (const ch of channels.othersOf(ctx)) {
      ch.ctx.log = ctx.log;                // 换渠道后日志前缀/落盘仍归调用方
      cands.push(ch);
    }
  }

  let r = await find(cands, ref, { refresh });
  if (r.hit) return r.hit;

  // 一次都没命中：可能是缓存太旧（刚在别的账号里建了实例），刷新一次再试
  if (!refresh) {
    r = await find(cands, ref, { refresh: true });
    if (r.hit) return r.hit;
  }

  const head = r.samples && r.samples.length
    ? `找不到实例「${ref}」。各渠道现有：\n` + r.samples.join('\n')
    : `找不到实例「${ref}」` + (r.lastErr ? `（${String(r.lastErr.message).slice(0, 160)}）` : '');
  const e = new Error(head);
  e.code = 'E_NOT_FOUND';
  throw e;
}

/**
 * 命令层用的入口：解析默认渠道 → 跨渠道找实例 → 顺手校验能力。
 * 「能力以命中渠道为准」：目标落在别的平台时，报错也该说那个平台缺什么。
 *
 * @param {string} ref
 * @param {{log?: Function, cap?: string, refresh?: boolean}} [opts]
 * @returns {Promise<{inst: object, ctx: object, ch: object}>}
 */
async function pickTarget(ref, opts = {}) {
  const ctx0 = channels.preferred().ctx;
  if (opts.log) ctx0.log = opts.log;
  const hit = await resolveTarget(ctx0, ref, { refresh: opts.refresh });
  if (opts.cap) hit.ctx.provider.require(opts.cap);
  return hit;
}

module.exports = { resolveInstance, resolveTarget, pickTarget, splitRef };
