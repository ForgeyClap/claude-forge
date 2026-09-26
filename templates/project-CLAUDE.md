# CLAUDE.md — project brain

This file is read by Claude Code at the start of every session in this project.
The installer created it because it did not exist yet. **Edit it freely** — the Forge
installer will never overwrite it; a re-install only adds the `## Forge` section below
if it is missing.

## Project identity

- **Name:** <!-- fill in: your project name -->
- **What it is:** <!-- fill in: one honest sentence -->
- **Stack:** <!-- fill in: languages, frameworks, database, hosting -->
- **Status:** <!-- new / in development / in production -->

## How to run and test

<!-- Fill these in; agents read them before touching anything. -->

```bash
# install dependencies
# run the app
# run the tests
```

## Project rules

- Work only inside this project folder.
- Never commit secrets. Real values live in `.env` (gitignored); placeholders in `.env.example`.
- Never claim a test, build, or check ran if it did not actually run.
- Ask before anything destructive or outward-facing: deploying, pushing, deleting, sending.

## Forge

This project has [claude-forge](https://github.com/ForgeyClap/claude-forge) installed.

- **`/forge <task>`** — classify the task, pick the smallest fitting agent team, build it, and
  report honestly what ran and what did not.
- **`/setup-forge`** — first-time onboarding and a health check of this installation.
- **`/forge config`** — see and change every Forge setting (everything is on by default), or just say it in
  chat. Forge runs every command itself and never asks you to run code; it only stops for the hard gates
  (deploying, pushing, spending money, …) and a real usage-limit pause. One deliberate exception: four
  command-kind hard gates (recursive delete, killing a process by name, a git command that discards
  uncommitted work, and a command that hides what it runs) are enforced by a real hook, not just a rule —
  a classifier, not a proof. Setting `gate-hook`, on by default; only you turn it off (`/forge config set
  gate-hook off`, or the same command prefixed with `!`) — an agent's own attempt is blocked.
- **`node .claude/forge-bin/forge-doctor.cjs`** — run the full self-test of the Forge install.

Forge keeps its memory of this project in `.claude/FORGE_*.md` and logs every run to
`.claude/forge-runs/<run_id>/` (gitignored — those logs are local to your machine).

Agent behaviour, playbooks and quality gates live in `.claude/skills/`; the rules above in
**Project rules** always win over anything a skill suggests.
