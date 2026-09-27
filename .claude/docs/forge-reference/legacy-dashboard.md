# Forge reference — `/forge legacy dashboard` (retired per-project Control Center)

Moved out of `.claude/commands/forge.md` (v2.9.0, WP-C context trim) so the command file only carries a
one-line pointer for this rarely-used path. This file is the full, unmodified rule — read it before running
`/forge legacy dashboard`. Nothing below was reworded from the original; it is the same rule that used to sit
inline.

## When this applies

The owner explicitly asks for the OLD per-project dashboard by name ("legacy dashboard", "old Forge
dashboard"). It never starts automatically — the Command Center on port 4100 is the current dashboard for
every project (see the `dashboard` sub-command in `commands/forge.md`).

## The rule (verbatim)

**`legacy dashboard`** / `old Forge dashboard` → the RETIRED per-project Control Center, available ONLY on
this explicit request (it never starts automatically): check `.claude/forge-dashboard/server.cjs` exists,
start it, health-check `http://localhost:<port>/api/health` (port from `.claude/forge-dashboard/PORT`),
report that URL, and remind that the Command Center on 4100 is the current dashboard.
