#!/usr/bin/env node
'use strict';
// ============================================================
// 半开连接的回归测试 —— 起本地假 ACP 服务端，实测五种"看起来还连着"的坏法。
//
//   node test/halfopen.js
//
// 为什么单独一个文件、不放进 smoke：这里要真起 TCP 服务、真等超时，一组下来 ~20 秒。
// smoke 必须保持"不联网、不等待"。
//
// 这些断言盯的都是同一类 bug：**socket 还在，但再也不来数据**。程序不报错、日志上
// conn=up，实际已经静默失效。这类回归没法靠纯函数测试覆盖，只能拿真 socket 打。
// ============================================================
const http = require('http');
const { Keepalive } = require('../lib/keepalive');

const QUESTION = {
  jsonrpc: '2.0', id: 7, method: '_codebuddy.ai/question',
  params: { schema: { questions: [{ header: '要不要继续？', options: [{ label: 'A' }, { label: 'B' }] }] } },
};

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.error('  \u2717 ' + name + (detail ? '  → ' + detail : '')); }
}

// 一个假 ACP 服务端。mode 决定它怎么坏。
function serve(mode) {
  const stats = { bootstraps: 0, posts: 0 };
  const srv = http.createServer((req, res) => {
    if (req.url === '/bootstrap') {
      stats.bootstraps++;
      if (mode === 'noheaders') return;                       // 永不发响应头
      res.writeHead(200, { 'content-type': 'text/event-stream', 'acp-connection-id': 'conn-' + stats.bootstraps });
      res.flushHeaders();
      if (mode === 'question') res.write(`data: ${JSON.stringify(QUESTION)}\n\n`);
      if (mode === 'close') { res.write(`data: ${JSON.stringify(QUESTION)}\n\n`); setTimeout(() => res.destroy(), 150); }
      return;                                                  // 其余模式：发完就静默
    }
    req.resume();
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(200); res.end(''); return; }
      stats.posts++;
      if (mode === 'postfail') { res.writeHead(500); res.end('boom'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, stats })));
}

async function run(mode, { sec, extra = {} }) {
  const { srv, stats } = await serve(mode);
  const kp = new Keepalive(
    { sessionId: 's1', token: 't', cwd: '/workspace', link: 'http://127.0.0.1:' + srv.address().port },
    {
      nudgeSec: 1, stallAfterNudgeSec: 2, connectTimeoutMs: 600, postTimeoutMs: 600,
      reconnectMs: 300, logEveryMs: 9e5, log: () => {},
      ...extra,
    }
  );
  await kp.start({ sec });
  try { srv.closeAllConnections?.(); } catch {}
  await new Promise((r) => srv.close(r));
  return { kp, stats };
}

(async () => {
  console.log('\n半开连接');

  // ① 服务端接了 TCP 却不发响应头 —— 没有 connectTimeout 时 fetch 会永远挂着
  {
    const { stats } = await run('noheaders', { sec: 4 });
    check('不发响应头时能超时并重试（而不是永远挂住）', stats.bootstraps >= 2, 'bootstrap=' + stats.bootstraps);
  }

  // ② 半开 + 空闲：催话后一个字节都不来，必须判死重连，而不是一直往死管道里催
  {
    const { kp, stats } = await run('silent', { sec: 6 });
    check('半开空闲：检测到静默后主动重连', stats.bootstraps >= 2, 'bootstrap=' + stats.bootstraps);
    check('半开空闲：判死发生在少数几次催话之内', kp.state.nudges <= 4, 'nudges=' + kp.state.nudges);
  }

  // ③ 半开 + 已挂提问：这是已知的检测盲区（那轮已经被钉住，保活目的已达到）。
  //    断言"不误判" —— 半开期间不该因为没事件而乱重连。
  {
    const { kp, stats } = await run('question', { sec: 4 });
    check('半开 + 挂起提问：不误判断线（已知盲区，见 README）', stats.bootstraps === 1, 'bootstrap=' + stats.bootstraps);
    check('半开 + 挂起提问：提问保持在挂起状态', kp.state.pending.size === 1, 'pending=' + kp.state.pending.size);
  }

  // ④ POST 被拒：要计失败、最终重连，且不能一秒一次地刷
  {
    const { kp, stats } = await run('postfail', { sec: 6 });
    check('POST 500：会计失败并最终重连', stats.bootstraps >= 2, 'bootstrap=' + stats.bootstraps);
    check('POST 500：重试频率被 nudgeSec 压住（6s 内不超过 8 次）', stats.posts <= 8, 'posts=' + stats.posts);
  }

  // ⑤ 对照组：真的断开 → 必须重连
  {
    const { stats } = await run('close', { sec: 3 });
    check('真断开：能重连', stats.bootstraps >= 2, 'bootstrap=' + stats.bootstraps);
  }

  console.log(`\n${fail ? '\u2717' : '\u2713'} ${pass} 通过${fail ? '，' + fail + ' 失败' : ''}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试自身出错：' + (e && e.stack)); process.exit(1); });
