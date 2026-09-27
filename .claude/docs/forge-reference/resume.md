# Forge reference — `/forge resume <run_id>` (WAVE D)

Moved out of `.claude/commands/forge.md` (v2.9.0, WP-C context trim) so the command file only carries a
one-line pointer for this rarely-used path. This file is the full, unmodified rule — read it before running
`/forge resume`. Nothing below was reworded from the original; it is the same rule that used to sit inline.

## When this applies

A session/usage limit killed a swarm mid-run and some work packages never finished.

## The rule (verbatim)

**`resume <run_id>`** (WAVE D) → a session/usage limit killed a swarm mid-run; reconcile that run's manifest
**purely from its logged `events.jsonl` content** (never inferred from side effects, never a fabricated
"done") and re-dispatch **only** the still-unfinished work packages with their original narrowed scope.
Requires the run to have been ARMED at dispatch time — that ARM step is now `arm-manifest` in
`.claude/config/orchestration/run-checklist.json` (advisory, sits between `route` and `dispatch`):
`node .claude/forge-bin/forge-manifest.cjs arm --run <run_id> --wps <file.json> --log-event` — one record
per WP: `wp_id, agent, narrowed_prompt, deps?`. **`--log-event` logs the `manifest_armed` proof event in the
SAME act as the write** (2026-08-01), so arming and its proof can no longer disagree; without it you must
log `manifest_armed` yourself or `forge-orchestrate.cjs audit` will report the step skipped. Once a run is
armed, `node .claude/forge-bin/forge-manifest.cjs ready --run <run_id>` gives the honest frontier and
`... waves --run <run_id>` gives the full dispatch order in which everything inside one wave is mutually
independent — that is the mechanical way to satisfy the owner's "one writer per hotspot at a time" HARD MUST
instead of eyeballing the order. Then:
`node .claude/forge-bin/forge-swarm-resume.cjs --run <run_id> [--json]` (or `forge.cmd resume --run <run_id>`
/ `forge.ps1 resume --run <run_id>` / `bash forge.sh resume --run <run_id>`) — exit 0 = complete (nothing to
resume) / 3 = resumable / 2 = usage error or no manifest was ever armed. Re-dispatch each returned unfinished
WP exactly as originally scoped and log `wp_resumed` per WP as it goes back out. A `done` WP is **never**
re-dispatched. This module has zero side effects of its own beyond persisting the reconciled manifest — a WP
whose own work is side-effecting (email/deploy/payment/etc.) still needs its own `forge-checkpoint.cjs`
idempotency guard before repeating that side effect.
