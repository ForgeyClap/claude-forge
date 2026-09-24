# Forge V2 — Owner Governance Precedence (WAVE B / B4, 2026-07-18)

The single, authoritative ordering for every "which rule wins" question Forge asks at run time.
Referenced by `forge-router` (`skills/forge-router/SKILL.md`, Step 0-owner) and `commands/forge.md`
before intake — never re-derive this ordering elsewhere; point back to this file instead.

## The order (highest wins)

1. **Hard gates** — `.claude/config/orchestration/hard-gates.json`, read via
   `.claude/forge-bin/forge-actiongate.cjs::classify()`. An irreversible action (deploy, git-push,
   spend, DNS change, prod-activate, credential attach/rotate, workflow-activate, outbound SMS) or a
   project-isolation escape (write-outside-root) stops the run **whenever the classifier fires**,
   regardless of every layer below — including a standing rule, an owner-profile pref, or the current
   owner instruction. This is also tier 2 of `.claude/forge-bin/forge-autonomy.cjs::decide()`.

   **What "hard" does and does not mean** (reconciled 2026-08-03, after the audit sweep found this
   file and `hard-gates.json` contradicting each other — one promising an action "always" stops, the
   other calling the same gates "ADVISORY … never blocking"; an agent reading only one of them drew
   the wrong conclusion either way):
   - **Hard = highest precedence, and it interrupts.** When the classifier fires, no lower layer —
     not a standing rule, not a stored pref, not autonomy mode, not even an explicit current
     instruction — may wave it through. That part of "always" is real, and it is what tier 1 means.
   - **Hard ≠ complete coverage, and ≠ technical enforcement.** The gate is a REGEX CLASSIFIER over
     an action's text, not a kernel that can physically prevent a command. It has deliberate,
     documented non-coverage (see `hard-gates.json`'s `_not_caught` block, which lists exactly what
     it does not see). An action it does not recognise is simply not gated — so the absence of an
     interrupt is never evidence that an action was safe.
   - **The exception — four COMMAND gates are hook-enforced (three since v2.7.0 WP16; `opaque-exec` since the 2026-09-24 codex-recheck) — a classifier, not a proof.**
     `destructive-delete`, `kill-by-name` and `git-destructive` are also checked by a real PreToolUse hook,
     `.claude/forge-bin/forge-gate-hook.cjs` (matcher `Bash|PowerShell`, started as
     `node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"` so it works from any working directory),
     which blocks a matching command with exit 2 BEFORE it runs: a recursive delete with OR without the force
     flag, killing processes by name (including pgrep/pidof substitutions and xargs pipelines), and git commands
     that discard uncommitted work. Config key `gate-hook`, default on. Only the owner switches it off — an
     agent's own `forge-config … set gate-hook off` / `unset` / `reset` is itself blocked; the one exact shape
     `node .claude/forge-bin/forge-config.cjs set gate-hook off --once "<quote>"` (a quoted owner approval with a
     short expiry) passes, and while the gate is off every call it would have stopped still prints a visible
     `FORGE GATE is OFF …` notice with exit 1. A recursive delete passes ONLY when every segment of the command
     is itself a provable delete and every target resolves (real paths, symlink-aware, no `..`, no shell
     variables, no globs, no braces or parentheses, no `cd`/`mv`/`ln`/`exec`/`env` words) inside a scratch
     area — `_scratch/`, `node_modules/`, `dist/`, strictly inside `.claude/forge-backups/`,
     `.claude/forge-runs/**/gate-output/`, `command-center/.data/tmp/`, or the OS temp dir for targets outside the project root — and `kill-by-name` /
     `git-destructive` never pass; the pass-through itself fails CLOSED on any internal error. Quoted DATA
     (heredoc bodies, `echo`/`printf` literals, log-event payloads, search patterns for grep/rg/Select-String/
     findstr/git grep) is not a command and is not gated, unless the same command later feeds it to an
     interpreter. Whenever the hook cannot judge a call (own error, oversized payload, stdin read error or
     timeout) it exits 1 — visible, never a silent pass (see `HOOKS_OPT_IN.md` "Scratch pass-through" and
     "Gate hook"). The text gates (deploy, git-push, spend, dns-change, prod-activate, credential
     attach/rotate, workflow-activate, outbound-sms) and `write-outside-root` remain classifier + prose, and the
     standing rules (tier 3) stay advisory.
   The honest one-line summary, and the sentence both files must agree on: **a fired gate always
   interrupts and cannot be overridden; an unfired gate proves nothing.**
2. **Current owner instruction** — whatever the owner explicitly asked for in THIS turn/session always
   outranks a stored default. A stored pref/rule pre-fills and advises; it never silently overrides an
   explicit, current, in-scope owner instruction. (It does not outrank tier 1 — an explicit instruction
   to do something an active hard gate blocks still stops for confirmation.)
3. **Standing rules and owner config (`/forge config`, `.claude/FORGE_CONFIG.json` project /
   `~/.claude/FORGE_CONFIG.json` global)** — the rules are `.claude/config/orchestration/FORGE_STANDING_RULES.json`, read via
   `.claude/forge-bin/forge-standing.cjs::match()`. Enforceable, evidence-backed owner rules (e.g.
   "never push without being asked", "outreach stays draft-only"). Advisory, not a hook (this project's
   governance is light-security — CLAUDE.md: "no mandatory security gates") — a match is injected into
   the dispatch prompt as ADVISORY OWNER CONSTRAINTS, never used to silently block a run outside tier 1.
   Within this layer, `forge-standing.cjs`'s own topic-shadowing precedence applies (`glob` > `domain` /
   `on-request` > `always`; a `cannot_override_core:true` rule can never be shadowed).
   The owner config (v2.7.0, 2026-09-24) sits in this same tier: every setting the owner changed with
   `/forge config set <key> <value>` (usage guard, autonomy, start gate, intake, prompt doctor, explain mode,
   dashboard, Codex review, team size, git checkpoint, cleanup, …) is an explicit, standing owner choice, read
   ONLY via `.claude/forge-bin/forge-config.cjs` (its own order: per-run `--flag` > project file > global file >
   owner-profile product default > schema default; catalogue `config/orchestration/FORGE_CONFIG_SCHEMA.json`).
   A config value can never make a hard gate configurable — the gate ids and `always_interrupt` are locked
   (`set` on one exits 3, a stray value in a file is ignored with a note) — and a current owner instruction
   (tier 2, e.g. "wait", "ask first") still wins over a stored setting for this run.
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

Since v2.7.0 (2026-09-24) the echo also carries the resolved owner config — how many settings resolved and
which ones differ from the defaults, with their source — and a CHANGE is announced before it is applied:
right after the run id exists, `node .claude/forge-bin/forge-config.cjs diff --run <run_id> --mark-seen` compares
the current values with the last run's and, when something changed, logs ONE `config_changed` event through
the real event writer (exit 3); the Lead repeats those lines to the owner in its first message ("Je hebt
usage-guard.pause-at op 97 gezet — toegepast.") and only then emits the echo. A changed setting is therefore
always visible on the dashboard and in the chat, never applied silently.
