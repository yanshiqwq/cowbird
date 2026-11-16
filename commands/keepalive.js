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

const USAGE = 'keepalive <实例> [--nudge 60] [--max-nudges 0] [--question-timeout 0] [--stall 30] [--sec 0] [--no-nudge] [--prompt "文案"]';

async function run(argv) {
  const args = parse(argv, {
    flags: ['no-nudge'],
    values: ['nudge', 'max-nudges', 'question-timeout', 'sec', 'prompt', 'stall'],
    aliases: { n: 'nudge', s: 'sec' },
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
    log: (m) => log(`[${inst.name || inst.id}] ${m}`),
  };
  const sec = num(args.opts.sec, 0);

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

module.exports = { run, usage: USAGE };
