// v2.9.0 (Command Center audit finding 31) — unit coverage for discord-activity.mjs's
// readDiscordActivity(): the read-only summary of the Discord bot's jobs and recorded cost behind
// GET /api/discord/activity. Every case uses its own os.tmpdir() fixture folder, never the real
// command-center/.data/discord/state.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDiscordActivity, RECENT_JOBS_LIMIT, QUEUE_MAX_BYTES, USAGE_MAX_BYTES } from '../src/discord-activity.mjs';

const NOW = Date.UTC(2026, 8, 27, 20, 0, 0); // a fixed "now", so the 24 hour and 7 day windows are exact
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Token-shaped (three dot-separated parts) so redact.mjs's DISCORD_BOT_TOKEN pattern fires; built from
// pieces, the same way redact.test.mjs does, so this file never holds one literal token-shaped value.
const FAKE_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'Gx2abc', 'abcdefghijklmnopqrstuvwxyz0123'].join('.');
// Discord-id-shaped values the summary must never return.
const DISCORD_IDS = ['1532155925555576001', '1532155925555576002', '1532155925555576003', '1532155925555576004', '1532155925555576005', '1532155925555576999'];

let dir;
let seq = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-activity-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function writeJson(name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value), 'utf8');
}

function writeLines(name, lines) {
  fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n', 'utf8');
}

/** One queue item in the bot's real shape (discord/src/queue.js), private fields included on purpose. */
function job(overrides) {
  seq += 1;
  return {
    id: 'item-' + seq,
    seq,
    messageId: DISCORD_IDS[0],
    guildId: DISCORD_IDS[1],
    channelId: DISCORD_IDS[2],
    threadId: DISCORD_IDS[3],
    senderId: DISCORD_IDS[4],
    projectId: 'alpha',
    conversationId: 'conv-private-id',
    content: 'PRIVATE MESSAGE TEXT that must never leave the gateway',
    promptHash: 'prompt-hash-that-must-not-leak',
    attachments: [],
    referencedMessageId: null,
    priority: 0,
    receivedAt: NOW - 3 * HOUR,
    enqueuedAt: NOW - 3 * HOUR,
    state: 'COMPLETED',
    attempts: 1,
    error: null,
    runId: 'discord-run-' + seq,
    startedAt: NOW - 3 * HOUR + 1000,
    completedAt: NOW - 3 * HOUR + 61000,
    ...overrides,
  };
}

function usageRow(overrides) {
  return JSON.stringify({
    ts: NOW - HOUR,
    itemId: 'usage-item',
    projectId: 'alpha',
    threadId: DISCORD_IDS[3],
    model: null,
    costUsd: 1,
    durationMs: 1000,
    numTurns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    ...overrides,
  });
}

test('no state folder at all: not available, every count zero, no notes', () => {
  const r = readDiscordActivity({ stateDir: path.join(dir, 'does-not-exist'), now: NOW });
  assert.equal(r.available, false);
  assert.equal(r.jobs.total, 0);
  assert.equal(r.jobs.open, 0);
  assert.deepEqual(r.jobs.by_state, {});
  assert.deepEqual(r.jobs.recent, []);
  assert.equal(r.cost.recorded_runs, 0);
  assert.equal(r.cost.total_usd, 0);
  assert.deepEqual(r.cost.by_project, []);
  assert.deepEqual(r.notes, []);
});

test('jobs: counted by state, open jobs, newest first, durations, project names, redacted errors', () => {
  writeJson('mappings.json', {
    projects: [{ projectId: 'alpha', name: 'Alpha Shop', forumChannelId: DISCORD_IDS[2], archived: false, permissionMode: 'default' }],
    conversations: { [DISCORD_IDS[5]]: { conversationId: 'c', projectId: 'alpha', threadId: DISCORD_IDS[3] } },
  });
  writeJson('queue.json', {
    items: [
      job({ id: 'a', state: 'COMPLETED', startedAt: NOW - 5 * HOUR - MINUTE, completedAt: NOW - 5 * HOUR }),
      job({ id: 'b', state: 'FAILED', startedAt: NOW - 2 * HOUR - 30000, completedAt: NOW - 2 * HOUR, error: 'login failed for ' + FAKE_TOKEN }),
      job({ id: 'c', state: 'RUNNING', startedAt: NOW - 10 * MINUTE, completedAt: undefined }),
      job({ id: 'd', state: 'CANCELLED', projectId: 'beta', completedAt: NOW - DAY }),
      job({ id: 'e', state: 'not-a-real-state' }),
      null,
      'not-an-object',
    ],
    nextSeq: 9,
  });
  const r = readDiscordActivity({ stateDir: dir, now: NOW });
  assert.equal(r.available, true);
  assert.equal(r.jobs.total, 5);
  assert.deepEqual(r.jobs.by_state, { COMPLETED: 1, FAILED: 1, RUNNING: 1, CANCELLED: 1, UNKNOWN: 1 });
  assert.equal(r.jobs.open, 1);
  assert.deepEqual(r.jobs.recent.map((j) => j.id), ['c', 'b', 'e', 'a', 'd']);

  const b = r.jobs.recent.find((j) => j.id === 'b');
  assert.equal(b.state, 'FAILED');
  assert.equal(b.duration_ms, 30000);
  assert.equal(b.project_name, 'Alpha Shop');
  assert.equal(b.run_id, 'discord-run-' + (seq - 3));
  assert.ok(b.error.includes('[REDACTED:DISCORD_BOT_TOKEN]'), b.error);
  assert.ok(!b.error.includes(FAKE_TOKEN), 'the token itself must be gone');

  const c = r.jobs.recent.find((j) => j.id === 'c');
  assert.equal(c.completed_at, null);
  assert.equal(c.duration_ms, null, 'a running job has no duration yet');
  assert.equal(c.started_at, new Date(NOW - 10 * MINUTE).toISOString());

  const d = r.jobs.recent.find((j) => j.id === 'd');
  assert.equal(d.project_id, 'beta');
  assert.equal(d.project_name, null, 'no name in mappings.json: the id is all there is');
  assert.equal(r.jobs.recent.find((j) => j.id === 'e').state, 'UNKNOWN');
  assert.deepEqual(r.notes, []);
});

test('never returns message text, prompt hashes, conversation ids or any Discord id', () => {
  writeJson('mappings.json', { projects: [{ projectId: 'alpha', name: 'Alpha Shop' }], conversations: { [DISCORD_IDS[5]]: { conversationId: 'conv-private-id', projectId: 'alpha', threadId: DISCORD_IDS[3] } } });
  writeJson('queue.json', { items: [job({}), job({ state: 'FAILED', error: { message: 'boom', stack: 'at secretFunction' } })] });
  writeLines('usage.jsonl', [usageRow({}), usageRow({ projectId: 'beta' })]);
  const text = JSON.stringify(readDiscordActivity({ stateDir: dir, now: NOW }));
  for (const value of ['PRIVATE MESSAGE TEXT', 'prompt-hash-that-must-not-leak', 'conv-private-id', 'secretFunction', ...DISCORD_IDS]) {
    assert.ok(!text.includes(value), 'leaked: ' + value);
  }
  for (const key of ['content', 'promptHash', 'senderId', 'guildId', 'channelId', 'threadId', 'messageId', 'conversationId', 'attachments']) {
    assert.ok(!text.includes('"' + key + '"'), 'leaked field: ' + key);
  }
});

test('cost: totals, 24 hour and 7 day windows, runs without cost, per project, unreadable lines', () => {
  writeJson('mappings.json', { projects: [{ projectId: 'alpha', name: 'Alpha Shop' }] });
  writeLines('usage.jsonl', [
    usageRow({ ts: NOW - HOUR, projectId: 'alpha', costUsd: 1.25, inputTokens: 100, outputTokens: 10, cacheReadTokens: 5000 }),
    usageRow({ ts: NOW - 3 * DAY, projectId: 'alpha', costUsd: 2.5, inputTokens: 200, outputTokens: 20, cacheReadTokens: 7000 }),
    usageRow({ ts: NOW - 30 * DAY, projectId: 'beta', costUsd: 10, inputTokens: 1, outputTokens: 2 }),
    usageRow({ ts: NOW - 2 * HOUR, projectId: 'beta', costUsd: null, inputTokens: 0, outputTokens: 0 }),
    '{not json',
    '[1,2]',
  ]);
  const r = readDiscordActivity({ stateDir: dir, now: NOW });
  assert.equal(r.available, true, 'a usage log alone means the bot has run here');
  assert.equal(r.jobs.total, 0);
  assert.equal(r.cost.recorded_runs, 4);
  assert.equal(r.cost.runs_without_cost, 1);
  assert.equal(r.cost.total_usd, 13.75);
  assert.equal(r.cost.last_24h_usd, 1.25);
  assert.equal(r.cost.last_7d_usd, 3.75);
  assert.equal(r.cost.input_tokens, 301);
  assert.equal(r.cost.output_tokens, 32);
  assert.equal(r.cost.cache_read_tokens, 12000, 'cached input is counted separately, never dropped');
  assert.equal(r.cost.first_at, new Date(NOW - 30 * DAY).toISOString());
  assert.equal(r.cost.last_at, new Date(NOW - HOUR).toISOString());
  assert.deepEqual(r.cost.by_project, [
    { project_id: 'beta', project_name: null, runs: 2, cost_usd: 10 },
    { project_id: 'alpha', project_name: 'Alpha Shop', runs: 2, cost_usd: 3.75 },
  ]);
  assert.ok(r.notes.some((n) => n.startsWith('2 lines in usage.jsonl could not be read')), JSON.stringify(r.notes));
});

test('a malformed or wrongly shaped queue.json becomes a plain note, never a crash', () => {
  fs.writeFileSync(path.join(dir, 'queue.json'), '{"items": [', 'utf8');
  let r = readDiscordActivity({ stateDir: dir, now: NOW });
  assert.equal(r.available, true);
  assert.equal(r.jobs.total, 0);
  assert.ok(r.notes.some((n) => n.includes('queue.json is not in the expected shape')), JSON.stringify(r.notes));
  writeJson('queue.json', { items: 'not a list' });
  r = readDiscordActivity({ stateDir: dir, now: NOW });
  assert.ok(r.notes.some((n) => n.includes('queue.json is not in the expected shape')), JSON.stringify(r.notes));
});

test('a queue.json over its size cap is not read, and the note says so', () => {
  const fd = fs.openSync(path.join(dir, 'queue.json'), 'w');
  fs.ftruncateSync(fd, QUEUE_MAX_BYTES + 1);
  fs.closeSync(fd);
  const r = readDiscordActivity({ stateDir: dir, now: NOW });
  assert.equal(r.jobs.total, 0);
  assert.ok(r.notes.some((n) => n.includes('queue.json is larger than 8 MB')), JSON.stringify(r.notes));
});

test('a usage.jsonl over its size cap: only the newest part is counted, with a note', () => {
  const oldRow = usageRow({ ts: NOW - 40 * DAY, costUsd: 100 });
  const padding = ' '.repeat(USAGE_MAX_BYTES);
  const newRows = [usageRow({ ts: NOW - 2 * HOUR, costUsd: 1 }), usageRow({ ts: NOW - HOUR, costUsd: 1 })];
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), [oldRow, padding, ...newRows].join('\n') + '\n', 'utf8');
  const r = readDiscordActivity({ stateDir: dir, now: NOW });
  assert.equal(r.cost.recorded_runs, 2, 'the oldest row lies outside the cap and is not counted');
  assert.equal(r.cost.total_usd, 2);
  assert.ok(r.notes.some((n) => n.includes('only its most recent part is counted')), JSON.stringify(r.notes));
});

test('a symlinked queue.json is refused, not followed', (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-activity-outside-'));
  try {
    const target = path.join(outside, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ items: [job({})] }), 'utf8');
    try {
      fs.symlinkSync(target, path.join(dir, 'queue.json'), 'file');
    } catch {
      t.skip('this account cannot create file symlinks');
      return;
    }
    const r = readDiscordActivity({ stateDir: dir, now: NOW });
    assert.equal(r.jobs.total, 0);
    assert.ok(r.notes.some((n) => n.includes('refused: the file is a link')), JSON.stringify(r.notes));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('recent jobs are capped, the totals still count every job', () => {
  const items = [];
  for (let i = 0; i < RECENT_JOBS_LIMIT + 8; i += 1) items.push(job({ completedAt: NOW - i * MINUTE }));
  writeJson('queue.json', { items });
  const r = readDiscordActivity({ stateDir: dir, now: NOW });
  assert.equal(r.jobs.total, RECENT_JOBS_LIMIT + 8);
  assert.equal(r.jobs.recent.length, RECENT_JOBS_LIMIT);
  assert.equal(r.jobs.recent[0].completed_at, new Date(NOW).toISOString(), 'the newest job comes first');
});

test('F-10: a Discord id inside a job error never leaves the gateway, not even cut short by the length cap', () => {
  const nearCap = 'x'.repeat(190) + ' 1532155925555576001 tail';
  writeJson('queue.json', {
    items: [
      job({ id: 'channel', state: 'FAILED', completedAt: NOW - HOUR, error: 'Unknown Channel 1532155925555576001' }),
      job({ id: 'object', state: 'FAILED', completedAt: NOW - 2 * HOUR, error: { code: 10003, channelId: '1532155925555576002' } }),
      job({ id: 'cap', state: 'FAILED', completedAt: NOW - 3 * HOUR, error: nearCap }),
    ],
    nextSeq: 4,
  });
  const r = readDiscordActivity({ stateDir: dir, now: NOW });
  const errors = r.jobs.recent.map((j) => j.error);
  for (const e of errors) {
    assert.doesNotMatch(e, /\d{10}/, 'no Discord id, and no cut-off piece of one: ' + e);
  }
  assert.equal(r.jobs.recent.find((j) => j.id === 'channel').error, 'Unknown Channel [discord id]');
});
