#!/usr/bin/env node
'use strict';
/**
 * forge-chaos.cjs — FAILURE-INJECTION harness (WP5, 2026-07-14). Zero-dependency, Windows-safe.
 *
 * Proves Forge's own invariants survive REAL failure conditions — not simulated/fabricated ones — by
 * genuinely corrupting fixture data, stubbing only the transport layer (never the network itself), and
 * calling the REAL, unmodified project modules against that damage. This file NEVER edits forge-store.cjs,
 * forge-run-state.cjs, forge-report.cjs, nvidia-provider.cjs, forge-sync.cjs, forge-verify.cjs,
 * forge-doctor.cjs, or forge-dashboard/log-event.cjs — it only requires or spawns them, exactly as they
 * ship, against disposable os.tmpdir() fixtures.
 *
 * HERMETIC GUARANTEE: every fixture directory this tool creates is tracked (see TMP_ROOTS/freshDir) and
 * lives under a fresh os.tmpdir() mkdtemp — never this repo's real `.claude/`, never the real 12 Forge
 * projects, never a real forge-runs/<run_id>. No scenario makes a real network call: the only "provider"
 * scenarios stub global.fetch before requiring nvidia-provider.cjs so its real retry/mask/error-handling
 * code runs against a fully offline, injected transport.
 *
 * SCENARIOS (each: inject a REAL failure -> call the REAL module -> assert its documented invariant):
 *   malformed_json_events        forge-verify.verifyRun            a corrupt JSONL line is skipped, not
 *                                                                  crashed on, never silently counted done
 *   corrupt_hash_chain           forge-doctor.chainCheck           a tampered proof-ledger event is detected
 *                                                                  (ok:false), never silently trusted
 *   interrupted_run_resume       forge-run-state.projectRunState   only the genuinely unfinished work
 *                                                                  package is marked for resume — no double
 *                                                                  work for the already-completed one, and a
 *                                                                  truncated on-disk events.jsonl never
 *                                                                  crashes the CLI or fakes completion
 *   secret_in_event              forge-store.putEntity             a secret is redacted before the entity
 *                                                                  ever touches disk — never written raw
 *   provider_offline             nvidia-provider.chat              a network failure surfaces as a clean
 *                                                                  {error}, never fabricated content, never
 *                                                                  leaks the raw API key in the error path
 *   provider_rate_limited_429    nvidia-provider.chat              a persistent 429 ends in a clean {error}
 *                                                                  after real retries, never fabricated
 *   provider_server_error_500    nvidia-provider.chat              same, for a persistent 5xx
 *   provider_timeout             nvidia-provider.chat              a real AbortSignal timeout wins the race
 *                                                                  against a slow "success" — no fabrication
 *   provider_malformed_response  nvidia-provider.chat              an unparsable 200 body degrades to empty
 *                                                                  content, never a crash, never a fabrication
 *   provider_unknown_model       nvidia-provider.chat              a provider-side 404 for a bogus model id
 *                                                                  surfaces as a clean {error}
 *   canary_sync_failure          forge-sync.runSyncAll             a broken dedicated-canary validation rolls
 *                                                                  the canary back and ABORTS the whole batch
 *                                                                  before any fixture "real" project is touched
 *   unknown_agent_model_routing  nvidia-provider.routeFor/
 *                                modelForRole                      an unknown agent/role resolves to an
 *                                                                  explicit {error}/null, never a silent
 *                                                                  fabricated route counted as success
 *
 * GLOBAL INVARIANTS asserted in every scenario that touches them: (1) never a fake PASS — a scenario's own
 * assertion is built from ground truth the harness itself created (a known corruption/injection), not from
 * blindly trusting the checked module's own verdict; (2) no uncontrolled write ever reaches the real 12
 * projects (every root/projectDir/runDir argument passed to a real module is tracked and proven to sit under
 * os.tmpdir() — see allUnderTmp()); (3) the proof/ledger stays intact or is honestly reported corrupt;
 * (4) safe resume without double work; (5) no secret/key leak in any error path.
 *
 * NOT INJECTED (honest, explicit): a "missing skill" fallback (agent-skill-map.json / forge-paperclip.cjs's
 * skillsForRole) is outside this harness's locked module scope (forge-store/forge-run-state/forge-report/
 * nvidia-provider/forge-sync/forge-verify) and is not covered here — see unknown_agent_model_routing's reason
 * text, which documents this boundary rather than silently claiming full coverage.
 *
 * CLI:
 *   node forge-chaos.cjs [--json] [--only <scenario-id>] [--keep-tmp]
 *   Exit-code honesty gate (WP5 CHAOS FIX, 2026-07-14) — "exit 0 = every invariant held" must be
 *   LITERALLY true, so a zero-scenario or all-skip run can never be vacuously green:
 *     0 = at least one scenario ran AND zero 'fail' AND zero 'skip' (every invariant genuinely verified).
 *     1 = at least one scenario reported 'fail' (a real invariant break) — unchanged from before.
 *     2 = ZERO scenarios ran at all (e.g. an unknown --only id) — a usage error, never a silent exit 0.
 *     3 = zero 'fail' but at least one scenario reported 'skip' — NOT fully green: a skip means that
 *         invariant was never actually verified this run, so exit 0 would misrepresent the header claim.
 *   See classifyRun(tally, args) — the single, pure, directly-testable function that decides this.
 *
 * Module API (for forge-chaos.test.cjs — every scenario function accepts an optional opts object with
 * dependency-injection override hooks so the harness's OWN teeth can be proven: passing a fake "always
 * passes" stub for the checked function must flip that scenario to 'fail', not 'pass'):
 *   { SCENARIOS, runAll, tally, classifyRun, allUnderTmp, getTmpRoots, cleanupTmp, parseArgs, printHuman, FAKE_KEY,
 *     scenarioMalformedJson, scenarioCorruptHashChain, scenarioInterruptedRun, scenarioSecretRedaction,
 *     scenarioProviderOffline, scenarioProvider429, scenarioProvider500, scenarioProviderTimeout,
 *     scenarioProviderMalformedResponse, scenarioProviderUnknownModel, scenarioCanarySyncFailure,
 *     scenarioUnknownRouting }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FORGE_BIN = __dirname;
const REAL = {
  forgeStore: path.join(FORGE_BIN, 'forge-store.cjs'),
  forgeDoctor: path.join(FORGE_BIN, 'forge-doctor.cjs'),
  forgeVerify: path.join(FORGE_BIN, 'forge-verify.cjs'),
  forgeRunState: path.join(FORGE_BIN, 'forge-run-state.cjs'),
  forgeSync: path.join(FORGE_BIN, 'forge-sync.cjs'),
  nvidiaProvider: path.join(FORGE_BIN, 'nvidia-provider.cjs'),
  logEvent: path.join(FORGE_BIN, '..', 'forge-dashboard', 'log-event.cjs'),
};
const FAKE_KEY = 'nvapi-CHAOS-FAKE-KEY-0000000000000000';

// ---- hermetic tmpdir tracking (proof, not just a claim — mirrors forge-sync.test.cjs addendum G) ----
const TMP_ROOTS = [];
function freshDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  TMP_ROOTS.push(d);
  return d;
}
function allUnderTmp() {
  const base = path.resolve(os.tmpdir());
  return TMP_ROOTS.length > 0 && TMP_ROOTS.every((d) => path.resolve(d).startsWith(base));
}
function getTmpRoots() { return TMP_ROOTS.slice(); }
function cleanupTmp() {
  for (const d of TMP_ROOTS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

// ---- small fixture helpers ----
function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { out[p] = fs.readFileSync(p).toString('hex'); } catch { /* unreadable, skip */ } }
    }
  };
  walk(dir);
  return out;
}
function makeFixtureProject(root, name) {
  const p = path.join(root, name);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'console.log("chaos-fixture-old");\n', 'utf8');
  return p;
}
// copies the REAL log-event.cjs UNMODIFIED into a fixture .claude/forge-dashboard/ so real chained events
// can be generated for a scenario — never writes into this repo's real forge-runs/.
function makeChainFixtureRoot() {
  const root = freshDir('forge-chaos-chain');
  const dashDir = path.join(root, '.claude', 'forge-dashboard');
  fs.mkdirSync(dashDir, { recursive: true });
  fs.copyFileSync(REAL.logEvent, path.join(dashDir, 'log-event.cjs'));
  return root;
}
function logRealEvent(root, runId, type, extra) {
  const script = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  return spawnSync(process.execPath, [script, runId, type, JSON.stringify(extra || {})], { encoding: 'utf8', cwd: root, timeout: 10000 });
}
// writes+runs a throwaway child-process probe script that stubs global.fetch BEFORE requiring the REAL
// nvidia-provider.cjs, so its genuine retry/mask/error-handling code executes against a fully offline,
// injected transport (never the real network, never the real key).
function runProviderScript(fetchStubSrc, chatArgs, envExtra) {
  const scriptDir = freshDir('forge-chaos-provider-script');
  const scriptPath = path.join(scriptDir, 'probe.cjs');
  const src = [
    "'use strict';",
    'global.fetch = ' + fetchStubSrc + ';',
    'const P = require(' + JSON.stringify(REAL.nvidiaProvider) + ');',
    '(async () => {',
    '  const out = await P.chat(' + JSON.stringify(chatArgs) + ');',
    '  process.stdout.write(JSON.stringify(out));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ __harness_uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ].join('\n');
  fs.writeFileSync(scriptPath, src, 'utf8');
  const env = Object.assign({}, process.env, { NVIDIA_API_KEY: FAKE_KEY, NVIDIA_SKIP_ENV_FILES: '1' }, envExtra || {});
  return spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env, timeout: 15000 });
}
function runRoutingProbeScript() {
  const scriptDir = freshDir('forge-chaos-routing-script');
  const scriptPath = path.join(scriptDir, 'probe.cjs');
  const src = [
    "'use strict';",
    'const P = require(' + JSON.stringify(REAL.nvidiaProvider) + ');',
    'const routeResult = P.routeFor("totally-unknown-boss-role-chaos-xyz");',
    'const modelResult = P.modelForRole("totally-unknown-nvidia-role-chaos-xyz");',
    'process.stdout.write(JSON.stringify({ routeResult: routeResult, modelResult: modelResult }));',
  ].join('\n');
  fs.writeFileSync(scriptPath, src, 'utf8');
  const env = Object.assign({}, process.env, { NVIDIA_API_KEY: '', NVIDIA_SKIP_ENV_FILES: '1' });
  return spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env, timeout: 10000 });
}
function parseChildJson(r) {
  try { return { ok: true, out: JSON.parse(r.stdout) }; }
  catch (e) { return { ok: false, err: 'child probe produced non-JSON/crashed stdout (status ' + r.status + '): ' + (r.stderr || r.stdout || '').slice(0, 500) }; }
}

// =====================================================================================================
// SCENARIO 1: malformed JSON line in events.jsonl -> forge-verify never crashes, never fakes done
// =====================================================================================================
function scenarioMalformedJson(opts) {
  opts = opts || {};
  const root = freshDir('forge-chaos-malformed');
  const runId = 'chaos-malformed-' + Date.now();
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const lines = [
    JSON.stringify({ event_type: 'subagent_started', agent: 'build-boss', timestamp: '2026-07-14T00:00:00.000Z' }),
    JSON.stringify({ event_type: 'check_started', agent: 'build-boss', timestamp: '2026-07-14T00:00:01.000Z' }),
    '{"event_type":"check_passed","agent":"build-boss"', // MALFORMED — truncated, invalid JSON (missing closing brace)
    JSON.stringify({ event_type: 'subagent_completed', agent: 'build-boss', timestamp: '2026-07-14T00:00:02.000Z' }),
  ];
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');

  const verify = opts.verifyModule || require(REAL.forgeVerify);
  let result;
  try { result = verify.verifyRun(runDir, {}); }
  catch (e) { return { status: 'fail', reason: 'verifyRun CRASHED on a malformed JSONL line (must never crash): ' + e.message, evidence: [] }; }

  const malformedCounted = result.malformed === 1;
  const rec = (result.agents || []).find((a) => a.agent === 'build-boss');
  // build-boss claims done (subagent_completed present) but the malformed line WOULD have been the
  // check_passed that closes its open check_started task — since it was dropped, that task must still be
  // open, so this must be a MISMATCH (never silently trusted as fully done just because SOME completion
  // event exists elsewhere in the stream).
  const neverFakedDone = !!rec && rec.claimsDone === true && rec.mismatch === true && rec.tasksDone === 0 && rec.tasksTotal === 1;
  const pass = malformedCounted && neverFakedDone;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass
      ? 'verifyRun did not crash on the malformed line, honestly counted it (malformed:1), and did not let the dropped check_passed silently count as done (mismatch correctly flagged: 0/1 tasks)'
      : 'invariant broken — ' + JSON.stringify({ malformed: result.malformed, rec }),
    evidence: [{ runDir, malformed: result.malformed, agentRecord: rec }],
  };
}

// =====================================================================================================
// SCENARIO 2: corrupt hash chain in the proof ledger -> forge-doctor.chainCheck detects it, never trusts it
// =====================================================================================================
function scenarioCorruptHashChain(opts) {
  opts = opts || {};
  const root = makeChainFixtureRoot();
  const runId = 'chaos-chain-' + Date.now();
  const doctorModule = opts.doctorModule || require(REAL.forgeDoctor);
  const chainCheckFn = opts.chainCheckFn || doctorModule.chainCheck;

  for (const note of ['first', 'second', 'third']) {
    const r = logRealEvent(root, runId, 'agent_note', { agent: 'orchestrator', note, evidence: note + '-evidence' });
    if (r.status !== 0) return { status: 'fail', reason: 'setup: real log-event.cjs failed to append (' + note + '): ' + (r.stderr || r.stdout || '').trim(), evidence: [] };
  }

  const eventsFile = path.join(root, '.claude', 'forge-runs', runId, 'events.jsonl');
  const before = fs.readFileSync(eventsFile, 'utf8');
  const lines = before.replace(/\n+$/, '').split('\n').map((l) => JSON.parse(l));
  if (lines.length !== 3) return { status: 'fail', reason: 'setup: expected 3 chained events on disk, found ' + lines.length, evidence: [] };

  const preCheck = chainCheckFn(root);
  if (!(preCheck.ok === true && preCheck.chained >= 1)) {
    return { status: 'fail', reason: 'setup sanity failed: the real chain was not intact BEFORE corruption — ' + JSON.stringify(preCheck), evidence: [] };
  }

  // CORRUPT: tamper with the middle event's content — its recorded entry_hash no longer matches its own
  // (now-different) canonical content, exactly the "edited event" attack chainCheck exists to catch.
  lines[1].note = 'TAMPERED-' + lines[1].note;
  fs.writeFileSync(eventsFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  const result = chainCheckFn(root);
  const detected = result.ok === false && Array.isArray(result.broken) && result.broken.some((b) => b.run === runId);
  return {
    status: detected ? 'pass' : 'fail',
    reason: detected
      ? 'chainCheck correctly flagged the tampered event (self-hash mismatch) — the proof ledger is honestly reported corrupt, never silently trusted'
      : 'invariant broken — chainCheck did NOT flag a known-tampered chain: ' + JSON.stringify(result),
    evidence: [{ root, runId, chainCheckResult: result }],
  };
}

// =====================================================================================================
// SCENARIO 3: interrupted/crashed run -> forge-run-state marks only the unfinished WP for resume
// =====================================================================================================
function scenarioInterruptedRun(opts) {
  opts = opts || {};
  const runState = opts.runStateModule || require(REAL.forgeRunState);
  const runId = 'chaos-interrupt-' + Date.now();

  // sub-check A: pure projection — one WP fully finished, one WP only started (simulated crash before it
  // could log completion/failure) -> only the unfinished one may be marked for resume (no double work).
  const events = [
    { event_type: 'subagent_started', agent: 'test-boss', timestamp: 't1' },
    { event_type: 'subagent_completed', agent: 'test-boss', timestamp: 't2' },
    { event_type: 'subagent_started', agent: 'build-boss', timestamp: 't3' },
    // (crash here — build-boss never logs subagent_completed/subagent_failed)
  ];
  const st = runState.projectRunState(runId, events);
  const projectionOk = st.resume.includes('build-boss') && !st.resume.includes('test-boss') && st.unfinished.includes('build-boss') && st.complete === false;

  // sub-check B: a genuinely truncated on-disk events.jsonl (half-written last line, no closing brace, no
  // trailing newline) via the REAL CLI — must not crash and must not silently claim complete.
  const root = freshDir('forge-chaos-interrupt');
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const goodLine = JSON.stringify({ event_type: 'subagent_started', agent: 'build-boss', timestamp: 't1' });
  const truncatedLine = '{"event_type":"subagent_completed","agent":"build-b'; // half-written, unterminated
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), goodLine + '\n' + truncatedLine, 'utf8');
  const cli = spawnSync(process.execPath, [REAL.forgeRunState, runId, '--json'], {
    encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }),
  });
  let cliParsed = null;
  try { cliParsed = JSON.parse(cli.stdout); } catch { /* handled below via cliCrashed */ }
  const cliCrashed = cliParsed === null || ![0, 2, 3].includes(cli.status);
  const cliOk = !cliCrashed && cliParsed.resume.includes('build-boss') && cliParsed.complete === false;

  const pass = projectionOk && cliOk;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass
      ? 'resume-projector marks only the genuinely unfinished work package for redispatch (the already-completed one is never re-resumed), and a truncated on-disk events.jsonl neither crashes the CLI nor is silently treated as complete'
      : 'invariant broken — ' + JSON.stringify({ projectionOk, resume: st.resume, cliStatus: cli.status, cliParsed, cliStderr: (cli.stderr || '').slice(0, 300) }),
    evidence: [{ inMemory: st, root, runId, cliStatus: cli.status, cliParsed }],
  };
}

// =====================================================================================================
// SCENARIO 4: secret pasted into an event/entity -> forge-store redacts it before it ever touches disk
// =====================================================================================================
function scenarioSecretRedaction() {
  const storeRoot = freshDir('forge-chaos-secret'); // this dir itself acts as CLAUDE_DIR (FORGE_STORE_ROOT semantics)
  // "FAKE" is embedded on purpose in BOTH keys: forge-store still redacts them (sk-/nvapi- shape, long run),
  // but forge-doctor's leak-scan STRONG_PLACEHOLDER_RE recognises the FAKE marker as a test fixture and does
  // not cry wolf. (5th fix round: the nvapi key formerly used an XXXX run as its marker, but XXXX is now only
  // a WEAK signal — an incidental run no longer exempts a real-looking key — so it carries an explicit FAKE.)
  const fakeSecret = 'sk-FAKETHISISACHAOSTESTSECRETVALUE1234567890';
  const fakeNvidiaKey = 'nvapi-FAKE-CHAOSTESTKEYVALUE-DONOTUSE-000';
  const plainPassword = 'plain-unformatted-secret-chaos-value';
  const scriptDir = freshDir('forge-chaos-secret-script');
  const scriptPath = path.join(scriptDir, 'inject.cjs');
  const payload = { note: 'contains a secret: ' + fakeSecret + ' and a key: ' + fakeNvidiaKey, password: plainPassword };
  const src = [
    "'use strict';",
    'const store = require(' + JSON.stringify(REAL.forgeStore) + ');',
    'store.putEntity(' + JSON.stringify('artifacts') + ', ' + JSON.stringify('chaos-secret-1') + ', ' + JSON.stringify(payload) + ');',
    'process.stdout.write("done");',
  ].join('\n');
  fs.writeFileSync(scriptPath, src, 'utf8');
  const r = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { FORGE_STORE_ROOT: storeRoot }) });
  if (r.status !== 0) return { status: 'fail', reason: 'setup: injection script failed: ' + (r.stderr || r.stdout || '').trim(), evidence: [] };

  const entityFile = path.join(storeRoot, 'forge-artifacts', 'chaos-secret-1.json');
  let onDisk;
  try { onDisk = fs.readFileSync(entityFile, 'utf8'); }
  catch (e) { return { status: 'fail', reason: 'setup: stored entity file not found on disk: ' + e.message, evidence: [] }; }

  const leaked = onDisk.includes(fakeSecret) || onDisk.includes(fakeNvidiaKey) || onDisk.includes(plainPassword);
  const redactedMarkerPresent = onDisk.includes('***REDACTED***');
  const pass = !leaked && redactedMarkerPresent;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass
      ? 'forge-store redacted every secret (pattern-matched sk-/nvapi- keys AND the key-name-matched plain password) before the entity ever touched disk — raw secret bytes never appear in the stored file'
      : 'invariant broken — raw secret bytes were found on disk, or no redaction marker is present',
    evidence: [{ entityFile }],
  };
}

// =====================================================================================================
// SCENARIOS 5-10: nvidia-provider transport faults — real retry/mask/error-handling code, stubbed transport
// =====================================================================================================
function scenarioProviderOffline() {
  const stub = 'async function (url, options) { throw new Error("connect ECONNREFUSED 127.0.0.1:443 (auth attempted with Bearer ' + FAKE_KEY + ')"); }';
  const r = runProviderScript(stub, { role: 'fast', prompt: 'hi' }, {});
  const parsed = parseChildJson(r);
  if (!parsed.ok) return { status: 'fail', reason: parsed.err, evidence: [] };
  const out = parsed.out;
  if (out.__harness_uncaught) return { status: 'fail', reason: 'chat() threw uncaught on a network failure (must return a clean {error}, never throw): ' + out.__harness_uncaught, evidence: [{ out }] };
  const cleanError = typeof out.error === 'string' && out.error.length > 0;
  const noContent = out.content === undefined;
  const noKeyLeak = !out.error || !out.error.includes(FAKE_KEY);
  // guard against a pre-mortem-flagged false-pass class: a real (non-empty) NVIDIA_API_KEY is set for this
  // probe specifically so hasKey() stays true and chat()/call() never take the {mock:true} short-circuit —
  // asserted explicitly (not just assumed) so a future change to that plumbing fails LOUD, not silently green.
  const notMocked = out.mock !== true;
  const pass = cleanError && noContent && noKeyLeak && notMocked;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass
      ? 'a real network failure (thrown before any response) surfaces as a clean {error} after real retries (confirmed NOT the {mock:true} short-circuit) — no fabricated content, and the masked error never contains the raw API key'
      : 'invariant broken — ' + JSON.stringify({ cleanError, noContent, noKeyLeak, notMocked, out }),
    evidence: [{ out }],
  };
}
function providerHttpFaultScenario(status, label) {
  const stub = [
    'async function (url, options) {',
    '  return {',
    '    status: ' + status + ', ok: false,',
    '    headers: { get: function (h) { return String(h).toLowerCase() === "retry-after" ? "0.001" : null; } },',
    '    text: async function () { return JSON.stringify({ error: { message: "' + label + ' (chaos-injected)" } }); },',
    '  };',
    '}',
  ].join('\n');
  const r = runProviderScript(stub, { role: 'fast', prompt: 'hi' }, {});
  const parsed = parseChildJson(r);
  if (!parsed.ok) return { status: 'fail', reason: parsed.err, evidence: [] };
  const out = parsed.out;
  if (out.__harness_uncaught) return { status: 'fail', reason: 'chat() threw uncaught on a persistent HTTP ' + status + ' (must return a clean {error}): ' + out.__harness_uncaught, evidence: [{ out }] };
  const cleanError = typeof out.error === 'string' && out.error.includes(String(status));
  const noContent = out.content === undefined;
  // the injected body text must be echoed back verbatim in the error — this is only possible if the REAL
  // fetch reached our stub and the REAL call()/mask() code processed its response; a {mock:true} short-circuit
  // could never produce this text, so this doubles as the "not mocked" proof for this scenario.
  const realResponseProcessed = typeof out.error === 'string' && out.error.includes(label + ' (chaos-injected)');
  const notMocked = out.mock !== true;
  const pass = cleanError && noContent && realResponseProcessed && notMocked;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass
      ? 'a persistent HTTP ' + status + ' ends in a clean {error} after real retries (confirmed the REAL fetch/retry path ran, not the {mock:true} short-circuit — the injected response body was genuinely echoed back) — never fabricated content'
      : 'invariant broken — ' + JSON.stringify({ cleanError, noContent, realResponseProcessed, notMocked, out }),
    evidence: [{ out }],
  };
}
function scenarioProvider429() { return providerHttpFaultScenario(429, 'rate limited'); }
function scenarioProvider500() { return providerHttpFaultScenario(500, 'server error'); }
function scenarioProviderTimeout() {
  const stub = [
    'function (url, options) {',
    '  return new Promise(function (resolve, reject) {',
    '    var t = setTimeout(function () { resolve({ status: 200, ok: true, headers: { get: function () { return null; } }, text: async function () { return JSON.stringify({ choices: [{ message: { content: "FABRICATED-SHOULD-NEVER-ARRIVE" } }] }); } }); }, 999999);',
    '    var sig = options && options.signal;',
    '    if (sig) {',
    '      if (sig.aborted) { clearTimeout(t); var e0 = new Error("The operation was aborted"); e0.name = "AbortError"; reject(e0); return; }',
    '      sig.addEventListener("abort", function () { clearTimeout(t); var e1 = new Error("The operation was aborted"); e1.name = "AbortError"; reject(e1); });',
    '    }',
    '  });',
    '}',
  ].join('\n');
  const r = runProviderScript(stub, { role: 'fast', prompt: 'hi' }, { NVIDIA_TIMEOUT_MS: '80' });
  const parsed = parseChildJson(r);
  if (!parsed.ok) return { status: 'fail', reason: parsed.err, evidence: [] };
  const out = parsed.out;
  if (out.__harness_uncaught) return { status: 'fail', reason: 'chat() threw uncaught on a real abort-signal timeout (must return a clean {error}): ' + out.__harness_uncaught, evidence: [{ out }] };
  const cleanError = typeof out.error === 'string' && out.error.length > 0;
  const noFabrication = out.content === undefined || !/FABRICATED/.test(String(out.content));
  const notMocked = out.mock !== true;
  const pass = cleanError && noFabrication && notMocked;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass
      ? 'the real AbortSignal timeout wins the race against a slow "success" (confirmed NOT the {mock:true} short-circuit) — a clean {error}, never the fabricated content that would have arrived had the timeout not fired'
      : 'invariant broken — ' + JSON.stringify({ cleanError, noFabrication, notMocked, out }),
    evidence: [{ out }],
  };
}
function scenarioProviderMalformedResponse() {
  const stub = 'async function (url, options) { return { status: 200, ok: true, headers: { get: function () { return null; } }, text: async function () { return "NOT-VALID-JSON-{{{ chaos"; } }; }';
  const r = runProviderScript(stub, { role: 'fast', prompt: 'hi' }, {});
  const parsed = parseChildJson(r);
  if (!parsed.ok) return { status: 'fail', reason: parsed.err, evidence: [] };
  const out = parsed.out;
  const noCrash = !out.__harness_uncaught;
  const noFabrication = out.content === '' || out.content === undefined;
  const notMocked = out.mock !== true; // a mock content string is non-empty and would already fail noFabrication — asserted explicitly anyway for a self-explaining failure reason
  const pass = noCrash && noFabrication && notMocked;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass
      ? 'an unparsable HTTP 200 body never crashes chat() and never fabricates model content (confirmed NOT the {mock:true} short-circuit) — it degrades to empty content'
      : 'invariant broken — ' + JSON.stringify({ noCrash, noFabrication, notMocked, out }),
    evidence: [{ out }],
  };
}
function scenarioProviderUnknownModel() {
  const stub = 'async function (url, options) { return { status: 404, ok: false, headers: { get: function () { return null; } }, text: async function () { return JSON.stringify({ error: { message: "model \\u0027totally-bogus-model-xyz\\u0027 not found" } }); } }; }';
  const r = runProviderScript(stub, { model: 'totally-bogus-model-xyz', prompt: 'hi' }, {});
  const parsed = parseChildJson(r);
  if (!parsed.ok) return { status: 'fail', reason: parsed.err, evidence: [] };
  const out = parsed.out;
  if (out.__harness_uncaught) return { status: 'fail', reason: 'chat() threw uncaught for an unknown model (must return a clean {error}): ' + out.__harness_uncaught, evidence: [{ out }] };
  const cleanError = typeof out.error === 'string' && out.error.includes('404');
  const noContent = out.content === undefined;
  const notMocked = out.mock !== true;
  const pass = cleanError && noContent && notMocked;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass
      ? 'a provider-side 404 for a bogus model id surfaces as a clean {error} (confirmed NOT the {mock:true} short-circuit) — never fabricated content'
      : 'invariant broken — ' + JSON.stringify({ cleanError, noContent, notMocked, out }),
    evidence: [{ out }],
  };
}

// =====================================================================================================
// SCENARIO 11: canary-sync failure -> canary rolled back, WHOLE batch aborts, real projects untouched
// =====================================================================================================
function scenarioCanarySyncFailure(opts) {
  opts = opts || {};
  const sync = opts.syncModule || require(REAL.forgeSync);
  const tpl = freshDir('forge-chaos-sync-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("chaos-template-v1");\n', 'utf8');
  const root = freshDir('forge-chaos-sync-root');
  // FIXTURE "real" projects — never one of the real 12 Forge projects; both must stay byte-untouched.
  const proj1 = makeFixtureProject(root, 'fixture-real-1');
  const proj2 = makeFixtureProject(root, 'fixture-real-2');
  const before1 = snapshotTree(proj1);
  const before2 = snapshotTree(proj2);

  const failDoctorSrc = path.join(root, 'fail-doctor.cjs');
  fs.writeFileSync(failDoctorSrc, [
    '#!/usr/bin/env node',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ ok: false, checks: { node_check: { ok: false, total: 1, failed: 1 }, tests: { ok: true, suites: 1, passed: 1, failed: 0 } } })); }',
    'process.exit(1);',
  ].join('\n'), 'utf8');

  const batchId = 'chaos-canary-b-' + Date.now();
  const r = sync.runSyncAll(tpl, root, { projects: [proj1, proj2], canaryDoctorSource: failDoctorSrc, batchId, nowIso: '2026-07-14T00:00:00.000Z' });

  const after1 = snapshotTree(proj1);
  const after2 = snapshotTree(proj2);
  const abortedAtCanary = r.ok === false && r.aborted === true && r.stage === 'dedicated-canary';
  const canaryRolledBack = !!r.dedicatedCanary && r.dedicatedCanary.ok === false && r.dedicatedCanary.rolledBack === true;
  const realUntouched = JSON.stringify(before1) === JSON.stringify(after1) && JSON.stringify(before2) === JSON.stringify(after2);
  const stillHermetic = allUnderTmp(); // proof: nothing in this scenario ever left os.tmpdir() — never the real 12 projects
  const pass = abortedAtCanary && canaryRolledBack && realUntouched && stillHermetic;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass
      ? 'a broken canary validation rolled the dedicated canary back and aborted the WHOLE batch before touching either fixture "real" project — the safe-sync circuit breaker held, and no write ever left os.tmpdir()'
      : 'invariant broken — ' + JSON.stringify({ abortedAtCanary, canaryRolledBack, realUntouched, stillHermetic, resultOk: r.ok, resultStage: r.stage }),
    evidence: [{ root, batchId, resultSummary: { ok: r.ok, aborted: r.aborted, stage: r.stage, dedicatedCanary: r.dedicatedCanary && { ok: r.dedicatedCanary.ok, rolledBack: r.dedicatedCanary.rolledBack } } }],
  };
}

// =====================================================================================================
// SCENARIO 12: unknown agent/model in the routing config -> clean {error}/null, never a silent fabrication
// =====================================================================================================
function scenarioUnknownRouting() {
  const r = runRoutingProbeScript();
  const parsed = parseChildJson(r);
  if (!parsed.ok) return { status: 'fail', reason: parsed.err, evidence: [] };
  const out = parsed.out;
  const routeGraceful = !!out.routeResult && typeof out.routeResult.error === 'string' && out.routeResult.error.length > 0;
  const modelGraceful = out.modelResult === null;
  const pass = routeGraceful && modelGraceful;
  return {
    status: pass ? 'pass' : 'fail',
    reason: (pass
      ? 'an unknown agent/role in the routing config resolves to an explicit {error} / null — never a silently fabricated model id, never a crash counted as success. '
      : 'invariant broken — ' + JSON.stringify(out) + '. ')
      + 'NOTE (honest scope boundary): this covers "unknown model in routing" only — a "missing skill" fallback '
      + '(agent-skill-map.json / forge-paperclip.cjs skillsForRole) is outside this harness\'s locked module scope '
      + '(forge-store/forge-run-state/forge-report/nvidia-provider/forge-sync/forge-verify) and is not injected here.',
    evidence: [{ out }],
  };
}

// =====================================================================================================
// registry, runner, CLI
// =====================================================================================================
const SCENARIOS = [
  { id: 'malformed_json_events', description: 'A malformed JSON line lands in a run\'s events.jsonl.', invariant: 'forge-verify skips the bad line, never crashes, and never lets a dropped completion event count as done.', run: scenarioMalformedJson },
  { id: 'corrupt_hash_chain', description: 'An event in the proof-ledger hash chain is tampered with after the fact.', invariant: 'forge-doctor.chainCheck detects the tamper (ok:false) — the ledger is never silently trusted.', run: scenarioCorruptHashChain },
  { id: 'interrupted_run_resume', description: 'A run crashes mid-flight: one work package finishes, another only starts (or the checkpoint file itself is truncated).', invariant: 'forge-run-state marks only the genuinely unfinished work package for resume — no double work, no fake completion.', run: scenarioInterruptedRun },
  { id: 'secret_in_event', description: 'A secret (API key / password) is pasted into a value being stored.', invariant: 'forge-store redacts every secret before the entity ever touches disk.', run: scenarioSecretRedaction },
  { id: 'provider_offline', description: 'The NVIDIA provider network call fails outright (connection refused).', invariant: 'nvidia-provider returns a clean {error}, never fabricated content, never leaks the raw API key.', run: scenarioProviderOffline },
  { id: 'provider_rate_limited_429', description: 'The NVIDIA provider persistently returns HTTP 429.', invariant: 'nvidia-provider retries then returns a clean {error}, never fabricated content.', run: scenarioProvider429 },
  { id: 'provider_server_error_500', description: 'The NVIDIA provider persistently returns HTTP 500.', invariant: 'nvidia-provider retries then returns a clean {error}, never fabricated content.', run: scenarioProvider500 },
  { id: 'provider_timeout', description: 'The NVIDIA provider never responds within the configured timeout.', invariant: 'the real AbortSignal timeout wins over a slow "success" — clean {error}, no fabrication.', run: scenarioProviderTimeout },
  { id: 'provider_malformed_response', description: 'The NVIDIA provider returns HTTP 200 with an unparsable body.', invariant: 'nvidia-provider degrades to empty content, never crashes, never fabricates an answer.', run: scenarioProviderMalformedResponse },
  { id: 'provider_unknown_model', description: 'A bogus model id is sent to the NVIDIA provider.', invariant: 'the provider-side 404 surfaces as a clean {error}, never fabricated content.', run: scenarioProviderUnknownModel },
  { id: 'canary_sync_failure', description: 'The dedicated sync canary fails its own post-sync validation.', invariant: 'forge-sync rolls the canary back and aborts the WHOLE batch before touching any real project.', run: scenarioCanarySyncFailure },
  { id: 'unknown_agent_model_routing', description: 'An unknown agent/role is requested from the model-routing config.', invariant: 'nvidia-provider returns an explicit {error}/null, never a silently fabricated route.', run: scenarioUnknownRouting },
];

// Some checked modules (e.g. forge-sync.cjs's own runSyncAll/printSafeSyncResult) print real progress/error
// lines to console.log/console.error as part of doing their real job — expected, honest chatter, not a bug
// in them. Silencing it here (this file's OWN console, restored immediately after) keeps this harness's
// stdout a clean single report (required for --json to stay valid, parsable JSON) without touching any
// other file. Captured lines are attached to a FAILED scenario's evidence only (debugging aid); a passed
// scenario's evidence stays lean, exactly as already designed.
function runScenarioSilently(fn) {
  const realLog = console.log, realErr = console.error;
  const captured = [];
  console.log = (...args) => { captured.push(args.map(String).join(' ')); };
  console.error = (...args) => { captured.push(args.map(String).join(' ')); };
  try { return { result: fn(), captured }; }
  finally { console.log = realLog; console.error = realErr; }
}
function runAll(only) {
  const results = [];
  for (const sc of SCENARIOS) {
    if (only && sc.id !== only) continue;
    const t0 = Date.now();
    let res, captured = [];
    try {
      const wrapped = runScenarioSilently(() => sc.run({}));
      res = wrapped.result; captured = wrapped.captured;
    } catch (e) { res = { status: 'fail', reason: 'scenario threw uncaught (harness bug or a real crash in the checked path): ' + ((e && e.stack) || e), evidence: [] }; }
    if (!res || !['pass', 'fail', 'skip'].includes(res.status)) {
      res = { status: 'fail', reason: 'scenario returned no valid status — never silently counted as pass', evidence: [] };
    }
    if (res.status === 'fail' && captured.length) {
      res = Object.assign({}, res, { evidence: (res.evidence || []).concat([{ suppressedModuleOutput: captured.slice(0, 40) }]) });
    }
    results.push(Object.assign({ id: sc.id, description: sc.description, invariant: sc.invariant, ms: Date.now() - t0 }, res));
  }
  return results;
}

function tally(results) {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length,
  };
}

// Pure exit-code decision, deliberately factored out of the CLI block so it is directly unit-testable
// with a hand-built tally (no need to spawn a real run for every branch). This is the SINGLE place that
// decides whether "exit 0 = every invariant held" is actually true for a given tally — see the CLI
// docblock above for the full 0/1/2/3 contract. `args` is only consulted for a friendlier usage message
// (naming the unknown --only id); it never changes the decision itself.
function classifyRun(tl, args) {
  args = args || {};
  if (!tl || tl.total === 0) {
    return {
      exitCode: 2,
      outcome: 'usage_error',
      reason: '0 scenario(s) ran' + (args.only ? (' (unknown --only id: ' + JSON.stringify(args.only) + ')') : '')
        + ' — refusing to report exit 0 for a vacuous run.',
    };
  }
  if (tl.failed > 0) {
    return { exitCode: 1, outcome: 'failed', reason: tl.failed + ' of ' + tl.total + ' scenario(s) FAILED — at least one invariant broke.' };
  }
  if (tl.skipped > 0) {
    return {
      exitCode: 3,
      outcome: 'skipped',
      reason: tl.skipped + ' of ' + tl.total + ' scenario(s) SKIPPED — not every invariant was verified this run, so this is NOT a full green.',
    };
  }
  return { exitCode: 0, outcome: 'green', reason: 'all ' + tl.total + ' scenario(s) passed — every invariant genuinely held.' };
}

function printHuman(results) {
  const lines = ['forge-chaos — failure-injection harness'];
  for (const r of results) {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL';
    lines.push('  [' + tag + '] ' + r.id + ' (' + r.ms + 'ms)');
    lines.push('    invariant: ' + r.invariant);
    lines.push('    ' + r.reason);
  }
  const tl = tally(results);
  lines.push('');
  lines.push(tl.total + ' scenario(s): ' + tl.passed + ' passed, ' + tl.failed + ' failed, ' + tl.skipped + ' skipped.');
  lines.push('every fixture rooted under os.tmpdir(): ' + allUnderTmp());
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { json: false, only: null, keepTmp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--only') out.only = argv[++i] || null;
    else if (a === '--keep-tmp') out.keepTmp = true;
  }
  return out;
}

module.exports = {
  SCENARIOS, runAll, tally, classifyRun, printHuman, parseArgs, allUnderTmp, getTmpRoots, cleanupTmp, FAKE_KEY,
  scenarioMalformedJson, scenarioCorruptHashChain, scenarioInterruptedRun, scenarioSecretRedaction,
  scenarioProviderOffline, scenarioProvider429, scenarioProvider500, scenarioProviderTimeout,
  scenarioProviderMalformedResponse, scenarioProviderUnknownModel, scenarioCanarySyncFailure, scenarioUnknownRouting,
};

// ---- CLI ----
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const results = runAll(args.only);
  const tl = tally(results);
  const decision = classifyRun(tl, args);
  if (args.json) {
    console.log(JSON.stringify({ results, tmpRootsOk: allUnderTmp(), tmpRoots: getTmpRoots(), tally: tl, outcome: decision.outcome, exitCode: decision.exitCode }, null, 2));
  } else {
    console.log(printHuman(results));
  }
  if (decision.exitCode !== 0) console.error('forge-chaos: ' + decision.reason);
  if (!args.keepTmp) cleanupTmp();
  process.exitCode = decision.exitCode;
}
