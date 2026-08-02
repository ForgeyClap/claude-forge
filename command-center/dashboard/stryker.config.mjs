// @ts-check
/**
 * Forge Workspace — scoped mutation testing (mission §46 / section L).
 *
 * WHY THESE THREE FILES AND NO OTHERS
 * `mutate` is deliberately narrow. A surviving mutant is a gap in the tests,
 * and the gaps that matter most live in the pure, security-critical modules
 * where a wrong branch or a flipped comparison can turn into a silent lie
 * about system state or a hole in the filesystem sandbox:
 *
 *   - src/shared/state-machines.ts   the transition tables + evidence gates
 *                                     that make a fake status structurally
 *                                     impossible. A surviving mutant here is
 *                                     a transition or a gate check the tests
 *                                     never actually exercised.
 *   - src/bridge/security/paths.ts    the path guard every filesystem write
 *                                     crosses. A surviving mutant here is a
 *                                     potential traversal/escape the security
 *                                     suite did not actually catch.
 *   - src/bridge/usage/aggregator.ts  the accuracy-labelling arithmetic (EXACT
 *                                     / DERIVED / ESTIMATED / UNAVAILABLE). A
 *                                     surviving mutant here is a place the UI
 *                                     could show a number with a confidence it
 *                                     has not earned.
 *
 * Keeping `mutate` to these three keeps the run bounded: Stryker only injects
 * mutants into these files, then (via coverageAnalysis: 'perTest' + Vitest's
 * --related) runs only the tests whose import graph actually touches the
 * mutated file — not the full suite (integration/e2e included) on every mutant.
 *
 * WHY vite.config.ts AND NOT A DEDICATED CONFIG
 * All three target files are already exercised by the "unit", "bridge" and
 * "fuzz" vitest projects declared in vite.config.ts (usage-shape.test.ts;
 * negative/operations.test.ts + negative/events.test.ts + property/invariants.test.ts;
 * fuzz/inputs.test.ts, respectively). @stryker-mutator/vitest-runner drives
 * Vitest's own Node API and iterates `ctx.projects`, so a workspace config
 * with multiple projects is supported directly — no need to fork a second,
 * unscoped vitest config just for this run. See docs/mutation-report.md for
 * what was verified and, if it ever stops working, what was tried instead.
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: {
    configFile: 'vite.config.ts',
    // Investigated `related: false` as a fix for a mutant-run slowdown (see
    // `concurrency` below) and it was a dead end: the slowdown reproduced
    // identically with `related` on or off, so it was not related-mode
    // overhead. Left at the default (true) because it is strictly better here
    // — it keeps the one-off initial dry run scoped to the ~41-106 test files
    // actually related to each mutated file (vs. the full ~370-test suite),
    // AND it keeps tests/unit/no-runtime-contact.test.ts and tests/unit/
    // runtime-declarations.test.ts (whole-src-tree text scanners, see
    // `ignorePatterns` below) out of the run entirely, since neither imports
    // any of the three mutated files and so neither is ever "related" to
    // them. They are still listed in `ignorePatterns` as a documented,
    // defense-in-depth exclusion in case that ever changes.
  },

  mutate: [
    'src/shared/state-machines.ts',
    'src/bridge/security/paths.ts',
    'src/bridge/usage/aggregator.ts',
  ],

  // Nothing here is needed to run the relevant tests; skipping the copy keeps
  // sandbox creation fast and — for .claude specifically — keeps the real
  // Forge install untouched by the mutation run's temp sandbox entirely.
  //
  // tests/idempotency/repeat.test.ts is excluded for a documented, verified
  // reason, not convenience: @stryker-mutator/vitest-runner hardcodes
  // `pool: 'threads'` (worker_threads) for every run regardless of what
  // vite.config.ts specifies. Its "createProject requestId (router cache)"
  // test redirects os.homedir() by mutating process.env.USERPROFILE/HOME for
  // the duration of the test — a real, working technique under the default
  // vitest pool ('forks'), but Node's worker_threads keep process.env local to
  // the worker's JS layer; the native os.homedir() binding does not observe
  // it. Under Stryker's forced threads pool the redirect silently no-ops, the
  // operation resolves the machine's REAL Documents\ForgeProjecten instead of
  // the test's temp dir, and the assertion on the temp path throws ENOENT —
  // in the plain `npm test` run (pool: 'forks') this same test passes. See
  // docs/mutation-report.md for the exact error and why this is a tooling
  // interaction, not a defect in any of the three mutated files. Every other
  // test file that covers state-machines.ts / paths.ts / aggregator.ts
  // (negative/operations, negative/events, property/invariants, fuzz/inputs,
  // unit/usage-shape) passed the dry run under the same forced pool.
  ignorePatterns: [
    '.claude',
    '.forge-workspace',
    'artifacts',
    'capability',
    'dist',
    'playwright-report',
    'test-results',
    'product',
    'docs',
    'tests/e2e',
    'tests/idempotency/repeat.test.ts',
    // tests/unit/no-runtime-contact.test.ts reads every src/**/*.ts file off
    // DISK as raw text (readFileSync) and regex-scans it for banned patterns
    // like a literal `exec(`. That is a legitimate, valuable static guard
    // against real source — but Stryker's instrumentation rewrites the
    // sandbox copy of a mutated file into a ternary "mutant switch" for every
    // injected mutant, active for the whole session. Verified: with
    // `related: false` (which makes the dry run execute the full suite
    // instead of only the --related subset) this test failed against the
    // INSTRUMENTED paths.ts — its own `.exec(` filter (RegExp.prototype.exec
    // is legitimate and excluded by design; see the test's own comment) missed
    // a hit because Stryker's ternary rewrite of a regex literal used in a
    // `pattern.exec(line)` call reflowed the statement across source lines,
    // separating `.exec(line)` from the text the filter expected it attached
    // to. Zero behavioural relevance to state-machines.ts / paths.ts /
    // aggregator.ts's actual logic — it is a whole-tree text linter, not a
    // unit test of any of the three mutated files — so it is excluded from
    // the mutation sandbox rather than treated as a real finding. The real,
    // unmutated paths.ts still passes it in `npm test`. tests/unit/
    // runtime-declarations.test.ts runs the identical whole-src-tree text
    // scan (same `scan()`/`.exec(`-filter helper, same false positive against
    // the same instrumented line in paths.ts) and is excluded for the
    // identical, verified reason.
    'tests/unit/no-runtime-contact.test.ts',
    'tests/unit/runtime-declarations.test.ts',
    // tests/fuzz/inputs.test.ts is excluded for a MEASURED cost reason, not a
    // correctness one, and it is the most consequential exclusion in this
    // file — read docs/mutation-report.md's "scope" section before trusting
    // the path-guard score at face value. sanitizeSlug/assertInsideRoot are
    // covered almost entirely by this fuzz file, which drives thousands of
    // generated inputs through each. With it in the run, mutating paths.ts
    // alone (711 non-static mutants after `ignoreStatic`) stalled at the same
    // ~330-340/711 mark on every attempt — with `related` on and off, and at
    // concurrency 4 AND concurrency 10 (ruling out both related-mode overhead
    // and parallelism as the cause) — because coverageAnalysis:'perTest'
    // correctly re-runs the FULL fuzz corpus for every one of the ~250-380
    // mutants that land inside those two functions, and each such re-run
    // through Stryker's coverage-instrumented code costs real seconds, not
    // the sub-millisecond a single fuzz input costs uninstrumented. Projected
    // total: 20-30+ minutes for paths.ts ALONE, which is not a bounded,
    // interactive pass by any measure. state-machines.ts does not lose
    // equivalent coverage: its fuzz coverage (tests/fuzz/inputs.test.ts's
    // "fuzzing the run state machine" / "fuzzing every state machine" blocks)
    // overlaps almost entirely with tests/property/invariants.test.ts, which
    // stays IN this run (it is in the "bridge" project, not "fuzz", and was
    // not the source of the stall). paths.ts is the one file that loses real
    // coverage here — its mutation score in docs/mutation-report.md is
    // reported as a measured LOWER BOUND for exactly this reason, with a
    // recommendation to run a fuzz-inclusive pass separately as a longer,
    // non-interactive job (nightly/CI), not folded into this scoped pass.
    'tests/fuzz/inputs.test.ts',
  ],

  // MEASURED: at concurrency 3-4 (the "sane" range this config started with),
  // mutating just paths.ts (711 non-static mutants) reproducibly progressed
  // fast for the first ~330 mutants, then crawled — 12-25 mutants per minute
  // for several minutes straight, CPU busy the whole time, with the same
  // stall arriving at roughly the same mutant count on every retry regardless
  // of `related`. Cause: sanitizeSlug/assertInsideRoot are covered by
  // tests/fuzz/inputs.test.ts, which drives thousands of generated inputs
  // through them (see that file's own "total inputs generated" tally) —
  // legitimately expensive to re-run per mutant, and coverageAnalysis:
  // 'perTest' correctly re-runs exactly that fuzz test for every mutant
  // inside those two functions. That cost is real and worth paying (the fuzz
  // suite is the strongest signal this run has for the path guard), so the
  // fix is not to drop it — it's to stop leaving this 22-logical-core machine
  // 80%+ idle. Raised from 4 to 10, well under the core count, and confirmed
  // this cut the paths.ts wall time roughly in proportion to the extra
  // workers. See docs/mutation-report.md for the measured before/after.
  concurrency: 10,
  coverageAnalysis: 'perTest',
  reporters: ['html', 'clear-text', 'progress'],

  // MEASURED, not guessed: a first real run (see docs/mutation-report.md) hit
  // 4139 total mutants, of which Stryker's own planner flagged 2054 (50%) as
  // STATIC — module-top-level literals (the frozen transition-table objects
  // and state arrays in state-machines.ts, mostly) that require reloading the
  // whole test environment and re-running the ENTIRE covering suite per
  // mutant, rather than the few tests coverageAnalysis:'perTest' can filter
  // to for an ordinary (non-static) mutant. The non-static 2085 mutants tested
  // at a rate of >1000/minute; the static ones alone pushed the projected
  // total past 1-3 HOURS and climbing, which is not a "bounded, scoped pass"
  // by any reading of that phrase. `ignoreStatic` is Stryker's own documented
  // fix for exactly this. It trades away mutation coverage of the literal
  // VALUES inside the frozen tables (e.g. "CANCELLED" swapped for another
  // string as a table entry) — but that surface is already covered by a
  // different, better-suited mechanism in this codebase:
  // `validateMachineRegistry()` / `assertMachineRegistryValid()` structurally
  // checks every table (every transition target is a declared state, every
  // terminal state has no outgoing transitions, no self-transitions, no
  // duplicates, total coverage of the protocol's state vocabularies) and is
  // itself exercised by the property suite. What `ignoreStatic` does NOT skip
  // is the actual behavioural logic this run exists to check: every
  // conditional, comparison, boolean operator and branch inside
  // explainTransitionIn/assertEvidence/the paths.ts guard
  // functions/aggregator.ts's accuracy arithmetic — all of that is ordinary,
  // per-function, non-static code and stays fully in scope.
  ignoreStatic: true,

  // Node runs these .ts files directly (type-stripping, no ts-node/tsx build
  // step), so a cold Vitest project start is the dominant per-run cost, not
  // compilation. Generous but not unbounded: real infinite loops still time
  // out well inside a "several minutes" budget for ~3 small pure files.
  timeoutMS: 60_000,
  timeoutFactor: 2,

  disableTypeChecks: true,
};
