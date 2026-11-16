// 实例引用解析：支持三种写法
//   完整 id    2120000000000000000
//   会话名     wb-sandbox-01
//   短序号     01 / 1 / sandbox-01（按名字后缀匹配）
// 名字来自会话标题，缓存读 conversations.json；缓存里没有就联网拉一次。
const cfg = require('./config');
const cloud = require('./cloud');

function localKnown() {
  const byId = new Map();
  for (const c of cloud.cachedConversations()) {
    byId.set(String(c.id), { id: String(c.id), name: c.name || c.title || '', status: c.status, sessionStatus: c.sessionStatus });
  }
  // 只在 token 缓存里出现的 id：多半是早期实验留下的一次性会话，列表里已不存在。
  // 标记 local=true，默认不往 ls 里混（--all 才显示），但仍可用 id 直接操作。
  for (const id of cfg.cachedIds()) {
    if (!byId.has(id)) byId.set(id, { id, name: '', status: null, sessionStatus: null, local: true });
  }
  return [...byId.values()];
}

async function known({ refresh = false } = {}) {
  let list = localKnown();
  const unnamed = list.filter((x) => !x.name).length;
  if (refresh || list.length === 0 || unnamed === list.length) {
    try {
      const live = await cloud.listConversations();
      const byId = new Map(list.map((x) => [x.id, x]));
      for (const c of live) {
        const old = byId.get(String(c.id)) || {};
        byId.set(String(c.id), {
          id: String(c.id),
          // 服务端改名有延迟，返回空名字时别把缓存里的好名字冲掉
          name: c.name || c.title || old.name || '',
          status: c.status, sessionStatus: c.sessionStatus,
          lastActivityAt: c.lastActivityAt || c.updatedAt,
        });
      }
      list = [...byId.values()];
    } catch (e) {
      if (!list.length) throw new Error('拿不到会话列表（' + e.message + '）');
    }
  }
  return list;
}

function match(list, ref) {
  const r = String(ref);
  if (/^\d{10,}$/.test(r)) {
    const hit = list.find((x) => x.id === r);
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
  // id 前缀
  hits = list.filter((x) => x.id.startsWith(r));
  if (hits.length) return hits;
  // 模糊包含
  return list.filter((x) => (x.name || '').toLowerCase().includes(low));
}

async function resolve(ref, opts = {}) {
  let list = await known(opts);
  let hits = match(list, ref);
  // 缓存可能是旧的：刚 create 出来的实例还没进 conversations.json，
  // 而 known() 只要缓存"看起来完整"就不主动刷新 ⇒ 按名字找不到。
  // 所以未命中时无条件联网再找一次。
  if (!hits.length && !opts.refresh) {
    try {
      list = await known({ refresh: true });
      hits = match(list, ref);
    } catch { /* 没网就按原来的结论报错 */ }
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`「${ref}」匹配到多个实例，请写全一点：\n  ` +
      hits.map((h) => `${h.id}  ${h.name}`).join('\n  '));
  }
  const sample = list.slice(0, 8).map((x) => `  ${x.id}  ${x.name}`).join('\n');
  throw new Error(`找不到实例「${ref}」${sample ? '\n现有：\n' + sample : ''}`);
}

module.exports = { resolve, known };
