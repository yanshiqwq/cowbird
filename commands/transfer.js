// wbsbx put / get —— 和实例之间搬文件（同样不经过 Agent）
const fs = require('fs');
const path = require('path');
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const e2b = require('../lib/e2b');
const resolve = require('../lib/resolve');
const log = require('../lib/log').log;

async function putRun(argv) {
  const args = parse(argv, { values: ['timeout'] });
  const [ref, local, remote] = need(args, 3, 'put <实例> <本地文件> <沙箱内路径>');
  if (!fs.existsSync(local)) throw new Error('本地文件不存在：' + local);
  const inst = await resolve.resolve(ref);
  const s = await cloud.getSession(inst.id, log);
  const r = await e2b.put(s, local, remote, { timeout: num(args.opts.timeout, 120) });
  console.log(ui.c.green('OK') + ` ${local} → ${remote}（${ui.bytes(r.size)}，${r.chunks} 块）`);
  return 0;
}

async function getRun(argv) {
  const args = parse(argv, { values: ['timeout'] });
  const [ref, remote] = need(args, 2, 'get <实例> <沙箱内路径> [本地路径]');
  const local = args._[2] || path.basename(remote);
  const inst = await resolve.resolve(ref);
  const s = await cloud.getSession(inst.id, log);
  const r = await e2b.get(s, remote, local, { timeout: num(args.opts.timeout, 120) });
  console.log(ui.c.green('OK') + ` ${remote} → ${local}（${ui.bytes(r.size)}）`);
  return 0;
}

module.exports = [
  { run: putRun, usage: 'put <实例> <本地文件> <沙箱内路径>' },
  { run: getRun, usage: 'get <实例> <沙箱内路径> [本地路径]' },
];
