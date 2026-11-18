// 保活目标（heal.targets）的增删查。
//
// 从 commands/daemon.js 里搬出来的原因：这里的"三写"（登记簿 + daemon 内存 + cowbird.json）
// 是最容易写错又最难测的一段 —— 命令层只该负责打印。
const api = require('../api');
const cfg = require('../config');
const sandboxes = require('../platform/sandboxes');
const { pickTarget } = require('../platform/target');

/** 当前目标：优先问 daemon（它内存里的是权威），连不上就退回配置文件 */
async function current(client = new api.DaemonClient()) {
  try { return (await client.status()).targets; } catch { return cfg.readConfig().heal.targets || []; }
}

/**
 * 加目标。**顺手登记沙箱**（一个正在被保活的实例必须在 ls 里看得见）。
 * @returns {{list:Array, added:string[], skipped:string[]}}
 */
async function add(refs, client = new api.DaemonClient()) {
  const list = await current(client);
  const added = [];
  const skipped = [];
  for (const ref of refs) {
    const { inst, ctx } = await pickTarget(ref);
    sandboxes.record(ctx, inst, 'keepalive');
    if (list.some((t) => String(t.id) === inst.id)) { skipped.push(String(inst.id)); continue; }
    // 渠道写死在目标上：以后换了默认账号，这个目标仍然跟着原来那个账号走
    list.push({ id: String(inst.id), name: inst.name || '', channel: ctx.channel });
    added.push(String(inst.id));
  }
  return { list, added, skipped };
}

/**
 * 删目标。纯数字 id 允许直通（驱动掉线时也能按 id 摘掉），其余解析不到就算失败 ——
 * 别把"没删掉"报成"已更新"。
 * @returns {{list:Array, removed:string[], failed:string[]}}
 */
async function remove(refs, client = new api.DaemonClient()) {
  const list = await current(client);
  const ids = [];
  const failed = [];
  for (const ref of refs) {
    try {
      ids.push(String((await pickTarget(ref)).inst.id));
    } catch (e) {
      if (/^\d+$/.test(ref)) ids.push(ref);
      else failed.push(`${ref}（${String(e.message).split('\n')[0].slice(0, 80)}）`);
    }
  }
  return { list: list.filter((t) => !ids.includes(String(t.id))), removed: ids, failed };
}

/**
 * 落盘：先让 daemon 热更新，连不上就直接改配置（下次启动生效）。
 * @returns {{via:'daemon'|'config'}}
 */
async function save(list, client = new api.DaemonClient()) {
  try {
    await client.setTargets(list);
    return { via: 'daemon' };
  } catch (e) {
    cfg.writeConfig({ heal: { targets: list } });
    return { via: 'config', error: e };
  }
}

module.exports = { current, add, remove, save };
