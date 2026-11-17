// cowbird put / get —— 和实例之间搬文件（同样不经过 Agent）
//
// 两条通道二选一：平台有独立文件通道（fs）就优先用它，否则退回 exec 通道
// （各平台实现不同：E2B base64 分块 / MCP file_write / shell base64）。
const fs = require('fs');
const path = require('path');
const { parse, need, num } = require('../lib/args');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const { CAP } = require('../lib/platform/contract');
const { resolveInstance } = require('../lib/platform/target');
const log = require('../lib/log').log;

function needFileChannel(p) {
  // 优先走 exec.put/get：那是字节级的（base64 / 二进制帧），往返无损。
  // fs 通道有的平台是"给人看的文本接口"（例如 Qoder 的 file_read 带行号、还吃掉行尾换行），
  // 拿它当传输会把文件搞坏，所以只作兜底。
  if (p.has(CAP.EXEC) && p.exec && typeof p.exec.put === 'function' && typeof p.exec.get === 'function') return 'exec';
  if (p.has(CAP.FS)) return 'fs';
  throw new Error(`本平台（${p.displayName}）没有文件通道（既没有 exec.put/get 也没有 fs）`);
}

async function putRun(argv) {
  const args = parse(argv, { values: ['timeout'] });
  const [ref, local, remote] = need(args, 3, 'put <实例> <本地文件> <沙箱内路径>');
  if (!fs.existsSync(local)) throw new Error('本地文件不存在：' + local);

  const p = registry.get();
  const how = needFileChannel(p);
  const ctx = registry.context(p);
  ctx.log = (m) => log(m);
  const inst = await resolveInstance(ctx, ref);

  const t0 = Date.now();
  const r = how === 'fs'
    ? await p.fs.write(ctx, inst.id, { path: remote, content: fs.readFileSync(local, 'utf8') })
    : await p.exec.put(ctx, inst.id, { localPath: local, remotePath: remote, timeoutMs: num(args.opts.timeout, 120) * 1000 });
  const ms = Date.now() - t0;
  console.log(ui.c.green('OK') + ` ${local} → ${remote}（${ui.bytes(r && r.size ? r.size : 0)}，${ms}ms，${how}）`);
  return 0;
}

async function getRun(argv) {
  const args = parse(argv, { values: ['timeout'] });
  const [ref, remote] = need(args, 2, 'get <实例> <沙箱内路径> [本地路径]');
  const local = args._[2] || path.basename(remote);

  const p = registry.get();
  const how = needFileChannel(p);
  const ctx = registry.context(p);
  ctx.log = (m) => log(m);
  const inst = await resolveInstance(ctx, ref);

  if (how === 'fs') {
    const r = await p.fs.read(ctx, inst.id, { path: remote });
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, r.content);
    console.log(ui.c.green('OK') + ` ${remote} → ${local}（${ui.bytes(Buffer.byteLength(r.content))}，fs）`);
    return 0;
  }
  const r = await p.exec.get(ctx, inst.id, { remotePath: remote, localPath: local, timeoutMs: num(args.opts.timeout, 120) * 1000 });
  console.log(ui.c.green('OK') + ` ${remote} → ${local}（${ui.bytes(r && r.size ? r.size : 0)}，exec）`);
  return 0;
}

module.exports = [
  {
    run: putRun,
    usage: 'put [--timeout <秒>] <实例> <本地文件> <沙箱路径>',
    help: [
      '说明:',
      '  平台有独立文件通道（fs）就直接写；否则走 exec 通道（base64 分块 / MCP file_write）。',
      '  分块大小由驱动决定 —— 走 shell 的平台要注意 argv 上限（约 128KB）。',
      '  中途失败可能留下半个文件（不续传），重跑即可。',
    ],
  },
  {
    run: getRun,
    usage: 'get [--timeout <秒>] <实例> <沙箱路径> [本地路径]',
    help: [
      '说明:',
      '  不传本地路径时用远端文件名，落在当前目录。',
      '  大文件不建议走 exec 通道（结果会整个进内存）；优先用平台的 fs 通道。',
    ],
  },
];
