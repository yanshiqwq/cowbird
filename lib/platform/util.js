// 内核与驱动共用的小工具。
//
// 这些函数以前在每个驱动里各写一份（sleep 13 份、单引号转义 4 份……），
// 抄错一处就是 bug 或注入。平台无关的东西一律放这里。

/** 等一会儿（`await sleep(2000)`） */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

/** 数字或默认值（空串/NaN 都算没有） */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 把输出裁到上限（按字符数，给"人类可读日志"用；字节级裁剪请按 Buffer 算） */
function clip(v, max) {
  const s = String(v === undefined || v === null ? '' : v);
  if (!max || s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断：原始 ${s.length} 字符，上限 ${max}）`;
}

/** 单行摘要（日志/错误信息用）：压掉换行、截断 */
function oneLine(v, max = 200) {
  return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 把明显的凭据形状打码：token=xxx / authorization: xxx / cookie: xxx */
function redact(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/((?:token|access_token|authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*)([^\s,;"']{4,})/gi, '$1***');
}

/** 这段字节是不是合法 UTF-8（决定文本通道能不能无损写） */
function isUtf8(buf) {
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

module.exports = { sleep, numOrNull, clip, oneLine, redact, isUtf8 };
