// 内核侧访问浏览器能力的唯一入口。
//
// 为什么要有这一层：`test/guard.js` 禁止 commands/ 与内核直接 require lib/browser
// （那属于"平台实现漏进内核"）。命令层需要知道的只有一件事——这台机器能不能弹浏览器，
// 所以这里只暴露最小的三个方法。
const core = require('../browser');

module.exports = {
  hasPlaywright: () => core.hasPlaywright(),
  chromeBin: () => core.chromeBin(),
  launchEphemeral: (opts) => core.launchEphemeral(opts),
};
