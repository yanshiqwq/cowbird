// daemon 的运行日志：内存环形缓冲（给 /api/logs）+ 落盘（给事后翻）。
//
// 刻意不引日志库：这里只有一台机器、一个进程、几百行/天的量。
// 文件按 8MB 轮转一次，保留一个 .1，防止长期跑把盘吃满。
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const MAX_MEM = 1000;
const MAX_FILE = 8 * 1024 * 1024;

class LogStore {
  constructor(file) {
    this.file = file || path.join(cfg.PATHS.logs, 'daemon.log');
    this.buf = [];
    this.size = 0;
  }

  _ensure() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); } catch {}
  }

  _rotate() {
    try {
      const st = fs.statSync(this.file);
      if (st.size < MAX_FILE) return;
      const old = this.file + '.1';
      try { fs.unlinkSync(old); } catch {}
      fs.renameSync(this.file, old);
    } catch {}
  }

  push(scope, msg, extra) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${scope}] ${redact(msg)}` + (extra ? ' ' + safeJson(extra) : '');
    this.buf.push(line);
    if (this.buf.length > MAX_MEM) this.buf.shift();

    this._ensure();
    this._rotate();
    try {
      // mode 只对"新建"生效：日志里可能有远端脚本的 stderr，不该是 0644
      fs.appendFileSync(this.file, line + '\n', { mode: 0o600 });
    } catch (e) {
      // 日志是排障的唯一依据：写不进去必须喊一声，但别把主流程带崩
      if (!this._warned) {
        this._warned = true;
        process.stderr.write(`[cowbird] 日志写不进去（${this.file}）：${e.message}\n`);
      }
    }
    return line;
  }

  // 生成一个绑定 scope 的短函数，调用处更好读
  scoped(scope) {
    return (msg, extra) => this.push(scope, msg, extra);
  }

  tail(n = 100) { return this.buf.slice(-n); }
}

function safeJson(o) {
  try {
    const s = JSON.stringify(o);
    return s && s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch { return '[unserializable]'; }
}

/** 把明显的凭据形状打码（日志会进文件、也会经 /api/logs 出去） */
function redact(s) {
  return String(s).replace(/((?:token|authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*)([^\s,;"']{4,})/gi, '$1***');
}

module.exports = { LogStore };
