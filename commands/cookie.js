// wbsbx cookie —— 看登录态 / 导出 / 实测（**纯读文件，不开浏览器**）
// 登录态的搬运交给 `wbsbx login --import`；这里只操作 state.json。
const fs = require('fs');
const path = require('path');
const { parse } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const session = require('../lib/session');

function fmtLeft(days) {
  if (days === null) return '未标注';
  if (days <= 0) return ui.c.red('已过期');
  return days.toFixed(1) + ' 天';
}

async function run(argv) {
  const args = parse(argv, { values: ['out'] });
  const mode = args._[0] || 'dump';
  // 走凭据门面：daemon 在跑就用它维护的那份（更新），否则退回本地文件
  const s = await session.loadAsync();

  if (!s || !s.cookies.length) {
    console.log(ui.c.yellow('没有登录态（' + cfg.PATHS.state + ' 不存在或没有 cookie）'));
    console.log(ui.c.dim('跑 wbsbx login 扫码登录，或 wbsbx login --import 从现有浏览器 profile 导入。'));
    return 1;
  }

  if (mode === 'check') {
    const r = await session.alive();
    console.log(r.ok ? ui.c.green('✓ 登录态可用（接口 200）') : ui.c.red(`✗ 登录态不可用：${r.reason || 'http=' + r.status}`));
    return r.ok ? 0 : 1;
  }

  if (mode === 'export') {
    const out = args.opts.out || path.join(cfg.HOME, 'storage-state.json');
    const st = { cookies: s.cookies, origins: [] };
    fs.writeFileSync(out, JSON.stringify(st, null, 1));
    try { fs.chmodSync(out, 0o600); } catch {}
    console.log(ui.c.green('已导出 storageState → ' + out) + `（cookies=${s.cookies.length}；UA 在 state.json 里，别只搬这个文件）`);
    return 0;
  }

  if (mode !== 'dump') throw new Error('用法: wbsbx cookie [dump|export|check] [--out 文件]');

  const now = Date.now() / 1000;
  const rows = s.cookies.map((c) => [
    c.name,
    c.domain,
    c.expires && c.expires > 0 ? ((c.expires - now) / 86400).toFixed(1) : 'session',
    c.httpOnly ? 'Y' : 'n',
    (c.value || '').length,
  ]).sort((a, b) => String(b[2]).localeCompare(String(a[2])));
  console.log(ui.table(['cookie', '域名', '剩余(天)', 'httpOnly', '长度'], rows));

  console.log('');
  console.log(ui.c.bold('UA') + '（与会话强绑定，必须一字不差）：');
  console.log('  ' + (s.ua || ui.c.red('缺失！这样一定 401，重跑 wbsbx login')));
  console.log(ui.c.dim(`\n保存于 ${s.savedAt || '-'}，整体剩 ${fmtLeft(session.ttlDays(s.cookies))}` +
    (s.source === 'daemon' ? '，来源 daemon' : '，来源本地')));
  return 0;
}

module.exports = {
  run,
  usage: 'cookie [dump|export|check] [--out <文件>]',
  help: [
    '子命令:',
    '  dump     列出每条 cookie 的域名、剩余天数、httpOnly、长度（默认）',
    '  check    真发一次请求，验证这份登录态现在还能不能用',
    '  export   导出成 Playwright storageState（注意：UA 不在这个文件里）',
    '',
    '选项:',
    '  --out <文件>   export 的落点，默认 $WB_CLOUD_HOME/storage-state.json',
    '',
    '说明:',
    '  只读本地文件，除非用 check。要换登录态请用 `wbsbx login --import`，别手改 state.json。',
    '',
    '退出码:',
    '  0  正常（check 时表示接口 200）',
    '  1  没有登录态 / check 不通过',
  ],
};
