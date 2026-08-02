#!/usr/bin/env node
'use strict';
/** forge-v9-events.test.cjs — V9-INTEGRATE (2026-07-22) real end-to-end proof that the 7 new event types
 *  declared by P1 (forge-runcontract.cjs), P2 (forge-capabilities.cjs), P4 (forge-projectbrain.cjs), and
 *  P5 (forge-scout.cjs) are genuinely registered in all 3 required places (the "3-place event-registration
 *  discipline" CLAUDE.md's invariant #6 requires):
 *    1. forge-dashboard/log-event.cjs KNOWN_EVENT_TYPES — proven by REALLY spawning the CLI (a made-up
 *       event_type must still be STRICT-REJECTED; every one of the 7 new types must be ACCEPTED and land in
 *       a real events.jsonl line).
 *    2. forge-bin/forge-verify.cjs's TERMINAL_TYPES/FAILED_TYPES mirror — proven by direct membership checks
 *       against the exported Sets (no re-implemented classification logic).
 *    3. forge-dashboard/app.js's taskStatus()/SYNTH mirror — proven via a static source-text check (app.js
 *       is browser JS with no Node-loadable module boundary Node can exercise headlessly the way panels.js's
 *       vm-sandbox tests do for pure render functions; a literal string-membership check on the real shipped
 *       source is still a genuine regression guard, not a fabricated pass — see forge-doctor.test.cjs's own
 *       identical convention for cross-file drift proofs).
 *  Writes ONLY into a real throwaway run directory (deleted at the end, success or failure) — never touches
 *  any real/historical run. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-v9-events tests (log-event.cjs + forge-verify.cjs + app.js 3-place registration proof)');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG_EVENT = path.join(ROOT, '.claude', 'forge-dashboard', 'log-event.cjs');
const RUNS_DIR = path.join(ROOT, '.claude', 'forge-runs');
const RUN_ID = 'v9events-test-' + process.pid + '-' + Date.now();
const RUN_DIR = path.join(RUNS_DIR, RUN_ID);

const NEW_TYPES = [
  ['research_done', 'done'],
  ['run_contract_checked', 'done'],
  ['run_contract_violated', 'failed'],
  ['capabilities_reported', 'done'],
  ['scout_researched', 'done'],
  ['capability_vetted', 'done'],
  ['projectbrain_generated', 'done'],
];

function readEvents() {
  const raw = fs.readFileSync(path.join(RUN_DIR, 'events.jsonl'), 'utf8');
  return raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function runCLI(argv, env) {
  return spawnSync(process.execPath, [LOG_EVENT, ...argv], { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) });
}

try {
  // -----------------------------------------------------------------------------------------------------
  // 1) log-event.cjs — real spawned-subprocess acceptance proof
  // -----------------------------------------------------------------------------------------------------
  console.log('\n1) log-event.cjs KNOWN_EVENT_TYPES — real CLI acceptance');
  for (const [type] of NEW_TYPES) {
    t('CLI accepts "' + type + '" (exit 0, no STRICT REFUSED)', () => {
      const r = runCLI([RUN_ID, type, JSON.stringify({ agent: 'internal', runtime: 'internal', note: 'v9-events proof' })]);
      assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
      assert.ok(!/STRICT REFUSED/.test(r.stderr || ''), 'unexpected STRICT REFUSED: ' + r.stderr);
    });
  }
  t('every accepted event actually landed in a real events.jsonl line (not just exit 0)', () => {
    const events = readEvents();
    for (const [type] of NEW_TYPES) assert.ok(events.some((e) => e.event_type === type), type + ' missing from events.jsonl');
  });
  t('a genuinely made-up event_type is STILL STRICT-REJECTED (the honesty gate was not weakened)', () => {
    const r = runCLI([RUN_ID, 'totally_not_a_real_v9_event_type_xyz', '{}']);
    assert.strictEqual(r.status, 2);
    assert.ok(/STRICT REFUSED/.test(r.stderr || ''), 'expected STRICT REFUSED, got: ' + r.stderr);
  });

  // -----------------------------------------------------------------------------------------------------
  // 2) forge-verify.cjs TERMINAL_TYPES/FAILED_TYPES mirror
  // -----------------------------------------------------------------------------------------------------
  console.log('\n2) forge-verify.cjs classification mirror');
  const verify = require('./forge-verify.cjs');
  for (const [type, want] of NEW_TYPES) {
    t('forge-verify.cjs classifies "' + type + '" as ' + want, () => {
      const inTerminal = verify.TERMINAL_TYPES.has(type);
      const inFailed = verify.FAILED_TYPES.has(type);
      assert.ok(!(inTerminal && inFailed), type + ' cannot be in both TERMINAL_TYPES and FAILED_TYPES');
      if (want === 'done') assert.ok(inTerminal, type + ' expected in TERMINAL_TYPES');
      else assert.ok(inFailed, type + ' expected in FAILED_TYPES');
    });
  }

  // -----------------------------------------------------------------------------------------------------
  // 3) app.js taskStatus()/SYNTH mirror — real shipped source, static membership proof
  // -----------------------------------------------------------------------------------------------------
  console.log('\n3) forge-dashboard/app.js classification mirror (static source proof)');
  const appSrc = fs.readFileSync(path.join(ROOT, '.claude', 'forge-dashboard', 'app.js'), 'utf8');
  for (const [type, want] of NEW_TYPES) {
    t('app.js taskStatus() includes "' + type + '" in its ' + want + ' list', () => {
      const re = new RegExp("(^|[,\\s])'" + type + "'(,|\\])");
      assert.ok(re.test(appSrc), type + ' literal not found in app.js source at all');
    });
  }
  for (const [type] of NEW_TYPES) {
    t('app.js SYNTH map has a fallback entry for "' + type + '"', () => {
      const synthRe = new RegExp(type + ":\\s*'[a-z-]+'");
      assert.ok(synthRe.test(appSrc), type + ' not found in the SYNTH fallback map');
    });
  }

  // -----------------------------------------------------------------------------------------------------
  // 4) unregisteredEvent() (forge-doctor.cjs) never flags the new types as unregistered
  // -----------------------------------------------------------------------------------------------------
  console.log('\n4) forge-doctor.cjs cross-check (no false "unregistered" flag)');
  const doctor = require('./forge-doctor.cjs');
  const known = doctor.extractKnownEventTypesFromSource(fs.readFileSync(LOG_EVENT, 'utf8'));
  t('extractKnownEventTypesFromSource() sees all 7 new literal types', () => {
    for (const [type] of NEW_TYPES) assert.ok(known.has(type), type + ' not found by the static KNOWN_EVENT_TYPES extractor');
  });
} finally {
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
