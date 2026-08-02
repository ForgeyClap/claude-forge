---
description: Forge (global, lightweight) — run a task with Forge behavior (dynamic ECC agent team, project isolation, optional Codex review, honest report). If this project has a local Forge V2 install, the project-local /forge takes over with full playbooks.
argument-hint: [task · e.g. "build a landing page" | START NEW/CONTINUE]
---

# /forge (global)

Run Forge for: **$ARGUMENTS**. Load the **`forge-core`** skill for behavior + rules. Forge is **ECC-based** and runs as a **Lead-Agent studio**: run in **ECC Normal Mode (default ON)** — prefer real ECC agents/skills over native/internal roles, and report honestly what ECC did.

- **Lead-Agent studio:** plan before executing — Mission Blueprint + **Skill Discovery** → dynamic role-based subagents (ECC-first; **create custom roles/skills** for gaps — the role/skill examples are guidance, not limits) → outputs → Lead Review → bounded rework/fix loop → merge → optional Codex → quality gate → report.
- **Session Mode:** `/forge` / `gebruik Forge` / `use Forge` / `start Forge` enters project-local **Forge Session Mode** so follow-ups auto-use Forge (no need to repeat the trigger); `stop Forge` / `pause Forge` pauses it. No extra permission granted.
- **ECC-first:** read memory/profile → use the ECC inventory if available → select relevant ECC agents/skills → **really try to invoke them** → make work packages → log ECC + native activity honestly. Use a native role only as a labeled fallback when ECC is unavailable/blocked/failed/too-small — never present native as ECC.
- **Project isolation:** work only in the current project folder; if ambiguous, ask which exact folder first, then stop. No edits outside it; no global Claude/ECC config changes; no credential/live-workflow/production/external writes without explicit approval.
- **Team:** classify the task + complexity (L1–L4) and pick the *smallest relevant* set of ECC agents/skills. Small task = small team; big task = larger swarm.
- **Execute** small, inspected changes within this folder. Parallel work → separate worktrees; you integrate.
- **Review (optional):** for important code, optionally run the `codex-reviewer` agent (`/codex:review`). Never blocks; if Codex is unavailable, report it wasn't run.
- **ECC Full Test Mode** (broad inventory / unblock-diagnose / permission test) is **opt-in only** — `enable ECC test mode for this project`. Default OFF.
- **Deliver** an honest report (what changed · ECC attempted/used vs native fallback + reason · checks actually run · not run · next step).

**v8 default behavior (every project with the local install — see the `forge-core` "v8" section):**
- **Owner memory first:** read the owner profile + standing rules and echo which were auto-applied (`forge-prefs`/`forge-standing`/`forge-echo`) — never-auto-push, language, real-file-testing, UI-quality, draft-only outreach, etc. `/forge remember <text>` makes a rule stick.
- **Autonomy `continue-within-mission`** by default (no phase re-asking); hard-gates (deploy/push/spend/DNS/prod/credentials/outbound/outside-root) + usage-limit ALWAYS interrupt (`forge-actiongate`).
- **Evidence gates:** web ⇒ real responsive screenshots + the auto web-quality contract, correctness-critical ⇒ real fixtures — or the run is not "done".
- **Learns across projects:** recalls the global lesson namespace before dispatch; `/forge learn` harvests your other projects' Forge memory (read-only, secrets-excluded, evidenced-only).
- **`/forge resume <run_id>`** re-dispatches only the unfinished work packages after a session/usage-limit interruption.
- **Stay current:** on `/forge`, if this project's Forge is behind the canonical template it is brought current via the safe `forge-sync install` (backup + doctor-validate + rollback; only ever touches `.claude/`, never your app code).

**v8.1 (all opt-in / owner-gated — see forge-core "v8.1"):** external **MCP tools** via `forge-mcp-clients` are dormant + least-privilege (4 tiers; every write-tool is hard-gated); **moonshots** — `forge-genesis` (self-proposed skills, staged + `/forge approve-skill` token-gated), `forge-tournament` (best-of-N), `forge-secondbrain` (read-only portfolio strategist), `forge-codemodel` (living repo index), `forge-nightshift` (opt-in overnight builder + morning briefing), `forge-guardian` (owner-gated prod self-heal scaffold). None run or self-act without your explicit opt-in.

If you want the **full** Forge V2 installed into this project, say: **`install Forge V2 into this project`** — the `forge-core` skill scans the project, writes project memory (`FORGE_PROJECT_PROFILE.md` + `FORGE_MEMORY.md` + role map), installs the router + domain playbooks (website, full-stack, n8n, scraping, RAG, prediction, integration), and the per-project run-event writer (`.claude/forge-dashboard/log-event.cjs`) that the Command Center reads. Project-local only, no security hooks.

After install, project-local sub-commands work: `/forge dashboard` / `/forge start` (start THIS project's dashboard + health-check + report the real URL), `/forge use`, `/forge status`, `/forge runs`, `/forge open-report`. Natural language also triggers Forge: **"use Forge system"**, **"gebruik Forge systeem"**, **"start Forge dashboard"**.

**The dashboard is the Forge Command Center** — one local app on `http://127.0.0.1:4100` that auto-discovers your projects and shows strictly per-project data. `/forge dashboard` starts it when this project hosts it (`node command-center/gateway/supervisor.mjs`), or simply health-checks the running instance, which already covers this project. The per-project **Control Center** (ports 3737–3999, `.claude/forge-dashboard/server.cjs`) is **retired**: it never starts automatically and only runs on an explicit `legacy dashboard` request — but its `log-event.cjs` stays in service as the per-project run-event writer. Never read another project's `.claude/`. **Never claim the dashboard is running unless a `GET /api/health` check actually passed** — otherwise print the exact command + URL.
