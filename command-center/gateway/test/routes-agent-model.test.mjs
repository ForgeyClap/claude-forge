// feat-agent-model-edit: HTTP-level tests for PATCH /api/agents/:slug/model?project=<name>.
//
// Every scenario here is deliberately chosen so it NEVER reaches a real write — this suite must
// never mutate THIS project's own real .claude/config/agents/agent-model-map.json (that would be
// exactly the "mutate the real project config in a test" this work package forbids). The real
// SUCCESSFUL-write behavior (persists, re-readable, backup created, sibling fields byte-identical)
// is covered exhaustively against a temp fixture in agents-write.test.mjs instead — this suite only
// proves the HTTP layer's routing/auth/schema wiring: token gate, project/slug/value validation,
// and method registration. A before/after byte-identity guardrail on the real file proves the "never
// reaches a write" claim, not just asserts it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const REAL_MODEL_MAP_FILE = path.join(PROJECT_ROOT, '.claude', 'config', 'agents', 'agent-model-map.json');

let server;
let port;
let realFileBefore;

before(async () => {
  _resetProjectsCacheForTests();
  realFileBefore = fs.readFileSync(REAL_MODEL_MAP_FILE, 'utf8');
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  // The real guardrail: nothing in this whole suite ever wrote to the real project's config.
  assert.equal(fs.readFileSync(REAL_MODEL_MAP_FILE, 'utf8'), realFileBefore, 'the real agent-model-map.json must be byte-identical after this suite');
  await new Promise((resolve) => server.close(resolve));
});

function agentModelUrl(slug, project) {
  return '/api/agents/' + encodeURIComponent(slug) + '/model?project=' + encodeURIComponent(project);
}

test('PATCH without the exec token is rejected with 403, even with an otherwise-valid body', async () => {
  const res = await requestWithBody(port, agentModelUrl('boss', THIS_PROJECT_NAME), {
    method: 'PATCH',
    jsonBody: { claudeTier: 'opus' },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /execution token/);
});

// N6 fix (WP-C1, 2026-09-26 laptop re-audit): the exec token is now checked ONCE in
// requestListener, before ANY route runs — including before this route's own body/schema
// validation. These two tests used to prove "schema checked first"; they now prove the opposite
// (correctly: token beats schema, matching every other route on this gateway) — see the paired
// "...AND the real exec token" tests just below for proof the schema check still runs afterwards.
test('PATCH with an unknown field in the body and NO exec token is rejected with 403 (token is checked before schema now)', async () => {
  const res = await requestWithBody(port, agentModelUrl('boss', THIS_PROJECT_NAME), {
    method: 'PATCH',
    jsonBody: { nvidia: 'reasoning' },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json.error, /execution token/);
});

test('PATCH with an unknown field in the body AND the real exec token is rejected with 400 (schema still validated, after auth)', async () => {
  const res = await requestWithBody(port, agentModelUrl('boss', THIS_PROJECT_NAME), {
    method: 'PATCH',
    jsonBody: { nvidia: 'reasoning' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /unknown field/);
});

test('PATCH with an empty body and NO exec token is rejected with 403 (token is checked before schema now)', async () => {
  const res = await requestWithBody(port, agentModelUrl('boss', THIS_PROJECT_NAME), {
    method: 'PATCH',
    jsonBody: {},
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json.error, /execution token/);
});

test('PATCH with an empty body AND the real exec token is rejected with 400 (at least one of..., schema still validated after auth)', async () => {
  const res = await requestWithBody(port, agentModelUrl('boss', THIS_PROJECT_NAME), {
    method: 'PATCH',
    jsonBody: {},
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /at least one of/);
});

test('PATCH with a path-traversal-shaped slug (URL-encoded, so it reaches this route rather than being collapsed by URL normalization) is rejected with 400', async () => {
  // A literal `/api/agents/../model` is collapsed by URL parsing itself (well-known WHATWG dot-segment
  // removal) into `/api/model` before this route's regex ever sees it — a real, honest rejection, but
  // via the generic 405 method guard, not this route's own slug check. Encoding the slash (`%2F`) keeps
  // it as ONE path segment (matching AGENT_MODEL_RE's `[^/]+`) so decodeURIComponent + safeIdOk actually
  // run against a real `../../evil`-shaped value — this is the genuine defense-in-depth check.
  const res = await requestWithBody(port, '/api/agents/..%2F..%2Fevil/model?project=' + encodeURIComponent(THIS_PROJECT_NAME), {
    method: 'PATCH',
    jsonBody: { claudeTier: 'opus' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /invalid agent slug/);
});

test('a literal ".." slug segment never even reaches this route — URL dot-segment normalization collapses it first (honest 405, not a silent pass-through)', async () => {
  const res = await requestWithBody(port, agentModelUrl('..', THIS_PROJECT_NAME), {
    method: 'PATCH',
    jsonBody: { claudeTier: 'opus' },
  });
  assert.equal(res.statusCode, 405);
});

test('PATCH against an unknown project is rejected with 404', async () => {
  const res = await requestWithBody(port, agentModelUrl('boss', 'this-project-does-not-exist-xyz'), {
    method: 'PATCH',
    jsonBody: { claudeTier: 'opus' },
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json.error, /unknown project/);
});

test('PATCH against an unknown agent slug (real project) is rejected with 404, real file untouched', async () => {
  const res = await requestWithBody(port, agentModelUrl('totally-not-a-real-agent', THIS_PROJECT_NAME), {
    method: 'PATCH',
    jsonBody: { claudeTier: 'opus' },
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json.error, /unknown agent slug/);
});

test('PATCH with a value that is not a real value anywhere in the file is rejected with 400, real file untouched', async () => {
  const res = await requestWithBody(port, agentModelUrl('boss', THIS_PROJECT_NAME), {
    method: 'PATCH',
    jsonBody: { claudeTier: 'gpt-mega-9000' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /must be one of the real values/);
});

test('GET on the same path (wrong method) is still handled by the existing /api/agents GET route, not this PATCH route', async () => {
  const res = await request(port, '/api/agents?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
});

test('DELETE on the agent-model path is rejected with 405 (only PATCH is registered for this route)', async () => {
  const res = await request(port, agentModelUrl('boss', THIS_PROJECT_NAME), { method: 'DELETE' });
  assert.equal(res.statusCode, 405);
});
