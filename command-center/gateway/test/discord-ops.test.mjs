// Codex run B F-08 (2026-09-28): unit coverage for discord-ops.mjs, the queue that runs one Discord bot
// operation at a time (every start/stop/connect/server route and the boot autostart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDiscordOperation } from '../src/discord-ops.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

test('operations run one after the other, in the order they arrived', async () => {
  const order = [];
  const gate = deferred();
  const first = runDiscordOperation(async () => { order.push('first:begin'); await gate.promise; order.push('first:end'); return 1; });
  const second = runDiscordOperation(async () => { order.push('second'); return 2; });
  await tick();
  assert.deepEqual(order, ['first:begin'], 'the second waits while the first is still busy');
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first:begin', 'first:end', 'second']);
});

test('a failed operation reports its own error and never blocks the ones behind it', async () => {
  const failed = runDiscordOperation(async () => { throw new Error('start refused'); });
  const next = runDiscordOperation(async () => 'ran');
  await assert.rejects(failed, /start refused/);
  assert.equal(await next, 'ran');
});

test('a synchronous throw is a rejection too, and the queue keeps going', async () => {
  const failed = runDiscordOperation(() => { throw new Error('boom'); });
  await assert.rejects(failed, /boom/);
  assert.equal(await runDiscordOperation(() => 'after'), 'after');
});
