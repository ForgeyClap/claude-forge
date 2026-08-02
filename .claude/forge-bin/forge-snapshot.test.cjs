#!/usr/bin/env node
'use strict';
// forge-snapshot.test.cjs — real tests for the context-continuity snapshot generator (owner request
// 2026-07-29). Every fixture runs under a fresh os.tmpdir() project — this file NEVER writes to this repo's
// real .claude/FORGE_SNAPSHOT.md and NEVER reads this repo's real forge-runs/ (each fixture builds its own).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const snap = require('./forge-snapshot.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true });
  // forge-manifest.cjs is required directly by forge-snapshot.cjs's module scope (not dynamically), so no
  // copy is needed there; forge-doctor.cjs is required lazily+guarded (pickRunId's try/catch) — a fixture
  // that omits it simply gets runId:null, which several tests below rely on as the honest "no run" case.
  return root;
}
function writeMemory(root, body) {
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_MEMORY.md'), body);
}
function writeEvents(root, runId, lines) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
function ev(overrides) {
  return Object.assign({ run_id: 'r1', timestamp: '2026-07-29T10:00:00.000Z' }, overrides);
}

console.log('forge-snapshot tests (context-continuity snapshot generator)');

// ---------------------------------------------------------------------------
console.log('\n1) write() basic shape + all 10 sections present');
t('write() produces a file with all 10 numbered section headings', () => {
  const root = freshRoot('snap-basic');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-07-29T12:00:00Z') });
  assert.ok(fs.existsSync(r.path));
  for (let i = 1; i <= 10; i++) assert.ok(new RegExp('^## ' + i + '\\.').test(r.markdown.split('\n').find((l) => l.startsWith('## ' + i + '.')) || ''), 'missing section ' + i);
  assert.ok(r.markdown.includes('reason: manual'));
});

t('write() rejects an invalid --reason at the CLI but write() itself defaults an invalid opts.reason to manual', () => {
  const root = freshRoot('snap-badreason');
  const r = snap.write({ root, reason: 'not-a-real-reason', now: new Date() });
  assert.strictEqual(r.reason, 'manual');
});

// ---------------------------------------------------------------------------
console.log('\n2) Mission handling — anti-drift');
t('mission is preserved VERBATIM across two regenerations even as other sources change', () => {
  const root = freshRoot('snap-mission-verbatim');
  writeMemory(root, '# Forge Memory\n\n## Status update A\n- first state\n');
  const r1 = snap.write({ root, reason: 'manual', now: new Date('2026-07-29T10:00:00Z') });
  const missionBlock1 = snap.extractMissionBlock(r1.markdown);
  assert.ok(missionBlock1);
  // change the source memory entirely between regenerations
  writeMemory(root, '# Forge Memory\n\n## Status update B (totally different)\n- second state, unrelated text\n');
  const r2 = snap.write({ root, reason: 'phase', now: new Date('2026-07-29T11:00:00Z') });
  const missionBlock2 = snap.extractMissionBlock(r2.markdown);
  assert.strictEqual(missionBlock2, missionBlock1, 'mission block must be byte-identical across regenerations');
  assert.ok(!r2.markdown.includes('unrelated text'), 'mission must not have re-derived from the new memory content');
});

t('mission migrates verbatim from a pre-existing hand-written snapshot\'s first section when no marker exists', () => {
  const root = freshRoot('snap-mission-migrate');
  const snapshotPath = path.join(root, '.claude', 'FORGE_SNAPSHOT.md');
  fs.writeFileSync(snapshotPath, '# FORGE SNAPSHOT — handwritten\n\n## 1. Wat bouwen we\nThe exact mission paragraph text to preserve.\n\n## 2. Waar het staat\nsome other section content\n');
  const r = snap.write({ root, reason: 'manual', now: new Date() });
  assert.ok(r.markdown.includes('The exact mission paragraph text to preserve.'));
  assert.ok(!r.markdown.includes('some other section content'), 'only the FIRST section body may be migrated as Mission');
  assert.ok(r.mission.source.includes('migrated verbatim'));
});

t('mission falls back to an honest TODO placeholder when no marker/prior snapshot/memory exists', () => {
  const root = freshRoot('snap-mission-todo');
  const r = snap.write({ root, reason: 'manual', now: new Date() });
  assert.ok(r.mission.block.includes('TODO'));
  assert.strictEqual(r.mission.source, 'no source found — honest TODO placeholder');
});

// ---------------------------------------------------------------------------
console.log('\n3) Section 3 (Current state) is ALWAYS re-derived fresh — never patched forward');
t('changing events.jsonl between two writes changes Current state (not preserved like Mission)', () => {
  const root = freshRoot('snap-section3');
  writeEvents(root, 'run-a', [ev({ event_type: 'run_started', agent: 'orchestrator', task: 'do the thing' })]);
  const r1 = snap.write({ root, reason: 'manual', now: new Date(), runId: 'run-a' });
  assert.ok(!r1.markdown.includes('SENTINEL-NEW-EVENT'));
  writeEvents(root, 'run-a', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'do the thing' }),
    ev({ event_type: 'subagent_completed', agent: 'Build Boss', role: 'x', note: 'SENTINEL-NEW-EVENT done' }),
  ]);
  const r2 = snap.write({ root, reason: 'manual', now: new Date(), runId: 'run-a' });
  assert.ok(r2.markdown.includes('SENTINEL-NEW-EVENT'), 'Current state must reflect the freshly-changed events.jsonl');
});

t('in-progress bucket lists a subagent_started with no matching completed/failed', () => {
  const root = freshRoot('snap-inprogress');
  writeEvents(root, 'run-b', [
    ev({ event_type: 'subagent_started', agent: 'Test Boss', role: 'qa', dispatch_id: 'd1', task: 'run the suite' }),
  ]);
  const r = snap.write({ root, reason: 'manual', now: new Date(), runId: 'run-b' });
  assert.ok(r.markdown.includes('run the suite'));
  assert.ok(r.markdown.includes('dispatch_id=d1'));
});

t('done bucket excludes a subagent_started that WAS later completed', () => {
  const root = freshRoot('snap-done-excl');
  writeEvents(root, 'run-c', [
    ev({ event_type: 'subagent_started', agent: 'Build Boss', role: 'x', dispatch_id: 'd2', task: 'build it' }),
    ev({ event_type: 'subagent_completed', agent: 'Build Boss', role: 'x', dispatch_id: 'd2', note: 'built successfully' }),
  ]);
  const r = snap.write({ root, reason: 'manual', now: new Date(), runId: 'run-c' });
  assert.ok(!r.markdown.includes('build it'), 'a completed dispatch must not remain in the In progress bucket');
  assert.ok(r.markdown.includes('built successfully'));
});

// ---------------------------------------------------------------------------
console.log('\n4) Evidence pointers — every derived claim is attributed');
t('evidence pointers list is non-empty when real source files exist, and each Current-state item carries one', () => {
  const root = freshRoot('snap-evidence');
  writeMemory(root, '# Forge Memory\n\n## Status update X\n- something\n');
  writeEvents(root, 'run-d', [ev({ event_type: 'subagent_completed', agent: 'Build Boss', note: 'did the work' })]);
  const r = snap.write({ root, reason: 'manual', now: new Date(), runId: 'run-d' });
  assert.ok(r.evidencePointers.length > 0);
  assert.ok(r.markdown.includes('_(evidence: .claude/forge-runs/run-d/events.jsonl'));
});

// ---------------------------------------------------------------------------
console.log('\n5) Size budget / truncation');
t('an oversized decisions section gets truncated with an explicit marker', () => {
  const root = freshRoot('snap-truncate');
  // write() only ever keeps the LAST 5 decision rows (extractDecisions(..., 5)) — so truncation must be
  // forced via per-row LENGTH (a single very long decision line), not row COUNT.
  const longText = 'a very long decision rationale that keeps going and going and going '.repeat(20);
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push('| 2026-01-0' + (i + 1) + ' | decision ' + i + ': ' + longText + ' |');
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_DECISIONS.md'), '# Forge Decisions Log\n\n| Date | Decision |\n|---|---|\n' + rows.join('\n') + '\n');
  const r = snap.write({ root, reason: 'manual', now: new Date() });
  assert.ok(r.markdown.includes('(truncated — see'), 'expected a truncation marker for the oversized Key decisions section');
});

t('truncateSection leaves short text untouched', () => {
  assert.strictEqual(snap.truncateSection('short text', 'some/path', 900), 'short text');
});

// ---------------------------------------------------------------------------
console.log('\n6) Pure parsers (extractDecisions / openFromTodoGraph / openFromWorkPackages)');
t('extractDecisions returns the LAST n rows in document order (append-only convention)', () => {
  const text = '# Log\n\n| Date | Decision |\n|---|---|\n| 2026-01-01 | first |\n| 2026-01-02 | second |\n| 2026-01-03 | third |\n';
  const rows = snap.extractDecisions(text, 2);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].text, 'second');
  assert.strictEqual(rows[1].text, 'third');
});

t('openFromTodoGraph excludes COMPLETED rows and caps at the requested count', () => {
  const text = [
    '| WP | Task | Title | Owner | Deps | Status |',
    '|---|---|---|---|---|---|',
    '| WP1 | T1 | Title one | Lead | — | COMPLETED (done) |',
    '| WP2 | T2 | Title two | Lead | WP1 | BACKLOG |',
    '| WP3 | T3 | Title three | Lead | WP2 | SELF REVIEW |',
  ].join('\n');
  const out = snap.openFromTodoGraph(text, 'x/TODO_GRAPH.md', 5);
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((o) => !/COMPLETED/.test(o.detail)));
  assert.ok(out[0].label.includes('WP2'));
});

t('openFromWorkPackages reads WP-ID/Status lines from the LAST heading block only', () => {
  const text = [
    '# Work Packages',
    '',
    '## 2026-07-01 — old mission',
    'WP-ID: old1 · text · Status: BACKLOG',
    '',
    '## 2026-07-02 — latest mission',
    'WP-ID: wp1 · text · Status: DONE',
    'WP-ID: wp2 · text · Status: DOING',
  ].join('\n');
  const out = snap.openFromWorkPackages(text, 'tasks/WORK_PACKAGES.md', 5);
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].label.includes('wp2'));
  assert.ok(!out.some((o) => o.label.includes('old1')), 'must only read the LAST (latest) heading block');
});

// ---------------------------------------------------------------------------
console.log('\n7) check() staleness probe');
t('check() reports MISSING when FORGE_SNAPSHOT.md does not exist', () => {
  const root = freshRoot('snap-check-missing');
  const r = snap.check({ root });
  assert.strictEqual(r.exists, false);
  assert.strictEqual(r.stale, true);
});

t('check() reports fresh right after a write()', () => {
  const root = freshRoot('snap-check-fresh');
  snap.write({ root, reason: 'manual' });
  const r = snap.check({ root, maxAgeHours: 24 });
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.stale, false);
});

t('check() reports stale when the file is older than maxAgeHours', () => {
  const root = freshRoot('snap-check-stale');
  const r0 = snap.write({ root, reason: 'manual' });
  const old = Date.now() - 25 * 3600000;
  fs.utimesSync(r0.path, old / 1000, old / 1000);
  const r = snap.check({ root, maxAgeHours: 24 });
  assert.strictEqual(r.stale, true);
  assert.ok(r.ageHours >= 24);
});

// ---------------------------------------------------------------------------
console.log('\n8) Honesty footer — unknown/missing sources are named, never silently omitted');
t('honesty footer lists expected-but-missing core sources honestly', () => {
  const root = freshRoot('snap-honesty');
  const r = snap.write({ root, reason: 'manual' });
  assert.ok(r.markdown.includes('Sources unknown/missing'));
  assert.ok(r.markdown.includes('FORGE_TASK_HISTORY.md'));
});

// ---------------------------------------------------------------------------
console.log('\n9) git handling — never throws outside a repo');
t('gitInfo() on a non-repo directory returns available:false without throwing', () => {
  const root = freshRoot('snap-notgit');
  const info = snap.gitInfo(root, { timeoutMs: 2000 });
  assert.strictEqual(info.available, false);
});

// ---------------------------------------------------------------------------
console.log('\n10) CLI (real spawned subprocess)');
const CLI = path.join(__dirname, 'forge-snapshot.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

t('CLI write --json exits 0 and prints parseable JSON with path/runId/approxTokens', () => {
  const root = freshRoot('snap-cli-write');
  const r = runCLI(['write', '--root', root, '--reason', 'manual', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.path.endsWith('FORGE_SNAPSHOT.md'));
  assert.ok(Number.isFinite(parsed.approxTokens));
});

t('CLI check exits 3 when FORGE_SNAPSHOT.md is missing', () => {
  const root = freshRoot('snap-cli-check-missing');
  const r = runCLI(['check', '--root', root, '--json']);
  assert.strictEqual(r.status, 3);
});

t('CLI write with an invalid --reason exits 2', () => {
  const root = freshRoot('snap-cli-badreason');
  const r = runCLI(['write', '--root', root, '--reason', 'bogus']);
  assert.strictEqual(r.status, 2);
});

t('CLI with no command exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

// ---------------------------------------------------------------------------
// 11) RUN SELECTION — the whole point of the snapshot is that a resuming session sees the REAL work.
// Real defect measured 2026-07-31 on this project's own .claude/FORGE_SNAPSHOT.md: it named
// `.claude/forge-runs/doctor-selfcheck-2480/` as "latest run" and rendered "_No done-type events found in
// the latest run._" while 30 other run dirs held a night of real work. Cause: the picker asked only "which
// run directory was touched most recently" (forge-doctor.cjs::latestRunIdFor) and never asked "does that run
// contain anything this snapshot can actually show". forge-doctor.cjs::strictEventCheck writes exactly such
// a run on EVERY doctor invocation — `doctor-selfcheck-<pid>/events.jsonl` with a single `agent_progress`
// event and no run.json — and its rmSync cleanup can lose the race on Windows, so this recurs by design.
console.log('\n11) Run selection — newest run that actually contains renderable work');

/** writeRunAt — a run dir with a deterministic mtime on every file AND the dir itself, because the ranking
 *  core (forge-doctor.cjs::rankRunCandidates) takes the MAX of events.jsonl / run.json / dir mtimes. */
function writeRunAt(root, runId, lines, mtimeIso, opts) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (opts && opts.runJson) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(opts.runJson));
  const secs = new Date(mtimeIso).getTime() / 1000;
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), secs, secs);
  fs.utimesSync(dir, secs, secs);
}

t('DEFECT repro: picks the older run WITH work over a NEWER doctor-selfcheck run that only logged agent_progress', () => {
  const root = freshRoot('snap-pick-work');
  writeRunAt(root, 'forge-2026-07-30-realwork', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'ship the thing' }),
    ev({ event_type: 'subagent_completed', agent: 'Build Boss', role: 'impl', note: 'REAL-WORK-SENTINEL delivered' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: '26/26 green' }),
  ], '2026-07-30T10:00:00Z');
  // byte-shape copied from this repo's real .claude/forge-runs/doctor-selfcheck-2480/events.jsonl
  writeRunAt(root, 'doctor-selfcheck-9999', [
    ev({ event_type: 'agent_progress', agent: 'orchestrator', note: 'doctor self-check' }),
  ], '2026-07-31T17:28:22Z'); // strictly NEWER by mtime, so the name tie-break can never decide this test
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.strictEqual(r.runId, 'forge-2026-07-30-realwork');
  assert.ok(r.markdown.includes('REAL-WORK-SENTINEL'), 'Done must show the real run\'s work');
  assert.ok(!/_No done-type events found/.test(r.markdown), 'the empty-Done placeholder must be gone');
});

t('the rule is CONTENT-based, not name-based: a newer plainly-named run carrying only unrenderable events is skipped too, and a work run WITHOUT run.json still wins', () => {
  const root = freshRoot('snap-pick-content');
  // no run.json at all — matches this repo's real newest work runs (07-26/07-27/07-30/07-31 have none)
  writeRunAt(root, 'forge-2026-07-30-realwork', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'NO-RUNJSON-SENTINEL green' }),
  ], '2026-07-30T10:00:00Z');
  // newer, ordinary forge-* name, and it even HAS a run.json — but nothing section 3 can render.
  // (2026-08-01: the filler here used to be `doctor_run`. After the render-set breadth fix a doctor receipt
  // is real, renderable work, so this fixture now uses types section 3 genuinely renders nowhere — the
  // test's point was always the CONTENT rule, never which particular type happened to be unrenderable.)
  writeRunAt(root, 'forge-2026-07-31-receipt', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'receipt only' }),
    ev({ event_type: 'memory_loaded', agent: 'orchestrator', files_read: ['FORGE_MEMORY.md'] }),
    ev({ event_type: 'agent_note', agent: 'orchestrator', note: 'just a note' }),
  ], '2026-07-31T20:00:00Z', { runJson: { run_id: 'forge-2026-07-31-receipt' } });
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.strictEqual(r.runId, 'forge-2026-07-30-realwork');
  assert.ok(r.markdown.includes('NO-RUNJSON-SENTINEL'));
});

t('a run whose only work is an unresolved subagent_started counts as work (in-progress is real state)', () => {
  const root = freshRoot('snap-pick-inprogress');
  writeRunAt(root, 'forge-2026-07-30-dispatched', [
    ev({ event_type: 'subagent_started', agent: 'Build Boss', role: 'impl', dispatch_id: 'd9', task: 'IN-FLIGHT-SENTINEL' }),
  ], '2026-07-30T10:00:00Z');
  writeRunAt(root, 'doctor-selfcheck-8888', [
    ev({ event_type: 'agent_progress', agent: 'orchestrator', note: 'doctor self-check' }),
  ], '2026-07-31T17:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.strictEqual(r.runId, 'forge-2026-07-30-dispatched');
  assert.ok(r.markdown.includes('IN-FLIGHT-SENTINEL'));
});

t('honest fallback: when NO run has work, no run is silently picked — runId is null and every considered run is named', () => {
  const root = freshRoot('snap-pick-nowork');
  writeRunAt(root, 'doctor-selfcheck-7777', [
    ev({ event_type: 'agent_progress', agent: 'orchestrator', note: 'doctor self-check' }),
  ], '2026-07-31T17:00:00Z');
  writeRunAt(root, 'forge-2026-07-22-receipt', [
    ev({ event_type: 'cost_sampled', agent: 'orchestrator', tokens: 15400, cost: 0.21 }),
  ], '2026-07-22T00:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.strictEqual(r.runId, null, 'must not fall back to "the first one it finds"');
  assert.ok(/no run with real work/i.test(r.markdown), 'the file must SAY there is no run with work');
  assert.ok(r.markdown.includes('doctor-selfcheck-7777'), 'considered runs must be named');
  assert.ok(r.markdown.includes('forge-2026-07-22-receipt'), 'considered runs must be named');
});

t('an explicit runId (CLI --run) still wins over the work-based picker', () => {
  const root = freshRoot('snap-pick-explicit');
  writeRunAt(root, 'forge-2026-07-30-realwork', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'other run green' }),
  ], '2026-07-30T10:00:00Z');
  writeRunAt(root, 'doctor-selfcheck-6666', [
    ev({ event_type: 'agent_progress', agent: 'orchestrator', note: 'doctor self-check' }),
  ], '2026-07-31T17:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z'), runId: 'doctor-selfcheck-6666' });
  assert.strictEqual(r.runId, 'doctor-selfcheck-6666');
});

t('pickRun() work criterion is DERIVED from the section-3 render sets, so it can never drift from what the file shows', () => {
  // Every type section 3 renders must qualify a run, EXCEPT the explicitly-declared administrative ones
  // (W5, 2026-08-01 — see ADMINISTRATIVE_EVENT_TYPES: `run_completed` is still rendered in Done but a
  // sweep-written one must not, on its own, make a dead run "the newest work run").
  // The second block is the 2026-08-01 breadth fix: before it, these real progress signals rendered
  // nothing and a run full of them counted 0.
  for (const ty of ['wp_completed', 'check_passed', 'subagent_completed', 'quality_gate_passed', 'fix_completed',
    'final_output_created', 'merge_completed', 'retest_completed', 'check_failed', 'quality_gate_blocked',
    'rework_task_created', 'subagent_failed', 'subagent_started',
    'agent_completed', 'rework_completed', 'lead_review_completed', 'codex_review_completed',
    'dashboard_health_verified', 'report_generated', 'prd_generated', 'artifact_stored', 'research_done',
    'audit_finding', 'codex_finding', 'agent_started', 'fix_started', 'check_started',
    'rework_assigned', 'doctor_run', 'ticket_created', 'ticket_updated']) {
    assert.ok(snap.WORK_EVENT_TYPES.has(ty), ty + ' renders in section 3 but is not a work event');
    assert.ok(!snap.ADMINISTRATIVE_EVENT_TYPES.has(ty), ty + ' is real work and must not be declared administrative');
  }
  // the derivation itself: WORK = (everything section 3 renders) minus (the declared administrative types)
  const rendered = new Set([...snap.DONE_EVENT_TYPES, ...snap.GAP_EVENT_TYPES, ...snap.IN_PROGRESS_EVENT_TYPES, ...snap.OUTCOME_EVENT_TYPES]);
  for (const ty of rendered) {
    assert.strictEqual(snap.WORK_EVENT_TYPES.has(ty), !snap.ADMINISTRATIVE_EVENT_TYPES.has(ty),
      ty + ' must qualify a run unless it is declared administrative');
  }
  for (const ty of snap.ADMINISTRATIVE_EVENT_TYPES) {
    assert.ok(rendered.has(ty), ty + ' is declared administrative but renders nowhere — it would be dead config');
  }
  // ...and nothing else may qualify one. These are the real types this repo logs that section 3 deliberately
  // renders nowhere (bookkeeping/telemetry, or rendered by a DIFFERENT section) — `agent_progress` above all,
  // because forge-doctor.cjs's self-check writes exactly that and re-counting it would reopen defect #1.
  for (const ty of ['agent_progress', 'agent_note', 'run_started', 'file_changed', 'memory_updated',
    'memory_loaded', 'owner_prefs_loaded', 'cost_sampled', 'command_run', 'skill_loaded', 'custom_skill_used',
    'decision_logged', 'project_scanned', 'agent_selected', 'role_map_created', 'mission_blueprint_created',
    'mindmap_generated', 'agent_work_package_created', 'audit_iteration', 'claude_md_updated',
    'browser_screenshot_captured', 'codex_review_started']) {
    assert.ok(!snap.WORK_EVENT_TYPES.has(ty), ty + ' renders nothing in section 3 and must not qualify a run');
  }
});

// Same defect class as the run picker, same file: section 2 read only `task`/`note` off run_started, but
// the two most recent real runs in this repo (07-30-discord, 07-31-ultieme-forge) put the mission text in
// `detail` — so section 2 printed "No run_started task text found" with the text sitting right there.
t('section 2 (Why) reads a run_started whose mission text is in `detail` (the field the newest real runs use)', () => {
  const root = freshRoot('snap-why-detail');
  writeRunAt(root, 'forge-2026-07-31-detailonly', [
    ev({ event_type: 'run_started', agent: 'orchestrator', role: 'lead', detail: 'WHY-DETAIL-SENTINEL: the real mission text' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'green' }),
  ], '2026-07-31T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.ok(r.markdown.includes('WHY-DETAIL-SENTINEL'));
  assert.ok(!/No run_started task text found/.test(r.markdown));
});

t('section 2 still prefers `task` over the other run_started text fields when several are present', () => {
  const root = freshRoot('snap-why-order');
  writeRunAt(root, 'forge-2026-07-31-allfields', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'TASK-WINS', note: 'note-loses', detail: 'detail-loses' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'green' }),
  ], '2026-07-31T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  // (2026-08-01: this used to assert section 2 STARTS with the bare mission text. Section 2 now leads with
  // the run attribution — see section 13 — so the assertion tests the same thing it always meant: of the
  // three candidate fields, `task` is the one quoted.)
  assert.ok(r.markdown.includes('TASK-WINS'), 'section 2 must quote the task text');
  assert.ok(!r.markdown.includes('note-loses') && !r.markdown.includes('detail-loses'), '`task` must win over `note`/`detail`');
});

t('pickRun() on a project with no forge-runs directory at all is honest, not an error', () => {
  const root = freshRoot('snap-pick-noruns');
  const sel = snap.pickRun(root, null);
  assert.strictEqual(sel.runId, null);
  assert.strictEqual(sel.considered.length, 0);
  assert.ok(/no run direct/i.test(sel.selection));
});

// ---------------------------------------------------------------------------
// 12) RENDER-SET BREADTH — second defect, found by an independent witness on 2026-08-01 and reproduced
// below with the REAL events of this repo's `.claude/forge-runs/forge-2026-07-10-mc-checkup/`.
//
// The picker's criterion is derived from what section 3 can render, which is right — but the render set
// itself was too NARROW: it knew only the subagent/check/fix/merge/retest family. A run that wrote a PRD,
// opened three tickets, stored a report artifact, ran an ALL-GREEN doctor and then closed all three tickets
// with test evidence counted as ZERO work events and was skipped. Worse, the generated file then labelled
// such a run "skipped as work-less (self-test / receipt-only)" — a category the code never establishes
// anywhere, i.e. a fabricated claim in a file whose own footer promises evidence-backed honesty.
console.log('\n12) Render-set breadth — real progress signals count as work AND are shown');

/** MC_CHECKUP_REAL_EVENTS — the 15 lines of this repo's real
 *  `.claude/forge-runs/forge-2026-07-10-mc-checkup/events.jsonl`, copied VERBATIM as raw JSONL strings on
 *  2026-08-01, so the fixture is byte-faithful to the witness's measurement while this file stays hermetic
 *  (it still never reads the repo's real forge-runs/, per the header rule). */
const MC_CHECKUP_REAL_EVENTS = [
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"run_started\",\"agent\":\"orchestrator\",\"note\":\"MC Phase 2 checkup run\",\"timestamp\":\"2026-07-10T11:15:21.112Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"prd_generated\",\"agent\":\"orchestrator\",\"note\":\"PRD generated: Mission Control Phase 2\",\"prd_id\":\"prd-mc-phase2\",\"timestamp\":\"2026-07-10T11:15:21.187Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"ticket_created\",\"agent\":\"orchestrator\",\"note\":\"Ticket created from acceptance criterion\",\"ticket_id\":\"tk-prd-mc-phase2-1\",\"prd_id\":\"prd-mc-phase2\",\"timestamp\":\"2026-07-10T11:15:21.219Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"ticket_created\",\"agent\":\"orchestrator\",\"note\":\"Ticket created from acceptance criterion\",\"ticket_id\":\"tk-prd-mc-phase2-2\",\"prd_id\":\"prd-mc-phase2\",\"timestamp\":\"2026-07-10T11:15:21.251Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"ticket_created\",\"agent\":\"orchestrator\",\"note\":\"Ticket created from acceptance criterion\",\"ticket_id\":\"tk-prd-mc-phase2-3\",\"prd_id\":\"prd-mc-phase2\",\"timestamp\":\"2026-07-10T11:15:21.280Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"mindmap_generated\",\"agent\":\"orchestrator\",\"note\":\"Mind map generated: Mission Control\",\"map_id\":\"mm-mc-phase2\",\"timestamp\":\"2026-07-10T11:15:21.366Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"artifact_stored\",\"agent\":\"report-writer\",\"artifact_id\":\"art-mc-report\",\"kind\":\"report\",\"title\":\"Phase 2 final report\",\"timestamp\":\"2026-07-10T11:15:21.457Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"cost_sampled\",\"agent\":\"orchestrator\",\"role\":\"orchestrator\",\"tokens\":15400,\"cost\":0.21,\"model\":\"claude-opus-4-8\",\"timestamp\":\"2026-07-10T11:15:21.550Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"doctor_run\",\"agent\":\"reviewer\",\"note\":\"forge-doctor ALL GREEN\",\"ok\":true,\"timestamp\":\"2026-07-10T11:15:24.243Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"ticket_updated\",\"agent\":\"orchestrator\",\"ticket_id\":\"tk-prd-mc-phase2-1\",\"note\":\"verify-loop: still open at verification\",\"timestamp\":\"2026-07-10T17:24:02.039Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"ticket_updated\",\"agent\":\"orchestrator\",\"ticket_id\":\"tk-prd-mc-phase2-2\",\"note\":\"verify-loop: still open at verification\",\"timestamp\":\"2026-07-10T17:24:02.072Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"ticket_updated\",\"agent\":\"orchestrator\",\"ticket_id\":\"tk-prd-mc-phase2-3\",\"note\":\"verify-loop: still open at verification\",\"timestamp\":\"2026-07-10T17:24:02.105Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"ticket_updated\",\"agent\":\"orchestrator\",\"ticket_id\":\"tk-prd-mc-phase2-1\",\"note\":\"closed with test_evidence (verify-loop test-first rule)\",\"timestamp\":\"2026-07-10T17:34:18.503Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"ticket_updated\",\"agent\":\"orchestrator\",\"ticket_id\":\"tk-prd-mc-phase2-2\",\"note\":\"closed with test_evidence (verify-loop test-first rule)\",\"timestamp\":\"2026-07-10T17:34:18.545Z\"}",
  "{\"run_id\":\"forge-2026-07-10-mc-checkup\",\"event_type\":\"ticket_updated\",\"agent\":\"orchestrator\",\"ticket_id\":\"tk-prd-mc-phase2-3\",\"note\":\"closed with test_evidence (verify-loop test-first rule)\",\"timestamp\":\"2026-07-10T17:34:18.585Z\"}",
];

/** writeRawRunAt — like writeRunAt but takes raw JSONL lines, so a real events.jsonl can be reproduced
 *  byte-for-byte instead of being re-serialised through JSON.stringify. */
function writeRawRunAt(root, runId, rawLines, mtimeIso) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), rawLines.join('\n') + '\n');
  const secs = new Date(mtimeIso).getTime() / 1000;
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), secs, secs);
  fs.utimesSync(dir, secs, secs);
}

t('WITNESS REPRO: the REAL mc-checkup events (PRD + 3 tickets + doctor ALL GREEN + 3 tickets closed with test evidence) count as work and are NOT skipped', () => {
  const root = freshRoot('snap-mc-real');
  // the witness's exact move: the real run's events, replayed under a NEWER throwaway run id
  writeRawRunAt(root, 'forge-2026-07-31-mc-replay', MC_CHECKUP_REAL_EVENTS, '2026-07-31T22:00:00Z');
  // FIXTURE FIX 2026-08-01 (W1a): this comparison run carried `ev()`'s default timestamp 2026-07-29, which
  // is NEWER than the mc-checkup replay's own real event times (its last work event is
  // 2026-07-10T17:34:18.585Z — the replayed lines keep their ORIGINAL timestamps, which is the whole point
  // of ranking on them). Harmless while ranking used file mtime; self-contradicting once it uses the events.
  // The run is meant to be the older one, so it is now dated — name, mtime and event alike — before that.
  // The test's subject is unchanged: the mc-checkup event FAMILY must count as work and be rendered.
  writeRunAt(root, 'forge-2026-07-05-older', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'OLDER-RUN-SENTINEL green', timestamp: '2026-07-05T10:00:00.000Z' }),
  ], '2026-07-05T10:00:00Z');
  const sel = snap.pickRun(root, null);
  assert.strictEqual(sel.runId, 'forge-2026-07-31-mc-replay', 'a run with a PRD, tickets and an ALL-GREEN doctor must not count as zero-work');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.ok(!r.markdown.includes('OLDER-RUN-SENTINEL'), 'section 3 must report the newest working run, not the older one');
  assert.ok(r.markdown.includes('PRD generated: Mission Control Phase 2'), 'the PRD must be shown');
  assert.ok(r.markdown.includes('forge-doctor ALL GREEN'), 'the doctor receipt must be shown');
  assert.ok(r.markdown.includes('Phase 2 final report'), 'the stored report artifact must be shown');
  assert.ok(r.markdown.includes('tk-prd-mc-phase2-3'), 'the tickets must be shown');
  assert.ok(r.markdown.includes('closed with test_evidence'), 'the closing test evidence must be shown');
});

t('the skip label states the MEASURED fact and never the invented "self-test / receipt-only" category', () => {
  const root = freshRoot('snap-skip-label');
  writeRunAt(root, 'forge-2026-07-30-realwork', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'green' }),
  ], '2026-07-30T10:00:00Z');
  writeRunAt(root, 'doctor-selfcheck-9999', [
    ev({ event_type: 'agent_progress', agent: 'orchestrator', note: 'doctor self-check' }),
  ], '2026-07-31T17:28:22Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.ok(!/self-test/i.test(r.markdown), 'must not assert a "self-test" category the code never establishes');
  assert.ok(!/receipt-only/i.test(r.markdown), 'must not assert a "receipt-only" category the code never establishes');
  assert.ok(r.markdown.includes('logged no event of a type section 3 renders'), 'must state what was actually measured');
  assert.ok(r.markdown.includes('doctor-selfcheck-9999 (0 renderable work events)'), 'must name the skipped run WITH its measured count');
});

t('a FAILING doctor_run is a gap, never a "Done" item', () => {
  const root = freshRoot('snap-doctor-fail');
  writeRunAt(root, 'forge-2026-07-30-redoctor', [
    ev({ event_type: 'doctor_run', agent: 'reviewer', ok: false, note: 'DOCTOR-RED-SENTINEL 3 suites failing' }),
  ], '2026-07-30T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.strictEqual(r.runId, 'forge-2026-07-30-redoctor', 'a doctor run is real work either way');
  const done = r.markdown.split('### Done')[1].split('### In progress')[0];
  assert.ok(!done.includes('DOCTOR-RED-SENTINEL'), 'a failed doctor run must not be listed under Done');
  assert.ok(/## 7\. Known gaps[\s\S]*DOCTOR-RED-SENTINEL/.test(r.markdown), 'a failed doctor run belongs in Known gaps');
});

t('ticket lifecycle: a ticket whose last update closes it is Done, a ticket still open is In progress', () => {
  const root = freshRoot('snap-tickets');
  writeRunAt(root, 'forge-2026-07-30-tickets', [
    ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-1', note: 'from acceptance criterion' }),
    ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-2', note: 'from acceptance criterion' }),
    ev({ event_type: 'ticket_updated', agent: 'orchestrator', ticket_id: 'tk-1', note: 'CLOSED-SENTINEL closed with test_evidence' }),
    ev({ event_type: 'ticket_updated', agent: 'orchestrator', ticket_id: 'tk-2', note: 'OPEN-SENTINEL still open at verification' }),
  ], '2026-07-30T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  const done = r.markdown.split('### Done')[1].split('### In progress')[0];
  const inprog = r.markdown.split('### In progress')[1].split('### Open')[0];
  assert.ok(done.includes('CLOSED-SENTINEL'), 'a closed ticket belongs in Done');
  assert.ok(!done.includes('OPEN-SENTINEL'), 'an open ticket must not be reported as Done');
  assert.ok(inprog.includes('OPEN-SENTINEL'), 'an open ticket belongs in In progress');
  assert.ok(inprog.includes('tk-2'), 'the ticket id is the identity, so it must be shown');
});

t('the new started/completed families pair up: a fix/check/rework/agent that finished is not left "In progress"', () => {
  const root = freshRoot('snap-lifecycles');
  writeRunAt(root, 'forge-2026-07-30-lifecycle', [
    ev({ event_type: 'fix_started', agent: 'build-boss', note: 'FIX-DONE-SENTINEL' }),
    ev({ event_type: 'fix_completed', agent: 'build-boss', note: 'fix landed' }),
    ev({ event_type: 'check_started', agent: 'test-boss', task: 'CHECK-DONE-SENTINEL' }),
    ev({ event_type: 'check_passed', agent: 'test-boss', task: 'suite green' }),
    ev({ event_type: 'check_started', agent: 'seo-boss', task: 'CHECK-OPEN-SENTINEL' }),
    ev({ event_type: 'rework_assigned', agent: 'orchestrator', to: 'Build Boss' }),
    ev({ event_type: 'rework_completed', agent: 'Build Boss', role: 'builder', note: 'REWORK-DONE-SENTINEL' }),
    ev({ event_type: 'agent_started', agent: 'Search Boss', task: 'AGENT-OPEN-SENTINEL' }),
  ], '2026-07-30T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  const inprog = r.markdown.split('### In progress')[1].split('### Open')[0];
  assert.ok(!inprog.includes('FIX-DONE-SENTINEL'), 'a fix_started answered by fix_completed is not in progress');
  assert.ok(!inprog.includes('CHECK-DONE-SENTINEL'), 'a check_started answered by check_passed is not in progress');
  assert.ok(!inprog.includes('rework'), 'a rework_assigned answered by rework_completed (logged by the ASSIGNEE) is not in progress');
  assert.ok(inprog.includes('CHECK-OPEN-SENTINEL'), 'an unanswered check_started IS in progress');
  assert.ok(inprog.includes('AGENT-OPEN-SENTINEL'), 'an unanswered agent_started IS in progress');
  assert.ok(r.markdown.includes('REWORK-DONE-SENTINEL'), 'the completed rework is real Done work');
});

t('renderable events with no `note` still render their real text (run_completed/report_generated use `task`, artifact_stored uses `title`)', () => {
  const root = freshRoot('snap-detailfields');
  writeRunAt(root, 'forge-2026-07-30-fields', [
    ev({ event_type: 'run_completed', task: 'TASK-FIELD-SENTINEL upgrade complete', status: 'done' }),
    ev({ event_type: 'artifact_stored', agent: 'report-writer', kind: 'report', title: 'TITLE-FIELD-SENTINEL' }),
    ev({ event_type: 'quality_gate_blocked', agent: 'Test Boss', decision_summary: 'SUMMARY-FIELD-SENTINEL one blocker' }),
  ], '2026-07-30T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.ok(r.markdown.includes('TASK-FIELD-SENTINEL'));
  assert.ok(r.markdown.includes('TITLE-FIELD-SENTINEL'));
  assert.ok(r.markdown.includes('SUMMARY-FIELD-SENTINEL'));
  assert.ok(!/no additional detail logged/.test(r.markdown), 'text that IS present must never be reported as absent');
});

// ---------------------------------------------------------------------------
// 13) SECTION 2 ATTRIBUTION — a regression the run-picker fix itself introduced, found by the same witness.
// Once the picker started skipping the newest run, section 2 silently followed the SELECTED run: it printed
// the mission of an older run with no attribution whatsoever (grepping the generated file for "run_started"
// returned zero hits), so a resuming session read a mission belonging to a different run and had no pointer,
// caveat or run id to notice with. The pre-fix code showed the right mission there, so this was a true
// regression. Hard rule now: never show a mission without saying which run it is from.
console.log('\n13) Section 2 (Why) — no mission is ever shown without naming its run');

/** sectionOf — the body of `## <n>. ...` up to the next `## ` heading. */
function sectionOf(md, n) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ' + n + '.'));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { if (lines[i].startsWith('## ')) { end = i; break; } }
  return lines.slice(start + 1, end).join('\n');
}

t('when the newest run is skipped, section 2 names the run its mission came from (the witness grep for "run_started" must hit)', () => {
  const root = freshRoot('snap-why-attrib');
  writeRunAt(root, 'forge-2026-07-28-thework', [
    ev({ event_type: 'run_started', agent: 'orchestrator', note: 'WHY-SOURCE-SENTINEL build the thing' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'green' }),
  ], '2026-07-28T10:00:00Z');
  writeRunAt(root, 'forge-2026-07-31-nothing', [
    ev({ event_type: 'memory_loaded', agent: 'orchestrator', files_read: ['FORGE_MEMORY.md'] }),
  ], '2026-07-31T20:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  const why = sectionOf(r.markdown, 2);
  assert.ok(why.includes('WHY-SOURCE-SENTINEL'), 'the mission itself must still be shown');
  assert.ok(why.includes('forge-2026-07-28-thework'), 'section 2 MUST name the run the mission belongs to');
  assert.ok(why.includes('run_started'), 'section 2 MUST cite the event the mission was read from');
  assert.ok(/_\(evidence: \.claude\/forge-runs\/forge-2026-07-28-thework\/events\.jsonl \[run_started\]\)_/.test(why),
    'section 2 MUST carry a real evidence pointer, like every other derived claim in this file');
});

t('WITNESS SCENARIO: when a NEWER run recorded a different mission but was skipped, section 2 says so and quotes BOTH, each named', () => {
  const root = freshRoot('snap-why-divergent');
  writeRunAt(root, 'forge-2026-07-28-thework', [
    ev({ event_type: 'run_started', agent: 'orchestrator', note: 'OLD-MISSION-SENTINEL finish the dashboard' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'green' }),
  ], '2026-07-28T10:00:00Z');
  // a run that JUST started: it logged its mission and nothing renderable yet — exactly when the two diverge
  writeRunAt(root, 'forge-2026-07-31-juststarted', [
    ev({ event_type: 'run_started', agent: 'orchestrator', detail: 'NEW-MISSION-SENTINEL migrate the gateway' }),
  ], '2026-07-31T20:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  const why = sectionOf(r.markdown, 2);
  assert.ok(why.includes('OLD-MISSION-SENTINEL') && why.includes('forge-2026-07-28-thework'),
    'the source run\'s mission must be shown AND named');
  assert.ok(why.includes('NEW-MISSION-SENTINEL') && why.includes('forge-2026-07-31-juststarted'),
    'the newer run\'s mission must not be silently dropped — it must be shown AND named');
  assert.ok(/NEWER run/i.test(why), 'section 2 must SAY that the second mission belongs to a newer, non-source run');
  assert.ok(why.indexOf('forge-2026-07-28-thework') < why.indexOf('NEW-MISSION-SENTINEL'),
    'the source run (the one section 3 reports on) must lead, so sections 2 and 3 describe the same run');
});

t('when the source run has NO mission text, section 2 still names the run it checked', () => {
  const root = freshRoot('snap-why-nomission');
  writeRunAt(root, 'forge-2026-07-30-silent', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'green, but this run never logged run_started' }),
  ], '2026-07-30T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  const why = sectionOf(r.markdown, 2);
  assert.ok(why.includes('forge-2026-07-30-silent'), 'an absence must be attributed too: say WHICH run was checked');
  assert.ok(/no `run_started` mission text found/i.test(why));
});

t('when NO run qualifies at all, a mission found in a considered run is still shown — named, and flagged as not section 3\'s source', () => {
  const root = freshRoot('snap-why-norun');
  writeRunAt(root, 'forge-2026-07-31-onlystart', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'ORPHAN-MISSION-SENTINEL' }),
    ev({ event_type: 'agent_progress', agent: 'orchestrator', note: 'nothing renderable' }),
  ], '2026-07-31T20:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T00:00:00Z') });
  assert.strictEqual(r.runId, null);
  const why = sectionOf(r.markdown, 2);
  assert.ok(why.includes('ORPHAN-MISSION-SENTINEL'), 'the only mission text there is must not be thrown away');
  assert.ok(why.includes('forge-2026-07-31-onlystart'), 'and it must be attributed to its run');
  assert.ok(/not section 3's source/i.test(why), 'and flagged as not being what section 3 reports on');
});

// ---------------------------------------------------------------------------
// 14) W1-W5 — five weaknesses measured by an independent witness on 2026-08-01, W1 additionally verified
// LIVE on this project by the owner agent before any code was written. Each test below states the exact
// measurement it locks down; each failed for its own reason before the corresponding fix landed.
console.log('\n14) W1-W5 — witness-measured weaknesses (ranking, ticket negation, ticket crowding, concurrency)');

/** writeRunMetaAt — writeRunAt plus a run.json, with the SAME deterministic mtime stamping applied after
 *  both files exist (writeRunAt's own utimes pass runs before run.json is written when the caller uses its
 *  opts.runJson, which is fine, but these fixtures re-stamp explicitly so the intent is unmissable). */
function writeRunMetaAt(root, runId, lines, mtimeIso, runJson) {
  writeRunAt(root, runId, lines, mtimeIso, { runJson });
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  const secs = new Date(mtimeIso).getTime() / 1000;
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), secs, secs);
  fs.utimesSync(dir, secs, secs);
}

// --- W1(a) RANKING -----------------------------------------------------------------------------------
// LIVE MEASUREMENT (owner agent, this project, 2026-08-01): the picker ranked by forge-doctor.cjs::
// rankRunCandidates, i.e. by the MAX of events.jsonl / run.json / directory mtime. In the night of
// 2026-08-01 a ledger reconciliation appended a `decision_logged` event to 13 old July runs, restamping
// every one of them to ~01:21:50Z — so thirteen runs from 10-15 July became "the newest" and the snapshot
// reported one of them. File mtime is metadata any tool can disturb; it is not evidence of work.
t('W1a: "newest" is the time of the last REAL WORK event, so an administrative touch cannot reorder history', () => {
  const root = freshRoot('snap-w1-rank');
  // the genuinely current run: its work happened on 07-31 and nothing has touched its files since
  writeRunAt(root, 'forge-2026-07-31-realwork', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'W1-CURRENT-MISSION', timestamp: '2026-07-31T09:00:00.000Z' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'W1-REALWORK-SENTINEL 26/26 green', timestamp: '2026-07-31T10:00:00.000Z' }),
  ], '2026-07-31T10:00:00Z');
  // an old July run whose work stopped on 07-10 — then last night's ledger reconciliation appended a
  // `decision_logged` event, making its events.jsonl the newest file on disk. Byte-shape of the appended
  // event copied from this repo's real reconciliation events.
  writeRunAt(root, 'forge-2026-07-10-old', [
    ev({ event_type: 'check_passed', agent: 'Docs Boss', note: 'W1-OLDWORK-SENTINEL', timestamp: '2026-07-10T12:00:00.000Z' }),
    ev({ event_type: 'decision_logged', agent: 'orchestrator', note: 'status reconciliation 2026-08-01', timestamp: '2026-08-01T01:21:50.000Z' }),
  ], '2026-08-01T01:21:50Z');
  const sel = snap.pickRun(root, null);
  assert.strictEqual(sel.runId, 'forge-2026-07-31-realwork', 'a reconciliation touch must not promote a July run to "newest"');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  assert.ok(r.markdown.includes('W1-REALWORK-SENTINEL'));
  assert.ok(!r.markdown.includes('W1-OLDWORK-SENTINEL'), 'the restamped old run must not be what section 3 reports on');
});

t('W1a: ranking states the work-event time it ranked on, so the ordering is checkable from the file itself', () => {
  const root = freshRoot('snap-w1-rank-evidence');
  writeRunAt(root, 'forge-2026-07-31-realwork', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'green', timestamp: '2026-07-31T10:00:00.000Z' }),
  ], '2026-07-31T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  assert.ok(r.markdown.includes('2026-07-31T10:00:00.000Z'), 'the selected run\'s last work-event time must be stated');
  assert.ok(/last real work event/i.test(r.markdown), 'the file must say WHAT the ranking is based on');
});

// LIVE MEASUREMENT #2 (regenerating the real snapshot after the first W1a fix, 2026-08-01): a run with ZERO
// work events has no work time, so it fell back to file mtime — and the reconciliation had rewritten that
// too. Result: section 2 announced "**A NEWER run recorded a different mission.** `forge-2026-07-13-scout-
// loop` is newer than the source run above" and quoted a 13 July mission above a 31 July one. Same defect
// class as W1a, one rung down the ladder. A run that never logged work still has ONE timestamp written once
// and never rewritten: its own `run_started`. That is what "when did this run happen" means for it.
t('W1a: a work-less run is dated by its own run_started, not by a mtime a maintenance pass rewrote', () => {
  const root = freshRoot('snap-w1-startfallback');
  writeRunAt(root, 'forge-2026-07-31-realwork', [
    ev({ event_type: 'run_started', agent: 'orchestrator', note: 'W1-CURRENT-MISSION-SENTINEL', timestamp: '2026-07-31T09:00:00.000Z' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'green', timestamp: '2026-07-31T10:00:00.000Z' }),
  ], '2026-07-31T10:00:00Z');
  // a July run that never logged a renderable work event, restamped last night by the reconciliation
  writeRunAt(root, 'forge-2026-07-13-scoutloop', [
    ev({ event_type: 'run_started', agent: 'orchestrator', note: 'W1-STALE-MISSION-SENTINEL 5-uurs scout loop', timestamp: '2026-07-13T05:00:00.000Z' }),
    ev({ event_type: 'agent_progress', agent: 'orchestrator', note: 'scouting', timestamp: '2026-07-13T06:00:00.000Z' }),
    ev({ event_type: 'decision_logged', agent: 'orchestrator', note: 'status reconciliation 2026-08-01', timestamp: '2026-08-01T01:21:49.000Z' }),
  ], '2026-08-01T01:21:49Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  assert.strictEqual(r.runId, 'forge-2026-07-31-realwork');
  const why = sectionOf(r.markdown, 2);
  assert.ok(why.includes('W1-CURRENT-MISSION-SENTINEL'), 'the current mission must be the lead quote');
  assert.ok(!/NEWER run/i.test(why), 'a July run dated by its own run_started is NOT newer than a 31 July run');
  assert.ok(!why.includes('W1-STALE-MISSION-SENTINEL'), 'a stale mission must not be presented as the newer intent');
});

t('W1a: a genuinely just-started run (run_started today, no work yet) IS still ranked newest and disclosed', () => {
  const root = freshRoot('snap-w1-juststarted');
  writeRunAt(root, 'forge-2026-07-28-thework', [
    ev({ event_type: 'run_started', agent: 'orchestrator', note: 'OLD-MISSION-SENTINEL', timestamp: '2026-07-28T09:00:00.000Z' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'green', timestamp: '2026-07-28T10:00:00.000Z' }),
  ], '2026-07-28T10:00:00Z');
  writeRunAt(root, 'forge-2026-07-31-juststarted', [
    ev({ event_type: 'run_started', agent: 'orchestrator', detail: 'NEW-MISSION-SENTINEL migrate the gateway', timestamp: '2026-07-31T20:00:00.000Z' }),
  ], '2026-07-31T20:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  assert.strictEqual(r.runId, 'forge-2026-07-28-thework', 'a run with no work yet is not a source run');
  const why = sectionOf(r.markdown, 2);
  assert.ok(/NEWER run/i.test(why), 'but a genuinely newer mission must still be disclosed');
  assert.ok(why.includes('NEW-MISSION-SENTINEL') && why.includes('forge-2026-07-31-juststarted'));
});

// --- W1(b) SELF-DECLARATION --------------------------------------------------------------------------
// LIVE MEASUREMENT: `.claude/forge-runs/forge-demo-10agents-layout-preview/run.json` says of itself
//   "request": "DEMO LAYOUT PREVIEW — 10 agents (geen echt werk, alleen UI-demo)"
// and already carried the machine-readable `_demo: true`. Its 38 events are shaped exactly like real work
// ("docs-boss — check_passed — DEMO LAYOUT PREVIEW — geen echt bewijs"), so no content rule can tell them
// apart — only the run's own machine-readable declaration can.
t('W1b: a run that declares itself not-real-work in its own run.json is skipped, and the skip says why', () => {
  const root = freshRoot('snap-w1-synthetic');
  writeRunMetaAt(root, 'forge-demo-10agents-layout-preview', [
    ev({ event_type: 'check_passed', agent: 'docs-boss', note: 'DEMO LAYOUT PREVIEW — geen echt bewijs', timestamp: '2026-07-31T23:00:00.000Z' }),
    ev({ event_type: 'subagent_completed', agent: 'seo-boss', note: 'DEMO LAYOUT PREVIEW — geen echt bewijs', timestamp: '2026-07-31T23:05:00.000Z' }),
  ], '2026-07-31T23:05:00Z', {
    run_id: 'forge-demo-10agents-layout-preview',
    request: 'DEMO LAYOUT PREVIEW — 10 agents (geen echt werk, alleen UI-demo)',
    synthetic: true,
  });
  writeRunAt(root, 'forge-2026-07-30-realwork', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'W1B-REALWORK-SENTINEL', timestamp: '2026-07-30T10:00:00.000Z' }),
  ], '2026-07-30T10:00:00Z');
  const sel = snap.pickRun(root, null);
  assert.strictEqual(sel.runId, 'forge-2026-07-30-realwork', 'a self-declared synthetic run must never be the source run');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  assert.ok(r.markdown.includes('W1B-REALWORK-SENTINEL'));
  assert.ok(/synthetic/i.test(r.markdown), 'the skip reason must state the measured fact (a self-declaration in run.json)');
  assert.ok(r.markdown.includes('forge-demo-10agents-layout-preview'), 'the skipped run must be named, not silently dropped');
});

t('W1b: `_demo: true` counts as the same machine-readable declaration (it is the field the real demo run already carries)', () => {
  const root = freshRoot('snap-w1-demoflag');
  writeRunMetaAt(root, 'forge-demo-preview', [
    ev({ event_type: 'check_passed', agent: 'docs-boss', note: 'DEMO-SENTINEL', timestamp: '2026-07-31T23:00:00.000Z' }),
  ], '2026-07-31T23:00:00Z', { run_id: 'forge-demo-preview', _demo: true });
  writeRunAt(root, 'forge-2026-07-30-realwork', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'REAL-SENTINEL', timestamp: '2026-07-30T10:00:00.000Z' }),
  ], '2026-07-30T10:00:00Z');
  assert.strictEqual(snap.pickRun(root, null).runId, 'forge-2026-07-30-realwork');
});

t('W1b: the rule is the DECLARED FLAG, never the run-id name — a run called "demo" without the flag still counts', () => {
  const root = freshRoot('snap-w1-noblacklist');
  writeRunMetaAt(root, 'forge-demo-10agents-layout-preview', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'NAME-LOOKS-DEMO-BUT-IS-REAL', timestamp: '2026-07-31T23:00:00.000Z' }),
  ], '2026-07-31T23:00:00Z', { run_id: 'forge-demo-10agents-layout-preview', request: 'real work despite the name' });
  writeRunAt(root, 'forge-2026-07-30-older', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'OLDER-SENTINEL', timestamp: '2026-07-30T10:00:00.000Z' }),
  ], '2026-07-30T10:00:00Z');
  assert.strictEqual(snap.pickRun(root, null).runId, 'forge-demo-10agents-layout-preview',
    'no name blacklist: without a declaration the run is judged on its content like any other');
});

// --- W2 TICKET NEGATION ------------------------------------------------------------------------------
// WITNESS MEASUREMENT: TICKET_CLOSED_NOTE_RE = /\b(closed|gesloten|resolved|opgelost)\b/i matched the word
// "closed" inside "NOT closed — blocked on owner key" and produced the self-contradicting Done line
// "ticket tk-1 — closed :: NOT closed — blocked on owner key".
t('W2: "NOT closed — blocked on owner key" is never rendered as a closed ticket', () => {
  const root = freshRoot('snap-w2-negation');
  writeRunAt(root, 'forge-2026-07-30-neg', [
    ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-1', note: 'from acceptance criterion', timestamp: '2026-07-30T09:00:00.000Z' }),
    ev({ event_type: 'ticket_updated', agent: 'orchestrator', ticket_id: 'tk-1', note: 'W2-NEGATED-SENTINEL: NOT closed — blocked on owner key', timestamp: '2026-07-30T10:00:00.000Z' }),
  ], '2026-07-30T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  const done = r.markdown.split('### Done')[1].split('### In progress')[0];
  assert.ok(!done.includes('W2-NEGATED-SENTINEL'), 'a negated closure must not appear under Done');
  assert.ok(!/ticket tk-1 — closed/.test(r.markdown), 'the label must not contradict the detail on the same line');
  const inprog = r.markdown.split('### In progress')[1].split('### Open')[0];
  assert.ok(inprog.includes('W2-NEGATED-SENTINEL'), 'the ticket is still open, so it belongs in In progress');
});

t('W2: classifyTicketState is negation-aware in EN and NL, and says "unknown" rather than guessing', () => {
  const c = snap.classifyTicketState;
  assert.strictEqual(c({ event_type: 'ticket_updated', note: 'closed with test_evidence (verify-loop test-first rule)' }).state, 'closed');
  assert.strictEqual(c({ event_type: 'ticket_updated', note: 'NOT closed — blocked on owner key' }).state, 'open');
  assert.strictEqual(c({ event_type: 'ticket_updated', note: 'not yet closed, waiting on review' }).state, 'open');
  assert.strictEqual(c({ event_type: 'ticket_updated', note: 'nog niet gesloten — wacht op de owner' }).state, 'open');
  assert.strictEqual(c({ event_type: 'ticket_updated', note: 'still open at verification' }).state, 'open');
  assert.strictEqual(c({ event_type: 'ticket_updated', note: 'reassigned to Build Boss' }).state, 'unknown');
  assert.strictEqual(c({ event_type: 'ticket_created', note: 'from acceptance criterion' }).state, 'open');
  assert.strictEqual(c({ event_type: 'ticket_updated', status: 'closed', note: 'whatever the note says' }).state, 'closed');
  assert.strictEqual(c({ event_type: 'ticket_updated', status: 'blocked' }).state, 'open');
});

t('W2: a ticket whose text proves nothing is labelled "status unknown" — never silently reported closed or open', () => {
  const root = freshRoot('snap-w2-unknown');
  writeRunAt(root, 'forge-2026-07-30-unk', [
    ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-9', note: 'from acceptance criterion', timestamp: '2026-07-30T09:00:00.000Z' }),
    ev({ event_type: 'ticket_updated', agent: 'orchestrator', ticket_id: 'tk-9', note: 'W2-VAGUE-SENTINEL reassigned to Build Boss', timestamp: '2026-07-30T10:00:00.000Z' }),
  ], '2026-07-30T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  const done = r.markdown.split('### Done')[1].split('### In progress')[0];
  assert.ok(!done.includes('W2-VAGUE-SENTINEL'), 'an unprovable ticket state must never be reported as Done');
  assert.ok(/ticket tk-9 — status unknown/.test(r.markdown), 'the honest label is "status unknown"');
});

// --- W3 TICKET CROWDING ------------------------------------------------------------------------------
// WITNESS MEASUREMENT: tickets were appended AFTER the event loop and `done.slice(-8)` keeps the TAIL, so
// 9 closed tickets pushed every real work event out: Done contained 9 tickets and 0 of the 2 work events.
t('W3: 9 closed tickets can no longer push real work out of Done — work first, tickets separately capped', () => {
  const root = freshRoot('snap-w3-crowding');
  const lines = [
    ev({ event_type: 'fix_completed', agent: 'Build Boss', note: 'W3-WORK-A-SENTINEL the real fix landed', timestamp: '2026-07-30T09:00:00.000Z' }),
    ev({ event_type: 'subagent_completed', agent: 'Test Boss', role: 'qa', note: 'W3-WORK-B-SENTINEL suite green', timestamp: '2026-07-30T09:05:00.000Z' }),
  ];
  for (let i = 1; i <= 9; i++) {
    lines.push(ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-' + i, note: 'from acceptance criterion', timestamp: '2026-07-30T09:10:00.000Z' }));
    lines.push(ev({ event_type: 'ticket_updated', agent: 'orchestrator', ticket_id: 'tk-' + i, note: 'closed with test_evidence', timestamp: '2026-07-30T10:0' + (i % 10) + ':00.000Z' }));
  }
  writeRunAt(root, 'forge-2026-07-30-crowded', lines, '2026-07-30T10:10:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  const done = r.markdown.split('### Done')[1].split('### In progress')[0];
  assert.ok(done.includes('W3-WORK-A-SENTINEL'), 'real work must survive a flood of tickets');
  assert.ok(done.includes('W3-WORK-B-SENTINEL'), 'real work must survive a flood of tickets');
  assert.ok(/\d+ of 9 tickets omitted/.test(done), 'the file must SAY how many tickets it left out');
});

// --- W4 CONCURRENT STARTS BY THE SAME ACTOR ----------------------------------------------------------
// WITNESS MEASUREMENT: the 'actor' keyMode stores starts in a Map keyed by actor, so a second concurrent
// start OVERWROTE the first, and one completion then deleted the single surviving entry — reporting ZERO
// in progress while one dispatch was genuinely still running.
t('W4: two concurrent starts by the SAME actor plus ONE completion leaves exactly one in progress', () => {
  const root = freshRoot('snap-w4-concurrent');
  writeRunAt(root, 'forge-2026-07-30-concurrent', [
    ev({ event_type: 'agent_started', agent: 'Build Boss', task: 'W4-TASK-ONE-SENTINEL', timestamp: '2026-07-30T09:00:00.000Z' }),
    ev({ event_type: 'agent_started', agent: 'Build Boss', task: 'W4-TASK-TWO-SENTINEL', timestamp: '2026-07-30T09:01:00.000Z' }),
    ev({ event_type: 'agent_completed', agent: 'Build Boss', note: 'one of the two finished', timestamp: '2026-07-30T09:30:00.000Z' }),
  ], '2026-07-30T09:30:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  const inprog = r.markdown.split('### In progress')[1].split('### Open')[0];
  assert.ok(/_No dispatched-but-unresolved/.test(inprog) === false, 'in-progress must not be empty while a dispatch is still running');
  assert.ok(inprog.includes('W4-TASK-TWO-SENTINEL'), 'the still-running start must remain visible');
  assert.ok(!inprog.includes('W4-TASK-ONE-SENTINEL'), 'exactly ONE start is closed by one completion (FIFO — the oldest)');
});

t('W4: three concurrent starts by the same actor and no completions leave all three visible', () => {
  const root = freshRoot('snap-w4-three');
  writeRunAt(root, 'forge-2026-07-30-three', [
    ev({ event_type: 'fix_started', agent: 'Build Boss', note: 'W4-FIX-A', timestamp: '2026-07-30T09:00:00.000Z' }),
    ev({ event_type: 'fix_started', agent: 'Build Boss', note: 'W4-FIX-B', timestamp: '2026-07-30T09:01:00.000Z' }),
    ev({ event_type: 'fix_started', agent: 'Build Boss', note: 'W4-FIX-C', timestamp: '2026-07-30T09:02:00.000Z' }),
  ], '2026-07-30T09:02:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  const inprog = r.markdown.split('### In progress')[1].split('### Open')[0];
  for (const s of ['W4-FIX-A', 'W4-FIX-B', 'W4-FIX-C']) assert.ok(inprog.includes(s), s + ' must stay visible');
});

// --- W5 ADMINISTRATIVE CLOSE -------------------------------------------------------------------------
// WITNESS MEASUREMENT: `run_completed` counted as a work event, so a run whose ONLY events were
// run_started + a sweep-written run_completed ("closed administratively by a liveness sweep") outranked a
// run with a genuinely running subagent_started.
t('W5: a run closed administratively by a sweep (run_started + run_completed only) is not a work run', () => {
  const root = freshRoot('snap-w5-adminclose');
  writeRunAt(root, 'forge-2026-07-01-swept', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'W5-SWEPT-MISSION', timestamp: '2026-07-01T09:00:00.000Z' }),
    ev({ event_type: 'run_completed', agent: 'orchestrator', task: 'closed administratively by a liveness sweep', timestamp: '2026-08-01T01:00:00.000Z' }),
  ], '2026-08-01T01:00:00Z');
  writeRunAt(root, 'forge-2026-07-25-live', [
    ev({ event_type: 'subagent_started', agent: 'Build Boss', role: 'impl', dispatch_id: 'd5', task: 'W5-LIVE-SENTINEL', timestamp: '2026-07-25T09:00:00.000Z' }),
  ], '2026-07-25T09:00:00Z');
  const sel = snap.pickRun(root, null);
  assert.strictEqual(sel.runId, 'forge-2026-07-25-live', 'an administrative close must not out-rank genuinely running work');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  assert.ok(r.markdown.includes('W5-LIVE-SENTINEL'));
});

t('W5: run_completed is still RENDERED in Done for a run that did real work — it just cannot qualify one alone', () => {
  const root = freshRoot('snap-w5-render');
  writeRunAt(root, 'forge-2026-07-30-finished', [
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'W5-REALWORK-SENTINEL green', timestamp: '2026-07-30T09:00:00.000Z' }),
    ev({ event_type: 'run_completed', agent: 'orchestrator', task: 'W5-RUNCOMPLETED-SENTINEL delivered', timestamp: '2026-07-30T10:00:00.000Z' }),
  ], '2026-07-30T10:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: new Date('2026-08-01T02:00:00Z') });
  assert.strictEqual(r.runId, 'forge-2026-07-30-finished');
  assert.ok(r.markdown.includes('W5-RUNCOMPLETED-SENTINEL'), 'run_completed remains renderable work in section 3');
  assert.ok(snap.ADMINISTRATIVE_EVENT_TYPES.has('run_completed'), 'and is declared administrative for the picker');
  assert.ok(!snap.WORK_EVENT_TYPES.has('run_completed'), 'so it can never qualify a run on its own');
});

// ===========================================================================================================
// W1-CLOCK (2026-08-01) — an IMPOSSIBLE timestamp must not be able to hijack the ranking.
// W1a moved the ordering key from file mtime to each run's own `timestamp` field precisely BECAUSE a mtime
// is metadata any tool can rewrite. But that traded one unbounded key for another: a mtime is at least
// bounded by the filesystem clock, whereas `timestamp` is self-declared text that nothing validated. A
// single event dated 2099 therefore outranked a whole night of real July work, and the generated file
// quoted that 2099 date as fact — a fabricated claim inside a file whose own footer promises evidence.
// ===========================================================================================================
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
const NOW_REAL = new Date('2026-08-01T02:00:00.000Z');

t('W1-CLOCK: a 2099-dated work event does NOT let its run outrank a genuinely newer real run', () => {
  const root = freshRoot('snap-clock-hijack');
  fs.copyFileSync(path.join(__dirname, 'forge-doctor.cjs'), path.join(root, '.claude', 'forge-bin', 'forge-doctor.cjs'));
  writeRunAt(root, 'forge-2026-07-31-real', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'the real mission', timestamp: '2026-07-31T20:00:00.000Z' }),
    ev({ event_type: 'subagent_completed', agent: 'Build Boss', role: 'impl', note: 'REAL-JULY-SENTINEL delivered', timestamp: '2026-07-31T23:00:00.000Z' }),
  ], '2026-07-31T23:00:00Z');
  writeRunAt(root, 'forge-2026-07-10-hijack', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'an old July run', timestamp: '2026-07-10T08:00:00.000Z' }),
    ev({ event_type: 'subagent_completed', agent: 'Docs Boss', role: 'docs', note: 'OLD-JULY-SENTINEL', timestamp: '2026-07-10T09:00:00.000Z' }),
    ev({ event_type: 'check_passed', agent: 'Test Boss', note: 'HIJACK-SENTINEL', timestamp: FAR_FUTURE }),
  ], '2026-07-10T09:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: NOW_REAL });
  assert.strictEqual(r.runId, 'forge-2026-07-31-real',
    'the real 31 July run must win; got ' + r.runId + ' (selection: ' + r.runSelection.selection + ')');
  assert.ok(!r.markdown.includes('2099'),
    'the generated snapshot must never present a 2099 timestamp as a fact — found one in the output');
});

t('W1-CLOCK: runWorkSignal ignores the implausible event for DATING but still counts it as work, and says so', () => {
  const root = freshRoot('snap-clock-signal');
  writeRunAt(root, 'r-future', [
    ev({ event_type: 'subagent_completed', agent: 'a', note: 'real', timestamp: '2026-07-31T09:00:00.000Z' }),
    ev({ event_type: 'check_passed', agent: 'b', note: 'impossible', timestamp: FAR_FUTURE }),
  ], '2026-07-31T09:00:00Z');
  const sig = snap.runWorkSignal(root, 'r-future', { now: NOW_REAL });
  assert.strictEqual(sig.workEvents, 2, 'both events are still real work events (the run is not erased)');
  assert.strictEqual(sig.lastWorkAt, '2026-07-31T09:00:00.000Z',
    'dating falls back to the newest PLAUSIBLE work event; got ' + sig.lastWorkAt);
  assert.strictEqual(sig.implausibleWorkEvents, 1, 'the rejected event is counted, not silently dropped');
  assert.strictEqual(sig.implausibleLatestAt, FAR_FUTURE, 'and the rejected timestamp itself is reported');
});

t('W1-CLOCK: a plausible timestamp just inside the tolerance is NOT rejected (the horizon is a clock-skew allowance, not a "no future" rule)', () => {
  const root = freshRoot('snap-clock-tolerance');
  const justInside = new Date(NOW_REAL.getTime() + snap.FUTURE_TOLERANCE_MS - 60000).toISOString();
  writeRunAt(root, 'r-skew', [ev({ event_type: 'subagent_completed', agent: 'a', note: 'slightly-ahead clock', timestamp: justInside })], '2026-08-01T02:00:00Z');
  const sig = snap.runWorkSignal(root, 'r-skew', { now: NOW_REAL });
  assert.strictEqual(sig.implausibleWorkEvents, 0, 'a within-tolerance skew must be accepted as-is');
  assert.strictEqual(sig.lastWorkAt, justInside);
});

t('W1-CLOCK: a run whose ONLY work event is impossible falls to its run_started rung and DISCLOSES the rejection', () => {
  const root = freshRoot('snap-clock-onlyfuture');
  fs.copyFileSync(path.join(__dirname, 'forge-doctor.cjs'), path.join(root, '.claude', 'forge-bin', 'forge-doctor.cjs'));
  writeRunAt(root, 'r-onlyfuture', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'started honestly', timestamp: '2026-07-15T08:00:00.000Z' }),
    ev({ event_type: 'subagent_completed', agent: 'a', note: 'ONLY-FUTURE-SENTINEL', timestamp: FAR_FUTURE }),
  ], '2026-07-15T08:00:00Z');
  const doctorMod = require('./forge-doctor.cjs');
  const rows = snap.rankByWorkRecency(root, doctorMod.rankRunCandidates(root, {}), { now: NOW_REAL });
  const row = rows.find((x) => x.name === 'r-onlyfuture');
  assert.ok(row, 'the run is still considered');
  assert.strictEqual(row.lastWorkAtMs, null, 'it can no longer be dated by its impossible event');
  assert.ok(/run_started/.test(row.timeBasis), 'it drops to the run_started rung; got: ' + row.timeBasis);
  assert.ok(/implausible|beyond/i.test(row.timeBasis),
    'and the drop must be DISCLOSED in timeBasis, never silent; got: ' + row.timeBasis);
  // The requirement is MARKING, not erasure: the 2099 stamp is what the events literally contain, so
  // deleting it from the file would be its own small dishonesty. Every line that prints it must qualify it.
  const r = snap.write({ root, reason: 'manual', now: NOW_REAL });
  const unmarked = r.markdown.split('\n').filter((l) => l.includes('2099') && !/IMPLAUSIBLE|implausible/.test(l));
  assert.strictEqual(unmarked.length, 0, 'every line printing the 2099 stamp must mark it; unmarked: ' + JSON.stringify(unmarked));
  assert.ok(/IMPLAUSIBLE timestamp \(beyond the clock-skew horizon/.test(r.markdown),
    'section 3 must label the event\'s own evidence pointer, not only the run-selection sentence');
});

t('W1-CLOCK: an ORDINARY run is rendered exactly as before (the label fires only on an implausible stamp)', () => {
  const root = freshRoot('snap-clock-noregress');
  fs.copyFileSync(path.join(__dirname, 'forge-doctor.cjs'), path.join(root, '.claude', 'forge-bin', 'forge-doctor.cjs'));
  writeRunAt(root, 'r-normal', [
    ev({ event_type: 'run_started', agent: 'orchestrator', task: 'ordinary', timestamp: '2026-07-31T20:00:00.000Z' }),
    ev({ event_type: 'subagent_completed', agent: 'a', note: 'NORMAL-SENTINEL', timestamp: '2026-07-31T21:00:00.000Z' }),
  ], '2026-07-31T21:00:00Z');
  const r = snap.write({ root, reason: 'manual', now: NOW_REAL });
  assert.ok(r.markdown.includes('[subagent_completed@2026-07-31T21:00:00.000Z]'),
    'a plausible stamp keeps its exact original bare rendering');
  assert.ok(!/IMPLAUSIBLE|ignored for dating/.test(r.markdown), 'and nothing is labelled or disclosed');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
