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

module.exports = { run, usage: 'rename <实例> <新名字>' };
