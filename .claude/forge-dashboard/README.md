# Forge dashboard folder

This folder used to hold a whole per-project dashboard (the "Forge Control Center"). That old
dashboard was **removed in Forge v2.9.0** — the files are gone, not just hidden.

## What's actually in here now

- **`log-event.cjs`** — the only tool left, and it is **not** retired. Every Forge run writes its
  events through this exact file (`.claude/forge-runs/<run_id>/events.jsonl`). Every wrapper
  script, the Command Center, and `forge-doctor.cjs` all call it at this path. Do not move or
  rename it.
- **`README.md`** — this file.
- **`start-forge-dashboard.bat`** — double-click it to open the dashboard (see below).

## Where the dashboard actually is

The live dashboard for **every** Forge project is the **Forge Command Center**, a separate app
served at **http://127.0.0.1:4100**. It lives in its own `command-center/` project (not inside
`.claude/`) and auto-discovers every Forge project on this machine, so you do not install or run
one dashboard per project.

## How to start it

- Windows: double-click `start-forge-dashboard.bat`, or run
  ```
  .claude\forge-bin\forge-dashboard.cmd
  ```
- Any shell: `/forge dashboard` inside Claude Code, or run the wrapper directly —
  `bash .claude/forge-bin/forge-dashboard.sh` or `.\.claude\forge-bin\forge-dashboard.ps1 dashboard`.
- Then open **http://127.0.0.1:4100** in your browser.

If this project has no local `command-center/` folder, the command above first checks whether the
shared Command Center is already running (`http://127.0.0.1:4100/api/health`); if not, it looks
for the installer's own central copy at `~/.claude/forge/template/command-center/` and builds +
starts THAT itself (v2.9.0, WP-P2) — nothing here needs installing per project. Only when no copy
exists anywhere does it say so honestly and name the installer (`install.ps1` / `install.sh`).

## Checking status from the terminal (no browser needed)

`.claude/forge-bin/forge-runinfo.cjs` prints this project's status without opening a browser:

```
.claude\forge-bin\forge-status.cmd        # latest run, memory files, Command Center reachability
.claude\forge-bin\forge-runs.cmd          # list this project's runs, newest first
.claude\forge-bin\forge-open-report.cmd   # print the latest run's final report
```
(Bash/PowerShell equivalents: `forge-status.sh`/`.ps1`, `forge-runs.sh`/`.ps1`,
`forge-open-report.sh`/`.ps1` in the same folder.)

## How events get written (unchanged)

```bash
node .claude/forge-dashboard/log-event.cjs <run_id> <event_type> "{\"agent\":\"frontend-boss\",\"task\":\"...\"}"
```
See `log-event.cjs`'s own `KNOWN_EVENT_TYPES` for the full accepted vocabulary. An unknown
event type is rejected (exit code 2) so a typo never lands in the run log silently.

## History

The old Control Center (`server.cjs` plus its static UI: `index.html`, `app.js`, `graph.js`,
`lenses.js`, `panels.js`, `styles.css` — a per-project HTTP server on ports 3737–3999) was
superseded by the Command Center on 2026-07-31 and its files were deleted from this folder in
v2.9.0 (2026-09-27). `forge-sync` removes them automatically from any older installation that
still has them on disk.
