# Changelog

All notable changes to **claude-forge** (Forge V2) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Nothing yet. Open a PR — see [CONTRIBUTING.md](CONTRIBUTING.md).

## [2.7.2] - 2026-09-24

Two things in one release. First, loop iteration 1 after 2.7.1: a read-only Deep Learn scan of the whole project, a
scout vetting of every skill and MCP server named in the 98-video beginner research, and the small fixes both
surfaced. Second, and larger: an independent Codex recheck (`gpt-6-astra`, reasoning effort xhigh, six read-only
passes over everything since 2.4.0) returned 85 findings, and every one was fixed with a test, rejected with evidence
or deferred with a written reason before this release went out — see "Security — after the Codex recheck" below. No
feature removed, nothing enabled by default that was off before; several promises in the documentation were made
more honest.

### Added

- **Dormant, opt-in MCP registry entries for beginners' favourites.** `n8n-mcp` (czlonkowski/n8n-mcp, MIT: n8n node
  documentation and workflow validation for `forge-n8n`, read-only, no credentials in that mode) joins `context7`
  (already registered) in `mcp-registry.json`, status `not-installed`; the existing `playwright` entry
  (microsoft/playwright-mcp) gained a beginner-language note and the rule that any write-shaped browser action routes
  through the hard gates. Grants stay least-privilege (Integration Boss → n8n-mcp within its existing tier 1; no
  `max_tier` raised). Nothing is installed, started or connected — the owner opts in by name.
- **Doctor beginner check `settings-wired`** (advisory, never red): confirms the five Forge hooks and the deny rules are
  really present in the project's `.claude/settings.json` via `forge-settings-merge.cjs check`; an honest note when
  there is no settings file or no template to compare against.
- **Scout vetting of the beginner sweep** (`.claude/forge-research/beginner-sweep-2026-09-24/scout-vetting.md`): 13 new
  verdicts in `FORGE_SCOUT_VETTING.json` (39 → 52) — Context7, Playwright MCP, n8n-mcp, Figma Dev Mode MCP approved as
  reference/opt-in; Home Assistant and Sentry MCP reference-only (Sentry's licence is unasserted, so no code is
  vendored); Caveman (source-available proxy that intercepts agent traffic), Taste-Skill and Ponytail (duplicate what
  Forge already ships), Sand Castles, UiPath skills and Higgsfield (out of scope) hard-passed. Eight of the ten beginner
  themes map to an existing Forge feature; the two gaps became this release's doctor checks and registry entries.
- **Doctor beginner check `model-choice-hint`** (info only, never red): one plain sentence about model choice, usage
  limits and cost — routine work on a balanced model, heavier models only for high-risk work, the usage guard pauses
  before the limit, cost is visible with `/costs` and `/insights`. It never tells the user to run anything.
- **Unsafe-advice register** (`forge-prompt-coach/references/unsafe-advice.md`, Dutch first, then English): eight tips
  that circulate in beginner videos and that Forge will not adopt — skipping permission prompts, reflexively trusting a
  publisher, blanket "always allow", unvetted token-compression proxies, hooks installed from a tutorial, and three more
  from the sweep — each with why it is unsafe and what Forge does instead. The doctor's `bypass-mode` warning and the
  prompt coach point to it.
- **Command Center:** a NVIDIA health probe that exits in mock or no-key mode is now shown as `NOT CONFIGURED` instead
  of `DISCONNECTED` (real network failures still show `DISCONNECTED`).
- **Independent Codex review repinned** (owner directive 2026-09-24) to `gpt-6-astra` at reasoning effort `xhigh` in
  `config/orchestration/codex-review.json` (the single source of truth the codex-reviewer agent and the
  forge-code-review skill read), verified live with `--strict-config` on codex-cli 0.156.1; "long thinking" is that
  highest effort level, the CLI has no separate flag. History kept in the file (gpt-5.6-sol, 2026-08-04 → 2026-09-24).

### Security — after the Codex recheck (six `gpt-6-astra` xhigh passes over everything since 2.4.0: 85 findings, 60 high)

Codex (the owner re-enabled it on 2026-09-24) reviewed the whole 2.5→2.7 range read-only and returned NEEDS FIXES;
every finding is archived with its measured evidence in the maintainer's run folder and was fixed, rejected with
evidence or deferred with a reason before this release went out. The code fixes:

- **Settings merge (`forge-settings-merge.cjs` + new `forge-settings-merge-guards.cjs`, installers, sync):** a read
  error is never "absent" (only a verified missing regular file enters the create path — an unreadable existing file is
  refused, never overwritten); the target is re-verified immediately before the rename (a concurrent edit refuses
  instead of being lost); backups and recommended files are created exclusively with unique names and never through a
  link; every write destination must lie inside the real project root (a `.claude` junction pointing elsewhere is
  refused, in `forge-sync` too); source and target shapes are validated deeply (a hook with the right command but the
  wrong `type` does not count as present; partial matcher entries are topped up, never duplicated); content that
  cannot be reserialized losslessly is refused, BOM/line endings/indentation are preserved; file mode is preserved on
  replace and backup (POSIX); a `settings.json` that is a directory is refused by both installers; `forge-sync`
  reports a settings failure as a failed sync (`--unsafe` paths share the same step) and shows the settings preview in
  dry-run; installers create no directory in dry-run, keep the version marker when nothing changed, resolve the home
  directory once, and mark global paths `[OUTSIDE this project]` in the plan; the deny list grows from 23 to 28 rules
  (`.env.forge-setup` and the nested `.env.development/.staging/.test` forms). Deferred with reason: settings.json
  inside the `forge-sync rollback` transaction; migration between gate-hook matcher strings.
- **Config core (`forge-config.cjs` + new `forge-config-once.cjs`, `forge-autonomy.cjs`, `forge-setup.cjs`):** an
  existing usage-limit pause is honoured even when the settings file is damaged or the guard is switched off; persisted
  values must have the canonical schema type (a string `"false"` or `[0]` for a boolean is damage, not a switch); a
  rejected schema is never mined for "safe" values; a project value for a global-scope boolean can only strengthen
  protection; `parseFlagValue()` gives consumers schema bounds; a locked error is reported as a locked error; writes are
  serialized with a lock file and fsynced; `--once` is now single-use — `consumeOnce()` marks the entry consumed
  atomically, a second one-off cannot be armed while one is pending, hand-edited or future-dated expiries are treated
  as expired, and `gate-hook` ignores the global settings file (so `reset` can never expose a hidden global off);
  the git checkpoint scans candidate paths against the secret-name policy (now including `id_ed25519*`) **before**
  staging and repairs `.gitignore` negations that would defeat it. Disclosed residual gaps: a wall-clock rollback inside
  the original ten-minute window; secret-shaped files that were already tracked before Forge arrived.
- **Gate hook (`forge-gate-hook.cjs`, `forge-gate-data.cjs`, new `forge-gate-scratch.cjs`, `forge-actiongate.cjs`,
  `hard-gates.json`):** unparseable, empty or hostile stdin now exits 1 with a visible line ("this call was NOT
  checked") instead of a silent pass; a heredoc-lookalike inside an open quote is no longer stripped as data;
  PowerShell curly quotes do not qualify for the quoted-data exception; a heredoc with a quoted or indented
  destination is recognised; a `git -c alias.x='rm -rf …'` executable is no longer treated as data; kill-by-name is
  matched per statement; the self-disable check parses the real argv (a quoted `"set"` verb, any path to
  `forge-config.cjs`, flags in any order all count); a `--once` approval is consumed by exactly one command through
  `consumeOnce()` (live-probed: first call consumes and allows, the second identical call is blocked); an inspection
  failure while the gate is OFF stays visible and never swallows a self-disable; the scratch pass-through is
  fail-closed (a path that cannot be canonicalised is not "scratch"; `mv src _scratch; rm -rf _scratch` is blocked);
  more git spellings that discard work are covered; the UTF-16LE test fixture is now really UTF-16LE. **New fourth
  command gate `opaque-exec`:** `eval`, `iex`/`Invoke-Expression`, `sh -c`/`bash -c`/`pwsh -c`/`powershell -c`
  evaluating a variable or substitution, a pipe straight into a shell interpreter, and `certutil -decode … & …` are
  stopped because no other gate can see what they would run; mirrored into `FORGE_AUTONOMY.json` `always_interrupt`.
  The gate words fire only in command position (the first word of a statement, also after `FOO=1`, `sudo`, `&&`,
  `|` or a new line): the live hook had blocked the maintainer's own `node probe-heredoc-eval.cjs` (the word inside
  a file name) and a commit message that merely mentioned the word, so a file name, a commit message or prose
  containing `eval`/`iex` is data again. `powershell -EncodedCommand …` (also `-e`, `-ec`, `-enc`) now fires on its
  shape, closing a gap `_not_caught` had named since the gate was introduced; the payload is still never decoded.
  Named gaps stay named: a fully literal `sh -c "echo hi"`, `| node`/`| python`, an encoded payload reaching
  PowerShell by any route other than that flag, and a heredoc line that itself starts with `eval` inside a
  non-writer heredoc such as `git commit -F - <<'MSG'` (a safe false block). Deferred with reason: a bare
  `git checkout <path>` without `--` (a classifier cannot tell a branch from a path without repository state, and a
  blocking hook that fires on `git checkout main` would break the most common everyday git command).
- **Completion honesty (`forge-runcontract.cjs`, `forge-verify.cjs`, `forge-finalize.cjs`, `forge-manifest.cjs`,
  `log-event.cjs`, dashboard `app.js`):** a `proof_verified: false` event no longer satisfies a rule; the domain comes
  from `run.json`, not from a caller flag; an armed manifest is a STALING claim — `manifestCompleteness()` surfaces every
  armed work package that never completed (the previous "inert" classification is reversed; the finalized 2.7.1 run
  now honestly reads HISTORICAL because HEAD moved); an unknown block rule counts as missing, never as green; a proof
  write failure exits 3; `closes_event_id` has a grammar and may be consumed once; a FAIL review verdict keeps the
  review open; a dead worker (started, never completed, dispatch gone) is a gate, not a pass; a malformed or foreign-run
  event is a gate; waivers are owner-only; `finalize` requires `all_green` and re-evaluates the contract on `check`
  (a receipt cannot be forged by editing the JSON); `log-event.cjs` validates the `run_id` it writes into; the dashboard
  mirrors the contract instead of bypassing it. Deferred with reason: an evidence-field schema; tolerance for a missing
  output file.
- **Usage guard, NVIDIA provider, gateway (`usage-guard.cjs` + new `usage-guard-redact.cjs`, `nvidia-provider.cjs`,
  `forge-ownergrant.cjs`, gateway `capabilities.mjs`/`models.mjs`):** a switched-off guard makes no network call at all
  (`check`/`status`/`credits`/`watch --once` refuse; the only exception is a verified owner grant); the token's shape is
  validated before any header is built and transport errors are reported as codes, never with the raw message; the
  refresh-token identity fallback is gone (an opaque local account label instead) and a refusal names a
  project-relative label, never the absolute credential path; a corrupt state file is distinguished from a missing one
  and blocks until a fresh validated measurement; pause/resume/override are serialized with a lock and re-read inside it;
  `stop` clears its timers, aborts an in-flight request on SIGTERM and exits nonzero when it cannot confirm the death;
  the fetch timeout also covers reading the body; the disclosure line is complete and the real watcher logs it before its
  first tick; flag and config values are checked against the schema bounds; the NVIDIA base URL is a fixed single-entry
  allow-list (a custom URL only from the real environment; userinfo, query and fragment always refused; `models.mjs`
  redacts it again); a switch-off is honoured before every retry and cancels the backoff; secrets are masked before
  truncation and on every public return value; the gateway runs its own central `forge-capabilities.cjs` against the
  selected project instead of executing a script from inside that project (a tampered project copy never runs); the test
  suites isolate themselves from the real credential file before their first `require`. **Honest wording, in the code
  too:** `status`/`start` now say "sampled every Ns (best effort — a task can still cross the limit between samples;
  this is not an instant, guaranteed block)", and the docs, the settings description and the doctor's model-choice hint
  say the same instead of "never cut off". Named follow-ups: `forge-autonomy.cjs` does not yet treat a corrupt guard
  state as blocking; `usage-guard.cjs` is due for a further split.

### Fixed

- **Deep Learn no longer alarms beginners with test fixtures.** `forge-deeplearn.cjs` reported 32 HIGH "secret-pattern"
  risks on this very project; every one was a redaction test fixture or a documentation sentence listing the regex
  names, while the doctor's leak scan over 1898 tracked files was clean. A hit under `test/`, `tests/`, `__tests__/`,
  `test-evidence/`, `fixtures/`, `docs/`, `*.test.*`, `*.spec.*` or `*.md` is now reported as MED
  `secret-pattern-fixture-looking` with a pointer to the leak scan as the authority; hits in real code stay HIGH. The
  scanner also logs its own dashboard events as the orchestrator (role `project-scan`) instead of an unregistered agent
  name, which the run contract had correctly refused as an unknown worker.
- **A completed review no longer counts as an open task.** `forge-verify.cjs` and the dashboard (`app.js`, mirrored)
  pair `review_started` with `review_completed` (same agent, same `review_id`; a FAIL verdict keeps it visibly open).
- **Gateway tests are hermetic by default.** `models`, `routes-wp3` and `routes-wp6` no longer make a real NVIDIA
  `GET /models` when a key is present; the live variant is behind `FORGE_GATEWAY_LIVE_NVIDIA=1`.
- **Documentation promises corrected after the Codex recheck** (six `gpt-6-astra` xhigh passes over everything since
  2.4.0; the code findings are listed under Security below): the beginner promise (English and Dutch, now saying the same) says which gates are enforced by
  the hook (destructive deletes, kill-by-name, git commands that discard work, commands that hide what they run)
  and that the hook is a classifier, not a proof — what it does not recognise it does not stop — with the measured
  limits in a new `docs/SETTINGS.md` section "What the gate hook stops, and what it cannot see"; the other gates are
  rules checked by a text classifier (deploy, push, spend, DNS, production, credentials, outbound, writes outside the
  project); every remaining "three gates" sentence (project `CLAUDE.md`, `precedence.md`, `HOOKS_OPT_IN.md`, the
  forge-core skill copies, the unsafe-advice register) was brought to four with the same caveat; the plugin
  table says the LITE install writes nothing but its agents still edit your project when you ask them to build; the
  install guide no longer claims "no service phones home" — it names the usage guard's calls to `api.anthropic.com`,
  the optional Paperclip `npx` download and the on-request `setup-pre-commit` npm use; Node 20.19+/22.12+ is stated
  for building the dashboard yourself (Vite 7); Claude Code's account requirement includes Console/API billing; the
  vendored-skill register says only each wrapper's own operations were inspected (`task-done` runs the command you
  give it, `find-polluter.sh` runs `npm test`); `task-start`/`task-done` call their helpers through `bash` and ship
  with the executable bit; the brand token version follows the release.

## [2.7.1] - 2026-09-24

Patch release, minutes after 2.7.0: the release commit's CI was red on the GitHub runners while every local check was
green. Two causes, both found by the CI matrix and reproduced locally before fixing. Use v2.7.1; the v2.7.0 tag stays for
history and every feature note under 2.7.0 applies to this release unchanged.

### Fixed

- **Temp-folder cleanups were blocked on Windows machines whose temp path is an 8.3 short name.** When `os.tmpdir()`
  reads like `C:\Users\RUNNER~1\AppData\Local\Temp` (the GitHub Windows runners; any Windows account with a user name
  longer than eight characters can see this), the gate hook's pass-through refused the `~` as a possible tilde expansion
  and blocked every temp-folder delete — over-blocking, never unsafe. Bash expands a tilde only at the START of a word,
  so an in-word tilde is now treated as the literal character it is; a leading or `=`/`:`-prefixed tilde stays
  unprovable. Reproduced locally with a short-name temp dir (155 passed / 5 failed → 164 / 0) and covered by tests.
- **`usage-guard.test.cjs`'s control arm was Node-version dependent.** The "torn login file" test asserted that V8
  quotes the input in its `JSON.parse` error message; Node 18 does not, so the suite was red on the Node 18 runners
  although every product assertion (no token fragment, no home path in state, log or output) held. The control arm now
  notes the runtime instead of failing; the leak assertions are unchanged.

## [2.7.0] - 2026-09-24

Release theme: **built for beginners — everything on, one command for every setting, a real safety stop.** The
maintainer's first users do not think in computer terms. Three read-only research tracks (35, 75 and 89 sources) looked
at how beginners should steer an AI, which mistakes they make, and which public skills help them. This release turns the
findings into defaults: Forge does the work, protects the user without being asked, and explains itself in one plain
sentence. Counts for the full install: **19 agents · 72 skills · 102 zero-dependency tool files**; the LITE plugin is
now 18 agents / 22 skills: the plugin copies of the Forge skills and agents were re-synced with the payload (they had drifted since 2.1.0), `forge-prompt-coach` was added, and `gsap/*` + `humanizer` were removed from the plugin (not open-licensed / deliberately not shipped in the full install either).

### Added

- **`/forge config` — every setting in one command.** One catalogue, `.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json`,
  lists **36 settings** in three groups (on by default · available when needed · advanced), each with a Dutch and
  English explanation, plus **7 locked rules** that are shown but can never be set (hard gates, the usage-limit pause,
  the honesty core, project isolation, "does it for you", never auto-push, draft-only outreach). One tool,
  `forge-config.cjs` (with `forge-config-cli.cjs` and `forge-config-text.cjs`), is the only code that resolves,
  validates and writes them: `list [--all] · get · set [--global] · unset · reset --yes · explain · diff · parse
  "<sentence>"`, with `--lang nl|en`, `--ascii` and `--json`. Values live in `.claude/FORGE_CONFIG.json` (project) and
  `~/.claude/FORGE_CONFIG.json` (machine-wide); precedence is one-run flag > project > global > product default >
  schema default. Writes are atomic; a damaged file is refused and nothing is written; a locked rule is refused with
  exit 3. Plain sentences ("zet de usage guard op 97%") are mapped to the exact `set` command.
- **Forge notices a changed setting.** At the start of every run `forge-config.cjs diff --run <run_id> --mark-seen`
  logs one `config_changed` event when a value changed since the last run, and Forge repeats it to the user in plain
  words.
- **The beginner promise**, written into `/forge` and the standing rules (`does-it-for-you`): Forge runs every
  command, script, install and build itself, never asks the user to run a file or code, never asks "shall I
  continue?" between phases, and only stops for the hard gates and a real usage-limit pause.
- **The gate hook** (`forge-gate-hook.cjs`, a `PreToolUse` hook on `Bash|PowerShell`, setting `gate-hook`, on by
  default). Before every shell command it asks the existing hard-gate classifier (`forge-actiongate.cjs` +
  `hard-gates.json`) whether the command is a recursive force-delete, a kill of processes by name, or a git command
  that discards uncommitted work. If so it exits 2: Claude Code blocks the call and shows a plain Dutch/English reason,
  and Claude has to ask the user. A delete whose every target is provably inside a scratch area (`_scratch/`, any
  `node_modules/` or `dist/`, `.claude/forge-backups/*`, the system temp folder for targets outside your project, …) passes.
- **21 vendored public skills and 2 commands**, so a beginner never has to hunt for skills: 13 from obra/superpowers
  (MIT), `frontend-design` from anthropics/skills (Apache-2.0), 6 from mattpocock/skills (MIT: `grill-me`, `grilling`,
  `teach`, `wait-what`, `resolving-merge-conflicts`, `setup-pre-commit`) and `claude-md-improver` from
  anthropics/claude-plugins-official (Apache-2.0), plus the commands `/commit` and `/revise-claude-md` from the same
  repository. Each is pinned to an exact upstream commit, keeps its upstream `LICENSE` file in its folder and carries a
  provenance header; every change is listed in `.claude/skills/VENDORED-SKILLS.md`. The Bosses use them automatically
  (`agent-skill-map.json`: Boss → `forge-prompt-coach`, `grill-me`, `grilling`; Build Boss → `resolving-merge-conflicts`,
  `setup-pre-commit` (only on request); Docs Boss → `teach`, `wait-what`, `claude-md-improver`).
- **Prompt coach.** The new Forge skill `forge-prompt-coach` (9 ingredients of an accurate request, failure modes
  F1–F13 each with one 2–3-option question and a safe default, a 7-rule asking protocol, 10 bad→good examples) and
  `forge-promptcheck.cjs ask "<request>"` (implemented in `forge-promptcheck-ask.cjs`; deterministic, offline, Dutch and
  English). The silent intake asks **at most one** question — the highest-ranked real gap, as 2–3 plain options plus
  "iets anders / something else" — then confirms in one sentence and, in explain mode, adds one teaching tip. Beginner
  guide `docs/HOW-TO-ASK.md` (Dutch first, then English).
- **Intake question bank:** Dutch text and beginner options on all 149 questions; the `bugfix` and `bots` sets are live
  intake packs. `forge-intake.cjs` gains `--lang nl|en`, `--beginner` and `--trigger F<id>`, and passes the beginner
  fields through in `--json`.
- **Doctor beginner checks** (advisory, never red): a project `CLAUDE.md` over ~200 lines; `claude`, `git` and `node`
  on PATH, including a clear note when Node is missing entirely (Claude Code itself needs no Node, Forge's tools need
  Node 18+); `bypassPermissions` as the default permission mode; a WSL project under `/mnt/c`; a read-only summary of
  `claude doctor`; the prompt coach installed next to the intake.
- **Command Center:** a read-only "Forge settings" section in Settings, served by `GET /api/config?project=<name>`
  (read-only: POST is refused with 405, an unknown project is a 404).
- **`git-checkpoint`** (on by default): a local safety commit or branch before an L2+ build or any destructive request —
  never pushed, never staging a `.env` or key file git does not ignore.
- **`forge-sweep.cjs`** (with `-core`, `-extract`, `-aggregate`): a maintainer tool for a resumable YouTube beginner
  research sweep. Needs `yt-dlp`; captions only, never media.

### Changed

- **The usage guard is on by default and pauses at 98 %.** In 2.4.0 it was opt-in, started only on an explicit request
  or an opt-in marker file. The maintainer reversed that: beginners should be protected without having to know the guard
  exists. To keep that honest, the tool now says what it does exactly when a new watcher really starts — it reads the
  Claude login token locally from `~/.claude/.credentials.json` and sends it only to `api.anthropic.com` — followed by
  the one command that switches it off (`/forge config set usage-guard off` — `off`, `uit` and `false` are all accepted). The opt-in marker is no longer used.
  `usage-guard.cjs start` exits 3 without starting anything when the user switched it off, and `status` prints every
  threshold with its source. It is still never started by `/forge dashboard`, by the Paperclip runtime (which needs
  `--with-usage-guard`) or by the doctor's test run.
- **Why 98 % and not the old 95 %:** Claude Code 2.1.234 and later already wait at a limit and continue by themselves
  after the reset. The guard's job is now the pause *before* the limit, between phases (best effort: it samples every
  2 minutes, so a step can still cross the limit between two samples). The pause default had drifted between 93, 95 and 98 across files; 98 is now the only literal.
- **Everything is on by default**, with three documented exceptions: `paperclip` stays off (unattended agents only on
  an explicit request — `forge-paperclip.cjs up`/`ensure` now refuse with exit 3 while it is off, unless `--force`),
  `cleanup` stays on `report` (`auto` deletes files) and `ecc-full-test` stays off (heavy diagnostics; it is bridged into
  `FORGE_ECC_MODE.json`, and the old `ECC_TEST_MODE.md` marker is legacy).
- **Build by default follows the settings:** `start-gate` (default `off`), `intake`, `prompt-doctor`, `dashboard`,
  `usage-guard`, `git-checkpoint`, `team-max`, `model-tiering` and `explain-mode`. `/forge` refuses to work in the home
  folder or a drive root, lists a keep-list before any "clean up" request, and ends every finished run with a one-line
  `/clear` reminder.
- `/forge dashboard` never prints a start or build command for the user to type; when no dashboard is available it says
  so in one line and continues.
- The doctor's "which tree is this?" check (`installationProfile`) now keys on a development-tree marker file that the
  release never ships, instead of "carries vendored skills" — the public distribution ships vendored skills now.
  Installation-pinned test assertions keep skipping visibly outside the development tree; skill counts are derived from
  disk.

### Fixed

- **Hard-gate gap:** `git checkout .`, `git checkout -- <path>`, `git checkout <tree-ish> -- <path>` and
  `git restore <path>` / `git restore .` were classified "no gate triggered", although each discards uncommitted edits
  with no reflog entry. They are now `git-destructive`, as are `git switch -f` / `--force` / `--discard-changes`.
  `git restore --staged <path>` (it only unstages), `git checkout main` and `git checkout -b x` stay silent.
- The docs contradicted each other on the usage guard (opt-in vs default; 95 % vs 98 %). All docs now say: on by
  default, 98 %, one command to change or switch off.
- The README promised "no `npm install`, ever" while telling the user to run `npm install && npm run build` for the
  dashboard. Forge's tools need no npm; the dashboard's one-time build is the only npm step, and it is run for the user.
- `docs/FEATURES.md` listed `humanizer` and `gsap` as shipped craft skills and called gsap MIT. Neither is shipped in
  the full install (gsap has no open licence); the section now lists the vendored skills that really ship.
- The shipped owner profile's seed note said `/forge remember` writes `~/.claude/FORGE_OWNER_PROFILE.json`; it writes
  the project's standing rules (`.claude/config/orchestration/FORGE_STANDING_RULES.json`).

### Security

- The gate hook is the first Forge hook that **enforces** instead of advising — deliberately scoped to the three
  destructive command gates. Honest limits, documented in `HOOKS_OPT_IN.md` §6: it sees shell command text only (a delete
  inside a script, a variable or `node -e` is not seen); the text gates (deploy, push, spend, …) and
  writing outside the project stay classifier + prose gates; a hook cannot tell the user apart from the agent. If the
  hook itself cannot judge a call (its own error, an oversized payload, a stdin timeout) it exits 1 — visible and
  non-blocking, never a silent pass — and a regex fallback still blocks the obvious destructive verbs when the
  classifier fails to load; if its scratch pass-through errors it keeps the block. A missing or damaged settings file
  falls back to the default, which is ON.
- After the read-only security and code reviews of this release the hook was tightened: a recursive delete
  **without** the force flag is gated too (`rm -r`, `rm -R`, `rm --recursive`; `aws s3 rm`, `git rm -r` and `gsutil rm -r`
  stay silent); kill-by-name also catches abbreviated `Stop-Process -N…`, `taskkill /FI` with any filter except
  `PID eq`, `kill $(pgrep …)` / `` `pidof` `` substitutions and `pgrep|pidof|grep … | xargs kill`; the hook command is
  `node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"` (works from any working directory; expansion
  proven live); an agent's own `forge-config … set gate-hook off|unset|reset` is blocked, the one exact shape
  `… set gate-hook off --once "<quote>"` passes (a quoted owner approval that expires after 10 minutes), and while the
  gate is off every call it would have stopped prints a `FORGE GATE is OFF …` notice with exit 1; the scratch
  pass-through refuses braces, parentheses and `cd`/`mv`/`ln`/`builtin`/`command`/`exec`/`env` words, and a delete
  passes only when **every** segment of the command is itself a provable delete; quoted data (heredoc bodies,
  `echo`/`printf` literals, log-event payloads, search patterns for grep/rg/Select-String/findstr/git grep) is never
  classified as a command unless the same command later feeds it to an interpreter (`forge-gate-data.cjs`). Declared
  gaps stay in `hard-gates.json` `_not_caught`: PowerShell `kill -n <name>` is silent (for POSIX `kill`, `-n` is a
  signal number) and `gsutil -m rm -r` over-warns.
- Hook `timeout` values are **seconds** in Claude Code; the shipped 5000/8000 meant 83 minutes / 2.2 hours. Now 15 s
  for the snapshot hooks and 10 s for the tool ledger and the gate hook.
- The shipped `.claude/settings.json` adds 23 `permissions.deny` rules: `Read(./.env)`, `Read(./.env.local)`,
  `Read(./.env.*.local)`, `Read(./.env.development)`, `Read(./.env.production)`, `Read(./.env.staging)`,
  `Read(./.env.test)`, `Read(./secrets/**)`, the same names nested anywhere (`Read(./**/.env)`, `.env.local`,
  `.env.*.local`, `.env.production`, `.env.prod`, `.env.bak`, `.env.backup`, `secrets/**`), private keys
  (`*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`) and the user's own credential files (`~/.claude/.credentials.json`,
  `~/.claude/nvidia.env`, `~/.ssh/**`). `.env.example` stays readable on purpose (a test asserts it). Not covered:
  reading through the shell.
- Vendored skills: every upstream file was sha256-verified against the pinned commit's manifest and scanned for hidden or
  zero-width Unicode and prompt-injection patterns before copying. Helper scripts that open a network listener or
  delete outside their own work folder were excluded (the brainstorming browser companion); commands that push, open
  PRs or delete branches (`commit-push-pr`, `clean_gone`) were not shipped.
- The doctor warns when `bypassPermissions` is the default permission mode.
- **NVIDIA off means no network.** With `nvidia` off, `health` and `models` make no request at all (one `NVIDIA OFF` line,
  exit 3; `--force` checks anyway) and the Command Center shows the state `OFF` instead of "disconnected". A project
  `.env` file may only set the API key and the per-role model names; the base URL and the "allow a custom URL" flag count
  only from the real environment or the global `~/.claude/nvidia.env`, and the URL must be `https:` on an `*.nvidia.com`
  host unless that flag is set — otherwise every request is refused before it is sent. `NVIDIA_TIMEOUT_MS` can no longer
  come from an env file.
- **Usage guard hardening.** Login-file errors are fixed text (no token fragment, no home path reaches the state file, the
  log or the output); a running watcher re-reads the `usage-guard` setting before every check and exits cleanly when it
  was switched off; `start` without a login file (for example macOS Keychain) refuses honestly with exit 3; a stale
  "paused" state older than three intervals no longer blocks every phase; a pre-existing 30-second linger on a bad
  login file is gone.
- **The Command Center never runs a selected project's own code.** `GET /api/config` runs the gateway's own central
  `forge-config.cjs` against the selected project (only that project's settings file is read), and the config child
  receives no `*_TOKEN`, `*_SECRET` or `*_KEY` variables.
- **Unreadable settings never mean "on".** `forge-config.cjs` exports `safeGet()`, which never throws: when
  `FORGE_CONFIG.json` is damaged, every setting that costs money, uses the network or your data, deletes files or hands
  control to an unattended agent falls to its safe value (off / report-only), the CLIs print one `NOTE (settings)` line
  naming the file and the way back, and `reset --yes` moves the damaged file aside byte-for-byte before starting fresh.
  The nine tools that read a setting now share one `configRead` adapter instead of nine copies.
- **`git-checkpoint` never stages a secret.** Before the local safety commit Forge appends the missing ignore lines
  (`forge-setup.cjs gitignore`, keeps `!.env.example`), then unstages anything secret-shaped that git did not ignore
  (`.env*` except `.env.example`, `*.pem`, `*.key`, `id_rsa*`, `credentials*.json`, `secrets/`) and says so in one line.

### Fixed — after the read-only code and security reviews of this release (2026-09-24)

- **Existing projects get the hooks and deny rules too.** A project that already had its own `.claude/settings.json`
  used to receive only `settings.forge-recommended.json` and the message "merge what you want by hand", and
  `forge-sync install` never touched `settings.json` at all — so a 2.4.0 project upgrading would never have got the gate
  hook. New `forge-settings-merge.cjs` merges the five Forge hooks and the deny rules into an existing file
  (existing entries kept byte-for-byte and in place, a Forge timeout still written in milliseconds corrected to seconds,
  timestamped backup first, atomic write, running again is a no-op; an unreadable file is left alone with the
  recommended copy next to it). `install.sh`, `install.ps1` and `forge-sync install`/`sync-all` all use it; the
  fresh-install CI asserts a foreign hook and allow rule survive and the Forge entries arrive.
- **A project that lives under the OS temp folder keeps its safety stop.** The evidence round's fresh-install test creates
  its project under `%TEMP%`, and there the gate hook let every delete pass: its temp-folder pass-through counted the whole
  project as scratch (15 of 141 hook tests red inside such a project). The temp-folder rule now applies only to targets
  outside the project root; inside the project only the named scratch areas pass, and the project root itself never does.
- **Progress heartbeats of finished work no longer count as open tasks.** `forge-verify.cjs` and the dashboard's
  `app.js` (mirrored) close an agent's `agent_progress` heartbeats when the same work package's `subagent_completed` or
  `subagent_failed` arrives, taking that completion's status (blockers stay visible); a `fix_completed` or
  `check_passed` carrying `closes_event_id` plus non-empty `evidence` closes exactly that earlier task; the drift check
  reports a skill whose body changed but whose frontmatter did not as a `body_only_change` note instead of a false
  `noop_claim` (git confirms the change).
- **Version number.** This release is numbered **2.7.0** at the maintainer's request; there was no 2.5.0 or 2.6.0
  release. Every version marker in the tree (VERSION, plugin and marketplace manifests, docs, code labels, brand tokens)
  reads 2.7.0.

### Docs

- New: `docs/SETTINGS.md` (every setting with its default, how to change it, precedence, the locked rules),
  `docs/CLAUDE-CODE-BASICS.md` (English and Dutch: paid plan and `/login`, the install line per shell, PATH, Git for
  Windows, permission prompts and the folder-trust prompt, the hooks and deny rules Forge adds, Esc / Esc Esc /
  `/rewind` / git as real undo, `/usage` and the shared 5-hour and weekly limits, `/clear`, CLAUDE.md, three myths) and
  `docs/HOW-TO-ASK.md`.
- README: the beginner promise (English and Dutch), "Settings in one command", the safety stop, the vendored skills,
  the prompt coach, the usage-guard change and a corrected dashboard section. AI-INSTALL §2b lists the gate hook and
  deny rules and describes the usage guard's default honestly. COMMANDS-QUICK-REF, FEATURES, HOW-IT-WORKS,
  TOKEN-USAGE and AGENTS (skills per Boss) are updated to match; `forge-core` gains a v2.7.0 section.

## [2.4.0] - 2026-09-23

Release theme: **measured on a machine that has never seen Forge.** An independent deep audit of v2.3.0 (Windows 11,
empty `~/.claude`, public GitHub API) found that every "fresh installs work" claim since 2.1.0 had been verified on the
author's own workstation — with its hooks, 40 plugins, policy files and canonical template already in place. A real
user has none of that. This release reproduces the audit's result (9 failing assertions in 4 suites on an empty HOME),
fixes each cause, and adds the one job that would have caught all of it: **a CI workflow that installs into an empty
directory with an empty HOME on Ubuntu and Windows and requires the doctor to print ALL GREEN.**

### Fixed — the P0s

- **`/setup-forge` crashed with `MODULE_NOT_FOUND`** (audit II-A). Its engine `forge-setup.cjs` shipped in 2.0.0 and was
  deleted in 2.1.0 while 35 references in 6 documents kept calling it; only fresh installs noticed, because the template
  sync is additive and never removes a file from a project that already had it. Restored from `be088b8`, and now part of
  the canonical payload so it cannot silently disappear again.
- **The canonical template `~/.claude/forge/template/` was never created** (II-A). The auto-install, "install Forge V2 into
  this project" and the "stay current" rule all pointed at nothing, and `forge-sync status` compared each project with
  itself — printing "up to date" forever. Both installers now create the template from the payload; `forge-sync status`
  says plainly when no template exists and that the update check was NOT performed.
- **A `PostToolUse` hook with no matcher shipped in `settings.json`** (II-D) and fired on every tool call of every agent
  (461 in one audited session). It now carries `Write|Edit|MultiEdit|NotebookEdit|Bash`, is disclosed in AI-INSTALL.md
  with the other three hooks, and `HOOKS_OPT_IN.md` no longer contradicts itself about it.
- **`forge-log-event.cmd` re-tokenised JSON and executed text after an `&`** (II-G). Payloads may now be passed as a
  `.json` file (`log-event.cjs --file` — the only form cmd can never mangle) or inline with cmd's own `""` escape; the
  `.ps1` form passes the payload through an environment variable (`--env`). Both wrappers return the real exit code
  instead of 0. The three audit payloads were driven through the real `.cmd`: intact, nothing executed, exit 1 on bad JSON.
- **`forge.cmd resume` / `learn` could not find their tool from any directory but one** (II-G): `shift` also shifts `%0`.
  The script directory is captured before any shift. Two original REM lines containing `<command>` and `->` — parsed by
  cmd as redirection even inside a comment — are rewritten; the file is pure ASCII (a UTF-8 dash shifts cmd's byte offsets).
- **The Command Center dashboard could not be built from the repository** (II-G): `src/views/mission/` was imported by
  `App.tsx` but never committed (it lived inside a nested git repo in the author's tree). All eight files are in.
- **The shipped `command-center/` was a stale copy** (measured while chasing the last red suite): 14 gateway source
  files, 19 dashboard source files, `gateway/src/runtime-state.mjs`, the drain test and two redaction tests existed only
  in the author's tree, so `gateway-drain.test.cjs` exercised a gateway that ignored `CC_PORT`, and the leak scan hit
  lines the source had rewritten weeks earlier. Brought current with a selective sync (code only — no runtime data,
  transcripts or logs). Two `supervisor-out.log.*` residue files are untracked.
- **Every fresh install reported `installed=2.3.0` forever**: the payload carried the author's `FORGE_VERSION.json`.
  The file is no longer shipped; both installers now write it with the real version, and the fresh-install job asserts it.

### Fixed — tests that only passed on the author's machine (II-B, Part III)

- `guard-hook.test.cjs` required a hook the installer deliberately never ships and read `~/.claude/settings.json`
  unguarded; elsewhere it died with "0 passed, 0 failed", which the doctor counts as a failed suite. It now skips
  honestly, with the reason, when the optional hook is absent.
- `forge-contextbudget.test.cjs` (3) and `forge-doctor.test.cjs` (1) asserted the size of "the REAL machine's" plugin
  catalog and global CLAUDE.md chain. They now check the precondition first and skip visibly where there is nothing to measure.
- `forge-sync.test.cjs` (5): with no canonical template the template-refusal fired before argument validation, so the
  `--force-all` usage gate was unreachable. Validation now comes first; usage (2) and environment (3) have distinct exit
  codes; `install` against a folder without `.claude/` names the fix instead of blaming the template.
- `forge-paperclip.cjs` split paths on `path.sep`, so a Windows-style input kept its backslashes on a Linux runner.
- `forge-capabilities-panel.test.cjs` counted the tool ledger's `_toollog/` as a run directory.
- `forge-prefs.test.cjs` (7) and `forge-echo.test.cjs` (1) went red the moment the author's preferences left
  `FORGE_OWNER_PROFILE.json`: they pin Forge's nine standing defaults. The file now ships those nine as **product
  defaults**, each sourced to the shipped document that defines it (never to a person's answer); `/forge remember` layers
  the owner's own rules on top.
- `nvidia-provider.test.cjs` ("every registry agent has core skills"): dropping the unshipped skills had left ui-boss,
  seo-boss and skill-boss with empty lists. Refilled from skills that ship.
- Skill hygiene reported `.claude/.forge-setup.json` — the marker `/setup-forge` writes — as a dangling reference,
  because the engine builds that path into a variable and writes it fifteen lines later. `generatedPathBasenames()` now
  resolves a written variable to its declaration; a variable never handed to a write API still counts as dangling.
- New `forge-setup.test.cjs`: the tripwire that was missing for two releases (engine present, starts, `status`/`doctor`
  answer JSON on a throwaway project and write nothing).
- `forge-sync.test.cjs` 58b crashed on Linux (found by the first 2.4.0 CI run): its "real OS" branch — taken when
  `lstat` yields ENOTDIR, which Linux does and Windows does not — wrote a file where the fixture had already made a
  directory (EISDIR). That branch had never executed on the author's machine.
- `forge-doctor.cjs` now NAMES the red suites on its tests line, with why (`crashed or no tally` / `timeout` / `N failed`):
  the CI line "6128 passed / 0 failed · 1 SUITE(S) FAILED" named nothing, and a runner has no per-suite output at hand.
- `fresh-install.yml` (Windows) assigned to `$home`, a read-only PowerShell automatic variable; `validate.yml` passed a
  bare relative path to `require()` (a module name). Both found by the first 2.4.0 runs, both fixed.
- **`forge-sync.cjs` containment guard on 8.3 short paths** (found by the Windows CI runner, whose TEMP is
  `C:\Users\RUNNER~1\…`): for a project directory that does not exist yet (the dedicated canary on a dry run) the
  base fell back to the short form while the target's ancestor was realpath'd to the long form, so every file
  "escaped" and the canary plan was empty. Both sides now resolve through the same existing ancestor; regression
  test 58c drives a real 8.3 alias.
- `log-event-concurrency.test.cjs` unlinked a lock whose handle it still held and immediately recreated the name —
  on Windows that name is delete-pending and the create throws EPERM (crash before the tally on the runner). The
  takeover is now simulated with a rename; the stress runners carry a timeout so no grandchild outlives the suite.
- The fresh-install job re-runs any red suite the doctor names and prints its failures, so a runner-only failure can
  be read from the log instead of guessed at.
- `forge-doctor.test.cjs` asserted that its own runtime markers (`.forge-snapshot-due.json`, `.forge-setup.json`) are
  listed as generated refs — true only while they are absent. The independent re-execution of this release found the
  dev-tree doctor red minutes after a precompact hook had written the snapshot marker. The assertions now accept a
  marker that exists and fail only when a reference is flagged as dangling.

### Fixed — found by the read-only security and consistency reviews of this release (2026-09-24)

Two independent read-only reviews ran against the release candidate (a security audit of what the distribution ships and
a claim-by-claim consistency check of the docs). Everything they found was fixed before the tag:

- **The doctor's own test run used to start a real usage guard against the user's real home** (security HIGH):
  `usage-guard.test.cjs` H3.2b spawned `usage-guard start` with only the pid/log/state paths redirected, so the child read
  `~/.claude/.credentials.json`, called Anthropic's usage endpoint and wrote `~/.claude/FORGE_USAGE_PRESSURE.json` —
  on every fresh install, via forge-doctor. The guard's home is now overridable (`FORGE_USAGE_GUARD_HOME`), the test
  isolates a temporary home, kills the child it spawned, and asserts the real pressure file was not touched.
- **No silent usage-guard starts anywhere:** `forge-paperclip.cjs up` no longer starts it (opt in with
  `--with-usage-guard`); `/forge dashboard` no longer starts it; a `FORGE_USAGE_PRESSURE.json` on disk is no longer read
  as consent — only an explicit request or the marker `~/.claude/FORGE_USAGE_GUARD_OPT_IN.json` is.
- `forge-paperclip.cjs` killed any listener on ports 54329–54331 and every `postgres.exe` under an `embedded-postgres`
  path. It now stops only processes that belong to its own `PAPERCLIP_HOME`.
- **`forge-log-event.cmd` / `forge.cmd log-event` accept only a `.json` file.** The inline form survived 2.4.0's first
  fix for backslash-escaped quotes and for JSON passed from Windows PowerShell 5.1; `%*` and `call` re-expansion are
  gone. Inline JSON: use `forge.ps1` (environment-variable route) or `forge.sh`.
- `start-command-center.cmd` pasted the project path into a single-quoted PowerShell string; a `'` in the path broke it.
  The values travel through environment variables now.
- **Installers:** a piped install (`curl | bash`, `irm | iex`) always downloads the archive and never treats the current
  folder as a source (a cwd that happened to contain `.claude/` was installed instead); `VERSION` comes from the archive;
  the confirmation is read from `/dev/tty` (the `curl | bash` one-liner used to abort as "non-interactive"); **the target
  may not be the home directory** — from `%USERPROFILE%` the Windows one-liner used to copy the project payload into
  `~/.claude` and replace the user's global `settings.json`; **an existing project `.claude/settings.json` is never
  replaced** (Forge's copy is written next to it as `settings.forge-recommended.json`); the plan and the confirmation
  name all three write targets. `fresh-install.yml` checks the piped install, the home-directory refusal and the
  kept `settings.json`.
- Docs: the agent/skill counts really agree now (19 agents = 12 Bosses + 7 specialists incl. verify-boss / 50 skills;
  LITE 18 / 31), `docs/HOW-IT-WORKS.md` and `AGENTS.md` name verify-boss, the README's "What's new" is about 2.4.0,
  Path C is labelled the partial install it is, `HOOKS_OPT_IN.md` matches the live hook, `AI-INSTALL.md` lists the third
  write target, the settings.json policy, the Discord service's token use and the opt-in marker; the ARM → START and
  auto-start passages in `forge-core`'s reference text carry dated SUPERSEDED notes; the plugin's `/forge` and
  `forge-intake` carry the build-by-default paragraph.
- Removed from the distribution: `maand-sweep.cmd` + its prompt (an unattended `bypassPermissions` sweep over YouTube
  content), the author's dashboard screenshots, and the runtime marker `.claude/.forge-snapshot-due.json` is ignored.
- **Windows vs macOS/Linux, side by side.** `AI-INSTALL.md §2a` and the README now carry one decision table — detect the
  OS first, then stay in that column: installer file, clone-and-run and one-liner forms, unattended/dry-run/partial flags
  (`-Yes`/`--yes`, `-DryRun`/`--dry-run`, …), where the global core lands (`%USERPROFILE%\.claude` vs `~/.claude`), the
  identical verification command, the `.cmd`/`.ps1` vs `.sh` wrappers, the home-directory refusal, and what never to
  mix (`install.sh` in PowerShell, `install.ps1` in bash).
- `forge-doctor.test.cjs` no longer fails on the dev tree after a precompact hook writes its own marker (see above).

### Changed — beginner-first (Part IV of the audit)

- **`/forge <goal>` builds by default.** The ARM → START gate is gone: Forge posts one line (`Plan ready — N work
  packages · team … · Building now — say STOP to pause`) and continues. It waits for START only when the owner writes
  "wait", "ask first" or "plan only", or the mission is L4. All hard gates (deploy, push, spend, DNS, production,
  credentials, outbound, writing outside the project) are unchanged and still interrupt.
- **Silent intake.** The 21–24-question intake is answered by the Lead from the mission text, the project scan,
  `.claude/.forge-setup.json` and the project profile, recorded in the PRD as *Assumptions (auto-filled)*. At most one
  question is asked. The full interview is opt-in via **`/forge interview`**. `/forge` reads what `/setup-forge` saved.
- **The dashboard is started, not printed.** `/forge` health-checks port 4100, starts the supervisor itself when
  `command-center/` is present, or says in one line that no dashboard is installed here and continues.
- **The usage guard is opt-in** (it reads the OAuth token from `~/.claude/.credentials.json`); no silent start.
- The six `/forge` sub-commands advertised since v8.1 (`propose-skill`, `approve-skill`, `tournament`, `secondbrain`,
  `codemodel`, `briefing`) have dispatcher entries pointing at the tools that already shipped.
- `forge-doctor.cjs --help` prints usage and exits (it used to run the full self-test); a mistyped flag is refused. The
  "dashboard SPA · 7 files present" line now says it checks the retired per-project files, not a working dashboard.
- `forge-killswitch.cjs` refuses honestly on non-Windows; its probes no longer report a lookup failure when nothing listens.

### Removed from the distribution (II-D)

- Per-install state tracked against the repo's own `.gitignore`: `forge-sync-receipt.json` (311 hashes from the author's
  machine), `FORGE_VERSION.json`, `scheduled_tasks.lock` (a live PID lock), and the author's `forge-tickets/`,
  `forge-artifacts/`, `forge-mindmaps/`. `FORGE_OWNER_PROFILE.json` no longer quotes the author: its nine entries are
  Forge's product defaults with document sources (see Fixed — tests).
- `agent-skill-map.json` mapped skills that do not ship in this payload (they lived in the author's global `~/.claude`);
  19 are remapped to the shipped Forge equivalents, the remainder is listed inside the file under
  `_unshipped_removed_2026_09_23` rather than silently dropped, and `forge-website` — which does ship and had been swept
  up by mistake — is restored to ui-boss and seo-boss.
- Skill text citing policy documents present only on the author's machine now says so and falls back to its own defaults.
- **`.claude/forge-bin/maand-sweep.cmd` and `maand-sweep-prompt.txt` removed.** An unattended, `bypassPermissions` sweep over YouTube content — never part of the public docs. The failing test reference is gone; the tool is gone.

### Documentation

- One set of counts, taken from the **tracked** files (what a clone actually gets): full install **19 agents / 50 skills /
  93 tools**; LITE plugin **18 agents / 31 skills**. README, AGENTS, FEATURES, HOW-IT-WORKS, COMMANDS-QUICK-REF and
  CONTRIBUTING agree, and the `dist-hygiene` release gate now counts them. (The earlier "59 skills" counted the
  maintainer's working tree, which also holds the nine vendored third-party skills that `VENDORED-SKILLS.md` says are
  not redistributed.) **`forge-prd` ships again**: it had been gitignored in the distribution as "shipped once under
  `plugins/forge/skills/`", but the full install copies `.claude/` only — every full install since 2.1.0 lacked the PRD
  skill the router requires. The fresh-install job now asserts it is present.
- `npm run forge:*` was documented in nine places and defined nowhere — replaced by the real wrappers.
  `forge-doctor.cjs leakScan` is not a CLI mode. `docs/INTERNATIONALIZATION.md` is labelled a design note (the dashboard
  i18n layer was never built) and the README no longer claims the dashboard adapts to your language.
- `AI-INSTALL.md` states the PowerShell flag spellings, that `--global-only` has no doctor to verify it, which hooks the
  install switches on, and that the usage guard is opt-in.
- `SECURITY.md` supports 2.4.x; CHANGELOG link references exist for every release; `plugin.json` and `marketplace.json`
  are stamped from `VERSION`, and CI fails if they drift.

### CI

- **New `fresh-install.yml`**: real installer into an empty directory with an empty HOME (Ubuntu + Windows, Node 18 + 22),
  checks the install delivered what it documents, re-runs the installer to prove idempotence, runs the full doctor,
  requires `⇒ ALL GREEN`.
- `validate.yml` gains two hygiene gates: `git ls-files -i -c` must be empty; every manifest version must equal `VERSION`.

### Verified

- Reproduction of the audit on this machine with an empty HOME: 9 failed / 4 suites before, **0 failed after**.
- Source-tree regression with a normal HOME: every touched suite green.
- The three audit payloads through the real `forge-log-event.cmd`: `x=1,y;z` intact; a file containing `a&echo INJECTED`
  written verbatim with nothing executed; malformed JSON returns exit 1. `forge.cmd resume` works from a foreign cwd.

## [2.3.0] - 2026-08-13

Release theme: **a fresh install on someone else's machine now behaves exactly like the author's.**
Every item below was found by measuring a real install into a clean folder — not by reasoning about it.

### Fixed — the "works here, breaks there" class

- **The installer never delivered the two project-root files Forge documents.** `CLAUDE.md` and
  `.gitignore` were only ever created by hand in the author's tree, so on a brand-new project three
  suites failed (`forge-configdrift`, `forge-tool-index`, `forge-toolhook`) and the very first
  `forge-doctor` a new user ran reported `FAILURES ABOVE`. Both installers now seed them from
  `templates/`: an existing `CLAUDE.md` is never touched, and `.gitignore` only receives lines it
  does not already have. Running the installer twice changes nothing the second time.
- **A test read the author's local mission history.** `forge-quality.test.cjs` did an unguarded
  `readFileSync` on a run directory that exists only on the development machine. Anywhere else the
  `ENOENT` crashed the whole test file — and with it `forge-doctor` and the post-install validation.
  It now skips honestly, stating why, and stays fully strict where that history does exist.
- **`forge-killswitch` claimed to be cross-platform.** Every real collector shells out to
  `powershell`/`taskkill`/`schtasks` with no `process.platform` check, while the suite injects those
  collectors and never touches the real paths — green on every OS, `spawn powershell ENOENT` on
  macOS/Linux. It now refuses honestly with an explanation (exit 2, also under `--json`).
- **The Codex review pinned a single model with no fallback.** Any user on a ChatGPT account gets
  `HTTP 400 — model not supported` for *every* model, including the CLI default. The config now
  carries an ordered candidate list, a diagnosis command, and an explicit rule: if Codex cannot run,
  report it blocked and continue — never fabricate a review, never pass the local fallback off as an
  independent one.
- **`forge-sync`'s "not a project" refusal did not say what to do instead.** The refusal itself is a
  safety feature and stays (one mistyped path would otherwise fill a random folder with system
  files); the message now points to the installer, which does bootstrap from nothing.

### Added

- **[AI-INSTALL.md](AI-INSTALL.md)** — instructions for the AI assistant a user asks to install this
  repo: pre-flight checks, the exact commands, the verification it must run, what it must never do,
  and how to report back honestly. The README points at it up front.
- **Quality Intelligence Layer** (`forge-quality.cjs`, `config/orchestration/domain-catalog.json`,
  `config/quality/cards/`) — turns a mission into a multi-label profile, ten quality lenses that each
  carry an explicit disposition with a reason, omission mining along five axes, validated requirement
  cards, and a bounded context pack. One canonical domain list, with drift against four seams
  reported instead of silently carried.
- **LLM Council** (`skills/forge-council`) — the full protocol (neutral framing, five independent
  advisors, anonymous peer review, chairman synthesis with a minority report) with append-only,
  atomically written decision records. Deliberately not always-on: council consensus is never evidence.
- **Evidence tooling** — `forge-gate-evidence.cjs` (per-gate command, exit code, output hash and
  commit binding), `forge-finalize.cjs` (one authoritative run receipt), and `forge-ownergrant.cjs`.

### Changed

- Documentation states the real counts (52 skills, 19 agents) instead of the outdated 23/18.
- `install.sh` documents that `SHA256SUMS` exists only on tagged release archives, so a plain clone
  is honestly "not hash-verified" rather than silently unverified.

### Security / privacy

- Removed a personal file that had shipped in the distribution
  (`command-center/dashboard/CLAUDE.laptop-orig.md`).
- Sanitised owner-identifying data the previous pass missed **because its scan was case-sensitive**:
  lowercase `users/YOU` home paths in four dashboard docs and a fixture, plus private
  project/business names used as examples across 19 files. The pre-publish gate is now
  case-insensitive and includes project-name patterns.
- The sync into this distribution runs against an explicit blocklist: owner profile, project memory,
  task history, agent ledger, per-agent memory, run logs, research, audit trails and local state are
  never copied.

### Verified

- Fresh install into a clean directory (both `install.sh` and `install.ps1`), then the full doctor:
  **ALL GREEN**, 121 suites. The same measurement on 2.2.0 gave 3 failing suites.
- Source tree doctor: **ALL GREEN**, 121 suites / 6623 assertions.
- Installer idempotence verified by running it twice and comparing the result.

## [2.2.0] - 2026-08-04

Installing into a fresh project was structurally impossible, and the usage guard was watching the wrong
account. Both were found by running the system against itself; every fix below ships with a test that
first reproduces the defect.

### Fixed — installing into a new project

- **A fresh install validated itself against files that could only exist afterwards** and therefore
  rolled back all ~357 files, every time. The post-install doctor required a `CLAUDE.md`, `.gitignore`
  rules, a wrapper script that was never shipped, a **git repository**, and two assertions pinning the
  maintainer tree's exact state. The installer now seeds the environment its own validation checks
  (append-only `.gitignore`, create-only `CLAUDE.md` stub, both undone on rollback), environment tests
  skip honestly where their precondition is legitimately absent, and dev-tree-only assertions sit behind
  a marker file that is never shipped.
- **The leak scan walked Python virtualenvs**, reporting third-party docstrings (`user:pass@host`
  examples in fsspec/httpx/pandas) as credentials — enough to fail an entire install. Virtualenvs are now
  detected by `pyvenv.cfg` (whatever the directory is called) and skipped like `node_modules`; a real
  secret outside the venv is still caught.

### Fixed — usage guard

- **No account identity anywhere.** One state file served every account, so after switching accounts the
  guard kept deciding on the previous one's numbers, and a credits override bought on account A
  suppressed the guard on account B. The guard now fingerprints the account (a short digest — never a raw
  uuid, e-mail or token), detects a switch, and starts clean instead of inheriting.
- **Only two usage windows were read.** The API returns a typed `limits` array (session, weekly, and
  per-model scoped windows); everything outside the two legacy fields was invisible and could sit at 100%
  while the guard reported `ok`. All windows now count, are shown and are logged, typed and legacy are
  merged rather than one replacing the other, and a `null` percentage is no longer coerced into a
  confident `0%`.
- **A live PID counted as proof the watcher was working.** It could stop ticking while the process lived
  on. There is now a heartbeat, process-wide rejection/exception handlers, and an honest
  running/stale/not-running verdict.
- **`stop` could kill a recycled PID**, including its process tree. It now verifies the command line
  belongs to this watcher before killing anything, never tree-kills, and removes the PID file only once
  the process is confirmed gone.

### Fixed — honesty of what the system reports

- **A synthetic demo run counted as "the latest run"** for status, `open-report` and the dashboard header
  — pointing at a report that does not exist — and operational directories were listed as missions. Run
  listings now require run shape, order by real time, and never let a self-declared demo win "latest".
- Several tools resolved their event writer from their own install directory while accepting a `--root`,
  so running them against another project wrote that project's events into the tool's own tree.
- Machine-specific paths (a maintainer's username, one machine's Paperclip home and `claude` binary) were
  baked into shipped files — wrong everywhere else, and needlessly identifying. Per-install state files
  are no longer published at all.

## [2.1.0] - 2026-08-02

This release closes three defect classes that were **measured**, not guessed, in the system this repo is cut from.

### Added

- **The Forge Command Center now ships** (`command-center/`) — one zero-dependency Node gateway + React dashboard on `http://127.0.0.1:4100` that auto-discovers your Forge projects and shows strictly per-project data. It is the only layer allowed to spawn the real `claude` CLI. Build the SPA once (`cd command-center/dashboard && npm install && npm run build`), then run `node command-center/gateway/supervisor.mjs` (it restarts the gateway if it dies).
- **Run-contract gate with proof** — `forge-runcontract.cjs check --run <id> --log-event` now emits a `gate_evaluated` event through the one real writer, in the same act as the check. A gate that evaluates silently is indistinguishable from one that never ran.
- **`VENDORED-SKILLS.md`** — third-party skills this system uses internally are listed with their source and pinned commit instead of being redistributed here.

### Fixed

- **Agents did not create tasks.** Measured across 857 events in 29 runs: `gate_evaluated` had fired **0 times ever**, the run contract failed on 28 of 29 runs, and the system prompt appended to every dashboard-driven execution contained no obligation to create a work package, ticket, PRD or run id. Three layers each assumed another was enforcing. The gateway preamble now carries a **mission-ledger obligation** (mint a run id → log work packages *before* the work → log real events → run the contract gate before claiming done), the `/forge` command actually invokes the gate at completion, and the router's PRD step is a numbered obligation with a runnable command instead of a noun.
- **Documented commands that did not run as printed.** `forge-verify.cjs --run <id>` was documented but unparsed; `forge-heartbeat.cjs`, `forge-report.cjs`, `forge-sync.cjs` and `forge-intake.cjs` examples in the quick reference were missing required subcommands or arguments. A run id may no longer begin with `-`.
- **The retired dashboard was still advertised as current.** The per-project Control Center (ports 3737–3999) was being auto-started as a fallback in the very same tree whose rules call it retired, and the copy-paste mission template pointed users at it. It now starts only on an explicit `legacy dashboard` request. Its `log-event.cjs` is *not* retired and remains the per-project run-event writer.
- **Kill switch reported success as failure.** Stopping the supervisor cascades to its children, so their own `taskkill` answered "process not found" — and the switch printed `FAILED` for processes it had just stopped. The verdict now comes from whether the PID is actually gone. `restore` also never returned, because it started a long-lived daemon with a blocking call; it now spawns detached and clears its ledger.
- **README claimed screenshots that were not in the repo.**

### Known limitations — measured on this exact release tree, not estimated

Some tests in this repo pin facts about *a populated installation*. In a fresh clone they fail honestly rather than being silently skipped. None of them indicates broken code — each is listed here with its real cause so you can tell a genuine regression from an expected gap.

- **Gateway suite: 935 of 971 pass.** The 36 failures are integration tests that expect a real Forge workspace (e.g. *"at least the known ~15 real projects"*, real run artifacts). They pass in a real installation.
- **Everything is green** (as of v2.4.0), including fresh-install CI (both `install.sh` and `install.ps1` into empty directories with empty HOME), the full doctor (110+ suites), `node --check` on all 203 sources, honesty gates, agent validation, and leak scans (no secrets found).

Fixing the first three properly means separating installation pins from unit tests, which is a real piece of work rather than a line in a changelog.

## [2.0.0] - 2026-07-18

First public open-source release of Forge V2 — a zero-dependency, multi-agent
build / automation / review / delivery system for Claude Code.

### Added

- **Four install methods** that all converge on one first-run funnel
  (`/setup-forge`):
  - **Claude Code plugin** (LITE) — `/plugin marketplace add ForgeyClap/claude-forge`
    then `/plugin install forge@claude-forge`; namespaced commands `/forge:forge`
    and `/forge:setup-forge`.
  - **One-line installer** (FULL) — `install.sh` (curl \| bash) and
    `install.ps1` (irm \| iex) with a merge-safe, backup-before-overwrite copy.
  - **Clone + run installer** — reviewable, with `--project`, `--yes`,
    `--dry-run`, `--global-only`, and `--project-only` flags.
  - **Manual copy** — documented baseline fallback.
- **`/setup-forge` onboarding wizard** — friendly first-run flow that asks your
  name, goal, project type, and preferred language, auto-detects repo signals,
  and is idempotent / self-healing on re-runs
  (`disable-model-invocation: true`, so it never auto-fires).
- **Beginner-safe key setup** — writes a temporary, already-gitignored
  `.env.forge-setup` fill-file with commented placeholders; on your "done"
  signal it moves real values into the gitignored `.env`, writes a
  values-free `.env.example`, and deletes the temp file. Keys are never
  committed and never echoed back.
- **18 Boss agents** — boss, build-boss, review-boss, test-boss, ui-boss,
  seo-boss, search-boss, security-boss, integration-boss, skill-boss,
  docs-boss, head-chef, codex-reviewer, data-scientist, electron-pro,
  mcp-developer, ml-engineer, and payment-integration.
- **23 skills** — including `forge-core`, the domain playbooks
  (`forge-website`, `forge-fullstack`, `forge-n8n`, `forge-rag`,
  `forge-scraping`, `forge-prediction`, `forge-integration`), plus
  `forge-router`, `forge-report`, `forge-verify`, `forge-registry`,
  `forge-prd`, `forge-intake`, `forge-graded-verify`, `forge-deeplearn`,
  `forge-heartbeat`, `forge-mindmap`, `forge-doctor`, `forge-agent-report`,
  `ship-readiness`, `humanizer`, and `gsap`.
- **Per-project isolated dashboard** — a local-only Control Center on a stable,
  path-derived port (3737–3999). Shows real activity only; never shared or
  global.
- **Honest agent ledger + reports** — every run records which agents really
  worked, with evidence, and no fabricated "done" claims.
- **`forge-doctor` self-test + secret/leak scan** — `node --check`s every
  source, runs the test suites, verifies the honesty gate, confirms the
  dashboard SPA is intact, and scans git-tracked files for leaked secrets.
- **Repo packaging** — MIT license, README, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/` templates and CI
  (`claude plugin validate . --strict`), and [ADR 0001](docs/adr/0001-plugin-vs-installer-split.md)
  recording the plugin-vs-installer split and the two ship invariants.

### Security

- Zero runtime dependencies (plain Node `.cjs`, POSIX `sh`, PowerShell,
  Markdown / JSON / YAML) — no supply-chain surface from npm packages or native
  modules.
- `.env` and the temporary fill-files are gitignored and never committed; the
  repo ships secret-free. See [SECURITY.md](SECURITY.md).

[Unreleased]: https://github.com/ForgeyClap/claude-forge/compare/v2.7.2...HEAD
[2.7.2]: https://github.com/ForgeyClap/claude-forge/compare/v2.7.1...v2.7.2
[2.7.1]: https://github.com/ForgeyClap/claude-forge/compare/v2.7.0...v2.7.1
[2.7.0]: https://github.com/ForgeyClap/claude-forge/compare/v2.4.0...v2.7.0
[2.4.0]: https://github.com/ForgeyClap/claude-forge/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/ForgeyClap/claude-forge/compare/v2.0.0...v2.3.0
[2.2.0]: https://github.com/ForgeyClap/claude-forge/commits/main
[2.1.0]: https://github.com/ForgeyClap/claude-forge/commits/main
<!-- v2.1.0 and v2.2.0 were released without git tags; their links point at the commit history. Tags exist from v2.3.0 on. -->

[2.0.0]: https://github.com/ForgeyClap/claude-forge/releases/tag/v2.0.0
