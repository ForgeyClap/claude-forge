# forge-verify — learnings

Append-only log of real corrections/preferences learned from actual runs. Read this file before
applying `forge-verify`; add one dated entry (with evidence) after a run that produced a genuine
correction. Never invent an entry — an unsupported "lesson" is worse than no lesson.

- **2026-07-31:** `forge-verify.cjs` gained `checkAcceptanceCoverage()` (spec-drift / acceptance-
  coverage detection, backlog item 7 from the GSD (get-shit-done-cc) mining pass) — closing a real gap
  this skill previously missed: a planner silently dropping a PRD acceptance criterion produced no
  mismatch at all under the old events/tickets-only check, because the criterion was never wired to a
  task in the first place. Each PRD criterion is now classified covered/dropped/changed; a `dropped`
  criterion with no explicit owner decision is now a verify failure. Evidence:
  `.claude/forge-bin/forge-verify.cjs` header comment "BACKLOG ITEM 7 / spec-drift (2026-07-31...)" and
  `.claude/forge-research/MINING-RONDE-1-2026-07-31.md`. Lesson: "the events say it's done" and "the
  spec's own requirements are still fully covered" are two different checks — verify both.
