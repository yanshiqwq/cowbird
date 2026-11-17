// 只活几十秒的本地回调接收器：接住华为 OAuth 打回来的 `?code=…`。
//
// 为什么需要它：授权页登录完成后，浏览器会被打回 `http://127.0.0.1:<port>/oauth/callback`。
// 那个端口是我们自己在授权链接里写的，所以必须由我们先起一个服务听着 —— 否则 code 就丢了。
// （WSL 里起在 127.0.0.1 上，Windows 侧浏览器照样能打到：WSL2 会把 localhost 转发进去。）
//
// 三种回调形态，实测都出现过：
//   ?code=<授权码>                     新式 OAuth：拿它去 STS 换凭据
//   ?secret=<会话密钥>&redirect=<url>  旧式 portal：记下 secret 后继续跳转，改走 ticket 轮询
//   两者都有                            先记 secret（可能对后续轮询有用），再处理 code
const http = require('http');

const PAGE = (title, detail) => `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>body{font:16px/1.7 -apple-system,"Segoe UI",sans-serif;max-width:34em;margin:18vh auto;padding:0 1.5em;color:#222}
h1{font-size:1.3em}code{background:#f4f4f4;padding:.1em .35em;border-radius:4px}
.muted{color:#666;font-size:.9em}</style>
<h1>${title}</h1><p class="muted">${detail}</p>`;

/**
 * 起一个本地回调服务。
 * @param {{redirectPath?:string, onCallback:(q:URLSearchParams)=>void|Promise<void>}} opts
 * @returns {Promise<{port:number, url:string, close:()=>Promise<void>}>}
 */
function open({ redirectPath = '/oauth/callback', onCallback } = {}) {
  return new Promise((resolve, reject) => {
    let closed = false;
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== redirectPath) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const q = u.searchParams;
      const hasCode = Boolean(q.get('code'));
      const redirect = q.get('redirect') || '';
      const secret = q.get('secret') || '';

      try {
        if (onCallback) await onCallback(q);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE('回调处理出错', String(e.message || e)));
        return;
      }

      if (hasCode) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE('授权完成', '可以关掉这个页面，回到终端看结果。'));
        return;
      }
      if (secret && /^https:\/\//.test(redirect)) {
        // 旧式 portal 回调：把浏览器送回华为那边继续，别让用户停在白页上
        res.writeHead(302, { location: secret && redirect ? `${redirect}${redirect.includes('?') ? '&' : '?'}secret=${encodeURIComponent(secret)}` : redirect });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE('收到了回调，但没有授权码', '回到终端看提示；这条链路可能要走 ticket 轮询。'));
    });

    server.on('error', (e) => { if (!closed) { closed = true; reject(e); } });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}${redirectPath}`,
        close: () => new Promise((r) => {
          if (closed) return r();
          closed = true;
          try { server.close(() => r()); } catch { r(); }
          // keep-alive 连接会让 close 挂住，兜底超时
          setTimeout(r, 1500).unref?.();
        }),
      });
    });
  });
}

module.exports = { open };
