// _example —— 契约的可执行样例（兼契约测试的平台无关证明）。
//
// 它不连任何网络、不 spawn 任何进程：实例存在 ctx.store 里，exec 用内置的极简解释器。
// 目的只有一个：**内核在完全不认识任何真实平台的情况下也能跑通 ls / exec / doctor**。
const { defineProvider, CAP, EVENT, execResult, fileEntry } = require('../contract');

const WORKSPACE = '/workspace';
const REPLY = '示例平台：我收到了你的消息。';

function seed(ctx) {
  let s = ctx.store.read('state');
  if (!s) {
    s = {
      seq: 1,
      instances: [{ id: '1001', name: 'example-01', status: 'idle', updatedAt: new Date().toISOString(), archived: false }],
      files: { [`${WORKSPACE}/hello.txt`]: 'hello from _example\n' },
      messages: {},
    };
    ctx.store.write('state', s);
  }
  return s;
}
const commit = (ctx, s) => ctx.store.write('state', s);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简命令解释器：只支持契约测试要用的几条，保证跨平台可跑。
 *  支持 `a; b` 顺序执行与 `a && b`（前者成功才继续）。 */
async function interpret(ctx, s, cmd) {
  const parts = String(cmd || '').split(';').map((x) => x.trim()).filter(Boolean);
  let out = '', err = '', code = 0, ms = 0;
  for (const part of parts) {
    const r = await one(s, part);
    out += r.out; err += r.err; ms += r.ms || 0;
    code = r.code;
    if (r.code !== 0 && /&&/.test(part)) break;
  }
  return execResult({ out, err, code, ms });
}

async function one(s, line) {
  const andCmd = line.split('&&')[0].trim();
  const [head, ...rest] = andCmd.split(/\s+/);
  switch (head) {
    case '':
    case 'true':
      return execResult({ out: '', code: 0 });
    case 'false':
      return execResult({ out: '', code: 1 });
    case 'echo':
      return execResult({ out: rest.join(' ') + '\n', code: 0 });
    case 'pwd':
      return execResult({ out: WORKSPACE + '\n', code: 0 });
    case 'id':
      return execResult({ out: 'uid=1000(probe) gid=1000(probe)\n', code: 0 });
    case 'uname':
      return execResult({ out: 'Linux example 6.6.0-probe x86_64 GNU/Linux\n', code: 0 });
    case 'nproc':
      return execResult({ out: '4\n', code: 0 });
    case 'sleep': {
      const sec = Math.max(0, Math.min(Number(rest[0]) || 0, 2));
      await sleep(sec * 1000);
      return execResult({ out: '', code: 0, ms: sec * 1000 });
    }
    case 'cat': {
      const p = rest[0] && rest[0].startsWith('/') ? rest[0] : `${WORKSPACE}/${rest[0]}`;
      if (!(p in s.files)) return execResult({ out: '', err: `cat: ${p}: No such file\n`, code: 1 });
      return execResult({ out: s.files[p], code: 0 });
    }
    case 'ls':
      return execResult({
        out: Object.keys(s.files).filter((f) => f.startsWith(WORKSPACE + '/')).map((f) => f.slice(WORKSPACE.length + 1)).join('\n') + '\n',
        code: 0,
      });
    default:
      return execResult({ out: '', err: `probe: command not found: ${head}\n`, code: 127 });
  }
}

module.exports = defineProvider({
  id: '_example',
  displayName: '示例平台（契约样例）',
  version: '1.0.0',
  capabilities: [
    CAP.AUTH, CAP.LIST, CAP.CREATE, CAP.RENAME, CAP.REMOVE, CAP.META,
    CAP.AGENT, CAP.AGENT_QUESTION, CAP.AGENT_INTERRUPT,
    CAP.EXEC, CAP.EXEC_BG, CAP.FS, CAP.MODEL,
  ],
  defaults: { model: 'example-model' },
  limits: { maxSyncMs: 5000, defaultSyncMs: 2000, maxBackground: true },

  auth: {
    async state() { return { token: 'example-token', savedAt: new Date().toISOString() }; },
    ttlDays() { return 365; },
  },

  instances: {
    async list(ctx) { return seed(ctx).instances.filter((i) => !i.archived); },
    async get(ctx, id) {
      const s = seed(ctx);
      const hit = s.instances.find((i) => String(i.id) === String(id));
      if (!hit) throw new Error(`示例平台没有实例 ${id}`);
      return hit;
    },
    async create(ctx, { name }) {
      const s = seed(ctx);
      const inst = { id: String(1000 + ++s.seq), name, status: 'idle', updatedAt: new Date().toISOString(), archived: false };
      s.instances.unshift(inst); commit(ctx, s); return inst;
    },
    async rename(ctx, id, title) {
      const s = seed(ctx);
      const hit = s.instances.find((i) => String(i.id) === String(id));
      if (!hit) throw new Error(`示例平台没有实例 ${id}`);
      hit.name = title; hit.updatedAt = new Date().toISOString(); commit(ctx, s); return hit;
    },
    async remove(ctx, id) {
      const s = seed(ctx);
      s.instances = s.instances.filter((i) => String(i.id) !== String(id));
      commit(ctx, s); return true;
    },
    /** 可选：凭据到期时间（秒）。有这个方法，`ls` 才会显示「凭据剩余」列。 */
    async expiry() { return Math.floor(Date.now() / 1000) + 3600 * 6; },
    async info(ctx, id) {
      // 故意给出「可见」与「配额」两组数字，示范内核该怎么显示（对齐 WorkBuddy 的 32c/123G vs 4c/8G）
      return {
        visible: { cpu: 32, memBytes: 126277 * 1024 * 1024, diskBytes: 256 * 1024 ** 3 },
        quota: { cpu: 4, memBytes: 8 * 1024 ** 3 },
        facts: [{ label: '平台', value: '示例平台' }, { label: '实例', value: id }],
      };
    },
  },

  agent: {
    async send(ctx, id, { text }) {
      const s = seed(ctx);
      (s.messages[id] = s.messages[id] || []).push({ role: 'user', text, at: new Date().toISOString() });
      commit(ctx, s);
      return { ok: true };
    },
    async *stream(ctx, id, { text } = {}) {
      yield { kind: EVENT.STATUS, data: { status: 'running' } };
      if (text) {
        yield { kind: EVENT.THINKING, data: { text: '（示例平台的思考）' } };
        for (const chunk of REPLY.match(/.{1,6}/g)) {
          await sleep(1);
          yield { kind: EVENT.TEXT, data: { text: chunk } };
        }
      }
      const s = seed(ctx);
      (s.messages[id] = s.messages[id] || []).push({ role: 'assistant', text: REPLY, at: new Date().toISOString() });
      commit(ctx, s);
      yield { kind: EVENT.USAGE, data: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } };
      yield { kind: EVENT.DONE, data: { reason: 'end' } };
    },
    async history(ctx, id) { return { messages: seed(ctx).messages[id] || [], nextCursor: null }; },
    async interrupt() { return { ok: true }; },
    async answer(ctx, id, { requestId }) { return { ok: true, requestId }; },
  },

  exec: {
    async probe() { return { ready: true }; },
    async run(ctx, id, { command }) { return interpret(ctx, seed(ctx), command); },
    async start(ctx, id, { command }) {
      const jobId = 'job-' + Math.random().toString(36).slice(2, 8);
      const s = seed(ctx);
      (s.jobs = s.jobs || {})[jobId] = { command, done: false, out: '', code: null, startedAt: Date.now() };
      commit(ctx, s);
      interpret(ctx, s, command).then((r) => {
        const s2 = seed(ctx);
        s2.jobs[jobId] = { ...s2.jobs[jobId], done: true, out: r.out, code: r.code };
        commit(ctx, s2);
      });
      return { jobId, outputPath: `${WORKSPACE}/.jobs/${jobId}.log` };
    },
    async poll(ctx, id, { jobId }) {
      const j = (seed(ctx).jobs || {})[jobId];
      if (!j) throw new Error(`未知 job ${jobId}`);
      return { done: j.done, out: j.out, code: j.code };
    },
    async put(ctx, id, { localPath, remotePath }) {
      const fs = require('fs');
      const s = seed(ctx);
      s.files[remotePath] = fs.readFileSync(localPath, 'utf8');
      commit(ctx, s);
      return { size: Buffer.byteLength(s.files[remotePath]) };
    },
    async get(ctx, id, { remotePath, localPath }) {
      const fs = require('fs');
      const s = seed(ctx);
      if (!(remotePath in s.files)) throw new Error(`没有文件 ${remotePath}`);
      fs.writeFileSync(localPath, s.files[remotePath]);
      return { size: Buffer.byteLength(s.files[remotePath]) };
    },
  },

  fs: {
    async list(ctx, id, { path = WORKSPACE } = {}) {
      const s = seed(ctx);
      const prefix = path.replace(/\/$/, '') + '/';
      return Object.keys(s.files)
        .filter((f) => f.startsWith(prefix))
        .map((f) => fileEntry({ path: f, type: 'file', size: Buffer.byteLength(s.files[f]) }));
    },
    async read(ctx, id, { path }) {
      const s = seed(ctx);
      if (!(path in s.files)) throw new Error(`没有文件 ${path}`);
      return { path, content: s.files[path], encoding: 'utf8' };
    },
    async write(ctx, id, { path, content }) {
      const s = seed(ctx);
      s.files[path] = String(content);
      commit(ctx, s);
      return { path, size: Buffer.byteLength(s.files[path]) };
    },
  },

  doctor: {
    async checks() {
      return [{ level: 'ok', name: '示例平台', detail: '契约样例，无外部依赖' }];
    },
  },
});
