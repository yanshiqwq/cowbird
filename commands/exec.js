// wbsbx exec —— 在实例里直接跑命令（走 E2B，不经过 Agent、不进对话轨迹）
const fs = require('fs');
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const e2b = require('../lib/e2b');
const resolve = require('../lib/resolve');
const log = require('../lib/log').log;

async function run(argv) {
  const args = parse(argv, {
    flags: ['json', 'quiet'],
    values: ['timeout', 'file'],
    aliases: { f: 'file', t: 'timeout' },
  });
  const [ref] = need(args, 1, 'exec <实例> "<命令>" [--timeout 60] | exec <实例> -f 脚本.sh');

  let cmd = args.opts.file ? fs.readFileSync(args.opts.file, 'utf8') : args._[1];
  if (!cmd) throw new Error('用法: wbsbx exec <实例> "<命令>" [--timeout 60]');
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

module.exports = { run, usage: 'exec <实例> "<命令>" [-f 脚本] [--timeout 秒] [--json]' };
