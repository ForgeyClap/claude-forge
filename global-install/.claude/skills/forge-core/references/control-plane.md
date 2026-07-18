# FORGE GLOBAL ADD-ON — PAPERCLIP-INSPIRED AGENT CONTROL PLANE

This section is an append-only add-on to the existing Forge global instructions.

Purpose:
Upgrade Forge with a stronger agent/company operating system inspired by Paperclip concepts, while preserving the existing Forge governance.

Core idea:
Forge remains the build/execution system.
The Paperclip-inspired layer becomes the agent control plane:

* agents
* org chart
* reporting lines
* work packages
* task tickets
* routines
* heartbeats
* budget limits
* cost tracking
* audit logs
* decision logs
* proof logs
* blocker tracking
* project/company separation

Do not replace Forge.
Do not weaken the existing Forge global system.
Only add this control-plane layer.

## 1. LEAD AGENT AS COMPANY/PROJECT BOSS

Lead Agent is the final authority.

Lead Agent owns:

* mission interpretation
* project/folder selection
* START NEW vs CONTINUE decision
* work package creation
* task assignment
* agent hierarchy
* task priority
* budget limits
* proof requirements
* final verdict
* Codex permission decisions

Lead Agent may delegate work, but may not delegate final responsibility.

## 2. AGENT ORG CHART

Every serious Forge project should define an agent org chart.

Minimum structure:

Lead Agent

* owns project mission
* creates masterprompt
* creates work packages
* assigns tasks
* reviews proof
* approves final DONE
* authorizes Codex modifications

Subagents

* execute assigned tasks
* own their role-specific deliverables
* update task status
* log proof
* report blockers

Codex Agent

* reviews code/architecture/security
* proposes improvements
* may modify only with Lead Agent permission
* cannot override Lead Agent
* cannot mark final DONE

Optional agents depending on project:

* UI/UX Agent
* Frontend Agent
* Backend Agent
* n8n Workflow Agent
* Security Agent
* QA/Screenshot Agent
* Product Agent
* Growth Agent
* Data Agent
* Ops Agent
* Documentation Agent
* Deployment Agent

Every agent must have:

* role
* responsibilities
* allowed files/folders
* tasks
* reporting line
* proof requirements
* status

## 3. TASK/TICKET CONTROL

Forge must not rely only on Markdown reports.

Every project must create or update:

tasks/TASK_BOARD.md
tasks/AGENT_TASKS.json
tasks/WORK_PACKAGES.md
tasks/ACCEPTANCE_CRITERIA.md
tasks/PROOF_LOG.md
tasks/BLOCKERS.md
tasks/CODEX_REVIEW.md
tasks/LEAD_AGENT_DECISIONS.md

Each task/ticket must include:

* task ID
* work package
* owner agent
* status
* priority
* dependencies
* exact files/folders
* execution steps
* acceptance criteria
* proof required
* proof result
* Lead Agent verdict

Allowed statuses:

* TODO
* READY
* DOING
* BLOCKED
* REVIEW
* CODEX_REVIEW
* DONE
* REJECTED
* DEFERRED

DONE means implemented, validated, proof logged, and accepted by Lead Agent.

## 4. WORK PACKAGES

Every serious project must be split into Work Packages.

Work Package format:

WP-ID:
Name:
Owner:
Goal:
Scope:
Tasks:
Dependencies:
Files/Folders:
Acceptance Criteria:
Proof Required:
Status:
Lead Agent Verdict:

Example standard work packages:

WP-01 Project State Check
WP-02 Planning & Masterprompt
WP-03 Task System
WP-04 Core Implementation
WP-05 UI/UX
WP-06 Integrations
WP-07 Security
WP-08 QA/Screenshot Loop
WP-09 Codex Review
WP-10 Cleanup
WP-11 Final Report

The Lead Agent adapts these to the project type.

## 5. HEARTBEATS AND ROUTINES

Forge should support a Paperclip-inspired heartbeat model for future 24/7 work.

Heartbeats are scheduled agent check-ins.

Examples:

* every 30 minutes: check task queue
* every 2 hours: run product/research jobs
* daily: write progress report
* weekly: cleanup and strategy review

Heartbeat tasks must be recorded as tasks or routines.

Routine format:

ROUTINE-ID:
Agent:
Schedule:
Goal:
Inputs:
Actions:
Budget Limit:
Stop Conditions:
Proof Required:
Last Run:
Next Run:
Status:

In local MVP mode, routines may be simulated.
For 24/7 deployment, routines may later be handled by n8n, cron, worker processes, or Paperclip if selected.

## 6. BUDGET AND COST CONTROL

Every autonomous or recurring system must have budget controls.

Track:

* AI/API spend
* token usage where available
* image generation spend
* automation/workflow spend
* platform costs
* VPS/server costs
* daily budget
* monthly budget
* per-agent budget
* per-project budget

If budget is exceeded:

* pause non-critical jobs
* continue low-cost internal work only
* log the event
* notify in final/daily report

Budget control must be part of the Lead Agent decisions.

## 7. AUDIT LOG AND DECISION TRACE

Every important decision must be traceable.

Use:

tasks/LEAD_AGENT_DECISIONS.md
tasks/PROOF_LOG.md
tasks/CODEX_REVIEW.md
tasks/BLOCKERS.md

Every key action must answer:

* who decided
* why
* what files changed
* what proof exists
* what remains blocked
* what was deferred

No vague completion claims.

## 8. MULTI-PROJECT / COMPANY SEPARATION

Forge must keep projects separated.

Website Builder, n8n Builder, Football Predict, Commerce Forge Factory, client projects, and future projects must not be mixed.

Every project must identify:

* project name
* folder/path
* mode: START NEW or CONTINUE
* company/project context
* related agents
* related tasks
* related credentials
* related deployment target

Do not share secrets or config between projects unless explicitly intended.

## 9. PAPERCLIP INTEGRATION STRATEGY

If Paperclip is installed:

* install/test it in an isolated folder first
* do not merge it directly into Forge until validated
* create a test company/project
* create roles matching Forge governance
* test Lead Agent / Subagent / Codex Reviewer structure
* test task/ticket workflows
* test heartbeats/routines
* test budget controls
* test audit logs
* document results

If Paperclip is not installed:

* use its architecture as inspiration
* build Forge-native task/control-plane docs and structures
* keep the system compatible with possible future Paperclip integration

Do not make Paperclip mandatory until it proves useful in a local test.

## 10. CODEX PERMISSION INSIDE CONTROL PLANE

Codex Agent may review freely.
Codex Agent may propose patches.
Codex Agent may modify files only after Lead Agent records permission.

Before Codex edits:

* Lead Agent records decision
* allowed files/folders are listed
* forbidden files/folders are listed
* goal is listed
* proof required is listed

Codex cannot mark DONE.
Lead Agent decides final status.

## 11. FINAL REPORT REQUIREMENT

Every final report must include:

* Project name
* Folder/path
* Whether Paperclip was only evaluated, tested, installed, or used as inspiration
* Verdict on Paperclip as Forge upgrade
* Work packages created/updated
* Tasks created/updated
* Agents defined
* Files changed
* Backup path
* Proof/validation run
* Blockers
* Codex review result if used
* Lead Agent final verdict
* Next recommended step

END OF PAPERCLIP/FORGE CONTROL PLANE ADD-ON.


<!-- ───────────────────────────────────────────────────────────────────────────
     Forge global add-on appended 2026-06-30 (APPEND-ONLY; nothing above removed).
     Backup of the pre-append file: SKILL.md.bak-2026-06-30-prompt-master
     Add-on: Prompt Master / Lead Agent Masterprompt Quality Layer
     (verdict: YES — keep the full Prompt Master skill SEPARATE at ~/.claude/skills/prompt-master).
─────────────────────────────────────────────────────────────────────────── -->
