#!/usr/bin/env node
// Entry point: starts the Forge Compatibility Gateway bound to 127.0.0.1 ONLY on port 4100.
import { createServer } from './src/server.mjs';
import { runAskBootScan } from './src/ask-boot-scan.mjs';

const PORT = 4100;
const HOST = '127.0.0.1';

// WP10 should-fix-now #9 (AP-4, HIGH), defence-in-depth layer: static.mjs now guards its own
// decodeURIComponent() call (the actual fix), but this handler exists so that ANY future
// unforeseen synchronous throw inside a request handler logs honestly and keeps the gateway
// serving, instead of the whole process dying on one malformed request. This is a safety net,
// never a substitute for fixing the real throw site — a crash that reaches here is still a bug.
process.on('uncaughtException', (err) => {
  console.error('Forge Command Center gateway: uncaught exception (server stays up):', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Forge Command Center gateway: unhandled rejection (server stays up):', reason);
});

const server = createServer();
server.on('error', (err) => {
  console.error('Forge Command Center gateway failed to start:', err && err.message ? err.message : err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log('Forge Command Center gateway listening on http://' + HOST + ':' + PORT);
  // fix-ghost-asks item 2: runs AFTER the "listening" line above is already printed and the port is
  // already bound — this scan is deliberately NOT on the critical path to "the gateway is up" (see
  // ask-boot-scan.mjs's own header for the real file/byte bound this relies on to stay fast).
  // Best-effort: a scan failure degrades to a logged warning, never a dead gateway.
  try {
    const result = runAskBootScan();
    if (result.abandonedCount > 0) {
      console.log('[ask-boot-scan] closed out ' + result.abandonedCount + ' dangling ask(s) left over from a previous boot');
    }
  } catch (err) {
    console.error('Forge Command Center gateway: ask boot scan failed (server stays up):', err && err.stack ? err.stack : err);
  }
});
