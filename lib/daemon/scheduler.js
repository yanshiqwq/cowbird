// 调度器：daemon 的全部「自动行为」都在这里。
//
// 三条循环互相独立，周期也不同：
//   heal    10 分钟 —— 让平台看到有人在访问，容器才不被回收
//   refresh 6 小时  —— 把 E2B token 续在到期之前（纯 HTTP，很便宜）
//   renew   按需    —— cookie 快满 7 天时才起一次浏览器走 SSO
//
// 用递归 setTimeout 而不是 setInterval：上一轮没跑完不会再叠一轮。
// 每轮都落一次状态，`wbsbx daemon status` 和 /health 直接读它。
const fs = require('fs');
const cfg = require('../config');
const creds = require('../creds');
const cloud = require('../cloud');
const session = require('../session');
const { runHeal, normalizeTargets } = require('./heal');

const HOUR = 3600e3;

class Scheduler {
  constructor({ log }) {
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
      const r = await runHeal(
        { targets, probe: c.heal.probe, timeoutSec: c.heal.timeoutSec },
        this.log
      );
      this.state.lastHealAt = r.at;
      this.state.lastHeal = { at: r.at, ok: r.ok, failed: r.failed, results: r.results };
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
      const want = ids && ids.length
        ? ids.map(String)
        : [...new Set([...this.targets().map((t) => t.id), ...cfg.cachedIds()])];
      const done = [], failed = [];
      for (const id of want) {
        const t = cfg.readToken(id);
        const fresh = t && t.token && t.expireAt && t.expireAt * 1000 - Date.now() > c.refresh.leadMs;
        if (!ids && fresh) continue;                       // 定时轮只补快过期的
        try {
          const d = await cloud.refreshSession(id, this.log);
          done.push({ id, expireAt: d.expireAt });
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
    if (!force && !c.renew.enabled) return { skipped: 'disabled' };
    const st = creds.readLocalState();
    const ttl = st ? session.ttlDays(st.cookies) : null;
    if (!force && ttl !== null && ttl > c.renew.whenDays) return { skipped: 'fresh', ttlDays: ttl };

    this.busy.renew = true;
    try {
      const { runRenew } = require('./renew');
      const r = await runRenew({ verifyIds: this.targets().map((t) => t.id) }, this.log);
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
    // 启动时先等一会儿，把「重启风暴」错开（容器 recreate 时不必立刻打云端）
    this._loop('heal', () => this.conf.heal.intervalMs, () => this.healNow(), 15e3);
    this._loop('refresh', () => this.conf.refresh.intervalMs, () => this.refreshNow(), 60e3);
    this._loop('renew', () => 6 * HOUR, () => this.renewNow(), 120e3);
    this.log(
      `已启动 heal=${Math.round(c.heal.intervalMs / 60e3)}min refresh=${Math.round(c.refresh.intervalMs / HOUR)}h ` +
      `renew=${c.renew.enabled ? 'on' : 'off'} targets=${normalizeTargets(c.heal.targets).length}`
    );
    return this;
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.log('调度器已停止');
  }

  snapshot() {
    const st = creds.readLocalState();
    const ttl = st ? session.ttlDays(st.cookies) : null;
    const c = this.conf;
    return {
      ...this.state,
      uptimeSec: Math.floor((Date.now() - Date.parse(this.state.startedAt)) / 1000),
      targets: normalizeTargets(c.heal.targets),
      config: {
        heal: { enabled: c.heal.enabled, intervalMs: c.heal.intervalMs, probe: c.heal.probe },
        refresh: { intervalMs: c.refresh.intervalMs, leadMs: c.refresh.leadMs },
        renew: { enabled: c.renew.enabled, whenDays: c.renew.whenDays },
      },
      login: {
        present: !!(st && st.cookies && st.cookies.length),
        hasUa: !!(st && st.ua),
        cookies: st ? st.cookies.length : 0,
        ttlDays: ttl,
      },
      // daemon 自己永远是本地凭据源（它本身就是权威，不去请求自己）
      mode: 'local',
    };
  }
}

module.exports = { Scheduler };
