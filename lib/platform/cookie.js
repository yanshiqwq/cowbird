// Cookie jar 的通用部分：取值、拼 Cookie 头、解析粘贴串、合并 Set-Cookie。
//
// 以前 codearts 与 qoder 各写一份（域名/路径匹配规则还略有不同），
// 这两件事都是"写错就跨域泄露凭据"的地方，所以只保留一份实现。

/** 取某个 cookie 的值（没有就 null） */
function value(cookies, name) {
  const hit = (cookies || []).find((c) => c && c.name === name);
  return hit ? String(hit.value === undefined ? '' : hit.value) : null;
}

/** 复合键：同一个 name 在 / 与 /console 下是两条不同 cookie，不能只按 name 去重 */
function key(c) {
  return `${c && c.name}|${(c && c.path) || '/'}|${String((c && c.domain) || '').replace(/^\./, '').toLowerCase()}`;
}

/**
 * jar → Cookie 请求头。
 * @param {Array} cookies
 * @param {{host?:string, path?:string, extraDomains?:string[]}} [opts]
 *   extraDomains：本平台自己的域名后缀白名单（例如 codearts 的 huaweicloud.com）
 */
function header(cookies, { host = '', path = '/', extraDomains = [] } = {}) {
  const h = String(host || '').toLowerCase();
  const extra = (extraDomains || []).map((x) => String(x).toLowerCase());
  return (cookies || [])
    .filter((c) => {
      if (!c || !c.name) return false;
      const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
      const domainOk = !d || d === h || (h && h.endsWith('.' + d)) || (d && d.endsWith('.' + h))
        || extra.some((x) => d === x || d.endsWith('.' + x));
      if (!domainOk) return false;
      const cp = c.path || '/';
      return cp === '/' || path === cp || path.startsWith(cp.endsWith('/') ? cp : cp + '/');
    })
    .map((c) => `${c.name}=${c.value === undefined ? '' : c.value}`)
    .join('; ');
}

/** 用户手动粘 `a=1; b=2` → cookie 数组（无浏览器环境的主要登录方式） */
function parse(raw, { domain = '', path = '/' } = {}) {
  const out = [];
  for (const part of String(raw === undefined || raw === null ? '' : raw).split(';')) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out.push({
      name: t.slice(0, i).trim(),
      value: t.slice(i + 1).trim(),
      domain,
      path,
      expires: -1,
      httpOnly: false,
      secure: true,
    });
  }
  return out;
}

/**
 * Set-Cookie 合并回 jar（滚动刷新）。
 *
 * 调用方约定：**只对 2xx 调用**。401 响应里常带 `session=; Max-Age=0`（服务端在清理
 * 失效会话），照收会把还能救的登录态清空。
 *
 * @param {Array} jar
 * @param {string[]} setCookies
 * @param {{defaultDomain?:string}} [opts]
 * @returns {{cookies:Array, changed:boolean}}
 */
function absorb(jar, setCookies, { defaultDomain = '' } = {}) {
  const cookies = Array.isArray(jar) ? jar.slice() : [];
  let changed = false;

  for (const raw of setCookies || []) {
    const parts = String(raw === undefined || raw === null ? '' : raw).split(';').map((x) => x.trim());
    const first = parts.shift() || '';
    const i = first.indexOf('=');
    if (i < 0) continue;
    const name = first.slice(0, i).trim();
    const val = first.slice(i + 1);
    if (!name) continue;

    const attrs = {};
    for (const p of parts) {
      const k = p.indexOf('=');
      if (k > 0) attrs[p.slice(0, k).toLowerCase()] = p.slice(k + 1);
    }
    const path = attrs.path || '/';
    const domain = attrs.domain || defaultDomain;
    const k2 = key({ name, path, domain });
    const idx = cookies.findIndex((c) => key(c) === k2);

    const maxAge = attrs['max-age'] !== undefined ? Number(attrs['max-age']) : null;
    const expiresAt = attrs.expires ? Math.floor(Date.parse(attrs.expires) / 1000) : null;
    const dead = (maxAge !== null && maxAge <= 0) || (expiresAt !== null && expiresAt * 1000 <= Date.now());

    if (dead) { if (idx >= 0) { cookies.splice(idx, 1); changed = true; } continue; }
    if (!val && maxAge === null && expiresAt === null) continue;

    const cur = {
      name,
      value: val,
      path,
      domain,
      expires: maxAge !== null ? Math.floor(Date.now() / 1000) + maxAge
        : (expiresAt !== null ? expiresAt : (idx >= 0 ? cookies[idx].expires : -1)),
      httpOnly: 'httponly' in attrs ? true : (idx >= 0 ? !!cookies[idx].httpOnly : false),
      secure: 'secure' in attrs ? true : (idx >= 0 ? !!cookies[idx].secure : true),
    };
    if (idx >= 0) {
      if (cookies[idx].value !== val || cookies[idx].expires !== cur.expires) changed = true;
      cookies[idx] = cur;
    } else { cookies.push(cur); changed = true; }
  }

  return { cookies, changed };
}

module.exports = { value, key, header, parse, absorb };
