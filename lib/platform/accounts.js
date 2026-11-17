// 账号：一个平台下的多份独立登录态。
//
// 布局（由 ctx.store 读写，见 lib/platform/index.js）：
//   ~/.cowbird/platform/<平台>/accounts/<账号>/
// 账号就是**目录名**，也是 `--account <名字>` / `<平台>:<名字>` 里的那一段。
//
// 为什么按目录分而不是在一份文件里放多个账号：凭据是「一个账号一个 jar」的东西，
// 分目录后账号之间天然互相看不见 —— 换账号不会串 cookie，删账号就是删目录。
//
// 老布局（凭据直接躺在 platform/<平台>/ 下）在首次访问时一次性搬进 accounts/default/，
// 搬完就不用再管了；判断条件是「子目录里有 .json 文件」。
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const DEFAULT_ALIAS = 'default';
// 目录名同时会出现在 `平台:账号` 的引用里，限制成不用转义的一小撮字符。
// 从下划线开头留给内部用途（例如 _tmp），别让用户建出来。
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function valid(alias) {
  return typeof alias === 'string' && ALIAS_RE.test(alias);
}

function assertValid(alias) {
  if (!valid(alias)) {
    const e = new Error(`账号名「${alias}」不合法：只能字母/数字/点/下划线/连字符，1~32 字符，且不以符号开头`);
    e.code = 'E_BAD_ACCOUNT';
    throw e;
  }
  return alias;
}

function platformDir(id) { return cfg.PATHS.platform(id); }
function dir(id, alias = DEFAULT_ALIAS) { return cfg.PATHS.account(id, assertValid(alias)); }

/** 现有账号名（按目录名排序；不保证目录里有凭据） */
function list(id) {
  migrate();
  try {
    return fs
      .readdirSync(cfg.PATHS.accounts(id), { withFileTypes: true })
      .filter((d) => d.isDirectory() && valid(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function exists(id, alias = DEFAULT_ALIAS) {
  return fs.existsSync(cfg.PATHS.account(id, assertValid(alias)));
}

function ensure(id, alias = DEFAULT_ALIAS) {
  const d = dir(id, alias);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 账号目录里的 json 文件名（凭据 + 缓存都在这；空 = 这个目录还没被用过） */
function files(id, alias = DEFAULT_ALIAS) {
  try {
    return fs.readdirSync(dir(id, alias)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** 这个账号有没有东西（登录成功过就会至少有一份凭据） */
function hasCred(id, alias = DEFAULT_ALIAS) {
  return files(id, alias).length > 0;
}

// account.json 是**内核**写的账号名片（昵称、uid、登录时间），驱动不碰它。
// 好处：`cowbird account ls` 要显示「这是谁的账号」，而各平台的登录态形状完全不同，
// 让内核去解析每家的凭据文件等于把平台细节搬回内核。
function meta(id, alias = DEFAULT_ALIAS) {
  try { return JSON.parse(fs.readFileSync(path.join(dir(id, alias), 'account.json'), 'utf8')); } catch { return null; }
}

function writeMeta(id, alias, patch) {
  const cur = meta(id, alias) || {};
  const next = { ...cur, ...patch, alias, platform: id, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(dir(id, alias), { recursive: true });
    fs.writeFileSync(path.join(dir(id, alias), 'account.json'), JSON.stringify(next, null, 1));
  } catch { /* 名片写失败不影响登录本身 */ }
  return next;
}

function remove(id, alias = DEFAULT_ALIAS) {
  const d = dir(id, alias);
  if (!fs.existsSync(d)) return false;
  fs.rmSync(d, { recursive: true, force: true });
  return true;
}

function rename(id, from, to) {
  assertValid(from);
  assertValid(to);
  const a = dir(id, from);
  const b = dir(id, to);
  if (!fs.existsSync(a)) throw new Error(`没有账号「${id}:${from}」`);
  if (fs.existsSync(b)) throw new Error(`账号「${id}:${to}」已经存在`);
  fs.renameSync(a, b);
  writeMeta(id, to, { alias: to });
  return true;
}

/** 当前该用哪个账号：显式指定 > 环境变量 > 配置 > default */
function pick(id, want) {
  const c = (() => { try { return cfg.readConfig(); } catch { return {}; } })();
  const chosen = want || cfg.envVal('COWBIRD_ACCOUNT') || (c.accounts && c.accounts[id]) || DEFAULT_ALIAS;
  return assertValid(String(chosen));
}

let migrated = false;

/**
 * 老布局 → 账号目录。幂等，进程内只跑一次。
 * 搬的是：platform/<平台>/*.json 与 ~/.cowbird/conversations.json（旧版会话缓存）。
 */
function migrate() {
  if (migrated) return;
  migrated = true;
  const root = path.join(cfg.HOME, 'platform');
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const pdir = path.join(root, ent.name);
      let legacy = [];
      try {
        legacy = fs.readdirSync(pdir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.json'));
      } catch { continue; }
      if (!legacy.length) continue;
      const dest = ensure(ent.name, DEFAULT_ALIAS);
      for (const f of legacy) {
        const from = path.join(pdir, f.name);
        const to = path.join(dest, f.name);
        try {
          if (fs.existsSync(to)) fs.unlinkSync(from);
          else fs.renameSync(from, to);
        } catch { /* 单个文件搬不动就算了，别让整个命令起不来 */ }
      }
      writeMeta(ent.name, DEFAULT_ALIAS, { migrated: true, nickname: (meta(ent.name, DEFAULT_ALIAS) || {}).nickname || null });
    }
  } catch { /* 没有 platform 目录 = 全新安装 */ }

  // 旧版把会话缓存放在数据目录根上（那时只有一个账号）。归到 workbuddy 的 default 账号下。
  const oldConv = cfg.PATHS.conversations;
  if (fs.existsSync(oldConv)) {
    const dest = path.join(ensure('workbuddy', DEFAULT_ALIAS), 'conversations.json');
    try {
      if (!fs.existsSync(dest)) fs.renameSync(oldConv, dest);
      else fs.unlinkSync(oldConv);
    } catch { /* 留着也无害 */ }
  }
}

module.exports = {
  DEFAULT_ALIAS, valid, assertValid,
  platformDir, dir, list, exists, ensure, files, hasCred,
  meta, writeMeta, remove, rename, pick, migrate,
};
