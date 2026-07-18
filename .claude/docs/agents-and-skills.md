# Forge Permanent Agents & Global Skills (2026-07-05)

## The 12 permanent Bosses (names are FIXED across every project)
| Agent | Role | Runtime (Claude) | NVIDIA tool-model | Core skills |
|---|---|---|---|---|
| **Boss** | Lead/orchestrator, owns quality + fix strategy | opus | reasoning | forge-router, make-plan, brainstorming, forge-report |
| **Head Chef** | Exact work packages, completion control | sonnet (↑opus on complex) | reasoning | make-plan, writing-plans, dispatching-parallel-agents |
| **Review Boss** | Final QA vs the user goal | opus | review (2nd opinion only) | code-review-excellence, verification-before-completion |
| **Test Boss** | Automated tests (Playwright for web; fitting strategy otherwise) | sonnet | coding | TDD, e2e-runner, systematic-debugging |
| **UI Boss** | Premium UI/UX, screenshot loops | sonnet | vision | frontend-design, design-is, browser |
| **SEO Boss** | SEO/perf/site quality (non-web: perf+docs) | sonnet | default | seo-specialist, performance-optimizer |
| **Security Boss** | Secrets/auth/validation/production safety | opus (always) | reasoning (extra lens) | security-reviewer, security-review |
| **Skill Boss** | Global skill registry + auto-attach validation | haiku | fast | skill-builder, global-skills registry |
| **Search Boss** | Source-grounded research | sonnet | default | deep-research, WebSearch/WebFetch |
| **Build Boss** | Implementation | sonnet (↑opus hard) | coding | TDD, systematic-debugging, git worktrees |
| **Integration Boss** | APIs/n8n/webhooks/NVIDIA | sonnet (↑opus auth/data) | default | forge-integration, n8n-mcp-tools-expert, nvidia-provider |
| **Docs Boss** | Docs + handoff | haiku (↑sonnet complex) | fast | forge-report, writing-plans |

*De Core-skills kolom is een verkorte greep — de **source of truth** is `config/agents/agent-skill-map.json` (volledige lijsten) + `config/agents/agent-model-map.json` (volledige model-mappings incl. escalaties).*

Extra agents: alleen met permanente naam + rol + skill-bundle + model-mapping + self-review + loop-positie → toevoegen in `config/agents/agent-registry.json` (template-first, dan syncen). Nooit ad-hoc namen voor werk dat een Boss al dekt.

## The QA fix-loop (enforced flow)
User → **Boss** (mission) → **Head Chef** (work packages) → **Skill Boss** (skills attached) + model-route check → subagents (each **self-reviews** before done) → **Test Boss** → **UI Boss**/**SEO Boss** (when relevant) → **Security Boss** → **Review Boss** (final) → fail? structured failure report → Boss → Head Chef assigns fixes → re-test → Review Boss again → repeat until genuine pass **or a truthful blocker** (max loops per forge.md; never fake a pass).

## Global skills (auto-attach, no manual reconnection)
- Per-agent CORE skills: `config/agents/agent-skill-map.json` (always attached).
- Project-type bundles ON TOP: `config/skills/global-skills.json` — website / n8n / app-backend / research-planning / automation-integration. Boss detects the type in the Mission Blueprint; custom types get the closest bundle + reported gaps.
- Missing skill? Skill Boss reports it + assigns a labeled safe fallback — never silently skip, never claim a skill loaded that didn't.

## Where things live
Template (canonical): `~/.claude/forge/template/.claude/config/**` + `forge-bin/nvidia-provider.cjs` — synced to every project's `.claude/`. Fixes are ALWAYS template-first.
