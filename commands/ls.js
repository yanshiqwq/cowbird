// cowbird ls —— 列出沙箱会话（= 本工具管的实例）
//
// 默认**聚合所有渠道**（平台 × 账号）：一个平台挂两个账号、五个平台同时在线，
// 都是一条命令看完。只想看一个渠道就 `cowbird ls --channel qoder` 或写全局开关。
//
// 两个默认过滤，都是为了别把「平台上的用户会话」混进来：
//   ① 不是我们建的 → 不是沙箱会话。判据是**登记簿**（lib/platform/sandboxes.js）：
//      create 建出来的、adopt 收编的、daemon targets 里的才算。平台不区分这件事，
//      所以也没有平台字段可猜 —— 你在网页里聊出来的会话一个都不会默认出现。
//   ② 平台明说没有沙箱的（码道那种 agent_session_id 为空的随手对话）也算不上沙箱。
// 想全看就 `--all`：多一列「类型」，把用户会话一起列出来（沙箱那一列也会出现）。
//
// 某个渠道读不到（掉线/没登录）不会让整条命令失败 —— 单独列一行提醒，其余照常显示。
const { parse } = require('../lib/args');
const ui = require('../lib/ui');
const channels = require('../lib/platform/channels');
const sandboxes = require('../lib/platform/sandboxes');

async function run(argv) {
  const args = parse(argv, {
    flags: ['json', 'refresh', 'all'],
    values: ['channel', 'account', 'platform'],
    aliases: { j: 'json', r: 'refresh', c: 'channel' },
  });
  const chs = channels.selected({ channel: args.opts.channel, platform: args.opts.platform, account: args.opts.account });

  const rows = [];
  const errors = [];
  const dropped = { archived: 0, noSandbox: 0, session: 0 };
  for (const ch of chs) {
    const p = ch.provider;
    let list;
    try {
      list = await p.instances.list(ch.ctx, { refresh: !!args.opts.refresh });
    } catch (e) {
      errors.push({ channel: ch.key, error: String(e.message).slice(0, 200) });
      continue;
    }
    const reg = sandboxes.read(ch.ctx);          // 每个渠道读一次盘，别每个实例读一遍
    const hasExpiry = typeof p.instances.expiry === 'function';
    for (const x of list || []) {
      const kind = sandboxes.isSandbox(reg, x) ? 'sandbox' : 'session';
      if (!args.opts.all) {
        if (x.archived || x.status === 'archived') { dropped.archived++; continue; }
        if (x.hasSandbox === false) { dropped.noSandbox++; continue; }
        if (kind !== 'sandbox') { dropped.session++; continue; }
      }
      let expiresAt;
      if (hasExpiry) {
        try { expiresAt = await p.instances.expiry(ch.ctx, x.id); } catch { expiresAt = null; }
      }
      rows.push({
        id: String(x.id),
        name: x.name || '',
        kind,                               // sandbox = 我们建的/收编的；session = 平台上的用户会话
        status: x.status,
        sessionStatus: (x.extra && x.extra.sessionStatus) || null,
        updatedAt: x.updatedAt,
        archived: !!x.archived,
        hasSandbox: x.hasSandbox,           // false = 平台明说没沙箱；undefined = 平台不区分
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
    const where = `渠道 ${chs.map((c) => c.key).join(', ')}`;
    if (dropped.session) {
      console.log(ui.c.dim(`没有沙箱会话：这 ${dropped.session} 个都是平台上的用户会话（你在网页/客户端里的对话），不归这个工具管。`));
      console.log(ui.c.dim('  要把某个会话当沙箱长期用：cowbird ls --all 找到它 → cowbird adopt <引用>；'));
      console.log(ui.c.dim('  或者直接开一个新的：cowbird create <名字>'));
      // 人数已经说过了，这里只说还有别的类别没显示
      const rest = hiddenText({ session: 0, noSandbox: dropped.noSandbox, archived: dropped.archived }, { withHint: false });
      if (rest) console.log(ui.c.dim(rest));
    } else if (!errors.length) {
      console.log(ui.c.dim(`没有实例。用 cowbird create <名字> 开一个。（${where}）`));
    } else {
      const why = hiddenText(dropped);
      if (why) console.log(ui.c.dim(why));
    }
    return errors.length >= chs.length ? 1 : 0;
  }

  const anyExpiry = rows.some((r) => r.expiresAt !== undefined);
  const showKind = !!args.opts.all;                                  // 默认全是沙箱，这一列是常数
  const showSandbox = rows.some((r) => r.hasSandbox === false);      // 只有 --all 时才会出现
  const head = ['ID', '名字'];
  if (showKind) head.push('类型');
  head.push('状态', '最近活动');
  if (multi) head.push('渠道');
  if (showSandbox) head.push('沙箱');
  if (anyExpiry) head.push('凭据剩余');
  const body = rows.map((r) => {
    const row = [r.id, r.name || ui.c.dim('(未命名)')];
    if (showKind) row.push(r.kind === 'sandbox' ? ui.c.green('沙箱') : ui.c.dim('会话'));
    row.push(
      ui.statusBadge(r.status) + (r.sessionStatus ? '/' + ui.statusBadge(r.sessionStatus) : ''),
      (r.updatedAt || '').replace('T', ' ').slice(0, 16),
    );
    if (multi) row.push(r.channel);
    if (showSandbox) row.push(r.hasSandbox === false ? ui.c.dim('·') : ui.c.green('✓'));
    if (anyExpiry) row.push(r.expiresAt === undefined ? ui.c.dim('-') : r.expiresAt ? ui.til(r.expiresAt) : ui.c.dim('无缓存'));
    return row;
  });
  console.log(ui.table(head, body));
  // 只报「真有实例」的渠道：0 个的渠道列出来只是噪音（读不到的渠道上面已经单独警告过）
  const byChannel = chs
    .map((c) => ({ key: c.key, n: rows.filter((r) => r.channel === c.key).length }))
    .filter((x) => x.n)
    .map((x) => `${x.key} ${x.n}`)
    .join(' · ');
  console.log(ui.c.dim(`\n共 ${rows.length} 个${args.opts.all ? '' : '沙箱会话'}${multi ? '，按渠道：' + byChannel : ' · 渠道 ' + (chs[0] ? chs[0].key : '-')}`));
  const why = hiddenText(dropped);
  if (why) console.log(ui.c.dim(why));
  return 0;
}

/** 「另有 N 个…」这句在空列表和正常列表下都要说清楚 */
function hiddenText(dropped, opts = {}) {
  const bits = [];
  if (dropped.session) bits.push(`${dropped.session} 个用户会话`);
  if (dropped.noSandbox) bits.push(`${dropped.noSandbox} 个没有沙箱的会话`);
  if (dropped.archived) bits.push(`${dropped.archived} 个已归档`);
  if (!bits.length) return '';
  const hint = opts.withHint === false ? '' : '；要收编其中某个：cowbird adopt <引用>';
  return `另有 ${bits.join('、')}（--all 一起看${hint}）`;
}

module.exports = {
  run,
  usage: 'ls [--channel <渠道>] [--refresh] [--all] [--json]',
  help: [
    '选项:',
    '  -c, --channel <渠道>  只看这个渠道（平台[:账号]），默认聚合全部',
    '  -r, --refresh         强制联网拉一次（默认优先用本地缓存，若平台有缓存）',
    '  --all                 连用户会话（不是我们建的）、没有沙箱的、已归档的一起列出来',
    '  --json                输出 JSON',
    '',
    '说明:',
    '  默认只列沙箱会话：本工具管的实例。判据是登记簿 ——',
    '  cowbird create 建出来的、cowbird adopt 收编的、daemon 保活目标里的。',
    '  平台上的用户会话（你在网页里聊出来的那些）不在这个范围，用 --all 看，',
    '  「类型」列会标出沙箱/会话；想长期管某个会话就 cowbird adopt <引用>。',
    '  默认把所有已登录的渠道合在一起列，所以「同平台两个账号」「五个平台同时挂」都看得到。',
    '  「渠道」列只在多于一个渠道时出现，取值可直接当引用前缀：cowbird exec qoder:alt/<id>。',
    '  「凭据剩余」一列只有平台提供该能力时才显示（例如 WorkBuddy 的 E2B token）。',
    '  某个渠道读不到会单列一行警告，不影响其余渠道。',
  ],
};
