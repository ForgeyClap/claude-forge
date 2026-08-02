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
});
