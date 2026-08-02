# forge-code-review — learnings

Append-only log of real corrections/preferences learned from actual runs. Read this file before
applying `forge-code-review`; add one dated entry (with evidence) after a run that produced a genuine
correction. Never invent an entry — an unsupported "lesson" is worse than no lesson.

- **2026-07-31:** this skill's `description` frontmatter was rewritten from a long, keyword-stuffed
  version (which listed every trigger phrase and restated the full review order/severity scale inline)
  down to a compact ≤200-char summary, as part of a project-wide fix: the skill picker was found to
  truncate descriptions above a ~11k-character total budget across all 48 skills (24,423 chars measured
  before the fix, 8,390 after). Evidence: FORGE_MEMORY.md 2026-07-31 entry ("Skill laadt niet goed —
  wortel gemeten") and `.claude/skills/DESCRIPTIONS-BACKUP-2026-07-31.md` (pre-fix backup). Lesson: keep
  the description short and let the skill BODY carry the detail — a long description doesn't make the
  skill activate better, it risks the whole list getting cut off.
