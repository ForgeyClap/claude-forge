# Agents

Forge ships **19 built-in agents** — **12 permanent Bosses** plus **7 on-demand specialists** — and turns Claude Code into a coordinated team that builds, tests, reviews and ships. Every one is a **real Claude Code Agent-tool subagent** defined in [`.claude/agents/*.md`](.claude/agents/), not a simulated persona or a fabricated name on a dashboard.

> [!NOTE]
> **Honest count.** The full install ships **19 agents** (12 permanent Bosses + 7 specialists) and **50 skills**; the LITE plugin carries **18 agents** and **31 skills**. Counts are taken from the directories, not typed by hand. Forge can also *route* to your wider agent ecosystem (ECC / Claude-Code agent types) when a task calls for something outside the built-ins — but those are not part of this repo. When you see large numbers elsewhere, that is the routable ecosystem, not what claude-forge ships. See [Routing to your wider ecosystem](#routing-to-your-wider-ecosystem).

---

## How Forge uses agents

Forge is a hierarchy, not a free-for-all. Work flows top-down and quality flows bottom-up:

```
You (orchestrator) ── /forge <task>
        │
        ▼
   Boss (Lead)  ──►  Head Chef  ──►  domain Bosses + specialists
   owns mission     splits into        do the actual work
                    work packages
        ▲                                     │
        └──────── QA fix-loop ◄───── Test Boss / Review Boss
```

- **Lead → Bosses → specialists.** The **Boss** owns the mission; **Head Chef** breaks it into exact work packages; the right **domain Bosses** and **specialists** execute; **Test Boss** and **Review Boss** gate the result.
- **Real subagents.** Each agent is dispatched via the Claude Code Agent tool with its own model, tools and effort budget (from its frontmatter). Nothing is theatre.
- **Dynamic, right-sized teams.** Forge picks the **smallest relevant** team per task (see the fan-out levels in `CLAUDE.md`): a one-line fix gets one or two agents; a full-stack build gets a phased swarm. Forge does not over-spawn to look impressive, and does not lock to a fixed count.
- **Honest ledger.** Every run records which agents *actually* worked in `FORGE_AGENT_LEDGER.md`, with evidence and one of the fixed statuses — `REAL INVOKED` · `REAL TOOL/SKILL USED` · `INTERNAL ROLE ONLY` · `NOT USED` · `FAILED`. No fake "done", no invented tests, no imaginary agents.

---

## The 12 permanent Bosses

The Bosses are always available. They form the standing org chart Forge draws from for every task.

| Boss | Role | When it's used | Model / effort | Tools |
|---|---|---|---|---|
| **boss** | **Lead Agent** — owns the mission, splits it into work packages for Head Chef, tracks progress, receives QA-failure reports, decides the fix strategy, and reassigns until the loop genuinely passes. | Every Forge task (proactively). | `opus` · high | Read, Write, Edit, Grep, Glob |
| **head-chef** | Converts the Boss's mission into exact, step-by-step work packages for subagents; verifies each subagent actually met its goal and prevents random or duplicate work before it reaches QA. | Every task, right after the Boss frames the mission. | `sonnet` · high | Read, Write, Edit, Grep, Glob |
| **build-boss** | Implementation and coding Boss — writes/modifies the actual code assigned by Head Chef, follows the existing architecture, keeps it clean, maintainable and tested, never bypasses QA. | Any work package that writes or changes code (features, bug fixes, refactors, scaffolding, glue). | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |
| **test-boss** | Runs **real** automated testing (Playwright e2e for web/apps; the correct strategy for other project types) and reports real pass/fail proof, never a fabricated pass. | After Build Boss finishes a work package, before UI/SEO/Security/Review Boss. | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |
| **ui-boss** | UI/UX and frontend quality — builds premium, responsive, modern interfaces with purposeful motion, verifies mobile/tablet/desktop with real screenshot loops, fixes weak layout, spacing, contrast and oversized text. | Any work touching the visible interface, before Review Boss sees it. | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |
| **seo-boss** | Website SEO, performance and site-quality review — metadata, structure, headings, Core Web Vitals-style performance, accessibility, image optimization, schema and indexability, with real findings and sources. | Website / landing-page work needing SEO and site-quality review. | `sonnet` | Read, Grep, Glob, WebSearch, WebFetch |
| **search-boss** | Research and current-information Boss — finds facts with sources and references (never hallucinating); covers competitor, design, SEO and market research on request. | When a task needs current information, external facts, or source-grounded research rather than model memory. | `sonnet` | Read, Grep, Glob, WebSearch, WebFetch |
| **security-boss** | Security and secrets Boss — **read-only** audit of keys, env vars, auth, webhooks, input validation, injection surfaces, unsafe logging and exposed secrets. | Before Review Boss signs off, and any time a work package touches auth, payments, webhooks or credentials. | `opus` · xhigh | Read, Grep, Glob |
| **skill-boss** | Global skills manager — maintains the skill registry, attaches default and project-type skill bundles to agents, and reports missing skills with a safe fallback instead of silently skipping them. | At team-build time before subagents are dispatched, and whenever a new agent or skill is added. | `haiku` | Read, Write, Edit, Grep, Glob |
| **docs-boss** | Documentation and handoff Boss — writes docs, setup instructions, architecture notes, env-var guides and final reports in simple language with exact commands. | At the end of a task, or whenever setup, config or API surface changes need documenting. | `haiku` | Read, Write, Edit, Grep, Glob |
| **integration-boss** | APIs, automation and external-systems Boss — n8n, webhooks, Gmail, calendars, databases, payments and NVIDIA-as-tool wiring with retries, timeouts, clear errors and fallbacks. | Any work package connecting to an external service, third-party API or automation platform. | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |
| **review-boss** | Final **QA gate** — reviews finished work against the user's actual goal (design, code quality, logic, security, tests, UX, edge cases, missing features) and files a structured failure report on any real gap. | Before any task is reported done. | `opus` · xhigh | Read, Grep, Glob |

> [!TIP]
> **Read-only Bosses gate; they don't build.** `security-boss`, `review-boss`, `search-boss` and `seo-boss` deliberately have **no write tools** — they audit, research and report so their verdicts stay independent of the code they judge.

---

## The 7 specialists

Specialists are dispatched **on demand** when a work package needs deep domain expertise the Bosses don't cover. They are pulled into the team by Head Chef only when the task type calls for them.

| Specialist | Role | When it's used | Model | Tools |
|---|---|---|---|---|
| **codex-reviewer** | **Optional** independent code-quality reviewer. Primary path is the official Codex plugin (`/codex:review`, `/codex:adversarial-review`); fallback is the ECC code-reviewer (clearly labeled non-independent). Returns one verdict line. | On request for important/sensitive code (auth, payments, data, migrations, automation). **Not a mandatory gate — never blocks a build.** | `claude-opus-4-8` | Bash, Read, Grep, Glob |
| **data-scientist** | Exploratory data analysis, statistical modeling and prediction — EDA to model with rigorous validation and honest uncertainty/confidence labels. Never fabricates metrics or claims certainty. | Data analysis, statistics and prediction work. | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |
| **electron-pro** | Electron desktop apps — safe IPC, context isolation, no `nodeIntegration` in the renderer, and a real signed installer. | Building or hardening an Electron desktop app. | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |
| **mcp-developer** | Model Context Protocol servers/clients and tool integrations — JSON-RPC 2.0 compliance, schema-validated inputs, minimal scopes, secure config. | Building or debugging MCP servers/clients, or authoring skills/integrations. | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |
| **ml-engineer** | Production ML engineering — training-to-serving pipelines, reproducibility, model versioning, drift monitoring and safe rollout. Never triggers real-money or irreversible actions automatically. | Production machine-learning engineering work. | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |
| **payment-integration** | Payments and financial transactions — Stripe/gateway integration, PCI-safe tokenization, verified webhooks and idempotent charge/refund flows. **Never hardcodes keys.** | Integrating payments or handling financial transactions. | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |
| **verify-boss** | Comprehensive verification and graded proof — runs the doctor self-test suite (110+ suites, 6000+ assertions per installation), gates behind a contract-check before "done", and grades the actual result of every claim. | On completion of any major build, before reporting done; also spot-checks during a long session to catch drift early. | `sonnet` | Read, Write, Edit, Bash, Grep, Glob |

---

## The QA fix-loop

Forge does not report a task done until quality is genuinely verified. Work climbs a ladder of increasingly independent checks, and any real failure sends it back down to be fixed — then re-tested from the top.

```
subagent self-review
        │  (each agent checks its own output first)
        ▼
   Test Boss  ──────►  real automated tests, real pass/fail proof
        │
        ▼
 domain Bosses  ─────►  UI / SEO / Security review as relevant
        │
        ▼
  Review Boss  ──────►  final QA gate vs the user's actual goal
        │
   ┌────┴─────────────────────────────┐
   │ PASS                     FAIL     │
   ▼                                   ▼
 report done                structured failure report
                                       │
                                       ▼
                                    Boss  ──► decides fix strategy
                                       │
                                       ▼
                                  Head Chef  ──► reassigns the fix
                                       │
                                       ▼
                                   fix ──► re-test (back to the top)
```

1. **Subagent self-review.** Every agent checks its own output before handing off — no throwing half-work over the wall.
2. **Test Boss.** Runs the real test strategy for the project type and reports **real** pass/fail proof — never a fabricated pass.
3. **Domain Bosses.** UI Boss, SEO Boss and Security Boss review their slices as relevant (screenshot loops, site quality, secret/injection audit).
4. **Review Boss.** The final gate compares the finished work against the user's *actual* goal — design, logic, security, tests, UX, edge cases, missing features.
5. **Fail → report → Boss → Head Chef → fix → re-test.** A real gap becomes a structured failure report. The Boss decides the fix strategy, Head Chef reassigns the work package, the fix is made, and it re-enters the loop. The task is only reported done when the loop **genuinely** passes — and the `FORGE_AGENT_LEDGER.md` records who actually ran, with evidence.

---

## Routing to your wider ecosystem

The 19 built-ins cover the common Forge domains, but they are not a ceiling. When a task needs a capability outside them, Forge can **route** to your wider agent ecosystem — additional **ECC / Claude-Code agent types** available in your environment — instead of forcing a poor fit onto a Boss.

> [!NOTE]
> Those routable agents are part of your broader Claude Code / ECC setup, **not** shipped by claude-forge. This repo ships **19 built-in agents** (12 Bosses + 7 specialists), **extensible to your wider agent ecosystem.** Whatever runs, the honest ledger still records exactly which agents actually worked.

---

<sub>Every agent above is defined in <a href="./.claude/agents/">.claude/agents/</a>. Counts are honest: 19 agents, 50 skills (full install); 18 agents, 31 skills (LITE plugin). MIT © ForgeyClap.</sub>
