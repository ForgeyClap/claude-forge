/**
 * Proves the fixture path still works after the fix-cert-fixtures split
 * (forge-2026-07-29-cc-finish, certification finding #5): `PrototypeProvider`'s
 * fixture branch now renders through `React.lazy` + `Suspense` instead of a
 * plain top-level import (see `PrototypeProvider.tsx` and `state/fixture-
 * provider.tsx`'s headers). That changed WHEN the fixture dataset becomes
 * available (after one microtask/dynamic-import tick instead of on the very
 * first render) without changing WHAT is available once it resolves — this
 * suite is the regression proof for that claim, mounting the REAL
 * `<PrototypeProvider>` component (not a hand-built context stub), the same
 * way `composer-write-scope.test.tsx` already does for the production path.
 *
 * Fixture mode makes no network/DOM call beyond `matchMedia` (already
 * polyfilled in `tests/setup.ts`). The production-mode mount below DOES go
 * through `ProductionProvider`'s real gateway hooks, so it installs the same
 * kind of harmless `fetch` stub `composer-write-scope.test.tsx` already uses —
 * never the real local gateway, per this project's own "a unit test must not
 * couple to a live process" convention (`gwGet`/`gwEventSource` already
 * try/catch every transport failure, so this is belt-and-braces determinism,
 * not a crash-prevention workaround).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import {
  FIXTURE_ENV_KEY,
  FIXTURE_ENV_ON,
  allowFixtureData,
  disallowFixtureData,
} from '@/config/mode';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';
import { usePrototype } from '@/prototype/state/prototype-store';
import { FIXTURE_DATASET } from '@/prototype/fixtures';

/** A minimal real consumer — the same pattern every view uses via `usePrototype()`. */
function ProjectCountProbe() {
  const { state } = usePrototype();
  return createElement('span', { 'data-testid': 'project-count' }, String(state.data.projects.length));
}

/** A harmless stand-in for every gateway route — never the real 127.0.0.1:4100. */
function installHarmlessFetchStub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
  );
}

beforeEach(() => {
  disallowFixtureData();
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
  disallowFixtureData();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('fixture mode still renders real example data through the lazy Suspense boundary', () => {
  it('resolves to the real, non-empty FIXTURE_DATASET project count once the lazy chunk settles', async () => {
    vi.stubEnv(FIXTURE_ENV_KEY, FIXTURE_ENV_ON);
    allowFixtureData();

    render(createElement(PrototypeProvider, null, createElement(ProjectCountProbe)));

    // The Suspense fallback is `null`, so there is nothing to assert about the
    // interim frame — only that the real count eventually appears.
    await waitFor(() => {
      expect(screen.getByTestId('project-count').textContent).toBe(String(FIXTURE_DATASET.projects.length));
    });
    expect(FIXTURE_DATASET.projects.length).toBeGreaterThan(0);
  });
});

describe('production mode never takes the lazy fixture path', () => {
  it('mounts ProductionProvider synchronously — no Suspense fallback is ever observed', async () => {
    // Neither gate is armed (see beforeEach) — the default for every test here.
    installHarmlessFetchStub();
    const { container } = render(createElement(PrototypeProvider, null, createElement(ProjectCountProbe)));
    // A real (empty) count is available on the very first render — no `await`,
    // no `waitFor`: production never routes through `<Suspense>` at all.
    expect(container.querySelector('[data-testid="project-count"]')?.textContent).toBe('0');

    // Let the stubbed fetch's already-in-flight promise settle inside `act`
    // before the test ends, so its state update is not reported against the
    // NEXT test (composer-write-scope.test.tsx's own `flush()` does the same).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  });
});
