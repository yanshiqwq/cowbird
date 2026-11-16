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

const USAGE = 'exec [--timeout 秒] [--json] <实例> <命令...>   或   exec <实例> -f 脚本.sh';

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

module.exports = { run, usage: USAGE };
