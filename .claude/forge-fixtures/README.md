# Forge fixtures vault (project-local, real-input-only)

This directory is the **fixtures vault**: the one place owner-provided **REAL sample inputs**
(invoices, CSVs, sample documents, scanned receipts, API payloads, real transcripts, etc.) live
for correctness-critical builds.

## Why this exists

The Forge honesty core says a run can't claim "done" on fabricated proof (see
`config/orchestration/required-evidence.json` and `forge-actiongate.cjs`'s single-source-of-truth
discipline). This vault applies the same discipline to **test data**: for domains where being
subtly wrong on real-world input is the actual risk — finance/invoicing, parsers, OCR, data/ETL
transforms, prediction/backtesting — testing only against clean synthetic fixtures proves nothing
about the failure modes that matter. `forge-fixtures.cjs` is the gate that checks whether a
correctness-critical domain actually has real fixtures (or an explicit, logged waiver) before a
build in that domain can honestly be called done.

See `.claude/forge-bin/forge-fixtures.cjs` for the `requirement()` / `check()` API and its CLI.

## What belongs here

- Real owner-provided sample files needed to prove correctness: sample invoices, CSV exports,
  scanned/photographed documents for OCR, real API payload captures, real historical data slices
  for prediction/backtesting.
- Small, targeted samples — enough to exercise real-world irregularity (messy formatting, OCR
  noise, edge-case rows), not a bulk data dump.

## What does NOT belong here

- Anything containing real client PII, real payment details, real credentials, or any data the
  owner hasn't explicitly approved for local use in this repo's working tree.
- Large bulk datasets — keep fixtures small and targeted; link to an external secure source for
  bulk data instead.

## Git hygiene — real fixtures stay LOCAL, never committed

**Real, owner-provided sample data must NOT be committed to git.** Only this `README.md` (and any
deliberately-crafted, fully synthetic/placeholder fixture explicitly marked as such) may be
tracked. A `.gitignore` in this directory enforces that: everything placed here is ignored by
default except this README and files explicitly whitelisted as synthetic placeholders (name them
`*.synthetic.*` or `*.placeholder.*` if you need a tracked, safe example fixture).

If a correctness-critical build genuinely cannot get real fixtures (e.g. the owner hasn't provided
sample data yet), do not silently fall back to synthetic data and call the build done. Either wait
for real fixtures, or have the owner log an explicit waiver (`forge-fixtures.cjs check --waiver
"<reason>"`) so the gap is visible in the run's evidence trail, not hidden.

## Placeholder note

This vault intentionally starts empty of real data (`.gitkeep`-equivalent: this README is the only
tracked file). Drop real, owner-approved sample fixtures directly into this directory as needed
per build — they will stay local automatically.
