# global-install — the global Forge core

Copy the contents of this folder's `.claude/` into your user-level Claude config at `~/.claude/`
(Windows: `%USERPROFILE%\\.claude\\`). This installs the two small GLOBAL pieces Forge needs so that
`/forge` works in every project and the project-level `/forge` can reference the full `forge-core` playbook:

```
~/.claude/
  skills/forge-core/        ← Forge behavior + governance (the project /forge references this)
    SKILL.md
    references/
  commands/forge.md         ← the lightweight global /forge command
  commands/setup-forge.md   ← the bare /setup-forge first-run onboarding wizard
```

The bare `/setup-forge` command now ships alongside `/forge` in the global core,
so after the installer copies this folder into `~/.claude`, both `/forge` and
`/setup-forge` are available in every project (no plugin namespace prefix — the
plugin route uses `/forge:forge` and `/forge:setup-forge` instead).

Then copy the repo's top-level `.claude/` into any PROJECT you want to build with Forge (see the main README).

Nothing else from the author's global `~/.claude` is included — only these Forge-specific files.
