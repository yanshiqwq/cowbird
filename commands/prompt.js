// wbsbx prompt —— 代实例发一条消息（用户口吻）
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const { withAcp } = require('../lib/acp');
const resolve = require('../lib/resolve');
const log = require('../lib/log').log;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(argv) {
  const args = parse(argv, { values: ['wait', 'grep'], flags: ['raw'], aliases: { w: 'wait' } });
  const [ref] = need(args, 2, 'prompt <实例> "<文本>" [--wait 15]');
  const text = args._[1];
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

module.exports = { run, usage: 'prompt <实例> "<文本>" [--wait 秒] [--raw]' };
