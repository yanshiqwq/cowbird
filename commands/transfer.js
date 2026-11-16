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
  {
    run: putRun,
    usage: 'put [--timeout <秒>] <实例> <本地文件> <沙箱路径>',
    help: [
      '说明:',
      '  分块走 exec 通道（base64 追加），不需要额外端口；传完用 stat 核对大小。',
      '  单块 60KB —— 整条命令是作为一个 argv 传给 /bin/sh 的，Linux 的 MAX_ARG_STRLEN',
      '  只有 128KB，块再大就会 "argument list too long"。',
      '  中途失败会留下半个文件（不续传），重跑即可。',
    ],
  },
  {
    run: getRun,
    usage: 'get [--timeout <秒>] <实例> <沙箱路径> [本地路径]',
    help: [
      '说明:',
      '  走 base64 over exec，不适合几百 MB 的大文件（结果会整个进内存）。',
      '  不传本地路径时用远端文件名，落在当前目录。',
    ],
  },
];
