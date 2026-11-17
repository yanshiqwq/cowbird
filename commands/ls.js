// cowbird ls —— 列出实例（会话 = 一个沙箱）
const { parse } = require('../lib/args');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const { CAP } = require('../lib/platform/contract');

async function run(argv) {
  const args = parse(argv, { flags: ['json', 'refresh', 'all'], aliases: { j: 'json', r: 'refresh' } });
  const p = registry.get();
  const ctx = registry.context(p);

  let list = await p.instances.list(ctx, { refresh: !!args.opts.refresh });
  if (!args.opts.all) {
    // 默认隐藏已归档的
    list = list.filter((x) => !x.archived && x.status !== 'archived');
  }
  list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  // 「凭据剩余」是可选能力：provider 提供 instances.expiry 才显示这一列
  const hasExpiry = typeof p.instances.expiry === 'function';
  const expires = {};
  if (hasExpiry) {
    for (const x of list) {
      try { expires[x.id] = await p.instances.expiry(ctx, x.id); } catch { expires[x.id] = null; }
    }
  }

  if (args.opts.json) {
    console.log(JSON.stringify(list.map((x) => ({ ...x, expiresAt: hasExpiry ? expires[x.id] || null : undefined })), null, 2));
    return 0;
  }
  if (!list.length) {
    console.log(ui.c.dim(`没有实例。用 cowbird create <名字> 开一个（平台：${p.displayName}）。`));
    return 0;
  }

  const head = ['ID', '名字', '状态', '最近活动'];
  if (hasExpiry) head.push('凭据剩余');
  const rows = list.map((x) => {
    const row = [
      x.id,
      x.name || ui.c.dim('(未命名)'),
      ui.statusBadge(x.status) + (x.extra && x.extra.sessionStatus ? '/' + ui.statusBadge(x.extra.sessionStatus) : ''),
      (x.updatedAt || '').replace('T', ' ').slice(0, 16),
    ];
    if (hasExpiry) row.push(expires[x.id] ? ui.til(expires[x.id]) : ui.c.dim('无缓存'));
    return row;
  });
  console.log(ui.table(head, rows));
  console.log(ui.c.dim(`\n共 ${list.length} 个 · 平台 ${p.displayName}`));
  return 0;
}

module.exports = {
  run,
  usage: 'ls [--refresh] [--all] [--json]',
  help: [
    '选项:',
    '  -r, --refresh   强制联网拉一次（默认优先用本地缓存，若平台有缓存）',
    '  --all           连已归档的一起列出来',
    '  --json          输出 JSON',
    '',
    '说明:',
    '  「凭据剩余」一列只有平台提供该能力时才显示（例如 WorkBuddy 的 E2B token）。',
    '  状态列显示平台自己的状态词，含义见 `cowbird platform`。',
  ],
};
