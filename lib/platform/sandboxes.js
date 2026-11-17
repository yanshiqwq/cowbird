// 沙箱登记簿：哪些「平台会话」是我们当沙箱用的。
//
// 为什么需要这一层：这些平台上的「会话」是用户自己的东西 —— 你在网页里随便聊两句也是一个
// 会话（WorkBuddy 上一个会话还配一个容器）。平台不提供「这是用户会话 / 这是工具建的沙箱」
// 这种字段，只有我们自己知道谁是谁。
//
// 于是本工具的定义收敛成一句话：**沙箱会话 = 登记过的会话**。三个入口：
//   · cowbird create           建出来就登记（source=create）
//   · cowbird adopt <引用>     把平台上已有的会话收编（source=adopt）
//   · cowbird daemon targets add  保活目标必然是沙箱（source=keepalive）
//
// 登记表按渠道存放（ctx.store → accounts/<账号>/sandboxes.json），所以多账号天然隔离：
// A 账号收编的会话，在 B 账号的 ls 里不会冒出来。
//
// 没登记的会话一律按「用户会话」处理。`cowbird ls` 默认只列沙箱会话，
// `--all` 才会把平台上的用户会话一起列出来（并标出类型）。
const NAME = 'sandboxes';

// 这只是「我们建过什么」的备忘，不是审计日志：超过上限就丢最旧的。
const MAX = 2000;

const key = (id) => String(id === undefined || id === null ? '' : id).trim();

function atStore(ctx) {
  return ctx && ctx.store && typeof ctx.store.read === 'function' ? ctx.store : null;
}

/** 整表读出来（循环里请读一次，别每个实例读一遍盘） */
function read(ctx) {
  const s = atStore(ctx);
  if (!s) return {};
  const raw = s.read(NAME, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function write(ctx, map) {
  const s = atStore(ctx);
  if (!s) throw new Error('沙箱登记簿写不进去：ctx.store 不可用');
  s.write(NAME, map);
}

/**
 * 登记一个实例。
 * @param {object} ctx
 * @param {{id:string|number, name?:string}} inst
 * @param {'create'|'adopt'|'keepalive'} [source]
 */
function record(ctx, inst, source = 'create') {
  const id = key(inst && inst.id);
  if (!id) throw new Error('sandboxes.record() 需要实例 id');
  const map = read(ctx);
  const prev = map[id] || {};
  map[id] = {
    id,
    name: String((inst && inst.name) || prev.name || ''),
    at: new Date().toISOString(),
    source: String(source || prev.source || 'create'),
  };
  const ids = Object.keys(map);
  if (ids.length > MAX) {
    ids.sort((a, b) => String((map[a] && map[a].at) || '').localeCompare(String((map[b] && map[b].at) || '')));
    for (const k of ids.slice(0, ids.length - MAX)) delete map[k];
  }
  write(ctx, map);
  return map[id];
}

/** 注销一个（删除实例后调用；不改平台侧任何东西） */
function forget(ctx, id) {
  const k = key(id);
  const map = read(ctx);
  if (!map[k]) return false;
  delete map[k];
  write(ctx, map);
  return true;
}

function get(ctx, id) {
  return read(ctx)[key(id)] || null;
}

/** 全部登记项（按登记时间倒序） */
function all(ctx) {
  return Object.values(read(ctx)).sort((a, b) => String(b && b.at).localeCompare(String(a && a.at)));
}

/** 纯函数：在一张已经读出来的登记表里查 */
function isSandbox(reg, inst) {
  const k = key(inst && inst.id);
  return Boolean(k && reg && Object.prototype.hasOwnProperty.call(reg, k));
}

/** 'sandbox' | 'session' —— ls 用这个决定列不列 */
function kindOf(ctx, inst) {
  return isSandbox(read(ctx), inst) ? 'sandbox' : 'session';
}

module.exports = { NAME, read, record, forget, get, all, isSandbox, kindOf };
