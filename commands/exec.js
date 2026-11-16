// wbsbx exec —— 在实例里直接跑命令（走 E2B，不经过 Agent、不进对话轨迹）
//
// 参数规则跟 ssh / docker exec 一致：**第一个位置参数之后的全部内容都是命令**。
// 所以 `wbsbx exec 01 ls -la /etc` 能直接用，不用给整条命令加引号。
// 代价是 exec 自己的选项要写在实例之前：`wbsbx exec --timeout 30 01 "sleep 60"`。
const fs = require('fs');
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const e2b = require('../lib/e2b');
const resolve = require('../lib/resolve');
const log = require('../lib/log').log;

const USAGE = 'exec [--timeout <秒>] [--json] <实例> <命令...>   或   exec <实例> -f <脚本>';

async function run(argv) {
  const args = parse(argv, {
    flags: ['json', 'quiet'],
    values: ['timeout', 'file'],
    aliases: { f: 'file', t: 'timeout' },
    stopAfter: 1,
  });
  const [ref] = need(args, 1, USAGE);

  const rest = args._.slice(1);
  // 兼容老写法 `exec <实例> -f 脚本.sh`：只有"命令"恰好是 -f/--file + 一个路径时才当文件读，
  // 免得把 `ls -f` 这种真的想跑的东西误判。
  const legacyFile = rest.length === 2 && (rest[0] === '-f' || rest[0] === '--file');
  let cmd;
  if (args.opts.file) cmd = fs.readFileSync(args.opts.file, 'utf8');
  else if (legacyFile) cmd = fs.readFileSync(rest[1], 'utf8');
  else cmd = rest.join(' ');
  if (!cmd) throw new Error('用法: wbsbx ' + USAGE);

  const timeout = num(args.opts.timeout, 60);

  const inst = await resolve.resolve(ref);
  const s = await cloud.getSession(inst.id, log);
  const r = await e2b.exec(s, cmd, { timeout });

  if (args.opts.json) {
    console.log(JSON.stringify(r));
  } else {
    if (r.out) process.stdout.write(r.out);
    if (r.err) process.stderr.write(ui.c.dim(r.err));
    if (!args.opts.quiet) {
      console.log(ui.c.dim(`[exit=${r.code === null ? '?' : r.code}]`));
    }
  }
  return r.code === 0 || r.code === null ? 0 : 1;
}

module.exports = {
  run,
  usage: USAGE,
  stopAfter: 1,          // 第一个位置参数（实例）之后的一切都属于命令
  help: [
    '选项:',
    '  --timeout <秒>   单次执行超时，默认 60',
    '  -f, --file <路径>  执行本地脚本文件的内容（等价于把文件内容当命令发过去）',
    '  --json           输出原始结果 {out,err,code}',
    '  --quiet          不打印 [exit=N] 那行',
    '',
    '说明:',
    '  选项必须写在实例前面 —— 实例之后的内容全部当作命令串，所以不用加引号。',
    '  走 E2B 数据面，不经过 Agent，也不会写进对话历史。',
    '',
    '退出码:',
    '  0   远端命令返回 0（或拿不到退出码，见下）',
    '  1   远端命令返回非 0',
    '  拿不到退出码按 0 处理：上行 end 帧是 proto3 JSON，成功时 exitCode 字段被省略。',
  ],
};
