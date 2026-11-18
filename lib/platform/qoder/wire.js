// Qoder 协议里的纯逻辑：事件映射、grant/JWT 解析、隧道 URL 拼装、
// cgroup/容量读数、exec 包装脚本与 MCP 结果解包、SSE 帧解析。
//
// 这个文件**不碰网络、不碰磁盘、不读环境**，所以 selftest.js 能拿假数据把
// 每一块都验一遍（这也是为什么协议相关的判断全都被搬到这里）。
//
// 协议事实来源：同目录 README.md 的「实测」章节（2026-11-17 全量实测）。
'use strict';
const { EVENT } = require('../contract');
const sse = require('../sse');

// ---------------- 常量 ----------------

const ORIGIN = 'https://qoder.cn';
const API_PREFIX = '/api/v1/remote';
const PREVIEW_DOMAIN = 'preview.qoderwork.cn';
const MCP_PORT = 3001;                 // 沙箱里 MCP server 监听的端口（实测 404 page not found = 它）
const CODE_MARK = '__COWBIRD_CODE__';    // 包装脚本打的退出码标记
const ERR_MARK = '__COWBIRD_STDERR__';   // 包装脚本打的 stderr 分隔标记

// 会话里「沙箱自述」探测脚本：全部走 /proc 与 cgroup，不依赖任何第三方工具。
// 输出 COWBIRD_KEY=value 一行一项，交给 parseCapacity 解析。
const PROBE_SCRIPT = [
  'echo "COWBIRD_NPROC=$(nproc 2>/dev/null)"',
  'echo "COWBIRD_CPU_MAX=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"',
  'echo "COWBIRD_CPU_QUOTA=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null)"',
  'echo "COWBIRD_CPU_PERIOD=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null)"',
  'echo "COWBIRD_MEM_MAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"',
  'echo "COWBIRD_MEM_LIMIT=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"',
  'echo "COWBIRD_MEMTOTAL_KB=$(awk \'/^MemTotal/{print $2}\' /proc/meminfo 2>/dev/null)"',
  'echo "COWBIRD_DF_KB=$(df -k / 2>/dev/null | awk \'NR==2{print $2}\')"',
  'echo "COWBIRD_KERNEL=$(uname -r 2>/dev/null)"',
  'echo "COWBIRD_VIRT=$(systemd-detect-virt 2>/dev/null)"',
  'echo "COWBIRD_UID=$(id -u 2>/dev/null)"',
  'echo "COWBIRD_CWD=$(pwd 2>/dev/null)"',
  'echo "COWBIRD_BOOTID=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"',
  'echo "COWBIRD_UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
].join('\n');

// ---------------- 小工具 ----------------

function protocolError(message, code) {
  const e = new Error(message);
  e.code = code || 'E_PROTOCOL';
  return e;
}

function b64urlDecode(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (t.length % 4)) % 4;
  return Buffer.from(t + '='.repeat(pad), 'base64');
}

// 单引号转义：实现已上提到 lib/platform/shell.js（全仓只有一份）
const { q: shellQuote } = require('../shell');

// ---------------- grant / JWT / 隧道 URL ----------------
//
// 实测 grant 的 JWT（ES256）payload 形如：
//   { sid: 'sess_…', port: 3000,
//     up: { addr: 'http://cloud-sandbox-manager.qoder.svc:8091/preview/sandboxes/<sandbox_id>',
//           h: { 'X-Access-Token': '<redacted>', 'X-Sandbox-Port': '3000' } },
//     sub, aud:['preview'], exp, iat }
// 我们只解 payload、不验签：只用它来拼子域和显示沙箱 id，不做任何信任判断。
function jwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try { return JSON.parse(b64urlDecode(parts[1]).toString('utf8')); } catch { return null; }
}

/** 从 grant（JWT 字符串或已解好的 payload）里取隧道前缀与沙箱标识 */
function grantInfo(grant) {
  const payload = typeof grant === 'string' ? jwtPayload(grant) : (grant && typeof grant === 'object' ? grant : null);
  if (!payload) return { sid: null, sandboxId: null, port: null, exp: null };
  const addr = payload.up && payload.up.addr ? String(payload.up.addr) : '';
  const m = addr.match(/sandboxes\/([^/?#\s]+)/);
  return {
    sid: payload.sid ? String(payload.sid) : null,
    sandboxId: m ? m[1] : null,
    port: Number(payload.port) || null,
    exp: Number(payload.exp) || null,
  };
}

/**
 * 隧道 URL 的直接拼装：https://<port>-<cma_session_id>.preview.qoderwork.cn
 * （子域 = 端口 + 会话的 cma_session_id，实测格式就是它）
 */
function previewUrl(port, cmaSessionId) {
  const p = Number(port) || MCP_PORT;
  const sid = String(cmaSessionId == null ? '' : cmaSessionId).trim();
  if (!sid) throw protocolError('拼 preview 隧道 URL 缺 cma_session_id', 'E_PROTOCOL');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sid)) throw protocolError(`cma_session_id 形状不对：${sid}`, 'E_PROTOCOL');
  return `https://${p}-${sid}.${PREVIEW_DOMAIN}`;
}

/**
 * grant 响应 → 可用隧道基址。
 * 优先用响应里的 url（平台自己给的，最可信）；没有就用 JWT 里的 sid + port 拼。
 * 两个都缺就报协议错误（不猜、不写死）。
 */
function tunnelUrl({ url, grant, port, cmaSessionId } = {}) {
  const raw = String(url == null ? '' : url).trim();
  if (raw) {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
    return withScheme.replace(/\/+$/, '');
  }
  const info = grantInfo(grant);
  const sid = info.sid || cmaSessionId;
  if (!sid) throw protocolError('grant 里既没有 url 也没有 sid，无法拼隧道地址', 'E_PROTOCOL');
  return previewUrl(info.port || port, sid);
}

/** grant 过期时间统一成毫秒时间戳（兼容秒/毫秒/ISO 字符串/只给 JWT exp） */
function grantExpiryAt(grantResponse, info) {
  const g = grantResponse && typeof grantResponse === 'object' ? grantResponse : {};
  const raw = g.expires_at !== undefined ? g.expires_at : g.expiresAt;
  let t = null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) t = raw > 1e12 ? raw : raw * 1000;
  else if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) t = n > 1e12 ? n : n * 1000;
    else { const d = Date.parse(raw); if (!Number.isNaN(d)) t = d; }
  }
  if (!t) {
    const exp = info && info.exp ? info.exp : (grantInfo(g.grant).exp || null);
    if (exp) t = exp * 1000;
  }
  return t;
}

// ---------------- 503 判定（沙箱未就绪 / 端口被策略挡） ----------------

function bodyCode(body) {
  if (!body) return null;
  if (typeof body === 'object') return body.code || body.errorCode || null;
  const s = String(body);
  try { const j = JSON.parse(s); return j && (j.code || j.errorCode); } catch { return null; }
}

function bodyText(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  try { return JSON.stringify(body); } catch { return String(body); }
}

/**
 * preview/grant 的 503 有两种，含义完全不同：
 *   CloudSandboxNotReady → 沙箱还没起（发一条消息把它拉起来再说）
 *   catalog_unavailable  → 这个端口不开放隧道（换端口也没用，是策略）
 * 返回 null 表示「不是这两种」。
 */
function notReadyReason(status, body) {
  if (Number(status) !== 503) return null;
  const code = bodyCode(body);
  if (code === 'CloudSandboxNotReady') return 'CloudSandboxNotReady';
  if (code === 'catalog_unavailable') return 'catalog_unavailable';
  const text = bodyText(body);
  if (/CloudSandboxNotReady/.test(text)) return 'CloudSandboxNotReady';
  if (/catalog_unavailable/.test(text)) return 'catalog_unavailable';
  return null;
}

// ---------------- exec 包装脚本与结果解析 ----------------
//
// 沙箱 MCP 的 bash 工具只回一段文本，没有结构化 exit code，也常常把 stderr
// 混进同一个流。所以命令外面套一层壳：先临时文件接 stderr，跑完打退出码标记，
// 再打 stderr 分隔标记 + cat 出来。这样 out/err/code 三个都能拿回来。
function wrapCommand(command) {
  const body = String(command == null ? '' : command).replace(/\s+$/, '');
  const inner = body || ':';            // 空命令不能写成 `{ }`（bash 语法错误）
  return [
    '__cowbird_err=$(mktemp 2>/dev/null || echo /tmp/.cowbird-err-$$)',
    '{',
    inner,
    '} 2>"$__cowbird_err"',
    '__cowbird_code=$?',
    `printf '\\n${CODE_MARK}%s\\n' "$__cowbird_code"`,
    `printf '${ERR_MARK}\\n'`,
    'cat "$__cowbird_err" 2>/dev/null',
    'rm -f "$__cowbird_err"',
  ].join('\n');
}

/**
 * 解析包装脚本的输出（也用于 on_timeout=background 的 `[backgrounded]` 提示）。
 * 缺标记时 code=null、truncated=true —— 通常是命令被超时 kill 或输出被截断。
 */
function parseWrapper(text) {
  const raw = String(text == null ? '' : text);

  const bg = raw.match(/\[backgrounded\]\s*pid\s*[:=]\s*(\d+)[\s\S]*?output_file\s*[:=]\s*(\S+)/i);
  if (bg) {
    return {
      out: raw.slice(0, bg.index).replace(/\r?\n$/, ''),
      err: '',
      code: null,
      backgrounded: true,
      pid: Number(bg[1]),
      outputFile: bg[2].replace(/[),.;]+$/, ''),
      truncated: false,
    };
  }

  const errAt = raw.indexOf(ERR_MARK);
  const head = errAt >= 0 ? raw.slice(0, errAt) : raw;
  const err = errAt >= 0 ? raw.slice(errAt + ERR_MARK.length).replace(/^\r?\n/, '') : '';

  let out = head;
  let code = null;
  let truncated = true;
  const m = head.match(new RegExp(`${CODE_MARK}(-?\\d+)`));
  if (m) {
    code = Number(m[1]);
    // printf 自己打的那个前导换行要吃掉，用户输出的换行保留
    out = head.slice(0, m.index).replace(/\r?\n$/, '');
    truncated = false;
  }
  return { out, err, code, backgrounded: false, pid: null, outputFile: null, truncated };
}

// ---------------- 沙箱容量（cgroup 读数） ----------------

/** COWBIRD_KEY=value 行 → 对象（键去掉 COWBIRD_ 前缀） */
function parseProbe(text) {
  const map = {};
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:COWBIRD_)?([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

/**
 * 把探测脚本的输出解析成「可见（宿主）」与「配额（cgroup）」两组数。
 * 两代沙箱（kvm microVM / docker 容器）读数格式一样，但配额未必存在：
 *   - cgroup v2: cpu.max / memory.max（"max" = 无限制）
 *   - cgroup v1: cpu.cfs_quota_us + cpu.cfs_period_us / memory.limit_in_bytes（哨兵值极大）
 */
function parseCapacity(text) {
  const map = parseProbe(text);
  const num = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s === 'max' || s === '-1') return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const visibleCpu = num(map.NPROC);
  const memTotalKb = num(map.MEMTOTAL_KB);
  const dfKb = num(map.DF_KB);

  let quota = num(map.CPU_QUOTA);
  let period = num(map.CPU_PERIOD);
  if (map.CPU_MAX) {
    const parts = String(map.CPU_MAX).trim().split(/\s+/);
    const q = num(parts[0]);
    const p = num(parts[1]);
    if (q != null) quota = q;
    if (p != null) period = p;
  }
  const cpuQuota = quota != null && period != null ? Math.ceil(quota / period) : null;

  let memQuota = num(map.MEM_MAX);
  if (memQuota == null) memQuota = num(map.MEM_LIMIT);
  if (memQuota != null && memQuota >= 2 ** 60) memQuota = null;   // v1 的「无限制」哨兵

  return {
    visible: {
      cpu: visibleCpu,
      memBytes: memTotalKb != null ? memTotalKb * 1024 : null,
      diskBytes: dfKb != null ? dfKb * 1024 : null,
    },
    quota: { cpu: cpuQuota, memBytes: memQuota },
    facts: {
      kernel: map.KERNEL || null,
      virt: map.VIRT || null,
      uid: map.UID || null,
      cwd: map.CWD || null,
      bootId: map.BOOTID || null,
      uptimeSec: num(map.UPTIME),
    },
    raw: map,
  };
}

// ---------------- MCP（JSON-RPC）结果 ----------------

/** JSON-RPC 信封 → result；有 error 就抛（code=E_MCP，带原始 rpc 错误） */
function unwrapRpc(envelope) {
  if (!envelope || typeof envelope !== 'object') throw protocolError('MCP 空响应', 'E_MCP_EMPTY');
  if (envelope.error) {
    const err = envelope.error;
    const e = new Error(`MCP 错误${err.code != null ? ' ' + err.code : ''}：${err.message || JSON.stringify(err)}`);
    e.code = 'E_MCP';
    e.rpc = err;
    throw e;
  }
  return envelope.result || {};
}

/** MCP 工具结果里的文本（content[].text 拼起来，实测就这一种形态） */
function mcpText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const c = result.content;
  if (Array.isArray(c)) {
    return c
      .map((x) => (x && typeof x.text === 'string' ? x.text : (typeof x === 'string' ? x : '')))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof result.text === 'string') return result.text;
  return '';
}

// ---------------- SSE 帧 ----------------

/** 单个 SSE 块 → {event, data, id, raw}；data 能 JSON.parse 就解析。
 *  解析实现已上提到 lib/platform/sse.js（与 codearts / minimax 共用）。 */
function parseSseBlock(block) {
  const raw = String(block === undefined || block === null ? '' : block);
  const f = sse.parseBlock(raw);
  if (!f) return { event: 'message', data: null, id: null, raw };
  return { event: f.event, data: f.data, id: f.id, raw };
}

/** 整段 SSE 文本 → 帧数组（只保留有 data 的） */
function parseSseFrames(text) {
  return String(text === undefined || text === null ? '' : text)
    .split(/\r?\n\r?\n/)
    .map(parseSseBlock)
    .filter((f) => f && f.data !== null);
}

// ---------------- 事件映射（协议 → 归一化事件） ----------------

function eventPayload(ev) {
  let p = ev && ev.payload;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { p = { text: p }; }
  }
  return p && typeof p === 'object' ? p : {};
}

/** assistant / user 事件的 content 块数组 */
function contentBlocks(payload) {
  const msg = payload && payload.message && typeof payload.message === 'object' ? payload.message : null;
  const c = (msg && msg.content) || payload.content;
  return Array.isArray(c) ? c : [];
}

function toolResultEvent(block) {
  const c = block && block.content;
  let out = '';
  if (Array.isArray(c)) {
    out = c.map((x) => (x && (x.text != null ? x.text : x.content != null ? x.content : ''))).join('');
  } else if (typeof c === 'string') out = c;
  else if (block && block.text != null) out = String(block.text);
  return {
    kind: EVENT.TOOL_RESULT,
    data: { id: (block && (block.tool_use_id || block.id)) || null, name: (block && block.name) || null, ok: !(block && block.is_error), out },
  };
}

/**
 * stop_reason 可能是字符串，也可能是对象（实测见过 `{type:'end_turn'}`）。
 * done 事件的 reason 必须是字符串，否则 `[object Object]` 会漏到命令层。
 */
function reasonOf(v) {
  if (v == null) return 'idle';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return String(v.type || v.stop_reason || v.reason || 'idle');
  return String(v);
}

function usageEvent(p) {  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const credits = p.total_credits != null ? p.total_credits : p.credits;
  return {
    kind: EVENT.USAGE,
    data: {
      inputTokens: num(p.input_tokens),
      outputTokens: num(p.output_tokens),
      totalTokens: num(p.total_tokens),
      credits: num(credits),
      modelCredits: num(p.model_credits),
      sandboxCredits: num(p.sandbox_runtime_credits),
    },
  };
}

/**
 * 单条原始事件 → 0..n 条归一化事件。
 *
 * 映射表（event_type / 结构 → kind）：
 *   worker.status.changed / session.thread_status_* / stream_event(session.status_*)
 *                                      → status
 *   assistant 里的 text                → text
 *   assistant 里的 reasoning/thinking  → thinking
 *   assistant 里的 tool_use            → tool
 *   user 里的 tool_result（工具结果是伪装成 user 事件的）→ tool_result
 *   session.usage                      → usage
 *   session.thread_status_idle / assistant stop_reason=end_turn → done
 *   其它（sandbox.boot_progress、available_*_update、stream_event 其它…）→ raw
 */
function mapEvent(ev) {
  const out = [];
  if (!ev || typeof ev !== 'object') return out;
  const type = String(ev.event_type || '');
  const p = eventPayload(ev);

  switch (type) {
    case 'assistant': {
      for (const b of contentBlocks(p)) {
        if (!b || typeof b !== 'object') continue;
        const bt = String(b.type || '');
        if (bt === 'text' && b.text != null && String(b.text) !== '') {
          out.push({ kind: EVENT.TEXT, data: { text: String(b.text) } });
        } else if ((bt === 'reasoning' || bt === 'thinking') && (b.text || b.reasoning)) {
          out.push({ kind: EVENT.THINKING, data: { text: String(b.text || b.reasoning) } });
        } else if (bt === 'tool_use') {
          out.push({ kind: EVENT.TOOL, data: { id: b.id || null, name: b.name || null, input: b.input === undefined ? null : b.input } });
        } else if (bt === 'tool_result') {
          out.push(toolResultEvent(b));
        }
      }
      const stop = p.stop_reason != null ? p.stop_reason : (p.message && p.message.stop_reason);
      if (stop === 'end_turn') out.push({ kind: EVENT.DONE, data: { reason: 'end_turn' } });
      else if (stop && stop !== 'tool_use') out.push({ kind: EVENT.STATUS, data: { status: `assistant:${stop}` } });
      break;
    }

    case 'user': {
      // worker 把工具结果伪装成 user 事件；真正的用户消息（source=controller）没有 tool_result
      let any = false;
      for (const b of contentBlocks(p)) {
        if (b && typeof b === 'object' && String(b.type || '') === 'tool_result') { out.push(toolResultEvent(b)); any = true; }
      }
      if (!any) out.push({ kind: EVENT.RAW, data: { raw: ev } });
      break;
    }

    case 'worker.status.changed':
      out.push({ kind: EVENT.STATUS, data: { status: String(p.session_status || p.worker_status || 'unknown') } });
      break;

    case 'session.thread_status_running':
      out.push({ kind: EVENT.STATUS, data: { status: 'running' } });
      break;

    case 'session.thread_status_idle':
      out.push({ kind: EVENT.STATUS, data: { status: 'idle' } });
      out.push({ kind: EVENT.DONE, data: { reason: reasonOf(p.stop_reason) } });
      break;

    case 'session.usage':
      out.push(usageEvent(p));
      break;

    case 'stream_event': {
      const st = String(p.type || p.subtype || '');
      const m = st.match(/^session\.status_([a-z]+)$/);
      if (m) out.push({ kind: EVENT.STATUS, data: { status: m[1] } });
      else out.push({ kind: EVENT.RAW, data: { raw: ev } });
      break;
    }

    default:
      out.push({ kind: EVENT.RAW, data: { raw: ev } });
  }
  return out;
}

/** 会话对象 → 内核认的实例形状（同时保留原始对象，方便调试） */
function instanceFromSession(s) {
  const o = s && typeof s === 'object' ? s : {};
  const ctxc = o.session_context && typeof o.session_context === 'object' ? o.session_context : {};
  return {
    id: o.session_id || null,
    name: o.title || o.session_id || '(未命名)',
    status: o.session_status || 'unknown',
    updatedAt: o.updated_at || null,
    createdAt: o.created_at || null,
    archived: !!(o.archived_at || o.archived),
    pinned: !!o.pinned,
    model: ctxc.model || null,
    workMode: ctxc.work_mode || null,
    environmentId: o.environment_id || null,
    cmaSessionId: o.cma_session_id || null,
    origin: o.origin || null,
    // 内核的 ls / info 会读 extra.sessionStatus（两套状态词并存时的展示位）
    extra: {
      sessionStatus: o.session_status || null,
      cmaSessionId: o.cma_session_id || null,
      environmentId: o.environment_id || null,
      model: ctxc.model || null,
      workMode: ctxc.work_mode || null,
      lastEndTurnAt: o.last_end_turn_at || null,
    },
    raw: o,
  };
}

/** 给 /sessions/{id} 系列接口拼路径 */
function sessionPath(id, suffix) {
  const base = `${API_PREFIX}/sessions/${encodeURIComponent(String(id == null ? '' : id))}`;
  return suffix ? `${base}${suffix}` : base;
}

/**
 * MCP 的 file_read 返回是**带行号**的（实测：`1\tqoder fs test`）。
 * 直接拿去写文件会把内容搞坏（实测把 "qoder fs test" 存成了 "1\tqoder fs test"）。
 * 规则：**每一行都匹配行号前缀才剥**，有一行不匹配就原样返回 —— 宁可多带行号，也别误删正文。
 */
function stripLineNumbers(text) {
  const s = String(text == null ? '' : text);
  if (!s) return s;
  const lines = s.split('\n');
  const re = /^\s*(\d+)\t([\s\S]*)$/;
  let matched = 0;
  let nonEmpty = 0;
  for (const l of lines) {
    if (l === '') continue;
    nonEmpty += 1;
    if (re.test(l)) matched += 1;
  }
  if (!nonEmpty || matched !== nonEmpty) return s;
  return lines.map((l) => { const m = l.match(re); return m ? m[2] : l; }).join('\n');
}

module.exports = {
  ORIGIN,
  API_PREFIX,
  stripLineNumbers,
  PREVIEW_DOMAIN,
  MCP_PORT,
  CODE_MARK,
  ERR_MARK,
  PROBE_SCRIPT,
  protocolError,
  b64urlDecode,
  shellQuote,
  jwtPayload,
  grantInfo,
  previewUrl,
  tunnelUrl,
  grantExpiryAt,
  bodyCode,
  bodyText,
  notReadyReason,
  wrapCommand,
  parseWrapper,
  parseProbe,
  parseCapacity,
  unwrapRpc,
  mcpText,
  parseSseBlock,
  parseSseFrames,
  mapEvent,
  instanceFromSession,
  sessionPath,
};
