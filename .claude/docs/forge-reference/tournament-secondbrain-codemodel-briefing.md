# Forge reference — `tournament` / `secondbrain` / `codemodel` / `briefing <run_id>`

Moved out of `.claude/commands/forge.md` (v2.9.0, WP-C context trim) so the command file only carries a
one-line pointer for these rarely-used paths. This file is the full, unmodified rule — read it before
running any of the four sub-commands below. Nothing below was reworded from the original; it is the same
rule that used to sit inline (the `propose-skill` / `approve-skill` sub-commands referenced in the closing
note stay inline in `commands/forge.md` itself — only these four moved here).

## When this applies

- `tournament` — the owner wants several implementation variants scored and the best one promoted.
- `secondbrain` — the owner wants a read-only, cross-project portfolio recommendation.
- `codemodel` — the owner wants the incrementally-updated repo index queried or refreshed.
- `briefing <run_id>` — the owner (or an overnight `forge-nightshift` run) wants the morning briefing for a
  specific run.

## The rule (verbatim)

- **`tournament`** → `node .claude/forge-bin/forge-tournament.cjs` — best-of-N variants scored against a
  transparent rubric; the winner is promoted, never fabricated.
- **`secondbrain`** → `node .claude/forge-bin/forge-secondbrain.cjs` — read-only, secrets-excluded portfolio
  strategist; every recommendation cites `{project, file, fact}`.
- **`codemodel`** → `node .claude/forge-bin/forge-codemodel.cjs` — incrementally updated repo index; results
  are labelled stale when the index is behind.
- **`briefing <run_id>`** → `node .claude/forge-bin/forge-briefing.cjs --run <run_id>` — the morning briefing
  for an overnight (`forge-nightshift`) run.
  *(These six were advertised by `forge-core` since v8.1 but had no entry here; wired 2026-09-23 after an
  external audit. Each tool ships in `forge-bin/` and prints usage on `--help`.)*
