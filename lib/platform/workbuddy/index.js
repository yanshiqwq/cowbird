'use strict';
// workbuddy —— WorkBuddy（腾讯 www.workbuddy.cn）云沙箱平台的 provider。
//
// 这个目录只做**适配**，WorkBuddy 的协议实现全都已经躺在仓库里了：
//   lib/session.js   cookie jar + UA 绑定（APISIX 把会话跟 User-Agent 逐字节绑定）
//   lib/cloud.js     控制面 /console/as/conversations/*（列表/详情/凭据/建/改名/删）
//   lib/e2b.js       数据面 exec（connect+json 五字节帧，process.Process/Start）
//   lib/acp.js       对话通道（POST {link}/bootstrap 取 Acp-Connection-Id，然后读 SSE）
//   lib/browser.js   登录/续期用的浏览器（playwright-core，可选依赖）
//   commands/login.js、lib/daemon/renew.js  两个现成的登录/续期流程
//
// 分工：本 provider 负责「形状转换」（Instance / Event / ExecResult / FileEntry）
// 与「把多个现成模块拼成一条命令」，不重新实现任何协议。
//
// 能力声明的两个刻意选择（README「未验证」一节有完整理由）：
//   · 不声明 exec.wake：WorkBuddy 沙箱长寿（实测最长 22 小时），也没有独立唤醒接口，
//     exec 本来就能直连；声明 wake 会让内核多打一次无意义的往返。exec.wake() 仍然实现着，
//     需要时可以显式调用。
//   · 声明了 agent.interrupt，但它的语义是「取消挂起的提问」（有代码依据），
//     没有挂起提问时如实返回 {ok:false, reason:'unsupported'}。
const { defineProvider, CAP } = require('../contract');
const config = require('../../config');
const cloud = require('./lib/cloud');
const session = require('./lib/session');
const auth = require('./auth');
const instances = require('./instances');
const agent = require('./agent');
const exec = require('./exec');
const fsops = require('./fsops');
const keepaliveFlow = require('./keepalive-flow');

module.exports = defineProvider({
  id: 'workbuddy',
  displayName: 'WorkBuddy（腾讯云沙箱）',
  version: '1.0.0',

  capabilities: [
    CAP.AUTH,            // 有登录态（cookie + UA）
    CAP.AUTH_RENEW,      // Keycloak SSO 换新 session（lib/daemon/renew.js）
    CAP.LOGIN_BROWSER,   // 登录要浏览器扫码
    CAP.LIST, CAP.CREATE, CAP.RENAME, CAP.REMOVE, CAP.META,
    CAP.AGENT, CAP.AGENT_QUESTION, CAP.AGENT_INTERRUPT,
    CAP.EXEC, CAP.EXEC_BG, CAP.FS,
    CAP.MODEL,
  ],

  defaults: {
    model: require('./constants').DEFAULT_MODEL,
    workspace: exec.WORKSPACE,
    jobsDir: exec.JOBS_DIR,
  },

  // 建会话接口本身要求一条 prompt（`{prompt≤100, model}`），所以命名时总要带一句
  requiresPromptOnCreate: true,

  limits: {
    // E2B 单次执行实测约 60s 天花板（commands/exec.js 的默认值也是 60）：更久的命令必须走后台
    maxSyncMs: exec.MAX_SYNC_MS,
    defaultSyncMs: exec.MAX_SYNC_MS,
    maxBackground: true,
    maxOutputBytes: exec.MAX_OUTPUT_BYTES,
    wakeTimeoutMs: 60e3,
  },

  auth,
  instances,
  agent: {
    stream: agent.stream,
    send: agent.send,
    history: agent.history,
    answer: agent.answer,
    interrupt: agent.interrupt,
  },
  exec,
  fs: fsops,
  // 扩展点（不在契约的能力位里）：只有 WorkBuddy 有「提问挂着不答」这套语义。
  // 内核的 keepalive 命令发现没有它就直接报"本平台不支持"。
  keepalive: { create: keepaliveFlow.create },
  model: { list: agent.model.list, current: agent.model.current },

  /**
   * doctor：只做**离线**自检（不联网、不开浏览器）。
   * 真凭据能不能用要跑 cloud.probeLogin() / exec.probe()。
   *
   * level 的取值与内核 commands/doctor.js 的 ICON 表对齐：ok / warn / bad / info
   * （写 'error' 不会报错，但会显示成一个 '-'，等于白写一条）。
   */
  doctor: {
    async checks(ctx, opts) {
      const out = [];
      // 登录态：只有一条路 —— accessToken（2026-11 删掉 cookie+UA 模式）
      const cur = auth.state();
      const d = auth.ttlDays(cur);
      const who = (cur.account && (cur.account.nickname || cur.account.uid)) || '未知账号';
      out.push({
        level: cur.token ? (d === null || d < 1 ? 'warn' : 'ok') : 'bad',
        name: '登录态',
        detail: cur.token
          ? `accessToken · 账号 ${who} · 剩余 ${d === null ? '未知' : d.toFixed(1) + ' 天'}（Bearer，不依赖 cookie/UA）`
          : '没有 accessToken：跑 wbsbx login（打印链接授权，不需要浏览器）',
      });
      if (cur.refreshToken) out.push({ level: 'info', name: '续期', detail: '有 refreshToken：过期会自动续（daemon 也会定期续）' });

      out.push({ level: 'ok', name: '控制面', detail: `cookie + UA 走纯 HTTP：${require('./constants').ORIGIN}/console/as/conversations/*` });
      out.push({ level: 'ok', name: '数据面', detail: 'E2B envd（connect+json 五字节帧）—— exec 不经过 LLM、不进对话轨迹' });
      out.push({ level: 'ok', name: '容器规格', detail: 'instances.info 会同时给「看得见」（nproc/free/df）与「真配额」（cgroup v1/v2）两组数字' });

      // 下面几项原来长在内核的 doctor 里（WorkBuddy 专属），搬进驱动后其它平台不再被误检
      const c = config.readConfig();
      let cached = [];
      try { cached = cloud.cachedConversations(); } catch { cached = []; }
      out.push({
        level: cached.length ? 'ok' : 'warn',
        name: '实例缓存',
        detail: cached.length ? `${cached.length} 个（offline 时 ls 用这份）` : '没有缓存也没有拉到会话',
      });
      let ids = [];
      try { ids = config.cachedIds(); } catch { ids = []; }
      out.push({ level: 'info', name: '凭据缓存', detail: `${ids.length} 份访问凭据（token 缓存）` });
      const targets = ((c.heal && c.heal.targets) || []).length;
      out.push({
        level: 'info',
        name: '保活目标',
        detail: targets ? `${targets} 个：heal 每 ${Math.round((c.heal.intervalMs || 600e3) / 60e3)} 分钟跑一次` : '未配置（heal 不会做任何事）',
      });
      if (opts && opts.net) {
        try {
          const r = await auth.alive();
          out.push({ level: r && r.ok ? 'ok' : 'warn', name: '接口', detail: r && r.ok ? '控制面 200' : `探测失败：${(r && r.reason) || 'http=' + (r && r.status)}` });
        } catch (e) {
          out.push({ level: 'warn', name: '接口', detail: String(e.message).slice(0, 140) });
        }
      }
      return out;
    },
  },

  /** 本平台专属 HTTP：内核不碰，但 doctor / 上层脚本可能要直接用 */
  transport: {
    origin: require('./constants').ORIGIN,
    agentsUrl: require('./constants').AGENTS_URL,
    loginUrl: require('./constants').LOGIN_URL,
    get: session.get,
    post: session.post,
    http: session.http,
  },
});
