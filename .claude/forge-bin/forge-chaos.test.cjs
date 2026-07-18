#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-chaos.cjs (WP5, 2026-07-14). Every fixture forge-chaos.cjs creates lives under a
 * fresh os.tmpdir() mkdtemp — this file never touches the real 12 Forge projects, the real forge-runs/, or
 * the network. It never edits forge-chaos.cjs's own dependencies (forge-store/forge-run-state/forge-report/
 * nvidia-provider/forge-sync/forge-verify/forge-doctor/log-event.cjs) — only requires/spawns the REAL
 * forge-chaos.cjs and, for one proof, injects a deliberately-fake dependency via forge-chaos.cjs's OWN
 * documented dependency-injection hook (opts.chainCheckFn) — never a source edit.
 *
 * Section map:
 *   1) full CLI run (--json)            — the real end-to-end tool, exit code, tally, tmpdir-containment proof
 *   2) --only filtering                 — exactly one scenario runs
 *   3) targeted direct-require checks   — fast scenarios re-asserted with specific evidence fields
 *   4) THE REQUIRED PROOF: a fake "always passes" chainCheck stub flips corrupt_hash_chain to FAIL, not PASS
 *   5) runAll() never lets a scenario silently count as pass — an uncaught throw, and an invalid status,
 *      both convert to 'fail'
 *   6) parseArgs() unit checks
 *   7) tmpdir containment — every directory this suite (and forge-chaos.cjs) created is under os.tmpdir()
 *   8) mock-short-circuit control — proves nvidia-provider's {mock:true} no-key short-circuit is a REAL path
 *      (control case) AND that every provider scenario function explicitly guards against ever exercising it
 *      undetected (a pre-mortem-flagged false-pass class, addressed with direct runtime + source evidence)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'forge-chaos.cjs');
const chaos = require('./forge-chaos.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-chaos.cjs tests (hermetic — every fixture lives under os.tmpdir(), never the real 12 projects/network)');

// =====================================================================================================
// 1) FULL CLI RUN — the real end-to-end tool
// =====================================================================================================
console.log('\n1) full CLI run (--json) — real subprocess, real modules, real fixtures');
{
  const r = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', timeout: 60000 });
  t('CLI exits 0 (every currently-real invariant holds on this codebase)', r.status === 0);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (e) { console.error('  could not parse CLI --json output: ' + e.message); }
  t('CLI produced parsable JSON', parsed !== null);
  if (parsed) {
    t('all 12 documented scenarios ran', parsed.results.length === 12);
    t('every scenario reports a valid status (pass/fail/skip — never anything else)', parsed.results.every((rr) => ['pass', 'fail', 'skip'].includes(rr.status)));
    t('zero scenarios reported "fail" (real, current state of the codebase)', parsed.tally.failed === 0);
    t('zero scenarios silently "skip" — this build found a real hermetic injection for every listed scenario', parsed.tally.skipped === 0);
    t('tally.total/passed/failed/skipped are internally consistent', parsed.tally.total === parsed.tally.passed + parsed.tally.failed + parsed.tally.skipped);
    t('tmpRootsOk: true — every fixture dir this run created is proven to sit under os.tmpdir()', parsed.tmpRootsOk === true);
    t('at least one fixture dir was actually created (not a vacuous zero-evidence true)', Array.isArray(parsed.tmpRoots) && parsed.tmpRoots.length > 0);
    const expectedIds = [
      'malformed_json_events', 'corrupt_hash_chain', 'interrupted_run_resume', 'secret_in_event',
      'provider_offline', 'provider_rate_limited_429', 'provider_server_error_500', 'provider_timeout',
      'provider_malformed_response', 'provider_unknown_model', 'canary_sync_failure', 'unknown_agent_model_routing',
    ];
    t('every documented scenario id is present exactly once', expectedIds.every((id) => parsed.results.filter((rr) => rr.id === id).length === 1));
    t('each scenario carries a non-empty invariant + reason string (never a blank "trust me")', parsed.results.every((rr) => typeof rr.invariant === 'string' && rr.invariant.length > 0 && typeof rr.reason === 'string' && rr.reason.length > 0));
    t('WP5 CHAOS FIX: a genuinely full green run reports outcome:"green" + exitCode:0 in the JSON body itself', parsed.outcome === 'green' && parsed.exitCode === 0);
  }
  // real tmpdir cleanup already ran inside that CLI process (no --keep-tmp) — confirm nothing it created survives
  if (parsed && Array.isArray(parsed.tmpRoots)) {
    t('CLI cleaned up its own tmp fixtures after the run (no --keep-tmp)', parsed.tmpRoots.every((d) => !fs.existsSync(d)));
  }
}

// =====================================================================================================
// 2) --only FILTERING
// =====================================================================================================
console.log('\n2) --only <id> runs exactly one scenario');
{
  const r = spawnSync(process.execPath, [CLI, '--json', '--only', 'secret_in_event'], { encoding: 'utf8', timeout: 15000 });
  t('CLI exits 0', r.status === 0);
  const parsed = JSON.parse(r.stdout);
  t('exactly one scenario ran', parsed.results.length === 1 && parsed.results[0].id === 'secret_in_event');
  t('that scenario passed', parsed.results[0].status === 'pass');
}
{
  // WP5 CHAOS FIX: a 0-scenario run (unknown --only id) must NEVER be vacuously green (exit 0) — the
  // header claims "exit 0 = every invariant held", which is false when nothing ran at all.
  const r = spawnSync(process.execPath, [CLI, '--json', '--only', 'this-scenario-does-not-exist'], { encoding: 'utf8', timeout: 15000 });
  const parsed = JSON.parse(r.stdout);
  t('an unknown --only id runs zero scenarios (never silently falls back to "run everything")', parsed.results.length === 0 && parsed.tally.total === 0);
  t('CLI exits NON-ZERO (usage error, code 2) for a 0-scenario run — never a vacuous exit 0', r.status === 2);
  t('a loud usage-error message names the unknown id on stderr', /this-scenario-does-not-exist/.test(r.stderr) && /0 scenario/.test(r.stderr));
  t('the JSON body itself is honest about the outcome too', parsed.outcome === 'usage_error' && parsed.exitCode === 2);
}

// =====================================================================================================
// 2b) classifyRun() — the pure exit-code decision (WP5 CHAOS FIX, 2026-07-14): a SKIP / 0-ran run must
//     never be vacuously green. Tested directly against hand-built ("simulated") tallies so every branch
//     is covered fast and deterministically, without needing a real all-skip run of the 12 scenarios.
// =====================================================================================================
console.log('\n2b) classifyRun() exit-code honesty gate — simulated tallies for every branch');
{
  const zeroRan = chaos.classifyRun({ total: 0, passed: 0, failed: 0, skipped: 0 }, { only: 'bogus-id' });
  t('0-ran (e.g. unknown --only) -> exitCode 2, outcome usage_error (never 0)', zeroRan.exitCode === 2 && zeroRan.outcome === 'usage_error');
  t('0-ran reason names the unknown --only id', /bogus-id/.test(zeroRan.reason));

  // simulated ALL-SKIP run: a zero-passed/zero-failed/all-skipped tally — exactly the vacuous-green shape
  // the fix targets. NOTE: deliberately worded WITHOUT the literal digit pattern "N passed, M failed" —
  // forge-doctor.cjs's own test-tally regex (/(\d+)\s+passed,\s+(\d+)\s+failed/, unanchored, first-match)
  // would otherwise latch onto this test's own printed "ok "/"FAIL " description line instead of this
  // suite's real trailing summary line, misreporting the whole suite as a false 0/0 (a known, previously
  // documented collision class in this project — see MEMORY.md).
  const allSkip = chaos.classifyRun({ total: 5, passed: 0, failed: 0, skipped: 5 }, {});
  t('simulated all-skip run (zero-passed, zero-failed, five-skipped) -> NOT green (exitCode != 0)', allSkip.exitCode !== 0);
  t('simulated all-skip run -> exitCode 3, outcome "skipped" (distinct from a real failure)', allSkip.exitCode === 3 && allSkip.outcome === 'skipped');

  // simulated MIXED run (some passed, some skipped, none failed) — still not fully green.
  const mixedSkip = chaos.classifyRun({ total: 12, passed: 10, failed: 0, skipped: 2 }, {});
  t('simulated mixed pass+skip run -> still NOT green (skip alone blocks exit 0)', mixedSkip.exitCode !== 0 && mixedSkip.outcome === 'skipped');

  // a REAL failure must still exit 1, unchanged by this fix.
  const realFail = chaos.classifyRun({ total: 12, passed: 11, failed: 1, skipped: 0 }, {});
  t('a real failure still reports exitCode 1 (unchanged behavior)', realFail.exitCode === 1 && realFail.outcome === 'failed');

  // failed takes priority over skipped when both are present in the same tally.
  const failAndSkip = chaos.classifyRun({ total: 12, passed: 9, failed: 2, skipped: 1 }, {});
  t('failed + skipped together -> failed wins (exitCode 1, not 3)', failAndSkip.exitCode === 1 && failAndSkip.outcome === 'failed');

  // the ONLY way to earn exitCode 0 is a real, non-empty, fully-verified run.
  const trueGreen = chaos.classifyRun({ total: 12, passed: 12, failed: 0, skipped: 0 }, {});
  t('a genuinely full green run (12/12 pass, 0 fail, 0 skip) -> exitCode 0', trueGreen.exitCode === 0 && trueGreen.outcome === 'green');

  // MUTATION-TEETH PROOF (hand-verified against a scratchpad copy of the pre-fix logic, not asserted here
  // as inline code — see the build report): reverting classifyRun to the old `anyFail ? 1 : 0` shape makes
  // BOTH `zeroRan` and `allSkip` above resolve to exitCode 0 instead of 2/3 — i.e. these exact assertions
  // go RED under the old (vacuously-green) logic, proving they pin the fix down rather than trivially pass.
}

// =====================================================================================================
// 3) TARGETED DIRECT-REQUIRE CHECKS — specific evidence fields, fast scenarios only
// =====================================================================================================
console.log('\n3) targeted direct-require checks on individual scenario functions');
{
  const r = chaos.scenarioMalformedJson();
  t('malformed_json_events: status pass', r.status === 'pass');
  t('malformed_json_events: evidence proves malformed:1 was actually counted', r.evidence[0].malformed === 1);
  t('malformed_json_events: evidence proves the mismatch (0/1 tasks done) was actually detected', r.evidence[0].agentRecord.mismatch === true && r.evidence[0].agentRecord.tasksDone === 0);
}
{
  const r = chaos.scenarioSecretRedaction();
  t('secret_in_event: status pass', r.status === 'pass');
  const onDisk = fs.readFileSync(r.evidence[0].entityFile, 'utf8');
  t('secret_in_event: the on-disk file genuinely contains a redaction marker (not just an empty file)', onDisk.includes('***REDACTED***'));
  t('secret_in_event: the on-disk file genuinely does NOT contain the raw injected secret substring', !onDisk.includes('THISISACHAOSTESTSECRETVALUE'));
}
{
  const r = chaos.scenarioInterruptedRun();
  t('interrupted_run_resume: status pass', r.status === 'pass');
  t('interrupted_run_resume: evidence proves the unfinished agent (build-boss) IS marked for resume', r.evidence[0].inMemory.resume.includes('build-boss'));
  t('interrupted_run_resume: evidence proves the completed agent (test-boss) is NOT marked for resume (no double work)', !r.evidence[0].inMemory.resume.includes('test-boss'));

  // FOLLOW-UP B survivor #1 pin (2026-07-14): `pass = projectionOk && cliOk` blanket-ANDs the in-memory
  // projection sub-check with the truncated-events-file/CLI-resume sub-check — no prior test read the
  // CLI-specific evidence on its own. Assert the cliParsed/cliStatus fields directly (independent of the
  // overall status), so a diagnostic reader can see exactly which branch produced which outcome.
  t('interrupted_run_resume: CLI-branch dedicated check — cliParsed.resume includes the genuinely unfinished agent (the truncated-events-file/CLI-resume path)', !!r.evidence[0].cliParsed && r.evidence[0].cliParsed.resume.includes('build-boss'));
  t('interrupted_run_resume: CLI-branch dedicated check — cliParsed.complete === false (a truncated events.jsonl is never silently treated as complete)', !!r.evidence[0].cliParsed && r.evidence[0].cliParsed.complete === false);
  t('interrupted_run_resume: CLI-branch dedicated check — cliStatus is 0/2/3 (the truncated file never crashes the CLI itself)', [0, 2, 3].includes(r.evidence[0].cliStatus));
}
{
  // Standalone, independent replication of JUST the truncated-events-file/CLI-resume branch — bypasses
  // scenarioInterruptedRun() entirely, using its own fresh fixture and its own direct spawn of the REAL
  // forge-run-state.cjs CLI. A regression that breaks ONLY this branch (while the in-memory projection
  // sub-check stays fine) is caught here on its own ground truth, independent of the scenario's combiner.
  //
  // HONEST SCOPE NOTE (mutation-teeth, verified against a scratchpad mutant copy): scenarioInterruptedRun()
  // has no opts hook to override the CLI subprocess (unlike its opts.runStateModule hook for the in-memory
  // half), so a pure harness-level mutation of line ~301 itself (e.g. dropping cliOk from the AND, or
  // swapping && for ||) cannot be forced to diverge without either an available injection point or editing
  // the locked forge-run-state.cjs — confirmed equivalent under this suite's real, achievable conditions
  // (cliParsed's own values are unaffected by that specific line's mutation, since they come from a real,
  // correct subprocess run either way). This standalone test still independently pins the real behavior of
  // the branch itself, which is the concrete, literal ask of this pin.
  const runStateCli = path.join(__dirname, 'forge-run-state.cjs');
  const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chaos-test-cli-isolation-'));
  const isoRunId = 'chaos-test-cli-isolation-' + Date.now();
  const isoRunDir = path.join(isoRoot, '.claude', 'forge-runs', isoRunId);
  fs.mkdirSync(isoRunDir, { recursive: true });
  const isoGoodLine = JSON.stringify({ event_type: 'subagent_started', agent: 'build-boss', timestamp: 't1' });
  const isoTruncatedLine = '{"event_type":"subagent_completed","agent":"build-b'; // half-written, unterminated
  fs.writeFileSync(path.join(isoRunDir, 'events.jsonl'), isoGoodLine + '\n' + isoTruncatedLine, 'utf8');
  const isoCli = spawnSync(process.execPath, [runStateCli, isoRunId, '--json'], {
    encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: isoRoot }),
  });
  let isoParsed = null;
  try { isoParsed = JSON.parse(isoCli.stdout); } catch { /* handled by the assertion below */ }
  t('interrupted_run_resume: ISOLATED standalone replication of the truncated-events-file/CLI-resume branch — never crashes (valid JSON, exit 0/2/3)', isoParsed !== null && [0, 2, 3].includes(isoCli.status));
  t('interrupted_run_resume: ISOLATED standalone replication — resume includes the unfinished agent, complete stays false', !!isoParsed && isoParsed.resume.includes('build-boss') && isoParsed.complete === false);
  fs.rmSync(isoRoot, { recursive: true, force: true });
}
{
  const r = chaos.scenarioProvider429();
  t('provider_rate_limited_429: status pass', r.status === 'pass');
  t('provider_rate_limited_429: the clean error actually names the injected status code', /429/.test(r.evidence[0].out.error));
  t('provider_rate_limited_429: no fabricated content field on a failed call', r.evidence[0].out.content === undefined);
}
{
  // FOLLOW-UP B survivor #3 pin (2026-07-14): `pass = cleanError && noContent && noKeyLeak && notMocked` on
  // scenarioProviderOffline blanket-ANDs four invariants with no dedicated assertion on noKeyLeak (never leak
  // the raw configured key in the masked error) or notMocked (the real retry path ran, not the {mock:true}
  // short-circuit). Read the raw evidence fields directly, independent of the internal cleanError/noContent
  // terms and independent of the internal noKeyLeak/notMocked booleans themselves.
  // HONEST SCOPE NOTE (mutation-teeth, verified against scratchpad mutant copies): scenarioProviderOffline()
  // takes no opts/injection hook, and — given the real (correct) nvidia-provider.cjs masking/mock-detection
  // code this suite deliberately never touches — hardcoding either internal `noKeyLeak` or `notMocked` to
  // `true` produces NO observable divergence in the raw evidence under this suite's achievable conditions
  // (confirmed: out.error/out.mock are unaffected either way, since they come from a real, correct subprocess
  // run regardless of the harness's own post-processing formula). These are still real, independent,
  // correctly-scoped pins of the actual invariant (they would catch a REAL regression in nvidia-provider.cjs's
  // own masking or mock-detection logic, which is squarely this scenario's purpose) — reported honestly as
  // very likely equivalent for that one specific harness-internal hardcode-mutation class, per the same
  // reasoning as provider_offline's own header-documented pre-mortem false-pass guard.
  const r = chaos.scenarioProviderOffline();
  t('provider_offline: noKeyLeak dedicated pin — the masked error text never contains the raw configured key', typeof r.evidence[0].out.error === 'string' && !r.evidence[0].out.error.includes(chaos.FAKE_KEY));
  t('provider_offline: notMocked dedicated pin — no {mock:true} field on the returned output (the real retry path ran)', r.evidence[0].out.mock !== true);
  t('provider_offline: notMocked dedicated pin — the error text carries the real retry-path signature ("failed after N attempts"), never the mock-mode message', /failed after \d+ attempts?/.test(r.evidence[0].out.error) && !/mock mode/.test(r.evidence[0].out.error));
}
{
  const r = chaos.scenarioUnknownRouting();
  t('unknown_agent_model_routing: status pass', r.status === 'pass');
  t('unknown_agent_model_routing: routeFor returned an explicit error string, not a fabricated route', typeof r.evidence[0].out.routeResult.error === 'string');
  t('unknown_agent_model_routing: modelForRole returned null, not a fabricated model id', r.evidence[0].out.modelResult === null);
}
{
  const r = chaos.scenarioCanarySyncFailure();
  t('canary_sync_failure: status pass', r.status === 'pass');
  t('canary_sync_failure: the batch genuinely aborted at the dedicated-canary stage', r.evidence[0].resultSummary.stage === 'dedicated-canary' && r.evidence[0].resultSummary.aborted === true);
  t('canary_sync_failure: the canary itself was genuinely rolled back', r.evidence[0].resultSummary.dedicatedCanary.rolledBack === true);

  // FOLLOW-UP B survivor #2 pin, stillHermetic half (2026-07-14): `pass = abortedAtCanary && canaryRolledBack
  // && realUntouched && stillHermetic` blanket-ANDs four invariants with no separate assertion on
  // stillHermetic. Dedicated, independent re-check: call the REAL exported allUnderTmp() fresh right after
  // this run (not the scenario's own internal variable) to confirm containment held.
  // HONEST SCOPE NOTE (mutation-teeth, verified against a scratchpad mutant copy): hardcoding this specific
  // internal variable to `true` produces NO observable divergence under this suite's achievable conditions
  // — the fixture-creation helpers (freshDir/makeFixtureProject) only ever create directories under
  // os.tmpdir(), so there is no available, non-source-editing way to force a genuine escape and prove this
  // exact term false. This assertion is real, independent defense-in-depth (it does not trust the scenario's
  // own internal flag), but is honestly reported as very likely equivalent for that one specific mutation.
  t('canary_sync_failure: stillHermetic dedicated pin — a freshly-called allUnderTmp() (not the scenario\'s internal variable) confirms containment after this real canary-failure run', chaos.allUnderTmp() === true);
}
{
  // FOLLOW-UP B survivor #2 pin, realUntouched half (2026-07-14): dedicated, INDEPENDENT proof via the
  // scenario's own documented opts.syncModule injection hook — a "lying" syncModule that returns the SAME
  // correct-looking flags (ok:false, aborted:true, stage:'dedicated-canary', rolledBack:true) but ACTUALLY
  // writes to the fixture "real" project anyway (simulating a hypothetical real regression in forge-sync's
  // abort path). This is exactly the class of bug realUntouched exists to catch — the current (unmutated)
  // forge-chaos.cjs must independently detect the file mutation rather than blindly trust the returned flags.
  // MUTATION-TEETH PROOF (hand-verified against a scratchpad mutant copy, not asserted inline — see the
  // build report): hardcoding `realUntouched = true` in scenarioCanarySyncFailure flips THIS exact test's
  // result from 'fail' to 'pass' — i.e. this assertion goes RED under that mutation, proving it has teeth.
  const lyingSync = {
    runSyncAll(tpl, root, options) {
      const projects = (options && options.projects) || [];
      for (const p of projects) {
        try { fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'console.log("LIED-despite-abort");\n', 'utf8'); } catch { /* best-effort */ }
      }
      return { ok: false, aborted: true, stage: 'dedicated-canary', dedicatedCanary: { ok: false, rolledBack: true } };
    },
  };
  const r = chaos.scenarioCanarySyncFailure({ syncModule: lyingSync });
  t('canary_sync_failure: realUntouched dedicated pin — a lying syncModule that claims success/rollback but ACTUALLY writes to a fixture project is still caught as FAIL (never blindly trusts the returned flags)', r.status === 'fail');
  t('canary_sync_failure: realUntouched dedicated pin — the failure reason explicitly names realUntouched:false (not masked by the other three true terms)', /"realUntouched":false/.test(r.reason));
}

// =====================================================================================================
// 4) THE REQUIRED PROOF: a module-stub that gives a FAKE PASS must flip the scenario to FAIL, not PASS
// =====================================================================================================
console.log('\n4) proof: the harness catches a REAL invariant break (a fake-pass stub is reported FAIL, not PASS)');
{
  // 4a) baseline — the REAL forge-doctor.chainCheck against a genuinely tampered chain correctly reports the
  //     scenario as PASS (meaning: the corruption WAS detected — the invariant held).
  const real = chaos.scenarioCorruptHashChain();
  t('baseline (real chainCheck) on a genuinely tampered chain -> scenario PASS (corruption WAS detected)', real.status === 'pass');

  // 4b) inject a deliberately BROKEN checker: a module-stub that ALWAYS reports "everything is fine",
  //     regardless of the fixture. This is exactly "a module-stub die een fake pass geeft" — if the harness's
  //     OWN assertion just trusted whatever chainCheck said, it would report PASS here too, which would make
  //     the whole harness worthless. It must instead independently know (from the fixture IT corrupted) that
  //     the correct answer was "detected", and report FAIL when the checker fails to detect it.
  const fakePassStub = () => ({ ok: true, checked: 1, chained: 1, broken: [] });
  const broken = chaos.scenarioCorruptHashChain({ chainCheckFn: fakePassStub });
  t('a fake-pass chainCheck stub on the SAME kind of tampered chain -> scenario reports FAIL, not PASS (the harness has teeth)', broken.status === 'fail');
  t('the FAIL reason explicitly names the missed detection (not a vague/blank failure)', /did NOT flag/.test(broken.reason));
}

// =====================================================================================================
// 5) runAll() never lets a scenario silently count as pass
// =====================================================================================================
console.log('\n5) runAll() converts an uncaught throw / an invalid status to a real FAIL, never a silent pass');
{
  const throwingScenario = { id: 'chaos-test-throwing-scenario', description: 'test-only', invariant: 'test-only', run: () => { throw new Error('deliberate test-only throw'); } };
  const bogusStatusScenario = { id: 'chaos-test-bogus-status-scenario', description: 'test-only', invariant: 'test-only', run: () => ({ status: 'totally-not-a-real-status', reason: 'nope' }) };
  chaos.SCENARIOS.push(throwingScenario);
  chaos.SCENARIOS.push(bogusStatusScenario);
  try {
    const results = chaos.runAll(null);
    const thrown = results.find((r) => r.id === 'chaos-test-throwing-scenario');
    const bogus = results.find((r) => r.id === 'chaos-test-bogus-status-scenario');
    t('a scenario that throws is reported as a real FAIL (never silently dropped or counted as pass)', !!thrown && thrown.status === 'fail' && /deliberate test-only throw/.test(thrown.reason));
    t('a scenario returning a non-pass/fail/skip status is coerced to FAIL, never treated as pass', !!bogus && bogus.status === 'fail');
  } finally {
    // remove the test-only injected scenarios so they never leak into a real run of this file/process
    const kept = chaos.SCENARIOS.filter((s) => !['chaos-test-throwing-scenario', 'chaos-test-bogus-status-scenario'].includes(s.id));
    chaos.SCENARIOS.length = 0;
    for (const s of kept) chaos.SCENARIOS.push(s);
  }
  t('the two test-only scenarios were removed again (SCENARIOS back to the documented 12)', chaos.SCENARIOS.length === 12);
}

// =====================================================================================================
// 6) parseArgs() unit checks
// =====================================================================================================
console.log('\n6) parseArgs() unit checks');
{
  t('no flags -> defaults', JSON.stringify(chaos.parseArgs([])) === JSON.stringify({ json: false, only: null, keepTmp: false }));
  t('--json sets json:true', chaos.parseArgs(['--json']).json === true);
  t('--only <id> captures the id', chaos.parseArgs(['--only', 'provider_offline']).only === 'provider_offline');
  t('--keep-tmp sets keepTmp:true', chaos.parseArgs(['--keep-tmp']).keepTmp === true);
  t('combined flags all parse together', (() => { const p = chaos.parseArgs(['--only', 'x', '--json', '--keep-tmp']); return p.only === 'x' && p.json === true && p.keepTmp === true; })());
}

// =====================================================================================================
// 7) TMPDIR CONTAINMENT — every directory this suite's own direct-require calls created is under os.tmpdir()
// =====================================================================================================
console.log('\n7) tmpdir containment proof (mirrors forge-sync.test.cjs addendum G)');
{
  const roots = chaos.getTmpRoots();
  const base = path.resolve(os.tmpdir());
  t('at least one fixture dir was created by this test file\'s own direct-require calls', roots.length > 0);
  t('every one of the ' + roots.length + ' fixture dir(s) created this run is rooted under os.tmpdir()', roots.every((d) => path.resolve(d).startsWith(base)));
  chaos.cleanupTmp();
  t('cleanupTmp() actually removes every tracked fixture dir', roots.every((d) => !fs.existsSync(d)));
}

// =====================================================================================================
// 8) MOCK-SHORT-CIRCUIT CONTROL — a pre-mortem review flagged that nvidia-provider.chat()/call() returns
//    {mock:true} and skips ALL retry/backoff logic whenever no NVIDIA_API_KEY is set (real code, confirmed
//    below). If a provider scenario accidentally ran with an empty key it would silently exercise the mock
//    path and could still report a false PASS. This section (a) proves the concern is REAL for a naive
//    no-key setup (the control case), and (b) proves every one of this harness's own provider-transport
//    scenario FUNCTIONS carries a source-level `out.mock !== true` guard specifically to rule this out —
//    matched by direct runtime evidence already captured in section 3/1 (out.model/out.error text that only
//    the REAL fetch/retry path could have produced, e.g. the injected "(chaos-injected)" body echoed back).
// =====================================================================================================
console.log('\n8) mock-short-circuit control (closes the pre-mortem-flagged false-pass class)');
{
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chaos-test-mockcontrol-'));
  const scriptPath = path.join(scriptDir, 'probe.cjs');
  fs.writeFileSync(scriptPath, [
    "'use strict';",
    'global.fetch = async function () { throw new Error("CONTROL FAILURE: fetch must never be called in mock mode"); };',
    'const P = require(' + JSON.stringify(path.join(__dirname, 'nvidia-provider.cjs')) + ');',
    '(async () => { const out = await P.chat({ role: "fast", prompt: "hi" }); process.stdout.write(JSON.stringify(out)); })();',
  ].join('\n'), 'utf8');
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chaos-test-emptyhome-'));
  const env = Object.assign({}, process.env, { USERPROFILE: emptyHome, HOME: emptyHome, NVIDIA_SKIP_ENV_FILES: '1' });
  delete env.NVIDIA_API_KEY;
  const r = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 10000, env });
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* handled by the assertion below */ }
  t('CONTROL: with NO NVIDIA_API_KEY at all, chat() genuinely takes the {mock:true} short-circuit (the concern is real for a naive no-key setup)', !!out && out.mock === true);
  t('CONTROL: the mock content is honestly labeled, never a fabricated real-looking answer', !!out && /NOT a model response/.test(out.content || ''));
  fs.rmSync(scriptDir, { recursive: true, force: true });
  fs.rmSync(emptyHome, { recursive: true, force: true });

  const src = fs.readFileSync(CLI, 'utf8');
  const providerFnNames = ['scenarioProviderOffline', 'providerHttpFaultScenario', 'scenarioProviderTimeout', 'scenarioProviderMalformedResponse', 'scenarioProviderUnknownModel'];
  const guarded = providerFnNames.every((fnName) => {
    const start = src.indexOf('function ' + fnName + '(');
    if (start === -1) return false;
    const nextFn = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, nextFn === -1 ? src.length : nextFn);
    return /out\.mock !== true/.test(body);
  });
  t('every provider-transport scenario function in forge-chaos.cjs source explicitly checks out.mock !== true (a regression back to the mock path fails LOUD, never a silent pass)', guarded);
}

// =====================================================================================================
// 9) printHuman() / non-JSON CLI OUTPUT — FOLLOW-UP B survivor #4 pin (2026-07-14): args.json's FALSE
//    branch (the human-readable printHuman() report) had ZERO test coverage — every prior test in this
//    file used --json. MUTATION-TEETH PROOF (hand-verified against a scratchpad mutant copy that forces
//    the CLI's `if (args.json)` check to `if (true)`, not asserted inline — see the build report): under
//    that mutant, `node forge-chaos.cjs --only secret_in_event` (no --json flag) still prints a JSON blob,
//    which flips the "prints the human-readable report, not JSON" assertion below from green to RED.
// =====================================================================================================
console.log('\n9) printHuman() / non-JSON CLI output (args.json false branch)');
{
  const fakeResults = [
    { id: 'demo_pass', description: 'd1', invariant: 'inv-one', ms: 5, status: 'pass', reason: 'reason-pass-one', evidence: [] },
    { id: 'demo_fail', description: 'd2', invariant: 'inv-two', ms: 7, status: 'fail', reason: 'reason-fail-two', evidence: [] },
    { id: 'demo_skip', description: 'd3', invariant: 'inv-three', ms: 1, status: 'skip', reason: 'reason-skip-three', evidence: [] },
  ];
  const human = chaos.printHuman(fakeResults);
  const notJson = (() => { try { JSON.parse(human); return false; } catch { return true; } })();
  t('printHuman(): header line present', /^forge-chaos — failure-injection harness/.test(human));
  t('printHuman(): a PASS scenario is tagged [PASS] with its invariant and reason lines', /\[PASS\] demo_pass \(5ms\)[\s\S]*invariant: inv-one[\s\S]*reason-pass-one/.test(human));
  t('printHuman(): a FAIL scenario is tagged [FAIL] with its invariant and reason lines', /\[FAIL\] demo_fail \(7ms\)[\s\S]*invariant: inv-two[\s\S]*reason-fail-two/.test(human));
  t('printHuman(): a SKIP scenario is tagged [SKIP] with its invariant and reason lines', /\[SKIP\] demo_skip \(1ms\)[\s\S]*invariant: inv-three[\s\S]*reason-skip-three/.test(human));
  t('printHuman(): the trailing tally line correctly reports the mixed counts (1 passed, 1 failed, 1 skipped)', /3 scenario\(s\): 1 passed, 1 failed, 1 skipped\./.test(human));
  t('printHuman(): the output is NOT JSON (a human report, never a machine-parsable blob)', notJson);
}
{
  // real, literal CLI subprocess spawn WITHOUT --json — proves the CLI's args.json FALSE branch is genuinely
  // wired to printHuman() end-to-end, not just the exported function in isolation above.
  const r = spawnSync(process.execPath, [CLI, '--only', 'secret_in_event'], { encoding: 'utf8', timeout: 15000 });
  const stdoutNotJson = (() => { try { JSON.parse(r.stdout); return false; } catch { return true; } })();
  t('CLI without --json exits 0 for a real green --only run', r.status === 0);
  t('CLI without --json prints the human-readable report, not JSON', stdoutNotJson);
  t('CLI without --json output contains the [PASS] tag for the real scenario that ran', /\[PASS\] secret_in_event/.test(r.stdout));
  t('CLI without --json output contains the real tally line (1 scenario(s): 1 passed, 0 failed, 0 skipped.)', /1 scenario\(s\): 1 passed, 0 failed, 0 skipped\./.test(r.stdout));
}

// =====================================================================================================
// 10) EXIT-CODE STDERR DIAGNOSTIC — FOLLOW-UP B survivor #5 pin (2026-07-14): `if (decision.exitCode !== 0)
//     console.error(...)` had no dedicated test proving the diagnostic is genuinely PRESENT on a non-zero
//     exit and genuinely ABSENT on a green run. MUTATION-TEETH PROOF (hand-verified against a scratchpad
//     mutant copy that inverts the guard to `if (decision.exitCode === 0)`, not asserted inline — see the
//     build report): under that mutant, the real, genuinely-green `--json` run below prints the diagnostic
//     line to stderr, which flips the "EMPTY stderr" assertion from green to RED.
//     HONEST SCOPE NOTE: every one of the 12 real scenarios genuinely passes on this codebase, and none of
//     them accept a CLI flag/env override that could legitimately force a real exit-1 without editing the
//     locked source — so this pin proves the guard for exitCode 0 (absent, real spawn) and exitCode 2
//     (present, real spawn, unknown --only id) using the ONE literal, unmutated, non-branching `!== 0`
//     comparison; that same one-line comparison governs exitCode 1/3 identically (no per-value branch
//     exists in the source to carve out a different behavior for 1 specifically).
// =====================================================================================================
console.log('\n10) exit-code stderr diagnostic — presence on non-zero exit, absence on a green run');
{
  const r = spawnSync(process.execPath, [CLI, '--json'], { encoding: 'utf8', timeout: 60000 });
  t('a genuinely green run (exitCode 0) has EMPTY stderr — the diagnostic line never fires when nothing is wrong', r.status === 0 && r.stderr === '');
}
{
  const r = spawnSync(process.execPath, [CLI, '--json', '--only', 'this-scenario-does-not-exist'], { encoding: 'utf8', timeout: 15000 });
  t('a non-zero-exit-code run (exitCode 2) has a NON-EMPTY stderr diagnostic with the exact literal prefix the CLI uses ("forge-chaos: ")', r.status === 2 && r.stderr.startsWith('forge-chaos: '));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
