// 统一的 HTTP 发送：超时、取消、错误归一、读 JSON。
//
// 四个驱动以前各自 `fetch(... AbortSignal.timeout(...))` + 自己判异常 + 自己 try JSON，
// 细节全在漂移（有的把调用方 abort 误报成超时，有的在 AbortSignal.any 缺失时静默丢掉超时）。
// 这里只保留一份，**只管"怎么发、怎么读、怎么把异常归一"**；
// 头怎么拼、401 怎么重试仍归各驱动（那是平台语义）。
const { ERR } = require('./contract');

class HttpError extends Error {
  constructor(message, { code = ERR.NETWORK, status = null, retryable = false, cause = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/** 把多个 AbortSignal 合成一个（Node 18 早期没有 AbortSignal.any，手写一个） */
function combineSignals(signals) {
  const list = (signals || []).filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ac = new AbortController();
  for (const s of list) {
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => { try { ac.abort(s.reason); } catch { /* 已中止 */ } }, { once: true });
  }
  return ac.signal;
}

/**
 * 发一个请求，**不抛 HTTP 状态错误**（4xx/5xx 原样返回，由调用方判）。
 * 只有网络层失败/超时才抛 HttpError。
 *
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string|object, timeoutMs?:number,
 *          signal?:AbortSignal, fetchImpl?:Function}} [opts]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, opts = {}) {
  const {
    method = 'GET', headers, body, timeoutMs = 30000, signal, fetchImpl = fetch,
  } = opts;
  const ac = new AbortController();
  let firedTimeout = false;
  const timer = timeoutMs > 0
    ? setTimeout(() => { firedTimeout = true; try { ac.abort(new Error('timeout')); } catch { /* 已中止 */ } }, timeoutMs)
    : null;
  const sig = combineSignals([signal, ac.signal]);
  const payload = body === undefined || body === null || typeof body === 'string'
    ? body
    : JSON.stringify(body);
  try {
    return await fetchImpl(url, { method, headers, body: payload, signal: sig });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError' || /aborted|abort/i.test(String(e.message)));
    if (firedTimeout) {
      throw new HttpError(`请求超过 ${timeoutMs}ms 未返回：${method} ${url}`, { code: ERR.TIMEOUT, retryable: true, cause: e });
    }
    if (aborted) {
      // 调用方主动取消：不是超时，别把排查方向带偏
      throw new HttpError(`请求被取消：${method} ${url}`, { code: ERR.NETWORK, retryable: false, cause: e });
    }
    throw new HttpError(`连不上 ${url}：${(e && e.message) || e}`, { code: ERR.NETWORK, retryable: true, cause: e });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 非 JSON 一律 null（HTTP 错误页、空体、HTML 登录页都很常见） */
function tryJson(text) {
  const t = String(text === undefined || text === null ? '' : text);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** 读响应体并解 JSON：{status, ok, headers, text, json} */
async function readJson(res) {
  const text = await res.text();
  return { status: res.status, ok: res.ok, headers: res.headers, text, json: tryJson(text) };
}

module.exports = { HttpError, fetchWithTimeout, combineSignals, tryJson, readJson };
