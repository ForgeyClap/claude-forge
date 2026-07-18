---
name: forge-core
description: Lightweight GLOBAL Forge Core. Use whenever the user works with Forge in any project, asks to build/create/automate/scrape/refactor something via Forge, says START NEW or CONTINUE, or writes a Forge trigger phrase like "install Forge V2 into this project", "use Forge system", "gebruik Forge systeem", "start Forge dashboard", or "gebruik forge voor dit project". Defines Forge behavior (dynamic ECC agent pool, project isolation, optional Codex review, honest reporting), per-project localhost dashboards, and the project-local installer. No hooks, no security blockers — instructions only.
---

# Forge Core (global, lightweight)

This is the **global, security-light** Forge layer. It carries instructions only — **no hooks, no security gates, nothing that runs automatically across your projects.** The full Forge V2 (command + skills + playbooks) is installed **per project** via the installer below.

## What Forge does (Lead-Agent studio)
**Lead Agent (you) → Mission Blueprint + Skill Discovery → dynamic role-based subagents (ECC-first, incl. custom roles) → outputs/artifacts → Lead Review → rework/fix loop → merge → optional Codex review → quality gate → honest forge-report.**
The Lead Agent **plans before executing** and **decides the agents and skills** — the role/skill examples in the playbooks are **guidance, not fixed menus or limits**. Pick the *smallest relevant* team; small task = small team, large/high-end = larger swarm. Don't lock to a fixed number; don't over-spawn to look impressive.

## Skill Discovery + custom subagents/skills (Lead has final control)
Before assigning subagents the Lead Agent runs **Skill Discovery**: inspect the user mission, project type, files/frameworks/tools, package/config, project memory/profile, **existing project-local skills**, global Forge skills, available ECC agents/skills, MCP/tools, quality target, required outputs, and risks. It then **discovers, chooses, assigns, or creates** the right skills per project (not just "use the listed ones"). For unknown project types, create a **custom taxonomy + custom subagents + custom-skill strategy** — never force-fit into website/n8n/RAG/scraping. **Skill gaps:** create a safe project-local custom skill (`.claude/skills/<name>/SKILL.md`, scoped + documented + linked to a real work package), or a scaffold for approval, or a labeled native fallback, or mark BLOCKED. **No executable subagent runs without an assigned skill/method.** Every subagent + custom role + custom skill must be real (reason + work package + output or honest BLOCKED) and visible in dashboard/ledger/report — never fake one.

## Forge Session Mode (project-local)
`/forge`, `gebruik Forge`, `gebruik Forge systeem`, `use Forge`, `start Forge` → enter **Forge Session Mode** for THIS project (`.claude/FORGE_SESSION_STATE.json` `mode:"on"`). While ON, follow-up prompts in this project **auto-use Forge** — the Lead Agent treats them as part of the current session and keeps dashboard/memory/task-history/ledger updating; the user need not repeat the trigger. **Pause/stop:** `stop Forge`, `pause Forge`, `normale Claude mode`, `doe dit zonder Forge`. **Status:** `Forge status` / `is Forge actief?`. Session Mode grants **no extra permission**: project isolation ON, ECC Normal ON, ECC Full Test OFF (unless explicitly enabled), no credentials/live-workflows/production/global config/external writes without explicit approval.

## ECC-first by default (ECC Normal Mode — DEFAULT ON)
Forge is an **ECC-based** system. When the user says **`gebruik Forge`** / **`gebruik Forge systeem`** / **`use Forge system`** or runs **`/forge ...`**, Forge runs in **ECC Normal Mode** (default ON for every Forge project). In ECC Normal Mode you MUST:
1. read project memory + profile, 2. use the **ECC inventory** if available, 3. select the relevant ECC agents/skills, 4. **really try to invoke** those ECC agents/skills, 5. create agent work packages, 6. log ECC activity to the dashboard, 7. report honestly what ECC did vs didn't.
**If an ECC agent/skill is available, prefer it over a native/internal role.** Do not silently use native agents and present them as ECC. ECC Normal Mode still respects full **project isolation + approval gates** (active folder only; no other projects; no global Claude/ECC config changes; no credential/live-workflow/production/external writes without explicit approval) — that is normal scope control, **not** "ECC off".

**Fallback:** if ECC is available but an agent/skill fails or is blocked → log `ecc_agent_failed` / `ecc_blocked`, show it in the dashboard, and only then use a **native fallback** (clearly labeled). The report states: ECC attempted (y/n) · ECC succeeded (y/n) · fallback used (y/n) · reason. Never pretend ECC ran when it didn't.

## ECC Full Test Mode (OPT-IN ONLY — default OFF)
Full Test Mode = broad ECC inventory, unblock-diagnosis, permission testing, trying all safe ECC routes, sandbox stress-test. **Only** when the user explicitly says **`enable ECC test mode for this project`** or **`test ECC full mode in this sandbox`**. Enable project-local via `.claude/FORGE_ECC_MODE.json` (`"ecc_full_test_mode":"on"`) or `.claude/ECC_TEST_MODE.md`. New projects never get this automatically. Default = OFF.

## Project CLAUDE.md + project-local skills (Forge maintains four things)
For every project where Forge is installed or activated, Forge maintains **four** things: **`CLAUDE.md`** (project brain/instructions), **`.claude/skills/*/SKILL.md`** (project capabilities), **Forge memory** (`.claude/FORGE_*.md`), and the **dashboard** (live visibility).

**Project CLAUDE.md — create or SAFE-MERGE (never overwrite blindly).** On install / `gebruik Forge`, check for `CLAUDE.md`:
- **Missing →** create one from the project scan (log `claude_md_created`).
- **Exists →** read it first, **preserve all existing/non-Forge instructions**, and add or refresh ONLY a clearly-marked **`## Forge Studio v7`** section (log `claude_md_updated`). On a genuine conflict, **report it** (log `claude_md_conflict_detected`) and ask before deleting any user rule; make a changelog note for major changes.

The CLAUDE.md Forge section should cover: **project identity** (name/folder/type/status/key files) · **Forge behavior** (Studio v7, ECC Normal default, Full Test opt-in, Session Mode, how `/forge`/`gebruik Forge` are read) · **project rules** (isolation, do-not-touch, credentials/live-workflow/deploy/external-write restrictions, no-fake honesty) · **project workflow** (how to run/test, safe vs approval-needed commands, dashboard URL/port) · **agent strategy** (project type, recommended + custom subagent roles, role mapping, rework loop) · **skill strategy** (selected packs, project-local custom skills, skill discovery, fallback) · **memory/reporting** (where memory/runs/reports live; ledger/task-history update) · **quality gates** (advisory review unless blocking asked; Codex rules; QA/retest).

**Project-local custom skills.** Check `.claude/skills/` (log `project_skill_dir_checked`; create the dir if missing). Create `.claude/skills/<name>/SKILL.md` **only** when useful, project-local, documented, and linked to a real subagent/work package (log `custom_skill_created`/`custom_skill_updated`; `custom_skill_used` when a subagent runs it; `custom_skill_skipped`/`custom_skill_conflict_detected` honestly). Never modify global skill folders without explicit approval; never create fake skills. Each custom `SKILL.md` documents: name · purpose · when to use / not use · project evidence · inputs · allowed/not-allowed actions · expected outputs · evidence required · related subagents · example work package · safety/isolation notes.

## v7.1 hardening (Codex unlock · browser proof · skill registry · fresh-install · strict verdicts)
- **Codex unlock / retry:** when a Codex run is blocked, run a **diagnosis** — codex CLI present? version? authed (if detectable)? folder a git repo? interactive/TTY available? trust gate suspected? stdout/stderr + exit code + orphan-process check — and write `artifacts/codex-unlock-diagnosis.md` + an **exact manual command** the user can run in an interactive terminal (`cd "<folder>"; git status; codex --version; codex exec "<safe review prompt>"`). Events: `codex_diagnosis_started/_completed`, `codex_trust_gate_detected`, `codex_interactive_retry_required`, `codex_manual_command_created`, `codex_retry_started/_completed/_blocked` (carry `reason`). **Never fake Codex**; report the exact state: **CODEX REAL INVOKED · BLOCKED: TRUST/TTY · BLOCKED: NO GIT · BLOCKED: NO OUTPUT · NOT AVAILABLE · NOT INVOKED · FALLBACK USED**.
- **Browser screenshot proof:** if Playwright or Chrome-headless is available, open the dashboard → FLOW lens → fit → capture (optionally AGENTS/ARTIFACTS/REVIEW) → write `artifacts/dashboard-browser-proof.md` (tool, URL, run id, lenses, screenshot paths, layout observations, pass/fail, limitations). Events: `browser_proof_started`, `browser_screenshot_captured`, `browser_layout_verified`, `browser_proof_blocked`. If unavailable → **PARTIAL** with the exact reason; never claim screenshot proof without a real screenshot.
- **Skill registry:** maintain `.claude/FORGE_SKILL_REGISTRY.md` (skill name · path · source built-in/Forge/ECC/project-local · created-by run · last-used run · related subagents · purpose · status active/planned/skipped/unavailable/deprecated · safety notes · evidence). Update on every custom-skill create/use/skip. Events: `skill_registry_checked/_created/_updated/_conflict_detected`.
- **Fresh-install verification:** on request, verify CLAUDE.md created/safe-merged · `.claude/skills/` · skill registry · Forge memory files · session state · dashboard installed + starts · ECC Normal ON / Full Test OFF · project-local only / no unrelated projects touched → `artifacts/fresh-install-verification.md` (reusable in a new blank project).
- **Strict verdicts:** use **FULL PASS / PASS CORE · PARTIAL PROOF / PARTIAL / BLOCKED / FAIL** with per-layer verdicts (Core · Codex · Browser proof · Dashboard · Project isolation · Overall). Do **not** use FULL PASS if a required Codex/browser proof was blocked.

## Project isolation (REQUIRED — always on)
1. Work **only** in the active project folder where Forge was invoked. Never edit other projects or unrelated dirs.
2. If the folder/project is ambiguous, **ask which exact project folder is meant before any edit**, then stop and wait.
3. No edits outside the target folder. No global project edits without the user's explicit permission.
4. Don't modify global Claude/ECC folders unless the user explicitly says so.
5. Inspect before editing; never delete meaningful files without approval.

## START NEW / CONTINUE
- **START NEW** — a fresh build; confirm the target folder, then plan from scratch.
- **CONTINUE** — existing work; read the current state first, then proceed.
- If the user doesn't say which, infer safely and confirm the folder before editing.

## Codex (optional)
Codex is an **optional** code-quality reviewer for important changes (`/codex:review`). Never a blocker. If Codex isn't available, don't block — just report it wasn't run.

## Honesty
Never claim a check/test/review ran if it didn't. Report what changed, which agents/skills ran, which checks actually ran, and what was NOT run.

## Memory-aware & project-aware
If the project has Forge installed, it carries local memory in `.claude/`: `FORGE_PROJECT_PROFILE.md`, `FORGE_MEMORY.md`, `FORGE_DECISIONS.md`, `FORGE_TASK_HISTORY.md`, `FORGE_AGENT_LEDGER.md`. Read profile + memory **before** a task; update memory, task history, and the agent ledger **after**. Adapt the agent role map to each project (don't reuse one fixed set). Only write memory supported by real files/git/user instruction; mark `inferred`/`unknown`.

## Agent Activity Ledger (proof — no fake claims)
Record which agents really worked, with evidence, and **distinguish ECC from native**. Each row has a **Runtime** (ECC agent · ECC skill · native/main · Codex) and a Status. Statuses ONLY: `ECC REAL INVOKED` · `ECC SKILL LOADED` · `NATIVE AGENT INVOKED` · `INTERNAL ROLE ONLY` · `NOT USED` · `FAILED` · `BLOCKED`. Never claim an ECC/agent/Codex/test/preview that didn't actually run; native fallback is labeled `NATIVE AGENT INVOKED`, never dressed up as ECC.

## Dashboard awareness (per-project, isolated)
Each installed project has its **own** local-only **Forge Control Center** at `.claude/forge-dashboard/` with its **own stable port** (range 3737–3999, deterministic from the project path, stored in `.claude/forge-dashboard/PORT`; falls back to the next free port if busy and updates the file). Start: `node .claude/forge-dashboard/server.cjs` → it prints the actual `http://localhost:<port>` and writes `DASHBOARD_STATE.json`. Health: `GET /api/health`. Each run writes `.claude/forge-runs/<run_id>/{run.json, events.jsonl, final-report.md}`; append real events with `log-event.cjs`. **Never** a shared/global dashboard; never read/start/merge another project's dashboard, port, runs, or memory. On trigger phrases ("use Forge system" / "gebruik Forge systeem" / "/forge dashboard" / "start Forge dashboard"): confirm the active folder, start (or print the command for) THIS project's dashboard, health-check it, and report the real URL — **never fake a start**.

**Project isolation (v7.2 — strict).** Each dashboard server resolves its project root from its **own install location** (`__dirname/../..`) or an explicit `FORGE_PROJECT_ROOT`; it **never** serves the global template or another project, and lists runs **only** from its own `.claude/forge-runs/`. `/api/health` reports `project_root` · `project_id` · `dashboard_port` · `server_pid` · `cwd` · `script_dir` · `latest_run_id` · `isolation_status` (OK / PROJECT_ROOT_MISMATCH / STATE_PROJECT_MISMATCH / RUN_PROJECT_MISMATCH). On start the server **validates `DASHBOARD_STATE.json` against the current project root** and, on mismatch, backs it up (`.mismatch.bak`) + writes fresh state. The top bar/footer show project name · root · port · run id so the served project is unmistakable. **Never sync live per-project state between projects** — `PORT`, `DASHBOARD_STATE.json`, `.claude/forge-runs/`, `FORGE_SESSION_STATE.json` (active/last_run), `FORGE_MEMORY/LEDGER/TASK_HISTORY.md`, and project-specific `CLAUDE.md`/custom skills are **per-project only**; template sync copies **code + neutral scaffolds** (mode `off`), never another project's live state. **Different ports must never show the same project unless started from the same folder** — if they do, you have duplicate/zombie servers: stop them by **listening port** or by the `server_pid` from `/api/health` (a command-line match on the project path fails because the node process argv is just `node server.cjs`).

**Windows start (recommended `.cmd` first):** `.claude\forge-bin\forge-dashboard.cmd` (PowerShell may block `.ps1` — then use `.cmd` or `powershell -ExecutionPolicy Bypass -File ...`). The wrappers auto-detect Node: `node` on PATH → `C:\Program Files\nodejs\node.exe` → else a clear "install Node.js LTS, reopen terminal" message (never silent). If `node` was just installed (e.g. winget) and "not recognized", close and reopen the terminal. Never change global PATH or execution policy; never install Node automatically.

## Forge report (default format)
End non-trivial work with: Classification · Project Adaptation · What was done · Files changed · Checks actually run · Agent Activity Ledger · Memory Update · Dashboard Update · Issues · Remaining risks · Codex block · Verdict · Next step.

---

## INSTALLER — trigger: `install Forge V2 into this project`

When the user writes **"install Forge V2 into this project"** (or clearly asks to install Forge into the current project), treat it as an installer command. Do not assume the project is new — support installing mid-project. Run these phases:

**Phase 1 — Detect** the active project folder (cwd / where the user is). State it back.
**Phase 2 — Confirm the target** if there's any ambiguity (parent vs subfolder, multiple candidates). Do not install until clear. Refuse to modify any other folder.
**Phase 3 — Project State Scan.** Inspect folder structure, README, existing `CLAUDE.md`, package/config files, docs, workflows, `.env.example`, important source, existing `.claude/`, git history if present. Detect project type, stack, goal, maturity (new/existing/mid/mature), what's built, open tasks, known issues, integrations, deployment status, and files that must NOT be overwritten. Mark anything unverified `inferred`/`unknown`. Never fake knowledge.
**Phase 4 — Create/update `.claude/FORGE_PROJECT_PROFILE.md`** from the scan, including a **project-specific agent role map** (default/optional/irrelevant agents, matching playbooks, parallel vs sequential workstreams, why this team fits).
**Phase 5 — Create/update `.claude/FORGE_MEMORY.md`** from the scan (don't wipe existing memory; mark inferred/unknown).
**Phase 6 — Copy the template** from `~/.claude/forge/template/` into that project ONLY:
   - `.claude/commands/forge.md`, `.claude/agents/codex-reviewer.md` (optional reviewer)
   - `.claude/skills/forge-*` (forge-router, ship-readiness, forge-report, forge-website, forge-fullstack, forge-n8n, forge-scraping, forge-rag, forge-prediction, forge-integration)
   - `.claude/forge-dashboard/` (server.cjs, log-event.cjs, index.html, app.js, styles.css, README.md, start-forge-dashboard.bat)
   - `.claude/forge-bin/` (the command pack: forge/dashboard/status/runs/open-report/log-event × .ps1/.cmd/.sh + README.md)
   - memory scaffolds for any not created in Phases 4–5: `.claude/FORGE_DECISIONS.md`, `.claude/FORGE_TASK_HISTORY.md`, `.claude/FORGE_AGENT_LEDGER.md`
   - `.claude/FORGE_ECC_MODE.json` — ECC mode config (defaults: `ecc_normal_mode: "on"`, `ecc_full_test_mode: "off"`)
   - `.claude/FORGE_SESSION_STATE.json` — Forge Session Mode state (default `mode: "off"` until a `/forge` / "gebruik Forge" starts it)
   - `.claude/FORGE_SKILL_REGISTRY.md` — project-local skill registry (built-in/Forge/ECC/project-local skills + status)
   - `env.example` → `.env.example`
   Use a copy that won't trip path guards (e.g. `robocopy` for the `.claude` subtree on Windows).
**Phase 7 — Dashboard files.** Ensure `.claude/forge-dashboard/` is in place (copied in Phase 6). If `package.json` exists, you may add a `"forge:dashboard": "node .claude/forge-dashboard/server.cjs"` script (only if safe).
**Phase 8 — Assign a stable project-local port.** Run `node .claude/forge-dashboard/server.cjs --assign-only`. This computes a deterministic port (range **3737–3999**, from a hash of the project path), writes `.claude/forge-dashboard/PORT`, and creates `DASHBOARD_STATE.json`. Each project gets its **own** port; if it's busy at start time the server walks to the next free port and updates `PORT`.
**Phase 9 — Dashboard state file.** Confirm `.claude/forge-dashboard/DASHBOARD_STATE.json` exists (project name/folder, preferred/actual port, URL, status, latest run). Project-local only.
**Phase 10 — Install the command pack** `.claude/forge-bin/` (copied in Phase 6): cross-platform wrappers (`.ps1`/`.cmd`/`.sh`) for forge/dashboard/status/runs/open-report/log-event + README. **Project-local only — no global shell commands, no PATH changes, no admin rights.**
**Phase 11 — package.json scripts (if present, safe-merge).** If the project has `package.json`, add `"forge"`, `"forge:dashboard"`, `"forge:status"`, `"forge:runs"`, `"forge:open-report"` **only if absent**. On a name conflict use `forge2:*` or report + ask. Keep JSON valid; don't add/install dependencies; the dashboard stays zero-dependency.
**Phase 12 — VS Code tasks (if safe).** If `.vscode/` exists (or is safe to create), add `Forge: Start Dashboard / Status / Runs / Open Latest Report` to `.vscode/tasks.json` (merge, never overwrite existing tasks). If merging is risky, write `.vscode/tasks.forge.example.json` instead.
**Phase 13 — Run/event structure:** `.claude/forge-runs/` (with `README.md`). Real runs are created per `/forge` task.
**Phase 14 — Initialize task history + agent ledger** (`FORGE_TASK_HISTORY.md`, `FORGE_AGENT_LEDGER.md`) with an install entry.
**Phase 15 — Start or provide the dashboard command (no fake starts).** Start it (`node .claude/forge-dashboard/server.cjs`, or a `forge-bin` wrapper, or detached `Start-Process node ...`) and **health-check** `http://localhost:<port>/api/health`. If the environment can't keep a process alive, print the exact command + actual URL instead. Never claim running unless the health check passed.
**Phase 16 — Project CLAUDE.md (create / SAFE-MERGE) + skills dir + .gitignore + final report.** Check `CLAUDE.md` (log `claude_md_checked`): if missing, create from the project scan + `template/CLAUDE.md` (log `claude_md_created`); if it exists, **read it, preserve existing rules, and add/refresh only a `## Forge Studio v7` section** (log `claude_md_updated`) — never overwrite blindly; on conflict log `claude_md_conflict_detected` and ask. Check `.claude/skills/` (log `project_skill_dir_checked`; create if missing) and create any needed project-local custom skills (`custom_skill_created`). Append missing `template/gitignore.snippet` lines (incl. `.claude/forge-runs/`, `PORT`, `DASHBOARD_STATE.json`). Report honestly: every file created/changed, **CLAUDE.md created/updated/no-change/conflict + what was preserved**, **custom skills created/used**, the role map, **the actual dashboard port + URL + health result**, the **Command Pack Update** (forge-bin / package.json scripts / VS Code tasks + how to start in PowerShell/CMD/Bash/npm), and confirm **no** security hooks/`settings.json` were installed.

**New-project defaults:** ECC **Normal Mode ON**, ECC **Full Test Mode OFF**, **Forge Session Mode OFF** (until `/forge`/"gebruik Forge" starts it), project isolation ON, no heavy security gates, no global unblock, no global config changes. New projects work **ECC-based + Lead-Agent-studio by default** — they just never get broad test/unblock mode automatically.

**Do NOT install:** any hooks, `.claude/settings.json` security config, AgentShield, `secrets-guard`, `prod-deploy-guard`, any mandatory security/production gate, or any **global unblock / ECC Full Test Mode**. **Never** touch files outside `<project>` or modify global Claude/ECC folders during an install.

After install, the project-local `/forge` + `forge-*` skills + dashboard take over for that project.


<!-- ───────────────────────────────────────────────────────────────────────────
     Forge global add-ons appended 2026-06-30 (APPEND-ONLY; nothing above removed).
     Backup of the pre-append file: SKILL.md.bak-2026-06-30-addons
     Two add-ons below: (1) Task Execution / Work Packages / Lead-Agent / Codex,
     (2) Paperclip-inspired Agent Control Plane (verdict: YES — isolated test first).
─────────────────────────────────────────────────────────────────────────── -->

## Detailed operating playbooks — MANDATORY on-demand reads (kept here, not inlined, to keep this core lean)

The full Forge operating detail below is **not** inlined in this core anymore — it lives in `references/` and
you **MUST** read the matching file at the moment its phase begins (this is progressive disclosure, not an
optional extra — the rules there are binding exactly as if inlined):

- **Before running ANY Forge mission / work packages** → read `references/task-execution.md`
  (Executing a Forge mission — work packages, task format, AGENT_TASKS.json, proof log, blockers, decisions log, Codex review flow, masterprompt rule, execution order, final report, screenshot loop, security layer, cleanup, strict-done, authority summary).
- **When orchestrating the agent control plane** (org chart, tickets, heartbeats, budget, audit, Paperclip)
  → read `references/control-plane.md`.
- **When writing or grading a masterprompt** → read `references/masterprompt-quality.md`.

Skipping the relevant reference is a governance violation — the detail is binding, just lazy-loaded to save tokens.

<!-- forge-onboarding-i18n-v1 -->
## Language — internationalization (required)
Forge is international. The user's language is captured during `/setup-forge` and stored in the project
marker (read it via `node .claude/forge-bin/forge-setup.cjs lang`, default `en`). The Lead **replies to the
user and writes the final report in that language**, defaulting to English when unset. Keep commands, paths
and code identifiers verbatim; the dashboard carries its own language toggle.
