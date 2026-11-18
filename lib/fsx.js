// 落盘工具：JSON 原子写。
//
// 为什么要它：配置/凭据/状态都是"读-改-写整份文件"。直接 writeFileSync 的窗口里
// 崩一次（断电、被 kill、两个进程同时写）就留下半截 JSON；而 readRawConfig 会把
// "解析失败"当"没有配置"，于是 daemon.token 变空、ensureToken 静默换新令牌，
// 所有远端客户端突然 401 —— 用户看到的只是"令牌无效"，没有任何线索。
//
// 做法：同目录写临时文件 → chmod 600 → rename 覆盖（同目录 rename 在 POSIX 与
// Windows 上都是原子替换）。
const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    try { fs.chmodSync(tmp, mode); } catch { /* Windows 上 chmod 基本是 no-op */ }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响原错误 */ }
    throw e;
  }
  return file;
}

function writeJsonAtomic(file, obj, opts = {}) {
  return writeFileAtomic(file, JSON.stringify(obj, null, opts.indent === undefined ? 1 : opts.indent), opts);
}

/** 读 JSON；文件不存在或坏掉都返回 dflt（调用方决定要不要当成"配置损坏"） */
function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}

module.exports = { writeFileAtomic, writeJsonAtomic, readJson };
