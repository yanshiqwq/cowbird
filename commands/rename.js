// cowbird rename —— 改实例名（会话标题）
const { parse, need } = require('../lib/args');
const ui = require('../lib/ui');
const { CAP } = require('../lib/platform/contract');
const { pickTarget } = require('../lib/platform/target');

async function run(argv) {
  const args = parse(argv, {});
  const [ref, title] = need(args, 2, 'rename <实例> <新名字>');

  const { inst, ctx } = await pickTarget(ref);
  const p = ctx.provider;
  if (!p.has(CAP.RENAME)) throw new Error(`本平台 ${p.displayName} 不支持改名`);
  await p.instances.rename(ctx, inst.id, title);
  console.log(ui.c.green('OK') + ` ${inst.id} → ${title}`);
  return 0;
}

module.exports = {
  run,
  usage: 'rename <实例> <新名字>',
  help: [
    '说明:',
    '  改的是会话标题，不是沙箱主机名。改名通常是异步的 —— 紧接着 ls 可能还看到旧名字。',
  ],
};
