// daemon 的 HTTP 接口。没有框架，就是 node:http 加一个路由表。
//
// 鉴权：除 /health 外全部要 Bearer token。
//   token 由 daemon 首次启动生成并写进配置文件（600）。
//   监听非回环地址却没 token 时，daemon 拒绝启动 —— 别把凭据服务裸奔在网上。
const http = require('http');
const crypto = require('crypto');
const cfg = require('../config');
const creds = require('../creds');
const session = require('../session');

const VERSION = require('../../package.json').version;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

function isLoopback(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function createServer({ scheduler, log, logstore, token }) {
  const needToken = Boolean(token);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const method = req.method.toUpperCase();

    // 健康检查给系统探活用，不泄露任何内容
    if (p === '/health') {
      return json(res, 200, {
        ok: true, service: 'wbsbx-daemon', version: VERSION,
        uptimeSec: scheduler.state ? Math.floor((Date.now() - Date.parse(scheduler.state.startedAt)) / 1000) : 0,
      });
    }

    const auth = req.headers.authorization || '';
    const given = auth.replace(/^Bearer\s+/i, '');
    if (needToken) {
      if (!safeEqual(given, token)) return json(res, 401, { error: '令牌无效', code: 'UNAUTHORIZED' });
    } else if (!isLoopback(req.socket.remoteAddress)) {
      // 没设令牌时只允许本机访问，不给「忘了配 token」留后门
      return json(res, 403, { error: '本机之外的访问需要配置令牌', code: 'NO_TOKEN' });
    }

    try {
      if (method === 'GET' && p === '/api/status') return json(res, 200, scheduler.snapshot());

      if (method === 'GET' && p === '/api/state') {
        const st = creds.readLocalState();
        if (!st || !st.cookies || !st.cookies.length) return json(res, 404, { error: '没有登录态', code: 'NO_STATE' });
        return json(res, 200, { cookies: st.cookies, ua: st.ua, savedAt: st.savedAt });
      }

      if (method === 'PUT' && p === '/api/state') {
        const body = await readBody(req);
        if (!body || !Array.isArray(body.cookies) || !body.cookies.length) {
          return json(res, 400, { error: 'cookies 不能为空' });
        }
        if (!body.ua) return json(res, 400, { error: '缺 ua —— 会话与 UA 强绑定，没有它这份 cookie 用不了' });
        creds.writeLocalState({ cookies: body.cookies, ua: body.ua });
        creds.reset();
        log(`接收了新的登录态（${body.cookies.length} 条 cookie）`);
        return json(res, 200, { ok: true });
      }

      if (method === 'GET' && p.startsWith('/api/token/')) {
        const id = decodeURIComponent(p.slice('/api/token/'.length));
        if (!/^\d+$/.test(id)) return json(res, 400, { error: 'id 必须是数字' });
        const cloud = require('../cloud');
        const t = await cloud.getSession(id, (m) => log('[token] ' + m));
        return json(res, 200, t);
      }

      if (method === 'POST' && p === '/api/heal') {
        const r = await scheduler.healNow();
        return json(res, 200, r);
      }

      if (method === 'POST' && p === '/api/refresh') {
        const body = await readBody(req);
        const r = await scheduler.refreshNow(body && body.ids);
        return json(res, 200, r);
      }

      if (method === 'POST' && p === '/api/renew') {
        const r = await scheduler.renewNow({ force: true });
        return json(res, r.ok ? 200 : 500, r);
      }

      if (method === 'PUT' && p === '/api/targets') {
        const body = await readBody(req);
        if (!body || !Array.isArray(body.targets)) return json(res, 400, { error: 'targets 必须是数组' });
        return json(res, 200, { ok: true, targets: scheduler.setTargets(body.targets) });
      }

      if (method === 'GET' && p === '/api/logs') {
        const n = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
        return json(res, 200, { lines: logstore ? logstore.tail(n) : [] });
      }

      return json(res, 404, { error: '没有这个接口：' + method + ' ' + p });
    } catch (e) {
      log(`${method} ${p} 失败：${String(e.message).slice(0, 200)}`);
      const code = /登录态|401|令牌/.test(e.message) ? 401 : 500;
      return json(res, code, { error: String(e.message).slice(0, 300) });
    }
  });

  return server;
}

module.exports = { createServer };
