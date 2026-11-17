// 建会话 / 发消息要带的模型参数（形状抄自前端 ChatSessionService.buildSendMessageRequest，
// 2026-11-18 实测：少一个字段就 400 991102 "invalid parameter"）。
//
// 这些值不是"可调的审美"，是服务端的入参约束：
//   · mode: "code"                —— 决定这个会话有没有沙箱/工具（别的模式建出来是死会话）
//   · env: "remote"               —— 远端沙箱，不是本地
//   · agent_type/agent_id         —— solo_agent_remote 才是带 Shell 的那个 agent
//   · model_selection_strategy    —— 手动选模型时必须写 manual 并带 custom_model
const DEFAULTS = {
  model: 'deepseek-v4.1-flash',
  agentType: 'solo_agent_remote',
  agentId: 'solo_agent_remote',
  origin: 'web',
};

/** 从 ctx.effective 取本渠道的模型设置（cowbird.json 的 platforms.trae.* 可覆盖） */
function resolve(ctx) {
  const e = (ctx && ctx.effective) || {};
  return {
    model: String(e.model || DEFAULTS.model),
    agentType: String(e.agentType || DEFAULTS.agentType),
    agentId: String(e.agentId || DEFAULTS.agentId),
    origin: String(e.origin || DEFAULTS.origin),
  };
}

/** 前端那个 custom_model 对象（字段全都见过真值，别删） */
function customModel(name) {
  const m = String(name || DEFAULTS.model);
  return {
    provider: '',
    is_preset: true,
    config_name: m,
    config_source: 1,
    model_name: m,
    display_model_name: m,
    ak: '',
    base_url: '',
    use_remote_service: true,
    multimodal: true,
    reasoning_effort_level: 'high',
  };
}

/**
 * common_params 是个**字符串化的 JSON**（不是对象）。
 * 里面混了产品和埋点字段，服务端不校验内容但也别传空 —— 实测空对象能过，但
 * solo_chat_mode / region 这些会被下游拿去选路由，缺了行为会怪。
 */
function commonParams(over = {}) {
  return JSON.stringify({
    language: 'zh-cn',
    app_language: 'en',
    quality: 'stable',
    app_version: '1.0.0.543',
    web_id: '',
    biz_user_id: '',
    user_unique_id: '',
    scope: 'marscode',
    tenant: 'marscode',
    region: 'CN',
    aiRegion: 'CN',
    tenant_name: '',
    solo_chat_mode: 'code',
    is_privacy_mode: 1,
    privacy_mode: 'on',
    user_identity: 'Free',
    is_freshman: '1',
    ...over,
  });
}

/** 一次消息的完整入参（建会话的 initial_message 和发消息的 body 是同一坨，只是外壳不同） */
function messageFields(ctx, { query, text } = {}) {
  const m = resolve(ctx);
  const q = query !== undefined
    ? query
    : JSON.stringify([{ type: 'text', data: { content: String(text === undefined ? '' : text) } }]);
  return {
    content: [],
    query: q,
    model_name: m.model,
    agent_type: m.agentType,
    agent_id: m.agentId,
    model_selection_strategy: 'manual',
    custom_model: customModel(m.model),
    common_params: commonParams(),
  };
}

module.exports = { DEFAULTS, resolve, customModel, commonParams, messageFields };
