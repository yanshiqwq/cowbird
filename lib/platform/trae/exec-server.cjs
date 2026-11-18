#!/usr/bin/env node
// cowbird 的沙箱内执行端（给用户自己的 CLI 用）。
//
// 它就是一个普通的 stdio MCP server，只提供一个工具 `sh`：收到命令 → 在**本沙箱内**
// 用 bash 跑 → 把 stdout / stderr / 退出码回给调用方。没有跨沙箱、跨账号的访问。
//
// 为什么要它：TRAE 网页端没有给 CLI 用的执行接口。想让 `cowbird exec` 跑命令，
// 要么每条命令请 agent 代跑一轮（10–25 秒、费一轮额度），要么在沙箱里挂这个执行端
// 直接调（0.3–1.2 秒）。用户是这台沙箱和这个账号的主人，选了后者。
//
// 谁拉起它：沙箱里的 agent-tool-host。cowbird 把它登记进某个插件的 `.mcp.json`，
// toolhost 在 TurnStart 合并插件 MCP 配置时把它作为插件服务器启动。
// 之后 cowbird 从 preview 网关的 9003 端口 `tools/call`。
//
// 两个实现细节（踩过）：
//   1. 用**非登录** shell。Ubuntu 的 /bin/sh 是 dash，而 /etc/profile 里的 mise 钩子带
//      bash 语法，`sh -lc` 会在 profile 阶段语法错误退出，命令根本轮不到执行。
//   2. stdin 关闭时要等还在跑的 tools/call 收尾，否则管道用法会丢输出。
const { spawn } = require('node:child_process');

const SEND = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch { /* stdout 关了 */ } };

const TOOLS = [{
  name: 'sh',
  description: 'Run a shell command inside this sandbox and return stdout/stderr/exit code.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      cmd: { type: 'string', description: 'Shell command (runs via bash -c).' },
      cwd: { type: 'string', description: 'Working directory, default /workspace.' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, default: 60000 },
    },
    required: ['cmd'],
  },
}];

function run(cmd, a) {
  const fs = require('node:fs');
  const pick = (p) => { try { return p && fs.statSync(p).isDirectory() ? p : null; } catch { return null; } };
  const cwd = pick(a.cwd) || pick('/workspace') || process.cwd();
  const sh = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(sh, ['-c', cmd], { cwd, env: process.env });
    } catch (e) {
      return resolve({ code: -1, out: '', err: 'spawn failed: ' + e.message });
    }
    let out = '', err = '', done = false;
    // 截断只做一次、也只标一次（早先每个 data 事件都会再拼一个 [truncated]）
    let outCut = false; let errCut = false;
    const MAX_OUT = 3e6; const MAX_ERR = 3e5;
    const fin = (code, sig) => { if (done) return; done = true; clearTimeout(t); resolve({ code, sig, out, err }); };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} fin(-2, 'timeout'); }, Number(a.timeout_ms) || 60000);
    p.stdout.on('data', (d) => {
      if (outCut) return;
      out += d.toString('utf8');
      if (out.length > MAX_OUT) { out = out.slice(0, MAX_OUT) + '\n[truncated]'; outCut = true; }
    });
    p.stderr.on('data', (d) => {
      if (errCut) return;
      err += d.toString('utf8');
      if (err.length > MAX_ERR) { err = err.slice(0, MAX_ERR) + '\n[truncated]'; errCut = true; }
    });
    p.on('error', (e) => { err += '\n' + e.message; fin(-1, null); });
    p.on('close', (code, sig) => fin(code, sig));
  });
}

async function handle(m) {
  const id = m && m.id;
  const method = m && m.method;
  const params = (m && m.params) || {};
  if (typeof method === 'string' && method.indexOf('notifications/') === 0) return;
  if (method === 'initialize') {
    return SEND({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cowbird-exec', version: '0.1.0' } } });
  }
  if (method === 'tools/list') return SEND({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    if (params.name !== 'sh') return SEND({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + String(params.name) } });
    const a = params.arguments || {};
    const r = await run(String(a.cmd == null ? '' : a.cmd), a);
    const text = 'exit=' + r.code + (r.sig ? ' signal=' + r.sig : '') + '\n--- stdout ---\n' + r.out + '\n--- stderr ---\n' + r.err;
    return SEND({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: r.code !== 0 } });
  }
  if (method === 'ping') return SEND({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined && id !== null) SEND({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method: ' + String(method) } });
}

let buf = '';
let pending = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch { continue; }
    const list = Array.isArray(msg) ? msg : [msg];
    for (const m of list) {
      pending++;
      handle(m).catch(() => {}).finally(() => { pending--; });
    }
  }
});
process.stdin.on('end', () => {
  // 输入结束时别把还没跑完的 tools/call 一起杀掉
  let guard = 0;
  const wait = () => {
    if (pending === 0 || guard++ > 1200) process.exit(0);
    else setTimeout(wait, 50);
  };
  wait();
});
