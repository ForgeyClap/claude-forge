---
name: forge-deeplearn
description: Read-only full-codebase priming scanner. Use before a PRD or big refactor, or onboarding into an unfamiliar project — deep learn, prime the codebase, scan the project, risk list.
---

# Deep Learn Mode (WP2 — full-codebase priming scan)

Deep Learn Mode is an **on-demand, read-only** scan of the current project (`.claude/forge-bin/forge-deeplearn.cjs`) that produces an honest project-summary and risk-list BEFORE the Lead commits to a PRD or a big architectural change. It never writes into the scanned tree — its only output is its own artifact under `.claude/` (with `--store`) and optional dashboard events.

## When the Lead runs it
- A new or unfamiliar project (first `/forge` run, or "gebruik forge voor dit project" on a folder with no memory yet).
- Before generating a PRD or acceptance criteria for a non-trivial feature.
- Before a large refactor, migration, or architecture change.
- Not needed for a 1-2 line fix, or a project already scanned this session — check `.claude/forge-artifacts/index.jsonl` first.

## How
```
node .claude/forge-bin/forge-deeplearn.cjs --path . --run <run_id> --store
```
- `--path <dir>` — defaults to the current directory.
- `--run <run_id>` — logs `deep_learn_started` / `deep_learn_completed` to that run's dashboard events (omit to run standalone).
- `--store` — persists the full result via `forge-store.cjs` (`.claude/forge-artifacts/deeplearn-<epoch>.json`).

## What it outputs
Stack (node/python/go/rust/dotnet/php/static + framework hints from `package.json` deps), file **counts** by category, likely **entry points**, **tests** presence, the **5 largest code files**, and a **risk-list** (`high`/`med`/`low`) covering missing tests, oversized files (>800 lines), a missing README, TODO/FIXME density, secret-looking strings, and an unignored `.env`. Feed the summary + risks straight into the PRD's acceptance criteria, and hand any `high` risk to the Security Boss / `security-reviewer`.

## Honesty rule (non-negotiable)
- **Read-only.** It only ever reads files under `--path`; it never edits, deletes, or writes into the scanned project. Its only write is the explicit `--store` artifact under `.claude/forge-artifacts/`.
- **Real findings only** — every risk is backed by an actual file/pattern match; nothing is invented.
- **Never prints or stores a raw secret.** A secret-looking match is reported as `{file, pattern_name}` only, never the matched text — `forge-store.cjs`'s own redaction is a second safety net when `--store` is used.

## Deeper priming (optional, not required)
For genuinely deep *semantic* understanding beyond this structural scan, the Lead MAY additionally invoke the `graphify` skill (knowledge graph of the codebase) or the ECC `learn-codebase` skill (full-file read-through). Deep Learn Mode is fast and structural; those are slower and semantic — use them together on large/unfamiliar codebases, not as a replacement for each other.
