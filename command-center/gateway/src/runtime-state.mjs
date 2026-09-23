// runtime-state.mjs — DEGRADED-vlag voor de gateway (audit G8.1, 2026-08-06).
// De uncaught-handlers logden alleen ("server stays up"): de gateway bleef serveren met mogelijk
// gecorrumpeerde in-memory-invarianten, /api/health bleef groen en de supervisor (die alleen op
// proces-exit reageert) kreeg nooit een signaal. Nu: de eerste uncaught markeert de runtime DEGRADED
// (health wordt rood), waarna een GECONTROLEERDE drain volgt — nieuwe verbindingen weigeren, lopende
// executies een begrensde tijd laten afronden, dan exit(1) zodat de SUPERVISOR (de enige
// herstart-autoriteit, met bestaande backoff + crash-loop-brake) een verse, integere gateway start.
let uncaughtCount = 0;
let lastUncaughtAt = null;
let lastUncaughtMessage = null;
let draining = false;

export function markUncaught(err) {
  uncaughtCount++;
  lastUncaughtAt = new Date().toISOString();
  lastUncaughtMessage = String((err && (err.stack || err.message)) || err).slice(0, 500);
}
export function markDraining() { draining = true; }
export function isDegraded() { return uncaughtCount > 0; }
export function isDraining() { return draining; }
export function getRuntimeState() {
  return uncaughtCount === 0
    ? { state: 'OK', uncaught_count: 0 }
    : { state: draining ? 'DRAINING' : 'DEGRADED', uncaught_count: uncaughtCount, last_uncaught_at: lastUncaughtAt, last_uncaught: lastUncaughtMessage };
}
