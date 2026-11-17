// keepalive 的平台实现：维持 SSE 长连接 + 挂着提问，让会话停在 pending。
//
// 为什么在驱动里：这套东西完全建立在 ACP 的「提问不回就挂着」之上（见 lib/keepalive.js 文件头），
// 换一个平台就是另一套语义，所以它是 WorkerBuddy 的扩展点，不是内核契约的一部分。
// 内核只要求：能 create 出一个带 start({sec}) / stop(reason) 的对象。
const cfg = require('../../config');
const cloud = require('./lib/cloud');
const { Keepalive } = require('./lib/keepalive');
const { logf } = require('./util');

/**
 * @param {object} ctx
 * @param {string} id
 * @param {object} opts nudgeSec / maxNudges / questionTimeoutSec / stallAfterNudgeSec / prompt / noNudge
 * @returns {Promise<{start:Function, stop:Function}>}
 */
async function create(ctx, id, opts = {}) {
  const sid = String(id);
  const k = cfg.readConfig().keepalive || {};
  const log = opts.log || logf(ctx);

  // 每次重连前重新取凭据：顺手把快过期的 token 刷掉（纯 HTTP，不需要浏览器）
  const reload = async () => {
    const s = await cloud.getSession(sid, () => {});
    const left = s && s.expireAt ? s.expireAt * 1000 - Date.now() : Infinity;
    const lead = Number(k.leadMs) || 0;
    if (left < lead) {
      log('凭据剩余不足 ' + Math.round(lead / 36e5) + 'h，先续一次');
      return cloud.refreshSession(sid, () => {});
    }
    return s;
  };

  const s = await reload();
  return new Keepalive(s, {
    nudgeSec: opts.nudgeSec !== undefined ? opts.nudgeSec : k.nudgeSec,
    maxNudges: opts.maxNudges !== undefined ? opts.maxNudges : k.maxNudges,
    questionTimeoutSec: opts.questionTimeoutSec !== undefined ? opts.questionTimeoutSec : k.questionTimeoutSec,
    stallAfterNudgeSec: opts.stallAfterNudgeSec !== undefined ? opts.stallAfterNudgeSec : k.stallAfterNudgeSec,
    prompt: opts.prompt || k.prompt,
    noNudge: !!opts.noNudge,
    // 日志里的状态以控制面为准，跟 `cowbird ls --refresh` 同一个取法
    probeStatus: async () => {
      const d = await cloud.getConversation(sid);
      return { status: d.status, sessionStatus: d.sessionStatus, updatedAt: d.updatedAt };
    },
    reload,
    log: log,
  });
}

module.exports = { create };
