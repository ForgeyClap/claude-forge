#!/usr/bin/env node
// Entry point: starts the Forge Compatibility Gateway bound to 127.0.0.1 ONLY on port 4100.
import { createServer } from './src/server.mjs';
import { runAskBootScan } from './src/ask-boot-scan.mjs';

const PORT = Number(process.env.CC_PORT) > 0 ? Number(process.env.CC_PORT) : 4100; // env-override puur voor hermetische tests (G8-drain-test); productie blijft 4100
const HOST = '127.0.0.1';

// WP10 should-fix-now #9 (AP-4, HIGH), defence-in-depth layer: static.mjs now guards its own
// decodeURIComponent() call (the actual fix), but this handler exists so that ANY future
// unforeseen synchronous throw inside a request handler logs honestly and keeps the gateway
// serving, instead of the whole process dying on one malformed request. This is a safety net,
// never a substitute for fixing the real throw site — a crash that reaches here is still a bug.
// AUDIT G8.1 (2026-08-06): "log + serveer door" liet de gateway na een uncaught met mogelijk
// gecorrumpeerde in-memory-staat doorleven terwijl /api/health groen bleef en de supervisor (die
// alleen op proces-exit reageert) nooit ingreep. Nu: markeer DEGRADED (health wordt rood), weiger
// nieuwe verbindingen, geef lopende executies een begrensde drain (10s) en exit(1) — de SUPERVISOR
// is de enige herstart-autoriteit (supervisor.mjs: backoff + crash-loop-brake bestaan al).
const DRAIN_MS = 10000;
let drainStarted = false;
/** degradeAndDrain (r4 #13 · r5 #28/#29, 2026-08-07): de reentrancy-guard, de exitcode ÉN de
 *  exit-deadline staan VÓÓR elke await — faalt zelfs de runtime-state-import, dan eindigt het proces
 *  hoe dan ook binnen het drain-venster met code 1 (de timer is bewust NIET ge-unref'd: hij MOET het
 *  proces levend houden tot de exit). Kills worden afgewacht (Promise-based, met eigen deadline) zodat
 *  de supervisor geen verse gateway naast nog levende oude kinderen start. */
async function degradeAndDrain(kind, err) {
  process.exitCode = 1; // SYNCHROON, voor enige await — ook een importfout eindigt dan met 1
  console.error('Forge Command Center gateway: ' + kind + ' — runtime DEGRADED, gecontroleerde drain gestart:', err && err.stack ? err.stack : err);
  if (drainStarted) return;
  drainStarted = true;
  // gegarandeerde exit-deadline: referenced (geen unref) — dit is nu het maximum-leven van het proces
  setTimeout(() => {
    console.error('Forge Command Center gateway: drain-venster (' + DRAIN_MS + 'ms) voorbij — exit(1) zodat de supervisor een verse gateway start');
    process.exit(1);
  }, DRAIN_MS);
  try {
    try {
      const { markUncaught, markDraining } = await import('./src/runtime-state.mjs');
      markUncaught(err);
      markDraining();
    } catch (e) { console.error('drain: runtime-state-markering faalde (door met drain): ' + (e && e.message)); }
    try { if (globalThis.__forgeGatewayServer && typeof globalThis.__forgeGatewayServer.close === 'function') globalThis.__forgeGatewayServer.close(); } catch { /* drain gaat door */ }
    try {
      const lc = await import('./src/exec-lifecycle.mjs');
      lc.enterDrainMode(kind);
      const interrupted = lc.interruptAllExecutions(kind);
      if (interrupted.length) {
        console.error('Forge Command Center gateway: ' + interrupted.length + ' lopende executie(s) interrupted + tree-kill gestart: ' + interrupted.map((i) => i.convId + '#' + i.pid).join(', '));
        // r5 #28: wacht (begrensd) tot de kinderen echt weg zijn — geen verse gateway naast oude schrijvers
        const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
        const deadline = Date.now() + Math.max(2000, DRAIN_MS - 3000);
        while (interrupted.some((i) => i.pid && alive(i.pid)) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
        }
        const survivors = interrupted.filter((i) => i.pid && alive(i.pid));
        if (survivors.length) console.error('drain: ' + survivors.length + ' kind(eren) nog levend na de kill-deadline: ' + survivors.map((i) => i.pid).join(',') + ' — exit volgt toch; supervisor-log draagt dit eerlijk');
        else console.error('drain: alle geinterrumpeerde kinderen zijn aantoonbaar beeindigd');
      }
    } catch (e) { console.error('drain: exec-interrupt faalde (door met exit): ' + (e && e.message)); }
    try {
      const ds = await import('./src/discord-service.mjs');
      const r = await ds.stopDiscordService();
      console.error('Forge Command Center gateway: Discord-service gestopt bij drain (' + JSON.stringify(r).slice(0, 120) + ')');
    } catch (e) { console.error('drain: discord-stop faalde (door met exit): ' + (e && e.message)); }
  } finally {
    // niets meer te doen: niet op het drain-venster wachten
    process.exit(1);
  }
}
// TESTHAAK (alleen actief met CC_TEST_THROW_AFTER_MS gezet — nooit in productie): injecteert een echte
// uncaught throw zodat de drain-keten (readiness-rood -> weiger nieuw -> begrensde drain -> exit(1) ->
// supervisor-herstart) met een ECHT proces getest kan worden i.p.v. alleen op papier te bestaan.
if (Number(process.env.CC_TEST_THROW_AFTER_MS) > 0) {
  setTimeout(() => { throw new Error('CC_TEST_THROW_AFTER_MS fault-injection'); }, Number(process.env.CC_TEST_THROW_AFTER_MS));
}
process.on('uncaughtException', (err) => { void degradeAndDrain('uncaught exception', err); });
process.on('unhandledRejection', (reason) => { void degradeAndDrain('unhandled rejection', reason); });

const server = createServer();
globalThis.__forgeGatewayServer = server; // drain-handle voor de uncaught-afhandeling (G8.1)
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
