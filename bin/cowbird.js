#!/usr/bin/env node
// cowbird —— 把各大网页 agent 自带的沙箱 shell 包装成统一的云沙箱管理器（客户端）
//
// 职责边界：只管「对实例做事」——列、建、删、执行、收发文件、看历史、发消息。
// 「让实例活着 / 让登录态不过期」是 daemon 的活，见 cowbird daemon。
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
  adopt: { mod: '../commands/adopt', alias: ['claim'] },
  put: { mod: '../commands/transfer', alias: [], pick: 0 },
  get: { mod: '../commands/transfer', alias: [], pick: 1 },
  history: { mod: '../commands/history', alias: ['log'] },
  watch: { mod: '../commands/watch', alias: ['tail'] },
  prompt: { mod: '../commands/prompt', alias: ['say'] },
  keepalive: { mod: '../commands/keepalive', alias: ['ka'] },
  login: { mod: '../commands/login', alias: [] },
  doctor: { mod: '../commands/doctor', alias: ['diag'] },
  daemon: { mod: '../commands/daemon', alias: ['d', 'svc'] },
  account: { mod: '../commands/account', alias: ['accounts', 'ch', 'channels'] },
  platform: { mod: '../commands/platform', alias: ['providers', 'drivers'] },
};

const ALIAS = {};
for (const [name, def] of Object.entries(COMMANDS)) {
  for (const a of [name, ...(def.alias || [])]) ALIAS[a] = name;
}

// 全局开关：只从**命令名之前**摘取。
// 这一点很关键 —— 原先把整条 argv 都扫一遍，`cowbird exec 01 curl --token x` 里的 --token
// 会被当成全局开关吃掉。跟 docker/gh 一致：全局开关写在命令前。
function extractGlobals(argv) {
  const out = [];
  let i = 0;
  const take = (flag) => {
    const v = argv[++i];
    if (v === undefined || v === '') throw new Error(`--${flag} 需要一个值`);
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform') { process.env.COWBIRD_PLATFORM = take('platform'); continue; }
    if (a.startsWith('--platform=')) { process.env.COWBIRD_PLATFORM = a.slice(11); continue; }
    if (a === '--account') { process.env.COWBIRD_ACCOUNT = take('account'); continue; }
    if (a.startsWith('--account=')) { process.env.COWBIRD_ACCOUNT = a.slice(10); continue; }
    if (a === '--channel') { process.env.COWBIRD_CHANNEL = take('channel'); continue; }
    if (a.startsWith('--channel=')) { process.env.COWBIRD_CHANNEL = a.slice(10); continue; }
    if (a === '--remote') { process.env.COWBIRD_DAEMON_URL = take('remote'); continue; }
    if (a.startsWith('--remote=')) { process.env.COWBIRD_DAEMON_URL = a.slice(9); continue; }
    if (a.startsWith('--token=')) { process.env.COWBIRD_DAEMON_TOKEN = a.slice(8); continue; }
    if (a === '--token') { process.env.COWBIRD_DAEMON_TOKEN = take('token'); continue; }
    out.push(a);
    break;                       // 遇到命令名，后面的原样保留
  }
  for (let j = i + 1; j < argv.length; j++) out.push(argv[j]);
  return out;
}

function help() {
  const cmdRows = [
    ['ls', '沙箱会话列表'],
    ['create', '新建实例'],
    ['adopt', '收编已有会话'],
    ['rm', '删除/归档'],
    ['rename', '修改实例名'],
    ['exec', '在实例里跑命令'],
    ['info', '配额详情'],
    ['put', '传入文件'],
    ['get', '取出文件'],
    ['history', '导出对话历史'],
    ['watch', '观测输出'],
    ['prompt', '向会话发送消息'],
    ['keepalive', '沙箱保活'],
    ['login', '登录'],
    ['doctor', '自检'],
    ['daemon', '常驻进程'],
    ['account', '账号与渠道'],
    ['platform', '平台驱动与能力'],
  ];
  console.log(ui.c.bold(`cowbird ${pkg.version}`) + ui.c.dim(' · 云沙箱管理器（多平台多账号）'));
  console.log('\n' + ui.c.bold('用法') + ':  cowbird <命令> [选项] [参数]');
  console.log('\n' + ui.table(['命令', '说明'], cmdRows));

  console.log(`
${ui.c.bold('实例引用方式：')}
  1. 完整 id（2123456789012345678）
  2. 会话名（work-01）
  3. 短序号（01）
  4. 带渠道（qoder:alt/01）—— 同名实例分属不同账号时用这个

${ui.c.bold('全局开关')}
  写在命令之前，例如 cowbird --channel qoder:alt ls
  --channel <平台[:账号]>  指定渠道
  --platform <id>         指定平台（账号取默认）
  --account <名字>        指定账号（平台取默认）
  --remote <地址>         使用远程 daemon
  --token <令牌>          配合 --remote

${ui.c.bold('环境变量')}
  COWBIRD_HOME              数据目录（默认 ~/.cowbird）
  COWBIRD_PLATFORM          默认平台
  COWBIRD_ACCOUNT           默认账号
  COWBIRD_CHANNEL           默认渠道（平台:账号）
  COWBIRD_PLATFORM_MODULE   第三方驱动
  COWBIRD_DAEMON_URL        等同于 --remote
  COWBIRD_DAEMON_TOKEN      等同于 --token
`);
  console.log(ui.c.dim('运行 `cowbird <命令> --help` 查看该命令的选项与退出码'));
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
    console.error(ui.c.red(`未知命令：${argv[0]}`) + ui.c.dim('（运行 cowbird --help 看可用命令）'));
    return 2;
  }
  const def = COMMANDS[name];
  let mod = require(def.mod);
  if (Array.isArray(mod)) mod = mod[def.pick || 0];

  const rest = argv.slice(1);
  const hi = rest.findIndex((a) => a === '--help' || a === '-h');
  if (hi >= 0) {
    // 对 exec/prompt 这类「实例之后全是命令」的子命令，只有写在实例之前的 --help 才算要看帮助；
    // 否则 `cowbird exec 01 ls -h` 会被误当成"看帮助"，而用户其实想让远端跑 ls -h。
    let show = true;
    if (mod.stopAfter) {
      const firstPos = rest.findIndex((a) => !a.startsWith('-'));
      show = firstPos === -1 || hi < firstPos;
    }
    if (show) {
      console.log(`用法: cowbird ${mod.usage}`);
      if (Array.isArray(mod.help) && mod.help.length) console.log('\n' + mod.help.join('\n'));
      return 0;
    }
  }
  return (await mod.run(rest)) || 0;
}

main()
  .then((code) => { process.exitCode = Number(code) || 0; })
  .catch((e) => {
    console.error(ui.c.red('出错：') + String((e && e.message) || e).replace(/\n/g, '\n  '));
    if (process.env.COWBIRD_DEBUG) console.error(e.stack);
    // 能力缺失（例如平台没有 exec）用 2 与"执行失败=1"区分开
    process.exitCode = e && e.code === 'E_CAPABILITY' ? 2 : 1;
  });
