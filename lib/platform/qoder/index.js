// qoder —— Qoder（qoder.cn）平台驱动。
//
// 形态：**云 agent 会话**（Claude-Code 风格，agent 只会一个 Bash 工具），
//   控制面是 event-sourcing（`/api/v1/remote/sessions/{id}/events`），
//   数据面是沙箱里的 **HTTP MCP**（JSON-RPC，`tools/call bash|file_*|glob|…`）。
//
// 这个驱动刻意**只实现实测过的路径**（见 README.md）：
//   - 有：auth（cookie 快照）/ instances / agent（事件流）/ exec（MCP）/ fs / model
//   - 没有：agent.question —— Qoder 的提问回复路径没能确认，agent.answer 明确抛
//     E_UNSUPPORTED，绝不假装成功，也不写死猜测的 URL。
//
// 依赖：只用 Node 内置（fetch / crypto / fs），不引任何第三方包。
'use strict';
const crypto = require('crypto');
const nodefs = require('fs');
const { defineProvider, CAP, EVENT, execResult, fileEntry } = require('../contract');
const wire = require('./wire');
const { createTransport, AuthError, cookieHeader, mergeSetCookies, readAuth, hasLogin } = require('./http');
const { createTunnel } = require('./mcp');

const VERSION = '1.0.0';
const API = wire.API_PREFIX;

// 唤醒沙箱用的最小消息：让 agent 调一次 bash（沙箱就是在第一次工具调用时创建的）。
// 第二轮换成更明确的措辞 —— 实测 10 次里有 1 次模型只回文字、沙箱没起。
const BOOT_PROMPTS = [
  '执行 `true` 并回复 ok。',
  '请调用 bash 工具执行 `true`，然后回复 ok（不要只用文字回答）。',
];

const AGENT_TIMEOUT_MS = 600e3;      // 一个回合的默认等待上限（10 分钟）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clampSec(v, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Math.min(dflt, max);
  return Math.max(1, Math.min(Math.round(n), max));
}

function apiError(prefix, r) {
  const j = r && r.json;
  const detail = (j && (j.errorMessage || j.message || j.errorCode || j.code)) || String((r && r.text) || '').slice(0, 200);
  const e = new Error(`${prefix}（HTTP ${r && r.status}）${detail ? '：' + detail : ''}`);
  e.code = 'E_HTTP';
  e.status = r && r.status;
  return e;
}

// ---------------- 网络层（可以被 selftest 整体替换） ----------------
//
// 所有网络调用都走 net.*，selftest 用 useFetch(假 fetch) 把它换成离线的，
// 这样连 exec.run 的完整链路都能在无凭据、无网络的情况下验证。
function makeNet(fetchImpl) {
  const transport = createTransport(fetchImpl);
  return {
    request: transport.request,
    stream: transport.stream,
    tunnel: createTunnel({ request: transport.request, fetchImpl }),
  };
}
let net = makeNet(null);
const useFetch = (fn) => { net = makeNet(fn); return net; };

const evPath = (id) => wire.sessionPath(id, '/events');

// ---------------- 公共小工具 ----------------

async function environments(ctx, opts = {}) {
  const cached = ctx.store.read('environments', null);
  if (!opts.force && cached && cached.at && Date.now() - cached.at < 10 * 60e3 && Array.isArray(cached.data)) return cached.data;
  const r = await net.request(ctx, 'GET', `${API}/environments`, { query: { limit: 100 }, timeout: 20000 });
  if (!r.ok) throw apiError('列出环境失败', r);
  const raw = r.json || {};
  const data = Array.isArray(raw) ? raw : (raw.data || raw.environments || []);
  ctx.store.write('environments', { at: Date.now(), data });
  return data;
}

async function defaultEnvironment(ctx) {
  const envs = await environments(ctx);
  const pick = envs.find((e) => e && e.is_default) || envs.find((e) => e && e.type === 'cloud') || envs[0];
  if (!pick || !pick.id) throw new Error('账号下没有可用的云环境（environment）：先到网页端建一个，或用 instances.create 显式传 environmentId');
  return pick.id;
}

async function sessionStatus(ctx, id) {
  try {
    const r = await net.request(ctx, 'GET', wire.sessionPath(id), { timeout: 15000 });
    if (r.ok && r.json) return String(r.json.session_status || '');
  } catch {}
  return '';
}

async function latestSeq(ctx, id) {
  const r = await net.request(ctx, 'GET', evPath(id), { query: { limit: 1 }, timeout: 20000 });
  if (!r.ok) return 0;
  const rows = (r.json && r.json.data) || [];
  return rows.reduce((m, e) => Math.max(m, Number(e && e.sequence_num) || 0), 0);
}

/** 发一条控制指令（interrupt / set_model / session_title_changed …） */
async function controlRequest(ctx, id, request) {
  const requestId = `req-${crypto.randomUUID()}`;
  const body = {
    events: [{
      event_type: 'control_request',
      payload: {
        type: 'control_request',
        request_id: requestId,
        request: request || {},
        uuid: `control-request:${crypto.randomUUID()}`,
      },
    }],
  };
  const r = await net.request(ctx, 'POST', evPath(id), { body, timeout: 25000 });
  if (!r.ok) throw apiError('发控制指令失败', r);
  return { requestId, results: (r.json && r.json.results) || [] };
}

/** 发一条用户消息（POST /events，实测 201/200 + results[{event_id,sequence_num}]） */
async function sendUser(ctx, id, opts = {}) {
  const text = String(opts.text == null ? (opts.message == null ? '' : opts.message) : opts.text);
  if (!text.trim()) throw new Error('要发的消息是空的');
  const uuid = `controller-user:${crypto.randomUUID()}`;
  const body = {
    events: [{
      event_type: 'user',
      payload: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        uuid,
        session_id: '',            // 实测就是空串，让服务端自己填
      },
    }],
  };
  const r = await net.request(ctx, 'POST', evPath(id), { body, timeout: 25000 });
  if (!r.ok) throw apiError('发消息失败', r);
  const first = (r.json && r.json.results && r.json.results[0]) || {};
  const seq = Number(first.sequence_num);
  return { ok: true, eventId: first.event_id || null, sequenceNum: Number.isFinite(seq) ? seq : null, uuid };
}

/**
 * 事件流：轮询 `GET /sessions/{id}/events?after_sequence_num=` 拿增量，
 * 映射成归一化事件后逐条 yield，拿到 done 就收尾。
 *
 * 两个反直觉的地方：
 *   - 事件接口**默认倒序**，所以每次都按 sequence_num 重新排序，靠游标过滤；
 *   - `after_sequence_num` 是我们自己的游标 —— 发新消息时用 POST 返回的
 *     sequence_num 起算，这样绝不会把历史当本轮重放。
 */
async function* streamImpl(ctx, id, opts = {}) {
  const t0 = Date.now();
  const timeoutMs = Number(opts.timeoutMs) > 0
    ? Number(opts.timeoutMs)
    : (Number(opts.timeout) > 0 ? Number(opts.timeout) * 1000 : AGENT_TIMEOUT_MS);
  const interval = Math.max(400, Math.min(Number(opts.intervalMs) || 1000, 5000));
  const signal = opts.signal || null;
  const cursorKey = `cursor_${id}`;

  let cursor = Number.isFinite(Number(opts.afterSequenceNum))
    ? Number(opts.afterSequenceNum)
    : (Number(ctx.store.read(cursorKey, 0)) || 0);

  if (typeof opts.text === 'string' && opts.text.trim()) {
    const sent = await sendUser(ctx, id, { text: opts.text });
    if (Number.isFinite(sent.sequenceNum)) {
      cursor = sent.sequenceNum;
    } else {
      // 少见：POST 没回 sequence_num。那就问一下最新序号，别让旧历史被当成本轮重放。
      cursor = await latestSeq(ctx, id);
    }
    ctx.store.write(cursorKey, cursor);
  } else if (!cursor && !opts.replay) {
    // 没有游标又没给消息：先问最新一条的序号，避免把整段历史当新事件刷出来
    cursor = await latestSeq(ctx, id);
    ctx.store.write(cursorKey, cursor);
  }

  let done = false;
  let sawWork = false;
  let idleHint = false;
  let lastFreshAt = Date.now();
  const sseCtl = new AbortController();
  let sse = null;

  // 可选：订阅全局状态 SSE，只用来「早点知道会话 idle」，内容永远以事件为准
  if (opts.systemEvents) {
    sse = net.stream(ctx, `${API}/system-events/stream`, {
      signal: sseCtl.signal,
      onEvent: (frame) => {
        const d = frame && frame.data && typeof frame.data === 'object' ? (frame.data.data || frame.data) : null;
        if (!d || typeof d !== 'object') return;
        const sid = d.session_id || (d.session && d.session.session_id);
        const st = d.session_status || d.status || (d.session && d.session.session_status);
        if (sid && String(sid) === String(id) && st === 'idle') idleHint = true;
      },
    }).catch(() => {});
  }

  try {
    while (!done) {
      if (signal && signal.aborted) break;
      if (Date.now() - t0 > timeoutMs) {
        yield { kind: EVENT.ERROR, data: { message: `等待回合结束超时（${Math.round(timeoutMs / 1000)}s）`, code: 'E_TIMEOUT' } };
        break;
      }

      const r = await net.request(ctx, 'GET', evPath(id), {
        query: { limit: 200, after_sequence_num: cursor },
        timeout: 25e3,
      });
      if (r.status === 404) {
        yield { kind: EVENT.ERROR, data: { message: `会话 ${id} 不存在（404）`, code: 'E_NOT_FOUND' } };
        break;
      }
      if (!r.ok) {
        yield { kind: EVENT.ERROR, data: { message: `拉事件失败（HTTP ${r.status}）`, code: 'E_HTTP' } };
        break;
      }

      const rows = ((r.json && r.json.data) || []).slice()
        .sort((a, b) => (Number(a && a.sequence_num) || 0) - (Number(b && b.sequence_num) || 0));
      const more = !!(r.json && r.json.has_more);
      let fresh = 0;
      let doneReason = null;

      for (const ev of rows) {
        const seq = Number(ev && ev.sequence_num) || 0;
        if (seq <= cursor) continue;
        cursor = seq;
        fresh++;
        for (const m of wire.mapEvent(ev)) {
          // done 先记下来、不立刻 yield：`thread_status_idle` 之后平台还会补一条
          // `session.usage`（实测 §4.5 的 30→31）。漏掉它，下一轮 stream 就会把这条
          // 旧 usage 当成新回合的花费报出去。
          if (m.kind === EVENT.DONE) {
            if (!doneReason) doneReason = (m.data && m.data.reason) || 'done';
            continue;
          }
          if (m.kind !== EVENT.RAW) sawWork = true;
          yield m;
        }
      }

      if (fresh) { ctx.store.write(cursorKey, cursor); lastFreshAt = Date.now(); }

      if (doneReason) {
        // 尾巴排空：等一小会儿，把 idle 之后紧跟的 usage/raw 收完再收尾
        for (let round = 0; round < 3; round++) {
          await sleep(300);
          const tail = await net.request(ctx, 'GET', evPath(id), {
            query: { limit: 200, after_sequence_num: cursor },
            timeout: 20e3,
          });
          if (!tail.ok) break;
          const trows = ((tail.json && tail.json.data) || []).slice()
            .sort((a, b) => (Number(a && a.sequence_num) || 0) - (Number(b && b.sequence_num) || 0));
          let got = 0;
          for (const ev of trows) {
            const seq = Number(ev && ev.sequence_num) || 0;
            if (seq <= cursor) continue;
            cursor = seq;
            got++;
            for (const m of wire.mapEvent(ev)) {
              if (m.kind === EVENT.DONE) continue;
              yield m;
            }
          }
          ctx.store.write(cursorKey, cursor);
          if (!got) break;
        }
        done = true;
        yield { kind: EVENT.DONE, data: { reason: doneReason } };
        break;
      }

      if (more) continue;

      // 没有新事件但已经在干活：会话状态已 idle 就收尾（防 idle 事件丢失）
      if (!fresh && sawWork && (idleHint || Date.now() - lastFreshAt >= interval * 2)) {
        const st = await sessionStatus(ctx, id);
        if (st === 'idle') {
          done = true;
          yield { kind: EVENT.DONE, data: { reason: 'idle' } };
          break;
        }
      }
      await sleep(interval);
    }
  } finally {
    sseCtl.abort();
    if (sse) { try { await sse; } catch {} }
  }

  if (!done) yield { kind: EVENT.DONE, data: { reason: signal && signal.aborted ? 'aborted' : 'timeout' } };
}

// ---------------- 鉴权 ----------------

function cookieFingerprint(st) {
  const h = cookieHeader(st, 'qoder.cn', '/');
  return h ? crypto.createHash('sha256').update(h).digest('hex').slice(0, 12) : null;
}

/** ttlDays 的入参可能是 ctx、state 或 cookies 数组 —— 都要能算 */
function pickCookies(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.cookies)) return input.cookies;
  if (input && input.store) {
    try { const st = input.store.read('auth', null); return st && Array.isArray(st.cookies) ? st.cookies : []; } catch { return []; }
  }
  return [];
}

const VOLATILE_COOKIE = /^(acw_tc|tgw_l7_route|arms_uid|_?csrf|xsrf-token|qoder_visitor_id)$/i;

/**
 * 登录态还剩几天：只看真正的会话 cookie，跳过网关/防爬那几条
 * （acw_tc 这类 TTL 极短，取了会把结论带偏 —— 和 workbuddy 驱动踩过的坑一样）。
 */
function ttlDaysOf(input) {
  const cookies = pickCookies(input).filter((c) => c && c.name && Number(c.expires) > 0 && !VOLATILE_COOKIE.test(c.name));
  if (!cookies.length) return null;
  const min = Math.min(...cookies.map((c) => Number(c.expires)));
  const now = Date.now() / 1000;
  return min > now ? (min - now) / 86400 : 0;
}

/** 把浏览器导出的 cookies 规整成快照里的形状 */
function normalizeCookies(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && c.name)
    .map((c) => ({
      name: String(c.name),
      value: String(c.value == null ? '' : c.value),
      domain: String(c.domain || '').replace(/^\./, '') || 'qoder.cn',
      path: c.path || '/',
      expires: Number(c.expires) || -1,
      httpOnly: !!c.httpOnly,
      secure: c.secure === undefined ? true : !!c.secure,
      sameSite: c.sameSite || 'Lax',
    }));
}

/** 登录：接受「浏览器导出 / 直接粘 / kernel 注入的 browser 钩子」三种来源 */
async function collectCookies(ctx, opts = {}) {
  const out = { cookies: null, cookie: null, from: null };

  if (Array.isArray(opts.cookies)) {
    out.cookies = normalizeCookies(opts.cookies);
    out.from = 'cookies';
  } else if (opts.cookie || opts.cookieString) {
    out.cookie = String(opts.cookie || opts.cookieString).trim();
    out.from = 'cookie';
  } else if (opts.page && typeof opts.page.context === 'function') {
    // playwright 风格的 page：调用方已经起了浏览器，这里只取 cookie
    const pctx = opts.page.context();
    out.cookies = normalizeCookies(await pctx.cookies(wire.ORIGIN));
    out.from = 'browser';
  } else if (ctx && ctx.browser && typeof ctx.browser.cookies === 'function') {
    // 内核如果愿意注入浏览器能力，就优先用它（驱动自己不 require 浏览器模块）
    out.cookies = normalizeCookies(await ctx.browser.cookies(wire.ORIGIN));
    out.from = 'browser';
  } else if (opts.cookieMap && typeof opts.cookieMap === 'object') {
    out.cookies = normalizeCookies(Object.entries(opts.cookieMap).map(([name, value]) => ({ name, value })));
    out.from = 'map';
  }

  const usable = out.cookie ? out.cookie : cookieHeader({ cookies: out.cookies || [] }, 'qoder.cn', '/');
  if (!usable) {
    const e = new Error(
      '没有拿到 qoder.cn 的 cookie。三种给法任选：\n' +
      '  1) 浏览器登录后把 Cookie 头整条粘进来：wbsbx login --cookie "name=value; name2=value2"\n' +
      '  2) 由内核起浏览器后把 cookies 数组传进来（auth.browser 能力位就是为这个声明的）\n' +
      '  3) 把已登录浏览器的 profile 里的 qoder.cn cookie 导出成 JSON 再导入'
    );
    e.code = 'E_NO_COOKIE';
    throw e;
  }
  return out;
}

// ---------------- 实例（= Qoder 会话） ----------------

const instances = {
  async list(ctx, opts = {}) {
    const pageSize = Math.min(Math.max(Number(opts.limit) || 100, 1), 100);
    const max = Math.max(Number(opts.max) || 200, 1);
    const out = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const r = await net.request(ctx, 'GET', `${API}/sessions`, {
        query: { sort_by: 'updated_at', offset, limit: pageSize },
        timeout: 25000,
      });
      if (!r.ok) throw apiError('列出会话失败', r);
      const rows = (r.json && r.json.data) || [];
      out.push(...rows.map(wire.instanceFromSession));
      offset += rows.length;
      if (!rows.length || !r.json.has_more || out.length >= max) break;
    }
    return out;
  },

  async get(ctx, id) {
    const r = await net.request(ctx, 'GET', wire.sessionPath(id), { timeout: 20000 });
    if (r.status === 404) {
      const e = new Error(`Qoder 没有会话 ${id}`);
      e.code = 'E_NOT_FOUND';
      throw e;
    }
    if (!r.ok) throw apiError('读会话失败', r);
    return wire.instanceFromSession(r.json || {});
  },

  /**
   * 建会话。内核约定签名是 create(ctx, {name, model, prompt}, {log})：
   * 平台的创建接口不收首条消息，所以 prompt 在建完之后用（实测过的）POST events 补发。
   * 补发失败不算创建失败 —— 会话已经建出来了，把原因放进 extra.promptError 里报上去。
   */
  async create(ctx, opts = {}, meta = {}) {
    const log = (meta && meta.log) || (() => {});
    const title = String(opts.name || opts.title || 'wbsbx').trim() || 'wbsbx';
    const environmentId = opts.environmentId || opts.environment_id || await defaultEnvironment(ctx);
    const model = opts.model || ctx.defaults.model || 'qfmodel';
    const workMode = opts.workMode || opts.work_mode || ctx.defaults.workMode || 'general';
    const body = {
      title,
      origin: 'web',
      environment_id: environmentId,
      session_context: { model, work_mode: workMode },
    };
    if (opts.permissionMode) body.session_context.permission_mode = opts.permissionMode;
    const r = await net.request(ctx, 'POST', `${API}/sessions`, { body, timeout: 25000 });
    if (r.status !== 201 && !r.ok) throw apiError('创建会话失败', r);

    const inst = wire.instanceFromSession(r.json || {});
    const prompt = opts.prompt == null ? '' : String(opts.prompt).trim();
    if (prompt) {
      try {
        await sendUser(ctx, inst.id, { text: prompt });
        inst.extra.promptSent = true;
        log(`已把首条指令发给 ${inst.id}`);
        // 实测：Qoder 会拿首条消息自动改标题，把用户起的名字冲掉（`create --name x` 之后
        // `exec x` 就找不到实例）。这里补一次改名把它压回去；压不住也不影响用 id 操作。
        try {
          const back = await this.rename(ctx, inst.id, title);
          inst.name = back.name || inst.name;
          inst.extra.titleRestored = true;
        } catch (e) {
          inst.extra.titleRestored = false;
          log('注意：平台可能随后又把标题改成了首条消息的内容，用 id 更稳');
        }
      } catch (e) {
        inst.extra.promptSent = false;
        inst.extra.promptError = String(e.message || e).slice(0, 200);
        log(`会话已建好，但首条指令没发出去：${inst.extra.promptError}`);
      }
    }
    return inst;
  },

  /**
   * 改名。两条路都试（README 里写明「未单独实测」）：
   *   A) PATCH /sessions/{id} {title}   —— 会话对象本身有 title，PATCH {pinned} 已确认存在
   *   B) 控制指令 session_title_changed —— 报告 §4.2 记录的控制器指令
   * 成功与否以「重新 GET 一眼标题变没变」为准，不靠 HTTP 码猜。
   */
  async rename(ctx, id, title) {
    const name = String(title == null ? '' : title).trim();
    if (!name) throw new Error('新标题不能为空');
    const errors = [];

    try {
      const r = await net.request(ctx, 'PATCH', wire.sessionPath(id), { body: { title: name }, timeout: 20000 });
      if (r.ok) {
        const cur = await instances.get(ctx, id);
        if (cur.name === name) return { ...cur, via: 'patch' };
        errors.push('PATCH 返回 2xx 但标题没变');
      } else {
        errors.push(`PATCH HTTP ${r.status}`);
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      errors.push('PATCH ' + e.message);
    }

    try {
      await controlRequest(ctx, id, { subtype: 'session_title_changed', title: name, source: 'custom' });
      const cur = await instances.get(ctx, id);
      if (cur.name === name) return { ...cur, via: 'control_request' };
      errors.push('session_title_changed 已发但标题没变');
    } catch (e) {
      if (e instanceof AuthError) throw e;
      errors.push('control_request ' + e.message);
    }

    const e = new Error(`改名失败（两条路径都没成）：${errors.join('；')}`);
    e.code = 'E_RENAME';
    throw e;
  },

  /**
   * 删除 / 归档。内核约定 remove(ctx, id, {archive})。
   * 归档走 `POST …/{id}/archive`（报告 §3.3 只记到代码级，未单独实测）：
   * 它不认就退回 DELETE —— 宁可真删掉，也不要让 `rm --archive` 假装成功。
   */
  async remove(ctx, id, opts = {}) {
    const archive = !!(opts && opts.archive);
    if (archive) {
      const a = await net.request(ctx, 'POST', wire.sessionPath(id, '/archive'), { timeout: 25000 });
      if (a.ok || a.status === 204) {
        try { ctx.store.remove(`tunnel_${id}`); ctx.store.remove(`cursor_${id}`); } catch {}
        return true;
      }
      if (a.status !== 404 && a.status !== 405 && a.status !== 400) throw apiError('归档会话失败', a);
    }
    const r = await net.request(ctx, 'DELETE', wire.sessionPath(id), { timeout: 25000 });
    if (r.status === 404) return true;                       // 已经没了就是目标达成
    if (r.status !== 204 && !r.ok) throw apiError('删除会话失败', r);
    try { ctx.store.remove(`tunnel_${id}`); ctx.store.remove(`cursor_${id}`); } catch {}
    return true;
  },

  /**
   * 单实例详情。能 exec 就读 cgroup 给「可见 / 配额」两组数；
   * 沙箱没起（Qoder 的常态）就诚实返回 {ready:false}，不编数字。
   */
  async info(ctx, id) {
    const base = [
      { label: '平台', value: 'Qoder（qoder.cn）' },
      { label: '会话', value: String(id) },
    ];
    let p;
    try {
      p = await net.tunnel.probe(ctx, id);
    } catch (e) {
      return { ready: false, reason: String(e.message || e), facts: [...base, { label: '探测失败', value: String(e.message || e).slice(0, 200) }] };
    }

    if (!p.ready) {
      return {
        ready: false,
        reason: p.reason || 'not_ready',
        facts: [
          ...base,
          {
            label: '沙箱',
            value: p.reason === 'catalog_unavailable'
              ? '这个端口不开放隧道（平台的策略）'
              : '未启动 —— Qoder 只在第一次工具调用时才创建沙箱，先跑 wbsbx wake',
          },
        ],
      };
    }

    try {
      const r = await exec.run(ctx, id, { command: wire.PROBE_SCRIPT, timeout: 60 });
      const cap = wire.parseCapacity(r.out);
      return {
        ready: true,
        visible: cap.visible,
        quota: cap.quota,
        facts: [
          ...base,
          { label: '沙箱 ID', value: p.sandboxId || '（未知）' },
          { label: '内核', value: cap.facts.kernel || '未知' },
          { label: '虚拟化', value: cap.facts.virt || '未知（kvm 与 docker 两代混跑）' },
          { label: '身份/工作目录', value: `uid=${cap.facts.uid || '?'} cwd=${cap.facts.cwd || '?'}` },
          { label: 'boot', value: cap.facts.bootId ? `${String(cap.facts.bootId).slice(0, 8)} / uptime ${cap.facts.uptimeSec || '?'}s` : '未知' },
        ],
        raw: { probe: cap.raw, execMs: r.ms },
      };
    } catch (e) {
      return {
        ready: false,
        reason: String(e.message || e),
        facts: [...base, { label: '探测失败', value: String(e.message || e).slice(0, 200) }],
      };
    }
  },
};

// ---------------- 对话 ----------------

const agent = {
  send(ctx, id, opts) { return sendUser(ctx, id, opts); },

  stream(ctx, id, opts) { return streamImpl(ctx, id, opts); },

  /** 中断当前回合：control_request{subtype:'interrupt'}（实测被接受） */
  async interrupt(ctx, id) {
    const r = await controlRequest(ctx, id, { subtype: 'interrupt' });
    return { ok: true, requestId: r.requestId };
  },

  /**
   * 回答 agent 的提问 —— **未实现**。
   *
   * 为什么不做：Qoder 的审批/提问回复走的是 `control_response`（报告 §4.3 有形状），
   * 但「提问事件的 request_id 从哪来、回复要带哪些字段」这条链路没有实测过。
   * 猜一个 URL 或格式写进去，比报错更糟 —— 它会静默地发进对话、还可能把会话搞挂。
   * 所以这里明确抛 E_UNSUPPORTED，能力位也不声明 agent.question。
   */
  async answer() {
    const e = new Error(
      'Qoder 驱动不支持回答提问：control_response 的请求/回复链路未实测，实现成「看起来成功」会污染会话。\n' +
      '  临时办法：直接到网页/APP 里点掉那次提问，或用 agent.interrupt 中断这一轮。'
    );
    e.code = 'E_UNSUPPORTED';
    e.capability = CAP.AGENT_QUESTION;
    throw e;
  },

  /** 历史事件（分页读，默认倒序同步成时间序） */
  async history(ctx, id, opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 200);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const r = await net.request(ctx, 'GET', evPath(id), { query: { limit, offset }, timeout: 25000 });
    if (!r.ok) throw apiError('读事件历史失败', r);
    const rows = ((r.json && r.json.data) || []).slice()
      .sort((a, b) => (Number(a && a.sequence_num) || 0) - (Number(b && b.sequence_num) || 0));
    const messages = [];
    for (const ev of rows) {
      for (const m of wire.mapEvent(ev)) {
        if (m.kind === EVENT.TEXT && ev.event_type === 'assistant') messages.push({ role: 'assistant', text: m.data.text, seq: ev.sequence_num, at: ev.created_at || null });
        else if (m.kind === EVENT.THINKING) messages.push({ role: 'thinking', text: m.data.text, seq: ev.sequence_num, at: ev.created_at || null });
      }
      if (ev.event_type === 'user' && ev.source === 'controller') {
        const text = (((ev.payload || {}).message || {}).content || [])
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text) messages.push({ role: 'user', text, seq: ev.sequence_num, at: ev.created_at || null });
      }
    }
    return { messages, nextCursor: r.json && r.json.has_more ? String(offset + rows.length) : null, events: rows };
  },

  /** 全局会话状态 SSE（内容层面的东西还得靠轮询事件） */
  async *systemEvents(ctx, opts = {}) {
    const queue = [];
    let closed = false;
    let waiter = null;
    const kick = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
    const ctl = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) ctl.abort();
      else opts.signal.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    const pump = net.stream(ctx, `${API}/system-events/stream`, {
      signal: ctl.signal,
      timeout: Number(opts.timeoutMs) || 0,
      onEvent: (f) => { queue.push(f); kick(); },
    }).catch((e) => { queue.push({ error: e }); }).finally(() => { closed = true; kick(); });

    try {
      for (;;) {
        while (queue.length) {
          const f = queue.shift();
          if (f.error) {
            yield { kind: EVENT.ERROR, data: { message: String(f.error.message || f.error), code: 'E_STREAM' } };
            continue;
          }
          yield { kind: EVENT.RAW, data: { raw: f.data, event: f.event } };
        }
        if (closed) break;
        await new Promise((r) => { waiter = r; setTimeout(r, 20000); });
      }
    } finally {
      ctl.abort();
      try { await pump; } catch {}
    }
  },
};

// ---------------- exec（沙箱 MCP 数据面） ----------------

function toolArgs(command, sec, workDir, env, onTimeout) {
  const a = { command, timeout: sec, on_timeout: onTimeout };
  if (workDir) a.work_dir = String(workDir);
  if (env && typeof env === 'object' && Object.keys(env).length) a.env = env;
  return a;
}

/**
 * 超时：内核传的是 `timeoutMs`（毫秒），手写脚本习惯传秒；两个都收。
 * MCP bash 的上限是 600 秒（实测：默认 120 / 最大 600）。
 */
function secsOf(opts, dflt = 120) {
  const o = opts || {};
  const ms = Number(o.timeoutMs != null ? o.timeoutMs : o.timeout_ms);
  if (Number.isFinite(ms) && ms > 0) return clampSec(Math.max(1, Math.round(ms / 1000)), 600, dflt);
  return clampSec(o.timeout, 600, dflt);
}

/** 工作目录：内核叫 cwd，MCP 叫 work_dir */
function workDirOf(opts) {
  const o = opts || {};
  return o.cwd || o.workDir || o.work_dir || null;
}

const exec = {
  /**
   * 隧道是否就绪：preview/grant 200 = 沙箱在跑（503 CloudSandboxNotReady = 还没起）。
   * 同时给 `reason` 与 `why`：内核的编排层读 `why`，人读 `reason`。
   */
  async probe(ctx, id) {
    const p = await net.tunnel.probe(ctx, id);
    return { ...p, why: p.ready ? null : (p.reason || 'not-ready') };
  },

  /**
   * 唤醒：发一条最小消息让 agent 调一次 bash（沙箱随之创建），然后重新 probe。
   * 实测 10 次里 1 次模型只回文字、没调工具 → 所以默认给两轮，第二轮换更明确的措辞。
   * 返回 {ready:false} 而不抛：这是「状态」不是「异常」。
   */
  async wake(ctx, id, opts = {}) {
    const attempts = Math.max(1, Math.min(Number(opts.attempts) || 2, 4));
    const timeoutMs = Number(opts.timeoutMs) || 120e3;
    const t0 = Date.now();

    let p = await net.tunnel.probe(ctx, id);
    if (p.ready) return { ready: true, already: true, attempts: 0, ms: Date.now() - t0, url: p.url, why: null };

    let last = p.reason || 'not_ready';
    for (let i = 0; i < attempts; i++) {
      const text = BOOT_PROMPTS[Math.min(i, BOOT_PROMPTS.length - 1)];
      try {
        for await (const ev of streamImpl(ctx, id, { text, timeoutMs })) {
          if (opts.onEvent) opts.onEvent(ev);
          if (ev.kind === EVENT.DONE) break;
        }
      } catch (e) {
        last = String(e.message || e);
      }
      p = await net.tunnel.probe(ctx, id);
      if (p.ready) return { ready: true, already: false, attempts: i + 1, ms: Date.now() - t0, url: p.url, why: null };
      last = p.reason || last;
      // 沙箱创建到端口可用可能有几秒延迟：再等一拍重新探一次，别急着发第二条消息
      await sleep(1500);
      p = await net.tunnel.probe(ctx, id);
      if (p.ready) return { ready: true, already: false, attempts: i + 1, ms: Date.now() - t0, url: p.url, why: null };
      last = p.reason || last;
    }
    return { ready: false, already: false, attempts, reason: last, why: last, ms: Date.now() - t0 };
  },

  /** 同步执行：包装脚本 → MCP tools/call bash → 解出 out/err/code */
  async run(ctx, id, opts = {}) {
    const sec = secsOf(opts, 120);
    const t0 = Date.now();
    let res;
    try {
      res = await net.tunnel.call(ctx, id, 'bash',
        toolArgs(wire.wrapCommand(opts.command), sec, workDirOf(opts), opts.env, 'kill'),
        { timeout: sec * 1000 + 30e3 });
    } catch (e) {
      if (e.code === 'E_NOT_READY') {
        const x = new Error('沙箱还没起来：Qoder 只在第一次工具调用时创建沙箱。先跑 wbsbx wake <实例>（或 exec --wake）再执行。');
        x.code = 'E_NOT_READY';
        x.reason = e.reason;
        throw x;
      }
      throw e;
    }

    const p = wire.parseWrapper(res.text);
    let err = p.err;
    if (p.code === null && !err && (res.isError || p.truncated)) err = '没有拿到退出码（可能被超时 kill 或输出被截断）';
    return execResult({
      out: p.out,
      err,
      code: p.code,
      ms: Date.now() - t0,
      truncated: p.truncated || (p.code === null && res.isError),
    });
  },

  /**
   * 后台执行：用 MCP 原生的 on_timeout=background 拿 pid + output_file，
   * 之后 exec.poll 用 file_read 读输出、用 kill -0 判活。
   * 若命令在 grace 秒内就跑完了，直接把它当「已完成的任务」存下来，poll 立刻返回结果。
   */
  async start(ctx, id, opts = {}) {
    const grace = clampSec(opts.graceMs, 600, 3);
    const t0 = Date.now();
    const res = await net.tunnel.call(ctx, id, 'bash',
      toolArgs(wire.wrapCommand(opts.command), grace, workDirOf(opts), opts.env, 'background'),
      { timeout: grace * 1000 + 40e3 });

    const p = wire.parseWrapper(res.text);
    const jobId = p.backgrounded && p.pid ? String(p.pid) : `local-${crypto.randomUUID().slice(0, 8)}`;
    const jobs = ctx.store.read('jobs', {}) || {};

    if (p.backgrounded) {
      jobs[jobId] = {
        pid: p.pid,
        outputPath: p.outputFile,
        command: String(opts.command || ''),
        sessionId: String(id),
        startedAt: Date.now(),
        done: false,
      };
    } else {
      jobs[jobId] = {
        pid: null,
        outputPath: null,
        command: String(opts.command || ''),
        sessionId: String(id),
        startedAt: t0,
        finishedAt: Date.now(),
        done: true,
        out: p.out,
        err: p.err,
        code: p.code,
      };
    }
    trimJobs(jobs);
    ctx.store.write('jobs', jobs);

    return {
      jobId,
      outputPath: p.backgrounded ? p.outputFile : null,
      backgrounded: !!p.backgrounded,
      pid: p.pid || null,
      ms: Date.now() - t0,
    };
  },

  /**
   * 轮询后台任务。内核（lib/platform/exec.js 的 follow）会把 start 返回的**整个 job 对象**
   * 传回来，手写脚本习惯传 `{jobId}` —— 两种都收。
   */
  async poll(ctx, id, opts = {}) {
    const jobs = ctx.store.read('jobs', {}) || {};
    const jobKey = opts && typeof opts === 'object' ? (opts.jobId != null ? opts.jobId : opts.id) : opts;
    const key = String(jobKey == null ? '' : jobKey);
    const job = jobs[key];
    if (!job) {
      const e = new Error(`未知的后台任务 ${key || '(空)'}`);
      e.code = 'E_NO_JOB';
      throw e;
    }
    if (job.done) return { done: true, out: job.out || '', err: job.err || '', code: job.code === undefined ? null : job.code };

    const alive = await pidAlive(ctx, job.sessionId || id, job.pid);
    let text = '';
    if (job.outputPath) {
      try {
        const r = await net.tunnel.call(ctx, job.sessionId || id, 'file_read', { file_path: job.outputPath }, { timeout: 60e3 });
        // 输出文件可能还没被创建出来（刚 background、或已被清理）：当「暂时没输出」，
        // 不要把 file_read 的报错文本当成命令输出。
        text = r.isError ? '' : r.text;
      } catch (e) {
        if (e.code !== 'E_NOT_READY') throw e;   // 沙箱没了就只能认命，把已读到的返回
      }
    }
    const p = wire.parseWrapper(text);
    if (!alive) {
      job.done = true;
      job.finishedAt = Date.now();
      job.out = p.out;
      job.err = p.err;
      job.code = p.code;
      ctx.store.write('jobs', jobs);
    }
    return { done: !!job.done, out: p.out, err: p.err, code: p.code === undefined ? null : p.code, outputPath: job.outputPath || null };
  },

  /** 上传：文本走 file_write；二进制走 base64 分块经 bash 落盘（FUSE 挂载不支持 mmap 写） */
  async put(ctx, id, opts = {}) {
    const localPath = String(opts.localPath || '');
    const remotePath = String(opts.remotePath || opts.path || '');
    if (!localPath) throw new Error('exec.put 缺 localPath');
    if (!remotePath) throw new Error('exec.put 缺 remotePath');
    const buf = nodefs.readFileSync(localPath);
    const text = buf.toString('utf8');
    const binary = !Buffer.from(text, 'utf8').equals(buf) || buf.includes(0);

    if (!binary) {
      const r = await net.tunnel.call(ctx, id, 'file_write', { file_path: remotePath, content: text }, { timeout: 120e3 });
      if (r.isError) throw new Error(`写远端文件失败：${r.text.slice(0, 200)}`);
      return { size: buf.length, encoding: 'utf8', mode: 'file_write' };
    }

    if (buf.length > 16 * 1024 * 1024) {
      const e = new Error(`文件太大（${buf.length} 字节）：二进制上传上限 16 MiB，再大先用 exec 里的 tar/gzip 方案`);
      e.code = 'E_TOO_LARGE';
      throw e;
    }
    const dir = remotePath.replace(/\/[^/]*$/, '') || '/';
    const mk = await exec.run(ctx, id, { command: `mkdir -p -- ${wire.shellQuote(dir)}`, timeoutMs: 30000 });
    if (mk.code !== 0) throw new Error(`建目录失败：${mk.err || mk.out}`);

    const chunkMs = secsOf(opts, 120) * 1000;
    const b64 = buf.toString('base64');
    const CHUNK = 192 * 1024;
    let first = true;
    for (let i = 0; i < b64.length; i += CHUNK) {
      const piece = b64.slice(i, i + CHUNK);
      const cmd = `printf %s ${wire.shellQuote(piece)} | base64 -d ${first ? '>' : '>>'} ${wire.shellQuote(remotePath)}`;
      const r = await exec.run(ctx, id, { command: cmd, timeoutMs: chunkMs });
      if (r.code !== 0) throw new Error(`写二进制分块失败（第 ${i / CHUNK + 1} 块）：${r.err || r.out}`);
      first = false;
    }
    return { size: buf.length, encoding: 'base64', mode: 'bash' };
  },

  /**
   * 下载：**一律走 base64**（无损，文本/二进制都行）。
   * 不能用 file_read 落盘 —— 它的输出带行号（实测把 "qoder fs test" 存成 "1\tqoder fs test"）。
   */
  async get(ctx, id, opts = {}) {
    const remotePath = String(opts.remotePath || opts.path || '');
    const localPath = String(opts.localPath || '');
    if (!remotePath) throw new Error('exec.get 缺 remotePath');
    if (!localPath) throw new Error('exec.get 缺 localPath');

    const r = await exec.run(ctx, id, { command: `base64 -w0 -- ${wire.shellQuote(remotePath)}`, timeoutMs: secsOf(opts, 120) * 1000 });
    if (r.code !== 0) throw new Error(`读远端文件失败：${r.err || r.out}`);
    const buf = Buffer.from(String(r.out).replace(/\s+/g, ''), 'base64');
    nodefs.writeFileSync(localPath, buf);
    return { size: buf.length, encoding: 'binary' };
  },

  /** MCP 工具清单（能力探测；实测 14 个，两代沙箱都是 sandbox-runtime-tools 0.1.0） */
  async tools(ctx, id) {
    return net.tunnel.listTools(ctx, id);
  },
};

/** kill -0 判活：拿不到 pid 就当还活着（宁可多等一轮，也不要误报完成） */
async function pidAlive(ctx, id, pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true;
  const r = await net.tunnel.call(ctx, id, 'bash', { command: `kill -0 ${n} 2>/dev/null && echo ALIVE || echo GONE`, timeout: 15 }, { timeout: 45e3 });
  return /ALIVE/.test(r.text);
}

function trimJobs(jobs) {
  const keys = Object.keys(jobs);
  if (keys.length <= 50) return;
  keys.sort((a, b) => (jobs[a].startedAt || 0) - (jobs[b].startedAt || 0))
    .slice(0, keys.length - 50)
    .forEach((k) => { delete jobs[k]; });
}

// ---------------- fs（同样走 MCP，不经过 agent） ----------------

/** glob 的输出是纯文本行；带 `[backgrounded]` 之类提示的行要滤掉 */
function parseGlob(text, basePath) {
  const base = String(basePath || '/').replace(/\/+$/, '') || '';
  const out = [];
  const seen = new Set();
  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('[') || line.startsWith('(') || /^no matches/i.test(line)) continue;
    const isDir = /\/$/.test(line);
    line = line.replace(/\/+$/, '');
    const abs = line.startsWith('/') ? line : `${base}/${line.replace(/^\.\//, '')}`;
    const norm = abs.replace(/\/{2,}/g, '/');
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(fileEntry({ path: norm, name: norm.split('/').pop(), type: isDir ? 'dir' : 'file', size: null, mtime: null }));
  }
  return out;
}

const fsApi = {
  /** 列目录：MCP glob（pattern 默认 `*`，recursive 时 `**​/*`） */
  async list(ctx, id, opts = {}) {
    const path = String(opts.path || ctx.defaults.workDir || '/data');
    const pattern = opts.pattern || (opts.recursive ? '**/*' : '*');
    const r = await net.tunnel.call(ctx, id, 'glob', { pattern, path }, { timeout: 90e3 });
    if (r.isError) throw new Error(`列目录失败：${r.text.slice(0, 200)}`);
    return parseGlob(r.text, path);
  },

  async read(ctx, id, opts = {}) {
    const path = String(opts.path || '');
    if (!path) throw new Error('fs.read 缺 path');
    const args = { file_path: path };
    if (opts.startLine || opts.endLine) {
      args.start_line = Number(opts.startLine) || 1;
      if (opts.endLine) args.end_line = Number(opts.endLine);
    }
    const r = await net.tunnel.call(ctx, id, 'file_read', args, { timeout: 120e3 });
    if (r.isError) throw new Error(`读文件失败：${r.text.slice(0, 200)}`);
    // file_read 的输出带行号（`<n>\t<行>`）；剥掉，否则写下去就是脏数据
    const raw = r.text;
    const content = wire.stripLineNumbers(raw);
    return { path, content, encoding: 'utf8', numbered: content !== raw };
  },

  async write(ctx, id, opts = {}) {
    const path = String(opts.path || '');
    if (!path) throw new Error('fs.write 缺 path');
    const content = String(opts.content == null ? '' : opts.content);
    const r = await net.tunnel.call(ctx, id, 'file_write', { file_path: path, content }, { timeout: 120e3 });
    if (r.isError) throw new Error(`写文件失败：${r.text.slice(0, 200)}`);
    return { path, size: Buffer.byteLength(content) };
  },
};

// ---------------- 模型 ----------------

const model = {
  /** 可用模型来自 environments[].metadata.available_models（实测 14 个，0.04x–1x） */
  async list(ctx) {
    const envs = await environments(ctx);
    const seen = new Map();
    for (const e of envs) {
      const meta = (e && e.metadata) || {};
      for (const m of (meta.available_models || [])) {
        // 条目可能是对象，也可能只是一个模型 id 字符串
        const id = typeof m === 'string' ? m : (m && (m.model_id || m.modelId || m.id || m.model));
        if (!id || seen.has(id)) continue;
        seen.set(String(id), {
          id: String(id),
          name: typeof m === 'string' ? m : String(m.display_name || m.displayName || m.name || id),
          priceFactor: typeof m === 'string' ? null
            : (m.price_factor != null ? m.price_factor : (m.priceFactor != null ? m.priceFactor : null)),
          description: (m && m.description) || null,
          environmentId: (e && e.id) || null,
        });
      }
    }
    const list = [...seen.values()];
    list.sort((a, b) => (Number(a.priceFactor) || 99) - (Number(b.priceFactor) || 99));
    return list;
  },

  async set(ctx, id, name) {
    const m = String(name || '').trim();
    if (!m) throw new Error('要设置的模型名不能为空');
    const r = await controlRequest(ctx, id, { subtype: 'set_model', model: m });
    return { ok: true, model: m, requestId: r.requestId };
  },
};

// ---------------- 鉴权门面（doctor 也要用，先提出来） ----------------

const authApi = {
  async state(ctx) {
    const st = readAuth(ctx);
    const cookies = Array.isArray(st.cookies) ? st.cookies : [];
    const fp = cookieFingerprint(st);
    return {
      token: fp ? `qoder-cookie:${fp}` : null,       // 只放指纹，别把 cookie 打进日志
      savedAt: st.savedAt || null,
      user: st.user || null,
      cookieCount: cookies.length,
      hasCookie: hasLogin(st),
      source: st.source || null,
      ttlDays: ttlDaysOf(st),
    };
  },

  ttlDays(input) {
    return ttlDaysOf(input);
  },

  async login(ctx, opts = {}) {
    const got = await collectCookies(ctx, opts);
    const snap = { savedAt: new Date().toISOString(), source: got.from };
    if (Array.isArray(got.cookies) && got.cookies.length) snap.cookies = got.cookies;
    if (got.cookie) snap.cookie = got.cookie;
    ctx.store.write('auth', snap);
    // 换了账号就不该再用旧账号的环境 id / 模型列表
    try { ctx.store.remove('environments'); } catch {}

    let me = null;
    try {
      const r = await net.request(ctx, 'GET', '/api/v1/me', { timeout: 20000 });
      if (!r.ok) {
        ctx.store.remove('auth');
        const e = new Error(`cookie 保存了但 /api/v1/me 返回 HTTP ${r.status}：这份登录态不可用`);
        e.code = 'E_AUTH';
        e.status = r.status;
        throw e;
      }
      me = r.json || null;
    } catch (e) {
      if (e instanceof AuthError) {
        ctx.store.remove('auth');
        const x = new Error(`这份 cookie 拿不到 /api/v1/me：${e.message}`);
        x.code = 'E_AUTH';
        throw x;
      }
      throw e;
    }

    const withUser = { ...snap, user: me ? { id: me.id || null, name: me.name || null, username: me.username || null } : null };
    ctx.store.write('auth', withUser);
    return { ok: true, user: withUser.user, cookieCount: (withUser.cookies || []).length, savedAt: withUser.savedAt, from: got.from };
  },

  async alive(ctx) {
    try {
      const r = await net.request(ctx, 'GET', '/api/v1/me', { timeout: 15000 });
      return { ok: r.ok, status: r.status, user: r.ok ? (r.json || null) : null };
    } catch (e) {
      return { ok: false, status: 0, reason: String(e.message || e) };
    }
  },

  async logout(ctx) {
    ctx.store.remove('auth');
    ctx.store.remove('environments');
    return true;
  },
};

// ---------------- 驱动定义 ----------------

module.exports = defineProvider({
  id: 'qoder',
  displayName: 'Qoder（qoder.cn）',
  version: VERSION,
  homepage: 'https://qoder.cn',
  notes:
    '云 agent 会话平台。控制面是 event-sourcing，数据面是沙箱 HTTP MCP。' +
    '沙箱只在第一次工具调用时创建，所以 exec 前可能要先 wake（发一条最小消息）。' +
    'agent.answer 未实现（回复提问的链路未实测），调用会抛 E_UNSUPPORTED。',

  capabilities: [
    CAP.AUTH, CAP.LOGIN_BROWSER,
    CAP.LIST, CAP.CREATE, CAP.RENAME, CAP.REMOVE, CAP.META,
    CAP.AGENT, CAP.AGENT_INTERRUPT,
    CAP.EXEC, CAP.EXEC_BG, CAP.WAKE,
    CAP.FS, CAP.MODEL,
  ],

  defaults: {
    model: 'qfmodel',        // Qwen3.8-Flash，0.04x，全场最便宜（实测）
    workMode: 'general',
    execTimeoutSec: 120,
    mcpPort: wire.MCP_PORT,
  },

  // 实测：MCP bash 默认 120s、最大 600s；没有 30s 网关硬顶；原生支持 on_timeout=background
  limits: {
    maxSyncMs: 590000,
    defaultSyncMs: 120000,
    maxBackground: true,
    wakeTimeoutMs: 180e3,
    maxOutputBytes: 4 << 20,
  },

  transport: {
    request: (ctx, method, path, opts) => net.request(ctx, method, path, opts),
    stream: (ctx, path, opts) => net.stream(ctx, path, opts),
    get: (ctx, path, opts) => net.request(ctx, 'GET', path, opts),
    post: (ctx, path, body, opts) => net.request(ctx, 'POST', path, { ...(opts || {}), body }),
    ORIGIN: wire.ORIGIN,
    API_PREFIX: API,
    AuthError,
    cookieHeader,
    mergeSetCookies,
  },

  auth: authApi,

  instances,
  agent,
  exec,
  fs: fsApi,
  model,

  doctor: {
    /** 内核约定签名 checks(ctx, {net})：`--no-net` 时只报本地登录态，一个请求都不发 */
    async checks(ctx, opts = {}) {
      const out = [];
      const net_allowed = opts.net !== false;
      const st = readAuth(ctx);
      const n = Array.isArray(st.cookies) ? st.cookies.length : 0;

      if (!hasLogin(st)) {
        out.push({ level: 'bad', name: '登录态', detail: '没有 cookie：先跑 wbsbx login（或 login --cookie "…"）' });
        return out;
      }
      const ttl = ttlDaysOf(st);
      out.push({
        level: ttl != null && ttl < 1 ? 'warn' : 'ok',
        name: '登录态',
        detail: `${n ? n + ' 条 cookie' : 'cookie 字符串'}，保存于 ${st.savedAt || '未知时间'}${ttl != null ? `，约剩 ${ttl.toFixed(1)} 天` : ''}`,
      });
      if (!net_allowed) {
        out.push({ level: 'info', name: '接口', detail: '未联网校验（--no-net）' });
        return out;
      }

      try {
        const me = await authApi.alive(ctx);
        const name = (me.user && (me.user.name || me.user.username)) || 'ok';
        out.push(me.ok ? { level: 'ok', name: '账号', detail: name } : { level: 'warn', name: '账号', detail: `GET /api/v1/me → HTTP ${me.status}` });
      } catch (e) {
        out.push({ level: 'bad', name: '账号', detail: String(e.message || e) });
      }

      try {
        const envs = await environments(ctx);
        const models = await model.list(ctx);
        const def = envs.find((e) => e && e.is_default) || envs[0] || {};
        out.push({ level: envs.length ? 'ok' : 'warn', name: '环境', detail: `${envs.length} 个（默认 ${def.name || '?'}），${models.length} 个模型` });
      } catch (e) {
        out.push({ level: 'warn', name: '环境', detail: String(e.message || e) });
      }

      try {
        const list = await instances.list(ctx, { limit: 20 });
        out.push({ level: 'ok', name: '会话', detail: `${list.length} 个（本次最多列 20）` });
        const target = list.find((i) => i.status === 'idle') || list[0];
        if (target) {
          const p = await net.tunnel.probe(ctx, target.id);
          out.push(p.ready
            ? { level: 'ok', name: '沙箱隧道', detail: `${target.id} 可用（${p.sandboxId || 'sandbox 未知'}）` }
            : { level: 'warn', name: '沙箱隧道', detail: `${target.id} 未就绪：${p.reason}（exec 之前要 wake）` });
        }
      } catch (e) {
        out.push({ level: 'warn', name: '会话', detail: String(e.message || e) });
      }
      return out;
    },
  },

  // 自测用的内部入口：把网络层换成假的，其余逻辑一点不改（见 selftest.js）
  _internals: {
    VERSION,
    wire,
    useFetch,
    net: () => net,
    parseGlob,
    ttlDaysOf,
    normalizeCookies,
    BOOT_PROMPTS,
  },
});
