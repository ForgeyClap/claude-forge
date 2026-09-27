#!/usr/bin/env node
'use strict';
/**
 * forge-vault.cjs — WP-E offline tests. Hermetic: every scenario uses its own throwaway temp project
 * root with a REAL copy of log-event.cjs (so events.jsonl is genuinely chained/hashed, never a hand-typed
 * fixture) and, for the finalize-integration section, real copies of forge-finalize.cjs/forge-runcontract.cjs
 * too — the same fixture pattern forge-finalize.test.cjs already uses. Cleans up its own temp dirs with
 * fs.rmSync (never a shell delete). Exit 0 = all pass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); } };

const BIN = __dirname;
const V = require(path.join(BIN, 'forge-vault.cjs'));
// v2.9.0 WP-K2 (Codex F7 perf fixture) — write a large file_changed event directly via log-event.cjs's own
// exported writer (validateForWrite + appendChainedLocked) instead of spawning the CLI: 5000 file paths as a
// single JSON CLI argv risks Windows' ~32K command-line length limit, and 5000 separate CLI spawns would
// make the fixture itself slow. Same hash-chain/validation code path as the real CLI, just called in-process.
const LE = require(path.join(BIN, '..', 'forge-dashboard', 'log-event.cjs'));

const TMP_ROOTS = [];
function newRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  TMP_ROOTS.push(root);
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(path.join(BIN, '..', 'forge-dashboard', 'log-event.cjs'), path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
  return root;
}
function logEvt(root) { return path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'); }
function log(root, run, type, extra) {
  const r = spawnSync(process.execPath, [logEvt(root), run, type, JSON.stringify(Object.assign({ agent: 'orchestrator' }, extra || {}))], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('fixture log() failed: ' + type + ' :: ' + r.stdout + r.stderr);
}
function writeRunJson(root, run, meta) {
  const dir = path.join(root, '.claude', 'forge-runs', run);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(Object.assign({ run_id: run }, meta), null, 2));
}
function noteFile(root, ...rest) { return path.join(root, '.claude', 'forge-vault', ...rest); }
function readNote(root, ...rest) { return fs.readFileSync(noteFile(root, ...rest), 'utf8'); }

console.log('forge-vault (WP-E) offline tests');

// ---- 1) a run with real events produces Home/runs/decisions/topics notes with valid frontmatter and
// working links, and free text is redacted ----
{
  const ROOT = newRoot('vault-1');
  const RUN = 'forge-2026-09-27-vault-smoke';
  writeRunJson(ROOT, RUN, { started_at: '2026-09-27T00:00:00.000Z', mission: 'Ship the Forge knowledge vault (WP-E).' });
  log(ROOT, RUN, 'run_started', { note: 'begin' });
  log(ROOT, RUN, 'file_changed', { files_changed: ['.claude/forge-bin/forge-vault.cjs', '.claude/forge-bin/forge-gate-hook.cjs'] });
  log(ROOT, RUN, 'check_passed', { note: 'node forge-vault.test.cjs -> 20 passed, 0 failed', command: 'node forge-vault.test.cjs', output: '20 passed, 0 failed' });
  log(ROOT, RUN, 'check_failed', { note: 'a deliberately failed check for fixture coverage', command: 'node x.test.cjs', output: '1 failed' });
  log(ROOT, RUN, 'decision_logged', { note: 'DECISION: reimplement the claude-obsidian pattern zero-dependency. Token sk-THISISNOTAREALSECRETKEY1234567890 must never leak.' });
  log(ROOT, RUN, 'run_completed', { note: 'done', command: 'x', output: 'ok' });

  const r = V.updateVault(ROOT, RUN, {});
  t('1a updateVault reports ok:true', r.ok === true, JSON.stringify(r));
  t('1b at least 4 notes written (run + decision + >=1 topic + home)', r.notes_written >= 4, r.notes_written);
  t('1c exactly one decision slug derived', Array.isArray(r.decisions) && r.decisions.length === 1, JSON.stringify(r.decisions));
  t('1d at least one topic slug derived', Array.isArray(r.topics) && r.topics.length >= 1, JSON.stringify(r.topics));

  const home = readNote(ROOT, 'Home.md');
  t('1e Home.md has valid frontmatter (title/type/created/updated/tags)', /^---\r?\ntitle: "Forge Vault"[\s\S]*?type: "index"[\s\S]*?created: "[^"]+"[\s\S]*?updated: "[^"]+"[\s\S]*?tags: \[[^\]]*\]\r?\n---/.test(home), home.slice(0, 200));
  t('1f Home.md links the run (wikilink)', home.includes('[[runs/' + RUN + ']]'), home);
  t('1g Home.md links the decision', home.includes('[[decisions/' + r.decisions[0] + ']]'), home);
  t('1h Home.md links a topic', home.includes('[[topics/' + r.topics[0] + ']]'), home);

  const runNote = readNote(ROOT, 'runs', RUN + '.md');
  t('1i run note has valid frontmatter with source_run', new RegExp('source_run: "' + RUN + '"').test(runNote), runNote.slice(0, 300));
  t('1j run note lists the changed files', runNote.includes('forge-gate-hook.cjs'), runNote);
  t('1k run note lists PASS and FAIL checks', runNote.includes('PASS —') && runNote.includes('FAIL —'), runNote);
  t('1l run note links its decision and topics (wikilinks)', runNote.includes('[[decisions/' + r.decisions[0] + ']]') && r.topics.every((s) => runNote.includes('[[topics/' + s + ']]')), runNote);
  t('1m run note mission excerpt present', runNote.includes('Ship the Forge knowledge vault'), runNote);

  const decisionNote = readNote(ROOT, 'decisions', r.decisions[0] + '.md');
  t('1n decision note links back to the run', decisionNote.includes('[[runs/' + RUN + ']]'), decisionNote);
  t('1o decision note text redacted the secret-shaped token', !decisionNote.includes('sk-THISISNOTAREALSECRETKEY1234567890') && decisionNote.includes('REDACTED'), decisionNote);

  const topicNote = readNote(ROOT, 'topics', r.topics[0] + '.md');
  t('1p topic note links the run', topicNote.includes('[[runs/' + RUN + ']]'), topicNote);
  t('1q topic note links the decision', topicNote.includes('[[decisions/' + r.decisions[0] + ']]'), topicNote);
}

// ---- 2) idempotency: a second update() with no new facts changes nothing at all ----
{
  const ROOT = newRoot('vault-2');
  const RUN = 'forge-2026-09-27-idempotent';
  writeRunJson(ROOT, RUN, { started_at: '2026-09-27T00:00:00.000Z', mission: 'idempotency check' });
  log(ROOT, RUN, 'run_started', { note: 'begin' });
  log(ROOT, RUN, 'file_changed', { files_changed: ['.claude/forge-bin/forge-vault.cjs'] });
  log(ROOT, RUN, 'run_completed', { note: 'done' });

  const r1 = V.updateVault(ROOT, RUN, {});
  t('2a first call writes new notes', r1.notes_written > 0, JSON.stringify(r1));
  const homeBefore = readNote(ROOT, 'Home.md');
  const runBefore = readNote(ROOT, 'runs', RUN + '.md');

  const r2 = V.updateVault(ROOT, RUN, {});
  t('2b second call writes ZERO new notes', r2.notes_written === 0, JSON.stringify(r2));
  t('2c second call reports the same notes as unchanged', r2.notes_unchanged === r1.notes_written, JSON.stringify([r1, r2]));
  const homeAfter = readNote(ROOT, 'Home.md');
  const runAfter = readNote(ROOT, 'runs', RUN + '.md');
  t('2d Home.md byte-identical after a no-op update (even the updated: timestamp)', homeBefore === homeAfter);
  t('2e run note byte-identical after a no-op update (even the updated: timestamp)', runBefore === runAfter);
}

// ---- 3) hand-written text below the manual marker survives regeneration ----
{
  const ROOT = newRoot('vault-3');
  const RUN = 'forge-2026-09-27-manual-text';
  writeRunJson(ROOT, RUN, { started_at: '2026-09-27T00:00:00.000Z', mission: 'manual text preservation' });
  log(ROOT, RUN, 'run_started', { note: 'begin' });
  log(ROOT, RUN, 'run_completed', { note: 'done' });
  V.updateVault(ROOT, RUN, {});

  const runFile = noteFile(ROOT, 'runs', RUN + '.md');
  fs.appendFileSync(runFile, '\nMy own private research notes that Forge must never delete.\n');

  // a second run touching the SAME area forces Home.md (and, if topics overlap, the topic note) to
  // regenerate — proving preservation survives a REAL regeneration, not just "we happened not to touch it".
  const RUN2 = 'forge-2026-09-27-manual-text-b';
  writeRunJson(ROOT, RUN2, { started_at: '2026-09-27T01:00:00.000Z', mission: 'second run, same project' });
  log(ROOT, RUN2, 'run_started', { note: 'begin' });
  log(ROOT, RUN2, 'run_completed', { note: 'done' });
  V.updateVault(ROOT, RUN2, {});
  // regenerate the FIRST run's own note again (new call, same facts) to prove ITS manual text also survives
  const r3 = V.updateVault(ROOT, RUN, {});
  const after = fs.readFileSync(runFile, 'utf8');
  t('3a manual text survives a later regeneration', after.includes('My own private research notes that Forge must never delete.'), after);
  t('3b the manual marker itself is still present exactly once', after.split('<!-- forge:manual -->').length === 2, after);
  t('3c updateVault still reports ok:true after a hand-edited note exists on disk', r3.ok === true, JSON.stringify(r3));
}

// ---- 4) vault off writes nothing at all (fresh run, fresh root — proves absence, not just "unchanged") ----
{
  const ROOT = newRoot('vault-4');
  const RUN = 'forge-2026-09-27-vault-off';
  writeRunJson(ROOT, RUN, { started_at: '2026-09-27T00:00:00.000Z', mission: 'should never be written' });
  log(ROOT, RUN, 'run_started', { note: 'begin' });
  log(ROOT, RUN, 'run_completed', { note: 'done' });

  const r = V.updateVault(ROOT, RUN, { configModule: { get: () => ({ value: false }) } });
  t('4a updateVault reports skipped:true', r.ok === true && r.skipped === true, JSON.stringify(r));
  t('4b the vault directory was never created', !fs.existsSync(noteFile(ROOT)), 'exists=' + fs.existsSync(noteFile(ROOT)));

  const status = V.statusOf(ROOT, { configModule: { get: () => ({ value: false }) } });
  t('4c statusOf reports enabled:false through the same config seam', status.enabled === false, JSON.stringify(status));
}

// ---- 5) honest no-op: a run with neither run.json nor readable events writes nothing and says why ----
{
  const ROOT = newRoot('vault-5');
  const r = V.updateVault(ROOT, 'forge-2026-09-27-never-existed', {});
  t('5a unknown run: ok:false with an honest reason, never fabricated', r.ok === false && /no run\.json/.test(r.reason), JSON.stringify(r));
  t('5b nothing was written for an unknown run', !fs.existsSync(noteFile(ROOT)));
}

// ---- 6) the finalize hook never fails finalize even when the vault write throws or returns ok:false, and
// a REAL (uninjected) finalize genuinely produces vault notes automatically — no command needed ----
{
  const ROOT = newRoot('vault-6-finalize');
  fs.mkdirSync(path.join(ROOT, '.claude', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(path.join(BIN, 'forge-runcontract.cjs'), path.join(ROOT, '.claude', 'forge-bin', 'forge-runcontract.cjs'));
  fs.copyFileSync(path.join(BIN, 'forge-finalize.cjs'), path.join(ROOT, '.claude', 'forge-bin', 'forge-finalize.cjs'));
  fs.copyFileSync(path.join(BIN, 'forge-vault.cjs'), path.join(ROOT, '.claude', 'forge-bin', 'forge-vault.cjs'));
  try {
    fs.mkdirSync(path.join(ROOT, '.claude', 'config', 'agents'), { recursive: true });
    fs.copyFileSync(path.join(BIN, '..', 'config', 'agents', 'agent-registry.json'), path.join(ROOT, '.claude', 'config', 'agents', 'agent-registry.json'));
  } catch { /* optional fixture; runcontract degrades gracefully without it */ }
  fs.writeFileSync(path.join(ROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({
    owners_allowlist: ['owner'],
    rules: [{ id: 'has-start', rule: 'run has a start event', trigger: 'always', check: { type: 'event-present', key: ['run_started'] }, severity: 'block', override: 'n/a', source: 'test' }],
  }, null, 2));
  const F = require(path.join(ROOT, '.claude', 'forge-bin', 'forge-finalize.cjs'));
  const seedEvidence = (run) => {
    const d = path.join(ROOT, '.claude', 'forge-runs', run);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'gate-evidence.json');
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ run_id: run, gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
  };
  const flog = (run, type, extra) => { seedEvidence(run); log(ROOT, run, type, extra); };

  // 6a — a REAL, uninjected finalize automatically refreshes the vault (the marquee "no command needed" claim)
  const RUN_A = 'fin-vault-auto';
  writeRunJson(ROOT, RUN_A, { mission: 'prove finalize wires the vault automatically' });
  flog(RUN_A, 'run_started', { note: 's' });
  flog(RUN_A, 'file_changed', { files_changed: ['.claude/forge-bin/forge-finalize.cjs'] });
  flog(RUN_A, 'run_completed', { command: 'x', output: 'klaar', note: 'af' });
  const rA = F.finalize(ROOT, RUN_A);
  t('6a a real finalize() call still succeeds', rA.ok === true && rA.verdict === 'finalized', JSON.stringify(rA).slice(0, 200));
  t('6b Home.md now exists with NO explicit vault call — finalize alone triggered it', fs.existsSync(path.join(ROOT, '.claude', 'forge-vault', 'Home.md')));
  t('6c the run note for this run now exists too', fs.existsSync(path.join(ROOT, '.claude', 'forge-vault', 'runs', RUN_A + '.md')));

  // 6b — a throwing vault module never fails finalize
  const RUN_B = 'fin-vault-throws';
  flog(RUN_B, 'run_started', { note: 's' });
  flog(RUN_B, 'run_completed', { command: 'x', output: 'klaar' });
  const rB = F.finalize(ROOT, RUN_B, { vaultModule: { updateVault() { throw new Error('synthetic vault crash'); } } });
  t('6d finalize still succeeds when the vault module throws', rB.ok === true && rB.verdict === 'finalized', JSON.stringify(rB).slice(0, 200));

  // 6c — a non-throwing ok:false vault result never fails finalize either
  const RUN_C = 'fin-vault-failed';
  flog(RUN_C, 'run_started', { note: 's' });
  flog(RUN_C, 'run_completed', { command: 'x', output: 'klaar' });
  const rC = F.finalize(ROOT, RUN_C, { vaultModule: { updateVault() { return { ok: false, reason: 'synthetic' }; } } });
  t('6e finalize still succeeds when the vault module reports ok:false', rC.ok === true && rC.verdict === 'finalized', JSON.stringify(rC).slice(0, 200));

  // 6d — an idempotent RECONFIRMATION (second finalize call on an already-finalized run) also refreshes the vault
  const rA2 = F.finalize(ROOT, RUN_A);
  t('6f a second, idempotent finalize call on the same run still reports finalized', rA2.ok === true && rA2.idempotent === true, JSON.stringify(rA2).slice(0, 160));
}

// ---- 7) small pure-function unit checks ----
{
  const map = V.deriveTopics(['.claude/forge-bin/forge-gate-hook.cjs', '.claude/forge-dashboard/panels.js', 'random-file.txt']);
  t('7a deriveTopics maps a gate file to "gate-hook"', map.has('gate-hook') && map.get('gate-hook').has('.claude/forge-bin/forge-gate-hook.cjs'));
  t('7b deriveTopics maps a dashboard file to "dashboard"', map.has('dashboard'));
  t('7c deriveTopics falls back to a filename-derived slug for an unmatched file', map.has('random-file'));

  const text = '## 2026-09-27 (run forge-abc-123 — test)\nline one\nline two\n## next heading\nunrelated';
  const sec = V.extractSectionMentioning(text, 'forge-abc-123');
  t('7d extractSectionMentioning captures the matching heading block only', sec.includes('line one') && sec.includes('line two') && !sec.includes('unrelated'), sec);
  t('7e extractSectionMentioning returns null when nothing matches', V.extractSectionMentioning(text, 'no-such-run') === null);

  const rInvalid = V.updateVault(newRoot('vault-7-invalid'), '../escape-attempt', {});
  t('7f an unsafe run_id is refused outright, never touches the filesystem', rInvalid.ok === false && /invalid run_id/.test(rInvalid.reason), JSON.stringify(rInvalid));
}

// ---- 8) v2.9.0 WP-K2 (Codex F5) — scrub() must catch a LABELLED secret in free text, not just a
// pattern-shaped one. redactValue()'s SECRET_KEY_RE only ever matched OBJECT KEYS, so a decision_logged
// note whose text reads "password=hunter2" passed straight through when scrub() called redactValue() on a
// bare string. Fixed by switching scrub() to forge-store.cjs's redactText(). ----
{
  const ROOT = newRoot('vault-8-f5-redacttext');
  const RUN = 'forge-2026-09-27-f5-redacttext';
  writeRunJson(ROOT, RUN, { started_at: '2026-09-27T00:00:00.000Z', mission: 'F5 free-text redaction probe' });
  log(ROOT, RUN, 'run_started', { note: 'begin' });
  // the EXACT input from the Codex finding
  log(ROOT, RUN, 'decision_logged', { note: 'password=hunter2' });
  log(ROOT, RUN, 'run_completed', { note: 'done' });

  const r = V.updateVault(ROOT, RUN, {});
  t('8a updateVault reports ok:true', r.ok === true, JSON.stringify(r));
  t('8b exactly one decision derived', Array.isArray(r.decisions) && r.decisions.length === 1, JSON.stringify(r.decisions));
  const decisionNote = readNote(ROOT, 'decisions', r.decisions[0] + '.md');
  t('8c the raw secret value "hunter2" never reaches disk', !decisionNote.includes('hunter2'), decisionNote);
  t('8d the key name "password=" survives (only the value is masked)', decisionNote.includes('password='), decisionNote);
  t('8e a redaction marker is present', /REDACTED/.test(decisionNote), decisionNote);
}

// ---- 9) v2.9.0 WP-K2 (Codex F6) — a symlink/junction path-escape must be refused, never followed. If
// `.claude/forge-vault/runs` is a real NTFS junction pointing OUTSIDE the project, withinBase()'s purely
// LEXICAL check used to report "inside" while the actual write landed at the junction's target. ----
{
  const ROOT = newRoot('vault-9-f6-symlink');
  const RUN = 'forge-2026-09-27-f6-symlink';
  writeRunJson(ROOT, RUN, { started_at: '2026-09-27T00:00:00.000Z', mission: 'F6 symlink escape probe' });
  log(ROOT, RUN, 'run_started', { note: 'begin' });
  log(ROOT, RUN, 'run_completed', { note: 'done' });

  const vaultDir = path.join(ROOT, '.claude', 'forge-vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-escape-target-'));
  TMP_ROOTS.push(escapeTarget);
  const runsLink = path.join(vaultDir, 'runs');
  let junctionMade = true;
  try { fs.symlinkSync(escapeTarget, runsLink, 'junction'); } catch (e) { junctionMade = false; console.log('  (skipping 9: could not create a junction on this machine — ' + e.message + ')'); }

  if (junctionMade) {
    t('9a isPathSafeUnderRoot directly refuses the junctioned runs dir', V.isPathSafeUnderRoot(ROOT, runsLink).safe === false);
    const r = V.updateVault(ROOT, RUN, {});
    t('9b updateVault still reports ok:true (best-effort, never throws)', r.ok === true, JSON.stringify(r));
    t('9c nothing was written into the escape target through the junction', fs.readdirSync(escapeTarget).length === 0, JSON.stringify(fs.readdirSync(escapeTarget)));
    t('9d Home.md (a REAL, non-junctioned dir) still gets written normally', fs.existsSync(path.join(vaultDir, 'Home.md')));
  }
}

// ---- 10) v2.9.0 WP-K2 (Codex F7) — thousands of distinct files must not stall updateVault: topics capped
// at MAX_TOPICS_PER_RUN, files-considered capped at MAX_FILES_CONSIDERED, and the runs/decisions note
// directories are scanned ONCE per updateVault() call instead of once PER TOPIC. ----
{
  const ROOT = newRoot('vault-10-f7-perf');
  const RUN = 'forge-2026-09-27-f7-perf-5000-files';
  const files = [];
  // deliberately unmatched by every TOPIC_RULES pattern so pre-fix code would mint one topic PER file
  for (let i = 0; i < 5000; i++) files.push('src/perf-file-' + i + '.zz');
  const evStarted = { run_id: RUN, event_type: 'run_started', agent: 'orchestrator', note: 'perf fixture' };
  const evFiles = { run_id: RUN, event_type: 'file_changed', agent: 'orchestrator', files_changed: files };
  const evDone = { run_id: RUN, event_type: 'run_completed', agent: 'orchestrator', note: 'done' };
  for (const e of [evStarted, evFiles, evDone]) {
    const v = LE.validateForWrite(e);
    if (!v.ok) throw new Error('10 fixture validateForWrite failed: ' + v.message);
  }
  const w = LE.appendChainedLocked(path.join(ROOT, '.claude', 'forge-runs', RUN), [evStarted, evFiles, evDone], {});
  if (!w.ok) throw new Error('10 fixture appendChainedLocked failed: ' + w.message);

  const t0 = Date.now();
  const r = V.updateVault(ROOT, RUN, {});
  const elapsedMs = Date.now() - t0;
  console.log('  [perf] updateVault with 5000 distinct files took ' + elapsedMs + 'ms');
  t('10a updateVault with 5000 distinct files still reports ok:true', r.ok === true, JSON.stringify(r).slice(0, 200));
  t('10b topics are capped at MAX_TOPICS_PER_RUN even with 5000 distinct files', r.topics.length <= V.MAX_TOPICS_PER_RUN, r.topics.length);
  const runNote = readNote(ROOT, 'runs', RUN + '.md');
  t('10c the run note honestly discloses the files-considered cap', runNote.includes('5000 files changed') && runNote.includes('first ' + V.MAX_FILES_CONSIDERED), runNote.slice(0, 400));
  t('10d the run note honestly discloses the topics cap', runNote.includes('topics capped at ' + V.MAX_TOPICS_PER_RUN), runNote.slice(0, 800));
  t('10e finishes fast (< 5000ms on this machine) — F7 perf fix', elapsedMs < 5000, elapsedMs + 'ms');
}

console.log(pass + ' passed, ' + fail + ' failed');
for (const r of TMP_ROOTS) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
process.exitCode = fail ? 1 : 0;
