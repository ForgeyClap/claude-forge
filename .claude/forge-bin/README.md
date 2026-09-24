# Forge command pack (project-local)

Cross-platform terminal wrappers for **this project's** Forge. They only ever run scripts that live inside this project — **no global install, no PATH changes, no admin rights, nothing outside this folder.** They require Node.js (the wrappers auto-detect it; see below).

## Windows quick start (recommended)
```
.claude\forge-bin\forge-dashboard.cmd
```
On Windows, prefer the **`.cmd`** wrappers — PowerShell often blocks `.ps1` by execution policy.

| Action | CMD (recommended) | PowerShell | Bash/Git Bash |
|---|---|---|---|
| Start dashboard | `.claude\forge-bin\forge-dashboard.cmd` | `.\.claude\forge-bin\forge-dashboard.ps1` | `bash .claude/forge-bin/forge-dashboard.sh` |
| Status | `.claude\forge-bin\forge-status.cmd` | `.\.claude\forge-bin\forge-status.ps1` | `bash .claude/forge-bin/forge-status.sh` |
| Recent runs | `.claude\forge-bin\forge-runs.cmd` | `.\.claude\forge-bin\forge-runs.ps1` | `bash .claude/forge-bin/forge-runs.sh` |
| Latest report | `.claude\forge-bin\forge-open-report.cmd` | `.\.claude\forge-bin\forge-open-report.ps1` | `bash .claude/forge-bin/forge-open-report.sh` |
| Log an event | `.claude\forge-bin\forge-log-event.cmd <run_id> <type> payload.json` — the `.cmd` form accepts ONLY a `.json` file path (cmd never parses it); inline JSON is refused (exit 2) — use `.ps1`/`.sh` for inline JSON | `.\.claude\forge-bin\forge-log-event.ps1 <run_id> <type> '<json>'` | `bash .claude/forge-bin/forge-log-event.sh <run_id> <type> '<json>'` |
| Dispatcher | `.claude\forge-bin\forge.cmd <cmd>` | `.\.claude\forge-bin\forge.ps1 <cmd>` | `bash .claude/forge-bin/forge.sh <cmd>` |

Dispatcher commands: `dashboard` / `start` · `status` · `runs` · `open-report` · `health` · `assign-only` · `log-event <run_id> <type> <payload>` · `resume <run_id>` · `learn` · `legacy-dashboard` (explicit only — see below).

Forge defines **no npm scripts**: the wrappers above are the whole terminal interface.

## Which dashboard starts
`dashboard` / `start` looks for the **Forge Command Center** (`command-center/gateway/bin.mjs`) in this project and starts it on `http://127.0.0.1:4100` (health check `GET /api/health`). If this project does not host the Command Center, the wrapper says so in one line — it never invents a dashboard. The old per-project **Control Center** (`.claude/forge-dashboard/server.cjs`, ports 3737–3999) is **retired**: it never starts automatically and only runs on an explicit `legacy-dashboard`. Its `log-event.cjs` stays in service as the per-project run-event writer, and `status` / `runs` / `open-report` / `health` use the same script's read-only modes.

## Node detection (built into every wrapper)
The dispatcher (`forge.cmd` / `forge.ps1` / `forge.sh`, which the other wrappers delegate to) finds Node in this order:
1. `node` on PATH.
2. else `C:\Program Files\nodejs\node.exe` (auto-used if present).
3. else it prints: **"Node.js LTS is required for Forge. Install Node.js LTS, close and reopen your terminal, then run node -v."** and exits 1 (never silent).

### "node is not recognized" right after installing Node (e.g. via winget)
A terminal opened *before* installing Node won't see it yet. Fix:
1. **Close the terminal completely.** 2. Open a new terminal. 3. Run `node -v`.
4. If it still fails, Forge automatically tries `C:\Program Files\nodejs\node.exe`.
If Node isn't installed at all: install **Node.js LTS**, then reopen the terminal.

## PowerShell execution policy
If a `.ps1` is blocked ("running scripts is disabled on this system"), use the **`.cmd`** wrapper instead, or:
```
powershell -ExecutionPolicy Bypass -File .claude\forge-bin\forge-dashboard.ps1
```
Do **not** change the execution policy globally; do **not** run as admin. The wrappers never modify PATH or execution policy.

## Direct Node fallbacks (no wrappers)
```
node command-center/gateway/supervisor.mjs        # Command Center with auto-restart (when this project hosts it)
node .claude/forge-dashboard/log-event.cjs <run_id> <type> --file payload.json
```

## Notes
- `.sh` scripts expect LF endings (installed via copy, so they keep LF); `.cmd` files are pure ASCII with CRLF on purpose — a UTF-8 dash in a batch file shifts cmd's byte offsets and breaks `goto`.
- Exit codes are propagated: a failed `log-event` (bad JSON, unregistered event type) returns non-zero from every wrapper.
- Everything is project-local and isolated — these never read or start another project's dashboard.
