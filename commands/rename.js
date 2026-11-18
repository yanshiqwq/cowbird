// cowbird rename —— 改实例名（会话标题）
const { need } = require('../lib/args');
const ui = require('../lib/ui');
const { CAP } = require('../lib/platform/contract');
const { capabilityError } = require('../lib/platform/caps');
const { pickTarget } = require('../lib/platform/target');
const { defineCommand } = require('../lib/command');

module.exports = defineCommand({
  usage: 'rename <实例> <新名字>',
  notes: ['改的是会话标题，不是沙箱主机名。改名通常是异步的 —— 紧接着 ls 可能还看到旧名字。'],
  exits: [[0, '成功'], [1, '执行失败'], [2, '平台不支持改名']],
  run: async (args) => {
    const [ref, title] = need(args, 2, 'rename <实例> <新名字>');

    const { inst, ctx } = await pickTarget(ref);
    const p = ctx.provider;
    if (!p.has(CAP.RENAME)) throw capabilityError(`本平台 ${p.displayName} 不支持改名`, { capability: CAP.RENAME });
    await p.instances.rename(ctx, inst.id, title);
    console.log(ui.c.green('OK') + ` ${inst.id} → ${title}`);
    return 0;
  },
});
