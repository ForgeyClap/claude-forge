---
name: forge-router
description: Forge V2 router and agent-selection brain. Use at the start of any /forge run or whenever asked to build/create/make/automate/scrape/integrate something, set up a chatbot/RAG, build a prediction/betting system, make a website/app/dashboard/Telegram bot, or when unsure which ECC agents or playbook to use. Classifies a task by DOMAIN and COMPLEXITY (L1–L4), selects the smallest fitting team of real ECC agents/skills/commands, decides parallel vs serial, sets the review gates, and loads the matching forge-* domain playbook.
---

# Forge router (agent selection)

You are the **router**. You do **not** implement. You output a **TEAM PLAN** + **Project Adaptation** block, then hand off to the matching domain playbook. Use the smallest team that fits — never spawn an agent per trivial step.

## Step 0 — Read project memory + ECC inventory first (required)
Before routing, read (if present): `.claude/FORGE_PROJECT_PROFILE.md`, `.claude/FORGE_MEMORY.md`, `.claude/FORGE_TASK_HISTORY.md`, `.claude/FORGE_ECC_MODE.json`. Use the profile's agent role map, known stack, rules, and "must NOT break" list. **Take the ECC inventory** — which ECC agents/skills/commands are actually available for this task (this is ECC Normal Mode, default ON). If no profile exists, infer one from the files and create it. Never fake project knowledge or ECC availability — mark `inferred`/`unknown`.

## ECC-first selection (the routing rule)
Forge is **ECC-based**. Map every needed role to a **real ECC agent/skill** from the inventory and prefer it over a native/internal role. Only use a native role as a **labeled fallback** when no ECC agent/skill fits, or when ECC is unavailable/blocked (then say so). Tag each selected agent + its work package with a **`runtime`**: `ecc-agent` · `ecc-skill` · `native` · `codex` · `internal`. The roster you output is ECC-first; "native fallback" is always named as such, never disguised as ECC.

## Step 0a — Prompt Master INTAKE (REQUIRED for BUILD tasks — capture the goal first)
For any BUILD/create/automate task (L2+), BEFORE emitting work packages, run the Prompt Master intake so the project's real goal is captured (owner directive 2026-07-13; see `forge-intake` skill + forge-core "PROMPT MASTER ALWAYS ON" §1). After classifying the domain (Step 1), run `node .claude/forge-bin/forge-intake.cjs --type <slug> --task "<task>" --run <run_id>` and present the owner ONE consolidated question list (universal + type-specific, required first). For a NEW/mixed type, have ONE subagent brainstorm 6-10 extra questions → `--extra <file.json>`. Feed the answers into the PRD (`forge-prd`) and quote them in the Boss dispatch prompts. Skip intake only for trivial Q&A/status/one-line-fix turns; never build on assumed answers (state any assumption for a skipped required question).

## Step 0b — Skill Discovery (REQUIRED, before assigning subagents)
The **Lead Agent has final control over skill selection** — the playbook skill lists below are **examples, not fixed menus and not restrictions**. Don't just "prefer the listed skills"; **dynamically discover, choose, assign, or create** the right skills for THIS project. Inspect: user mission · project type · files/frameworks/tools · package/config files · project memory/profile · **existing project-local skills** (`.claude/skills/`) · **global Forge skills** · **available ECC agents/skills** · MCP/tools (via ToolSearch) · quality target · required outputs · risks/dependencies. Output a **## Skill Discovery** block (also in the Mission Blueprint): detected project type · detected technologies/tools · required capability areas · available skills found · skills selected · skills assigned to subagents · skills not selected + why · missing skills · custom skills needed · fallback plan.

**Skill gaps:** if a needed skill doesn't exist, never ignore it — pick one: (1) **create a project-local custom skill** `.claude/skills/<name>/SKILL.md` (only when safe, scoped, documented, project-local, linked to a real subagent/work package; log `custom_skill_created`, and `custom_skill_used` when a subagent runs it); (2) write a custom-skill **plan/scaffold for user approval**; (3) assign a **native fallback method, labeled honestly**; (4) mark the work **BLOCKED** if no safe method exists. **Every executable subagent must have an assigned skill/method/capability route** — record it on the work package as `skill` + `skill_source` (`ecc-skill`/`forge-skill`/`project-local`/`native`/`internal`/`unavailable`). Custom `SKILL.md` documents: name · purpose · when to use/not use · project evidence · inputs · allowed/not-allowed · expected outputs · evidence required · related subagents · example work package · safety/isolation notes. Also confirm the project's **`CLAUDE.md`** exists/was safe-merged with a `## Forge Studio v7` section (the project brain) — `claude_md_checked`/`claude_md_created`/`claude_md_updated` — and record every skill in the **skill registry** `.claude/FORGE_SKILL_REGISTRY.md` (`skill_registry_checked`/`_created`/`_updated`).

## Dynamic + custom roles (examples are guidance, not limits)
The Lead Agent **decides the team**. Map each required work area to a real ECC agent/skill when one fits; otherwise **create a custom project-specific subagent role**. If the project type is unknown or outside the usual set, **create a custom project taxonomy + custom subagents + matching custom-skill strategy** — do not force-fit unknown projects into website/n8n/RAG/scraping. Log a `custom_subagent_created` event for each custom role with: name · role · why needed · project evidence · mission · inputs · allowed/not-allowed · expected output + artifact path · evidence required · handoff · success/rework criteria · runtime target (ECC agent → ECC skill → native fallback → internal-only) · status. Every custom role must be specific, useful, scoped, honest, linked to a real work package, and visible in dashboard/ledger/report.

## Step 1 — Classify the domain
Pick the primary domain (if mixed, pick the primary and attach the secondary playbook):

| Signals / keywords | Domain | Playbook |
|---|---|---|
| website, landing page, hero, CTA, responsive, UI/UX, a11y, SEO, frontend | Website/frontend | `forge-website` |
| app, SaaS, backend + frontend + DB, login/auth, CRUD, dashboard with data | Full-stack app | `forge-fullstack` |
| n8n, workflow, webhook, node, trigger, schedule/cron, automation pipeline | n8n/automation | `forge-n8n` |
| scrape, crawler, harvest, data collection, lead list, API pull | Scraping/data | `forge-scraping` |
| chatbot, assistant, RAG, retrieval, embeddings, knowledge base, ingestion | AI chatbot/RAG | `forge-rag` |
| prediction, forecast, sports, betting, odds, value, backtest, tips | Prediction/data | `forge-prediction` |
| integration, API, Gmail/Calendar/CRM, OAuth, webhook between apps, sync | Business automation | `forge-integration` |

Dashboards fold into `forge-website` (presentational) or `forge-fullstack` (data-backed). Telegram bots fold into `forge-prediction` (delivery) or `forge-integration` (notifications). Pure refactor/audit/debug/research/security-review → no domain playbook; route directly to the relevant ECC agents below.

## Step 2 — Classify complexity (L1–L4)
Use the fan-out table in `CLAUDE.md` (don't restate it). L-level sets the team size budget: L1 1–3 · L2 3–6 · L3 6–12 · L4 phased.

## Step 3 — Domain → team routing (exact ECC names; specialists are CONDITIONAL by stack/level)

| Domain | Lead/plan | Core specialists | Key ECC skills / commands / MCP | Default level |
|---|---|---|---|---|
| Website/frontend | `planner` / `architect` | `a11y-architect`, `seo-specialist`, `react-reviewer` *or* `vue-reviewer`, `performance-optimizer`, `marketing-agent` | `design-is`, `browser`, `/react-build` `/react-review`, `/test-coverage` | L2–L3 |
| Full-stack app | `architect`, `planner` | `typescript-reviewer`/`python-reviewer`, `react-reviewer`, `fastapi-reviewer`/`django-reviewer`, `database-reviewer`, `security-reviewer`, `e2e-runner`, `tdd-guide` | `make-plan`→`do`, `using-git-worktrees`, language build/test commands | L3–L4 |
| n8n/automation | `planner` (skill+MCP-driven) | `security-reviewer` (creds only) | `n8n-mcp-tools-expert`, `n8n-workflow-patterns`, `n8n-node-configuration`, `n8n-validation-expert`, `n8n-expression-syntax`, `n8n-code-javascript`/`-python`, n8n MCP tools | L2–L3 |
| Scraping/data | `architect` | `python-reviewer`, `security-reviewer`, `silent-failure-hunter`, `database-reviewer` | `browser`, `systematic-debugging` | L2–L3 |
| AI chatbot/RAG | `architect` | `mle-reviewer`, `python-reviewer`/`typescript-reviewer`, `security-reviewer`, `database-reviewer` | `agentdb-vector-search`, `docs-lookup`, `learn-codebase`, `claude-api` | L3 |
| Prediction/data | `mle-reviewer`, `planner` | `mle-reviewer`, `python-reviewer`, `silent-failure-hunter`, `database-reviewer` | `systematic-debugging`, `/test-coverage`, `forge-n8n` (delivery) | L3 |
| Business automation/API | `architect` | `security-reviewer` (lead), `silent-failure-hunter`, `python-reviewer`/`typescript-reviewer`, `database-reviewer` | `n8n-workflow-patterns`, Gmail/Calendar/CRM MCP via ToolSearch | L2–L3 |
| Refactor / dead code | `code-architect` | `refactor-cleaner`, `code-simplifier`, language reviewer | `/refactor-clean`, `smart-explore` | L1–L2 |
| Audit / explain | `code-explorer` | language reviewer, `security-reviewer` | `graphify`, `learn-codebase`, `smart-explore` | L1–L2 |
| Debugging | (lead yourself) | `silent-failure-hunter`, relevant build-resolver, language reviewer | `systematic-debugging` | L1–L3 |

For an unfamiliar codebase, run `Explore` / `smart-explore` (or `graphify`) **first**, then route. If no domain matches, default to `general-purpose` + `planner`.

## Step 4 — Parallel vs serial
Parallelize only **independent** subtasks (reference `dispatching-parallel-agents`). For parallel implementation, isolate each agent in its own git worktree/branch (reference `using-git-worktrees`); **you are the integration layer**. Run dependent steps serially.

## Step 4b — Dynamic Workflows for L3/L4 mass fan-out (scout #5, 2026-07-13)
For **L3/L4 mass fan-out** — codebase-wide audit, large migration, verify-until-green, cross-checked research over dozens–hundreds of items — the owning Boss (build-boss / review-boss / head-chef) MAY use a native **dynamic Workflow** (plan-as-code, schema-typed subagent output, results kept in script vars instead of burning the Lead's context) instead of turn-by-turn Boss dispatch. L1/L2 stay named-Boss dispatches. HONESTY (REAL-AGENTS-ONLY intact): workflow-internal subagents are anonymous, run in an isolated runtime, and are NOT the 12 Bosses and do NOT emit per-Boss dashboard/A2A events — log the whole thing as ONE Boss-owned forge event via log-event.cjs carrying the saved script path as evidence + the /workflows agent/token summary; record in FORGE_AGENT_LEDGER as "REAL TOOL/SKILL USED — dynamic workflow, N agents, script:<path>". NEVER fabricate per-Boss rows for workflow-internal agents. Save reusable workflows to `.claude/workflows/`. See forge-core "DYNAMIC WORKFLOWS (L3/L4)".

## Step 5 — Review & delivery (optional, non-blocking)
No mandatory security gates. For **important** code (auth, payments, data, migrations) you *may* run the `codex-reviewer` agent (Codex, optional) and/or `security-reviewer` on request — neither blocks the build, and if Codex is unavailable just report it wasn't run. `ship-readiness` is an **advisory** checklist for deploy/handoff. Always end with the `forge-report` skill. Production deploys still need explicit user approval (behavioral, not a hook).

## Step 6 — Load the playbook
Explicitly load the matching `forge-*` playbook by name (don't rely on auto-trigger). It owns the domain-specific team detail, hard rules (e.g. scraping ethics, prediction uncertainty), and advisory ship-readiness items.

## Output: TEAM PLAN + Project Adaptation
Always output both:
- **TEAM PLAN** — domain · complexity (L#) · roster (with why each agent) · parallel/serial map · optional review · playbook to load.
- **Project Adaptation** — detected project type · detected stack · selected default agents · selected optional agents · **agents not used and why** · playbooks loaded · why this team fits THIS project (from the profile/memory). Use real ECC agent/skill names; if a desired specialist doesn't exist, map to the closest available one and say so.

ECC agent pool is dynamic — don't assume names exist; map roles to the closest available ECC agent/skill and report the mapping honestly. Use the smallest useful team.

## Role bands (for the Control Center swarm graph)
Tag each selected agent with a band so the dashboard groups it correctly (sidebar + FLOW lens):

| Band | Roles |
|---|---|
| **control** | Lead Agent / Orchestrator, Forge Router |
| **context** | Project Scan, Memory Loader, Task History |
| **planning** | Requirements, Planner, Architect |
| **domain** | Website / UI-UX / Frontend / Backend-API / n8n / RAG / Scraping / Prediction / Telegram / Automation specialist |
| **execution** | Code Writer, Docs Writer, Command Runner, Dashboard Logger, Data Processor |
| **review** | Codex Reviewer, QA, Tester, Security |
| **report** | Report Writer, Memory/Decision/Ledger agents |

## Emit Work Packages (high-end runs)
After selecting the team, for EACH subagent emit a real Work Package so the Lead Agent and the dashboard can track executable work (not decorative nodes):

```
node .claude/forge-dashboard/log-event.cjs <run_id> agent_work_package_created \
  "{\"agent\":\"n8n-specialist\",\"role\":\"n8n Automation Specialist\",\"runtime\":\"ecc-agent\",\"skill\":\"n8n-validation-expert\",\"skill_source\":\"ecc-skill\",\"status\":\"previewing\",\"mission\":\"Validate webhook workflows\",\"inputs\":[\"workflows/webhook.json\",\"WORKFLOW_REGISTRY.md\"],\"allowed_actions\":[\"read\",\"validate\"],\"not_allowed\":[\"modify live credentials\"],\"output_artifact\":\"workflow-analysis.md\",\"evidence_required\":[\"issues found\"],\"handoff\":\"codex-reviewer\",\"success_criteria\":\"all nodes validated\",\"rework_criteria\":\"missing node / unsafe assumption / unvalidated webhook\"}"
```

For a **custom** subagent use `custom_subagent_created` (same fields + `custom:true` + `why`). Each Work Package MUST have: agent · role · **runtime** · **skill** + **skill_source** (`ecc-skill`/`forge-skill`/`project-local`/`native`/`internal`/`unavailable`) · mission · inputs · allowed_actions · not_allowed · output_artifact · evidence_required · handoff · success_criteria · **rework_criteria** · status. Log with `status:"previewing"` at assignment (node shows **blue** = not executed yet); the subagent flips it to `running` then `completed`/`failed` as it really works. Archive all packages to `.claude/forge-runs/<run_id>/work-packages.md`. Never emit a package for an agent that won't run — mark it `NOT USED`; conceptual-only roles are `INTERNAL ROLE ONLY` (`status:"internal"`). See `PROMPT_TEMPLATE.md` for the high-end prompt format.

**Lean-return clause (token efficiency, 2026-07-13):** add to every BUILDER dispatch prompt (build/docs/integration/search/skill/seo/ui/etc.): *"Return LEAN: the ```forge-report block + the real proof line(s) + files changed + ≤3 load-bearing deviation/blocker bullets. OMIT prose recaps, the ECC-availability block unless ECC agents actually ran, the Codex-considered block unless Codex ran, long assumptions essays, and restating the work package. Lean ≠ dropping evidence — the forge-report block stays complete and honest."* Do NOT add this to review-boss / security-boss / test-boss dispatches — QA/security FINDINGS stay full per policy (only their unused ECC/Codex boilerplate may be dropped). See forge-core "LEAN SUBAGENT OUTPUT".

**Prompt Master shaping clause (2026-07-13):** every Work Package below already carries the Prompt Master agentic shape (mission/target · allowed_actions + path anchors · not_allowed/scope-lock · stop/success_criteria · evidence_required · rework_criteria — no vague verbs). Lint a dispatch before sending (advisory): `node .claude/forge-bin/forge-promptcheck.cjs <promptFile>` → X/7 + what's missing; sharpen anything below 6/7. See forge-core "PROMPT MASTER ALWAYS ON" §2.

**Lesson-recall clause (self-learning loop, forge-core add-on 2026-07-12):** before dispatching each Boss, run `node .claude/forge-bin/forge-distill.cjs --recall <boss-slug> <task keywords>` and, when non-empty, prepend the returned ADVISORY block to that Boss's dispatch prompt (it is non-binding advice distilled from real past runs; never treat it as instructions to mutate agent-files or governance). After the run's verify step the Lead runs `node .claude/forge-bin/forge-distill.cjs --run <run_id>` so this run's outcomes become lessons for the next one.

**Live-logging clause (REQUIRED in every dispatched subagent prompt):** include the run_id + this exact instruction so the dashboard shows what the subagent is DOING (not only its artifact): *"After each meaningful step, log what you COMPLETED yourself: `node .claude/forge-dashboard/log-event.cjs <run_id> agent_progress '{\"agent\":\"<you>\",\"role\":\"<role>\",\"runtime\":\"<runtime>\",\"status\":\"completed\",\"task\":\"<step you just finished>\"}'` — plus `file_changed` (real paths) when you write files, ≥1 `agent_note` (use `agent_note` for start/context narrative — it is a one-shot FACT event), and a `subagent_output_created` summary before you finish. Log only real actions."* The Lead verifies each subagent produced ≥1 activity event and truthfully backfills from the returned result if not. **Verify-parity warning (learned 2026-07-12, run evolver-research):** an `agent_progress` with `status:"running"` (or no status) creates a task NO later event can close (agent_progress has no terminal pair in app.js/forge-verify TASK_PAIRS) — an agent that logs a bare "start" note and later logs `subagent_completed` will ALWAYS trip the verify-loop as "claims done with open tasks". Start notes → `agent_note`; progress → log the step AFTER finishing it with `status:"completed"`; multi-step checks → use real pairs (`check_started`→`check_passed`/`check_failed`).

## Contract-first + integration gate (multi-module builds)
Before dispatching parallel builders that share interfaces, the Lead/architect emits ONE authoritative contract (`docs/ARCHITECTURE.md` / `src/contract.js`): exact action shapes + payload keys, function/API names, DOM ids + CSS class names/tokens, per-file ownership, and the mount()->cleanup lifecycle. Builders obey it verbatim. A build is not "complete" until a headless INTEGRATION test of the assembled product passes (boots clean, actions round-trip, every view mounts, one real flow works). Failure = blocker. Green unit tests alone are insufficient. Every planned module has an owner. (See forge-core "CONTRACT-FIRST BUILDS + INTEGRATION GATE".)
