// wbsbx rename —— 改实例名（会话标题）
const { parse, need } = require('../lib/args');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const resolve = require('../lib/resolve');

async function run(argv) {
  const args = parse(argv, {});
  const [ref, title] = need(args, 2, 'rename <实例> <新名字>');
  const inst = await resolve.resolve(ref);
  await cloud.renameConversation(inst.id, title);
  console.log(ui.c.green('OK') + ` ${inst.id} → ${title}`);
  return 0;
}

module.exports = {
  run,
  usage: 'rename <实例> <新名字>',
  help: [
    '说明:',
    '  改的是会话标题，不是容器主机名。改名是异步的 —— 紧接着 ls 可能还看到旧名字，',
    '  列表缓存会保留旧值，下次刷新才对上。',
  ],
};
