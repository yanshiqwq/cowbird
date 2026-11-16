#!/usr/bin/env node
// wbsbx —— WorkBuddy 云沙箱管理器（客户端）
//
// 职责边界：只管「对实例做事」——列、建、删、执行、收发文件、看历史、发消息。
// 「让实例活着 / 让登录态不过期」是 daemon 的活，见 wbsbx daemon。
// 两者共享一份凭据目录，但 daemon 不在时 CLI 照样能用（走本地缓存，只是凭据会慢慢变旧）。
const ui = require('../lib/ui');
const pkg = require('../package.json');

const COMMANDS = {
  ls: { mod: '../commands/ls', alias: ['list', 'ps'] },
  info: { mod: '../commands/info', alias: ['show'] },
  create: { mod: '../commands/create', alias: ['new'] },
  rm: { mod: '../commands/rm', alias: ['del', 'delete'] },
  rename: { mod: '../commands/rename', alias: ['mv'] },
  exec: { mod: '../commands/exec', alias: ['run'] },
  put: { mod: '../commands/transfer', alias: [], pick: 0 },
  get: { mod: '../commands/transfer', alias: [], pick: 1 },
  history: { mod: '../commands/history', alias: ['log'] },
  watch: { mod: '../commands/watch', alias: ['tail'] },
  prompt: { mod: '../commands/prompt', alias: ['say'] },
  login: { mod: '../commands/login', alias: [] },
  cookie: { mod: '../commands/cookie', alias: [] },
  doctor: { mod: '../commands/doctor', alias: ['diag'] },
  daemon: { mod: '../commands/daemon', alias: ['d', 'svc'] },
};

const ALIAS = {};
for (const [name, def] of Object.entries(COMMANDS)) {
  for (const a of [name, ...(def.alias || [])]) ALIAS[a] = name;
}

// 全局开关：在命令分发之前就把它们摘掉，免得每个命令都要认一遍
function extractGlobals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') { process.env.WBSBX_LOCAL = '1'; continue; }
    if (a === '--remote') { process.env.WBSBX_DAEMON_URL = argv[++i]; continue; }
    if (a.startsWith('--remote=')) { process.env.WBSBX_DAEMON_URL = a.slice(9); continue; }
    if (a.startsWith('--token=')) { process.env.WBSBX_DAEMON_TOKEN = a.slice(8); continue; }
    if (a === '--token') { process.env.WBSBX_DAEMON_TOKEN = argv[++i]; continue; }
    out.push(a);
  }
  return out;
}

function help() {
  const cmdRows = [
    ['ls', '列实例（状态 / 最近活动 / 凭据剩余）'],
    ['info', '单个实例详情：配额、内存、uptime'],
    ['create', '新建实例（会话即容器）'],
    ['rm', '删除（默认 dry-run，--yes 才真删）'],
    ['rename', '改名'],
    ['exec', '在实例里跑命令（不经 Agent，不进对话）'],
    ['put / get', '传文件进去 / 取文件出来'],
    ['history', '拉对话历史'],
    ['watch', '连上去看一会儿输出'],
    ['prompt', '给会话发一句话'],
    ['login', '扫码登录（唯一需要浏览器的一步）'],
    ['cookie', '查/测登录态'],
    ['doctor', '体检：登录态 / 接口 / 实例 / 凭据 / daemon'],
    ['daemon', '常驻进程：保活、刷 token、续登录态'],
  ];
  console.log(ui.c.bold(`wbsbx v${pkg.version}`) + ui.c.dim('  —  WorkBuddy 云沙箱管理器'));
  console.log('\n' + ui.c.bold('用法') + ':  wbsbx <命令> [参数]');
  console.log('\n' + ui.table(['命令', '作用'], cmdRows));

  console.log(`
${ui.c.bold('实例引用')}  id（2120000000000000000） / 名字（work-01） / 短序号（01）

${ui.c.bold('常驻（让实例活着）')}
  wbsbx daemon start --detach    后台起一个，之后关掉电脑也不影响
  wbsbx daemon targets add 01    把 01 加进保活名单
  wbsbx daemon status            看它到底在干嘛

${ui.c.bold('全局开关')}
  --local                 这次不走 daemon，直接用本地凭据
  --remote <url>          这次改用另一台机器上的 daemon
  --token <令牌>          配合 --remote

${ui.c.bold('环境变量')}
  WB_CLOUD_HOME           数据目录（默认 ~/.wbsbx）
  WBSBX_DAEMON_URL        等于 --remote
  WBSBX_DAEMON_TOKEN      等于 --token

${ui.c.dim('运营在别人的平台上，容器随时可能被回收：保活靠 daemon 定期访问，登录态靠它续期。')}
`);
  return 0;
}

async function main() {
  let argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv[0] === '-h' || argv[0] === '--help') return help();
  if (argv[0] === '-v' || argv[0] === '--version' || argv[0] === 'version') { console.log(pkg.version); return 0; }

  argv = extractGlobals(argv);
  if (!argv.length) return help();

  const name = ALIAS[argv[0]];
  if (!name) {
    console.error(ui.c.red(`未知命令：${argv[0]}`));
    help();
    return 2;
  }
  const def = COMMANDS[name];
  let mod = require(def.mod);
  if (Array.isArray(mod)) mod = mod[def.pick || 0];

  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`用法: wbsbx ${mod.usage}`);
    return 0;
  }
  return (await mod.run(rest)) || 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error(ui.c.red('出错：') + String((e && e.message) || e).replace(/\n/g, '\n  '));
    if (process.env.WBSBX_DEBUG) console.error(e.stack);
    process.exit(1);
  });
