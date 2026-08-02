/// <reference types="node" />
/**
 * Forge Workspace — the LOAD and PERFORMANCE suite's own vitest project
 * (mission section I).
 *
 * Separate from `vite.config.ts` on purpose, for the same reasons the security
 * suite is separate:
 *
 *  1. IT MUST NOT MOVE THE HEADLINE NUMBER. `npm test` reports a fixed unit /
 *     chaos / property count that other people quote. A performance suite whose
 *     timings vary run to run has no business changing that number, so it lives
 *     under its own config and its own command:
 *         npx vitest run --config vitest.load.config.ts
 *
 *  2. ENVIRONMENT. These tests drive the real durable store (`node:fs`, real
 *     temp dirs) and the real transport client. `node` is the honest environment;
 *     the graph-layout function it also exercises falls back to its token
 *     defaults when `document` is absent, which is exactly what happens here.
 *
 *  3. ISOLATION. `pool: 'forks'` gives each file its own process, so a 100k-event
 *     burst in one file cannot perturb the timings measured in the other.
 *
 * WHAT THIS SUITE IS, AND IS NOT. Every event pushed through it is CLEARLY
 * LABELLED SYNTHETIC. It measures rendering and throughput; it is NOT evidence
 * that any real Claude Code run happened. The measurements are written to a temp
 * JSON that `scripts/perf-report.cjs` folds into `artifacts/perf-report.json`.
 *
 * The react plugin is present because `rendering.test.ts` imports the real
 * `renderMarkdown` (a .tsx module); it never renders to a DOM, it only builds
 * the element tree, so `node` is sufficient.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// fileURLToPath, not URL.pathname — the pathname is percent-encoded and this
// project lives in a directory whose name contains a space.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
      '@brand': path.resolve(here, 'brand'),
    },
  },
  test: {
    name: 'load',
    environment: 'node',
    globals: false,
    include: ['tests/load/**/*.test.ts'],
    // The jsdom setup file installs shims these tests neither need nor should
    // stand on. Explicitly empty.
    setupFiles: [],
    restoreMocks: true,
    // A durable append fsyncs per line, and a burst is thousands of them. Give
    // the honest measurement room rather than time it out into a false failure.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    // A load suite that reports "0 tests" must not be mistaken for a clean run.
    passWithNoTests: false,
    reporters: ['verbose'],
  },
});
