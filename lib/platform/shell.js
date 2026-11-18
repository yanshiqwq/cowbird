// POSIX shell 拼接：平台无关，但每个驱动以前都抄了一份（4 份）。
//
// 单引号转义是**安全相关**的：抄错一处就是命令注入。所以只保留这一份实现。

/**
 * 把任意字符串包成安全的 shell 单引号字面量：`a'b` → `'a'\''b'`。
 * 对 sh/bash/dash 都成立（不依赖 $'...' 之类的扩展）。
 */
function q(s) {
  return "'" + String(s === undefined || s === null ? '' : s).replace(/'/g, `'\\''`) + "'";
}

/**
 * `KEY='value'` 前缀若干行，给"一条命令要带环境变量"的场景用。
 * 变量名不合法的直接忽略（防止把奇怪的东西拼进命令行）。
 */
function envPrefix(env) {
  if (!env || typeof env !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (v === undefined || v === null) continue;
    out.push(`export ${k}=${q(v)}`);
  }
  return out;
}

module.exports = { q, envPrefix };
