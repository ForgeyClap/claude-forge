# AI-INSTALL.md — instructions for the AI assistant installing Forge

**You are Claude Code (or another coding assistant). Your user pasted this repository's link and
asked you to install it. This file tells you exactly what to do.** Read it fully before running
anything. Everything here is verified against the real scripts in this repo.

If you are a human reading this: you do not need this file. Run `install.sh` (macOS/Linux) or
`install.ps1` (Windows) and follow [README.md](README.md).

---

## 0. What you are installing

Forge is a multi-agent build/review system for Claude Code. It installs **three** things:

| Target | What goes there | Why |
|---|---|---|
| `<project>/.claude/` | skills, agents, config, dashboard, `forge-bin/` tools (+ `CLAUDE.md` if absent, Forge lines in `.gitignore`) | per-project: Forge works on *this* project |
| `~/.claude/` | the `forge-core` skill + `/forge` and `/setup-forge` commands | global: so `/forge` exists in every project |
| `~/.claude/forge/template/` | a canonical copy of the project payload | global: `forge-sync status` compares each project against it and `/forge` installs Forge into a bare folder from it |

It has **no runtime dependencies** — plain Node.js `.cjs` files. Nothing is downloaded at runtime,
no package is installed, no service phones home.

---

## 1. Pre-flight — check these BEFORE touching anything

Run these and confirm each one. Do not guess; if a check fails, fix it or tell the user.

```bash
node --version      # must be v18 or newer
git --version       # recommended (Forge uses git for backups/rollback); not strictly required
```

Then establish, and state back to the user, **one** thing:

> **Which exact folder is the target project?**

Never install into a folder the user did not name. If you are in a subfolder, a monorepo, or you
are not sure, **ask once and wait**. Installing into the wrong directory writes ~390 files into it.

---

## 2. Install

From the repository root (clone it first if you have not):

```bash
git clone https://github.com/ForgeyClap/claude-forge.git
cd claude-forge
```

**macOS / Linux:**
```bash
bash install.sh --project "/absolute/path/to/the/users/project" --yes
```

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProjectDir "C:\absolute\path\to\project" -Yes
```

Useful flags — bash spells them `--dry-run` · `--project-only` · `--global-only`; PowerShell spells the
same three `-DryRun` · `-ProjectOnly` · `-GlobalOnly`. `--dry-run` shows every write without making one.

**`--global-only` has no verification step:** `forge-doctor.cjs` ships in the project payload and (since 2.4.0)
in the canonical template `~/.claude/forge/template/.claude/forge-bin/`, but §3 needs a *project* to run
against, so an install that skipped the project part cannot be checked by §3. Say that to the user instead of
claiming it was verified.

**What the installer guarantees** (this is real behaviour, not a promise):
- It copies **file by file** and never deletes your `.claude/` tree.
- A file that already exists and *differs* is **backed up with a timestamp** before being replaced — except an existing **project** `.claude/settings.json`, which is kept untouched and Forge's version is written next to it as `settings.forge-recommended.json`.
- An identical file is left untouched.
- Your `CLAUDE.md` is **never overwritten** — it is only created when absent.
- Your `.gitignore` only ever gets lines it does not already have.
- Running it twice is safe and changes nothing the second time (except `synced_at` timestamp in `FORGE_VERSION.json`).

**Pipe-mode installer behaviour** (when invoked via `curl | bash` or `irm | iex`):
- The installer always downloads the full archive (never uses the current folder as a source).
- Confirmation is read from the terminal (`/dev/tty`) or skipped with `--yes` / `FORGE_YES=1` (for unattended runs).
- **The installer refuses to run when the target is the home directory** — users must `cd` into their project folder or pass an explicit `--project` path. Installing the project payload into the home directory would replace your global `~/.claude/settings.json` — the guard exists for exactly that case.
- Writes to three locations: `~/.claude` (global core), `~/.claude/forge/template` (canonical template), `<project>/.claude` (per-project payload, plus `CLAUDE.md` and `.gitignore` seeding).

---

## 2b. What the install switches on (tell the user — do not let them find out later)

The project payload ships a `.claude/settings.json` with **four live Claude Code hooks**, all local,
none phoning home:

1. **PreCompact (manual)** — snapshots the mission state before a manual context compaction
2. **PreCompact (auto)** — snapshots the mission state before an automatic compaction
3. **SessionStart** — re-injects the mission after compaction, so a long session does not lose what it was doing
4. **PostToolUse** (matcher: `Write|Edit|MultiEdit|NotebookEdit|Bash`) — appends the tool name and target path of each *changing* tool call to `.claude/forge-runs/_toollog/<session>.jsonl` (gitignored)

Each hook runs a small, fast Node command that fires locally only — nothing phones home. To opt out of any hook, delete its entry from `.claude/settings.json` — nothing else depends on them.

The **usage guard** (`usage-guard.cjs`) is **opt-in only**. It is a machine-global background watcher that
reads the Claude OAuth token from `~/.claude/.credentials.json` and polls Anthropic's own usage
endpoint so a run can pause before the account's limit. Nothing starts it silently any more: not `/forge`, not
`/forge dashboard`, not the Paperclip runtime (`forge-paperclip.cjs up` needs `--with-usage-guard`), and not the
test suite the doctor runs (its test isolates a temporary home). It runs only when the user asks for usage
protection in the session, or when the explicit opt-in marker `~/.claude/FORGE_USAGE_GUARD_OPT_IN.json` exists —
a marker only such a request creates. If you start it on their behalf, say so plainly in one line
(`node .claude/forge-bin/usage-guard.cjs stop` stops it).

One more token reader, also opt-in: the Command Center's **Discord service** (`command-center/discord/`) reads the
same `~/.claude/.credentials.json` to show subscription usage, and sends the token only to `api.anthropic.com`. It is
never installed into a project and never starts on its own.

---

## 3. Verify — do not skip this, and do not claim success without it

```bash
cd "/path/to/the/users/project"
node .claude/forge-bin/forge-doctor.cjs
```

This runs the full self-test (110+ suites, several thousand assertions). It takes a few minutes.

**Expected on a correct fresh install: `⇒ ALL GREEN`.**

You may also see lines marked `(advisory, non-blocking)` — those are informational and do **not**
mean the install failed. Only `✗` lines and `⇒ FAILURES ABOVE` mean something is genuinely wrong.

Also confirm the two root files exist (the installer creates them when absent):

```bash
ls CLAUDE.md .gitignore
```

If the doctor reports failures, **report the exact failing lines to the user**. Do not paper over
it, do not re-run until it looks better, and do not claim the install works when the doctor says
otherwise.

---

## 4. Hand over to the user

Tell them, in their own language, this:

- **`/forge <task>`** — the one command. Describe a goal in plain words ("build a landing page for
  my bakery", "find why the login breaks", "automate this with n8n") and Forge classifies the task,
  picks the smallest fitting team of agents, builds it, and reports honestly what ran.
- **`/setup-forge`** — first-time onboarding; run it once inside Claude Code.
- **`CLAUDE.md`** in their project root is theirs to edit — it is the project brain every session
  reads. The installer filled in a skeleton; ask them to complete the "Project identity" and
  "How to run and test" sections, because agents read those before touching anything.

---

## 5. Things you must NOT do

- **Do not** install into a folder the user did not explicitly name.
- **Do not** edit anything in `~/.claude/` by hand — the installer's merge-safe copy is the only
  sanctioned path there.
- **Do not** put API keys, tokens or passwords into any Forge config file. Secrets belong in
  `.env` (which is gitignored); `.env.example` holds placeholders only.
- **Do not** run `npm install` anywhere for Forge itself. The only optional exception is building
  the dashboard SPA (§6).
- **Do not** claim the installation is verified unless you actually ran the doctor and read its
  output.
- **Do not** delete or "clean up" the user's existing `.claude/` directory. The installer merges;
  wiping is never required.

---

## 6. Optional: the dashboard

The Command Center is a local web UI on `http://127.0.0.1:4100` that shows runs, agents and
artifacts per project. **It is optional — Forge works fully without it.**

It ships as source and needs a one-time build, which is the *only* step in this repo that uses npm:

```bash
cd command-center/dashboard
npm install
npm run build
cd ../..
node command-center/gateway/supervisor.mjs      # then open http://127.0.0.1:4100
```

If the user does not want npm involved, skip this entirely and say so plainly. Never start the
gateway and then claim the dashboard is running without checking `GET /api/health` first.

---

## 7. Troubleshooting (the failures that actually happen)

| Symptom | Cause | Fix |
|---|---|---|
| `node: command not found` | Node not installed or not on PATH | Install Node 18+; on Windows reopen the terminal after installing |
| PowerShell: *"running scripts is disabled"* | Execution policy | Use `powershell -ExecutionPolicy Bypass -File .\install.ps1 ...` (as shown above) — do not change the machine-wide policy |
| `Permission denied` running install.sh | Not executable | `bash install.sh ...` (invoking bash directly needs no chmod) |
| Doctor: `not a project (.claude missing)` from forge-sync | You ran the *updater* on a folder that has no Forge yet | That is the installer's job — run `install.sh`/`install.ps1` instead |
| Doctor reports failures right after a fresh install | Should not happen on v2.4.0+: this exact scenario (clean folder, **empty** `~/.claude`) is what the `fresh-install` CI job measures on every commit | Report the exact `✗` lines to the user, include the doctor's `tests` line, and open an issue with them; do not guess or re-run until it looks better |
| `spawn powershell ENOENT` on macOS/Linux | `forge-killswitch` is Windows-only | Expected; it refuses honestly. Every other tool is cross-platform |
| Codex review step fails with HTTP 400 | The pinned Codex model is not available on that account | Optional feature. Forge continues and reports the review did not run |

---

## 8. Report back honestly

When you are done, tell the user:

1. **Where** you installed (the exact project path, and whether the global part was installed).
2. **What the doctor said** — quote the verdict line, not a paraphrase.
3. **What you did not do** (e.g. "I skipped the dashboard build because it needs npm").
4. **The next step**: open Claude Code in that folder and run `/setup-forge`.

If anything failed, say which part and what the error was. A half-working install that is reported
as working is worse than a failed one that is reported accurately.
