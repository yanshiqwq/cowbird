// wbsbx ls —— 列出云端实例（会话 = 一个沙箱）
const { parse } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const resolve = require('../lib/resolve');

async function run(argv) {
  const args = parse(argv, { flags: ['json', 'refresh', 'all'], aliases: { j: 'json', r: 'refresh' } });
  let list = await resolve.known({ refresh: args.opts.refresh });
  if (!args.opts.all) {
    // 默认隐藏：已归档的、只剩本地 token 缓存的历史实验会话（列表里已不存在的）
    list = list.filter((x) => !x.archived && !x.deleted && !x.local);
  }
  list.sort((a, b) => String(b.lastActivityAt || b.updatedAt || '').localeCompare(String(a.lastActivityAt || a.updatedAt || '')));

  if (args.opts.json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  if (!list.length) {
    console.log(ui.c.dim('没有实例。用 wbsbx create <名字> 开一个。'));
    return 0;
  }

  const rows = list.map((x) => {
    const t = cfg.readToken(x.id);
    return [
      x.id,
      x.name || ui.c.dim(x.local ? '(仅本地凭据)' : '(未命名)'),
      ui.statusBadge(x.status) + '/' + ui.statusBadge(x.sessionStatus),
      (x.lastActivityAt || x.updatedAt || '').replace('T', ' ').slice(0, 16),
      t && t.expireAt ? ui.til(t.expireAt) : ui.c.dim('无缓存'),
    ];
  });
  console.log(ui.table(['ID', '名字', '状态', '最近活动', '凭据剩余'], rows));
  console.log(ui.c.dim(`\n共 ${list.length} 个。明细缓存：${cfg.PATHS.conversations}`));
  return 0;
}

module.exports = { run, usage: 'ls [--refresh] [--json] [--all]' };
