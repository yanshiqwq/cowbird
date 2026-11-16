// E2B 数据面：绕过 Agent 直接在沙箱里跑命令 / 收发文件
// 协议：POST <e2bDataEndpoint>/<Service>/<Method>，Content-Type: application/connect+json
// 报文是「5 字节头 + JSON」的帧序列：头 [flag][uint32BE 长度]，flag=0 为数据帧。
// 正因为不经过 Agent，装包、写 authkey、改配置都不会进对话轨迹。
const fs = require('fs');
const path = require('path');

function endpoint(creds, svc) {
  const base = (creds.e2bDataEndpoint || '').replace(/\/$/, '');
  if (!base) throw new Error('凭据里没有 e2bDataEndpoint，拿不到执行通道');
  return base + '/' + svc;
}

function headers(creds) {
  return {
    'Content-Type': 'application/connect+json',
    'Connect-Protocol-Version': '1',
    'X-Access-Token': creds.token,
  };
}

// 解析响应里的帧，拼出 stdout/stderr/exitCode
function parseExecFrames(buf) {
  let off = 0; let out = ''; let err = ''; let code = null;
  while (off + 5 <= buf.length) {
    const len = buf.readUInt32BE(off + 1);
    const msg = buf.slice(off + 5, off + 5 + len).toString('utf8');
    off += 5 + len;
    if (!msg) continue;
    let j;
    try { j = JSON.parse(msg); } catch { continue; }
    if (j.event && j.event.data) {
      const d = j.event.data;
      if (d.stdout) out += Buffer.from(d.stdout, 'base64').toString('utf8');
      if (d.stderr) err += Buffer.from(d.stderr, 'base64').toString('utf8');
    }
    // 🚨 proto3 JSON 会省略默认值：命令成功时 end 帧里根本没有 exitCode 字段，
    //    硬读 j.event.end.exitCode 会拿到 undefined（旧脚本就一直打印 exit=undefined）。
    //    见到 end 帧而没写 exitCode，就是 0。
    if (j.event && j.event.end) {
      code = j.event.end.exitCode === undefined ? 0 : j.event.end.exitCode;
    }
    if (j.error) err += JSON.stringify(j.error);
  }
  return { out, err, code };
}

// 跑一条 shell 命令。cwd 固定 /workspace（Agent 的工作目录）
async function exec(creds, cmd, { timeout = 60, cwd = '/workspace', envs = {} } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = 60;
  const payload = Buffer.from(JSON.stringify({ process: { cmd: '/bin/sh', args: ['-lc', cmd], envs, cwd } }));
  const hdr = Buffer.alloc(5);
  hdr[0] = 0;
  hdr.writeUInt32BE(payload.length, 1);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout * 1000);
  try {
    const r = await fetch(endpoint(creds, 'process.Process/Start'), {
      method: 'POST',
      headers: headers(creds),
      body: Buffer.concat([hdr, payload]),
      signal: ac.signal,
    });
    if (r.status !== 200) throw new Error(`exec http=${r.status} ${(await r.text()).slice(0, 200)}`);
    return parseExecFrames(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`exec 超时（${timeout}s）`);
    throw e;
  } finally { clearTimeout(timer); }
}

// 单引号转义，塞进 shell 用
const shq = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

// 写文件到沙箱。
// ⚠ 不用 /filesystem.Filesystem/Write：这套 runtime 上该路由没注册（404 page not found，
//   2026-11-11 实测），旧脚本"成功"其实是没校验返回。改成 exec 分块 base64 追加，
//   与执行通道同一条路，跨 runtime 都通。
// 🚨 单块别贪大：整条命令是作为 **一个 argv 字符串** 传给 /bin/sh 的，Linux 的
//   MAX_ARG_STRLEN 只有 128KB，256KB 块 base64 后直接 "argument list too long"。
//   60KB 原始 → 约 80KB base64，稳。
async function put(creds, localFile, remotePath, { chunk = 60 * 1024, timeout = 120 } = {}) {
  const buf = fs.readFileSync(localFile);
  const dir = path.posix.dirname(remotePath);
  const r0 = await exec(creds, `mkdir -p ${shq(dir)} && : > ${shq(remotePath)}`, { timeout: 30 });
  if (r0.code !== 0) throw new Error('准备远端文件失败：' + String(r0.err || r0.code).slice(0, 200));

  let chunks = 0;
  for (let off = 0; off < buf.length; off += chunk) {
    const b64 = buf.slice(off, off + chunk).toString('base64');
    const r = await exec(creds, `printf %s '${b64}' | base64 -d >> ${shq(remotePath)}`, { timeout: Math.max(60, timeout) });
    if (r.code !== 0) throw new Error(`写第 ${chunks + 1} 块失败（offset ${off}）：` + String(r.err || r.code).slice(0, 200));
    chunks++;
  }
  const chk = await exec(creds, `stat -c %s ${shq(remotePath)}`, { timeout: 30 });
  const remote = Number(chk.out.trim());
  if (remote !== buf.length) throw new Error(`大小不符：本地 ${buf.length} / 远端 ${remote}`);
  return { size: buf.length, chunks };
}

// 取文件回本地：走 base64 over exec，比读 Filesystem/Read 的流式帧简单且不易错
async function get(creds, remotePath, localFile, { timeout = 120 } = {}) {
  const r = await exec(creds, `base64 -w0 ${shq(remotePath)}`, { timeout });
  if (r.code !== 0) throw new Error('读取失败：' + (r.err || `exit=${r.code}`).slice(0, 200));
  if (!r.out.trim()) throw new Error('远端文件为空或不存在');
  const buf = Buffer.from(r.out.replace(/\s+/g, ''), 'base64');
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, buf);
  return { size: buf.length };
}

module.exports = { exec, put, get };
