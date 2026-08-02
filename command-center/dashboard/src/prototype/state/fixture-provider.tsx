/**
 * Forge Workspace — the fixture-mode provider, loaded lazily on purpose.
 *
 * fix-cert-fixtures (forge-2026-07-29-cc-finish), certification finding #5:
 * "no fixture module is imported by production-rendering code — enforce with
 * an import-graph test." Before this split, `PrototypeProvider.tsx` imported
 * `PROTOTYPE_DATASET` from `@/prototype/data` at its TOP LEVEL — a plain static
 * ES import. Vite/Rollup bundles a static import unconditionally, regardless of
 * which runtime branch actually uses the binding: the `production` ternary in
 * `PrototypeProvider` is a RUNTIME value (`isProductionMode()` also depends on
 * a mutable runtime opt-in, not just the build-time env flag), so it can never
 * be proven false at build time and the FixtureProvider branch — and therefore
 * the whole 18-agent/conversation/task/etc. example dataset behind it — shipped
 * inside the SAME entry chunk every real user downloads. `tests/unit/fixture-
 * import-graph.test.ts` proves this class of leak directly, by walking the real
 * static import graph from `src/main.tsx`.
 *
 * The fix: this component now lives in its OWN module, reached only through
 * `React.lazy(() => import(...))` from `PrototypeProvider.tsx` — the exact
 * code-splitting mechanism `App.tsx` already uses for every route (see its own
 * WP11 header). A dynamic `import()` is a deliberate chunk boundary, not a
 * bundling edge, so Rollup puts this module — and everything it statically
 * imports, including `@/prototype/data` and the full fixture barrel behind it —
 * into a SEPARATE chunk that a real production build never fetches, because
 * `production` resolves `true` in every build this repo currently ships
 * (`VITE_FORGE_FIXTURES` is never set by any script here — see `config/mode.ts`).
 *
 * This changes NOTHING about behaviour once the dynamic import resolves: by the
 * time React actually renders this component, the module (and its own static
 * import of `PROTOTYPE_DATASET`) has already fully evaluated, so reading the
 * dataset here is exactly as synchronous as it was before the split — only
 * "should this code be fetched at all" became conditional, not "is the dataset
 * available once it runs."
 */

import { useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';

import { PROTOTYPE_DATASET } from '@/prototype/data';
import { createInitialState, useShellEffects } from '@/prototype/state/shell-effects';
import { PrototypeContext, reducer } from '@/prototype/state/prototype-store';
import type { StoreValue } from '@/prototype/state/prototype-store';

/** Fixtures: the original example-data reducer, untouched. */
function FixtureProvider({ children }: { children?: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => createInitialState(PROTOTYPE_DATASET));
  useShellEffects(state, dispatch);

  const value = useMemo<StoreValue>(() => ({ state, dispatch }), [state]);

  return <PrototypeContext.Provider value={value}>{children}</PrototypeContext.Provider>;
}

export default FixtureProvider;
