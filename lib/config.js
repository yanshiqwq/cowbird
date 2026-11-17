// 全局配置与路径。
//
// 数据目录（状态、凭据、日志）走 $COWBIRD_HOME，默认 ~/.cowbird。
// 所有路径都由这里出，别在别处拼 os.homedir()。
const path = require('path');
const os = require('os');
const fs = require('fs');

// 改名兼容：老变量（wbsbx 时代的 WB_CLOUD_HOME / WBSBX_*）继续认，但会提示一次。
// 项目 2026-11 从 wbsbx 改名 cowbird —— 沙箱是各平台的，工具不该背平台的名字。
const OLD_ENV = {
  COWBIRD_HOME: ['WB_CLOUD_HOME'],
  COWBIRD_DAEMON_URL: ['WBSBX_DAEMON_URL'],
  COWBIRD_DAEMON_TOKEN: ['WBSBX_DAEMON_TOKEN'],
  COWBIRD_DAEMON_PORT: ['WBSBX_DAEMON_PORT'],
  COWBIRD_DAEMON_HOST: ['WBSBX_DAEMON_HOST'],
  COWBIRD_PLATFORM: ['WBSBX_PLATFORM'],
  COWBIRD_PLATFORM_MODULE: ['WBSBX_PLATFORM_MODULE'],
  COWBIRD_MODEL: ['WBSBX_MODEL'],
  COWBIRD_LOCAL: ['WBSBX_LOCAL'],
};
const warned = new Set();
/** 读环境变量：新名优先，老名兜底（提示一次） */
function envVal(name, dflt = '') {
  if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
  for (const old of OLD_ENV[name] || []) {
    if (process.env[old]) {
      if (!warned.has(old)) {
        warned.add(old);
        console.error(`[cowbird] 环境变量 ${old} 已改名为 ${name}，这个旧名字下个版本会移除。`);
      }
      return process.env[old];
    }
  }
  return dflt;
}

// 平台选择：'workbuddy' 是历史默认。真正的解析在 lib/platform/index.js（它还会认
// COWBIRD_PLATFORM_MODULE 与配置文件），这里只放默认值。
const DEFAULT_PLATFORM = 'workbuddy';

// ---------- 数据目录 ----------
const OLD_HOME = path.join(os.homedir(), '.wbsbx');

/** 把 ~/.wbsbx 整个拷到 ~/.cowbird（只拷不删，出问题还能退回去） */
function migrateOldHome(target) {
  try {
    if (!fs.existsSync(OLD_HOME) || fs.existsSync(target)) return false;
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(OLD_HOME, target, { recursive: true, force: false });
    console.error(`[cowbird] 已把旧数据目录 ${OLD_HOME} 复制到 ${target}（源目录保留，确认没问题后可自行删除）。`);
    return true;
  } catch (e) {
    console.error(`[cowbird] 迁移旧数据目录失败（忽略，继续用新目录）：${e.message}`);
    return false;
  }
}

function resolveHome() {
  const fromEnv = envVal('COWBIRD_HOME');
  if (fromEnv) return { home: fromEnv, source: 'COWBIRD_HOME' };
  const home = path.join(os.homedir(), '.cowbird');
  migrateOldHome(home);
  return { home, source: 'default' };
}

const HOME_INFO = resolveHome();
const HOME = HOME_INFO.home;
const PROFILE = path.join(HOME, 'profile');       // 登录用的持久 profile（login 才碰）

const PATHS = {
  home: HOME,
  config: path.join(HOME, 'cowbird.json'),          // 用户配置（daemon 地址 / 保活参数）
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
    // 催话文案的默认值。原来是 require('./keepalive').DEFAULTS.prompt（那个模块已经搬进
    // WorkBuddy 驱动了）；内核不该为了一个字符串去依赖平台实现，所以就地内联。
    // 想改成别的平台口径，用 cowbird.json 的 keepalive.prompt 覆盖。
    prompt: '【保活】上一轮已经结束了。请立刻用 AskUserQuestion 问我下一个问题，不要自己往下做，也不要总结。',
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
  if (envVal('COWBIRD_DAEMON_URL')) c.daemon.url = envVal('COWBIRD_DAEMON_URL');
  if (envVal('COWBIRD_DAEMON_TOKEN')) c.daemon.token = envVal('COWBIRD_DAEMON_TOKEN');
  if (envVal('COWBIRD_DAEMON_PORT')) c.http.port = Number(envVal('COWBIRD_DAEMON_PORT'));
  if (envVal('COWBIRD_DAEMON_HOST')) c.http.host = envVal('COWBIRD_DAEMON_HOST');
  if (envVal('COWBIRD_PLATFORM')) c.platform = envVal('COWBIRD_PLATFORM');
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
  envVal,
  HOME, HOME_INFO, PROFILE, DEFAULT_PLATFORM, PATHS,
  DEFAULTS,
  ensureDirs, readConfig, writeConfig, readRawConfig,
  readToken, writeToken, dropToken, cachedIds,
};
