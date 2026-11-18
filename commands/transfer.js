// cowbird put / get —— 和实例之间搬文件（同样不经过 Agent）
//
// 通道按**能力**选，不按"有没有声明 FS"猜：
//   1. exec.put/get       字节级（base64 分块 / 二进制帧），往返无损 —— 首选
//   2. fs.binary          驱动声明 fs.write 吃 {encoding:'base64'} —— 也无损
//   3. fs（纯文本）        只能写文本；二进制直接**拒绝**，绝不悄悄按 utf8 写坏
const fs = require('fs');
const path = require('path');
const { need, num } = require('../lib/args');
const ui = require('../lib/ui');
const { CAP } = require('../lib/platform/contract');
const { capabilityError } = require('../lib/platform/caps');
const { pickTarget } = require('../lib/platform/target');
const { defineCommand } = require('../lib/command');
const log = require('../lib/log').log;

/** 一次写出 / 一次读回能不能走 fs 通道，走哪种 */
function pickChannel(p) {
  if (p.has(CAP.EXEC) && p.exec
    && typeof p.exec.put === 'function' && typeof p.exec.get === 'function') return 'exec';
  const canFs = p.has(CAP.FS) && p.fs
    && typeof p.fs.write === 'function' && typeof p.fs.read === 'function';
  if (canFs) return p.has(CAP.FS_BINARY) ? 'fs-bin' : 'fs-text';
  throw capabilityError(
    `本平台 ${p.displayName} 没有可用的文件通道（exec.put/get 与 fs.write/read 都没有）`,
    { capability: CAP.FS },
  );
}

/** 这段字节是不是合法 UTF-8（决定 fs 文本通道能不能无损写） */
function isUtf8(buf) {
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

const put = defineCommand({
  usage: 'put [--timeout <秒>] [--json] <实例> <本地文件> <沙箱路径>',
  options: [
    { flag: 'timeout', arg: '<秒>', desc: '超时，默认 120' },
    { flag: 'json', desc: '输出 JSON' },
  ],
  notes: [
    '通道自动选：exec.put（字节级）> fs.binary（base64）> fs 文本。',
    '平台只有文本 fs 通道时，上传二进制会被**拒绝**而不是写坏。',
    '走 shell 的平台分块大小由驱动决定（注意 argv 上限）。',
    '中途失败可能留下半个文件（不续传），重跑即可。',
  ],
  exits: [[0, '成功'], [1, '失败（含字节数校验不符）'], [2, '平台没有文件通道']],
  run: async (args) => {
    const [ref, local, remote] = need(args, 3, 'put <实例> <本地文件> <沙箱内路径>');
    if (!fs.existsSync(local)) throw new Error('本地文件不存在：' + local);

    const { inst, ctx } = await pickTarget(ref, { log });
    const p = ctx.provider;
    const how = pickChannel(p);
    const buf = fs.readFileSync(local);            // 不传 encoding：二进制必须是二进制
    const timeoutMs = num(args.opts.timeout, 120) * 1000;

    const t0 = Date.now();
    let r;
    if (how === 'exec') {
      r = await p.exec.put(ctx, inst.id, { localPath: local, remotePath: remote, timeoutMs });
    } else if (how === 'fs-bin') {
      r = await p.fs.write(ctx, inst.id, { path: remote, content: buf.toString('base64'), encoding: 'base64' });
    } else {
      if (!isUtf8(buf)) {
        throw new Error(
          `本平台 ${p.displayName} 的 fs 通道只能写文本（写二进制会损坏文件）。\n` +
          `  可选：cowbird exec ${ref} "base64 -d > ${remote}" < 本地 base64，或让驱动支持 exec.put / fs.binary。`,
        );
      }
      r = await p.fs.write(ctx, inst.id, { path: remote, content: buf.toString('utf8') });
    }
    // 字节数对不上就是没写对 —— 静默"成功"比报错更坏
    if (r && r.size != null && Number(r.size) !== buf.length) {
      throw new Error(`上传字节数不符：远端 ${r.size} / 本地 ${buf.length}（${remote}）`);
    }
    const ms = Date.now() - t0;
    const size = (r && r.size) || buf.length;
    if (args.opts.json) {
      console.log(JSON.stringify({ ok: true, id: inst.id, local, remote, size, via: how, ms }));
    } else {
      console.log(ui.c.green('OK') + ` ${local} → ${remote}（${ui.bytes(size)}，${ms}ms，${how}）`);
    }
    return 0;
  },
});

const get = defineCommand({
  usage: 'get [--timeout <秒>] [--json] <实例> <沙箱路径> [本地路径]',
  options: [
    { flag: 'timeout', arg: '<秒>', desc: '超时，默认 120' },
    { flag: 'json', desc: '输出 JSON' },
  ],
  notes: [
    '不传本地路径时用远端文件名，落在当前目录。',
    '大文件不建议走 exec 通道（结果会整个进内存）；优先平台的 fs 通道。',
  ],
  exits: [[0, '成功'], [1, '失败'], [2, '平台没有文件通道']],
  run: async (args) => {
    const [ref, remote] = need(args, 2, 'get <实例> <沙箱内路径> [本地路径]');
    const local = args._[2] || path.basename(remote);

    const { inst, ctx } = await pickTarget(ref, { log });
    const p = ctx.provider;
    const how = pickChannel(p);
    const timeoutMs = num(args.opts.timeout, 120) * 1000;

    fs.mkdirSync(path.dirname(path.resolve(local)), { recursive: true });
    if (how === 'exec') {
      const r = await p.exec.get(ctx, inst.id, { remotePath: remote, localPath: local, timeoutMs });
      if (args.opts.json) console.log(JSON.stringify({ ok: true, id: inst.id, remote, local, size: r && r.size, via: how }));
      else console.log(ui.c.green('OK') + ` ${remote} → ${local}（${ui.bytes(r && r.size ? r.size : 0)}，exec）`);
      return 0;
    }

    const r = await p.fs.read(ctx, inst.id, { path: remote });
    // 驱动用 base64 交回二进制（workbuddy 就是这么做的），别把它当文本落盘
    const buf = r && r.encoding === 'base64'
      ? Buffer.from(String(r.content || ''), 'base64')
      : Buffer.from(String((r && r.content) || ''), 'utf8');
    fs.writeFileSync(local, buf);
    if (args.opts.json) console.log(JSON.stringify({ ok: true, id: inst.id, remote, local, size: buf.length, via: how }));
    else console.log(ui.c.green('OK') + ` ${remote} → ${local}（${ui.bytes(buf.length)}，${how}）`);
    return 0;
  },
});

module.exports = [put, get];
