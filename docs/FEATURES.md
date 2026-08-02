# Features — everything Forge does

The complete catalog behind the one-line pitch. **claude-forge** turns Claude Code into a coordinated team that **builds, automates, reviews and ships** — with a live per-project dashboard, honest reporting, and zero runtime dependencies.

> [!NOTE]
> **Honest counts.** Forge ships exactly **18 built-in agents** (12 permanent Bosses + 6 specialists) and **23 skills**. That is what lives in this repo. Forge can also *route to* your wider Claude Code / ECC agent ecosystem when it is present — but only 18 agents and 23 skills ship here, and nothing else is ever claimed as "shipped".

> [!TIP]
> You do **not** need to read this whole page to use Forge. Run `/setup-forge` once, then say `/forge <what you want>`. This reference is for when you want to know *exactly* what is under the hood.

**Command surface:** the plugin uses namespaced commands (`/forge:forge`, `/forge:setup-forge`); the installer copies the core into `~/.claude`, giving you the bare `/forge` and `/setup-forge`. Both do the same thing.

---

## Table of contents

- [Orchestration & routing](#orchestration--routing)
- [Domain playbooks](#domain-playbooks)
- [The 12 Bosses + 6 specialists](#the-12-bosses--6-specialists)
- [Verification, honesty & reporting](#verification-honesty--reporting-skills)
- [Priming, visualization & cross-project](#priming-visualization--cross-project-skills)
- [Craft skills](#craft-skills)
- [The dashboard (Control Center)](#the-dashboard-control-center)
- [Project memory](#project-memory-the-forge_-files)
- [Onboarding & safe key setup](#onboarding--safe-key-setup)
- [Honesty & isolation guarantees](#honesty--isolation-guarantees)
- [Zero-dependency design](#zero-dependency-design)

---

## Orchestration & routing

Forge is a **Lead-Agent studio**: you (the orchestrator) hand a task to `/forge`, and Forge classifies it, assembles the *smallest relevant* team, runs it in your project folder only, optionally adds an independent review, and writes a truthful report. The routing brain never over-spawns — a small task gets a small team.

```
You (the orchestrator)
        │  /forge <task>
        ▼
  forge-router  ──►  dynamic agent pool  ──►  per-task specialists
                                                     │
                                          optional Codex review
                                                     │
                                                     ▼
                                          honest forge-report + dashboard
```

| Skill | Role in the pipeline |
|---|---|
| **`forge-core`** | The global, security-light Forge layer. Instructions only — no hooks, no auto-running gates. Defines Forge behavior (dynamic agent pool, project isolation, optional Codex review, honest reporting) and the per-project installer. |
| **`forge-router`** | The router / agent-selection brain. Classifies each task by **domain** and **complexity (L1–L4)**, selects the smallest fitting team, decides parallel vs serial, sets the review gates, and loads the matching domain playbook. Reads project memory first; never fakes availability. |
| **`forge-intake`** | Prompt Master intake. At the start of any BUILD task it captures the project's real goal via one consolidated clarifying-question list (project-type-aware, subagent-brainstormed for new types), then feeds answers into the PRD and the Boss dispatch prompts. Also lint-checks every dispatch prompt is Prompt-Master-shaped. |
| **`forge-prd`** | Generates a structured PRD (markdown + JSON meta) before a non-trivial build and auto-creates one ticket per acceptance criterion — forcing scope, acceptance criteria, and the test plan to be explicit before agents touch files. |

### Fan-out levels

Forge picks the smallest team that fits — it never locks to a fixed agent count.

| Level | Size | Typical use |
|---|---|---|
| **L1** | 1–3 agents | small, well-understood change |
| **L2** | 3–6 agents | a real feature or automation |
| **L3** | 6–12 agents | complex, multi-part build |
| **L4** | phased | large builds run in phases |

Parallel work happens only for **independent** subtasks, isolated in git worktrees/branches — the Lead is always the integration layer.

---

## Domain playbooks

Seven domain playbooks encode the "how" for each kind of work. The router loads the matching one; the Lead retains final control and can adapt or create custom skills for unusual projects. Each playbook is **orchestration only** and defers to existing ECC/Claude skills rather than duplicating them.

| Playbook | What it builds | Key safeguards |
|---|---|---|
| **`forge-website`** | Websites, landing pages, marketing sites, presentational dashboards, frontend UI | Mobile **and** desktop verified by screenshot before "done"; no placeholder/Lorem/mock content in prod; forms validate + hit a real endpoint; keys in env, never in the bundle |
| **`forge-fullstack`** | Complete apps, SaaS, CRUD, data-backed dashboards with a DB + login | Auth enforced server-side on **every** protected route (authn + authz); input validation on every endpoint; secrets in env + `.env.example`; DB migrations reviewed and reversible; runs specialists across git worktrees |
| **`forge-n8n`** | n8n automation workflows | Validate before "production-ready" (webhook method, schema, credentials, auth, **error branch present**, retries, test/prod split); credentials in the n8n store/env — never hardcoded; imports stay **inactive** until owner approves activation |
| **`forge-rag`** | AI chatbots, assistants, RAG / knowledge-base Q&A | Source-aware answers that **cite sources**; clear fallback on empty/low-confidence retrieval (no guessing); no hallucinated business facts; safe data handling + defined human-handoff |
| **`forge-scraping`** | Safe, legal web scraping & data collection | Ethics gate *before* any collector: public/official/permitted sources only; **never** paywall/login bypass or leaked data; respects robots + rate limits; **outreach is DRAFT-ONLY**; stop-and-ask on unclear legality |
| **`forge-prediction`** | Forecasting, sports-data, odds/value models, Telegram tip delivery | **Never claims certainty** — every output carries a confidence/risk label; **no automatic real-money betting** / no auto-stake path; backtest with sample size before trusting a model; token in env only |
| **`forge-integration`** | Business automation & API integrations — Gmail, Calendar, CRM, webhooks, Slack, payments | Secrets in env + `.env.example`, never in code/logs; webhook auth / signature verification on every inbound hook; input validation + minimal OAuth scopes; idempotent writes (no duplicate side effects on retry) |

> [!NOTE]
> Dashboards fold into `forge-website` (presentational) or `forge-fullstack` (data-backed). Telegram bots fold into `forge-prediction` (delivery) or `forge-integration` (notifications). Pure refactor / audit / debug / research / security-review needs **no** domain playbook — the router routes straight to the relevant agents.

---

## The 12 Bosses + 6 specialists

Forge ships **18 built-in agents** in `.claude/agents/*.md`. Full role detail lives in [AGENTS.md](../AGENTS.md); this is the at-a-glance map.

### The 12 permanent Bosses

| Boss | Model | Responsibility |
|---|---|---|
| **boss** | opus | The Lead Agent — owns the mission, splits it into work packages, tracks progress, decides fix strategy, reassigns until the loop genuinely passes |
| **head-chef** | sonnet | Converts the mission into exact step-by-step work packages and verifies each subagent actually completed its goal (no random/duplicate work) |
| **build-boss** | sonnet | Implementation & coding — writes clean, tested code that follows existing architecture; never bypasses QA |
| **test-boss** | sonnet | Real automated testing (Playwright e2e for web/apps; the right strategy elsewhere); reports real pass/fail proof, never a fabricated pass |
| **review-boss** | opus | The final QA gate — reviews finished work against the user's actual goal and files a structured failure report on any real gap |
| **ui-boss** | sonnet | UI/UX & frontend quality — premium responsive interfaces, real screenshot loops across mobile/tablet/desktop |
| **seo-boss** | sonnet | SEO, performance & site-quality review — metadata, headings, Core Web Vitals, a11y, schema, indexability |
| **search-boss** | sonnet | Research & current-information — source-grounded facts with references, never hallucinated |
| **security-boss** | opus | Read-only security & secrets audit — keys, env, auth, webhooks, input validation, injection surfaces, unsafe logging |
| **integration-boss** | sonnet | APIs, automation & external systems — n8n, webhooks, Gmail, calendars, DBs, payments with retries/timeouts/fallbacks |
| **docs-boss** | haiku | Docs, setup instructions, architecture notes, env-var guides, final reports in plain language |
| **skill-boss** | haiku | Global skills manager — maintains the skill registry, attaches skill bundles to agents, reports missing skills with a safe fallback |

### The 6 specialists

| Specialist | Model | When it's used |
|---|---|---|
| **codex-reviewer** | opus | **Optional** independent code-quality review for important/sensitive code — never a mandatory gate, never blocks a build |
| **data-scientist** | sonnet | Exploratory data analysis, statistical modeling & prediction with rigorous validation and honest uncertainty labels |
| **electron-pro** | sonnet | Electron desktop apps — safe IPC, context isolation, no `nodeIntegration` in the renderer, a real signed installer |
| **mcp-developer** | sonnet | Building/debugging MCP servers & clients — JSON-RPC 2.0 compliance, schema-validated inputs, minimal scopes |
| **ml-engineer** | sonnet | Production ML engineering — training-to-serving pipelines, versioning, drift monitoring, safe rollout |
| **payment-integration** | sonnet | Payments & financial transactions — Stripe/gateway integration, PCI-safe tokenization, verified webhooks, idempotent charge/refund flows |

> [!TIP]
> Models are tiered for cost: routine work runs on Sonnet/Haiku and only high-stakes roles (Lead, review, security) default to Opus. The tiering is configurable in `.claude/FORGE_MODEL_ROUTING.json`, and the **actual** model used is logged in the agent ledger — never faked.

---

## Verification, honesty & reporting skills

Seven skills exist purely to keep Forge honest — closing the gap between "an agent said it's done" and "the recorded events prove it".

| Skill | What it does |
|---|---|
| **`forge-verify`** | The verify-loop. After any agent/work-package claims done, it reconstructs task state from `events.jsonl` (the same way the dashboard does) and flags any agent that claims completed while its own tasks are still open/running/failed. `--enforce` sends mismatches back; exit code gates a hook/CI step. |
| **`forge-graded-verify`** | Advisory rubric-scored verification for subjective answer-quality work (RAG/research/scraping/prediction). Dispatches review-boss as a graded verifier that scores each criterion 1–4 with evidence. **Never** gates an irreversible action — deterministic checks + owner approval stay authoritative. |
| **`forge-doctor`** | Self-test + secret/leak scan. `node --check` every source, runs all test suites, verifies the honesty gate still rejects unknown events, confirms the dashboard SPA is intact, and scans git-tracked files for leaked secrets. |
| **`forge-heartbeat`** | Stall/silence watchdog. Reads a run's `events.jsonl` and flags any started-but-not-finished agent that hasn't logged anything for longer than a window (default 10 min) — crashed, stuck, or waiting on nobody. Read-only. |
| **`forge-report`** | The standard end-of-task delivery report — classification, project adaptation, mission blueprint + skill discovery, files changed, checks actually run, and the evidence-based **Agent Activity Ledger**. Reflects only checks that really ran. |
| **`forge-agent-report`** | The completion-report contract. Every dispatched Boss ends its final message with one fenced block; the tool parses, validates, and ingests it — so the Lead never hand-transcribes results into the dashboard. |
| **`ship-readiness`** | **Advisory** pre-deploy / pre-handoff checklist (not a blocker). Reports each item pass/fail with evidence across websites, apps, APIs, dashboards, n8n, scraping, RAG, prediction, bots, and automations. Production deploys still need explicit owner approval. |

<details>
<summary><b>How the verify-loop stays honest (the mechanics)</b></summary>

`forge-verify` reconstructs per-agent task state from `<run>/events.jsonl` the same way the Control Center does: structural milestone events (`run_started`, `agent_completed`, `lead_review_completed`, …) are never counted as a "task"; every other event attributed to an agent is a task, and a task is "done" only when its status genuinely resolves to done. An agent "claims completed" once it logs `agent_completed` or `subagent_completed`. A **mismatch** is an agent that claims completed while some of its own tasks are still open/running/failed. It also checks the ticket store — any ticket left open for the run counts against a clean pass.

```
node .claude/forge-bin/forge-verify.cjs <run_id>            # report only, exit 0/1
node .claude/forge-bin/forge-verify.cjs <run_id> --enforce  # report + send mismatches back
node .claude/forge-bin/forge-verify.cjs <run_id> --json     # machine-readable
```

</details>

---

## Priming, visualization & cross-project skills

| Skill | What it does |
|---|---|
| **`forge-deeplearn`** | Deep Learn Mode — an on-demand, **read-only** full-codebase priming scan that produces an honest project-summary and risk-list *before* the Lead commits to a PRD or a big refactor. Never writes into the scanned tree. |
| **`forge-mindmap`** | Generates a node/edge mind map from an indented outline to visualize a plan, architecture, or mission decomposition — with optional Mermaid/markdown sidecars, stored under `.claude/forge-mindmaps/`. |
| **`forge-registry`** | The global, **opt-in, read-only** Project Registry — a cross-project index of every Forge project (status, last run, open tickets, port) plus a self-contained home-view HTML. Reads other projects read-only; never writes into them; the only thing written is the global index. |

---

## Craft skills

| Skill | What it does |
|---|---|
| **`humanizer`** | Removes signs of AI-generated writing (inflated symbolism, promotional language, em-dash overuse, rule-of-three, filler phrases, negative parallelisms, …). Based on Wikipedia's "Signs of AI writing" guide. |
| **`gsap`** | Production-grade web-animation toolkit for `forge-website` / frontend work — timelines, ScrollTrigger, React integration, plugins, performance. A curated reference bundle (vendored from GreenSock's gsap-skills, MIT), read via progressive disclosure. |

---

## The dashboard (Control Center)

Each project gets its **own** local-only **Agent Swarm command center** that shows what Forge is *actually* doing in *this* project as a live node graph — never a global or shared dashboard.

```bash
node .claude/forge-dashboard/server.cjs
# prints the real http://localhost:<port>, exposes GET /api/health
```

- **One Command Center on 127.0.0.1:4100.** It auto-discovers your Forge projects and shows strictly per-project data, so two projects never clash and you only run one dashboard. *(Legacy: the retired per-project Control Center still derives a deterministic port in 3737–3999 from the project path, stored in `.claude/forge-dashboard/PORT` — used only by an explicit `legacy dashboard` request.)*
- **Real activity only.** It reads each run's `.claude/forge-runs/<run_id>/{run.json, events.jsonl, final-report.md}` **read-only** and renders real events. It never reads another project's `.claude/`.
- **Zero dependencies.** No database, no cloud, no login — a plain Node `.cjs` server + a static SPA.

<details>
<summary><b>What the Control Center shows</b></summary>

- **3-column workbench:** left AGENT GROUPS sidebar (Control · Context · Planning · Domain · Execution · Review · Memory·Report, each with a status dot) · center node-graph canvas (pan, wheel-zoom, minimap) · right SELECTED-AGENT work-package inspector + LIVE ACTIVITY feed.
- **11 lenses** over the same live run (default TASK GRAPH): FLOW / TASK GRAPH / NOTE / WORKFLOW / EXEC / DAG / AGENTS / PIPELINE / TEST / REVIEW / ARTIFACTS. Deep-link via `?lens=<id>`.
- **Mission Control dock panels:** Agent Board (12 Bosses as live cards; `NOT USED` when a Boss wasn't dispatched) · Tickets (kanban) · Gates (tests/build/screenshot/security/codex/lead pass·fail·pending) · Proof/Trust (verified-vs-claimed ratio from honesty stamps) · Cost (per-agent tokens/cost, honest empty state otherwise).
- **6 status states:** running (orange) · completed (green) · waiting (cyan) · previewing (blue) · failed (red) · internal-only (gray).
- **Honest badges:** ECC ✓ / ECC SKILL / NATIVE (fallback) / CODEX ✓·✕·— / CUSTOM / SETUP·CONTEXT / DERIVED — so native work is never presented as ECC and Codex is never claimed without real output.
- **Live vs Replay:** a replay bar plays any run back from the start (`1x`/`2x`/`5x`), animating nodes WAITING→RUNNING→COMPLETED in event order. Finished runs keep their real status — no faked "running".

</details>

### The terminal command pack

Cross-platform wrappers in `.claude/forge-bin/` run **only this project's** dashboard scripts — no global install, no PATH changes, no admin rights.

| Action | CMD (Windows, recommended) | PowerShell | Bash |
|---|---|---|---|
| Start dashboard | `.claude\forge-bin\forge-dashboard.cmd` | `.\.claude\forge-bin\forge-dashboard.ps1` | `bash .claude/forge-bin/forge-dashboard.sh` |
| Status | `forge-status.cmd` | `forge-status.ps1` | `forge-status.sh` |
| Recent runs | `forge-runs.cmd` | `forge-runs.ps1` | `forge-runs.sh` |
| Latest report | `forge-open-report.cmd` | `forge-open-report.ps1` | `forge-open-report.sh` |
| Log an event | `forge-log-event.cmd <run> <type> "<json>"` | `forge-log-event.ps1 …` | `forge-log-event.sh …` |

Every wrapper auto-detects Node (PATH → `C:\Program Files\nodejs\node.exe` → a clear "install Node.js LTS" message). Dispatcher commands: `dashboard` · `start` · `status` · `runs` · `open-report` · `health` · `assign-only` · `log-event`. If `package.json` exists: `npm run forge:dashboard | forge:status | forge:runs | forge:open-report`.

---

## Project memory (the `FORGE_*` files)

Forge keeps **project-local** memory in `.claude/`. It reads it before every task and updates it after — writing only what real files / git / owner instruction support, and marking anything else `inferred`/`unknown`. Memory is per-project and is never wiped without reason.

| File | Purpose |
|---|---|
| **`FORGE_PROJECT_PROFILE.md`** | Project name, active folder, detected type & stack, agent role map, and the "must NOT break" list |
| **`FORGE_MEMORY.md`** | Rolling status, decisions, and known issues (never stores secrets/keys/PII) |
| **`FORGE_DECISIONS.md`** | A decisions log — decision, reason, impact, files affected, rollback note |
| **`FORGE_TASK_HISTORY.md`** | One honest entry per completed `/forge` task (status, work packages, which agents/checks actually ran) |
| **`FORGE_AGENT_LEDGER.md`** | Proof of which agents actually worked — statuses `REAL INVOKED` · `REAL TOOL/SKILL USED` · `INTERNAL ROLE ONLY` · `NOT USED` · `FAILED` |
| **`FORGE_SKILL_REGISTRY.md`** | Authoritative list of skills available/used in *this* project (`built-in` · `forge` · `ecc` · `project-local`) |

<details>
<summary><b>Supporting state files (JSON)</b></summary>

| File | Purpose |
|---|---|
| `FORGE_ECC_MODE.json` | ECC mode (ECC Normal default ON; Full Test opt-in), project-isolation flag, security-gate flags |
| `FORGE_SESSION_STATE.json` | Forge Session Mode (`on`/`off`) — when on, follow-up prompts in this project auto-use Forge without re-typing the trigger |
| `FORGE_MODEL_ROUTING.json` | Per-role model tiering (Lead on Opus, subagents on Sonnet/Haiku, escalate high-stakes) — guidance only, the actual model is logged |
| `FORGE_VERSION.json` | Installed Forge template version + sync metadata |

New to the internals? Read them in order: `FORGE_PROJECT_PROFILE.md` → `FORGE_MEMORY.md` → `FORGE_TASK_HISTORY.md` → `FORGE_AGENT_LEDGER.md`.

</details>

---

## Onboarding & safe key setup

`/setup-forge` is the first-run wizard. It asks four friendly questions (name, goal, project type, language), auto-detecting what it can from your repo, then runs the **beginner-safe key flow**:

1. Forge writes a temporary, **already-gitignored** fill-in file with labelled placeholders and where-to-get-each-key links.
2. You paste your keys, save, and say **"done"**.
3. Forge moves the values into a gitignored `.env`, writes a values-free `.env.example`, and **deletes the temp file** — nothing is ever committed, and secret values are never echoed back.

**Key handling invariants:**

- **Keys are optional** — Forge runs fine without any.
- **Gitignore invariant:** `.env`, `.env.*` (except `.env.example`) and the temp `.env.forge-setup` are ignored. If a `.env` is already tracked, Forge stops and warns you to `git rm --cached .env` and rotate.
- **Storage tier:** the honest default is a gitignored `.env` with `0600` perms. An OS keychain (macOS Keychain / Windows Credential Manager / libsecret) is an **optional advanced** upgrade — never required, never faked.
- **`.env.example`** ships key *names* and comments only — never values.

---

## Honesty & isolation guarantees

These are the non-negotiables baked into every skill, agent, and dashboard view.

**Honesty:**

- Never claims a check/test/review ran if it didn't — reports what was installed/changed, which files, which agents/skills ran, which checks **actually** ran, and what was **not** run.
- Every run records which agents really worked in `FORGE_AGENT_LEDGER.md` with evidence (command output, diffs, tool results, commit hashes, log lines).
- No fake "done", no invented tests, no imaginary agents. The dashboard shows **real activity only** and never presents native work as ECC or claims Codex without real output.
- The verify-loop (`forge-verify`) and self-test (`forge-doctor`) exist specifically to catch dishonest completion claims.

**Isolation:**

- Forge works **only in the target project folder** — never edits other projects, unrelated directories, or global Claude/ECC config without explicit permission.
- If the target folder is ambiguous, Forge asks which exact folder is meant **before** any edit.
- Every dashboard is local and per-project; it never reads another project's `.claude/`. The one exception — `forge-registry` — is opt-in, read-only, and writes only a global index, never into a scanned project.
- No deploy, push, or money spent on your behalf without you asking.

**Security posture — light, non-blocking:** no mandatory security gates slow a normal build. Basic hygiene (secrets in env, `.env.example` placeholders) is guidance, not an enforced hook. `security-boss` and `codex-reviewer` remain **available on request** for sensitive code — optional, never a blocker.

---

## Zero-dependency design

Forge is plain Node `.cjs` — **nothing to `npm install`, ever.**

- Every tool in `.claude/forge-bin/` and the dashboard server is zero-dependency Node; the wrappers auto-detect Node and never modify PATH or execution policy.
- The dashboard has **no database, no cloud, no login** — it reads the run's JSON/JSONL event logs directly and serves a static SPA.
- Intake, PRD, mindmap, verify, doctor and the rest are deterministic tools with **no LLM inside them and no telemetry**.
- **Requirements:** Claude Code (Forge is a configuration layer on top of it), Node.js 18+ (for the `.cjs` tools and dashboard), and Git (recommended — the leak-scan and safe key setup use it — but not strictly required).

---

<div align="center">

Back to the [README](../README.md) · agent detail in [AGENTS.md](../AGENTS.md) · [MIT](../LICENSE) © ForgeyClap.

</div>
