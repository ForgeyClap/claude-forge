// Unit tests for the WP4 conversation store (conversations.mjs). Every test points the module at
// an isolated temp directory via _setConversationsDirForTests — never the real
// command-center/.data/conversations/.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  listConversations,
  readConversation,
  conversationExists,
  appendUserTurn,
  appendAssistantTurn,
  appendConversationEvent,
  deriveTitleFromText,
  deleteConversation,
  _setConversationsDirForTests,
  _resetConversationsForTests,
  _conversationsSummaryCacheSizeForTests,
} from '../src/conversations.mjs';

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-conversations-test-'));
  _setConversationsDirForTests(tempDir);
});

after(() => {
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test gets a clean directory so listConversations() counts are deterministic.
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
});

test('createConversation writes exactly one meta line and returns a real id matching the conv-id allowlist', () => {
  const conv = createConversation({ project: 'demo-project', title: 'My thread' });
  assert.match(conv.id, /^[A-Za-z0-9-]+$/);
  assert.equal(conv.project, 'demo-project');
  assert.equal(conv.title, 'My thread');
  assert.ok(conversationExists(conv.id));

  const raw = fs.readFileSync(path.join(tempDir, conv.id + '.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const meta = JSON.parse(lines[0]);
  assert.equal(meta.type, 'meta');
  assert.equal(meta.conversation_id, conv.id);
});

test('createConversation defaults a missing title to null, never an empty string', () => {
  const conv = createConversation({ project: 'demo-project' });
  assert.equal(conv.title, null);
});

test('appendUserTurn + appendAssistantTurn produce a real readable turn history in order', () => {
  const conv = createConversation({ project: 'demo-project' });
  const { turnId, requestId } = appendUserTurn(conv.id, 'hello there');
  appendAssistantTurn(conv.id, { turn_id: turnId, request_id: requestId, text: 'hi back', exit_code: 0 });

  const full = readConversation(conv.id);
  assert.equal(full.ok, true);
  assert.equal(full.turns.length, 2);
  assert.equal(full.turns[0].role, 'user');
  assert.equal(full.turns[0].text, 'hello there');
  assert.equal(full.turns[1].role, 'assistant');
  assert.equal(full.turns[1].text, 'hi back');
  assert.equal(full.turn_count, 2);
});

test('appendConversationEvent records are readable separately from turns', () => {
  const conv = createConversation({ project: 'demo-project' });
  const { turnId, requestId } = appendUserTurn(conv.id, 'go');
  appendConversationEvent(conv.id, { turn_id: turnId, request_id: requestId, kind: 'system', data: { subtype: 'init' } });

  const full = readConversation(conv.id);
  assert.equal(full.events.length, 1);
  assert.equal(full.events[0].kind, 'system');
  assert.equal(full.turns.length, 1); // the event must never be miscounted as a turn
});

test('readConversation on an unknown id returns an honest ok:false, never throws', () => {
  const result = readConversation('c-does-not-exist');
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

test('a malformed line in the store is skipped, never crashes the read (honest partial recovery)', () => {
  const conv = createConversation({ project: 'demo-project' });
  fs.appendFileSync(path.join(tempDir, conv.id + '.jsonl'), 'not-json-at-all\n', 'utf8');
  appendUserTurn(conv.id, 'still works');
  const full = readConversation(conv.id);
  assert.equal(full.ok, true);
  assert.equal(full.turns.length, 1);
});

test('listConversations returns id/title/project/updated_at/turn_count for every real conversation, most recent first', async () => {
  const a = createConversation({ project: 'proj-a', title: 'first' });
  await new Promise((r) => setTimeout(r, 5));
  const b = createConversation({ project: 'proj-b', title: 'second' });
  appendUserTurn(b.id, 'a message');

  const rows = listConversations();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, b.id); // most recently updated first
  const rowA = rows.find((r) => r.id === a.id);
  assert.equal(rowA.project, 'proj-a');
  assert.equal(rowA.turn_count, 0);
  const rowB = rows.find((r) => r.id === b.id);
  assert.equal(rowB.turn_count, 1);
});

test('SECURITY: a conv id containing traversal characters is rejected before touching the filesystem', () => {
  assert.equal(conversationExists('../../evil'), false);
  assert.equal(conversationExists('evil/../../etc'), false);
  const result = readConversation('..%2Fevil');
  assert.equal(result.ok, false);
});

test('SECURITY: appendUserTurn on an unsafe id throws rather than silently writing anywhere', () => {
  assert.throws(() => appendUserTurn('not/a/safe/id', 'x'));
});

// cc-fix-chat-identity: title derivation (server-side, on the FIRST real user turn).
test('TITLE: deriveTitleFromText normalizes whitespace/newlines and truncates ~48 chars at a word boundary', () => {
  assert.equal(deriveTitleFromText('  hello   world  '), 'hello world');
  assert.equal(deriveTitleFromText('line one\nline two\ttabbed'), 'line one line two tabbed');
  assert.equal(deriveTitleFromText(''), null);
  assert.equal(deriveTitleFromText('   '), null);
  assert.equal(deriveTitleFromText(null), null);
  assert.equal(deriveTitleFromText(undefined), null);

  const long = 'this is a genuinely long first message that definitely exceeds forty eight characters in total length';
  const title = deriveTitleFromText(long);
  assert.ok(title.length <= 48);
  assert.notEqual(title[title.length - 1], ' ');
  assert.ok(long.startsWith(title), 'the truncated title must be a real prefix of the original message');
  // it must have cut at a word boundary, not mid-word: the next char after the title in the
  // original (normalized) text must be a space.
  assert.equal(long[title.length], ' ');

  const noSpaces = 'x'.repeat(60);
  assert.equal(deriveTitleFromText(noSpaces), 'x'.repeat(48), 'a hard cut is the honest fallback when there is no word boundary at all');
});

test('TITLE: a real first user turn derives and persists a title on a conversation created without one', () => {
  const conv = createConversation({ project: 'demo-project' });
  assert.equal(conv.title, null);
  appendUserTurn(conv.id, 'plan the new onboarding flow please');

  const full = readConversation(conv.id);
  assert.equal(full.meta.title, 'plan the new onboarding flow please');

  const rows = listConversations();
  const row = rows.find((r) => r.id === conv.id);
  assert.equal(row.title, 'plan the new onboarding flow please');
});

test('TITLE: a second user turn never overwrites the title already derived from the first', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendUserTurn(conv.id, 'first message sets the title');
  appendUserTurn(conv.id, 'second message must not change it');

  const full = readConversation(conv.id);
  assert.equal(full.meta.title, 'first message sets the title');
});

test('TITLE: a conversation with no user turn yet keeps title null (never fabricated)', () => {
  const conv = createConversation({ project: 'demo-project' });
  const full = readConversation(conv.id);
  assert.equal(full.meta.title, null);

  const rows = listConversations();
  const row = rows.find((r) => r.id === conv.id);
  assert.equal(row.title, null);
});

test('TITLE: an explicit title supplied at creation is never overwritten by a later first user turn', () => {
  const conv = createConversation({ project: 'demo-project', title: 'My explicit title' });
  appendUserTurn(conv.id, 'this text must not become the title');
  const full = readConversation(conv.id);
  assert.equal(full.meta.title, 'My explicit title');
});

test('TITLE: lazy backfill derives+persists a title on read for a pre-existing titleless conversation with a user turn', () => {
  // Simulates a conversation written before this fix existed: a raw meta line with title:null and
  // a raw user-turn line, both appended directly (bypassing appendUserTurn's own live derivation).
  const conv = createConversation({ project: 'demo-project' });
  const rawPath = path.join(tempDir, conv.id + '.jsonl');
  fs.appendFileSync(rawPath, JSON.stringify({ type: 'turn', turn_id: 't-x', request_id: 'req-x', role: 'user', text: 'old conversation needs a real title', created_at: new Date().toISOString() }) + '\n', 'utf8');

  const full = readConversation(conv.id);
  assert.equal(full.meta.title, 'old conversation needs a real title');

  // The derivation must have been PERSISTED (a one-time meta_patch line), not just computed
  // in-memory: a fresh read of the raw file must show it without any further backfill event.
  const raw = fs.readFileSync(rawPath, 'utf8');
  const patchLines = raw.split('\n').filter((l) => l.includes('"meta_patch"'));
  assert.equal(patchLines.length, 1, 'the backfill must persist exactly one meta_patch line, not repeat on every read');

  // listConversations() must see the same persisted title too.
  const rows = listConversations();
  const row = rows.find((r) => r.id === conv.id);
  assert.equal(row.title, 'old conversation needs a real title');
});

// cc-fix-chat-identity: the plan/execute mode is stored on the turn record itself ("turn-meta").
test('MODE: appendUserTurn defaults to mode "execute" and stores an explicit "plan" mode on the turn', () => {
  const conv = createConversation({ project: 'demo-project' });
  const defaultTurn = appendUserTurn(conv.id, 'no mode passed');
  assert.equal(defaultTurn.record.mode, 'execute');

  const conv2 = createConversation({ project: 'demo-project' });
  const planTurn = appendUserTurn(conv2.id, 'plan this', { mode: 'plan' });
  assert.equal(planTurn.record.mode, 'plan');

  const full = readConversation(conv2.id);
  assert.equal(full.turns[0].mode, 'plan');
});

// fix-exec-modes: `effort` follows the exact same optional-field pattern as `mode` — defaults to
// null when not requested, stored verbatim when it is.
test('EFFORT: appendUserTurn defaults to effort null and stores an explicit effort value on the turn', () => {
  const conv = createConversation({ project: 'demo-project' });
  const defaultTurn = appendUserTurn(conv.id, 'no effort passed');
  assert.equal(defaultTurn.record.effort, null);

  const conv2 = createConversation({ project: 'demo-project' });
  const effortTurn = appendUserTurn(conv2.id, 'go hard', { mode: 'bypass', effort: 'xhigh' });
  assert.equal(effortTurn.record.effort, 'xhigh');
  assert.equal(effortTurn.record.mode, 'bypass');

  const full = readConversation(conv2.id);
  assert.equal(full.turns[0].effort, 'xhigh');
});

// feat-model-picker: `model` follows the exact same optional-field pattern as `mode`/`effort` —
// defaults to null when not requested, stored verbatim when it is. This is the REQUESTED model on
// the USER turn, distinct from the actually-run model exec-lifecycle.mjs writes onto the assistant
// turn's own `model` field.
test('MODEL: appendUserTurn defaults to model null and stores an explicit model value on the turn', () => {
  const conv = createConversation({ project: 'demo-project' });
  const defaultTurn = appendUserTurn(conv.id, 'no model passed');
  assert.equal(defaultTurn.record.model, null);

  const conv2 = createConversation({ project: 'demo-project' });
  const modelTurn = appendUserTurn(conv2.id, 'use opus please', { mode: 'bypass', effort: 'xhigh', model: 'claude-opus-5' });
  assert.equal(modelTurn.record.model, 'claude-opus-5');
  assert.equal(modelTurn.record.effort, 'xhigh');
  assert.equal(modelTurn.record.mode, 'bypass');

  const full = readConversation(conv2.id);
  assert.equal(full.turns[0].model, 'claude-opus-5');
});

// feat-delete-conversation: deleteConversation() unit coverage. The HTTP-level route (id
// validation order, exec token, busy check) is covered separately in gateway/test/routes-wp4.test.mjs
// — these tests exercise the store function's own contract directly.
test('DELETE: deleteConversation removes the real file and drops its stale summary-cache entry', () => {
  const conv = createConversation({ project: 'demo-project' });
  const filePath = path.join(tempDir, conv.id + '.jsonl');
  assert.ok(fs.existsSync(filePath));

  listConversations(); // populates SUMMARY_CACHE with a real entry for this conversation's path
  const before = _conversationsSummaryCacheSizeForTests();
  assert.ok(before >= 1);

  const result = deleteConversation(conv.id);
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(conversationExists(conv.id), false);

  const after = _conversationsSummaryCacheSizeForTests();
  assert.equal(after, before - 1, 'the cache entry for the deleted conversation must be dropped, not left stale');

  const rows = listConversations();
  assert.ok(!rows.some((r) => r.id === conv.id));
});

test('DELETE: deleteConversation on an unknown id returns an honest ok:false, never throws', () => {
  const result = deleteConversation('c-does-not-exist');
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

test('SECURITY: deleteConversation rejects a traversal-shaped id before ever touching the filesystem', () => {
  const result = deleteConversation('../../evil');
  assert.equal(result.ok, false);
  assert.match(result.error, /invalid/);

  const result2 = deleteConversation('evil/../../etc');
  assert.equal(result2.ok, false);
  assert.match(result2.error, /invalid/);
});
