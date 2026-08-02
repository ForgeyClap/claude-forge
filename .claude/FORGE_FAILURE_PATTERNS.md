# Forge Failure Patterns (project-local)

> Append-only log of BLOCKED / quality-gate-blocked causes for this project. Purpose: give Head Chef
> (and whichever agent picks up a stalled work package next) a real memory of *why* past attempts
> failed, so the same decomposition mistake isn't repeated on the next retry or the next similar task.
> Inspired by the MAST multi-agent failure taxonomy — failures are bucketed into three broad causes so
> patterns become searchable instead of buried in run logs. Existing projects create this file on
> first use; new installs get it from this template.

## Format

Append one line per resolved failure, oldest first, newest at the bottom. No other formatting.

```
- [YYYY-MM-DD] [spec|coordination|verification] WP/onderwerp — wat ging mis — wat de fix/les was
```

## Categories

- **spec** — onduidelijke of te grote opdracht (the work package itself was underspecified or too
  large to land safely in one pass).
- **coordination** — agents werkten langs elkaar heen of in de verkeerde volgorde (parallel or
  sequenced work stepped on itself, or a handoff was missed).
- **verification** — bewijs ontbrak of klopte niet (a "done" claim wasn't backed by a real check, or
  the check that ran didn't actually cover the claim).

## Patterns
