// 极简参数解析：不引三方库，行为可预期
//   --flag / --no-flag            布尔
//   --key=value / --key value     取值
//   -h -v 等短别名通过 aliases 指定
//   stopAfter: n                  收到 n 个位置参数后，剩下的原样收进 _（给 exec/prompt 用，
//                                 跟 ssh / docker exec 一致：命令里带 -la 不会被当成选项）
function parse(argv, spec = {}) {
  const flags = new Set(spec.flags || []);
  const values = new Set(spec.values || []);
  const aliases = spec.aliases || {};
  const stopAfter = spec.stopAfter;
  const out = { _: [], opts: {} };

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (stopAfter !== undefined && out._.length >= stopAfter) { out._.push(...argv.slice(i)); break; }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      if (key.startsWith('no-') && flags.has(key.slice(3))) { out.opts[key.slice(3)] = false; continue; }
      if (values.has(key)) {
        if (val === undefined) val = argv[++i];
        if (val === undefined) throw new Error(`--${key} 需要一个值`);
        out.opts[key] = val;
      } else if (flags.has(key)) {
        out.opts[key] = val === undefined ? true : val !== 'false';
      } else {
        throw new Error(`未知选项 --${key}`);
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && a !== '-') {
      const key = aliases[a.slice(1)];
      if (!key) throw new Error(`未知选项 ${a}`);
      if (values.has(key)) out.opts[key] = argv[++i];
      else out.opts[key] = true;
      continue;
    }
    out._.push(a);
  }
  return out;
}

// 取位置参数，不够就报错（带用法提示）
function need(args, n, usage) {
  if (args._.length < n) throw new Error('用法: wbsbx ' + usage);
  return args._.slice(0, n);
}

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

module.exports = { parse, need, num };
