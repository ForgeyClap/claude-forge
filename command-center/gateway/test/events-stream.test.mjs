// Unit tests for the new SSE endpoint's mechanics (attachEventsStream in events.mjs). Uses a
// minimal fake req/res pair (no real socket needed to prove the streaming logic) against a real,
// isolated temp events file — never the real .claude/forge-runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { attachEventsStream } from '../src/events.mjs';
import { makeTempProjectRoot, writeEventsFile, appendEventLine } from '../test-support/helpers.mjs';

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

test('attachEventsStream sends real backlog events as proper SSE frames with a 200 text/event-stream header', () => {
  const root = makeTempProjectRoot();
  try {
    writeEventsFile(root, 'run-sse-a', [
      { event_type: 'run_started', agent: 'orchestrator' },
      { event_type: 'agent_note', agent: 'Build Boss', note: 'backlog-one' },
    ]);
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachEventsStream({ req, res, projectPath: root, runId: 'run-sse-a', heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /text\/event-stream/);
    const text = res.text();
    assert.match(text, /id: \d+\ndata: .*"note":"backlog-one"/);
    res._emitClose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attachEventsStream tail-follows a real file append via the fallback poll', async () => {
  const root = makeTempProjectRoot();
  try {
    const eventsPath = writeEventsFile(root, 'run-sse-b', [{ event_type: 'run_started', agent: 'orchestrator' }]);
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachEventsStream({ req, res, projectPath: root, runId: 'run-sse-b', heartbeatMs: 999_999, fallbackPollMs: 40 });
    appendEventLine(eventsPath, { event_type: 'agent_note', agent: 'Build Boss', note: 'tailed-live' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(res.text(), /"note":"tailed-live"/);
    res._emitClose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attachEventsStream emits a heartbeat comment on its own timer', async () => {
  const root = makeTempProjectRoot();
  try {
    writeEventsFile(root, 'run-sse-c', []);
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachEventsStream({ req, res, projectPath: root, runId: 'run-sse-c', heartbeatMs: 30, fallbackPollMs: 999_999 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.match(res.text(), /:heartbeat/);
    res._emitClose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reconnect: Last-Event-ID resumes from exactly that byte offset, replaying only what came after', () => {
  const root = makeTempProjectRoot();
  try {
    const eventsPath = writeEventsFile(root, 'run-sse-d', [
      { event_type: 'run_started', agent: 'orchestrator' },
      { event_type: 'agent_note', agent: 'Build Boss', note: 'seen-before-disconnect' },
    ]);
    const firstReq = makeFakeReq();
    const firstRes = makeFakeRes();
    attachEventsStream({ req: firstReq, res: firstRes, projectPath: root, runId: 'run-sse-d', heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    const idMatch = firstRes.text().match(/id: (\d+)/g);
    assert.ok(idMatch && idMatch.length === 2, 'both backlog events carried a real id: line');
    const lastId = idMatch[idMatch.length - 1].replace('id: ', '');
    firstRes._emitClose();

    appendEventLine(eventsPath, { event_type: 'agent_note', agent: 'Build Boss', note: 'arrived-while-disconnected' });

    const secondReq = makeFakeReq({ 'last-event-id': lastId });
    const secondRes = makeFakeRes();
    attachEventsStream({ req: secondReq, res: secondRes, projectPath: root, runId: 'run-sse-d', heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    const secondText = secondRes.text();
    assert.match(secondText, /"note":"arrived-while-disconnected"/);
    assert.doesNotMatch(secondText, /"note":"seen-before-disconnect"/, 'a reconnect must not replay events the client already had');
    secondRes._emitClose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attachEventsStream honestly reports "no events.jsonl yet" for a genuinely new run instead of erroring', () => {
  const root = makeTempProjectRoot();
  try {
    fs.mkdirSync(root + '/.claude/forge-runs/run-sse-e', { recursive: true });
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachEventsStream({ req, res, projectPath: root, runId: 'run-sse-e', heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    assert.equal(res.status, 200);
    assert.match(res.text(), /no events\.jsonl yet/);
    res._emitClose();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attachEventsStream rejects a containment-violating run id with 400, never writing outside forge-runs', () => {
  const root = makeTempProjectRoot();
  try {
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachEventsStream({ req, res, projectPath: root, runId: '..' + require_sep() + '..' + require_sep() + 'evil', heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    assert.equal(res.status, 400);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function require_sep() {
  return process.platform === 'win32' ? '\\' : '/';
}
