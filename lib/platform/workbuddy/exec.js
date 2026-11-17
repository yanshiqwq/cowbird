'use strict';
// exec 通道：E2B 数据面（`POST {e2bDataEndpoint}/process.Process/Start`，connect+json 五字节帧）。
//
// 现成实现在 lib/e2b.js，这里只做适配：
//   · 契约的 execResult（{out,err,code,ms,truncated}）
//   · 秒级 timeout 与内核毫秒级 timeoutMs 的换算（E2B 侧只认秒，实测约 60s 天花板）
//   · 后台任务：nohup 起进程 + 输出落文件 + 退出码落文件，poll 时一并读回
//   · put/get 直接复用 e2b.put/get（分块 base64 + 大小校验都是现成的）
const cloud = require('./lib/cloud');
const e2b = require('./lib/e2b');
const { execResult } = require('../contract');
const { logf, shq, clipText } = require('./util');

const WORKSPACE = '/workspace';
const JOBS_DIR = `${WORKSPACE}/.wbsbx/jobs`;

// E2B 单次执行实测上限约 60s（commands/exec.js 的默认值也是 60）。超过这个数的命令必须走后台。
const MAX_SYNC_MS = 60e3;
const MAX_OUTPUT_BYTES = 1 << 20;
const PROBE_TIMEOUT_S = 15;

/** 毫秒 → E2B 的秒；没给或非法就用上限，超了截到上限 */
function timeoutSeconds(timeoutMs, maxSyncMs = MAX_SYNC_MS) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return Math.max(1, Math.round(maxSyncMs / 1000));
  return Math.max(1, Math.round(Math.min(n, maxSyncMs) / 1000));
}

/** env 既可能是 {'K':'V'} 也可能是 ['K=V']，都归一成对象（E2B 的 envs 是 map） */
function normalizeEnv(env) {
  if (!env) return {};
  if (Array.isArray(env)) {
    const out = {};
    for (const item of env) {
      const s = String(item || '');
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
    }
    return out;
  }
  if (typeof env === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(env)) if (k) out[k] = String(v === undefined || v === null ? '' : v);
    return out;
  }
  return {};
}

/** e2b 的原始结果 → 契约 execResult（带耗时与截断标记） */
function toExecResult(r, ms, maxOutputBytes = MAX_OUTPUT_BYTES) {
  const out = clipText(r && r.out, maxOutputBytes);
  const err = clipText(r && r.err, maxOutputBytes);
  return execResult({
    out: out.text,
    err: err.text,
    code: r && r.code !== undefined ? r.code : null,
    ms,
    truncated: out.truncated || err.truncated,
  });
}

/** 取凭据 + 跑一条命令（fsops 也走这个，保证超时/环境变量行为一致） */
async function runShell(ctx, id, command, opts = {}) {
  const log = logf(ctx);
  const creds = await cloud.getSession(String(id), log);
  const t0 = Date.now();
  const r = await e2b.exec(creds, String(command), {
    timeout: timeoutSeconds(opts.timeoutMs, MAX_SYNC_MS),
    cwd: opts.cwd || WORKSPACE,
    envs: normalizeEnv(opts.env),
  });
  return toExecResult(r, Date.now() - t0, Number(opts.maxOutputBytes) > 0 ? Number(opts.maxOutputBytes) : MAX_OUTPUT_BYTES);
}

/**
 * exec.run：一条同步命令。
 * 传输层失败（HTTP 非 200 / 通道超时）直接抛 —— 那不是「命令返回非 0」，
 * 内核需要把两者区分开，别用 code=null 糊过去。
 */
async function run(ctx, id, opts = {}) {
  const command = opts.command === undefined || opts.command === null ? '' : String(opts.command);
  if (!command.trim()) throw new Error('exec.run 需要 command');
  return runShell(ctx, id, command, opts);
}

/**
 * exec.probe：容器是否可用。
 * 判据：`GET /session` 能拿到凭据 且 `exec('true')` 不报错。
 * E2B 不保证发 end 帧（成功时 exitCode 字段被 proto3 省略），所以 code=null + 无 stderr 也算通。
 *
 * 返回里带 `why`：内核的 ensureReady 直接把 `st.why` 抄进「沙箱不可用：…」的报错里。
 */
async function probe(ctx, id) {
  const log = logf(ctx);
  const t0 = Date.now();
  try {
    const creds = await cloud.getSession(String(id), log);
    const r = await e2b.exec(creds, 'true', { timeout: PROBE_TIMEOUT_S });
    const ms = Date.now() - t0;
    const ready = r.code === 0 || (r.code === null && !String(r.err || '').trim());
    if (ready) return { ready: true, ms, code: r.code, sandboxId: creds.sandboxId || null };
    const why = String(r.err || '').trim().slice(0, 200) || `exec('true') 返回 code=${r.code}`;
    return { ready: false, why, ms, code: r.code, detail: why };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 200);
    return { ready: false, why, ms: Date.now() - t0, error: why, code: (e && e.code) || null };
  }
}

/**
 * exec.wake：把沙箱弄到「exec 能用」。
 *
 * ⚠ 本 provider **没有**声明 `exec.wake` 能力：WorkBuddy 的沙箱是长寿的（抽样里最长 22 小时），
 *   也没有独立的唤醒接口 —— exec 本来就能直连，声明 wake 反而是误导。
 *   这个函数留着给内核按需调用（或上层脚本用）：重新要一次凭据再探活，直到通或超时。
 */
async function wake(ctx, id, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60e3;
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 2000;
  const { sleep } = require('./util');
  const t0 = Date.now();
  let attempts = 0;
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    attempts++;
    last = await probe(ctx, id);
    if (last.ready) return { ok: true, waitedMs: Date.now() - t0, attempts, detail: last };
    await sleep(intervalMs);
  }
  return { ok: false, waitedMs: Date.now() - t0, attempts, detail: last };
}

/** 后台任务的三个文件：输出、退出码、pid。退出码先写 .tmp 再 mv，poll 永远不会读到半个数字 */
function jobPaths(jobId) {
  const id = String(jobId);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`非法 jobId：${id}`);
  return {
    outputPath: `${JOBS_DIR}/${id}.log`,
    exitPath: `${JOBS_DIR}/${id}.exit`,
    pidPath: `${JOBS_DIR}/${id}.pid`,
  };
}

/**
 * exec.start：nohup 起后台。E2B 没有原生后台任务（报告里也是「自己 nohup & + 轮询」）。
 * 返回 jobId + 输出文件路径，后续用 exec.poll 读。
 */
async function start(ctx, id, opts = {}) {
  const command = opts.command === undefined || opts.command === null ? '' : String(opts.command);
  if (!command.trim()) throw new Error('exec.start 需要 command');
  const jobId = 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const { outputPath, exitPath, pidPath } = jobPaths(jobId);
  const exitTmp = exitPath + '.tmp';
  const cwd = opts.cwd || WORKSPACE;

  // 内层脚本：跑命令 → 把退出码落盘。用 sh -c 包一层，中间被 kill 时退出码文件就不会出现，
  // poll 于是能一直显示 running（exec.kill 会补写 143，见下）。
  const inner = [
    `cd ${shq(cwd)} 2>/dev/null || exit 127`,
    command,
    `__wb_code=$?`,
    `printf '%s\\n' "$__wb_code" > ${shq(exitTmp)}`,
    `mv -f ${shq(exitTmp)} ${shq(exitPath)}`,
  ].join('\n');

  const outer = [
    `mkdir -p ${shq(JOBS_DIR)}`,
    `rm -f ${shq(exitPath)} ${shq(exitTmp)}`,
    `: > ${shq(outputPath)}`,
    `nohup /bin/sh -c ${shq(inner)} > ${shq(outputPath)} 2>&1 &`,
    `echo $! > ${shq(pidPath)}`,
    `cat ${shq(pidPath)}`,
  ].join('\n');

  const r = await runShell(ctx, id, outer, { timeoutMs: 30000, cwd: WORKSPACE, env: opts.env });
  const pid = Number(String(r.out || '').trim());
  return {
    jobId,
    outputPath,
    pid: Number.isFinite(pid) ? pid : null,
    startedAt: new Date().toISOString(),
    cwd,
  };
}

/** 解析 poll 脚本的输出：一行状态 + 一段日志尾巴 */
function parsePollOutput(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  const m = raw.match(/__WBSBX_STATE__=(done|running|missing):([^\n]*)/);
  const state = m ? m[1] : 'missing';
  const value = m ? m[2].trim() : '';
  const marker = '__WBSBX_LOG__';
  const i = raw.indexOf(marker);
  const out = i >= 0 ? raw.slice(i + marker.length).replace(/^\r?\n/, '') : '';
  // 退出码文件可能是空的（刚 mv 完就被读到）：空串按「还不知道」处理，别当成 0
  const codeNum = state === 'done' && value !== '' ? Number(value) : null;
  return {
    done: state === 'done' && value !== '',
    state,
    code: Number.isFinite(codeNum) ? codeNum : null,
    pid: state === 'running' ? Number(value) || null : null,
    out,
  };
}

/**
 * exec.poll：读后台任务的输出与退出码。
 * 一条命令同时返回状态和日志尾巴，省一次 E2B 往返（单程 300–1500ms）。
 */
async function poll(ctx, id, opts = {}) {
  const { jobId } = opts;
  if (!jobId) throw new Error('exec.poll 需要 jobId');
  const { outputPath, exitPath, pidPath } = jobPaths(jobId);
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 256 * 1024;
  const script = [
    `if [ -f ${shq(exitPath)} ]; then printf '__WBSBX_STATE__=done:%s\\n' "$(cat ${shq(exitPath)} 2>/dev/null)";`,
    `elif [ -f ${shq(pidPath)} ]; then printf '__WBSBX_STATE__=running:%s\\n' "$(cat ${shq(pidPath)} 2>/dev/null)";`,
    `else printf '__WBSBX_STATE__=missing:\\n'; fi`,
    `printf '__WBSBX_LOG__\\n'`,
    `tail -c ${maxBytes} ${shq(outputPath)} 2>/dev/null`,
  ].join('\n');

  const r = await runShell(ctx, id, script, { timeoutMs: 30000 });
  const p = parsePollOutput(r.out);
  return {
    done: p.done,
    state: p.state,
    code: p.code,
    pid: p.pid,
    out: p.out,
    outputPath,
    truncated: r.truncated,
  };
}

/**
 * exec.kill：结束后台任务。
 * 只 kill 我们起的那个 sh（不是进程组）；kill 之后主动补写 143（SIGTERM 的惯例退出码），
 * 否则 poll 会永远显示 running —— 因为内层脚本没机会写退出码文件。
 */
async function kill(ctx, id, opts = {}) {
  const { jobId } = opts;
  if (!jobId) throw new Error('exec.kill 需要 jobId');
  const { exitPath, pidPath } = jobPaths(jobId);
  const script = [
    `if [ -f ${shq(pidPath)} ]; then`,
    `  __wb_pid=$(cat ${shq(pidPath)} 2>/dev/null)`,
    `  if [ -n "$__wb_pid" ] && kill -TERM "$__wb_pid" 2>/dev/null; then`,
    `    printf '143\\n' > ${shq(exitPath)}`,
    `    printf 'killed %s\\n' "$__wb_pid"`,
    `  else printf 'gone %s\\n' "$__wb_pid"; fi`,
    `else printf 'no-pid\\n'; fi`,
  ].join('\n');
  const r = await runShell(ctx, id, script, { timeoutMs: 30000 });
  return { ok: /^killed\b/.test(r.out.trim()), detail: r.out.trim() || r.err.trim() };
}

/** exec.put：本地文件 → 沙箱（复用 e2b.put 的分块 base64，60KB 一块，避开 MAX_ARG_STRLEN） */
async function put(ctx, id, opts = {}) {
  const { localPath, remotePath } = opts;
  if (!localPath || !remotePath) throw new Error('exec.put 需要 localPath 与 remotePath');
  const log = logf(ctx);
  const creds = await cloud.getSession(String(id), log);
  const r = await e2b.put(creds, localPath, remotePath, { timeout: timeoutSeconds(opts.timeoutMs, 300e3) });
  return { remotePath, size: r.size, chunks: r.chunks };
}

/** exec.get：沙箱 → 本地（同样复用 e2b.get） */
async function get(ctx, id, opts = {}) {
  const { remotePath, localPath } = opts;
  if (!localPath || !remotePath) throw new Error('exec.get 需要 remotePath 与 localPath');
  const log = logf(ctx);
  const creds = await cloud.getSession(String(id), log);
  const r = await e2b.get(creds, remotePath, localPath, { timeout: timeoutSeconds(opts.timeoutMs, 300e3) });
  return { localPath, size: r.size };
}

module.exports = {
  WORKSPACE, JOBS_DIR, MAX_SYNC_MS, MAX_OUTPUT_BYTES,
  timeoutSeconds, normalizeEnv, toExecResult, runShell, run, probe, wake,
  start, poll, kill, put, get, jobPaths, parsePollOutput,
};
