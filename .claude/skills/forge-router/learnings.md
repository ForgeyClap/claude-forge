# forge-router — learnings

Append-only log of real corrections/preferences learned from actual runs. Read this file before
applying `forge-router`; add one dated entry (with evidence) after a run that produced a genuine
correction. Never invent an entry — an unsupported "lesson" is worse than no lesson.

- **2026-07-13:** `skills/forge-router/SKILL.md` was found missing from forge-sync's FILES manifest —
  every router clause added since (intake Step 0a, lean-return, dispatch shaping, lesson-recall) had
  been drifting silently and never reaching the 11 synced projects. Fixed by adding forge-router to
  `forge-sync.cjs`'s system-skill list (same treatment as forge-verify/forge-prd). Evidence:
  FORGE_MEMORY.md "Status update 2026-07-13c" — sync 12/12 at version fd0a0c513ea9, verified present in
  the an e-commerce project project. Lesson: a new/edited system skill is not actually distributed until it is
  confirmed present in forge-sync's manifest, not just present on disk here.
