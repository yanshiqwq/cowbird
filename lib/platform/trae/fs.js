// 沙箱里的文件：读 / 列 / 写。
//
// 数据面两条通道（实测 2026-11-18）：
//   读文件  GET ${explorerUrl}/file/<相对路径>          （sessionFs.readFileStream）
//   写文件  PUT ${explorerUrl}/file/<相对路径>          （sessionFs.uploadFile）
//   列目录  WS  fs.readdir {reqId, path}                （没有 HTTP 版本，只能走 WS）
//
// ⚠ 三个必须记住的限制：
//   1. 路径是**工作区相对路径**（git 树的路径），`/etc/hostname` 这种绝对路径读不到；
//   2. 会话离线（`x-explorer-mode: offline`）时，数据面读的是 **restic 备份的 git 快照**，
//      也就是说你看到的是"会话最后一次提交"的状态，不是沙箱当前状态；
//   3. 目录列举只有 WS 一条路，需要 Node ≥ 22（内置 WebSocket）。
const { fileEntry } = require('../contract');
const transport = require('./http');
const ws = require('./ws');

/** 把工作区路径规整成数据面要的样子：去掉开头的 /，逐段 encode */
function encodePath(p) {
  const clean = String(p || '.')
    .replace(/^\/workspace\/?/, '')          // 容忍用户按沙箱绝对路径写
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  // 越界保护：`..` 会拼出 /file/../../etc/... 这种 URL，别把"能不能穿出工作区"交给网关判断
  if (clean.split('/').some((seg) => seg === '..')) {
    throw new Error(`路径里不允许出现 ..：${p}`);
  }
  return clean;
}
function encodeUrlPath(p) {
  return encodePath(p).split('/').map((s) => encodeURIComponent(s)).join('/');
}

async function explorerOf(ctx, id) {
  const t = transport.createTransport(ctx);
  const j = await t.request('GET', `/api/remote/v1/chat_sessions/${encodeURIComponent(id)}`);
  const s = (j && j.data) || {};
  if (!s.explorer_url) {
    throw new Error(`会话 ${id} 没有 explorer_url（沙箱还没分配？）：先 cowbird info ${id} 看一眼`);
  }
  return { t, explorerUrl: s.explorer_url, workspacePath: s.workspace_path || '/workspace' };
}

/** 列目录 → FileEntry[] */
async function list(ctx, id, { path = '.', reqId = 'cowbird' } = {}) {
  const { t, explorerUrl } = await explorerOf(ctx, id);
  const jwt = await t.cloudideToken();
  const rel = encodePath(path);
  const result = await ws.rpc({
    explorerUrl,
    jwt,
    method: 'fs.readdir',
    params: { reqId, path: rel === '' ? '.' : rel },
  });
  const arr = Array.isArray(result) ? result : (result && (result.entries || result.files)) || [];
  return arr.map((x) => {
    if (typeof x === 'string') return fileEntry({ path: join(rel, x), name: x, type: 'file' });
    const name = x.name || x.path || '';
    const isDir = x.isDir === true || x.is_dir === true || x.type === 'dir' || x.type === 'directory';
    return fileEntry({
      path: join(rel, name),
      name,
      type: isDir ? 'dir' : 'file',
      size: Number.isFinite(Number(x.size)) ? Number(x.size) : null,
      mtime: x.mtime ? new Date(x.mtime).toISOString() : null,
    });
  });
  function join(base, name) {
    if (!base || base === '.') return name;
    return base.replace(/\/+$/, '') + '/' + name;
  }
}

/** 读文件 → { path, content }（二进制会被当 utf8 读，本项目按文本处理） */
async function read(ctx, id, { path } = {}) {
  if (!path) throw new Error('read 需要 path（工作区相对路径，例如 README.md）');
  const { t, explorerUrl } = await explorerOf(ctx, id);
  const rel = encodePath(path);
  const r = await t.dataRequest(explorerUrl, 'GET', `/file/${encodeUrlPath(rel)}`);
  if (!r.ok) {
    let hint = '';
    if (r.status === 404) hint = `（数据面只认工作区相对路径；绝对路径读不到。会话离线时读到的是最后一次提交的快照）`;
    throw new Error(`读 ${rel} 失败：http=${r.status} ${String(r.text || '').slice(0, 160)}${hint}`);
  }
  return { path: rel, content: r.text };
}

/**
 * 写文件（PUT sessionFs.uploadFile）。
 *
 * ⚠ 2026-11-18 实测纠正：body 就是**文件内容本身**（raw 文本），不是 `{content:...}`。
 * 之前按 `{content}` 发，沙箱里落盘的是整个 JSON —— 也就是文件第一行成了
 * `{"content":"set -e\n..."}`，`bash` 跑起来直接语法错误（沙箱里的 agent 就是这么报的）。
 */
async function write(ctx, id, { path, content, encoding = 'utf8' } = {}) {
  if (!path) throw new Error('write 需要 path');
  const { t, explorerUrl } = await explorerOf(ctx, id);
  const rel = encodePath(path);
  // encoding=base64 时按二进制发（声明了 fs.binary）：body 直接是字节，不再套 JSON
  const buf = encoding === 'base64'
    ? Buffer.from(String(content === undefined ? '' : content), 'base64')
    : Buffer.from(String(content === undefined ? '' : content), 'utf8');
  const r = await t.dataRequest(explorerUrl, 'PUT', `/file/${encodeUrlPath(rel)}`, { body: buf, raw: true, timeoutMs: 60000 });
  if (!r.ok) throw new Error(`写 ${rel} 失败：http=${r.status} ${String(r.text || '').slice(0, 200)}`);
  return { path: rel, size: buf.length };
}

module.exports = { list, read, write, encodePath, encodeUrlPath, explorerOf };
