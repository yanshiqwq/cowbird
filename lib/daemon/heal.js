// 保活：对配置里的实例做一次「真实 API 访问」。
//
// 为什么这就够：平台按「有没有人在访问这个会话」决定要不要回收，而一次 E2B exec
// 就是货真价实的 API 调用。不需要在容器里装任何东西，也不需要发一句话打扰 agent。
//
// 两种模式，由目标自己声明：
//   probe（默认）  在容器里跑一条短命令（默认 uptime）。便宜，只证明"能进去"。
//   script         把本地脚本文件的内容送进去跑。用于全量自愈 —— 脚本自己负责检测、
//                  修复、并把结果以 ACTION: / ERROR: / STATE: 三种前缀打出来。
//   ⚠ 声明了 script 但读不到文件时**不会**退回 probe：配置写错要能被看见，而不是静默降级。
//
// ⚠ 一次不成就换 token 再来一次：老脚本的坑是「缓存 token 已失效但代码不重取」，
//   表现是每天 5xx/401 静默刷屏。这里把「失败 → 强制刷新 → 重试」固化成规则。
const fs = require('fs');
const path = require('path');
const cloud = require('../cloud');
const e2b = require('../e2b');

const head = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const lines = (out, prefix) => String(out || '').split('\n').filter((l) => l.startsWith(prefix));

function normalizeTargets(list) {
  return (list || [])
    .map((t) => (typeof t === 'string' ? { id: t } : t))
    .filter((t) => t && t.id)
    .map((t) => ({ id: String(t.id), name: t.name || '', script: t.script || '' }));
}

// 把目标声明的脚本读成文本。相对路径按 scriptsDir 解析（不给就用当前目录）。
function readScript(target, scriptsDir) {
  const p = path.isAbsolute(target.script)
    ? target.script
    : path.resolve(scriptsDir || '.', target.script);
  return { path: p, body: fs.readFileSync(p, 'utf8') };
}

async function healOne(target, opts, log, deps) {
  const { probe, timeoutSec, scriptsDir } = opts;
  const started = Date.now();
  const rec = {
    id: target.id, name: target.name, mode: target.script ? 'script' : 'probe',
    ok: false, code: null, attempt: 0, ms: 0, out: '',
    actions: [], errors: [], error: '',
  };

  let payload = probe;
  if (target.script) {
    try {
      const s = readScript(target, scriptsDir);
      payload = s.body;
      rec.script = s.path;
    } catch (e) {
      rec.error = `脚本读不到：${String(e.message).slice(0, 120)}`;
      rec.ms = Date.now() - started;
      log(`${rec.name || rec.id} FAIL ${rec.error}`, { id: rec.id });
      return rec;
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    rec.attempt = attempt;
    try {
      const creds = attempt === 1
        ? await deps.getSession(target.id, log)
        : await deps.refreshSession(target.id, log);   // 强制换一份新的再试
      const r = await deps.exec(creds, payload, { timeout: timeoutSec });
      rec.code = r.code;
      rec.out = head(r.out);
      rec.actions = lines(r.out, 'ACTION:');
      rec.errors = lines(r.out, 'ERROR:');
      rec.ok = r.code === 0 || r.code === null;
      if (rec.ok) break;
      rec.error = 'exit=' + r.code + ' ' + head(r.err, 120);
    } catch (e) {
      rec.error = head(e.message, 200);
    }
  }

  rec.ms = Date.now() - started;
  const tail = rec.ok
    ? (rec.actions.length || rec.errors.length ? ` (${rec.actions.length} 动作, ${rec.errors.length} 告警)` : '')
    : ' ' + rec.error;
  log(
    `${rec.name || rec.id} ${rec.ok ? 'ok' : 'FAIL'} ${rec.ms}ms` +
      (rec.attempt > 1 ? ` (第${rec.attempt}次尝试)` : '') + tail,
    rec.ok ? undefined : { id: rec.id }
  );
  // 脚本自己报的问题单独成行 —— 它们不等于本轮失败，但必须让人看见
  for (const l of rec.errors.slice(0, 5)) log(`${rec.name || rec.id} ! ${head(l, 200)}`);
  return rec;
}

async function runHeal({ targets, probe = 'uptime', timeoutSec = 120, scriptsDir = '' }, log = () => {}, deps = {}) {
  const d = {
    exec: deps.exec || e2b.exec,
    getSession: deps.getSession || cloud.getSession,
    refreshSession: deps.refreshSession || cloud.refreshSession,
  };
  const list = normalizeTargets(targets);
  if (!list.length) return { at: new Date().toISOString(), results: [], skipped: 'no-targets' };

  const results = [];
  for (const t of list) results.push(await healOne(t, { probe, timeoutSec, scriptsDir }, log, d));
  return {
    at: new Date().toISOString(),
    results,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    warned: results.filter((r) => r.ok && r.errors.length).length,
  };
}

module.exports = { runHeal, normalizeTargets };
