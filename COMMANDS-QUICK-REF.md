<div align="center">

# claude-forge — Commands & Tools Quick Reference

Every slash command, sub-flow, dashboard control, natural-language trigger, and zero-dependency terminal tool — in one scannable page.

**2 slash commands · 19 agents · 59 skills · 93 zero-dep `.cjs` tools (full install; the LITE plugin has 18 agents and 31 skills).**

</div>

---

> [!TIP]
> **You almost never need this page to get started.** Run `/setup-forge` once, then say `/forge <what you want>`. This reference is for when you want to reach past the two commands into the terminal tools, dashboard controls, and sub-flows underneath.

---

## Namespaced (plugin) vs bare (installer)

The **same** commands exist under two names, depending on how you installed Forge. Both do the same thing.

| Install path | Command form | Example |
|---|---|---|
| 🔌 **Plugin** (`/plugin install forge@claude-forge`) | **Namespaced** — always prefixed with `forge:` | `/forge:forge`, `/forge:setup-forge` |
| 🛠️ **Installer / manual copy** (writes into `~/.claude`) | **Bare** — no prefix | `/forge`, `/setup-forge` |

> [!NOTE]
> Plugin commands are namespaced because Claude Code namespaces every plugin's commands by the plugin name. The installer copies the command definitions straight into `~/.claude/commands/`, so they resolve bare. Throughout this doc, the **bare** form is shown; prepend `forge:` if you are on the plugin.

---

## Slash commands

| Command | Bare | Namespaced (plugin) | What it does |
|---|---|---|---|
| **Run a task** | `/forge <task>` | `/forge:forge <task>` | Classify the task, read project memory, assemble the *smallest relevant* agent team, execute **in this folder only**, log real events to the dashboard, update memory + agent ledger, optionally Codex-review, and deliver an honest report. |
| **Onboard** | `/setup-forge` | `/forge:setup-forge` | First-run wizard — asks name / goal / project-type / language, does beginner-safe API-key setup, and scaffolds the per-project Forge system. Run once per project. |

> [!NOTE]
> **Plugin is LITE.** `/forge:setup-forge` from the read-only plugin cache **cannot** write `~/.claude`, scaffold the dashboard, or run the `.env` key-move flow — it detects this and offers to add the full system via the installer. Only the **installer / manual** route gives you the dashboard and safe key flow.

### `/forge` — what to pass

```
/forge build me a landing page for my bakery
/forge create an n8n automation that emails new leads to my inbox
/forge refactor the auth module and keep the tests green
/forge audit this codebase for security and dead code
/forge scrape public product listings into a CSV
/forge START NEW          # begin a fresh mission
/forge CONTINUE           # resume the current project's work
```

`/forge` also accepts the project-local **sub-commands** below (checked before the input is treated as a task).

---

## `/forge` sub-commands

Once the full system is installed in a project, `/forge <sub-command>` drives the dashboard and run history. These are project-local and only ever touch the **active** project's `.claude/`.

| Sub-command | What it does |
|---|---|
| `/forge dashboard` | Find/start the **Command Center** (`node command-center/gateway/supervisor.mjs`), health-check `GET http://127.0.0.1:4100/api/health`, and report `http://127.0.0.1:4100`. Never claims a start it can't prove. |
| `/forge start` | Same as `dashboard`, then begin a new run. |
| `/forge use` | Load project memory/profile, start (or show how to start) the dashboard, then continue the task. |
| `/forge status` | Summarize project status, the latest run, and the dashboard URL (reads `FORGE_MEMORY.md` + `DASHBOARD_STATE.json` + newest `run.json`). |
| `/forge runs` | List this project's runs (`.claude/forge-runs/*/`) newest-first. |
| `/forge open-report` | Print this project's newest `final-report.md`. |

> [!TIP]
> One Command Center on **127.0.0.1:4100** serves every project — it auto-discovers them and shows strictly per-project data. Run events stay per-project (`.claude/forge-runs/<run_id>/events.jsonl`, written by `.claude/forge-dashboard/log-event.cjs`). Forge never reads another project's `.claude/` for anything else. The retired per-project Control Center (ports 3737–3999) starts only on an explicit `legacy dashboard` request.

---

## `/setup-forge` sub-flows

The wizard has one happy path plus three targeted modes. Dispatch is read from the arguments.

| Invocation | Flow |
|---|---|
| `/setup-forge` | **Full wizard** — first-run detection → 4-question happy path (name · goal · project type · language) → beginner-safe key setup → write markers → self-heal. |
| `/setup-forge keys` | **Key setup only** — re-run / add keys via the safe temp-file flow. |
| `/setup-forge doctor` | **Health check only** — PASS/FAIL for Node, `.claude/` integrity, `.env` not git-tracked, valid markers, skills/agents dirs. |
| `/setup-forge reset` | **Re-onboard** from the top. Does **not** delete your `.env` or keys. |
| `/setup-forge --quick` *(or all of `--name/--goal/--type/--lang`)* | **Non-interactive** (CI / headless) — no questions. |
| `/setup-forge --keys-from <path>` | Import keys from a file non-interactively. |

### The signature safe-key flow

```
1. guard        → refuses to proceed if a .env is already git-tracked (STOP + warn)
2. init-keys    → writes .env.forge-setup (already gitignored) with labelled KEY= blanks
3. you fill it  → paste each key after the =, save, say "done" (en) / "klaar" (nl)
4. place-keys   → validates each value, MOVES valid keys into a gitignored .env (chmod 600),
                  writes a values-free .env.example, and DELETES the temp on clean success
```

> [!NOTE]
> Secret **values are never echoed back or committed**. Keys are **optional** — skip them and Forge still runs. The engine keeps the temp file (still gitignored) only if a pasted key failed validation, and tells you which to fix.

---

## Onboarding language (i18n)

The whole wizard, replies, and the final report run in the language you pick.

| | |
|---|---|
| Supported now | **English (`en`, default)** · **Nederlands (`nl`)** |
| "I'm done" signal | `done` (en) / `klaar` (nl) |
| Force a language | pass `--lang en` / `--lang nl` |

---

## Natural-language triggers

You don't have to type a slash command. These plain-language phrases activate Forge (English + Dutch), enter/leave **Forge Session Mode**, and drive the dashboard.

<details>
<summary><strong>Activate / use Forge</strong></summary>

| Say | Effect |
|---|---|
| `use Forge` · `use Forge system` | Enter Forge Session Mode; load memory; run the task through the Forge flow. |
| `gebruik Forge` · `gebruik Forge systeem` · `gebruik forge voor dit project` | Dutch equivalents. |
| `start Forge` · `start Forge session` | Enter Session Mode. |

</details>

<details>
<summary><strong>Dashboard</strong></summary>

| Say | Effect |
|---|---|
| `start Forge dashboard` · `open Forge dashboard` | Find/start the Command Center, health-check it, report the real URL. |

</details>

<details>
<summary><strong>Pause / stop / status</strong></summary>

| Say | Effect |
|---|---|
| `stop Forge` · `pause Forge` | Pause Session Mode. |
| `normale Claude mode` · `doe dit zonder Forge` | Leave Session Mode (Dutch). |
| `Forge status` · `is Forge actief?` | Report Session Mode state. |

</details>

> [!NOTE]
> **Session Mode grants no extra permission.** Project isolation stays on; no edits outside the folder; no credentials, live workflows, production deploys, or global config changes without explicit approval.

---

## Dashboard commands

The Command Center gateway is a zero-dependency Node server that reads each run's event log **read-only** and shows **real activity only**. (The retired per-project Control Center below still works on request.)

```bash
# Start (foreground) — prints the real http://localhost:<port>
node .claude/forge-dashboard/server.cjs

# One-shot CLI projections (no server, no browser)
node .claude/forge-dashboard/server.cjs --status        # project + latest-run status
node .claude/forge-dashboard/server.cjs --runs          # list runs newest-first
node .claude/forge-dashboard/server.cjs --open-report   # print newest final-report.md
node .claude/forge-dashboard/server.cjs --health        # health-check output
node .claude/forge-dashboard/server.cjs --assign-only   # dashboard assignment only

# Append a REAL event to the current run's event log
node .claude/forge-dashboard/log-event.cjs <run_id> <event_type> "<json>"
node .claude/forge-dashboard/log-event.cjs '<json>'
```

| Endpoint / control | Purpose |
|---|---|
| `http://127.0.0.1:4100/` | Live Command Center SPA (projects, runs, agents, missions, proof). |
| `GET /api/health` | Health probe — Forge never claims the dashboard is up unless this passes. |
| `.claude/forge-dashboard/PORT` | Port of the RETIRED per-project Control Center (3737–3999) — only used by `legacy dashboard`. |
| `start-forge-dashboard.bat` | Windows one-click start. |

---

## `forge-bin/` terminal tools

Cross-platform wrappers with **no global install** — everything runs from the project folder. Each has a PowerShell `.ps1`, CMD `.cmd`, and Bash `.sh` form, plus a `forge` dispatcher.

### Wrappers (day-to-day)

| Tool | Purpose | Example |
|---|---|---|
| `forge` | Dispatcher — routes to the sub-tools below. | `.\.claude\forge-bin\forge.ps1 dashboard` |
| `forge-dashboard` | Start / health-check the Command Center. | `.claude\forge-bin\forge-dashboard.cmd` |
| `forge-status` | Print project + latest-run status. | `bash .claude/forge-bin/forge-status.sh` |
| `forge-runs` | List runs newest-first. | `.claude/forge-bin/forge-runs.cmd` |
| `forge-open-report` | Print the newest final report. | `.claude/forge-bin/forge-open-report.cmd` |
| `forge-log-event` | Append a real event to a run. | `.\.claude\forge-bin\forge-log-event.ps1 <run_id> <type> "<json>"` |

> [!TIP]
> **Pick your shell:** PowerShell `.\.claude\forge-bin\forge-dashboard.ps1` · CMD `.claude\forge-bin\forge-dashboard.cmd` · Bash `bash .claude/forge-bin/forge-dashboard.sh` · npm `.claude/forge-bin/forge-dashboard.cmd` (or `.ps1` / `.sh`). Same pattern for `forge-status` / `forge-runs` / `forge-open-report`.

### Core engines (`node .claude/forge-bin/<tool>.cjs`)

| Tool | Purpose | Example |
|---|---|---|
| `forge-setup.cjs` | Onboarding + safe-key engine behind `/setup-forge`. Sub-actions: `status · guard · init-keys · place-keys · mark · self-heal · doctor · lang`. | `node .claude/forge-bin/forge-setup.cjs status --json` |
| `forge-doctor.cjs` | **Self-test + leak scan** — `node --check` every source, run every test suite, verify the honesty gate, confirm the dashboard SPA is intact, scan tracked files for leaked secrets, validate agents. | `node .claude/forge-bin/forge-doctor.cjs` |
| `forge-sync.cjs` | Safe installer / template sync — backup + canary + validation + rollback before touching a project file. Bare = `status`; use `install` to actually sync. | `node .claude/forge-bin/forge-sync.cjs status` |
| `forge-report.cjs` | Parse, validate, and ingest a dispatched agent's structured completion-report block. Requires a subcommand. | `node .claude/forge-bin/forge-report.cjs validate <file>` |
| `forge-verify.cjs` | The "verify-loop" — checks a DONE claim against the real `events.jsonl`; `--enforce` reopens mismatches. | `node .claude/forge-bin/forge-verify.cjs --run <run_id>` |
| `forge-heartbeat.cjs` | Stall watchdog — flags an agent that started but has gone silent past a window. | `node .claude/forge-bin/forge-heartbeat.cjs check <run_id>` |
| `forge-intake.cjs` | Prompt-Master intake — renders the one big clarifying-question list before a build. `--type` is required. | `node .claude/forge-bin/forge-intake.cjs --type website --task "<task>"` |
| `forge-runcontract.cjs` | **Run-contract gate** — checks a run against `FORGE_HARD_RULES.json` before it may be called done. Exit 3 = NOT DONE (the listed rules are unfinished work). `--log-event` writes the `gate_evaluated` proof in the same act. | `node .claude/forge-bin/forge-runcontract.cjs check --run <run_id> --log-event` |
| `usage-guard.cjs` | Subscription usage watchdog — reads the official Anthropic OAuth usage endpoint; pauses at a threshold. | `node .claude/forge-bin/usage-guard.cjs start` |

### `forge-setup.cjs` sub-actions (used by the wizard)

| Sub-action | Purpose |
|---|---|
| `status` | First-run / onboarding state (add `--json`). |
| `guard` | Refuse to proceed if `.env` is git-tracked (exit `3`). |
| `init-keys` | Write the gitignored `.env.forge-setup` fill-in file. |
| `place-keys` | Validate + move keys into `.env`, write values-free `.env.example`, delete the temp on success. |
| `mark` | Write/merge the project + global onboarding markers. |
| `self-heal` | Create any missing `.claude/` dirs/files; report only what changed. |
| `doctor` | PASS/FAIL health check. |
| `lang` | Print the working language (`en` default). |

### Advanced / internal tools

<details>
<summary><strong>Planning, memory & reporting</strong></summary>

| Tool | Purpose |
|---|---|
| `forge-prd.cjs` | Render a structured PRD to markdown + JSON sidecar. |
| `forge-deeplearn.cjs` | Read-only full-codebase priming scanner (stack, entry points, coverage, risks). |
| `forge-mindmap.cjs` | Turn an indented outline into a node/edge mind-map. |
| `forge-registry.cjs` | Global, opt-in, read-only registry of Forge projects under a root. |
| `forge-store.cjs` | Hardened append-only flat-file store writer (project-local). |
| `forge-artifact.cjs` | Thin artifact-store helper (the "Vault"). |
| `forge-memory.cjs` | Per-Boss typed memory (episodic / semantic / procedural) with top-K recall. |
| `forge-distill.cjs` | Self-learning distill loop over per-Boss memory. |
| `forge-learn.cjs` | Opt-in, read-only cross-project federated lesson recall. |
| `forge-reflect.cjs` | Manual-only owner-correction → evidence-linked lesson writer. |
| `forge-resume.cjs` · `forge-run-state.cjs` | Durable resume — fold a run's events into a plan so only unfinished work restarts. |
| `forge-stats.cjs` | Read-only run-outcome statistics across every run. |
| `forge-cost.cjs` | Cost/token sampler → `cost_sampled` events for the dashboard. |

</details>

<details>
<summary><strong>Honesty, verification & hardening</strong></summary>

| Tool | Purpose |
|---|---|
| `forge-certify.cjs` | Black-box certification — did Forge genuinely orchestrate this run, or is it fabricated? |
| `forge-chaos.cjs` | Failure-injection harness — proves invariants survive real failure conditions. |
| `forge-checkpoint.cjs` | Idempotency + atomic checkpoint layer (effectively-once side effects). |
| `forge-integrate.cjs` | Hermetic integration gate. |
| `forge-evals.cjs` | Deterministic binary-assertion scorer for the skill-refine loop. |
| `forge-mutate.cjs` | Mutation testing — proves the tests actually pin the logic. |
| `forge-promptcheck.cjs` | Advisory dispatch-prompt linter (non-blocking). |
| `forge-policy.cjs` | Pure orchestration/security policy helpers (model cascade, etc.). |
| `forge-bench.cjs` | FORGEBENCH capability scoreboard across the real modules. |

</details>

<details>
<summary><strong>Interop & model routing</strong></summary>

| Tool | Purpose |
|---|---|
| `nvidia-provider.cjs` | NVIDIA Build / NIM OpenAI-compatible provider adapter (key from `.env`, always masked). |
| `forge-mcp.cjs` | Read-only MCP server exposing this project's Forge run state as an interoperable service. |
| `forge-otel.cjs` | Export a run as OpenTelemetry GenAI spans (Langfuse / Phoenix / Grafana Tempo). |
| `forge-a2a.cjs` | A2A (Agent2Agent) client edge — delegate to external specialist agents. |
| `forge-agui.cjs` | AG-UI emit-bridge — project run events into standard AG-UI events. |
| `forge-graph.cjs` | Executable orchestration DAG (the Boss loop as resumable nodes + edges). |
| `forge-paperclip.cjs` | **Opt-in** Forge ↔ Paperclip bridge (1 Forge project = 1 Paperclip company). Not started by `/forge`. |

</details>

> [!NOTE]
> Every tool is **zero-dependency** plain Node (`fs`/`path`/`crypto`/`child_process`/`os` only) and Windows-safe. There is nothing to `npm install`. Requires **Node.js 18+**.

---

## Quick lookup

| I want to… | Do this |
|---|---|
| Onboard a new project | `/setup-forge` |
| Build / automate / refactor something | `/forge <task>` |
| Add or fix API keys | `/setup-forge keys` |
| Check Forge's health | `/setup-forge doctor` **or** `node .claude/forge-bin/forge-setup.cjs doctor` |
| See the live dashboard | `/forge dashboard` |
| Check the latest run | `/forge status` |
| Read the last report | `/forge open-report` |
| Run the full self-test + leak scan | `node .claude/forge-bin/forge-doctor.cjs` |
| Trigger Forge without a slash command | say `use Forge` / `gebruik Forge` |

---

<div align="center">

Part of **[claude-forge](README.md)** · [MIT](LICENSE) © ForgeyClap

</div>
