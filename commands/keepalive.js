// wbsbx keepalive —— 把会话钉在「等用户回答」上（长驻，Ctrl-C 结束）
//
// 和 daemon 的 heal 是两件事：
//   heal      每 10 分钟一次 E2B exec（便宜、不进对话记录、保证不被回收）
//   keepalive 维持 SSE 长连接 + 挂着的提问（让会话状态停在 pending/working）
//
// 详见 lib/keepalive.js 的文件头。这里只管参数解析和输出。
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const cfg = require('../lib/config');
const cloud = require('../lib/cloud');
const resolve = require('../lib/resolve');
const { Keepalive } = require('../lib/keepalive');
const log = require('../lib/log').log;

const USAGE = 'keepalive [--nudge <秒>] [--max-nudges <次>] [--stall <秒>] [--duration <秒>] [--no-nudge] [--prompt <文案>] <实例>';

async function run(argv) {
  const args = parse(argv, {
    flags: ['no-nudge'],
    values: ['nudge', 'max-nudges', 'question-timeout', 'stall', 'duration', 'sec', 'prompt'],
    aliases: { n: 'nudge', s: 'duration' },
  });
  const [ref] = need(args, 1, USAGE);
  const k = cfg.readConfig().keepalive;

  const inst = await resolve.resolve(ref);
  const opts = {
    nudgeSec: num(args.opts.nudge, k.nudgeSec),
    maxNudges: num(args.opts['max-nudges'], k.maxNudges),
    questionTimeoutSec: num(args.opts['question-timeout'], k.questionTimeoutSec),
    stallAfterNudgeSec: num(args.opts.stall, k.stallAfterNudgeSec),
    prompt: args.opts.prompt || k.prompt,
    noNudge: !!args.opts['no-nudge'],
    // 日志里的状态以控制面为准，跟 `wbsbx ls --refresh` 同一个取法
    probeStatus: async () => {
      const d = await cloud.getConversation(inst.id);
      return { status: d.status, sessionStatus: d.sessionStatus, updatedAt: d.updatedAt };
    },
    log: (m) => log(`[${inst.name || inst.id}] ${m}`),
  };
  const sec = num(args.opts.duration || args.opts.sec, 0);

  // 每次重连前重新取凭据：顺手把快过期的 token 刷掉（纯 HTTP，不需要浏览器）
  const reload = async () => {
    const s = await cloud.getSession(inst.id, () => {});
    const left = s.expireAt ? s.expireAt * 1000 - Date.now() : Infinity;
    if (left < k.leadMs) {
      log('凭据剩余不足 ' + Math.round(k.leadMs / 36e5) + 'h，先续一次');
      return cloud.refreshSession(inst.id, () => {});
    }
    return s;
  };

  const s = await reload();
  const kp = new Keepalive(s, { ...opts, reload });

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

  const r = await kp.start({ sec });
  console.log(ui.c.dim(`结束：催话 ${r.nudges} 次，最后状态 ${r.status}，挂起 ${r.pending}`));
  return 0;
}

module.exports = {
  run,
  usage: USAGE,
  help: [
    '选项:',
    '  -n, --nudge <秒>             空闲多久催一次，默认 60',
    '  --max-nudges <次>            催话次数上限，默认 0（不限）',
    '  --question-timeout <秒>      挂起的提问多久后主动取消，默认 0（永不取消）',
    '  --stall <秒>                 催话后这么久收不到任何字节就判定连接已死，默认 30',
    '  -s, --duration <秒>          跑够这么久自动退出，默认 0（一直跑到 Ctrl-C）',
    '  --no-nudge                   只连接、不催话（不留痕，用于验证链路）',
    '  --prompt <文案>              催话内容',
    '',
    '说明:',
    '  长驻进程。收到 AskUserQuestion 不回答，让那一轮一直挂着 —— 会话就停在 pending，',
    '  平台不会把它当闲置回收。掉出这个状态时补一句催话让它重新提问。',
    '',
    '  催话会写进该会话的历史；不想留痕用 --no-nudge。',
    '  断线自动重连：连接 20s 超时、单条 POST 60s 超时、催话后无响应 30s 判死；',
    '  连续短连接按 5/10/20/40/60s 退避。',
    '',
    '退出码:',
    '  0  正常退出（Ctrl-C 或 --duration 到期）',
    '  1  取凭据失败',
  ],
};
