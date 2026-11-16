// wbsbx doctor —— 一条命令看清这套东西现在还活着没有
// 顺序按依赖链排：node → 数据目录 → 登录态 → 接口 → 实例/凭据 → daemon → 浏览器
//
// 浏览器在日常路径里用不到（纯 HTTP + cookie/UA 就够），只有 login 和可选的服务端续期需要，
// 所以它在体检里是「信息项」，不给黄灯。
const fs = require('fs');
const path = require('path');
const { parse } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const browser = require('../lib/browser');
const cloud = require('../lib/cloud');
const session = require('../lib/session');
const creds = require('../lib/creds');
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

async function checkLoginState() {
  const s = await creds.loginState();
  if (!s || !s.cookies.length) {
    add('warn', '登录态', '没有（跑 wbsbx login，或 login --import 复用现有浏览器）');
    return null;
  }
  if (!s.ua) {
    add('bad', '登录态', '有 cookie 但缺 UA —— 会话跟 UA 强绑定，必定 401。重跑 wbsbx login');
    return null;
  }
  const d = session.ttlDays(s.cookies);
  const left = d === null ? '期限未知' : d <= 0 ? '已过期' : `剩 ${d.toFixed(1)} 天`;
  add(d !== null && d <= 0 ? 'warn' : 'ok', '登录态', `${s.cookies.length} 条 cookie，${left}${s.source === 'daemon' ? ui.c.dim('（来自 daemon）') : ''}`);
  if (d !== null && d < 2) {
    add('warn', '登录态到期', `不到 2 天 —— daemon 的 renew 没开的话，需要手动重新 login`);
  }
  return s;
}

async function checkApi(allowNet, st) {
  if (!allowNet) { add('info', '接口', '未联网校验（--no-net）'); return; }
  if (!st || !st.cookies.length || !st.ua) { add('info', '接口', '跳过（没登录态）'); return; }
  try {
    const r = await cloud.probeLogin();
    add(r.ok ? 'ok' : 'bad', '接口', r.ok ? '200，纯 HTTP 可用（不需要浏览器）' : `http=${r.status}，需要 wbsbx login`);
  } catch (e) {
    add('bad', '接口', String(e.message).slice(0, 100));
  }
}

async function checkSessions(allowNet, st) {
  let list = cloud.cachedConversations();
  if (allowNet && st && st.ua) {
    try { list = await cloud.listConversations(); }
    catch (e) { add('warn', '实例列表', '拉取失败：' + e.message.slice(0, 80)); }
  }
  if (list.length) {
    const byStatus = (k) => list.filter((x) => x.status === k).length;
    add('ok', '实例', `${list.length} 个（pending ${byStatus('pending')}，working ${byStatus('working')}）`);
  } else {
    add('warn', '实例', '没有缓存也没有拉到会话');
  }
  const ids = cfg.cachedIds();
  const soon = ids.map((id) => cfg.readToken(id)).filter(Boolean)
    .map((t) => t.expireAt)
    .filter((e) => e && e * 1000 > Date.now() && e * 1000 - Date.now() < 12 * 3600e3);
  add(ids.length ? 'ok' : 'info', '凭据缓存', `${ids.length} 份` + (soon.length ? ui.c.yellow(`，${soon.length} 份 12h 内到期`) : ''));
}

// daemon 挂了不会让 CLI 瘫痪，但会让实例没人访问 —— 这是「慢慢被回收」的开端，必须让用户看见。
// 目标配了 script 却读不到文件，是"十轮之后才发现"的那种错 —— 放在体检里当场暴露。
function checkHealTargets() {
  const c = cfg.readConfig();
  const list = c.heal.targets || [];
  if (!list.length) { add('info', '保活目标', '未配置（heal 不会做任何事）'); return; }
  const missing = [];
  let withScript = 0;
  for (const t of list) {
    if (!t.script) continue;
    withScript++;
    const p = path.isAbsolute(t.script) ? t.script : path.resolve(c.heal.scriptsDir || '.', t.script);
    if (!fs.existsSync(p)) missing.push(`${t.name || t.id} → ${p}`);
  }
  const desc = `${list.length} 个（${withScript ? withScript + ' 个 script 模式' : '全是 probe'}）`;
  if (missing.length) add('bad', '保活目标', `${desc}，脚本缺失：${missing.join('；')}`);
  else add('ok', '保活目标', desc);
}

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
    add('warn', 'daemon', '没连上 —— 没人定期访问的话实例会被回收。起一个：wbsbx daemon start --detach');
  }
}

function checkBrowser() {
  if (!browser.hasPlaywright()) {
    add('info', '浏览器', '没装 playwright-core —— 只影响 wbsbx login 和 daemon 的登录态续期');
    return;
  }
  const desc = browser.describe();
  add('info', '浏览器', desc ? `${desc} —— 仅登录/续期需要` : '找不到 Edge/chromium —— 仅影响登录/续期，可设 WBSBX_BROWSER 指定路径');
}

async function run(argv) {
  const args = parse(argv, { flags: ['no-net', 'json'] });
  const allowNet = !args.opts['no-net'];

  checkNode();
  checkHome();
  const st = await checkLoginState();
  await checkApi(allowNet, st);
  await checkSessions(allowNet, st);
  checkHealTargets();
  await checkDaemon();
  checkBrowser();

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
    '  按依赖顺序体检：node → 数据目录 → 登录态 → 接口 → 实例/凭据 → daemon → 浏览器。',
    '  「接口」一项会真发一次请求（--no-net 时跳过），所以能区分「cookie 过期」和「UA 不匹配」。',
    '',
    '退出码:',
    '  0  没有异常项（警告不影响退出码）',
    '  1  存在异常项',
  ],
};
