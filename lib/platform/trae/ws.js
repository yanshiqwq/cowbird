// 沙箱数据面的 WebSocket（JSON-RPC 2.0）。
//
// 实测（2026-11-18）：
//   wss://agent-sandbox-<cluster>-gw.trae.cn/explorer/<sid>
//   浏览器设置不了请求头，所以前端把 `Authorization: Cloud-IDE-JWT <jwt>` 的空格换成点，
//   塞进子协议：`Sec-WebSocket-Protocol: Cloud-IDE-JWT.<jwt>`，服务端 101 并回显该子协议。
//   服务端**不会主动发首帧**，客户端先说；心跳是 30s 一次的 `system.ping`。
//
// 方法空间只有 `fs.*`（readFileStream/uploadFile/readdir/watch/...）与 `system.ping` ——
// 没有 exec 类方法，这也是"TRAE 网页版没有命令行执行通道"的证据之一。
const TIMEOUT = 12000;

/** https://…/explorer/<sid> → wss://…/explorer/<sid> */
function rpcUrl(explorerUrl) {
  return String(explorerUrl).replace(/^http/, 'ws');
}

/**
 * 发一条 JSON-RPC，等对应 id 的结果。
 * @param {{explorerUrl:string, jwt:string, method:string, params?:object, timeoutMs?:number}} opts
 */
function rpc({ explorerUrl, jwt, method, params = {}, timeoutMs = TIMEOUT }) {
  if (typeof WebSocket !== 'function') {
    // Node 22 起才有全局 WebSocket；低版本直接说清楚，不让人对着 "undefined is not a function" 发呆
    const e = new Error('读取沙箱目录需要 Node ≥ 22（内置 WebSocket）。当前 ' + process.version + '，可改用 `cowbird get` 按路径取具体文件');
    e.code = 'E_UNSUPPORTED';
    return Promise.reject(e);
  }
  const url = rpcUrl(explorerUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, ['Cloud-IDE-JWT.' + jwt]);
    const timer = setTimeout(() => finish(new Error(`沙箱 WS 超时（${method}）`)), timeoutMs);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已关 */ }
      err ? reject(err) : resolve(value);
    };
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (msg.id !== 1) return;                       // 通知类（fs.fileChange）忽略
      if (msg.error) finish(Object.assign(new Error(`沙箱 RPC 失败（${method}）：${msg.error.message || JSON.stringify(msg.error)}`), { code: msg.error.code || 'E_RPC' }));
      else finish(null, msg.result);
    });
    ws.addEventListener('error', () => finish(new Error(`沙箱 WS 连接失败（${url}）`)));
    ws.addEventListener('close', () => finish(new Error(`沙箱 WS 提前关闭（${method}）`)));
  });
}

module.exports = { rpc, rpcUrl };
