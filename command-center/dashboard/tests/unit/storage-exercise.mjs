/**
 * Runnable proof for src/bridge/storage. Not a vitest suite: it is a standalone
 * script so it can be run with the same `node file.ts` path the bridge itself
 * uses. Run it with `node tests/unit/storage-exercise.mjs`.
 *
 * Real exercise of src/bridge/storage against the real file system, run with
 * the real Node 24 that ships in this environment. Every check either passes
 * or is reported as a failure — nothing is inferred from "it didn't throw".
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import console from 'node:console';

import * as atomic from '../../src/bridge/storage/atomic.ts';
import * as schema from '../../src/bridge/storage/schema.ts';
import * as store from '../../src/bridge/storage/store.ts';

let pass = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function section(title) {
  console.log(`\n== ${title}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'forge-storage-smoke-'));
const nowIso = () => new Date().toISOString();

function project(id, name) {
  return {
    id,
    displayName: name,
    slug: id,
    canonicalPath: join(scratch, id),
    relativePath: id,
    type: 'website',
    description: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    forgeVersion: null,
    templateVersion: null,
    git: { initialized: false, branch: null, dirtyFiles: 0, lastCommit: null, hasRemote: false },
    sessionIds: [],
    conversationIds: [],
    activeRunIds: [],
    archived: false,
    health: 'UNKNOWN',
    lastDoctorResult: null,
    metadataSchemaVersion: 1,
  };
}

function run(id, projectId, status, pid, owner) {
  return {
    id,
    projectId,
    conversationId: null,
    sessionId: null,
    goal: 'exercise',
    status,
    statusReason: 'started',
    pid,
    ownerBridgeInstanceId: owner,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    endedAt: null,
    exitCode: null,
    lastSequence: 0,
    evidenceRefs: [],
  };
}

/* ------------------------------------------------------------------ atomic */
section('atomic.ts — writeAtomic / readJsonSafe');
{
  const dir = join(scratch, 'atomic');
  const target = join(dir, 'record.json');
  const result = atomic.writeAtomic(target, '{"x":1}\n');
  check('writeAtomic produced the exact bytes', readFileSync(target, 'utf8') === '{"x":1}\n');
  check('writeAtomic left no .tmp litter', readdirSync(dir).filter((f) => f.endsWith('.tmp')).length === 0,
    readdirSync(dir).join(','));
  check('writeAtomic reports fileSynced', result.fileSynced === true);
  console.log(`  INFO  directorySynced on this platform = ${result.directorySynced}`);

  atomic.writeAtomic(target, '{"x":2}\n');
  check('writeAtomic overwrote in place', readFileSync(target, 'utf8') === '{"x":2}\n');

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{"x":');
  const badRead = atomic.readJsonSafe(bad);
  check('readJsonSafe detects malformed JSON without throwing',
    badRead.ok === false && badRead.reason === 'MALFORMED_JSON', JSON.stringify(badRead));

  const missing = atomic.readJsonSafe(join(dir, 'nope.json'));
  check('readJsonSafe reports MISSING', missing.ok === false && missing.reason === 'MISSING');

  const empty = join(dir, 'empty.json');
  writeFileSync(empty, '   ');
  check('readJsonSafe reports EMPTY', atomic.readJsonSafe(empty).reason === 'EMPTY');

  const scalar = join(dir, 'scalar.json');
  writeFileSync(scalar, '42');
  check('readJsonSafe reports NOT_AN_OBJECT', atomic.readJsonSafe(scalar).reason === 'NOT_AN_OBJECT');
}

section('atomic.ts — readJsonlSafe truncation handling');
{
  const p = join(scratch, 'atomic', 'log.jsonl');
  atomic.appendLineDurable(p, JSON.stringify({ a: 1 }));
  atomic.appendLineDurable(p, JSON.stringify({ a: 2 }));
  appendFileSync(p, '{"a":3,"partial');
  const read = atomic.readJsonlSafe(p);
  check('two good lines survive a truncated tail', read.lines.length === 2, `got ${read.lines.length}`);
  check('truncated tail is flagged', read.truncatedTailDropped === true);
  check('truncated tail is the only corruption reported',
    read.corruption.length === 1 && read.corruption[0].kind === 'TRUNCATED_TAIL' && read.corruption[0].lineNumber === 3,
    JSON.stringify(read.corruption));
  check('the log file itself was not rewritten', readFileSync(p, 'utf8').includes('"partial'));

  const mid = join(scratch, 'atomic', 'mid.jsonl');
  writeFileSync(mid, '{"a":1}\nNOT JSON\n{"a":3}\n');
  const midRead = atomic.readJsonlSafe(mid);
  check('a corrupt middle line is skipped, not fatal', midRead.lines.length === 2);
  check('a corrupt middle line is NOT called a truncated tail',
    midRead.truncatedTailDropped === false && midRead.corruption[0].kind === 'MALFORMED_JSON');
}

section('atomic.ts — advisory lock');
{
  const lockPath = join(scratch, 'lock', 'bridge.lock');
  const first = atomic.acquireLock(lockPath, { staleMs: 60_000 });
  check('lock acquired', first.ok === true, JSON.stringify(first));
  const second = atomic.acquireLock(lockPath, { staleMs: 60_000 });
  check('a second acquisition is refused while the first is live',
    second.ok === false && second.reason === 'HELD', JSON.stringify(second));
  check('the refusal names the holder pid', second.ok === false && second.heldBy?.pid === process.pid);
  check('renewLock succeeds for the real holder', atomic.renewLock(first.handle) === true);
  check('releaseLock succeeds for the real holder', atomic.releaseLock(first.handle) === true);
  check('the lock file is gone after release', existsSync(lockPath) === false);

  // Stale takeover: a lock naming a pid that is not running.
  const deadPid = 4_000_000;
  check('isPidAlive says the synthetic pid is not running', atomic.isPidAlive(deadPid) === false);
  atomic.writeJsonAtomic(lockPath, {
    pid: deadPid, token: 'stale-token', acquiredAt: nowIso(), heartbeatAt: nowIso(),
    owner: 'ghost', lockVersion: 1,
  });
  const takeover = atomic.acquireLock(lockPath, { staleMs: 60_000 });
  check('a lock held by a dead pid is taken over', takeover.ok === true, JSON.stringify(takeover));
  check('the takeover records who it took it from',
    takeover.ok === true && takeover.handle.tookOverFrom?.pid === deadPid);
  if (takeover.ok) atomic.releaseLock(takeover.handle);
}

/* ------------------------------------------------------------------ schema */
section('schema.ts — validation is the honesty gate');
{
  check('a well-formed project validates', schema.validateRecord('project', project('p1', 'P1')).ok === true);
  const missing = schema.validateRecord('project', { id: 'p1' });
  check('a project missing contract fields is rejected', missing.ok === false);

  const unknownEvent = schema.validateEvent({
    eventId: 'e', schemaVersion: 1, sequence: 1, timestamp: nowIso(), projectId: 'p1',
    runId: null, sessionId: null, conversationId: null, taskId: null, agentId: null,
    source: 'bridge', type: 'run.definitely.succeeded', payload: {}, evidenceRefs: [],
  });
  check('an event type outside EVENT_TYPES is rejected', unknownEvent.ok === false,
    JSON.stringify(unknownEvent));

  const selfApproved = schema.validateRecord('verification', {
    id: 'v1', taskId: 't1', runId: 'r1', verifierAgentId: 'a1', subjectAgentId: 'a1',
    startedAt: nowIso(), resolvedAt: nowIso(), verdict: 'VERIFIED_PASS', reason: 'looks fine', evidenceRefs: [],
  });
  check('a self-approved PASS verification is rejected', selfApproved.ok === false,
    JSON.stringify(selfApproved));

  const testNoExit = schema.validateRecord('test', {
    id: 't1', projectId: 'p1', runId: null, gate: 'unit', command: 'npm', args: ['test'], cwd: scratch,
    startedAt: nowIso(), endedAt: nowIso(), durationMs: 10, exitCode: null, stdoutRef: null, stderrRef: null,
    counts: null, status: 'COMPLETED', evidenceRefs: [],
  });
  check('a COMPLETED test with no exit code is rejected', testNoExit.ok === false);

  const runNoProof = schema.validateRecord('run', run('r1', 'p1', 'RUNNING', null, null));
  check('a RUNNING run with neither a pid nor an owner is rejected', runNoProof.ok === false);
}

section('schema.ts — migrations are idempotent');
{
  let state = null;
  const records = new Map();
  records.set('project/p1', { kind: 'project', id: 'p1', schemaVersion: 0, storedAt: nowIso(), record: { id: 'p1' } });
  const io = {
    listRecordIds: (kind) => [...records.keys()].filter((k) => k.startsWith(kind + '/')).map((k) => k.slice(kind.length + 1)),
    readEnvelope: (kind, id) => {
      const e = records.get(`${kind}/${id}`);
      return e ? { ok: true, value: e, bytes: 0 } : { ok: false, reason: 'MISSING', detail: 'absent', bytes: 0 };
    },
    writeEnvelope: (env) => { records.set(`${env.kind}/${env.id}`, env); },
    readState: () => (state ? { ok: true, value: state, bytes: 0 } : { ok: false, reason: 'MISSING', detail: 'absent', bytes: 0 }),
    writeState: (s) => { state = s; },
  };
  const migration = {
    id: 'project-0-to-1-add-flag', kind: 'project', from: 0, to: 1,
    description: 'synthetic', migrate: (r) => ({ ...r, migratedFlag: true }),
  };

  const firstRun = schema.runMigrations(io, [migration]);
  check('first run applies the migration', firstRun.applied.length === 1 && firstRun.applied[0].recordsChanged === 1,
    JSON.stringify(firstRun.applied));
  check('the record was actually transformed', records.get('project/p1').record.migratedFlag === true);
  check('the record version advanced', records.get('project/p1').schemaVersion === 1);

  const secondRun = schema.runMigrations(io, [migration]);
  check('second run applies nothing', secondRun.applied.length === 0, JSON.stringify(secondRun.applied));
  check('second run reports the id as already applied',
    secondRun.alreadyApplied.includes('project-0-to-1-add-flag'));
  check('state still records exactly one application', state.applied.length === 1);

  const already = schema.migrateEnvelope({ kind: 'project', id: 'p1', schemaVersion: 1, storedAt: nowIso(), record: {} }, [migration]);
  check('migrateEnvelope is a no-op at the current version', already.ok === true && already.applied.length === 0);

  const fromFuture = schema.migrateEnvelope({ kind: 'project', id: 'p1', schemaVersion: 99, storedAt: nowIso(), record: {} }, [migration]);
  check('a record from a future schema version is refused, not downgraded', fromFuture.ok === false);
}

/* ------------------------------------------------------------------- store */
section('store.ts — events, sequences and idempotency');
const ws1 = join(scratch, 'ws1');
{
  const s = store.ForgeStore.open({ dataDir: ws1, bridgeInstanceId: 'inst-1', now: () => new Date() });
  try {
    const a = s.appendEvent({ eventId: 'evt-1', projectId: 'proj1', runId: 'run1', source: 'bridge', type: 'run.created', payload: { n: 1 } });
    check('first append is not a duplicate', a.deduplicated === false && a.event.sequence === 1);
    const again = s.appendEvent({ eventId: 'evt-1', projectId: 'proj1', runId: 'run1', source: 'bridge', type: 'run.created', payload: { n: 999 } });
    check('the same eventId twice stores once', again.deduplicated === true && again.event.sequence === 1);
    check('the deduplicated call returns the ORIGINAL payload', again.event.payload.n === 1,
      JSON.stringify(again.event.payload));

    s.appendEvent({ projectId: 'proj1', runId: 'run1', source: 'claude-code', type: 'claude.message', payload: {} });
    s.appendEvent({ projectId: 'proj1', runId: 'run1', source: 'claude-code', type: 'claude.usage', payload: {} });

    const lines = readFileSync(join(ws1, 'events', 'proj1~run1.jsonl'), 'utf8').trim().split('\n');
    check('exactly three lines are on disk', lines.length === 3, `got ${lines.length}`);
    check('sequences are 1,2,3', lines.map((l) => JSON.parse(l).sequence).join(',') === '1,2,3');

    const page = s.readEvents({ projectId: 'proj1', runId: 'run1' });
    check('readEvents replays all three', page.events.length === 3);
    check('readEvents gives a usable cursor', page.nextSequence === 4, String(page.nextSequence));
    const tail = s.readEvents({ projectId: 'proj1', runId: 'run1', fromSequence: 3 });
    check('fromSequence is inclusive', tail.events.length === 1 && tail.events[0].sequence === 3);
    const typed = s.readEvents({ projectId: 'proj1', runId: 'run1', types: ['claude.usage'] });
    check('type filtering works', typed.events.length === 1 && typed.events[0].type === 'claude.usage');
    check('no gaps in a healthy stream', s.detectGaps('proj1~run1').length === 0);

    let threw = null;
    try {
      s.appendEvent({ projectId: 'proj1', runId: 'run1', source: 'bridge', type: 'run.totally.finished', payload: {} });
    } catch (err) { threw = err; }
    check('an unknown event type cannot be persisted', threw !== null && threw.name === 'StoreValidationError',
      threw ? threw.name : 'nothing thrown');

    let pathThrew = null;
    try { s.appendEvent({ projectId: '../escape', source: 'bridge', type: 'bridge.ready', payload: {} }); }
    catch (err) { pathThrew = err; }
    check('a traversal projectId is rejected', pathThrew !== null && pathThrew.name === 'StorePathError');
  } finally {
    s.close();
  }
}

section('store.ts — record CRUD');
{
  const s = store.ForgeStore.open({ dataDir: ws1, bridgeInstanceId: 'inst-1b' });
  try {
    s.saveRecord('project', project('proj1', 'Project One'));
    const read = s.getRecord('project', 'proj1');
    check('a saved project reads back', read.ok === true && read.record.displayName === 'Project One');
    check('the envelope carries a schema version', read.ok === true && read.schemaVersion === 1);
    check('listRecords finds it', s.listRecords('project').records.length === 1);
    check('hasRecord is true', s.hasRecord('project', 'proj1') === true);

    let threw = null;
    try { s.saveRecord('project', { id: 'broken' }); } catch (err) { threw = err; }
    check('an invalid record never reaches disk', threw !== null && threw.name === 'StoreValidationError');
    check('and no file was created for it', s.hasRecord('project', 'broken') === false);

    writeFileSync(join(ws1, 'records', 'project', 'corrupt.json'), '{"kind":"project","id":"corrupt",');
    const corrupt = s.getRecord('project', 'corrupt');
    check('a corrupt record file returns a typed failure instead of throwing',
      corrupt.ok === false && corrupt.reason === 'CORRUPT', JSON.stringify(corrupt));
    const listed = s.listRecords('project');
    check('listRecords reports the unreadable one separately',
      listed.records.length === 1 && listed.unreadable.length === 1, JSON.stringify(listed.unreadable));

    check('deleteRecord removes it', s.deleteRecord('project', 'corrupt') === true);
    check('deleteRecord on nothing returns false', s.deleteRecord('project', 'corrupt') === false);
  } finally {
    s.close();
  }
}

section('store.ts — gap detection drives DEGRADED');
{
  const ws = join(scratch, 'ws-gap');
  const s0 = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'gap-seed' });
  s0.close();
  const streamFile = join(ws, 'events', 'projg~rung.jsonl');
  const mk = (seq) => JSON.stringify({
    eventId: `g${seq}`, schemaVersion: 1, sequence: seq, timestamp: nowIso(), projectId: 'projg',
    runId: 'rung', sessionId: null, conversationId: null, taskId: null, agentId: null,
    source: 'bridge', type: 'run.state', payload: {}, evidenceRefs: [],
  });
  writeFileSync(streamFile, `${mk(1)}\n${mk(2)}\n${mk(5)}\n${mk(8)}\n`);

  const s = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'gap-reader' });
  try {
    const gaps = s.detectGaps('projg~rung');
    check('gaps are reported as ranges',
      JSON.stringify(gaps) === JSON.stringify([{ from: 3, to: 4, count: 2 }, { from: 6, to: 7, count: 2 }]),
      JSON.stringify(gaps));
    const report = s.reconcileOnStartup();
    check('reconcile surfaces the gap', report.gaps.length === 1 && report.gaps[0].streamKey === 'projg~rung');
    const degraded = s.readEvents({ projectId: '__bridge__', runId: null, types: ['bridge.degraded'] });
    check('a bridge.degraded event was recorded for the gap',
      degraded.events.some((e) => e.payload.reason === 'events.sequence-gap'),
      JSON.stringify(degraded.events.map((e) => e.payload.reason)));
  } finally {
    s.close();
  }

  // Re-open: the same damage must not multiply degraded events.
  const s2 = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'gap-reader-2' });
  try {
    s2.reconcileOnStartup();
    const degraded = s2.readEvents({ projectId: '__bridge__', runId: null, types: ['bridge.degraded'] });
    const gapNotes = degraded.events.filter((e) => e.payload.reason === 'events.sequence-gap');
    check('re-running on the same damage does not duplicate the note', gapNotes.length === 1,
      `got ${gapNotes.length}`);
  } finally {
    s2.close();
  }
}

section('store.ts — a truncated final line after a hard crash');
{
  const ws = join(scratch, 'ws-trunc');
  const s0 = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'trunc-seed' });
  s0.appendEvent({ projectId: 'projt', runId: 'runt', source: 'bridge', type: 'run.created', payload: { i: 1 } });
  s0.appendEvent({ projectId: 'projt', runId: 'runt', source: 'bridge', type: 'run.state', payload: { i: 2 } });
  s0.close();
  const f = join(ws, 'events', 'projt~runt.jsonl');
  appendFileSync(f, '{"eventId":"half","schemaVersion":1,"sequ');

  const s = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'trunc-reader' });
  try {
    const page = s.readEvents({ projectId: 'projt', runId: 'runt' });
    check('the two complete events survive', page.events.length === 2, `got ${page.events.length}`);
    check('the truncated line is reported as damage',
      page.issues.some((i) => i.reason === 'jsonl.truncated-tail'), JSON.stringify(page.issues));
    const notes = s.degradedNotes().filter((n) => n.reason === 'jsonl.truncated-tail');
    check('a bridge.degraded note was recorded at open', notes.length === 1, JSON.stringify(s.degradedNotes()));
    const degraded = s.readEvents({ projectId: '__bridge__', runId: null, types: ['bridge.degraded'] });
    check('the note is on disk as a bridge.degraded event',
      degraded.events.some((e) => e.payload.reason === 'jsonl.truncated-tail'));
    check('the damaged log was NOT discarded', readFileSync(f, 'utf8').includes('"sequ'));
    const next = s.appendEvent({ projectId: 'projt', runId: 'runt', source: 'bridge', type: 'run.state', payload: { i: 3 } });
    check('appends continue from the last good sequence', next.event.sequence === 3, String(next.event.sequence));
  } finally {
    s.close();
  }
}

section('store.ts — reconcileOnStartup never leaves a false RUNNING');
{
  const ws = join(scratch, 'ws-recon');
  const s1 = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'inst-A' });
  s1.saveRecord('project', project('projr', 'R'));
  s1.saveRecord('run', run('run-dead', 'projr', 'RUNNING', 4_000_001, 'inst-A'));
  s1.saveRecord('run', run('run-nopid', 'projr', 'STREAMING', null, 'inst-A'));
  s1.saveRecord('run', run('run-alive', 'projr', 'RUNNING', process.pid, 'inst-A'));
  s1.saveRecord('run', { ...run('run-done', 'projr', 'COMPLETED', 4_000_002, null), endedAt: nowIso(), exitCode: 0 });
  s1.close();

  const s2 = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'inst-B' });
  try {
    const report = s2.reconcileOnStartup();
    const byId = Object.fromEntries(report.reconciled.map((r) => [r.runId, r]));
    check('a run whose pid is gone becomes INTERRUPTED', byId['run-dead']?.to === 'INTERRUPTED', JSON.stringify(byId['run-dead']));
    check('a run with no pid becomes ORPHANED', byId['run-nopid']?.to === 'ORPHANED');
    check('a run whose pid is alive but unowned becomes ORPHANED', byId['run-alive']?.to === 'ORPHANED');
    check('an already-finished run is left alone', byId['run-done'] === undefined);
    check('nothing was reconciled to COMPLETED', report.reconciled.every((r) => r.to !== 'COMPLETED'));
    check('every reconciliation carries evidence', report.reconciled.every((r) => r.evidenceRefs.length > 0));
    check('pidAlive is recorded honestly for the dead pid', byId['run-dead']?.pidAlive === false);
    check('pidAlive is null when there was no pid to check', byId['run-nopid']?.pidAlive === null);

    for (const id of ['run-dead', 'run-nopid', 'run-alive']) {
      const r = s2.getRecord('run', id);
      check(`${id} no longer claims a live status on disk`, r.ok === true && r.status !== 'RUNNING' && r.status !== 'STREAMING',
        r.ok ? r.record?.status : 'unreadable');
      check(`${id} has an end time`, r.ok === true && r.record.endedAt !== null);
      check(`${id} has no owning bridge instance`, r.ok === true && r.record.ownerBridgeInstanceId === null);
    }

    const stateEvents = s2.readEvents({ projectId: 'projr', runId: 'run-dead', types: ['run.state'] });
    check('a run.state event records the transition',
      stateEvents.events.length === 1 && stateEvents.events[0].status === 'INTERRUPTED');
    const reconciledEvents = s2.readEvents({ projectId: '__bridge__', runId: null, types: ['bridge.reconciled'] });
    check('a bridge.reconciled event was written', reconciledEvents.events.length === 1);

    // Second reconcile: everything is already terminal, so there is nothing to do.
    const second = s2.reconcileOnStartup();
    check('a second reconcile changes nothing', second.reconciled.length === 0, JSON.stringify(second.reconciled));
  } finally {
    s2.close();
  }
}

section('store.ts — the lock stops a second instance');
{
  const ws = join(scratch, 'ws-lock');
  const a = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'lock-A' });
  let threw = null;
  try { store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'lock-B' }); } catch (err) { threw = err; }
  check('a second store cannot open the same workspace', threw !== null && threw.name === 'StoreLockError',
    threw ? `${threw.name}: ${threw.message}` : 'nothing thrown');
  a.close();
  const c = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'lock-C' });
  check('after close, the workspace opens again', c.lockHeld === true);
  c.close();
}

section('store.ts — checkpoints');
{
  const ws = join(scratch, 'ws-cp');
  const s = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'cp-A' });
  try {
    s.saveRecord('project', project('projc', 'C'));
    s.appendEvent({ projectId: 'projc', runId: 'runc', source: 'bridge', type: 'run.created', payload: {} });
    s.appendEvent({ projectId: 'projc', runId: 'runc', source: 'bridge', type: 'run.state', payload: {} });

    const cp = s.createCheckpoint({ kind: 'workspace', id: null }, 'smoke');
    check('the checkpoint captured a stream head',
      cp.streamHeads.some((h) => h.streamKey === 'projc~runc' && h.sequence === 2), JSON.stringify(cp.streamHeads));
    check('the checkpoint referenced the project record',
      cp.recordRefs.some((r) => r.kind === 'project' && r.id === 'projc' && r.hash !== null));
    check('the checkpoint is marked complete', cp.complete === true);
    check('listCheckpoints finds it', s.listCheckpoints().some((c) => c.id === cp.id));
    // A workspace-scoped checkpoint belongs to the bridge, so its event lands
    // on the bridge stream rather than any one project's stream.
    check('a checkpoint.created event was written to the bridge stream',
      s.readEvents({ projectId: '__bridge__', runId: null, types: ['checkpoint.created'] }).events.length === 1);
    const projectCp = s.createCheckpoint({ kind: 'project', id: 'projc' }, 'project scope');
    check('a project-scoped checkpoint emits on that project stream',
      s.readEvents({ projectId: 'projc', runId: null, types: ['checkpoint.created'] }).events.length === 1,
      projectCp.id);
    check('a project-scoped checkpoint only captures that project\'s streams',
      projectCp.streamHeads.every((h) => h.streamKey.startsWith('projc~')), JSON.stringify(projectCp.streamHeads));

    const read1 = s.readCheckpoint(cp.id);
    check('an untouched workspace is restorable', read1.restorable === true, JSON.stringify(read1.issues));

    s.saveRecord('project', { ...project('projc', 'C renamed'), createdAt: cp.createdAt });
    const read2 = s.readCheckpoint(cp.id);
    check('a changed record makes the checkpoint not restorable', read2.restorable === false);
    check('and the change is named as a hash mismatch',
      read2.refs.some((r) => r.ref.id === 'projc' && r.state === 'HASH_MISMATCH'), JSON.stringify(read2.refs.map((r) => r.state)));

    s.appendEvent({ projectId: 'projc', runId: 'runc', source: 'bridge', type: 'run.state', payload: {} });
    const read3 = s.readCheckpoint(cp.id);
    check('appending past the head keeps the stream reachable',
      read3.streams.every((st) => st.reachable === true), JSON.stringify(read3.streams));
  } finally {
    s.close();
  }
}

section('store.ts — a store without the lock never writes');
{
  const ws = join(scratch, 'ws-readonly');
  const seed = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'ro-seed' });
  seed.appendEvent({ projectId: 'projro', runId: 'runro', source: 'bridge', type: 'run.created', payload: {} });
  seed.close();
  const f = join(ws, 'events', 'projro~runro.jsonl');
  appendFileSync(f, '{"eventId":"half","sche');
  // The lock holder legitimately records the damage; snapshot AFTER it has.
  const holder = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'ro-holder' });
  const snapshot = () =>
    readdirSync(join(ws, 'events')).sort().map((f) => `${f}:${readFileSync(join(ws, 'events', f), 'utf8').length}`).join(',');
  const before = snapshot();

  const ro = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'ro-reader', acquireLock: false });
  try {
    check('the lock-free store still reports the damage it found',
      ro.degradedNotes().some((n) => n.reason === 'jsonl.truncated-tail'), JSON.stringify(ro.degradedNotes()));
    check('but it added not one byte to any event log', snapshot() === before,
      `${before}  ->  ${snapshot()}`);
    let threw = null;
    try { ro.reconcileOnStartup(); } catch (err) { threw = err; }
    check('and it refuses to reconcile without the lock', threw !== null && threw.name === 'StoreLockError',
      threw ? threw.name : 'nothing thrown');
  } finally {
    ro.close();
    holder.close();
  }
}

section('store.ts — stats');
{
  const ws = join(scratch, 'ws-stats');
  const s = store.ForgeStore.open({ dataDir: ws, bridgeInstanceId: 'stats-A' });
  try {
    s.appendEvent({ projectId: 'projs', source: 'bridge', type: 'bridge.ready', payload: {} });
    const st = s.stats();
    check('stats counts the persisted event', st.eventsPersisted === 1, JSON.stringify(st));
    check('stats reports the lock is held', st.lockHeld === true);
    check('stats reports a last event time', typeof st.lastEventAt === 'string');
  } finally {
    s.close();
  }
}

console.log(`\n=== ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  ! ${f}`);
}
rmSync(scratch, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
