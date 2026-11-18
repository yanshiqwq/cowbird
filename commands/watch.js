// cowbird watch —— 连上实例的事件流，实时打印（大部分平台会把历史重放一遍，默认跳过）
//
// 内核只认归一化事件（EVENT.*），平台差异由驱动吸收：
// 所以同一条命令既能看 WorkBuddy 的 ACP，也能看码道的具名 SSE、Qoder 的轮询增量。
const { need, num } = require('../lib/args');
const ui = require('../lib/ui');
const { CAP, EVENT } = require('../lib/platform/contract');
const { describe, collect } = require('../lib/platform/stream');
const { pickTarget } = require('../lib/platform/target');
const { defineCommand } = require('../lib/command');
const log = require('../lib/log').log;

const USAGE = 'watch [--duration <秒>] [--raw] [--grep <词>] <实例>';

function printer(opts) {
  const needle = opts.grep || null;
  return (ev) => {
    if (opts.raw) {
      const j = JSON.stringify(ev);
      if (needle && !j.includes(needle)) return;
      console.log(j);
      return;
    }
    const d = ev.data || {};
    // 历史重放默认不刷屏（驱动一般会把它标成 raw+history 或直接过滤掉）
    if (ev.kind === EVENT.RAW && d.history) return;

    const line = describe(ev);
    if (needle && !line.includes(needle)) return;
    switch (ev.kind) {
      case EVENT.TEXT: process.stdout.write(ui.c.cyan('[text] ') + String(d.text || '') + '\n'); break;
      case EVENT.THINKING: process.stdout.write(ui.c.dim('[think] ' + String(d.text || '').slice(0, 200) + '\n')); break;
      case EVENT.TOOL: console.log(ui.c.magenta('[tool] ') + (d.name || '?') + ' ' + JSON.stringify(d.input || {}).slice(0, 200)); break;
      case EVENT.TOOL_RESULT: console.log(ui.c.dim('[tool] ') + (d.name || '?') + (d.ok === false ? ' 失败' : ' 完成')); break;
      case EVENT.ARTIFACT: console.log(ui.c.green('[artifact] ') + (d.name || d.uri || '') + (d.size ? ` (${d.size}B)` : '')); break;
      case EVENT.USAGE: console.log(ui.c.dim('[usage] ' + describe(ev))); break;
      case EVENT.DONE: console.log(ui.c.green('[done] ') + describe(ev)); break;
      case EVENT.ERROR: console.log(ui.c.red('[error] ') + (d.message || '')); break;
      case EVENT.QUESTION: console.log(ui.c.yellow('[question] ') + JSON.stringify(d.questions || d).slice(0, 300)); break;
      case EVENT.PERMISSION: console.log(ui.c.yellow('[permission] ') + (d.tool || '')); break;
      case EVENT.STATUS: console.log(ui.c.dim('[status] ' + (d.status || '?'))); break;
      default:
        console.log(ui.c.dim('[raw] ' + line.slice(0, 240)));
    }
  };
}

module.exports = defineCommand({
  usage: USAGE,
  options: [
    { flag: 'duration', short: 's', arg: '<秒>', desc: '看多久，默认 20' },
    { flag: 'sec', arg: '<秒>', desc: '--duration 的旧名字（兼容）' },
    { flag: 'raw', desc: '打印归一化事件 JSON（含原始旁路）' },
    { flag: 'grep', arg: '<词>', desc: '只显示匹配的行' },
  ],
  notes: [
    '连上去看实时事件流。历史重放默认跳过（只想看新事件）。',
    '这是"看一会儿"，不是常驻：到点自动断开。要持续保活用 keepalive 或 daemon。',
    '事件已被驱动归一（text/thinking/tool/tool_result/artifact/usage/question/done），',
    '所以不同平台看到的是同一套词。',
  ],
  exits: [[0, '正常到点断开'], [1, '流断了（连接错误）'], [2, '平台不支持对话']],
  run: async (args) => {
    const [ref] = need(args, 1, USAGE);
    const sec = num(args.opts.duration || args.opts.sec, 20);

    const { inst, ctx } = await pickTarget(ref, { log, cap: CAP.AGENT });
    const p = ctx.provider;

    log(`连上 ${inst.name || inst.id} · ${p.displayName} · ${ctx.channel}，观听 ${sec}s…`);
    const print = printer(args.opts);
    // 同上：驱动内部的兜底 deadline 不能超过观察窗（否则 collect 到点调 return() 也停不下来）
    const stream = p.agent.stream(ctx, inst.id, { timeoutMs: sec * 1000 });
    // collect 的 timer 会主动 stream.return()，所以超时在"一直没事件"的流上也成立
    // （早先是"收到事件才判 deadline"，安静流上 --duration 完全不生效）
    const sum = await collect(stream, { timeoutMs: sec * 1000, breakOnDone: false, onEvent: print });
    if (sum.errors.length) {
      log('流断了：' + String((sum.errors[0] && sum.errors[0].message) || '未知错误').slice(0, 120));
      return 1;
    }
    return 0;
  },
});
