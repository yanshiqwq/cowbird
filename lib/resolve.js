// 实例引用解析：支持三种写法
//   完整 id    2120000000000000000
//   会话名     wb-sandbox-01
//   短序号     01 / 1 / sandbox-01（按名字后缀匹配）
//
// 这里只保留**平台无关**的匹配规则；真正的数据来源走 provider.instances.list()。
// （历史包袱：以前直接读 WorkBuddy 的 conversations.json 缓存，现在由驱动自己管缓存。）
const ui = require('./ui');

/** 纯匹配：完整 id → 精确名字 → 后缀 → id 前缀 → 模糊包含 */
function match(list, ref) {
  const r = String(ref);
  if (/^\d{10,}$/.test(r)) {
    const hit = list.find((x) => String(x.id) === r);
    return hit ? [hit] : [{ id: r, name: '' }];
  }
  const low = r.toLowerCase();
  let hits = list.filter((x) => (x.name || '').toLowerCase() === low);
  if (hits.length) return hits;
  // 后缀匹配：01 → wb-sandbox-01；sandbox-01 → wb-sandbox-01
  hits = list.filter((x) => {
    const n = (x.name || '').toLowerCase();
    return n && (n.endsWith('-' + low) || n.endsWith(low)) && n !== low;
  });
  if (hits.length) return hits;
  // id 前缀（Qoder/码道的 id 是 uuid，很常用）
  hits = list.filter((x) => String(x.id).startsWith(r));
  if (hits.length) return hits;
  // 模糊包含
  return list.filter((x) => (x.name || '').toLowerCase().includes(low));
}

/** 当前平台的实例列表（归一化后） */
async function known({ refresh = false } = {}) {
  const registry = require('./platform');
  const p = registry.get();
  const ctx = registry.context(p);
  let list;
  try {
    list = await p.instances.list(ctx, { refresh });
  } catch (e) {
    throw new Error('拿不到实例列表（' + e.message + '）');
  }
  return (list || []).map((x) => ({
    id: String(x.id),
    name: x.name || '',
    status: x.status,
    sessionStatus: (x.extra && x.extra.sessionStatus) || null,
    updatedAt: x.updatedAt,
    archived: !!x.archived,
    raw: x,
  }));
}

/** 解析成单个实例；不唯一就抛带候选列表的错 */
async function resolve(ref, opts = {}) {
  // 延迟 require：platform/target 反过来要用本文件的 match，顶层互相 require 会成环
  const registry = require('./platform');
  const { resolveInstance } = require('./platform/target');
  const p = registry.get();
  const ctx = registry.context(p);
  try {
    return await resolveInstance(ctx, ref, opts);
  } catch (e) {
    if (e && e.code === 'E_NOT_FOUND' && !opts.quiet) {
      // 老代码靠 console.error 提示"这是缓存"；现在驱动自己会说明，这里只补一句来源
      void ui;
    }
    throw e;
  }
}

module.exports = { resolve, known, match };
