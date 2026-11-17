// exec：走沙箱里的 MCP 通道（preview 网关 9003），不做"让 agent 代跑"的兜底。
//
// 这个平台没有给 CLI 用的执行端点（156 条里没有 terminal/pty/shell），但沙箱里的
// agent-tool-host 在 9003 上开了一个 MCP JSON-RPC 网关。`create` 时会在沙箱里装一个
// 只跑 `sh` 的执行端（见 prime.js），之后一条命令 0.3–1.2 秒、不消耗 agent 额度。
//
// 只有一条路：**装了就能跑，没装就跑不了**。装不上（例如沙箱里的 agent 拒绝执行那段
// 安装脚本）时，exec 直接报 E_NOT_PRIMED 并说明原因，不再偷偷改成"请 agent 代跑一轮" ——
// 那条路一条命令要 10–25 秒、还经常被拒，留着只会让人以为工具坏了。
const C = require('./constants');
const mcp = require('./mcp');

/** 铺路时注册的扩展名；换插件名/服务器名要同时改 prime.js 的 HOST_PLUGIN/SERVER_KEY */
const DEFAULT_EXT = 'user::trae-remote-official_plugin_deployment_exec';

const extIdOf = (ctx) => String((ctx && ctx.effective && ctx.effective.execExtId) || DEFAULT_EXT);

/**
 * 沙箱可执行吗？
 * @returns {Promise<{ready:boolean, why?:string, detail?:string}>}
 */
async function probe(ctx, id, opts = {}) {
  let conn;
  try {
    conn = await mcp.connect(ctx, id, opts);
  } catch (e) {
    return { ready: false, why: 'no-sandbox', detail: String(e.message).slice(0, 160) };
  }
  const status = Number(conn.session && conn.session.status);
  if (status === 1) return { ready: false, why: 'cold', detail: '会话还没跑过任何一轮' };
  const hs = await mcp.handshake(ctx, id, extIdOf(ctx), opts);
  if (hs.ok) return { ready: true };
  const p = hs.problem;
  if (p && p.kind === 'no-server') return { ready: false, why: 'not-primed', detail: '执行端还没装上' };
  return { ready: false, why: 'unreachable', detail: (p && p.message) || ('http=' + hs.http) };
}

/**
 * 跑一条命令。
 * @param {object} opts { command, timeoutMs, cwd, log, autoInstall }
 * @returns {Promise<{out:string, err:string, code:number|null, ms:number, via:string}>}
 */
async function run(ctx, id, opts = {}) {
  const { command, log = () => {}, autoInstall = true } = opts;
  if (!command) throw new Error('命令为空');

  let st = await probe(ctx, id);

  if (!st.ready && autoInstall && (st.why === 'not-primed' || st.why === 'cold')) {
    // 收编来的老会话 / 之前没装成功的会话：这里补装一次，装上就一直快
    const prime = require('./prime');
    log('这个沙箱还没有执行端，先装一次（会占两轮）…');
    try {
      await prime.install(ctx, id, { log });
    } catch (e) {
      if (e.code === 'E_PRIME_REFUSED') {
        // 同会话里它已经拒过一次，再劝也没用（上下文脏了）。让用户换新会话。
        const err = new Error(
          `这个会话里的 agent 拒绝装执行端，同一会话再试也没用（它会拿上一轮的判断当依据）。\n` +
          `  换一个干净的会话：cowbird create <名字>（create 会自动装，被拒会自己换新会话重试）。\n` +
          `  它这次的原话：${String(e.refusal || '').replace(/\s+/g, ' ').slice(0, 200) || '(无)'}`,
        );
        err.code = 'E_PRIME_REFUSED';
        err.refusal = e.refusal || null;
        throw err;
      }
      throw e;
    }
    st = await probe(ctx, id);
  }

  if (!st.ready) {
    const e = new Error(
      st.why === 'not-primed' || st.why === 'cold'
        ? '沙箱里没有执行端，跑不了命令。用 cowbird create 建的实例会自动装；收编来的会话跑一次 `cowbird create` 之外的 exec 会自动补装。'
        : `沙箱执行通道不可用：${st.detail || st.why}`,
    );
    e.code = 'E_NOT_PRIMED';
    throw e;
  }

  const t0 = Date.now();
  const result = await mcp.callTool(ctx, id, extIdOf(ctx), 'sh', {
    cmd: String(command),
    ...(opts.cwd ? { cwd: String(opts.cwd) } : {}),
    timeout_ms: Math.max(1000, Math.min(Number(opts.timeoutMs) || 60000, 600000)),
  }, { timeoutMs: Number(opts.timeoutMs) || 60000 });
  const text = (result.content || []).map((c) => c.text || '').join('');
  return { ...parseShellText(text), ms: Date.now() - t0, via: 'mcp' };
}

/**
 * exec-server 回的是这种纯文本：
 *   exit=0
 *   --- stdout ---
 *   ...
 *   --- stderr ---
 *   ...
 */
function parseShellText(text) {
  const s = String(text || '');
  const m = /^exit=(-?\d+)(?: signal=(\S+))?\n--- stdout ---\n([\s\S]*?)\n--- stderr ---\n([\s\S]*)$/.exec(s);
  if (!m) return { out: s, err: '', code: null };
  // exec-server 末尾固定补一个换行，stderr 会多吃一个
  return { code: Number(m[1]), signal: m[2] || null, out: m[3], err: m[4].replace(/\n$/, '') };
}

/** 唤醒 = 让沙箱跑起来并把执行端装上（这个平台"跑一轮才分配沙箱"） */
async function wake(ctx, id, { log = () => {} } = {}) {
  const prime = require('./prime');
  const r = await prime.install(ctx, id, { log });
  return { ok: !!(r && r.primed), raw: r };
}

module.exports = { run, probe, wake, parseShellText, extIdOf, DEFAULT_EXT };
