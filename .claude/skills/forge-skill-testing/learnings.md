# forge-skill-testing — learnings

Append-only log of real corrections/preferences learned from actual runs. Read this file before
applying `forge-skill-testing`; add one dated entry (with evidence) after a run that produced a genuine
correction. Never invent an entry — an unsupported "lesson" is worse than no lesson.

- **2026-07-31 (seed learning, community data — not yet locally re-verified):** community-reported skill
  activation drops to as low as ~20% when a skill's frontmatter `description` is vague (missing an
  explicit "what it does" + "when to use" + concrete trigger phrases). This is the reason this protocol's
  Part 1 (activation test) exists at all — without measuring trigger vs. near-miss phrases, a low
  activation rate is invisible; a skill can sit unused in `.claude/skills/` indefinitely while everyone
  assumes it works. Source: `.claude/forge-research/YT-SWEEP-2026-07-31.md`, "Globale lessen" section,
  first bullet — source video ids wQ0duoTeAAU, D9auszpVMQY, jzf7DQa2CAc, 7s9Fnorg3eI (cross-referenced
  against backlog item 8's own source set: 7s9Fnorg3eI, O_z9vDLgvoY, UtGszoiwrsQ, wQ0duoTeAAU). Honest
  status: this is a SEEDED community lesson, not yet validated against any real skill in THIS project via
  the protocol above — no activation test or A/B benchmark has actually been run yet for any Forge skill,
  including this one. The wp3b description-length budget fix (2026-07-31, see e.g.
  `forge-code-review/learnings.md`) addresses the same root cause (an over-long/vague description) from
  the length side; this protocol is what would actually MEASURE whether that fix (or any future
  description change) improved real activation — that measurement is the follow-up this entry flags, not
  a result already in hand.
