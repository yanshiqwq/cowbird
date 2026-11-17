// cowbird ls —— 列出实例（会话 = 一个沙箱）
//
// 默认**聚合所有渠道**（平台 × 账号）：一个平台挂两个账号、四个平台同时在线，
// 都是一条命令看完。只想看一个渠道就 `cowbird ls --channel qoder` 或写全局开关。
//
// 默认还**只列有沙箱的会话**：像码道这种平台，你在网页端随手开的对话也算一个会话，
// 但它们没有沙箱、不属于这个工具管的范围。驱动用 `hasSandbox` 表态（见 docs/providers.md），
// 平台不区分的（undefined）照旧全列。想全看就 `--all`。
//
// 某个渠道读不到（掉线/没登录）不会让整条命令失败 —— 单独列一行提醒，其余照常显示。
const { parse } = require('../lib/args');
const ui = require('../lib/ui');
const channels = require('../lib/platform/channels');

async function run(argv) {
  const args = parse(argv, {
    flags: ['json', 'refresh', 'all'],
    values: ['channel', 'account', 'platform'],
    aliases: { j: 'json', r: 'refresh', c: 'channel' },
  });
  const chs = channels.selected({ channel: args.opts.channel, platform: args.opts.platform, account: args.opts.account });

  const rows = [];
  const errors = [];
  const dropped = { archived: 0, noSandbox: 0 };
  for (const ch of chs) {
    const p = ch.provider;
    let list;
    try {
      list = await p.instances.list(ch.ctx, { refresh: !!args.opts.refresh });
    } catch (e) {
      errors.push({ channel: ch.key, error: String(e.message).slice(0, 200) });
      continue;
    }
    const hasExpiry = typeof p.instances.expiry === 'function';
    for (const x of list || []) {
      if (!args.opts.all) {
        if (x.archived || x.status === 'archived') { dropped.archived++; continue; }
        if (x.hasSandbox === false) { dropped.noSandbox++; continue; }
      }
      let expiresAt;
      if (hasExpiry) {
        try { expiresAt = await p.instances.expiry(ch.ctx, x.id); } catch { expiresAt = null; }
      }
      rows.push({
        id: String(x.id),
        name: x.name || '',
        status: x.status,
        sessionStatus: (x.extra && x.extra.sessionStatus) || null,
        updatedAt: x.updatedAt,
        archived: !!x.archived,
        hasSandbox: x.hasSandbox,          // false = 明确没沙箱；undefined = 平台不区分
        channel: ch.key,
        platform: ch.platform,
        account: ch.account,
        expiresAt: hasExpiry ? expiresAt || null : undefined,
        raw: x,
      });
    }
  }
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  if (args.opts.json) {
    console.log(JSON.stringify({ instances: rows, errors, hidden: dropped }, null, 2));
    return 0;
  }

  for (const e of errors) console.log(ui.c.yellow(`! ${e.channel}：${e.error}`));

  const multi = chs.length > 1;
  if (!rows.length) {
    if (!errors.length) {
      const where = multi || chs.length === 1 ? `渠道 ${chs.map((c) => c.key).join(', ')}` : '';
      const why = dropped.noSandbox ? `（有 ${dropped.noSandbox} 个会话没有沙箱，用 --all 看）` : '';
      console.log(ui.c.dim(`没有实例。用 cowbird create <名字> 开一个。${where ? '（' + where + '）' : ''}${why}`));
    }
    return errors.length && !rows.length ? 1 : 0;
  }

  const anyExpiry = rows.some((r) => r.expiresAt !== undefined);
  const showSandbox = rows.some((r) => r.hasSandbox === false);     // 只有 --all 时才会出现
  const head = ['ID', '名字', '状态', '最近活动'];
  if (multi) head.push('渠道');
  if (showSandbox) head.push('沙箱');
  if (anyExpiry) head.push('凭据剩余');
  const body = rows.map((r) => {
    const row = [
      r.id,
      r.name || ui.c.dim('(未命名)'),
      ui.statusBadge(r.status) + (r.sessionStatus ? '/' + ui.statusBadge(r.sessionStatus) : ''),
      (r.updatedAt || '').replace('T', ' ').slice(0, 16),
    ];
    if (multi) row.push(r.channel);
    if (showSandbox) row.push(r.hasSandbox === false ? ui.c.dim('·') : ui.c.green('✓'));
    if (anyExpiry) row.push(r.expiresAt === undefined ? ui.c.dim('-') : r.expiresAt ? ui.til(r.expiresAt) : ui.c.dim('无缓存'));
    return row;
  });
  console.log(ui.table(head, body));
  const byChannel = chs.map((c) => `${c.key} ${rows.filter((r) => r.channel === c.key).length}`).join(' · ');
  console.log(ui.c.dim(`\n共 ${rows.length} 个${multi ? '，按渠道：' + byChannel : ' · 渠道 ' + (chs[0] ? chs[0].key : '-')}`));
  if (dropped.noSandbox) {
    console.log(ui.c.dim(`另有 ${dropped.noSandbox} 个会话没有沙箱（网页端随手开的对话不在这个工具管的范围），用 --all 一起看。`));
  }
  return 0;
}

module.exports = {
  run,
  usage: 'ls [--channel <渠道>] [--refresh] [--all] [--json]',
  help: [
    '选项:',
    '  -c, --channel <渠道>  只看这个渠道（平台[:账号]），默认聚合全部',
    '  -r, --refresh         强制联网拉一次（默认优先用本地缓存，若平台有缓存）',
    '  --all                 连已归档的、以及**没有沙箱**的会话一起列出来',
    '  --json                输出 JSON',
    '',
    '说明:',
    '  默认把所有已登录的渠道合在一起列，所以「同平台两个账号」「四个平台同时挂」都看得到。',
    '  默认**只列有沙箱的会话**：码道那种平台上，你在网页端随手开的对话也算会话，但没有沙箱，',
    '  不归这个工具管 —— 它们不会出现在默认列表里（--all 可见，「沙箱」列会标出来）。',
    '  「渠道」列只在多于一个渠道时出现，取值可直接当引用前缀：cowbird exec qoder:alt/<id>。',
    '  「凭据剩余」一列只有平台提供该能力时才显示（例如 WorkBuddy 的 E2B token）。',
    '  某个渠道读不到会单列一行警告，不影响其余渠道。',
  ],
};
