// 终端输出小工具：颜色（尊重 NO_COLOR / 非 TTY）、对齐表格、人类可读的时间与大小
const useColor = process.env.NO_COLOR
  ? false
  : (process.env.FORCE_COLOR === '1' || (process.stdout.isTTY && process.platform !== 'win32'));

const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  dim: wrap(2), bold: wrap(1),
  red: wrap(31), green: wrap(32), yellow: wrap(33),
  blue: wrap(34), cyan: wrap(36), magenta: wrap(35),
};

// 中文字符按 2 列宽算，否则表格会歪；ANSI 颜色码不算宽度，否则带颜色的单元格会多出几列
const ANSI = /\x1b\[[0-9;]*m/g;
function width(s) {
  let n = 0;
  for (const ch of String(s).replace(ANSI, '')) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return n;
}
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));

function table(headers, rows, opts = {}) {
  const all = [headers, ...rows].map((r) => r.map((x) => String(x === undefined || x === null ? '-' : x)));
  const w = headers.map((_, i) => Math.max(...all.map((r) => width(r[i]))));
  const out = [];
  out.push(headers.map((h, i) => c.bold(pad(h, w[i]))).join('  '));
  if (opts.sep !== false) out.push(w.map((n) => '─'.repeat(n)).join('  '));
  for (const r of rows.map((x) => x.map((y) => String(y === undefined || y === null ? '-' : y)))) {
    out.push(r.map((x, i) => pad(x, w[i])).join('  '));
  }
  return out.join('\n');
}

function til(tsSeconds) {
  if (!tsSeconds) return '-';
  const s = Math.round(Number(tsSeconds) - Date.now() / 1000);
  if (s <= 0) return c.red('已过期');
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return (s / 3600).toFixed(1) + 'h';
  return (s / 86400).toFixed(1) + 'd';
}

function bytes(n) {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0; let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + u[i];
}

function statusBadge(s) {
  const t = String(s || '-');
  const low = t.toLowerCase();
  if (low === 'pending') return c.yellow(t);
  if (low === 'working' || low === 'running') return c.cyan(t);
  if (low === 'completed') return c.green(t);
  if (low === 'creating') return c.blue(t);
  return c.dim(t);
}

module.exports = { c, table, til, bytes, statusBadge, width };
