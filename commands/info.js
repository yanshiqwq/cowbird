// wbsbx info —— 一个实例的 API 侧信息 +（默认）进容器探活
const { parse, need } = require('../lib/args');
const cfg = require('../lib/config');
const ui = require('../lib/ui');
const cloud = require('../lib/cloud');
const e2b = require('../lib/e2b');
const resolve = require('../lib/resolve');
const log = require('../lib/log').log;

// 一次把所有关心的运行时事实取回来（nproc 的坑见 README「nproc 会说谎」）
const PROBE = [
  'echo "host=$(hostname)"',
  'echo "nproc=$(nproc) all=$(nproc --all)"',
  'echo "cpu.max=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null)"',
  'echo "cpuset=$(cat /sys/fs/cgroup/cpuset.cpus.effective 2>/dev/null || cat /sys/fs/cgroup/cpuset/cpuset.effective_cpus 2>/dev/null)"',
  'echo "mem=$(awk \'/MemTotal/{printf "%.1fG", $2/1048576}\' /proc/meminfo)"',
  'echo "uptime=$(uptime -p 2>/dev/null | sed "s/^up //")"',
  'echo "kernel=$(uname -r)"',
  'echo "space=$(grep -E "^(cpu|mem|region):" /var/run/cloudstudio/space.yaml 2>/dev/null | tr "\\n" " ")"',
].join('; ');

async function run(argv) {
  const args = parse(argv, { flags: ['json', 'api-only'] });
  const [ref] = need(args, 1, 'info <实例> [--api-only]');
  const inst = await resolve.resolve(ref);

  const out = { id: inst.id, name: inst.name, status: inst.status, sessionStatus: inst.sessionStatus };
  const t = cfg.readToken(inst.id);
  out.tokenExpireAt = t && t.expireAt;

  if (!args.opts['api-only']) {
    try {
      const s = await cloud.getSession(inst.id, log);
      out.link = s.link;
      out.cwd = s.cwd;
      out.tokenExpireAt = s.expireAt;
      out.sessionStatus = s.sessionStatus || out.sessionStatus;
      const r = await e2b.exec(s, PROBE, { timeout: 30 });
      const kv = {};
      for (const line of r.out.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
      }
      out.live = kv;
      // E2B 不保证发 end 事件，code 可能是 null；有输出就算通
      out.reachable = r.code === 0 || (r.code === null && !!r.out);
    } catch (e) {
      out.reachable = false;
      out.error = e.message;
    }
  }

  if (args.opts.json) { console.log(JSON.stringify(out, null, 2)); return out.reachable === false ? 1 : 0; }

  const rows = [
    ['ID', out.id],
    ['名字', out.name || ui.c.dim('(未命名)')],
    ['状态', ui.statusBadge(out.status) + ' / ' + ui.statusBadge(out.sessionStatus)],
    ['凭据到期', out.tokenExpireAt ? ui.til(out.tokenExpireAt) + ' 后' : ui.c.dim('无缓存')],
  ];
  if (out.link) rows.push(['ACP', out.link.replace(/^https:\/\//, '')]);
  if (out.live) {
    const l = out.live;
    rows.push(['主机名', l.host || '-']);
    rows.push(['内核', l.kernel || '-']);
    rows.push(['CPU 配额', quotaText(l['cpu.max'])]);
    // nproc 看的是亲和性（cpuset），不是配额 —— 共享宿主的池子会报满宿主的核数
    rows.push(['CPU 可见', l.cpuset || '-']);
    rows.push(['nproc', l.nproc + (l.all && l.all !== l.nproc ? ui.c.dim(`（all=${l.all}）`) : '')]);
    rows.push(['内存', memText(l.mem, l.space)]);
    rows.push(['运行时长', l.uptime || '-']);
    if (l.space) rows.push(['机房', l.space.trim()]);
  } else if (out.error) {
    rows.push(['探活', ui.c.red('失败：' + out.error.slice(0, 120))]);
  }
  console.log(ui.table(['项目', '值'], rows, { sep: false }));
  return out.reachable === false ? 1 : 0;
}

// cpu.max 形如 "400000 100000" = 4 核配额
function quotaText(cpuMax) {
  if (!cpuMax) return '未知';
  if (/^\d+$/.test(cpuMax.trim())) {
    const usPerCore = 100000;   // cgroup v1：-1 = 不限
    const v = Number(cpuMax.trim());
    return v <= 0 ? '不限' : (v / usPerCore).toFixed(1) + ' 核';
  }
  const [a, b] = cpuMax.split(/\s+/).map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !b) return cpuMax;
  return a <= 0 || a === -1 ? '不限' : (a / b).toFixed(1) + ' 核';
}

// /proc/meminfo 是"能看见多少"，不是配额；space.yaml 里的 mem 才是平台给的
function memText(mem, space) {
  const q = (space || '').match(/mem:\s*(\S+)/);
  if (q && mem) return `${mem}（平台配额 ${q[1]}）`;
  return mem || '-';
}

module.exports = { run, usage: 'info <实例> [--api-only] [--json]' };
