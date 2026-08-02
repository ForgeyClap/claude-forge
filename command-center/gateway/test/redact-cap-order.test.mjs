// SECURITY — REDACT-BEFORE-CAP ORDERING (fix-cap-order).
//
// THE CLASS: a bounded field is produced by cutting a string to a cap and THEN letting redaction walk
// over the cut result. Every secret pattern that needs a trailing anchor to match (this project's PEM
// block needs its `-----END ... PRIVATE KEY-----`) is defeated by that order: the cut removes the
// anchor, the pattern stops matching, and the readable HEAD of the key survives into storage and into
// the DOM. Measured live before the fix: a real Write tool_use of a 5462-char PEM produced a 4000-char
// `file_edits[0].content` of raw key material, `diff_state:"present"`, zero `[REDACTED:` markers.
//
// This is the SECOND time this exact fault has been found in this project — `.claude/forge-bin/
// forge-toolhook.cjs` sliced at 1000 chars and redacted afterwards, while its own header promised
// "redaction runs BEFORE truncation". A one-line fix does not stop a third occurrence, so this file is
// deliberately GENERATIVE rather than a list of hand-written cases:
//
//   * the secret set comes from `_secretPatternNamesForTests()` — the SAME array redact.mjs redacts by.
//     Adding a 6th pattern without adding a sample here FAILS the coverage test below, so a new pattern
//     can never be silently left uncovered.
//   * the cap numbers come from `_turnArtifactCapsForTests()` / `_subagentActivityCapsForTests()` —
//     changing a cap moves the generated boundary with it; the test cannot drift from the code.
//   * every one of the 13 capped fields in exec-stream-parse.mjs is a SITE below, and every site is
//     crossed by every secret at several straddle depths. 13 sites x 5 patterns x 4 depths.
//
// The assertion is derived from the patterns, not enumerated: after processing, the field must contain
// NO match of a RELAXED form of the pattern (its recognisable prefix followed by key material). A field
// that still reads `nvapi-B7f3...` or `-----BEGIN RSA PRIVATE KEY-----` has leaked, whatever its length.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFileEditFromToolUseBlock,
  extractTodoSnapshotFromToolUseBlock,
  extractShellCommandFromToolUseBlock,
  extractShellResultFromToolResultBlock,
  extractAgentDispatchFromToolUseBlock,
  extractSubagentLine,
  extractHookEventFromParsedLine,
  _turnArtifactCapsForTests,
  _subagentActivityCapsForTests,
} from '../src/exec-stream-parse.mjs';
import { _secretPatternNamesForTests } from '../src/redact.mjs';

const caps = _turnArtifactCapsForTests();
const subCaps = _subagentActivityCapsForTests();

// ── the secret generators ────────────────────────────────────────────────────────────────────────
// One entry per name in redact.mjs's own SECRET_PATTERNS. `build(len)` returns a WELL-FORMED secret of
// roughly `len` characters (a real key is not 12 chars long — the whole point is that it is long enough
// to straddle a cap). `partial` is the relaxed pattern: what a LEAKED head of that secret still looks
// like. `[REDACTED:<NAME>]` deliberately matches none of them.
const SENTINEL = 'B7f3A9c2D5e8';        // alnum-only: legal inside every pattern's character class
const SENTINEL_UPPER = 'B7F3A9C2D5E8';  // AWS ids are [A-Z0-9] only

const SECRETS = {
  NVIDIA_API_KEY: {
    build: (len) => 'nvapi-' + SENTINEL + 'x'.repeat(Math.max(10, len - 6 - SENTINEL.length)),
    partial: /nvapi-[A-Za-z0-9_-]{6,}/,
  },
  GENERIC_SK_KEY: {
    build: (len) => 'sk-' + SENTINEL + 'x'.repeat(Math.max(20, len - 3 - SENTINEL.length)),
    partial: /sk-[A-Za-z0-9_-]{6,}/,
  },
  GITHUB_PAT: {
    build: (len) => 'ghp_' + SENTINEL + 'x'.repeat(Math.max(10, len - 4 - SENTINEL.length)),
    partial: /ghp_[A-Za-z0-9]{6,}/,
  },
  AWS_ACCESS_KEY_ID: {
    build: (len) => 'AKIA' + SENTINEL_UPPER + 'X'.repeat(Math.max(10, len - 4 - SENTINEL_UPPER.length)),
    partial: /AKIA[A-Z0-9]{6,}/,
  },
  PEM_PRIVATE_KEY: {
    build: (len) => {
      const head = '-----BEGIN RSA PRIVATE KEY-----\n';
      const tail = '\n-----END RSA PRIVATE KEY-----';
      const bodyLen = Math.max(40, len - head.length - tail.length - SENTINEL.length);
      return head + SENTINEL + 'MIIEow'.repeat(Math.ceil(bodyLen / 6)).slice(0, bodyLen) + tail;
    },
    // A surviving BEGIN marker means the key body that follows it survived too.
    partial: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  },
};

test('COVERAGE GATE: every pattern redact.mjs redacts by has a straddle sample here', () => {
  const declared = _secretPatternNamesForTests();
  const covered = Object.keys(SECRETS);
  assert.deepEqual(
    declared.filter((n) => !covered.includes(n)),
    [],
    'a new SECRET_PATTERN was added to redact.mjs without a straddle sample — this test would silently stop covering it',
  );
  assert.deepEqual(covered.filter((n) => !declared.includes(n)), [], 'a sample here names a pattern redact.mjs no longer has');
});

// ── the 13 capped fields ─────────────────────────────────────────────────────────────────────────
// Each site: build one real stream-json block carrying `payload` in the field under test, run the REAL
// extractor, and hand back every string the extractor produced for that field.
const SITES = [
  { name: 'Edit.old_string', cap: caps.FILE_EDIT_FIELD_CAP_LEN,
    run: (p) => [extractFileEditFromToolUseBlock({ type: 'tool_use', name: 'Edit', input: { file_path: '/f', old_string: p, new_string: 'x' } }).old_string] },
  { name: 'Edit.new_string', cap: caps.FILE_EDIT_FIELD_CAP_LEN,
    run: (p) => [extractFileEditFromToolUseBlock({ type: 'tool_use', name: 'Edit', input: { file_path: '/f', old_string: 'x', new_string: p } }).new_string] },
  { name: 'Write.content', cap: caps.FILE_EDIT_FIELD_CAP_LEN,
    run: (p) => [extractFileEditFromToolUseBlock({ type: 'tool_use', name: 'Write', input: { file_path: '/f', content: p } }).content] },
  { name: 'TodoWrite.content', cap: caps.TODO_FIELD_CAP_LEN,
    run: (p) => [extractTodoSnapshotFromToolUseBlock({ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: p, status: 'pending', activeForm: 'x' }] } })[0].content] },
  { name: 'TodoWrite.activeForm', cap: caps.TODO_FIELD_CAP_LEN,
    run: (p) => [extractTodoSnapshotFromToolUseBlock({ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending', activeForm: p }] } })[0].activeForm] },
  { name: 'Bash.command', cap: caps.SHELL_FIELD_CAP_LEN,
    run: (p) => [extractShellCommandFromToolUseBlock({ type: 'tool_use', name: 'Bash', id: 't1', input: { command: p, description: 'x' } }).command] },
  { name: 'Bash.description', cap: caps.SHELL_FIELD_CAP_LEN,
    run: (p) => [extractShellCommandFromToolUseBlock({ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'x', description: p } }).description] },
  { name: 'Agent.description', cap: caps.SHELL_FIELD_CAP_LEN,
    run: (p) => [extractAgentDispatchFromToolUseBlock({ type: 'tool_use', name: 'Agent', input: { subagent_type: 'Explore', description: p } }).description] },
  { name: 'tool_result.result (string content)', cap: caps.SHELL_FIELD_CAP_LEN,
    run: (p) => [extractShellResultFromToolResultBlock({ type: 'tool_result', tool_use_id: 't1', content: p, is_error: false }).result] },
  { name: 'tool_result.result (text-block content)', cap: caps.SHELL_FIELD_CAP_LEN,
    run: (p) => [extractShellResultFromToolResultBlock({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: p }], is_error: false }).result] },
  { name: 'subagent.text', cap: subCaps.SUBAGENT_TEXT_CAP_LEN,
    run: (p) => extractSubagentLine({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: p }] } }).entries.map((e) => e.text) },
  { name: 'subagent.thinking', cap: subCaps.SUBAGENT_TEXT_CAP_LEN,
    run: (p) => extractSubagentLine({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'thinking', thinking: p }] } }).entries.map((e) => e.text) },
  { name: 'subagent.tool_result', cap: subCaps.SUBAGENT_TEXT_CAP_LEN,
    run: (p) => extractSubagentLine({ type: 'user', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_result', content: p }] } }).entries.map((e) => e.text) },
  { name: 'hook.output', cap: subCaps.HOOK_OUTPUT_CAP_LEN,
    run: (p) => [extractHookEventFromParsedLine({ type: 'system', subtype: 'hook_response', hook_event: 'SubagentStop', hook_name: 'SubagentStop', hook_id: 'h1', output: p }).output] },
];

// How far the secret pokes PAST the cap, as a fraction of its own length. 0.05 = only its last sliver is
// cut off (the nastiest case: almost the whole key survives); 0.95 = only its first sliver survives.
const STRADDLE_FRACTIONS = [0.05, 0.35, 0.65, 0.95];

// The replacement marker can itself land ON the cap boundary — a secret starting at char 495 of a
// 500-char field becomes `[REDACTED:...]` at 495 and gets clipped to `[REDACT`. That is correct
// behaviour (the key is gone either way), so the marker check accepts the full marker anywhere, or any
// non-empty prefix of it at the very end of the field. It rejects a field with no marker at all.
const MARKER = '[REDACTED:';
function carriesRedactionMarker(out) {
  if (out.includes(MARKER)) return true;
  for (let n = MARKER.length - 1; n >= 1; n -= 1) {
    if (out.endsWith(MARKER.slice(0, n))) return true;
  }
  return false;
}

// The filler is a single repeated lowercase letter plus ONE space immediately before the secret: the
// space supplies the `\b` that GENERIC_SK_KEY/GITHUB_PAT/AWS_ACCESS_KEY_ID anchor on, exactly as a real
// `KEY=` or `--token ` prefix would, and no filler run can itself match a partial pattern.
function buildStraddlingField(cap, secret, fractionPast) {
  const past = Math.max(1, Math.min(secret.length - 1, Math.round(secret.length * fractionPast)));
  const inside = secret.length - past;      // chars of the secret that land BEFORE the cap
  const leadLen = Math.max(0, cap - inside - 1);
  return 'a'.repeat(leadLen) + ' ' + secret + 'a'.repeat(64);
}

for (const site of SITES) {
  for (const [patternName, spec] of Object.entries(SECRETS)) {
    // A secret sized to the site's own cap: long enough to genuinely straddle it, never longer than it.
    const secret = spec.build(Math.max(80, Math.floor(site.cap / 3)));
    for (const fraction of STRADDLE_FRACTIONS) {
      test(`SECURITY: ${patternName} straddling the cap of ${site.name} (${Math.round(fraction * 100)}% past) never comes through readable`, () => {
        const field = buildStraddlingField(site.cap, secret, fraction);
        assert.ok(field.length > site.cap, 'the generated field must actually exceed the cap, or this case proves nothing');

        for (const out of site.run(field)) {
          assert.equal(typeof out, 'string', `${site.name} produced no string to check`);
          assert.ok(out.length <= site.cap, `${site.name} exceeded its own cap (${out.length} > ${site.cap})`);
          const hit = spec.partial.exec(out);
          assert.equal(
            hit,
            null,
            `${site.name} leaked readable ${patternName} material across the ${site.cap}-char cap: ` +
              JSON.stringify(hit ? hit[0].slice(0, 60) : ''),
          );
          assert.ok(
            carriesRedactionMarker(out),
            `${site.name} must carry the honest redaction marker (whole, or clipped by the cap) instead of the key — got tail ` +
              JSON.stringify(out.slice(-24)),
          );
        }
      });
    }
  }
}

// A secret that fits ENTIRELY inside the cap was already handled before this fix; it must stay handled.
test('a secret wholly inside the cap is still redacted (no regression on the already-working path)', () => {
  const secret = SECRETS.PEM_PRIVATE_KEY.build(200);
  const edit = extractFileEditFromToolUseBlock({ type: 'tool_use', name: 'Write', input: { file_path: '/f', content: 'x ' + secret + ' y' } });
  assert.doesNotMatch(edit.content, SECRETS.PEM_PRIVATE_KEY.partial);
  assert.match(edit.content, /\[REDACTED:PEM_PRIVATE_KEY\]/);
});

// Redaction must not change what the cap MEANS: clean text is still cut at exactly the cap, and a clean
// string under the cap is returned untouched (same object semantics the old capString had).
test('capping semantics are unchanged for clean text', () => {
  const long = 'z'.repeat(caps.FILE_EDIT_FIELD_CAP_LEN + 500);
  const edit = extractFileEditFromToolUseBlock({ type: 'tool_use', name: 'Write', input: { file_path: '/f', content: long } });
  assert.equal(edit.content.length, caps.FILE_EDIT_FIELD_CAP_LEN);

  const short = 'a short clean line';
  const edit2 = extractFileEditFromToolUseBlock({ type: 'tool_use', name: 'Write', input: { file_path: '/f', content: short } });
  assert.equal(edit2.content, short);

  const notAString = extractFileEditFromToolUseBlock({ type: 'tool_use', name: 'Write', input: { file_path: '/f', content: 12345 } });
  assert.equal(notAString.content, null, 'a non-string field is still honestly null, never coerced');
});

// ── the stderr path (exec-lifecycle.mjs) ─────────────────────────────────────────────────────────
//
// The same fault, one file over, with an extra way in: `stderrBuffer` used to be built as
// `+= redact(chunk)` — redaction PER 'data' EVENT — and only cut at STDERR_CAP_BYTES afterwards. A
// child does not choose where the OS pipe splits its output, so a credential can arrive in two halves
// that each match nothing; the reassembled key was then cut by the cap before anything redacted it
// again. This drives the REAL spawn path (CC_EXEC_MOCK=1, mock child echoes a PEM to its own stderr in
// two deliberately split writes) and asserts on the turn record that actually reaches disk.
import { test as stderrTest, before as stderrBefore, after as stderrAfter } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversation, readConversation, _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { startExecution, _resetExecBridgeForTests } from '../src/exec-bridge.mjs';

let stderrTempDir;
stderrBefore(() => {
  process.env.CC_EXEC_MOCK = '1';
  stderrTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cap-order-stderr-'));
  _setConversationsDirForTests(stderrTempDir);
  _resetExecBridgeForTests();
});
stderrAfter(() => {
  delete process.env.CC_EXEC_MOCK;
  _resetConversationsForTests();
  fs.rmSync(stderrTempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

stderrTest('SECURITY: a PEM split across two real stderr writes AND straddling STDERR_CAP_BYTES never reaches the turn record', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const started = startExecution({
    convId: conv.id, turnId: 't-stderr-1', requestId: 'req-stderr-1',
    text: '__MOCK_STDERR_SPLIT_SECRET__', cwd: os.tmpdir(),
  });
  assert.equal(started.started, true, 'the mock child must actually have been spawned');

  const deadline = Date.now() + 8000;
  let turn = null;
  while (Date.now() < deadline) {
    const full = readConversation(conv.id);
    turn = (full.turns || []).find((t) => t.role === 'assistant' && t.turn_id === 't-stderr-1') || null;
    if (turn) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(turn, 'the assistant turn never closed — nothing to assert on');
  assert.equal(typeof turn.stderr, 'string', 'the mock child was supposed to produce real stderr');

  assert.doesNotMatch(turn.stderr, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, 'raw PEM header survived into the stored turn');
  assert.equal(turn.stderr.includes('MIIEow'), false, 'raw PEM body survived into the stored turn');
  assert.match(turn.stderr, /\[REDACTED:PEM_PRIVATE_KEY\]/, 'the honest redaction marker must be there instead');

  const raw = fs.readFileSync(path.join(stderrTempDir, conv.id + '.jsonl'), 'utf8');
  assert.equal(raw.includes('-----BEGIN RSA PRIVATE KEY-----'), false, 'the raw JSONL on disk must never hold the key');
});
