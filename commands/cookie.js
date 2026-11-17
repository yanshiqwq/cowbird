// wbsbx cookie —— 看登录态 / 导出 / 实测（**纯读本地，不开浏览器**）
//
// 各平台的登录态形状不同（WorkBuddy: cookie+UA；Qoder/码道: cookie；MiniMax: token），
// 所以这里只做"展示与验证"，具体形状由 provider.auth.state() 给。
const fs = require('fs');
const path = require('path');
const { parse } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const registry = require('../lib/platform');
const { CAP } = require('../lib/platform/contract');

const USAGE = 'cookie [dump|export|check] [--out <文件>]';

function fmtLeft(days) {
  if (days === null || days === undefined) return '未标注';
  if (days <= 0) return ui.c.red('已过期');
  return Number(days).toFixed(1) + ' 天';
}

async function readState(p, ctx) {
  // 有的驱动能从 daemon 拿更新的一份（daemon 会自己续期），优先它
  if (p.auth && typeof p.auth.stateAsync === 'function') {
    try { return await p.auth.stateAsync(ctx); } catch { /* 退回同步读 */ }
  }
  return p.auth.state(ctx);
}

async function run(argv) {
  const args = parse(argv, { values: ['out'] });
  const mode = args._[0] || 'dump';

  const p = registry.get();
  if (!p.has(CAP.AUTH)) throw new Error(`本平台（${p.displayName}）没有登录态概念`);
  const ctx = registry.context(p);
  const st = (await readState(p, ctx)) || {};
  const cookies = Array.isArray(st.cookies) ? st.cookies.filter((c) => c && c.value) : [];
  const hasSomething = cookies.length || st.token || st.cookie;

  if (!hasSomething) {
    console.log(ui.c.yellow(`没有登录态（平台 ${p.displayName}，数据目录 ${cfg.HOME}）`));
    console.log(ui.c.dim('跑 wbsbx login（或 wbsbx login --cookie "<串>"）。'));
    return 1;
  }

  if (mode === 'check') {
    // 用「列一次实例」当探针：任何平台都实现了 instances.list，且它一定需要鉴权
    try {
      const list = await p.instances.list(ctx, { refresh: true });
      const stale = list && list.stale;
      if (stale) {
        console.log(ui.c.yellow('⚠ 接口没打通，返回的是本地缓存快照：' + (list.warning || '原因不明')));
        return 1;
      }
      console.log(ui.c.green(`✓ 登录态可用（拉到 ${(list || []).length} 个实例）`));
      return 0;
    } catch (e) {
      console.log(ui.c.red('✗ 登录态不可用：' + String(e.message || e).slice(0, 200)));
      return 1;
    }
  }

  if (mode === 'export') {
    if (!cookies.length) throw new Error('这个平台的登录态不是 cookie 形状，导不出 storageState');
    const out = args.opts.out || path.join(cfg.HOME, 'storage-state.json');
    fs.writeFileSync(out, JSON.stringify({ cookies, origins: [] }, null, 1));
    try { fs.chmodSync(out, 0o600); } catch {}
    console.log(ui.c.green('已导出 storageState → ' + out) + `（cookies=${cookies.length}）`);
    if (st.ua) console.log(ui.c.dim('注意：UA 不在这个文件里（WorkBuddy 的 UA 是绑定的一部分）'));
    return 0;
  }

  if (mode !== 'dump') throw new Error('用法: wbsbx ' + USAGE);

  const ttl = typeof p.auth.ttlDays === 'function' ? p.auth.ttlDays(st) : null;
  if (cookies.length) {
    const now = Date.now() / 1000;
    const rows = cookies.map((c) => [
      c.name,
      c.domain || '-',
      c.expires && c.expires > 0 ? ((c.expires - now) / 86400).toFixed(1) : 'session',
      c.httpOnly ? 'Y' : 'n',
      String(c.value || '').length,
    ]).sort((a, b) => String(b[2]).localeCompare(String(a[2])));
    console.log(ui.table(['cookie', '域名', '剩余(天)', 'httpOnly', '长度'], rows));
  } else {
    // token 形状（MiniMax / Qoder 的某些态）
    console.log(ui.table(['项', '值'], [
      ['形状', 'token'],
      ['长度', String(String(st.token || st.cookie || '').length)],
      ['账号', (st.user && (st.user.name || st.user.id)) || '-'],
    ], { sep: false }));
  }

  if (st.ua) {
    console.log('');
    console.log(ui.c.bold('UA') + ui.c.dim('（与会话强绑定，必须一字不差）：'));
    console.log('  ' + st.ua);
  }
  console.log(ui.c.dim(`\n平台 ${p.displayName} · 保存于 ${st.savedAt || '-'} · 整体剩 ${fmtLeft(ttl)}`));
  return 0;
}

module.exports = {
  run,
  usage: USAGE,
  help: [
    '子命令:',
    '  dump     列出登录态的构成（默认）：cookie 的域名/剩余天数/httpOnly/长度，或 token 长度',
    '  check    真发一次请求，验证这份登录态现在还能不能用',
    '  export   导出成 Playwright storageState（只有 cookie 形状的平台支持）',
    '',
    '选项:',
    '  --out <文件>   export 的落点，默认 $WB_CLOUD_HOME/storage-state.json',
    '',
    '说明:',
    '  只读本地文件，除非用 check（check 会列一次实例）。换登录态请用 wbsbx login。',
    '  WorkBuddy 的 UA 是鉴权的一部分，别手改 state.json。',
    '',
    '退出码:',
    '  0  正常（check 时表示接口通）',
    '  1  没有登录态 / check 不通过',
  ],
};
