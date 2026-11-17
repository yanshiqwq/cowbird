// cowbird platform —— 平台驱动能做什么、各自管着哪些渠道
//
// 这里**没有「当前平台」**：渠道是并行的（平台 × 账号同时在线），平台只是驱动的命名空间。
// 真正有「默认」这回事的只有**默认渠道**（平台:账号），用 cowbird account use 设置。
// 所以这条命令只有两级：
//   cowbird platform [ls]        全部平台并排的能力对照，每个平台带它自己的渠道
//   cowbird platform show <id>   单个平台的细节（能力、限制、默认值、渠道）
//
// 能力位与 contract.js 的 CAP 一一对应；中文名在 CAP_NAME 里，缺一条测试会报（test/smoke.js）。
const { parse } = require('../lib/args');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const accounts = require('../lib/platform/accounts');
const channels = require('../lib/platform/channels');

const CAP_NAME = Object.freeze({
  auth: '登录态',
  'auth.renew': '自动续期',
  'auth.browser': '浏览器登录',
  'instances.list': '实例列表',
  'instances.create': '新建',
  'instances.rename': '改名',
  'instances.remove': '删除',
  'instances.meta': '规格详情',
  agent: '对话',
  'agent.question': '回提问',
  'agent.interrupt': '中断',
  exec: '执行',
  'exec.background': '后台任务',
  'exec.wake': '唤醒沙箱',
  fs: '文件通道',
  model: '模型',
});

/** 一个平台下的渠道：有凭据的账号；默认渠道那个打 * */
function channelsOf(id, defaultKey) {
  return accounts.list(id)
    .filter((a) => accounts.hasCred(id, a))
    .map((a) => ({ key: `${id}:${a}`, account: a, default: `${id}:${a}` === defaultKey }));
}

function channelCell(chs) {
  if (!chs.length) return ui.c.dim('未登录');
  return chs.map((c) => (c.default ? c.account + ui.c.green('*') : c.account)).join(' ');
}

/**
 * 平台能力对照表（纯函数：只吃 registry.inventory() 的结果，不联网）。
 * @param {object[]} list  inventory() 的返回
 * @param {{all?:boolean, defaultKey?:string}} [opts]
 */
function matrixRows(list, opts = {}) {
  const head = ['ID', '名字', '渠道', '实例', '建/删/改', '对话', '执行', '后台', '文件', '续期'];
  const rows = [];
  for (const x of list || []) {
    if (!opts.all && String(x.id).startsWith('_')) continue;        // 样例驱动默认不露面
    if (!x.ok) {
      const pad = head.slice(3).map(() => ui.c.dim('·'));
      rows.push([x.id, ui.c.dim(x.displayName || '驱动不可用'), ui.c.red(String(x.error || '').slice(0, 48)), ...pad]);
      continue;
    }
    const caps = x.capabilities || [];
    const cap = (c) => (caps.includes(c) ? ui.c.green('✓') : ui.c.dim('·'));
    rows.push([
      x.id,
      x.displayName || '',
      channelCell(channelsOf(x.id, opts.defaultKey || channels.defaultKey())),
      cap('instances.list'),
      ['instances.create', 'instances.remove', 'instances.rename'].map(cap).join('/'),
      cap('agent'),
      cap('exec'),
      cap('exec.background'),
      cap('fs'),
      cap('auth.renew'),
    ]);
  }
  return { head, rows };
}

/**
 * 单个平台的明细。能力按「实例 / 对话 / 执行 / 文件 / 认证」分组给人看 ——
 * 一长串能力位挤在一行没人读，分组之后「这个平台能不能 exec」一眼就有答案。
 * @param {object} p    provider
 * @param {object[]} chs 该平台的渠道（channels.describeLogin() 的结果）
 * @param {{defaultKey?:string}} [opts]
 */
const GROUPS = [
  ['实例', ['instances.list', 'instances.create', 'instances.rename', 'instances.remove', 'instances.meta']],
  ['对话', ['agent', 'agent.question', 'agent.interrupt']],
  ['执行', ['exec', 'exec.background', 'exec.wake']],
  ['文件', ['fs']],
  ['认证', ['auth', 'auth.renew', 'auth.browser']],
  ['其它', ['model']],
];

function detailRows(p, chs, opts = {}) {
  const caps = p.capabilityList() || [];
  const builtin = Boolean(registry.BUILTIN[p.id]);
  const rows = [
    ['平台', `${p.displayName} · ${p.id}`],
    ['驱动', (builtin ? `内置（lib/platform/${p.id}/）` : '外部（COWBIRD_PLATFORM_MODULE）') + (p.version ? ` · 驱动版本 ${p.version}` : '')],
  ];
  const known = new Set();
  for (const [label, bits] of GROUPS) {
    bits.forEach((b) => known.add(b));
    const have = bits.filter((b) => caps.includes(b));
    if (have.length) {
      let text = have.map((c) => CAP_NAME[c] || c).join(' · ');
      if (label === '执行') {
        const lim = [`同步上限 ${Math.round(p.limits.maxSyncMs / 1000)}s / 默认 ${Math.round(p.limits.defaultSyncMs / 1000)}s`];
        if (p.has('exec') && p.has('exec.wake')) lim.push('执行前要唤醒沙箱');
        text += ui.c.dim('（' + lim.join(' · ') + '）');
      }
      rows.push([label, text]);
    } else if (label === '执行') {
      rows.push([label, ui.c.dim('没有执行通道 —— cowbird exec 会直接报不支持（退出码 2）')]);
    }
  }
  const rest = caps.filter((c) => !known.has(c));
  if (rest.length) rows.push(['其它', rest.map((c) => CAP_NAME[c] || c).join(' · ')]);

  const dv = Object.entries(p.defaults || {});
  if (dv.length) {
    // 平台的默认值可能一大堆（MiniMax 有 10 个），一行塞不下就按宽度折成几行
    const parts = dv.map(([k, v]) => `${k}=${v}`);
    const lines = [];
    let cur = '';
    for (const s of parts) {
      if (cur && (cur + ' · ' + s).length > 76) { lines.push(cur); cur = s; } else cur = cur ? cur + ' · ' + s : s;
    }
    if (cur) lines.push(cur);
    lines.forEach((l, i) => rows.push([i === 0 ? '默认值' : '', l]));
  }

  if (!chs.length) rows.push(['渠道', ui.c.dim('未登录（cowbird login' + (p.id === registry.currentId() ? '' : ` --platform ${p.id}`) + '）')]);
  chs.forEach((d, i) => {
    const bits = [d.key + (d.key === opts.defaultKey ? ui.c.green(' *') : '')];
    if (!d.hasCred) bits.push(ui.c.dim('未登录'));
    if (d.who) bits.push(d.who);
    if (d.hasCred) bits.push(d.ttlDays == null ? '凭据剩余未知' : d.ttlDays <= 0 ? ui.c.red('已过期') : `剩余 ${d.ttlDays.toFixed(1)} 天`);
    rows.push([i === 0 ? '渠道' : '', bits.join(' · ')]);
  });
  return rows;
}

async function listAll(args) {
  const defKey = channels.defaultKey();
  const list = registry.inventory();
  if (args.opts.json) {
    console.log(JSON.stringify({
      default: defKey,
      platforms: list.filter((x) => args.opts.all || !String(x.id).startsWith('_')).map((x) => ({
        ...x,
        channels: x.ok ? channelsOf(x.id, defKey) : [],
      })),
    }, null, 2));
    return 0;
  }
  const { head, rows } = matrixRows(list, { all: !!args.opts.all, defaultKey: defKey });
  console.log(ui.table(head, rows));
  console.log(ui.c.dim(`\n默认渠道 ${defKey}`) + ui.c.dim('（cowbird account use <平台:账号> 切换）' +
    ' · 单平台详情 cowbird platform show <id> · 登录态细节 cowbird account ls' +
    (args.opts.all ? '' : ' · 样例驱动 cowbird platform ls --all')));
  return 0;
}

async function showOne(id) {
  const p = registry.load(id);                     // 不污染 current 单例（渠道枚举会用它）
  const defKey = channels.defaultKey();
  const chs = [];
  for (const ch of channels.all()) {
    if (ch.platform !== p.id) continue;
    try { chs.push(await channels.describeLogin(ch)); } catch { chs.push({ key: ch.key, hasCred: false }); }
  }
  return { p, defKey, chs };
}

async function run(argv) {
  const args = parse(argv, { flags: ['json', 'all'] });
  const sub = args._[0];

  if (!sub || sub === 'ls' || sub === 'list') return listAll(args);

  if (sub === 'use') {
    throw new Error('platform use 已删除：平台没有「当前」这个概念了，默认值只有一个 —— 默认渠道。\n'
      + '  设默认渠道：cowbird account use <平台:账号>　临时指定：cowbird --platform <id> <命令>');
  }

  // show <id> / info <id> / 直接写 id 都认
  const id = sub === 'show' || sub === 'info' ? args._[1] : sub;
  const { p, defKey, chs } = await showOne(id || registry.currentId());

  if (args.opts.json) {
    console.log(JSON.stringify({
      id: p.id,
      displayName: p.displayName,
      version: p.version || null,
      capabilities: p.capabilityList(),
      limits: p.limits,
      defaults: p.defaults || {},
      default: defKey,
      channels: chs,
    }, null, 2));
    return 0;
  }
  console.log(ui.table(['项目', '值'], detailRows(p, chs, { defaultKey: defKey }), { sep: false }));
  console.log(ui.c.dim(`\n全部平台：cowbird platform ls`));
  return 0;
}

module.exports = {
  run,
  CAP_NAME,
  channelsOf,
  matrixRows,
  detailRows,
  usage: 'platform [ls|show <id>] [--all] [--json]',
  help: [
    '子命令:',
    '  ls            全部平台的能力对照（默认；每个平台带它自己的渠道）',
    '  show <id>     单个平台的细节：能力、限制、默认值、渠道',
    '',
    '选项:',
    '  --all         连样例驱动（_example）一起列',
    '  --json        输出 JSON',
    '',
    '说明:',
    '  平台只是驱动的命名空间，没有「当前平台」：多渠道是并行的，默认值只有一个 ——',
    '  默认渠道（平台:账号），用 cowbird account use <平台:账号> 设置，表里打 *。',
    '  「渠道」列是各平台已登录的账号；某个渠道要看细节用 cowbird --channel <渠道> doctor。',
    '  第三方驱动用 COWBIRD_PLATFORM_MODULE=<路径|包名> 挂进来，同样会出现在这张表里。',
    '',
    '退出码:',
    '  0  正常',
    '  1  平台 id 不存在 / 驱动加载失败',
  ],
};
