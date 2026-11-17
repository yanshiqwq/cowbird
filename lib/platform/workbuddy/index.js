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
const creds = require('../../creds');
const session = require('../../session');
const auth = require('./auth');
const instances = require('./instances');
const agent = require('./agent');
const exec = require('./exec');
const fsops = require('./fsops');

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
    model: config.DEFAULT_MODEL,
    workspace: exec.WORKSPACE,
    jobsDir: exec.JOBS_DIR,
  },

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
  model: { list: agent.model.list, current: agent.model.current },

  /**
   * doctor：只做**离线**自检（不联网、不开浏览器）。
   * 真凭据能不能用要跑 cloud.probeLogin() / exec.probe()。
   *
   * level 的取值与内核 commands/doctor.js 的 ICON 表对齐：ok / warn / bad / info
   * （写 'error' 不会报错，但会显示成一个 '-'，等于白写一条）。
   */
  doctor: {
    async checks() {
      const out = [];
      const st = creds.readLocalState();
      if (!st || !st.cookies || !st.cookies.length) {
        out.push({ level: 'bad', name: '登录态', detail: '没有 cookie：先跑 wbsbx login（浏览器扫码）' });
      } else if (!st.ua) {
        out.push({
          level: 'bad',
          name: 'User-Agent',
          detail: 'state.json 里没有 ua —— APISIX 把会话跟 UA 逐字节绑定，缺了必然 401；重跑 wbsbx login',
        });
      } else {
        const d = auth.ttlDays(st);
        out.push({
          level: d === null || d < 1 ? 'warn' : 'ok',
          name: '登录态',
          detail: `cookie ${st.cookies.length} 条 / UA ${String(st.ua).slice(0, 32)}… / 剩余 ${d === null ? '未知' : d.toFixed(1) + ' 天'}`,
        });
      }

      const hasPw = auth.browserAvailable();
      out.push({
        level: hasPw ? 'ok' : 'warn',
        name: '浏览器（只有登录/续期需要）',
        detail: hasPw
          ? (auth.browserDescribe() || 'playwright 可用')
          : '没装 playwright-core（可选依赖）：login / renew 不可用，exec / agent 全走纯 HTTP 不受影响',
      });

      out.push({ level: 'ok', name: '控制面', detail: `cookie + UA 走纯 HTTP：${config.ORIGIN}/console/as/conversations/*` });
      out.push({ level: 'ok', name: '数据面', detail: 'E2B envd（connect+json 五字节帧）—— exec 不经过 LLM、不进对话轨迹' });
      out.push({ level: 'ok', name: '容器规格', detail: 'instances.info 会同时给「看得见」（nproc/free/df）与「真配额」（cgroup v1/v2）两组数字' });
      return out;
    },
  },

  /** 本平台专属 HTTP：内核不碰，但 doctor / 上层脚本可能要直接用 */
  transport: {
    origin: config.ORIGIN,
    agentsUrl: config.AGENTS_URL,
    loginUrl: config.LOGIN_URL,
    get: session.get,
    post: session.post,
    http: session.http,
    cookieHeader: session.cookieHeader,
  },
});
