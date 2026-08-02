// WP10 should-fix-now #9 (AP-4, HIGH) — defense-in-depth proof for bin.mjs's own
// process.on('uncaughtException'/'unhandledRejection') handlers, isolated from static.mjs's own
// (already separately tested) decodeURIComponent guard.
//
// This spawns a REAL, standalone child Node process whose handler registration is an intentional
// line-for-line mirror of bin.mjs's own (see bin.mjs's header comment for the original) — not the
// real gateway on the real port 4100 (avoids any port conflict with a concurrently-running real
// dashboard instance; also avoids needing static.mjs's own fix to already be in place, which is the
// whole point: this proves BIN.MJS'S layer holds even when a request handler throws for some other,
// unforeseen reason).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const FIXTURE_SCRIPT = `
const http = require('http');
process.on('uncaughtException', (err) => {
  console.error('MIRROR-UNCAUGHT: ' + (err && err.message ? err.message : String(err)));
});
process.on('unhandledRejection', (reason) => {
  console.error('MIRROR-REJECTION: ' + String(reason));
});
const server = http.createServer((req, res) => {
  if (req.url === '/throw') { throw new Error('synthetic unforeseen throw'); }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});
server.listen(0, '127.0.0.1', () => { console.log('LISTENING:' + server.address().port); });
`;

function httpGet(port, urlPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ok: true, statusCode: res.statusCode, body }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, timedOut: true }); });
    req.end();
  });
}

test('bin.mjs-pattern uncaughtException handler: a synchronous throw in one request never kills the process, and later requests still succeed', async () => {
  const child = spawn(process.execPath, ['-e', FIXTURE_SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

  try {
    const port = await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const m = stdout.match(/LISTENING:(\d+)/);
        if (m) { clearInterval(timer); resolve(Number(m[1])); }
        else if (Date.now() - started > 5000) { clearInterval(timer); reject(new Error('fixture server never reported LISTENING; stderr=' + stderr)); }
      }, 20);
    });

    // Hitting /throw must NOT get a normal 200 (the response is genuinely never written) — but it
    // must also not crash the child. The real proof is the NEXT request.
    const throwResult = await httpGet(port, '/throw');
    assert.notEqual(throwResult.ok && throwResult.statusCode, 200, '/throw must not silently succeed with 200');

    // Give the process-level handler and the surviving event loop a moment, then prove the SAME
    // child process still answers a normal request — this is the actual AP-4 regression this WP
    // fixes: without the handler, the whole process would already be dead here.
    const okResult = await httpGet(port, '/ok');
    assert.equal(okResult.ok, true, 'the child process must still be alive and accepting connections');
    assert.equal(okResult.statusCode, 200);
    assert.equal(okResult.body, 'ok');

    assert.match(stderr, /MIRROR-UNCAUGHT: synthetic unforeseen throw/, 'the uncaughtException handler must have actually fired and logged');
    assert.equal(child.exitCode, null, 'the child process must not have exited');
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1000);
    });
  }
});
