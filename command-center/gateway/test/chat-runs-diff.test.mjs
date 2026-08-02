// feat-chatrun-diff: `chat-runs.mjs` used to project a real, already-captured file edit down to
// `{tool, file_path}` — `exec-stream-parse.mjs` captures `old_string`/`new_string` (Edit) and
// `content` (Write), capped at FILE_EDIT_FIELD_CAP_LEN, and `conversations.mjs` already redacts
// them on write AND on read, but `toFileEditRow()` threw the fields away one line later. The UI
// could therefore only ever say "not tracked" about a change this gateway genuinely had on disk.
//
// This file proves the widened projection end to end, using the SAME convention the existing
// `chat-runs.test.mjs` uses: every record is written through `conversations.mjs`'s own real
// production write path (never a hand-rolled fixture file) and read back through `listChatRuns()`.
//
// Four things are asserted here, in this order:
//   1. the real captured before/after text survives the projection (Edit and Write alike);
//   2. an edit that genuinely has NO recorded diff (an older run, written before the capture
//      existed) reads back as `diff_state:'none'` — never as an empty diff that would read as
//      "nothing changed";
//   3. the payload is BOUNDED: a per-response diff budget, and an edit past that budget is
//      reported honestly as `diff_state:'omitted_budget'` (with the real budget number) rather
//      than silently truncated or silently dropped;
//   4. SECURITY: a credential in `old_string`, in `new_string`, in `content`, or in the FILE PATH
//      never reaches the payload `listChatRuns()` returns — proven by executing the real
//      redaction layer, not by assuming it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  appendUserTurn,
  appendAssistantTurn,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import { listChatRuns, _CHAT_RUN_DIFF_BUDGET_CHARS_FOR_TESTS } from '../src/chat-runs.mjs';

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-runs-diff-test-'));
  _setConversationsDirForTests(tempDir);
});

after(() => {
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function completedRun(project, prompt, fileEdits) {
  const conv = createConversation({ project });
  const { turnId, requestId } = appendUserTurn(conv.id, prompt);
  appendAssistantTurn(conv.id, {
    turn_id: turnId,
    request_id: requestId,
    text: 'done',
    stop_reason: 'end_turn',
    exit_code: 0,
    file_edits: fileEdits,
  });
  return conv;
}

test("an Edit's real old_string/new_string survive the projection (this is what the UI shows as a diff)", () => {
  completedRun('diff-project-edit', 'Change the heading colour', [
    { tool: 'Edit', file_path: '/proj/site.css', old_string: 'color: red;', new_string: 'color: rebeccapurple;' },
  ]);

  const [run] = listChatRuns('diff-project-edit');
  assert.equal(run.file_edits.length, 1);
  assert.deepEqual(run.file_edits[0], {
    tool: 'Edit',
    file_path: '/proj/site.css',
    old_string: 'color: red;',
    new_string: 'color: rebeccapurple;',
    content: null,
    diff_state: 'present',
  });
});

test("a Write's real content survives the projection (a Write has no 'before', only what it wrote)", () => {
  completedRun('diff-project-write', 'Write the notes file', [
    { tool: 'Write', file_path: '/proj/NOTES.md', content: '# Notes\nfirst line\n' },
  ]);

  const [run] = listChatRuns('diff-project-write');
  assert.deepEqual(run.file_edits[0], {
    tool: 'Write',
    file_path: '/proj/NOTES.md',
    old_string: null,
    new_string: null,
    content: '# Notes\nfirst line\n',
    diff_state: 'present',
  });
});

test('HONESTY: an older edit with no recorded before/after text reads back diff_state:"none", never an empty diff', () => {
  // Exactly the shape a run recorded BEFORE the capture existed has on disk: tool + path only.
  completedRun('diff-project-legacy', 'An older run from before diffs were captured', [
    { tool: 'Edit', file_path: '/proj/legacy.js' },
  ]);

  const [run] = listChatRuns('diff-project-legacy');
  assert.equal(run.file_edits[0].diff_state, 'none');
  assert.equal(run.file_edits[0].old_string, null);
  assert.equal(run.file_edits[0].new_string, null);
  assert.equal(run.file_edits[0].content, null);
  // The distinction that matters: "no diff was recorded" must never be representable as
  // "a diff was recorded and it was empty".
  assert.notEqual(run.file_edits[0].diff_state, 'present');
});

test('BOUNDS: the per-response diff budget is real — past it, an edit is reported honestly, never silently cut', () => {
  const budget = _CHAT_RUN_DIFF_BUDGET_CHARS_FOR_TESTS;
  assert.equal(typeof budget, 'number');

  // The realistic explosion case this bounds: many maximum-size Writes. exec-stream-parse.mjs caps
  // each captured field at 4000 chars and each turn at 50 edits; 50 chat-runs of those is ~20 MB.
  const bigContent = 'x'.repeat(4000);
  const editsPerTurn = 50;
  const edits = Array.from({ length: editsPerTurn }, (_, i) => ({
    tool: 'Write',
    file_path: '/proj/big-' + i + '.txt',
    content: bigContent,
  }));
  // Enough turns that the budget is certainly crossed (50 * 50 * 4000 = 10,000,000 chars).
  for (let t = 0; t < 50; t++) completedRun('diff-project-budget', 'Big write turn ' + t, edits);

  const runs = listChatRuns('diff-project-budget');
  const allEdits = runs.flatMap((r) => r.file_edits);
  assert.ok(allEdits.length > 0);

  const present = allEdits.filter((e) => e.diff_state === 'present');
  const omitted = allEdits.filter((e) => e.diff_state === 'omitted_budget');
  assert.ok(omitted.length > 0, 'the budget must actually be reached by this much diff text');

  // Nothing is silently truncated: every kept diff is the FULL captured string.
  for (const edit of present) assert.equal(edit.content.length, 4000);

  // An omitted edit is still a real, visible edit — only its diff text is absent, and it says so.
  for (const edit of omitted) {
    assert.equal(edit.content, null);
    assert.equal(edit.old_string, null);
    assert.equal(edit.new_string, null);
    assert.equal(edit.diff_budget_chars, budget, 'the honest report carries the real budget number');
    assert.ok(typeof edit.file_path === 'string' && edit.file_path.length > 0, 'the edit itself is never dropped');
  }

  // The whole point: the payload cannot explode.
  const totalDiffChars = present.reduce(
    (sum, e) => sum + (e.old_string?.length ?? 0) + (e.new_string?.length ?? 0) + (e.content?.length ?? 0),
    0,
  );
  assert.ok(totalDiffChars <= budget, 'total diff text in one response never exceeds the budget');
});

test('SECURITY: a secret in old_string, new_string, content OR the file path never reaches the chat-runs payload', () => {
  completedRun('diff-project-secrets', 'Rotate the credentials', [
    {
      tool: 'Edit',
      file_path: '/proj/config.js',
      old_string: 'OLD_TOKEN=ghp_abcdefghij1234567890',
      new_string: 'NEW_TOKEN=nvapi-abcdefghij1234567890',
    },
    {
      tool: 'Write',
      file_path: '/proj/.env',
      content: 'AWS_ACCESS_KEY_ID=AKIA1234567890ABCD\nOPENAI=sk-abcdefghijklmnopqrstuvwx\n',
    },
    // A credential can also sit in the PATH itself (a temp dir named after a key, a checked-out
    // secret file) — the projection must not treat file_path as a "safe" field.
    { tool: 'Write', file_path: '/tmp/sk-abcdefghijklmnopqrstuvwx/out.txt', content: 'harmless body' },
  ]);

  const payload = JSON.stringify(listChatRuns('diff-project-secrets'));

  assert.doesNotMatch(payload, /ghp_abcdefghij1234567890/, 'a GitHub PAT in old_string must never reach the payload');
  assert.doesNotMatch(payload, /nvapi-abcdefghij1234567890/, 'an NVIDIA key in new_string must never reach the payload');
  assert.doesNotMatch(payload, /AKIA1234567890ABCD/, 'an AWS key id in Write content must never reach the payload');
  assert.doesNotMatch(payload, /sk-abcdefghijklmnopqrstuvwx/, 'an sk- key in content OR in a file path must never reach the payload');

  // Positive proof the values really passed through the redaction layer (not merely absent).
  assert.match(payload, /\[REDACTED:GITHUB_PAT\]/);
  assert.match(payload, /\[REDACTED:NVIDIA_API_KEY\]/);
  assert.match(payload, /\[REDACTED:AWS_ACCESS_KEY_ID\]/);
  assert.match(payload, /\[REDACTED:GENERIC_SK_KEY\]/);

  const [run] = listChatRuns('diff-project-secrets');
  assert.match(run.file_edits[0].old_string, /\[REDACTED:GITHUB_PAT\]/);
  assert.match(run.file_edits[0].new_string, /\[REDACTED:NVIDIA_API_KEY\]/);
  assert.match(run.file_edits[1].content, /\[REDACTED:AWS_ACCESS_KEY_ID\]/);
  assert.match(run.file_edits[2].file_path, /\[REDACTED:GENERIC_SK_KEY\]/);
  // Clean sibling text is left completely alone — redaction never over-reaches.
  assert.equal(run.file_edits[2].content, 'harmless body');
});
