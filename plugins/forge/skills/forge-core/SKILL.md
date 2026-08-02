---
name: forge-core
description: Global lightweight Forge Core. Use for any goal-shaped build/create/automate/fix/research request, or triggers: install Forge V2 into this project, use Forge system, gebruik Forge systeem, start Forge dashboard. Runs the Forge Command Center at 127.0.0.1:4100.
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
**THE dashboard for every project is the Forge Command Center** -- one dashboard, all projects: the zero-dependency gateway at `http://127.0.0.1:4100` (source: `C:/Users/YOU/Documents/my-forge-project/command-center/`). It auto-discovers every project (registry incl. Documents/ and Documents/ForgeProjecten/), serves chat/runs/agents/tasks/artifacts per project, and is the ONLY layer that may spawn the real `claude` CLI. Start (preferred, auto-restart): `node "C:/Users/YOU/Documents/my-forge-project/command-center/gateway/supervisor.mjs"` -- then health-check `GET http://127.0.0.1:4100/api/health` and report that URL. On trigger phrases ("/forge dashboard" / "start Forge dashboard" / "use Forge system"): check 4100 health FIRST; if down, start the supervisor (background, output appended to its log file), health-check, report the real URL -- **never fake a start**. After a gateway (re)start also restart the Discord service if it was running: `POST /api/discord/start` with the exec token read from the served page's cc-exec-token meta tag. **The old per-project Forge Control Center (`.claude/forge-dashboard/server.cjs`, ports 3737-3999) is RETIRED (owner decision 2026-07-31): never start it in any project.** Keep the directory in place -- `log-event.cjs` remains the per-project run-event writer (`.claude/forge-runs/<run_id>/events.jsonl`), which the Command Center reads -- and ensure a one-time backup copy `.claude/forge-dashboard-backup-<date>/` exists per project before any change there. Never claim the dashboard runs unless the 4100 health check passed.

**Project isolation still holds for data:** the Command Center reads each project's own `.claude/forge-runs/` and memory from that project's folder only; run events, memory and state remain per-project files. One dashboard, strictly per-project data.

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
**Phase 8 — (retired) no per-project dashboard port.** The Command Center on 4100 serves every project (owner decision 2026-07-31); do NOT run `--assign-only` and do not create PORT/DASHBOARD_STATE for new installs. `log-event.cjs` is still installed — it is the run-event writer the Command Center reads.
**Phase 9 — Dashboard state file.** Confirm `.claude/forge-dashboard/DASHBOARD_STATE.json` exists (project name/folder, preferred/actual port, URL, status, latest run). Project-local only.
**Phase 10 — Install the command pack** `.claude/forge-bin/` (copied in Phase 6): cross-platform wrappers (`.ps1`/`.cmd`/`.sh`) for forge/dashboard/status/runs/open-report/log-event + README. **Project-local only — no global shell commands, no PATH changes, no admin rights.**
**Phase 11 — package.json scripts (if present, safe-merge).** If the project has `package.json`, add `"forge"`, `"forge:dashboard"`, `"forge:status"`, `"forge:runs"`, `"forge:open-report"` **only if absent**. On a name conflict use `forge2:*` or report + ask. Keep JSON valid; don't add/install dependencies; the dashboard stays zero-dependency.
**Phase 12 — VS Code tasks (if safe).** If `.vscode/` exists (or is safe to create), add `Forge: Start Dashboard / Status / Runs / Open Latest Report` to `.vscode/tasks.json` (merge, never overwrite existing tasks). If merging is risky, write `.vscode/tasks.forge.example.json` instead.
**Phase 13 — Run/event structure:** `.claude/forge-runs/` (with `README.md`). Real runs are created per `/forge` task.
**Phase 14 — Initialize task history + agent ledger** (`FORGE_TASK_HISTORY.md`, `FORGE_AGENT_LEDGER.md`) with an install entry.
**Phase 15 — Dashboard = the Command Center (no fake starts).** Check `http://127.0.0.1:4100/api/health`; if down, start `node "C:/Users/YOU/Documents/my-forge-project/command-center/gateway/supervisor.mjs"` in the background (output to its log), health-check again, and report `http://127.0.0.1:4100` as THE dashboard URL for this project (it auto-discovers the project). Never start the retired per-project server.cjs. Never claim running unless the health check passed.
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


<!-- ───────────────────────────────────────────────────────────────────────────
     Forge v8 add-on appended 2026-07-19 (APPEND-ONLY; nothing above removed).
     Backup of the pre-append file: SKILL.md.bak-v8-20260719-010444
     Adds the owner-memory / autonomy / evidence-gate / learning layer as the GLOBAL
     default, plus the "stay current" rule so every project uses the upgraded system.
─────────────────────────────────────────────────────────────────────────── -->

## v8 — Owner-memory · autonomy · evidence-gates · cross-project learning (GLOBAL DEFAULT)

This layer is the **default for every project** the moment its local Forge V2 install is present (the tools ship with the template). When `/forge` / `gebruik Forge` runs in a project that has `.claude/forge-bin/`, the Lead Agent MUST apply the following **before** and **during** the mission. When the tools are absent (lightweight-only project), apply them as behavioural intent and offer the install (see "Stay current"). Everything here **reinforces** the honesty core and project isolation — it never weakens them.

**1. Read + apply owner memory FIRST (before intake).** Resolve the owner profile and standing rules and echo what was applied:
- `node .claude/forge-bin/forge-prefs.cjs list` → the owner's durable defaults (never-auto-push, language nl-UI/en-code, deep-research-first, real-file-testing for correctness-critical work, UI-quality default, draft-only outreach, autonomy default…). Each value carries a real source; nothing is invented.
- `node .claude/forge-bin/forge-standing.cjs match --type <domain>` → the enforceable standing rules that apply (honesty-core rules are `cannot_override_core` and can never be shadowed).
- Emit the **applied-prefs echo** (`owner_prefs_loaded` event via `forge-echo.cjs`) so the run visibly states which prefs/rules were auto-applied — nothing changes behaviour silently.
- Precedence is fixed: **hard-gates > current owner instruction > standing-rules > owner-profile defaults > auto-defaults** (`config/orchestration/precedence.md`).
- `/forge remember <text>` promotes an owner-approved rule to active (the ONLY sanctioned auto-active path — reflection may only STAGE candidates).

**2. Autonomy = `continue-within-mission` by default.** No phase-to-phase re-asking within a mission (`forge-autonomy.cjs`). BUT the hard-gates ALWAYS interrupt regardless of mode: deploy · git-push · spend · DNS · prod-activate · credential-attach/rotate · workflow-activate · outbound-send · write-outside-project-root, plus usage-limit. `forge-actiongate.cjs` (config `hard-gates.json`) is the single source of truth for that classification — never re-implement it.

**3. Evidence gates (a run is not "done" without real proof).** `forge-evidence.cjs` enforces per-domain required evidence — e.g. a website/full-stack run needs real responsive screenshots (desktop+tablet+mobile) + the auto **web-quality contract** (`config/orchestration/web-quality-contract.md`: real content, working states, tasteful motion, screenshot check) or it is not complete. Correctness-critical domains (finance/parser/ocr/data) require real fixtures (`forge-fixtures.cjs`) or a logged waiver — no silent synthetic fallback. `forge-orchestrate.cjs` records which checklist steps actually ran vs were skipped (kills "a check was silently skipped").

**4. Learn across runs and across projects.** Before dispatch, recall the highest-utility relevant lessons incl. the reserved **global** namespace (`forge-recall.cjs`) — a lesson that worked in one project is surfaced in the next. Lessons are canonical quotes tied to real outcomes, outcome-gated and anti-gaming (`forge-consolidate.cjs` / `forge-reinforce.cjs`) — never synthesised. `/forge learn` runs **`forge-harvest.cjs`**: a READ-ONLY, secrets-excluded, evidenced-only harvest of the owner's other Forge projects' `FORGE_*` memory into that global namespace (opt-in; never writes to another project; never harvests `.env`/keys/PII). **AUTO-CAPTURE (owner-besluit 2026-07-31 — standaard, elke run):** at the END of every run the Lead writes the run's genuinely-learned, evidence-backed lessons into this project's `.claude/agent-memory/global/lessons.jsonl` (same record shape forge-recall/consolidate read) — automatically, not only on /forge learn. This explicitly INCLUDES useful facts learned during research that are unrelated to the task itself (the owner wants steady cross-domain learning), each tied to its real source/outcome. Never store secrets/PII; never store unverified claims — a lesson without evidence is not a lesson. Periodically run `forge-consolidate.cjs --store .claude/agent-memory/global/lessons.jsonl` for decay/prune so the store stays high-signal.

**5. Verification depth.** Test Boss runs `forge-mutcheck.cjs` on changed files (a surviving mutant = a hollow test → strengthen it); `forge-trace.cjs` maps each requirement → verified artifact. New domain playbooks available: **payments · ecommerce · electron · voice** (plus the existing website/full-stack/n8n/scraping/rag/prediction/integration) with their `config/rubrics/*` and the `payment-integration`/`electron-pro` specialists.

**6. Doctor is honest.** `forge-doctor.cjs` now runs completeness checks (sync-manifest complete · no green no-ops · memory populated · event vocabulary registered) alongside correctness — a green doctor means the system is genuinely complete, not "10/10 but missing pieces". Every new event type must be registered in all 3 places (`log-event.cjs` KNOWN_EVENT_TYPES · `forge-verify.cjs` allow-list · `forge-dashboard/app.js`).

## Stay current (so the upgrade is used EVERYWHERE, always)

Whenever `/forge` / `gebruik Forge` runs in a project, the Lead Agent checks the project's Forge version against the canonical template and brings it current before working:
- `node .claude/forge-bin/forge-sync.cjs status .` (or `forge-sync doctor`) reports `installed=<hash>` vs `template=<hash>`.
- If the project is **behind** (or has no local install), offer / run the safe installer: `node ~/.claude/forge/template/.claude/forge-bin/forge-sync.cjs install "<projectDir>"` — it takes a per-project backup, validates with `forge-doctor` before+after, and rolls back on any regression (drift on a system file is refused, not clobbered, unless `--force-overwrite` is justified). Never overwrite a project's own app code — `forge-sync` only ever touches `.claude/` system files.
- The **canonical template** (`~/.claude/forge/template/.claude`) is the single source of truth; a new project install and an existing-project update both flow from it, so every project — present and future — runs the same current Forge.

## v8 subcommands (project-local, after install)

`/forge resume <run_id>` — a session/usage limit killed a swarm mid-run; reconcile the run's manifest **purely from its logged events** and re-dispatch ONLY the unfinished work packages (`forge-manifest.cjs` + `forge-swarm-resume.cjs`; a side-effecting WP still needs its own `forge-checkpoint.cjs` idempotency guard). · `/forge learn` — cross-project learning harvest (§4). · `/forge remember <text>` — promote an owner rule to active (§1).


<!-- ───────────────────────────────────────────────────────────────────────────
     Forge v8.1 add-on appended 2026-07-19 (APPEND-ONLY; nothing above removed).
     Backup of the pre-append file: SKILL.md.bak-v81-20260719-132122
     Adds the MCP-client keystone (Wave G) + the moonshot tools (Wave J) — all
     dormant/opt-in/owner-gated, so the zero-dep default is never broken.
─────────────────────────────────────────────────────────────────────────── -->

## v8.1 — MCP client keystone + moonshots (all DORMANT/OPT-IN/OWNER-GATED)

Additive to v8. Everything here is **off by default** — the zero-dependency Forge default is never broken, and nothing external runs or self-acts without an explicit owner opt-in / approval.

**MCP as a CLIENT (Wave G) — dormant + least-privilege.** Forge can call external MCP tools (docs, web search, browser-QA, GitHub) but ONLY through `forge-mcp-gate.cjs` + `config/orchestration/mcp-registry.json` + `mcp-grants.json`, governed by the **`forge-mcp-clients`** skill:
- **4 capability tiers** — 0 read-only-local · 1 read-only-remote · 2 sandboxed-action · 3 write-primitive.
- **Per-Boss least-privilege**: each Boss has a max tier + an allow-list; it can never obtain a tool above its tier or from a server it wasn't granted.
- **"mcp-write is a write-primitive"**: every tier-3 (write) MCP tool routes through `forge-actiongate.cjs` — it is hard-gated exactly like deploy/push/spend and can never be a standing/auto grant.
- **Dormant by default**: every registry server is `not-installed`; nothing activates until the owner copies `config/mcp/.mcp.json.example` to a real `.mcp.json` and sets `opted_in`. Absent → labeled native fallback. **Defer-load** tool schemas via ToolSearch (token discipline). The doctor's `mcp_dormancy` check flags any auto-active server or over-tier grant.

**Moonshot tools (Wave J) — real, but gated:**
- **`forge-genesis.cjs`** — when Forge hits a capability gap it can PROPOSE a new skill/agent, but only STAGED to `.claude/forge-genesis-staging/` with evidence; it NEVER writes into the live `.claude/skills/` and only `/forge approve-skill` (with an explicit owner token) promotes it. No self-activation.
- **`forge-tournament.cjs`** — best-of-N: plan N distinct-angle variants (in worktrees), score against a transparent rubric, promote the winner + graft runner-up ideas. Real scoring, never a fabricated winner.
- **`forge-secondbrain.cjs`** — a READ-ONLY, secrets-excluded portfolio strategist: every recommendation is evidence-cited `{project, file, fact}`; it writes to no project and never reads a secret.
- **`forge-codemodel.cjs`** — a living, incrementally-updated repo index a Boss queries cheaply (only changed files re-index); results are honestly labeled stale if the index is behind.
- **`forge-nightshift`** (skill) + **`forge-briefing.cjs`** — an OPT-IN overnight builder that survives session limits via resume and hands you a morning briefing; it NEVER self-schedules and hard-gates still interrupt overnight.
- **`forge-guardian`** (skill) — a SCAFFOLD/OWNER-GATED deploy→monitor→self-heal→redeploy doctrine; it never touches production without your explicit per-step circuit-breaker approval and prod credentials you supply.

New v8.1 subcommands (project-local, after install): `/forge propose-skill` / `/forge approve-skill <name> --owner-approval <token>` (genesis) · `/forge tournament` · `/forge secondbrain` · `/forge codemodel` · `/forge briefing <run_id>`.


<!-- ───────────────────────────────────────────────────────────────────────────
     Forge v10 add-on appended 2026-07-25 (APPEND-ONLY; nothing above removed).
     Backup of the pre-append file: SKILL.md.bak-v10-20260725-234428
     Encodes 3 owner-mandated standards (owner directive 2026-07-25): autonomous
     WP-dispatch, verify-binding as the per-task DEFAULT, and usage-pressure model
     routing — plus making the existing smart-subagents doctrine explicit.
─────────────────────────────────────────────────────────────────────────── -->

## v10 — AUTONOMOUS WP-DISPATCH · VERIFY-BINDING · USAGE-PRESSURE ROUTING (owner directive 2026-07-25)

**1. Autonomous WP-dispatch — no "use subagents" ask needed.** Every large/multi-part owner prompt is AUTOMATICALLY split by the Lead into work packages `wp0..wpN` (each with `taak 1..n`) in the owner's canonical shape (`wp0 (taak 1, taak 2, taak 3) · wp1 (…) · wp2 (…)`), per the existing **WP/FASE EXECUTIE-STANDAARD** add-on (`references/masterprompt-quality.md`). The owner never has to say "use subagents" or a count — the Lead computes team size itself: smallest relevant team (existing default), capped by usage-pressure routing (§3 below) and harness concurrency. Scout/read-only WPs run parallel; write-WPs get **one writer per hotspot** (the existing orchestration-safety HARD MUST is unchanged). Intake questions (Step 0a in `forge-router`) fire only when the mission genuinely needs a real owner choice; otherwise `continue-within-mission` autonomy (v8 §2) applies — this add-on inherits that gate, it does not restate it.

**2. Verify-binding per task — DEFAULT, not optional.** Every dispatched work package now gets a **bound verification before the Lead may mark it DONE**: **(a)** builder claims are re-executed by an independent verify pass — a real, dispatched, REGISTERED Boss (never an invented "Verify Boss" name; that name is not in `agent-registry.json`) takes the role `<wp>-verify` and re-runs/re-checks the owning Boss's claims (precedent: run `forge-2026-07-25-full-audit`, `role:"wp1b-verify (verify-boss re-executor)"` on agent `Test Boss`); **or (b)** for read-only/audit work packages, at minimum `node .claude/forge-bin/forge-verify.cjs <run_id> --enforce` on the run plus the Lead's own spot re-execution of load-bearing claims. A WP whose verify pass finds a mismatch goes back to the owning Boss as **rework** through the existing VERIFY-LOOP events (`rework_task_created` → `rework_assigned` → `rework_completed`, `references/masterprompt-quality.md`'s VERIFY-LOOP add-on) — the Lead may not accept DONE without the verify verdict. This binds the existing `forge-verify.cjs` / `forge-report` REPORT-CONTRACT **per work package**, not only per run.

**3. Usage-pressure routing (owner: near ~80% weekly usage, prefer NVIDIA without extreme quality downgrade — e.g. 3-4 Claude subagents + ~10 NVIDIA-offloaded tasks).** Before dispatch the Lead reads `~/.claude/FORGE_USAGE_PRESSURE.json` (account-wide — weekly usage is account-wide, not per-project; written by `usage-guard.cjs` next to its other state files); if absent, run `node .claude/forge-bin/usage-guard.cjs status`. `level:"nvidia-preferred"` → cap concurrent Claude subagents at 3-4 and route bulk-able work (drafting, summarization, research triage, boilerplate, doc drafts) through NVIDIA per `agent-model-map.json`'s `usagePolicy` — **only** the 6 `nvidiaForBulkOnly` Bosses (`docs-boss, seo-boss, search-boss, skill-boss, test-boss, build-boss`). The 6 `claudeWinsSkipNvidia` Bosses (`boss, head-chef, review-boss, security-boss, integration-boss, ui-boss`) are **never** downgraded — QA/security/review/lead-critical acceptance criteria and the verify-binding in §2 stay identical regardless of usage pressure. Every NVIDIA bulk output is still reviewed by its owning Claude Boss before acceptance (existing bulk-offload contract, `agent-model-map.json`'s `_verdict`). `level:"pause"` keeps existing guard behaviour unchanged (pause wins over everything). Honesty: never claim NVIDIA ran when it didn't; ledger rows label NVIDIA bulk work explicitly.

**4. Smart-subagents doctrine (lesson-memory, NOT model training).** Subagents get smarter ONLY through real, existing mechanisms — never claim more than this: **(a)** pre-dispatch lesson-recall (`forge-recall.cjs` / the router's Lesson-recall clause via `forge-distill.cjs --recall <boss-slug> <keywords>`) injected into the dispatch prompt; **(b)** per-Boss agent-memory (native `memory: project`, `.claude/agent-memory/<boss>/MEMORY.md`, per the existing PER-BOSS MEMORY add-on) read at start, evidence-based lesson appended at end; **(c)** post-run distill after verify (`forge-distill.cjs --run <run_id>` / `forge-consolidate.cjs` / `forge-reinforce.cjs`, the existing SELF-LEARNING LOOP, v8 §4); **(d)** periodic `forge-deeplearn` codebase priming for build-heavy missions. This is durable lesson-memory across runs, **not** weight/model training — never report a subagent as "trained" beyond this. Heavier external research into agent-training techniques stays an owner-gated, separately-approved option.
