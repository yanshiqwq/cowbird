// 实例引用的**匹配规则**（纯函数，平台无关）。
//
// 支持三种写法：
//   完整 id    2123456789012345678 / 3f2a-uuid
//   会话名     wb-sandbox-01
//   短序号     01 / 1 / sandbox-01（按名字后缀匹配）
//
// 「怎么拿到实例列表」「找不到时去哪个账号找」不在这里 —— 那是 lib/platform/target.js 的事。
function match(list, ref) {
  const r = String(ref);
  if (/^\d{10,}$/.test(r)) {
    const hit = list.find((x) => String(x.id) === r);
    // 没命中就返回空：别凭空造一个 {id} 假实例 —— 那会让 target.js 的
    // 「未命中就刷新一次」和「找不到实例」两条路径永远走不到，报错也说不清。
    return hit ? [hit] : [];
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

module.exports = { match };
