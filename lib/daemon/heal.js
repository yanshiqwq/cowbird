// 保活：对配置里的实例做一次「真实 API 访问」。
//
// 为什么这样就够：平台按「有没有人在访问这个会话」决定要不要回收，
// 而一次 E2B exec 就是货真价实的 API 调用。不需要在容器里装任何东西，
// 也不需要发一句话打扰 agent —— 这正是这套方案能对别人的实例也通用的原因。
//
// ⚠ 一次不成就换 token 再来一次：老脚本的坑是「缓存 token 已失效但代码不重取」，
//   表现是每天 5xx/401 静默刷屏。这里把「失败 → 强制刷新 → 重试」固化成规则。
const cloud = require('../cloud');
const e2b = require('../e2b');

const head = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function normalizeTargets(list) {
  return (list || [])
    .map((t) => (typeof t === 'string' ? { id: t } : t))
    .filter((t) => t && t.id)
    .map((t) => ({ id: String(t.id), name: t.name || '' }));
}

async function healOne(target, { probe, timeoutSec }, log) {
  const started = Date.now();
  const rec = { id: target.id, name: target.name, ok: false, code: null, attempt: 0, ms: 0, out: '', error: '' };

  for (let attempt = 1; attempt <= 2; attempt++) {
    rec.attempt = attempt;
    try {
      const s = attempt === 1
        ? await cloud.getSession(target.id, log)
        : await cloud.refreshSession(target.id, log);   // 强制换一份新的再试
      const r = await e2b.exec(s, probe, { timeout: timeoutSec });
      rec.code = r.code;
      rec.out = head(r.out);
      rec.ok = r.code === 0 || r.code === null;
      if (rec.ok) break;
      rec.error = 'exit=' + r.code + ' ' + head(r.err, 120);
    } catch (e) {
      rec.error = head(e.message, 200);
    }
  }
  rec.ms = Date.now() - started;
  log(
    `${rec.name || rec.id} ${rec.ok ? 'ok' : 'FAIL'} ${rec.ms}ms` +
      (rec.attempt > 1 ? ` (第${rec.attempt}次尝试)` : '') +
      (rec.ok ? '' : ' ' + rec.error),
    rec.ok ? undefined : { id: rec.id }
  );
  return rec;
}

async function runHeal({ targets, probe = 'uptime', timeoutSec = 60 }, log = () => {}) {
  const list = normalizeTargets(targets);
  if (!list.length) return { at: new Date().toISOString(), results: [], skipped: 'no-targets' };
  const results = [];
  for (const t of list) results.push(await healOne(t, { probe, timeoutSec }, log));
  return {
    at: new Date().toISOString(),
    results,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

module.exports = { runHeal, normalizeTargets };
