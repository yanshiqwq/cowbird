// HTTP 传输层：本平台所有网络细节都关在这里，内核看不见 fetch。
//
// 三条实测得来的硬事实，整个驱动都建立在这上面：
//
// 1. **必需头**（少一个就 400 TM.00001001 或行为怪异）：
//       x-requested-with: XMLHttpRequest
//       agent-type: CodeBase                     ← 最容易被忘的一个
//       x-codearts-doer-scenario-type: web
//       cftk: <devclouddevuibjtcftk cookie 的值>  ← double-submit CSRF
//
// 2. **未登录不是 401**：HTTP 200 + 空响应体 + 头 `HW-AJAX-REDIRECT: …authui/login…`。
//    把 401 当唯一判据的话，程序会以为"成功拿到了空列表"，一路装死到底。
//    所以这里把"有重定向头"直接翻成 AuthError(code=E_NOT_LOGGED_IN)。
//
// 3. **网关 30 秒硬上限**：超时不报错，返回 200 + 空 state；命令仍在沙箱里跑，
//    期间再请求会 400 `{"name":"UnknownError","data":{"message":"Session … is busy"}}`。
//    前者在 shell.parseShellResult 里识别成 truncated，后者在这里翻成 E_BUSY（可重试）。

const auth = require('./auth');

const ORIGIN = 'https://devcloud.cn-north-4.huaweicloud.com';
const BASE = ORIGIN + '/chat';
const END_CODE = 'CODEBASE.00010628.200';

// 平台错误码 → 语义码 + 处置建议。全是实测/报告里的原码，改版时这里最先要动。
const CODES = {
  'CODEBASE.00010605.200': { code: 'E_NO_SANDBOX', retryable: false, hint: '沙箱从未创建：必须发一轮 agent 消息（wake）才会建' },
  'CODEBASE.00010610.409': { code: 'E_SANDBOX_UNAVAILABLE', retryable: true, hint: '沙箱当前不可用（曾创建过）：再发一轮消息让它重建' },
  'CODEBASE.00010606.200': { code: 'E_NO_PREVIEW', retryable: false, hint: '预览服务未启动：沙箱内 127.0.0.1:9800 没有监听' },
  'CODEBASE.00010609.502': { code: 'E_PREVIEW_UNAVAILABLE', retryable: true, hint: '预览服务暂不可用（如 SSE 走代理），换通道或稍后重试' },
  'CODEBASE.00010611.413': { code: 'E_TOO_LARGE', retryable: false, hint: '文件超出预览/大小限制，走下载接口' },
  'CODEBASE.00010628.200': { code: 'E_STREAM_ENDED', retryable: false, hint: '流正常结束（哨兵），不是错误' },
  'CODEBASE.00011002.400': { code: 'E_BAD_PARAMS', retryable: false, hint: '参数无效：answers 形状（数组的数组 + "label" - description）最常见' },
  'CODEBASE.00011003.401': { code: 'E_NO_ATOMGIT_TOKEN', retryable: false, hint: '缺 AtomGit token' },
  'TM.00001001': { code: 'E_NO_AGENT_TYPE', retryable: false, hint: '缺 Agent-Type 请求头' },
  'TM.00001050': { code: 'E_QUEUE', retryable: false, hint: '排队类错误，不要重试' },
};

class AuthError extends Error {
  constructor(message, { code = 'E_NOT_LOGGED_IN', detail = null } = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.detail = detail;
    this.auth = true;          // 内核/命令层可以据此提示"去登录"而不是"重试"
  }
}

class ApiError extends Error {
  constructor(message, { code = 'E_API', status = null, platformCode = null, retryable = false, retryAfterMs = null, hint = '', detail = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.platformCode = platformCode;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;      // 可重试错误建议的退避时长（busy 用得上）
    this.hint = hint;
    this.detail = detail;
  }
}

// ---------- 头与判定（纯函数，自测直接用） ----------
function opt(ctx, key, dflt) {
  let conf = {};
  try { const c = ctx && ctx.config && ctx.config(); conf = (c && c.platforms && c.platforms.codearts) || {}; } catch {}
  const v = conf[key] !== undefined ? conf[key] : (ctx && ctx.defaults ? ctx.defaults[key] : undefined);
  return v === undefined || v === null ? dflt : v;
}

function headerGet(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    try { return headers.get(name) || ''; } catch { return ''; }
  }
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) {
      const v = headers[k];
      return v === undefined || v === null ? '' : String(v);
    }
  }
  return '';
}

/**
 * 构造一次请求的头。
 * @param {object} st   auth.state() 的形状（含 cookies）
 * @param {{method?:string, accept?:string, extra?:object}} [opts]
 */
function buildHeaders(st, { method = 'GET', accept = 'application/json', extra = {} } = {}) {
  const cookies = (st && st.cookies) || [];
  const cftk = auth.cookieValue(cookies, auth.CFTK_COOKIE);
  const h = {
    'x-requested-with': 'XMLHttpRequest',
    'agent-type': 'CodeBase',
    'x-codearts-doer-scenario-type': 'web',
    'accept': accept,
    'accept-language': 'zh-CN,zh;q=0.9',
    'x-language': 'zh-cn',
    'referer': BASE + '/',
    'cookie': auth.cookieHeader(cookies),
    // 网页端恒发空串；不发也行，发了更像浏览器
    'x-auth-token': '',
  };
  if (cftk) h.cftk = cftk;
  if (String(method).toUpperCase() !== 'GET') h.origin = ORIGIN;   // 浏览器的跨源/同源 POST 才带 Origin，照抄
  return Object.assign(h, extra || {});
}

/**
 * 未登录判定。有 `HW-AJAX-REDIRECT` 就是网关要把你送登录页 —— 不管状态码是不是 200。
 * 返回重定向地址（字符串），没命中返回 ''。
 */
function isNotLoggedIn({ status, headers, text } = {}) {
  const redirect = headerGet(headers, 'hw-ajax-redirect');
  if (redirect) return redirect;
  // 兜底：明确的 401 也算没登录（本平台不常见，但别把 401 当业务错误吞了）
  if (Number(status) === 401 && !String(text || '').trim()) return 'HTTP 401';
  return '';
}

function codeOf(json) {
  if (!json || typeof json !== 'object') return '';
  return String(
    json.error_code ||
    json.errorCode ||
    (json.data && (json.data.error_code || json.data.errorCode)) ||
    (json.result && json.result.error_code) ||
    ''
  );
}

/** busy：同一条 kernel session 是串行的，上一条还没跑完时新请求会 400 UnknownError */
function isBusy(json) {
  if (!json || typeof json !== 'object') return false;
  const msg = String(
    (json.data && (json.data.message || json.data.msg)) ||
    json.message || json.error_msg || json.error || ''
  );
  return /is\s+busy/i.test(msg);
}

/** HTTP/业务错误 → ApiError（带语义码、平台码、可重试标记与建议） */
function apiError(status, json, text) {
  // busy 优先：它不是"错误码"，是 400 里的一句英文（{"name":"UnknownError",
  // "data":{"message":"Session … is busy"}}），语义是"上一条还在跑，退避重试"
  if (isBusy(json)) {
    return new ApiError('沙箱里上一条命令还在跑（Session … is busy）：同一条 kernel session 是串行的', {
      code: 'E_BUSY',
      status,
      retryable: true,
      retryAfterMs: 2000,
      hint: '退避后重试；长任务请用后台任务（exec.start + exec.poll）',
      detail: { busy: true, body: json },
    });
  }
  const platformCode = codeOf(json);
  const known = CODES[platformCode] || null;
  const msg = String(
    (json && (json.error_msg || json.error || json.message ||
      (json.data && (json.data.message || json.data.msg)))) ||
    (text && String(text).slice(0, 300)) ||
    `HTTP ${status}`
  );
  let code = known ? known.code : (status === 429 ? 'E_RATE_LIMIT' : (status >= 500 ? 'E_SERVER' : `E_HTTP_${status || 0}`));
  const retryable = known ? !!known.retryable : (status === 429 || status >= 500 || status === 409);
  return new ApiError(msg, {
    code, status, platformCode: platformCode || null, retryable,
    hint: (known && known.hint) || '',
    detail: { status, platformCode: platformCode || null, body: json || String(text || '').slice(0, 500) },
  });
}

// ---------- 超时 ----------
function timeoutError(ms, what) {
  const e = new ApiError(`${what || '请求'}超过 ${ms}ms 未返回（网关 30s 硬上限，命令可能仍在沙箱里继续跑）`, {
    code: 'E_TIMEOUT', retryable: true, hint: '改用后台任务（exec.start + exec.poll），或缩小命令粒度',
  });
  return e;
}

function combineSignals(signals) {
  const list = (signals || []).filter(Boolean);
  if (list.length <= 1) return list[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  return list[0];
}

async function fetchWithTimeout(url, init, ms) {
  const ac = new AbortController();
  const timer = ms > 0 ? setTimeout(() => { try { ac.abort(); } catch {} }, ms) : null;
  try {
    return await fetch(url, { ...init, signal: combineSignals([init.signal, ac.signal]) });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError' || /aborted/i.test(String(e.message)));
    if (aborted && timer) throw timeoutError(ms);
    if (aborted) throw e;
    const net = new ApiError(`连不上码道网关：${e && e.message}`, { code: 'E_NET', retryable: true });
    net.cause = e;
    throw net;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function tryJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---------- 传输器 ----------
const cache = new WeakMap();     // ctx → Transport（同一 ctx 复用，省掉重复拼头）

function createTransport(ctx) {
  if (ctx && typeof ctx === 'object' && cache.has(ctx)) return cache.get(ctx);

  const base = String(opt(ctx, 'baseUrl', BASE)).replace(/\/+$/, '');
  const defaultTimeoutMs = Number(opt(ctx, 'requestTimeoutMs', 30000));
  const idleTimeoutMs = Number(opt(ctx, 'streamIdleTimeoutMs', 120000));

  const t = {
    base,
    origin: ORIGIN,

    _state() {
      const st = auth.read(ctx);
      if (!st || !(st.cookies || []).length) {
        throw new AuthError(
          '没有码道登录态：先跑 `cowbird login --platform codearts`（浏览器登录，或用 --cookie 粘一串），' +
          '或 `cowbird login --platform codearts --cookie "<从 DevTools 复制的 cookie>"`。'
        );
      }
      return st;
    },

    /**
     * 普通请求。返回 {status, headers, json, text}。
     * 2xx 且带 error_code 的也会抛（本平台把错误也塞 200 里）。
     */
    async request(method, path, { body, headers, timeoutMs = defaultTimeoutMs, signal, accept, retried = false } = {}) {
      const st = t._state();
      const h = buildHeaders(st, { method, accept, extra: headers });
      let payload;
      if (body !== undefined) {
        h['content-type'] = 'application/json';
        payload = typeof body === 'string' ? body : JSON.stringify(body);
      }

      const url = base + path;
      const res = await fetchWithTimeout(url, { method, headers: h, body: payload, signal }, timeoutMs);
      const text = await res.text();                // 空体也要读掉，否则连接不释放

      // ① 未登录（200 + 空体 + HW-AJAX-REDIRECT）
      const redirect = isNotLoggedIn({ status: res.status, headers: res.headers, text });
      if (redirect) {
        throw new AuthError(
          `登录态失效：网关把请求重定向到登录页（HW-AJAX-REDIRECT: ${String(redirect).slice(0, 120)}）。` +
          '重新跑 cowbird login --platform codearts。',
          { detail: { redirect, status: res.status, path } }
        );
      }

      // ② 滚动刷新的 Set-Cookie（只认 2xx，理由同 lib/session.js：错误响应里的清 cookie 不是给我们看的）
      if (res.status >= 200 && res.status < 300 && typeof res.headers.getSetCookie === 'function') {
        const sc = res.headers.getSetCookie();
        if (sc && sc.length) { try { auth.absorb(ctx, sc); } catch {} }
      }

      // ③ 401：重读一次登录态再试一次（别人可能刚好刷新了 cookie 文件）
      if (res.status === 401 && !retried) {
        return t.request(method, path, { body, headers, timeoutMs, signal, accept, retried: true });
      }

      const json = tryJson(text);
      if (json && codeOf(json) === END_CODE) {
        // 哨兵码：当正常结束返回（调用方自己看 error/type 字段）
        return { status: res.status, headers: res.headers, json, text };
      }
      if (res.status >= 300 || (json && codeOf(json))) {
        throw apiError(res.status, json, text);
      }
      return { status: res.status, headers: res.headers, json, text };
    },

    /** 只要 JSON 的便捷入口（错误已抛） */
    async json(method, path, opts) {
      return t.request(method, path, opts);
    },

    /**
     * 打开一条 SSE（或任意流）。返回 {status, headers, res, close()}。
     * 连接超时只覆盖"拿到响应头"这一段；拿到之后由 frames() 的空闲超时接管。
     */
    async openStream(method, path, { body, headers, connectTimeoutMs = 30000, signal } = {}) {
      const st = t._state();
      const h = buildHeaders(st, { method, accept: 'text/event-stream', extra: headers });
      let payload;
      if (body !== undefined) {
        h['content-type'] = 'application/json';
        payload = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const res = await fetchWithTimeout(base + path, { method, headers: h, body: payload, signal }, connectTimeoutMs);

      const redirect = headerGet(res.headers, 'hw-ajax-redirect');
      if (redirect) {
        try { await res.text(); } catch {}
        throw new AuthError(
          `登录态失效：网关把请求重定向到登录页（HW-AJAX-REDIRECT: ${String(redirect).slice(0, 120)}）。重新跑 cowbird login。`,
          { detail: { redirect, status: res.status } }
        );
      }

      const ct = headerGet(res.headers, 'content-type').toLowerCase();
      if (res.status >= 300 || ct.includes('application/json') || ct.includes('text/html')) {
        const text = await res.text().catch(() => '');
        throw apiError(res.status, tryJson(text), text);
      }

      return {
        status: res.status,
        headers: res.headers,
        contentType: ct,
        res,
        async close() { try { if (res.body) await res.body.cancel(); } catch {} },
      };
    },

    /**
     * 逐帧读 SSE。
     * @param {object} stream openStream() 的返回值
     * @param {{idleTimeoutMs?:number, signal?:AbortSignal}} [opts]
     */
    async *frames(stream, { idleTimeoutMs: idle = idleTimeoutMs, signal } = {}) {
      const sse = require('./sse');
      if (!stream || !stream.res || !stream.res.body) throw new ApiError('这条流没有可读的响应体', { code: 'E_NO_BODY' });
      const reader = stream.res.body.getReader();
      const dec = new TextDecoder();
      const parser = sse.createParser();
      let lastByteAt = Date.now();

      try {
        for (;;) {
          if (signal && signal.aborted) break;
          // readWithIdle 给的是 ReadableStream 的 {value, done} —— 不是字节本身
          const r = await readWithIdle(reader, idle, () => Date.now() - lastByteAt);
          if (!r || r.done) break;                          // EOF
          lastByteAt = Date.now();
          const text = dec.decode(r.value, { stream: true });
          for (const f of parser.push(text)) yield f;
        }
        const tail = dec.decode();
        const finalFrames = [...(tail ? parser.push(tail) : []), ...parser.end()];
        for (const f of finalFrames) yield f;
      } finally {
        try { await reader.cancel(); } catch {}
      }
    },
  };

  if (ctx && typeof ctx === 'object') cache.set(ctx, t);
  return t;
}

/**
 * reader.read() 带空闲超时。
 * 为什么需要：提问挂起时服务端只发 heartbeat（约 15s 一条），若 15s+ 一个字节都没有，
 * 说明链路已经半开（keepalive 场景实测过：TCP 还在，数据永远不来）。
 */
function readWithIdle(reader, idleMs, sinceLastByte) {
  const p = reader.read();
  if (!idleMs || idleMs <= 0) return p;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ApiError(
        `SSE 流已 ${Math.round((sinceLastByte ? sinceLastByte() : idleMs) / 1000)}s 没有新字节（含 heartbeat），判定链路已死`,
        { code: 'E_STREAM_IDLE', retryable: true, hint: '服务端这一轮可能仍在跑：用 history 补回，或重连 …/stream' }
      ));
    }, idleMs);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

module.exports = {
  ORIGIN, BASE, END_CODE, CODES,
  AuthError, ApiError,
  opt, headerGet, buildHeaders, isNotLoggedIn, codeOf, isBusy, apiError,
  timeoutError, fetchWithTimeout, tryJson, createTransport,
};
