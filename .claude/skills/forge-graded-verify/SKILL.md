---
name: forge-graded-verify
description: "Advisory GRADED verification for high-stakes answer-quality Forge tasks (RAG/research/scraping/prediction). Use when output quality is subjective and needs per-criterion scoring + actionable feedback — ALONGSIDE (never replacing) forge-verify (structural) and forge-evals (deterministic binary gate). Keywords: graded, rubric, quality, verify, review, answer quality, RAG quality, source grounding."
---

# forge-graded-verify — advisory rubric-scored verification (scout #7, 2026-07-13)

Fills the graded-quality axis Forge deliberately lacks: `forge-verify` checks structural bookkeeping ("did the agent close its tickets"); `forge-evals` is intentionally deterministic-binary so it can safely gate git reverts. Neither scores subjective ANSWER QUALITY. This skill adds that — advisory only. Method reimplemented from the DeepVerifier failure-taxonomy pattern (arXiv 2601.15808); no code/dataset from that repo is used.

## When to use
High-stakes answer-quality work where "did it pass an assertion" isn't enough: RAG answers, research syntheses, scraped-data summaries, prediction rationales. NOT for code/build gating (that stays with forge-evals + integration-gate). Reserve for genuinely high-stakes tasks — it costs an LLM review pass; don't duplicate ultra-review.

## How it works (advisory, bounded, never gates irreversible actions)
1. **Pick the rubric** for the domain from `.claude/config/rubrics/<domain>.json`. Each criterion has: `id`, `descriptor` (4-level: 1=poor … 4=excellent, what each level means), and `raise` (what would move the score up).
2. **Dispatch review-boss as a GRADED verifier** (not the binary reviewer): it reads the output + the source/context, and returns per-criterion `{id, score 1-4, evidence, feedback}` via verification-by-decomposition (judge each criterion separately, cite evidence).
3. **Bounded single rework loop:** if any required criterion scores < the threshold (default 3), emit ONE `rework_task_created` → `rework_assigned` to the owning Boss with the NL feedback, re-grade ONCE, respect the usage-guard. No open-ended loops.
4. **Log advisory only:** record the graded result via the existing `gate_evaluated` / `lead_review_completed` events (do NOT invent event types). NEVER let a graded score gate an irreversible action (deploy, git revert, send) — deterministic forge-evals / owner approval stay authoritative there.

## Honesty
LLM-graded scores are judgment, not ground truth (a judge can mislabel). Frame results as advisory quality signals; cite per-criterion evidence; the reviewer model should differ from the builder model (evaluator independence). Rubrics are owner-editable JSON — start from the shipped ones and ADAPT per project, don't drop-in.

## Rubrics
Shipped starters in `.claude/config/rubrics/`: `rag.json` (source-grounding, reasoning soundness, coverage, answer-correctness, completeness). Add per-domain rubrics as needed (research, scraping, prediction) with the same shape.
