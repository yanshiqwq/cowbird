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
  keepalive: { mod: '../commands/keepalive', alias: ['ka'] },
  login: { mod: '../commands/login', alias: [] },
  cookie: { mod: '../commands/cookie', alias: [] },
  doctor: { mod: '../commands/doctor', alias: ['diag'] },
  daemon: { mod: '../commands/daemon', alias: ['d', 'svc'] },
  platform: { mod: '../commands/platform', alias: ['providers', 'drivers'] },
};

const ALIAS = {};
for (const [name, def] of Object.entries(COMMANDS)) {
  for (const a of [name, ...(def.alias || [])]) ALIAS[a] = name;
}

// 全局开关：只从**命令名之前**摘取。
// 这一点很关键 —— 原先把整条 argv 都扫一遍，`wbsbx exec 01 curl --token x` 里的 --token
// 会被当成全局开关吃掉。跟 docker/gh 一致：全局开关写在命令前。
function extractGlobals(argv) {
  const out = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') { process.env.WBSBX_LOCAL = '1'; continue; }
    if (a === '--platform') { process.env.WBSBX_PLATFORM = argv[++i]; continue; }
    if (a.startsWith('--platform=')) { process.env.WBSBX_PLATFORM = a.slice(11); continue; }
    if (a === '--remote') { process.env.WBSBX_DAEMON_URL = argv[++i]; continue; }
    if (a.startsWith('--remote=')) { process.env.WBSBX_DAEMON_URL = a.slice(9); continue; }
    if (a.startsWith('--token=')) { process.env.WBSBX_DAEMON_TOKEN = a.slice(8); continue; }
    if (a === '--token') { process.env.WBSBX_DAEMON_TOKEN = argv[++i]; continue; }
    out.push(a);
    break;                       // 遇到命令名，后面的原样保留
  }
  for (let j = i + 1; j < argv.length; j++) out.push(argv[j]);
  return out;
}

function help() {
  const cmdRows = [
    ['ls', '列实例：状态、最近活动、凭据剩余'],
    ['info', '单个实例详情：CPU 配额、内存、uptime'],
    ['create', '新建实例（一个会话就是一个容器）'],
    ['rm', '删除/归档（默认 dry-run，加 --yes 才执行）'],
    ['rename', '改实例名（会话标题）'],
    ['exec', '在实例里跑命令（不经 Agent，不进对话）'],
    ['put', '把本地文件传进实例'],
    ['get', '把实例里的文件取出来'],
    ['history', '导出对话历史'],
    ['watch', '连着看一会儿输出'],
    ['prompt', '以用户口吻给会话发一条消息'],
    ['keepalive', '长驻：把会话钉在「等回答」上，防闲置回收'],
    ['login', '扫码登录（唯一需要浏览器的一步）'],
    ['cookie', '查看/导出/实测登录态'],
    ['doctor', '体检：登录态、接口、实例、凭据、daemon'],
    ['daemon', '常驻进程：保活、刷 token、续登录态'],
    ['platform', '看/切平台驱动：能力、执行通道、同步上限'],
  ];
  console.log(ui.c.bold(`wbsbx ${pkg.version}`) + ui.c.dim(' · 云沙箱管理器（多平台）'));
  console.log('\n' + ui.c.bold('用法') + ':  wbsbx <命令> [选项] [参数]');
  console.log('\n' + ui.table(['命令', '说明'], cmdRows));

  console.log(`
${ui.c.bold('实例引用')}
  以下三种写法等价：完整 id（2120000000000000000）、会话名（work-01）、短序号（01）

${ui.c.bold('常用')}
  wbsbx login                             扫码登录，之后全走纯 HTTP
  wbsbx ls                                看有哪些实例
  wbsbx exec 01 ls -la                    实例之后的内容全部当命令
  wbsbx daemon start --detach             后台起 daemon，关掉终端也不影响
  wbsbx daemon targets add 01             把 01 加进保活名单

${ui.c.bold('全局开关')}
  写在命令之前，例如 wbsbx --local ls
  --local                 这一次不走 daemon，直接用本地凭据
  --platform <id>         这一次换一个平台驱动（wbsbx platform ls 看有哪些）
  --remote <地址>         这一次改用另一台机器上的 daemon
  --token <令牌>          配合 --remote

${ui.c.bold('环境变量')}
  WB_CLOUD_HOME           数据目录（默认 ~/.wbsbx）
  WBSBX_PLATFORM          默认平台（等同于配置里的 platform）
  WBSBX_PLATFORM_MODULE   第三方驱动的路径/包名（不改内核就能加平台）
  WBSBX_DAEMON_URL        等同于 --remote
  WBSBX_DAEMON_TOKEN      等同于 --token
  WBSBX_PW_MODULE         playwright-core 的位置（装在镜像里时用）
  WBSBX_BROWSER           chromium/edge 可执行文件路径
`);
  console.log(ui.c.dim('运行 `wbsbx <命令> --help` 查看该命令的选项与退出码。'));
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
    console.error(ui.c.red(`未知命令：${argv[0]}`) + ui.c.dim('（运行 wbsbx --help 看可用命令）'));
    return 2;
  }
  const def = COMMANDS[name];
  let mod = require(def.mod);
  if (Array.isArray(mod)) mod = mod[def.pick || 0];

  const rest = argv.slice(1);
  const hi = rest.findIndex((a) => a === '--help' || a === '-h');
  if (hi >= 0) {
    // 对 exec/prompt 这类「实例之后全是命令」的子命令，只有写在实例之前的 --help 才算要看帮助；
    // 否则 `wbsbx exec 01 ls -h` 会被误当成"看帮助"，而用户其实想让远端跑 ls -h。
    let show = true;
    if (mod.stopAfter) {
      const firstPos = rest.findIndex((a) => !a.startsWith('-'));
      show = firstPos === -1 || hi < firstPos;
    }
    if (show) {
      console.log(`用法: wbsbx ${mod.usage}`);
      if (Array.isArray(mod.help) && mod.help.length) console.log('\n' + mod.help.join('\n'));
      return 0;
    }
  }
  return (await mod.run(rest)) || 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error(ui.c.red('出错：') + String((e && e.message) || e).replace(/\n/g, '\n  '));
    if (process.env.WBSBX_DEBUG) console.error(e.stack);
    // 能力缺失（例如平台没有 exec）用 2 与"执行失败=1"区分开
    process.exit(e && e.code === 'E_CAPABILITY' ? 2 : 1);
  });
