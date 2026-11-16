// wbsbx watch —— 连上实例的 ACP 事件流，实时打印（session/load 会把历史也重放一遍）
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const { tap } = require('../lib/acp');
const resolve = require('../lib/resolve');
const log = require('../lib/log').log;

const USAGE = 'watch [--duration <秒>] [--raw] [--grep <词>] <实例>';

async function run(argv) {
  const args = parse(argv, { values: ['duration', 'sec', 'grep'], flags: ['raw'], aliases: { s: 'duration' } });
  const [ref] = need(args, 1, USAGE);
  const sec = num(args.opts.duration || args.opts.sec, 20);
  const inst = await resolve.resolve(ref);
  const s = await cloud.getSession(inst.id, log);
  const needle = args.opts.grep || null;

  const dump = (m) => {
    const j = JSON.stringify(m);
    if (needle && !j.includes(needle)) return;
    if (args.opts.raw) return console.log(j);
    const u = m.method === 'session/update' ? (m.params && m.params.update) : null;
    if (u) {
      const meta = (u._meta && u._meta['codebuddy.ai']) || {};
      if (meta.mode === 'history') return;                 // 历史重放，默认不刷屏
      if (u.content && u.content.text) return console.log(ui.c.cyan('[text] ') + String(u.content.text).slice(0, 400));
      if (meta.toolName) return console.log(ui.c.magenta('[tool] ') + meta.toolName);
      if (u.title) return console.log(ui.c.bold('[title] ') + u.title);
      return;
    }
    if (m.method) console.log(ui.c.dim('EVT ' + m.method + '  ' + j.slice(0, 300)));
  };

  log(`连上 ${inst.name || inst.id}，观听 ${sec}s…`);
  const e = await tap(s, { id: inst.id, onEvent: dump }, sec * 1000);
  if (e) log('SSE 结束 ' + e.message.slice(0, 80));
  return 0;
}

module.exports = {
  run,
  usage: USAGE,
  help: [
    '选项:',
    '  -s, --duration <秒>  看多久，默认 20',
    '  --raw                打印原始事件 JSON',
    '  --grep <词>          只显示 JSON 里含这个词的事件',
    '',
    '说明:',
    '  连上去看实时事件流。session/load 会把整段历史重放一遍，默认跳过（只显示新事件）。',
    '  这是"看一会儿"，不是常驻：到点自动断开。要持续保活用 keepalive。',
  ],
};
