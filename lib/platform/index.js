// 平台注册表与门面：内核唯一允许拿 provider 的入口。
//
// 选择顺序（先到先得）：
//   1. COWBIRD_PLATFORM_MODULE=<路径|包名>   —— 外部/第三方驱动，不写进内核
//   2. COWBIRD_PLATFORM=<id>                —— 环境变量
//   3. config.platform                    —— cowbird.json 的 "platform"
//   4. 'workbuddy'                        —— 历史默认
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { validateShape } = require('./validate');

// 内置驱动：懒加载 —— 某个驱动写坏了不该拖垮整条 CLI。
const BUILTIN = {
  workbuddy: () => require('./workbuddy'),
  codearts: () => require('./codearts'),
  qoder: () => require('./qoder'),
  minimax: () => require('./minimax'),
  // 仅用于契约测试与 `platform ls --all`
  _example: () => require('./_example'),
};

const cache = new Map();      // id -> provider
const loadErrors = new Map(); // id -> Error

function describe(id) {
  return `provider「${id}」`;
}

function loadBuiltin(id) {
  if (cache.has(id)) return cache.get(id);
  if (loadErrors.has(id)) throw loadErrors.get(id);
  const factory = BUILTIN[id];
  if (!factory) {
    const e = new Error(`没有内置平台「${id}」。可用：${available().join(', ')}`);
    e.code = 'E_UNKNOWN_PLATFORM';
    throw e;
  }
  try {
    const p = factory();
    const provider = validateShape(p, id);
    cache.set(id, provider);
    return provider;
  } catch (e) {
    // 「还没实现」与「写坏了」要分开说：前者不是错误，后者才是
    const msg = String((e && e.message) || e);
    const missing = e && e.code === 'MODULE_NOT_FOUND' && msg.includes(`'./${id}'`);
    const wrapped = missing
      ? Object.assign(new Error(`驱动未实现（lib/platform/${id}/index.js 不存在）`), { code: 'E_NOT_IMPLEMENTED' })
      : Object.assign(new Error(`${describe(id)} 加载失败：${msg.split('\n')[0]}`), { code: 'E_PROVIDER_LOAD' });
    loadErrors.set(id, wrapped);
    throw wrapped;
  }
}

function loadExternal(spec) {
  const key = `module:${spec}`;
  if (cache.has(key)) return cache.get(key);
  let mod;
  try {
    // 允许相对当前工作目录、也允许绝对路径与包名
    const resolved = spec.startsWith('.') ? path.resolve(process.cwd(), spec) : spec;
    mod = require(resolved);
  } catch (e) {
    throw new Error(`加载外部驱动 ${spec} 失败：${e.message}`);
  }
  const def = mod && mod.default ? mod.default : mod;
  const provider = validateShape(def, (def && def.id) || spec);
  cache.set(key, provider);
  if (provider.id) cache.set(provider.id, provider);
  return provider;
}

/** 可用的内置平台（不含加载失败的） */
function available() {
  return Object.keys(BUILTIN).filter((id) => {
    try { loadBuiltin(id); return true; } catch { return false; }
  });
}

/** 所有内置平台及其状态（`cowbird platform ls` 用） */
function inventory() {
  return Object.keys(BUILTIN).map((id) => {
    try {
      const p = loadBuiltin(id);
      return { id, displayName: p.displayName, version: p.version || '', ok: true, capabilities: p.capabilityList(), external: false };
    } catch (e) {
      return { id, ok: false, error: String(e.message).slice(0, 200), external: false };
    }
  });
}

function currentId() {
  if (cfg.envVal('COWBIRD_PLATFORM_MODULE')) return `module:${cfg.envVal('COWBIRD_PLATFORM_MODULE')}`;
  if (cfg.envVal('COWBIRD_PLATFORM')) return cfg.envVal('COWBIRD_PLATFORM');
  let c = {};
  try { c = cfg.readConfig(); } catch {}
  return c.platform || 'workbuddy';
}

let current = null;

/** 当前平台（单例）。首次调用时解析并缓存。 */
function get() {
  if (current) return current;
  const id = currentId();
  current = id.startsWith('module:') ? loadExternal(id.slice(7)) : loadBuiltin(id);
  return current;
}

/** 显式切换（测试与 `--platform` 用） */
function use(idOrModule) {
  current = String(idOrModule).startsWith('module:')
    ? loadExternal(String(idOrModule).slice(7))
    : loadBuiltin(String(idOrModule));
  return current;
}

function reset() { current = null; }

/**
 * 构造 provider 的 ctx：provider 只从这里拿内核能力，不直接 require 内核模块。
 * 这样以后重构内核也不会波及驱动。
 */
function context(provider) {
  const dir = path.join(cfg.HOME, 'platform', provider.id);
  const store = {
    dir,
    read(name, dflt = null) {
      try { return JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8')); } catch { return dflt; }
    },
    write(name, value) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, name + '.json');
        fs.writeFileSync(f, JSON.stringify(value, null, 1));
        try { fs.chmodSync(f, 0o600); } catch {}
      } catch {}
    },
    remove(name) { try { fs.unlinkSync(path.join(dir, name + '.json')); } catch {} },
  };
  // 平台默认值 ← 用户配置 platforms.<id> 覆盖
  const conf = (() => { try { return cfg.readConfig(); } catch { return {}; } })();
  const userOver = (conf.platforms && conf.platforms[provider.id]) || {};
  const effective = { ...(provider.defaults || {}), ...userOver };
  return {
    provider,
    platform: provider,
    paths: cfg.PATHS,
    config: () => cfg.readConfig(),
    defaults: { ...(provider.defaults || {}) },
    effective,
    store,
    log: () => {},          // 命令层会替换成带前缀的实现
    now: () => Date.now(),
    cfg,                    // 极少数驱动要拼路径/读全局配置，显式给出而不是让它们 require
  };
}

module.exports = { get, use, reset, available, inventory, context, currentId, BUILTIN };
