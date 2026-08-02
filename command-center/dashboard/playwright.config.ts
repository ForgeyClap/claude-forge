import { defineConfig, devices } from '@playwright/test';

/**
 * The default (cost-safe) e2e suite.
 *
 * WP7c COST GUARD — read this before touching `webServer` or `baseURL` again.
 *
 * Before this change, this config served the prototype through Vite's own
 * static preview (`:4173`), disconnected from the real gateway. WP7b's own
 * validation of the gateway-adapter had to re-run the suite by hand against
 * the REAL gateway on `:4100` instead (the gateway's own CORS allowlist in
 * `gateway/src/security.mjs` only accepts `:4100`/`:5173` — a cross-origin
 * fetch from `:4173` is rejected, so the connected state can only be tested
 * same-origin with the gateway). That manual run is exactly what caused a
 * real, costly `claude` CLI invocation ($1.11, see `mission/MISSION_LEDGER.md`
 * WP7b entry) when `no-network.spec.ts`'s "sending a chat message" test fired
 * the production send-path against a REAL, non-mocked gateway.
 *
 * The fix: this config now starts the REAL gateway itself
 * (`node ../gateway/bin.mjs`), same-origin, with `CC_EXEC_MOCK=1` forced via
 * `webServer.env` — the exact env var `gateway/src/exec-bridge.mjs` documents
 * as "used by every automated test" (a fixed, argv-echoing mock script; ZERO
 * real `claude` invocations, ever, regardless of which spec runs).
 *
 * `reuseExistingServer: false` is DELIBERATE and must never become
 * conditional on `process.env.CI` here (unlike a normal dev-convenience
 * server): if a developer already has a REAL, non-mocked gateway bound to
 * `:4100` (e.g. via `/forge dashboard`), Playwright must FAIL LOUDLY on the
 * port conflict rather than silently reusing that real gateway — reusing it
 * is exactly the scenario that cost real money. Fail-closed, not reuse-open.
 *
 * For the ONE deliberately real-call spec, see `playwright.real-send.config.ts`
 * and `npm run test:e2e:real-send` — never part of this default suite.
 *
 * OPT-IN REUSE FLAG (test-e2e-composer, forge-2026-07-29-cc-finish): `CC_E2E_REUSE_LIVE_GATEWAY=1`
 * is the ONE narrowly-scoped, explicit, manual override this file grants — for the documented case
 * where a person is already running a real (non-mocked) gateway on `:4100` (e.g. via `/forge
 * dashboard`) and wants to run e2e specs against THAT session instead of failing loudly on the port
 * conflict. Unset (the default, every CI run, every plain `npm run test:e2e`), `reuseExistingServer`
 * stays `false` exactly as the header above mandates — this flag changes NOTHING by default. Set, it
 * only ever REUSES an already-healthy `:4100` (Playwright's own `reuseExistingServer:true` contract:
 * it health-checks the url first and only reuses if that already responds — it never silently starts
 * a second process, and never silently adopts an unhealthy one). Whether that reused session is
 * itself mocked or real is then whatever it already was — the specs written for this suite
 * (composer mentions/slash-commands/modes/queue/delete, `tests/e2e/composer-*`,
 * `tests/e2e/conversation-delete.spec.ts`) only ever assume the real API contract, never which
 * backend answered it, so they run correctly either way.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : 4,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    // Same-origin with the gateway (see header) — required for the connected
    // state to actually connect under the gateway's own CORS allowlist.
    baseURL: 'http://127.0.0.1:4100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Deterministic screenshots: no caret blink, no scrollbar drift.
    launchOptions: { args: ['--hide-scrollbars', '--force-prefers-reduced-motion'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    // Assumes `npm run build` already produced `dashboard/dist` — the same
    // assumption the old `npm run preview`-based command made (preview never
    // rebuilds either); no new pre-requirement introduced.
    command: 'node ../gateway/bin.mjs',
    url: 'http://127.0.0.1:4100/api/health',
    // NEVER `!process.env.CI` here — see the cost-guard header above. The one exception is the
    // explicit, manual `CC_E2E_REUSE_LIVE_GATEWAY=1` opt-in documented in this file's own header —
    // never `process.env.CI`, never on by default.
    reuseExistingServer: process.env.CC_E2E_REUSE_LIVE_GATEWAY === '1',
    timeout: 120_000,
    env: { CC_EXEC_MOCK: '1' },
  },
});
