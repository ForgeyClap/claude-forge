# Custom project-local SKILL.md template

Scaffold for a Forge Lead-Agent–created **project-local custom skill**. Copy this into
`.claude/skills/<custom-skill-name>/SKILL.md`, fill every field, and link it to a real subagent/work package.
Create one ONLY when it is useful, project-local, documented, and there is no suitable existing ECC/Forge skill.
Never create fake skills; never modify global skill folders without explicit approval.
(This file lives at the skills/ root — not inside a `<name>/SKILL.md` folder — so it is NOT auto-registered as a live skill.)

```markdown
---
name: <custom-skill-name>
description: <one line — what this skill does + dense trigger keywords so the Lead/subagent finds it>
---

# <Custom Skill Name> (custom, project-local)

## Purpose
<what capability this provides>

## When to use
<concrete situations in THIS project>

## When NOT to use
<out-of-scope situations; defer to ECC/Forge skill X instead>

## Project evidence (why this skill exists)
<the real files/memory/mission that justify a custom skill — the gap no existing skill filled>

## Inputs
- <files / data / context the skill consumes>

## Allowed actions
- <what a subagent using this skill may do>

## Not allowed actions
- <hard limits: no credentials / no live workflows / no production / no external writes / no other projects>

## Expected outputs
- <artifact(s) + path, e.g. artifacts/<name>.md>

## Evidence requirements
- <what proves the work really happened: files read/changed, before/after, findings>

## Related subagents
- <which subagent role(s) use this skill, and their handoff target>

## Example work package
```
node .claude/forge-dashboard/log-event.cjs <run_id> agent_work_package_created \
  "{\"agent\":\"<role>\",\"role\":\"<role>\",\"runtime\":\"native\",\"skill\":\"<custom-skill-name>\",\"skill_source\":\"project-local\",\"status\":\"previewing\",\"mission\":\"...\",\"inputs\":[\"...\"],\"allowed_actions\":[\"...\"],\"not_allowed\":[\"...\"],\"output_artifact\":\"artifacts/<name>.md\",\"evidence_required\":[\"...\"],\"handoff\":\"orchestrator\",\"success_criteria\":\"...\",\"rework_criteria\":\"...\"}"
```

## Safety / project-isolation notes
Project-local only; advisory; no code execution beyond the allowed actions; respects this project's do-not-touch list.
```

When the skill is created, log `custom_skill_created` (and `custom_skill_used` when a subagent actually runs it) so it appears on the dashboard (Custom Skills metric) and in the ledger/report.
