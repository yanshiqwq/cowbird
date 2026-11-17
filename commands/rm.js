// cowbird rm —— 删除 / 归档实例
// 默认是 dry-run：只打印"会删什么"，加 --yes 才真删（删错了容器里的东西就没了）
const { parse, need } = require('../lib/args');
const ui = require('../lib/ui');
const { CAP } = require('../lib/platform/contract');
const { pickTarget } = require('../lib/platform/target');
const sandboxes = require('../lib/platform/sandboxes');
const log = require('../lib/log').log;

async function run(argv) {
  const args = parse(argv, { flags: ['yes', 'archive', 'json'], aliases: { y: 'yes' } });
  const [ref] = need(args, 1, 'rm <实例> [--archive] [--yes]');

  const { inst, ctx } = await pickTarget(ref, { log });
  const p = ctx.provider;
  if (!p.has(CAP.REMOVE)) throw new Error(`本平台（${p.displayName}）不支持删除实例`);
  const action = args.opts.archive ? '归档' : '删除';
  const kind = sandboxes.kindOf(ctx, inst);

  if (!args.opts.yes) {
    console.log(ui.c.yellow('DRY-RUN') + `  将${action}实例：`);
    console.log(`  id   ${inst.id}`);
    console.log(`  名字 ${inst.name || ui.c.dim('(未命名)')}`);
    console.log(`  渠道 ${ctx.channel}`);
    console.log(`  状态 ${ui.statusBadge(inst.status)}`);
    console.log(`  类型 ${kind === 'sandbox' ? '沙箱会话' : ui.c.yellow('用户会话') + ui.c.dim('（不是本工具建的）')}`);
    if (kind !== 'sandbox') {
      console.log(ui.c.yellow('  ⚠ 这是平台上的对话本身，删掉会连同它的聊天记录一起没'));
    }
    if (inst.status === 'working' || inst.status === 'running') {
      console.log(ui.c.red('  ⚠ 这个实例正在干活，删了会把正在跑的任务一起干掉'));
    }
    console.log(ui.c.dim(`\n确认无误后重跑：cowbird rm ${ref}${args.opts.archive ? ' --archive' : ''} --yes`));
    return 0;
  }

  await p.instances.remove(ctx, inst.id, { archive: !!args.opts.archive });
  sandboxes.forget(ctx, inst.id);                 // 登记簿跟着清掉，别留一个不存在的 id
  if (args.opts.json) console.log(JSON.stringify({ ok: true, id: inst.id, action }));
  else log(`已${action} ${inst.name || inst.id}`);
  return 0;
}

module.exports = {
  run,
  usage: 'rm <实例> [--archive] [--yes]',
  help: [
    '选项:',
    '  --archive   归档而不是删除',
    '  -y, --yes   真的执行（默认只打印将要做什么）',
    '',
    '说明:',
    '  默认 dry-run，不碰云端；确认无误后再加 --yes。',
    '  删除会连同沙箱里的数据一起没，不可恢复。',
    '',
    '退出码:',
    '  0  dry-run 结束 或 已执行',
    '  1  执行失败',
  ],
};
