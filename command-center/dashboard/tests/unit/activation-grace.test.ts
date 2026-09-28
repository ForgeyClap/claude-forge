/**
 * The new-project auto-open race, pinned (visible-install, HIGH).
 *
 * `ProductionProvider`'s reconciliation effect heals a stale `activeProjectId` by resetting to the
 * first cached project. Correct for a project that really disappeared — but it also fired in the
 * same tick as "New project" activating the freshly created project, whose id CANNOT be in the
 * client's projects cache yet (5s server TTL + 2.5s poll). Screenshot evidence: the user clicked
 * Create and the workspace silently stayed on an unrelated project, from t+156ms through t+120s.
 *
 * `activationGraceActive` is the pure guard: while a LOCAL activation of this exact id is younger
 * than the grace window, reconciliation must hold off. A genuinely dead id still heals the moment
 * the window lapses — the guard delays healing, it never disables it.
 */

import { describe, expect, it } from 'vitest';

import { activationGraceActive } from '@/prototype/PrototypeProvider';

describe('activationGraceActive', () => {
  const T0 = 1_000_000;

  it('holds reconciliation off for a just-activated id (the create-flow race)', () => {
    expect(activationGraceActive({ id: 'p-new', at: T0 }, 'p-new', T0 + 200)).toBe(true);
    // Still inside the window at 14s — cache TTL (5s) + poll (2.5s) both comfortably covered.
    expect(activationGraceActive({ id: 'p-new', at: T0 }, 'p-new', T0 + 14_000)).toBe(true);
  });

  it('lets a genuinely dead id heal once the window lapses — the guard delays, never disables', () => {
    expect(activationGraceActive({ id: 'p-gone', at: T0 }, 'p-gone', T0 + 15_000)).toBe(false);
  });

  it('never shields an id that was not the one locally activated', () => {
    // The stale-id case the reconciliation exists for: a different id went stale in the
    // background. No local activation of THAT id → no grace, heal immediately.
    expect(activationGraceActive({ id: 'p-other', at: T0 }, 'p-stale', T0 + 100)).toBe(false);
  });

  /**
   * WP-CCD (review fix, found via real screenshot verification, 2026-09-28): the COLD-START bug this
   * pins — never covered by the three tests above, all of which start from a genuine, non-empty
   * activation. `PrototypeProvider.tsx`'s ref-sync effect used to record `{id: activeProjectId, at:
   * Date.now()}` UNCONDITIONALLY, including for the transient cold-start `activeProjectId === ''`
   * (which fires on the very first mount, before any project was ever chosen) — that made THIS
   * function see `last.id === activeId` (`'' === ''`) with an `at` of "just now", holding its 15s
   * grace window open against the very first real project pick. Measured live: with a real gateway,
   * `/api/agents`/`/api/runs` for the real default project were never even requested for a full 15
   * seconds after a cold load — every project-scoped view showed a false "0 agents" empty state that
   * had nothing to do with real data availability (confirmed present and fast the whole time). The
   * fix (in `PrototypeProvider.tsx`) is to never record the empty id as a "local activation" in the
   * first place — this test pins the CONTRACT that makes that fix correct: once the empty id is never
   * recorded, `last` stays at its true initial `{id: '', at: 0}` (an epoch timestamp far outside any
   * real grace window), so grace must read `false` from t=0, not `true` for the first 15 real seconds.
   */
  it('COLD START: an activeId that was never locally recorded (last stays at its initial {id:"", at:0}) never gets a grace window at any REAL epoch "now"', () => {
    // A real `Date.now()` is always a large epoch value, never near 0 — `now - 0` is therefore always
    // far outside GRACE_MS, so grace correctly reads false from the very first tick onward.
    expect(activationGraceActive({ id: '', at: 0 }, '', T0)).toBe(false);
    expect(activationGraceActive({ id: '', at: 0 }, '', Date.now())).toBe(false);
  });
});
