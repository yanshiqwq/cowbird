// cgroup 容量读取：v2（unified）与 v1（legacy）双模式。
//
// 为什么要自己解析：沙箱是 K8s Pod，`nproc` / /proc/meminfo 报的是**宿主机可见**的数字，
// 而真正卡住我们的是 cgroup 配额 —— 两者经常对不上（WorkBuddy 那边就是 32c/126G 可见、
// 4c/8G 配额）。所以 `instances.info` 要同时给「可见」与「配额」两组数。
//
// 采集走免 LLM 的 shell 通道（exec.run），脚本自己打印 WBSBX_* 键值行，
// 解析在这里做（纯函数，可离线自测）。

const RC = 'WBSBX_';

/** 沙箱里跑的采集脚本（POSIX sh，只依赖 coreutils） */
function cgroupScript() {
  return [
    'echo "WBSBX_NPROC=$(nproc 2>/dev/null || grep -c "^processor" /proc/cpuinfo 2>/dev/null)"',
    'echo "WBSBX_MEMTOTAL_KB=$(awk \'/^MemTotal:/{print $2}\' /proc/meminfo 2>/dev/null)"',
    'if [ -f /sys/fs/cgroup/cgroup.controllers ] || [ -f /sys/fs/cgroup/cpu.max ]; then',
    '  echo "WBSBX_CG=v2"',
    '  echo "WBSBX_CPU_MAX=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"',
    '  echo "WBSBX_MEM_MAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"',
    'elif [ -f /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]; then',
    '  echo "WBSBX_CG=v1"',
    '  echo "WBSBX_CPU_QUOTA=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null)"',
    '  echo "WBSBX_CPU_PERIOD=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null)"',
    '  echo "WBSBX_MEM_MAX=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"',
    'else',
    '  echo "WBSBX_CG=none"',
    'fi',
    'echo "WBSBX_DF=$(df -kP / 2>/dev/null | awk \'NR==2{print $2" "$4}\')"',
    'echo "WBSBX_UNAME=$(uname -smr 2>/dev/null)"',
    'echo "WBSBX_HOST=$(hostname 2>/dev/null)"',
    'echo "WBSBX_ROOTFS=$(stat -f -c %T /workspace 2>/dev/null || echo unknown)"',
  ].join('\n');
}

function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** v1 的"无限制"是 9223372036854771712 这个魔数，v2 是字符串 max */
function isUnlimited(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim().toLowerCase();
  if (!s) return true;
  if (s === 'max' || s === '-1') return true;
  const n = Number(s);
  if (!Number.isFinite(n)) return true;
  return n <= 0 || n >= 9.2e18;      // 2^63 附近一律当"没设上限"
}

/** `400000 100000` / `250000 100000` / `max 100000` → CPU 核数（可为小数），null = 不限 */
function cpuFromV2(text) {
  const parts = String(text || '').trim().split(/\s+/);
  if (parts.length < 2) return isUnlimited(text) ? null : num(parts[0]);
  const [quota, period] = parts;
  if (isUnlimited(quota)) return null;
  const q = num(quota);
  const p = num(period);
  if (!q || !p) return null;
  return Math.round((q / p) * 100) / 100;
}

function cpuFromV1(quota, period) {
  if (isUnlimited(quota)) return null;
  const q = num(quota);
  const p = num(period) || 100000;
  if (!q || !p) return null;
  return Math.round((q / p) * 100) / 100;
}

function bytes(v) {
  if (isUnlimited(v)) return null;
  const n = num(v);
  return n && n > 0 ? n : null;
}

/**
 * 解析 cgroupScript() 的输出。
 * 容忍缺失键（旧沙箱没有某个文件是常态），任何一项读不到就是 null。
 */
function parseCgroup(text) {
  const kv = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (!k.startsWith(RC)) continue;
    kv[k.slice(RC.length)] = t.slice(i + 1).trim();
  }

  const mode = kv.CG === 'v2' || kv.CG === 'v1' ? kv.CG : (kv.CPU_MAX !== undefined ? 'v2' : kv.CPU_QUOTA !== undefined ? 'v1' : null);

  const cpuQuota = mode === 'v2' ? cpuFromV2(kv.CPU_MAX) : mode === 'v1' ? cpuFromV1(kv.CPU_QUOTA, kv.CPU_PERIOD) : null;
  const memQuota = bytes(kv.MEM_MAX);
  const memTotalKb = num(kv.MEMTOTAL_KB);

  // df -kP / → "31268748 12345678"（总 KB / 可用 KB）
  let diskTotal = null;
  let diskAvail = null;
  const df = String(kv.DF || '').trim().split(/\s+/);
  if (df.length >= 2) {
    const t = num(df[0]);
    const a = num(df[1]);
    if (t) diskTotal = t * 1024;
    if (a !== null) diskAvail = a * 1024;
  }

  const cpuVisible = num(kv.NPROC);

  return {
    mode,
    cpu: {
      visible: cpuVisible,
      quota: cpuQuota,                    // null = 没设上限
      unlimited: cpuQuota === null,
    },
    mem: {
      visibleBytes: memTotalKb ? memTotalKb * 1024 : null,
      quotaBytes: memQuota,               // null = 没设上限
      unlimited: memQuota === null,
    },
    disk: { totalBytes: diskTotal, availBytes: diskAvail },
    kernel: kv.UNAME || null,
    host: kv.HOST || null,
    rootfs: kv.ROOTFS || null,
    raw: kv,
    parsed: true,
  };
}

/** 人类可读（info 的 facts 用） */
function humanBytes(b) {
  if (!b || !Number.isFinite(Number(b))) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(b);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

module.exports = { cgroupScript, parseCgroup, cpuFromV2, cpuFromV1, isUnlimited, humanBytes };
