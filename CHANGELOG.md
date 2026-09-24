# Changelog

All notable changes to **claude-forge** (Forge V2) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Nothing yet. Open a PR — see [CONTRIBUTING.md](CONTRIBUTING.md).

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

[Unreleased]: https://github.com/ForgeyClap/claude-forge/compare/v2.4.0...HEAD
[2.4.0]: https://github.com/ForgeyClap/claude-forge/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/ForgeyClap/claude-forge/compare/v2.0.0...v2.3.0
[2.2.0]: https://github.com/ForgeyClap/claude-forge/commits/main
[2.1.0]: https://github.com/ForgeyClap/claude-forge/commits/main
<!-- v2.1.0 and v2.2.0 were released without git tags; their links point at the commit history. Tags exist from v2.3.0 on. -->

[2.0.0]: https://github.com/ForgeyClap/claude-forge/releases/tag/v2.0.0
