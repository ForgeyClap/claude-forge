# Forge V2 — Owner Governance Precedence (WAVE B / B4, 2026-07-18)

The single, authoritative ordering for every "which rule wins" question Forge asks at run time.
Referenced by `forge-router` (`skills/forge-router/SKILL.md`, Step 0-owner) and `commands/forge.md`
before intake — never re-derive this ordering elsewhere; point back to this file instead.

## The order (highest wins)

1. **Hard gates** — `.claude/config/orchestration/hard-gates.json`, read via
   `.claude/forge-bin/forge-actiongate.cjs::classify()`. An irreversible action (deploy, git-push,
   spend, DNS change, prod-activate, credential attach/rotate, workflow-activate, outbound SMS) or a
   project-isolation escape (write-outside-root) **always** stops the run, regardless of every layer
   below — including a standing rule, an owner-profile pref, or the current owner instruction. This is
   also tier 2 of `.claude/forge-bin/forge-autonomy.cjs::decide()`.
2. **Current owner instruction** — whatever the owner explicitly asked for in THIS turn/session always
   outranks a stored default. A stored pref/rule pre-fills and advises; it never silently overrides an
   explicit, current, in-scope owner instruction. (It does not outrank tier 1 — an explicit instruction
   to do something an active hard gate blocks still stops for confirmation.)
3. **Standing rules** — `.claude/config/orchestration/FORGE_STANDING_RULES.json`, read via
   `.claude/forge-bin/forge-standing.cjs::match()`. Enforceable, evidence-backed owner rules (e.g.
   "never push without being asked", "outreach stays draft-only"). Advisory, not a hook (this project's
   governance is light-security — CLAUDE.md: "no mandatory security gates") — a match is injected into
   the dispatch prompt as ADVISORY OWNER CONSTRAINTS, never used to silently block a run outside tier 1.
   Within this layer, `forge-standing.cjs`'s own topic-shadowing precedence applies (`glob` > `domain` /
   `on-request` > `always`; a `cannot_override_core:true` rule can never be shadowed).
4. **Owner-profile defaults** — `.claude/FORGE_OWNER_PROFILE.json` (+ the owner-write-only global copy,
   `~/.claude/FORGE_OWNER_PROFILE.json`, + an optional `FORGE_OWNER_PROFILE` env override), read via
   `.claude/forge-bin/forge-prefs.cjs::resolve()`. Durable owner preferences that pre-fill intake
   (language, autonomy default, UI-quality default, etc.) when nothing more specific applies. Layer
   precedence WITHIN this tier is project < global < env (forge-prefs.cjs's own merge order).
5. **Auto-defaults** — whatever Forge would otherwise assume with no owner evidence at all (a playbook's
   built-in default, a tool's built-in fallback). Lowest precedence; only used when nothing above supplied
   a value.

## Non-negotiable

- `honesty_core` (`FORGE_OWNER_PROFILE.json`) and `honesty-core-untouchable`
  (`FORGE_STANDING_RULES.json`) both carry `cannot_override_core:true` — they may be REINFORCED by any
  lower/adjacent layer, never weakened or shadowed, no matter how the rest of this ordering resolves.
- A hard gate (tier 1) is decided by **live classification** (`forge-actiongate.classify()` /
  `forge-autonomy.decide()`), never by matching against a static list — this file documents the order,
  it is not itself consulted as a lookup table.
- Nothing in tiers 3-5 may ever promote itself to "active" on its own. A standing rule reaches
  `status:"active"` only via real evidence seeded by Build Boss, or an explicit owner **`/forge
  remember`** (`forge-standing.cjs::remember()`) — the only sanctioned auto-active write path. A staged
  `forge-reflect`/`FORGE_PREF_CANDIDATES.json` candidate is NEVER auto-promoted, regardless of its own
  status field (see `forge-prefs.cjs::listCandidates()` — STAGE-ONLY, no promote path exists in that
  module at all).

## Native primitives for autonomous work (WP-GH-WIRE, 2026-07-26)

A long autonomous mission should reach for the platform's own native primitives before rolling a prompt-only
equivalent: `/goal <condition>` for a bounded loop-until-done tier, `/loop <interval>` for recurring checks
(heartbeat/canary polling) — see `FORGE_AUTONOMY.json`'s `native_primitives` section for the exact wording.
Neither primitive outranks tier 1 or 2 above — a hard gate or a usage-limit pause still stops a `/goal`/
`/loop` run exactly as it stops any other continue-within-mission work.

## The echo (making this ordering visible, not just documented)

Before intake, Forge composes and logs ONE `owner_prefs_loaded` event (via
`.claude/forge-bin/forge-echo.cjs::composeEcho()`/`emitEcho()`) summarizing which owner-profile prefs
resolved and which standing rules matched for this run — the applied-prefs ECHO is the safety mechanism
that makes this file's ordering observable on the dashboard/run log, not merely a policy nobody can see
was actually followed. See `skills/forge-router/SKILL.md` "Step 0-owner" and `commands/forge.md` for the
exact wiring point.
