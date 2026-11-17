// wbsbx history —— 导出实例的对话历史
//
// 各平台的历史来源完全不同：WorkBuddy 只能靠 ACP 的 session/load 重放（没有查询接口）、
// 码道有分页接口（还是倒序）、Qoder 是事件溯源、MiniMax 有 message 接口。
// 内核不关心这些差异，只要求驱动把结果整理成 `{messages:[…]}`；
// 这里负责把各种形状**归一成可读行**，并落两份文件（jsonl + txt）。
const path = require('path');
const fs = require('fs');
const { parse, need, num } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const { CAP, EVENT } = require('../lib/platform/contract');
const { describe } = require('../lib/platform/stream');
const { resolveInstance } = require('../lib/platform/target');
const log = require('../lib/log').log;

const USAGE = 'history [--duration <秒>] [--limit <条>] [--out <目录>] [--json] <实例>';

/** 一条历史消息 → 一行可读文本（兼容 Event / 归一消息 / 平台原始消息三种形状） */
function renderOne(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.kind) {                                  // 归一化事件
    const line = describe(m);
    return line ? line : null;
  }
  const role = m.role
    || (m.msg_type === 2 ? 'assistant' : m.msg_type === 1 ? 'user' : null)
    || (m.type === 'user' ? 'user' : m.type === 'assistant' ? 'assistant' : null);
  let text = m.text;
  if (text == null) text = m.msg_content;
  if (text == null) text = typeof m.content === 'string' ? m.content : null;
  if (text == null && Array.isArray(m.content)) {
    text = m.content.map((b) => (b && (b.text || (b.type === 'tool_use' ? `<tool:${b.name}>` : ''))) || '').join('');
  }
  if (text == null && Array.isArray(m.parts)) {
    text = m.parts.map((p) => (p && p.text) || '').join('');
  }
  if (text == null) text = '';
  const who = role ? `[${role}] ` : '';
  const s = String(text).replace(/\s+$/, '');
  if (!s) return null;
  return who + s.slice(0, 4000);
}

async function run(argv) {
  const args = parse(argv, { values: ['duration', 'sec', 'out', 'limit'], flags: ['json'], aliases: { s: 'duration' } });
  const [ref] = need(args, 1, USAGE);

  const p = registry.get();
  p.require(CAP.AGENT);
  const ctx = registry.context(p);
  ctx.log = (m) => log(m);
  if (!p.agent || typeof p.agent.history !== 'function') {
    throw new Error(`本平台（${p.displayName}）没有提供历史接口`);
  }
  const inst = await resolveInstance(ctx, ref);

  const opts = {
    maxWaitMs: num(args.opts.duration || args.opts.sec, 12) * 1000,
    limit: num(args.opts.limit, 0) || undefined,
  };
  const r = await p.agent.history(ctx, inst.id, opts);
  const messages = (r && (r.messages || r.events)) || [];

  // 落盘：jsonl 保原始，txt 是给人看的
  const outDir = args.opts.out || cfg.HOME;
  fs.mkdirSync(outDir, { recursive: true });
  const rawPath = path.join(outDir, `history-${inst.id}.jsonl`);
  const txtPath = path.join(outDir, `history-${inst.id}.txt`);
  fs.writeFileSync(rawPath, messages.map((m) => JSON.stringify(m)).join('\n'));
  const lines = messages.map(renderOne).filter(Boolean);
  fs.writeFileSync(txtPath, lines.join('\n'));

  if (args.opts.json) {
    console.log(JSON.stringify({
      platform: p.id, id: inst.id, messages: messages.length, lines: lines.length,
      truncated: Boolean(r && r.truncated), raw: rawPath, txt: txtPath,
    }));
    return 0;
  }
  console.log(`消息 ${messages.length} 条（可读 ${lines.length} 行）${r && r.truncated ? ui.c.yellow('（可能被截断）') : ''}`);
  console.log(ui.c.dim('原始: ' + rawPath));
  console.log(ui.c.dim('摘要: ' + txtPath));
  return 0;
}

module.exports = {
  run,
  usage: USAGE,
  help: [
    '选项:',
    '  -s, --duration <秒>  平台靠重放抓历史时，最多抓多少秒（默认 12）',
    '  --limit <条>         只要最近 N 条',
    '  --out <目录>         落盘目录，默认数据目录',
    '  --json               只打印结果路径与条数',
    '',
    '说明:',
    '  各平台的历史来源不同：WorkBuddy 只能靠 ACP 重放（没有查询接口，所以是"抓一段流"），',
    '  码道是分页接口（倒序，驱动已还原），Qoder 是事件溯源，MiniMax 是 message 接口。',
    '  产物两个文件：history-<id>.jsonl（原始）与 history-<id>.txt（可读摘要）。',
    '  会话特别长时，--duration 给少了会截断 —— 输出里的「消息 N 条」是实际拿到的。',
  ],
};
