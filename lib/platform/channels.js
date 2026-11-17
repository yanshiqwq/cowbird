// 渠道 = 平台 × 账号。
//
// 「渠道」是内核里唯一对外的**寻址单位**：`workbuddy:main`、`qoder:alt`。
// 实例、登录态、保活目标、daemon 的每一轮动作都挂在某个渠道上，
// 这样「同一个平台开两个账号」「几个平台同时挂着」不需要两套代码。
//
// 引用写法（给命令行用）：
//   <平台>[:<账号>]                 workbuddy / workbuddy:main / qoder:alt
//   <渠道>/<实例>                   workbuddy:main/01、qoder:alt/3f2a…
// 平台与账号之间也接受 `@`（workbuddy@main），跟 docker/kubectl 的习惯对齐。
const cfg = require('../config');
const registry = require('./index');
const accounts = require('./accounts');

const PLATFORM_RE = /^[a-z_][a-z0-9_-]*$/;

function key(platform, account) {
  return `${platform}:${account}`;
}

/** 解析渠道引用。账号没写时为 null（调用方再按默认账号补） */
function parse(spec) {
  const s = String(spec || '').trim();
  if (!s) throw Object.assign(new Error('空的渠道名'), { code: 'E_BAD_CHANNEL' });
  // 外部驱动：整串都是模块说明
  if (s.startsWith('module:')) return { platform: s, account: null };
  const m = s.match(/^([^:@\s]+)(?:[:@]([^:@\s]*))?$/);
  const platform = m ? m[1] : s;
  const account = m && m[2] ? m[2] : null;
  if (account) accounts.assertValid(account);
  if (!PLATFORM_RE.test(platform) && !platform.startsWith('module:')) {
    throw Object.assign(new Error(`渠道名「${s}」不合法：平台部分只能是小写字母/数字/下划线/连字符`), { code: 'E_BAD_CHANNEL' });
  }
  return { platform, account };
}

function make(provider, account) {
  const ctx = registry.context(provider, { account });
  return {
    key: key(provider.id, ctx.account),
    platform: provider.id,
    account: ctx.account,
    provider,
    ctx,
    get hasCred() { return accounts.hasCred(provider.id, ctx.account); },
  };
}

/** 指名道姓拿一个渠道（账号目录不存在也照样给 —— login 需要它） */
function get(spec) {
  const { platform, account } = parse(spec);
  const provider = registry.load(platform);
  return make(provider, accounts.pick(provider.id, account));
}

/** 默认渠道：--channel > COWBIRD_CHANNEL > 默认平台 + 默认账号（--account 覆盖账号） */
function preferred(opts = {}) {
  const spec = opts.channel || cfg.envVal('COWBIRD_CHANNEL');
  if (spec) {
    const ch = get(spec);
    // `COWBIRD_CHANNEL=workbuddy` + `--account alt` 应该是「workbuddy 的 alt 账号」，
    // 而不是被渠道把账号锁死
    if (opts.account && opts.account !== ch.account) return get(`${ch.platform}:${opts.account}`);
    return ch;
  }
  const p = registry.get();
  return make(p, accounts.pick(p.id, opts.account));
}

/**
 * 默认渠道的键（配置里的平台 + 该平台的默认账号）：`workbuddy:default`。
 * 不加载驱动、不读盘以外的东西 —— account / platform 两条命令都用它来打 `*`。
 */
function defaultKey() {
  const c = (() => { try { return cfg.readConfig(); } catch { return {}; } })();
  const id = c.platform || cfg.DEFAULT_PLATFORM;
  return key(id, (c.accounts && c.accounts[id]) || accounts.DEFAULT_ALIAS);
}

/**
 * 所有「已经用过」的渠道（账号目录存在的）。
 * 顺序：配置里列出的渠道在前，其余按平台 id / 账号名排序 —— 保证输出稳定。
 */
function all() {
  const conf = (() => { try { return cfg.readConfig(); } catch { return {}; } })();
  const want = Array.isArray(conf.channels) ? conf.channels.filter(Boolean) : [];
  const ids = [...Object.keys(registry.BUILTIN).filter((id) => !id.startsWith('_'))];
  const ext = cfg.envVal('COWBIRD_PLATFORM_MODULE');
  if (ext) {
    try { const p = registry.load(`module:${ext}`); if (!ids.includes(p.id)) ids.push(p.id); } catch { /* 加载失败下面会体现 */ }
  }

  const out = [];
  for (const id of ids) {
    let provider;
    try { provider = registry.load(id); } catch { continue; }      // 驱动坏了不该拖垮 ls
    for (const alias of accounts.list(id)) out.push(make(provider, alias));
  }
  if (!want.length) return out;

  const rank = (ch) => {
    const i = want.indexOf(ch.key);
    return i < 0 ? want.length : i;
  };
  return out.sort((a, b) => rank(a) - rank(b));   // 配置里点过名的排前面，其余保持原序
}

/** 把调用方手里的 ctx 包成渠道 —— 复用同一个 ctx，别新造（ctx.log 之类的现场才留得住） */
function fromCtx(ctx) {
  return {
    key: ctx.channel,
    platform: ctx.provider.id,
    account: ctx.account,
    provider: ctx.provider,
    ctx,
    hasCred: true,
  };
}

/**
 * 聚合类命令（ls / doctor）该看哪些渠道。
 * 一旦用户显式指定了平台或渠道，就只给那一个 —— 否则全给，这才叫"共存"。
 * @param {{channel?:string, platform?:string, account?:string}} [opts] 命令自己的选项优先于环境
 */
function selected(opts = {}) {
  const one = opts.channel || cfg.envVal('COWBIRD_CHANNEL');
  const list = all();
  if (one) return [get(one)];
  const pf = opts.platform || cfg.envVal('COWBIRD_PLATFORM');
  if (pf) {
    const hits = list.filter((c) => c.platform === pf);
    return hits.length ? hits : [get(opts.account ? `${pf}:${opts.account}` : pf)];
  }
  return list.length ? list : [preferred(opts)];
}

/** 除自己之外的渠道（跨渠道找实例用） */
function othersOf(ctx) {
  const self = ctx && ctx.channel;
  return all().filter((c) => c.key !== self);
}

/** 人看的短名：workbuddy:main */
function label(ch) {
  return ch.key;
}

/** 从登录态里尽力捡出「这是谁」—— 各平台字段名不一样，捡不到就算了 */
function identityFrom(st) {
  if (!st || typeof st !== 'object') return null;
  const a = st.account || st.user || st.identity || st.profile || {};
  const cand = [a.nickname, a.name, a.username, a.email, a.uid, a.userId,
    st.nickname, st.userName, st.username, st.user_id, st.uid];
  for (const v of cand) if (v) return String(v);
  return null;
}

/**
 * 渠道的登录态摘要。**只读本地**，不联网 —— doctor 与 account ls 都会对每个渠道调一次。
 * 各平台的凭据形状完全不同，所以这里只按 auth 契约里的公共字段取值：
 * state() 给出登录态快照，ttlDays() 把快照换算成剩余天数（两边都是可选实现）。
 */
async function describeLogin(ch) {
  const meta = accounts.meta(ch.platform, ch.account) || {};
  const a = ch.provider.auth || {};
  let st = null;
  if (typeof a.state === 'function') {
    try { st = (typeof a.stateAsync === 'function' ? await a.stateAsync(ch.ctx) : await a.state(ch.ctx)) || {}; } catch { st = null; }
  }
  let ttl = null;
  if (st && typeof a.ttlDays === 'function') {
    try { ttl = a.ttlDays(st); } catch { ttl = null; }
  }
  const who = meta.nickname || meta.uid || identityFrom(st) || '';
  return {
    key: ch.key,
    platform: ch.platform,
    account: ch.account,
    displayName: ch.provider.displayName,
    who: who ? String(who) : '',
    uid: meta.uid || null,
    ttlDays: Number.isFinite(ttl) ? ttl : null,
    files: accounts.files(ch.platform, ch.account).length,
    hasCred: accounts.hasCred(ch.platform, ch.account),
    savedAt: meta.savedAt || meta.updatedAt || null,
  };
}

module.exports = {
  key, parse, get, make, fromCtx, preferred, defaultKey, all, selected, othersOf,
  label, describeLogin, identityFrom,
};
