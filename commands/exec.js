// cowbird exec —— 在实例里直接跑命令（经平台的执行通道，不经过 Agent）
//
// 参数规则跟 ssh / docker exec 一致：**第一个位置参数之后的全部内容都是命令**。
// 所以 `cowbird exec 01 ls -la /etc` 能直接用，不用给整条命令加引号。
// 代价是 exec 自己的选项要写在实例之前：`cowbird exec --timeout 30 01 "sleep 60"`。
//
// 「怎么跑」不在这里决定：同步 / 转后台 / 直接拒绝，交给 lib/platform/exec.js 按
// provider 声明的 limits 处理。这样 30s 硬顶的平台和 600s 的平台能共用一条命令。
const fs = require('fs');
const { need, num } = require('../lib/args');
const ui = require('../lib/ui');
const log = require('../lib/log').log;
const { CAP } = require('../lib/platform/contract');
const { capabilityError } = require('../lib/platform/caps');
const execCore = require('../lib/platform/exec');
const { pickTarget } = require('../lib/platform/target');
const { defineCommand } = require('../lib/command');

const USAGE = 'exec [--timeout <秒>] [--background] [--json] <实例> <命令...>   或   exec <实例> -f <脚本>';

module.exports = defineCommand({
  usage: USAGE,
  stopAfter: 1,          // 第一个位置参数（实例）之后的一切都属于命令
  options: [
    { flag: 'timeout', short: 't', arg: '<秒>', desc: '单次执行超时；超过平台上限会自动转后台（有后台能力的平台）' },
    { flag: 'wait', arg: '<秒>', desc: '转后台后最多等多久（默认 0 = 立即返回 job 信息）' },
    { flag: 'background', desc: '强制转后台' },
    { flag: 'no-wake', desc: '沙箱没醒时不自动唤醒（避免花额度）' },
    { flag: 'file', short: 'f', arg: '<路径>', desc: '执行本地脚本文件的内容' },
    { flag: 'json', desc: '输出 JSON' },
    { flag: 'quiet', desc: '不打印 [exit=N]' },
  ],
  notes: [
    '选项必须写在实例前面 —— 实例之后的内容全部当命令串，所以不用加引号。',
    '走平台的数据面（WorkBuddy=E2B / Qoder=沙箱 MCP / 码道=内核 shell / TRAE=沙箱 agent），不经过 Agent。',
    '平台没有执行通道时（如 MiniMax）会直接报错并列出可用命令。',
  ],
  exits: [
    [0, '远端命令返回 0（或拿不到退出码）'],
    [1, '远端命令返回非 0'],
    [2, '平台不支持 exec'],
  ],
  run: async (args) => {
    const [ref] = need(args, 1, USAGE);

    const rest = args._.slice(1);
    // 兼容老写法 `exec <实例> -f 脚本.sh`：只有"命令"恰好是 -f/--file + 一个路径时才当文件读，
    // 免得把 `ls -f` 这种真的想跑的东西误判。
    const legacyFile = rest.length === 2 && (rest[0] === '-f' || rest[0] === '--file');
    let cmd;
    if (args.opts.file) cmd = fs.readFileSync(args.opts.file, 'utf8');
    else if (legacyFile) cmd = fs.readFileSync(rest[1], 'utf8');
    else cmd = rest.join(' ');
    if (!cmd) throw new Error('用法: cowbird ' + USAGE);

    // 先解析到渠道（可能是别的平台/账号），再按**命中的**平台判能力
    const { inst, ctx } = await pickTarget(ref, { log });
    const p = ctx.provider;
    if (!p.has(CAP.EXEC)) {
      throw capabilityError(`本平台 ${p.displayName} 没有执行通道。`, {
        capability: CAP.EXEC,
        hint: '  可用的命令：ls / info / prompt / history / watch / doctor\n  换一个支持 exec 的平台：cowbird platform ls',
      });
    }
    const timeoutMs = num(args.opts.timeout, 0) > 0 ? num(args.opts.timeout, 0) * 1000 : undefined;
    const waitMs = num(args.opts.wait, 0) > 0 ? num(args.opts.wait, 0) * 1000 : 0;

    const r = await execCore.run(ctx, inst.id, {
      command: cmd,
      timeoutMs,
      background: !!args.opts.background,
      waitMs,
      wake: !args.opts['no-wake'],
      log: (m) => log(m),
    });

    if (args.opts.json) {
      console.log(JSON.stringify({
        out: r.out, err: r.err, code: r.code, ms: r.ms,
        truncated: !!r.truncated, via: r.via,
        job: r.job ? { id: r.job.jobId, outputPath: r.job.outputPath } : undefined,
        running: !!r.running,
      }));
    } else {
      if (r.out) process.stdout.write(r.out);
      if (r.err) process.stderr.write(ui.c.dim(r.err));
      if (!args.opts.quiet) {
        const bits = [`exit=${r.code === null ? '?' : r.code}`];
        if (r.via === 'bg') bits.push('后台');
        if (r.running) bits.push('仍在跑');
        if (r.truncated) bits.push('已截断');
        console.log(ui.c.dim(`[${bits.join(' ')}]`));
      }
    }
    if (r.running) return 0;
    return r.code === 0 || r.code === null ? 0 : 1;
  },
});
