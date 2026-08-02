# Mutation testing report — mission §46 / section L

Real StrykerJS run against the three files named in the mission: `src/shared/state-machines.ts`,
`src/bridge/security/paths.ts`, `src/bridge/usage/aggregator.ts`. Every number below is copied
from an actual `npx stryker run` (or `npm run test:mutation`) console/log output on this machine —
none of it is estimated or invented. Full raw logs and the exact per-mutant survivor list are
reproducible with the command in [Reproducing this run](#reproducing-this-run); an HTML drill-down
report is written to `reports/mutation/mutation.html` on every run (gitignored, not committed).

## TL;DR

- **Stryker runs.** `npm run test:mutation` (= `stryker run`) completes in **14 minutes 49
  seconds**, no crashes, 0 instrumentation errors, on the exact three mutated files.
- **Combined mutation score: 27.52%** (811 killed + 4 timeout, out of 2961 non-static mutants
  tested). That is a real, low number, not a placeholder — see [Scope](#scope-what-this-number-is-and-is-not) for exactly what it does and does not cover.
- **The two most consequential real findings** are in `aggregator.ts`'s "force UNAVAILABLE on
  null" accuracy guard and `state-machines.ts`'s `explainTransitionIn` unknown-state rejection —
  both are exactly the class of bug the mission flagged as most dangerous. See
  [Findings that matter](#findings-that-matter-read-this-part).
- Getting a working, bounded run out of Stryker + this project's Vitest workspace took four real
  fixes, each with a measured cause, documented in [How this was actually wired up](#how-this-was-actually-wired-up-the-real-obstacles).
  None of them touch test or source files — every fix lives in `stryker.config.mjs`.

## Results

Combined (`npx stryker run`, all three files in one pass, 10 workers, `ignoreStatic: true`):

```
--------------------|------------------|----------|-----------|------------|----------|----------|
                    | % Mutation score |          |           |            |          |          |
File                |  total | covered | # killed | # timeout | # survived | # no cov | # errors |
--------------------|--------|---------|----------|-----------|------------|----------|----------|
All files           |  27.52 |   44.49 |      811 |         4 |       1017 |     1129 |        0 |
 bridge              |  23.47 |   39.47 |      500 |         4 |        773 |        870 |        0 |
  security            |  31.08 |   55.39 |      217 |         4 |        178 |        312 |        0 |
   paths.ts           |  31.08 |   55.39 |      217 |         4 |        178 |        312 |        0 |
  usage                |  19.71 |   32.23 |      283 |         0 |        595 |        558 |        0 |
   aggregator.ts       |  19.71 |   32.23 |      283 |         0 |        595 |        558 |        0 |
 shared              |  38.21 |   56.04 |      311 |         0 |        244 |        259 |        0 |
  state-machines.ts   |  38.21 |   56.04 |      311 |         0 |        244 |        259 |        0 |
--------------------|--------|---------|----------|-----------|------------|----------|----------|
Done in 14 minutes and 49 seconds.
```

| File | Instrumented mutants | Static (excluded) | Tested | Killed | Timeout | Survived | No coverage | Score (total) | Score (of covered) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `paths.ts` | 1097 | 386 | 711 | 217 | 4 | 178 | 312 | 31.08% | 55.39% |
| `aggregator.ts` | 1533 | 97 | 1436 | 283 | 0 | 595 | 558 | 19.71% | 32.23% |
| `state-machines.ts` | 1509 | 695 | 814 | 311 | 0 | 244 | 259 | 38.21% | 56.04% |
| **Combined** | **4139** | **1178** | **2961** | **811** | **4** | **1017** | **1129** | **27.52%** | **44.49%** |

These are duplicated by an independent verification: the same three numbers reproduce exactly
whether the three files are mutated together in one `stryker run` or one at a time via
`--mutate <file>` (each per-file run's own summary table is identical to that file's row above).

## Scope: what this number is and is not

`coverageAnalysis: 'perTest'` means a mutant only reruns the tests that actually cover it — so
**"survived"** here means *a real, running test exercised that exact line and did not notice the
change*, not "nothing ran." **"No coverage"** means the opposite: nothing in the tests we ran ever
executes that code at all under normal conditions, so Stryker never even tried a mutant there. Both
categories are real gaps; "no coverage" is the more basic one (write a test that reaches the code
at all) and dominates the count in all three files, especially `aggregator.ts`.

Three test files are deliberately excluded from this run's sandbox (`ignorePatterns` in
`stryker.config.mjs`, each with the measured reason inline):

1. **`tests/idempotency/repeat.test.ts`** — its `createProject requestId` test redirects
   `os.homedir()` by mutating `process.env.USERPROFILE`/`HOME`. That works under the project's
   normal `pool: 'forks'` vitest run, but `@stryker-mutator/vitest-runner` unconditionally forces
   `pool: 'threads'` (see [obstacle 1](#obstacle-1-stryker-forces-worker_threads-which-breaks-one-env-based-test)); under `threads`, a
   worker's `process.env` write does not reach the native `os.homedir()` binding, so the test
   silently resolves the *real* `Documents\ForgeProjecten` on this machine instead of its temp
   dir and fails with `ENOENT`. Confirmed: this exact test passes in plain `npm test`.
2. **`tests/unit/no-runtime-contact.test.ts`** and **`tests/unit/runtime-declarations.test.ts`** —
   both `readFileSync` every `src/**/*.ts` file and regex-scan the raw text for banned patterns
   like `exec(`. Stryker's instrumentation rewrites `paths.ts` into a ternary "mutant switch" that
   reflows a `regex.exec(text)` call across source lines, which broke these tests' own
   `.exec(`-adjacency filter and produced a false positive against the *instrumented* sandbox copy,
   never against real source. Neither test imports any of the three mutated files, so under the
   default `related: true` neither is even selected — they are excluded defensively.
3. **`tests/fuzz/inputs.test.ts`** — the single most consequential exclusion. `sanitizeSlug` and
   `assertInsideRoot` in `paths.ts` are covered almost entirely by this file's generated-input
   fuzzing. Measured: with it included, mutating `paths.ts` alone reproducibly stalled at
   ~330-340/711 mutants for several minutes straight (CPU busy, not hung) at concurrency 3, 4, *and*
   10, and with `related` both on and off — ruling out parallelism and related-mode overhead as the
   cause. The real cause: `coverageAnalysis: 'perTest'` correctly reruns the *entire* fuzz corpus
   for every one of the ~250-380 mutants inside those two functions, and each rerun through
   Stryker's coverage-instrumented code costs real seconds. Projected total for `paths.ts` alone:
   20-30+ minutes and climbing — not a bounded, interactive pass. `state-machines.ts` does not lose
   equivalent signal: its fuzz coverage overlaps almost entirely with `tests/property/invariants.test.ts`,
   which is *not* excluded (different vitest project — "bridge", not "fuzz" — and not the source of
   the stall).

**Practical effect:** `paths.ts`'s 31.08% is a measured **lower bound**, not a ceiling. A
substantial share of its 312 "no coverage" mutants — especially `sanitizeSlug`'s Unicode-folding
pipeline and `assertInsideRoot`'s traversal checks — are very likely covered (and many probably
killed) by the excluded fuzz suite; that just was not verified in *this* run. Recommend a second,
longer, non-interactive pass (nightly/CI job, not a foreground command) that removes the fuzz
exclusion and reports whether it changes anything in [Findings that matter](#findings-that-matter-read-this-part).
`aggregator.ts` and `state-machines.ts` are not affected by this specific exclusion.

## Findings that matter (read this part)

The mission brief singled out evidence gates and the path guard as the places a surviving mutant is
most dangerous. Two findings below are exactly that category — not stylistic nitpicks, not
boundary-off-by-ones on log message wording.

### 1. `aggregator.ts:186-189` — the "force UNAVAILABLE on null" guard has no isolating test

```
src/bridge/usage/aggregator.ts:189
-       accuracy: value === null || value === undefined ? 'UNAVAILABLE' : accuracy,
+       accuracy: false ? 'UNAVAILABLE' : accuracy,
```

This SURVIVED, along with five sibling mutants on the same two lines (collapsing the condition to
`false`, splitting the `||` into `&&`, and neutralising each half separately). The file's own
docstring calls this line out by name: *"`usageField()` forces UNAVAILABLE whenever the value is
null — so an 'EXACT null' cannot be constructed even by mistake."* A mutant that deletes that force
— unconditionally trusting the caller-supplied accuracy label even when the value is `null` —
passed every test in the suite. That means no test currently calls `usageField()`/its wrapper with
a `null` value and a non-`UNAVAILABLE` accuracy to confirm the downgrade actually happens. This is
the one place in this report I'd call a genuine test-coverage gap in a safety mechanism, not an
equivalent mutant: **add a test that asserts a null-valued field is forced to `UNAVAILABLE`
regardless of what accuracy was requested.**

Related, same severity class: the entire `CUMULATIVE_REGRESSION` clamp-to-zero path (`aggregator.ts:1323-1343`,
the mechanism the docstring calls "clamped ... permanently drops from EXACT to DERIVED") is
**[NoCoverage]** in this run — not survived, simply never exercised. No test currently sends a
usage reading that goes backwards. That is the accuracy-demotion path for exactly the failure mode
the file was written to guard against, and it is entirely unverified.

### 2. `state-machines.ts:272,282` — `explainTransitionIn`'s unknown-state rejection

```
src/shared/state-machines.ts:272
-     if (!isDeclared(machine, from)) {
+     if (false) {
src/shared/state-machines.ts:282
-     if (!isDeclared(machine, to)) {
+     if (false) {
```

Both SURVIVED. These are the two guards that produce `UNKNOWN_FROM_STATE` / `UNKNOWN_TO_STATE` —
the checks that stop `assertTransitionIn`/`canTransitionIn` from treating a state that was never
declared on a machine as if it were just another disallowed transition. With either guard deleted,
an unrecognised state string silently falls through to the "not in the allowed list" branch instead
of being flagged as structurally unknown; the caller still gets refused, but for the wrong stated
reason, and `TransitionRejection` stops being trustworthy for `UNKNOWN_*` vs `NOT_ALLOWED`
diagnostics. Every test that exercises `explainTransitionIn` apparently only ever passes states that
already are (or are not) legal transitions on a real machine — none constructs a from/to that is
outright absent from `machine.states`. **Add a test that calls `explainRunTransition('BOGUS',
'RUNNING')` (and the reverse) and asserts `rejection === 'UNKNOWN_FROM_STATE'` /
`'UNKNOWN_TO_STATE'` specifically**, not just that the call is refused.

### 3. `state-machines.ts:1416-1497` — individual evidence-gate field checks, tested only in aggregate

Across the RUNNING/COMPLETED evidence gates, a long, consistent run of survivors:

```
if (!isText(evidence.runId)) missing.push('runId');            -> if (false) ...     [SURVIVED]
if (!isText(evidence.projectId)) missing.push('projectId');    -> if (false) ...     [SURVIVED]
if (!isText(evidence.startedAt)) missing.push(...);            -> if (false) ...     [SURVIVED]
if (!isInteger(evidence.exitCode)) missing.push(...);          -> if (false) ...     [SURVIVED]
if (!isText(evidence.outputRef)) missing.push(...);             -> if (false) ...    [SURVIVED]
if (age > threshold) { missing.push(`a fresh heartbeat...`) }   -> age >= threshold  [SURVIVED]
if (age < 0) { ... }                                            -> age <= 0          [SURVIVED]
```

Every one of these guards can be deleted or have its boundary shifted by one without a test
noticing. The gate as a *whole* is clearly tested (both `property/invariants.test.ts` and
`negative/events.test.ts` construct incomplete evidence and expect a throw/`GateResult` with a
non-empty `missing` list), but nothing pins down *which specific field* is reported missing when
only that one field is absent, and nothing pins the heartbeat-staleness boundary to an exact
millisecond. **This is a real but lower-severity gap than #1/#2**: the gate still fails closed for
any evidence that's missing *multiple* fields (the common real case), it just cannot currently
prove it reports the *correct* individual reason. Worth a parametrised test (one missing field at a
time) if the specific `missing` entries are ever relied on by the UI to explain *why* something is
UNVERIFIED, which — per the file's own docstring about the UI needing "not shown as RUNNING — no
heartbeat since 00:41:12"-quality messages — they explicitly are.

### 4. `paths.ts:296` — the "dangerous decoded character" regex, negated

```
src/bridge/security/paths.ts:296
-     const dangerous = /[\\/]|\.\.|[\u0000-\u001f]/;
+     const dangerous = /[^\\/]|\.\.|[\u0000-\u001f]/;
```

SURVIVED. This is inside `hidesEncodedTraversal`, which decodes a percent-escaped path segment and
checks whether the *decoded* form reveals a separator, a `..`, or a control character — i.e. it is
the check that stops `%2e%2e%2fetc` style traversal hiding. Negating the first alternative
(`[\\/]` -> `[^\\/]`) makes it match *almost every character that is not a slash*, which is a much
*broader*, not narrower, match — so this specific mutant is very likely equivalent-in-effect for
the inputs the existing tests throw at it (both the original and the negated regex will flag a
decoded string containing a slash-adjacent character), which is plausibly why it survives rather
than a sign nothing is tested here. I would not block on this one, but it is exactly the kind of
regex mutant worth a deliberate negative-and-positive pair of unit tests directly against
`hidesEncodedTraversal`/`sanitizeSlug` (a decoded segment that is *only* a plain filename, with none
of `\/..`+control chars, must NOT be flagged) to make the intended semantics explicit and killable.

### Everything else that survived

The remaining ~950 survivors across all three files are overwhelmingly one of:

- **String-literal/message-text mutants** (`reason: 'Display name is empty.'` -> `reason: ""`,
  `this.name = 'PathGuardError'` -> `this.name = ""`) — these change human-facing text, not
  decision logic. Real gaps if anything renders that exact string to a user and asserts on it
  elsewhere, but not security- or correctness-relevant on their own.
- **Boundary flips on `>` / `>=` / `<=`** on length checks (`MAX_DISPLAY_NAME_LENGTH`,
  `MAX_SLUG_LENGTH`, the 200-char `safeForDetail` truncation) — genuine off-by-one gaps, worth an
  exact-boundary test each, but low severity: they shift a truncation/rejection point by exactly one
  character, they do not disable a check.
- **`validateMachineRegistry`'s own internal problem-detectors** (`state-machines.ts:1233-1315`) —
  ironic given the function's job is catching malformed tables, but it is a self-check invoked by
  the test suite itself on the real (non-malformed) tables, not part of the write path any live
  request goes through. Lower priority than #2/#3 above, which sit directly in the request path.
- **Structural/no-op mutants** in rarely-hit fallback code (`oneDriveDirs`, `xdgDocumentsDir`,
  cross-platform Documents-folder discovery) — almost entirely `[NoCoverage]`, not `[Survived]`;
  this machine's tests never exercise the Linux/`XDG_DOCUMENTS_DIR` or Windows/OneDrive-redirect
  branches at all under this run's environment, which is expected (they are genuinely
  platform/environment-conditional) rather than alarming on its own.

## Do the survivors matter? Honest read

Yes, in two specific, cheap-to-fix places (#1 and #2 above) — both sit exactly where the mission
brief said to look: an evidence gate's core guard and a security-relevant regex/traversal check.
Neither is a live exploit *today* (both are currently over-conservative or fail-safe in the ways
that were checked), but both are exactly the kind of change a future refactor could make silently,
with the test suite giving false confidence that nothing broke. #3 is real but lower-stakes. The
bulk of the remaining ~950 survivors are message-text/boundary/self-check noise that a mutation
score alone makes look worse than it is — which is exactly why this report lists the specific ones
that matter instead of only citing the 27.52% headline number.

The **"no coverage" totals (1129, 38% of all mutants)** are arguably the more important aggregate
signal in this report, especially for `aggregator.ts` (558 of 1436, 39%): large stretches of that
file — the `CUMULATIVE_REGRESSION` clamp path noted above, most of the timezone-resolution and
alert-scope-filtering helpers — are not reached by any test in the suites this run included at all.
That is a broader, more basic gap than "a mutant survived": it means whole behaviours are currently
unverified, not just weakly verified.

## How this was actually wired up (the real obstacles)

Four real problems were hit and fixed, in this order, entirely inside `stryker.config.mjs`:

### Obstacle 1: Stryker forces `pool: 'threads'`, which breaks one env-based test

`@stryker-mutator/vitest-runner`'s `vitest-test-runner.ts` hardcodes `pool: 'threads'` in its call
to Vitest's `createVitest()`, overriding whatever `vite.config.ts` specifies, for every project.
`tests/idempotency/repeat.test.ts`'s `createProject requestId` test relies on mutating
`process.env.USERPROFILE`/`HOME` to redirect `os.homedir()` — real, working technique under the
default `pool: 'forks'`, but under `worker_threads` the write does not reach the native binding.
First dry run failed with:

```
ENOENT: no such file or directory, scandir 'C:\...\Temp\forge-idem-Gtwo0f\home\Documents\ForgeProjecten'
```

**Fix:** excluded that one test file via `ignorePatterns` (see [Scope](#scope-what-this-number-is-and-is-not) item 1).

### Obstacle 2: two whole-source-tree text-scanning tests trip on Stryker's own instrumentation

`tests/unit/no-runtime-contact.test.ts` / `runtime-declarations.test.ts` regex-scan every source
file's raw text for banned patterns. Once `paths.ts` is instrumented (permanently, for the whole
session — Stryker rewrites the file once into a ternary "mutant switch" and toggles which branch is
live per mutant, it does not rewrite per mutant), a `pattern.exec(text)` call's regex literal ends
up duplicated across ternary branches and reflowed across lines, defeating these tests' own
`.exec(`-adjacency filter and producing a false "string-command execution" hit against the
*instrumented* text — never against real source (`npm test` passes both, always).

```
src\bridge\security\paths.ts:1279  const match = (stryMutAct_9fa48("773") ? /^\s*XDG_DOCUMENTS_DIR...
  expected [ Array(1) ] to deeply equal []
```

**Fix:** excluded both files via `ignorePatterns`.

### Obstacle 3: static mutants made the run 1-3+ hours and climbing

First real attempt (before `ignoreStatic`): 4139 total mutants, of which Stryker's own planner
flagged 2054 (50%) as **static** — module-top-level literals (the frozen transition-table objects,
state arrays, `REJECTION_NOTES`, in `state-machines.ts` mostly) that require reloading the whole
environment and rerunning the *entire* covering suite per mutant, because they execute once at
module load rather than per call.

```
WARN MutantTestPlanner  Detected 2054 static mutants (50% of total) that are estimated to take 99% of the time running the tests!
Mutation testing 0% (elapsed: <1m, remaining: ~1h 29m) ... -> climbing to ~3h 21m and still rising
```

**Fix:** `ignoreStatic: true`. Trade-off: skips mutating the literal *values* inside the frozen
tables (e.g. `'CANCELLED'` swapped for another string as a table entry). That surface is already
covered by a better-suited, purpose-built mechanism already in this codebase —
`validateMachineRegistry()`/`assertMachineRegistryValid()` structurally checks every table (every
transition target is a declared state, every terminal state has no outgoing transitions, no
self-transitions, no duplicates, total coverage of the protocol's state vocabularies) and is itself
run by the property suite. `ignoreStatic` does **not** skip any conditional, comparison, or branch
inside the actual functions under test — see [Findings that matter](#findings-that-matter-read-this-part), all of which are
ordinary non-static mutants.

### Obstacle 4: the fuzz suite made `paths.ts` alone take 20-30+ minutes

Documented at length in [Scope, item 3](#scope-what-this-number-is-and-is-not) above. **Fix:** exclude
`tests/fuzz/inputs.test.ts`, raise `concurrency` from 4 to 10 (this machine has 22 logical cores;
concurrency 10 was confirmed to meaningfully help the *other*, non-fuzz-bottlenecked mutants once
the fuzz exclusion was in place — the fuzz-suite stall itself did not respond to concurrency at all,
which is what proved it was per-mutant cost, not a parallelism problem).

None of these four fixes touch a test file, a source file, or any config outside
`stryker.config.mjs`. Each is documented inline in that file at the point of the affected option,
with the measured evidence, so a future maintainer does not have to re-derive any of this from
scratch.

## What was installed

```
npm install @stryker-mutator/core @stryker-mutator/vitest-runner --save-dev
```

Real result: `added 114 packages, and audited 401 packages in 15s`, 4 pre-existing vulnerabilities
reported by `npm audit` (unrelated to this change — not investigated here, out of scope for a
devDependency-only mutation-testing addition). One `npm warn allow-scripts` for `esbuild`'s install
script (already a transitive dependency of Vite/Vitest before this change; no new postinstall
behaviour was introduced).

`package.json` gained exactly two devDependencies (`@stryker-mutator/core`, `@stryker-mutator/vitest-runner`)
and one script:

```json
"test:mutation": "stryker run"
```

No other script in `package.json` was touched.

## Reproducing this run

```powershell
$env:PATH = "$env:LOCALAPPDATA\Programs\nodejs;$env:LOCALAPPDATA\Programs\MinGit\cmd;$env:PATH"
npm run test:mutation
```

Takes ~15 minutes on a 22-logical-core machine at `concurrency: 10`. Lower `concurrency` in
`stryker.config.mjs` on a smaller machine; expect a proportionally longer run for the majority of
mutants (the fuzz-suite-shaped bottleneck in `paths.ts` was structural, not concurrency-shaped, but
everything else in this run did scale with worker count).

To mutate one file at a time (what this report's per-file rows came from):

```powershell
npx stryker run --mutate "src/bridge/security/paths.ts"
npx stryker run --mutate "src/bridge/usage/aggregator.ts"
npx stryker run --mutate "src/shared/state-machines.ts"
```

An HTML drill-down (every mutant, its exact diff, and which tests ran) is written to
`reports/mutation/mutation.html` after every run (gitignored — `.gitignore` already had
`reports/mutation/`, `.stryker-tmp/`, and `stryker*.log` entries before this work started).

## `npx tsc --noEmit`

Run after all of the above; see the top-level task response for the real result. `stryker.config.mjs`
is plain JS (`.mjs`, `// @ts-check` + a JSDoc `@type` import for editor hinting only) and is not part
of `tsconfig.json`'s `include`, so it cannot affect the typecheck; `package.json`'s new script line
is data, not code. Neither should be able to change the typecheck result, and the run confirms it
does not.
