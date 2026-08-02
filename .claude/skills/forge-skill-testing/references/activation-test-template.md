# Activation-test + A/B benchmark template (copy per skill run)

Copy this block into the run's scratch notes (or a `.claude/forge-research/` dump) when actually
executing the protocol `forge-skill-testing/SKILL.md` documents. Fill in every row with a REAL result —
an empty/guessed row is worse than no row (never fabricate a pass).

## 1. Activation test

**Skill under test:** `<skill-name>`
**Date:** `<YYYY-MM-DD>`
**Tester:** `<who/what ran it — e.g. "fresh Claude session, no prior context">`

### Trigger phrases (SHOULD activate the skill) — need 6+

| # | Phrase tried | Activated? (Y/N) | Notes |
|---|---------------|-------------------|-------|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |

### Near-miss phrases (should NOT activate this skill) — need 4+

| # | Phrase tried | Activated? (Y/N) | Notes |
|---|---------------|-------------------|-------|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |

**Score:** `<correct>/<total>` → `<percent>%` (target >= 95%)

### Registry logging (append to `.claude/FORGE_SKILL_REGISTRY.md`)

This project's registry table has no dedicated "activation test" column (see its own legend) — append
a compact, dated note to that skill's row in the **Safety notes** column, in this exact shape (matches
the free-text convention that column already uses):

```
activation <correct>/<total> (<YYYY-MM-DD>)
```

Example: `activation 11/12 (2026-08-05)`. Never edit any OTHER skill's row while doing this. Never
invent a score — a skill with no protocol run yet keeps its existing Safety notes unchanged.

## 2. Fresh-session A/B benchmark (OPT-IN — costs real runs, never a gate)

**Design session:** Claude A designs/edits the skill.
**Test session:** Claude B, a genuinely FRESH session (no shared context with A), attempts the target
task 3 times WITH the skill available and 3 times WITHOUT it (skill dir temporarily moved/renamed, or
a throwaway project copy with the skill absent).

| Run | Skill present? | Pass/Fail | Time (wall-clock) | Tokens (approx, from `/context` or session stats) |
|-----|-----------------|-----------|--------------------|----------------------------------------------------|
| 1 | yes | | | |
| 2 | yes | | | |
| 3 | yes | | | |
| 4 | no | | | |
| 5 | no | | | |
| 6 | no | | | |

**Verdict:** `<one line — did the skill measurably help pass-rate/time/tokens, or not?>`

Record this table (or a link to it) in the skill's own `learnings.md`, dated, with the real numbers —
never a hypothetical/expected result standing in for a run that didn't happen.
