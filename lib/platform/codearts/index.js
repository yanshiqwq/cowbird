// codearts —— 华为云「码道 CodeArts」（CodeArtsWorkWeb）平台驱动。
//
// 平台面（全部来自实测，详见同目录 README.md）：
//   · 基址 https://devcloud.cn-north-4.huaweicloud.com/chat
//   · 鉴权 = cookie + cftk 头 + `agent-type: CodeBase`；**不绑 UA**
//   · 未登录 = HTTP 200 + 空体 + `HW-AJAX-REDIRECT`（不是 401）
//   · 回合 = 具名 SSE，一次 POST messages 返回整轮
//   · ★ 免 LLM exec = 预览代理透传到沙箱内 agentkernel 127.0.0.1:9800 的 /shell，
//     tokens/cost 全 0、不进对话历史；**同步硬上限 30 秒**，超时后命令仍在沙箱里跑
//   · 沙箱只在**真正跑一轮 agent** 时才创建（POST /start 实测无效）
//
// 与 WorkBuddy 驱动的三处结构性差异（照抄那边会错）：
//   1. 登录态没有固定期限、不能续期 → 不声明 auth.renew
//   2. 沙箱是按运行时长回收的（30–40 分钟），心跳/访问活跃度都不参与判定
//      → 不声明 heal/keepalive 语义，改成"用之前先 wake"（exec.wake）
//   3. 同一 kernel session 串行，且 30 秒硬顶 → 同步上限 28s + nohup 后台兜底
const { defineProvider, CAP, EVENT, execResult, fileEntry } = require('../contract');
const auth = require('./auth');
const sse = require('./sse');
const transport = require('./transport');
const shell = require('./shell');
const { cgroupScript, parseCgroup, humanBytes } = require('./cgroup');
const { buildAnswers, describeAnswers } = require('./answers');

const ID = 'codearts';
const WORKSPACE = '/workspace';
const JOB_DIR = `${WORKSPACE}/.wbsbx`;
const PREVIEW_PORT = 9800;                       // 沙箱内 agentkernel 的端口（实测常驻）
const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';
const DEFAULT_AGENT = 'build';
const WAKE_PROMPT = '执行 `true` 并回复 ok。';    // 最小 prompt：只为把沙箱拉起来
const CHUNK_BYTES = 60 * 1024;                   // 写文件的 base64 分块；实测 60KB 稳，别更大

// limits 是一份硬承诺：内核只按这里决定"同步 / 后台 / 拒绝"。
const LIMITS = {
  maxSyncMs: 28000,          // 网关 30s 硬上限，留 2s 余量；超了命令还在沙箱里跑，不能当失败
  defaultSyncMs: 20000,
  maxBackground: true,
  wakeTimeoutMs: 90000,      // wake = 一轮最小 prompt + 轮询详情，实测 5–10s，留足
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => encodeURIComponent(String(s));
const opt = transport.opt;

function api(ctx) { return transport.createTransport(ctx); }

// ---------- 会话归一 ----------
// 平台状态枚举：ACTIVE / IDLE / RUNNING / COMPLETED / FAILED / CANCELED / WAITING_APPROVAL / CLOSED
const STATUS_MAP = {
  ACTIVE: 'idle',            // 新建瞬间：没有沙箱
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
  WAITING_APPROVAL: 'waiting',
  CLOSED: 'closed',
};

function normStatus(s) {
  const v = String(s || '').toUpperCase();
  return STATUS_MAP[v] || (v ? v.toLowerCase() : 'unknown');
}

// 平台时间是 `2026-11-16 08:28:14`（空格、无时区），原样保留信息但补成可解析的形状
function toIso(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)) return s.replace(' ', 'T');
  return s;
}

function normalizeSession(raw = {}) {
  const id = String(raw.session_id || raw.id || '');
  const stats = raw.stats || {};
  const ws = (stats.credit_cost_for_web && stats.credit_cost_for_web.credit_cost !== undefined)
    ? stats.credit_cost_for_web.credit_cost : null;
  return {
    id,
    name: raw.title || raw.name || '',
    title: raw.title || '',
    status: normStatus(raw.status),
    platformStatus: raw.status || null,
    updatedAt: toIso(raw.last_active_time || raw.update_time),
    createdAt: toIso(raw.create_time),
    streaming: !!raw.streaming,
    agentSessionId: raw.agent_session_id || null,     // 有它 = 沙箱曾创建
    model: (stats.model && (stats.model.id || stats.model)) || null,
    agent: stats.agent || null,
    credits: ws,
    runtime: raw.runtime_name || null,
    clientType: raw.client_type || null,
    raw,
  };
}

function sessionListOf(json) {
  const j = json || {};
  if (Array.isArray(j)) return j;                       // 有的接口直接回数组
  if (Array.isArray(j.result)) return j.result;
  if (Array.isArray(j.data)) return j.data;
  if (j.data && Array.isArray(j.data.sessions)) return j.data.sessions;
  return [];
}

// ---------- instances ----------
async function listInstances(ctx, { pageSize = 50, max = 500 } = {}) {
  const t = api(ctx);
  const size = Math.max(50, Number(pageSize) || 50);   // 服务端把 <50 兜成 50，别用更小的
  const out = [];
  let total = null;
  for (let page = 1; page <= 20; page++) {
    const r = await t.request('GET', `/v1/cloudagent/sessions?page_num=${page}&page_size=${size}`);
    const arr = sessionListOf(r.json);
    if (Number.isFinite(Number(r.json && r.json.total))) total = Number(r.json.total);
    out.push(...arr.map(normalizeSession));
    if (!arr.length) break;
    // total 可信就用 total 判断收尾；拿不到 total 才退回"短页即末页"
    if (total !== null) { if (out.length >= total) break; }
    else if (arr.length < size) break;
    if (out.length >= max) break;
  }
  return out;
}

async function getInstance(ctx, id) {
  const t = api(ctx);
  const r = await t.request('GET', `/v1/cloudagent/sessions/${enc(id)}`);
  const j = r.json || {};
  const s = j.result || j.data || j;
  if (!s || (!s.session_id && !s.id)) {
    throw new Error(`没有会话 ${id}（返回：${String(r.text || '').slice(0, 200)}）`);
  }
  return normalizeSession(s);
}

async function createInstance(ctx, { name, title, model, prompt } = {}) {
  const t = api(ctx);
  // 建会话接口只认空 body（实测），名字要建完再改；model/prompt 平台都不接受
  const r = await t.request('POST', '/v1/cloudagent/sessions', { body: {} });
  const j = r.json || {};
  const s = j.result || j.data || j;
  const id = s && (s.session_id || s.id);
  if (!id) throw new Error(`建会话的返回里没有 session_id：${String(r.text || '').slice(0, 200)}`);
  const want = name || title || '';
  if (want) await renameInstance(ctx, id, want);
  // 记住用户起的名字：平台会拿**首条消息**自动改标题（实测 `wbsbx-probe` → `执行 true 命令并回复 ok`），
  // 所以 wake 跑完一轮之后要再改回来一次（见 execWake 末尾的 restoreTitle）。
  if (want) {
    try { if (ctx && ctx.store) ctx.store.write('title-' + id, { title: String(want), at: Date.now() }); } catch {}
  }
  // 平台不认"建会话时指定模型"，但用户的意思要留住：记在该实例名下，之后发消息时用
  if (model) {
    try { if (ctx && ctx.store) ctx.store.write('model-' + id, { model: String(model), at: Date.now() }); } catch {}
  }
  let inst;
  try { inst = await getInstance(ctx, id); } catch { inst = normalizeSession({ ...s, title: want || s.title }); }
  if (prompt) {
    inst = {
      ...inst,
      // 建会话不花 credit、不建沙箱；初始指令必须单独发一轮（那才会建沙箱）
      hint: '本平台建会话接口只接受空 body：初始指令未发送，请建完后单独 wbsbx prompt',
      pendingPrompt: String(prompt),
    };
  }
  return inst;
}

/**
 * 把用户起的名字改回来。平台会拿**首条消息**自动改标题（实测 `wbsbx-probe` →
 * `执行 true 命令并回复 ok`），所以 wake 跑完那一轮之后名字就变了，`exec <名字>` 会找不到。
 * best-effort：失败只当没发生（用 id 操作永远不受影响）。
 */
async function restoreTitle(ctx, id) {
  let saved = null;
  try { saved = ctx.store.read('title-' + id, null); } catch { /* store 不可用就算了 */ }
  if (!saved || !saved.title) return false;
  try {
    const cur = await getInstance(ctx, id);
    if (cur && cur.name === saved.title) return true;
    await renameInstance(ctx, id, saved.title);
    return true;
  } catch {
    return false;
  }
}

async function renameInstance(ctx, id, title) {  const t = api(ctx);
  await t.request('PUT', `/v1/cloudagent/sessions/${enc(id)}`, { body: { title: String(title || '') } });
  try { return await getInstance(ctx, id); } catch { return { id: String(id), name: String(title || ''), title: String(title || '') }; }
}

async function removeInstance(ctx, id, { archive = false } = {}) {
  if (archive) {
    // 平台只有 DELETE（真删），没有归档。加了 --archive 还照删太危险，直接拒绝。
    const e = new Error('码道没有"归档"语义：DELETE 就是永久删除。确实要删请去掉 --archive');
    e.code = 'E_UNSUPPORTED';
    throw e;
  }
  const t = api(ctx);
  await t.request('DELETE', `/v1/cloudagent/sessions/${enc(id)}`);
  return true;
}

// 沙箱详情：先 probe，ready 才去读 cgroup；不 ready 就返回 {ready:false}（**不抛错**）
async function infoInstance(ctx, id) {
  const p = await execProbe(ctx, id);
  const facts = [
    { label: '平台', value: '码道 CodeArts' },
    { label: '实例', value: String(id) },
  ];
  if (p.session) {
    facts.push({ label: '会话状态', value: p.session.platformStatus || p.session.status });
    if (p.session.model) facts.push({ label: '模型', value: p.session.model });
    if (p.session.agent) facts.push({ label: 'agent', value: p.session.agent });
    if (p.session.credits !== null) facts.push({ label: '已用 credit', value: String(p.session.credits) });
  }
  if (!p.ready) {
    return {
      ready: false,
      why: p.why,
      hint: p.hint || '沙箱只在真正跑一轮 agent 时才创建：先 wbsbx wake（约 0.2 credit），或发一条 prompt',
      agentSessionId: null,
      facts,
    };
  }
  facts.push({ label: '沙箱内核会话', value: p.kernelSessionId });

  let cg = null;
  let runErr = null;
  try {
    const r = await execRun(ctx, id, { command: cgroupScript() });
    if (r.truncated) runErr = '采集脚本被 30s 网关截断';
    else cg = parseCgroup(r.out);
  } catch (e) {
    runErr = e.message;
  }

  if (!cg) {
    return {
      ready: true,
      partial: true,
      why: 'cgroup-unavailable',
      error: runErr,
      agentSessionId: p.kernelSessionId,
      facts: [...facts, { label: '容量', value: `读不到（${String(runErr || '').slice(0, 80)}）` }],
    };
  }

  // 「可见」= 容器里能看到多少；「配额」= 真正被限到多少。两个都给，别只给一个。
  const visible = {
    cpu: cg.cpu.visible,
    memBytes: cg.mem.visibleBytes,
    diskBytes: cg.disk.totalBytes,
    diskAvailBytes: cg.disk.availBytes,
  };
  const quota = {
    cpu: cg.cpu.quota === null ? cg.cpu.visible : cg.cpu.quota,
    memBytes: cg.mem.quotaBytes === null ? cg.mem.visibleBytes : cg.mem.quotaBytes,
  };
  facts.push(
    { label: 'CPU', value: `可见 ${cg.cpu.visible ?? '?'} / 配额 ${cg.cpu.quota === null ? '不限' : cg.cpu.quota}` },
    { label: '内存', value: `可见 ${humanBytes(cg.mem.visibleBytes)} / 配额 ${cg.mem.quotaBytes === null ? '不限' : humanBytes(cg.mem.quotaBytes)}` },
    { label: '磁盘', value: `${humanBytes(cg.disk.totalBytes)}（可用 ${humanBytes(cg.disk.availBytes)}）` },
    { label: 'cgroup', value: cg.mode || 'unknown' },
  );
  if (cg.kernel) facts.push({ label: '内核', value: cg.kernel });
  if (cg.host) facts.push({ label: '主机名', value: cg.host });

  return {
    ready: true,
    agentSessionId: p.kernelSessionId,
    cgroup: cg.mode,
    visible,
    quota,
    limits: {
      cpuUnlimited: cg.cpu.quota === null,
      memUnlimited: cg.mem.quotaBytes === null,
    },
    disk: { totalBytes: cg.disk.totalBytes, availBytes: cg.disk.availBytes },
    facts,
  };
}

// ---------- exec（免 LLM 通道） ----------
// 链路：POST /codebaseservice/v1/cloudagent/sessions/{sid}/9800/preview/session/{ksid}/shell
//        body {command, agent:'build'} → {parts:[{type:'tool', state:{status, output}}]}
// 前置：agent_session_id 必须存在（沙箱在跑）。没有就报 no-sandbox，交给 wake 处理。

async function execProbe(ctx, id) {
  let sess;
  try {
    sess = await getInstance(ctx, id);
  } catch (e) {
    if (e && e.auth) throw e;
    return { ready: false, why: 'probe-failed', error: e.message, session: null };
  }
  if (!sess.agentSessionId) {
    return {
      ready: false,
      why: 'no-sandbox',
      status: sess.platformStatus,
      session: sess,
      hint: '沙箱从未创建（agent_session_id 为空）：发一轮最小 prompt 才会建（exec.wake / wbsbx wake）',
    };
  }
  // 沙箱存在 ≠ 可以插命令：agent 自己也在用同一条 kernel session（串行）。
  // 实测 wake 刚发完一轮 prompt 就去 exec，会连续撞 `Session … is busy`。
  // 所以这里要求「有 kernel session **且** 会话不在跑」才算 ready。
  const busy = Boolean(sess.streaming)
    || /RUNNING|PROCESSING|WORKING|IN_PROGRESS/i.test(String(sess.platformStatus || ''));
  return {
    ready: !busy,
    why: busy ? 'busy' : null,
    kernelSessionId: sess.agentSessionId,
    status: sess.platformStatus,
    streaming: sess.streaming,
    session: sess,
    ...(busy ? { hint: '沙箱在，但会话正在跑（agent 自己也在用这条 kernel session）：等这一轮结束再 exec' } : {}),
  };
}

function shellPath(id, ksid) {
  return `/codebaseservice/v1/cloudagent/sessions/${enc(id)}/${PREVIEW_PORT}/preview/session/${enc(ksid)}/shell`;
}

async function execRun(ctx, id, { command, timeoutMs, cwd, env, wake = false, raw = false } = {}) {
  const t = api(ctx);
  let p = await execProbe(ctx, id);
  if (!p.ready && wake) p = await execWake(ctx, id);
  if (!p.ready) {
    const e = new Error(
      `实例 ${id} 还没有沙箱（${p.why || 'unknown'}）。` +
      (p.hint ? `\n  ${p.hint}` : '')
    );
    e.code = 'E_NO_SANDBOX';
    e.hint = p.hint || null;
    e.retryable = false;
    throw e;
  }

  const budget = Math.min(Number(timeoutMs) || LIMITS.defaultSyncMs, LIMITS.maxSyncMs);
  const wrapped = raw ? String(command === undefined || command === null ? '' : command) : shell.wrapCommand(command, { cwd, env });
  const agent = opt(ctx, 'agent', DEFAULT_AGENT);
  const started = Date.now();

  let resp;
  try {
    resp = await t.request('POST', shellPath(id, p.kernelSessionId), {
      body: { command: wrapped, agent },
      timeoutMs: budget,
    });
  } catch (e) {
    // 我们自己的 28s 预算先到：命令仍在沙箱里跑，不能当失败
    if (e && e.code === 'E_TIMEOUT') {
      return execResult({
        out: '',
        err: `同步执行超过 ${budget}ms 被截断（网关硬上限 30s，命令仍在沙箱里继续跑）。` +
             '别马上重试（会 400 busy），改用后台任务：wbsbx exec --background 或 exec.start + exec.poll。',
        code: null,
        ms: Date.now() - started,
        truncated: true,
      });
    }
    throw e;
  }

  const parsed = shell.parseShellResult(resp.json, { ms: Date.now() - started });
  if (parsed.truncated) {
    return execResult({
      out: '',
      err: '网关返回 200 但 state.status 与 output 双空 = 被 30s 上限截断（实测特征），命令仍在沙箱里继续跑。' +
           '改用后台任务（exec.start + exec.poll），或等它跑完再重试。',
      code: null,
      ms: Date.now() - started,
      truncated: true,
    });
  }

  if (raw) {
    return execResult({
      out: parsed.out,
      err: '',
      code: parsed.status === 'completed' ? 0 : null,
      ms: Date.now() - started,
      truncated: false,
    });
  }

  // 普通模式：命令尾部有我们打的 `__WBSBX_RC=` / `__WBSBX_STDERR__` 标记，据此拆出 out/err/code
  const pw = shell.parseWrapped(parsed.out);
  if (!pw.wrapped) {
    // 标记没找到（输出被平台侧截断之类）：只给原始输出，退出码未知，别谎报 0
    return execResult({
      out: parsed.out,
      err: parsed.status === 'completed' ? '' : `命令状态 ${parsed.status || '未知'}`,
      code: parsed.status === 'completed' ? 0 : null,
      ms: Date.now() - started,
      truncated: false,
    });
  }
  return execResult({ out: pw.out, err: pw.err, code: pw.code, ms: Date.now() - started, truncated: false });
}

// 后台任务：nohup 起、日志落 /workspace/.wbsbx/<job>.log，poll 时 shell cat 读
async function execStart(ctx, id, { command, cwd, env } = {}) {
  const jobId = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const script = shell.buildJobScript({ jobId, command, cwd, env, dir: JOB_DIR });
  const r = await execRun(ctx, id, { command: script });
  if (r.truncated) {
    const e = new Error('启动后台任务时被 30s 截断（很少见）：稍后直接 poll，jobId=' + jobId);
    e.code = 'E_TIMEOUT';
    e.jobId = jobId;
    throw e;
  }
  if (r.code !== 0) {
    throw new Error(`启动后台任务失败 rc=${r.code}：${String(r.err || r.out || '').trim().slice(0, 300)}`);
  }
  const pid = String(r.out || '').trim().split(/\s+/).filter(Boolean).pop() || null;
  return {
    jobId,
    pid,
    outputPath: `${JOB_DIR}/${jobId}.log`,
    pidPath: `${JOB_DIR}/${jobId}.pid`,
    command: String(command || ''),
  };
}

async function execPoll(ctx, id, { jobId } = {}) {
  if (!jobId) throw new Error('poll 缺 jobId');
  const r = await execRun(ctx, id, { command: shell.buildPollScript({ jobId, dir: JOB_DIR }) });
  const st = shell.parsePoll(r.out);
  return {
    jobId,
    done: st.done,
    out: st.out,
    err: st.err,
    code: st.code,
    alive: st.alive,
    pid: st.pid,
    size: st.size,
    missing: st.missing,
    truncated: st.truncated || r.truncated,
    ms: r.ms,
  };
}

// 唤醒：沙箱只能靠"真跑一轮 agent"创建，所以 wake = 发一条最小 prompt + 轮询详情
async function execWake(ctx, id, { timeoutMs, prompt, model } = {}) {
  const limit = Number(timeoutMs) || LIMITS.wakeTimeoutMs;
  const started = Date.now();

  const before = await execProbe(ctx, id);
  if (before.ready) return { ready: true, triggered: false, kernelSessionId: before.kernelSessionId, waitedMs: 0 };

  let turnError = null;
  try {
    for await (const ev of agentStream(ctx, id, {
      text: prompt || WAKE_PROMPT,
      model,
      idleTimeoutMs: Math.max(30000, limit),
    })) {
      if (ev.kind === EVENT.ERROR) turnError = ev.data;
      if (ev.kind === EVENT.DONE) break;
      if (Date.now() - started > limit * 2) break;
    }
  } catch (e) {
    turnError = { message: e.message, code: e.code || null };
  }

  const deadline = Date.now() + limit;
  for (;;) {
    const p = await execProbe(ctx, id).catch(() => ({ ready: false }));
    if (p.ready) {
      await restoreTitle(ctx, id);
      return { ready: true, triggered: true, kernelSessionId: p.kernelSessionId, waitedMs: Date.now() - started, error: turnError };
    }
    if (Date.now() >= deadline) {
      return {
        ready: false,
        why: 'wake-timeout',
        waitedMs: Date.now() - started,
        error: turnError,
        hint: '一轮 prompt 打完仍没有 agent_session_id：确认账号能正常发消息（credit 是否够、是否被风控）',
      };
    }
    await sleep(2000);
  }
}

// 传文件：base64 分块 → 沙箱内重组（60KB 一块，别更大）
async function pushFile(ctx, id, { remotePath, buffer, mode } = {}) {
  if (!remotePath) throw new Error('pushFile 缺 remotePath');
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer === undefined || buffer === null ? '' : buffer), 'utf8');
  const dir = remotePath.lastIndexOf('/') > 0 ? remotePath.slice(0, remotePath.lastIndexOf('/')) : '/';
  const tmp = `${remotePath}.wbsbx-b64`;

  await execRun(ctx, id, { command: `mkdir -p ${shell.shQuote(dir)} && rm -f ${shell.shQuote(tmp)}` });
  if (buf.length === 0) {
    const r0 = await execRun(ctx, id, { command: `: > ${shell.shQuote(remotePath)} && wc -c < ${shell.shQuote(remotePath)}` });
    if (r0.code !== 0) throw new Error(`创建空文件失败：${String(r0.err || r0.out).slice(0, 200)}`);
    return { path: remotePath, size: 0, chunks: 0 };
  }

  const b64 = buf.toString('base64');
  const chunks = [];
  for (let i = 0; i < b64.length; i += CHUNK_BYTES) chunks.push(b64.slice(i, i + CHUNK_BYTES));

  for (let i = 0; i < chunks.length; i++) {
    const r = await execRun(ctx, id, { command: `printf '%s' ${shell.shQuote(chunks[i])} >> ${shell.shQuote(tmp)}` });
    if (r.truncated) throw new Error(`上传分片 ${i + 1}/${chunks.length} 被截断（把 --chunk 调小或重试）`);
    if (r.code !== 0) throw new Error(`上传分片 ${i + 1}/${chunks.length} 失败 rc=${r.code}：${String(r.err || r.out).slice(0, 200)}`);
  }

  const fin = await execRun(ctx, id, {
    command: `base64 -d ${shell.shQuote(tmp)} > ${shell.shQuote(remotePath)} && rm -f ${shell.shQuote(tmp)} && wc -c < ${shell.shQuote(remotePath)}` +
      (mode ? ` && chmod ${mode} ${shell.shQuote(remotePath)}` : ''),
  });
  if (fin.truncated || fin.code !== 0) {
    throw new Error(`写入 ${remotePath} 失败 rc=${fin.code}：${String(fin.err || fin.out).slice(0, 200)}`);
  }
  const size = Number(String(fin.out).trim());
  return { path: remotePath, size: Number.isFinite(size) ? size : buf.length, chunks: chunks.length };
}

async function pullFile(ctx, id, { remotePath, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!remotePath) throw new Error('pullFile 缺 remotePath');
  const q = shell.shQuote(remotePath);
  const sz = await execRun(ctx, id, { command: `wc -c < ${q}` });
  const size = Number(String(sz.out).trim());
  if (!Number.isFinite(size)) {
    throw new Error(`读不到 ${remotePath}：${String(sz.err || sz.out).slice(0, 200) || '文件不存在或无权限'}`);
  }
  if (size > maxBytes) {
    const e = new Error(`${remotePath} 有 ${humanBytes(size)}，超过一次性读取上限 ${humanBytes(maxBytes)}（base64 走 shell 通道）`);
    e.code = 'E_TOO_LARGE';
    e.hint = '大文件走文件接口 …/files/download 或分块 read';
    throw e;
  }
  const r = await execRun(ctx, id, { command: `base64 -w0 ${q}` });
  if (r.truncated) {
    const e = new Error(`读取 ${remotePath} 被 30s 截断（文件可能太大）`);
    e.code = 'E_TIMEOUT';
    throw e;
  }
  if (r.code !== 0) throw new Error(`读取 ${remotePath} 失败 rc=${r.code}：${String(r.err || r.out).slice(0, 200)}`);
  const buffer = Buffer.from(String(r.out).trim(), 'base64');
  return { buffer, size, truncated: buffer.length !== size };
}

// ---------- agent（对话通道） ----------
// 提问挂起信息存 ctx.store：answer 时可以不显式带 question_id，也能按 label 补 description
function rememberQuestion(ctx, id, data) {
  try {
    if (!ctx || !ctx.store) return;
    ctx.store.write('pending-question', {
      instanceId: String(id),
      requestId: data && data.requestId,
      questions: (data && data.questions) || [],
      at: Date.now(),
    });
  } catch {}
}

function pendingQuestion(ctx, id) {
  try {
    if (!ctx || !ctx.store) return null;
    const p = ctx.store.read('pending-question');
    if (!p) return null;
    if (id !== undefined && String(p.instanceId) !== String(id)) return null;
    if (Date.now() - Number(p.at || 0) > 6 * 3600e3) return null;   // 太旧的不认
    return p;
  } catch { return null; }
}

function forgetQuestion(ctx, id) {
  try {
    const p = pendingQuestion(ctx, id);
    if (p && ctx && ctx.store) ctx.store.remove('pending-question');
  } catch {}
}

/** 本实例该用哪个模型：显式 > create 时记下的 > 平台默认 */
function modelFor(ctx, id, explicit) {
  if (explicit) return explicit;
  if (id) {
    try {
      const m = ctx && ctx.store && ctx.store.read('model-' + id);
      if (m && m.model) return m.model;
    } catch {}
  }
  return opt(ctx, 'model', DEFAULT_MODEL);
}

function messageBody(ctx, { id, text, model, agent, command, skills, attachments } = {}) {
  const body = {
    content: String(text === undefined || text === null ? '' : text),
    model_id: modelFor(ctx, id, model),
    repos: [],
  };
  const ag = agent || opt(ctx, 'agent', DEFAULT_AGENT);
  if (ag) body.agent = ag;
  if (command) body.command = command;
  if (Array.isArray(skills) && skills.length) body.skills = skills;
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;
  return body;
}

/**
 * 发一轮并逐帧回放成归一化事件。
 * 最后一定以 done 收尾：正常 done / stopped / error(stream_ended) 都是 done；
 * 流被切断时补一个 error（标注"服务端可能仍在跑"）再 done，避免内核挂死。
 */
async function* agentStream(ctx, id, { text, model, agent, command, skills, attachments, idleTimeoutMs, signal } = {}) {
  const t = api(ctx);
  const st = await t.openStream('POST', `/codebaseservice/v1/cloudagent/sessions/${enc(id)}/messages`, {
    body: messageBody(ctx, { id, text, model, agent, command, skills, attachments }),
    signal,
  });

  try {
    let ended = false;
    for await (const frame of t.frames(st, { idleTimeoutMs, signal })) {
      for (const ev of sse.mapFrame(frame)) {
        if (ev.kind === EVENT.QUESTION) rememberQuestion(ctx, id, ev.data);
        if (ev.kind === EVENT.DONE) { ended = true; forgetQuestion(ctx, id); }
        yield ev;
      }
      if (ended) break;
    }
    if (!ended) {
      // 断流 ≠ 中断：服务端这一轮很可能仍在跑并落库，用 history 能补回
      yield {
        kind: EVENT.ERROR,
        data: {
          message: 'SSE 流在 done 之前断开（不等于中断）：服务端这一轮可能仍在跑，稍后用 history 补回',
          code: 'E_STREAM_CUT',
        },
      };
      yield { kind: EVENT.DONE, data: { reason: 'eof' } };
    }
  } finally {
    try { await st.close(); } catch {}
  }
}

/** 只发不回放（prompt 命令用）：读一块证明通道开了，然后断开 */
async function agentSend(ctx, id, { text, model, agent, command, skills, attachments } = {}) {
  const t = api(ctx);
  const ac = new AbortController();
  const st = await t.openStream('POST', `/codebaseservice/v1/cloudagent/sessions/${enc(id)}/messages`, {
    body: messageBody(ctx, { id, text, model, agent, command, skills, attachments }),
    signal: ac.signal,
  });
  let bytes = 0;
  try {
    if (st.res && st.res.body) {
      const reader = st.res.body.getReader();
      try { const first = await reader.read(); bytes = first && first.value ? first.value.length : 0; } catch {}
      try { await reader.cancel(); } catch {}
    }
  } finally {
    try { ac.abort(); } catch {}
    try { await st.close(); } catch {}
  }
  return { ok: true, status: st.status, bytes, note: '已发出；服务端会把这轮跑完（断流不等于中断）' };
}

/**
 * 历史消息。★ 分页参数是 **snake_case**（pageNum/pageSize 会被忽略，实测返回 50 条），
 * 且返回**倒序**（message_index 递减），这里按索引升序还原成时间顺序。
 */
async function agentHistory(ctx, id, { pageSize = 50, max = 500 } = {}) {
  const t = api(ctx);
  const size = Math.max(50, Number(pageSize) || 50);    // 服务端对 <50 会兜底成 50
  const raw = [];
  let total = null;
  for (let page = 1; page <= 20; page++) {
    const r = await t.request('GET', `/codebaseservice/v1/cloudagent/sessions/${enc(id)}/messages?page_num=${page}&page_size=${size}`);
    const arr = sessionListOf(r.json);
    if (Number.isFinite(Number(r.json && r.json.total))) total = Number(r.json.total);
    if (!arr.length) break;
    raw.push(...arr);
    if (total !== null) { if (raw.length >= total) break; }
    else if (arr.length < size) break;
    if (raw.length >= max) break;
  }

  const idxOf = (m) => (m && m.message_index !== undefined ? Number(m.message_index) : NaN);
  const allIndexed = raw.length > 0 && raw.every((m) => Number.isFinite(idxOf(m)));
  const asc = allIndexed ? raw.slice().sort((a, b) => idxOf(a) - idxOf(b)) : raw.slice().reverse();

  return {
    messages: asc.map(normalizeMessage),
    total: total === null ? raw.length : total,
    nextCursor: null,
  };
}

function normalizeMessage(m = {}) {
  let text = '';
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.parts)) {
    text = m.parts.filter((p) => p && (p.type === 'text' || p.type === undefined) && typeof p.text === 'string').map((p) => p.text).join('');
  }
  return {
    index: m.message_index ?? null,
    role: m.role || m.message_type || null,
    text,
    at: toIso(m.create_time || m.time || null),
    raw: m,
  };
}

/** 回答提问：answers 形状见 answers.js（这是最容易 400 的地方） */
async function agentAnswer(ctx, id, { requestId, questionId, answers, questions } = {}) {
  const t = api(ctx);
  const pend = pendingQuestion(ctx, id);
  const qid = requestId || questionId || (pend && pend.requestId) || null;
  if (!qid) {
    throw new Error('回答提问缺 question_id：没收到过 question 事件时请显式传 requestId');
  }
  const qs = Array.isArray(questions) && questions.length ? questions : ((pend && pend.questions) || []);
  const shaped = buildAnswers(answers, qs);
  if (!shaped.length || shaped.every((g) => !g.length)) {
    throw new Error('回答提问的 answers 是空的');
  }
  const r = await t.request('POST', `/v1/cloudagent/sessions/${enc(id)}/messages/reply`, {
    body: { question_id: qid, answers: shaped },
  });
  forgetQuestion(ctx, id);
  return {
    ok: true,
    requestId: qid,
    answers: shaped,
    summary: describeAnswers(shaped),
    result: (r.json && r.json.result) || null,
  };
}

async function agentInterrupt(ctx, id) {
  const t = api(ctx);
  await t.request('POST', `/v1/cloudagent/sessions/${enc(id)}/messages/stop`, { body: {} });
  return { ok: true };
}

// ---------- fs ----------
function treeNode(json) {
  const j = json || {};
  const cand = [j.result, j.data, j.tree, j];
  for (const c of cand) {
    if (c && typeof c === 'object' && (Array.isArray(c.children) || c.path || c.name)) return c;
  }
  return null;
}

function flattenNode(node, out = [], depth = 0) {
  if (!node) return out;
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const k of kids) {
    if (!k) continue;
    const isDir = String(k.type || '').toLowerCase() === 'directory' || Array.isArray(k.children);
    out.push(fileEntry({
      path: k.path || k.absolute || `${node.path || WORKSPACE}/${k.name}`,
      name: k.name || '',
      type: isDir ? 'dir' : 'file',
      size: k.size ?? null,
      mtime: k.mtime ?? null,
    }));
    if (isDir && depth < 12) flattenNode(k, out, depth + 1);
  }
  return out;
}

function findNode(root, path) {
  if (!root || !path) return root;
  const want = String(path).replace(/\/+$/, '') || WORKSPACE;
  if (String(root.path || '').replace(/\/+$/, '') === want) return root;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (String(n.path || '').replace(/\/+$/, '') === want) return n;
    for (const c of Array.isArray(n.children) ? n.children : []) stack.push(c);
  }
  return null;
}

async function fsList(ctx, id, { path = WORKSPACE, recursive = false } = {}) {
  const t = api(ctx);
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  const r = await t.request('GET', `/v1/cloudagent/sessions/${enc(id)}/files/tree${q}`);
  const root = treeNode(r.json);
  if (!root) return [];
  if (recursive) {
    const node = findNode(root, path);
    return flattenNode(node || root);
  }
  const node = findNode(root, path);
  const kids = Array.isArray(node && node.children) ? node.children : (Array.isArray(root.children) ? root.children : []);
  return kids.filter(Boolean).map((k) => fileEntry({
    path: k.path || k.absolute || `${path}/${k.name}`,
    name: k.name || '',
    type: String(k.type || '').toLowerCase() === 'directory' || Array.isArray(k.children) ? 'dir' : 'file',
    size: k.size ?? null,
    mtime: k.mtime ?? null,
  }));
}

async function fsRead(ctx, id, { path, encoding = 'utf8' } = {}) {
  if (!path) throw new Error('fs.read 缺 path');
  const t = api(ctx);
  let fallback = true;
  try {
    const r = await t.request('GET', `/v1/cloudagent/sessions/${enc(id)}/files/content?path=${encodeURIComponent(path)}`);
    const j = r.json || {};
    const d = j.result || j.data || j;
    if (d && d.content !== undefined && (d.type === undefined || String(d.type).toLowerCase() === 'text')) {
      const content = typeof d.content === 'string' ? d.content : String(d.content);
      return { path, content, encoding: 'utf8', size: Buffer.byteLength(content) };
    }
    fallback = false;                       // 明确是二进制/其它类型
  } catch (e) {
    if (e && e.auth) throw e;
    fallback = true;                        // 接口不通或超限：退回 shell base64
  }

  const f = await pullFile(ctx, id, { remotePath: path });
  return {
    path,
    content: encoding === 'base64' ? f.buffer.toString('base64') : f.buffer.toString('utf8'),
    encoding: encoding === 'base64' ? 'base64' : 'utf8',
    size: f.size,
    via: 'shell',
    fallback,
  };
}

async function fsWrite(ctx, id, { path, content, encoding = 'utf8' } = {}) {
  if (!path) throw new Error('fs.write 缺 path');
  const buf = encoding === 'base64'
    ? Buffer.from(String(content === undefined || content === null ? '' : content), 'base64')
    : Buffer.from(String(content === undefined || content === null ? '' : content), 'utf8');
  const r = await pushFile(ctx, id, { remotePath: path, buffer: buf });
  return { path, size: r.size, chunks: r.chunks };
}

async function fsRemove(ctx, id, { path } = {}) {
  if (!path) throw new Error('fs.remove 缺 path');
  const r = await execRun(ctx, id, { command: `rm -rf ${shell.shQuote(path)}` });
  if (r.code !== 0) throw new Error(`删除 ${path} 失败 rc=${r.code}：${String(r.err || r.out).slice(0, 200)}`);
  return true;
}

// ---------- model ----------
async function modelList(ctx) {
  const t = api(ctx);
  const r = await t.request('GET', '/PromptCenterService/v1/model/builtin');
  const j = r.json || {};
  const arr = Array.isArray(j.result) ? j.result
    : Array.isArray(j.data) ? j.data
      : (Array.isArray(j.models) ? j.models : []);
  return arr.map((m) => {
    const o = m || {};
    return {
      id: o.id || o.model_id || o.modelId || o.name || '',
      name: o.name || o.display_name || o.displayName || o.id || '',
      ratio: o.ratio ?? o.credit_ratio ?? null,
      provider: o.providerID || o.provider || null,
      raw: o,
    };
  }).filter((m) => m.id);
}

// ---------- 组装 ----------
const provider = defineProvider({
  id: ID,
  displayName: '码道 CodeArts（华为云）',
  version: '1.0.0',
  capabilities: [
    CAP.AUTH,
    CAP.LOGIN_BROWSER,        // 登录要浏览器（或手动粘 cookie）
    CAP.LIST, CAP.CREATE, CAP.RENAME, CAP.REMOVE, CAP.META,
    CAP.AGENT, CAP.AGENT_QUESTION, CAP.AGENT_INTERRUPT,
    CAP.EXEC, CAP.EXEC_BG, CAP.WAKE,
    CAP.FS,
    CAP.MODEL,
    // 故意不声明：auth.renew（session cookie，不可续期）
  ],
  defaults: {
    baseUrl: transport.BASE,
    model: DEFAULT_MODEL,
    agent: DEFAULT_AGENT,
    jobDir: JOB_DIR,
  },
  limits: LIMITS,

  auth: {
    async state(ctx) { return auth.state(ctx); },
    ttlDays(st) { return auth.ttlDays(st); },
    async login(ctx, opts) { return auth.login(ctx, opts); },
    async importCookies(ctx, raw, opts) { return auth.importCookies(ctx, raw, opts); },
    async alive(ctx, opts) { return auth.alive(ctx, opts); },
    async logout(ctx) { auth.clear(ctx); return true; },
  },

  transport,                  // 平台专属 HTTP：内核不碰，但调试/doctor 可以看

  instances: {
    list: listInstances,
    get: getInstance,
    create: createInstance,
    rename: renameInstance,
    remove: removeInstance,
    info: infoInstance,
  },

  agent: {
    stream: agentStream,
    send: agentSend,
    history: agentHistory,
    answer: agentAnswer,
    interrupt: agentInterrupt,
    pendingQuestion,
  },

  exec: {
    probe: execProbe,
    run: execRun,
    start: execStart,
    poll: execPoll,
    wake: execWake,
    put(ctx, id, { localPath, remotePath, mode } = {}) {
      const buf = require('fs').readFileSync(localPath);
      return pushFile(ctx, id, { remotePath, buffer: buf, mode });
    },
    async get(ctx, id, { remotePath, localPath } = {}) {
      const r = await pullFile(ctx, id, { remotePath });
      require('fs').writeFileSync(localPath, r.buffer);
      return { size: r.size, truncated: r.truncated };
    },
  },

  fs: {
    list: fsList,
    read: fsRead,
    write: fsWrite,
    remove: fsRemove,
  },

  model: { list: modelList },

  doctor: {
    async checks(ctx, { net = true } = {}) {
      const out = [];
      const st = auth.read(ctx);
      if (!auth.isLoggedIn(st)) {
        out.push({ level: 'error', name: '登录态', detail: '没有 cookie：跑 wbsbx login --platform codearts（或 --cookie 粘一串）' });
        return out;
      }
      out.push({
        level: 'ok',
        name: '登录态',
        detail: `已保存${st.savedAt ? '（' + st.savedAt + '）' : ''}；session cookie 无固定期限，过期只能重抓`,
      });

      let hasPw = false;
      try { hasPw = !!(require('../../browser').hasPlaywright && require('../../browser').hasPlaywright()); } catch {}
      out.push({
        level: hasPw ? 'ok' : 'info',
        name: '浏览器',
        detail: hasPw ? 'playwright-core 可用（login 能直接开浏览器）' : '没有 playwright-core：login 请用 --cookie 手动粘贴',
      });

      // --no-net：不发任何请求（离线/容器里跑 doctor 时不能卡在超时上）
      if (!net) {
        out.push({ level: 'info', name: '网络', detail: '--no-net：跳过接口连通与会话列表探测' });
        return out;
      }

      try {
        const a = await auth.alive(ctx);
        out.push({ level: a.ok ? 'ok' : 'error', name: '接口连通', detail: a.ok ? 'GET /rest/me 正常' : `http=${a.status} ${String(a.reason || '').slice(0, 120)}` });
      } catch (e) {
        out.push({ level: 'error', name: '接口连通', detail: String(e.message).slice(0, 160) });
      }
      try {
        const list = await listInstances(ctx, { pageSize: 50 });
        out.push({ level: 'ok', name: '会话列表', detail: `${list.length} 个会话` });
        const withSandbox = list.filter((x) => x.agentSessionId).length;
        out.push({ level: 'info', name: '沙箱', detail: `${withSandbox}/${list.length} 个会话有 agent_session_id（有它才能 exec，否则要先 wake）` });
      } catch (e) {
        out.push({ level: 'error', name: '会话列表', detail: String(e.message).slice(0, 160) });
      }
      return out;
    },
  },
});

module.exports = provider;

// 供 selftest / 命令层直接用的内部件（不参与契约）
module.exports._internal = {
  LIMITS, WORKSPACE, JOB_DIR, PREVIEW_PORT, DEFAULT_MODEL, DEFAULT_AGENT, WAKE_PROMPT, CHUNK_BYTES,
  normalizeSession, normStatus, toIso, normalizeMessage, messageBody,
  treeNode, flattenNode, findNode,
  shellPath, pushFile, pullFile, execProbe,
};
