// 调度器：daemon 的全部「自动行为」都在这里。
//
// 三条循环互相独立，周期也不同：
//   heal    10 分钟 —— 让平台看到有人在访问，容器才不被回收（需要 exec 能力）
//   refresh 6 小时  —— 把访问凭据续在到期之前（需要 instances.refresh 能力）
//   renew   按需    —— 登录态快过期时才续（需要 auth.renew 能力，目前只有 WorkBuddy）
//
// 平台没有对应能力时，这一轮直接记 `skipped:'unsupported'` 并照常调度 ——
// 不报错、不重试、不假装成功。这样同一份 daemon 能跑在任何平台后面。
//
// 用递归 setTimeout 而不是 setInterval：上一轮没跑完不会再叠一轮。
// 每轮都落一次状态，`cowbird daemon status` 和 /health 直接读它。
const fs = require('fs');
const cfg = require('../config');
const channels = require('../platform/channels');
const { resolveTarget } = require('../platform/target');
const { CAP } = require('../platform/contract');
const { runHeal, normalizeTargets } = require('./heal');

const HOUR = 3600e3;

class Scheduler {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.timers = [];
    this.stopped = false;
    this.busy = { heal: false, refresh: false, renew: false, warm: false };
    this.state = {
      startedAt: new Date().toISOString(),
      lastHealAt: null, lastHeal: null,
      lastRefreshAt: null, lastRefresh: null,
      lastRenewAt: null, lastRenew: null,
      lastWarmAt: null, lastWarm: null,
      errors: 0,
    };
    this._load();
  }

  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(cfg.PATHS.daemonState, 'utf8'));
      // startedAt 用本次进程的，其余沿用历史（重启后还能看到上一轮结果）
      this.state = { ...this.state, ...j, startedAt: this.state.startedAt };
    } catch {}
  }

  _save() {
    try {
      cfg.ensureDirs();
      fs.writeFileSync(cfg.PATHS.daemonState, JSON.stringify(this.state, null, 1));
    } catch {}
  }

  get conf() { return cfg.readConfig(); }

  /** 默认渠道 + ctx（每次现取，`cowbird account use` 换渠道后无需重启 daemon） */
  _pf() {
    const ch = channels.preferred();
    return { p: ch.provider, ctx: ch.ctx, ch };
  }

  targets() {
    return normalizeTargets(this.conf.heal.targets);
  }

  setTargets(list) {
    const t = normalizeTargets(list);
    cfg.writeConfig({ heal: { targets: t } });
    this.log(`保活目标更新为 ${t.length} 个`, { targets: t.map((x) => x.name || x.id) });
    return t;
  }

  // ---------- heal ----------
  async healNow() {
    if (this.busy.heal) return { skipped: 'busy' };
    this.busy.heal = true;
    const c = this.conf;
    try {
      if (!c.heal.enabled) return { skipped: 'disabled' };
      const targets = normalizeTargets(c.heal.targets);
      if (!targets.length) {
        this.state.lastHeal = { at: new Date().toISOString(), skipped: 'no-targets' };
        this._save();
        return this.state.lastHeal;
      }
      const { ctx } = this._pf();
      const r = await runHeal(
        {
          targets,
          probe: c.heal.probe,
          timeoutSec: c.heal.timeoutSec,
          scriptsDir: c.heal.scriptsDir,
        },
        this.log,
        { ctx }
      );
      this.state.lastHealAt = r.at;
      this.state.lastHeal = r.skipped
        ? { at: r.at, skipped: r.skipped, reason: r.reason || null }
        : { at: r.at, ok: r.ok, failed: r.failed, warned: r.warned || 0, skipped: r.skipped || 0, results: r.results };
      if (r.failed) this.state.errors++;
      this._save();
      return this.state.lastHeal;
    } catch (e) {
      this.state.errors++;
      this.state.lastHeal = { at: new Date().toISOString(), error: e.message };
      this._save();
      this.log('heal 异常：' + e.message);
      return this.state.lastHeal;
    } finally {
      this.busy.heal = false;
    }
  }

  // ---------- refresh ----------
  /** 该刷哪些实例：给了 ids 就按引用解析，没给就跟着保活目标走。结果按渠道分组。 */
  async _refreshGroups(ids) {
    const groups = new Map();
    const push = (key, id) => {
      if (!groups.has(key)) groups.set(key, []);
      if (!groups.get(key).includes(String(id))) groups.get(key).push(String(id));
    };
    const def = channels.preferred();

    if (ids && ids.length) {
      for (const raw of ids) {
        try {
          const { ch, inst } = await resolveTarget(def.ctx, String(raw));
          push(ch.key, inst.id);
        } catch (e) {
          push(def.key, String(raw));      // 解析不了就按默认渠道硬刷，失败会被记下来
        }
      }
      return groups;
    }
    for (const t of this.targets()) push(t.channel || def.key, t.id);
    return groups;
  }

  async refreshNow(ids) {
    if (this.busy.refresh) return { skipped: 'busy' };
    this.busy.refresh = true;
    const c = this.conf;
    try {
      const groups = await this._refreshGroups(ids);
      const done = [], failed = [], unsupported = [];
      for (const [key, list] of groups) {
        let ch;
        try { ch = channels.get(key); } catch (e) { unsupported.push({ channel: key, why: String(e.message).slice(0, 120) }); continue; }
        const p = ch.provider;
        if (typeof p.instances.refresh !== 'function') { unsupported.push({ channel: key, why: 'unsupported' }); continue; }
        for (const id of list) {
          // 定时轮只补快过期的（--force 时全刷）
          if (!ids && typeof p.instances.expiry === 'function') {
            try {
              const at = await p.instances.expiry(ch.ctx, id);
              const fresh = at && at * 1000 - Date.now() > c.refresh.leadMs;
              if (fresh) continue;
            } catch { /* 拿不到到期时间就照刷不误 */ }
          }
          try {
            const d = await p.instances.refresh(ch.ctx, id);
            done.push({ channel: key, id, expireAt: (d && d.expireAt) || null });
          } catch (e) {
            failed.push({ channel: key, id, error: String(e.message).slice(0, 160) });
          }
        }
      }
      this.state.lastRefreshAt = new Date().toISOString();
      this.state.lastRefresh = {
        at: this.state.lastRefreshAt, done, failed,
        unsupported: unsupported.length ? unsupported : undefined,
      };
      if (failed.length) this.state.errors++;
      this._save();
      this.log(`refresh 完成 ok=${done.length} fail=${failed.length}` +
        (unsupported.length ? ` 跳过渠道 ${unsupported.map((x) => x.channel).join(',')}` : ''));
      return this.state.lastRefresh;
    } finally {
      this.busy.refresh = false;
    }
  }

  // ---------- renew ----------
  /** 逐个渠道续登录态：每个平台的续期方式不同，但对内核来说都是 auth.renew(ctx) */
  async renewNow({ force = false } = {}) {
    if (this.busy.renew) return { skipped: 'busy' };
    const c = this.conf;
    if (!force && !c.renew.enabled) return { skipped: 'disabled' };

    const targets = this.targets();
    const list = channels.all().filter((ch) => ch.provider.has(CAP.AUTH_RENEW) && typeof ch.provider.auth.renew === 'function');
    if (!list.length) {
      const r = { at: new Date().toISOString(), skipped: 'unsupported' };
      this.state.lastRenew = r;
      return r;
    }

    this.busy.renew = true;
    try {
      const results = [];
      for (const ch of list) {
        const p = ch.provider;
        try {
          const st = (typeof p.auth.stateAsync === 'function' ? await p.auth.stateAsync(ch.ctx) : await p.auth.state(ch.ctx)) || {};
          const ttl = typeof p.auth.ttlDays === 'function' ? p.auth.ttlDays(st) : null;
          // always=true 时每轮都续，不看剩余天数。这不是浪费 —— SSO 会话有空闲超时，
          // 只在快过期时才续会踩线（一旦 SSO 掉了，换 session 的路就断了，只能人工重登）。
          if (!force && !c.renew.always && ttl !== null && ttl > c.renew.whenDays) {
            results.push({ channel: ch.key, skipped: 'fresh', ttlDays: ttl });
            continue;
          }
          const verifyIds = targets.filter((t) => !t.channel || t.channel === ch.key).map((t) => t.id);
          const r = await p.auth.renew(ch.ctx, { force, verifyIds });
          results.push({ channel: ch.key, ...r });
        } catch (e) {
          results.push({ channel: ch.key, ok: false, error: String(e.message).slice(0, 200) });
        }
      }
      const ok = results.some((r) => r.ok);
      this.state.lastRenewAt = new Date().toISOString();
      this.state.lastRenew = { at: this.state.lastRenewAt, ok, results };
      if (!ok) this.state.errors++;
      this._save();
      // 登录态换新了，旧 token 对应的访问凭据也该跟着重拿（只刷续期成功的渠道）
      const renewed = results.filter((r) => r.ok).map((r) => r.channel);
      if (renewed.length) {
        const ids = targets.filter((t) => !t.channel || renewed.includes(t.channel)).map((t) => t.id);
        if (ids.length) await this.refreshNow(ids);
      }
      return this.state.lastRenew;
    } catch (e) {
      this.state.errors++;
      this.state.lastRenew = { ok: false, error: e.message };
      this._save();
      this.log('renew 异常：' + e.message);
      return this.state.lastRenew;
    } finally {
      this.busy.renew = false;
    }
  }

  // ---------- warm（登录态保活） ----------
  /**
   * 对每个渠道发一次轻量请求，让服务端别把会话回收。
   * 这是 cookie 型平台唯一可能的"续命"手段：它们没有 refresh_token，
   * 但很多控制面是按"最近有没有活动"来滑动过期的。
   * 判据只用 provider 的 `auth.alive()`（可选能力），没有就跳过，不装作做了。
   */
  async warmNow() {
    if (this.busy.warm) return { skipped: 'busy' };
    const c = this.conf;
    if (!c.warm || c.warm.enabled === false) return { skipped: 'disabled' };
    this.busy.warm = true;
    try {
      let chs = [];
      try { chs = channels.all(); } catch { chs = []; }
      const results = [];
      for (const ch of chs) {
        const a = ch.provider.auth;
        if (!a || typeof a.alive !== 'function') { results.push({ channel: ch.key, skipped: 'unsupported' }); continue; }
        const t0 = Date.now();
        try {
          const r = await a.alive(ch.ctx, {});
          const ok = !(r && r.ok === false);
          results.push({
            channel: ch.key, ok, status: (r && r.status) || null, ms: Date.now() - t0,
            error: ok ? null : String((r && (r.reason || r.error)) || '').slice(0, 160),
          });
        } catch (e) {
          results.push({ channel: ch.key, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 160) });
        }
      }
      const tried = results.filter((r) => r.ok !== undefined);
      const bad = tried.filter((r) => !r.ok);
      this.state.lastWarmAt = new Date().toISOString();
      this.state.lastWarm = { at: this.state.lastWarmAt, results };
      if (bad.length) this.state.errors++;
      this._save();
      this.log(`登录态保活 ${tried.length - bad.length}/${tried.length}` +
        (bad.length ? ` 失败: ${bad.map((b) => b.channel).join(', ')}` : ''));
      return this.state.lastWarm;
    } finally {
      this.busy.warm = false;
    }
  }

  // ---------- 循环 ----------
  _loop(name, intervalFn, runFn, initialDelayMs) {
    const tick = async () => {
      if (this.stopped) return;
      try { await runFn(); } catch (e) { this.log(`[${name}] 未捕获异常：${e.message}`); }
      if (this.stopped) return;
      const ms = Math.max(30e3, Number(intervalFn()) || 600e3);   // 最小 30s，防止配置写错把云端打爆
      const t = setTimeout(tick, ms);
      this.timers.push(t);
    };
    const t = setTimeout(tick, initialDelayMs);
    this.timers.push(t);
  }

  start() {
    this.stopped = false;
    const c = this.conf;
    const { p, ch } = this._pf();
    let nCh = 0;
    try { nCh = channels.all().length; } catch { nCh = 1; }
    // 启动时先等一会儿，把「重启风暴」错开（容器 recreate 时不必立刻打云端）
    this._loop('heal', () => this.conf.heal.intervalMs, () => this.healNow(), 15e3);
    this._loop('refresh', () => this.conf.refresh.intervalMs, () => this.refreshNow(), 60e3);
    this._loop('renew', () => 6 * HOUR, () => this.renewNow(), 120e3);
    this._loop('warm', () => (this.conf.warm && this.conf.warm.intervalMs) || 600e3, () => this.warmNow(), 90e3);
    this.log(
      `已启动 渠道=${nCh} 个（默认 ${ch.key}）heal=${Math.round(c.heal.intervalMs / 60e3)}min ` +
      `refresh=${Math.round(c.refresh.intervalMs / HOUR)}h ` +
      `renew=${p.has(CAP.AUTH_RENEW) ? (c.renew.enabled ? 'on' : 'off') : 'n/a'} ` +
      `targets=${normalizeTargets(c.heal.targets).length} ` +
      `warm=${c.warm && c.warm.enabled === false ? 'off' : Math.round(((c.warm && c.warm.intervalMs) || 600e3) / 60e3) + 'min'}`
    );
    return this;
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.log('调度器已停止');
  }

  async snapshot() {
    const c = this.conf;
    const { p, ctx } = this._pf();
    let st = {};
    try {
      st = (typeof p.auth.stateAsync === 'function' ? await p.auth.stateAsync(ctx) : await p.auth.state(ctx)) || {};
    } catch { /* 没有登录态概念的平台 */ }
    const ttl = st && typeof p.auth.ttlDays === 'function' ? p.auth.ttlDays(st) : null;
    const cookies = Array.isArray(st.cookies) ? st.cookies.length : 0;

    // 所有渠道的登录态摘要（本地读，不联网）
    let chs = [];
    try {
      chs = channels.all();
    } catch { chs = []; }
    const channelState = [];
    for (const ch of chs) {
      try {
        const d = await channels.describeLogin(ch);
        channelState.push({
          key: d.key, platform: d.platform, account: d.account, displayName: d.displayName,
          present: d.hasCred, who: d.who || null, ttlDays: d.ttlDays, files: d.files,
          exec: ch.provider.has(CAP.EXEC),
          refresh: typeof ch.provider.instances.refresh === 'function',
          renew: ch.provider.has(CAP.AUTH_RENEW),
        });
      } catch (e) {
        channelState.push({ key: ch.key, platform: ch.platform, account: ch.account, error: String(e.message).slice(0, 120) });
      }
    }

    return {
      ...this.state,
      platform: p.id,
      channel: ctx.channel,
      uptimeSec: Math.floor((Date.now() - Date.parse(this.state.startedAt)) / 1000),
      targets: normalizeTargets(c.heal.targets),
      channels: channelState,
      capabilities: {
        exec: p.has(CAP.EXEC),
        refresh: typeof p.instances.refresh === 'function',
        renew: p.has(CAP.AUTH_RENEW),
        wake: p.has(CAP.WAKE),
      },
      config: {
        heal: { enabled: c.heal.enabled, intervalMs: c.heal.intervalMs, probe: c.heal.probe },
        refresh: { intervalMs: c.refresh.intervalMs, leadMs: c.refresh.leadMs },
        renew: { enabled: c.renew.enabled, whenDays: c.renew.whenDays },
        warm: { enabled: !(c.warm && c.warm.enabled === false), intervalMs: (c.warm && c.warm.intervalMs) || 600e3 },
      },
      login: {
        present: !!(st && (cookies || st.token)),
        hasUa: !!st.ua,
        cookies,
        ttlDays: ttl,
      },
      // daemon 自己永远是本地凭据源（它本身就是权威，不去请求自己）
      mode: 'local',
    };
  }
}

module.exports = { Scheduler, normalizeTargets };
