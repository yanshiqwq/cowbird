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

async function run(argv) {
  const args = parse(argv, { values: ['sec', 'out'], flags: ['json'], aliases: { s: 'sec' } });
  const [ref] = need(args, 1, 'history <实例> [--sec 12] [--out 目录]');
  const sec = num(args.opts.sec, 12);
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

module.exports = { run, usage: 'history <实例> [--sec 12] [--out 目录]' };
