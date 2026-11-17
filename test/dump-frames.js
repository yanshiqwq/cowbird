// 调试用：拿某个实例的 E2B 访问凭据，直接打一次 envd 的 Process/Start，把原始帧打出来。
//   node test/dump-frames.js <实例 id>
// 凭据来自驱动自己的按实例缓存（~/.cowbird/tokens/<id>.json），全程不联网取 token。
const cache = require('../lib/platform/workbuddy/lib/token-cache');
const s = cache.readToken(process.argv[2]);
if (!s) {
  console.error('没有这个实例的凭据缓存：先跑一次 cowbird exec <实例> "true"');
  process.exit(1);
}
(async () => {
  const base = s.e2bDataEndpoint.replace(/\/$/, '');
  const payload = Buffer.from(JSON.stringify({ process: { cmd: '/bin/sh', args: ['-lc', 'echo hi; exit 3'], envs: {}, cwd: '/workspace' } }));
  const h = Buffer.alloc(5); h.writeUInt32BE(payload.length, 1);
  const r = await fetch(base + '/process.Process/Start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/connect+json', 'Connect-Protocol-Version': '1', 'X-Access-Token': s.token },
    body: Buffer.concat([h, payload]),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  console.log('http', r.status, 'bytes', buf.length);
  let off = 0;
  while (off + 5 <= buf.length) {
    const flag = buf[off];
    const len = buf.readUInt32BE(off + 1);
    const msg = buf.slice(off + 5, off + 5 + len).toString('utf8');
    off += 5 + len;
    console.log('frame flag=' + flag, msg.slice(0, 300));
  }
})();
