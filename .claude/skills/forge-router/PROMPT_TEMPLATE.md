# High-End Forge Prompt Template

Paste this and fill the brackets. Forge's Lead Agent will analyze + improve it into a Mission Packet, decompose it into executable subagent work packages, run the swarm, merge, Codex-review + fix-loop, and deliver an honest report — all visible live in the Command Center dashboard (http://127.0.0.1:4100, run/agent/mission views).

```
gebruik Forge systeem

MISSION:
[What should Forge achieve?]

MODE:
[Audit / Improve / Build / Fix / Refactor]

QUALITY TARGET:
[Client-ready / production-ready / demo-ready / high-end]

PROJECT RULES:
- Work only in this active project folder.
- Preserve existing working behavior.
- Do not touch unrelated projects.
- Do not touch credentials, live workflows, production logic, or unrelated files unless approved.
- Use project memory before planning.
- Update project memory after completion.

AGENT SWARM EXECUTION:
Lead Agent must:
1. analyze and improve this prompt into a Mission Packet
2. split the work into real executable subagent work packages
3. assign useful agents
4. make subagents execute their own work
5. collect outputs/artifacts
6. merge and synthesize
7. run Codex/review loop if useful
8. assign fixes and retest
9. update dashboard, memory, ledger and final report

Each subagent must have:
- role
- mission
- inputs
- allowed actions
- output artifact
- evidence
- handoff target
- success criteria

SUBAGENT LIVE LOGGING (required):
Every subagent must stream its own progress to the dashboard while working —
log agent_progress after each meaningful step, file_changed with real paths,
at least one agent_note (visible reasoning), and a subagent_output_created
summary before finishing (via node .claude/forge-dashboard/log-event.cjs).
The dashboard must show WHAT each subagent is doing live, not only its final .md.
If a subagent cannot log, the Lead backfills truthful events from its result.

DASHBOARD:
Show: Lead Agent · subagents by role · work packages · handoffs · artifacts · Codex review loop · fixes · retest status · final output.

DEFINITION OF DONE:
- [Exact done item 1]
- [Exact done item 2]
- [Exact done item 3]

FINAL REPORT:
Include: mission packet summary · prompt improvements made · agents used · what each agent did · artifacts produced · files read/changed · evidence · review/Codex status · fixes made · checks run · memory update · dashboard update · what was not done · final verdict · next step.
```

## Notes
- **Honesty is mandatory.** Forge marks agents `NOT USED` / `INTERNAL ROLE ONLY`, reviews `Codex not invoked` when not run, and event-derived data `derived from event log`. It never fakes agents, execution, reviews, tests, files, artifacts, or progress.
- **Quality loop is bounded:** max 2 iterations (3 for high-end). Never loops forever.
- **Project isolation always on:** Forge works only in the active project folder; per-project dashboard, memory, runs, logs and port.
- Watch it live in the **Command Center** (the one dashboard for every project): `http://127.0.0.1:4100` — if it isn't running, start the supervisor from the Command Center home project (`node command-center/gateway/supervisor.mjs`) and health-check `/api/health` first. The retired per-project Control Center only starts on an explicit `legacy dashboard` request.
