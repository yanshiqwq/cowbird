// 实例引用解析（平台无关）：把 `01` / 名字 / 完整 id 解析成一个 Instance。
//
// 复用 lib/resolve.js 里那套匹配规则（完整 id → 精确名字 → 后缀 → id 前缀 → 模糊包含），
// 但数据来源换成 provider.instances.list()，所以任何平台都能用。
const { match } = require('../resolve');

/**
 * @param {object} ctx   registry.context(provider)
 * @param {string} ref   实例引用
 * @param {object} [opts] { refresh:boolean }
 * @returns {Promise<object>} Instance
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
    const e = new Error(`「${ref}」匹配到多个实例，请写全一点：\n  ` +
      hits.map((h) => `${h.id}  ${h.name || ''}`).join('\n  '));
    e.code = 'E_AMBIGUOUS';
    throw e;
  }
  const sample = (list || []).slice(0, 8).map((x) => `  ${x.id}  ${x.name || ''}`).join('\n');
  const e = new Error(`找不到实例「${ref}」${sample ? '\n现有：\n' + sample : ''}`);
  e.code = 'E_NOT_FOUND';
  throw e;
}

module.exports = { resolveInstance };
