// wbsbx prompt —— 代实例发一条消息（用户口吻）
//
// 参数规则同 exec：实例之后的所有内容都是要发的文本，不用加引号。
// 所以 prompt 自己的选项写在实例之前：`wbsbx prompt --wait 30 01 帮我看下磁盘`
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const { withAcp } = require('../lib/acp');
const resolve = require('../lib/resolve');
const log = require('../lib/log').log;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USAGE = 'prompt [--wait 秒] [--raw] <实例> <文本...>';

async function run(argv) {
  const args = parse(argv, { values: ['wait', 'grep'], flags: ['raw'], aliases: { w: 'wait' }, stopAfter: 1 });
  const [ref] = need(args, 2, USAGE);
  const text = args._.slice(1).join(' ');
  const wait = num(args.opts.wait, 15);
  const inst = await resolve.resolve(ref);
  const s = await cloud.getSession(inst.id, log);

  await withAcp(s, {
    id: inst.id,
    onEvent: (m) => {
      if (!args.opts.raw) return;
      const j = JSON.stringify(m);
      if (args.opts.grep && !j.includes(args.opts.grep)) return;
      console.log(j);
    },
  }, async (acp) => {
    const loopP = acp.loop().catch(() => {});
    await sleep(2000);                       // 等 bootstrap 的 session/load 把通道铺好
    const r = await acp.prompt(text);
    log(`已发送 http=${r.status}`);
    await sleep(wait * 1000);
    try { acp._ac.abort(); } catch {}
    await loopP;
  });

  if (!args.opts.raw) console.log(ui.c.dim(`已发出，观察 ${wait}s（想看流式细节加 --raw）`));
  return 0;
}

module.exports = { run, usage: USAGE };
