# WP0 — Backup, Git baseline and rollback plan

Completed 2026-07-24. Every line below is a recorded fact, not an intention.

## What the environment actually is

| Fact | Value | How it was established |
| --- | --- | --- |
| Claude Code CLI | `%APPDATA%\Claude\claude-code\2.1.217\claude.exe` | filesystem search |
| Claude Code version | `2.1.217 (Claude Code)` | `claude --version` |
| Local session authenticated | **yes**, no API key involved | real `claude -p` call, exit 0, returned `FORGE_HEALTH_OK` |
| Session id captured | `97c12490-b1f6-47a2-96d4-ab4d05b921ee` | `--output-format json` result envelope |
| Usage telemetry available | **EXACT** — input/output/cache tokens, `contextWindow: 200000`, `costUSD`, per-model breakdown | same call |
| Node | v24.18.0 portable, `%LOCALAPPDATA%\Programs\nodejs` | `node --version` |
| Git | **2.55.0.windows.3**, MinGit portable, `%LOCALAPPDATA%\Programs\MinGit` | `git --version` |
| Documents root | `C:\Users\YOU\Documents` | `[Environment]::GetFolderPath('MyDocuments')` **and** `HKCU\...\User Shell Folders\Personal` — both agree |
| `ForgeProjects` | does not exist yet | `Test-Path` |

### CLI flags confirmed present in 2.1.217

`--print` · `--output-format` (incl. `stream-json`) · `--input-format` · `--include-partial-messages` ·
`--verbose` · `--session-id` · `--resume` · `--continue` · `--fork-session` · `--permission-mode` ·
`--allowedTools` · `--disallowedTools` · `--model` · `--effort` · `--add-dir` · `--agents` ·
`--settings` · `--strict-mcp-config` · `--replay-user-messages` · `--background`

### Confirmed ABSENT — must never be used

- **`--max-turns`** — does not exist in 2.1.217. Any adapter code referencing it is a bug.

The adapter reads the installed version and gates every flag on it. This table is the reason
the mission demanded an audit first: assuming older documentation would have shipped a
flag that does not exist.

## Backup

| Item | Location |
| --- | --- |
| Full archive | `C:\Users\YOU\Documents\ForgeWorkspace-backup.zip` (3.84 MB) |
| Archive SHA256 | `2E86A66A4104B62C204364DA53CFAF86856D4DA8C8A84823D93BA0FE48A5F238` |
| File hash manifest | `artifacts/baseline-manifest.json` — 347 files, per-file SHA256 |

The archive excludes `node_modules`, `dist`, `test-results`, `playwright-report` — all
reproducible from `package-lock.json` and the test commands.

## Git baseline

```
commit 9cdbf93  tag: baseline-prototype  branch: main
347 files tracked · clean worktree · NO REMOTE CONFIGURED
```

Nothing is published and nothing can be pushed: no remote exists.

## Rollback plan

**Undo everything after the baseline, keep the repository:**

```powershell
$env:PATH = "$env:LOCALAPPDATA\Programs\MinGit\cmd;$env:PATH"
git stash --include-untracked          # keep anything uncommitted, just in case
git reset --hard baseline-prototype
```

**Inspect what changed since the baseline before deciding:**

```powershell
git diff --stat baseline-prototype
git log --oneline baseline-prototype..HEAD
```

**Full restore from the archive** (if the repository itself is damaged) — extract the zip
over a clean folder, then `npm install`.

**Verify a restore is faithful** — recompute hashes and compare against
`artifacts/baseline-manifest.json`.

**Remove the tooling this phase installed** (nothing is registered with Windows):

- delete `%LOCALAPPDATA%\Programs\MinGit`
- delete `%LOCALAPPDATA%\Programs\nodejs`
- remove both entries from the user `Path` in `HKCU\Environment`

## Recorded test state at the baseline

| Gate | Command | Result at `baseline-prototype` |
| --- | --- | --- |
| Theme drift | `npm run theme:check` | in sync, `67db39bf9f38`, 402 declarations |
| Types | `npm run typecheck` | 0 errors |
| Lint | `npm run lint` | 0 errors, 3 `react-refresh` warnings |
| Unit | `npm run test` | 78/78 |
| Build | `npm run build` | exit 0 — 1.23 MB JS / 254 KB CSS |
| Browser | `npm run test:e2e` | 40/40 |
| Screenshots | `npm run shots` | 20 captured |

These are the numbers every later phase is measured against. A regression is any
movement away from them that is not explained and accepted.

## Routes and controls present at the baseline

13 routes: `/` · `/projects` · `/project` · `/chat` · `/mission` · `/agents` · `/tasks` ·
`/files` · `/artifacts` · `/tests` · `/activity` · `/settings` · `/theme`

The full machine-readable capability matrix is built in WP11, before the ultimate test
program — inventorying it now would only describe the prototype, not the connected system.
