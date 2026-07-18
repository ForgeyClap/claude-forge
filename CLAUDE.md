# CLAUDE.md — Forge V2 (project-local, security-light)

This project runs **Forge V2**: a universal, dynamic multi-agent build / automation / review / delivery system on top of ECC. It handles new and existing work across **websites, landing pages, full-stack apps, n8n builds, AI chatbots / RAG, Telegram bots, prediction & data systems, scraping, business automations, API integrations, dashboards, refactors, audits, research, and debugging.**

Standing rules, not a procedure — the procedure lives in `/forge` and the skills.

## How Forge works
**Orchestrator (you) → dynamic ECC agent pool → per-task specialists → optional Codex review → honest forge-report.**
Per task, pick the *smallest relevant* team via the **`forge-router`** skill. Small task = small team; large task = larger swarm. Don't over-spawn agents to look impressive. Don't lock to a fixed number of agents.

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
Every task records which agents really worked in `FORGE_AGENT_LEDGER.md` with evidence. Statuses ONLY: `REAL INVOKED` · `REAL TOOL/SKILL USED` · `INTERNAL ROLE ONLY` · `NOT USED` · `FAILED`. Never claim an agent/Codex/test/preview that didn't actually run.

## Dashboard + event logs (Forge Control Center — per-project, isolated)
This project has its **own** local-only dashboard in `.claude/forge-dashboard/` on its **own stable port** (3737–3999, deterministic from the project path, stored in `.claude/forge-dashboard/PORT`; falls back to the next free port if busy). Start: `node .claude/forge-dashboard/server.cjs` (or `start-forge-dashboard.bat`, or `/forge dashboard`) → it prints the actual `http://localhost:<port>`, writes `DASHBOARD_STATE.json`, and exposes `GET /api/health`. Each `/forge` run writes `.claude/forge-runs/<run_id>/{run.json, events.jsonl, final-report.md}`; append real events with `node .claude/forge-dashboard/log-event.cjs`. The dashboard reads these read-only and shows real activity only — **never a shared/global dashboard; never read another project's `.claude/`**. Commands: `/forge dashboard` · `/forge start` · `/forge use` · `/forge status` · `/forge runs` · `/forge open-report`. NL triggers: "use Forge system" / "gebruik Forge systeem" / "start Forge dashboard". **Never claim the dashboard is running unless a health check passed.**

## Terminal command pack (project-local, no global install)
`.claude/forge-bin/` has cross-platform wrappers: PowerShell `.\.claude\forge-bin\forge-dashboard.ps1`, CMD `.claude\forge-bin\forge-dashboard.cmd`, Bash `bash .claude/forge-bin/forge-dashboard.sh` (also `forge-status`/`forge-runs`/`forge-open-report`/`forge-log-event` + a `forge` dispatcher). If `package.json` exists: `npm run forge:dashboard|forge:status|forge:runs|forge:open-report`. Dashboard CLI: `node .claude/forge-dashboard/server.cjs [--status|--runs|--open-report|--health|--assign-only]`. No global PATH changes; everything runs from this folder only.

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
