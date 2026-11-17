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
// 每轮都落一次状态，`wbsbx daemon status` 和 /health 直接读它。
const fs = require('fs');
const cfg = require('../config');
const registry = require('../platform');
const { CAP } = require('../platform/contract');
const { runHeal, normalizeTargets } = require('./heal');

const HOUR = 3600e3;

class Scheduler {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.timers = [];
    this.stopped = false;
    this.busy = { heal: false, refresh: false, renew: false };
    this.state = {
      startedAt: new Date().toISOString(),
      lastHealAt: null, lastHeal: null,
      lastRefreshAt: null, lastRefresh: null,
      lastRenewAt: null, lastRenew: null,
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

  /** 当前平台 + ctx（每次现取，`wbsbx platform use` 换平台后无需重启 daemon） */
  _pf() {
    const p = registry.get();
    return { p, ctx: registry.context(p) };
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
        : { at: r.at, ok: r.ok, failed: r.failed, warned: r.warned || 0, results: r.results };
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
  async refreshNow(ids) {
    if (this.busy.refresh) return { skipped: 'busy' };
    this.busy.refresh = true;
    const c = this.conf;
    try {
      const { p, ctx } = this._pf();
      if (typeof p.instances.refresh !== 'function') {
        this.state.lastRefreshAt = new Date().toISOString();
        this.state.lastRefresh = { at: this.state.lastRefreshAt, skipped: 'unsupported', platform: p.id };
        this._save();
        return this.state.lastRefresh;
      }
      const want = ids && ids.length
        ? ids.map(String)
        : [...new Set(this.targets().map((t) => t.id))];
      const done = [], failed = [];
      for (const id of want) {
        // 定时轮只补快过期的（--force 时全刷）
        if (!ids && typeof p.instances.expiry === 'function') {
          try {
            const at = await p.instances.expiry(ctx, id);
            const fresh = at && at * 1000 - Date.now() > c.refresh.leadMs;
            if (fresh) continue;
          } catch { /* 拿不到到期时间就照刷不误 */ }
        }
        try {
          const d = await p.instances.refresh(ctx, id);
          done.push({ id, expireAt: (d && d.expireAt) || null });
        } catch (e) {
          failed.push({ id, error: String(e.message).slice(0, 160) });
        }
      }
      this.state.lastRefreshAt = new Date().toISOString();
      this.state.lastRefresh = { at: this.state.lastRefreshAt, done, failed };
      if (failed.length) this.state.errors++;
      this._save();
      this.log(`refresh 完成 ok=${done.length} fail=${failed.length}`);
      return this.state.lastRefresh;
    } finally {
      this.busy.refresh = false;
    }
  }

  // ---------- renew ----------
  async renewNow({ force = false } = {}) {
    if (this.busy.renew) return { skipped: 'busy' };
    const c = this.conf;
    const { p, ctx } = this._pf();
    if (!p.has(CAP.AUTH_RENEW) || typeof p.auth.renew !== 'function') {
      const r = { at: new Date().toISOString(), skipped: 'unsupported', platform: p.id };
      this.state.lastRenew = r;
      return r;
    }
    if (!force && !c.renew.enabled) return { skipped: 'disabled' };

    const st = (typeof p.auth.stateAsync === 'function' ? await p.auth.stateAsync(ctx) : await p.auth.state(ctx)) || {};
    const ttl = typeof p.auth.ttlDays === 'function' ? p.auth.ttlDays(st) : null;
    // always=true 时每轮都续，不看剩余天数。这不是浪费 —— SSO 会话有空闲超时，
    // 只在快过期时才续会踩线（一旦 SSO 掉了，换 session 的路就断了，只能人工扫码）。
    if (!force && !c.renew.always && ttl !== null && ttl > c.renew.whenDays) {
      return { skipped: 'fresh', ttlDays: ttl };
    }

    this.busy.renew = true;
    try {
      const r = await p.auth.renew(ctx, { force, verifyIds: this.targets().map((t) => t.id) });
      this.state.lastRenewAt = new Date().toISOString();
      this.state.lastRenew = r;
      if (!r.ok) this.state.errors++;
      this._save();
      if (r.ok) {
        // cookie 换新了，旧 token 对应的访问凭据也该跟着重拿
        await this.refreshNow(this.targets().map((t) => t.id));
      }
      return r;
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
    const { p } = this._pf();
    // 启动时先等一会儿，把「重启风暴」错开（容器 recreate 时不必立刻打云端）
    this._loop('heal', () => this.conf.heal.intervalMs, () => this.healNow(), 15e3);
    this._loop('refresh', () => this.conf.refresh.intervalMs, () => this.refreshNow(), 60e3);
    this._loop('renew', () => 6 * HOUR, () => this.renewNow(), 120e3);
    this.log(
      `已启动平台=${p.id} heal=${Math.round(c.heal.intervalMs / 60e3)}min ` +
      `refresh=${Math.round(c.refresh.intervalMs / HOUR)}h ` +
      `renew=${p.has(CAP.AUTH_RENEW) ? (c.renew.enabled ? 'on' : 'off') : 'n/a'} ` +
      `targets=${normalizeTargets(c.heal.targets).length}`
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
    return {
      ...this.state,
      platform: p.id,
      uptimeSec: Math.floor((Date.now() - Date.parse(this.state.startedAt)) / 1000),
      targets: normalizeTargets(c.heal.targets),
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
