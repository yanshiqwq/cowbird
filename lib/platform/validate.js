// 驱动形状校验：内置与外部驱动都走这里，保证内核拿到的东西一定符合契约。
//
// 这里**没有"已经定义过就跳过"的快路径**。早先为了省一次校验，只要驱动导出对象自带
// has() 与 capabilities:Set 就直接放行 —— 结果是一个伪造对象能绕开 id 正则、
// 能力位与实现的一致性检查，`store.dir` 因此可以被指到数据目录之外。
// defineProvider 对已定义对象重跑是幂等的，省这一次没有意义。
const { defineProvider, REQUIRED } = require('./contract');

/**
 * @param {object} def            驱动导出的对象（原始定义或 defineProvider 的返回值）
 * @param {string} [expectedId]   期望的 id（内置目录名）；外部驱动传模块名时不做强校验
 */
function validateShape(def, expectedId) {
  if (!def || typeof def !== 'object') {
    throw new Error('驱动没有导出对象（应为 defineProvider({...}) 的返回值）');
  }

  const p = defineProvider(def);

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
