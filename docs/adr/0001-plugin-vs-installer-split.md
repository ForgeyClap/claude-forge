# ADR 0001 — Plugin is LITE, installer is FULL

- **Status:** Accepted
- **Date:** 2026-07-18
- **Deciders:** ForgeyClap (maintainer)

## Context

Forge V2 ships as an open-source Claude Code extension through **four** install
methods (see the [README](../../README.md)): the Claude Code plugin, a one-line
installer, a clone-and-run installer, and manual copy. All four converge on the
same first run, `/setup-forge`.

Two of those methods deliver fundamentally different amounts of the system, and
that difference is **not a product choice — it is forced by how Claude Code
loads a plugin.** A plugin is fetched and copied into a read-only cache under
`~/.claude/plugins/` and runs from there. From that sandbox it **cannot**:

- write into the user's `~/.claude/` (to install the global `forge-core` core or
  the bare `/forge` / `/setup-forge` commands),
- scaffold the per-project `.claude/` payload (skills, agents, `forge-bin`,
  config, commands) into the user's actual project directory,
- stand up the per-project localhost dashboard, or
- run the `.env` key-setup flow (create the temp fill-file, move values into a
  gitignored `.env`, delete the temp file) — that requires writing into the
  project working tree.

A filesystem installer, by contrast, runs with the user's own permissions and
can do all of the above with a merge-safe, backup-before-overwrite copy.

If we pretended the plugin could deliver the full system, newcomers would
install it, look for the dashboard or the key flow, find nothing, and blame
themselves. This confusion is the single most likely first-run failure.

## Decision

We ship **two tiers, named honestly**, and document the split in a
Plugin-vs-Installer comparison table in the README.

- **Plugin = LITE.** `plugins/forge/` contains commands (`/forge:forge`,
  `/forge:setup-forge`), the 18 Boss agents, and a curated array of skills.
  It is a read-only cache install: no `~/.claude` core write, no per-project
  `.claude/` scaffold, no dashboard, no `.env` key setup. Its `/forge:setup-forge`
  detects that it is plugin-only and offers to run the full installer.
- **Installer / manual = FULL.** `install.sh` / `install.ps1` (and the manual
  copy) write the per-project `.claude/` payload into the user's project, copy
  the global core into `~/.claude`, enable the live dashboard, and run the
  `/setup-forge` key flow. Because the core is copied into `~/.claude/commands`,
  the installer route exposes the **bare** `/forge` and `/setup-forge` commands,
  whereas the plugin route always uses the **namespaced** `/forge:forge` and
  `/forge:setup-forge`.

## Consequences

- The README leads with a comparison table so the tiers are clear before a user
  picks one, and documents both the bare and namespaced command forms.
- Skill content must be **duplicated as real files** into the plugin bundle
  (`plugins/forge/skills/<name>/SKILL.md`) rather than symlinked, because
  cache-copy installers drop symlinks. This means the same skill lives in two
  places and the two must be kept in sync.
- Anyone changing the plugin/installer boundary must preserve the two invariants
  below.

## Invariants (recorded here, checked in CI / by `forge-doctor`)

1. **Curated-skills-array invariant.**
   The plugin ships an **explicit, curated array of real files**. Every skill
   that is meant to ship must exist under `plugins/forge/skills/<name>/SKILL.md`
   as a **real file, not a symlink**. Work-in-progress skills and
   `CUSTOM_SKILL_TEMPLATE.md` are excluded. A skill present only in
   `.claude/skills/` (and not in the plugin bundle) will silently fail to load
   for plugin users.

2. **Version-sync invariant.**
   The version is declared in **one** source of truth, never two. Do **not** set
   `version` in both `plugins/forge/.claude-plugin/plugin.json` and the
   marketplace entry in `.claude-plugin/marketplace.json` — `plugin.json`
   silently wins and the drift misleads users. For rapid development, omit
   `version` from `plugin.json` so each commit auto-updates; for a stable
   release, set it in `plugin.json` only and keep the `VERSION` file and
   [CHANGELOG](../../CHANGELOG.md) in agreement, git-tagging on release.

## References

- README — Plugin vs Installer comparison table.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — the two invariants, restated for
  contributors, plus the validation steps (`claude plugin validate .`,
  `forge-doctor`).
