// cowbird prompt —— 代实例发一条消息（用户口吻）
//
// 参数规则同 exec：实例之后的所有内容都是要发的文本，不用加引号。
// 所以 prompt 自己的选项写在实例之前：`cowbird prompt --wait 30 01 帮我看下磁盘`
//
// 实现上就是「先挂上事件流，再发消息，观察 N 秒」—— 这样 send 只管发、stream 只管收，
// 两条通道在驱动里各自实现，内核不做平台假设。
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const { CAP, EVENT } = require('../lib/platform/contract');
const { collect } = require('../lib/platform/stream');
const { pickTarget } = require('../lib/platform/target');
const log = require('../lib/log').log;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USAGE = 'prompt [--wait <秒>] [--raw] <实例> <文本...>';

async function run(argv) {
  const args = parse(argv, { values: ['wait', 'grep'], flags: ['raw'], aliases: { w: 'wait' }, stopAfter: 1 });
  const [ref] = need(args, 2, USAGE);
  const text = args._.slice(1).join(' ');
  const wait = num(args.opts.wait, 15);

  const { inst, ctx } = await pickTarget(ref, { log, cap: CAP.AGENT });
  const p = ctx.provider;

  // 观察窗：--raw 时逐事件打印（可按 --grep 过滤），否则把正文流式写出来
  const onEvent = args.opts.raw
    ? (ev) => {
      const j = JSON.stringify(ev);
      if (args.opts.grep && !j.includes(args.opts.grep)) return;
      console.log(j);
    }
    : (ev) => {
      if (ev.kind === EVENT.TEXT) process.stdout.write(String((ev.data && ev.data.text) || ''));
      else if (ev.kind === EVENT.TOOL) process.stderr.write(ui.c.dim(`\n[tool ${(ev.data && ev.data.name) || '?'}]`));
    };

  const stream = p.agent.stream(ctx, inst.id, {});
  // breakOnDone:false —— 刚连上的历史重放里带着上一轮的 endTurn，
  // 见 done 就收工会拿到「零正文 + 一堆旧产物」。这里按 --wait 计时收工。
  const collecting = collect(stream, { timeoutMs: Math.max(1, wait) * 1000, breakOnDone: false, onEvent });

  await sleep(1500);                       // 给驱动铺好通道（ACP bootstrap / SSE 握手）
  await p.agent.send(ctx, inst.id, { text });
  log(`已发送，观察 ${wait}s`);

  const sum = await collecting;
  if (args.opts.raw) return 0;

  if (sum.text) process.stdout.write(sum.text.endsWith('\n') ? '' : '\n');
  const bits = [];
  if (sum.tools.length) bits.push(`工具 ${sum.tools.length}`);
  if (sum.artifacts.length) bits.push(`产物 ${sum.artifacts.length}`);
  if (sum.usage && sum.usage.credits != null) bits.push(`${sum.usage.credits} credit`);
  else if (sum.usage && sum.usage.totalTokens) bits.push(`${sum.usage.totalTokens} tokens`);
  bits.push(sum.done ? '结束' : `观察 ${wait}s 到点`);
  if (sum.errors.length) bits.push(ui.c.red('有错误'));
  console.log(ui.c.dim(`[${bits.join(' · ')}]`));
  for (const e of sum.errors) console.log(ui.c.red('  错误：') + (e.message || JSON.stringify(e)).slice(0, 200));
  return sum.errors.length ? 1 : 0;
}

module.exports = {
  run,
  usage: USAGE,
  stopAfter: 1,          // 第一个位置参数（实例）之后的一切都属于消息正文
  help: [
    '选项:',
    '  -w, --wait <秒>   发完观察多久，默认 15',
    '  --raw             打印归一化事件 JSON',
    '  --grep <词>       配 --raw 用，只显示含该词的 JSON',
    '',
    '说明:',
    '  以"用户发言"的身份发一条消息，会写进对话历史、并触发 agent 干活。',
    '  实例之后的内容全部当文本，不用加引号。',
    '  只是想让会话别闲着、又不想留下痕迹的话，用 exec（不进对话）或 keepalive --no-nudge。',
    '  退出码 0 = 发出去了（观察窗正常结束）；1 = 观察期间有 error 事件。',
  ],
};
