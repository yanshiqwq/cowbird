'use strict';
// MiniMax Code（agent.minimax.cn）传输层：拼 URL / 公共 query / 三件套签名 / yy。
//
// 三条实测结论决定了这里的写法：
//   1. token 会**静默轮换**（旧 token 打 /tree 直接 401，新 token 200）⇒ 每次请求都从
//      ctx.store 重读快照，绝不在模块级缓存 token；顺手把响应里滚动出来的新 token 收回去；
//   2. `/minimax-cloud/*` 全部要求 yy，而 yy 的算法**没逆出来** ⇒ 缺 yy 时当场抛 E_NEED_YY，
//      不让一个必然 401 的请求发出去（也就不会被误判成「登录态坏了」）；
//   3. 签名 = md5(timestamp + SECRET + body)，body 为空时就是 md5(ts + SECRET)（逐字节实测过）。
//
// 本模块同时充当「yy 提供器」：允许把浏览器里抓到的 yy 写进 ctx.store 的 `yy`，
// 命中就带上、没命中才抛 —— 这样在 yy 逆出来之前也能用只读端点。
const crypto = require('crypto');

const BASE = 'https://agent.minimax.cn';
const STREAM_BASE = 'https://agent-stream.minimax.cn';
const CLOUD = '/minimax-cloud/api/v1';

// 签名盐：实测抓包逐字节反解出来的，别改。
const SIGN_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2';

// 公共 query 的字段与**顺序**（照实测抓包的顺序抄）；yy 的算法依赖 URL+params，
// 虽然我们算不出来，但保持同一顺序至少让"重放"这条路稳定。
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

// 明确"需要 yy"的端点：留一份清单给自己看，实际判定走 pathNeedsYY()。
const NEED_YY = new Set([
  P.tree, P.agents, P.skills, P.pluginsInstalled, P.pluginsEnabled,
  P.cron, P.project, P.channel, P.channelConnections, P.interaction,
]);

/**
 * 这个端点要不要 yy？
 * 实测结论：`/minimax-cloud/*` 全部要，**只有** config 例外；`/v1/api/*`（用户/登录）不要。
 * 写成函数而不是清单，是因为 session/{id}/... 这类路径是动态拼的，清单永远会漏。
 */
function pathNeedsYY(path) {
  const p = String(path || '');
  if (p === P.config) return false;
  if (p === P.events) return false;      // SSE 走 stream 域，token 在 query 里
  return p.startsWith(`${CLOUD}/`);
}


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
 * 解析"我是谁"：token 与设备标识。
 * 优先级：环境变量（临时试跑）> store 快照（正常路径）。
 * 每次调用都重读 —— token 轮换后自然拿到新的。
 */
function identity(ctx) {
  const snap = readAuth(ctx);
  const env = process.env || {};
  const token = String(env.MINIMAX_TOKEN || snap.token || '').trim();
  let uuid = String(env.MINIMAX_UUID || snap.uuid || '').trim();
  let deviceId = String(env.MINIMAX_DEVICE_ID || snap.device_id || snap.deviceId || '').trim();
  let userId = String(env.MINIMAX_USER_ID || snap.user_id || snap.userId || '').trim();
  const payload = token ? jwtPayload(token) : null;
  if (!userId && payload && payload.user && payload.user.id) userId = String(payload.user.id);
  return {
    token,
    uuid,
    deviceId,
    userId,
    source: env.MINIMAX_TOKEN ? 'env' : (snap.token ? 'store' : 'none'),
    exp: payload && payload.exp ? Number(payload.exp) : (numOrNull(snap.exp) || null),
    snapshot: snap,
  };
}

/**
 * 设备标识兜底：uuid / device_id 缺失时生成一份并落盘（只生成一次，之后稳定）。
 * 平台是否要求先 device/register 未验证，这里只保证"调用看起来像同一个浏览器"。
 */
function ensureDeviceIds(ctx, idn) {
  if (!idn.token || (idn.uuid && idn.deviceId)) return idn;
  const snap = idn.snapshot || {};
  const uuid = idn.uuid || crypto.randomUUID();
  const deviceId = idn.deviceId || uuid;
  const next = { ...snap, token: snap.token, uuid, device_id: deviceId, savedAt: snap.savedAt || new Date().toISOString() };
  try { if (ctx && ctx.store) ctx.store.write('auth', next); } catch { /* 落盘失败不影响本次请求 */ }
  return { ...idn, uuid, deviceId, generated: true, snapshot: next };
}

/**
 * 拼公共 query：固定字段按 QUERY_ORDER 排，调用方的额外参数同名就地覆盖、异名追加，
 * 最后无条件把 token 覆盖成最新值（token 在 query 里也有一份，且会轮换）。
 * @returns {Array<[string,string]>}
 */
function buildQuery(idn, { unix, extra } = {}) {
  const values = {
    ...QUERY_CONST,
    unix: String(unix),
    uuid: idn.uuid || '',
    device_id: idn.deviceId || '',
    user_id: idn.userId || '',
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
// yy 提供器
//
// yy = 32 hex，每请求一个，算法未逆出（bundle 里的结构与序列化顺序对不上）。
// 我们能做的只有"把浏览器里抓到的那一份记下来、下次照抄"：
//   store.read('yy') 支持三种形状：
//     'abcdef...'                                   ← 全局默认（对所有路径生效）
//     { yy:'...', path:'/minimax-cloud/api/v1/...' } ← 绑定某个路径
//     { entries:[ {...}, {...} ] }                   ← 多份，按路径挑
// 命中规则：路径完全匹配 > 路径前缀通配（末尾 *）> 未绑定路径的全局默认。
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
  const fromDefaults = ctx && ctx.defaults ? numOrNull(ctx.defaults.yyMaxAgeMs) : null;
  if (fromDefaults) return fromDefaults;
  let conf = {};
  try { conf = (ctx && ctx.config && ctx.config()) || {}; } catch { conf = {}; }
  const p = (conf.platforms && conf.platforms.minimax) || {};
  return numOrNull(p.yyMaxAgeMs) || 24 * 3600e3;
}

/**
 * 取一份可用 yy；没有就抛 E_NEED_YY（绝不发一个注定 401 的请求）。
 * @returns {{yy:string, path:string, source:string, capturedAt:number|null, ageMs:number|null}}
 */
function ensureYY(ctx, path, opts = {}) {
  const entries = readYYEntries(ctx);
  const hit = matchYY(entries, path);
  const base = '该端点需要 yy 头，算法未逆出；请用浏览器侧或以只读端点代替';
  if (!hit) {
    const known = entries.length ? `已记录的 yy 绑定在：${entries.map((e) => e.path || '*').join(', ')}` : '当前没有任何 yy 记录';
    throw err('E_NEED_YY', `${base}。缺失端点：${path}（${known}；把浏览器抓到的 yy 写进 store 键 yy，见 README「yy 的现状与绕过」）`, {
      path, needYY: true, hint: 'auth capture-yy / store.write(\'yy\', {yy, path})',
    });
  }
  const age = hit.capturedAt ? Date.now() - hit.capturedAt : null;
  const maxAge = yyMaxAge(ctx, opts);
  if (age !== null && age > maxAge) {
    throw err('E_NEED_YY', `${base}。记录里有一份 yy，但已经 ${Math.round(age / 1000)}s 未更新（上限 ${Math.round(maxAge / 1000)}s），请重新抓一份（端点：${path}）`, {
      path, needYY: true, expired: true,
    });
  }
  return { yy: hit.yy, path: hit.path || '*', source: hit.source, capturedAt: hit.capturedAt || null, ageMs: age };
}

/** 给人看的 yy 现状（auth.state / doctor 用） */
function yyStatus(ctx) {
  const entries = readYYEntries(ctx);
  const maxAge = yyMaxAge(ctx, {});
  return {
    available: entries.length > 0,
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
 * 构造一次请求（不发网络）。缺 token / 缺 yy 都在这里抛 —— 这是唯一的"门"。
 * @param {object} ctx
 * @param {object} opts { method, path, query, body, base:'api'|'stream', needYY, ts, unix, now }
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

  const unix = String(numOrNull(opts.unix) || nowMs(ctx, opts));
  const ts = String(opts.ts !== undefined && opts.ts !== null ? opts.ts : Math.floor(Number(unix) / 1000));

  // body：GET/HEAD 一律空串（签名对空 body 是 md5(ts+SECRET)）
  let bodyText = '';
  if (method !== 'GET' && method !== 'HEAD') {
    if (opts.body === undefined || opts.body === null) bodyText = '';
    else bodyText = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }

  const needYY = opts.needYY === true || (opts.needYY !== false && pathNeedsYY(path));
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

  let yy = null;
  if (needYY) {
    yy = ensureYY(ctx, path, opts);
    headers.yy = yy.yy;
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
      needYY,
      yy: yy ? { source: yy.source, path: yy.path, ageMs: yy.ageMs } : null,
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
  const built = build(ctx, opts);   // 缺 token / 缺 yy 在这里就抛，网络还没碰
  const f = resolveFetch(ctx, opts);
  const init = { ...built.init };
  const signal = makeSignal(opts);
  if (signal) init.signal = signal;

  let res;
  try {
    res = await f(built.url, init);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
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
      e.hint = built.meta.needYY
        ? '两个可能：① token 已被轮换/过期（重抓 auth 快照）；② 这份 yy 对这个端点无效（重抓该端点的 yy）'
        : 'token 过期或被轮换：重抓 auth 快照（旧 token 打受保护端点一律 401）';
    }
    throw e;
  }

  if (parseError) {
    throw err('E_PARSE', `${built.meta.path} 返回的不是 JSON：${snippet(text, 160)}`, { path: built.meta.path, body: snippet(text, 800) });
  }

  return { ok: true, status: res.status, data, text, url: redactUrl(built.url), meta: { ...built.meta, rotated } };
}

/** GET 便捷封装 */
function get(ctx, path, opts = {}) { return request(ctx, { ...opts, method: 'GET', path }); }

/** POST JSON 便捷封装（body 对象会被 stringify，且与签名用的是同一份字符串） */
function postJson(ctx, path, body, opts = {}) { return request(ctx, { ...opts, method: 'POST', path, body }); }

/**
 * 打开 SSE（agent-stream 域，token 在 query 里 —— 这条通道不需要 yy）。
 * @returns {Promise<{res:Response, url:string, meta:object}>}
 */
async function openStream(ctx, opts = {}) {
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
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield typeof value === 'string' ? value : dec.decode(value, { stream: true });
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
  const data = [];
  let event = '';
  let touched = false;
  for (const line of String(frame).split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;       // 心跳/注释
    const m = /^([a-zA-Z_]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    touched = true;
    if (m[1] === 'data') data.push(m[2]);
    else if (m[1] === 'event') event = m[2];
  }
  if (!touched) return null;
  return { data: data.join('\n'), event };
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
  NEED_YY,
  pathNeedsYY,
  sign,
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
  ensureYY,
  readYYEntries,
  matchYY,
  yyStatus,
  yyMaxAge,
  jwtPayload,
  numOrNull,
  tryParse,
};
