// One Discord bot operation at a time (Codex run B F-08, 2026-09-28).
//
// Starting the bot takes several awaits: a health probe of the bot port, a first-time npm install and
// the spawn. Two operations that overlapped could each pass the "already running?" check before either
// had spawned (two bots on one token), and the boot autostart could read the owner's choice, wait for
// the bot's status, and then start the bot although the owner had switched it off in between.
//
// So every owner action that starts, stops or restarts the bot (the /api/discord/* routes in
// server.mjs) and the boot autostart (discord-autostart.mjs) run through this queue, one after the
// other, in the order they arrived. An operation that fails never blocks the ones behind it.
// bin.mjs's crash drain deliberately does NOT queue: it has a fixed 10 s window and must stop the bot
// even while another operation is stuck.

let tail = Promise.resolve();

/** Runs fn once every operation queued before it has finished. Resolves or rejects with fn's own result. */
export function runDiscordOperation(fn) {
  const run = tail.then(() => fn());
  tail = run.then(() => undefined, () => undefined);
  return run;
}
