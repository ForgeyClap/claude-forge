# Forge Permanent Agents & Global Skills (2026-07-05)

## The 12 permanent Bosses (names are FIXED across every project)
| Agent | Role | Runtime (Claude) | NVIDIA tool-model | Core skills |
|---|---|---|---|---|
| **Boss** | Lead/orchestrator, owns quality + fix strategy | opus | reasoning | forge-router, make-plan, brainstorming, forge-report, forge-prompt-coach, grill-me, grilling |
| **Head Chef** | Exact work packages, completion control | sonnet (↑opus on complex) | reasoning | make-plan, writing-plans, dispatching-parallel-agents |
| **Review Boss** | Final QA vs the user goal | opus | review (2nd opinion only) | code-review-excellence, verification-before-completion |
| **Test Boss** | Automated tests (Playwright for web; fitting strategy otherwise) | sonnet | coding | TDD, e2e-runner, systematic-debugging |
| **UI Boss** | Premium UI/UX, screenshot loops | sonnet | vision | frontend-design, design-is, browser |
| **SEO Boss** | SEO/perf/site quality (non-web: perf+docs) | sonnet | default | seo-specialist, performance-optimizer |
| **Security Boss** | Secrets/auth/validation/production safety | opus (always) | reasoning (extra lens) | security-reviewer, security-review |
| **Skill Boss** | Global skill registry + auto-attach validation | haiku | fast | skill-builder, global-skills registry |
| **Search Boss** | Source-grounded research | sonnet | default | deep-research, WebSearch/WebFetch |
| **Build Boss** | Implementation | sonnet (↑opus hard) | coding | TDD, systematic-debugging, git worktrees, resolving-merge-conflicts, setup-pre-commit (alleen op verzoek van de owner) |
| **Integration Boss** | APIs/n8n/webhooks/NVIDIA | sonnet (↑opus auth/data) | default | forge-integration, n8n-mcp-tools-expert, nvidia-provider |
| **Docs Boss** | Docs + handoff | haiku (↑sonnet complex) | fast | forge-report, writing-plans, teach, wait-what, claude-md-improver |

*De Core-skills kolom is een verkorte greep — de **source of truth** is `config/agents/agent-skill-map.json` (volledige lijsten) + `config/agents/agent-model-map.json` (volledige model-mappings incl. escalaties).*

*v2.7.0 (2026-09-24): de meegeleverde (gevendorde) skills zijn aan drie Bosses gekoppeld — Boss: `forge-prompt-coach` (bij elk ruw verzoek tijdens de intake), `grill-me`/`grilling` (alleen bij intake `interview` of op verzoek); Build Boss: `resolving-merge-conflicts` (bij een merge-conflict), `setup-pre-commit` (alleen als de owner er expliciet om vraagt — draait npm/npx); Docs Boss: `teach`/`wait-what` (uitleg-modus), `claude-md-improver` (`/revise-claude-md`). Wanneer welke skill vuurt staat in `agent-skill-map.json` → `invocationNotes`. Let op: enkele namen in deze kolom (make-plan, e2e-runner, design-is, seo-specialist, security-reviewer, …) staan niet (meer) in de core-map; voor de meeste staat de reden daar in `_unshipped_removed_2026_09_23`. Herkomst en licenties: `.claude/skills/VENDORED-SKILLS.md`.*

Extra agents: alleen met permanente naam + rol + skill-bundle + model-mapping + self-review + loop-positie → toevoegen in `config/agents/agent-registry.json` (template-first, dan syncen). Nooit ad-hoc namen voor werk dat een Boss al dekt.

## The QA fix-loop (enforced flow)
User → **Boss** (mission) → **Head Chef** (work packages) → **Skill Boss** (skills attached) + model-route check → subagents (each **self-reviews** before done) → **Test Boss** → **UI Boss**/**SEO Boss** (when relevant) → **Security Boss** → **Review Boss** (final) → fail? structured failure report → Boss → Head Chef assigns fixes → re-test → Review Boss again → repeat until genuine pass **or a truthful blocker** (max loops per forge.md; never fake a pass).

## Global skills (auto-attach, no manual reconnection)
- Per-agent CORE skills: `config/agents/agent-skill-map.json` (always attached).
- Project-type bundles ON TOP: `config/skills/global-skills.json` — website / n8n / app-backend / research-planning / automation-integration. Boss detects the type in the Mission Blueprint; custom types get the closest bundle + reported gaps.
- Missing skill? Skill Boss reports it + assigns a labeled safe fallback — never silently skip, never claim a skill loaded that didn't.

## Where things live
Template (canonical): `~/.claude/forge/template/.claude/config/**` + `forge-bin/nvidia-provider.cjs` — synced to every project's `.claude/`. Fixes are ALWAYS template-first.

## v10 — WP-dispatch · verify-binding · usage-pressure routing (owner directive 2026-07-25)
Every large mission is now auto-split into `wp0..wpN` work packages by the Lead (no owner ask needed);
every WP gets a bound verify pass (a registered Boss, role `<wp>-verify`, or `forge-verify.cjs --enforce`)
before DONE; and near ~80% weekly usage the Lead reads `~/.claude/FORGE_USAGE_PRESSURE.json` (account-wide) and prefers the
6 `nvidiaForBulkOnly` Bosses for bulk work while the 6 `claudeWinsSkipNvidia` Bosses above never downgrade.
Full standard: forge-core "v10" add-on; routing pointer: `forge-router` Step 4d.

## Per-Boss memory ceiling (WP-GH-WIRE, 2026-07-26)
Every `.claude/agent-memory/<boss>/MEMORY.md` stays **≤200 lines** — the platform only injects the first 200
lines of a subagent's memory index into context, so anything past that ceiling is silently invisible to the
Boss that reads it. When a MEMORY.md nears the ceiling, rotate the oldest/least-valuable lessons out to a
topic file in the same `agent-memory/<boss>/` directory (the index keeps a pointer, not the full lesson).

## Project CLAUDE.md generation (V9-INTEGRATE, 2026-07-22)
Install/onboarding-time (and `forge-deeplearn` deep-learn-pass) `CLAUDE.md` generation for a new or thin
project brain now uses `forge-bin/forge-projectbrain.cjs` (+ the `forge-projectbrain` skill) instead of a bare
bullet-list template merge — real-stack detection, adapted environment rules, verbatim anti-generic
guardrails/honesty core, and a real `## Hard Rules` section wired to that project's `FORGE_HARD_RULES.json`,
written via a safe-merge that never clobbers an unmarked owner-authored file. This note is a **source-project
copy only** — it documents the method for this project's own template; propagating it into `~/.claude`'s
global installer is a separate, explicitly owner-reviewed sync, not performed automatically here.
