# Forge runs (event logs)

Each `/forge` run gets its own folder here:

```
forge-runs/
  <run_id>/                 e.g. forge-2026-06-27-143000
    run.json                run metadata (request, mode, type, stack, status, quality_target, preview_url, …)
    events.jsonl            one JSON event per line (live activity for the dashboard)
    mission-packet.md       the Lead Agent's expanded mission (high-end runs)
    work-packages.md        the per-subagent work packages (high-end runs)
    final-report.md         the final Forge report for this run
```

`run.json` shape:
```json
{
  "run_id": "forge-2026-06-27-143000",
  "started": "2026-06-27T14:30:00Z",
  "finished": null,
  "status": "running",
  "request": "build a landing page",
  "mode": "CONTINUE",
  "project_folder": "C:/path/to/project",
  "project_type": "website",
  "stack": "React/Vite",
  "complexity": "L2",
  "preview_url": null,
  "blocks": { "classify": "done", "execute": "running" }
}
```

`events.jsonl` line shape (append with `node .claude/forge-dashboard/log-event.cjs`):
```json
{"timestamp":"2026-06-27T14:30:01Z","run_id":"forge-2026-06-27-143000","event_type":"agent_started","agent":"frontend","status":"running","task":"build hero","files_read":["src/App.tsx"],"files_changed":[],"evidence":"file read confirmed"}
```

## Event types (all optional — write only when real)
`run_started` · `project_scanned` · `profile_loaded` · `memory_loaded` · `memory_updated` · `decision_logged` · `agent_selected` · `agent_started` · `agent_progress` · `agent_completed` · `agent_failed` · `skill_loaded` · `command_run` · `file_read` · `file_changed` · `check_started` · `check_passed` · `check_failed` · `report_generated` · `run_completed`.

**Visible reasoning — NOT hidden chain-of-thought:** `agent_note` · `agent_output` · `agent_decision_summary` · `agent_next_action` · `agent_evidence_added`. The Forge Terminal shows these as a node's task cards + SELECTED NODE detail. Examples:
```json
{"event_type":"agent_note","agent":"orchestrator","role":"lead/integrator","note":"README-only task; workflows and credentials untouched.","evidence":"user requested docs-only change"}
{"event_type":"agent_output","agent":"forge-router","role":"routing","output":"Project type: n8n automation. Playbook: forge-n8n.","evidence":"WORKFLOW_REGISTRY.md present"}
```
Common fields: `agent`, `role`, `status`, `task`, `note`, `output`, `decision_summary`, `next_action`, `evidence`, `files_read[]`, `files_changed[]`. Don't fabricate — only log a note/output when a real decision, read, or output exists. Runs without these still render (the cockpit derives limited summaries from the event log and labels them "derived").

**Swarm execution (Lead-Agent studio — write only when real):** `mission_packet_created` / `mission_blueprint_created` · `role_map_created` · `skill_discovery` / `skill_map_created` · `custom_skill_created` · `skill_assigned` · `agent_work_package_created` · `custom_subagent_created` · `subagent_started` · `subagent_completed` · `subagent_output_created` · `subagent_artifact_created` (≈ `agent_*`) · `agent_handoff` · `lead_review_started` · `lead_review_completed` · `rework_task_created` · `rework_assigned` · `rework_started` · `rework_completed` · `merge_started` · `merge_completed` · `codex_review_started` · `codex_review_completed` · `codex_finding` · `codex_blocked` · `codex_not_invoked` · `fix_started` · `fix_completed` · `retest_started` · `retest_completed` · `quality_gate_passed` · `quality_gate_blocked` · `final_output_created`. These drive the **FLOW studio layout** — a separated *Preflight/Context* band on top (router/memory/scan/ecc-mode/forge-core, shown as SETUP/CONTEXT, not subagents) then **left → right** stage columns: **USER MISSION → LEAD AGENT → MASTER PLAN → SUBAGENT EXECUTION → OUTPUT/ARTIFACT → LEAD REVIEW + REWORK → FIX LOOP / RETEST → MERGE → CODEX → FINAL OUTPUT** — plus the REVIEW (codex/fix loop) and ARTIFACTS lenses. Node badges are honest: **ECC ✓** (ECC REAL INVOKED) · **ECC SKILL** · **NATIVE** (fallback) · **CODEX ✓/✕/—** · **CUSTOM** (✦, custom role) · **SETUP/CONTEXT** (preflight) · **DERIVED**. Custom subagents need `custom_subagent_created` (or `custom:true` on the work package) + a real work package + a real output (or honest blocked). Work packages SHOULD carry `skill` + `skill_source` (`ecc-skill`/`forge-skill`/`project-local`/`native`/`internal`/`unavailable`). **Live vs Replay:** completed runs show "Completed run — Replay available" and the replay bar (▶/⏸ · 1x/2x/5x · ⟲ reset · ⤓ Live) animates WAITING→RUNNING→COMPLETED in event order; live runs show "Live run". Examples:
```json
{"event_type":"mission_packet_created","agent":"orchestrator","role":"lead","expanded_mission":"Audit n8n webhooks…","quality_target":"client-ready","definition_of_done":["…"],"evidence":"mission-packet.md"}
{"event_type":"agent_work_package_created","agent":"n8n-specialist","role":"n8n Automation Specialist","status":"previewing","mission":"Validate workflows","inputs":["workflows/webhook.json"],"allowed_actions":["read","validate"],"not_allowed":["modify live credentials"],"output_artifact":"workflow-analysis.md","evidence_required":["issues found"],"handoff":"codex-reviewer","success_criteria":"all nodes validated"}
{"event_type":"agent_artifact_created","agent":"n8n-specialist","artifact":"workflow-analysis.md","artifact_kind":"report"}
{"event_type":"agent_handoff","agent":"n8n-specialist","to":"codex-reviewer","note":"analysis ready"}
{"event_type":"codex_finding","agent":"codex-reviewer","severity":"high","area":"input validation","issue":"webhook payload used without validation","iteration":1}
{"event_type":"fix_completed","agent":"code-writer","finding_id":"f1","files_changed":["src/utils/validator.js"]}
{"event_type":"quality_gate_blocked","agent":"orchestrator","iteration":1,"reason":"unresolved_critical","note":"1 high finding open"}
```
**Project governance events (Forge maintains the project's CLAUDE.md + project-local skills):** `claude_md_checked` · `claude_md_created` · `claude_md_updated` (safe-merge — preserve existing rules, add/refresh a `## Forge Studio v7` section) · `claude_md_conflict_detected` · `project_skill_dir_checked` · `custom_skill_created` · `custom_skill_updated` · `custom_skill_used` (carry `agent` + `skill`) · `custom_skill_skipped` · `custom_skill_conflict_detected`. The dashboard surfaces these as **CLAUDE.md** + **Custom Skills** Summary-Metrics rows. Example: `{"event_type":"claude_md_updated","agent":"orchestrator","note":"added ## Forge Studio v7 section; preserved nb governance rules","evidence":"CLAUDE.md"}`.

**v7.1 hardening events.** **Codex unlock:** `codex_diagnosis_started`/`_completed` (capture codex CLI/version/auth/git/TTY/trust/exit-code), `codex_trust_gate_detected`, `codex_interactive_retry_required`, `codex_manual_command_created` (exact command for the user), `codex_retry_started`/`_completed`/`_blocked` (`reason`: `trust/tty`|`no-git`|`no-output`|`not-available`). The dashboard's **Codex** metric + CODEX node show the exact state: CODEX REAL INVOKED · BLOCKED: TRUST/TTY · BLOCKED: NO GIT · BLOCKED: NO OUTPUT · NOT AVAILABLE · NOT INVOKED · FALLBACK USED. **Browser proof:** `browser_proof_started`, `browser_screenshot_captured`, `browser_layout_verified`, `browser_proof_blocked` → the **Browser Proof** metric. **Skill registry:** `skill_registry_checked`/`_created`/`_updated`/`_conflict_detected` (`.claude/FORGE_SKILL_REGISTRY.md`). **Large swarms (≥4 subagents)** get an **ARTIFACT COLLECTOR** node that bundles output→review edges; edge types include **artifact flow** + **blocked**; subagent nodes use readable category labels (PLAN/DESIGN/MOBILE/FRONTEND/OPTIMIZE/ACCESSIBILITY/QA/REVIEW/CODEX/REPORT/CUSTOM/…).

**ECC-first events (Forge is ECC-based):** `ecc_inventory` (what ECC is available + mode), `ecc_blocked` / `ecc_agent_failed` (with `reason`), `native_fallback_used`. Every agent/work-package event SHOULD carry a **`runtime`**: `ecc-agent` · `ecc-skill` · `native` · `codex` · `internal` — so the dashboard + ledger show ECC vs native honestly. Mode comes from `.claude/FORGE_ECC_MODE.json` (`ecc_normal_mode`/`ecc_full_test_mode`), surfaced by the dashboard ECC badge + Summary Metrics.

**STATUS values** map to the 6-state model: `running`=orange · `completed`/`done`=green · `waiting`=cyan · `previewing`=blue (work package logged, not executed yet) · `failed`/`block`=red · `internal`=gray (INTERNAL ROLE ONLY). Old runs without these new types still render gracefully.

These logs are local-only and may be git-ignored (see `.gitignore`). The dashboard reads them read-only (live via SSE).
