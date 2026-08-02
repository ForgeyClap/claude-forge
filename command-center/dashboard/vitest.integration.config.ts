/// <reference types="node" />
/**
 * Forge Workspace — the INTEGRATION suite's own vitest project.
 *
 * These tests do not import a single bridge module. They start the REAL bridge
 * (`node src/bridge/main.ts`) as a child process, pointed at throwaway temp
 * directories, and drive it over the real HTTP + WebSocket protocol — the same
 * two surfaces the browser uses. That makes them slow and stateful in a way the
 * unit, chaos, property and security suites deliberately are not, so they get
 * their own config and are never mixed into a fast run:
 *
 *  1. NODE, NO DOM. There is no React here and no jsdom. `node` is the only
 *     honest environment for a suite whose subject is a separate OS process.
 *
 *  2. SINGLE FORK, SEQUENTIAL. Each test starts and stops a real listener that
 *     takes an exclusive workspace lock. Running files in parallel would race
 *     two bridges over ports and locks for no benefit, so the pool is one fork
 *     and files run one at a time.
 *
 *  3. LONG TIMEOUTS. One test spawns a real Claude Code run (guarded to skip if
 *     the CLI is unauthenticated). A cold CLI start plus a model round-trip is
 *     measured in tens of seconds, not milliseconds, so the per-test budget is
 *     generous and the hook budget covers a real startup and a graceful stop.
 *
 *  4. RUNNABLE ALONE. `npm run test:integration` is one command with one answer.
 *
 *  5. NO SETUP FILE. `tests/setup.ts` installs jsdom shims and Testing Library
 *     cleanup; none of it applies to a child process spoken to over a socket.
 *
 * `globals: false` on purpose, matching the security suite: every
 * `describe`/`it`/`expect` is imported by name so nothing ambient sits between
 * an assertion and the running bridge it is asserting about.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// fileURLToPath, not URL.pathname — the pathname is percent-encoded and this
// project lives in a directory whose name contains a space.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
      '@brand': path.resolve(here, 'brand'),
    },
  },
  test: {
    name: 'integration',
    environment: 'node',
    globals: false,
    include: ['tests/integration/**/*.test.ts'],
    // Explicitly empty: the jsdom setup file must not run here.
    setupFiles: [],
    restoreMocks: true,
    // A real child bridge, a real CLI probe (up to ~130s to settle), and one
    // real model round-trip. The budget is the sum of those with headroom, so a
    // cold CLI never turns a passing run into a spurious timeout.
    testTimeout: 360_000,
    hookTimeout: 60_000,
    // One listener, one lock, one child at a time. No cross-file parallelism.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    fileParallelism: false,
    // A suite that silently runs zero tests must not read as a clean pass.
    passWithNoTests: false,
    reporters: ['verbose'],
  },
});
