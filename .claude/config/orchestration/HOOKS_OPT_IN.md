# Forge hooks — mostly opt-in, 5 real hook entries LIVE (3 snapshot entries in section 4, the tool ledger in section 5, the gate hook in section 6)

**Status (updated 2026-09-24, v2.7.0 WP16):** `.claude/settings.json` now carries **5 live hook entries
running 4 hook scripts** — the 3 snapshot entries (section 4), the tool ledger (section 5) and, new, the
**gate hook** (section 6: a PreToolUse hook that really BLOCKS the four command gates — destructive-delete,
kill-by-name, git-destructive and, since the 2026-09-24 codex-recheck, opaque-exec; a classifier, not a proof) —
plus a **`permissions.deny` block** (29 rules) that keeps `.env` files at any depth, `secrets/`, private keys,
the user's own credential files and the usage guard's owner-approval secret out of Claude's Read tool (section 6b).
The gate hook is the first hook here that enforces instead of advising; it is ON by default because the
owner decided so (config key `gate-hook`), and it is switched off with one command. The history below is kept
as it was written.

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
- **PreToolUse** (`Write|Edit|MultiEdit`) → `~/.claude/forge-bin/forge-hook-hotspot-lock.cjs` (`timeout: 5000` — SECONDS, see the L8 note in section 4) → calls `forge-lock-guard.cjs`'s `check()` on the edited path.
- **PostToolUse** (`Write|Edit|MultiEdit`) → `~/.claude/forge-bin/forge-hook-secret-scrub.cjs` (`timeout: 8000` — SECONDS) → calls `forge-secret-scrub.cjs`'s `scanFile()` on the edited path.

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

> **TIMEOUT UNIT (corrected 2026-09-24, security review wp9b L8):** a Claude Code hook `timeout` is in
> **SECONDS**, not milliseconds. The `5000` / `8000` values written here since 2026-07-29 meant 83 minutes and
> 2.2 hours, not 5 and 8 seconds. The project-local `.claude/settings.json` now uses 15 (snapshot hooks) and
> 10 (tool ledger, gate hook). The jsonc blocks in this file are the HISTORICAL shapes with the old numbers.
> The global `~/.claude/settings.json` entries named above may carry the same unit mistake; that file is
> outside this project and was not changed.

**Project-local** (`.claude/settings.json`, created 2026-07-29; timeouts now 15 seconds, see the note above):
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

## 5. Tool-behaviour ledger — `forge-toolhook.cjs` (PostToolUse, **WIRED and live** — matcher `Write|Edit|MultiEdit|NotebookEdit|Bash`, timeout 10 SECONDS since 2026-09-24 (was `8000`, i.e. 2.2 hours — see the L8 note in section 4), matcher since 2026-09-23; the 2026-08-03 correction further down already said it was firing)

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
> entry **does** carry a matcher, its timeout was **8000** (not 5000) — and that number is SECONDS, so it was corrected to **10** on 2026-09-24 (L8), and it fires only on a **Write, Edit,
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
   never one byte of stdout, own 2500 ms internal failsafe under the live 10-SECOND hook timeout), which makes it *eligible*,
   not automatic.

Proven by `forge-toolhook.test.cjs` (42/42, real subprocesses): garbage stdin, binary/NUL stdin, empty
stdin, hostile field types, an un-creatable log path, and an 8 MB payload all give **exit 0 with empty
stdout**; the 8 MB case still records the call, honestly marked `truncated:true`, in 1113 ms. A project with
no `.claude/` degrades silently and creates nothing.

Manual (always available, hook or no hook): the module is directly callable —
`require('.claude/forge-bin/forge-toolhook.cjs').run(payloadJson, {root})`.

## 6. Gate hook — `forge-gate-hook.cjs` (PreToolUse, matcher `Bash|PowerShell`, **LIVE, default ON**)

**Why it exists (2026-09-24, run `forge-2026-09-24-config-v250`, WP16).** The beginner research
(`forge-research/beginner-sweep-2026-09-24/web-track-a.md`, rows A4, A21 and B10) found that written rules
are advice: CLAUDE.md can say "never run `rm -rf`" and a model can still run it. Real beginners lost 11 GB, or
their whole home folder, to a "clean up" request. The owner wants Forge to do the safe thing by default, so the
COMMAND hard gates from `hard-gates.json` are now enforced by a hook — three at first (destructive-delete,
kill-by-name, git-destructive), a fourth (`opaque-exec`) since the codex-recheck of 2026-09-24. The model
cannot talk its way past a hook, because Claude Code runs it before the tool call; what the hook's classifier
cannot recognise it cannot stop, though — the measured limits are listed under "Honest limits" and in
`hard-gates.json` → `_not_caught`, and the beginner docs describe the gate as a classifier, not a proof. The design was hardened the same day by a
security-boss audit (wp9b) and a review-boss audit (wp9a); every finding id is named where it applies below.

**What it does.** Before every `Bash` or `PowerShell` tool call it passes the command text to
`forge-actiongate.cjs` (the same classifier everything else uses, so there is no second regex set). The entry
runs `node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"` (security M2a). That the variable
expands was PROVEN live in Claude Code 2.1.220 on win32, because the hook ran and blocked a probe from that
command form. The hook therefore works even when the session's working directory is not the project root.

| Exit | Meaning |
|---|---|
| **2** | **Blocked.** Claude Code stops the call and shows Claude one plain-language reason in Dutch and English. |
| **1** | **Not blocked, but VISIBLE** to the user (security M2 / M3). Used when the gate is switched off and the call *would* have been blocked, and when the hook could not check the call (internal error, payload over 8 MB, stdin that never ends, classifier unavailable). |
| **0** | Allowed. |

| Gate | What gets blocked | Safe variant the message offers |
|---|---|---|
| `destructive-delete` | `rm -rf ./build`, `rm -r ./src` / `rm -R` / `rm --recursive` (security H1), `Remove-Item -Recurse -Force ./src`, `rd /s /q dist`, `rimraf ./lib`, a recursive `Get-ChildItem … \| Remove-Item` | name the exact path and check it first, delete single files, or clean up inside a scratch area. A delete whose every segment is a provable scratch delete PASSES (see "Scratch pass-through") — codex-recheck 2026-09-24 (I01): this proof now runs for EVERY recursive-delete SHAPE, even one the classifier's own 16-literal except-valve already excused, so `mv src _scratch; rm -rf _scratch` still blocks. |
| `kill-by-name` | `taskkill /IM node.exe`, a `taskkill /FI` filter other than `PID eq` (security M1), `Stop-Process -Name` / `-N` / `-Na` / `-Nam`, `pkill`, `killall`, `gps node \| Stop-Process`, `ps node \| kill`, `kill $(pgrep node)`, `pgrep node \| xargs kill`, `ps aux \| grep node \| xargs kill`, `Stop-Process -InputObject (Get-Process node)` (codex-recheck S04) | kill only the exact PID you started (`taskkill /PID <pid>`, `Stop-Process -Id <pid>`). Never a pass-through. |
| `git-destructive` | `git reset --hard`, `git clean -f`, `git checkout -f` / `-qf`, `git checkout .`, `git checkout -- <path>`, `git checkout <tree-ish> -- <path>`, `git restore <path>` / `git restore .`, `git switch -f` / `--force` / `--discard-changes`, `git stash drop` / `clear`, `git worktree remove --force`, `git -c clean.requireForce=false clean -d` (codex-recheck D01), `git.exe`, a quoted or glued `-C` (`-C/repo`, `-C "/repo with spaces"`) | commit or stash first (`git stash push`). Never a pass-through. |
| `opaque-exec` (codex-recheck 2026-09-24, S03; command-position fix by the Lead the same day; wave-2 fix V06 restores grouping/control-flow and substitution evidence) | `iex`/`Invoke-Expression`/`eval` **as the command of a segment** — after optional `NAME=value`, sudo/time/nohup/exec/env, the PowerShell `&`, and after grouping/control-flow openers (`{`, `(`, `!`, `then`, `do`, `else`, `elif`, `while`, `until`, `for`, `if`, `case` arms, PowerShell `if (…) {`, `foreach`, `try`) — the same words inside a file name, a commit message or prose stay silent; `sh -c`/`bash -c`/`pwsh -c`/`powershell -c` (also via `/bin/bash`, `/usr/bin/env bash`) whose argument holds a variable, a `$(…)` or a backtick substitution (the substitution evidence is tested on the raw text, not on the amputated segment); `pwsh`/`powershell -e`/`-ec`/`-enc`/`-EncodedCommand` (the encoded shape itself); a pipe straight into an interpreter (`\| sh`, `curl … \| bash`, `curl … \| /bin/bash`, `base64 -d \| sh`); `certutil -decode … & …` | write the command out in full, or run it as a separate readable script file — Forge cannot see what an opaque call would run, so it stops rather than guessing. |
| `gate-hook-self-disable` (security M3, hook-only; wave-2 fix V02/V03) | any Bash/PowerShell forge-config invocation whose PARSED ARGV names `gate-hook` with `set <off-word>` or `unset`: any path to `forge-config.cjs`/`forge-config-cli.cjs`, a quoted or concatenated verb (`s"et"`), `node` with flags (`--no-warnings`) or by absolute path (`/usr/bin/node`, `node.exe`), `env`/`sudo`/`time`/`nohup` wrappers, flags in any order, `--json`/`--global`; an invocation that names `forge-config` + `gate-hook` but cannot be read unambiguously is REFUSED (never `null` = permission); while a `--once` grant is pending, a plain off/unset is blocked too (and `forge-config.cjs` itself refuses to persist that transition — a one-off can never become a permanent OFF). Only the EXACT `--once "<quote>"` shape passes; `reset` is allowed (it restores the default, which is ON) | see "Switching the gate off" below. |

**The `git-destructive` gap this closed.** Before WP16, `git checkout .`, `git checkout -- src/app.js` and
`git restore src/app.js` were classified "no gate triggered". All three discard uncommitted edits with no
reflog entry. The gate has five more arms now, including `git switch` with a force flag. Codex-recheck 2026-09-24
(D01/DATA-GIT-SPELLINGS) closed a further, independent set of spelling gaps: `git.exe`, a quoted/glued `-C`,
`git checkout -qf` (a bundled short flag), `git worktree remove --force`, and `git -c clean.requireForce=false
clean -d` (a config override that makes an unforced clean destructive). These stay silent:
- `git restore --staged <path>` (it only unstages);
- `git checkout main`, `git checkout -b x` and `git checkout src/app.js` (no `--`: same shape as a branch switch
  — deliberately NOT closed, see "Honest limits");
- `git switch main`;
- a trailing `--` with no path;
- `git worktree remove ../wt-a` without `--force` (git itself refuses a dirty worktree there);
- `git -c clean.requireForce=false clean -d -n` / `--dry-run` (a dry run never deletes).

### Switching the gate off (security M3, review M4, codex-recheck S05/S06/S07)
- **The owner** can always switch it off: run `/forge config set gate-hook off` yourself, or any command
  with `!` in front (bash mode runs in the owner's own shell, not through Claude's tool). You can also delete
  the `PreToolUse` entry from `.claude/settings.json`. Switch it back on with `… set gate-hook on`.
- **An agent cannot switch it off**, from a PARSED ARGV rather than a spelling match (codex-recheck S05): any
  path form to `forge-config.cjs`, a quoted verb (`"set"`), flags in any order/position, `--json`/`--global` —
  whose target key is `gate-hook` with `set <off-word>` or `unset` — is blocked. A `reset` (project or global,
  with or without `--yes`) is allowed, because it can only restore the default, which is ON.
- **There is one exception: the beginner yes-path.** When the owner has explicitly said yes, the agent may run
  exactly `node .claude/forge-bin/forge-config.cjs set gate-hook off --once "<the owner's words>"`, and
  nothing else on the same line — an extra flag or a trailing argument after the quote is NOT exempt.
  That writes a one-off 10-minute off entry (`forge-config.cjs::setOnce`).
  - The quote's field name in `get()` is read defensively (`once_quote`, `approval_quote`, `quote` or
    `approval`).
- **A once-grant is consumed ATOMICALLY, per affected command — never a blanket 10-minute window (codex-recheck
  S06).** Setting the grant is not itself the approval for every command that follows: the FIRST command that
  would have been blocked while the grant is armed calls `forge-config.cjs::consumeOnce('gate-hook',
  {commandSha256})`, which marks the entry consumed and returns `{ok:true}` exactly once. That command is
  allowed with a visible notice (`FORGE GATE: one-off approval used for this command (<gates>)`, exit 1); every
  subsequent command — even an identical one — sees `{ok:false, reason:'consumed'}` and is BLOCKED. If
  `consumeOnce` is absent from the config module, or it throws, the hook fails CLOSED (blocks) rather than
  guessing. A self-disable attempt arriving during a once-window is BLOCKED outright (exit 2 with the
  self-disable notice — codex-recheck V03, wave 2): it is never approvable through the grant, never calls
  `consumeOnce`, and `forge-config.cjs` itself refuses to persist a plain off/unset while a once-entry is pending,
  so a one-off can never turn into a permanent OFF.
- **While the gate is off it is never silent about what it would have stopped — on either off-path, including
  a self-disable attempt (codex-recheck S07).** Every affected call exits 1 with one visible line:
  - `FORGE GATE is OFF (set_at <ts>, set_by <who>) — this would have been blocked (<gates>)` for a PERSISTENT
    off (no expiry — an out-of-band owner action, e.g. a direct config edit or the dashboard), or
  - `FORGE GATE is OFF until <expires_at> — one-off approval: "<quote>" — this would have been blocked (<gates>)`
    for a once-grant whose `consumeOnce` call has not yet succeeded for THIS command.
  An inspection failure (the classifier is unavailable) is likewise ALWAYS visible, on or off — it is never
  folded into the off-branch at all.
- **Optional hardening — not installed by default (security M3 point 3).** The hook only sees Bash and
  PowerShell. An agent could still edit the switch files with the Write or Edit tools. A user who wants that
  closed too can add these lines to `permissions.deny`:

  ```json
  "Edit(./.claude/FORGE_CONFIG.json)", "Write(./.claude/FORGE_CONFIG.json)",
  "Edit(./.claude/settings.json)", "Write(./.claude/settings.json)",
  "Edit(./.claude/forge-bin/forge-gate-hook.cjs)", "Write(./.claude/forge-bin/forge-gate-hook.cjs)",
  "Edit(./.claude/forge-bin/forge-gate-data.cjs)", "Edit(./.claude/forge-bin/forge-actiongate.cjs)",
  "Edit(./.claude/config/orchestration/hard-gates.json)"
  ```

  They are not shipped, because in the Forge dev tree they would block the maintenance of these very files.
  They also do not affect `/forge config set`, because the node CLI writes the file, not Claude's Edit tool.

### Inert data is not a command (WP16 follow-up 2, review L1 + L3)

**Why.** On the first day the hook blocked three calls whose QUOTED DATA only mentioned a gated command: a Lead
log payload, a verification line, and the codex-reviewer's prompt file. So before classifying, the hook removes
regions that provably never execute (`forge-gate-data.cjs`). Everything else is classified exactly as before,
and any doubt means nothing is stripped. If that module is missing, nothing is stripped at all.

**What gets stripped.**
- **(a) A bash heredoc body**, when all of these hold:
  - the consumer is a pure writer: `cat`, `tee`, `printf` or `echo`;
  - it is not piped;
  - its head line has no quote, `$(`, backtick or `#` before it — codex-recheck 2026-09-24 (C02) now also
    reads LEADING INDENTATION before the writer and a QUOTED redirect destination (`cat > 'notes.txt' <<'EOF'`,
    `  cat > notes.txt <<'EOF'`), which the original head-only regex used to reject outright;
  - it does not write a script file (a quoted script destination, `cat > 'evil.sh' <<'EOF'`, is still refused).

  An UNQUOTED delimiter (`<<EOF`) qualifies only when the body has no `$(`, backtick or `${`. The Claude Code
  commit form `git commit -m "$(cat <<'EOF'` … `EOF` / `)"` also qualifies. **Codex-recheck 2026-09-24 (S01) —
  quote-STATE awareness:** a `<<` that only LOOKS like a heredoc marker while it is actually sitting inside an
  already-open, multi-line shell quote is never treated as a real one (`echo '` … `cat <<EOF` … `'` … a real
  command … `EOF` no longer hides the command in between); a `$(...)` command substitution is its own lexical
  context and is never swallowed by an enclosing quote's scan, so the Claude Code commit form above still works
  even though it sits inside a double-quoted `-m` argument. An unterminated quote anywhere refuses the WHOLE
  heredoc pass (fail closed).
- **(b) Quoted literals** — single-quoted, or double-quoted without `$` — given to:
  - `echo` or `printf`;
  - `git commit -m|-am|--message`, and (codex-recheck SEC-EXECUTABLE-QUOTE) `git grep`/`git log --grep` ONLY
    when `grep`/`log` is genuinely the git SUBCOMMAND of that segment (found by walking past `git`'s own global
    options `-c <k=v>`/`-C <path>`/`--git-dir=…`/`--work-tree=…`) — a `-c alias.x=<value>` or any other later
    argument that merely equals the word "grep" no longer gets its value mistaken for an inert search pattern;
  - `.claude/forge-dashboard/log-event.cjs`;
  - the search tools `grep`, `rg`, `egrep`, `fgrep`, `ag`, `Select-String`, `findstr` (a search tool never
    executes its pattern — this was already correctly scoped to the tool being the segment's OWN command).

  This applies only when that segment is not piped (into anything) and nothing is piped into an interpreter.
  **Codex-recheck 2026-09-24 (S02) — PowerShell smart quotes:** this scanner understands straight ASCII quotes
  only, and PowerShell also accepts the Unicode "smart quote" pair (`' ' " "`) as real string delimiters — a
  straight-quote-only scan can misjudge where such a string actually ends, hiding a live command inside what
  looks like inert echo data. Rather than replicate PowerShell's own open/close matching, a PowerShell command
  containing ANY smart quote refuses the data exception entirely (fail closed, nothing stripped).
- **Review L1:** a region is NEVER stripped when an interpreter (`bash`, `sh`, `zsh`, `node`, `python*`,
  `pwsh`, `powershell`, `cmd`, `eval`, `source`, `.`, `iex`, `xargs`, `chmod`) or a layout/rename command
  (`mv`, `ln`, `mklink`, `cp`, `rename`, `Move-Item`, `Copy-Item`, …) appears ANYWHERE later in the same
  command. So write-then-run stays classified, e.g. `… > x.txt; mv x.txt x.sh; bash x.sh`, or `… | sh`.

**What stays classified.**
- `bash <<'EOF'`, `bash -c "…"`, `node -e '…'`, `echo "…" | bash`, `echo "…" | cat`.
- `X='…'; $X`, and `$(…)` inside double quotes.
- An escaped quote outside quotes (`it\'s`), a PowerShell lone `&`, ANY PowerShell command containing a smart
  quote (S02, fail closed).
- `grep -l "pkill" . | xargs kill`.
- A `git -c alias.x='<payload>' <alias>` invocation, even next to an unrelated trailing `grep` argument
  (SEC-EXECUTABLE-QUOTE) — the quoted value is preserved because `grep` was not the actual subcommand.

All of these are proven in `forge-gate-hook.test.cjs` section 4c. Measured live on 2026-09-24:
`grep -rn "taskkill /IM" …HOOKS_OPT_IN.md` PASSED, and `echo "git reset --hard" | cat` was BLOCKED.

### Scratch pass-through (WP16 follow-up, review L2, security L3, codex-recheck I01/I02)

**Why.** Once warnings became blocks, the config's own price counts would have stalled every agent. The count
is now 62 of 90 legitimate cleanup commands after security H1; examples are `rm -rf ./_scratch/run-1` and
`rm -r ./_scratch/x`. So the hook, not the classifier, makes one narrow exception.

**The rule.**
- It applies to every command whose destructive-delete SHAPE is present — **not only** when the classifier's
  own verdict names `destructive-delete` (codex-recheck 2026-09-24, I01/ISO-SCRATCH-SHORTCIRCUIT): the
  classifier's 16-literal except-valve (`rm -rf node_modules`, `rm -rf _scratch`, and their `Remove-Item`/
  `rimraf` siblings) is supplemental detection for the classifier's OWN advisory verdict, never an enforcement
  shortcut for this hook. `rm -rf node_modules` on its own still passes (with a notice), but `mv src _scratch;
  rm -rf _scratch` — the delete segment is byte-identical to an excused literal, but the real content being
  destroyed is `src`, moved there first to disguise it — now BLOCKS, because it is still routed through the
  same cwd/layout/exec-token and containment checks below.
- The pass-through itself still only ever emits its "allowed" notice when NO OTHER command gate fired alongside
  the delete shape (a delete next to `taskkill`/`git reset --hard` still blocks on the other gate).
- EVERY segment of the command must itself be a provable delete (review L2). So `rm -rf ./_scratch/x && npm ci`,
  `git mv …`, `/bin/mv …` and `command mv …` all block.
- There must be no `{ } ( )`, and no `cd`, `pushd`, `Set-Location`, `mv`, `cp`, `ln`, `mklink`, `New-Item`,
  `builtin`, `command`, `exec` or `env` as ANY token (security L3).
- Every target must resolve inside one of the areas below. Resolution means: against the payload's `cwd`, on
  real paths (a link is judged by where it points), and case-insensitively on Windows. The areas:
  - `<root>/_scratch`;
  - any `node_modules/` or `dist/` path segment below the root;
  - strictly inside `<root>/.claude/forge-backups/`;
  - `<root>/.claude/forge-runs/**/gate-output`;
  - `<root>/command-center/.data/tmp`;
  - strictly inside the OS temp dir (`os.tmpdir()`), ONLY for targets outside the project root.

  **Eindtest fix (2026-09-24).** A fresh install into a project that itself lived under `%TEMP%` passed EVERY
  delete, e.g. "`<tmp>/…/proj/src`", because the temp rule swallowed the whole project. The protected roots are
  now:
  - this hook's own project root;
  - `CLAUDE_PROJECT_DIR`, or the call's `cwd` when that variable is not set.

  All are realpath-resolved, with these rules:
  - A target that IS a protected root, or CONTAINS one (an ancestor folder), never passes.
  - A target INSIDE a protected root passes only through the named scratch sub-areas above.
  - The temp rule applies only to targets outside every protected root.
  - **Codex-recheck 2026-09-24 (I02) — a canonicalization FAILURE is never treated as proof.** If `realpath`
    cannot resolve the target, a protected root, the temp dir, or the project root itself (a permission error,
    a broken link), the scratch exception is refused outright rather than silently substituting the unresolved
    lexical path — a stale/failed proof can never accidentally look like containment.

  This is proven in `forge-gate-hook.test.cjs` section 4d, by a hook copied into a project made with
  `fs.mkdtempSync(os.tmpdir())`. There, `rm -rf src`, `rm -rf .`, `rm -r ./src`, `rm -rf .claude`, the project
  itself and its parent folder are blocked, while `rm -rf ./_scratch/x` and a sibling temp dir still pass. The
  whole suite was also re-run from such a tmp-located copy: 160/160. The same run with the fix removed gives
  132 passed, 28 failed.
- It then passes with exit 0 and one stderr line naming the targets.

**What still blocks, each tested in section 4b:**
- `.`, `*`, globs, and `..` anywhere in a target (refused outright).
- `~`, `$VAR`, `$env:X`, `%VAR%`, drive roots and `/`.
- `src`, `.claude`, `.git` and `build`.
- A redirection, a `-Param:value` flag, and `/s`-style switches (a path in Git Bash and PowerShell).
- A `\` path under the Bash tool.
- A pipeline delete, and `git rm`.
- A pass-through that errors internally keeps the block (fail-CLOSED).

**Live proof, 2026-09-24:**
- `rm -rf ./_scratch/probe-dir` on a directory created for the test PASSED, and the directory was really gone.
- A payload probe of `rm -r ./_scratch/probe-x` passed, and `rm -r ./src` was blocked.

**Limits (honest):**
- It reasons about the file system at the moment the hook runs.
- `dist/` and `node_modules/` are trusted by NAME.
- Anything inside the OS temp dir passes, but only outside the project root. That includes another tool's
  temp files.
- The Git Bash `/tmp` alias is not mapped, so it blocks (a safe false block).

**Cost.** Measured by `forge-gate-hook.test.cjs`: a real spawned hook takes about 66–104 ms on this machine
(best of 5, then median, across runs), and most of that is Node starting up. The test's hard budget is 1000 ms
(env `FORGE_GATE_HOOK_TIMING_MS`); 200 ms is an advisory line only (review L9), so a slow CI runner or a
beginner's doctor cannot turn red on timing. The hook writes nothing to disk and nothing to stdout.

**Fail-safe rules (security M2).**
- A missing or damaged `FORGE_CONFIG.json`, or a missing `forge-config.cjs`, leaves the gate ON (the schema
  default).
- If `hard-gates.json` or the classifier cannot load, a fallback regex BLOCKS the obviously destructive verbs
  (`rm`, `Remove-Item`, `rd`, `rmdir`, `del`, `taskkill`, `Stop-Process`, `pkill`, `killall`, and `git` with
  `reset`, `clean`, `checkout`, `restore`, `switch` or `stash`). Everything else exits 1 with "classifier
  unavailable — this call was NOT checked".
- Any other internal error, an oversized payload, or a stdin error or timeout exits 1 (visible, not blocking).
  A broken hook never breaks a session, and never hides that it did not check.
- **Codex-recheck 2026-09-24 (C01) — a call this hook cannot actually judge is NEVER silently allowed.**
  Unparseable stdin, a null/array/string payload, or a shell tool with a missing/non-string command now exits 1
  with a visible "… this call was NOT checked" line — exactly like an internal error. Silent exit 0 is reserved
  for a call the hook can POSITIVELY tell is unrelated: a real `PostToolUse` (or other non-`PreToolUse`) event,
  a recognised non-shell tool (`Write`, `Read`, `Edit`, …), or a genuinely empty/whitespace-only command (which
  runs nothing, so there is nothing to classify).

**Proof.** `forge-gate-hook.test.cjs` is 188/188 (up from 142/142 after the codex-recheck 2026-09-24 remediation
— wp-f1: C01/S01–S07/I01/I02/D01/S03/S04). It uses real spawned processes with hermetic `FORGE_CONFIG_HOME` and
`FORGE_PROJECT_ROOT` temp dirs, and includes a fixture tree with `hard-gates.json` removed. The scratch-area
lexer (`tokenize`/`realish`/`areaOf`/`scratchPassThrough`) now lives in its own file, `forge-gate-scratch.cjs`,
split out from the hook to keep both under 500 lines; an absent copy fails closed (no pass-through, ever). Live
proofs in a real Claude Code session, 2026-09-24:
- `echo probe git checkout .` was blocked by both the relative and the `$CLAUDE_PROJECT_DIR` command forms.
- `echo probe rm -r ./src` was blocked (H1).
- `echo probe git switch -f main` was blocked.
- The quoted-data probes passed.
- `rm -rf ./_scratch/probe-dir` passed.

### Honest limits (not hidden)
- **It sees Bash and PowerShell command TEXT only.** It inherits every blind spot of the classifier, which
  `hard-gates.json` → `_not_caught` lists and executes. Examples: `npm run clean`, `node -e "require('fs').rmSync(…)"`,
  an encoded command reaching PowerShell by any route other than the `-EncodedCommand` flag (the flag itself
  now fires `opaque-exec` on its shape; the payload is still never decoded),
  `robocopy /MIR`, `git checkout src/app.js` written without `--` (deliberately left open: it has exactly the
  same shape as the branch switch `git checkout main`, and closing it would block that everyday command too),
  and `kill -n node` (PowerShell's kill alias with a -Name prefix; POSIX `-n` is a signal number). Codex-recheck
  2026-09-24 (S03) closed the sibling gap for `iex $cmd`/`Invoke-Expression $cmd`/`eval`/`sh -c "$VAR"`/a pipe
  into an interpreter — those now fire `opaque-exec` — but it cannot see the Write or Edit tools.
- **Text gates and `write-outside-root` are not enforced here.** Text gates match spoken intent. Blocking on
  them would hit legitimate flows: a push to the authorised remote, `git commit -m "deploy notes"`, editing
  the authorised distribution copy.
- **Over-warns the rules cannot prove are blocked calls.** Examples: a cleanup with a variable or glob; prose
  that quotes a command outside a recognised data position (`echo probe git checkout .`); `git restore -S
  <path>` (the gate is case-insensitive, so only the long `--staged` is treated as safe); `gsutil -m rm -r`
  (the H1 lookbehind expects exactly `gsutil rm`).
- **The owner and the agent cannot be told apart.** The self-disable block stops an agent's Bash/PowerShell
  off-switch, but not a Write/Edit of `FORGE_CONFIG.json` (see the optional hardening above).
  - A `--once` quote could be invented by the agent. The one-off expires after 10 minutes, and every call it
    would have blocked shows the quote.
  - `set_by` in the config reads `owner /forge config set` whoever ran it.
- **Owner bash mode (`!`) is inferred, not reproduced.** A subagent cannot type `!`. That these commands
  bypass the tool hook comes from Claude Code's documentation of bash mode.

## 6b. `permissions.deny` — secrets stay out of Claude's Read tool (LIVE)

The deny list now holds 29 rules (wp-f2, 2026-09-24 Codex re-check SECRET-READ-GAPS closed the two gaps
below; wave 6 of the same recheck added the owner-approval secret):
- the 9 root-level ones: `./.env`, `./.env.local`, `./.env.*.local`, `./.env.development`, `./.env.production`,
  `./.env.staging`, `./.env.test`, `./.env.forge-setup`, `./secrets/**`;
- plus security L5 (and SECRET-READ-GAPS): `./**/.env`, `./**/.env.local`, `./**/.env.*.local`,
  `./**/.env.development`, `./**/.env.production`, `./**/.env.staging`, `./**/.env.test`,
  `./**/.env.forge-setup`, `./**/.env.prod`, `./**/.env.bak`, `./**/.env.backup`, `./**/*.pem`, `./**/*.key`,
  `./**/id_rsa*`, `./**/id_ed25519*`, `./**/secrets/**`, `~/.claude/.credentials.json`, `~/.claude/nvidia.env`,
  `~/.ssh/**`;
- plus the usage guard's owner-approval secret (Security Boss sec-w5 M5, 2026-09-24 wave 6):
  `./.claude/config/forge-owner-grant.txt` — the file `forge-ownergrant.cjs` reads to verify an `override-on`
  grant. If Claude could read it, an agent could quote the owner's secret back and grant itself an override; the
  same file and the grant record are also gitignored (source `.gitignore` + `templates/gitignore.snippet`).

All of them are in the `Read(...)` form. `.env.forge-setup` (the file README.md/AI-INSTALL.md tell a beginner
to fill with keys during setup) previously had no rule at all, root or nested; `.env.development`,
`.env.staging` and `.env.test` previously had a root rule but no `./**/` nested equivalent, unlike every other
`.env.*` variant — both were real coverage gaps in the Read tool itself, independent of the acknowledged shell
bypass below.

**Why:** without these rules Claude can read a secret straight into its context, and from there into logs,
transcripts and reports. The rule form (`Read(./.env)`, `Read(./secrets/**)`) is the one in the official
permissions docs, as quoted in `web-track-a.md` S19. `./` means "relative to the working directory", and
`./**/` covers nested apps too.

**`.env.example` stays readable on purpose.** `Read(./.env.*)` would also match `.env.example`, and a deny rule
cannot be undone with an allow rule, because deny always wins. Every Forge build records new variables in
`.env.example`, so the secret names are listed one by one; the suite asserts that no rule matches it.

**Not covered (honest):**
- **Reading a secret through the shell** (`cat .env`, `Get-Content .env`). Deny rules govern Claude's Read
  tool, not the commands a shell runs. The gate hook does not treat a read as a destructive command either.
- Unlisted names such as `.env.staging2` or any other variant not in the 29-rule list above.

**No `_doc` key inside `permissions`.** Claude Code is proven to tolerate an unknown key on a hook-matcher
object: the existing `_matcher_doc` is there and the ledger keeps recording. It is not proven to tolerate one
inside `permissions`. A rejected file would silently switch off all five hook entries and these rules, so the
explanation lives in the gate-hook entry's `_doc` and here.

---

## Existing projects: merged automatically, not "merge by hand" (wp22, 2026-09-24)

Before 2026-09-24, a project that already had its own `.claude/settings.json` got the template's version
written next to it as `settings.forge-recommended.json` with an instruction to "merge what you want by
hand" — both from `install.sh`/`install.ps1` and from `forge-sync install`/`sync-all`. That contradicted the
owner directive "Forge does it for you — never tell the user to run or merge something by hand", and it meant
a pre-existing project's `.claude/settings.json` never received the gate hook or the deny rules on upgrade.

**Now:** the installers and `forge-sync install`/`sync-all` all call the same dedicated tool,
`forge-bin/forge-settings-merge.cjs` (generalises `forge-snapshot-settings.cjs`'s proven merge-safety model —
pure function, deep-clone, append-only, exact matcher+command match, idempotent — from the 2 snapshot hooks
to every `hooks.<event>[]` entry plus `permissions.deny`). Absent `settings.json` -> created (a copy of the
template's). Present -> MERGED: every foreign hook entry, foreign `permissions.allow`/`ask` rule, and unknown
top-level key is kept byte-for-byte at its original position; a matcher partially present tops up only the
missing hook(s) instead of duplicating the whole entry; the template's own hooks (including the gate hook) and
deny rules are added; a stale pre-2026-09-24 millisecond-as-seconds Forge hook timeout is fixed in place. A
backup of the pre-merge file is written first, EXCLUSIVELY and uniquely named
(`<file>.forge-bak-<yyyyMMdd-HHmmss>-<random>`, wp-f2 2026-09-24 hardening: never overwrites a prior recovery
file, and refuses outright if its own directory is a symlink/junction) — find the latest one with
`ls <file>.forge-bak-*` (POSIX) or `Get-ChildItem` (PowerShell) and `diff`/`Compare-Object` it against the
merged file. A genuinely unreadable (not just "absent" — a directory, a symlink, or a permission error never
counts as absent), malformed, unexpectedly-shaped, or round-trip-unsafe (a duplicate JSON key, or a number
whose value would change on reserialize) existing `settings.json` refuses instead and writes a uniquely-named
`settings.forge-recommended-<stamp>-<random>.json` next to it — reported plainly, never silently, and the
existing file is never touched. A concurrent edit detected immediately before the write (someone else changed
`settings.json` between when Forge read it and when it would have written) also refuses rather than silently
discarding that edit. Re-running the installer or `forge-sync install` a second time is a true no-op: nothing
is rewritten and no new backup is taken; a pre-existing duplicate-matcher condition (however it got there) is
reported on the result, never silently auto-repaired.
`node .claude/forge-bin/forge-settings-merge.cjs check --target .claude/settings.json --source <template>/.claude/settings.json`
answers "is this project's settings.json behind the template?" without writing anything.

## Disabling / revoking

Delete the relevant entry from `.claude/settings.json` (project-local) or `~/.claude/settings.json` (global) —
or delete `.claude/settings.json` entirely to return this project to the zero-project-local-hook default
(the global config, including the snapshot hooks there, is unaffected by deleting the project-local file).
Every mechanism in this file still works as a manual CLI afterward — disabling a hook never removes the
capability, only its automatic firing. For the gate hook (section 6) the lighter switch is
the owner's `/forge config set gate-hook off`: the entry stays wired and, while off, exits 1 with a visible
"FORGE GATE is OFF … this would have been blocked" line for every call it would have stopped.

## Why sections 1-3 stay opt-in (never installed) while sections 4-6 are live
- The project `CLAUDE.md` states the security posture explicitly: no mandatory gates, no `secrets-guard`/`prod-deploy-guard` hooks, normal builds not slowed by blocking. A default-on ENFORCEMENT hook (lock/doctor/secret-scrub-as-a-gate) would contradict that, so sections 1-3 stay documented-only.
- Section 4 is different in kind: it is purely **advisory continuity tooling** (it writes a markdown file and re-injects a short summary; it never blocks, never gates, never enforces anything), and the owner explicitly asked for it to be live, "dit geldt ook voor globaal" — so it was turned on for real, with a backup + a proven-safe merge first.
- Section 6 (gate hook) IS an enforcement hook, and it departs on purpose from the first bullet — for the
  four command gates only. The owner decided it (v2.7.0: the `gate-hook` setting, default ON, in
  `FORGE_CONFIG_SCHEMA.json`) after the beginner research showed prose rules do not stop a destructive
  command. It is scoped to Bash/PowerShell calls that trip `destructive-delete`, `kill-by-name`,
  `git-destructive` or (since the 2026-09-24 codex-recheck) `opaque-exec`; everything else stays advisory. It
  is a classifier, not a proof — what it does not recognise it does not stop (`hard-gates.json` →
  `_not_caught`). The owner switches it off with one command; an agent's own attempt is blocked. CLOSED
  2026-09-24: the project `CLAUDE.md` security-posture paragraph and `precedence.md` now name this exception
  with the same four gates and the same caveat.
- The global governance (`~/.claude` policies) requires **per-item owner approval** before any hook is enabled — pinned purpose, reviewed command, documented disable procedure. This file is that documentation for every hook, live or not.
