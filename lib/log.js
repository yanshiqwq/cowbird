// 统一的日志行：带本地时间戳打到 stdout
// 为什么不直接用 console.log：排障要拿时间戳对齐事件（跨时区尤其明显）。
// 要落盘时调用方重定向（`cowbird ... > file 2>&1`）即可，不必自己管文件句柄。
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const log = (...a) => console.log(`[${ts()}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

module.exports = { log };
