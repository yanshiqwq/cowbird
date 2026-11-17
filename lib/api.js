// daemon 的 HTTP 客户端。CLI 侧唯一跟 daemon 打交道的地方。
//
// 刻意保持极薄：只做「发请求、解 JSON、把错误翻成人话」。
// 重试和降级逻辑放在 lib/creds.js（业务决策），这里不掺。
const cfg = require('./config');

class DaemonError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class DaemonClient {
  constructor({ url, token, timeoutMs } = {}) {
    const c = cfg.readConfig().daemon;
    this.url = String(url || c.url).replace(/\/+$/, '');
    this.token = token !== undefined ? token : c.token;
    this.timeoutMs = timeoutMs || c.timeoutMs || 4000;
  }

  async req(method, path, body) {
    const h = { accept: 'application/json' };
    if (this.token) h.authorization = 'Bearer ' + this.token;
    if (body !== undefined) h['content-type'] = 'application/json';
    let r;
    try {
      r = await fetch(this.url + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new DaemonError(`连不上 daemon（${this.url}）：${e.message}`, 0, 'UNREACHABLE');
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!r.ok) {
      const msg = (json && (json.error || json.message)) || text.slice(0, 200) || `http=${r.status}`;
      throw new DaemonError(`daemon ${r.status}：${msg}`, r.status, json && json.code);
    }
    return json;
  }

  async probe() { return this.req('GET', '/health'); }
  async status() { return this.req('GET', '/api/status'); }
  async loginState() { return this.req('GET', '/api/state'); }
  async token(id) { return this.req('GET', '/api/token/' + encodeURIComponent(id)); }
  async heal() { return this.req('POST', '/api/heal', {}); }
  async refresh(ids) { return this.req('POST', '/api/refresh', { ids: ids || null }); }
  async renew() { return this.req('POST', '/api/renew', {}); }
  async warm() { return this.req('POST', '/api/warm', {}); }
  async setTargets(targets) { return this.req('PUT', '/api/targets', { targets }); }
  async pushState(state) { return this.req('PUT', '/api/state', state); }
  async logs(limit) { return this.req('GET', '/api/logs?limit=' + (limit || 50)); }
}

module.exports = { DaemonClient, DaemonError };
