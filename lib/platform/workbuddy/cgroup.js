'use strict';
// cgroup 与容量解析：**全是纯函数**，不碰网络、不读文件 —— selftest.js 直接拿假数据过一遍。
//
// 为什么要读 cgroup（2026-11-17 实测，20 个既有会话抽样 + 4 个补读 cgroups）：
//   WorkBuddy 的沙箱池是两代异构的，但它们骗人的方式不一样：
//     A 代（tl4 大容器，约 3/4）：nproc=32、MemTotal≈123 GiB、根盘 256 GiB —— 全是**宿主**的数字
//     B 代（Cube 微 VM，约 1/4）：nproc=5、8.2 GiB —— 与配额基本一致
//   而两代的 cgroup 配额**完全一样**：cpu.max = 400000/100000（4 核）、memory.max = 8589934592（8 GiB）。
//   所以 info 必须同时给「看得见的」和「真正能用的」两组数字：只给 nproc，`make -j` / `npm ci` /
//   JVM 默认堆 / 多进程池会按 32 核 123 GiB 去规划，然后被 4 核掐死（A 代已经出现过 nr_throttled>0）。

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// cgroup v1 里 memory.limit_in_bytes 的「无限制」哨兵（大约 2^63 页对齐）。
// 不特判的话会被当成 8 EiB 真配额，比 nproc 撒谎还离谱。
const V1_MEM_UNLIMITED = 9223372036854771712;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * cgroup v2 的 cpu.max：一格里两个字段 `quota period`。
 *   '400000 100000' → 4 核；'max 100000' → 不限；空串 → 读不到（别当成 0 核）
 */
function parseCpuMax(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const out = { text: raw, quotaUs: null, periodUs: null, cores: null, unlimited: false };
  if (!raw) return out;
  const parts = raw.split(/\s+/);
  const period = Number(parts[1]);
  out.periodUs = Number.isFinite(period) && period > 0 ? period : null;
  if (parts[0] === 'max') { out.unlimited = true; return out; }
  const quota = Number(parts[0]);
  if (!Number.isFinite(quota)) return out;
  out.quotaUs = quota;
  if (quota <= 0) { out.unlimited = true; return out; }
  out.cores = round2(quota / (out.periodUs || 100000));
  return out;
}

/**
 * cgroup v1：配额和周期是两个文件（cpu.cfs_quota_us / cpu.cfs_period_us）。
 * quota = -1 表示不限（这是 v1 的约定，别当成 -1 核）。
 */
function parseCfsQuota(quotaText, periodText) {
  const qRaw = String(quotaText === undefined || quotaText === null ? '' : quotaText).trim();
  const pRaw = String(periodText === undefined || periodText === null ? '' : periodText).trim();
  const out = { text: qRaw, periodText: pRaw, quotaUs: null, periodUs: null, cores: null, unlimited: false };
  if (!qRaw) return out;
  const quota = Number(qRaw);
  if (!Number.isFinite(quota)) return out;
  out.quotaUs = quota;
  const period = Number(pRaw);
  out.periodUs = Number.isFinite(period) && period > 0 ? period : 100000;   // v1 默认周期 100ms
  if (quota <= 0) { out.unlimited = true; return out; }
  out.cores = round2(quota / out.periodUs);
  return out;
}

/**
 * 内存上限：v2 是一个 memory.max（'max' = 不限），v1 是一个 memory.limit_in_bytes（超大哨兵 = 不限）。
 * @param {string} text
 * @param {{v1?: boolean}} [opts]
 */
function parseMemoryMax(text, opts = {}) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const out = { text: raw, bytes: null, unlimited: false };
  if (!raw) return out;
  if (raw === 'max') { out.unlimited = true; return out; }
  const n = Number(raw);
  if (!Number.isFinite(n)) return out;
  if (opts.v1 && n >= V1_MEM_UNLIMITED) { out.unlimited = true; return out; }
  if (n <= 0) { out.unlimited = true; return out; }
  out.bytes = n;
  return out;
}

/**
 * cpu.stat：v2 是「每行两个字段」（nr_periods 2626 / nr_throttled 5 / throttled_usec 1262552），
 * 探针里用 awk 压成了 'nr_periods=2626 nr_throttled=5'，两种写法都吃。
 * nr_throttled > 0 是「4 核是硬顶」的直接证据，值得报给用户看。
 */
function parseCpuStat(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const out = { text: raw, periods: null, throttled: null, throttledUsec: null };
  if (!raw) return out;
  const map = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      // 'k=v k2=v2' 形式
      for (const pair of t.split(/\s+/)) {
        const i = pair.indexOf('=');
        if (i > 0) map[pair.slice(0, i)] = pair.slice(i + 1);
      }
    } else {
      const [k, v] = t.split(/\s+/);
      if (k) map[k] = v;
    }
  }
  const pick = (k) => { const n = Number(map[k]); return Number.isFinite(n) ? n : null; };
  out.periods = pick('nr_periods');
  out.throttled = pick('nr_throttled');
  out.throttledUsec = pick('throttled_usec');
  return out;
}

/**
 * /var/run/cloudstudio/space.yaml 里 `cpu: 4` / `mem: 8Gi` / `region: ap-xxx`（来自 commands/info.js 的既有做法）。
 * 平台自述的配额，用来和 cgroup 交叉验证 —— 两者一致才敢说「这就是你的配额」。
 */
function parseSpaceYaml(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim();
  const out = { text: raw, cpu: null, memBytes: null, memText: null, region: null };
  if (!raw) return out;
  // 用 exec 逐个吃 `key: value`（value 不含空格）；别用 split(/\s*(?=...)/)：
  // JS 的 split 遇到「能匹配空串」的分隔符会在每个字符间切开，结果会碎成一地单字符。
  const re = /([A-Za-z]+)\s*:\s*([^\s]+)/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const k = m[1].toLowerCase();
    const v = m[2];
    if (k === 'cpu') out.cpu = Number(v) || null;
    else if (k === 'mem') { out.memText = v; out.memBytes = parseSize(v); }
    else if (k === 'region') out.region = v || null;
  }
  return out;
}

/** '8Gi' / '8G' / '512Mi' / '8589934592' → 字节数；认不出来返回 null */
function parseSize(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*([KMGT]i?)?B?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || '').toUpperCase();
  const mult = { '': 1, K: 1024, M: MIB, G: GIB, T: 1024 * GIB, KI: 1024, MI: MIB, GI: GIB, TI: 1024 * GIB }[unit];
  if (!mult) return null;
  return Math.round(n * mult);
}

/** 给人看的字节数：8589934592 → '8 GiB'，132491378688 → '123.4 GiB' */
function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return null;
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= GIB) return round1(n / GIB) + ' GiB';
  if (n >= MIB) return round1(n / MIB) + ' MiB';
  if (n >= 1024) return round1(n / 1024) + ' KiB';
  return n + ' B';
}

function fmtCores(cores) {
  if (cores === null || cores === undefined) return null;
  const n = Number(cores);
  if (!Number.isFinite(n)) return null;
  return (Number.isInteger(n) ? String(n) : String(round2(n))) + ' 核';
}

module.exports = {
  MIB, GIB, V1_MEM_UNLIMITED,
  parseCpuMax, parseCfsQuota, parseMemoryMax, parseCpuStat, parseSpaceYaml, parseSize,
  fmtBytes, fmtCores,
};
