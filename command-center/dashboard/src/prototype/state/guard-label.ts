/**
 * How the account usage pill names the usage guard (AccountUsagePressure.tsx).
 *
 * The watcher decides first: the guard's state file still says "ok" after a reboot, while nothing checks
 * usage any more, and the pill used to call that "Active" (found live 2026-09-28). `watcher` comes from
 * GET /api/usage (usage.mjs watcherHealth, the same rule as `usage-guard.cjs status`).
 */

export interface GuardLabelInput {
  readonly available: boolean;
  readonly mode: string | null;
  readonly watcher: string | null;
}

/** True when the guard exists but nothing is checking usage right now. */
export function isGuardWatcherDown(guard: GuardLabelInput): boolean {
  return guard.available && (guard.watcher === 'not-running' || guard.watcher === 'stale');
}

export function guardLabel(guard: GuardLabelInput): string {
  if (!guard.available) return 'n/a';
  if (guard.watcher === 'not-running') return 'Not running';
  if (guard.watcher === 'stale') return 'Not checking';
  if (guard.mode === 'paused') return 'Paused';
  if (guard.mode === 'ok') return 'Active';
  return guard.mode ?? 'n/a';
}

/** The value for the pill's data-guard attribute: the watcher's state when it is down, else the mode. */
export function guardStateAttr(guard: GuardLabelInput): string {
  if (isGuardWatcherDown(guard) && guard.watcher !== null) return guard.watcher;
  return guard.mode ?? 'unknown';
}
