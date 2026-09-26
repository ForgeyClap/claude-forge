# Contributing to claude-forge

Thanks for your interest in improving **Forge V2** (`claude-forge`). This is a
zero-dependency, multi-agent build / automation / review / delivery system for
[Claude Code](https://claude.com/claude-code). Contributions of skills, agents,
docs, and bug fixes are welcome.

By contributing you agree that your work is licensed under the project's
[MIT License](LICENSE) and that you will follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

---

## Ground rules

- **Zero runtime dependencies in the core.** Forge's own tools ship as plain Node
  `.cjs`, POSIX `sh`, PowerShell, Markdown, JSON, or YAML. No npm packages, no
  native modules, no build step. A PR that adds a dependency to `.claude/forge-bin`
  or the global core will not be merged. The one scoped exception: the optional
  Command Center dashboard (`command-center/dashboard/`) is a Vite/web app with its
  own `package.json` and a one-time `npm install && npm run build` — that step stays
  confined to the dashboard folder and is never required for `/forge` itself.
- **Honesty first.** Never claim a check, test, or review ran if it did not.
  Never commit real secrets or print secret values. Report what actually
  happened.
- **Cross-platform.** The project is Windows-first but must work on macOS and
  Linux too. If you touch a script, test both a POSIX shell and PowerShell path.
- **Keep files small.** Prefer many small focused files over few large ones
  (target < 500 lines).
- **Read before you edit.** Inspect the existing layout; match the surrounding
  style and naming.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `.claude/` | The per-project Forge payload (skills, agents, dashboard, `forge-bin`, config, commands). |
| `global-install/.claude/` | The small global core copied into `~/.claude` (the `forge-core` skill + the bare `/forge` and `/setup-forge` commands). |
| `plugins/forge/` | The **LITE** Claude Code plugin bundle (commands, 18 agents, 22 curated skills). |
| `.claude-plugin/marketplace.json` | Repo-as-marketplace catalog. |
| `docs/adr/` | Architecture Decision Records. Read [ADR 0001](docs/adr/0001-plugin-vs-installer-split.md) before changing the plugin/installer split. |
| `install.sh` / `install.ps1` | The merge-safe installers. |

---

## Adding a skill

Skills live in two places and **both** must stay in sync (see the invariants
below).

1. Create the skill under `.claude/skills/<skill-name>/SKILL.md` with valid YAML
   frontmatter (`name`, `description`). Add any `references/` alongside it.
2. **Copy the real files** into the plugin bundle at
   `plugins/forge/skills/<skill-name>/SKILL.md`. Use real files, not symlinks —
   cache-copy installers drop symlinks, so a symlinked skill silently fails to
   load.
3. If the skill is domain-routing relevant, wire it into the `forge-router`
   skill so it can be selected per task.
4. Run the validation and doctor steps below.

Do **not** ship work-in-progress skills or the `CUSTOM_SKILL_TEMPLATE.md` in the
curated plugin array — only finished, shipping skills go in the bundle.

## Adding an agent

1. Create `.claude/agents/<agent-name>.md` with valid frontmatter.
2. Copy the real file into `plugins/forge/agents/<agent-name>.md`.
3. Keep the agent list consistent between the two locations.

---

## The two ADR invariants (must hold on every PR)

These are recorded in
[ADR 0001](docs/adr/0001-plugin-vs-installer-split.md) and are checked in CI:

1. **Every shipped skill appears in the plugin skills bundle.**
   The plugin ships a *curated, explicit array of real files*. If a skill exists
   in `.claude/skills/` and is meant to ship, it must also exist under
   `plugins/forge/skills/<name>/SKILL.md` as a real file (never a symlink).
   Nothing loads if it is only in one place.

2. **Version stays synced to a single source of truth.**
   The version is declared in **one** place, not two. Do **not** set `version`
   in both `plugins/forge/.claude-plugin/plugin.json` and the marketplace entry
   (`plugin.json` silently wins, and drift confuses users). Keep the `VERSION`
   file, the plugin manifest, and the [CHANGELOG](CHANGELOG.md) in agreement
   when you cut a release.

---

## Validating your change

Run these locally before opening a PR.

**1. Validate the plugin manifest + skill/agent YAML:**

```bash
claude plugin validate .
```

Use `claude plugin validate . --strict` to fail on a malformed manifest, a
duplicate plugin name, path traversal, or bad skill/agent frontmatter. **Note:**
the `claude` CLI is not available on CI, so CI does not run this exact command —
it asserts the same required fields on the raw JSON manifests instead (see
`.github/workflows/validate.yml`). Run the real `claude plugin validate` locally;
CI is the parseable-JSON-plus-required-fields fallback, not a substitute for it.

**2. Run forge-doctor (self-test + secret/leak scan):**

```bash
node .claude/forge-bin/forge-doctor.cjs
```

This `node --check`s every source file, runs the test suites, verifies the
honesty gate, confirms the dashboard SPA is intact, and scans git-tracked files
for leaked secrets. Get it **all green** before you push. To run just the leak
scan:

```bash
node .claude/forge-bin/forge-doctor.cjs   # runs the full self-test including the leak scan (there is no separate leakScan mode)
```

**3. If you touched the onboarding / key flow**, also run the setup tests directly
(`forge-setup.cjs` has no `--self-test` flag — that flag does not exist):

```bash
node .claude/forge-bin/forge-setup.test.cjs
```

Confirm keys never leak, the temp fill-file is deleted, `.gitignore` stays
correct, and the flow is idempotent.

---

## Pull request flow

1. **Fork** the repo and create a branch from `main`
   (`feat/<thing>` or `fix/<thing>`).
2. Make the change; keep it focused and small.
3. Run the three validation steps above. **Do not** open a PR with a red
   `forge doctor` or a failing `claude plugin validate . --strict`.
4. Commit with a clear
   [Conventional Commits](https://www.conventionalcommits.org/) message
   (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
5. Push and open a PR against `main`. In the description, state:
   - what changed and why,
   - which checks you actually ran and their real result,
   - whether it touches the plugin/installer split or the key flow.
6. CI (`.github/workflows/validate.yml`) checks the tracked-file/gitignore
   invariant, the executable bit on every `.sh`, `node --check`s every `.cjs` in
   `.claude/forge-bin`, runs the Forge test suites, runs `forge-doctor.cjs`, and
   validates the plugin/marketplace manifests as parseable JSON with the required
   fields (the `claude` CLI itself isn't installed on the runner, so it cannot run
   `claude plugin validate` there). `.github/workflows/fresh-install.yml` installs
   into an empty directory with an empty `HOME` on Windows and Linux and checks the
   doctor is green. A green run on both plus a maintainer review is required to merge.

Small, honest, well-tested PRs get merged fastest. Thank you for contributing!
