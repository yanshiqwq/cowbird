'use strict';
// ============================================================
// keepalive —— 把会话钉在「等用户回答」上
//
// 原理：agent 发出 AskUserQuestion 之后，这一轮就一直挂着等客户端回答，而
// **服务端不计时**（默认 5 分钟超时是客户端本地 setTimeout）。所以只要连上 ACP、
// 收到提问不回，会话就停在 pending —— 平台看到的是"正在等人"的会话，而不是闲置的。
//
// 和 heal 是两件事，不是二选一：
//   heal       每 10 分钟一次 E2B exec，让平台看到"有人在访问"。便宜、不进对话记录。
//   keepalive  维持一条长连接 + 挂着的提问，把会话状态钉在 working/pending。占一条 SSE。
//
// 本文件只做三件事：① 连接/断线重连 ② 收到提问不回答（保活本身）③ 掉出 pending 就催一句
//
// ⚠ 有代价，用之前想清楚：
//   · 催话会写进该会话的历史（heal 不会）。所以催话文案可配，间隔可调，可设上限。
//   · 一个 keepalive 占一条 SSE 长连接，实例多了要算进去。
//   · 提问"永不回答"意味着那个 agent 永远停在那儿 —— 别对还要继续干活的会话开这个。
//
// 凭据刷新不用自己加锁：wbsbx 的 refreshSession 是纯 HTTP，多进程同时刷只是多打两次接口。
// 老实现要文件锁，是因为它走 headless 浏览器、profile 独占。
const { Acp } = require('./acp');

const DEFAULTS = {
  nudgeSec: 60,             // 空闲多久催一次
  maxNudges: 0,             // 0 = 不限
  questionTimeoutSec: 0,    // 0 = 永不放弃（这才是保活的本意）
  noNudge: false,           // true = 只连不收不催（shadow，验证链路用）
  prompt: '【保活】上一轮已经结束了。请立刻用 AskUserQuestion 问我下一个问题，不要自己往下做，也不要总结。',
  reconnectMs: 5000,
  logEveryMs: 60e3,
  log: () => {},
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Keepalive {
  constructor(creds, opts = {}) {
    this.creds = creds;
    this.id = creds.sessionId || opts.id;
    this.opts = { ...DEFAULTS, ...opts };
    this.state = {
      status: 'unknown',
      busy: false,
      pending: new Map(),     // id -> questions[]
      nudges: 0,
      lastEventAt: Date.now(),
      connId: null,
      connected: false,
    };
    this._acp = null;
    this._stopped = false;
    this._ticker = null;
    this._lastNudgeAt = Date.now();
    this._lastLogAt = 0;
  }

  log(msg) { try { this.opts.log(msg); } catch {} }

  // 提问只在「那一轮还活着」时才算数。轮次被关掉（用户答了、或别的客户端超时自动选了）之后，
  // 本地 map 里留下的 id 再也不会来事件；不清掉就会因为 pending 非空而永远不催 ——
  // 变成既不保活也不干活的僵尸。
  dropPending(why) {
    const n = this.state.pending.size;
    if (!n) return;
    this.state.pending.clear();
    this.log(`⚠ 作废挂起提问 ${n} 条（${why}）—— 服务端已不再认它`);
  }

  // ---------- 收消息（拆出来就是为了能离线测） ----------

  // 服务端发来的「请求」。这个类只观察两件事；mcp/message 和 elicitation 由 Acp 自己回。
  onServerRequest(m) {
    const method = m.method;
    if (method === '_codebuddy.ai/question') {
      if (this.state.pending.has(m.id)) return;                  // 重连会重放，别重复记
      const qs = (m.params && m.params.schema && m.params.schema.questions) || [];
      this.state.pending.set(m.id, qs);
      const q0 = qs[0] || {};
      const labels = (q0.options || []).map((o) => o.label).filter(Boolean).join('/');
      this.log(`❓ 提问挂起 id=${m.id}「${q0.header || ''}」${labels ? '选项=' + labels : ''} —— 不回答`);
      if (this.opts.questionTimeoutSec > 0) {
        const id = m.id;
        setTimeout(() => {
          if (!this.state.pending.delete(id)) return;
          this.log(`⏱ id=${id} 挂满 ${this.opts.questionTimeoutSec}s，主动取消`);
          this.post({ jsonrpc: '2.0', id, result: { outcome: 'cancelled', reason: 'keepalive timeout' } }).catch(() => {});
        }, this.opts.questionTimeoutSec * 1000).unref?.();
      }
      return;
    }
    if (method === 'session/request_permission') this.log('🔐 权限请求（不回应）');
  }

  // 通知类消息
  onEvent(m) {
    this.state.lastEventAt = Date.now();
    const method = m.method || '';

    if (method === '_codebuddy.ai/interaction_timeout') {
      const id = m.params && m.params.id;
      if (this.state.pending.delete(id)) this.log(`⏰ 服务端说提问 id=${id} 超时`);
      return;
    }

    if (method === 'session/update') {
      const u = (m.params && m.params.update) || {};
      const meta = (u._meta && u._meta['codebuddy.ai']) || (m.params && m.params._meta && m.params._meta['codebuddy.ai']) || {};
      // 历史重放（session/load）也在往这里灌消息，别把 replay 当成"正在干活"
      const replay = meta.mode === 'history';
      if (meta.status && meta.status !== this.state.status) {
        this.state.status = meta.status;
        this.state.busy = ['working', 'running'].includes(meta.status);
        this.log('状态 → ' + meta.status);
        if (meta.status === 'completed') this.dropPending('状态 completed');
      }
      if (!replay && (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk')) {
        this.state.busy = true;
      }
      return;
    }

    if (method === 'session/endTurn') {
      this.state.busy = false;
      this.dropPending('本轮结束');
      return;
    }

    // JSON-RPC 响应（我们自己发出去的 prompt 的回执）
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      if (this.state.pending.size === 0) this.state.busy = false;
    }
  }

  // ---------- 动作 ----------
  async post(body) {
    if (!this._acp) throw new Error('没有活动连接');
    const r = await this._acp.post(body);
    if (r.status >= 400) this.log(`POST 失败 ${r.status} ${String(r.text).slice(0, 160)}`);
    return r;
  }

  async nudge(why) {
    if (this.opts.noNudge) { this.log(`shadow：本该催话（${why}），noNudge 生效，跳过`); return; }
    if (this.opts.maxNudges && this.state.nudges >= this.opts.maxNudges) {
      this.log(`已催 ${this.state.nudges} 次，到达上限，不再催`);
      return;
    }
    this.state.nudges++;
    this.log(`>>> 催话 #${this.state.nudges}（${why}）`);
    await this.post({
      jsonrpc: '2.0', id: 1000 + this.state.nudges, method: 'session/prompt',
      params: { sessionId: this.id, prompt: [{ type: 'text', text: this.opts.prompt }] },
    });
    this._lastNudgeAt = Date.now();
  }

  // 空闲 = 连接在、没在干活、也没有挂着的提问
  get idle() {
    return this.state.connected && !this.state.busy && this.state.pending.size === 0;
  }

  async tick() {
    const now = Date.now();
    if (now - this._lastLogAt > this.opts.logEveryMs) {
      this._lastLogAt = now;
      this.log(`状态 status=${this.state.status} busy=${this.state.busy} 挂起=${this.state.pending.size} ` +
        `静默=${Math.round((now - this.state.lastEventAt) / 1000)}s 催=${this.state.nudges} conn=${this.state.connected ? 'up' : 'DOWN'}`);
    }
    if (this.idle && now - this._lastNudgeAt > this.opts.nudgeSec * 1000) {
      await this.nudge(this.state.status === 'completed' ? '会话已完成' : '空闲无提问').catch((e) => {
        this.log('催话失败 ' + String(e.message).slice(0, 100));
      });
    }
  }

  // ---------- 连接循环 ----------
  async start({ sec = 0 } = {}) {
    const timer = setInterval(() => { this.tick().catch(() => {}); }, 1000);
    timer.unref?.();
    this._ticker = timer;
    if (sec > 0) setTimeout(() => this.stop('到达 --sec 时长'), sec * 1000);

    while (!this._stopped) {
      let creds = this.creds;
      if (this.opts.reload) {
        try { creds = (await this.opts.reload()) || creds; this.creds = creds; }
        catch (e) {
          this.log('取凭据失败：' + String(e.message).slice(0, 140) + '，稍后重试');
          await sleep(this.opts.reconnectMs * 2);
          continue;
        }
      }

      const acp = new Acp(creds, {
        id: this.id,
        onEvent: (m) => this.onEvent(m),
        onServerRequest: (m) => this.onServerRequest(m),
      });

      try {
        const res = await acp.connect();
        if (!acp.connId) {
          this.log('bootstrap 没给 Acp-Connection-Id http=' + res.status + '，重试');
          await sleep(this.opts.reconnectMs);
          continue;
        }
        this._acp = acp;
        this.state.connected = true;
        this.state.connId = acp.connId;
        this.log('连接建立 connectionId=' + acp.connId);
        await acp.loop();
        this.log('SSE 断开，' + this.opts.reconnectMs / 1000 + 's 后重连');
      } catch (e) {
        this.log((e && e.name === 'AbortError' ? '连接已主动断开' : '连接异常 ' + String(e && e.message).slice(0, 120)) +
          '，' + this.opts.reconnectMs / 1000 + 's 后重连');
      } finally {
        this.state.connected = false;
        this._acp = null;
        try { await acp.close(); } catch {}
      }
      if (!this._stopped) await sleep(this.opts.reconnectMs);
    }
    return this.summary();
  }

  stop(why) {
    if (this._stopped) return;
    this._stopped = true;
    if (why) this.log('停止：' + why);
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
    if (this._acp) { try { this._acp.close(); } catch {} }
  }

  summary() {
    return {
      id: this.id,
      nudges: this.state.nudges,
      status: this.state.status,
      pending: this.state.pending.size,
    };
  }
}

module.exports = { Keepalive, DEFAULTS };
