// wbsbx rm —— 删除 / 归档实例
// 默认是 dry-run：只打印"会删什么"，加 --yes 才真删（删错了容器里的东西就没了）
const { parse, need } = require('../lib/args');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const { CAP } = require('../lib/platform/contract');
const { resolveInstance } = require('../lib/platform/target');
const log = require('../lib/log').log;

async function run(argv) {
  const args = parse(argv, { flags: ['yes', 'archive', 'json'], aliases: { y: 'yes' } });
  const [ref] = need(args, 1, 'rm <实例> [--archive] [--yes]');

  const p = registry.get();
  if (!p.has(CAP.REMOVE)) throw new Error(`本平台（${p.displayName}）不支持删除实例`);
  const ctx = registry.context(p);
  const inst = await resolveInstance(ctx, ref);
  const action = args.opts.archive ? '归档' : '删除';

  if (!args.opts.yes) {
    console.log(ui.c.yellow('DRY-RUN') + `  将${action}实例：`);
    console.log(`  id   ${inst.id}`);
    console.log(`  名字 ${inst.name || ui.c.dim('(未命名)')}`);
    console.log(`  状态 ${ui.statusBadge(inst.status)}`);
    if (inst.status === 'working' || inst.status === 'running') {
      console.log(ui.c.red('  ⚠ 这个实例正在干活，删了会把正在跑的任务一起干掉'));
    }
    console.log(ui.c.dim(`\n确认无误后重跑：wbsbx rm ${ref}${args.opts.archive ? ' --archive' : ''} --yes`));
    return 0;
  }

  await p.instances.remove(ctx, inst.id, { archive: !!args.opts.archive });
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
