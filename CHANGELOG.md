# Changelog

All notable changes to **claude-forge** (Forge V2) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Nothing yet. Open a PR — see [CONTRIBUTING.md](CONTRIBUTING.md).

## [2.2.0] - 2026-08-04

Installing into a fresh project was structurally impossible, and the usage guard was watching the wrong
account. Both were found by running the system against itself; every fix below ships with a test that
first reproduces the defect.

### Fixed — installing into a new project

- **A fresh install validated itself against files that could only exist afterwards** and therefore
  rolled back all ~357 files, every time. The post-install doctor required a `CLAUDE.md`, `.gitignore`
  rules, a wrapper script that was never shipped, a **git repository**, and two assertions pinning the
  maintainer tree's exact state. The installer now seeds the environment its own validation checks
  (append-only `.gitignore`, create-only `CLAUDE.md` stub, both undone on rollback), environment tests
  skip honestly where their precondition is legitimately absent, and dev-tree-only assertions sit behind
  a marker file that is never shipped.
- **The leak scan walked Python virtualenvs**, reporting third-party docstrings (`user:pass@host`
  examples in fsspec/httpx/pandas) as credentials — enough to fail an entire install. Virtualenvs are now
  detected by `pyvenv.cfg` (whatever the directory is called) and skipped like `node_modules`; a real
  secret outside the venv is still caught.

### Fixed — usage guard

- **No account identity anywhere.** One state file served every account, so after switching accounts the
  guard kept deciding on the previous one's numbers, and a credits override bought on account A
  suppressed the guard on account B. The guard now fingerprints the account (a short digest — never a raw
  uuid, e-mail or token), detects a switch, and starts clean instead of inheriting.
- **Only two usage windows were read.** The API returns a typed `limits` array (session, weekly, and
  per-model scoped windows); everything outside the two legacy fields was invisible and could sit at 100%
  while the guard reported `ok`. All windows now count, are shown and are logged, typed and legacy are
  merged rather than one replacing the other, and a `null` percentage is no longer coerced into a
  confident `0%`.
- **A live PID counted as proof the watcher was working.** It could stop ticking while the process lived
  on. There is now a heartbeat, process-wide rejection/exception handlers, and an honest
  running/stale/not-running verdict.
- **`stop` could kill a recycled PID**, including its process tree. It now verifies the command line
  belongs to this watcher before killing anything, never tree-kills, and removes the PID file only once
  the process is confirmed gone.

### Fixed — honesty of what the system reports

- **A synthetic demo run counted as "the latest run"** for status, `open-report` and the dashboard header
  — pointing at a report that does not exist — and operational directories were listed as missions. Run
  listings now require run shape, order by real time, and never let a self-declared demo win "latest".
- Several tools resolved their event writer from their own install directory while accepting a `--root`,
  so running them against another project wrote that project's events into the tool's own tree.
- Machine-specific paths (a maintainer's username, one machine's Paperclip home and `claude` binary) were
  baked into shipped files — wrong everywhere else, and needlessly identifying. Per-install state files
  are no longer published at all.

## [2.1.0] - 2026-08-02

This release closes three defect classes that were **measured**, not guessed, in the system this repo is cut from.

### Added

- **The Forge Command Center now ships** (`command-center/`) — one zero-dependency Node gateway + React dashboard on `http://127.0.0.1:4100` that auto-discovers your Forge projects and shows strictly per-project data. It is the only layer allowed to spawn the real `claude` CLI. Build the SPA once (`cd command-center/dashboard && npm install && npm run build`), then run `node command-center/gateway/supervisor.mjs` (it restarts the gateway if it dies).
- **Run-contract gate with proof** — `forge-runcontract.cjs check --run <id> --log-event` now emits a `gate_evaluated` event through the one real writer, in the same act as the check. A gate that evaluates silently is indistinguishable from one that never ran.
- **`VENDORED-SKILLS.md`** — third-party skills this system uses internally are listed with their source and pinned commit instead of being redistributed here.

### Fixed

- **Agents did not create tasks.** Measured across 857 events in 29 runs: `gate_evaluated` had fired **0 times ever**, the run contract failed on 28 of 29 runs, and the system prompt appended to every dashboard-driven execution contained no obligation to create a work package, ticket, PRD or run id. Three layers each assumed another was enforcing. The gateway preamble now carries a **mission-ledger obligation** (mint a run id → log work packages *before* the work → log real events → run the contract gate before claiming done), the `/forge` command actually invokes the gate at completion, and the router's PRD step is a numbered obligation with a runnable command instead of a noun.
- **Documented commands that did not run as printed.** `forge-verify.cjs --run <id>` was documented but unparsed; `forge-heartbeat.cjs`, `forge-report.cjs`, `forge-sync.cjs` and `forge-intake.cjs` examples in the quick reference were missing required subcommands or arguments. A run id may no longer begin with `-`.
- **The retired dashboard was still advertised as current.** The per-project Control Center (ports 3737–3999) was being auto-started as a fallback in the very same tree whose rules call it retired, and the copy-paste mission template pointed users at it. It now starts only on an explicit `legacy dashboard` request. Its `log-event.cjs` is *not* retired and remains the per-project run-event writer.
- **Kill switch reported success as failure.** Stopping the supervisor cascades to its children, so their own `taskkill` answered "process not found" — and the switch printed `FAILED` for processes it had just stopped. The verdict now comes from whether the PID is actually gone. `restore` also never returned, because it started a long-lived daemon with a blocking call; it now spawns detached and clears its ledger.
- **README claimed screenshots that were not in the repo.**

### Known limitations — measured on this exact release tree, not estimated

Some tests in this repo pin facts about *a populated installation*. In a fresh clone they fail honestly rather than being silently skipped. None of them indicates broken code — each is listed here with its real cause so you can tell a genuine regression from an expected gap.

- **Gateway suite: 935 of 971 pass.** The 36 failures are integration tests that expect a real Forge workspace (e.g. *"at least the known ~15 real projects"*, real run artifacts). They pass in a real installation.
- **`forge-doctor` / `forge-configdrift` / `forge-contextbudget`: 5 failures** that all pin *"this project has 57 skills"*. This distribution ships 47, because 9 third-party skills are listed in `VENDORED-SKILLS.md` instead of redistributed. The number is right for the tree it was written against, not for this one.
- **`forge-run-budget`: 2 failures** referencing `maand-sweep.cmd` — a machine-specific scheduled-task wrapper that is deliberately not shipped.
- **Leak scan: 8 hits, all verified fixtures or pattern definitions**, and all inside `command-center/` — code this scanner had never seen before. In the development tree `command-center` is a nested git repository, so `git ls-files` never listed it and the scan reported "clean" over a tree that excluded the gateway entirely. Shipping it here as one repository is what made it visible. Each hit was read and confirmed: two redaction *patterns* (`attachments/policy.ts`, `projects/git.ts`), three test fixtures with obvious filler (`chat-run-diff.test.tsx`), a JWT-shaped fixture in the redaction-order test, and a mock PEM generator plus a comment quoting a marker (`exec-argv.mjs`, `exec-lifecycle.mjs`). The scanner's own way for a fixture to declare itself is to carry `FAKE`/`EXAMPLE`/`SAMPLE` inside the value — which a JWT fixture cannot do without ceasing to be JWT-shaped, so a blanket fix is not available. These are documented rather than silenced: bending a leak scanner to make a release look green is the exact reflex this project exists to avoid.
- **Everything else is green**, including `node --check` on all 203 sources, the honesty gate, the agent validation, and the no-op-test detector.

Fixing the first three properly means separating installation pins from unit tests, which is a real piece of work rather than a line in a changelog.

## [2.0.0] - 2026-07-18

First public open-source release of Forge V2 — a zero-dependency, multi-agent
build / automation / review / delivery system for Claude Code.

### Added

- **Four install methods** that all converge on one first-run funnel
  (`/setup-forge`):
  - **Claude Code plugin** (LITE) — `/plugin marketplace add ForgeyClap/claude-forge`
    then `/plugin install forge@claude-forge`; namespaced commands `/forge:forge`
    and `/forge:setup-forge`.
  - **One-line installer** (FULL) — `install.sh` (curl \| bash) and
    `install.ps1` (irm \| iex) with a merge-safe, backup-before-overwrite copy.
  - **Clone + run installer** — reviewable, with `--project`, `--yes`,
    `--dry-run`, `--global-only`, and `--project-only` flags.
  - **Manual copy** — documented baseline fallback.
- **`/setup-forge` onboarding wizard** — friendly first-run flow that asks your
  name, goal, project type, and preferred language, auto-detects repo signals,
  and is idempotent / self-healing on re-runs
  (`disable-model-invocation: true`, so it never auto-fires).
- **Beginner-safe key setup** — writes a temporary, already-gitignored
  `.env.forge-setup` fill-file with commented placeholders; on your "done"
  signal it moves real values into the gitignored `.env`, writes a
  values-free `.env.example`, and deletes the temp file. Keys are never
  committed and never echoed back.
- **18 Boss agents** — boss, build-boss, review-boss, test-boss, ui-boss,
  seo-boss, search-boss, security-boss, integration-boss, skill-boss,
  docs-boss, head-chef, codex-reviewer, data-scientist, electron-pro,
  mcp-developer, ml-engineer, and payment-integration.
- **23 skills** — including `forge-core`, the domain playbooks
  (`forge-website`, `forge-fullstack`, `forge-n8n`, `forge-rag`,
  `forge-scraping`, `forge-prediction`, `forge-integration`), plus
  `forge-router`, `forge-report`, `forge-verify`, `forge-registry`,
  `forge-prd`, `forge-intake`, `forge-graded-verify`, `forge-deeplearn`,
  `forge-heartbeat`, `forge-mindmap`, `forge-doctor`, `forge-agent-report`,
  `ship-readiness`, `humanizer`, and `gsap`.
- **Per-project isolated dashboard** — a local-only Control Center on a stable,
  path-derived port (3737–3999). Shows real activity only; never shared or
  global.
- **Honest agent ledger + reports** — every run records which agents really
  worked, with evidence, and no fabricated "done" claims.
- **`forge-doctor` self-test + secret/leak scan** — `node --check`s every
  source, runs the test suites, verifies the honesty gate, confirms the
  dashboard SPA is intact, and scans git-tracked files for leaked secrets.
- **Repo packaging** — MIT license, README, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/` templates and CI
  (`claude plugin validate . --strict`), and [ADR 0001](docs/adr/0001-plugin-vs-installer-split.md)
  recording the plugin-vs-installer split and the two ship invariants.

### Security

- Zero runtime dependencies (plain Node `.cjs`, POSIX `sh`, PowerShell,
  Markdown / JSON / YAML) — no supply-chain surface from npm packages or native
  modules.
- `.env` and the temporary fill-files are gitignored and never committed; the
  repo ships secret-free. See [SECURITY.md](SECURITY.md).

[Unreleased]: https://github.com/ForgeyClap/claude-forge/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/ForgeyClap/claude-forge/releases/tag/v2.0.0
