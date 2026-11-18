'use strict';
// provider 内部共用的小工具：不包含任何 WorkBuddy 协议知识，也不碰网络。
// 单独一个文件是为了让 agent / exec / fsops 都能用同一份实现（尤其是 shell 单引号转义，
// 那东西抄错一处就是命令注入）。

/** ctx.log 可能被命令层替换，也可能压根没有 —— 统一包一层，日志永远不该让主流程失败 */
function logf(ctx) {
  return (msg) => {
    try { if (ctx && typeof ctx.log === 'function') ctx.log(msg); } catch { /* 日志失败不影响主流程 */ }
  };
}

const { sleep } = require('../util');

/**
 * POSIX shell 单引号转义：实现已上提到 lib/platform/shell.js。
 * 这里保留 shq 这个名字，是因为驱动内还有几处按老名字调用。
 */
const { q: shq } = require('../shell');

/** 安全取数：空串 / 非数字一律 null（cgroup 文件读不到时是空串，别让它变成 0） */
function num(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 按字节截断输出。只保留前 maxBytes 个字节 —— 截断了就把 truncated 标上，
 * 让内核知道"这不是全量"，而不是把半截结果当成完整结果用。
 */
function clipText(text, maxBytes) {
  const s = text === undefined || text === null ? '' : String(text);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: s, truncated: false };
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, truncated: false };
  return { text: Buffer.from(s, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true };
}

module.exports = { logf, sleep, shq, num, clipText };
