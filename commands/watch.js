// wbsbx watch —— 连上实例的事件流，实时打印（大部分平台会把历史重放一遍，默认跳过）
//
// 内核只认归一化事件（EVENT.*），平台差异由驱动吸收：
// 所以同一条命令既能看 WorkBuddy 的 ACP，也能看码道的具名 SSE、Qoder 的轮询增量。
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const { CAP, EVENT } = require('../lib/platform/contract');
const { describe } = require('../lib/platform/stream');
const { resolveInstance } = require('../lib/platform/target');
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
        if (/^EVT/.test(line)) console.log(ui.c.dim(line));
        else console.log(ui.c.dim('[raw] ' + line.slice(0, 240)));
    }
  };
}

async function run(argv) {
  const args = parse(argv, { values: ['duration', 'sec', 'grep'], flags: ['raw'], aliases: { s: 'duration' } });
  const [ref] = need(args, 1, USAGE);
  const sec = num(args.opts.duration || args.opts.sec, 20);

  const p = registry.get();
  p.require(CAP.AGENT);
  const ctx = registry.context(p);
  ctx.log = (m) => log(m);
  const inst = await resolveInstance(ctx, ref);

  log(`连上 ${inst.name || inst.id}（${p.displayName}），观听 ${sec}s…`);
  const print = printer(args.opts);
  const stream = p.agent.stream(ctx, inst.id, {});
  const deadline = Date.now() + sec * 1000;
  try {
    for await (const ev of stream) {
      print(ev);
      if (Date.now() > deadline) break;
    }
  } catch (e) {
    log('流断了：' + String(e.message || e).slice(0, 120));
    return 1;
  } finally {
    try { stream.return && stream.return(); } catch {}
  }
  return 0;
}

module.exports = {
  run,
  usage: USAGE,
  help: [
    '选项:',
    '  -s, --duration <秒>  看多久，默认 20',
    '  --raw                打印归一化事件 JSON（含原始旁路）',
    '  --grep <词>          只显示匹配的行',
    '',
    '说明:',
    '  连上去看实时事件流。历史重放默认跳过（只想看新事件）。',
    '  这是"看一会儿"，不是常驻：到点自动断开。要持续保活用 keepalive 或 daemon。',
    '  事件已被驱动归一（text/thinking/tool/tool_result/artifact/usage/question/done），',
    '  所以不同平台看到的是同一套词。',
  ],
};
