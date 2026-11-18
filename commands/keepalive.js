// cowbird keepalive —— 把会话钉在「等用户回答」上（长驻，Ctrl-C 结束）
//
// 和 daemon 的 heal 是两件事：
//   heal      每 10 分钟一次 exec（便宜、不进对话记录、保证不被回收）
//   keepalive 维持 SSE 长连接 + 挂着的提问（让会话状态停在 pending/working）
//
// 「提问挂着不答」是 ACP 特有的语义，所以真正的实现在驱动的扩展点里
// （provider.keepalive.create）；内核只负责参数、打印和信号。
const { need, num } = require('../lib/args');
const ui = require('../lib/ui');
const cfg = require('../lib/config');
const { capabilityError } = require('../lib/platform/caps');
const { pickTarget } = require('../lib/platform/target');
const { defineCommand } = require('../lib/command');
const log = require('../lib/log').log;

const USAGE = 'keepalive [--nudge <秒>] [--max-nudges <次>] [--stall <秒>] [--duration <秒>] [--no-nudge] [--prompt <文案>] <实例>';

module.exports = defineCommand({
  usage: USAGE,
  options: [
    { flag: 'nudge', short: 'n', arg: '<秒>', desc: '空闲多久催一次，默认 60' },
    { flag: 'max-nudges', arg: '<次>', desc: '催话次数上限，默认 0（不限）' },
    { flag: 'question-timeout', arg: '<秒>', desc: '挂起的提问多久后主动取消，默认 0（永不取消）' },
    { flag: 'stall', arg: '<秒>', desc: '催话后这么久收不到任何字节就判定连接已死，默认 30' },
    { flag: 'duration', short: 's', arg: '<秒>', desc: '跑够这么久自动退出，默认 0（一直跑到 Ctrl-C）' },
    { flag: 'sec', arg: '<秒>', desc: '--duration 的旧名字（兼容）' },
    { flag: 'no-nudge', desc: '只连接、不催话（不留痕，用于验证链路）' },
    { flag: 'prompt', arg: '<文案>', desc: '催话内容' },
  ],
  notes: [
    '长驻进程。收到 AskUserQuestion 不回答，让那一轮一直挂着 —— 会话就停在 pending，',
    '平台不会把它当闲置回收。掉出这个状态时补一句催话让它重新提问。',
    '',
    '目前只有 WorkBuddy 实现了这个扩展点（ACP 的提问语义）；其它平台会直接报不支持，',
    '想保活请用 daemon 的 heal。',
    '',
    '催话会写进该会话的历史；不想留痕用 --no-nudge。',
    '断线自动重连：连接 20s 超时、单条 POST 60s 超时、催话后无响应 30s 判死；',
    '连续短连接按 5/10/20/40/60s 退避。',
  ],
  exits: [[0, '正常退出（Ctrl-C 或 --duration 到期）'], [1, '取凭据失败'], [2, '平台不支持 keepalive']],
  run: async (args) => {
    const [ref] = need(args, 1, USAGE);
    const k = cfg.readConfig().keepalive || {};

    const { inst, ctx } = await pickTarget(ref);
    const p = ctx.provider;
    if (!p.keepalive || typeof p.keepalive.create !== 'function') {
      throw capabilityError(`本平台 ${p.displayName} 不支持 keepalive：它依赖 ACP 的「提问挂着不答」语义。`, {
        capability: 'keepalive',
        hint: '  想让实例不被回收，用 daemon 的 heal（cowbird daemon targets add <实例>），或直接 cowbird exec。',
      });
    }

    const opts = {
      nudgeSec: num(args.opts.nudge, k.nudgeSec),
      maxNudges: num(args.opts['max-nudges'], k.maxNudges),
      questionTimeoutSec: num(args.opts['question-timeout'], k.questionTimeoutSec),
      stallAfterNudgeSec: num(args.opts.stall, k.stallAfterNudgeSec),
      prompt: args.opts.prompt || k.prompt,
      noNudge: !!args.opts['no-nudge'],
      log: (m) => log(`[${inst.name || inst.id}] ${m}`),
    };
    const sec = num(args.opts.duration || args.opts.sec, 0);

    const kp = await p.keepalive.create(ctx, inst.id, opts);

    console.log(ui.c.green('keepalive 启动') + ui.c.dim(
      `  ${inst.name || inst.id} · 催话 ${opts.nudgeSec}s` +
      (opts.maxNudges ? `（上限 ${opts.maxNudges}）` : '（不限）') +
      (opts.noNudge ? ' · shadow 模式（只观察，不催）' : '') +
      (sec ? ` · 跑 ${sec}s` : ' · Ctrl-C 结束')));
    if (!opts.noNudge) {
      console.log(ui.c.dim('  注意：催话会写进这个会话的历史。不想留痕就加 --no-nudge。'));
    }

    const onSig = () => { kp.stop('收到 Ctrl-C'); };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);

    try {
      const r = await kp.start({ sec });
      console.log(ui.c.dim(`结束：催话 ${r.nudges} 次，最后状态 ${r.status}，挂起 ${r.pending}`));
      return 0;
    } finally {
      process.removeListener('SIGINT', onSig);
      process.removeListener('SIGTERM', onSig);
    }
  },
});
