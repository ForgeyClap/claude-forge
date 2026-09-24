// WP10 should-fix-now #12: unit tests for the new runtime redaction filter (redact.mjs), plus its
// application at the write/read boundaries named in the WP — conversations.mjs (turn text + the
// 4KB stderr, both on write and on read) and capabilities.mjs (a spawn-failure err.message).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, redactNullable, redactDeep, _secretPatternNamesForTests } from '../src/redact.mjs';
import {
  createConversation,
  appendUserTurn,
  appendAssistantTurn,
  readConversation,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import { buildCapabilities, _resetCapabilitiesCacheForTests, _setForgeCapabilitiesCjsForTests } from '../src/capabilities.mjs';

test('redact() strips all 5 real credential shapes and leaves ordinary text untouched', () => {
  const names = _secretPatternNamesForTests();
  assert.deepEqual(names, ['NVIDIA_API_KEY', 'GENERIC_SK_KEY', 'GITHUB_PAT', 'AWS_ACCESS_KEY_ID', 'PEM_PRIVATE_KEY']);

  assert.match(redact('key=nvapi-abcdefghij1234567890'), /\[REDACTED:NVIDIA_API_KEY\]/);
  assert.match(redact('token sk-abcdefghijklmnopqrstuvwx'), /\[REDACTED:GENERIC_SK_KEY\]/);
  assert.match(redact('pat ghp_abcdefghij1234567890'), /\[REDACTED:GITHUB_PAT\]/);
  assert.match(redact('id AKIA1234567890ABCD'), /\[REDACTED:AWS_ACCESS_KEY_ID\]/);
  assert.match(
    redact('-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----'),
    /\[REDACTED:PEM_PRIVATE_KEY\]/,
  );

  const plain = 'this is a perfectly ordinary sentence with no secrets in it at all';
  assert.equal(redact(plain), plain);
});

test('redact() is idempotent: redacting already-redacted text changes nothing further', () => {
  const once = redact('leaked nvapi-abcdefghij1234567890 here');
  const twice = redact(once);
  assert.equal(once, twice);
});

test('redact()/redactNullable() never throw on non-string input', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(42), 42);
  assert.equal(redactNullable(null), null);
  assert.equal(redactNullable(undefined), undefined);
});

test('redact() does not mangle a non-secret string that merely resembles one (word-boundary anchoring)', () => {
  const text = 'the run was routed to task-orchestrator for a normal review';
  assert.equal(redact(text), text);
});

test('redactDeep() walks nested objects/arrays and redacts every string, without dropping fields or changing types', () => {
  const input = {
    event_type: 'agent_note',
    note: 'leaked key nvapi-abcdefghij1234567890 right here',
    nested: {
      evidence: ['clean text', 'another leak sk-abcdefghijklmnopqrstuvwx end'],
      count: 3,
      flag: true,
      empty: null,
    },
  };
  const out = redactDeep(input);
  assert.deepEqual(Object.keys(out), Object.keys(input));
  assert.deepEqual(Object.keys(out.nested), Object.keys(input.nested));
  assert.equal(out.event_type, 'agent_note');
  assert.doesNotMatch(out.note, /nvapi-abcdefghij1234567890/);
  assert.match(out.note, /\[REDACTED:NVIDIA_API_KEY\]/);
  assert.equal(out.nested.evidence[0], 'clean text');
  assert.doesNotMatch(out.nested.evidence[1], /sk-abcdefghijklmnopqrstuvwx/);
  assert.match(out.nested.evidence[1], /\[REDACTED:GENERIC_SK_KEY\]/);
  assert.equal(out.nested.evidence.length, 2);
  assert.equal(out.nested.count, 3);
  assert.equal(out.nested.flag, true);
  assert.equal(out.nested.empty, null);
});

test('redactDeep() does not mangle a non-secret string nested inside an object (false-positive check)', () => {
  const input = { agent: 'task-orchestrator', note: 'dispatched to task-orchestrator for review' };
  assert.deepEqual(redactDeep(input), input);
});

test('redactDeep() passes primitives, arrays, and null/undefined through untouched', () => {
  assert.equal(redactDeep(42), 42);
  assert.equal(redactDeep(true), true);
  assert.equal(redactDeep(null), null);
  assert.equal(redactDeep(undefined), undefined);
  assert.deepEqual(redactDeep([1, 'clean', null]), [1, 'clean', null]);
});

let tempDir;
before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-redact-test-'));
  _setConversationsDirForTests(tempDir);
});
after(() => {
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('#12 SECURITY: a secret pasted into a user turn is redacted BEFORE it ever touches disk', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendUserTurn(conv.id, 'here is my key nvapi-abcdefghij1234567890 please use it');

  const raw = fs.readFileSync(path.join(tempDir, conv.id + '.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /nvapi-abcdefghij1234567890/, 'the raw on-disk file must never contain the real secret');
  assert.match(raw, /\[REDACTED:NVIDIA_API_KEY\]/);

  const full = readConversation(conv.id);
  assert.doesNotMatch(full.turns[0].text, /nvapi-abcdefghij1234567890/);
});

test('#12 SECURITY: an assistant turn\'s text AND stderr are both redacted on write', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendAssistantTurn(conv.id, {
    text: 'the answer contains ghp_abcdefghij1234567890 unfortunately',
    stderr: 'child stderr leaked AKIA1234567890ABCD by accident',
    exit_code: 0,
  });

  const raw = fs.readFileSync(path.join(tempDir, conv.id + '.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /ghp_abcdefghij1234567890/);
  assert.doesNotMatch(raw, /AKIA1234567890ABCD/);

  const full = readConversation(conv.id);
  const turn = full.turns[0];
  assert.match(turn.text, /\[REDACTED:GITHUB_PAT\]/);
  assert.match(turn.stderr, /\[REDACTED:AWS_ACCESS_KEY_ID\]/);
});

test('#12 SECURITY: read-side redaction also catches a record written before this fix existed (defense in depth)', () => {
  const conv = createConversation({ project: 'demo-project' });
  // Simulate a pre-fix record: appended directly, bypassing appendUserTurn's write-side redact().
  fs.appendFileSync(
    path.join(tempDir, conv.id + '.jsonl'),
    JSON.stringify({ type: 'turn', role: 'user', text: 'pre-existing leak sk-abcdefghijklmnopqrstuvwx', created_at: new Date().toISOString() }) + '\n',
    'utf8',
  );
  const full = readConversation(conv.id);
  const leaked = full.turns.find((t) => /GENERIC_SK_KEY/.test(t.text || ''));
  assert.ok(leaked, 'read-side redaction must catch a secret that reached disk before the write-side fix existed');
});

test('#12 SECURITY: a turn with no stderr field at all is unaffected (redaction never invents a field)', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendAssistantTurn(conv.id, { text: 'a perfectly normal reply', exit_code: 0 });
  const full = readConversation(conv.id);
  assert.equal('stderr' in full.turns[0], false);
});

test('#12 SECURITY: capabilities.mjs redacts a secret that leaks into a spawn-failure err.message', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-redact-capabilities-test-'));
  try {
    _resetCapabilitiesCacheForTests();
    const binDir = path.join(projectRoot, '.claude', 'forge-bin');
    fs.mkdirSync(binDir, { recursive: true });
    // SEC-PROJECT-CODE (2026-09-24): buildCapabilities() now ALWAYS runs the gateway's own CENTRAL
    // forge-capabilities.cjs against the selected project's DATA (via --root) — never a script that
    // happens to live inside the selected project's own .claude/forge-bin/. A tampered/failing script
    // planted there (as this fixture used to be, and as this control arm still proves) must therefore
    // never execute at all; see capabilities.test.mjs's own SEC-PROJECT-CODE sentinel test for the
    // direct "it never ran" proof. Redaction of the CENTRAL script's own failure path is proven below
    // via the test-only override seam instead — exactly the D.2 "child stdout/stderr unredacted in
    // responses" path the WP10 threat model named. Node's child_process error messages embed stderr
    // verbatim on a non-zero exit.
    fs.writeFileSync(
      path.join(binDir, 'forge-capabilities.cjs'),
      "console.error('leaked during failure: nvapi-abcdefghij1234567890'); process.exit(1);\n",
      'utf8',
    );
    const notExecuted = await buildCapabilities(projectRoot);
    assert.equal(notExecuted.available, true, 'the project-local script must never run — the central script answers instead: ' + notExecuted.note);

    _resetCapabilitiesCacheForTests();
    const fixture = path.join(projectRoot, 'fake-forge-capabilities.cjs');
    fs.writeFileSync(fixture, "console.error('leaked during failure: nvapi-abcdefghij1234567890'); process.exit(1);\n", 'utf8');
    _setForgeCapabilitiesCjsForTests(fixture);
    const result = await buildCapabilities(projectRoot);
    assert.equal(result.available, false);
    assert.doesNotMatch(result.note, /nvapi-abcdefghij1234567890/, 'the raw secret must never reach the response');
    assert.match(result.note, /\[REDACTED:NVIDIA_API_KEY\]/);
  } finally {
    _setForgeCapabilitiesCjsForTests(null);
    _resetCapabilitiesCacheForTests();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
