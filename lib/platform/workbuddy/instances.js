'use strict';
// 实例（= 一个云端会话 = 一个沙箱）的增删改查 + 规格探测。
//
// 控制面接口全在 lib/cloud.js（`/console/as/conversations/*`，cookie + UA 鉴权），这里只做三件事：
//   ① 把服务端的会话对象映射成契约里的 Instance {id, name, status, updatedAt, extra}；
//   ② 建 / 改名 / 删的薄封装（创建接口不认名字，必须建完再 POST 一次 title）；
//   ③ info：进容器读 cgroup，把「看得见的资源」和「真正能用的配额」两组数字一起给出来。
const cloud = require('./lib/cloud');
const config = require('../../config');
const e2b = require('./lib/e2b');
const { logf } = require('./util');
const probe = require('./probe');

/**
 * 会话对象 → Instance。
 * 服务端字段来自 docs/protocol.md 与实测报告：列表里是 `name/title`、`status`、`sessionStatus`、
 * `lastActivityAt`；`/session` 里额外有 `sandboxId/link/cwd/expireAt`。
 * 未知字段一律进 extra —— 内核不认识它们，但 doctor / 调试时需要看。
 *
 * `archived` 同时放在顶层与 extra：`wbsbx ls` 按顶层 `x.archived` 过滤（与 _example 的 Instance 一致）。
 */
function mapConversation(c) {
  if (!c || typeof c !== 'object') return null;
  const x = c.conversation || c;                       // 详情接口偶尔包一层
  const id = x.id !== undefined ? x.id : (x.conversationId !== undefined ? x.conversationId : '');
  const manifest = x.manifest || {};
  return {
    id: String(id),
    name: x.name || x.title || '',
    // status 是会话状态，sessionStatus 是沙箱状态；两个都可能在，优先会话状态
    status: x.status || x.sessionStatus || null,
    updatedAt: x.lastActivityAt || x.updatedAt || x.createdAt || null,
    archived: !!x.archived,
    extra: {
      sessionStatus: x.sessionStatus === undefined ? null : x.sessionStatus,
      archived: !!x.archived,
      createdAt: x.createdAt === undefined ? null : x.createdAt,
      sandboxId: x.sandboxId === undefined ? null : x.sandboxId,
      runtimeId: x.runtimeId === undefined ? null : x.runtimeId,
      acpBackend: x.acpBackend === undefined ? null : x.acpBackend,
      link: x.link === undefined ? null : x.link,
      cwd: x.cwd === undefined ? null : x.cwd,
      expireAt: x.expireAt === undefined ? null : x.expireAt,
      model: manifest.model === undefined ? null : manifest.model,
      agentId: manifest.id === undefined ? null : manifest.id,
      conversationOrigin: x.conversationOrigin === undefined ? null : x.conversationOrigin,
      isPlayground: !!x.isPlayground,
    },
  };
}

/**
 * 列表：以控制面为准。
 * WorkBuddy 没有「列表缓存」这一层（`refresh` 传什么都没区别，照样打控制面），
 * 所以这个参数只是为了让内核的 `wbsbx ls --refresh` 有个统一的形状；
 * 控制面打不通时才退回 conversations.json 的本地缓存并标 `extra.stale`。
 */
async function list(ctx, opts = {}) {
  const log = logf(ctx);
  const refresh = !!opts.refresh;                       // eslint-disable-line no-unused-vars
  try {
    const live = await cloud.listConversations();
    return (live || []).map(mapConversation).filter(Boolean);
  } catch (e) {
    const cached = cloud.cachedConversations();
    if (!cached || !cached.length) throw e;
    log('拉不到会话列表（' + String(e.message).slice(0, 120) + '），返回本地缓存');
    return cached.map((c) => {
      const m = mapConversation(c);
      if (m) m.extra.stale = true;
      return m;
    }).filter(Boolean);
  }
}

async function get(ctx, id) {
  const data = await cloud.getConversation(String(id));
  const inst = mapConversation(data);
  if (!inst || !inst.id) throw new Error(`WorkBuddy 上没有实例 ${id}（控制面返回空）`);
  return inst;
}

async function create(ctx, opts = {}) {
  const log = logf(ctx);
  const name = opts.name === undefined || opts.name === null ? '' : String(opts.name);
  // 模型优先级：显式传的 → 平台默认（wbsbx.json 的 platforms.workbuddy.model 可覆盖）→ cloud.js 的兜底
  const model = opts.model
    || (ctx && ctx.effective && ctx.effective.model)
    || undefined;
  const r = await cloud.createConversation({
    name,
    model,
    prompt: opts.prompt,
  }, log);
  const session = r.session || {};
  return {
    id: String(r.id),
    name,
    status: session.sessionStatus || (r.raw && r.raw.status) || 'idle',
    updatedAt: new Date().toISOString(),
    archived: false,
    extra: {
      sessionStatus: session.sessionStatus === undefined ? null : session.sessionStatus,
      sandboxId: session.sandboxId === undefined ? null : session.sandboxId,
      link: session.link === undefined ? null : session.link,
      cwd: session.cwd === undefined ? null : session.cwd,
      expireAt: session.expireAt === undefined ? null : session.expireAt,
      model: model || (r.raw && r.raw.manifest && r.raw.manifest.model) || null,
      created: true,
    },
  };
}

async function rename(ctx, id, name) {
  const title = String(name === undefined || name === null ? '' : name);
  if (!title) throw new Error('instances.rename 需要非空的名字');
  await cloud.renameConversation(String(id), title);
  // 改名是异步的：紧接着拉详情可能还是旧标题（甚至空）。空名一律沿用我们刚设的值，
  // 否则内核会以为改名失败（cloud.js 的 mergeNames 就是为这个坑写的）。
  const fresh = await get(ctx, id).catch(() => null);
  const base = fresh || { id: String(id), name: '', status: null, updatedAt: new Date().toISOString(), extra: {} };
  return { ...base, name: base.name || title };
}

async function remove(ctx, id, opts = {}) {
  return cloud.deleteConversation(String(id), { archive: !!opts.archive });
}

/**
 * 凭据到期时间（epoch 秒；没有缓存就 null）。
 * 只读本地 token 缓存，**不联网** —— `wbsbx ls` 会为每个实例调一次，不能每条都去打接口。
 * 有这个方法，`ls` / `info` 才会显示「凭据剩余」列（lib/ui.js 的 til() 收的就是秒）。
 */
function expiry(ctx, id) {
  const t = config.readToken(String(id));
  const at = t && Number(t.expireAt);
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * 规格探测：一条 exec 把 cgroup（v1/v2）与可见资源一起取回来。
 *
 * 这是本 provider 最重要的一条：WorkBuddy 两种沙箱的 nproc / MemTotal 会报宿主的值
 * （32 核 / 123 GiB），真实配额只有 4 核 / 8 GiB。只返回一组数字就会误导调用方。
 */
async function info(ctx, id, opts = {}) {
  const log = logf(ctx);
  const sid = String(id);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;

  // 控制面信息拿不到不算失败：容器里的事实才是这条命令的重点
  const inst = await get(ctx, sid).catch(() => null);
  const creds = await cloud.getSession(sid, log);

  const t0 = Date.now();
  const r = await e2b.exec(creds, probe.buildProbeScript(), { timeout: Math.max(1, Math.round(timeoutMs / 1000)) });
  const ms = Date.now() - t0;

  const kv = probe.parseKv(r.out);
  if (!Object.keys(kv).length) {
    throw new Error(`探针没有输出（exit=${r.code}）${String(r.err || '').slice(0, 200)}`);
  }
  const s = probe.summarize(kv);

  // 控制面的事实并进 facts，省得内核再去拉一次详情
  const facts = s.facts.slice();
  if (inst) {
    if (inst.name) facts.unshift({ label: '名字', value: inst.name });
    if (inst.extra.sessionStatus) facts.push({ label: '沙箱状态', value: String(inst.extra.sessionStatus) });
    if (inst.extra.link) facts.push({ label: 'ACP', value: String(inst.extra.link).replace(/^https:\/\//, '') });
  }
  if (creds && creds.expireAt) {
    facts.push({ label: '凭据到期', value: new Date(creds.expireAt * 1000).toISOString() });
  }

  return {
    id: sid,
    name: inst ? inst.name : null,
    status: inst ? inst.status : null,
    visible: s.visible,                  // 看得见：nproc / free / df
    quota: s.quota,                      // 真能用：cgroup 配额
    environment: s.environment,          // 主机名 / 内核 / 虚拟化 / PID1（判代际用）
    warnings: s.warnings,
    facts,
    probe: { ms, code: r.code, err: String(r.err || '').slice(0, 400) || null, raw: kv },
  };
}


/**
 * 续访问凭据（E2B token）。daemon 的 refresh 循环用；平台没有这个概念时驱动不实现它。
 * @returns {Promise<{expireAt:number|null}>}
 */
async function refresh(ctx, id) {
  const d = await cloud.refreshSession(String(id), logf(ctx));
  return { expireAt: d && d.expireAt ? d.expireAt : null };
}

/** 单实例的访问凭据（daemon 的 /api/token/{id} 用） */
async function token(ctx, id) {
  return cloud.getSession(String(id), logf(ctx));
}

module.exports = { mapConversation, list, get, create, rename, remove, expiry, info, refresh, token };
