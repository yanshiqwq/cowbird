// 判据脚本：验证「这个接口把会话跟 UA 强绑定」
//
// 起因：2026-11-11 之前一直以为纯 HTTP 走不通是 APISIX 在卡 TLS 指纹
//（记忆里也是这么写的）。实际测下来 TLS 指纹、HTTP/2、cookie 全都不是原因 ——
// 换成 curl_cffi 模拟 Chrome 指纹照样 401，h2 也照样 401；
// 真正的原因是 UA 必须和登录时**一字不差**：改版本号、去尾巴、改大小写，全部 401。
//
// 用法: node test/probe-ua-binding.js
// 只读 state.json，不发任何写操作。UA 变了会 401，这就是预期结果。
const session = require('../lib/session');
const cfg = require('../lib/config');

const P = '/console/as/conversations/?page=1&pageSize=1';

async function tryUA(ua, cookies) {
  const r = await fetch(cfg.ORIGIN + P, {
    headers: {
      'user-agent': ua,
      accept: 'application/json',
      referer: cfg.AGENTS_URL,
      cookie: session.cookieHeader(cookies, undefined, P),
    },
  });
  const t = await r.text();
  return { s: r.status, len: t.length };
}

(async () => {
  const st = session.load();
  if (!st || !st.cookies.length) { console.log('没有 state.json，先跑 wbsbx login'); process.exit(1); }
  if (!st.ua) { console.log('state.json 缺 ua —— 那正是 401 的原因'); process.exit(1); }

  const real = st.ua;
  const cases = {
    'state.json 里的 UA': real,
    '改成 Chrome（去 Headless）': real.replace('HeadlessChrome', 'Chrome'),
    '版本号 +1': real.replace(/(Chrome\/\d+)/, (m) => m.replace(/\d+$/, (v) => String(Number(v) + 1))),
    '去掉 Edg 尾巴': real.replace(/ Edg\/[\d.]+$/, ''),
    '小写 headlesschrome': real.replace('HeadlessChrome', 'headlesschrome'),
    '空 UA': '',
  };

  console.log('UA =', JSON.stringify(real), '\n');
  for (const [tag, ua] of Object.entries(cases)) {
    try {
      const r = await tryUA(ua, st.cookies);
      console.log(`  ${tag.padEnd(28)} ${r.s === 200 ? '200 ✓' : r.s + ' ✗'}  (len=${r.len})`);
    } catch (e) {
      console.log(`  ${tag.padEnd(28)} ERR ${e.message.slice(0, 50)}`);
    }
  }
  console.log('\n只有第一行是 200 ⇒ 会话与 UA 精确绑定，state.json 里那份 UA 不能动。');
})();
