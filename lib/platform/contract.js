// Provider 契约：内核与平台之间唯一的约定。
//
// 设计原则（见 docs/architecture.md「平台驱动」一节）：
//   1. 内核只认五样东西：Instance / Access / Event / ExecResult / FileEntry；
//   2. exec 是**可选能力**，同步上限由 provider 声明，内核只做「同步 / 后台 / 拒绝」三选一；
//   3. 网络与签名全归 provider，内核连 fetch 都不出现。
//
// 这个文件不 require 任何 provider，也不读配置 —— 只做「形状」和「门禁」。
const CAP = Object.freeze({
  AUTH: 'auth',                    // 有登录态概念
  AUTH_RENEW: 'auth.renew',        // 能自动续期（refresh_token / SSO 各平台自选）
  LIST: 'instances.list',
  CREATE: 'instances.create',
  RENAME: 'instances.rename',
  REMOVE: 'instances.remove',
  META: 'instances.meta',          // 能给单实例详情/规格
  AGENT: 'agent',                  // 有对话通道（必需）
  AGENT_QUESTION: 'agent.question',// 能回答 agent 的提问
  AGENT_INTERRUPT: 'agent.interrupt',
  EXEC: 'exec',                    // 有免 LLM 执行通道
  EXEC_BG: 'exec.background',      // 支持后台任务
  FS: 'fs',                        // 有独立文件通道（可与 exec 复用）
  FS_BINARY: 'fs.binary',          // fs.write 吃 {content, encoding:'base64'}，可无损写二进制
  WAKE: 'exec.wake',               // exec 前需要唤醒沙箱
});

// 归一化事件种类。provider 负责把自家协议映射到这里，内核只消费这些。
const EVENT = Object.freeze({
  STATUS: 'status',            // {status: string}
  TEXT: 'text',                // {text: string}
  THINKING: 'thinking',        // {text: string}
  TOOL: 'tool',                // {id, name, input}
  TOOL_RESULT: 'tool_result',  // {id, name, ok, out}
  QUESTION: 'question',        // {requestId, questions: [{header, question, options:[{label, description}]}]}
  PERMISSION: 'permission',    // {requestId, tool, detail}
  USAGE: 'usage',              // {inputTokens, outputTokens, totalTokens, credits?}
  ARTIFACT: 'artifact',        // {action, uri, name, mimeType, size, sourceTool} 产物文件
  DONE: 'done',                // {reason?: string}
  ERROR: 'error',              // {message, code?}
  RAW: 'raw',                  // {raw: any} 原始事件旁路
});

const REQUIRED = [CAP.LIST, CAP.AGENT];

// 内核认的错误码。**只在这里定义**，驱动与内核都用它，别再各自写字面量。
//   retryable=true 表示"同一请求再来一次可能成功"，由内核决定退避策略。
const ERR = Object.freeze({
  CAPABILITY: 'E_CAPABILITY',      // 平台没这个能力（CLI 退出码 2）
  BUSY: 'E_BUSY',                  // 沙箱在跑，等一下再来
  RATE_LIMIT: 'E_RATE_LIMIT',
  TIMEOUT: 'E_TIMEOUT',
  NETWORK: 'E_NETWORK',
  AUTH: 'E_AUTH',                  // 登录态失效
  NOT_READY: 'E_NOT_READY',        // 沙箱没醒/没建
  NOT_FOUND: 'E_NOT_FOUND',
  AMBIGUOUS: 'E_AMBIGUOUS',
  STORE: 'E_STORE',                // 落盘失败（凭据/配置/登记簿）
  CONFIG_CORRUPT: 'E_CONFIG_CORRUPT',
});

/** 这个错误值不值得重试（内核只看结构化字段，不再匹配人类文案） */
function isRetryable(e) {
  if (!e) return false;
  if (e.retryable === false) return false;
  return e.retryable === true || e.code === ERR.BUSY || e.code === ERR.RATE_LIMIT;
}

const DEFAULT_LIMITS = Object.freeze({
  maxSyncMs: 30e3,        // 单条同步命令的硬上限（provider 覆盖）
  defaultSyncMs: 20e3,    // 未指定 --timeout 时的默认值
  maxBackground: false,   // 是否有原生后台任务
  maxOutputBytes: 1 << 20,
  wakeTimeoutMs: 60e3,    // 唤醒沙箱后等待就绪的上限
});

function fail(id, msg) { throw new Error(`[provider:${id}] ${msg}`); }

/**
 * 定义一个 provider。
 * 返回的对象带 has()/require()，其余字段原样保留；同时做最小一致性校验。
 *
 * @param {object} def
 * @param {string} def.id            稳定标识（目录名、配置键、COWBIRD_PLATFORM 取值）
 * @param {string} def.displayName   给人看的名字
 * @param {string[]} def.capabilities 能力位（CAP.*）
 * @param {object} [def.defaults]    平台默认配置（合并进 cowbird.json 的 platforms.<id>）
 * @param {object} [def.limits]      limits 覆盖
 * @param {object} def.instances     必需
 * @param {object} def.agent         必需
 * @param {object} [def.auth]
 * @param {object} [def.exec]
 * @param {object} [def.fs]
 * @param {object} [def.doctor]
 * @param {object} [def.transport]   本平台专属 HTTP（内核不碰；不参与 CLI 能力判断）
 * @param {boolean} [def.requiresPromptOnCreate] 建会话是否必须带首条指令（只有 WorkBuddy 是 true）
 */
function defineProvider(def) {
  if (!def || typeof def !== 'object') fail('?', 'defineProvider 需要对象');
  const id = String(def.id || '');
  if (!id) fail('?', '缺 id');
  if (!/^[a-z_][a-z0-9_-]*$/.test(id)) fail(id, 'id 只能是小写字母/数字/下划线/连字符（下划线开头的留给内置样例）');
  if (!def.displayName) fail(id, '缺 displayName');

  const caps = new Set(def.capabilities || []);
  for (const c of caps) {
    if (!Object.values(CAP).includes(c)) fail(id, `未知能力位 ${c}`);
  }

  // 必需能力
  for (const need of REQUIRED) if (!caps.has(need)) fail(id, `缺必需能力 ${need}`);

  // 能力与实现必须一致
  const need = (cap, mod, methods) => {
    if (!caps.has(cap)) return;
    if (!def[mod]) fail(id, `声明了 ${cap} 但没有 def.${mod}`);
    for (const m of methods) if (typeof def[mod][m] !== 'function') fail(id, `声明了 ${cap} 但缺 ${mod}.${m}()`);
  };
  need(CAP.LIST, 'instances', ['list']);
  need(CAP.CREATE, 'instances', ['create']);
  need(CAP.RENAME, 'instances', ['rename']);
  need(CAP.REMOVE, 'instances', ['remove']);
  need(CAP.META, 'instances', ['get']);
  need(CAP.AGENT, 'agent', ['stream', 'send']);
  need(CAP.AGENT_QUESTION, 'agent', ['answer']);
  need(CAP.AGENT_INTERRUPT, 'agent', ['interrupt']);
  need(CAP.EXEC, 'exec', ['probe', 'run']);
  need(CAP.EXEC_BG, 'exec', ['start', 'poll']);
  need(CAP.WAKE, 'exec', ['wake']);
  need(CAP.FS, 'fs', ['list', 'read']);
  need(CAP.FS_BINARY, 'fs', ['write']);
  need(CAP.AUTH, 'auth', ['state']);

  const limits = { ...DEFAULT_LIMITS, ...(def.limits || {}) };
  if (!(limits.maxSyncMs > 0)) fail(id, 'limits.maxSyncMs 必须大于 0');
  if (limits.defaultSyncMs > limits.maxSyncMs) limits.defaultSyncMs = limits.maxSyncMs;

  return {
    ...def,
    id,
    capabilities: caps,
    defaults: def.defaults || {},
    limits,
    // 建实例时是否必须带一条指令（WorkBuddy 的建会话接口要求 prompt；Qoder/码道不要求）。
    // 不要求时命令层就不发 —— 免得白白花一轮，也免得平台拿首条消息去自动改标题。
    requiresPromptOnCreate: def.requiresPromptOnCreate === true,
    has: (c) => caps.has(c),
    require(c) {
      if (!caps.has(c)) {
        const e = new Error(`本平台 ${def.displayName} 不支持 ${c}`);
        e.code = ERR.CAPABILITY;
        e.capability = c;
        throw e;
      }
      return true;
    },
    /** 给人看的能力清单（doctor / platform 命令用） */
    capabilityList: () => [...caps].sort(),
  };
}

/** 统一的 exec 结果形状 */
function execResult({ out = '', err = '', code = null, ms = 0, truncated = false } = {}) {
  return { out: String(out), err: String(err), code: code === undefined ? null : code, ms, truncated };
}

/** 统一的文件条目形状 */
function fileEntry({ path, name, type = 'file', size = null, mtime = null } = {}) {
  return { path, name: name || String(path || '').split('/').pop() || '', type, size, mtime };
}

/** 把任意异常翻成 {kind:'error'} 事件，避免 provider 里到处 try/catch */
function errorEvent(e) {
  return { kind: EVENT.ERROR, data: { message: String((e && e.message) || e), code: (e && e.code) || null } };
}

module.exports = {
  CAP, EVENT, ERR, REQUIRED, DEFAULT_LIMITS,
  defineProvider, execResult, fileEntry, errorEvent, isRetryable,
};
