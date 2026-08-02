# forge-snapshot — learnings

Append-only log of real corrections/preferences learned from actual runs. Read this file before
applying `forge-snapshot`; add one dated entry (with evidence) after a run that produced a genuine
correction. Never invent an entry — an unsupported "lesson" is worse than no lesson.

- **2026-07-29:** the owner's original ask ("bij elke 50% context een snapshot.md") assumed a
  context-percentage a hook could read — investigation found this is a closed Claude Code feature
  request; no hook can read `context_window.used_percentage`. Rather than fabricate or estimate a
  percentage, the design was corrected to fire on real, honest signals only: a PreCompact hook (the
  genuine "about to compact" event) plus an explicit manual/phase-boundary call. Evidence:
  `.claude/skills/forge-snapshot/SKILL.md` intro paragraph and commit `97a5a0d` (context-snapshot
  system, 52 tests, doctor 99 suites/4527/0). Lesson: when the owner's request assumes a signal the
  platform doesn't actually expose, correct the design to the nearest honest signal — never fake the
  requested one.
