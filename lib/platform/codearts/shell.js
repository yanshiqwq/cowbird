// 沙箱内 shell 侧的约定：命令包装、结果解析、后台任务。
//
// 背景（实测）：免 LLM 通道就是给沙箱内 agentkernel 发 `{command}`，它回的是 bash 工具的
// 一个 part：{state:{status,output}} —— **没有 exit code，stdout 和 stderr 是混在一起的**。
// 契约里 execResult 有 out/err/code 三个字段，所以只能自己在命令尾部打标记把它们拆开：
//
//     ( <command> ) 2>临时文件
//     printf '\n__WBSBX_RC=%d\n' $?      ← 退出码
//     printf '__WBSBX_STDERR__\n'        ← 之后全是 stderr
//
// 用 `( … )` 子 shell 而不是 `{ …; }`：命令里写 `exit 3` 时只退出子 shell，标记还能打出来。
// 标记解析一律**从后往前**找最后一次出现，命令自己打印同名文本也骗不过去。
//
// 这几个函数都是纯函数，selftest.js 直接调。

const RC_MARK = '__WBSBX_RC=';
const ERR_MARK = '__WBSBX_STDERR__';
const JOB_RC_MARK = '__WBSBX_JOB_RC=';
const BEGIN_MARK = '__WBSBX_BEGIN__';

/** POSIX 单引号转义：'a'"'"'b' 这种 */
function shQuote(s) {
  return `'${String(s === undefined || s === null ? '' : s).replace(/'/g, "'\\''")}'`;
}

/**
 * 环境变量前缀：`export K='V'` 若干行。
 * 只接受合法变量名（防止把奇怪的东西拼进命令行），非法名直接忽略。
 */
function envPrefix(env) {
  if (!env || typeof env !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (v === undefined || v === null) continue;
    out.push(`export ${k}=${shQuote(v)}`);
  }
  return out;
}

/**
 * 给用户命令套上"退出码 + stderr 分离"的壳。
 * @param {string} command 原样命令（可以是多行）
 * @param {{cwd?: string, env?: object}} [opts]
 */
function wrapCommand(command, { cwd, env } = {}) {
  const body = String(command === undefined || command === null ? '' : command);
  const pre = cwd ? `cd ${shQuote(cwd)} || { printf 'wbsbx: 无法进入 %s\n' ${shQuote(cwd)} >&2; }` : '';
  // ⚠ 实测（2026-11-17）：这个 /shell 端点**不是通用 bash**：
  //   ① 换行会被吞掉（`echo a\necho b` → `anecho b`）；
  //   ② shell 变量不保留（`X=1; echo X=$X` → `X=`），连 `f=$(mktemp)` 都拿不到值。
  //   所以外层命令必须"零变量、零换行"，把真正要跑的脚本 base64 后**管道喂给 bash -s**。
  //   实测 `echo <b64> | base64 -d | bash -s` 能完整保留变量、子 shell、退出码与引号。
  const script = [pre, ...envPrefix(env), body].filter(Boolean).join('\n');
  const inner = [
    '__e=$(mktemp 2>/dev/null || echo /tmp/.wbsbx-e-$$)',
    `( ${script} ) 2>"$__e"`,
    '__r=$?',
    `printf '\\n${RC_MARK}%d\\n' "$__r"`,
    `printf '${ERR_MARK}\\n'`,
    'cat "$__e" 2>/dev/null',
    'rm -f "$__e"',
  ].join('\n');
  const b64 = Buffer.from(inner, 'utf8').toString('base64');
  return `echo ${shQuote(b64)} | base64 -d | bash -s`;
}

/**
 * 解析 wrapCommand 的输出 → {out, err, code, wrapped}
 * 标记缺失（被网关截断、或 raw 模式）时返回 wrapped:false，out 原样给出。
 */
function parseWrapped(text) {
  const s = String(text === undefined || text === null ? '' : text);
  const at = s.lastIndexOf(RC_MARK);
  if (at < 0) return { out: s, err: '', code: null, wrapped: false };

  const before = s.slice(0, at);
  const after = s.slice(at + RC_MARK.length);
  const nl = after.indexOf('\n');
  const codeStr = (nl === -1 ? after : after.slice(0, nl)).trim();
  const code = /^-?\d+$/.test(codeStr) ? Number(codeStr) : null;
  const rest = nl === -1 ? '' : after.slice(nl + 1);

  // out：标记之前的所有内容，去掉 printf 自己引入的那个换行
  const out = before.endsWith('\n') ? before.slice(0, -1) : before;

  const ei = rest.indexOf(ERR_MARK);
  let err = '';
  if (ei >= 0) {
    err = rest.slice(ei + ERR_MARK.length);
    if (err.startsWith('\n')) err = err.slice(1);
  } else {
    err = rest;                       // 理论上不会走到；真到了就当 stderr 用，别丢东西
  }

  return { out, err, code, wrapped: true };
}

/**
 * 解析 agentkernel `/shell` 的响应体。
 * @param {object} json  响应 JSON
 * @param {{ms?:number, truncated?:boolean}} [opts]
 *
 * ★ 网关 30s 硬上限的表现（实测）：HTTP 200、`state.status` 空、`state.output` 空，
 *   而命令**仍在沙箱里继续跑**。所以「status 与 output 双空」= 被截断，不是"命令没输出"。
 */
function parseShellResult(json, { ms = 0, truncated = false } = {}) {
  const parts = (json && Array.isArray(json.parts) && json.parts) || [];
  const tool = parts.find((p) => p && p.type === 'tool') || parts[0] || null;
  const state = (tool && tool.state) || {};
  let raw = state.output;
  if (raw === undefined && state.metadata) raw = state.metadata.output;
  const out = raw === undefined || raw === null ? '' : (typeof raw === 'string' ? raw : String(raw));
  const status = state.status ? String(state.status) : '';
  const cut = !!truncated || (!status && out === '');
  return {
    out,
    status,
    truncated: cut,
    callId: (tool && (tool.callID || tool.callId)) || null,
    tool: (tool && tool.tool) || null,
    tokens: (json && json.info && json.info.tokens) || null,
    ms,
  };
}

/** 后台任务：nohup 起、日志写 /workspace/.wbsbx/<job>.log、pid 写 <job>.pid */
function buildJobScript({ jobId, command, cwd, env, dir }) {
  const log = `${dir}/${jobId}.log`;
  const pid = `${dir}/${jobId}.pid`;
  // 子 shell 里跑用户命令，尾部把退出码写进日志（用 JOB_RC_MARK，避免和包装层的 RC 撞）
  const inner = [
    ...envPrefix(env),
    cwd ? `cd ${shQuote(cwd)} || exit 127` : '',
    String(command === undefined || command === null ? '' : command),
    `printf '\\n${JOB_RC_MARK}%d\\n' $?`,
  ].filter(Boolean).join('\n');

  return [
    `mkdir -p ${shQuote(dir)}`,
    `rm -f ${shQuote(log)} ${shQuote(pid)}`,
    `nohup sh -c ${shQuote(inner)} > ${shQuote(log)} 2>&1 &`,
    `echo $! > ${shQuote(pid)}`,
    `cat ${shQuote(pid)}`,
  ].join('\n');
}

/** 轮询：一次命令拿齐「大小 / pid / 还活着吗 / 日志内容」 */
const POLL_TAIL_BYTES = 200000;
function buildPollScript({ jobId, dir }) {
  const log = `${dir}/${jobId}.log`;
  const pid = `${dir}/${jobId}.pid`;
  return [
    `__l=${shQuote(log)}`,
    `__p=${shQuote(pid)}`,
    'if [ ! -f "$__l" ] && [ ! -f "$__p" ]; then echo "__WBSBX_MISSING=1"; exit 0; fi',
    '__sz=$(wc -c < "$__l" 2>/dev/null || echo 0)',
    'echo "__WBSBX_SIZE=$__sz"',
    '__pid=$(cat "$__p" 2>/dev/null || echo "")',
    'echo "__WBSBX_PID=$__pid"',
    'if [ -n "$__pid" ] && kill -0 "$__pid" 2>/dev/null; then echo "__WBSBX_ALIVE=1"; else echo "__WBSBX_ALIVE=0"; fi',
    `echo "${BEGIN_MARK}"`,
    'if [ -f "$__l" ]; then',
    `  if [ "$__sz" -gt ${POLL_TAIL_BYTES} ]; then echo "__WBSBX_TAIL=1"; tail -c ${POLL_TAIL_BYTES} "$__l"; else cat "$__l"; fi`,
    'fi',
  ].join('\n');
}

/** 解析 buildPollScript 的输出 */
function parsePoll(text) {
  const s = String(text === undefined || text === null ? '' : text);
  const at = s.indexOf(BEGIN_MARK);
  const head = at === -1 ? s : s.slice(0, at);
  let body = at === -1 ? '' : s.slice(at + BEGIN_MARK.length);
  if (body.startsWith('\n')) body = body.slice(1);

  const meta = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^__WBSBX_([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) meta[m[1].toLowerCase()] = m[2];
  }

  // 日志尾部自己的退出码标记
  const jAt = body.lastIndexOf(JOB_RC_MARK);
  let done = false;
  let code = null;
  let out = body;
  let err = '';
  if (jAt >= 0) {
    const after = body.slice(jAt + JOB_RC_MARK.length);
    const nl = after.indexOf('\n');
    const codeStr = (nl === -1 ? after : after.slice(0, nl)).trim();
    if (/^-?\d+$/.test(codeStr)) {
      done = true;
      code = Number(codeStr);
      out = body.slice(0, jAt);
      if (out.endsWith('\n')) out = out.slice(0, -1);   // printf 引入的换行
      err = nl === -1 ? '' : after.slice(nl + 1);
    }
  }

  return {
    done,
    code,
    out,
    err,
    alive: meta.alive === '1',
    missing: meta.missing === '1',
    size: meta.size !== undefined ? Number(meta.size) : null,
    pid: meta.pid || null,
    truncated: meta.tail === '1',
  };
}

module.exports = {
  RC_MARK, ERR_MARK, JOB_RC_MARK, BEGIN_MARK,
  shQuote, envPrefix, wrapCommand, parseWrapped, parseShellResult,
  buildJobScript, buildPollScript, parsePoll, POLL_TAIL_BYTES,
};
