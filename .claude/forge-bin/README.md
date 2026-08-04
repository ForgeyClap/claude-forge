# Forge command pack (project-local)

Cross-platform terminal wrappers for **this project's** Forge. They only ever run this project's `.claude/forge-dashboard/` scripts — **no global install, no PATH changes, no admin rights, nothing outside this folder.** They require Node.js (the wrappers auto-detect it; see below).

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
| Log an event | `.claude\forge-bin\forge-log-event.cmd <run_id> <type> "<json>"` | `.\.claude\forge-bin\forge-log-event.ps1 <run_id> <type> '<json>'` | `bash .claude/forge-bin/forge-log-event.sh <run_id> <type> '<json>'` |
| Dispatcher | `.claude\forge-bin\forge.cmd <cmd>` | `.\.claude\forge-bin\forge.ps1 <cmd>` | `bash .claude/forge-bin/forge.sh <cmd>` |

Dispatcher commands: `dashboard` · `start` · `status` · `runs` · `open-report` · `health` · `assign-only` · `log-event`.
If `package.json` exists: `npm run forge:dashboard | forge:status | forge:runs | forge:open-report`.

## Node detection (built into every wrapper)
The dispatcher (`forge.cmd` / `forge.ps1` / `forge.sh`, which the other wrappers delegate to) finds Node in this order:
1. `node` on PATH.
2. else `C:\Program Files\nodejs\node.exe` (auto-used if present).
3. else it prints: **"Node.js LTS is required for Forge Control Center. Install Node.js LTS, close and reopen your terminal, then run node -v."** and exits 1 (never silent).

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
node .claude/forge-dashboard/server.cjs
"C:\Program Files\nodejs\node.exe" .claude\forge-dashboard\server.cjs
```

## Notes
- The dashboard port is this project's own (`.claude/forge-dashboard/PORT`, range 3737–3999); it falls back to the next free port if busy.
- `.sh` scripts expect LF endings (installed via copy, so they keep LF).
- Everything is project-local and isolated — these never read or start another project's dashboard.
