// cowbird account —— 账号与渠道
//
// 一个平台可以有多个账号（各自一份独立登录态），多个平台可以同时挂着。
// 一个「渠道」就是一对 平台:账号，实例、登录态、保活都挂在渠道上。
//
// 这条命令只管本地：不联网、不改云端状态。想加账号是 `cowbird login --as <名字>`。
const { parse } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const accounts = require('../lib/platform/accounts');
const channels = require('../lib/platform/channels');

const USAGE = 'account [ls|use <渠道>|rm <渠道>|mv <旧> <新>]';

/** 默认渠道（配置里的平台 + 该平台的默认账号） */
function defaultChannel() {
  const c = cfg.readConfig();
  const id = c.platform || cfg.DEFAULT_PLATFORM;
  return `${id}:${(c.accounts && c.accounts[id]) || accounts.DEFAULT_ALIAS}`;
}

async function listAll(args) {
  const all = channels.all();
  const def = defaultChannel();
  const rows = [];
  for (const ch of all) {
    try {
      const d = await channels.describeLogin(ch);
      d.default = d.key === def;
      // 迁移过来的老账号没有名片：既然读到了身份，就顺手记下来，下次不用再猜
      if (d.who && !d.uid) accounts.writeMeta(ch.platform, ch.account, { uid: null, nickname: d.who });
      rows.push(d);
    } catch (e) {
      rows.push({ key: ch.key, platform: ch.platform, account: ch.account, displayName: ch.provider.displayName, error: String(e.message).slice(0, 120) });
    }
  }
  // 还没有任何账号的平台也列出来（未登录也是一种状态，得让人看见）
  const seen = new Set(rows.map((r) => r.platform));
  for (const p of registry.inventory()) {
    if (!p.ok || p.id.startsWith('_') || seen.has(p.id)) continue;
    rows.push({ key: `${p.id}:${accounts.DEFAULT_ALIAS}`, platform: p.id, account: accounts.DEFAULT_ALIAS, displayName: p.displayName, empty: true, default: false });
  }

  if (args.opts.json) {
    console.log(JSON.stringify({ default: def, channels: rows }, null, 2));
    return 0;
  }
  if (!rows.length) {
    console.log(ui.c.dim('还没有任何账号。先登录一个：cowbird login --as <名字>'));
    return 0;
  }

  const multiPlatform = new Set(rows.map((r) => r.platform)).size > 1;
  const head = ['', '渠道', '身份', '凭据剩余', '登录时间'];
  const body = rows.map((r) => {
    if (r.empty) {
      return [' ', ui.c.dim(r.key), ui.c.dim('未登录'), ui.c.dim('-'), ui.c.dim('-')];
    }
    return [
      r.default ? ui.c.green('*') : ' ',
      r.key,
      r.who || ui.c.dim('(未记录)'),
      r.error ? ui.c.red('读不到') : r.ttlDays == null ? ui.c.dim('未知') : ui.til((Date.now() + r.ttlDays * 86400e3) / 1000),
      r.savedAt ? String(r.savedAt).replace('T', ' ').slice(0, 16) : ui.c.dim('-'),
    ];
  });
  console.log(ui.table(head, body));
  console.log(ui.c.dim(`\n共 ${rows.filter((r) => !r.empty).length} 个已登录渠道（* = 默认）` +
    (multiPlatform ? `，跨 ${new Set(rows.filter((r) => !r.empty).map((r) => r.platform)).size} 个平台` : '')));
  console.log(ui.c.dim('加账号：cowbird login --as <名字>　切换默认：cowbird account use <渠道>'));
  return 0;
}

async function run(argv) {
  const args = parse(argv, { flags: ['json', 'force'] });
  const sub = args._[0] || 'ls';

  if (sub === 'ls' || sub === 'list') return listAll(args);

  if (sub === 'use') {
    const spec = args._[1];
    if (!spec) throw new Error('用法: cowbird account use <平台[:账号]>');
    const ch = channels.get(spec);                    // 先验证能加载
    if (!ch.hasCred) {
      throw new Error(`账号「${ch.key}」还没有登录态。先跑：cowbird login --as ${ch.account}` + (ch.platform === cfg.DEFAULT_PLATFORM ? '' : ` --platform ${ch.platform}`));
    }
    cfg.writeConfig({ platform: ch.platform, accounts: { [ch.platform]: ch.account } });
    console.log(ui.c.green('默认渠道已切换为 ') + ch.key + ui.c.dim(`（${ch.provider.displayName}）`));
    return 0;
  }

  if (sub === 'rm' || sub === 'remove') {
    const spec = args._[1];
    if (!spec) throw new Error('用法: cowbird account rm <平台[:账号]>');
    const ch = channels.get(spec);
    const siblings = accounts.list(ch.platform).filter((a) => accounts.hasCred(ch.platform, a));
    if (ch.hasCred && siblings.length <= 1 && !args.opts.force) {
      throw new Error(`「${ch.key}」是 ${ch.platform} 唯一的登录态，删了就得重新登录。确实要删就加 --force。`);
    }
    if (!accounts.exists(ch.platform, ch.account)) {
      console.log(ui.c.dim(`没有账号「${ch.key}」，什么都没做`));
      return 0;
    }
    const dir = accounts.dir(ch.platform, ch.account);
    accounts.remove(ch.platform, ch.account);
    const c = cfg.readConfig();
    if (c.accounts && c.accounts[ch.platform] === ch.account) cfg.writeConfig({ accounts: { [ch.platform]: accounts.DEFAULT_ALIAS } });
    console.log(ui.c.green('已删除 ') + ch.key + ui.c.dim(`（${dir}）`));
    return 0;
  }

  if (sub === 'mv' || sub === 'rename') {
    const [from, to] = [args._[1], args._[2]];
    if (!from || !to) throw new Error('用法: cowbird account mv <旧渠道> <新渠道>');
    const a = channels.parse(from);
    const b = channels.parse(to);
    const platform = b.account ? b.platform : a.platform;
    const dst = b.account || b.platform;
    accounts.rename(a.platform, a.account || accounts.DEFAULT_ALIAS, dst);
    const c = cfg.readConfig();
    if (c.accounts && c.accounts[a.platform] === (a.account || accounts.DEFAULT_ALIAS)) cfg.writeConfig({ accounts: { [a.platform]: dst } });
    console.log(ui.c.green('已改名 ') + `${a.platform}:${a.account || accounts.DEFAULT_ALIAS} → ${platform}:${dst}`);
    return 0;
  }

  throw new Error('用法: cowbird ' + USAGE);
}

module.exports = {
  run,
  usage: USAGE,
  help: [
    '子命令:',
    '  ls               所有渠道（默认）',
    '  use <渠道>       设为默认渠道（写进 cowbird.json）',
    '  rm <渠道>        删掉该账号的本地登录态',
    '  mv <旧> <新>     改账号名（目录改名，不动凭据）',
    '',
    '选项:',
    '  --json           输出 JSON',
    '  --force          删掉某平台唯一的那份登录态',
    '',
    '说明:',
    '  渠道 = 平台:账号，例如 workbuddy:default / qoder:alt。',
    '  默认渠道用于「实例引用不带渠道前缀」时先找哪个；找不到会继续找其它渠道。',
    '  加账号：cowbird login --as <名字>（同平台可以挂多个）。',
    '',
    '退出码:',
    '  0  正常',
    '  1  用法错误 / 账号不存在',
  ],
};
