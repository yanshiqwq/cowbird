// cowbird adopt —— 把平台上的一个已有会话「收编」成沙箱会话
//
// 平台上的会话是用户自己的东西：你在网页里聊两句也是一个会话（WorkBuddy 上一个会话还配
// 一个容器）。cowbird 只认**登记过的**会话为沙箱，所以有两个办法让一个会话进入管理范围：
//   ① cowbird create <名字>      —— 从零建一个新的（天然是沙箱会话）
//   ② cowbird adopt <引用>       —— 把已经存在的会话收编（本命令）
// 收编只写本地登记簿（accounts/<账号>/sandboxes.json），**不动云端任何东西**：
// 会话还是那个会话，只是从此会被 `cowbird ls` 列出来、能当 exec / 保活的目标。
//
// 反过来 --release 只注销登记，也不删云端会话；真要删会话用 cowbird rm。
const { parse } = require('../lib/args');
const ui = require('../lib/ui');
const { pickTarget } = require('../lib/platform/target');
const sandboxes = require('../lib/platform/sandboxes');

async function run(argv) {
  const args = parse(argv, { flags: ['release', 'json'] });
  const refs = args._;
  if (!refs.length) throw new Error('用法: cowbird adopt [--release] <实例...>');
  const release = !!args.opts.release;

  const done = [];
  const failed = [];
  for (const ref of refs) {
    try {
      const { inst, ctx } = await pickTarget(ref);
      if (release) sandboxes.forget(ctx, inst.id);
      else sandboxes.record(ctx, inst, 'adopt');
      done.push({ id: String(inst.id), name: inst.name || '', channel: ctx.channel });
    } catch (e) {
      failed.push({ ref, error: String(e.message).split('\n')[0].slice(0, 160) });
    }
  }

  if (args.opts.json) {
    console.log(JSON.stringify({ action: release ? 'release' : 'adopt', done, failed }, null, 2));
    return failed.length ? 1 : 0;
  }

  for (const d of done) {
    console.log(ui.c.green(release ? '已注销' : '已收编') + `  ${d.name || ui.c.dim('(未命名)')}  id=${d.id}  ` + ui.c.dim(d.channel));
  }
  for (const f of failed) console.log(ui.c.red('失败 ') + `${f.ref}：${f.error}`);
  if (done.length && !release) {
    console.log(ui.c.dim('\n现在它算沙箱会话了：cowbird ls 能列出来，也可以直接 cowbird exec ' + (done[0].name || done[0].id) + ' "nproc"'));
  }
  if (done.length && release) {
    console.log(ui.c.dim('\n只是不再归本工具管（ls 默认不列）；云端会话没删。'));
  }
  return failed.length ? 1 : 0;
}

module.exports = {
  run,
  usage: 'adopt [--release] <实例...>',
  help: [
    '选项:',
    '  --release   反过来：注销登记（不删云端会话）',
    '  --json      输出 JSON',
    '',
    '说明:',
    '  `cowbird ls` 默认只列沙箱会话（本工具管的实例）。平台上已经存在的会话，',
    '  用 `cowbird ls --all` 找到 id（或短序号/名字），再 `cowbird adopt` 收编进来。',
    '  收编只写本地登记簿，不动云端；同一平台的不同账号各记各的。',
    '  `cowbird create` 建出来的会话会自动登记，不需要再 adopt。',
    '',
    '退出码:',
    '  0  全部成功（或全部已注销）',
    '  1  有引用解析不到 / 写登记簿失败',
  ],
};
