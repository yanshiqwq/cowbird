// cowbird platform —— 看/切「平台驱动」
//
// 这条命令存在的意义：把一个平台能做什么、不能做什么直接摊开，
// 免得 exec 之类的能力在缺能力时只能靠一句报错去猜。
const { parse } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const registry = require('../lib/platform');

function rowsFor(p) {
  const caps = p.capabilityList();
  const has = (c) => (caps.includes(c) ? ui.c.green('✓') : ui.c.dim('·'));
  return [
    ['平台', `${p.displayName}（${p.id}）`],
    ['版本', p.version || '-'],
    ['实例列表', has('instances.list')],
    ['建 / 删 / 改名', has('instances.create') + ' / ' + has('instances.remove') + ' / ' + has('instances.rename')],
    ['对话通道', has('agent')],
    ['提问 / 中断', has('agent.question') + ' / ' + has('agent.interrupt')],
    ['执行（exec）', has('exec')],
    ['后台任务', has('exec.background')],
    ['文件通道（fs）', has('fs')],
    ['需唤醒沙箱', has('exec.wake')],
    ['可自动续期', has('auth.renew')],
    ['同步上限', p.limits.maxSyncMs + 'ms（默认 ' + p.limits.defaultSyncMs + 'ms）'],
    ['默认模型', (p.defaults && p.defaults.model) || '-'],
  ];
}

async function run(argv) {
  const args = parse(argv, { flags: ['json', 'all'] });
  const sub = args._[0] || 'show';

  if (sub === 'ls' || sub === 'list') {
    const list = registry.inventory();
    if (args.opts.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
    const cur = registry.currentId();
    const rows = list.map((x) => [
      x.id === cur ? ui.c.green('*') : ' ',
      x.id,
      x.ok ? (x.displayName || '') : ui.c.dim('未实现'),
      x.ok ? String((x.capabilities || []).length) + ' 项能力' : ui.c.dim(String(x.error || '').slice(0, 40)),
    ]);
    console.log(ui.table(['', 'ID', '名字', '能力'], rows));
    console.log(ui.c.dim(`\n当前：${cur}。切换：cowbird platform use <id>`));
    return 0;
  }

  if (sub === 'use') {
    const id = args._[1];
    if (!id) throw new Error('用法: cowbird platform use <id>');
    const p = registry.use(id);                 // 先验证能加载，再落盘
    cfg.writeConfig({ platform: p.id });
    console.log(ui.c.green('已切换到 ') + `${p.displayName}（${p.id}）`);
    if (!p.has('exec')) console.log(ui.c.yellow('注意：该平台没有 exec 能力，cowbird exec 会直接报不支持'));
    return 0;
  }

  if (sub !== 'show' && sub !== 'info') throw new Error('用法: cowbird platform [show|ls|use <id>]');

  const p = registry.get();
  if (args.opts.json) {
    console.log(JSON.stringify({
      id: p.id, displayName: p.displayName, version: p.version,
      capabilities: p.capabilityList(), limits: p.limits, defaults: p.defaults,
      source: process.env.COWBIRD_PLATFORM_MODULE ? 'module' : 'builtin',
    }, null, 2));
    return 0;
  }
  console.log(ui.table(['项目', '值'], rowsFor(p), { sep: false }));
  console.log(ui.c.dim(`\n全部平台：cowbird platform ls`));
  return 0;
}

module.exports = {
  run,
  usage: 'platform [show|ls|use <id>] [--json]',
  help: [
    '子命令:',
    '  show          当前平台的能力与限制（默认）',
    '  ls            列出所有内置驱动与加载状态',
    '  use <id>      切换平台（写进 cowbird.json 的 platform）',
    '',
    '选项:',
    '  --json        输出 JSON',
    '',
    '说明:',
    '  平台由 cowbird.json 的 "platform" 决定，可用 COWBIRD_PLATFORM 覆盖；',
    '  第三方驱动用 COWBIRD_PLATFORM_MODULE=<路径|包名> 指过来，不需要改内核。',
    '',
    '退出码:',
    '  0  正常',
    '  2  子命令用法错误',
  ],
};
