// 全局配置与路径。
//
// 数据目录（状态、凭据、日志）走 $WB_CLOUD_HOME，默认 ~/.wbsbx。
// 所有路径都由这里出，别在别处拼 os.homedir()。
const path = require('path');
const os = require('os');
const fs = require('fs');

const ORIGIN = 'https://www.workbuddy.cn';
const LOGIN_URL = ORIGIN + '/login/?platform=agents';   // platform=admin 是企业控制台，个人号报"没有企业"
const AGENTS_URL = ORIGIN + '/agents/';

const DEFAULT_MODEL = process.env.WBSBX_MODEL || 'deepseek-v4.1-flash';

// 平台选择：'workbuddy' 是历史默认。真正的解析在 lib/platform/index.js（它还会认
// WBSBX_PLATFORM_MODULE 与配置文件），这里只放默认值。
const DEFAULT_PLATFORM = 'workbuddy';

// ---------- 数据目录 ----------
function resolveHome() {
  if (process.env.WB_CLOUD_HOME) return { home: process.env.WB_CLOUD_HOME, source: 'WB_CLOUD_HOME' };
  return { home: path.join(os.homedir(), '.wbsbx'), source: 'default' };
}

const HOME_INFO = resolveHome();
const HOME = HOME_INFO.home;
const PROFILE = path.join(HOME, 'profile');       // 登录用的持久 profile（login 才碰）

const PATHS = {
  home: HOME,
  config: path.join(HOME, 'wbsbx.json'),          // 用户配置（daemon 地址 / 保活参数）
  state: path.join(HOME, 'state.json'),           // 登录态：cookie jar + UA
  stateLastGood: path.join(HOME, 'state.json.last-good'),  // 上一版登录态，写坏了可回滚
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
}


// ---------- 用户配置 ----------
const DEFAULTS = {
  // 当前平台（驱动 id）。provider 自己的默认值放 platforms.<id> 下，由 lib/platform 合并。
  platform: DEFAULT_PLATFORM,
  platforms: {},                     // { workbuddy: {...}, qoder: { model: 'qfmodel' } }
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
    probe: 'uptime',                 // 没有 script 的目标跑这条：一次真实 API 访问即可续命
    scriptsDir: '',                  // script 模式的脚本根目录（targets[].script 的相对路径按它解析）
    targets: [],                     // [{ id, name, script? }]，空=不保活任何实例
    timeoutSec: 120,                 // 脚本模式最坏路径要跑一遍 sb-boot（约 25s）+ 兜底动作
  },
  refresh: {
    intervalMs: 21600000,            // 6 小时
    leadMs: 43200000,                // 剩余不足 12 小时就提前刷
  },
  renew: {
    enabled: false,                  // 走 Keycloak SSO 续 cookie，需要真浏览器
    whenDays: 2,                     // cookie 剩余不足 2 天才动手（always=true 时忽略）
    always: false,                   // true = 每轮都续，用来让 SSO 会话保持活跃
  },
  keepalive: {
    nudgeSec: 60,                    // 空闲多久催一次
    maxNudges: 0,                    // 0 = 不限
    questionTimeoutSec: 0,           // 0 = 永不放弃（这才是保活的本意）
    stallAfterNudgeSec: 30,          // 催话后多久没字节就判定连接已死
    leadMs: 21600000,                // 凭据剩余不足 6h 先续一次
    prompt: require('./keepalive').DEFAULTS.prompt,
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
  if (process.env.WBSBX_PLATFORM) c.platform = process.env.WBSBX_PLATFORM;
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
  try { return JSON.parse(fs.readFileSync(PATHS.token(id), 'utf8')); } catch { return null; }
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
  try {
    for (const f of fs.readdirSync(PATHS.tokens)) {
      const m = f.match(/^token-(\d+)\.json$/);
      if (m) ids.add(m[1]);
    }
  } catch {}
  return [...ids];
}

module.exports = {
  HOME, HOME_INFO, PROFILE, ORIGIN, LOGIN_URL, AGENTS_URL, DEFAULT_MODEL, DEFAULT_PLATFORM, PATHS,
  DEFAULTS,
  ensureDirs, readConfig, writeConfig, readRawConfig,
  readToken, writeToken, dropToken, cachedIds,
};
