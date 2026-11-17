'use strict';
// 容器指纹探针：一条 shell 命令把「看得见的资源 + cgroup 真配额」一次取回来，再纯函数解析。
//
// 只发**一次** exec：E2B 单次往返实测 342–1503 ms（中位约 900 ms），拆成多条命令会让
// `cowbird info` 变成好几秒。所有文件都加了 2>/dev/null —— 缺文件一律是空串，由解析层区分
// 「读不到」和「0」。
const cgroup = require('./cgroup');

const WORKSPACE = '/workspace';

/** 探针输出的键 → 含义（也当自检清单用：selftest 里逐项核对） */
const KEYS = [
  'cg.mount', 'cg.self',
  'v2.cpu.max', 'v2.cpu.stat', 'v2.mem.max', 'v2.mem.swap.max', 'v2.cpuset',
  'v1.cfs.quota', 'v1.cfs.period', 'v1.mem.limit', 'v1.cpuset',
  'nproc', 'nproc.all', 'memtotal.kb', 'free.m', 'free.h', 'df.bytes', 'df.h',
  'host', 'kernel', 'virt', 'uptime', 'uptime.sec', 'cpu.model', 'pid1', 'space.yaml',
];

/**
 * 构造探针脚本。一行一个 `key=$(...)`，值可能是空串（文件不存在/命令缺失）。
 * 注意：里面所有引号都是**给远端 shell** 的，不是给 JS 的。
 */
function buildProbeScript() {
  const lines = [
    // 🚨 先把 locale 钉死成 C：`free`/`df -h`/`uptime -p` 的输出是**本地化**的 ——
    //    在 zh_CN 环境下 free 打印的是「内存：」而不是「Mem:」，按 /^Mem:/ 匹配会静默拿到空值
    //    （2026-11-17 在本机 WSL 上跑这段探针时踩到）。proc 文件里的键名倒是永不本地化。
    'export LC_ALL=C LANG=C',
    // ── cgroup 版本：v2 挂的是 cgroup2fs，v1 是 tmpfs（两种代际都实测见过）──
    'echo "cg.mount=$(stat -fc %T /sys/fs/cgroup 2>/dev/null)"',
    'echo "cg.self=$(tr \'\\n\' \';\' < /proc/self/cgroup 2>/dev/null)"',
    // ── cgroup v2（A 代 tl4 容器）──
    'echo "v2.cpu.max=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"',
    'echo "v2.cpu.stat=$(awk \'{printf "%s=%s ", $1, $2}\' /sys/fs/cgroup/cpu.stat 2>/dev/null)"',
    'echo "v2.mem.max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"',
    'echo "v2.mem.swap.max=$(cat /sys/fs/cgroup/memory.swap.max 2>/dev/null)"',
    'echo "v2.cpuset=$(cat /sys/fs/cgroup/cpuset.cpus.effective 2>/dev/null)"',
    // ── cgroup v1（B 代 Cube 微 VM）──
    'echo "v1.cfs.quota=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null)"',
    'echo "v1.cfs.period=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null)"',
    'echo "v1.mem.limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"',
    'echo "v1.cpuset=$(cat /sys/fs/cgroup/cpuset/cpuset.effective_cpus 2>/dev/null)"',
    // ── 可见资源：就是会撒谎的那一组（nproc / free / df）──
    'echo "nproc=$(nproc 2>/dev/null)"',
    'echo "nproc.all=$(nproc --all 2>/dev/null)"',
    'echo "memtotal.kb=$(awk \'/^MemTotal/{print $2}\' /proc/meminfo 2>/dev/null)"',
    // free 按行号取字段（第 2 行第 2 列），不认标签 —— 万一 locale 没生效也还能用
    'echo "free.m=$(free -m 2>/dev/null | awk \'NR==2{print $2}\')"',
    'echo "free.h=$(free -h 2>/dev/null | awk \'NR==2{print $2}\')"',
    'echo "df.bytes=$(df -P -B1 / 2>/dev/null | awk \'NR==2{print $2}\')"',
    'echo "df.h=$(df -h / 2>/dev/null | awk \'NR==2{print $2}\')"',
    // ── 身份 / 环境（判代际用：tl4 vs cube、docker-init vs supervisord）──
    'echo "host=$(hostname 2>/dev/null)"',
    'echo "kernel=$(uname -r 2>/dev/null)"',
    'echo "virt=$(systemd-detect-virt 2>/dev/null)"',
    'echo "uptime=$(uptime -p 2>/dev/null | sed \'s/^up //\')"',
    'echo "uptime.sec=$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
    'echo "cpu.model=$(awk -F: \'/model name/{gsub(/^ +/, "", $2); print $2; exit}\' /proc/cpuinfo 2>/dev/null)"',
    'echo "pid1=$(tr \'\\0\' \' \' < /proc/1/cmdline 2>/dev/null | cut -c1-120)"',
    // 平台自述配额（与 cgroup 交叉验证，见 commands/info.js 的既有做法）
    'echo "space.yaml=$(grep -E \'^(cpu|mem|region):\' /var/run/cloudstudio/space.yaml 2>/dev/null | tr \'\\n\' \' \')"',
  ];
  return lines.join('\n');
}

/** `key=value` 逐行拆开；值里再出现 '=' 只切第一刀（cpu.model 里可能有） */
function parseKv(text) {
  const kv = {};
  for (const line of String(text === undefined || text === null ? '' : text).split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!k) continue;
    kv[k] = line.slice(i + 1).trim();
  }
  return kv;
}

const hasCpuData = (c) => !!c && (c.cores !== null || c.unlimited === true);
const hasMemData = (m) => !!m && (m.bytes !== null || m.unlimited === true);

/**
 * 扁平键值 → 结构化容量。
 *
 * 返回的 visible（看得见）与 quota（真能用）是**两组独立数字**，绝不互相覆盖：
 * A 代沙箱里 visible.cpu=32 / quota.cpu=4、visible.memBytes≈123 GiB / quota.memBytes=8 GiB，
 * 两个都得报出来，内核才有机会提醒用户「别按 nproc 自适应」。
 *
 * @param {Record<string,string>} kv parseKv() 的结果
 */
function summarize(kv = {}) {
  const mount = String(kv['cg.mount'] || '');
  const v2cpu = cgroup.parseCpuMax(kv['v2.cpu.max']);
  const v2mem = cgroup.parseMemoryMax(kv['v2.mem.max']);
  const v1cpu = cgroup.parseCfsQuota(kv['v1.cfs.quota'], kv['v1.cfs.period']);
  const v1mem = cgroup.parseMemoryMax(kv['v1.mem.limit'], { v1: true });

  const v2 = hasCpuData(v2cpu) || hasMemData(v2mem);
  const v1 = hasCpuData(v1cpu) || hasMemData(v1mem);
  // 挂载类型是权威判据；只有读不到时才靠「哪组文件有内容」猜
  const version = mount === 'cgroup2fs' ? 'v2' : mount === 'tmpfs' ? 'v1' : v2 ? 'v2' : v1 ? 'v1' : null;

  const cpu = version === 'v1' ? (hasCpuData(v1cpu) ? v1cpu : v2cpu) : (hasCpuData(v2cpu) ? v2cpu : v1cpu);
  const mem = version === 'v1' ? (hasMemData(v1mem) ? v1mem : v2mem) : (hasMemData(v2mem) ? v2mem : v1mem);
  const cpuset = (version === 'v1' ? kv['v1.cpuset'] || kv['v2.cpuset'] : kv['v2.cpuset'] || kv['v1.cpuset']) || null;

  const nproc = Number(kv['nproc']);
  const nprocAll = Number(kv['nproc.all']);
  const memTotalKb = Number(kv['memtotal.kb']);
  const freeM = Number(kv['free.m']);
  const dfBytes = Number(kv['df.bytes']);

  const visible = {
    cpu: Number.isFinite(nproc) ? nproc : null,                       // nproc：宿主亲和性，不是配额
    cpuAll: Number.isFinite(nprocAll) ? nprocAll : null,
    memBytes: Number.isFinite(memTotalKb) ? memTotalKb * 1024        // /proc/meminfo：宿主总量
      : Number.isFinite(freeM) ? freeM * cgroup.MIB : null,
    memText: kv['free.h'] || null,                                    // free -h 的原文（B 代唯一可信的那个）
    freeM: Number.isFinite(freeM) ? freeM : null,
    diskBytes: Number.isFinite(dfBytes) ? dfBytes : null,
    diskText: kv['df.h'] || null,
  };

  const space = cgroup.parseSpaceYaml(kv['space.yaml']);
  const throttled = cgroup.parseCpuStat(kv['v2.cpu.stat']);

  const quota = {
    cgroupVersion: version,
    cpu: cpu.cores,
    cpuUnlimited: !!cpu.unlimited,
    cpuQuotaUs: cpu.quotaUs,
    cpuPeriodUs: cpu.periodUs,
    cpuText: cpu.text || null,
    memBytes: mem.bytes,
    memUnlimited: !!mem.unlimited,
    memText: mem.text || null,
    swapBytes: cgroup.parseMemoryMax(kv['v2.mem.swap.max']).bytes,
    cpuset,
    cgroupPath: kv['cg.self'] || null,
    throttled: throttled.throttled === null && throttled.periods === null ? null : throttled,
    spaceYaml: space.text ? { cpu: space.cpu, memBytes: space.memBytes, memText: space.memText, region: space.region } : null,
  };

  // ── 结论：把「撒谎」这件事直接说出来，别让调用方自己去比大小 ──
  const warnings = [];
  if (visible.cpu !== null && quota.cpu !== null && visible.cpu > quota.cpu) {
    warnings.push(`nproc 报 ${visible.cpu} 核，cgroup 配额只有 ${cgroup.fmtCores(quota.cpu)} —— ` +
      'nproc 读的是宿主亲和性（cpuset），不是配额；按 nproc 自适应并行度的程序会被掐死');
  }
  if (visible.memBytes !== null && quota.memBytes !== null && visible.memBytes > quota.memBytes * 1.05) {
    warnings.push(`/proc/meminfo 报 ${cgroup.fmtBytes(visible.memBytes)}，cgroup 配额只有 ${cgroup.fmtBytes(quota.memBytes)}`);
  }
  if (quota.throttled && Number(quota.throttled.throttled) > 0) {
    warnings.push(`这个沙箱已经被 cgroup 限流过 ${quota.throttled.throttled} 次` +
      `（throttled_usec=${quota.throttled.throttledUsec}）—— 配额是硬顶，不是建议值`);
  }
  if (quota.cpu === null && quota.cpuUnlimited === false) {
    warnings.push('读不到 cgroup CPU 配额（cpu.max / cpu.cfs_quota_us 都空），下面只有可见资源');
  }
  if (quota.memBytes === null && quota.memUnlimited === false) {
    warnings.push('读不到 cgroup 内存配额（memory.max / memory.limit_in_bytes 都空）');
  }
  if (space.memBytes !== null && quota.memBytes !== null && Math.abs(space.memBytes - quota.memBytes) > 4096) {
    warnings.push(`space.yaml 自述内存 ${space.memText}，cgroup 报 ${cgroup.fmtBytes(quota.memBytes)} —— 两个来源不一致`);
  }

  const environment = {
    host: kv['host'] || null,
    kernel: kv['kernel'] || null,
    virt: kv['virt'] || null,
    uptime: kv['uptime'] || null,
    uptimeSec: Number(kv['uptime.sec']) || null,
    cpuModel: kv['cpu.model'] || null,
    pid1: kv['pid1'] || null,
    cgroupMount: mount || null,
  };

  return { visible, quota, environment, warnings, facts: buildFacts({ visible, quota, environment }) };
}

/** 给人看的键值行（内核直接渲染成表格即可） */
function buildFacts({ visible, quota, environment }) {
  const facts = [];
  const add = (label, value) => { if (value !== null && value !== undefined && value !== '') facts.push({ label, value: String(value) }); };
  add('主机名', environment.host);
  add('内核', environment.kernel);
  add('虚拟化', environment.virt);
  add('PID 1', environment.pid1);
  add('CPU 型号', environment.cpuModel);
  add('cgroup', quota.cgroupVersion || '未知');
  add('CPU 配额', quota.cpuUnlimited ? '不限' : cgroup.fmtCores(quota.cpu));
  add('CPU 可见', quota.cpuset ? quota.cpuset + '（cpuset）' : null);
  add('nproc', visible.cpu === null ? null : String(visible.cpu));
  add('内存配额', quota.memUnlimited ? '不限' : cgroup.fmtBytes(quota.memBytes));
  add('内存可见', cgroup.fmtBytes(visible.memBytes));
  add('根盘可见', visible.diskText);
  add('运行时长', environment.uptime);
  if (quota.throttled && Number(quota.throttled.throttled) > 0) {
    add('已被限流', quota.throttled.throttled + ' 次');
  }
  return facts;
}

module.exports = { KEYS, WORKSPACE, buildProbeScript, parseKv, summarize, buildFacts };
