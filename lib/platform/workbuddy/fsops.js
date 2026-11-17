'use strict';
// 文件通道：WorkBuddy 没有独立的 Filesystem 路由可依赖，所以全部落在 exec 通道上。
//
// 为什么不用 `/filesystem.Filesystem/*`：那套路由在这批 runtime 上没注册（lib/e2b.js 里记着
// 「404 page not found，旧脚本的『成功』其实是没校验返回」）。所以：
//   list  → find -printf（一次往返拿类型/大小/mtime）
//   read  → stat 拿大小 + base64（二进制安全，也能区分空文件与不存在）
//   write → 写本地临时文件再交给 e2b.put（分块 base64 + 大小校验都是现成的）
const { fileEntry } = require('../contract');
const { shq } = require('./util');
const exec = require('./exec');

const WORKSPACE = '/workspace';
const MAX_READ_BYTES = 1 << 20;      // 与 limits.maxOutputBytes 对齐：base64 后还要再涨 1/3

const posix = {
  join: (a, b) => (String(a).replace(/\/+$/, '') + '/' + String(b).replace(/^\/+/, '')),
};

/** find 的 '类型\t大小\tmtime\t名字' → FileEntry；顺带认出 ERR/CNT 两种控制行 */
function parseFindOutput(text, baseDir) {
  const entries = [];
  let count = null;
  let error = null;
  for (const line of String(text === undefined || text === null ? '' : text).split('\n')) {
    if (!line) continue;
    if (line.startsWith('ERR\t')) { error = line.slice(4).trim() || '路径不可用'; continue; }
    if (line.startsWith('CNT\t')) { const n = Number(line.slice(4)); count = Number.isFinite(n) ? n : null; continue; }
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const [typeChar, sizeText, mtimeText] = parts;
    const name = parts.slice(3).join('\t');
    if (!name) continue;
    const size = Number(sizeText);
    const mtimeSec = Number(mtimeText);
    entries.push({
      path: posix.join(baseDir, name),
      name,
      type: typeChar === 'd' ? 'dir' : typeChar === 'l' ? 'link' : 'file',
      size: typeChar === 'd' || !Number.isFinite(size) ? null : size,
      mtime: Number.isFinite(mtimeSec) ? new Date(Math.round(mtimeSec * 1000)).toISOString() : null,
    });
  }
  return { entries, count, error };
}

/** 解析 read 脚本的输出：第一行大小，其余是 base64 */
function parseReadOutput(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  const nl = raw.indexOf('\n');
  const head = nl >= 0 ? raw.slice(0, nl) : raw;
  const body = nl >= 0 ? raw.slice(nl + 1) : '';
  const m = head.match(/__WBSBX_SIZE__=(-?\d+)/);
  const size = m ? Number(m[1]) : null;
  return { size, b64: body.replace(/\s+/g, '') };
}

async function list(ctx, id, opts = {}) {
  const target = String(opts.path || opts.dir || WORKSPACE);
  const script = [
    `if [ ! -d ${shq(target)} ]; then printf 'ERR\\t路径不存在或不是目录\\n'; exit 0; fi`,
    `find ${shq(target)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null`,
    // 计数用来兜「find 不支持 -printf」的镜像：那时输出为空但目录里其实有东西
    `printf 'CNT\\t%s\\n' "$(ls -A ${shq(target)} 2>/dev/null | wc -l)"`,
  ].join('\n');

  const r = await exec.runShell(ctx, id, script, { timeoutMs: 30000 });
  const parsed = parseFindOutput(r.out, target);
  if (parsed.error) throw new Error(`${target}：${parsed.error}`);

  if (!parsed.entries.length && parsed.count) {
    // 退化路径：只给名字（类型/大小未知），但至少不撒谎说目录是空的
    const ls = await exec.runShell(ctx, id, `ls -A ${shq(target)} 2>/dev/null`, { timeoutMs: 30000 });
    return ls.out.split('\n').filter((x) => x).map((name) => fileEntry({
      path: posix.join(target, name), name, type: 'file',
    }));
  }
  return parsed.entries.map((e) => fileEntry(e));
}

async function read(ctx, id, opts = {}) {
  const target = String(opts.path || '');
  if (!target) throw new Error('fs.read 需要 path');
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_READ_BYTES;

  const script = [
    `if [ ! -e ${shq(target)} ]; then printf '__WBSBX_SIZE__=-1\\n'; exit 0; fi`,
    `if [ -d ${shq(target)} ]; then printf '__WBSBX_SIZE__=-2\\n'; exit 0; fi`,
    `printf '__WBSBX_SIZE__=%s\\n' "$(stat -c %s ${shq(target)} 2>/dev/null || echo -3)"`,
    `base64 -w0 ${shq(target)} 2>/dev/null`,
  ].join('\n');

  const r = await exec.runShell(ctx, id, script, { timeoutMs: 60000, maxOutputBytes: maxBytes * 2 });
  const { size, b64 } = parseReadOutput(r.out);
  if (size === -1) throw new Error(`文件不存在：${target}`);
  if (size === -2) throw new Error(`是目录，不是文件：${target}`);
  if (size === -3 || size === null) throw new Error(`读不到文件大小（可能没权限）：${target}`);
  if (size > maxBytes) {
    throw new Error(`文件 ${size} 字节，超过 fs.read 上限 ${maxBytes} 字节；大文件用 exec.get 拉到本地`);
  }

  const buf = Buffer.from(b64, 'base64');
  // utf8 解码能原样回写才是文本；否则按 base64 交出去，别把二进制悄悄变成一堆替换符
  const text = buf.toString('utf8');
  const isText = Buffer.from(text, 'utf8').equals(buf);
  return isText
    ? { path: target, content: text, encoding: 'utf8', size: buf.length }
    : { path: target, content: buf.toString('base64'), encoding: 'base64', size: buf.length };
}

async function write(ctx, id, opts = {}) {
  const target = String(opts.path || '');
  if (!target) throw new Error('fs.write 需要 path');
  const encoding = opts.encoding === 'base64' ? 'base64' : 'utf8';
  const raw = opts.content === undefined || opts.content === null ? '' : String(opts.content);
  const buf = Buffer.from(raw, encoding);

  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const tmp = path.join(os.tmpdir(), `wbsbx-fs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, buf);
  try {
    // 走 exec.put（内部是 e2b.put：分块 base64 + 远端大小校验）
    const r = await exec.put(ctx, id, { localPath: tmp, remotePath: target });
    return { path: target, size: r.size, chunks: r.chunks };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不影响结果 */ }
  }
}

module.exports = { WORKSPACE, MAX_READ_BYTES, parseFindOutput, parseReadOutput, list, read, write };
