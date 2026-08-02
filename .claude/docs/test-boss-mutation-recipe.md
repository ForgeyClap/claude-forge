# Test Boss mutation-testing recipe (forge-mutate wiring)

WHY: a green test suite proves the code ran, not that the tests actually **pin down** the
behavior. This project has already seen a large green suite hide an untested critical file.
`forge-mutate.cjs` (zero-dependency, `.claude/forge-bin/forge-mutate.cjs`) measures this
directly by mutating the source in small ways and counting how many mutants the paired test
suite actually kills. Test Boss runs it after writing/changing tests for a deliverable, on the
exact `.cjs` module(s) Build Boss changed — never on the whole repo at once.

## When to run it

- After writing NEW tests for a changed/new `.cjs` module (the deliverable this work package
  touched), before reporting the work package as tested.
- Skip only when the changed file has no paired `.test.cjs` suite yet (report that gap instead —
  do not fabricate a mutation score for tests that don't exist).

## Exact commands

```bash
# from the project root
node .claude/forge-bin/forge-mutate.cjs .claude/forge-bin/<target>.cjs --test .claude/forge-bin/<target>.test.cjs

# large module: sample a reproducible subset instead of the full mutant set (still deterministic)
node .claude/forge-bin/forge-mutate.cjs .claude/forge-bin/<target>.cjs --sample 40 --seed wp-<id>

# slow-but-healthy suite: raise the timeout ceiling (does NOT change scoring, only avoids a false
# "baseline is not green" refusal on a suite that legitimately takes longer than 20s)
node .claude/forge-bin/forge-mutate.cjs .claude/forge-bin/<target>.cjs --timeout 40000

# full JSON report (for pasting exact survivor lines into the forge-report)
node .claude/forge-bin/forge-mutate.cjs .claude/forge-bin/<target>.cjs --json
```

Exit code 0 means the run completed honestly (baseline was green and mutants were scored) —
it is **not** a pass/fail gate by itself. A red exit code (1) means the tool refused to run
(bad args, missing files, or a baseline that isn't green — fix the suite first).

## Reading the result

- `killed` / `survived` / `skipped` / `score` — score = killed / (killed + survived).
- `survivors[]` — each entry is one line + exact mutation the suite did NOT catch. **A surviving
  mutant with no failing test is a hollow-test finding**: the test file touches that code path
  but does not actually assert on the behavior that line encodes.
- `skippedList[]` — mutants that didn't parse (`node --check` failed); excluded from scoring,
  not a finding.

## What to report to Head Chef / Build Boss

For each survivor, name the file, line, exact mutation (`original -> replacement`), and what
assertion is missing (e.g. "line 142: `<` -> `<=` survived — no test exercises the boundary
value"). Route real survivors back to Build Boss as a hollow-test fix, the same way a failing
test would be routed. Do not silently accept a low score — a `score` well below the target
module's own paired-suite norm (see existing forge-bin `.test.cjs` files for comparison) is a
finding worth surfacing even if every existing assertion still passes.

## Non-negotiables

- Never run this against a target with no paired test file and report a score anyway.
- Never claim a mutation run happened without pasting the real `killed/survived/score` numbers.
- `forge-mutate.cjs` never touches the real target file (isolated `os.tmpdir()` copy) — if a
  run ever reports `targetUnchanged: false`, treat that as a tool bug, not a test result, and
  stop.
