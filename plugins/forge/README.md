# Forge V2 — Claude Code plugin (LITE)

This is the **plugin** distribution of
[**claude-forge**](https://github.com/ForgeyClap/claude-forge) — a
zero-dependency, multi-agent build / automation / review / delivery system for
[Claude Code](https://claude.com/claude-code).

## What this plugin includes

- **Commands**
  - `/forge:forge` — classify a task, assemble a right-sized team of agents,
    build/automate/review it, and deliver an honest report.
  - `/forge:setup-forge` — first-run onboarding wizard (name, goal, project
    type, language). Detects that it is running plugin-only and offers to run
    the full installer.
- **18 Boss agents** — boss, build-boss, review-boss, test-boss, ui-boss,
  seo-boss, search-boss, security-boss, integration-boss, skill-boss,
  docs-boss, head-chef, codex-reviewer, data-scientist, electron-pro,
  mcp-developer, ml-engineer, payment-integration.
- **Curated skills** — `forge-core`, the domain playbooks (`forge-website`,
  `forge-fullstack`, `forge-n8n`, `forge-rag`, `forge-scraping`,
  `forge-prediction`, `forge-integration`), plus `forge-router`,
  `forge-report`, `forge-verify`, `forge-registry`, and more.

## Install

```
/plugin marketplace add ForgeyClap/claude-forge
/plugin install forge@claude-forge
/reload-plugins
/forge:setup-forge
```

Plugin commands are always **namespaced** — `/forge:forge`,
`/forge:setup-forge`. (The bare `/forge` and `/setup-forge` come from the
installer route, not the plugin.)

## This is the LITE route

A Claude Code plugin is copied into a **read-only cache** and cannot write to
`~/.claude`, cannot scaffold a project's `.claude/` payload, cannot stand up the
per-project dashboard, and cannot run the `.env` key-setup flow.

So this plugin gives you the **commands, agents, and skills** — the fastest way
to try Forge — but **not** the dashboard or the beginner-safe key setup. For the
**full** system (per-project payload, global core, live localhost dashboard, and
the `/setup-forge` key flow), use the installer.

Why the split is architecturally forced is recorded in
[ADR 0001](https://github.com/ForgeyClap/claude-forge/blob/main/docs/adr/0001-plugin-vs-installer-split.md).

## Get the full installer

See the main README for the one-line installer, the clone-and-run option, and
the manual copy:

**<https://github.com/ForgeyClap/claude-forge#readme>**

## License

MIT © ForgeyClap. See the
[LICENSE](https://github.com/ForgeyClap/claude-forge/blob/main/LICENSE).
