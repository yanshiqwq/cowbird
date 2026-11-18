// 读"这个渠道的有效配置"。
//
// 内核在 ctx.effective 里已经把 provider.defaults 与 cowbird.json 的 platforms.<id> 合并好
// （见 lib/platform/index.js 的 context()）。驱动不该再自己去读配置文件重算一遍 ——
// 那既多一次同步读盘，又会让内核以后新增的合并规则（env 覆盖等）失效。
const util = require('./util');

/** 整份有效配置（只读快照） */
function all(ctx) {
  return (ctx && ctx.effective) || {};
}

function get(ctx, key, dflt) {
  const v = all(ctx)[key];
  return v === undefined || v === null ? dflt : v;
}

/** 数字：非法值退回默认（配置里写 "abc" 不该变成 NaN 传下去） */
function num(ctx, key, dflt) {
  const n = util.numOrNull(get(ctx, key, dflt));
  return n === null ? dflt : n;
}

function bool(ctx, key, dflt) {
  const v = get(ctx, key, dflt);
  return typeof v === 'boolean' ? v : dflt;
}

function str(ctx, key, dflt) {
  const v = get(ctx, key, dflt);
  return v === undefined ? dflt : String(v);
}

module.exports = { all, get, num, bool, str };
