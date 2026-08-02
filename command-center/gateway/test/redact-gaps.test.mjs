// WP8-13 (forge-2026-07-27-cc-wp8-13) — closing the 4 remaining secret-redaction gaps named by
// the Security Boss's threat model / the cc-secfix agent's own follow-up: events.mjs (the only
// verbatim file-content response path), models.mjs (the highest-risk child output — nvidia-
// provider.cjs runs WITHOUT the exec-bridge env allowlist), exec-bridge.mjs (raw spawn output
// capture), and conversations.mjs (the live-SSE hole a secret can appear in before turn-close
// redaction applies). Every test here reuses redact.mjs's ONE real implementation — nothing here
// duplicates a second redaction pattern set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readEvents, attachEventsStream, _resetEventsCacheForTests } from '../src/events.mjs';
import { makeTempProjectRoot, writeEventsFile } from '../test-support/helpers.mjs';
import {
  buildModelsView,
  _resetNvidiaHealthCacheForTests,
  _setNvidiaProviderCjsForTests,
  _parseNvidiaHealthOutputForTests,
} from '../src/models.mjs';
import {
  createConversation,
  readConversation,
  appendConversationEvent,
  attachConversationStream,
  _setConversationsDirForTests,
  _resetConversationsForTests,
  _resetConversationStreamCapForTests,
} from '../src/conversations.mjs';
import {
  startExecution,
  _resetExecBridgeForTests,
} from '../src/exec-bridge.mjs';

function makeFakeRes() {
  const emitter = new EventEmitter();
  const res = {
    chunks: [],
    status: null,
    headers: null,
    writableEnded: false,
    writeHead(status, headers) { res.status = status; res.headers = headers; },
    write(chunk) { if (!res.writableEnded) res.chunks.push(chunk); return true; },
    end(chunk) { if (chunk) res.chunks.push(chunk); res.writableEnded = true; },
    on(evt, cb) { emitter.on(evt, cb); },
    text() { return res.chunks.join(''); },
    _emitClose() { res.writableEnded = true; emitter.emit('close'); },
  };
  return res;
}

function makeFakeReq(headers = {}) {
  const emitter = new EventEmitter();
  return { headers, on(evt, cb) { emitter.on(evt, cb); } };
}

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── GAP 1: events.mjs — the only verbatim file-content response path ─────────────────────────

test('GAP 1 SECURITY: readEvents() (poll path) redacts a credential inside an event note field', () => {
  const root = makeTempProjectRoot();
  try {
    writeEventsFile(root, 'run-redact-poll', [
      { event_type: 'agent_note', agent: 'Build Boss', note: 'leaked key nvapi-abcdefghij1234567890 in output' },
    ]);
    const res = readEvents(root, 'run-redact-poll', 0);
    assert.equal(res.ok, true);
    assert.equal(res.events.length, 1);
    assert.doesNotMatch(JSON.stringify(res.events), /nvapi-abcdefghij1234567890/);
    assert.match(res.events[0].note, /\[REDACTED:NVIDIA_API_KEY\]/);
    assert.equal(res.events[0].agent, 'Build Boss', 'sibling fields must survive untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GAP 1 SECURITY: attachEventsStream (SSE frame) redacts a credential inside an event note field', () => {
  const root = makeTempProjectRoot();
  try {
    writeEventsFile(root, 'run-redact-sse', [
      { event_type: 'agent_note', agent: 'Build Boss', note: 'leaked key ghp_abcdefghij1234567890 in output' },
    ]);
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachEventsStream({ req, res, projectPath: root, runId: 'run-redact-sse', heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    const text = res.text();
    assert.doesNotMatch(text, /ghp_abcdefghij1234567890/);
    assert.match(text, /\[REDACTED:GITHUB_PAT\]/);
    res._emitClose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GAP 1 STRUCTURE PRESERVATION: a credential nested inside an object/array inside an event is redacted without dropping sibling fields', () => {
  const root = makeTempProjectRoot();
  try {
    writeEventsFile(root, 'run-redact-nested', [
      {
        event_type: 'gate_evaluated',
        agent: 'Security Boss',
        evidence: { findings: ['clean note', 'secret AKIA1234567890ABCD here'], count: 2 },
        ok: true,
      },
    ]);
    const res = readEvents(root, 'run-redact-nested', 0);
    const ev = res.events[0];
    assert.doesNotMatch(JSON.stringify(ev), /AKIA1234567890ABCD/);
    assert.match(ev.evidence.findings[1], /\[REDACTED:AWS_ACCESS_KEY_ID\]/);
    assert.equal(ev.evidence.findings[0], 'clean note');
    assert.equal(ev.evidence.count, 2);
    assert.equal(ev.ok, true);
    assert.equal(ev.agent, 'Security Boss');
    assert.equal(ev.event_type, 'gate_evaluated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GAP 1 FALSE POSITIVE: a non-secret "task-orchestrator" string survives poll + SSE untouched', () => {
  const root = makeTempProjectRoot();
  try {
    writeEventsFile(root, 'run-redact-fp', [
      { event_type: 'agent_dispatched', agent: 'task-orchestrator', note: 'routed to task-orchestrator for a normal review' },
    ]);
    const polled = readEvents(root, 'run-redact-fp', 0);
    assert.equal(polled.events[0].agent, 'task-orchestrator');
    assert.equal(polled.events[0].note, 'routed to task-orchestrator for a normal review');

    _resetEventsCacheForTests();
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachEventsStream({ req, res, projectPath: root, runId: 'run-redact-fp', heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    assert.match(res.text(), /"agent":"task-orchestrator"/);
    res._emitClose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── GAP 2: models.mjs — highest-risk child output (nvidia-provider.cjs, no env allowlist) ────

test('GAP 2 SECURITY: the unrecognized-output note (line.slice(0,200) path) redacts a credential', () => {
  const out = _parseNvidiaHealthOutputForTests('some garbage line containing nvapi-abcdefghij1234567890 and more junk after it');
  assert.equal(out.state, 'UNKNOWN');
  assert.doesNotMatch(out.note, /nvapi-abcdefghij1234567890/);
  assert.match(out.note, /\[REDACTED:NVIDIA_API_KEY\]/);
});

test('GAP 2 SECURITY: a credential leaking into the nvidia-provider spawn error message (err.message path) is redacted', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-redact-models-test-'));
  try {
    _resetNvidiaHealthCacheForTests();
    const fixtureScript = path.join(fixtureDir, 'fake-nvidia-provider.cjs');
    fs.writeFileSync(fixtureScript, "console.error('leaked live: nvapi-abcdefghij1234567890'); process.exit(1);\n", 'utf8');
    _setNvidiaProviderCjsForTests(fixtureScript);
    const result = await buildModelsView();
    assert.equal(result.nvidia.state, 'DISCONNECTED');
    assert.doesNotMatch(result.nvidia.note, /nvapi-abcdefghij1234567890/);
    assert.match(result.nvidia.note, /\[REDACTED:NVIDIA_API_KEY\]/);
  } finally {
    _setNvidiaProviderCjsForTests(null);
    _resetNvidiaHealthCacheForTests();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('GAP 2 FALSE POSITIVE: an unrecognized nvidia line mentioning "task-orchestrator" is not mangled', () => {
  const out = _parseNvidiaHealthOutputForTests('routed via task-orchestrator, unexpected format');
  assert.match(out.note, /task-orchestrator/);
});

// ── GAP 3 + GAP 4: exec-bridge.mjs raw spawn capture + conversations.mjs live-SSE write path ──

let tempConvDir;
before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempConvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-redact-execbridge-test-'));
  _setConversationsDirForTests(tempConvDir);
});

test('GAP 3+4 SECURITY: a credential echoed by a spawned child (mock CLI) never appears in stored/streamed conversation events', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const secretText = 'here is my key nvapi-abcdefghij1234567890 please use it';
  const start = startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: secretText, cwd: os.tmpdir() });
  assert.equal(start.started, true);

  const done = await waitUntil(() => {
    const full = readConversation(conv.id);
    return full.turns.some((t) => t.role === 'assistant');
  });
  assert.ok(done, 'the mock child must exit and produce a real assistant turn within the timeout');

  const full = readConversation(conv.id);
  const raw = fs.readFileSync(path.join(tempConvDir, conv.id + '.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /nvapi-abcdefghij1234567890/, 'the raw on-disk file must never contain the real secret, in ANY record type');

  const assistantEvent = full.events.find((e) => e.kind === 'assistant');
  assert.ok(assistantEvent, 'a real assistant-kind event must have been recorded');
  assert.doesNotMatch(JSON.stringify(assistantEvent), /nvapi-abcdefghij1234567890/);
  assert.match(JSON.stringify(assistantEvent), /\[REDACTED:NVIDIA_API_KEY\]/);

  const resultEvent = full.events.find((e) => e.kind === 'result');
  assert.ok(resultEvent, 'a real result-kind event must have been recorded');
  assert.doesNotMatch(JSON.stringify(resultEvent), /nvapi-abcdefghij1234567890/);
});

test('GAP 4 SECURITY: attachConversationStream (live-SSE) never emits a credential written via appendConversationEvent, even nested inside data', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const req = makeFakeReq();
  const res = makeFakeRes();
  attachConversationStream({ req, res, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 40 });

  appendConversationEvent(conv.id, {
    turn_id: 't-live-1',
    request_id: 'req-live-1',
    kind: 'assistant',
    data: { type: 'assistant', message: { content: [{ type: 'text', text: 'leaked sk-abcdefghijklmnopqrstuvwx here' }] } },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  const text = res.text();
  assert.match(text, /"kind":"assistant"/, 'the event must still be forwarded — redaction must never drop the frame');
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwx/);
  assert.match(text, /\[REDACTED:GENERIC_SK_KEY\]/);
  res._emitClose();
});

test('GAP 4 SECURITY: a raw string kind:"stdout_unparsed" event (non-JSON child line) is also redacted on write', async () => {
  const conv = createConversation({ project: 'demo-project' });
  appendConversationEvent(conv.id, {
    turn_id: 't-2',
    request_id: 'req-2',
    kind: 'stdout_unparsed',
    data: 'raw unparsed line with AKIA1234567890ABCD embedded',
  });
  const raw = fs.readFileSync(path.join(tempConvDir, conv.id + '.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /AKIA1234567890ABCD/);
  const full = readConversation(conv.id);
  const ev = full.events.find((e) => e.kind === 'stdout_unparsed');
  assert.match(ev.data, /\[REDACTED:AWS_ACCESS_KEY_ID\]/);
});

test('GAP 4 FALSE POSITIVE: an event whose data mentions "task-orchestrator" is stored and streamed unmangled', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const req = makeFakeReq();
  const res = makeFakeRes();
  attachConversationStream({ req, res, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 40 });

  appendConversationEvent(conv.id, {
    turn_id: 't-fp-1',
    request_id: 'req-fp-1',
    kind: 'assistant',
    data: { type: 'assistant', message: { content: [{ type: 'text', text: 'dispatched to task-orchestrator for review' }] } },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match(res.text(), /dispatched to task-orchestrator for review/);
  res._emitClose();

  const full = readConversation(conv.id);
  const ev = full.events.find((e) => e.turn_id === 't-fp-1');
  assert.equal(ev.data.message.content[0].text, 'dispatched to task-orchestrator for review');
});

after(() => {
  _resetExecBridgeForTests();
  _resetConversationsForTests();
  _resetConversationStreamCapForTests();
  delete process.env.CC_EXEC_MOCK;
  fs.rmSync(tempConvDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});
