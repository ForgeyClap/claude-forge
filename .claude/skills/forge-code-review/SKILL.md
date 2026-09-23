---
name: forge-code-review
description: Forge code-review method — order, severity levels, Codex handoff. Use before any commit or when asked to review code — code review, check my code, PR review, before I commit.
---

# Forge playbook — Code review method

**Self-improvement substrate (wp-skill-evals, 2026-07-31):** before applying this skill, read
`learnings.md` in this skill's own folder and honor its corrections. After a run that produced a
genuine correction (an owner fix, a false assumption caught, a preference stated), append it to
`learnings.md` with a date and real evidence — never invent a lesson that didn't happen.

**Do not duplicate ECC skills — defer to:** `code-review-excellence` (the deep per-language review
reference: React/Vue/Angular/Svelte/Rust/TypeScript/Java/PHP/Python/Django/Go/C#/Kotlin/NestJS/C/C++).
This file is the Forge-specific orchestration wrapper: the fixed review order, the severity scale, and
how a finding becomes a rework item in the Forge pipeline.

## Hard rules
- Review the real diff/files directly — never review a self-report of the diff, and never approve on the
  strength of "tests pass" alone without reading the actual change.
- Every finding is specific and actionable (file + line/symbol + what's wrong + the fix), never a vague
  "looks off."
- CRITICAL/HIGH findings block completion; they are not "nice to have later."
- Feedback targets the code, not the person; explain the reasoning, don't just assert a preference.
- A review is not a rewrite-to-taste pass — flag genuine correctness/security/maintainability issues, not
  personal style preferences that don't match a real project convention.

## Review order (fixed sequence — don't skip ahead to style)
1. **Correctness** — does the logic actually do what it claims; are edge cases the happy path hides
   named, not assumed away.
2. **Security** — secrets, injected input, auth/authz boundaries, unsafe deserialization, path traversal,
   anything on the mandatory security checklist (`~/.claude/rules/ecc/common/security.md`) for
   security-sensitive changes.
3. **Tests** — does new behavior have a real test; do existing tests still pass; is coverage of the
   changed logic genuine (not just line-count coverage).
4. **Simplicity** — is this the simplest correct solution, or is there unnecessary abstraction/complexity
   for what the task needed (YAGNI).
5. **Performance** — any obvious N+1 queries, unbounded loops/queries, or missing pagination/caching on a
   hot path.
6. **Style** — naming, formatting, project convention consistency — reviewed last, and never blocking on
   its own unless it actively harms readability.

## Severity levels
| Level | Meaning | Action |
|-------|---------|--------|
| CRITICAL | Security vulnerability, data loss, or broken correctness in a real path | **BLOCK** — must fix before done |
| HIGH | Real bug or significant quality/maintainability issue | **BLOCK or WARN** — fix before done unless owner explicitly accepts the risk |
| MEDIUM | Maintainability concern, not currently harmful | **INFO** — should fix, doesn't have to block |
| LOW | Style or minor suggestion | **NOTE** — optional |

## Codex handoff (optional, never a blocker)
For security-sensitive, auth, payments, database-migration, or other high-risk changes, this review MAY
be followed by an independent `codex-reviewer` pass (`/codex:review` read-only, or
`/codex:adversarial-review` for the required-review areas in `CODEX_GLOBAL_POLICY.md`). If Codex is
unavailable, report that honestly — the review above still stands on its own.

**The model is pinned, and it is NOT a detail you restate from memory.** Read
`.claude/config/orchestration/codex-review.json` — it holds the engine, model, reasoning effort,
sandbox and the exact command, and it is the ONLY place any of those are defined. Owner directive
2026-08-04: the independent review runs on **`gpt-5.6-sol` at `model_reasoning_effort=xhigh`**. Before
that file existed the model was pinned nowhere, so `/codex:review` silently used whatever default the
plugin happened to carry — and reaching gpt-5.6-sol at all needed a Codex CLI ≥ 0.146.0 (0.142.3 got
an HTTP 400 telling it to upgrade, measured 2026-08-03).

**Name the step for what it is.** The planned work package is the **Codex code-review**, not an "ECC
code-review". ECC `code-reviewer`/`security-reviewer` is the *fallback* you use when Codex genuinely
could not run, and it is always labelled
`FALLBACK (non-independent) review — Codex did not run because: <reason>`. Planning the fallback as
the step quietly downgrades an independent review into a second opinion from the same model family
that wrote the code.

**Never attribute a review to a model that did not run it.** If the pinned model is refused
(400 / CLI too old / not authenticated), say which model actually ran, or that the review was blocked
— a verdict stamped with the wrong provenance is a fabricated review.

## Relationship to Review Boss
`forge-code-review` is the **method** — the checklist and severity scale anyone applies when reviewing
code, including Build Boss self-reviewing before handoff. **Review Boss** (`.claude/agents/review-boss.md`)
is the **agent identity** that runs this method (plus `verification-before-completion`, `design-is`,
`requesting-code-review`) as the final QA gate before a task is ever reported done. Use this skill
directly for an in-flight self-review; dispatch Review Boss for the end-of-task gate.
