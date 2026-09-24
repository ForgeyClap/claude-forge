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

Dispatcher commands: `dashboard` / `start` · `status` · `runs` · `open-report` · `health` · `assign-only` · `log-event <run_id> <type> <payload>` · `resume <run_id>` · `learn` · `config <list|get|set|unset|reset|explain|diff|parse>` · `sweep <enumerate|filter|transcripts|extract|aggregate|status>` · `promptcheck <promptFile|-|ask>` · `legacy-dashboard` (explicit only — see below).

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

## Other tools in this folder (run directly with `node`, some also reachable via `forge <cmd>` above)
| Tool | Purpose |
|---|---|
| `forge-config.cjs` | The ONE resolver/validator/writer for every Forge setting: `list`, `get`, `set`, `unset`, `reset`, `explain`, `diff`, `parse` (also reachable via `forge config <cmd>` above, `--help` on each). Files: `.claude/FORGE_CONFIG.json` (project) + `~/.claude/FORGE_CONFIG.json` (global); catalogue: `config/orchestration/FORGE_CONFIG_SCHEMA.json`. Exit 0 ok · 1 not found · 2 usage/validation (nothing written) · 3 act on this (a real change, a locked key, an ambiguous `parse`). |
| `forge-config-cli.cjs` / `forge-config-text.cjs` | Helpers of `forge-config.cjs`, not run directly: `-cli.cjs` is the argv-parsing/dispatch/`--json`/exit-code layer, `-text.cjs` holds the nl/en wording and plain-text renderers (list/explain/diff output, `--ascii` fold for old Windows code pages). |
| `forge-sweep.cjs` (+ `forge-sweep-core.cjs`, `forge-sweep-extract.cjs`, `forge-sweep-aggregate.cjs`) | Resumable, checkpointed YouTube **research** sweep: `enumerate`, `filter`, `transcripts`, `extract`, `aggregate`, `status` (also reachable via `forge sweep <stage>` above). Captions/metadata only via `yt-dlp` — never video/audio. Needs `yt-dlp` on PATH (`pip install yt-dlp`). The `-core`/`-extract`/`-aggregate` files are its own stage helpers (ledger/checkpoint plumbing, NVIDIA-model extraction, dedupe + report) — never run standalone. Output is `INTERNAL_USE_ONLY` research under `.claude/forge-research/`. |
| `forge-gate-hook.cjs` | A `PreToolUse` hook (matcher `Bash`/`PowerShell`) that turns the 3 COMMAND hard gates (`destructive-delete`, `kill-by-name`, `git-destructive`) into a real stop — exit 2 blocks the tool call and explains why (NL+EN) instead of just advising against it. Controlled by config key `gate-hook` (default ON). **Not started by any wrapper above** — it only runs when wired into `.claude/settings.json` as a hook (see `config/orchestration/HOOKS_OPT_IN.md`). |
| `forge-settings-merge.cjs` | `apply`/`check` — merges Forge's `.claude/settings.json` (every hook + `permissions.deny` rule) into an EXISTING project's own settings.json instead of leaving it for the owner to merge by hand: foreign hooks/rules/keys are kept byte-for-byte, absent -> created, present -> merged with a `.forge-bak-<ts>` backup first, malformed/unexpected shape -> refused-safe (`settings.forge-recommended.json` written instead). Called by `install.sh`/`install.ps1` and by `forge-sync.cjs`'s own `syncProjectSettings()` — see `config/orchestration/HOOKS_OPT_IN.md`. |
| `forge-promptcheck.cjs` | Prompt Master dispatch-prompt linter (also reachable via `forge promptcheck` above). Default mode lints a dispatch/work-package prompt FILE against 7 dimensions (advisory; `--strict` makes it exit 1 below a threshold). `ask "<raw request>"` subcommand instead scores the OWNER's raw request against 5 dimensions (clarity, specificity, context, completeness, structure) in NL+EN before Forge plans anything — exit 0 CLEAR/OK · 2 usage · 3 VAGUE (ask one question first). Deterministic heuristics only, no LLM/network call. |

## Notes
- `.sh` scripts expect LF endings (installed via copy, so they keep LF); `.cmd` files are pure ASCII with CRLF on purpose — a UTF-8 dash in a batch file shifts cmd's byte offsets and breaks `goto`.
- Exit codes are propagated: a failed `log-event` (bad JSON, unregistered event type) returns non-zero from every wrapper.
- Everything is project-local and isolated — these never read or start another project's dashboard.
