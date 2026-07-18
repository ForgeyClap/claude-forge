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

If you want the **full** Forge V2 installed into this project, say: **`install Forge V2 into this project`** — the `forge-core` skill scans the project, writes project memory (`FORGE_PROJECT_PROFILE.md` + `FORGE_MEMORY.md` + role map), installs the router + domain playbooks (website, full-stack, n8n, scraping, RAG, prediction, integration), and the local **Forge Control Center** dashboard (`.claude/forge-dashboard/`). Project-local only, no security hooks.

After install, project-local sub-commands work: `/forge dashboard` / `/forge start` (start THIS project's dashboard + health-check + report the real URL), `/forge use`, `/forge status`, `/forge runs`, `/forge open-report`. Natural language also triggers Forge: **"use Forge system"**, **"gebruik Forge systeem"**, **"start Forge dashboard"**.

Each project gets its **own** dashboard on its **own** stable port (3737–3999, from the project path; stored in `.claude/forge-dashboard/PORT`). Never a shared/global dashboard; never read another project's `.claude/`. Never claim the dashboard is running unless a `/api/health` check passed — otherwise print the exact command + URL.

<!-- forge-onboarding-i18n-v1 -->
## First run — onboarding gate (optional, never a hard block)
Before executing a Forge task, check whether this project is onboarded:
`node .claude/forge-bin/forge-setup.cjs status --json` (or the presence of `.claude/.forge-setup.json`).
If it is NOT onboarded, briefly offer to run **/setup-forge** first — it captures the user's name, goal,
project type, **language**, and does beginner-safe API-key setup. If the user declines or it's a quick task,
proceed anyway: onboarding is optional and must never block work.

## Language — internationalization (required)
Forge is international. Determine the user's language with `node .claude/forge-bin/forge-setup.cjs lang`
(falls back to `en`). **Respond to the user, write the final forge-report, and run any wizard IN THAT
LANGUAGE.** Default to English when unset. The dashboard has its own language toggle. Never fabricate a
translation of a proper noun/command; keep commands/paths verbatim.
