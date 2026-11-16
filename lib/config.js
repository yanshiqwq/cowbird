// 全局配置与路径。
//
// 数据目录（状态、凭据、日志）走 $WB_CLOUD_HOME，默认 ~/.wbsbx。
// 兼容老用户：如果只有旧的 ~/.workbuddy/wb-cloud 存在，就继续用它，不逼人搬家。
// 所有路径都由这里出，别在别处拼 os.homedir()。
const path = require('path');
const os = require('os');
const fs = require('fs');

const ORIGIN = 'https://www.workbuddy.cn';
const LOGIN_URL = ORIGIN + '/login/?platform=agents';   // platform=admin 是企业控制台，个人号报"没有企业"
const AGENTS_URL = ORIGIN + '/agents/';

const DEFAULT_MODEL = process.env.WBSBX_MODEL || 'deepseek-v4.1-flash';

// ---------- 数据目录 ----------
function resolveHome() {
  if (process.env.WB_CLOUD_HOME) return { home: process.env.WB_CLOUD_HOME, source: 'WB_CLOUD_HOME' };
  const modern = path.join(os.homedir(), '.wbsbx');
  const legacy = path.join(os.homedir(), '.workbuddy', 'wb-cloud');
  const hasState = (d) => { try { return fs.existsSync(path.join(d, 'state.json')); } catch { return false; } };
  if (hasState(modern)) return { home: modern, source: 'default' };
  if (hasState(legacy)) return { home: legacy, source: 'legacy ~/.workbuddy/wb-cloud' };
  return { home: modern, source: 'default' };
}

const HOME_INFO = resolveHome();
const HOME = HOME_INFO.home;
const PROFILE = path.join(HOME, 'profile');       // 登录用的持久 profile（login 才碰）

const PATHS = {
  home: HOME,
  config: path.join(HOME, 'wbsbx.json'),          // 用户配置（daemon 地址 / 保活参数）
  state: path.join(HOME, 'state.json'),           // 登录态：cookie jar + UA
  conversations: path.join(HOME, 'conversations.json'),
  tokens: path.join(HOME, 'tokens'),              // token-<id>.json
  logs: path.join(HOME, 'logs'),
  daemonState: path.join(HOME, 'daemon-state.json'),
  daemonPid: path.join(HOME, 'daemon.pid'),
  token: (id) => path.join(HOME, 'tokens', `token-${id}.json`),
};

function ensureDirs() {
  for (const d of [HOME, PATHS.tokens, PATHS.logs]) {
    try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch {}
  }
  migrateLegacyTokens();
}

// 老版本把 token-<id>.json 直接堆在数据目录根下。挪进 tokens/ 但不删任何东西：
// 目的路径已存在就跳过（说明早就迁过了），rename 失败也静默 —— 读的时候两处都找。
function migrateLegacyTokens() {
  let names = [];
  try { names = fs.readdirSync(HOME); } catch { return; }
  for (const f of names) {
    if (!/^token-\d+\.json$/.test(f)) continue;
    const dst = path.join(PATHS.tokens, f);
    if (fs.existsSync(dst)) continue;
    try { fs.renameSync(path.join(HOME, f), dst); } catch {}
  }
}

// ---------- 用户配置 ----------
const DEFAULTS = {
  daemon: {
    // CLI 默认先问 daemon 要凭据；连不上就退回本地文件，不会因为 daemon 挂了啥都干不了。
    prefer: true,
    url: 'http://127.0.0.1:8787',
    token: '',                       // daemon 访问令牌；daemon 首次启动会自动生成并回写
    timeoutMs: 4000,
  },
  heal: {
    enabled: true,
    intervalMs: 600000,              // 10 分钟
    probe: 'uptime',                 // 续命探针：只要让平台看到一次真实 API 访问即可
    targets: [],                     // [{ id, name }]，空=不保活任何实例
    timeoutSec: 60,
  },
  refresh: {
    intervalMs: 21600000,            // 6 小时
    leadMs: 43200000,                // 剩余不足 12 小时就提前刷
  },
  renew: {
    enabled: false,                  // 走 Keycloak SSO 续 cookie，需要真浏览器
    whenDays: 2,                     // cookie 剩余不足 2 天才动手
  },
  http: {
    host: '127.0.0.1',
    port: 8787,
  },
};

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a && a[k], v) : v;
  }
  return out;
}

function readRawConfig() {
  try { return JSON.parse(fs.readFileSync(PATHS.config, 'utf8')); } catch { return {}; }
}

function readConfig() {
  const c = deepMerge(DEFAULTS, readRawConfig());
  // 环境变量覆盖（容器/CI 友好）
  if (process.env.WBSBX_DAEMON_URL) c.daemon.url = process.env.WBSBX_DAEMON_URL;
  if (process.env.WBSBX_DAEMON_TOKEN) c.daemon.token = process.env.WBSBX_DAEMON_TOKEN;
  if (process.env.WBSBX_DAEMON_PORT) c.http.port = Number(process.env.WBSBX_DAEMON_PORT);
  if (process.env.WBSBX_DAEMON_HOST) c.http.host = process.env.WBSBX_DAEMON_HOST;
  return c;
}

function writeConfig(patch) {
  ensureDirs();
  const next = deepMerge(readRawConfig(), patch);
  fs.writeFileSync(PATHS.config, JSON.stringify(next, null, 2));
  try { fs.chmodSync(PATHS.config, 0o600); } catch {}
  return next;
}

// ---------- 凭据缓存 ----------
function readToken(id) {
  try { return JSON.parse(fs.readFileSync(PATHS.token(id), 'utf8')); } catch {}
  // 迁移没成功时老位置还有一份
  try { return JSON.parse(fs.readFileSync(path.join(HOME, `token-${id}.json`), 'utf8')); } catch {}
  return null;
}

function writeToken(id, data) {
  ensureDirs();
  const p = PATHS.token(id);
  fs.writeFileSync(p, JSON.stringify(data, null, 1));
  try { fs.chmodSync(p, 0o600); } catch {}
  return p;
}

function dropToken(id) {
  try { fs.unlinkSync(PATHS.token(id)); } catch {}
}

function cachedIds() {
  const ids = new Set();
  for (const dir of [PATHS.tokens, HOME]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^token-(\d+)\.json$/);
        if (m) ids.add(m[1]);
      }
    } catch {}
  }
  return [...ids];
}

module.exports = {
  HOME, HOME_INFO, PROFILE, ORIGIN, LOGIN_URL, AGENTS_URL, DEFAULT_MODEL, PATHS,
  DEFAULTS,
  ensureDirs, readConfig, writeConfig, readRawConfig,
  readToken, writeToken, dropToken, cachedIds,
};
