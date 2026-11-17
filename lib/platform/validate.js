// 驱动形状校验：内置与外部驱动都走这里，保证内核拿到的东西一定符合契约。
const { defineProvider, REQUIRED } = require('./contract');

/**
 * @param {object} def            驱动导出的对象（可以是原始定义，也可以是已 defineProvider 过的）
 * @param {string} [expectedId]   期望的 id（内置目录名）；外部驱动传模块名时不做强校验
 */
function validateShape(def, expectedId) {
  if (!def || typeof def !== 'object') {
    throw new Error('驱动没有导出对象（应为 defineProvider({...}) 的返回值）');
  }

  const already = typeof def.has === 'function' && def.capabilities instanceof Set;
  const p = already ? def : defineProvider(def);

  if (!p.id || typeof p.id !== 'string') throw new Error('驱动的 id 无效');
  if (expectedId && !String(expectedId).startsWith('module:') && p.id !== expectedId) {
    throw new Error(`驱动的 id「${p.id}」与目录名「${expectedId}」不一致`);
  }

  for (const need of REQUIRED) {
    if (!p.has(need)) throw new Error(`驱动缺必需能力 ${need}`);
  }
  if (!p.instances || typeof p.instances.list !== 'function') throw new Error('驱动缺 instances.list()');
  if (!p.agent || typeof p.agent.stream !== 'function') throw new Error('驱动缺 agent.stream()');

  return p;
}

module.exports = { validateShape };
