/**
 * WP-P1 (Forge v2.9.0, "the Command Center works after a fresh install") — the dashboard-side
 * half of "the wrapper's FORGE_CC_DEFAULT_PROJECT becomes the default project when known":
 *
 *   1. `parseDefaultProjectId` (rows.ts) — a plain, honest passthrough of the gateway's
 *      `default_project_id` sibling field on `GET /api/projects`'s payload.
 *   2. `resolveFallbackProjectId` (PrototypeProvider.tsx) — the pure decision
 *      `ProductionProvider`'s cold-start reconciliation effect dispatches: prefer the wrapper's
 *      default project over `projects[0]`, but ONLY when it names a project actually present
 *      right now.
 *
 * `resolveFallbackProjectId` is tested directly, as its own pure function, rather than through a
 * full `<PrototypeProvider>` mount — same reasoning `activation-grace.test.ts` already documents
 * for `activationGraceActive`: mounting the real provider from a cold `activeProjectId === ''`
 * races a SEPARATE mount-time effect that seeds `lastActivationRef` to `{ id: '', at: <mount
 * time> }`, which makes `activationGraceActive` hold the grace window open for its own full 15s
 * from mount — a real integration test would have to fake-advance a clock rather than exercise
 * the decision this function actually makes. (`fix-activation-race.test.tsx`'s own mounted tests
 * sidestep this the same way real usage does not: by manually dispatching `project/activate`
 * right after mount, rather than relying on the cold-start auto-pick.) See
 * `resolveFallbackProjectId`'s own doc comment in `PrototypeProvider.tsx` for the full rationale.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { parseDefaultProjectId } from '@/prototype/state/adapter/rows';
import { readRememberedProjectId, resolveFallbackProjectId, writeRememberedProjectId } from '@/prototype/PrototypeProvider';

describe('parseDefaultProjectId', () => {
  it('a present, non-empty string is read back verbatim', () => {
    expect(parseDefaultProjectId({ ok: true, projects: [], default_project_id: 'my-site' })).toBe('my-site');
  });

  it('an absent field reads back null, never fabricated', () => {
    expect(parseDefaultProjectId({ ok: true, projects: [] })).toBeNull();
  });

  it('an explicit null on the wire reads back null', () => {
    expect(parseDefaultProjectId({ ok: true, projects: [], default_project_id: null })).toBeNull();
  });

  it('a non-string value on the wire is never trusted — reads back null', () => {
    expect(parseDefaultProjectId({ ok: true, projects: [], default_project_id: 42 })).toBeNull();
  });
});

describe('resolveFallbackProjectId', () => {
  const PROJECTS = [{ id: 'proj-a' }, { id: 'proj-b' }];

  it('with no defaultProjectId at all, the first project wins — the exact pre-WP-P1 behaviour', () => {
    expect(resolveFallbackProjectId(PROJECTS, undefined)).toBe('proj-a');
    expect(resolveFallbackProjectId(PROJECTS, null)).toBe('proj-a');
  });

  it('a defaultProjectId naming a REAL, present project wins over the first project', () => {
    expect(resolveFallbackProjectId(PROJECTS, 'proj-b')).toBe('proj-b');
  });

  it('a defaultProjectId naming a project NOT in the current list falls back to the first project — never an unknown id', () => {
    expect(resolveFallbackProjectId(PROJECTS, 'proj-does-not-exist')).toBe('proj-a');
  });

  it('an empty-string defaultProjectId is treated the same as absent, never matched against anything', () => {
    expect(resolveFallbackProjectId(PROJECTS, '')).toBe('proj-a');
  });
});

/**
 * WP-CCD (item 7): the owner's OWN last-chosen project (this browser's own `localStorage`) now wins
 * over even the wrapper default — see `resolveFallbackProjectId`'s own updated doc comment.
 */
describe('resolveFallbackProjectId — remembers the owner\'s own last choice (WP-CCD item 7)', () => {
  const PROJECTS = [{ id: 'proj-a' }, { id: 'proj-b' }];

  it('a remembered project naming a REAL, present project wins over BOTH the default and the first project', () => {
    expect(resolveFallbackProjectId(PROJECTS, 'proj-a', 'proj-b')).toBe('proj-b');
  });

  it('a remembered project naming a project NOT in the current list falls back to defaultProjectId', () => {
    expect(resolveFallbackProjectId(PROJECTS, 'proj-a', 'proj-does-not-exist')).toBe('proj-a');
  });

  it('with no remembered project at all, defaultProjectId still wins — unchanged pre-existing behaviour', () => {
    expect(resolveFallbackProjectId(PROJECTS, 'proj-b', null)).toBe('proj-b');
    expect(resolveFallbackProjectId(PROJECTS, 'proj-b', undefined)).toBe('proj-b');
  });

  it('with neither remembered nor default, the first project still wins — unchanged pre-existing behaviour', () => {
    expect(resolveFallbackProjectId(PROJECTS, null, null)).toBe('proj-a');
  });
});

describe('readRememberedProjectId / writeRememberedProjectId — best-effort localStorage round-trip', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('nothing remembered yet reads back null, never a guess', () => {
    expect(readRememberedProjectId()).toBeNull();
  });

  it('a written project id round-trips through a real read', () => {
    writeRememberedProjectId('proj-b');
    expect(readRememberedProjectId()).toBe('proj-b');
  });

  it('writing an empty string is a deliberate no-op — never overwrites a real previous choice with nothing', () => {
    writeRememberedProjectId('proj-b');
    writeRememberedProjectId('');
    expect(readRememberedProjectId()).toBe('proj-b');
  });

  it('a stored empty string reads back null (defensive: treated the same as "nothing remembered")', () => {
    window.localStorage.setItem('forge.activeProjectId', '');
    expect(readRememberedProjectId()).toBeNull();
  });
});
