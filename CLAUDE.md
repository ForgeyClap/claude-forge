# CLAUDE.md — Forge V2 (project-local, security-light)

This project runs **Forge V2**: a universal, dynamic multi-agent build / automation / review / delivery system on top of ECC. It handles new and existing work across **websites, landing pages, full-stack apps, n8n builds, AI chatbots / RAG, Telegram bots, prediction & data systems, scraping, business automations, API integrations, dashboards, refactors, audits, research, and debugging.**

Standing rules, not a procedure — the procedure lives in `/forge` and the skills.

## Forge Studio v7 (how Forge works)
> This is the clearly-marked Forge section. When Forge safe-merges into an existing `CLAUDE.md`, only this `## Forge Studio v7` section is added/updated — existing project rules are preserved.

**Lead Agent (you) → Mission Blueprint + Skill Discovery → dynamic role-based subagents (ECC-first, incl. custom roles) → outputs → Lead Review → bounded rework/fix loop → merge → optional Codex → quality gate → honest forge-report.**
Plan before executing. Pick the *smallest relevant* team via **`forge-router`**; the role/skill examples are **guidance, not limits** — create **custom subagent roles + safe project-local custom skills** for gaps, and a custom taxonomy for unknown project types. Small task = small team; large/high-end = larger swarm. Don't over-spawn; don't lock to a fixed number.

- **ECC-first (ECC Normal Mode — default ON):** prefer real ECC agents/skills; native only as a labeled fallback. **ECC Full Test Mode** is opt-in only (default OFF) via `.claude/FORGE_ECC_MODE.json`.
- **Forge Session Mode:** `/forge` / `gebruik Forge` start a project-local session (`.claude/FORGE_SESSION_STATE.json`) so follow-ups auto-use Forge until `stop Forge`/`pause Forge`. No extra permission granted.
- **Project agent strategy:** see `FORGE_PROJECT_PROFILE.md` for the project type, recommended + custom subagent roles, role mapping, and rework-loop rules.
- **Project skill strategy:** Skill Discovery selects skill packs + creates project-local custom skills (`.claude/skills/<name>/SKILL.md`); fallback = labeled native or BLOCKED. Every executable subagent gets an assigned skill/method.
- **Quality gates:** advisory review only unless you ask for blocking gates; Codex optional (logged real/blocked/not-invoked); QA/retest in the rework loop.
- **Forge maintains four things:** this `CLAUDE.md` (project brain) · `.claude/skills/*/SKILL.md` (capabilities) · Forge memory · the dashboard.

## Project isolation (REQUIRED — always on)
1. **Only this folder.** Forge works only in *this* project folder. Never edit other projects or unrelated directories.
2. **Confirm the target.** If the folder/project is ambiguous, ask which exact project folder is meant **before** any edit, then stop and wait.
3. **No outside changes.** No edits outside the target folder. No global project edits without the user's explicit permission.
4. **No global Claude/ECC edits** unless the user explicitly says so.
5. **Inspect before editing.** Read first; never guess layout. Never delete meaningful files without explicit approval.

## Honesty (REQUIRED)
Never claim a check/test/review ran if it didn't. Always report: what was installed/changed, which files, which agents/skills ran, which checks **actually** ran, and what was **not** run.

## Security posture — light, non-blocking
- **No mandatory security gates.** No AgentShield, no `/security-scan` gate, no mandatory `security-reviewer`, no `secrets-guard` / `prod-deploy-guard` hooks. Normal builds are not slowed by security blocking.
- Basic hygiene is still good practice (keep secrets in env, use `.env.example` placeholders, don't commit real secrets) — guidance, **not** an enforced hook.
- `security-reviewer` and `codex-reviewer` remain **available on request** for sensitive code — optional, never a blocker.

## Project memory (read before, update after — every task)
This project keeps local memory in `.claude/`:
- `FORGE_PROJECT_PROFILE.md` (type, stack, agent role map), `FORGE_MEMORY.md` (status/decisions/issues), `FORGE_DECISIONS.md`, `FORGE_TASK_HISTORY.md`, `FORGE_AGENT_LEDGER.md`.
**Before** every `/forge` task read the profile + memory + task history; **after**, update memory, task history, and the agent ledger. Only write what's supported by real files/git/user instruction; mark `inferred`/`unknown`. Memory is project-local only — never wipe it without reason.

## Agent Activity Ledger (proof, no fake claims)
Every task records which agents really worked in `FORGE_AGENT_LEDGER.md` with evidence (Runtime + status). Statuses ONLY: `ECC REAL INVOKED` · `ECC SKILL LOADED` · `NATIVE AGENT INVOKED` · `INTERNAL ROLE ONLY` · `NOT USED` · `FAILED` · `BLOCKED`. Mark **custom** subagents and the **skill / skill_source** each used. Never claim an agent/custom skill/Codex/test/preview that didn't actually run.

## Dashboard + event logs
**The Forge Command Center is the dashboard** — one dashboard on `http://127.0.0.1:4100` that auto-discovers your projects and shows strictly per-project data (owner decision 2026-07-31). `/forge dashboard` looks for `command-center/gateway/bin.mjs` in this project; if it lives here, start it (long sessions: `node command-center/gateway/supervisor.mjs`, which restarts the gateway automatically) — otherwise just health-check the central instance, because one running Command Center already covers this project. Either way the rule is the same: **never claim the dashboard is running unless `GET http://127.0.0.1:4100/api/health` actually passed.**

Event logging is unchanged and stays per-project: every run writes `.claude/forge-runs/<run_id>/{run.json, events.jsonl, final-report.md}` and appends real events with `node .claude/forge-dashboard/log-event.cjs` — the Command Center reads those. **Tasks exist before the work does:** log your plan as `agent_work_package_created` events BEFORE dispatching, and run `node .claude/forge-bin/forge-runcontract.cjs check --run <run_id> --log-event` before claiming the run is done (exit 3 = the listed rules are unfinished work).

The old per-project **Control Center** (`.claude/forge-dashboard/server.cjs`, ports 3737–3999) is **RETIRED — never started automatically**. It still works on an explicit `legacy dashboard` request, and its `log-event.cjs` remains in full service as the run-event writer. Commands: `/forge dashboard` · `/forge start` · `/forge use` · `/forge status` · `/forge runs` · `/forge open-report`. NL triggers: "use Forge system" / "gebruik Forge systeem" / "start Forge dashboard". **Never read another project's `.claude/`.**

## Terminal command pack (project-local, no global install)
`.claude/forge-bin/` has cross-platform wrappers: PowerShell `.\.claude\forge-bin\forge-dashboard.ps1`, CMD `.claude\forge-bin\forge-dashboard.cmd`, Bash `bash .claude/forge-bin/forge-dashboard.sh` (also `forge-status`/`forge-runs`/`forge-open-report`/`forge-log-event` + a `forge` dispatcher). If `package.json` exists: `.claude/forge-bin/forge-dashboard.cmd|forge:status|forge:runs|forge:open-report`. Dashboard CLI: `node .claude/forge-dashboard/server.cjs [--status|--runs|--open-report|--health|--assign-only]`. No global PATH changes; everything runs from this folder only.

## Codex (optional reviewer)
Codex stays available as an **optional** code-quality review for important changes (`codex-reviewer` agent → `/codex:review`). If Codex isn't available, **don't block** — just report it wasn't run.

## Fan-out levels
- **L1** small (1–3 agents) · **L2** medium (3–6) · **L3** complex (6–12) · **L4** large (phased). Pick the smallest that fits.

## Parallel vs serial
Parallelize only **independent** subtasks; isolate parallel implementation in git worktrees/branches; **you are the integration layer**.

## Entry points
- **`/forge <task>`** — classify, build a team, execute (in this folder), deliver.
- **`forge-router`** skill — picks task type, team, and the domain playbook (`forge-website`, `forge-fullstack`, `forge-n8n`, `forge-scraping`, `forge-rag`, `forge-prediction`, `forge-integration`).
- **`ship-readiness`** skill — **advisory** pre-handoff checklist (not a blocker).
- **`forge-report`** skill — final report format.

Keep this file short. Procedures belong in skills.
