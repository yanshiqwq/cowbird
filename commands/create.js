// cowbird create —— 开一个新实例（= 新会话 + 新沙箱）
//
// 平台差异：有的平台创建接口不认名字（要建完再改一次），有的接受 model/prompt，
// 这些细节由 provider 处理；命令层只负责把「名字 / 模型 / 首条指令」传下去。
const { parse, need } = require('../lib/args');
const ui = require('../lib/ui');
const { CAP } = require('../lib/platform/contract');
const channels = require('../lib/platform/channels');
const sandboxes = require('../lib/platform/sandboxes');
const log = require('../lib/log').log;

async function run(argv) {
  const args = parse(argv, {
    flags: ['json'],
    values: ['model', 'prompt', 'channel', 'account', 'platform'],
  });
  const [name] = need(args, 1, 'create <名字> [--model <模型>] [--prompt "初始指令"]');

  const ch = channels.preferred({ channel: args.opts.channel, platform: args.opts.platform, account: args.opts.account });
  const p = ch.provider;
  if (!p.has(CAP.CREATE)) throw new Error(`本平台（${p.displayName}）不支持建实例`);
  const ctx = ch.ctx;

  // 默认模型由驱动给（ctx.effective 是 provider.defaults + 用户配置合并后的结果）
  const model = args.opts.model || ctx.effective.model || '';
  if (!model) throw new Error(`本平台（${p.displayName}）没有默认模型：请用 --model 指定，或在 cowbird.json 的 platforms.${p.id}.model 里配一个`);
  // 只有平台建会话非要一条指令时（WorkBuddy）才默认补一句；
  // 其它平台不发 —— 既省一轮，也避免平台拿首条消息自动改掉标题（Qoder 就会）。
  const prompt = args.opts.prompt || (p.requiresPromptOnCreate ? (ctx.effective.prompt || '你好，先不要做任何事，等我指令。') : null);

  const inst = await p.instances.create(ctx, { name, model, prompt }, { log });
  // 建出来就登记成沙箱会话：ls 默认只列登记过的（见 lib/platform/sandboxes.js）
  sandboxes.record(ctx, inst, 'create');
  if (args.opts.json) { console.log(JSON.stringify(inst, null, 2)); return 0; }

  console.log(ui.c.green('OK') + ` 实例 ${ui.c.bold(name)}  id=${inst.id}`);
  console.log(`  渠道     ${ctx.channel}`);
  console.log(`  状态     ${ui.statusBadge(inst.status)}`);
  if (inst.extra && inst.extra.sessionStatus) console.log(`  会话     ${ui.statusBadge(inst.extra.sessionStatus)}`);
  console.log(`  类型     沙箱会话${ui.c.dim('（已登记，cowbird ls 会列出来）')}`);

  console.log(ui.c.dim('\n下一步：'));
  if (p.has(CAP.EXEC)) console.log(ui.c.dim(`  cowbird exec ${name} "nproc"           # 直连执行`));
  if (p.has(CAP.META)) console.log(ui.c.dim(`  cowbird info ${name}                   # 探活 / 规格`));
  if (p.has(CAP.EXEC) && p.has(CAP.WAKE)) console.log(ui.c.dim(`  cowbird exec ${name} "true"            # 第一次执行会唤醒沙箱`));
  return 0;
}

module.exports = {
  run,
  usage: 'create <名字> [--model <模型>] [--prompt <文本>]',
  help: [
    '选项:',
    '  --model <模型>   默认取 provider 的默认模型（cowbird platform 里能看到）',
    '  --prompt <文本>  初始指令',
    '  -c, --channel <渠道>  建在哪个渠道（平台[:账号]），默认用默认渠道',
    '',
    '说明:',
    '  一个实例 = 一个会话 + 一个沙箱。不同平台的创建细节（要不要二次改名、prompt 长度限制）',
    '  由驱动处理，命令层不关心。',
    '  建出来的会话会自动登记成沙箱会话（cowbird ls 默认只列这个）；平台上已经存在的',
    '  会话想纳进来用 cowbird adopt。',
    '  建好之后建议立刻 `cowbird exec <名字> "true"` 把沙箱拉起来，或用 `cowbird daemon targets add`。',
  ],
};
