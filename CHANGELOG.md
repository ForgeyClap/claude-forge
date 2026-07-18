# Changelog

All notable changes to **claude-forge** (Forge V2) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Nothing yet. Open a PR — see [CONTRIBUTING.md](CONTRIBUTING.md).

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
