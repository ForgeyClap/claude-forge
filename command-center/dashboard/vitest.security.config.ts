/// <reference types="node" />
/**
 * Forge Workspace — the SECURITY suite's own vitest project.
 *
 * Deliberately separate from `vite.config.ts` for four reasons, none of them
 * cosmetic:
 *
 *  1. ENVIRONMENT. The unit suite runs in jsdom because it tests React state.
 *     These tests drive the real path guard against the real filesystem —
 *     temporary roots, junctions, symlinks — and jsdom's globals buy nothing
 *     there. `node` is the honest environment for a filesystem guard.
 *
 *  2. ISOLATION. `pool: 'forks'` with `singleFork: false` gives each file its own
 *     process. A test that creates a junction, or that a future fuzzer makes
 *     crash the worker, cannot then corrupt an unrelated suite's result.
 *
 *  3. RUNNABLE ALONE. `npx vitest run --config vitest.security.config.ts` is one
 *     command with one answer. A security suite that can only be run as part of
 *     a 90-second full build is a security suite that stops being run.
 *
 *  4. NO SETUP FILE. `tests/setup.ts` installs jsdom shims and Testing Library
 *     cleanup. None of it applies here, and a shim that silently changes global
 *     behaviour is the last thing a security assertion should be standing on.
 *
 * `globals: false` on purpose: every `describe`/`it`/`expect` is imported by
 * name, so there is no ambient magic between the assertion and the thing it is
 * asserting about.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// fileURLToPath, not URL.pathname — the pathname is percent-encoded and this
// project lives in a directory with a space in its name.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
      '@brand': path.resolve(here, 'brand'),
    },
  },
  test: {
    // HONEST NAME (system-checkup finding, 2026-07-30): this suite's every test
    // file imports `@/bridge/**` (router, security/paths, storage/store,
    // attachments, claude adapter) — the WebSocket bridge the shipped product
    // never runs. Called plain `security`, a green line here read as "the live
    // Command Center's security is verified", which it is not: the LIVE security
    // coverage is `gateway/test/security.test.mjs`, `static-security.test.mjs`,
    // `recovery-redaction.test.mjs` and `chaos.test.mjs` (the gateway suite).
    // The suite still runs on every `npm run verify` — nothing was removed or
    // weakened — it just no longer claims to be about the live path.
    name: 'legacy-bridge-paths',
    environment: 'node',
    globals: false,
    include: ['tests/security/**/*.test.ts'],
    // Explicitly empty: the jsdom setup file must not run here.
    setupFiles: [],
    restoreMocks: true,
    // Real filesystem work, plus one optional probe that spawns the real CLI.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    // A security suite that reports "0 tests passed" must not be mistaken for a
    // clean run.
    passWithNoTests: false,
    reporters: ['verbose'],
  },
});
