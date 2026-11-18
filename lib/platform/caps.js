// 能力缺失的唯一出口。
//
// 为什么单独一个文件：CLI 的退出码约定是「平台不支持 = 2，执行失败 = 1」
// （bin/cowbird.js 按 e.code 判）。早先 9 条命令各自 `new Error('本平台不支持…')`，
// 于是同一件事在 exec 上是 2、在 rm/create/rename/login 上是 1，脚本没法统一判据。
//
// 规矩：**凡是"平台做不到"的错，一律从这里造**，别在命令里手写 new Error。
const { ERR } = require('./contract');

/**
 * 造一个"平台缺能力"的错（bin 会把它映射成退出码 2）。
 * @param {string} message  人话，第一行说清缺什么
 * @param {{capability?:string, hint?:string}} [opts]
 */
function capabilityError(message, { capability = null, hint = '' } = {}) {
  const e = new Error(hint ? `${message}\n${hint}` : message);
  e.code = ERR.CAPABILITY;
  if (capability) e.capability = capability;
  return e;
}

/**
 * 断言 provider 有某能力。
 * @param {object} provider
 * @param {string} cap            CAP.* 能力位
 * @param {string|Function} [hint] 追加说明（函数会收到 provider）
 */
function assertCap(provider, cap, hint = '') {
  if (provider.has(cap)) return true;
  throw capabilityError(`本平台 ${provider.displayName} 不支持 ${cap}`, {
    capability: cap,
    hint: typeof hint === 'function' ? hint(provider) : hint,
  });
}

module.exports = { capabilityError, assertCap };
