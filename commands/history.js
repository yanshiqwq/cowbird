// wbsbx history —— 导出实例的完整对话历史（ACP 重放，不截断）
// 历史没有 HTTP 接口（/messages、/history 全 404），只能在 session/load 里重放出来。
const path = require('path');
const fs = require('fs');
const { parse, need, num } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const { tap } = require('../lib/acp');
const resolve = require('../lib/resolve');
const log = require('../lib/log').log;

const USAGE = 'history [--duration <秒>] [--out <目录>] [--json] <实例>';

async function run(argv) {
  const args = parse(argv, { values: ['duration', 'sec', 'out'], flags: ['json'], aliases: { s: 'duration' } });
  const [ref] = need(args, 1, USAGE);
  const sec = num(args.opts.duration || args.opts.sec, 12);
  const inst = await resolve.resolve(ref);
  const s = await cloud.getSession(inst.id, log);

  const outDir = args.opts.out || cfg.HOME;
  fs.mkdirSync(outDir, { recursive: true });
  const rawPath = path.join(outDir, `history-${inst.id}.jsonl`);
  const txtPath = path.join(outDir, `history-${inst.id}.txt`);
  const out = fs.createWriteStream(rawPath, { flags: 'w' });
  const events = [];

  await tap(s, {
    id: inst.id,
    onEvent: (m) => {
      out.write(JSON.stringify(m) + '\n');
      events.push(m);
    },
  }, sec * 1000);
  out.end();
  await new Promise((r) => setTimeout(r, 200));

  // 整理成可读 transcript：文本块 / 工具名 / 标题 / 其他事件类型
  const lines = [];
  let updates = 0;
  for (const e of events) {
    const u = e.method === 'session/update' ? (e.params && e.params.update) : null;
    if (!u) continue;
    updates++;
    const meta = (u._meta && u._meta['codebuddy.ai']) || {};
    const kind = u.sessionUpdate || '';
    if (u.content && u.content.text) lines.push('[text] ' + u.content.text);
    else if (u.content && u.content.blocks) lines.push('[text] ' + JSON.stringify(u.content.blocks).slice(0, 400));
    if (u.title) lines.push('[title] ' + u.title);
    if (meta.toolName) lines.push('[tool] ' + meta.toolName + ' offset=' + (meta.offset === undefined ? '?' : meta.offset));
    if (u.toolName) lines.push('[tool] ' + u.toolName);
    if (kind && !u.content && !meta.toolName && !u.title) lines.push('[' + kind + ']');
  }
  fs.writeFileSync(txtPath, lines.join('\n'));

  if (args.opts.json) {
    console.log(JSON.stringify({ events: events.length, updates, raw: rawPath, txt: txtPath }));
    return 0;
  }
  console.log(`事件 ${events.length} 个 / 更新 ${updates} 条`);
  console.log(ui.c.dim('原始: ' + rawPath));
  console.log(ui.c.dim('摘要: ' + txtPath));
  return 0;
}

module.exports = {
  run,
  usage: USAGE,
  help: [
    '选项:',
    '  -s, --duration <秒>  抓多少秒，默认 12',
    '  --out <目录>         落盘目录，默认数据目录',
    '  --json               只打印结果路径',
    '',
    '说明:',
    '  历史没有查询接口，只能靠 session/load 的整段重放，所以是"抓一段时间的流"再整理，',
    '  不是"翻页查询"。会话特别长时，--duration 给少了会截断 —— 输出里的「事件 N 个」就是实际收到的。',
    '  产物两个文件：history-<id>.jsonl（原始事件）与 history-<id>.txt（可读摘要）。',
  ],
};
