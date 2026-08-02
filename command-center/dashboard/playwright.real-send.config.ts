import { defineConfig, devices } from '@playwright/test';

/**
 * REAL-SEND — the ONE deliberately non-mocked e2e path (WP7c).
 *
 * This is NOT part of the default `npm run test:e2e` suite (see
 * `playwright.config.ts`'s own cost-guard header) and is never invoked
 * automatically by any script, hook, or CI job in this project. It exists so
 * the one genuinely real `claude` CLI round trip this codebase intentionally
 * validates from time to time (mirroring the WP4/WP7b real-call precedents
 * recorded in `mission/MISSION_LEDGER.md`) has an explicit, clearly-labelled
 * home instead of accidentally living inside the always-mocked default suite.
 *
 * Running this config WILL spawn a real, billable `claude` CLI process if one
 * is resolvable on this machine (`CC_EXEC_MOCK` is deliberately NOT set here).
 * Only run it by hand, on purpose: `npm run test:e2e:real-send`.
 *
 * Requirements before running by hand:
 *   1. `npm run build` — a fresh `dashboard/dist` (this config serves it
 *      through the real gateway, same as the default config).
 *   2. No other process already bound to `:4100` — `reuseExistingServer:
 *      false` fails loudly rather than silently reusing an unknown gateway.
 *   3. A real `claude` CLI resolvable on PATH (`where`/`which claude`) with a
 *      signed-in local session — this is the SAME local session the rest of
 *      this project already uses, never an API key.
 */
export default defineConfig({
  testDir: './tests/e2e-real',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://127.0.0.1:4100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--hide-scrollbars', '--force-prefers-reduced-motion'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'node ../gateway/bin.mjs',
    url: 'http://127.0.0.1:4100/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    // Explicit CC_EXEC_MOCK: '0' (Codex F9) rather than an empty env object — an empty `env: {}`
    // here still merges with (rather than fully replacing) the PARENT process's own environment per
    // Playwright's webServer semantics, so if whatever shell later runs this config happens to have
    // CC_EXEC_MOCK=1 set (e.g. a CI harness, or a stray leftover from an earlier mocked run in the
    // SAME terminal), an empty `env: {}` would silently inherit that and turn this "the one
    // deliberately real config" file into another mocked run without any visible error. Setting it
    // explicitly to '0' guarantees the real-send suite is ALWAYS truly real, never silently mocked.
    env: { CC_EXEC_MOCK: '0' },
  },
});
