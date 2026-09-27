// Codex K3-3 (defense in depth) — startHealthServer() must never let a raw, token-shaped
// `loginError` reach GET /api/health or the BOT_STATUS.json heartbeat file on disk, even if a
// future getLoginError() implementation forgets to redact at the source itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { startHealthServer } from '../src/health-server.js';

// guardRequest() (local-guard.js) validates the incoming Host header against the CONFIGURED
// `botHttpPort`, not whatever port the server actually ended up listening on — so `botHttpPort: 0`
// (ask the OS to pick one) would compare a real client Host header against a bogus "port 0" allow
// list and always be refused with 403. A free port must be resolved up front instead.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, json: JSON.parse(body) });
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function fakeGateway() {
  return {
    transport: { connected: false },
    scheduler: { activeCount: () => 0 },
    queue: { depth: () => 0 },
    router: { projects: [] },
  };
}

test('GET /api/health and BOT_STATUS.json never carry a raw token-shaped loginError (Codex K3-3)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-health-server-test-'));
  const fakeToken = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'a'.repeat(30)].join('.');
  const port = await getFreePort();
  const health = startHealthServer({
    gateway: fakeGateway(),
    config: { stateDir, transport: 'discord', guildId: null, botHttpPort: port },
    runnerKind: 'fake',
    getPhase: () => 'login-failed',
    // Simulates a producer that forgot to redact at the source — the defense-in-depth layer here
    // must still catch it.
    getLoginError: () => 'Discord login failed: unexpected ' + fakeToken,
  });
  try {
    await health.listening;
    const res = await get(port, '/api/health');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.loginError.includes(fakeToken), false, 'the raw token must never reach the wire');
    assert.match(res.json.loginError, /\[REDACTED\]/);

    const onDisk = fs.readFileSync(path.join(stateDir, 'BOT_STATUS.json'), 'utf8');
    assert.equal(onDisk.includes(fakeToken), false, 'BOT_STATUS.json must never carry the raw token either');
    assert.match(onDisk, /\[REDACTED\]/);
  } finally {
    health.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('GET /api/health passes a null loginError through untouched (never invents a redaction marker)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-health-server-test-'));
  const port = await getFreePort();
  const health = startHealthServer({
    gateway: fakeGateway(),
    config: { stateDir, transport: 'discord', guildId: null, botHttpPort: port },
    runnerKind: 'fake',
    getLoginError: () => null,
  });
  try {
    await health.listening;
    const res = await get(port, '/api/health');
    assert.equal(res.json.loginError, null);
  } finally {
    health.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
