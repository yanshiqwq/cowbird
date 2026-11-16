const cfg = require('../lib/config');
const s = cfg.readToken(process.argv[2]);
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
