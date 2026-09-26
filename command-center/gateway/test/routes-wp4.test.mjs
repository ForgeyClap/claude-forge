// HTTP-level integration tests for the WP4 conversation routes, against a real instance of the
// gateway bound to an ephemeral port. ALWAYS in mock execution mode (CC_EXEC_MOCK=1) — no real
// `claude` invocation happens in this file.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT, SYNC_SCAN_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import { listProjects } from '../src/projects.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';
import { EXEC_TOKEN_HEADER, getExecToken } from '../src/security.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);

let server;
let port;
let tempDir;

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-wp4-test-'));
  _setConversationsDirForTests(tempDir);
  _resetProjectsCacheForTests();
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  delete process.env.CC_EXEC_MOCK;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  _resetConversationsForTests();
  // See exec-bridge.test.mjs's after() for why retries are needed here (Windows handle-release lag
  // right after a killed child process).
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  _resetExecBridgeForTests();
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
});

function requestStream(urlPath, { headers = {}, readMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      const timer = setTimeout(() => { req.destroy(); resolve({ statusCode: res.statusCode, headers: res.headers, body }); }, readMs);
      res.on('end', () => { clearTimeout(timer); resolve({ statusCode: res.statusCode, headers: res.headers, body }); });
    });
    req.on('error', () => resolve({ statusCode: null, headers: {}, body: '', aborted: true }));
    req.end();
  });
}

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test('GET /api/conversations returns an empty real list + a truthful execution capability before any conversation exists', async () => {
  const res = await request(port, '/api/conversations');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.conversations, []);
  assert.equal(res.json.execution.available, true);
  assert.match(res.json.execution.note, /mock execution mode/);
});

test('POST /api/conversations creates a real conversation for a real registry project', async () => {
  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME, title: 'wp4 test thread' } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.ok, true);
  assert.match(res.json.conversation.id, /^[A-Za-z0-9-]+$/);
  assert.equal(res.json.conversation.project, THIS_PROJECT_NAME);

  const list = await request(port, '/api/conversations');
  assert.ok(list.json.conversations.some((c) => c.id === res.json.conversation.id));
});

// N6 fix (WP-C1, 2026-09-26 laptop re-audit): POST /api/conversations had NO exec-token check at
// all before this fix — a real, non-browser local process could create a real conversation with
// no auth (audit: "POST /api/conversations no token -> 201 created"). GET stays the control: reads
// never required the token and still don't.
test('N6 AUTH: POST /api/conversations with NO exec token is rejected with 403, and nothing is created', async () => {
  const before = await request(port, '/api/conversations');
  const beforeCount = before.json.conversations.length;

  const res = await requestWithBody(port, '/api/conversations', {
    jsonBody: { project: THIS_PROJECT_NAME },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /execution token/);

  const after = await request(port, '/api/conversations');
  assert.equal(after.json.conversations.length, beforeCount, 'a rejected create must never persist a conversation');
});

test('N6 CONTROL: GET /api/conversations with NO exec token still succeeds (reads never required it)', async () => {
  const res = await requestWithBody(port, '/api/conversations', { method: 'GET', omitExecToken: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
});

test('N6 AUTH: POST /api/conversations with the REAL exec token succeeds', async () => {
  const res = await requestWithBody(port, '/api/conversations', {
    jsonBody: { project: THIS_PROJECT_NAME },
    omitExecToken: true,
    headers: { [EXEC_TOKEN_HEADER]: getExecToken() },
  });
  assert.equal(res.statusCode, 201);
});

// N6 fix: POST .../stop had NO exec-token check at all before this fix (audit: "POST
// /api/conversations/<x>/stop no token -> 404 (not gated)" — a real local process could probe/stop
// executions with no auth at all).
test('N6 AUTH: POST /api/conversations/:id/stop with NO exec token is rejected with 403', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/stop', {
    jsonBody: {},
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json.error, /execution token/);
});

test('N6 AUTH: POST /api/conversations/:id/stop with the REAL exec token succeeds', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/stop', {
    jsonBody: {},
    omitExecToken: true,
    headers: { [EXEC_TOKEN_HEADER]: getExecToken() },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
});

// fix-conv-filter REGRESSION (forge-2026-07-29-cc-finish): GET /api/conversations?project=<name>
// used to be read by no code at all — every caller got every conversation across every project
// (live-measured before this fix: three different ?project= query values returned byte-identical
// rows spanning four different projects).
/**
 * A DISCOVERABLE fixture project, so the cross-project test never silently skips.
 *
 * Lead hardening (2026-07-30): the first version of the test below looked for a second REAL
 * registered project on the machine and `t.skip()`-ed when it found none. That is the same
 * false-assurance shape this run has already fixed twice (a test that passed only because a
 * file happened to exist on this machine; a test that passed against a stale build): a skip
 * reads as green while the isolation assertion — the whole point — never ran. Nothing tells you
 * afterwards that it didn't.
 *
 * So the second project is CREATED here instead, using the same mechanism the registry really
 * discovers projects by (a `.claude/forge-dashboard` marker directory under the scan root — the
 * exact pattern `recovery-redaction.test.mjs` already uses for its own fixtures), and the
 * projects cache is reset so the fresh scan sees it. Deterministic on any machine, including a
 * clean clone with no other Forge project at all.
 */
function makeFixtureProject() {
  const root = fs.mkdtempSync(path.join(SYNC_SCAN_ROOT, 'cc-convfilter-fixture-'));
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# fixture project for cross-project isolation tests\n', 'utf8');
  _resetProjectsCacheForTests();
  return root;
}

test('PROJECT FILTER: GET /api/conversations?project=<name> returns ONLY that project\'s conversations', async () => {
  const fixtureRoot = makeFixtureProject();
  const fixtureName = path.basename(fixtureRoot);
  let other;
  try {
    const registry = await listProjects();
    other = registry.ok ? registry.projects.find((p) => p.name === fixtureName) : null;
    assert.ok(
      other,
      'the fixture project must be discoverable by the real registry scan — if this fails the marker ' +
        'convention changed, and this test must be updated rather than skipped',
    );

    const convA = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME, title: 'project-a-thread' } });
    const convB = await requestWithBody(port, '/api/conversations', { jsonBody: { project: other.name, title: 'project-b-thread' } });
    assert.equal(convA.statusCode, 201);
    assert.equal(convB.statusCode, 201);

    const filteredA = await request(port, '/api/conversations?project=' + encodeURIComponent(THIS_PROJECT_NAME));
    assert.equal(filteredA.statusCode, 200);
    assert.equal(filteredA.json.ok, true);
    assert.ok(filteredA.json.conversations.some((c) => c.id === convA.json.conversation.id));
    assert.ok(!filteredA.json.conversations.some((c) => c.id === convB.json.conversation.id), 'filtering by THIS project must never leak the other project\'s conversation');
    assert.ok(filteredA.json.conversations.every((c) => c.project === THIS_PROJECT_NAME), 'every returned row must actually belong to the requested project');

    const filteredB = await request(port, '/api/conversations?project=' + encodeURIComponent(other.name));
    assert.equal(filteredB.statusCode, 200);
    assert.ok(filteredB.json.conversations.some((c) => c.id === convB.json.conversation.id));
    assert.ok(!filteredB.json.conversations.some((c) => c.id === convA.json.conversation.id), 'filtering by the other project must never leak THIS project\'s conversation');
    assert.ok(filteredB.json.conversations.every((c) => c.project === other.name));

    const unfiltered = await request(port, '/api/conversations');
    assert.equal(unfiltered.statusCode, 200);
    assert.ok(unfiltered.json.conversations.some((c) => c.id === convA.json.conversation.id), 'no ?project= must still return everything, unchanged');
    assert.ok(unfiltered.json.conversations.some((c) => c.id === convB.json.conversation.id));
  } finally {
    // The fixture lives under the real scan root, so it must never be left behind.
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    _resetProjectsCacheForTests();
  }
});

test('PROJECT FILTER: GET /api/conversations?project=<unknown> is rejected by the same registry allowlist as the other ?project= routes (404)', async () => {
  const res = await request(port, '/api/conversations?project=totally-not-a-real-project');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /unknown project/);
});

test('POST /api/conversations with an unknown project is rejected by the allowlist (404)', async () => {
  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: 'totally-not-a-real-project' } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('SCHEMA: POST /api/conversations with an unknown field is rejected with 400', async () => {
  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME, evil: 'x' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /unknown field/);
});

test('SCHEMA: POST /api/conversations missing the required project field is rejected with 400', async () => {
  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { title: 'no project' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /missing required field/);
});

// REGRESSION (forge-2026-07-29-cc-finish, fix-newchat): the "New chat" button's real request body
// is `{ project, title: null }` (no title exists yet at creation time) — the schema check used to
// treat a present-but-null `title` as a type error identical to a number/object, so every "New
// chat" click failed with a real 400 ("title must be a string") and created nothing. `null` must
// behave exactly like an omitted field: both mean "no title supplied". A genuinely wrong type
// (number here) must still be rejected.
test('REGRESSION: POST /api/conversations with title omitted creates a real conversation (201)', async () => {
  const before = await request(port, '/api/conversations');
  const beforeCount = before.json.conversations.length;

  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.conversation.title, null);

  const after = await request(port, '/api/conversations');
  assert.equal(after.json.conversations.length, beforeCount + 1);
});

test('REGRESSION: POST /api/conversations with title:null is accepted (not 400) and creates a real conversation', async () => {
  const before = await request(port, '/api/conversations');
  const beforeCount = before.json.conversations.length;

  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME, title: null } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.conversation.title, null);

  const after = await request(port, '/api/conversations');
  assert.equal(after.json.conversations.length, beforeCount + 1);
});

test('REGRESSION: POST /api/conversations with title:123 (wrong type) is still rejected with 400', async () => {
  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME, title: 123 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /title must be a string/);
});

test('LIMIT: a request body over 64KB is rejected with 413, never buffered in full', async () => {
  const huge = 'x'.repeat(70 * 1024);
  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME, title: huge } });
  assert.equal(res.statusCode, 413);
});

test('GET /api/conversations/:id returns the full real conversation', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const res = await request(port, '/api/conversations/' + created.json.conversation.id);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.meta.project, THIS_PROJECT_NAME);
  assert.deepEqual(res.json.turns, []);
});

test('GET /api/conversations/:id for an unknown id is a real 404, not a crash', async () => {
  const res = await request(port, '/api/conversations/c-does-not-exist');
  assert.equal(res.statusCode, 404);
});

test('SECURITY: GET /api/conversations/:id with a traversal-shaped id never reaches the filesystem', async () => {
  const res = await request(port, '/api/conversations/' + encodeURIComponent('..%2Fescape'));
  assert.equal(res.statusCode, 400);
});

test('POST /api/conversations/:id/messages starts a real mock execution and eventually stores a real assistant turn', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;

  const sendRes = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'hello mock' } });
  assert.equal(sendRes.statusCode, 202);
  assert.equal(sendRes.json.ok, true);
  assert.equal(sendRes.json.execution_started, true);
  assert.ok(sendRes.json.turn_id);

  const done = await waitUntil(async () => {
    const r = await request(port, '/api/conversations/' + convId);
    return r.json.turns.some((t) => t.role === 'assistant');
  });
  assert.ok(done);
  const finalConv = await request(port, '/api/conversations/' + convId);
  const assistantTurn = finalConv.json.turns.find((t) => t.role === 'assistant');
  assert.equal(assistantTurn.text, 'MOCK:hello mock');
});

test('DUPLICATE-SEND: a second message while one is still pending is rejected with 409', async () => {
  process.env.CC_EXEC_MOCK_DELAY_MS = '400';
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;

  const first = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'one' } });
  assert.equal(first.statusCode, 202);
  const second = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'two' } });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json.ok, false);

  await requestWithBody(port, '/api/conversations/' + convId + '/stop', {});
});

test('SCHEMA: POST /messages with a non-string text field is rejected with 400', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const res = await requestWithBody(port, '/api/conversations/' + created.json.conversation.id + '/messages', { jsonBody: { text: 12345 } });
  assert.equal(res.statusCode, 400);
});

test('POST /messages against an unknown conversation id is a real 404', async () => {
  const res = await requestWithBody(port, '/api/conversations/c-does-not-exist/messages', { jsonBody: { text: 'x' } });
  assert.equal(res.statusCode, 404);
});

// cc-fix-chat-identity: title auto-derivation, end-to-end through the real routes.
test('TITLE: the first real message on a titleless conversation derives a real title, visible via GET', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'help me plan the release' } });

  const res = await request(port, '/api/conversations/' + convId);
  assert.equal(res.json.meta.title, 'help me plan the release');

  const list = await request(port, '/api/conversations');
  const row = list.json.conversations.find((c) => c.id === convId);
  assert.equal(row.title, 'help me plan the release');
});

// cc-fix-chat-identity: optional plan-first mode (`--permission-mode plan`), allowlisted at the route.
test('MODE: POST /messages with mode:"plan" is accepted and stored on the turn-meta', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'plan mode please', mode: 'plan' } });
  assert.equal(res.statusCode, 202);

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.mode, 'plan');
});

test('MODE: POST /messages with an unknown mode value is rejected with 400', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'x', mode: 'nonsense' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /mode must be one of/);
});

test('MODE: POST /messages with no mode defaults to "execute" on the turn-meta', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'default mode' } });

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.mode, 'execute');
});

// fix-exec-modes: the two NEW real modes ('accept-edits' -> --permission-mode acceptEdits,
// 'bypass' -> --permission-mode bypassPermissions) are accepted and stored exactly like 'plan'.
test('MODE: POST /messages with mode:"accept-edits" is accepted and stored on the turn-meta', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'accept edits please', mode: 'accept-edits' } });
  assert.equal(res.statusCode, 202);

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.mode, 'accept-edits');
});

test('MODE: POST /messages with mode:"bypass" is accepted and stored on the turn-meta', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'bypass please', mode: 'bypass' } });
  assert.equal(res.statusCode, 202);

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.mode, 'bypass');
});

// fix-exec-modes: optional `effort` field, same allowlist-or-400 pattern as `mode`.
test('EFFORT: POST /messages with effort:"high" is accepted and stored on the turn-meta', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'go big', mode: 'bypass', effort: 'high' } });
  assert.equal(res.statusCode, 202);

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.effort, 'high');
  assert.equal(userTurn.mode, 'bypass');
});

test('EFFORT: POST /messages with an unknown effort value is rejected with 400', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'x', effort: 'ludicrous' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /effort must be one of/);
});

test('EFFORT: POST /messages with no effort field stores effort:null on the turn-meta (no flag guessed)', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'no effort given' } });

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.effort, null);
});

// feat-model-picker: optional `model` field, same allowlist-or-400 pattern as `mode`/`effort`.
test('MODEL: POST /messages with a real full model id is accepted and stored on the turn-meta', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'use fable please', mode: 'bypass', model: 'claude-fable-5' } });
  assert.equal(res.statusCode, 202);

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.model, 'claude-fable-5');
  assert.equal(userTurn.mode, 'bypass');
});

test('MODEL: POST /messages with a real short alias ("opus") is accepted and stored on the turn-meta', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'use opus alias', model: 'opus' } });
  assert.equal(res.statusCode, 202);

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.model, 'opus');
});

// feat-model-picker: "haiku" was verified 2026-07-30 via a real (non-mock) CLI run (see server.mjs's
// own EXEC_MODEL_VALUES comment) — not present in the original `--help` examples, but real anyway.
test('MODEL: POST /messages with the real short alias "haiku" (verified via a real CLI run, not from --help) is accepted', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'use haiku alias', model: 'haiku' } });
  assert.equal(res.statusCode, 202);

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.model, 'haiku');
});

test('MODEL: POST /messages with an unknown model value is rejected with 400', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'x', model: 'gpt-5' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /model must be one of/);
});

// feat-model-picker CORRECTION (2026-07-30): the "[1m]" context-window suffix was originally
// rejected here on the theory that `--help` text gave no evidence it was valid INPUT — real
// (non-mock) CLI runs now prove it IS accepted, on both the full id and the short alias (see
// server.mjs's own EXEC_MODEL_VALUES comment for the exact commands/exit codes). This is now a
// real 202 acceptance test, the inverse of what it originally asserted.
test('MODEL: POST /messages with the real, CLI-verified "[1m]" context-window suffix (full id) is accepted and stored on the turn-meta', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'opus with 1m context please', model: 'claude-opus-5[1m]' } });
  assert.equal(res.statusCode, 202);

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.model, 'claude-opus-5[1m]');
});

test('MODEL: POST /messages with the real, CLI-verified "[1m]" suffix on the SHORT ALIAS ("opus[1m]") is accepted', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'opus alias with 1m context please', model: 'opus[1m]' } });
  assert.equal(res.statusCode, 202);

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.model, 'opus[1m]');
});

// feat-model-picker: the allowlist stays an EXACT-MATCH array, not a permissive "any bracket
// suffix" pattern — a bracket suffix never observed on ANY other model (input OR output) is still
// a real 400, proving the fix above did not silently widen into a regex-like acceptance.
test('MODEL: POST /messages with an UNVERIFIED bracket-suffixed value on a different model is still rejected with 400', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'x', model: 'claude-fable-5[1m]' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /model must be one of/);
});

test('MODEL: POST /messages with no model field stores model:null on the turn-meta (no flag guessed)', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'no model given' } });

  const full = await request(port, '/api/conversations/' + convId);
  const userTurn = full.json.turns.find((t) => t.role === 'user');
  assert.equal(userTurn.model, null);
});

// fix-sec-round #1 (HIGH) / N6 fix (WP-C1): POST /messages requires the real per-boot exec token
// for EVERY mode, including 'plan' (the previous 'plan'-mode exemption was removed — see
// server.mjs's own requestListener comment for why: the user's turn is always persisted first,
// regardless of mode, so there was never a mode that genuinely needed to skip this check). Every
// OTHER test in this file passes via `requestWithBody`'s new default (see test-support/helpers.mjs)
// — these tests exercise the guard itself directly.
test('AUTH: POST /messages with the default "execute" mode and NO exec token is rejected with 403', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', {
    jsonBody: { text: 'no token' },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /execution token/);
});

test('AUTH: POST /messages with mode:"bypass" and a WRONG exec token is rejected with 403 (not merely a missing one)', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', {
    jsonBody: { text: 'bypass please', mode: 'bypass' },
    omitExecToken: true,
    headers: { [EXEC_TOKEN_HEADER]: 'definitely-not-the-real-token' },
  });
  assert.equal(res.statusCode, 403);
});

test('AUTH: POST /messages with mode:"accept-edits" and NO exec token is rejected with 403', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', {
    jsonBody: { text: 'accept edits please', mode: 'accept-edits' },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
});

// N6 fix (WP-C1): 'plan' mode used to be exempt from the exec-token check — it no longer is,
// because appendUserTurn() persists the user's turn to the conversation store for EVERY mode
// (including 'plan') before execution even starts, which is itself a real write.
test('AUTH: POST /messages with mode:"plan" and NO exec token is rejected with 403 (the old plan exemption is gone)', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', {
    jsonBody: { text: 'plan mode please', mode: 'plan' },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json.error, /execution token/);
});

test('AUTH: POST /messages with mode:"plan" and the REAL exec token succeeds', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', {
    jsonBody: { text: 'plan mode please', mode: 'plan' },
    omitExecToken: true,
    headers: { [EXEC_TOKEN_HEADER]: getExecToken() },
  });
  assert.equal(res.statusCode, 202);
});

test('AUTH: POST /messages with the REAL current-boot token succeeds for "bypass"', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', {
    jsonBody: { text: 'bypass with a real token', mode: 'bypass' },
    omitExecToken: true,
    headers: { [EXEC_TOKEN_HEADER]: getExecToken() },
  });
  assert.equal(res.statusCode, 202);
});

// fix-sec-round #4 (LOW): a leading '-' in the message text is refused before it ever reaches
// exec-bridge.mjs's argv builder.
test('SECURITY: POST /messages with text starting with "-" is rejected with 400', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', {
    jsonBody: { text: '--dangerously-skip-permissions' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /cannot start with "-"/);
});

test('SECURITY: POST /messages with leading whitespace then "-" is still rejected (trimmed before the check)', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  const res = await requestWithBody(port, '/api/conversations/' + convId + '/messages', {
    jsonBody: { text: '   -x' },
  });
  assert.equal(res.statusCode, 400);
});

test('STOP: kills a still-running mock child and reports stopped:true, and frees the conversation to accept a new message', async () => {
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'stop me' } });

  const stopRes = await requestWithBody(port, '/api/conversations/' + convId + '/stop', {});
  assert.equal(stopRes.statusCode, 200);
  assert.equal(stopRes.json.stopped, true);

  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  const secondSend = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'after stop' } });
  assert.equal(secondSend.statusCode, 202, 'the conversation must no longer be considered busy after a stop');
});

test('STOP on a conversation with nothing running is an honest no-op (stopped:false)', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const res = await requestWithBody(port, '/api/conversations/' + created.json.conversation.id + '/stop', {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.stopped, false);
});

test('GET /api/conversations/:id/stream connects and replays the real backlog as SSE frames', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME, title: 'sse-thread' } });
  const res = await requestStream('/api/conversations/' + created.json.conversation.id + '/stream');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(res.body, /"conversation_id":"/);
  assert.match(res.body, /"title":"sse-thread"/);
});

test('SECURITY: GET /api/conversations/:id/stream for an unknown conversation is rejected with 404 JSON, never upgraded to SSE', async () => {
  const res = await requestStream('/api/conversations/c-does-not-exist/stream');
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(String(res.headers['content-type'] || ''), /text\/event-stream/);
});

test('non-GET/POST methods on conversation routes are rejected with 405', async () => {
  const res = await request(port, '/api/conversations', { method: 'DELETE' });
  assert.equal(res.statusCode, 405);
});

// feat-delete-conversation: DELETE /api/conversations/:id — the real "Delete conversation" route.
test('DELETE /api/conversations/:id removes the real conversation and it is gone from both GET routes', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;

  const del = await requestWithBody(port, '/api/conversations/' + convId, { method: 'DELETE' });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json.ok, true);
  assert.equal(del.json.deleted, true);
  assert.equal(del.json.id, convId);

  const afterGet = await request(port, '/api/conversations/' + convId);
  assert.equal(afterGet.statusCode, 404);

  const list = await request(port, '/api/conversations');
  assert.ok(!list.json.conversations.some((c) => c.id === convId));
});

test('DELETE /api/conversations/:id for an unknown id is a real 404', async () => {
  const res = await requestWithBody(port, '/api/conversations/c-does-not-exist', { method: 'DELETE' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('SECURITY: DELETE /api/conversations/:id with a traversal-shaped id never reaches the filesystem (400)', async () => {
  const res = await requestWithBody(port, '/api/conversations/' + encodeURIComponent('..%2Fescape'), { method: 'DELETE' });
  assert.equal(res.statusCode, 400);
});

test('AUTH: DELETE /api/conversations/:id with NO exec token is rejected with 403, and the conversation survives', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;

  const res = await requestWithBody(port, '/api/conversations/' + convId, { method: 'DELETE', omitExecToken: true });
  assert.equal(res.statusCode, 403);
  assert.match(res.json.error, /execution token/);

  const still = await request(port, '/api/conversations/' + convId);
  assert.equal(still.statusCode, 200, 'a rejected delete must never touch the real file');
});

test('AUTH: DELETE /api/conversations/:id with a WRONG exec token is rejected with 403 (not merely a missing one)', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;

  const res = await requestWithBody(port, '/api/conversations/' + convId, {
    method: 'DELETE',
    omitExecToken: true,
    headers: { [EXEC_TOKEN_HEADER]: 'definitely-not-the-real-token' },
  });
  assert.equal(res.statusCode, 403);
});

test('AUTH: DELETE /api/conversations/:id with the REAL current-boot token succeeds', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;

  const res = await requestWithBody(port, '/api/conversations/' + convId, {
    method: 'DELETE',
    omitExecToken: true,
    headers: { [EXEC_TOKEN_HEADER]: getExecToken() },
  });
  assert.equal(res.statusCode, 200);
});

test('BUSY: DELETE /api/conversations/:id while an execution is pending is rejected with 409, and the file survives', async () => {
  process.env.CC_EXEC_MOCK_DELAY_MS = '400';
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const convId = created.json.conversation.id;
  await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'busy please' } });

  const del = await requestWithBody(port, '/api/conversations/' + convId, { method: 'DELETE' });
  assert.equal(del.statusCode, 409);
  assert.equal(del.json.ok, false);

  const still = await request(port, '/api/conversations/' + convId);
  assert.equal(still.statusCode, 200, 'must never be deleted mid-execution');

  await requestWithBody(port, '/api/conversations/' + convId + '/stop', {});
});

test('non-GET/POST/DELETE methods on the :id route are still rejected with 405 (e.g. PUT)', async () => {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  const res = await request(port, '/api/conversations/' + created.json.conversation.id, { method: 'PUT' });
  assert.equal(res.statusCode, 405);
});

test('every other route on the gateway remains read-only: POST /api/health is still 405', async () => {
  const res = await request(port, '/api/health', { method: 'POST' });
  assert.equal(res.statusCode, 405);
});
