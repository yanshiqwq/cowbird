// TRAE 的固定值与端点前缀（改版时这里最先动）。
//
// 两个 base 是实测出来的，别混：
//   SITE  远端控制面（会话/消息/环境）—— **同源**，`/api/remote/v1/*`
//   API   网站 API（登录态/用户/换 token）—— `api.trae.cn`
// 我一开始按 `api.trae.cn/api/remote/v1/...` 打，返回 TLB 的 404 页，浪费了一轮。
const SITE = 'https://work.trae.cn';
const API = 'https://api.trae.cn';

// 与浏览器一致的 UA：TRAE 不绑 UA，但网关/WAF 对空 UA 会不顺眼
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';

const Ep = {
  checkLogin: '/cloudide/api/v3/trae/CheckLogin',
  userInfo: '/cloudide/api/v3/trae/GetUserInfo',
  userToken: '/cloudide/api/v3/common/GetUserToken',
  sessions: '/api/remote/v1/chat_sessions',
  session: (id) => `/api/remote/v1/chat_sessions/${encodeURIComponent(id)}`,
  messages: (id) => `/api/remote/v1/chat_sessions/${encodeURIComponent(id)}/messages`,
  stop: (id) => `/api/remote/v1/chat_sessions/${encodeURIComponent(id)}/stop`,
  commit: (id) => `/api/remote/v1/chat_sessions/${encodeURIComponent(id)}/commit`,
  wakeup: (id) => `/api/remote/v1/chat_sessions/${encodeURIComponent(id)}/wakeup_sandbox`,
  sessionToken: (id) => `/api/remote/v1/auth/session/${encodeURIComponent(id)}/token`,
};

// 会话状态枚举：**没有官方文档**，这几个值是实测/推断来的：
//   1 = 刚建出来（还没跑过），5 = 已结束（历史会话都是 5）
// 其余值原样透出（`status-N`），宁可显示得难看，也不猜成"完成"。
const STATUS = {
  1: 'creating',
  2: 'working',
  3: 'working',
  4: 'working',
  5: 'completed',
  6: 'failed',
  8: 'pending',      // 在等用户回答（agent 弹了确认卡片，这一轮不会自己结束）
};

const WORKSPACE_PATH = '/workspace';      // 沙箱内工作区（会话详情里的 workspace_path）

module.exports = { SITE, API, UA, Ep, STATUS, WORKSPACE_PATH };
