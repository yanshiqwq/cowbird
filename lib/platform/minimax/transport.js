'use strict';
// MiniMax Code（agent.minimax.cn）传输层：拼 URL / 公共 query / 三件套签名 / yy。
//
// 四条实测结论决定了这里的写法（2026-11-17 真机，逐字节验证）：
//   1. token 会**静默轮换**（旧 token 打 /tree 直接 401，新 token 200）⇒ 每次请求都从
//      ctx.store 重读快照，绝不在模块级缓存 token；顺手把响应里滚动出来的新 token 收回去；
//   2. `yy` 的算法**已经逆出来了**（computeYY()，见下），但它其实**不是门禁**：
//      把 yy 整个删掉，`/minimax-cloud/*` 照样 200 —— 服务端根本不校验它；
//   3. 签名 = md5(timestamp + SECRET + body)，body 为空时就是 md5(ts + SECRET)。
//      这条**是**硬门禁：签名错 → 400 `{"error":"invalid signature"}`；
//   4. 真正会被判 401 的是身份参数：query 里的 `user_id` 必须是 **realUserID**
//      （/v1/api/user/info 的 userInfo.realUserID，**不是** JWT 里的 user.id），
//      而 `device_id` 要么不传、要么是纯数字（传 UUID 一律 401）。
//      —— 当初「缺 yy 一律 401」的结论其实是踩了这两条，锅甩给了 yy。
//
// yy 仍然照算（算法见 computeYY），但只在调试时用 store/env 覆盖，缺了也绝不早停。
const crypto = require('crypto');
const sse = require('../sse');
const http = require('../http');

const BASE = 'https://agent.minimax.cn';
const STREAM_BASE = 'https://agent-stream.minimax.cn';
const CLOUD = '/minimax-cloud/api/v1';

// 签名盐：实测抓包逐字节反解出来的，别改。
const SIGN_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2';

// 公共 query 的字段与**顺序**（照实测抓包的顺序抄）。
// 顺序不影响服务端校验（实测两种顺序都 200），但保持一致让 yy 的中途调试能对得上。
//
// 注意这里**没有** `op_ticket`：浏览器里它是 `userInfo.op_ticket`（本账号 undefined），
// URLSearchParams 会把它序列化成字面量 `op_ticket=undefined`，而 axios 拼真 URL 时会把
// undefined 丢掉 ⇒ 它只出现在 yy 的输入里、不出现在 URL 上。见 withOpTicket()。
const QUERY_ORDER = [
  'device_platform', 'biz_id', 'app_id', 'version_code', 'unix', 'timezone_offset',
  'sys_language', 'lang', 'uuid', 'device_id', 'os_name', 'browser_name',
  'device_memory', 'cpu_core_num', 'browser_language', 'browser_platform',
  'user_id', 'screen_width', 'screen_height', 'token', 'client', 'region',
];

// 固定值部分（页面上的设备指纹，实测就是这样，无需随机）
const QUERY_CONST = {
  device_platform: 'web',
  biz_id: '3',
  app_id: '3001',
  version_code: '22201',
  timezone_offset: '28800',
  sys_language: 'zh',
  lang: 'zh',
  os_name: 'Windows',
  browser_name: 'Chrome',
  device_memory: '32',
  cpu_core_num: '24',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  screen_width: '2620',
  screen_height: '1280',
  client: 'web',
  region: 'cn',
};

// 与公共 query 里自称的浏览器指纹（os_name=Windows / browser_name=Chrome）保持一致；
// Node 默认 UA 是 `node`，很多网关会直接拦。是否被强校验未验证（见 README）。
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 端点表（全部来自实测；paths 只在这里定义，别在业务代码里手写字符串）
const P = {
  info: '/v1/api/user/info',                    // 唯一不需要 yy 的用户信息
  config: `${CLOUD}/config`,                     // 模型清单，也不需要 yy
  tree: `${CLOUD}/sidebar/session/tree`,         // 会话列表，需要 yy
  session: (id) => `${CLOUD}/session/${enc(id)}`,
  messages: (id) => `${CLOUD}/session/${enc(id)}/message`,
  queue: (id) => `${CLOUD}/session/${enc(id)}/queue`,
  inputSummaries: (id) => `${CLOUD}/session/${enc(id)}/input-summaries`,
  agents: `${CLOUD}/agent`,
  questionnaire: (id) => `${CLOUD}/agent/${enc(id)}/questionnaire/pending`,
  skills: `${CLOUD}/skill`,
  pluginsInstalled: `${CLOUD}/plugins/installed`,
  pluginsEnabled: `${CLOUD}/plugins/enabled`,
  cron: `${CLOUD}/cron`,
  project: `${CLOUD}/project`,
  channel: `${CLOUD}/channel`,
  channelConnections: `${CLOUD}/channel/connections`,
  interaction: `${CLOUD}/interaction/capabilities`,
  events: `${CLOUD}/events`,                     // SSE，走 STREAM_BASE
};

// 历史上这里有一张 NEED_YY 端点清单 + pathNeedsYY()，用来"缺 yy 就早停"。
// 2026-11-17 实测推翻了这个前提：yy 服务端不校验（连发都不发都 200），
// 于是清单和判定函数一起删了 —— 留着会让人以为还有这么一道门。
// 真正需要按端点区分的东西只剩 base（api / stream），那由 build() 的 opts.base 表达。

function enc(id) { return encodeURIComponent(String(id)); }

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/** 把 token 压成可安全打印的样子（日志/doctor 里绝不打全文） */
function preview(token) {
  const t = String(token || '');
  if (!t) return '';
  if (t.length <= 16) return `${t.slice(0, 4)}…`;
  return `${t.slice(0, 10)}…${t.slice(-4)}`;
}

/** JWT payload（不校验签名，只为了读 exp / user.id） */
function jwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
}

/** 把 URL 里的 token 打码（错误信息、日志里用） */
function redactUrl(url) {
  return String(url || '').replace(/([?&]token=)([^&]*)/g, (m, a, b) => a + preview(decodeURIComponent(b)));
}

function snippet(s, n = 240) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 登录态快照（{token, cookies, uuid, device_id, user_id, savedAt}），每次现读 */
function readAuth(ctx) {
  try {
    const s = ctx && ctx.store ? ctx.store.read('auth') : null;
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

/**
 * 解析"我是谁"：token、设备标识、以及**真正用于 query 的 user_id**。
 * 优先级：环境变量（临时试跑）> store 快照（正常路径）。
 * 每次调用都重读 —— token 轮换后自然拿到新的。
 *
 * `realUserId` 与 `userId` 是**两个不同的东西**，别混：
 *   - `userId` = JWT 里的 user.id，只用来展示/兜底；
 *   - `realUserId` = /v1/api/user/info 的 userInfo.realUserID，**query 里必须用它**。
 *     传 JWT 的 id 进去 → 401 空响应体（实测，就是当初被误判成「yy 不对」的那个 401）。
 */
function identity(ctx) {
  const snap = readAuth(ctx);
  const env = process.env || {};
  const token = String(env.MINIMAX_TOKEN || snap.token || '').trim();
  let uuid = String(env.MINIMAX_UUID || snap.uuid || '').trim();
  let deviceId = String(env.MINIMAX_DEVICE_ID || snap.device_id || snap.deviceId || '').trim();
  let userId = String(env.MINIMAX_USER_ID || snap.user_id || snap.userId || '').trim();
  let realUserId = String(env.MINIMAX_REAL_USER_ID || snap.realUserID || snap.real_user_id || '').trim();
  const payload = token ? jwtPayload(token) : null;
  if (!userId && payload && payload.user && payload.user.id) userId = String(payload.user.id);
  if (!realUserId) realUserId = '';
  return {
    token,
    uuid,
    deviceId,
    userId,
    realUserId,
    // query 里用的那一份：realUserID 优先，实在没有才退回 JWT id（会 401，但至少行为可解释）
    queryUserId: realUserId || userId,
    source: env.MINIMAX_TOKEN ? 'env' : (snap.token ? 'store' : 'none'),
    exp: payload && payload.exp ? Number(payload.exp) : (numOrNull(snap.exp) || null),
    snapshot: snap,
  };
}

/**
 * 设备标识兜底：uuid / device_id 缺失**或形状不对**时生成一份并落盘（只生成一次，之后稳定）。
 *
 * `device_id` 必须是**纯数字**（浏览器里是 sessionStorage 里一个 8 位随机数）。
 * 传 UUID 形状（我们早期版本就存的是 uuid）→ 服务端 401 空响应体；干脆不传反而 200。
 * 三条都实测过，别改回去。
 */
function ensureDeviceIds(ctx, idn) {
  const uuid = idn.uuid || crypto.randomUUID();
  const devOk = /^\d+$/.test(String(idn.deviceId || ''));
  const deviceId = devOk ? String(idn.deviceId) : String(1e7 + Math.floor(9e7 * Math.random()));
  if (!idn.token || (idn.uuid && devOk)) return idn;
  const snap = idn.snapshot || {};
  const next = { ...snap, token: snap.token, uuid, device_id: deviceId, savedAt: snap.savedAt || new Date().toISOString() };
  try { if (ctx && ctx.store) ctx.store.write('auth', next); } catch { /* 落盘失败不影响本次请求 */ }
  return { ...idn, uuid, deviceId, generated: true, snapshot: next };
}

/**
 * 拼公共 query：固定字段按 QUERY_ORDER 排，调用方的额外参数同名就地覆盖、异名追加，
 * 最后无条件把 token 覆盖成最新值（token 在 query 里也有一份，且会轮换）。
 *
 * `user_id` 取的是 **realUserID**（idn.queryUserId），不是 JWT 的 user.id —— 见 identity()。
 * @returns {Array<[string,string]>}
 */
function buildQuery(idn, { unix, extra } = {}) {
  const values = {
    ...QUERY_CONST,
    unix: String(unix),
    uuid: idn.uuid || '',
    device_id: idn.deviceId || '',
    user_id: idn.queryUserId || '',
    token: idn.token || '',
  };
  const pairs = QUERY_ORDER.map((k) => [k, values[k] === undefined ? '' : String(values[k])]);
  const index = new Map(pairs.map(([k], i) => [k, i]));
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null) continue;
    if (index.has(k)) pairs[index.get(k)][1] = String(v);
    else { index.set(k, pairs.length); pairs.push([k, String(v)]); }
  }
  // token 恒由身份决定：即使调用方传了 token 也要被覆盖掉（避免"拿旧 token 拼 query"）
  if (index.has('token')) pairs[index.get('token')][1] = idn.token;
  else pairs.push(['token', idn.token]);
  return pairs;
}

function stringifyPairs(pairs) {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** 签名：md5(timestamp + SECRET + body)；body 传空串就是 GET 的情形 */
function sign(timestamp, body = '') {
  return crypto.createHash('md5').update(`${timestamp}${SIGN_SECRET}${body}`).digest('hex');
}

// ---------------------------------------------------------------------------
// yy：已逆出（2026-11-17）
//
// 全部来自前端 bundle 的两段代码（模块 52724 + 65776，prod-web-sh-0.1.269）：
//
//   function wQ(e, t) {                       // 65776.wQ
//     let i = new URLSearchParams(t).toString();
//     return e.includes("?") ? `${e}&${i}` : `${e}?${i}`;
//   }
//   function yy({hasSearchParamsPath:t, bodyToYY:i, method:a, time:n, body:s}) {
//     let o = "{}";
//     a && "post" === a.toLowerCase() && (o = s ? JSON.stringify(s) : "{}");
//     i && (o = i);
//     return md5(`${encodeURIComponent(t)}_${o}${md5(n.toString())}ooui`);
//   }
//
// 逐字节验证：用浏览器里 hook fetch 抓到的 19 条真机请求（含 yy / x-timestamp / 完整 URL）
// 复算，**19/19 完全相同**；再把重算出来的 yy 拿去真打 /sidebar/session/tree 也是 200。
//
// 三个坑（当初「四种候选全不匹配」就卡在第 2 条）：
//   1. `encodeURIComponent` 作用在 `wQ(...)` 那一整个「path?query」字符串上，不是分段编；
//   2. `params` 里有一个**上线时会被 axios 丢掉**的 `op_ticket`（undefined → 字面量
//      `op_ticket=undefined`），所以 yy 的输入比你在 URL 里看到的多一段；
//   3. `time` 是 `Date.parse(new Date().toString())` —— **整秒**的毫秒数（毫秒位恒为 0），
//      也就是 URL 上那个 `unix=` 的值，不是 Date.now() 的原始毫秒。
//
// 结论（重要）：服务端**根本不校验 yy**（删掉也 200，随便填 32 hex 也 200）。
// 这里仍然照算，是为了「和浏览器逐字节一致」这件事本身可自证，以及哪天他们真开始校验。
// ---------------------------------------------------------------------------

function md5hex(s) { return crypto.createHash('md5').update(s).digest('hex'); }

/** URLSearchParams 的序列化语义（空格→`+`，`!~'()` 也转义）；和 encodeURIComponent 拼串不一样 */
function formEncode(params) {
  const sp = new URLSearchParams();
  if (Array.isArray(params)) {
    for (const [k, v] of params) sp.append(String(k), v === undefined ? 'undefined' : String(v));
  } else if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) sp.append(String(k), v === undefined ? 'undefined' : String(v));
  }
  return sp.toString();
}

/** bundle 里的 wQ(url, params) */
function wQ(url, params) {
  const q = formEncode(params);
  const u = String(url == null ? '' : url);
  return u.includes('?') ? `${u}&${q}` : `${u}?${q}`;
}

/** 把秒级/毫秒级时间戳统一成"整秒毫秒"（bundle 里那个 time） */
function toMsTime(ts) {
  const n = Math.floor(Number(ts));
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n < 1e11 ? n * 1000 : n;   // <1e11 当秒看（毫秒时间戳是 1.7e12 量级）
}

/**
 * 算一个 yy。
 * @param {string} url       请求路径（可带 query，可不带）；bundle 里就是 axios 的 e.url
 * @param {*} params         参数：对象或 [k,v] 数组（顺序即序列化顺序）
 * @param {number|string} ts 时间：秒级 x-timestamp 或毫秒 unix 都行（自动区分）
 * @param {*} body           请求体：GET 忽略；POST 用 JSON.stringify
 * @param {string} [method]  默认 GET
 * @returns {string} 32 位 hex
 */
function computeYY(url, params, ts, body, method) {
  const m = String(method || 'GET').toUpperCase();
  let bodyYY = '{}';
  if (m === 'POST') {
    if (body === undefined || body === null || body === '') bodyYY = '{}';
    else bodyYY = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const time = toMsTime(ts);
  if (!Number.isFinite(time)) throw err('E_ARGS', `computeYY 的时间戳不合法：${ts}`);
  const t = wQ(url, params);
  return md5hex(`${encodeURIComponent(t)}_${bodyYY}${md5hex(String(time))}ooui`);
}

/**
 * 在 [k,v] 列表里补上 `op_ticket=undefined`（位置照公共参数的插入顺序：user_id 之后）。
 * 只用于 yy 的输入，**不**进 URL。见文件头第 2 条坑。
 */
function withOpTicket(pairs) {
  const out = [];
  let placed = false;
  for (const kv of pairs) {
    if (String(kv[0]) === 'op_ticket') continue;    // 调用方自己给了就以后面补的为准
    out.push(kv);
    if (String(kv[0]) === 'user_id') { out.push(['op_ticket', 'undefined']); placed = true; }
  }
  if (!placed) out.push(['op_ticket', 'undefined']);
  return out;
}

// ---------------------------------------------------------------------------
// yy 覆盖（调试/取证用，正常路径用不上）
//
// store 的 `yy` 支持三种形状：
//   'abcdef...'                                    ← 对所有路径生效
//   { yy:'...', path:'/minimax-cloud/api/v1/...' } ← 绑定某个路径
//   { entries:[ {...}, {...} ] }                   ← 多份，按路径挑
// 命中规则：路径完全匹配 > 路径前缀通配（末尾 *）> 未绑定路径的全局默认。
// **不是必须**：yy 默认自算，覆盖只在你想复现某次抓包时有用。
// ---------------------------------------------------------------------------
const YY_RE = /^[0-9a-f]{32}$/i;

function normalizeYYEntry(e, parent) {
  if (!e) return [];
  if (typeof e === 'string') {
    const v = e.trim();
    return YY_RE.test(v) ? [{ yy: v, path: '*', capturedAt: null, source: 'store' }] : [];
  }
  if (typeof e !== 'object') return [];
  const val = String(e.yy || e.value || '').trim();
  if (!YY_RE.test(val)) return [];
  return [{
    yy: val,
    path: String(e.path || e.url_path || (parent && parent.path) || '*'),
    capturedAt: numOrNull(e.capturedAt || e.at || (parent && parent.capturedAt)),
    source: e.source || 'store',
  }];
}

function normalizeYY(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.flatMap((e) => normalizeYYEntry(e, null));
  if (typeof raw === 'string') return normalizeYYEntry(raw, null);
  if (typeof raw !== 'object') return [];
  if (Array.isArray(raw.entries)) {
    const base = { path: raw.path, capturedAt: raw.capturedAt || raw.at };
    return raw.entries.flatMap((e) => normalizeYYEntry(e, base));
  }
  return normalizeYYEntry(raw, null);
}

/** 所有已知的 yy 条目（环境变量优先，便于临时试跑） */
function readYYEntries(ctx) {
  const out = [];
  const env = String((process.env && process.env.MINIMAX_YY) || '').trim();
  if (YY_RE.test(env)) out.push({ yy: env, path: '*', capturedAt: null, source: 'env' });
  let raw = null;
  try { raw = ctx && ctx.store ? ctx.store.read('yy') : null; } catch { raw = null; }
  for (const e of normalizeYY(raw)) out.push(e);
  return out;
}

const normPath = (p) => String(p || '').split('?')[0].replace(/\/+$/, '');

/** 按路径挑一份 yy：完全匹配优先，其次通配，最后全局默认 */
function matchYY(entries, path) {
  const want = normPath(path);
  const exact = entries.find((e) => e.path && e.path !== '*' && !e.path.endsWith('*') && normPath(e.path) === want);
  if (exact) return exact;
  const wild = entries.find((e) => e.path && e.path.endsWith('*') && want.startsWith(normPath(e.path.slice(0, -1))));
  if (wild) return wild;
  return entries.find((e) => !e.path || e.path === '*') || null;
}

function yyMaxAge(ctx, opts = {}) {
  const fromOpts = numOrNull(opts.yyMaxAgeMs);
  if (fromOpts) return fromOpts;
  // 有效配置（defaults ← platforms.minimax）由内核合并进 ctx.effective，别再自己读盘
  const fromEffective = ctx && ctx.effective ? numOrNull(ctx.effective.yyMaxAgeMs) : null;
  if (fromEffective) return fromEffective;
  const fromDefaults = ctx && ctx.defaults ? numOrNull(ctx.defaults.yyMaxAgeMs) : null;
  if (fromDefaults) return fromDefaults;
  return 24 * 3600e3;
}

/**
 * 找一份**覆盖用**的 yy（env 优先于 store，按路径挑）；没有就返回 null。
 * 注意：这里**不再抛 E_NEED_YY** —— yy 自算，覆盖只是调试便利。
 * @returns {{yy:string, path:string, source:string, capturedAt:number|null, ageMs:number|null}|null}
 */
function findYYOverride(ctx, path, opts = {}) {
  const entries = readYYEntries(ctx);
  if (!entries.length) return null;
  const hit = matchYY(entries, path);
  if (!hit) return null;
  const age = hit.capturedAt ? Date.now() - hit.capturedAt : null;
  const maxAge = yyMaxAge(ctx, opts);
  if (age !== null && age > maxAge) return null;      // 过期的覆盖等于没有，回落到自算
  return { yy: hit.yy, path: hit.path || '*', source: hit.source, capturedAt: hit.capturedAt || null, ageMs: age };
}

/** 兼容旧名字（早期是"缺了就抛"的门禁）；现在只查覆盖，永不抛 */
function ensureYY(ctx, path, opts = {}) {
  return findYYOverride(ctx, path, opts);
}

/** 给人看的 yy 现状（auth.state / doctor 用） */
function yyStatus(ctx) {
  const entries = readYYEntries(ctx);
  const maxAge = yyMaxAge(ctx, {});
  return {
    // 服务端不校验 yy（实测删掉也 200），所以"有没有"不是可用性问题
    available: true,
    computed: true,
    mode: 'computed',                       // computed | override
    overrides: entries.length,
    maxAgeMs: maxAge,
    entries: entries.map((e) => ({
      path: e.path || '*',
      source: e.source,
      capturedAt: e.capturedAt ? new Date(e.capturedAt).toISOString() : null,
      expired: e.capturedAt ? Date.now() - e.capturedAt > maxAge : false,
    })),
  };
}

// ---------------------------------------------------------------------------
// 请求构造与发送
// ---------------------------------------------------------------------------

function nowMs(ctx, opts = {}) {
  if (numOrNull(opts.now)) return Number(opts.now);
  if (ctx && typeof ctx.now === 'function') { try { return Number(ctx.now()) || Date.now(); } catch { return Date.now(); } }
  return Date.now();
}

/** 环境里是否有 fetch */
let injectedFetch = null;
function setFetch(fn) { injectedFetch = fn; return fn; }
function resolveFetch(ctx, opts = {}) {
  const f = (opts && opts.fetch) || (ctx && ctx.fetch) || injectedFetch || globalThis.fetch;
  if (typeof f !== 'function') throw err('E_NO_FETCH', '当前运行时没有 fetch（需要 Node 18+，或用 transport.setFetch 注入）');
  // 用 call 调一次再包一层，避免 window/this 绑定的差异
  return (url, init) => f.call(null, url, init);
}

function makeSignal(opts = {}) {
  const ms = numOrNull(opts.timeoutMs);
  const own = ms && ms > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(Math.max(1, ms))
    : null;
  const base = opts.signal || null;
  if (base && own && typeof AbortSignal.any === 'function') return AbortSignal.any([base, own]);
  return base || own || null;
}

/**
 * 构造一次请求（不发网络）。唯一会在这里抛的是「没有 token」—— yy 自算，不再是门。
 * @param {object} ctx
 * @param {object} opts { method, path, query, body, base:'api'|'stream', yy, ts, unix, now }
 *   - `yy:false` 完全不发 yy 头；`yy:'32hex'` 临时覆盖一份；不传就自算
 *   - `ts` 秒级 x-timestamp；`unix` 毫秒。只给 ts 时 unix = ts*1000（和浏览器一致，整秒）
 * @returns {{url:string, init:{method:string, headers:object, body?:string}, meta:object}}
 */
function build(ctx, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const path = opts.path;
  if (!path) throw err('E_ARGS', 'build() 需要 path');
  if (typeof path !== 'string' || !path.startsWith('/')) throw err('E_ARGS', `path 必须是绝对路径：${path}`);

  const base = opts.base === 'stream' ? STREAM_BASE : BASE;
  const idn = ensureDeviceIds(ctx, identity(ctx));
  if (!idn.token) {
    throw err('E_NO_TOKEN', '没有 MiniMax token：先用浏览器登录并把 {token, cookies} 快照写进 store 的 auth（或设 MINIMAX_TOKEN 临时试跑）', {
      hint: 'provider.auth.login(ctx, {token, cookies})',
    });
  }

  // 浏览器里 ts = floor(time/1000)、unix = time（整秒毫秒），两者恒等 —— 这里照抄这个不变量。
  const now = nowMs(ctx, opts);
  const ts = String(opts.ts !== undefined && opts.ts !== null ? opts.ts : Math.floor(now / 1000));
  const unix = String(numOrNull(opts.unix) || (Number(ts) * 1000));
  if (!Number.isFinite(Number(unix)) || Number(unix) <= 0) throw err('E_ARGS', `unix 不合法：${unix}`);

  // body：GET/HEAD 一律空串（签名对空 body 是 md5(ts+SECRET)）
  let bodyText = '';
  if (method !== 'GET' && method !== 'HEAD') {
    if (opts.body === undefined || opts.body === null) bodyText = '';
    else bodyText = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  const pairs = buildQuery(idn, { unix, extra: opts.query });
  const url = `${base}${path}?${stringifyPairs(pairs)}`;

  const headers = {
    token: idn.token,
    'x-timestamp': ts,
    'x-signature': sign(ts, bodyText),
    'content-type': 'application/json',
    accept: opts.stream ? 'text/event-stream' : 'application/json',
    'user-agent': USER_AGENT,
  };

  // yy：默认自算（服务端其实不校验，见文件头）；`yy:false` 可以不发，store/env 可临时覆盖
  let yyMeta = null;
  if (opts.yy !== false) {
    const override = typeof opts.yy === 'string' && YY_RE.test(opts.yy)
      ? { yy: opts.yy, source: 'opts', path: '*', ageMs: null }
      : findYYOverride(ctx, path, opts);
    if (override) {
      headers.yy = override.yy;
      yyMeta = { source: override.source, path: override.path || '*', ageMs: override.ageMs };
    } else {
      // yy 的输入用"浏览器里那个 e.url"：
      //   api 域走 baseURL='/'，所以是相对路径；SSE 是绝对 URL（抓包里就是带域名的）
      const yyUrl = base === STREAM_BASE ? `${STREAM_BASE}${path}` : path;
      headers.yy = computeYY(yyUrl, withOpTicket(pairs), unix, bodyText, method);
      yyMeta = { source: 'computed', path: '*', ageMs: 0 };
    }
  }

  const init = { method, headers };
  if (bodyText) init.body = bodyText;

  return {
    url,
    init,
    meta: {
      method,
      path,
      base: opts.base === 'stream' ? 'stream' : 'api',
      ts,
      unix,
      // 兼容字段：yy 早就不是门禁了，恒为 true（真有需要就用 yy:false 关掉）
      needYY: opts.yy !== false,
      yy: yyMeta,
      userId: idn.queryUserId || '',
      realUserId: idn.realUserId || '',
      userIdIsReal: !!idn.realUserId,
      tokenSource: idn.source,
      tokenPreview: preview(idn.token),
      bodyBytes: Buffer.byteLength(bodyText),
      identityGenerated: !!idn.generated,
    },
  };
}

function readText(res) {
  if (!res) return Promise.resolve('');
  if (typeof res.text === 'function') return res.text().catch(() => '');
  return Promise.resolve('');
}

/**
 * 补齐 query 里那个必须的 `user_id`（= realUserID）。
 *
 * 为什么非补不可：服务端拿 `user_id` 跟登录态对账，对不上就是 401 **空响应体**，
 * 而 JWT 里的 `user.id` 跟 `userInfo.realUserID` **不是同一个数**（实测差好几位）。
 * 早期版本直接拿 JWT 的 id 塞进 query ⇒ 每条 /minimax-cloud/* 都 401，
 * 被误判成「yy 算法不对」，绕了一大圈。
 *
 * 只在快照里没有时才打一次 /v1/api/user/info（这条本身不需要 yy），拿到就写回快照。
 * @returns {Promise<string|null>} realUserID；拿不到返回 null（不抛，让上层照常失败并报 401）
 */
async function ensureRealUserId(ctx, opts = {}) {
  const idn = identity(ctx);
  if (idn.realUserId) return idn.realUserId;
  if (opts.__probeRealUser) return null;          // 防递归：探测请求自己不要再触发探测
  try {
    const r = await request(ctx, {
      method: 'GET',
      path: P.info,
      yy: false,
      __probeRealUser: true,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const d = (r && r.data) || {};
    const ui = (d.data && d.data.userInfo) || d.userInfo || d.data || null;
    const real = ui && ui.realUserID ? String(ui.realUserID) : '';
    if (!real) return null;
    const snap = readAuth(ctx);
    try {
      if (ctx && ctx.store) ctx.store.write('auth', { ...snap, realUserID: real, savedAt: snap.savedAt || new Date().toISOString() });
    } catch { /* 落盘失败不影响本次请求 */ }
    return real;
  } catch { return null; }
}

function looksLikeToken(v) {
  const t = String(v || '');
  return t.length >= 40 && t.split('.').length === 3;
}

/**
 * token 轮换：从响应里把新 token 收回来（Set-Cookie 的 _token 或 token 响应头）。
 * 平台会静默换 token，若不回收，下一次请求就会用旧 token 打 401 —— 表现得像"登录态坏了"。
 * @returns {{rotated:boolean, exp?:number|null}|null}
 */
function absorbToken(ctx, res) {
  if (!ctx || !ctx.store || !res || !res.headers) return null;
  const candidates = [];
  try {
    const getSetCookie = res.headers.getSetCookie;
    if (typeof getSetCookie === 'function') candidates.push(...(getSetCookie.call(res.headers) || []));
  } catch { /* 老运行时没有 getSetCookie */ }
  try {
    const h = res.headers.get('token') || res.headers.get('x-token');
    if (h) candidates.push(`token=${h}`);
  } catch { /* headers 假实现可能没有 get */ }

  let next = null;
  for (const c of candidates) {
    const m = /(?:^|[;,\s])_?token=([^;,\s]+)/i.exec(String(c));
    if (m && looksLikeToken(m[1])) {
      try { next = decodeURIComponent(m[1]); } catch { next = m[1]; }
      break;
    }
  }
  if (!next) return null;

  const snap = readAuth(ctx);
  if (snap.token === next) return null;
  const payload = jwtPayload(next);
  const merged = {
    ...snap,
    token: next,
    savedAt: snap.savedAt || new Date().toISOString(),
    rotatedAt: new Date().toISOString(),
    exp: payload && payload.exp ? Number(payload.exp) : (numOrNull(snap.exp) || null),
  };
  try { ctx.store.write('auth', merged); } catch { return null; }
  if (ctx.log) { try { ctx.log(`MiniMax token 已轮换（新 ${preview(next)}），已写回快照`); } catch { /* 日志失败不影响 */ } }
  return { rotated: true, exp: merged.exp };
}

/**
 * 发一次请求。JSON 响应自动解析；非 2xx 抛 E_HTTP（401/403 抛 E_UNAUTHORIZED）。
 * @returns {Promise<{ok:true,status:number,data:any,text:string,url:string,meta:object}>}
 */
async function request(ctx, opts = {}) {
  await ensureRealUserId(ctx, opts);   // query 里的 user_id 必须是 realUserID，缺了就补一次
  const built = build(ctx, opts);   // 缺 token 在这里就抛，网络还没碰
  const f = resolveFetch(ctx, opts);
  const init = { ...built.init };
  const signal = makeSignal(opts);
  if (signal) init.signal = signal;

  let res;
  try {
    // 发送/超时/取消统一走 lib/platform/http.js（四个驱动共用一份）
    res = await http.fetchWithTimeout(built.url, {
      ...built.init,
      timeoutMs: numOrNull(opts.timeoutMs) || 0,
      signal: opts.signal,
      fetchImpl: f,
    });
  } catch (e) {
    // 与迁移前保持同一套语义：取消与超时都归 E_ABORTED（上层据此"停止等待"而不是报错）
    if (e && (e.code === 'E_TIMEOUT' || /取消/.test(String(e.message)))) {
      throw err('E_ABORTED', `请求被取消：${built.meta.method} ${built.meta.path}`, { path: built.meta.path, cause: e });
    }
    throw err('E_NETWORK', `请求失败（${built.meta.method} ${built.meta.path}）：${(e && e.message) || e}`, {
      path: built.meta.path, url: redactUrl(built.url), cause: e,
    });
  }

  const rotated = absorbToken(ctx, res);
  const text = await readText(res);
  let data = null;
  let parseError = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { parseError = e; }
  }

  if (!res.ok) {
    const e = err('E_HTTP', `${built.meta.method} ${built.meta.path} 返回 ${res.status}${text ? '：' + snippet(text) : '（空响应体）'}`, {
      status: res.status,
      path: built.meta.path,
      body: snippet(text, 800),
      url: redactUrl(built.url),
      needYY: built.meta.needYY,
    });
    if (res.status === 401 || res.status === 403) {
      e.code = 'E_UNAUTHORIZED';
      e.hint = built.meta.userIdIsReal
        ? '401 基本只有三种原因：① token 已被轮换/过期（重抓 auth 快照）；'
          + `② query 里的 user_id 与服务端对不上（当前用的是 realUserID=${snippet(built.meta.userId, 32)}）；`
          + '③ device_id 不是纯数字（传 UUID 会 401）。签名错是 400 不是 401。'
        : '401 且快照里没有 realUserID：query 里的 user_id 只能用 JWT 的 user.id 兜底，而服务端要的是 '
          + 'userInfo.realUserID —— 先跑一次 auth.userId(ctx) 或任意一条 /v1/api/user/info 把 realUserID 补进快照。';
    }
    throw e;
  }

  if (parseError && !opts.allowNonJson) {
    throw err('E_PARSE', `${built.meta.path} 返回的不是 JSON：${snippet(text, 160)}`, { path: built.meta.path, body: snippet(text, 800) });
  }

  return {
    ok: true,
    status: res.status,
    data: parseError ? null : data,
    text,
    parseError: parseError || null,
    url: redactUrl(built.url),
    meta: { ...built.meta, rotated },
  };
}

/** GET 便捷封装 */
function get(ctx, path, opts = {}) { return request(ctx, { ...opts, method: 'GET', path }); }

/** POST JSON 便捷封装（body 对象会被 stringify，且与签名用的是同一份字符串） */
function postJson(ctx, path, body, opts = {}) { return request(ctx, { ...opts, method: 'POST', path, body }); }

/**
 * 打开 SSE（agent-stream 域，token 与全部公共参数都在 query 里）。
 * @returns {Promise<{res:Response, url:string, meta:object}>}
 */
async function openStream(ctx, opts = {}) {
  // 和 request() 一样：query 里的 user_id 必须是 realUserID，缺了先补一次
  await ensureRealUserId(ctx, { ...opts, __probeRealUser: opts.__probeRealUser });
  const built = build(ctx, { ...opts, method: 'GET', base: 'stream', stream: true });
  const f = resolveFetch(ctx, opts);
  const init = { ...built.init };
  const signal = makeSignal(opts);
  if (signal) init.signal = signal;

  let res;
  try {
    res = await f(built.url, init);
  } catch (e) {
    throw err('E_NETWORK', `事件流连接失败：${(e && e.message) || e}`, { url: redactUrl(built.url), cause: e });
  }
  absorbToken(ctx, res);
  if (!res.ok) {
    const text = await readText(res);
    throw err('E_STREAM_HTTP', `事件流返回 ${res.status}${text ? '：' + snippet(text) : ''}`, { status: res.status, body: snippet(text, 400) });
  }
  return { res, url: redactUrl(built.url), meta: built.meta };
}

/** 统一的字节流迭代（Web ReadableStream / async iterable / 字符串 都吃） */
async function* iterText(body) {
  if (body === null || body === undefined) return;
  if (typeof body === 'string') { yield body; return; }
  const dec = new TextDecoder();
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) yield typeof value === 'string' ? value : dec.decode(value, { stream: true });
      }
    } finally {
      // 上层看到 done 就 break，不 cancel 会留一条没关的连接（每条正常对话都漏一条）
      try { await reader.cancel(); } catch { /* 已结束 */ }
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
  }
}

/**
 * 把 SSE 响应变成"一条条 JSON 负载"。
 * 协议细节（事件名、是否分包、结束哨兵）实测里没抓到 ⇒ 这里做宽松解析：
 *   - 标准 SSE：按空行切帧，取 data: 行拼起来，JSON.parse 成功就吐对象；
 *   - `data: [DONE]` → {__done:true}
 *   - 服务端退化成 NDJSON / 一次性 JSON 也认（整段解析失败时逐行再试）；
 *   - 解析不了的原样吐 {__text}，由上层归到 raw 事件，不丢数据。
 */
async function* iterPayloads(res, { signal } = {}) {
  if (!res) return;
  let contentType = '';
  try { contentType = String(res.headers.get('content-type') || ''); } catch { contentType = ''; }

  // 有 content-type 就以它为准；没有才用"有没有 body 流"猜（见 README「未验证」）
  const isSSE = /event-stream/i.test(contentType) ? true : (contentType ? false : typeof res.body === 'object');
  if (!isSSE) {
    const text = await readText(res);
    const whole = tryParse(text);
    if (whole !== undefined) { yield whole; return; }
    for (const line of String(text).split(/\r?\n/)) {
      const v = tryParse(line);
      if (v !== undefined) yield v;
    }
    return;
  }

  let buf = '';
  let eventName = '';
  for await (const chunk of iterText(res.body)) {
    if (signal && signal.aborted) break;
    buf += chunk;
    let idx;
    // 帧分隔：空行（\n\n 或 \r\n\r\n）
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const parsed = parseSSEFrame(frame);
      if (!parsed) continue;
      if (parsed.event) eventName = parsed.event;
      if (parsed.data === '[DONE]') { yield { __done: true, event: eventName }; continue; }
      const obj = tryParse(parsed.data);
      if (obj !== undefined) yield obj;
      else if (parsed.data) yield { __text: parsed.data, event: eventName };
    }
  }
  // 收尾：最后一帧可能没有空行
  const tail = parseSSEFrame(buf);
  if (tail && tail.data) {
    if (tail.data === '[DONE]') yield { __done: true, event: tail.event };
    else {
      const obj = tryParse(tail.data);
      yield obj !== undefined ? obj : { __text: tail.data, event: tail.event };
    }
  }
}

function parseSSEFrame(frame) {
  if (!frame) return null;
  // 解析实现已上提到 lib/platform/sse.js（与 codearts / qoder 共用）
  const f = sse.parseBlock(String(frame));
  if (!f) return null;
  return { data: f.text, event: f.event };
}

function tryParse(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return undefined;
  if (!(t.startsWith('{') || t.startsWith('[') || t.startsWith('"'))) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

module.exports = {
  BASE,
  STREAM_BASE,
  CLOUD,
  SIGN_SECRET,
  QUERY_ORDER,
  QUERY_CONST,
  USER_AGENT,
  P,
  sign,
  md5hex,
  wQ,
  formEncode,
  toMsTime,
  computeYY,
  withOpTicket,
  preview,
  redactUrl,
  snippet,
  identity,
  readAuth,
  ensureDeviceIds,
  buildQuery,
  stringifyPairs,
  build,
  request,
  get,
  postJson,
  openStream,
  iterPayloads,
  setFetch,
  resolveFetch,
  findYYOverride,
  ensureYY,
  ensureRealUserId,
  readYYEntries,
  matchYY,
  yyStatus,
  yyMaxAge,
  jwtPayload,
  numOrNull,
  tryParse,
};
