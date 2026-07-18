#!/usr/bin/env node
'use strict';
/** Hermetic, real-CLI tests for forge-promptcheck.cjs (WP-PROMPTCHECK). Every case runs the actual CLI
 *  via spawnSync (never requires the module directly for assertions) so exit codes / stdout / logged
 *  events are proven, not assumed. Temp prompt files + a temp fake .claude/ project root live under one
 *  os.tmpdir() dir — nothing here touches this repo's real .claude/forge-runs/. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-promptcheck-test-'));
const CLI = path.join(__dirname, 'forge-promptcheck.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-promptcheck offline tests (hermetic tmp=' + TMP + ')');

function writePrompt(name, text) {
  const p = path.join(TMP, name + '-' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(p, text, 'utf8');
  return p;
}
function runCli(args, opts) {
  return spawnSync(process.execPath, [CLI, ...args], Object.assign({ encoding: 'utf8' }, opts || {}));
}
function runJson(text, extraArgs) {
  const file = writePrompt('p', text);
  const r = runCli([file, '--json'].concat(extraArgs || []));
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* leave null; assertions below fail loudly */ }
  return { r, parsed };
}

// ---- fixtures ----
// A prompt shaped like a real Forge work package (see forge-router SKILL.md "Emit Work Packages") —
// this is the "a good dispatch already passes" claim from the read-first material, proven for real.
const STRONG_PROMPT = [
  'WORK PACKAGE -- Build Boss',
  'mission: Build the LoginForm component; the deliverable is src/components/LoginForm.tsx.',
  'inputs: src/components/LoginForm.tsx, src/lib/auth.ts',
  'allowed_actions: edit only these files listed in inputs.',
  'not_allowed: do not touch src/lib/session.ts; never modify unrelated files.',
  'output_artifact: src/components/LoginForm.tsx',
  'evidence_required: quote real npm test output as evidence; do not claim success without proof.',
  'success_criteria: must pass tests/login.test.ts; verify with npm test.',
  'rework_criteria: missing validation or an unhandled error path.',
].join('\n');

const WEAK_PROMPT = 'improve the thing and fix stuff';

// ---- 1) strong dispatch -> score >=6, PROMPT-MASTER-SHAPED, exit 0 ----
{
  const { r, parsed } = runJson(STRONG_PROMPT);
  t('case1: CLI exits 0', r.status === 0);
  t('case1: parsed JSON present', !!parsed);
  t('case1: passed >= 6', !!parsed && parsed.passed >= 6);
  t('case1: verdict is PROMPT-MASTER-SHAPED', !!parsed && parsed.verdict === 'PROMPT-MASTER-SHAPED');
}

// ---- 2) weak vague prompt -> low score, NEEDS-SHARPENING, missing dims listed, exit 0 (advisory) ----
{
  const { r, parsed } = runJson(WEAK_PROMPT);
  t('case2: CLI exits 0 (advisory, non-blocking by default)', r.status === 0);
  t('case2: low score (< 4)', !!parsed && parsed.passed < 4);
  t('case2: verdict is NEEDS-SHARPENING', !!parsed && /^NEEDS-SHARPENING/.test(parsed.verdict));
  t('case2: missing dims listed (non-empty)', !!parsed && Array.isArray(parsed.missing) && parsed.missing.length > 0);
}

// ---- 3) --strict on the weak prompt -> exit 1 ----
{
  const file = writePrompt('weak-strict', WEAK_PROMPT);
  const r = runCli([file, '--strict']);
  t('case3: --strict on a weak prompt exits 1', r.status === 1);
}
// --strict on the strong prompt still exits 0 (sanity check the flag doesn't just always fail/pass)
{
  const file = writePrompt('strong-strict', STRONG_PROMPT);
  const r = runCli([file, '--strict']);
  t('case3b: --strict on a strong prompt exits 0', r.status === 0);
}

// ---- 4) each of the 7 dimensions individually detected (missing exactly one -> only that one flagged) ----
{
  const HEADER = 'Dispatch prompt for Boss X.';
  // Each field is deliberately isolated: it carries ONLY the keyword(s) for its own dimension, with no
  // path/file tokens and no words that belong to any other dimension's keyword list (hand-verified).
  const FIELDS = {
    'target-state': 'Mission: this task has a clear deliverable and target result; done when the goal is reached.',
    'allowed-scope': 'Allowed_actions: work only on the assigned inputs; edit only what is listed.',
    'forbidden-scope': 'Not_allowed: do not touch the shared config; never modify unrelated code. This is a scope lock -- only the assigned area may change, nothing else, must not go outside that boundary.',
    'stop-condition': 'Stop condition: ask before proceeding if requirements are unclear; checkpoint before any destructive change; when complete, report back.',
    'acceptance-criteria': 'Acceptance: this must pass a review; verify thoroughly against the criteria. Rework_criteria: redo if broken.',
    'evidence-honesty': 'Evidence_required: quote the real command output as evidence; include proof; maintain honesty at every step.',
  };
  const KEYS = Object.keys(FIELDS);
  function buildPrompt(excludeKey) {
    const parts = [HEADER];
    for (const k of KEYS) { if (k !== excludeKey) parts.push(FIELDS[k]); }
    return parts.join('\n');
  }

  const baseline = runJson(buildPrompt(null));
  t('case4: baseline (all 6 keyword fields present) -> all 6 keyword dims true', !!baseline.parsed && KEYS.every((k) => baseline.parsed.dimensions[k] === true));
  t('case4: baseline also passes no-vague-verbs (0 vague words used)', !!baseline.parsed && baseline.parsed.dimensions['no-vague-verbs'] === true);

  for (const k of KEYS) {
    const { parsed } = runJson(buildPrompt(k));
    const onlyThisMissing = !!parsed && parsed.dimensions[k] === false && KEYS.filter((x) => x !== k).every((x) => parsed.dimensions[x] === true);
    t('case4: removing "' + k + '" flags only that dimension', onlyThisMissing);
  }

  // no-vague-verbs dimension in isolation: keep all 6 keyword fields, add nothing but vague filler.
  const vagueOnly = runJson(buildPrompt(null) + ' Please handle this, improve it, and clean up some stuff, etc.');
  const onlyVagueMissing = !!vagueOnly.parsed && vagueOnly.parsed.dimensions['no-vague-verbs'] === false && KEYS.every((k) => vagueOnly.parsed.dimensions[k] === true);
  t('case4: adding vague filler on top of the full baseline flags only no-vague-verbs', onlyVagueMissing);
}

// ---- 5) no-vague-verbs: flagged without path grounding; not flagged when paths/specifics are present ----
{
  const { parsed: p1 } = runJson('handle the stuff, improve it, etc');
  t('case5: vague verbs with no path/file token -> flagged', !!p1 && p1.dimensions['no-vague-verbs'] === false);

  const { parsed: p2 } = runJson('Edit src/lib/auth.ts: handle the edge cases in validate(), improve error handling for empty input, and optimize the hot path in src/lib/auth.ts.');
  t('case5: vague verbs anchored by concrete paths -> not flagged', !!p2 && p2.dimensions['no-vague-verbs'] === true);
}

// ---- 6) STDIN mode ('-') works ----
{
  const r = runCli(['-', '--json'], { input: STRONG_PROMPT });
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch { /* fail below */ }
  t('case6: stdin mode exits 0', r.status === 0);
  t('case6: stdin mode scores the strong prompt correctly', !!parsed && parsed.passed >= 6);
}

// ---- 7) --json shape parses with score/verdict/dimensions/missing ----
{
  const { parsed } = runJson(STRONG_PROMPT);
  t('case7: json has numeric score', !!parsed && typeof parsed.score === 'number');
  t('case7: json has numeric passed', !!parsed && typeof parsed.passed === 'number');
  t('case7: json total is 7', !!parsed && parsed.total === 7);
  t('case7: json has a string verdict', !!parsed && typeof parsed.verdict === 'string');
  t('case7: json dimensions object has exactly 7 keys', !!parsed && parsed.dimensions && Object.keys(parsed.dimensions).length === 7);
  t('case7: json has a missing array', !!parsed && Array.isArray(parsed.missing));
  t('case7: json has a suggestions array', !!parsed && Array.isArray(parsed.suggestions));
}

// ---- 8) --run logs one agent_note (real log-event.cjs copied into a temp project root); failure tolerated ----
{
  const root = path.join(TMP, 'run-root');
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'config', 'agents'), { recursive: true });
  const realLogEvent = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
  fs.copyFileSync(realLogEvent, path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.writeFileSync(path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'), JSON.stringify({ agents: {} }));

  const file = writePrompt('run-ok', STRONG_PROMPT);
  const r = runCli([file, '--run', 'forge-test-run-001'], { env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
  t('case8: CLI with --run still exits 0', r.status === 0);

  const evPath = path.join(root, '.claude', 'forge-runs', 'forge-test-run-001', 'events.jsonl');
  let events = [];
  try { events = fs.readFileSync(evPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none written */ }
  t('case8: exactly one event logged', events.length === 1);
  t('case8: event_type is agent_note', events.length === 1 && events[0].event_type === 'agent_note');
  t('case8: agent is orchestrator', events.length === 1 && events[0].agent === 'orchestrator');
  t('case8: note carries the score', events.length === 1 && /\d\/7/.test(String(events[0].note)));

  // failure tolerated: FORGE_PROJECT_ROOT points at a dir with no log-event.cjs at all -> CLI still exits 0.
  const badRoot = path.join(TMP, 'run-root-missing');
  fs.mkdirSync(badRoot, { recursive: true });
  const file2 = writePrompt('run-missing', STRONG_PROMPT);
  const r2 = runCli([file2, '--run', 'forge-test-run-002'], { env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: badRoot }) });
  t('case8b: missing log-event.cjs is tolerated (CLI still exits 0)', r2.status === 0);
  t('case8b: a warning is still surfaced on stderr', /log-event warning/.test(r2.stderr));
}

// ---- 9) usage errors: no file argument at all, and an unreadable/nonexistent file, both exit 2 ----
{
  const r1 = runCli([]);
  t('case9: no arguments at all -> usage error exit 2', r1.status === 2);

  const r2 = runCli([path.join(TMP, 'does-not-exist-' + Math.random().toString(36).slice(2) + '.txt')]);
  t('case9b: nonexistent prompt file -> usage/read error exit 2', r2.status === 2);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
