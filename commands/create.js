// wbsbx create —— 开一个新实例（= 新会话 + 新容器）
// 创建接口只认 prompt(≤100字) 和 model；名字必须建完再 POST {title} 改一次。
const { parse, need } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const log = require('../lib/log').log;

async function run(argv) {
  const args = parse(argv, {
    flags: ['json'],
    values: ['model', 'prompt'],
  });
  const [name] = need(args, 1, 'create <名字> [--model deepseek-v4.1-flash] [--prompt "初始指令"]');
  const model = args.opts.model || cfg.DEFAULT_MODEL;
  const prompt = args.opts.prompt || '你好，先不要做任何事，等我指令。';

  const r = await cloud.createConversation({ name, model, prompt }, log);
  const out = { id: r.id, name, model, status: r.session.sessionStatus, cwd: r.session.cwd, link: r.session.link };
  if (args.opts.json) { console.log(JSON.stringify(out, null, 2)); return 0; }

  console.log(ui.c.green('OK') + ` 实例 ${ui.c.bold(name)}  id=${r.id}`);
  console.log(`  状态     ${ui.statusBadge(r.session.sessionStatus)}`);
  console.log(`  凭据     已缓存 token-${r.id}.json（剩余 ${ui.til(r.session.expireAt)}）`);
  console.log(ui.c.dim('\n下一步：'));
  console.log(ui.c.dim(`  wbsbx info ${name}                       # 探活`));
  console.log(ui.c.dim(`  wbsbx exec ${name} "nproc"               # 直连执行`));
  console.log(ui.c.dim(`  wbsbx daemon targets add ${name}         # 交给 daemon 保活`));
  return 0;
}

module.exports = {
  run,
  usage: 'create <名字> [--model <模型>] [--prompt <文本>]',
  help: [
    '选项:',
    '  --model <模型>   默认 deepseek-v4.1-flash',
    '  --prompt <文本>  初始指令，最多 100 字',
    '',
    '说明:',
    '  一个实例 = 一个会话 + 一个容器。创建接口不认名字，所以会建完再改一次标题（两次请求）。',
    '  建好之后建议立刻 `wbsbx daemon targets add <名字>`，否则没人访问就会倒计时回收。',
  ],
};
