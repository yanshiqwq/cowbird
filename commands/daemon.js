// cowbird daemon —— 管常驻进程：起停、看状态、看日志、改保活目标、连远程 daemon
//
// 这一层只做「进程与配置」，真正的循环逻辑在 lib/daemon/scheduler.js。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parse, need } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const api = require('../lib/api');
const { pickTarget } = require('../lib/platform/target');

const DAEMON_JS = path.join(__dirname, '..', 'bin', 'cowbird-daemon.js');

function runningPid() {
  try {
    const pid = Number(fs.readFileSync(cfg.PATHS.daemonPid, 'utf8').trim());
    if (!pid) return null;
    process.kill(pid, 0);       // 只探活，不发信号
    return pid;
  } catch { return null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- start ----------
async function start(argv) {
  const args = parse(argv, { flags: ['detach', 'quiet'], values: ['port', 'host'] });
  const pid = runningPid();
  if (pid) { console.log(ui.c.yellow(`daemon 已在跑（pid ${pid}）`)); return 0; }

  if (!args.opts.detach) {
    // 前台：直接把进程交给 daemon 入口，Ctrl-C 就停
    const child = spawn(process.execPath, [DAEMON_JS, ...argv], { stdio: 'inherit' });
    return new Promise((r) => child.on('exit', (code) => r(code || 0)));
  }

  cfg.ensureDirs();
  const out = fs.openSync(path.join(cfg.PATHS.logs, 'daemon.out'), 'a');
  const child = spawn(process.execPath, [DAEMON_JS, ...argv.filter((a) => a !== '--detach')], {
    detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.unref();

  // 等它真的开始服务，而不是打印完 pid 就走
  const c = cfg.readConfig();
  const url = c.daemon.url;
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    try { await new api.DaemonClient({ url }).probe(); break; } catch {}
  }
  console.log(ui.c.green('daemon 已启动') + ui.c.dim(`  pid ${child.pid} · ${url}`));
  console.log(ui.c.dim(`日志：${path.join(cfg.PATHS.logs, 'daemon.log')}`));
  return 0;
}

// ---------- stop ----------
async function stop() {
  const pid = runningPid();
  if (!pid) { console.log(ui.c.dim('daemon 没在跑')); return 0; }
  try { process.kill(pid, 'SIGTERM'); } catch (e) { console.log(ui.c.red('结束进程失败：' + e.message)); return 1; }
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if (!runningPid()) break;
  }
  try { fs.unlinkSync(cfg.PATHS.daemonPid); } catch {}
  console.log(ui.c.green('已停止') + ui.c.dim(`（pid ${pid}）`));
  return 0;
}

// ---------- status ----------
async function status(argv) {
  const args = parse(argv, { flags: ['json'] });
  let st = null, err = null;
  try { st = await new api.DaemonClient().status(); } catch (e) { err = e; }

  if (args.opts.json) {
    console.log(JSON.stringify(st || { running: false, error: err && err.message }, null, 2));
    return st ? 0 : 1;
  }
  if (!st) {
    console.log(ui.c.yellow('daemon 没在跑') + ui.c.dim(`（${err && err.message}）`));
    console.log(ui.c.dim('\n起一个：cowbird daemon start --detach'));
    return 1;
  }

  const warmLine = (st, fmtAge) => {
    const w = st.config && st.config.warm;
    if (!w || w.enabled === false) return ui.c.dim('关');
    const last = st.lastWarm;
    if (!last) return ui.c.dim(`开（每 ${Math.round(w.intervalMs / 60e3)} 分钟）· 还没跑过`);
    if (last.skipped) return ui.c.dim(`跳过（${last.skipped}）`);
    const tried = (last.results || []).filter((r) => r.ok !== undefined);
    const bad = tried.filter((r) => !r.ok);
    return `开（每 ${Math.round(w.intervalMs / 60e3)} 分钟）· ${fmtAge(st.lastWarmAt)} · ${tried.length - bad.length}/${tried.length}` +
      (bad.length ? ui.c.yellow(` · 失败 ${bad.map((b) => b.channel).join(',')}`) : '');
  };

  const fmtAge = (iso) => {
    if (!iso) return '从未';
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    return (s / 3600).toFixed(1) + ' 小时前';
  };
  const lastHeal = st.lastHeal && !st.lastHeal.skipped
    ? `${st.lastHeal.ok || 0} 正常 / ${st.lastHeal.failed || 0} 失败` +
      (st.lastHeal.warned ? ui.c.yellow(`，${st.lastHeal.warned} 条告警`) : '') +
      (st.lastHeal.skipped ? ui.c.dim(`，${st.lastHeal.skipped} 跳过`) : '')
    : (st.lastHeal && st.lastHeal.skipped ? ui.c.dim('跳过（' + st.lastHeal.skipped + '）') : '-');

  const rows = [
    ['运行时长', Math.floor(st.uptimeSec / 60) + ' 分钟'],
    ['默认渠道', st.channel || st.platform || '-'],
    ['保活目标', st.targets.length ? st.targets.map((t) => (t.channel ? t.channel + '/' : '') + (t.name || t.id)).join(', ') : ui.c.dim('（未设置）')],
    ['保活周期', Math.round(st.config.heal.intervalMs / 60e3) + ' 分钟'],
    ['上一轮保活', `${fmtAge(st.lastHealAt)} · ${lastHeal}`],
    ['上一轮刷新', `${fmtAge(st.lastRefreshAt)} · ${st.lastRefresh && st.lastRefresh.done ? st.lastRefresh.done.length + ' 份' : '-'}`],
    ['登录态续期', st.config.renew.enabled ? `开（剩 ${st.config.renew.whenDays} 天时）· ${fmtAge(st.lastRenewAt)}` : ui.c.dim('关')],
    ['登录态保活', warmLine(st, fmtAge)],
    ['累计错误', st.errors ? ui.c.yellow(st.errors) : '0'],
  ];
  console.log(ui.table(['项目', '状态'], rows, { sep: false }));

  // 每个「平台:账号」一行 —— 多账号共存时，光看一个 login 字段已经说明不了什么
  const chs = Array.isArray(st.channels) ? st.channels : [];
  if (chs.length) {
    console.log(ui.c.dim('\n渠道：'));
    console.log(ui.table(['渠道', '身份', '凭据剩余', '执行'], chs.map((c) => [
      c.key,
      c.error ? ui.c.red('读不到') : c.who || ui.c.dim('-'),
      c.error ? '-' : !c.present ? ui.c.red('未登录') : c.ttlDays == null ? ui.c.dim('未知') : ui.til((Date.now() + c.ttlDays * 86400e3) / 1000),
      c.exec ? '✓' : ui.c.dim('·'),
    ])));
  }
  return 0;
}

// ---------- logs ----------
function logs(argv) {
  const args = parse(argv, { flags: ['follow'], values: ['n'], aliases: { f: 'follow' } });
  const n = Number(args.opts.n || 50);
  const file = path.join(cfg.PATHS.logs, 'daemon.log');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n'); } catch {
    console.log(ui.c.dim('还没有日志：' + file));
    return 0;
  }
  console.log(lines.slice(-n).join('\n'));

  if (args.opts.follow) {
    let size = fs.statSync(file).size;
    process.stdout.write(ui.c.dim('\n--- 跟踪中（Ctrl-C 退出）---\n'));
    fs.watchFile(file, { interval: 800 }, (cur) => {
      if (cur.size <= size) { size = cur.size; return; }
      const buf = Buffer.alloc(cur.size - size);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, buf.length, size);
      fs.closeSync(fd);
      size = cur.size;
      process.stdout.write(buf.toString('utf8'));
    });
    return new Promise(() => {});
  }
  return 0;
}

// ---------- targets ----------
async function targets(argv) {
  const args = parse(argv, { flags: ['json'] });
  const [action, ...rest] = args._;
  const client = new api.DaemonClient();

  const current = async () => {
    try { return (await client.status()).targets; } catch { return cfg.readConfig().heal.targets || []; }
  };

  if (!action || action === 'ls' || action === 'list') {
    const list = await current();
    if (args.opts.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
    if (!list.length) { console.log(ui.c.dim('没有保活目标。加一个：cowbird daemon targets add 01')); return 0; }
    console.log(ui.table(['ID', '名字', '渠道'], list.map((t) => [t.id, t.name || '-', t.channel || ui.c.dim('（默认）')])));
    return 0;
  }

  if (action === 'add' || action === 'rm' || action === 'remove') {
    let list = await current();
    if (action === 'add') {
      if (!rest.length) throw new Error('用法: cowbird daemon targets add <实例...>');
      for (const ref of rest) {
        const { inst, ctx } = await pickTarget(ref);
        if (list.some((t) => String(t.id) === inst.id)) continue;
        // 渠道写死在目标上：以后换了默认账号，这个目标仍然跟着原来那个账号走
        list.push({ id: inst.id, name: inst.name || '', channel: ctx.channel });
      }
    } else {
      if (!rest.length) throw new Error('用法: cowbird daemon targets rm <实例...>');
      const ids = [];
      for (const ref of rest) {
        try { ids.push((await pickTarget(ref)).inst.id); } catch { if (/^\d+$/.test(ref)) ids.push(ref); }
      }
      list = list.filter((t) => !ids.includes(String(t.id)));
    }
    try {
      await client.setTargets(list);
      console.log(ui.c.green('已更新') + ui.c.dim(`（${list.length} 个目标）`));
    } catch (e) {
      // daemon 没跑就直接改配置，下次启动生效
      cfg.writeConfig({ heal: { targets: list } });
      console.log(ui.c.yellow('daemon 没在跑，已写进配置（下次启动生效）'));
    }
    return 0;
  }

  throw new Error('用法: cowbird daemon targets [ls|add|rm] [实例...]');
}

// ---------- pair ----------
function pair(argv) {
  const args = parse(argv, { values: ['token'], aliases: { t: 'token' } });
  const [url] = need(args, 1, 'daemon pair <http://主机:端口> [--token <令牌>]');
  if (!/^https?:\/\//.test(url)) throw new Error('地址要带协议，例如 http://10.0.0.5:8787');
  cfg.writeConfig({ daemon: { url: url.replace(/\/+$/, ''), token: args.opts.token || '' } });
  console.log(ui.c.green('已指向') + ' ' + url);
  if (!args.opts.token) console.log(ui.c.yellow('没给令牌 —— 如果对面不是本机，请求会被拒（403/401）'));
  return 0;
}

// ---------- 触发 ----------
async function trigger(which) {
  const client = new api.DaemonClient();
  const map = {
    heal: () => client.heal(),
    refresh: () => client.refresh(),
    renew: () => client.renew(),
    warm: () => client.warm(),
  };
  const r = await map[which]();
  console.log(JSON.stringify(r, null, 2));
  return which === 'renew' && r && r.ok === false ? 1 : 0;
}

// ---------- install ----------
// 只打印，不擅自改系统。加 --write 才落文件。
function install(argv) {
  const args = parse(argv, { flags: ['write'] });
  const node = process.execPath;
  const script = DAEMON_JS;

  if (process.platform === 'linux') {
    const unit = `[Unit]
Description=cowbird daemon (WorkBuddy sandbox keep-alive)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${node} ${script}
Restart=always
RestartSec=10
Environment=COWBIRD_HOME=${cfg.HOME}
# 需要用浏览器续期时把 HOME 设成有凭据的用户
# User=youruser

[Install]
WantedBy=multi-user.target
`;
    if (args.opts.write) {
      const p = '/etc/systemd/system/cowbird-daemon.service';
      try { fs.writeFileSync(p, unit); console.log(ui.c.green('已写入 ') + p); }
      catch (e) { console.log(ui.c.red('写不了 ' + p + '（要 root）：' + e.message)); return 1; }
      console.log(ui.c.dim('sudo systemctl daemon-reload && sudo systemctl enable --now cowbird-daemon'));
      return 0;
    }
    console.log(ui.c.bold('把下面存成 /etc/systemd/system/cowbird-daemon.service：\n'));
    console.log(unit);
    console.log(ui.c.dim('然后：sudo systemctl daemon-reload && sudo systemctl enable --now cowbird-daemon'));
    return 0;
  }

  if (process.platform === 'win32') {
    const cmd = `schtasks /Create /TN "cowbird-daemon" /SC ONLOGON /RL LIMITED /TR "\\"${node}\\" \\"${script}\\"" /F`;
    console.log(ui.c.bold('用计划任务在登录时拉起：\n'));
    console.log('  ' + cmd);
    console.log(ui.c.dim('\n也可以直接用「启动」文件夹放一个快捷方式；或者干脆 cowbird daemon start --detach 手动起。'));
    return 0;
  }

  console.log(ui.c.dim('这台平台没有内置的服务安装方式，用 docker 或前台跑：cowbird-daemon'));
  return 0;
}

async function run(argv) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'start': return start(rest);
    case 'stop': return stop();
    case 'restart': await stop(); return start(['--detach', ...rest]);
    case 'status': return status(rest);
    case 'logs': return logs(rest);
    case 'targets': return targets(rest);
    case 'pair': return pair(rest);
    case 'heal': return trigger('heal');
    case 'refresh': return trigger('refresh');
    case 'renew': return trigger('renew');
    case 'warm': return trigger('warm');
    case 'install': return install(rest);
    case undefined:
    case 'help':
      console.log(`用法: cowbird daemon <子命令>

  start [--detach]        启动（--detach 后台跑）
  stop                    停止
  restart                 重启
  status [--json]         运行状态、各轮结果、登录态剩余
  logs [-n 50] [-f]       看日志，-f 跟踪
  targets [ls|add|rm]     看/改保活目标（add 01 02 支持短序号）
  pair <url> [--token]    连远程 daemon
  heal | refresh | renew | warm  立即跑一轮
  install [--write]       生成 systemd / 计划任务配置`);
      return 0;
    default:
      console.error(ui.c.red('未知子命令：' + sub));
      return 2;
  }
}

module.exports = {
  run,
  usage: 'daemon <start|stop|restart|status|logs|targets|pair|heal|refresh|renew|install>',
  help: [
    '子命令:',
    '  start [--detach]        启动（--detach 后台跑）',
    '  stop                    停止',
    '  restart                 重启',
    '  status [--json]         运行状态、各轮结果、登录态剩余',
    '  logs [-n <行数>] [-f]   看日志，-f 跟踪',
    '  targets [ls|add|rm]     看/改保活目标（add 01 02 支持短序号）',
    '  pair <地址> [--token <令牌>]  连远程 daemon',
    '  heal | refresh | renew | warm  立即跑一轮',
    '  install [--write]       生成 systemd / 计划任务的配置（只打印，--write 才落盘）',
    '',
    '说明:',
    '  daemon 管四件事：heal 保活实例、refresh 刷 token、renew 换登录态、warm 让登录态别被回收。',
    '  keepalive 不在 daemon 里 —— 它是独立长驻进程，见 `cowbird keepalive --help`。',
  ],
};
