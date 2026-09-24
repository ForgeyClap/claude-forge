# Forge hooks — mostly opt-in, 4 real ones LIVE (3 snapshot hooks in section 4 + the tool ledger in section 5)

**Status (corrected 2026-07-29, forge-snapshot wiring):** this project's `.claude/settings.json` now EXISTS
and carries **4 real, live hooks**: the three context-continuity snapshot hooks (section 4 below) and the PostToolUse tool ledger (section 5, now with a `Write|Edit|MultiEdit|NotebookEdit|Bash` matcher — corrected 2026-09-23 after an external audit measured it firing on every tool call). Everything
else in this file (sections 1-3) remains what it always was: a documented, NOT-installed example an owner
could opt into by hand. Forge is still deliberately *security-light* ("No mandatory security gates", per the
project `CLAUDE.md`) — the snapshot hooks are advisory/never-blocking, exactly like every other hook here;
they are simply the first ones actually turned on, per an explicit owner request ("bij elke 50% context een
snapshot.md … dit geldt ook voor globaal"). Every mechanism below is **already built as a standalone,
zero-dependency `forge-bin` CLI** you can also run by hand at any time, hook or no hook.

**Honest correction (2026-07-26, wp7 triage — still true):** even before this project had its own
`settings.json`, "zero project-local hooks" never meant nothing fires while you work here. The **global**
`~/.claude/settings.json` (outside this project, owner-gated) has long carried **2 live hooks that apply to
every project including this one**:
- **PreToolUse** (`Write|Edit|MultiEdit`) → `~/.claude/forge-bin/forge-hook-hotspot-lock.cjs` (timeout 5000ms) → calls `forge-lock-guard.cjs`'s `check()` on the edited path.
- **PostToolUse** (`Write|Edit|MultiEdit`) → `~/.claude/forge-bin/forge-hook-secret-scrub.cjs` (timeout 8000ms) → calls `forge-secret-scrub.cjs`'s `scanFile()` on the edited path.

Both are read-only/advisory (they report, they do not block). As of 2026-07-29 that same global config also
carries the 2 snapshot events (PreCompact manual+auto, SessionStart compact) — see section 4; every
pre-existing entry in that file (these 2 plus the full `hook-safe.cjs`-routed set) was proven preserved
byte-for-byte by `forge-snapshot-settings.test.cjs` before the merge was applied for real.

Turning on sections 1-3 below is still a **deliberate, per-item owner decision** — nothing there is installed.

> **CORRECTED 2026-08-01 — the previous claim here was factually wrong and is retracted.** It said a hook
> fires only in the main session's process and that Agent-tool subagents "do not reliably share" it. That was
> never measured. It has now been measured: a temporary `PostToolUse`/`SubagentStart`/`SubagentStop` probe
> (a no-op logger, enabled for one dispatch and removed again) recorded **10 real invocations**, including
> `PostToolUse` for `agent_type: general-purpose` on its own `Glob` and `Read` calls, and `PostToolUse` for
> `agent_type: workflow-subagent` on concurrently-running workflow agents. **Hooks DO fire inside Agent-tool
> subagents.** The payload carries `agent_id`, `agent_type`, `tool_name`, `tool_use_id`, `tool_input`,
> `tool_response`, `duration_ms`, `permission_mode` and `effort`; `SubagentStop` additionally carries
> `agent_transcript_path` and `last_assistant_message`.
>
> Consequence: a hook is **not** merely belt-and-suspenders. It is the only source of agent activity the agent
> itself cannot author — which is exactly what the honesty rules need (a self-written `events.jsonl` entry is a
> claim; a `SubagentStop` payload is evidence). The orchestrator-invoked module stays useful for flow control,
> but "subagents don't get hooks" must not be used again as a reason to reject a hook-based guard. Any earlier
> decision that leaned on this sentence needs its remaining grounds re-checked on their own merits.

---

## 1. Hotspot write-lock — `forge-lock-guard.cjs` (PreToolUse, `Write|Edit`)

Mechanizes the "one writer per hotspot at a time" HARD MUST. **Primary use is the callable module** (the Lead/`forge-router` calls `acquire` before dispatch, `release` after). As an *optional* PreToolUse belt-and-suspenders, a starter shape:

```jsonc
// .claude/settings.json  — OWNER-CREATED, opt-in only
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        // reads the tool_input file path on stdin; checks (does not itself hold) a lock.
        // Non-blocking here (exit 0 always) — flip to `exit 3` inside the node to actually BLOCK a second writer.
        "command": "node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const i=JSON.parse(d);const f=(i.tool_input&&i.tool_input.file_path)||'';const g=require('./.claude/forge-bin/forge-lock-guard.cjs');const r=g.check({hotspot:f});if(r.held)console.error('[forge-lock] '+f+' held by run='+r.lock.run_id);}catch(e){}process.exit(0)})\""
      }]
    }]
  }
}
```

Manual (recommended) instead of a hook:
```
node .claude/forge-bin/forge-lock-guard.cjs acquire <hotspot> --run <run_id> --owner <boss>
node .claude/forge-bin/forge-lock-guard.cjs release <hotspot> --run <run_id>
node .claude/forge-bin/forge-lock-guard.cjs list
```

## 2. Stop-time doctor gate — `forge-doctor.cjs` (Stop)

Run the full self-test + leak scan when the session ends, instead of remembering to run it. The doctor already exits non-zero on any red check, so a Stop hook can surface a regression at session end. (Heavy: it runs every suite — use only if you want an end-of-session gate.)

```jsonc
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command",
  "command": "node .claude/forge-bin/forge-doctor.cjs || echo '[forge-doctor] RED — see output above'" }] }] } }
```

Manual (recommended): `node .claude/forge-bin/forge-doctor.cjs` before shipping / after big changes.

## 3. Runtime secret scrub — `forge-secret-scrub.cjs` (PostToolUse, advisory)

Scans runtime artifacts, most notably `.claude/forge-runs/<id>/events.jsonl` — gitignored and therefore not reached by the doctor's *git-tracked* leak scan — for leaked keys/tokens/PII. (`FORGE_*.md` memory files are also scanned as belt-and-suspenders, but those are git-tracked and already covered by the doctor's leak scan — `events.jsonl` is the genuine coverage gap this exists for.) **Advisory scan-and-report**: reports location only, never the secret, and never blocks. Keep it advisory to stay inside "No mandatory security gates"; only make it blocking if you explicitly want that.

```jsonc
{ "hooks": { "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [{ "type": "command",
  "command": "node .claude/forge-bin/forge-secret-scrub.cjs || true" }] }] } }
```

Manual (recommended): `node .claude/forge-bin/forge-secret-scrub.cjs` (scans all runtime artifacts; exit 3 if any finding).

## 4. Context-continuity snapshot — `forge-snapshot-{marker,reinject}.cjs` (PreCompact + SessionStart, **LIVE**)

**These 2 hooks are the ones actually installed** (owner request 2026-07-29 — see `skills/forge-snapshot/SKILL.md`
for the full doctrine). Real Claude Code stdin contract, verified against the official docs before wiring:
`PreCompact`'s payload carries `{session_id, transcript_path, cwd, hook_event_name:"PreCompact",
compaction_type:"manual"|"auto"}`; `SessionStart`'s payload carries `source` (`startup|resume|clear|compact|
fork`), and **whatever a `SessionStart` hook writes to stdout is added back into Claude's context** — the one
official re-injection point this whole system relies on. There is **no context-window percentage available
to any hook** (a closed feature request) — this system never fabricates or estimates one anywhere.

**Project-local** (`.claude/settings.json`, created 2026-07-29):
```jsonc
{
  "hooks": {
    "PreCompact": [
      { "matcher": "manual", "hooks": [{ "type": "command", "command": "node .claude/forge-bin/forge-snapshot-marker.cjs", "timeout": 5000 }] },
      { "matcher": "auto",   "hooks": [{ "type": "command", "command": "node .claude/forge-bin/forge-snapshot-marker.cjs", "timeout": 5000 }] }
    ],
    "SessionStart": [
      { "matcher": "compact", "hooks": [{ "type": "command", "command": "node .claude/forge-bin/forge-snapshot-reinject.cjs", "timeout": 5000 }] }
    ]
  }
}
```

**Global** (`~/.claude/settings.json`, merged 2026-07-29 via `forge-snapshot-settings.cjs apply --backup` —
every pre-existing hook/key proven preserved first): the same 2 events, appended alongside the pre-existing
PreCompact (`hook-safe.cjs handler compact-manual/-auto`) and SessionStart (`hook-safe.cjs handler
session-restore` + `memory import`) entries — never replacing them. The global commands point at
`~/.claude/forge-bin/forge-snapshot-{marker,reinject}.cjs`, which resolve the **target** project's root from
`CLAUDE_PROJECT_DIR` (or cwd) and dynamically `require()` **that project's own**
`.claude/forge-bin/forge-snapshot.cjs` — a project with no Forge install degrades **silently** (no output,
exit 0; proven by `forge-snapshot-marker.test.cjs`'s "no Forge install" case and a live run against a plain
non-Forge tmp dir).

Both hook targets **never block** (always exit 0, never emit `decision:"block"`) and **never print a
secret** — `forge-snapshot-marker.cjs` prints nothing at all on the success path; `forge-snapshot-reinject.cjs`
only ever prints paths/pointers/short evidenced text already written to `.claude/FORGE_SNAPSHOT.md`, never a
raw file body or credential.

Manual (also always available, hook or no hook): `node .claude/forge-bin/forge-snapshot.cjs write --reason
manual|phase` · `node .claude/forge-bin/forge-snapshot.cjs check --max-age-hours 24` · `/forge snapshot`.

## 5. Tool-behaviour ledger — `forge-toolhook.cjs` (PostToolUse, **WIRED and live** — matcher `Write|Edit|MultiEdit|NotebookEdit|Bash`, timeout 8000ms, since 2026-09-23; the 2026-08-03 correction further down already said it was firing)

**The gap it closes, measured 2026-08-01 (not assumed):** across all 28 `events.jsonl` in this project —
846 events — `file_read` appears **0** times and `command_run` **1** time. Both types are registered in
`log-event.cjs`; they are simply never written, because an agent must log them by hand and doesn't.
`grep`, `test_run` and `tool_call` are not even in the vocabulary. So "I ran the tests" is, in this
project, a **claim with nothing that could contradict it** — the exact hole the honesty rules exist to
close. Combined with the correction at the top of this file (hooks *do* fire inside Agent-tool subagents),
a `PostToolUse` hook is the only source of tool activity **the agent itself cannot author**.

`node .claude/forge-bin/forge-toolhook.cjs` reads the PostToolUse payload on stdin and appends ONE compact
line per real tool call to **`.claude/forge-runs/_toollog/<session_id>.jsonl`** (plus one rotated
generation `<session_id>.1.jsonl`):

```jsonc
{"ts":"…","session":"…","agent_id":"…","agent_type":"general-purpose","tool":"Bash",
 "target":"npm","target_kind":"command","ok":true,"ok_basis":"success-field","ms":412,
 "tool_use_id":"toolu_…","permission_mode":"default"}
```

**Behaviour, never content.** `target` is a summary: a file path (project-relative inside the project), or
a command's **canonical name** (see below), or a URL's **host** only, or a subagent/skill name. A Grep/Glob
**pattern is never stored** — a search pattern is content. `tool_input` bodies
(`old_string`/`new_string`/`prompt`) and `tool_response` bodies never appear; only a derived success boolean
plus `ok_basis`, the basis for it, so a reader can tell "the tool asserted success" from "something came
back".

**Scrubbing (rebuilt 2026-08-01 after 7 leaks were reproduced on disk).** The gate sits at
**serialisation**, not on individual fields: every string in the record — not just `target` — goes through
`forge-store.cjs`'s `SECRET_PATTERNS`, the single scrub source of truth, so a field added later is covered
automatically. If that module cannot load, the record **degrades** to the values the hook produced itself
rather than being written unvouched. Three structural consequences worth knowing when reading a log:

- Leading assignments are skipped in **both** shells — POSIX `NAME=value` *and* PowerShell `$pw="…";` /
  `$env:NAME="…";`, with or without spaces — so a key in an env prefix never becomes "the first token".
- A command's `target` is only ever a **constant from the hook's `KNOWN_COMMANDS` list** (`node`, `git`,
  `npm`, `pwsh`, `Get-ChildItem`, …), never bytes taken from the command. The executable name can itself be
  a secret (`./hunter2….sh`) and nothing can detect that, so anything off the list is recorded as
  `"target":null,"target_kind":"command-unlisted"` — the call is still counted, it just isn't named.
- `session` is the log's **filename**, so a redaction marker cannot repair it; a session id the scrubber
  would alter is refused into `unknown-session` instead, exactly like a path-traversal attempt.

**Why not into the run's `events.jsonl`:** volume (a run makes thousands of tool calls; it would drown the
narrative ledger and change what forge-verify/manifest/briefing/certify and every dashboard lens measure),
cost (resolving "which run" the way `forge-snapshot.cjs` does is O(all runs × all events) per tool call),
and correctness (that same mtime picker is documented in `forge-snapshot.cjs` as having misrouted to a
throwaway `doctor-selfcheck-<pid>/` dir — and this hook fires *during* doctor runs). Partitioning by
`session_id` is O(1), comes from the same untamperable payload, and joins to a run exactly at read time via
`tool_use_id`, which is the same id `log-event.cjs` requires as `dispatch_id` on `agent_started`/
`subagent_started`. `FORGE_RUN_ID` stamps a run on the line when the orchestrator already knows it.
`_toollog/` carries neither `run.json` nor `events.jsonl`, so every run picker already skips it
(`forge-doctor.cjs::rankRunCandidates`, the Command Center's `runs.mjs`, the chain check) — same as the
existing `.hotspot-locks` directory — and the existing forge-runs ignore rule already makes it
uncommittable. **No new `event_type` is introduced**, so the 3-place registration rule does not apply;
`forge-toolhook.test.cjs` G1 enforces that statically and `forge-doctor.cjs::unregisteredEvent()` reports
`unregistered: []`.

> **CORRECTION (2026-08-03, found by the full-`.claude` audit sweep): this hook IS wired and HAS been
> firing.** The text below said "NOT installed" while `.claude/settings.json` carried a real `PostToolUse`
> entry for `forge-toolhook.cjs` — and **without a `matcher`**, so it fires on *every* tool call of *every*
> agent, one step broader than the proposal below (`"matcher": "*"`). Proof: `.claude/forge-runs/_toollog/`
> holds ~532 KB of real entries, e.g. `{"ts":"2026-08-03T19:09:48.891Z","tool":"Bash","target":"tail",...}`.
> Practical cost: ~95-110 ms per tool call and a permanent record of every path touched and binary invoked.
> That retention/privacy trade-off was explicitly reserved for the owner, so this note records reality and
> leaves the choice open rather than silently keeping (or silently removing) the hook.
> **To turn it OFF:** delete the `forge-toolhook.cjs` entry from `.claude/settings.json`'s `PostToolUse`.
> **To keep it:** narrow it with a `matcher` and decide a retention rule for `.claude/forge-runs/_toollog/`.
> The count in this file's header ("3 real, live hooks") is therefore also wrong — it is **4**.

> **CORRECTION 2 (2026-09-24, WP7 audit-repair, security review LOW #11): the matcher/timeout claims above**
> **are now outdated too.** `.claude/settings.json`'s real `PostToolUse` entry for `forge-toolhook.cjs` was
> narrowed on 2026-09-23 to `"matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash"` with `"timeout": 8000` (see
> that file's own `_matcher_doc`, added the same day, which records why: shipped without a matcher it fired
> on every tool call of every agent — 461 in one audited session, ~56 ms each — and logged 320 paths outside
> the project; the ledger exists to record what CHANGED, and reads are noise). So, as of 2026-09-23: the live
> entry **does** carry a matcher, its timeout is **8000ms** (not 5000), and it fires only on a **Write, Edit,
> MultiEdit, NotebookEdit or Bash** call — not on every tool call. The jsonc block right below is the
> **original, historical proposal** (`"matcher": "*"`, `timeout: 5000`) from before either correction; it is
> kept for its shape/rationale but no longer describes what actually runs.

**Originally documented as a proposal (historical only — see both corrections above for what is actually live):**

```jsonc
// .claude/settings.json — HISTORICAL PROPOSAL, not the live config. The real entry (since 2026-09-23) uses
// "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash" and "timeout": 8000 — see Correction 2 above.
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node .claude/forge-bin/forge-toolhook.cjs", "timeout": 5000 }
        ]
      }
    ]
  }
}
```

**Why activation is a separate step (all three are real, none is a formality; the live matcher/timeout are per Correction 2 above):**
1. **It runs on a Write, Edit, MultiEdit, NotebookEdit or Bash call in a LIVE session** (not every tool call —
   see Correction 2). Measured cost is ~95–110 ms per matched call, of which ~77 ms is bare Node process
   startup on this machine — i.e. the hook's own work is ~20–30 ms, but the *process* is the tax and it is
   paid on every matched call. That is a real latency decision about the owner's own sessions, not a
   code-quality decision.
2. **It changes what is on disk about how the owner works.** Even though it stores behaviour and not
   content, a permanent per-session record of every file touched and every binary invoked is a
   privacy/retention choice that belongs to the owner. Bounded at ≤8 MB per session (4 MB rotation × 2
   generations); nothing prunes old session files automatically.
3. **Governance requires it.** The global policy demands per-item owner approval before any hook is enabled
   — pinned purpose, reviewed command, documented disable procedure — and the project `CLAUDE.md` keeps the
   security posture light. This hook is advisory and never blocks (always exit 0, never `decision:"block"`,
   never one byte of stdout, own 2500 ms failsafe under the live 8000 ms budget), which makes it *eligible*,
   not automatic.

Proven by `forge-toolhook.test.cjs` (42/42, real subprocesses): garbage stdin, binary/NUL stdin, empty
stdin, hostile field types, an un-creatable log path, and an 8 MB payload all give **exit 0 with empty
stdout**; the 8 MB case still records the call, honestly marked `truncated:true`, in 1113 ms. A project with
no `.claude/` degrades silently and creates nothing.

Manual (always available, hook or no hook): the module is directly callable —
`require('.claude/forge-bin/forge-toolhook.cjs').run(payloadJson, {root})`.

---

## Disabling / revoking

Delete the relevant entry from `.claude/settings.json` (project-local) or `~/.claude/settings.json` (global) —
or delete `.claude/settings.json` entirely to return this project to the zero-project-local-hook default
(the global config, including the snapshot hooks there, is unaffected by deleting the project-local file).
Every mechanism in this file still works as a manual CLI afterward — disabling a hook never removes the
capability, only its automatic firing.

## Why sections 1-3 stay opt-in (never installed) while section 4 is live
- The project `CLAUDE.md` states the security posture explicitly: no mandatory gates, no `secrets-guard`/`prod-deploy-guard` hooks, normal builds not slowed by blocking. A default-on ENFORCEMENT hook (lock/doctor/secret-scrub-as-a-gate) would contradict that, so sections 1-3 stay documented-only.
- Section 4 is different in kind: it is purely **advisory continuity tooling** (it writes a markdown file and re-injects a short summary; it never blocks, never gates, never enforces anything), and the owner explicitly asked for it to be live, "dit geldt ook voor globaal" — so it was turned on for real, with a backup + a proven-safe merge first.
- The global governance (`~/.claude` policies) requires **per-item owner approval** before any hook is enabled — pinned purpose, reviewed command, documented disable procedure. This file is that documentation for every hook, live or not.
