# Forge settings — every switch in one place

> **Nederlands, kort.** Alles in Forge staat standaard **aan**. Met één commando zie je elke instelling, met
> de waarde, waar die vandaan komt en wat hij doet: **`/forge config list`**. Iets veranderen gaat ook met één
> commando, bijvoorbeeld `/forge config set usage-guard.pause-at 97`. Nog makkelijker: zeg het gewoon in de chat
> ("zet de usage guard op 97%", "vraag me niet meer bij elke fase"). Forge voert het commando zelf uit en zegt
> in één zin wat er veranderd is. Je hoeft nooit zelf een bestand te openen of een commando te typen.

Forge has **36 settings** in three groups, plus **7 locked rules** that are always on. Everything is **on by
default**. You can see and change any setting with one command, or by simply saying it in chat.

> [!TIP]
> **You never have to type these commands.** Say what you want ("turn off the codex review", "pause at 95
> percent") and Forge runs the right command itself, then repeats its result in one plain line.

---

## The commands

All of these work inside Claude Code in a project where Forge is installed. They need the full install (the
LITE plugin has no settings file to write to).

| You type | What happens |
|---|---|
| `/forge config list` | Shows every setting with its value, where the value comes from and what it does. The advanced ones are hidden. |
| `/forge config list --all` | The same, including the advanced settings. |
| `/forge config get <setting>` | Shows the current value of one setting. |
| `/forge config set <setting> <value>` | Changes a setting. Machine-wide settings (see "Saved for" below) are saved for all your projects automatically. |
| `/forge config set <setting> <value> --global` | Saves the value for all your projects instead of only this one. |
| `/forge config unset <setting>` | Removes your own value, so the default applies again. |
| `/forge config reset` | Removes all your own values in this project. Forge asks you once ("everything back to the defaults?") before it really does it. |
| `/forge config explain <setting>` | Explains one setting in full: on/off, what it does with your data, who reads it, how to undo it. |
| `/forge config diff` | Shows which settings changed since last time. |
| `/forge config parse "<sentence>"` | Turns a plain sentence into the exact `set` command. It changes nothing. |

**Values.** On/off settings accept `on`/`off`, and also `aan`/`uit`, `yes`/`no`, `ja`/`nee`, `true`/`false`.
Numbers must stay inside the range shown below; Forge refuses a wrong value and tells you why, without saving
anything.

**For the curious.** The terminal form is `node .claude/forge-bin/forge-config.cjs <command> ...`. Add
`--lang nl` or `--lang en` to choose the language, and `--ascii` on an old Windows console that shows strange
characters.

---

## How Forge picks a value

When the same setting is set in more than one place, the highest one below wins:

1. **A flag for one run only** (`--flag <setting>=<value>`). It is never saved.
2. **This project's file**: `.claude/FORGE_CONFIG.json`.
3. **Your machine-wide file**: `~/.claude/FORGE_CONFIG.json` (on Windows: `%USERPROFILE%\.claude\FORGE_CONFIG.json`).
4. **Product default** from the owner profile that ships with Forge (read-only).
5. **The built-in default** in the table below.

A setting marked **this computer** is machine-wide: a value for it in a project file is ignored, and
`/forge config list` says so in a note.

**Forge notices changes by itself.** At the start of every run Forge compares your settings with the previous
run. When something changed, it logs one `config_changed` event and tells you in plain words, for example
"you set usage-guard.pause-at to 97 — applied". A change to a usage-guard setting reaches the running guard
only after a restart; Forge does that restart for you.

A damaged settings file is never treated as "no settings": Forge refuses to change anything until the file is
fixed, and says which file and why.

---

## What `/forge config list --all` shows

This is the real output of `node .claude/forge-bin/forge-config.cjs list --all --lang en --ascii` on a fresh install (installer run into an empty project folder named `proj`, empty home, so every value is still its default; captured on 2.7.0 and re-checked line by line against the 2.7.2 tool output):

```text
Forge settings - project "proj" (everything is ON by default; change it with one command)

Status  Setting                      Value                    From             What it does
------  ---------------------------  -----------------------  ---------------  ----------------------------------------

== On by default - Forge uses this on every run ==
ON      usage-guard                  on                       default          Pauses Forge automatically when your
                                                                               Claude usage nears the limit. It measures
                                                                               on an interval (2 minutes by default), so
                                                                               this is a pause before the limit, not a
                                                                               guaranteed instant block. [1]
ON      usage-guard.pause-at         98 %                     default          Forge pauses at this percentage of your
                                                                               usage limit.
ON      autonomy                     continue-within-mission  product-default  Keeps working across phases without
                                                                               asking 'continue?' each time. STOP always
                                                                               works; deploy/push/spend/DNS/production
                                                                               always ask first.
ON      start-gate                   off                      default          Does not wait for a START before building
                                                                               - the plan is posted and work continues
                                                                               immediately (say STOP to pause).
ON      gate-hook                    on                       default          A real stop (not advice) on dangerous
                                                                               commands: recursive deletes, killing
                                                                               processes by name, git commands that
                                                                               throw away uncommitted work, and commands
                                                                               that hide what they run (eval, a pipe
                                                                               into a shell). Forge asks first.
ON      git-checkpoint               on                       default          Creates a local git safety point (commit
                                                                               or branch, never pushed) before a bigger
                                                                               build so everything can be undone.
ON      intake                       silent                   default          Answers the intake questions itself from
                                                                               your request and the project; asks at
                                                                               most one multiple-choice question (2-3
                                                                               options), only when two readings would
                                                                               lead to materially different builds or
                                                                               when something must be sent, paid or
                                                                               deployed.
ON      prompt-doctor                on                       default          Checks your request for the classic traps
                                                                               (vague goal, no definition of done, no
                                                                               context) and fills the gaps itself or
                                                                               asks the one targeted question.
ON      explain-mode                 on                       default          Forge explains each phase in one plain
                                                                               sentence - what it is doing and why -
                                                                               useful when you are new.
ON      dashboard                    on                       default          Starts the Forge Command Center (this
                                                                               machine only, 127.0.0.1:4100) so you can
                                                                               watch the agents live.
ON      codex-review                 auto                     default          Has an independent second AI (OpenAI
                                                                               Codex) review important code when the
                                                                               codex CLI is installed and logged in on
                                                                               your machine. Never a blocker. [2]
ON      model-tiering                on                       default          Runs heavy agents on the strongest model
                                                                               and simple tasks on a cheaper one so your
                                                                               quota lasts longer.
ON      nvidia                       on                       default          Uses NVIDIA models for bulk work when you
                                                                               put an NVIDIA_API_KEY in .env; without a
                                                                               key nothing happens. [3]
ON      agent-memory                 on                       default          Agents remember lessons from earlier runs
                                                                               of this project (passwords and keys are
                                                                               always redacted).
ON      snapshots                    on                       default          Saves the mission when the conversation
                                                                               is compacted so Forge never forgets what
                                                                               it was doing after a long session.
ON      tool-log                     on                       default          Records which files agents change (in
                                                                               .claude/forge-runs/_toollog/, not in
                                                                               git).
ON      ui-quality                   on                       product-default  Websites and apps are only done with real
                                                                               desktop, tablet and phone screenshots and
                                                                               a real quality check.
ON      real-file-testing            on                       product-default  For money, invoices, parsers and data:
                                                                               tests on your real sample files, not on
                                                                               made-up data.
ON      research-first               on                       product-default  Looks up existing solutions and
                                                                               documentation before building anything
                                                                               new.
ON      council                      auto                     default          On doubtful or risky choices Forge brings
                                                                               in several advisors (costs extra tokens;
                                                                               only when the signal is real).
ON      docdrift                     on                       default          Checks that the documentation Forge
                                                                               relies on still matches the real tools
                                                                               (n8n, Claude Code) before using it.
-       language                     auto                     default          Language Forge speaks to you in (auto =
                                                                               the language you write in; code and
                                                                               technical docs stay English).
-       team-max                     auto                     default          Maximum agents at once (auto = Forge
                                                                               picks the smallest team that fits: small
                                                                               work 1-3, large work up to 12).

== Available when needed - Forge uses it without asking ==
ON      tournament                   auto                     default          Builds several variants and picks the
                                                                               best when no approach is clearly right
                                                                               (costs N times as much).
ON      code-index                   on                       default          Keeps an index of your code so agents
                                                                               find the right files faster.
ON      portfolio                    on                       default          May reuse lessons from your other Forge
                                                                               projects when you ask (read-only, never
                                                                               passwords). [4]
ON      skill-proposals              on                       default          Forge may propose a new skill when it
                                                                               sees a real gap; activating it always
                                                                               stays your decision.
ON      nightshift                   on                       default          May resume an interrupted run itself and
                                                                               write a morning briefing; never schedules
                                                                               itself.
ON      mcp                          on                       default          May use external tools (MCP servers) you
                                                                               enabled yourself; never installs or
                                                                               activates one on its own. [5]
OFF     paperclip                    off                      default          Local agent runtime (127.0.0.1:3100) with
                                                                               agents that keep working unattended. OFF:
                                                                               it uses your quota while you are not
                                                                               watching, so only when you explicitly ask
                                                                               for it (Forge decision 2026-07-04). [6]
-       cleanup                      report                   default          Old backups and logs: report only
                                                                               (default) or clean up automatically
                                                                               (deletes files older than 14 days, keeps
                                                                               the last 5). [7]

== Advanced - change only if you know why ==
ON      usage-guard.resume-at        0 %                      default          Forge resumes on its own once usage drops
                                                                               to this percentage (0 = only after your
                                                                               limit resets).
ON      usage-guard.interval         120 s                    default          How often (in seconds) the guard measures
                                                                               your usage.
ON      usage-guard.nvidia-shift-at  80 %                     default          From this weekly percentage Forge prefers
                                                                               NVIDIA models for bulk work (a hint only,
                                                                               pauses nothing).
OFF     ecc-full-test                off                      default          Extended ECC diagnostics (inventory,
                                                                               permission tests). Heavy and noisy - only
                                                                               for hunting an ECC problem.
-       budget-usd                   5 USD                    default          Cost ceiling per unattended run (claude
                                                                               -p); your own interactive session is not
                                                                               affected.

Footnotes (what these settings do with your data):
[1] usage-guard (C N U): Reads your Claude login token locally from ~/.claude/.credentials.json (and your account id
    from ~/.claude.json, kept only as a fingerprint) and sends the token only to api.anthropic.com to measure your
    usage; runs as a background process on this machine, also after the session closes, and writes its state/log files
    under ~/.claude. Turning it off stops it after the next check.
[2] codex-review (N $): Sends code to OpenAI through the codex CLI you logged in yourself; without codex nothing
    happens.
[3] nvidia (C N): Sends prompts to NVIDIA's API with your key from .env or ~/.claude/nvidia.env.
[4] portfolio (X): Reads only the .claude/FORGE_* memory files of your other Forge projects, secrets excluded, and
    never writes to them.
[5] mcp (N): Uses only servers from your own opt-in list (.claude/config/orchestration/mcp-opt-in.json).
[6] paperclip (U $): Unattended agents use your quota while you are not watching.
[7] cleanup (D): deletes files
Flags: C = reads credentials - N = uses the network - $ = costs quota or money - U = runs unattended - X = reads
  outside this project - D = deletes files

Notes:
- No settings of your own saved yet (no ~/.claude/FORGE_CONFIG.json and no .claude/FORGE_CONFIG.json) - everything is
  at its default, that is normal.

Locked - always on, never settable: hard-gates (Deploy, git push, spending money, DNS, activating production,
  credentials, sending anything out, killing processes by name, destructive deletes, writing outside your project -
  Forge ALWAYS asks first.) - usage-limit (A real usage-limit pause can never be overridden by any setting.) -
  honesty-core (Forge never claims a test, check or review ran when it did not.) - project-isolation (Forge works only
  in this project folder; never in other projects or your global settings without permission.) - does-it-for-you (Forge
  runs commands and scripts itself - it never asks you to run a file or code yourself.) - never-auto-push (No git push
  unless you ask.) - outreach-draft-only (Emails and messages are drafted only, never sent.)

Change: /forge config set <setting> <value> - Explain: /forge config explain <setting> - Everything: /forge config list --all
```

---

## Every setting explained

> The tables below are written from Forge's settings catalogue,
> `.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json`. They show the **built-in defaults** plus what
> "off" (or another value) means and whether a setting is saved for this project or for the whole computer.
> Your own `/forge config list` shows your live values and where each one comes from.

**Flags** mark what a setting does with your data:
**C** = reads credentials · **N** = uses the network · **$** = costs quota or money · **U** = runs unattended ·
**X** = reads outside this project · **D** = deletes files.

### On by default — Forge uses these on every run

| Setting | Default | Saved for | What it does | Off / other value | Flags |
|---|---|---|---|---|---|
| `usage-guard` | on | this computer | Pauses Forge automatically when your Claude usage nears the limit. It measures on an interval (2 minutes by default), so this is a pause before the limit, not a guaranteed instant block. | Forge does not measure your usage and never pauses by itself. | C N U |
| `usage-guard.pause-at` | 98 % | this computer | Forge pauses at this percentage of your usage limit (50–99). | — | |
| `autonomy` | continue-within-mission | this project | Keeps working across phases without asking "continue?" each time. STOP always works; deploy, push, spend, DNS and production always ask first. | `ask-each-phase`: Forge stops at every phase boundary and waits for you. (`full-auto-within-mission` is also allowed.) | |
| `start-gate` | off | this project | Does not wait for a START before building: the plan is posted and work continues immediately (say STOP to pause). | `l4-only`: only large phased missions wait for START. `always`: every run waits for START. | |
| `gate-hook` | on | this project | A real stop (not advice) on dangerous commands: recursive deletes, killing processes by name, git commands that throw away uncommitted work, and commands that hide what they run (eval, a pipe into a shell). Forge asks first. | The hard gates still exist as classifier and rule, but the hook no longer enforces them. | |
| `git-checkpoint` | on | this project | Creates a local git safety point (commit or branch, never pushed) before a bigger build, so everything can be undone. | No automatic safety point; only what you commit yourself. | |
| `intake` | silent | this project | Answers the intake questions itself from your request and the project; asks at most one question when two targets are equally plausible. | `interview`: Forge asks you the intake questions one at a time. | |
| `prompt-doctor` | on | this project | Checks your request for the classic traps (vague goal, no definition of done, no context) and fills the gaps itself or asks the one targeted question. | Forge takes your request literally, without the trap check. | |
| `explain-mode` | on | this project | Forge explains each phase in one plain sentence: what it is doing and why. Useful when you are new. | Only the short status lines, no explanations. | |
| `dashboard` | on | this computer | Starts the Forge Command Center (this machine only, 127.0.0.1:4100) so you can watch the agents live. | No dashboard; everything is still in the run files. | |
| `codex-review` | auto | this project | Has an independent second AI (OpenAI Codex) review important code when the codex CLI is installed and logged in on your machine. Never a blocker. | `on-request` or `off`: no automatic Codex review; Forge reports honestly that it did not run. | N $ |
| `model-tiering` | on | this project | Runs heavy agents on the strongest model and simple tasks on a cheaper one, so your quota lasts longer. | All agents on your session's default model. | |
| `nvidia` | on | this project | Uses NVIDIA models for bulk work when you put an `NVIDIA_API_KEY` in `.env`; without a key nothing happens. | Never NVIDIA, even with a key. | C N |
| `agent-memory` | on | this project | Agents remember lessons from earlier runs of this project (passwords and keys are always removed). | No new lessons stored; existing memory stays. | |
| `snapshots` | on | this project | Saves the mission when the conversation is compacted, so Forge never forgets what it was doing after a long session. | No snapshot on compaction. | |
| `tool-log` | on | this project | Records which files agents change (in `.claude/forge-runs/_toollog/`, not in git). | No change ledger. | |
| `ui-quality` | on | this project | Websites and apps are only done with real desktop, tablet and phone screenshots and a real quality check. | No mandatory screenshots; Forge visibly logs that you turned this off. | |
| `real-file-testing` | on | this project | For money, invoices, parsers and data: tests on your real sample files, not on made-up data. | No real-file requirement; results are labelled as untested on real data. | |
| `research-first` | on | this project | Looks up existing solutions and documentation before building anything new. | Build directly, without the research step. | |
| `council` | auto | this project | On doubtful or risky choices Forge brings in several advisors (costs extra tokens; only when the signal is real). | `off`: no automatic council; asking for one yourself still works. | |
| `docdrift` | on | this project | Checks that the documentation Forge relies on still matches the real tools (n8n, Claude Code) before using it. | No documentation drift check. | |
| `language` | auto | this computer | The language Forge speaks to you in (`auto` = the language you write in; code and technical docs stay English). | `nl` or `en`. | |
| `team-max` | auto | this project | Maximum agents at once (`auto` = Forge picks the smallest team that fits: small work 1–3, large work up to 12). | A whole number from 1 to 12. | |

### Available when needed — Forge uses these without asking

| Setting | Default | Saved for | What it does | Off / other value | Flags |
|---|---|---|---|---|---|
| `tournament` | auto | this project | Builds several variants and picks the best when no approach is clearly right (costs N times as much). | `off`: always one variant. | |
| `code-index` | on | this project | Keeps an index of your code so agents find the right files faster. | No index; agents search from scratch each time. | |
| `portfolio` | on | this computer | May reuse lessons from your other Forge projects when you ask (read-only, never passwords). | Every project stands completely alone. | X |
| `skill-proposals` | on | this project | Forge may propose a new skill when it sees a real gap; activating it always stays your decision. | No skill proposals. | |
| `nightshift` | on | this project | May resume an interrupted run itself and write a morning briefing; never schedules itself. | No automatic resume or briefing. | |
| `mcp` | on | this project | May use external tools (MCP servers) you enabled yourself; never installs or activates one on its own. | No external MCP tools. | N |
| `paperclip` | **off** | this project | A local agent runtime (127.0.0.1:3100) with agents that keep working unattended. Off by default: unattended agents run only on an explicit request (maintainer decision, 2026-07-04). | `on`: this project opts in. | U $ |
| `cleanup` | **report** | this project | Old backups and logs: report only (default), or clean up automatically. | `auto`: deletes files older than 14 days and keeps the last 5. | D |

### Advanced — change only if you know why

These are hidden from `/forge config list`; add `--all` to see them.

| Setting | Default | Saved for | What it does |
|---|---|---|---|
| `usage-guard.resume-at` | 0 % | this computer | Forge resumes on its own once usage drops to this percentage (0 = only after your limit resets). Range 0–98. |
| `usage-guard.interval` | 120 s | this computer | How often (in seconds) the guard measures your usage. Range 30–900. |
| `usage-guard.nvidia-shift-at` | 80 % | this computer | From this weekly percentage Forge prefers NVIDIA models for bulk work (a hint only; it pauses nothing). Range 50–99. |
| `ecc-full-test` | **off** | this project | Extended ECC diagnostics (inventory, permission tests). Heavy and noisy; only for hunting an ECC problem. |
| `budget-usd` | 5 USD | this project | Cost ceiling per unattended run (`claude -p`); your own interactive session is not affected. Range 0.25–25. |

### Why three things stay off

"Everything on" has three deliberate exceptions:

- **`paperclip`** runs agents unattended, and they use your quota while you are not watching. It starts only when
  you ask for it.
- **`cleanup`** stays on `report`, because `auto` deletes files.
- **`ecc-full-test`** is heavy diagnostics, only useful when hunting a specific problem.

---

## Locked — always on, never settable

These are not settings. `/forge config` shows them so you can see them, and refuses to change them.

| Rule | What it means |
|---|---|
| `hard-gates` | Deploy, git push, spending money, DNS, activating production, credentials, sending anything out, killing processes by name, destructive deletes, writing outside your project — Forge ALWAYS asks first. |
| `usage-limit` | A real usage-limit pause can never be overridden by any setting. |
| `honesty-core` | Forge never claims a test, check or review ran when it did not. |
| `project-isolation` | Forge works only in this project folder; never in other projects or your global settings without permission. |
| `does-it-for-you` | Forge runs commands and scripts itself; it never asks you to run a file or code yourself. |
| `never-auto-push` | No git push unless you ask. |
| `outreach-draft-only` | Emails and messages are drafted only, never sent. |

---

## What the usage guard does with your data

The usage guard is the only setting that is on by default and reads a credential, so here it is in full:

- It reads your Claude login token **locally** from `~/.claude/.credentials.json` and sends it **only** to
  `api.anthropic.com`, to measure your usage. It runs as a background process on this computer.
- It prints this disclosure (in Dutch and English) the moment it really starts a new watcher, not when one is
  already running, followed by the one command that switches it off: `/forge config set usage-guard uit`
  (`off` works too).
- When your 5-hour window or your weekly limit reaches 98 %, the guard marks your account as paused. Forge
  checks that mark before every new phase and stops there (best effort: it measures every 2 minutes, so a
  step can still cross the limit between two samples); it continues after the reset. On any error the guard does nothing (fail-safe), and it never logs or prints your token.
- When the guard is switched off it makes no call at all, with exactly two exceptions you have to ask for: an
  explicit `--force` on a read-only measurement (`check`, `status`, `credits` — one measurement, never a resume,
  never a setting change) and a verified owner grant for `override-on`, the only action that resumes paused agents.

More about limits and cost: [TOKEN-USAGE.md](TOKEN-USAGE.md).

## What the gate hook stops, and what it cannot see

The `gate-hook` setting is the only one that blocks a command before it runs, so its limits are spelled out here.
It is a **classifier over the command text**, not a proof: what it does not recognise, it does not stop.

**It stops (exit 2, with a plain reason in Dutch and English):**

- recursive deletes, with or without a force flag, in Bash and PowerShell (`rm -r`, `Remove-Item -Recurse`, the
  legacy `rd /s` / `rmdir /s`), except provable cleanups inside `_scratch`, `node_modules`, `dist` or the system
  temp folder outside your project;
- killing programs by name (`taskkill /IM`, `pkill`, `Stop-Process -Name`, also through `pgrep`/`xargs`);
- git commands that throw away uncommitted work (`git reset --hard`, `git checkout .`, `git restore <path>`,
  `git switch -f`, forced `git clean`, forced worktree removal);
- commands that hide what they run: `eval`, `iex` / `Invoke-Expression` as the command of a statement, `sh -c` /
  `bash -c` / `pwsh -c` on a variable or substitution, a pipe straight into a shell, an encoded PowerShell command;
- the assistant's own attempt to switch this setting off, in the spellings the hook recognises.

**It cannot see (named, tested gaps — the full list lives in `.claude/config/orchestration/hard-gates.json`
under `_not_caught`, and each one is executed by the test suite so the list cannot go stale):**

- a dangerous command **inside a file** it is asked to run: `npm run clean`, `./scripts/reset.sh`, a git hook, a
  `Makefile` target, `pwsh ./tools/wipe.ps1` — the hook sees the innocent-looking invocation, not the file;
- a command **built at runtime** whose dangerous word is never in the text: the target held in a variable fires
  only on the flags, a whole command in a variable fires only through the `opaque-exec` shapes above;
- **other interpreters**: a data stream piped into `node` or `python` as a script, a fully literal
  `sh -c "echo hi"`, an encoded payload reaching PowerShell by any route other than the `-EncodedCommand` flag;
- a bare `git checkout <path>` **without `--`** (it looks exactly like a branch switch), the PowerShell `kill -n`
  alias, mirroring and overwriting tools (`robocopy /MIR`, `rsync --delete`), truncation and raw device writes
  (`dd`, `mkfs`);
- **anything that is not a shell command**: the Write and Edit tools, a symlink or junction created inside the
  project that points outside it, a spawned service;
- **who typed an approval**: a one-off `--once "<words>"` must quote you, covers exactly one command and expires
  within 10 minutes, but the hook cannot verify that you were the one who typed the words — read the approval
  line Claude shows before the command runs.

When the hook cannot judge a call at all (unreadable input, a damaged config, a classifier error) it exits 1 and
says so: visible, not blocking, never a silent pass. The measured coverage and every known limit are kept
current in `HOOKS_OPT_IN.md` (section 6, "Honest limits") in the project's `.claude/config/orchestration/`.

---

<sub>Source of truth: `.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json` (36 settings, 7 locked rules),
read only through `.claude/forge-bin/forge-config.cjs`. Back to the [README](../README.md) ·
[Commands](../COMMANDS-QUICK-REF.md) · [Claude Code basics](CLAUDE-CODE-BASICS.md).</sub>
