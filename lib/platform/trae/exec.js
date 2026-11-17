// exec 能力：**由沙箱里的 agent 代执行**（这个平台本来就是这个形状）。
//
// 为什么不是直连：TRAE 网页端没有 terminal/pty/shell 端点，沙箱里唯一能跑命令的是
// agent 的 Shell 工具。另一条"往插件 MCP 配置里挂一个自己的执行端"的路实测可行
// （见 docs/TRAE-一次性铺路执行通道.md），但需要沙箱内的 agent 去写宿主配置，
// 它判定为"绕开审批的常驻远程执行通道"并拒绝执行 —— 这个判断是对的，所以不走。
//
// 于是这里的语义很朴素：发一条消息让 agent 跑，等这一轮结束，把 Shell 的 stdout 取回来。
// 代价是每条命令一轮 LLM（约 10–25 秒），好处是它是平台设计内的用法，不需要任何提权。
const send = require('./send');

/** 给 agent 的固定句式：越死越好复现，且明确要求"只跑这一条、贴 stdout" */
function wrapPrompt(command) {
  return [
    '请只做一件事：用 Shell 工具在沙箱里原样跑下面这条命令，然后把 stdout 完整贴进一个代码块里，',
    '不要解释、不要调用其它工具、不要修改任何文件。',
    '',
    '```bash',
    String(command),
    '```',
  ].join('\n');
}

/** 会话能不能跑：能发消息就能跑（冷会话发一条就会把沙箱唤醒） */
async function probe(ctx, id) {
  try {
    const items = await send.fetchMessages(ctx, id, 1);
    void items;
    return { ready: true };
  } catch (e) {
    return { ready: false, why: 'unreachable', detail: String(e.message).slice(0, 160) };
  }
}

/** 唤醒 = 让它跑一轮（这个平台"跑一轮才分配沙箱"） */
async function wake(ctx, id, { log = () => {} } = {}) {
  log('发一条消息把沙箱唤醒（会消耗一轮）');
  const r = await send.turn(ctx, id, '请只回一句 ok，不要调用任何工具。', { timeoutMs: 120000 });
  return { ok: true, raw: r };
}

/**
 * 跑一条命令。
 * @returns {Promise<{out:string, err:string, code:number|null, ms:number, via:string, refused?:boolean}>}
 */
async function run(ctx, id, { command, timeoutMs = 180000 } = {}) {
  const t0 = Date.now();
  const r = await send.turn(ctx, id, wrapPrompt(command), { timeoutMs });
  const ms = Date.now() - t0;

  // 一次 turn 里 agent 可能调多个工具（EnvironmentSetup / Shell / finish），
  // 只认最后一条真正跑过命令的 Shell。
  const shells = (r.tools || []).filter((x) => /^shell$/i.test(String(x.name || '')));
  if (!shells.length) {
    // 没跑 = 它拒绝了（或这一轮没给工具）。把它的原话带出来，别编一个"失败"。
    const e = new Error(
      `agent 没有执行这条命令${r.timeout ? '（这一轮超时）' : ''}；` +
      (r.tools || []).length ? `这一轮只调了：${[...new Set((r.tools || []).map((x) => x.name))].join(', ')}` : '这一轮没有工具调用',
    );
    e.code = 'E_AGENT_REFUSED';
    e.refusal = r.summary || null;
    throw e;
  }
  const last = shells[shells.length - 1];
  return { out: String(last.text || ''), err: '', code: last.exitCode === undefined ? null : last.exitCode, ms, via: 'agent' };
}

module.exports = { run, probe, wake, wrapPrompt };
