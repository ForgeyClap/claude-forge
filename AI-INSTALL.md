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

It has **no runtime dependencies** — plain Node.js `.cjs` files; the install itself downloads nothing beyond this
repository and installs no package. Be exact about network use afterwards, because the user will ask: the **usage
guard** (on by default) reads the Claude login token from `~/.claude/.credentials.json` and asks `api.anthropic.com`
for the usage figures every couple of minutes — it says so the moment it really starts, and `/forge config set
usage-guard off` stops it; the optional **Paperclip** runtime runs `npx paperclipai` (which downloads a package) only
when the owner turns `paperclip` on; the vendored **setup-pre-commit** skill runs npm only when the user asks for it.
Nothing else phones home.

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

### 2a. Windows or macOS/Linux — decide first, then use ONLY that column

Decide the operating system before you type anything, say which one you detected, and stay in that
column. Do not mix: `install.sh` is for bash (macOS/Linux, or Git Bash), `install.ps1` is for PowerShell
(Windows). The same Forge is installed either way — only the shell differs.

| Step | **Windows — PowerShell** | **macOS / Linux — bash** |
|---|---|---|
| How to detect | `$env:OS` prints `Windows_NT`; the prompt is `PS C:\...>` | `uname -s` prints `Darwin` or `Linux` |
| Prerequisite | `node --version` → v18 or newer. "node is not recognized" right after installing Node = reopen the terminal | `node --version` → v18 or newer |
| Where the global core lands | `%USERPROFILE%\.claude` (for example `C:\Users\<you>\.claude`) | `~/.claude` |
| Clone-and-run (recommended for an AI) | `git clone https://github.com/ForgeyClap/claude-forge.git`<br>`cd claude-forge`<br>`powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProjectDir "C:\absolute\path\to\project" -Yes` | `git clone https://github.com/ForgeyClap/claude-forge.git`<br>`cd claude-forge`<br>`bash install.sh --project "/absolute/path/to/project" --yes` |
| One-liner (run it **inside the project folder**) | `powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/ForgeyClap/claude-forge/main/install.ps1 \| iex"` | `curl -fsSL https://raw.githubusercontent.com/ForgeyClap/claude-forge/main/install.sh \| bash` |
| Unattended (no confirmation prompt) | `-Yes`, or `$env:FORGE_YES = '1'` before the command | `--yes`, or `FORGE_YES=1` in front of the command |
| Preview without writing | `-DryRun` | `--dry-run` |
| Only the global core / only the project | `-GlobalOnly` / `-ProjectOnly` | `--global-only` / `--project-only` |
| The `-ExecutionPolicy Bypass` prefix | Required for `irm \| iex` and for `.ps1` files when scripts are blocked; it applies to this one command only, never change the policy globally | n/a |
| Verify (identical on both) | `node .claude\forge-bin\forge-doctor.cjs` → must end with `⇒ ALL GREEN` | `node .claude/forge-bin/forge-doctor.cjs` → must end with `⇒ ALL GREEN` |
| Terminal wrappers after install | `.claude\forge-bin\forge-dashboard.cmd`, `forge-status.cmd`, `forge-runs.cmd` … (`.cmd` first; the `.ps1` twins may be blocked by execution policy) | `bash .claude/forge-bin/forge-dashboard.sh`, `forge-status.sh`, `forge-runs.sh` … |
| Log an event from a terminal | `.claude\forge-bin\forge-log-event.cmd <run_id> <type> payload.json` — the `.cmd` accepts **only a `.json` file**; inline JSON goes through `.\.claude\forge-bin\forge-log-event.ps1 <run_id> <type> '<json>'` | `bash .claude/forge-bin/forge-log-event.sh <run_id> <type> '<json>'` |
| What the installer refuses | a target that is your home directory (`C:\Users\<you>`) — `cd` into the project first | a target that is your home directory (`/home/<you>`, `/Users/<you>`) — `cd` into the project first |
| Never do this | run `install.sh` in `cmd.exe` or PowerShell; paste bash `--flags` into PowerShell | run `install.ps1`; paste PowerShell `-Flags` into bash |

Git Bash on Windows: `install.sh` works there too (that is what the Windows CI job uses for its bash steps), but
the documented, supported Windows path is `install.ps1`. Pick one and finish with it; do not run both.

**What the installer guarantees** (this is real behaviour, not a promise):
- It copies **file by file** and never deletes your `.claude/` tree.
- A file that already exists and *differs* is **backed up with a timestamp** before being replaced — except an existing **project** `.claude/settings.json`, which is never replaced: Forge's hooks and deny rules are **merged into it** (your own hooks, allow rules and other keys stay where they are; BOM, line endings and indentation are preserved; a uniquely named backup is written first with exclusive-create, never over an earlier backup; running again changes nothing). The merge refuses and leaves the file alone — writing Forge's version next to it as `settings.forge-recommended.json` and saying so in one line — when the file is not valid JSON, when it holds content that cannot be reserialized losslessly (duplicate keys, numbers beyond what JSON round-trips), when `settings.json` is a directory or a link, or when the file changed under the tool between read and write.
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

The project payload ships a `.claude/settings.json` with **hooks on four Claude Code events** (five entries,
four small Node scripts), all local, none phoning home, plus **deny rules** that keep secret files out of
Claude's reach:

1. **PreCompact (manual)** — snapshots the mission state before a manual context compaction
2. **PreCompact (auto)** — snapshots the mission state before an automatic compaction
3. **SessionStart** (after compaction) — re-injects the mission, so a long session does not lose what it was doing
4. **PostToolUse** (matcher: `Write|Edit|MultiEdit|NotebookEdit|Bash`) — appends the tool name and target path of each *changing* tool call to `.claude/forge-runs/_toollog/<session>.jsonl` (gitignored)
5. **PreToolUse — the gate hook** (matcher: `Bash|PowerShell`, `forge-gate-hook.cjs`, new in 2.7.0) — before every
   shell command it asks Forge's hard-gate classifier whether the command is a recursive delete (with or without
   the force flag), a kill of processes by name (also through `pgrep`/`pidof` substitutions and `xargs`
   pipelines), or a git command that throws away uncommitted work (`git reset --hard`, `git clean -f`,
   `git checkout -f` / `.` / `-- <path>`, `git restore <path>`, `git switch -f`, `git stash drop|clear`). If so it
   exits 2: Claude Code blocks the call and shows a plain Dutch/English reason, and the assistant must ask the
   user. A delete whose every target is provably inside a scratch area (`_scratch/`, `node_modules/`, `dist/`, the
   system temp folder for targets outside the project, …) passes. Quoted data given to a plain writer or search tool
   — a `cat`/`tee`/`echo`/`printf` heredoc body, an `echo` literal, a log-event payload, a `grep` pattern — is
   treated as data, not as a command; any other heredoc (for example a commit message fed to `git commit -F -`) is
   still scanned line by line, so a line that itself starts with a dangerous command is stopped (a safe false block,
   never a silent pass). When the hook cannot judge a call (its own error, an oversized payload, an unknown hook
   event name) it exits 1: visible, not blocking, never a silent pass. It is the only hook that blocks instead of
   advising; it is ON by default. It is built so the assistant cannot switch it off on its own
   (`/forge config set gate-hook off` is for the user): the assistant's own attempt to switch it off is blocked in
   every invocation form the hook's argv parser recognises (a quoted or concatenated verb, any path to
   `forge-config.cjs`/`forge-config-cli.cjs`, `node` with flags or by absolute path, `env`/`sudo`/`time`/`nohup`
   wrappers, flags in any order), and a `forge-config` mutation that names `gate-hook` but cannot be read
   unambiguously is refused rather than allowed; a one-off `--once "<quoted approval>"` must carry the user's words,
   is consumed by exactly one command (a second identical command is blocked again), cannot be armed while another
   one-off is pending, blocks a plain "off" while it is pending (a one-off can never become a permanent off — the
   config writer refuses that transition too), expires after at most 10 minutes, ignores the global settings file (no
   hidden global off), and while the gate is off every call it would have stopped still prints a visible notice.
   Honest limits: the hook cannot verify who typed the quoted words — the user reads the approval line before the
   command runs — and it is a classifier, not a proof: a command assembled in a variable and executed later is
   caught only through the `opaque-exec` shapes. That fourth gate stops commands whose real content the hook cannot
   read (`eval`, `iex`/`Invoke-Expression` as the command of a statement — also inside `{ }`, `( )`, `if`/`while`/
   `for`/`case` bodies and PowerShell blocks — `sh -c`/`bash -c`/`pwsh -c` on a variable or substitution, also via
   `/bin/bash` or `/usr/bin/env bash`, a pipe straight into a shell such as `curl … | bash`, an encoded PowerShell
   command (`-EncodedCommand`/`-e`/`-ec`/`-enc`), `certutil -decode … & …`); a fully literal `sh -c "echo hi"`,
   `| node`/`| python`, a dangerous command inside a script the hook is asked to run, and an encoded payload
   reaching PowerShell by a route other than that flag are named, deliberate gaps (full list: `hard-gates.json` →
   `_not_caught`; beginner version: `docs/SETTINGS.md` → "What the gate hook stops, and what it cannot see").

**Deny rules** (`permissions.deny`, 28 rules): `Read(./.env)`, `Read(./.env.local)`, `Read(./.env.*.local)`,
`Read(./.env.development)`, `Read(./.env.production)`, `Read(./.env.staging)`, `Read(./.env.test)`,
`Read(./.env.forge-setup)`, `Read(./secrets/**)`, the same names nested anywhere (`Read(./**/.env)`,
`Read(./**/.env.local)`, `Read(./**/.env.*.local)`, `Read(./**/.env.development)`, `Read(./**/.env.production)`,
`Read(./**/.env.staging)`, `Read(./**/.env.test)`, `Read(./**/.env.forge-setup)`, `Read(./**/.env.prod)`,
`Read(./**/.env.bak)`, `Read(./**/.env.backup)`, `Read(./**/secrets/**)`), private keys (`Read(./**/*.pem)`, `Read(./**/*.key)`,
`Read(./**/id_rsa*)`, `Read(./**/id_ed25519*)`) and the user's own credential files (`Read(~/.claude/.credentials.json)`,
`Read(~/.claude/nvidia.env)`, `Read(~/.ssh/**)`). `.env.example` stays readable on purpose (Forge records new
variable names in it; a test asserts it). Not covered: reading a file through the shell (`cat .env`).

Each hook runs a small, fast Node command that fires locally only — nothing phones home. To opt out of any hook,
delete its entry from `.claude/settings.json` — nothing else depends on them. **If the project already had its own
`.claude/settings.json`**, the installer (and every later `forge-sync install` upgrade) merges the five hooks and the
deny rules into it with `forge-settings-merge.cjs`: existing entries are kept in place, only missing Forge entries are
added (into an existing matcher entry when one already carries part of them, never as a duplicate), a Forge hook whose
timeout was still written in milliseconds is corrected to seconds, BOM/line endings/indentation are preserved, and a
uniquely named backup is written first. Running it again is a no-op. The file is left alone (Forge's version written
next to it as `settings.forge-recommended.json`) when it is not valid JSON, cannot be reserialized losslessly, is a
directory or a link, or changed under the tool. Tell the user which of the three happened
(created · merged · left alone) and, after a merge, name the backup path.

**Everything is on by default, and `/forge config` shows and changes it.** `/forge config list` (in a terminal:
`node .claude/forge-bin/forge-config.cjs list --all`) lists all 36 settings with value, source and a plain
explanation. Choices are saved in `.claude/FORGE_CONFIG.json` (this project) and `~/.claude/FORGE_CONFIG.json`
(machine-wide); a fresh install has neither file, so the built-in defaults apply. Mention this command in the
handover — the user never has to edit a settings file.

The **usage guard** (`usage-guard.cjs`) is **on by default since 2.7.0** (in 2.4.0 it was opt-in; the maintainer
reversed that so beginners are protected without knowing it exists). It is a machine-global background watcher
that reads the Claude login token **locally** from `~/.claude/.credentials.json` and sends it **only** to
`api.anthropic.com`, to read the account's usage, so a run can pause at **98 %** (setting `usage-guard.pause-at`)
before the account's limit. `/forge` starts it at the beginning of a build when the setting `usage-guard` is on.
The tool prints that disclosure itself — in Dutch and English, followed by the off command — exactly when a new
watcher really starts, not when one is already running. No consent file is created or read any more. Still never
started by: `/forge dashboard`, the Paperclip runtime (`forge-paperclip.cjs up` needs `--with-usage-guard`), or
the test suite the doctor runs (its test isolates a temporary home). **Tell the user in one line** that it exists,
what it reads and where it sends it, and that `/forge config set usage-guard off` switches it off (the tool then
refuses to start); `node .claude/forge-bin/usage-guard.cjs stop` stops a watcher that is already running.

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
- **`/forge config`** — every Forge setting in one list (value, where it comes from, what it does); change any of
  them with one command, or by just saying it in chat ("pause at 95 percent", "codex review off"). Everything is on
  by default. Details: [docs/SETTINGS.md](docs/SETTINGS.md).
- **The beginner promise** — say it in their language:
  - EN: "Forge does it for you. It runs every command, script, install and build itself and never asks you to run a file or code. It does not ask 'shall I continue?' between phases. It stops for the hard gates — deploying, pushing, spending money, DNS, production, credentials, sending anything out, killing processes by name, destructive deletes, writing outside your project — and for a real usage-limit pause. Be precise about what 'stops' means: four of those gates (destructive deletes, killing processes by name, git commands that throw work away, commands that hide what they run) are enforced by a real hook that blocks the shell command before it runs — a classifier, not a proof: what it does not recognise it does not stop; the others are rules the assistant follows and a text classifier checks, not a technical stop, so keep an eye on anything that deploys, pushes or spends. Everything is on by default; `/forge config` shows and changes any setting in one command, or just say it in chat."
  - NL: "Forge doet het voor je. Het draait elk commando, script, installatie en build zelf en vraagt je nooit om zelf een bestand of code te draaien. Het vraagt niet 'moet ik verder?' tussen fases. Het stopt voor de harde poorten — deployen, pushen, geld uitgeven, DNS, productie, credentials, iets versturen, processen op naam killen, destructief verwijderen, buiten je project schrijven — en voor een echte gebruikslimiet-pauze. Wees precies over wat 'stopt' betekent: vier van die poorten (destructief verwijderen, processen op naam killen, git-commando's die werk weggooien, commando's die verbergen wat ze uitvoeren) worden afgedwongen door een echte hook die het shellcommando blokkeert vóór het draait — een classifier, geen sluitend bewijs: wat hij niet herkent, houdt hij niet tegen; de overige poorten zijn regels die de assistent volgt en die een tekstclassifier controleert, geen technische stop — hou dus alles wat deployt, pusht of geld uitgeeft in het oog. Alles staat standaard aan; `/forge config` toont en wijzigt elke instelling met één commando, of zeg het gewoon in de chat."
  (This is the same qualified wording as the README's beginner promise — keep the two identical when either changes.)
- **New to Claude Code?** Point them to [docs/CLAUDE-CODE-BASICS.md](docs/CLAUDE-CODE-BASICS.md) (English and Dutch).
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
