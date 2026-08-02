/**
 * Forge Workspace — the single source of truth for run mode.
 *
 * PRODUCTION IS THE DEFAULT. Example/fixture data is a build you have to ask for
 * twice, on purpose:
 *
 *   1. AT BUILD TIME  — the Vite env var `VITE_FORGE_FIXTURES` must be baked into
 *      the bundle as the exact string "true". An unset or any other value is off.
 *   2. AT RUN TIME    — something must call `allowFixtureData()` explicitly. This
 *      never happens on its own, so a fixture bundle that ships without the
 *      opt-in still runs as production (fail-closed).
 *
 * Only when BOTH gates are open does the mode resolve to 'fixtures'. Anything
 * else — a missing env var, a missing opt-in, a stray value — is 'production',
 * and in production no example record may load.
 *
 * This module reads `import.meta.env` LAZILY (inside the functions, never cached
 * at module scope) so the value is whatever the running build/test actually has,
 * and so a test can flip it with `vi.stubEnv` and see the effect.
 *
 * There is no network, no filesystem and no process here. It is arithmetic over
 * two booleans.
 */

export type ForgeMode = 'production' | 'fixtures';

/** The build-time env var that arms the first gate. */
export const FIXTURE_ENV_KEY = 'VITE_FORGE_FIXTURES';

/** The exact value that arms it. Nothing else counts as "on". */
export const FIXTURE_ENV_ON = 'true';

/**
 * The hard policy. Mock/example data is NEVER permitted to reach a production
 * code path. This is a constant, not a setting: flipping it is a code change a
 * reviewer sees in the diff, and `guardFixtureLoad` below turns it into runtime
 * behaviour rather than a decorative declaration.
 *
 * It mirrors the bridge-side invariant of the same name in `src/shared/protocol.ts`.
 */
export const PRODUCTION_MOCK_DATA_ALLOWED = false;

/* --------------------------------------------------------------- build gate */

/**
 * Reads the fixture env var out of `import.meta.env`. Tolerates a runtime where
 * `import.meta.env` is absent (plain Node) by returning undefined rather than
 * throwing. Read through a cast so the module needs no ambient `vite/client`
 * types, which the project's tsconfig deliberately does not pull in.
 */
function readFixtureEnvValue(): string | undefined {
  try {
    const meta = import.meta as unknown as {
      readonly env?: Readonly<Record<string, unknown>>;
    };
    const value = meta.env?.[FIXTURE_ENV_KEY];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** True only when the build baked in `VITE_FORGE_FIXTURES=true`. The first gate. */
export function fixtureBuildFlag(): boolean {
  return readFixtureEnvValue() === FIXTURE_ENV_ON;
}

/* ------------------------------------------------------------- runtime gate */

/**
 * The second gate. Starts closed and stays closed until code explicitly opens
 * it. Module-private so it can only be changed through the two functions below,
 * never poked from the outside.
 */
let runtimeOptIn = false;

/**
 * Explicit runtime opt-in to fixture data. A test, the theme showcase, or a load
 * harness calls this before the workspace dataset is read. Absent this call the
 * build-time flag alone does nothing — that is the point of a second gate.
 */
export function allowFixtureData(): void {
  runtimeOptIn = true;
}

/** Closes the runtime gate again. Restores the fail-closed default. */
export function disallowFixtureData(): void {
  runtimeOptIn = false;
}

/** Whether the runtime gate is currently open. */
export function isFixtureDataAllowed(): boolean {
  return runtimeOptIn;
}

/* ------------------------------------------------------------- resolved mode */

/**
 * The resolved mode. Fixtures require BOTH gates open AND the policy to permit
 * them; anything short of that is production. Read live every call.
 */
export function resolveMode(): ForgeMode {
  const bothGatesOpen = fixtureBuildFlag() && runtimeOptIn;
  return bothGatesOpen ? 'fixtures' : 'production';
}

export function isProductionMode(): boolean {
  return resolveMode() === 'production';
}

export function isFixtureMode(): boolean {
  return resolveMode() === 'fixtures';
}

/* ------------------------------------------------------------- the tripwire */

/**
 * Thrown when example/fixture data is reachable in a production build. It is a
 * distinct class so a caller (and a test) can assert on the failure precisely
 * rather than on a message substring.
 */
export class ProductionFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionFixtureError';
  }
}

/**
 * The point where PRODUCTION_MOCK_DATA_ALLOWED stops being a declaration and
 * becomes behaviour. Call it on any path that is ABOUT to hand back fixture
 * data. In fixtures mode it returns quietly. In production it consults the
 * policy, finds it false, and FAILS LOUDLY — it does not warn and continue.
 */
export function guardFixtureLoad(where: string): void {
  if (isFixtureMode()) return;
  if (PRODUCTION_MOCK_DATA_ALLOWED) return;
  throw new ProductionFixtureError(
    `Forge: refusing to load example/fixture data in a production build (at ${where}). ` +
      'PRODUCTION_MOCK_DATA_ALLOWED is false, and fixtures require BOTH ' +
      `${FIXTURE_ENV_KEY}=${FIXTURE_ENV_ON} at build time AND an explicit allowFixtureData() ` +
      'opt-in at run time. Neither the build flag nor the runtime opt-in is set. ' +
      'This is a hard stop: example data must never render as if it were real.',
  );
}
