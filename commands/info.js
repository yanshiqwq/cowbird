// cowbird info —— 一个实例的详情 +（默认）进沙箱探活
//
// 关键设计：**「可见的规格」与「真实配额」要分开显示**。
// 实测 WorkBuddy 的沙箱 `nproc` 报 32、`free` 报 123GB，而 cgroup 只给 4 核 / 8 GiB ——
// 只看 nproc 会做出错误的并发决策。配额由 provider 的 instances.info() 负责读 cgroup。
const { parse, need } = require('../lib/args');
const ui = require('../lib/ui');
const { CAP } = require('../lib/platform/contract');
const { pickTarget } = require('../lib/platform/target');
const execCore = require('../lib/platform/exec');
const log = require('../lib/log').log;

const PROBE = [
  'echo "nproc=$(nproc)"',
  'echo "mem=$(free -m 2>/dev/null | awk \'NR==2{print $2}\')"',
  'echo "uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
  'echo "kernel=$(uname -r 2>/dev/null)"',
].join('; ');

const giB = (b) => (b ? (b / 1024 ** 3).toFixed(1) + ' GiB' : '?');

function capacityText(info) {
  if (!info) return null;
  const q = info.quota || {};
  const v = info.visible || {};
  const real = [];
  if (q.cpu) real.push(q.cpu + ' 核');
  if (q.memBytes) real.push(giB(q.memBytes));
  const seen = [];
  if (v.cpu) seen.push(v.cpu + ' 核');
  if (v.memBytes) seen.push(giB(v.memBytes));
  if (!real.length && !seen.length) return null;
  const head = real.length ? real.join(' / ') : ui.c.dim('未读到配额');
  const tail = seen.length ? ui.c.dim(`（可见 ${seen.join(' / ')}）`) : '';
  return head + tail;
}

async function run(argv) {
  const args = parse(argv, { flags: ['json', 'api-only'] });
  const [ref] = need(args, 1, 'info <实例> [--api-only] [--json]');

  const { inst, ctx } = await pickTarget(ref, { log });
  const p = ctx.provider;

  const out = { id: inst.id, name: inst.name, status: inst.status, extra: inst.extra || null, channel: ctx.channel, reachable: null };

  // 1) provider 侧元数据 + 容量（读 cgroup）
  let info = null;
  if (p.has(CAP.META) && typeof p.instances.info === 'function') {
    try { info = await p.instances.info(ctx, inst.id); out.info = info; } catch (e) { out.infoError = String(e.message).slice(0, 160); }
  }
  if (typeof p.instances.expiry === 'function') {
    try { out.expiresAt = await p.instances.expiry(ctx, inst.id); } catch {}
  }

  // 2) 进沙箱探活（可选）
  if (!args.opts['api-only'] && p.has(CAP.EXEC)) {
    try {
      const ready = await execCore.ensureReady(ctx, inst.id, { wake: true, log });
      if (!ready.ready) { out.reachable = false; out.error = '沙箱未就绪：' + (ready.why || ''); }
      else {
        const r = await execCore.run(ctx, inst.id, { command: PROBE, timeoutMs: p.limits.defaultSyncMs, wake: false, log });
        out.live = {};
        for (const line of String(r.out || '').split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) out.live[line.slice(0, i)] = line.slice(i + 1).trim();
        }
        out.reachable = true;
      }
    } catch (e) { out.reachable = false; out.error = String(e.message).slice(0, 160); }
  }

  if (args.opts.json) { console.log(JSON.stringify(out, null, 2)); return out.reachable === false ? 1 : 0; }

  const rows = [
    ['ID', out.id],
    ['名字', out.name || ui.c.dim('(未命名)')],
    ['渠道', out.channel],
    ['状态', ui.statusBadge(out.status)],
  ];
  if (out.expiresAt) rows.push(['凭据到期', ui.til(out.expiresAt) + ' 后']);
  const cap = capacityText(info);
  if (cap) rows.push(['配额', cap]);
  if (out.info && Array.isArray(out.info.facts)) for (const f of out.info.facts) rows.push([f.label || '·', f.value]);
  if (out.live) {
    const l = out.live;
    if (l.kernel) rows.push(['内核', l.kernel]);
    if (l.nproc) rows.push(['容器 nproc', l.nproc]);
    if (l.mem) rows.push(['容器内存', Number(l.mem) + ' MB']);
    if (l.uptime) rows.push(['运行时长', Math.round(Number(l.uptime) / 60) + ' 分钟']);
  } else if (out.reachable === false) {
    rows.push(['探活', ui.c.red('失败：' + (out.error || '').slice(0, 120))]);
  } else if (out.infoError) {
    rows.push(['元数据', ui.c.yellow(out.infoError)]);
  }
  console.log(ui.table(['项目', '值'], rows, { sep: false }));
  return out.reachable === false ? 1 : 0;
}

module.exports = {
  run,
  usage: 'info <实例> [--api-only] [--json]',
  help: [
    '选项:',
    '  --api-only   只看控制面信息，不进沙箱探活',
    '  --json       输出 JSON',
    '',
    '说明:',
    '  尽量显示两组数字：「配额」来自 cgroup（真实可用），「可见」来自 nproc / free（宿主视角）。',
    '  两者差很多时（例如可见 32 核、配额 4 核），并发与内存规划要按配额来。',
    '  平台不暴露容量时这一行省略。',
    '',
    '退出码:',
    '  0  正常（--api-only 时只表示取到信息）',
    '  1  探活失败',
  ],
};
