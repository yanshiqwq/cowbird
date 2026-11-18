// 命令定义工厂：**一份 spec 同时生成 parse 规格、--help 文案与 usage**。
//
// 为什么要它：审计里 18 条命令各自手写 `parse(argv, {...})` + 静态 help 数组 +
// 第二份 usage 字符串，已经漂移出 11 处（`-c` 文档里有实现里没有、`--json` 没写、
// `--sec` 没写、daemon 的 usage 漏了 warm……）。一份 spec 只能漂一次。
const { parse } = require('./args');
const ui = require('./ui');

const PAD = 2;

/** 把一条选项渲染成 `  -c, --channel <渠道>   说明` */
function renderOption(o, width) {
  const left = [
    o.short ? `-${o.short}, ` : '    ',
    `--${o.flag}`,
    o.arg ? ` ${o.arg}` : '',
  ].join('');
  const gap = ' '.repeat(Math.max(1, width - ui.width(left)));
  return `  ${left}${gap}${o.desc || ''}`.replace(/\s+$/, '');
}

/**
 * @param {object} spec
 * @param {string} spec.usage            不含 `cowbird ` 前缀的用法行
 * @param {Array}  [spec.options]        [{ flag, short?, arg?, desc?, value?:false }]
 *                                       带 arg 的按取值解析，否则按布尔
 * @param {string[]} [spec.notes]        说明段（一行一条）
 * @param {Array}  [spec.exits]          [[0, '成功'], [1, '执行失败']]
 * @param {number} [spec.stopAfter]      第 N 个位置参数之后原样收下（exec/prompt 用）
 * @param {Function} spec.run            (args) => number | Promise<number>
 */
function defineCommand(spec) {
  const name = spec.name || String(spec.usage || '').split(/\s+/)[0];
  const options = spec.options || [];
  const flags = [];
  const values = [];
  const aliases = {};
  for (const o of options) {
    if (!o || !o.flag) continue;
    const takesValue = Boolean(o.arg) && o.value !== false;
    (takesValue ? values : flags).push(o.flag);
    if (o.short) aliases[o.short] = o.flag;
  }

  const help = [];
  if (options.length) {
    // 左列最长的那个也要留两格间距，否则 `--platform <id>指定平台` 会粘在一起
    const width = Math.max(...options.map((o) => ui.width([
      o.short ? `-${o.short}, ` : '    ', `--${o.flag}`, o.arg ? ` ${o.arg}` : '',
    ].join('')))) + PAD;
    help.push('选项:');
    for (const o of options) help.push(renderOption(o, width));
  }
  if (Array.isArray(spec.notes) && spec.notes.length) {
    if (help.length) help.push('');
    help.push('说明:');
    for (const n of spec.notes) help.push('  ' + n);
  }
  if (Array.isArray(spec.exits) && spec.exits.length) {
    if (help.length) help.push('');
    help.push('退出码:');
    for (const [code, desc] of spec.exits) help.push(`  ${code}  ${desc}`);
  }

  return {
    name,
    usage: spec.usage,
    stopAfter: spec.stopAfter,
    help,
    /** 选项名清单（测试与文档生成用） */
    optionNames: { flags: flags.slice(), values: values.slice(), aliases: { ...aliases } },
    async run(argv) {
      const args = parse(argv, { flags, values, aliases, stopAfter: spec.stopAfter });
      const code = await spec.run(args, { name, usage: spec.usage });
      return Number.isFinite(code) ? code : 0;
    },
  };
}

/**
 * 子命令组：`cowbird daemon <子命令> ...` 这种形状。
 * 每个子命令自己一份 options spec，避免"6 个 parse() 各写一遍"的老问题。
 *
 * @param {object} spec
 * @param {string} spec.usage
 * @param {Object<string,{usage:string, options?:Array, stopAfter?:number, summary?:string, run:Function}>} spec.subcommands
 * @param {string} [spec.default]     不给子命令时默认跑哪个（默认 help）
 * @param {string[]} [spec.notes]
 * @param {Array} [spec.exits]
 */
function defineGroup(spec) {
  const subs = spec.subcommands || {};
  const help = [];
  if (Object.keys(subs).length) {
    help.push('子命令:');
    const width = Math.max(...Object.values(subs).map((s) => String(s.usage || '').length)) + PAD;
    for (const [, s] of Object.entries(subs)) {
      const left = String(s.usage || '');
      const gap = ' '.repeat(Math.max(1, width - ui.width(left)));
      help.push(`  ${left}${gap}${s.summary || ''}`.replace(/\s+$/, ''));
    }
  }
  if (Array.isArray(spec.notes) && spec.notes.length) {
    help.push('', '说明:');
    for (const n of spec.notes) help.push('  ' + n);
  }
  if (Array.isArray(spec.exits) && spec.exits.length) {
    help.push('', '退出码:');
    for (const [code, desc] of spec.exits) help.push(`  ${code}  ${desc}`);
  }

  const printHelp = () => {
    console.log(`用法: cowbird ${spec.usage}`);
    if (help.length) console.log('\n' + help.join('\n'));
  };

  return {
    usage: spec.usage,
    help,
    optionNames: { flags: [], values: [], aliases: {} },
    async run(argv) {
      const idx = argv.findIndex((a) => !a.startsWith('-'));
      const name = idx < 0 ? (spec.default || 'help') : argv[idx];
      const rest = idx < 0 ? argv.slice() : [...argv.slice(0, idx), ...argv.slice(idx + 1)];
      if (name === 'help' || !subs[name]) {
        if (name !== 'help') console.error(`未知子命令：${name}`);
        printHelp();
        return name === 'help' ? 0 : 2;
      }
      const s = subs[name];
      const cmd = defineCommand({
        usage: s.usage || name,
        options: s.options,
        stopAfter: s.stopAfter,
        run: s.run,
      });
      return cmd.run(rest);
    },
  };
}

module.exports = { defineCommand, defineGroup };
