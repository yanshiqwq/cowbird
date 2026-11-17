// cowbird doctor —— 一条命令看清这套东西现在还活着没有
// 顺序按依赖链排：node → 数据目录 → 登录态 → 接口 → 实例/凭据 → daemon → 浏览器
//
// 浏览器在日常路径里用不到（纯 HTTP + cookie/UA 就够），只有 login 和可选的服务端续期需要，
// 所以它在体检里是「信息项」，不给黄灯。
const fs = require('fs');
const path = require('path');
const { parse } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const api = require('../lib/api');

const rows = [];
const add = (level, name, detail) => rows.push([level, name, detail]);
const ICON = { ok: ui.c.green('✓'), warn: ui.c.yellow('!'), bad: ui.c.red('✗'), info: ui.c.dim('·') };

function checkNode() {
  const v = process.version;
  const major = Number(v.replace('v', '').split('.')[0]);
  add(major >= 18 ? 'ok' : 'bad', 'node', v + (major >= 18 ? '' : '（需要 ≥18）'));
}

function checkHome() {
  try {
    cfg.ensureDirs();
    fs.writeFileSync(path.join(cfg.HOME, '.write-test'), 'x');
    fs.unlinkSync(path.join(cfg.HOME, '.write-test'));
    add('ok', '数据目录', cfg.HOME + (cfg.HOME_INFO.source === 'default' ? '' : ui.c.dim(`（${cfg.HOME_INFO.source}）`)));
  } catch (e) {
    add('bad', '数据目录', cfg.HOME + ' 不可写：' + e.message.slice(0, 60));
  }
}




// daemon 挂了不会让 CLI 瘫痪，但会让实例没人访问 —— 这是「慢慢被回收」的开端，必须让用户看见。
// 目标配了 script 却读不到文件，是"十轮之后才发现"的那种错 —— 放在体检里当场暴露。

async function checkDaemon() {
  const c = cfg.readConfig();
  if (!c.daemon.prefer) {
    add('info', 'daemon', '配置里关掉了（daemon.prefer=false），只用本地凭据');
    return;
  }
  try {
    const st = await new api.DaemonClient().status();
    const last = st.lastHeal && st.lastHeal.at
      ? `${st.lastHeal.ok || 0}/${(st.lastHeal.ok || 0) + (st.lastHeal.failed || 0)} 正常`
      : '还没跑过';
    const n = (st.targets || []).length;
    add(n ? 'ok' : 'warn', 'daemon',
      `在线 · 保活 ${n} 个` + (n ? `（${last}）` : '（目标为空，等于没保活）') + ` · 已跑 ${Math.floor(st.uptimeSec / 60)} 分钟`);
  } catch {
    add('warn', 'daemon', '没连上 —— 没人定期访问的话实例会被回收。起一个：cowbird daemon start --detach');
  }
}


async function run(argv) {
  const args = parse(argv, { flags: ['no-net', 'json'] });
  const allowNet = !args.opts['no-net'];

  checkNode();
  checkHome();

  // ---- 默认平台（渠道是并行的，这里只说明「不带渠道时用谁」，细节看下面的渠道行）----
  const registry = require('../lib/platform');
  let provider = null;
  try {
    provider = registry.get();
    const caps = provider.capabilityList();
    add('ok', '默认平台', `${provider.displayName}（${provider.id}）· ${caps.length} 项能力` +
      (provider.has('exec') ? ` · 同步上限 ${Math.round(provider.limits.maxSyncMs / 1000)}s` : ' · 无执行通道'));
  } catch (e) {
    add('bad', '默认平台', String(e.message).slice(0, 160));
  }

  // ---- 渠道：每个「平台:账号」一行（多账号 / 多平台同时挂时一眼看清谁还能用）----
  const channels = require('../lib/platform/channels');
  let chs = [];
  try { chs = channels.all(); } catch (e) { add('warn', '渠道', String(e.message).slice(0, 140)); }
  for (const ch of chs) {
    let d;
    try { d = await channels.describeLogin(ch); } catch (e) { add('warn', `渠道 ${ch.key}`, String(e.message).slice(0, 140)); continue; }
    const bits = [d.displayName];
    if (d.who) bits.push(d.who);
    if (!d.hasCred) bits.push('未登录');
    else if (d.ttlDays == null) bits.push('凭据剩余未知');
    else if (d.ttlDays <= 0) bits.push('凭据已过期');
    else bits.push('剩余 ' + d.ttlDays.toFixed(1) + ' 天');
    bits.push(d.files + ' 份状态');
    const level = !d.hasCred ? 'warn' : d.ttlDays != null && d.ttlDays <= 0 ? 'bad' : d.ttlDays != null && d.ttlDays < 3 ? 'warn' : 'ok';
    add(level, `渠道 ${ch.key}`, bits.join(' · '));
  }
  if (!chs.length) {
    add('warn', '渠道', '还没有任何登录态。先跑 cowbird login（要多账号就加 --as <名字>）');
  }

  // 驱动自己的体检项：平台专属的检查（登录态/接口/实例缓存/保活目标/浏览器…）都在驱动里，
  // 内核只提供 node / 数据目录 / 渠道 / daemon 这些跨平台项。
  const hasProviderChecks = Boolean(provider && provider.doctor && typeof provider.doctor.checks === 'function');

  // 驱动自己的体检项（最后跑，同名覆盖历史检查）
  if (hasProviderChecks) {
    // 宽容一点：驱动写 error/good/pass 之类同义词也认，免得每个驱动都要记内核的四档
    const LV = {
      ok: 'ok', pass: 'ok', good: 'ok', success: 'ok',
      info: 'info', note: 'info',
      warn: 'warn', warning: 'warn', attention: 'warn',
      bad: 'bad', error: 'bad', fail: 'bad', failed: 'bad', critical: 'bad',
    };
    try {
      const ctx = registry.context(provider);
      for (const c of await provider.doctor.checks(ctx, { net: allowNet })) {
        const lv = LV[String((c && c.level) || 'info').toLowerCase()] || 'warn';
        add(lv, (c && c.name) || '驱动', (c && c.detail) || '');
      }
    } catch (e) {
      add('warn', '驱动体检', String(e.message).slice(0, 140));
    }
  }
  await checkDaemon();

  // 同名的行去重：驱动自己的体检项比内核里的历史检查更准（后者是 WorkBuddy 专属的旧实现），
  // 位置按第一次出现，内容用最后一条。
  const dedup = [];
  const at = new Map();
  for (const row of rows) {
    const key = row[1];
    if (at.has(key)) dedup[at.get(key)] = row;
    else { at.set(key, dedup.length); dedup.push(row); }
  }
  rows.length = 0;
  rows.push(...dedup);

  if (args.opts.json) {
    console.log(JSON.stringify(rows.map(([l, n, d]) => ({ level: l, name: n, detail: d })), null, 2));
    return 0;
  }
  console.log(ui.table(['', '项目', '状态'], rows.map(([l, n, d]) => [ICON[l], n, d]), { sep: false }));
  const bad = rows.filter((r) => r[0] === 'bad').length;
  const warn = rows.filter((r) => r[0] === 'warn').length;
  console.log(bad ? ui.c.red(`\n${bad} 项异常`) : warn ? ui.c.yellow(`\n${warn} 项待注意`) : ui.c.green('\n全部正常'));
  return bad ? 1 : 0;
}

module.exports = {
  run,
  usage: 'doctor [--no-net] [--json]',
  help: [
    '选项:',
    '  --no-net   不联网（只看本地登录态与缓存）',
    '  --json     输出 JSON',
    '',
    '说明:',
    '  按依赖顺序体检：node → 数据目录 → 默认平台 → 渠道 → 登录态 → 接口 → 实例/凭据 → daemon。',
    '  「渠道」一项每个「平台:账号」一行，多账号 / 多平台同时挂时一眼看清谁还能用。',
    '  某个渠道要看细节：cowbird --channel <渠道> doctor。',
    '',
    '退出码:',
    '  0  没有异常项（警告不影响退出码）',
    '  1  存在异常项',
  ],
};
