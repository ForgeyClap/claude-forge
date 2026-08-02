// fix-stream-insights: redaction coverage for the two new turn fields exec-bridge.mjs's real
// tool_use capture writes onto an assistant turn — `file_edits` (Edit/Write tool_use blocks, which
// can carry full file content/diff strings) and `todos` (a TodoWrite snapshot). Same "credential
// can land anywhere in free text an agent/child process shapes" class WP10 #12 / WP8-13 already
// fixed for text/stderr/event.data — this file proves the SAME redactDeep() coverage now also
// applies to these two new fields, on both write and read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  appendAssistantTurn,
  readConversation,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';

let tempDir;
before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-redact-turn-artifacts-test-'));
  _setConversationsDirForTests(tempDir);
});
after(() => {
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SECURITY: a secret pasted into a Write tool_use\'s content is redacted BEFORE it ever touches disk, and on read', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendAssistantTurn(conv.id, {
    text: 'wrote the file',
    exit_code: 0,
    file_edits: [
      { tool: 'Write', file_path: '/proj/.env', content: 'API_KEY=nvapi-abcdefghij1234567890 please keep this safe' },
    ],
    todos: null,
  });

  const raw = fs.readFileSync(path.join(tempDir, conv.id + '.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /nvapi-abcdefghij1234567890/, 'the raw on-disk file must never contain the real secret');
  assert.match(raw, /\[REDACTED:NVIDIA_API_KEY\]/);

  const full = readConversation(conv.id);
  const turn = full.turns[0];
  assert.match(turn.file_edits[0].content, /\[REDACTED:NVIDIA_API_KEY\]/);
  assert.equal(turn.file_edits[0].file_path, '/proj/.env', 'sibling fields survive redaction untouched');
  assert.equal(turn.file_edits[0].tool, 'Write');
});

test('SECURITY: a secret inside an Edit\'s old_string/new_string is redacted, and a secret inside a todo\'s content is redacted too', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendAssistantTurn(conv.id, {
    text: 'edited the file',
    exit_code: 0,
    file_edits: [
      { tool: 'Edit', file_path: '/proj/config.js', old_string: 'token=old', new_string: 'token=ghp_abcdefghij1234567890' },
    ],
    todos: [
      { content: 'remember to rotate AKIA1234567890ABCD', status: 'pending', activeForm: 'Rotating the key' },
    ],
  });

  const raw = fs.readFileSync(path.join(tempDir, conv.id + '.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /ghp_abcdefghij1234567890/);
  assert.doesNotMatch(raw, /AKIA1234567890ABCD/);

  const full = readConversation(conv.id);
  const turn = full.turns[0];
  assert.match(turn.file_edits[0].new_string, /\[REDACTED:GITHUB_PAT\]/);
  assert.equal(turn.file_edits[0].old_string, 'token=old', 'a clean sibling string is left completely untouched');
  assert.match(turn.todos[0].content, /\[REDACTED:AWS_ACCESS_KEY_ID\]/);
  assert.equal(turn.todos[0].status, 'pending', 'non-string sibling fields survive untouched');
});

test('SECURITY: read-side redaction also catches a pre-fix record written directly to disk (defense in depth)', () => {
  const conv = createConversation({ project: 'demo-project' });
  fs.appendFileSync(
    path.join(tempDir, conv.id + '.jsonl'),
    JSON.stringify({
      type: 'turn',
      role: 'assistant',
      text: 'pre-fix record',
      file_edits: [{ tool: 'Write', file_path: '/f.txt', content: 'leaked sk-abcdefghijklmnopqrstuvwx here' }],
      created_at: new Date().toISOString(),
    }) + '\n',
    'utf8',
  );
  const full = readConversation(conv.id);
  assert.match(full.turns[0].file_edits[0].content, /\[REDACTED:GENERIC_SK_KEY\]/);
});

test('a turn with no file_edits/todos fields at all is unaffected (redaction never invents a field)', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendAssistantTurn(conv.id, { text: 'a perfectly normal reply', exit_code: 0 });
  const full = readConversation(conv.id);
  assert.equal('file_edits' in full.turns[0], false);
  assert.equal('todos' in full.turns[0], false);
});

test('explicit null file_edits/todos survive redaction unchanged (never coerced into an empty array or dropped)', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendAssistantTurn(conv.id, { text: 'no tools used', exit_code: 0, file_edits: null, todos: null });
  const full = readConversation(conv.id);
  assert.equal(full.turns[0].file_edits, null);
  assert.equal(full.turns[0].todos, null);
});

// feat-live-stream: shell_commands (real Bash command/description/result text) is the exact same
// free-text redaction class as file_edits/todos above — same coverage, same convention.
test('SECURITY: a secret inside a shell command\'s own command text or its captured result is redacted, on both write and read', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendAssistantTurn(conv.id, {
    text: 'ran a command',
    exit_code: 0,
    shell_commands: [
      {
        tool: 'Bash',
        id: 'toolu_1',
        command: 'echo "API_KEY=nvapi-abcdefghij1234567890"',
        description: 'Print the key',
        result: 'token=ghp_abcdefghij1234567890',
        is_error: false,
      },
    ],
  });

  const raw = fs.readFileSync(path.join(tempDir, conv.id + '.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /nvapi-abcdefghij1234567890/, 'the raw on-disk file must never contain the real secret');
  assert.doesNotMatch(raw, /ghp_abcdefghij1234567890/);

  const full = readConversation(conv.id);
  const shellCommand = full.turns[0].shell_commands[0];
  assert.match(shellCommand.command, /\[REDACTED:NVIDIA_API_KEY\]/);
  assert.match(shellCommand.result, /\[REDACTED:GITHUB_PAT\]/);
  assert.equal(shellCommand.tool, 'Bash', 'sibling fields survive redaction untouched');
  assert.equal(shellCommand.is_error, false);
});

test('explicit null shell_commands survives redaction unchanged (never coerced into an empty array or dropped)', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendAssistantTurn(conv.id, { text: 'no tools used', exit_code: 0, shell_commands: null });
  const full = readConversation(conv.id);
  assert.equal(full.turns[0].shell_commands, null);
});
