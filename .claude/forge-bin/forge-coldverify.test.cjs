#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-coldverify.cjs. Uses os.mkdtemp + FORGE_STORE_ROOT (same escape hatch as
 *  forge-store.test.cjs / forge-verify.test.cjs) so nothing ever touches the real project's .claude/.
 *  FORGE_STORE_ROOT must be set BEFORE requiring the tool — forge-store.cjs resolves CLAUDE_DIR once, at
 *  require time, and forge-coldverify/forge-verify both hang off that. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-coldverify-test-'));
const CLAUDE_DIR = path.join(TMP, '.claude');
process.env.FORGE_STORE_ROOT = CLAUDE_DIR;
const C = require('./forge-coldverify.cjs');
const store = require('./forge-store.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-coldverify offline tests (hermetic root=' + TMP + ')');

const ev = (o) => JSON.stringify(o);
function writeEvents(runId, lines) {
  const dir = path.join(CLAUDE_DIR, 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  return dir;
}
function appendEvents(runId, lines) {
  fs.appendFileSync(path.join(CLAUDE_DIR, 'forge-runs', runId, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
}
function writePrdMeta(prdId, criteria) {
  const dir = path.join(CLAUDE_DIR, 'forge-prd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, prdId + '.meta.json'),
    JSON.stringify({ prd_id: prdId, title: prdId, sections: { acceptance_criteria: criteria } }), 'utf8');
}
function putTicket(id, data) { store.putEntity('tickets', id, data); }
function touch(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content || 'x', 'utf8');
  return p;
}
function verdictMap(res) {
  const m = {};
  for (const it of res.items) m[it.ticket_id] = it.verdict;
  return m;
}
function snapshotTree(dir) {
  const out = [];
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.push('D ' + path.relative(TMP, p)); walk(p); }
      else { let st; try { st = fs.statSync(p); } catch { continue; }
        out.push('F ' + path.relative(TMP, p) + ' ' + st.size + ' ' + st.mtimeMs); }
    }
  };
  walk(dir);
  return out.join('\n');
}

// ============================ 1. the narrative firewall (admitEvents) ============================
{
  const raw = [
    { event_type: 'agent_note', agent: 'Build Boss', note: 'every criterion is fully met, I checked carefully' },
    { event_type: 'subagent_completed', agent: 'Build Boss', status: 'done', ticket_id: 'tk-x-1' },
    { event_type: 'agent_progress', agent: 'Build Boss', status: 'completed', task: 'wired it all up' },
    { event_type: 'subagent_output_created', agent: 'Build Boss', output: 'all three criteria verified' },
    { event_type: 'decision_logged', agent: 'Build Boss', decision: 'accepted as done' },
    { event_type: 'report_generated', agent: 'Build Boss' },
    { event_type: 'agent_completed', agent: 'Build Boss', status: 'done' },
    { event_type: 'check_passed', agent: 'Test Boss', task: 'unit', ticket_id: 'tk-x-1', note: 'and it was beautiful' },
    { event_type: 'file_changed', agent: 'Build Boss', files_changed: ['src/a.js'], note: 'a masterpiece' },
  ];
  const admitted = C.admitEvents(raw);
  t('firewall: every narrative/claim event type is dropped (only the 2 hard facts survive)', admitted.length === 2);
  t('firewall: the surviving types are exactly check_passed + file_changed',
    admitted.map((e) => e.event_type).sort().join(',') === 'check_passed,file_changed');
  t('firewall: a bare completion CLAIM (subagent_completed) is excluded — a claim can never be its own proof',
    !admitted.some((e) => e.event_type === 'subagent_completed'));
  t('firewall: narrative fields are stripped even off an ADMITTED event (no reasoning smuggled in on a hard fact)',
    admitted.every((e) => e.note === undefined));
  t('firewall: the checkable payload of an admitted event survives (task name + paths kept)',
    admitted.find((e) => e.event_type === 'check_passed').task === 'unit'
    && admitted.find((e) => e.event_type === 'file_changed').files_changed[0] === 'src/a.js');
  t('firewall: admitEvents does not mutate its input (original note still present on the source object)',
    raw[7].note === 'and it was beautiful');
  const unknown = C.admitEvents([{ event_type: 'some_future_event', ticket_id: 'tk-x-1', status: 'done' }]);
  t('firewall is an ALLOW-LIST: an unregistered/future event type is NOT admitted by default', unknown.length === 0);
  t('firewall sets are disjoint: no event type is both excluded and admitted',
    Array.from(C.COLD_ADMITTED_EVENT_TYPES).every((x) => !C.COLD_EXCLUDED_EVENT_TYPES.has(x)));
}

// ============================ 2. the ticket-side firewall ============================
{
  const cold = C.coldTicket({ ticket_id: 'tk-a-1', title: 'Crit', note: 'builder prose', description: 'more prose', test_evidence: 'a.js', status: 'done' });
  t('ticket firewall: builder prose (note/description) is dropped', cold.note === undefined && cold.description === undefined);
  t('ticket firewall: the spec side (title) and the claim side (test_evidence) are KEPT — they are what gets compared',
    cold.title === 'Crit' && cold.test_evidence === 'a.js');
}

// ============================ 3. referent extraction ============================
{
  const r = C.extractReferents('forge-all-lens.test.cjs: 33/33 (agent+task nodes) + live screenshot 10-ALL-1440.png');
  t('referents: file-like tokens are extracted', r.includes('forge-all-lens.test.cjs') && r.includes('10-ALL-1440.png'));
  t('referents: an unverifiable prose tally ("33/33") is NOT treated as a referent', !r.some((x) => x.includes('33/33')));
  t('referents: prose with no file-like token yields none',
    C.extractReferents('forge-doctor ALL GREEN: leak scan 94 tracked files clean').length === 0);
  t('referents: blank/non-string input is safe', C.extractReferents('').length === 0 && C.extractReferents(null).length === 0);
}

// ============================ 4. referent resolution + containment ============================
{
  touch('.claude/forge-bin/real-suite.test.cjs');
  const hit = C.resolveReferent('real-suite.test.cjs', TMP, null);
  t('resolve: a bare basename is found under a bounded candidate root', hit.exists === true && hit.path.endsWith('real-suite.test.cjs'));
  const miss = C.resolveReferent('does-not-exist-anywhere.png', TMP, null);
  t('resolve: a missing referent is reported honestly, never guessed', miss.exists === false && miss.path === null);
  // Containment must be pinned against a file that GENUINELY EXISTS outside the project root — asserting
  // on a made-up path like ../../etc/passwd is vacuous (it resolves to nothing on Windows either way, so
  // the assertion holds even with the guard deleted). Create a real sibling of TMP in the OS temp dir and
  // reference it by traversal: with the guard it must stay unresolved, without it, it would be found.
  const outsideName = 'coldverify-outside-' + process.pid + '.png';
  const outsidePath = path.join(os.tmpdir(), outsideName);
  fs.writeFileSync(outsidePath, 'outside the project root', 'utf8');
  const sanity = fs.existsSync(outsidePath) && !path.resolve(outsidePath).startsWith(path.resolve(TMP) + path.sep);
  t('resolve (setup): the containment fixture really exists and really lies outside the project root', sanity);
  const escape = C.resolveReferent('../' + outsideName, TMP, null);
  t('resolve: a referent traversing OUT of the project root is refused even though the file exists (containment guard)',
    escape.exists === false && escape.path === null);
  try { fs.unlinkSync(outsidePath); } catch { /* best-effort cleanup of our own temp fixture */ }
}

// ============================ 5. the spec side (criterionFor) ============================
{
  writePrdMeta('prd-spec', [{ id: 'ac-1', text: 'Criterion one from the SPEC' }, { id: 'ac-2', text: 'Criterion two' }]);
  const fromPrd = C.criterionFor({ ticket_id: 'tk-prd-spec-1', prd_id: 'prd-spec', title: 'builder restatement that drifted' });
  t('spec: the PRD criterion wins over the ticket title (authoritative spec, not the builder restatement)',
    fromPrd.text === 'Criterion one from the SPEC' && fromPrd.source === 'prd' && fromPrd.ac_id === 'ac-1');
  const fromTitle = C.criterionFor({ ticket_id: 'tk-manual-1', title: 'Hand-written ticket' });
  t('spec: falls back to the ticket title when there is no PRD, and SAYS so via criterion_source',
    fromTitle.text === 'Hand-written ticket' && fromTitle.source === 'ticket-title');
  const none = C.criterionFor({ ticket_id: 'tk-empty-1' });
  t('spec: no criterion at all is reported as source "none" (never invented)', none.text === '' && none.source === 'none');
  t('spec: the criterion is read through forge-verify\'s OWN exports (no second truth)',
    typeof require('./forge-verify.cjs').acceptanceCriteria === 'function'
    && typeof require('./forge-verify.cjs').loadPrdMeta === 'function');
}

// ============================ 6. verdicts on real fixture shapes ============================
writePrdMeta('prd-cold', [
  { id: 'ac-1', text: 'P1 criterion — proven by a ticket-bound check_passed' },
  { id: 'ac-2', text: 'P2 criterion — proven by a referent that exists AND is named in-run' },
  { id: 'ac-3', text: 'P3 criterion — referent exists but nothing ties it to the ticket' },
  { id: 'ac-4', text: 'Missing-referent criterion — the named evidence is not on disk' },
  { id: 'ac-5', text: 'No-evidence criterion — closed on nothing at all' },
  { id: 'ac-6', text: 'Counter-evidence criterion — the run says this check FAILED' },
  { id: 'ac-7', text: 'Phantom-delivery criterion — a ticket-bound file_changed names a path that is not on disk' },
]);
// Placed at the project root so a BARE-BASENAME claim ("delivered.js") genuinely resolves through the
// bounded candidate-root lookup — the P2/P3 fixtures are only meaningful if the referent really resolves.
touch('delivered.js');
touch('orphan.js');
const RUN = 'run-cold';
writeEvents(RUN, [
  ev({ event_type: 'run_started', agent: 'orchestrator' }),
  ev({ event_type: 'check_passed', agent: 'Test Boss', task: 'ac-1 suite', ticket_id: 'tk-prd-cold-1', status: 'done' }),
  // deliberately NOT ticket-bound: this must corroborate via P2 (referent match), not via P1
  ev({ event_type: 'file_changed', agent: 'Build Boss', files_changed: ['delivered.js'] }),
  ev({ event_type: 'check_failed', agent: 'Test Boss', task: 'ac-6 suite', ticket_id: 'tk-prd-cold-6', status: 'failed' }),
  '{ this line is not valid json ,,,',
  ev({ event_type: 'ticket_updated', agent: 'orchestrator', ticket_id: 'tk-prd-cold-5', status: 'done' }),
  // a ticket-bound delivery claim whose path was never written — the phantom-delivery case
  ev({ event_type: 'file_changed', agent: 'Build Boss', files_changed: ['never-created.js'], ticket_id: 'tk-prd-cold-7' }),
]);
const base = { prd_id: 'prd-cold', run_id: RUN, status: 'done', required_tests: [], related_files: [] };
putTicket('tk-prd-cold-1', Object.assign({}, base, { ticket_id: 'tk-prd-cold-1', title: 'P1', test_evidence: 'suite green' }));
putTicket('tk-prd-cold-2', Object.assign({}, base, { ticket_id: 'tk-prd-cold-2', title: 'P2', test_evidence: 'delivered.js written' }));
putTicket('tk-prd-cold-3', Object.assign({}, base, { ticket_id: 'tk-prd-cold-3', title: 'P3', test_evidence: 'see orphan.js, all good' }));
putTicket('tk-prd-cold-4', Object.assign({}, base, { ticket_id: 'tk-prd-cold-4', title: 'missing', test_evidence: 'proof in never-written.png, 33/33' }));
putTicket('tk-prd-cold-5', Object.assign({}, base, { ticket_id: 'tk-prd-cold-5', title: 'none', test_evidence: '' }));
putTicket('tk-prd-cold-6', Object.assign({}, base, { ticket_id: 'tk-prd-cold-6', title: 'counter', test_evidence: 'suite green' }));
putTicket('tk-prd-cold-7', Object.assign({}, base, { ticket_id: 'tk-prd-cold-7', title: 'phantom', test_evidence: 'shipped it' }));
putTicket('tk-prd-cold-open', Object.assign({}, base, { ticket_id: 'tk-prd-cold-open', title: 'still open', status: 'open' }));

const res = C.coldVerify({ run_id: RUN, projectRoot: TMP });
const V = verdictMap(res);
const item = (id) => res.items.find((i) => i.ticket_id === id);
t('verdict P1: a ticket-bound admitted check_passed proves the criterion', V['tk-prd-cold-1'] === 'proven');
t('verdict P1 is recorded as P1 (a ticket-bound event), not confused with a referent match',
  item('tk-prd-cold-1').corroborations.every((c) => c.kind === 'P1'));
t('verdict P2: a referent that exists on disk AND is named by a NON-ticket-bound in-run event proves it', V['tk-prd-cold-2'] === 'proven');
t('verdict P2 is genuinely the referent path (kind P2), proving the fixture is not silently a P1',
  item('tk-prd-cold-2').corroborations.some((c) => c.kind === 'P2')
  && !item('tk-prd-cold-2').corroborations.some((c) => c.kind === 'P1'));
t('verdict P3: a referent that merely EXISTS, with nothing tying it to the ticket, is NOT proof', V['tk-prd-cold-3'] === 'unproven');
t('verdict P3 fixture really resolved on disk (otherwise it would be testing the missing-referent path instead)',
  item('tk-prd-cold-3').referents.resolved.length === 1 && item('tk-prd-cold-3').referents.missing.length === 0);
t('phantom delivery: a ticket-bound file_changed naming a path that is NOT on disk does not prove the ticket',
  V['tk-prd-cold-7'] === 'unproven' && item('tk-prd-cold-7').corroborations.length === 0);
t('phantom delivery: the un-written path is surfaced as missing, not silently ignored',
  item('tk-prd-cold-7').referents.missing.includes('never-created.js'));
t('verdict P3 reason names the exact softness ("a filename is not a proof")',
  item('tk-prd-cold-3').reasons.join(' ').includes('a filename is not a proof'));
t('verdict missing-referent: named evidence absent from disk -> unproven', V['tk-prd-cold-4'] === 'unproven');
t('verdict missing-referent names the exact missing file in its reason',
  item('tk-prd-cold-4').referents.missing.includes('never-written.png'));
t('verdict no-evidence: a done ticket carrying no checkable evidence at all -> unproven', V['tk-prd-cold-5'] === 'unproven');
t('circularity guard: a ticket_updated(status:done) can NEVER prove its own ticket',
  item('tk-prd-cold-5').corroborations.length === 0);
t('verdict counter-evidence: a ticket-bound check_failed -> unproven (loudly)', V['tk-prd-cold-6'] === 'unproven');
t('counter-evidence is recorded structurally, not only in prose',
  item('tk-prd-cold-6').counter_evidence.length === 1);
t('scope: only DONE tickets are assessed; the open one is skipped and counted',
  res.checked === 7 && res.skipped_not_done === 1 && V['tk-prd-cold-open'] === undefined);
t('summary tallies match the items', res.summary.proven === 2 && res.summary.unproven === 5 && res.summary.unassessable === 0);
t('a malformed events.jsonl line is skipped, never a crash',
  item('tk-prd-cold-1').evidence_channel.startsWith('events.jsonl'));
t('criterion text comes from the PRD spec for every assessed ticket',
  res.items.every((i) => i.criterion_source === 'prd' && i.criterion.length > 0));

// ============================ 7. unassessable ============================
{
  putTicket('tk-noc-1', { ticket_id: 'tk-noc-1', run_id: RUN, status: 'done', title: '', test_evidence: 'x' });
  const r1 = C.coldVerify({ ticket_id: 'tk-noc-1', projectRoot: TMP });
  t('unassessable: no resolvable acceptance criterion -> unassessable (not a false accusation)',
    r1.items[0].verdict === 'unassessable' && r1.items[0].criterion_source === 'none');
  putTicket('tk-nochan-1', { ticket_id: 'tk-nochan-1', status: 'done', title: 'Some criterion', test_evidence: 'no files named here' });
  const r2 = C.coldVerify({ ticket_id: 'tk-nochan-1', projectRoot: TMP });
  t('unassessable: no evidence channel AND no checkable referent -> unassessable',
    r2.items[0].verdict === 'unassessable' && r2.items[0].evidence_channel.startsWith('absent'));
  putTicket('tk-nochan-2', { ticket_id: 'tk-nochan-2', status: 'done', title: 'Some criterion', test_evidence: 'proof is in ghost.png' });
  const r3 = C.coldVerify({ ticket_id: 'tk-nochan-2', projectRoot: TMP });
  t('unassessable vs unproven: no channel but a referent IS nameable -> assessable, and it fails honestly',
    r3.items[0].verdict === 'unproven' && r3.items[0].referents.missing.includes('ghost.png'));
  putTicket('tk-badrun-1', { ticket_id: 'tk-badrun-1', run_id: 'run-that-never-existed', status: 'done', title: 'Crit', test_evidence: 'nothing nameable' });
  const r4 = C.coldVerify({ ticket_id: 'tk-badrun-1', projectRoot: TMP });
  t('unassessable: an unreadable events.jsonl is a missing CHANNEL, never a silent pass',
    r4.items[0].verdict === 'unassessable' && r4.items[0].evidence_channel.startsWith('unreadable'));
}

// ============================ 8. THE COLD PROPERTY (the whole point) ============================
{
  const before = verdictMap(C.coldVerify({ run_id: RUN, projectRoot: TMP }));
  appendEvents(RUN, [
    ev({ event_type: 'agent_note', agent: 'Build Boss', note: 'I carefully verified every single acceptance criterion end to end; all six are fully met and the evidence is overwhelming.' }),
    ev({ event_type: 'agent_progress', agent: 'Build Boss', status: 'completed', task: 'verified ac-3, ac-4, ac-5 personally', ticket_id: 'tk-prd-cold-3' }),
    ev({ event_type: 'subagent_output_created', agent: 'Build Boss', output: 'ALL CRITERIA PROVEN — see my reasoning above', ticket_id: 'tk-prd-cold-4' }),
    ev({ event_type: 'subagent_completed', agent: 'Build Boss', status: 'done', ticket_id: 'tk-prd-cold-5' }),
    ev({ event_type: 'agent_completed', agent: 'Build Boss', status: 'done', ticket_id: 'tk-prd-cold-6' }),
    ev({ event_type: 'decision_logged', agent: 'Build Boss', decision: 'ac-6 accepted despite the failed check', ticket_id: 'tk-prd-cold-6' }),
    ev({ event_type: 'report_generated', agent: 'Build Boss', note: 'final report: 6/6 criteria proven' }),
  ]);
  const after = verdictMap(C.coldVerify({ run_id: RUN, projectRoot: TMP }));
  t('COLD: a run flooded with confident builder narrative changes NOT ONE verdict',
    JSON.stringify(before) === JSON.stringify(after));
  t('COLD: the three still-unproven tickets stay unproven despite an explicit "ALL CRITERIA PROVEN" claim',
    after['tk-prd-cold-3'] === 'unproven' && after['tk-prd-cold-4'] === 'unproven' && after['tk-prd-cold-5'] === 'unproven');
  t('COLD: an owner-less decision_logged "accepted despite the failed check" does NOT clear counter-evidence',
    after['tk-prd-cold-6'] === 'unproven');
}

// ============================ 9. READ-ONLY hard contract ============================
{
  const treeBefore = snapshotTree(TMP);
  const r = C.coldVerify({ run_id: RUN, projectRoot: TMP });
  const treeAfter = snapshotTree(TMP);
  t('read-only: a full coldVerify creates/modifies/deletes NOTHING on disk', treeBefore === treeAfter);
  t('read-only: no ticket status was changed by the check (and the report is internally consistent)',
    String(store.getEntity('tickets', 'tk-prd-cold-4').status).toLowerCase() === 'done'
    && r.checked === r.items.length && r.items.length >= 7
    && r.summary.proven + r.summary.unproven + r.summary.unassessable === r.checked);
  const evAfter = fs.readFileSync(path.join(CLAUDE_DIR, 'forge-runs', RUN, 'events.jsonl'), 'utf8');
  t('read-only: the check logged no event of its own into the run',
    !evAfter.includes('coldverify') && !evAfter.includes('cold_verify'));
}

// ============================ 10. guarded reads ============================
{
  const dir = store.resolveStoreDir('tickets');
  fs.writeFileSync(path.join(dir, 'tk-corrupt-1.json'), '{ not json at all', 'utf8');
  let threw = false;
  let r;
  try { r = C.coldVerify({ projectRoot: TMP }); } catch { threw = true; }
  t('guarded: a corrupt ticket entity is skipped, never crashes the check', !threw && r.checked > 0);
  t('guarded: the corrupt ticket produced no item', !r.items.some((i) => i.ticket_id === 'tk-corrupt-1'));
}

// ============================ 11. CLI ============================
{
  const runCli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'forge-coldverify.cjs'), ...args],
    { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_STORE_ROOT: CLAUDE_DIR }) });

  const cliUnproven = runCli('--run', RUN, '--root', TMP);
  t('CLI: exits 1 when at least one done ticket is UNPROVEN', cliUnproven.status === 1);
  t('CLI: text output names the three verdicts it actually used',
    /UNPROVEN/.test(cliUnproven.stdout) && /PROVEN/.test(cliUnproven.stdout) && /summary:/.test(cliUnproven.stdout));
  t('CLI: text output states the read-only contract to the reader',
    /read-only: nothing was reopened, changed, or logged/.test(cliUnproven.stdout));

  const cliOne = runCli('--ticket', 'tk-prd-cold-1', '--root', TMP);
  t('CLI: exits 0 when nothing assessed is unproven', cliOne.status === 0);

  const cliJson = runCli('--run', RUN, '--root', TMP, '--json');
  let parsed = null;
  try { parsed = JSON.parse(cliJson.stdout); } catch { parsed = null; }
  t('CLI --json: emits parseable JSON with the summary + per-ticket items',
    !!parsed && parsed.checked === parsed.items.length && parsed.items.length >= 7
    && typeof parsed.summary.proven === 'number');
  t('CLI --json: every item carries one of exactly the three allowed verdicts',
    !!parsed && parsed.items.every((i) => C.VERDICTS.includes(i.verdict)));

  const cliBad = runCli('--nonsense');
  t('CLI: an unknown argument exits 2 (usage), never a silent pass', cliBad.status === 2);

  const cliHelp = runCli('--help');
  t('CLI --help: documents that it never writes', cliHelp.status === 0 && /Never writes/.test(cliHelp.stdout));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
