# Forge Control Center — RETIRED (kept for `log-event.cjs`)

> **Read this first (2026-07-31/08-02).** The Control Center described below is **no longer the dashboard**. The
> **Forge Command Center** on `http://127.0.0.1:4100` is — one dashboard that auto-discovers every project.
> This server is **never started automatically**; it still runs on an explicit `legacy dashboard` request.
> **`log-event.cjs` in this directory is NOT retired** — it remains the per-project run-event writer that the
> Command Center reads. Everything below documents the legacy UI as it still exists on disk.

## Legacy: Forge Control Center (project-local dashboard)

A lightweight, local-only **Agent Swarm command center** that shows what Forge is **actually** doing in *this* project as a live node graph. A **3-column workbench**: left **AGENT GROUPS** sidebar (Control · Context · Planning · Domain · Execution · Review · Memory·Report, each agent with a status dot + 6-state legend) · center **node-graph canvas** (pan by dragging left↔right + vertical, wheel zoom, minimap) · right **SELECTED AGENT** work-package inspector (9 tabs) + **LIVE ACTIVITY** feed. Along the bottom: a dock (**Live Log / Files Changed / Memory Status / Final Report / Preview**) + **Summary Metrics** (build progress · critical path · next step · est. completion). Top stat strip shows Events / Agents / Files / Port + Copy URL.

A **lens switcher** flips between 11 node-graph views of the same live run (default **TASK GRAPH**):
- **FLOW (AGENT EXECUTION)** *(default — Lead-Agent studio layout)* — a separated **Preflight / Context** band on top (forge-router · memory-loader · project-scan · ecc-mode · forge-core, shown as **SETUP / CONTEXT**, never mixed into the worker row) then clear **left → right** stage columns: **USER MISSION → LEAD AGENT → MASTER PLAN → SUBAGENT EXECUTION LAYER → OUTPUT / ARTIFACT LAYER → LEAD REVIEW + REWORK → FIX LOOP / RETEST → MERGE & SYNTHESIS → CODEX REVIEW → FINAL OUTPUT** (subagents + outputs stack vertically within their column, each output level with its subagent), with the rework→subagent and codex/fix **loop** edges. Node kinds: LEAD · MASTER PLAN · SUBAGENT (CUSTOM SUBAGENT = ✦) · OUTPUT ARTIFACT · LEAD REVIEW · REWORK TASK · FIX LOOP · QA/TEST · CODEX REVIEW · FINAL OUTPUT · PREFLIGHT/CONTEXT · DERIVED. Honest badges: **ECC ✓** (ECC REAL INVOKED) · **ECC SKILL** · **NATIVE** (fallback) · **CODEX ✓/✕/—** · **CUSTOM** · **SETUP/CONTEXT** · **DERIVED**.
- **TASK GRAPH** *(default — Mission Control)* — the big everything-graph: every agent AND each task it performed is its own connected node (agent → task → task → …), so the whole run reads as one large live node-graph. Real data only (tasks come from the run's logged events).
- **NOTE** (visible reasoning chains) · **WORKFLOW** (phases) · **EXEC** (agents→file/command/skill) · **DAG** (echelon dependency graph) · **AGENTS** (orchestration; every agent a distinct role) · **PIPELINE** (conveyor) · **TEST** (checks) · **REVIEW** (codex → findings → fix → retest → quality gate) · **ARTIFACTS** (outputs per agent).

**Mission Control dock panels** (bottom dock tabs, read-only over the real run): **Agent Board** (12 permanent Bosses as live cards; NOT USED when a Boss wasn't dispatched) · **Tickets** (kanban of every task/rework by status) · **Gates** (tests/build/screenshot/security/codex/lead pass·fail·pending) · **Proof/Trust** (verified-vs-claimed ratio from the `_forge_verify` honesty stamps) · **Cost** (per-agent tokens/cost + budget when logged; honest empty state otherwise).

**6 status states** (sketch legend): **running = orange** (pulse) · **completed = green** · **waiting = cyan** · **previewing = blue** (work package logged, not executed yet) · **failed = red** · **internal only = gray** (conceptual role). **Edge styles:** solid green = critical path · dashed = handoff · dotted cyan = waiting · animated orange = active execution · blue loop = codex/fix loop.

**ECC status (Forge is ECC-based).** The top-bar **ECC badge** shows ECC mode — `ECC NORMAL` (green, default), `ECC FULL TEST` (amber, opt-in), `ECC BLOCKED` (red), or `ECC OFF` — read from `.claude/FORGE_ECC_MODE.json` via `/api/state`. **Summary Metrics** shows ECC Mode, ECC Agents (selected · invoked · skills), Fallback, **Subagents** (real · custom), **Rework Loop** (created · fixed), **Session**, **CLAUDE.md**, **Custom Skills** (+ registry status), **Codex** (the exact v7.1 state), and **Browser Proof**. Forge maintains four project things: `CLAUDE.md` (project brain), `.claude/skills/*/SKILL.md` (project capabilities), Forge memory (history/state), and the dashboard (live visibility).

**v7.1 hardening.** Large swarms (≥4 subagents) insert an **ARTIFACT COLLECTOR** column that bundles many output→Lead-Review edges into one (no spaghetti); subagent nodes use readable **category labels** (PLAN/DESIGN/MOBILE/FRONTEND/OPTIMIZE/ACCESSIBILITY/QA/REVIEW/CODEX/REPORT/CUSTOM/…); new edge types **artifact flow** + **blocked**. The **CODEX** node + metric show the granular Codex state (REAL INVOKED / BLOCKED: TRUST·TTY / BLOCKED: NO GIT / BLOCKED: NO OUTPUT / NOT AVAILABLE / NOT INVOKED / FALLBACK USED) — never claims proof without real output. The clicked-node **Evidence** drilldown shows runtime · skill/source · rework completed · test/retest · handoff · final status + event-backed files/activity. The skill registry (`.claude/FORGE_SKILL_REGISTRY.md`) appears in **Memory Status**. Each agent's `runtime` (`ecc-agent`/`ecc-skill`/`native`/`codex`/`internal`) is derived from real events, so the dashboard never presents native work as ECC.

**Forge Session Mode.** A top-bar **session badge** (`FORGE SESSION` cyan / `FORGE PAUSED` amber / hidden when off) reflects `.claude/FORGE_SESSION_STATE.json` via `/api/state`. When the user runs `/forge` or says `gebruik Forge` / `use Forge` / `start Forge`, Forge enters project-local Session Mode so follow-up prompts in this project auto-use Forge (dashboard/memory/ledger keep updating) without repeating the trigger; `stop Forge` / `pause Forge` / `normale Claude mode` pause it. Session Mode grants no extra permission (project isolation ON, ECC Normal ON, ECC Full Test OFF, no credential/live-workflow/production/global/external writes without approval).

**Live vs Replay.** A bottom **replay bar** (`▶`/`⏸` · `1x`/`2x`/`5x` · `⟲` reset · `⤓ Live`) plays any run back from the beginning, animating nodes WAITING→RUNNING→COMPLETED in event order. Live runs show **"Live run"**; finished runs show **"Completed run — Replay available"** (completed nodes keep their real status — no faked "running"). `?shot=1` snapshots hide the replay bar.

Zero dependencies, no database, no cloud, no login. Reads only this project's `.claude/forge-runs/` and `.claude/FORGE_*.md`. **Each project runs its own dashboard on its own port — never a global/shared dashboard.**

Lenses deep-link via `?lens=<id>` (`taskgraph|flow|note|workflow|execution|dag|agents|pipeline|test|review|artifacts`); keys **1–8** switch the first eight, `[`/`]` cycle all, **f** fits, **+/−** zoom. `?sel=<agent>&tab=<tab>` pre-selects an agent; `?dock=<id>` opens a dock panel (`board|tickets|gates|trust|cost|log|files|memory|report|preview`); `?run=<run_id>` pins a specific historical run; `?shot=1` renders a static snapshot (no live connection) for headless screenshots.

## Start it
**Windows (recommended):**
```
.claude\forge-bin\forge-dashboard.cmd
```
Or directly:
```bash
node .claude/forge-dashboard/server.cjs
```
or double-click `start-forge-dashboard.bat`, or `/forge dashboard`. The `.cmd` wrapper auto-detects Node (PATH → `C:\Program Files\nodejs\node.exe` → clear "install Node.js LTS" message). If PowerShell blocks `.ps1`, use the `.cmd`. If `node` was just installed and "not recognized", close and reopen the terminal.

## Per-project port (3737–3999)
- The port is **deterministic per project** (hash of the project path), stored in `.claude/forge-dashboard/PORT`.
- The server tries the stored/preferred port first; if it's busy, it walks to the next free port in range and **updates `PORT`**.
- So two different Forge projects get **different** stable ports and can run at the same time without clashing.
- The actual URL is printed on start and saved in `DASHBOARD_STATE.json`.

## State files (git-ignored, runtime-only)
- `PORT` — the port to use (preferred → actual).
- `DASHBOARD_STATE.json` — `{project_name, project_folder, preferred_port, last_actual_port, last_url, last_started_at, status, latest_run_id}`.

Assign port + write state without starting the server:
```bash
node .claude/forge-dashboard/server.cjs --assign-only
```

## Live updates (forge-terminal-v4)
The dashboard updates **live**: the browser subscribes to a Server-Sent Events stream and new `events.jsonl` lines are pushed in real time — nodes appear/advance, edges redraw, the progress rail fills, and the LIVE LOG streams. If SSE is unavailable, it falls back to efficient polling (**250ms**, or **100ms** fast mode — never 1ms; that would waste CPU and can freeze the browser). A LIVE badge shows connected / reconnecting / fallback polling. **No fake progress** — nodes and log reflect only real logged events; empty states show "waiting for events".

Settings live in `DASHBOARD_STATE.json` → `settings`: `refresh_mode` (`sse`|`polling`), `polling_interval_ms` (250), `fast_mode` (false), `auto_scroll_logs` (true), `compact_mode` (false), `layout_version` (`forge-terminal-v4`).

## Endpoints
- `GET /` `/app.js` `/styles.css` — the UI
- `GET /api/events/stream` — **live SSE** stream of the latest run's events (malformed lines skipped + surfaced as a warning, never fatal)
- `GET /api/health` → strict-isolation block: `{ ok, project_name, project_root, project_id, dashboard_port, server_pid, cwd, script_dir, port_file_path, dashboard_state_path, runs_path, memory_path, session_state_path, latest_run_id, latest_run_project_root, isolation_status, state_reset, is_template, sse_clients }`. `isolation_status` ∈ OK / PROJECT_ROOT_MISMATCH / STATE_PROJECT_MISMATCH / RUN_PROJECT_MISMATCH. Quick check — PowerShell: `Invoke-RestMethod http://localhost:<port>/api/health | ConvertTo-Json -Depth 10`. Stop a server safely by its `server_pid` (`Stop-Process -Id <pid> -Force`) or by listening port (`Get-NetTCPConnection -LocalPort <port> -State Listen`). The server **refuses to run from the global template** and **resets a `DASHBOARD_STATE.json` copied from another project** (backed up to `.mismatch.bak`).
- `GET /api/state` → project + latest run (run.json + parsed events) + memory status + settings
- `GET /api/runs` → list of project-local runs
- `GET /api/run/<id>` (or `/api/run?id=<id>`) → one run's metadata + events + report

## What it shows (node-graph, not report-heavy)
- **Top bar** — run state (`● BUILDING / COMPLETE / FAILED / IDLE`) + last-activity, a `build <id>` derived from the run_id, a centered project/request **title pill**, a LIVE/POLL badge, and a glowing cyan **COMPLETE** badge when the run finishes.
- **Node graph** (center, scrollable) — each agent becomes a **plan node** (left spine card: green uppercase category header + glyph, bold title, `done/total` sub-step count, status). Its sub-events become numbered **task nodes** (right grid: `01/02/03` + title + status). Edges are drawn live: a green **spine** down the plan nodes, **green** branches from done nodes, **red** branches from the running/failed (live) node, dim for pending. Nodes derived from un-tagged events are marked **derived**. A `<state> — N blocks` flag sits at the bottom-left.
- **SELECTED NODE** (bottom-left) — click any plan node or task node → full real detail (role, attribution, why-selected, sub-steps, files read/changed, latest reasoning summary, next action, working notes, outputs, evidence — visible reasoning only, never hidden chain-of-thought). No selection → "Select a node to inspect it."
- **Progress rail** (center divider) — a tall glowing green vertical bar filling to the run's real % (done nodes / total nodes; 100% on completion).
- **LIVE LOG** (bottom-right) — green monospace, timestamped event stream, newest at bottom, auto-scroll, with the latest event time top-right and a malformed-skipped warning when relevant.

## Data sources (read-only, never fabricated)
`.claude/forge-runs/<run_id>/{run.json, events.jsonl, final-report.md}` + `.claude/FORGE_*.md`. If an agent wasn't really invoked it shows `not used` / `internal role only`; if no run exists it says so; if no preview server runs it shows no preview.

## How events get written
```bash
node .claude/forge-dashboard/log-event.cjs <run_id> <event_type> "{\"agent\":\"frontend\",\"task\":\"...\"}"
```
Event types: run_started · project_scanned · profile_loaded · memory_loaded · memory_updated · decision_logged · agent_selected · agent_started · agent_progress · agent_completed · agent_failed · skill_loaded · command_run · file_read · file_changed · check_started · check_passed · check_failed · report_generated · run_completed · **agent_note · agent_output · agent_decision_summary · agent_next_action · agent_evidence_added** (visible-reasoning events the cockpit shows on cards + inspector). Common fields: agent, role, status, task, note, output, decision_summary, next_action, evidence, files_read[], files_changed[]. Never hidden chain-of-thought; log only real activity.

The server only reads `forge-runs`/memory; it writes only its own `PORT`/`DASHBOARD_STATE.json`. Stop with Ctrl+C. **Isolation:** it never reads or touches any other project.
