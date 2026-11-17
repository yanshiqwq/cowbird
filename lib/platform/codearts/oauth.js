// 码道的 OAuth 登录：PKCE + DPoP，凭据从华为云 STS 换。
//
// 这不是我们发明的流程 —— 是官方 CodeArts Agent（码道）插件 `huaweicloud.authentication`
// 的路子，逆向来源与关键结论：
//
//   1. 授权页 `https://codearts.huaweicloud.com/portal/authorize`，参数里带
//      `client_id=codearts-agent`、`uri_scheme=codearts-agent`、`ticket_id`、PKCE challenge。
//      登录完成后浏览器被打回 `http://127.0.0.1:<port>/oauth/callback?code=…`。
//   2. 拿 code 去 STS 换 token：`POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`
//      form（grant_type/client_id/code/code_verifier/redirect_uri）+ **DPoP 头**（ES256 JWT）。
//   3. 换回来的是**临时 AK/SK + security_token**（不是 cookie），外加 refresh_token。
//   4. refresh_token 与「签发它时的 client_id + DPoP 公钥」绑定：续期必须用同一对密钥，
//      否则 STS 报 InvalidDPoPHeader / invalid client id。所以私钥 JWK 必须和凭据一起存。
//   5. 回调够不着时还有兜底：轮询 `GET …/snap-manager/v1/login/ticket?ticket_id=&secret=`
//      —— 就是「打印链接 + 轮询状态机」那套（和 WorkBuddy 的 device 登录同构）。
//
// 这个文件只做协议，不落盘、不认识 ctx：凭据怎么存由 auth.js 决定。
const crypto = require('crypto');

const DEFAULTS = {
  clientId: 'codearts-agent',
  portalHost: 'https://codearts.huaweicloud.com/portal',
  stsHost: 'https://sts.cn-north-4.myhuaweicloud.com',
  snapManager: 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager',
  redirectPath: '/oauth/callback',
  pluginName: 'snap_AIIDE',
  pluginVersion: '5.2.0',
  timeoutMs: 30000,
};

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

/** PKCE：验证明文 + S256 challenge */
function pkce() {
  const verifier = b64u(crypto.randomBytes(32));
  const challenge = b64u(sha256(verifier));
  return { verifier, challenge };
}

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 生成一对 P-256 密钥，返回可持久化的 JWK（含私钥 d）与 KeyObject */
function newKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, privateKey };
}

function keyFromJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d) throw new Error('DPoP 私钥无效（需要 P-256 且含 d）');
  return { jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, privateKey: crypto.createPrivateKey({ key: jwk, format: 'jwk' }) };
}

/**
 * DPoP 证明（RFC 9449）：JWT，头里带公钥 jwk，载荷带 htm/htu/iat/jti。
 * 签名用 ieee-p1363（r||s 各 32 字节），与华为 STS 校验的格式一致。
 */
function dpopProof(key, htu, { htm = 'POST', now = Date.now() } = {}) {
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: { kty: key.jwk.kty, crv: key.jwk.crv, x: key.jwk.x, y: key.jwk.y } };
  const payload = { htm, htu, iat: Math.floor(now / 1000), jti: randomHex(16) };
  const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(payload));
  const sig = crypto.sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return input + '.' + b64u(sig);
}

/** 授权链接（浏览器打开这个） */
function authorizeUrl({ port, challenge, ticketId, clientId = DEFAULTS.clientId, portalHost = DEFAULTS.portalHost, pluginName = DEFAULTS.pluginName, pluginVersion = DEFAULTS.pluginVersion }) {
  const q = new URLSearchParams({
    theme: '2',
    locale: 'zh-cn',
    uri_scheme: clientId,
    client_id: clientId,
    port: String(port),
    code_challenge: challenge,
    code_challenge_method: 'SHA-256',
    ticket_id: ticketId,
    'plugin-name': pluginName,
    'plugin-version': pluginVersion,
  });
  return `${portalHost}/authorize?${q.toString()}`;
}

/** 回调地址（redirect_uri 必须与换 token 时逐字一致） */
function redirectUri(port, redirectPath = DEFAULTS.redirectPath) {
  return `http://127.0.0.1:${port}${redirectPath}`;
}

/** 从回调 URL 里取 code / secret / redirect（三种部署形态都见过） */
function parseCallback(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('回调地址不是合法 URL：' + raw); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('回调地址必须是 http(s)');
  return {
    code: u.searchParams.get('code') || '',
    secret: u.searchParams.get('secret') || '',
    redirect: u.searchParams.get('redirect') || '',
    port: Number(u.port) || 80,
    path: u.pathname,
  };
}

async function tokenRequest({ form, key, stsHost = DEFAULTS.stsHost, fetchImpl = fetch, timeoutMs = DEFAULTS.timeoutMs }) {
  const url = stsHost + '/v1/oauth2/tokens';
  const body = new URLSearchParams(form).toString();
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: dpopProof(key, url) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：下面按错误报 */ }
  if (!r.ok) {
    const e = new Error(`换 token 失败 http=${r.status} ${String((json && (json.error_msg || json.error)) || text).slice(0, 200)}`);
    e.status = r.status;
    e.code = (json && json.error_code) || null;
    e.body = json;
    throw e;
  }
  const out = normalize(json || {});
  if (!out.securityToken) throw new Error(`换 token 的响应里没有凭据：${text.slice(0, 200)}`);
  return out;
}

/** authorization_code → 凭据 */
function exchange({ code, verifier, port, key, ...cfg }) {
  return tokenRequest({
    key,
    stsHost: cfg.stsHost,
    fetchImpl: cfg.fetchImpl,
    form: {
      client_id: cfg.clientId || DEFAULTS.clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(port, cfg.redirectPath),
    },
  });
}

/** refresh_token → 新凭据（必须用同一对 DPoP 密钥与同一个 client_id） */
function refresh({ refreshToken, verifier, key, ...cfg }) {
  return tokenRequest({
    key,
    stsHost: cfg.stsHost,
    fetchImpl: cfg.fetchImpl,
    form: {
      client_id: cfg.clientId || DEFAULTS.clientId,
      code_verifier: verifier || '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
  });
}

/** 兜底通道：轮询 ticket（浏览器回调够不着时用） */
async function pollTicket({ ticketId, secret, ...cfg }) {
  const base = cfg.snapManager || DEFAULTS.snapManager;
  const q = new URLSearchParams({ ticket_id: ticketId, secret: secret || '' });
  const r = await (cfg.fetchImpl || fetch)(`${base}/v1/login/ticket?${q}`, {
    headers: { 'plugin-name': cfg.pluginName || DEFAULTS.pluginName, 'plugin-version': cfg.pluginVersion || DEFAULTS.pluginVersion },
    signal: AbortSignal.timeout(cfg.timeoutMs || DEFAULTS.timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) return null;
  try { return normalize(JSON.parse(text)); } catch { return null; }
}

/** STS 的两种响应形状（新 credentials / 旧 credential）归一 */
function normalize(j = {}) {
  const c = j.credentials || {};
  const old = j.credential || {};
  // 实测（2026-11-17 真账号）：新形状的字段是 access_key_id / secret_access_key，
  // 而参考实现里读的是 access / secret —— 两种都认，别只留一种。
  const pick = (...vals) => vals.find((v) => v) || '';
  return {
    userId: pick(j.user_id, j.userId),
    userName: pick(j.user_name, j.userName),
    domainId: pick(j.domain_id, j.domainId),
    securityToken: pick(c.security_token, old.security_token),
    accessKeyId: pick(c.access_key_id, c.access, old.access, old.access_key_id),
    secretAccessKey: pick(c.secret_access_key, c.secret, old.secret, old.secret_access_key),
    expiration: pick(c.expiration, old.expires_at),
    refreshToken: pick(j.refresh_token, j.refreshToken),
    error: j.error || '',
    errorCode: j.error_code || '',
    errorMessage: j.error_msg || '',
    raw: j,
  };
}

/** 凭据还剩几天（没有 expiration 就 null） */
function ttlDays(expiration) {
  const t = Date.parse(expiration || '');
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / 86400e3;
}

// ---------- 华为云 SDK-HMAC-SHA256 签名 ----------
// 换回来的 AK/SK 只能配这个签名使（`Authorization: SDK-HMAC-SHA256 Access=…`），
// 与 `@huaweicloud/huaweicloud-sdk-core` 的 AKSKSigner 一致：
//   signed headers = 请求里全部头（小写、排序）
//   CanonicalURI   每段 encodeURIComponent 且末尾补 "/"
//   payload hash 放 X-Sdk-Content-Sha256 头里
// 实测（2026-11-17）：这套签名打 `/snap-manager/*` 200，打 devcloud 控制面仍是登录跳转。
function signRequest({ method = 'GET', url, body = '', accessKeyId, secretAccessKey, securityToken, now = Date.now() }) {
  const u = new URL(url);
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const h = {
    host: u.host,
    'x-sdk-date': iso,
    'x-sdk-content-sha256': sha256(body === undefined || body === null ? '' : body).toString('hex'),
  };
  if (securityToken) h['x-security-token'] = securityToken;

  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((k) => `${k}:${String(h[k]).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalUri = u.pathname.endsWith('/') ? u.pathname : u.pathname + '/';
  const params = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonicalRequest = [String(method).toUpperCase(), canonicalUri, canonicalQuery,
    canonicalHeaders, signedHeaders, h['x-sdk-content-sha256']].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', iso, sha256(canonicalRequest).toString('hex')].join('\n');
  h.authorization = `SDK-HMAC-SHA256 Access=${accessKeyId}, SignedHeaders=${signedHeaders}, ` +
    `Signature=${crypto.createHmac('sha256', secretAccessKey).update(stringToSign).digest('hex')}`;
  return h;
}

/**
 * 这个凭据是谁（`snap-manager/v1/current/user`，AK/SK 签名）。
 * 换票的响应里**没有人身份**（只有 credentials 与 refresh_token），所以登录成功后补这一问，
 * 才能把「登录的是哪个账号」写进名片、在 `account list` 里显示出来。
 */
async function whoami({ accessKeyId, secretAccessKey, securityToken, snapManager = DEFAULTS.snapManager, fetchImpl = fetch, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  if (!accessKeyId || !secretAccessKey) return null;
  const url = `${snapManager}/v1/current/user`;
  const headers = { ...signRequest({ url, accessKeyId, secretAccessKey, securityToken }), accept: 'application/json' };
  const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) return null;
  let j = null;
  try { j = await r.json(); } catch { return null; }
  if (!j) return null;
  return {
    userId: j.user_id || null,
    userName: j.user_name || null,
    domainId: j.domain_id || null,
    domainName: j.domain_name || null,
  };
}

module.exports = {
  DEFAULTS, pkce, newKey, keyFromJwk, dpopProof, randomHex,
  authorizeUrl, redirectUri, parseCallback,
  exchange, refresh, pollTicket, normalize, ttlDays,
  signRequest, whoami,
};
