// Real, non-mock tests for ask-mcp.mjs (feat-ask-owner, forge-2026-07-30-cc-finish) — spawns the
// ACTUAL script as its own child process (exactly how the `claude` CLI would spawn it via
// --mcp-config) and drives the real JSON-RPC-over-stdio handshake this project's own scratchpad
// proof established: initialize -> tools/list -> tools/call. The GATEWAY side is faked with a
// small local http.Server this file starts itself — that is the correct, honest test boundary,
// since ask-mcp.mjs's entire job is "talk HTTP to a gateway"; its own logic is what is under test
// here, not the real gateway (covered separately by routes-ask.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASK_MCP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ask-mcp.mjs');

/** A tiny fake gateway: records every request it receives and answers `/api/ask` however the
 *  test tells it to via `respondWith`. */
function startFakeGateway() {
  const received = [];
  let responder = (req, body) => ({ status: 200, body: { ok: true, timed_out: false, answers: [{ question: 'default', answer: 'default' }] } });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let parsedBody = null;
      try { parsedBody = JSON.parse(raw); } catch { /* recorded as null below */ }
      received.push({ method: req.method, url: req.url, headers: req.headers, body: parsedBody });
      const outcome = responder(req, parsedBody);
      res.writeHead(outcome.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(outcome.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: 'http://127.0.0.1:' + server.address().port,
        received,
        setResponder: (fn) => { responder = fn; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Spawns the real ask-mcp.mjs child and gives back a tiny JSON-RPC helper (send/nextMessage). */
function spawnAskMcp(env) {
  const child = spawn(process.execPath, [ASK_MCP_PATH], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lineQueue = [];
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (waiters.length > 0) waiters.shift()(msg);
      else lineQueue.push(msg);
    }
  });
  let stderrBuf = '';
  child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }
  function nextMessage(timeoutMs = 5000) {
    if (lineQueue.length > 0) return Promise.resolve(lineQueue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a message from ask-mcp.mjs; stderr so far: ' + stderrBuf)), timeoutMs);
      waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
    });
  }
  function stop() {
    child.stdin.end();
    child.kill();
  }
  return { send, nextMessage, stop, child };
}

let gateway;

before(async () => {
  gateway = await startFakeGateway();
});

after(async () => {
  await gateway.close();
});

test('HANDSHAKE: initialize -> tools/list returns exactly one tool, "ask_owner"', async () => {
  const mcp = spawnAskMcp({ CC_ASK_GATEWAY_ORIGIN: gateway.origin, CC_ASK_CONV_ID: 'c-1', CC_ASK_EXEC_TOKEN: 'tok' });
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const initResult = await mcp.nextMessage();
    assert.equal(initResult.id, 1);
    assert.equal(initResult.result.serverInfo.name, 'forge-ask');

    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const toolsResult = await mcp.nextMessage();
    assert.equal(toolsResult.id, 2);
    assert.equal(toolsResult.result.tools.length, 1);
    assert.equal(toolsResult.result.tools[0].name, 'ask_owner');
    assert.equal(toolsResult.result.tools[0].inputSchema.required[0], 'questions');
  } finally {
    mcp.stop();
  }
});

test('TOOLS/CALL: blocks on the real HTTP call to the (fake) gateway and resolves with the REAL answer once it responds', async () => {
  gateway.setResponder((req, body) => {
    assert.equal(body.conv_id, 'c-42');
    assert.equal(body.turn_id, 't-9');
    assert.deepEqual(body.questions, [{ question: 'Pick a color', options: ['red', 'blue'] }]);
    assert.equal(req.headers['x-cc-exec-token'], 'real-token-value');
    return { status: 200, body: { ok: true, timed_out: false, answers: [{ question: 'Pick a color', answer: 'blue' }] } };
  });

  const mcp = spawnAskMcp({
    CC_ASK_GATEWAY_ORIGIN: gateway.origin,
    CC_ASK_CONV_ID: 'c-42',
    CC_ASK_TURN_ID: 't-9',
    CC_ASK_EXEC_TOKEN: 'real-token-value',
  });
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await mcp.nextMessage();

    mcp.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ask_owner', arguments: { questions: [{ question: 'Pick a color', options: ['red', 'blue'] }] } },
    });
    const callResult = await mcp.nextMessage();
    assert.equal(callResult.id, 2);
    const text = callResult.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.answers, [{ question: 'Pick a color', answer: 'blue' }]);
    assert.notEqual(callResult.result.isError, true);
  } finally {
    mcp.stop();
  }

  assert.equal(gateway.received.length, 1);
  assert.equal(gateway.received[0].method, 'POST');
  assert.equal(gateway.received[0].url, '/api/ask');
});

test('TIMEOUT: a gateway response reporting timed_out:true is surfaced as an honest text result, never fabricating an answer', async () => {
  gateway.setResponder(() => ({ status: 200, body: { ok: true, timed_out: true, note: 'the owner did not answer within the time limit' } }));

  const mcp = spawnAskMcp({ CC_ASK_GATEWAY_ORIGIN: gateway.origin, CC_ASK_CONV_ID: 'c-1', CC_ASK_EXEC_TOKEN: 'tok' });
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_owner', arguments: { questions: [{ question: 'Anyone?' }] } } });
    const result = await mcp.nextMessage();
    const text = result.result.content[0].text;
    assert.match(text, /did not answer/);
    assert.doesNotMatch(text, /"answers"/, 'a timed-out call must never emit a fabricated answers payload');
  } finally {
    mcp.stop();
  }
});

test('GATEWAY FAILURE: a non-200/non-ok gateway response is surfaced as an honest error, never a silent hang or a fabricated answer', async () => {
  gateway.setResponder(() => ({ status: 500, body: { ok: false, error: 'internal gateway error' } }));

  const mcp = spawnAskMcp({ CC_ASK_GATEWAY_ORIGIN: gateway.origin, CC_ASK_CONV_ID: 'c-1', CC_ASK_EXEC_TOKEN: 'tok' });
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_owner', arguments: { questions: [{ question: 'Q' }] } } });
    const result = await mcp.nextMessage();
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /internal gateway error/);
  } finally {
    mcp.stop();
  }
});

test('VALIDATION: tools/call with no questions at all is an honest error, never a network call to the gateway', async () => {
  gateway.received.length = 0;
  const mcp = spawnAskMcp({ CC_ASK_GATEWAY_ORIGIN: gateway.origin, CC_ASK_CONV_ID: 'c-1', CC_ASK_EXEC_TOKEN: 'tok' });
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_owner', arguments: {} } });
    const result = await mcp.nextMessage();
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /no questions/);
  } finally {
    mcp.stop();
  }
  assert.equal(gateway.received.length, 0, 'an empty questions call must never reach the gateway at all');
});

test('UNREACHABLE GATEWAY: a connection failure (wrong port) is surfaced as an honest error, never a hang', async () => {
  const mcp = spawnAskMcp({ CC_ASK_GATEWAY_ORIGIN: 'http://127.0.0.1:1', CC_ASK_CONV_ID: 'c-1', CC_ASK_EXEC_TOKEN: 'tok' });
  try {
    mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await mcp.nextMessage();
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_owner', arguments: { questions: [{ question: 'Q' }] } } });
    const result = await mcp.nextMessage(10000);
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /Could not ask the owner/);
  } finally {
    mcp.stop();
  }
});
