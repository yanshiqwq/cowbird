// 四条定时循环（heal / refresh / renew / warm）共用的轮次骨架。
//
// 为什么单独抽出来：这四个方法原本各自写一遍「busy 互斥 + try/finally 释放」，
// 漏一处就会让某条循环永远停摆（renew 的早退分支就漏过落盘）。骨架只留一份。
//
// 约定：fn 自己负责业务与状态记账；这里只管"同一轮不并发、异常不掐死调度器"。

/**
 * 跑一轮。
 * @param {object} sched  Scheduler 实例（只用 busy）
 * @param {string} name   轮次名（heal/refresh/renew/warm）
 * @param {Function} fn   实际干活的 async 函数
 * @returns 已有一轮在跑时返回 {skipped:'busy'}
 */
async function withRound(sched, name, fn) {
  if (!sched.busy) sched.busy = {};
  if (sched.busy[name]) return { skipped: 'busy' };
  sched.busy[name] = true;
  try {
    return await fn();
  } finally {
    sched.busy[name] = false;
  }
}

/** 日志里的轮次名（中文），给状态行用 */
const LABEL = { heal: '保活', refresh: '刷新', renew: '续期', warm: '登录态保活' };

module.exports = { withRound, LABEL };
