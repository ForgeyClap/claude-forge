# RESUME — where the connected build stands, and exactly what comes next

Written 2026-07-24 when the owner paused on a usage limit. The mission is
autonomous ("continue through WP12, do not ask to type continue"). On the next
message, resume from **"Next actions"** below without re-planning.

## One-line status

The bridge drives the real Claude Code CLI end to end (proven, exit 0). 8 of 12
work packages are done or substantially done. Remaining: finish the frontend
wiring, WP10 (approvals/recovery), the rest of WP11 (the test program), WP12
(certification + report).

## Verified state at the last commit (`fcb28f4`)

| Gate | Command | Result |
| --- | --- | --- |
| Theme drift | `npm run theme:check` | in sync |
| Types | `npx tsc --noEmit` | 0 errors |
| Lint | `npx eslint .` | 0 errors |
| Unit + chaos + property | `npx vitest run` | 260/260 |
| Security | `npx vitest run --config vitest.security.config.ts` | 300 pass / 3 skip |
| End-to-end | `node artifacts/e2e-claude-code-probe.mjs` (bridge on :4600) | exit 0, token FORGE_E2E_OK streamed |
| Bundle | `npm run build` | 690 KB JS / 202 KB gzip |

Git: `baseline-prototype` → `9cdbf93` → `d860451` → `fcb28f4`. No remote. Clean
worktree. Rollback: `git reset --hard baseline-prototype`.

## Environment (all portable, on the user PATH — nothing registered with Windows)

- Node v24.18.0 — `%LOCALAPPDATA%\Programs\nodejs` — runs `.ts` directly.
- Git 2.55.0 — `%LOCALAPPDATA%\Programs\MinGit\cmd`.
- Claude Code CLI 2.1.217 — `%APPDATA%\Claude\claude-code\2.1.217\claude.exe`, authenticated, no API key.
- Every terminal turn must prepend PATH:
  `$env:PATH = "$env:LOCALAPPDATA\Programs\nodejs;$env:LOCALAPPDATA\Programs\MinGit\cmd;$env:PATH"`
- `--max-turns` does NOT exist in 2.1.217. Never use it.

## What is DONE

- WP0 backup + git baseline + rollback (`docs/WP0-baseline-and-rollback.md`)
- WP1 the contract (`src/shared/protocol.ts`, `src/shared/state-machines.ts`)
- WP2–WP5 bridge core: path guard, storage/event-log, Claude adapter, registry,
  attachments, usage aggregator, server on 127.0.0.1 (`src/bridge/**`)
- WP6 conversations + sessions + runs (real, streaming, resumable)
- WP8 all 39 operations registered (`src/bridge/operations/*.ts`)
- WP9 product discovery (`product/feature-opportunity-matrix.json`, `feature-roadmap.md`)
- Parts of WP11: security suite (G), chaos (H), property (M)
- WP12 partial: bundle −44%, sidebar contrast fix, react-refresh warnings gone
- Declarations split INVARIANT (static-proved) / DERIVED (computed with evidence)

## Owner instruction (2026-07-24, ~21:00) — resume at 21:15 with cheaper models

The owner is at a usage limit and wants work to resume at 21:15. A scheduled CLOUD
routine cannot do this work (it has no access to the local machine / local Claude
Code, and the repo has no GitHub remote), so none was created. The resume path is:
the owner sends ANY message at 21:15 and this session continues from the two
remaining items below.

**MODEL PREFERENCE for the remaining work: use Sonnet and Haiku for subagents**
(pass `model: 'sonnet'` or `model: 'haiku'` on `agent()` calls), not Opus — the
owner asked for the cheaper tiers to conserve usage. Reserve the highest tier only
if a task genuinely fails on the lower one.

Two items remain toward full CERTIFIED FOR LOCAL USE (see docs/FINAL-REPORT.md §58):
1. **Full multi-agent Forge orchestration run** — drive a real Forge mission through
   the connected bridge so agent.activated / verify.verdict / skill.used events
   populate, and verify the causality. Needs the local Claude Code (subscription).
2. **Mutation testing** — add Stryker (a dependency), run a scoped pass over the
   state machines / path guard / permission rules, report the score.

Execution policy is now RemoteSigned (CurrentUser), so `npm run ...` works in a
fresh PowerShell. Launcher: double-click `start-forge.cmd`.

## Next actions, in order (resume here)

1. **Finish frontend wiring (WP8 tail).** Verify each view under `src/views/**`
   reads from the live store (`src/prototype/state/live-store.ts` +
   `bridge-client.ts`) and renders real empty states in production mode. The
   production data gate is at `src/prototype/data/index.ts`; fixtures moved to
   `src/prototype/fixtures/`. Wire `ConnectionBanner` into `AppShell`.
2. **Wire the two remaining declaration observers into `src/bridge/main.ts`.**
   `observeUsageSnapshots` and `observeAttachmentStaging` exist in
   `src/bridge/health.ts` but are not passed to `router.declarationSources`
   (main.ts ~line 349 explains why they were left out). Pass a live
   `UsageAggregator` and `AttachmentPipeline` instance so
   `USES_REAL_USAGE_TELEMETRY` and `SUPPORTS_FILE_ATTACHMENTS` can derive true.
3. **Add the live usage bar above the chat (WP4 UI).** The telemetry is real
   (`claude.usage` events carry EXACT input/output/cache tokens + contextWindow).
   Build the bar to read `getUsageState`, with the accuracy labels and the
   "Plan usage is not exposed by the local Claude Code runtime." line.
4. **WP10** owner approvals wired to a WAITING_FOR_PERMISSION gate, crash
   recovery drills (reconcileOnStartup already exists), backup/restore commands.
5. **WP11 rest**: integration, E2E (Playwright against the connected app),
   negative, load/perf, visual (recapture screenshots), accessibility, mutation
   (needs Stryker — an added dependency; flag its cost), fuzz/property extension,
   idempotency, and the real-world certification run.
6. **WP12**: fix any critical/high defect found, re-run affected suites, the
   58-point final report, the mechanically-verified declarations, the verdict.

## Cost note for the owner

The certification run (WP11-O) starts real Claude Code sessions and consumes the
subscription. That is required by the mission but is not free. Mutation testing
(Stryker) is slow and adds a dependency.

## Housekeeping done at pause

- Bridge stopped cleanly (no orphan node/Claude process, lock on
  `.forge-workspace` released).
- 3 test projects created under `Documents/ForgeProjects` during the e2e proof
  were removed; that folder is empty again.
