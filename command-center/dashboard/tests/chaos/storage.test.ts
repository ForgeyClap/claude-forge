/**
 * Chaos — storage crash simulation (mission section H).
 *
 * Real modules, real files, throwaway directories: every workspace here is an
 * `mkdtemp` under the OS temp dir, passed explicitly as `dataDir`, so neither
 * the repository's `.forge-workspace` nor any user project is ever touched.
 *
 * The four crashes being simulated:
 *
 *  1. POWER LOSS MID-APPEND. The last JSONL line is cut in half. The store must
 *     drop exactly that line, keep every earlier line, record a degraded note
 *     naming the file and the line, and leave the damaged bytes on disk. The
 *     three failure modes it must NOT have: discarding the log, silently
 *     dropping more than the damaged line, or reporting success.
 *
 *  2. CRASH MID-WRITE OF A RECORD. `writeAtomic` writes to a temp file, fsyncs,
 *     then renames. A crash therefore leaves either the old complete file or the
 *     new complete file, plus possibly a `.tmp` fragment. No reader may ever be
 *     handed the fragment, and a write that fails must leave no litter.
 *
 *  3. TWO BRIDGE INSTANCES. Taking the lock twice must be refused while the
 *     holder is live, and taken over — with the takeover recorded — when the
 *     holder is provably dead or its heartbeat has gone stale.
 *
 *  4. THE BRIDGE DIED WHILE A RUN CLAIMED TO BE RUNNING. Reconciliation must
 *     move it to INTERRUPTED or ORPHANED. Never COMPLETED. Never left RUNNING.
 *
 * One case below is marked KNOWN DEFECT. It asserts what the code does today,
 * not what it should do, and says so in full. Encoding the bug is how the suite
 * stays honest while `src/bridge/**` is owned by another work package.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  DEFAULT_LOCK_STALE_MS,
  acquireLock,
  isPidAlive,
  readJsonSafe,
  readLock,
  releaseLock,
  renewLock,
  writeAtomic,
  writeJsonAtomic,
} from '../../src/bridge/storage/atomic.ts';
import { ForgeStore, StoreLockError } from '../../src/bridge/storage/store.ts';
import type { StoreOptions } from '../../src/bridge/storage/store.ts';
import { LIVE_RUN_STATUSES, isTerminalRunStatus } from '../../src/bridge/storage/schema.ts';
import type { RunRecord } from '../../src/bridge/storage/schema.ts';
import type { OperationalStatus, ProjectRecord } from '../../src/shared/protocol.ts';

/* ------------------------------------------------------------------ fixtures */

/**
 * A pid that is not running. Asserted, never assumed — if the OS ever handed
 * this number to a live process the tests below would be measuring nothing, and
 * they would say so instead of passing for the wrong reason.
 */
const DEAD_PID = 4_000_001;

let scratchDirs: string[] = [];
let openStores: ForgeStore[] = [];

function workspace(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-chaos-${label}-`));
  if (!resolve(dir).startsWith(resolve(tmpdir()))) {
    throw new Error(`refusing to run: the scratch workspace ${dir} is not under the OS temp directory`);
  }
  scratchDirs.push(dir);
  return dir;
}

function openAt(dir: string, bridgeInstanceId: string, extra: StoreOptions = {}): ForgeStore {
  const store = ForgeStore.open({ dataDir: dir, bridgeInstanceId, ...extra });
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* closing twice is documented as safe; a test may already have closed it */
    }
  }
  openStores = [];
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

/* ------------------------------------------------------------------- helpers */

const nowIso = (): string => new Date().toISOString();

function streamPath(dir: string, streamKey: string): string {
  return join(dir, 'events', `${streamKey}.jsonl`);
}

function projectRecord(id: string, displayName: string, root: string): ProjectRecord {
  return {
    id,
    displayName,
    slug: id,
    canonicalPath: join(root, id),
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

function runRecord(id: string, status: OperationalStatus, pid: number | null, owner: string | null): RunRecord {
  return {
    id,
    projectId: 'projr',
    conversationId: null,
    sessionId: null,
    goal: 'a goal that was never finished',
    status,
    statusReason: 'the bridge recorded this and then stopped',
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

/** Cut the final line of a JSONL file in half, exactly as a power loss would. */
function truncateFinalLineMidRecord(path: string): { readonly cutAt: number; readonly originalBytes: number } {
  const text = readFileSync(path, 'utf8');
  const lastNewline = text.lastIndexOf('\n', text.length - 2);
  const finalLineLength = text.length - lastNewline - 2;
  const cutAt = lastNewline + 1 + Math.floor(finalLineLength / 2);
  if (cutAt <= lastNewline + 1 || cutAt >= text.length - 1) {
    throw new Error(`the computed truncation point ${cutAt} is not inside the final line`);
  }
  truncateSync(path, cutAt);
  return { cutAt, originalBytes: text.length };
}

function tempLitter(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

/* ========================================================================== */
/*  1. A power loss mid-append                                                 */
/* ========================================================================== */

describe('a JSONL log whose final line was cut in half', () => {
  function seedFive(dir: string): string {
    const seed = openAt(dir, 'seed');
    for (let i = 1; i <= 5; i += 1) {
      seed.appendEvent({
        projectId: 'projt',
        runId: 'runt',
        source: 'bridge',
        type: 'run.state',
        payload: { i, note: 'a payload long enough that half of it is not valid JSON' },
      });
    }
    seed.close();
    return streamPath(dir, 'projt~runt');
  }

  it('drops ONLY the damaged line and keeps every earlier event intact', () => {
    const dir = workspace('trunc');
    const path = seedFive(dir);
    truncateFinalLineMidRecord(path);

    const store = openAt(dir, 'trunc-reader');
    const page = store.readEvents({ projectId: 'projt', runId: 'runt' });

    expect(page.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(page.events.map((e) => (e.payload as { i: number }).i)).toEqual([1, 2, 3, 4]);
    // Four of five: the log was not discarded, and no extra line went with it.
    expect(store.detectGaps('projt~runt')).toHaveLength(0);
  });

  it('records a degraded note that names the file and the line, and says only that line went', () => {
    const dir = workspace('trunc-note');
    const path = seedFive(dir);
    truncateFinalLineMidRecord(path);

    const store = openAt(dir, 'trunc-note-reader');
    const notes = store.degradedNotes().filter((note) => note.reason === 'jsonl.truncated-tail');

    expect(notes).toHaveLength(1);
    expect(notes[0].detail).toContain('projt~runt');
    expect(notes[0].detail).toContain('line 5');
    expect(notes[0].detail).toContain('Only that line was dropped');
    expect(notes[0].evidenceRefs[0].kind).toBe('file');
    expect(notes[0].evidenceRefs[0].ref).toContain('#L5');

    // The note is persisted as a real event, with the status spelled out.
    const degraded = store.readEvents({
      projectId: '__bridge__',
      runId: null,
      types: ['bridge.degraded'],
      limit: 100,
    }).events;
    const event = degraded.find((e) => (e.payload as { reason: string }).reason === 'jsonl.truncated-tail');
    expect(event).toBeDefined();
    expect(event?.status).toBe('DEGRADED');
    expect(store.stats().degradedNotes).toBeGreaterThanOrEqual(1);
  });

  it('never rewrites or deletes the damaged log — the bytes stay as evidence', () => {
    const dir = workspace('trunc-evidence');
    const path = seedFive(dir);
    const { cutAt } = truncateFinalLineMidRecord(path);
    const bytesAfterCrash = readFileSync(path);
    expect(bytesAfterCrash.byteLength).toBe(cutAt);

    const store = openAt(dir, 'trunc-evidence-reader');
    store.readEvents({ projectId: 'projt', runId: 'runt' });
    store.reconcileOnStartup();

    expect(readFileSync(path).equals(bytesAfterCrash)).toBe(true);
    // The half record is still there, unparseable and unhidden.
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(false);
  });

  it('does not pretend the log is fine: the damage reaches both the page and the log', () => {
    const dir = workspace('trunc-honesty');
    const path = seedFive(dir);
    truncateFinalLineMidRecord(path);

    const store = openAt(dir, 'trunc-honesty-reader');
    const page = store.readEvents({ projectId: 'projt', runId: 'runt' });

    expect(page.issues.map((issue) => issue.reason)).toContain('jsonl.truncated-tail');
    expect(page.issues[0].detail).toContain('unterminated');
    expect(store.degradedNotes().length).toBeGreaterThan(0);
  });

  it('the same damage found on a second boot does not produce a second event', () => {
    const dir = workspace('trunc-idempotent');
    const path = seedFive(dir);
    truncateFinalLineMidRecord(path);

    const first = openAt(dir, 'trunc-boot-1');
    first.close();
    const second = openAt(dir, 'trunc-boot-2');

    const events = second.readEvents({
      projectId: '__bridge__',
      runId: null,
      types: ['bridge.degraded'],
      limit: 100,
    }).events;
    const tailNotes = events.filter((e) => (e.payload as { reason: string }).reason === 'jsonl.truncated-tail');
    expect(tailNotes).toHaveLength(1);
  });

  /*
   * KNOWN DEFECT — reported, not papered over.
   *
   * `appendLineDurable` (src/bridge/storage/atomic.ts) writes `line + "\n"` in
   * append mode without first checking that the file ends with a newline. After
   * a crash that left an unterminated final line, the next append is therefore
   * GLUED ONTO THE FRAGMENT: `appendEvent` returns a result claiming sequence
   * N+1, the in-memory index counts it, but on disk the two are fused into one
   * unparseable line and the event is lost. On the next boot the stream's
   * highest readable sequence is N again, so the store will hand out N+1 a
   * second time.
   *
   * The correct behaviour would be for `appendLineDurable` to terminate a
   * dangling final line before appending (or for the store to refuse to append
   * to a stream it has flagged `jsonl.truncated-tail` until it is repaired).
   *
   * The assertions below pin the CURRENT behaviour so the defect cannot vanish
   * unnoticed. When atomic.ts is fixed this test will fail — that is the point;
   * invert it then.
   */
  it('KNOWN DEFECT: the first append after a truncated tail is fused with the fragment and lost', () => {
    const dir = workspace('trunc-defect');
    const path = seedFive(dir);
    truncateFinalLineMidRecord(path);

    const store = openAt(dir, 'trunc-defect-writer');
    const appended = store.appendEvent({
      projectId: 'projt',
      runId: 'runt',
      source: 'bridge',
      type: 'run.state',
      payload: { i: 6 },
    });

    // What the caller is told:
    expect(appended.deduplicated).toBe(false);
    expect(appended.event.sequence).toBe(5);

    // What is actually on disk: the fragment and the new event share one line,
    // so the new event cannot be read back.
    const physicalLines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    expect(physicalLines).toHaveLength(5);
    expect(physicalLines[4]).toContain('"i":6');
    expect(() => JSON.parse(physicalLines[4])).toThrow();

    const page = store.readEvents({ projectId: 'projt', runId: 'runt' });
    expect(page.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(page.issues.map((i) => i.reason)).toContain('jsonl.corrupt-line');
    store.close();

    // And after a restart the store re-issues the sequence it already handed out.
    const reopened = openAt(dir, 'trunc-defect-reader');
    expect(reopened.readEvents({ projectId: 'projt', runId: 'runt' }).events.map((e) => e.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      reopened.appendEvent({ projectId: 'projt', runId: 'runt', source: 'bridge', type: 'run.state', payload: {} })
        .event.sequence,
    ).toBe(5);
  });
});

/* ========================================================================== */
/*  2. An interrupted atomic write                                             */
/* ========================================================================== */

describe('an interrupted atomic write', () => {
  it('a write that fails leaves no temp litter and does not touch what was there', () => {
    const dir = workspace('atomic-fail');
    const blocked = join(dir, 'blocked.json');
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, 'keep.txt'), 'still here');

    // renaming a file over an existing non-empty directory cannot succeed, so
    // this exercises the failure path after the temp file has been written.
    expect(() => writeAtomic(blocked, '{"replacement":true}')).toThrow(/writeAtomic failed/);

    expect(tempLitter(dir)).toHaveLength(0);
    expect(readdirSync(blocked)).toEqual(['keep.txt']);
    expect(readFileSync(join(blocked, 'keep.txt'), 'utf8')).toBe('still here');
  });

  it('a fragment left behind by a crash between the temp write and the rename is never readable as a record', () => {
    const dir = workspace('atomic-fragment');
    const store = openAt(dir, 'frag');
    store.saveRecord('project', projectRecord('p1', 'Original', dir));

    // Exactly the shape writeAtomic uses: a dotfile beside the target, ending .tmp.
    const recordsDir = join(dir, 'records', 'project');
    const fragment = join(recordsDir, `.p1.json.${process.pid}.9.deadbeef.tmp`);
    writeFileSync(fragment, '{"kind":"project","id":"p1","schemaVersion":1,"record":{"id":"p1","displayNam');

    // The previous complete record is what a reader gets. Always.
    const read = store.getRecord('project', 'p1');
    expect(read.ok).toBe(true);
    expect(read.ok && read.record.displayName).toBe('Original');

    // The fragment is invisible to every listing path...
    expect(store.listRecordIds('project')).toEqual(['p1']);
    expect(store.listRecords('project').records).toHaveLength(1);
    expect(store.listRecords('project').unreadable).toHaveLength(0);

    // ...and unusable even if something did reach for it.
    const fragmentRead = readJsonSafe(fragment);
    expect(fragmentRead.ok).toBe(false);
    expect(fragmentRead.ok === false && fragmentRead.reason).toBe('MALFORMED_JSON');
  });

  it('every intermediate state of a repeatedly overwritten record is a complete document', () => {
    const dir = workspace('atomic-loop');
    const target = join(dir, 'record.json');
    const rounds = 120;

    for (let i = 0; i < rounds; i += 1) {
      const value = { round: i, filler: 'x'.repeat(i * 7), nested: { ok: true, seen: i } };
      const result = writeJsonAtomic(target, value);

      expect(result.fileSynced).toBe(true);
      // Honesty about durability: the directory fsync is best effort and the
      // result reports what was actually achieved rather than claiming it.
      expect(typeof result.directorySynced).toBe('boolean');

      const read = readJsonSafe<typeof value>(target);
      expect(read.ok).toBe(true);
      // Never a prefix, never a mix of two versions: exactly what was written.
      expect(read.ok && read.value).toEqual(value);
      expect(tempLitter(dir)).toHaveLength(0);
    }
  });

  it('a record file that IS half written is reported as corrupt rather than parsed optimistically', () => {
    const dir = workspace('atomic-halfrecord');
    const store = openAt(dir, 'half');
    store.saveRecord('project', projectRecord('p1', 'Original', dir));

    // Simulate the one thing writeAtomic is designed to make impossible, to
    // prove the read path still refuses it rather than guessing.
    writeFileSync(join(dir, 'records', 'project', 'p2.json'), '{"kind":"project","id":"p2","schemaVer');

    const read = store.getRecord('project', 'p2');
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toBe('CORRUPT');

    const listed = store.listRecords('project');
    expect(listed.records.map((r) => r.id)).toEqual(['p1']);
    expect(listed.unreadable.map((u) => u.id)).toEqual(['p2']);
  });
});

/* ========================================================================== */
/*  3. Taking the lock twice                                                   */
/* ========================================================================== */

describe('taking the workspace lock twice', () => {
  it('refuses the second acquisition while the holder is live, and names the holder', () => {
    const dir = workspace('lock-held');
    const first = openAt(dir, 'lock-A');
    expect(first.lockHeld).toBe(true);

    let thrown: unknown = null;
    try {
      openAt(dir, 'lock-B');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StoreLockError);
    expect((thrown as StoreLockError).heldBy?.pid).toBe(process.pid);
    expect((thrown as Error).message).toContain('could not acquire the workspace lock');
  });

  it('acquireLock itself reports HELD rather than corrupting a live holder', () => {
    const dir = workspace('lock-direct');
    const path = join(dir, 'bridge.lock');

    const first = acquireLock(path, { staleMs: DEFAULT_LOCK_STALE_MS, owner: 'first' });
    expect(first.ok).toBe(true);

    const second = acquireLock(path, { staleMs: DEFAULT_LOCK_STALE_MS, owner: 'second' });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('HELD');
    expect(second.ok === false && second.heldBy?.pid).toBe(process.pid);
    expect(second.ok === false && second.detail).toContain('heartbeat is fresh');

    // The live holder's own token is untouched by the failed attempt.
    const onDisk = readLock(path);
    expect(onDisk.ok && first.ok && onDisk.value.token).toBe(first.ok ? first.handle.token : '');
    if (first.ok) expect(releaseLock(first.handle)).toBe(true);
  });

  it('takes over a lock whose holder pid is not running, and records the takeover', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false); // precondition, asserted not assumed

    const dir = workspace('lock-dead');
    const path = join(dir, 'bridge.lock');
    writeJsonAtomic(path, {
      pid: DEAD_PID,
      token: 'ghost-token',
      acquiredAt: nowIso(),
      heartbeatAt: nowIso(),
      owner: 'forge-bridge:ghost',
      lockVersion: 1,
    });

    const result = acquireLock(path, { staleMs: DEFAULT_LOCK_STALE_MS, owner: 'survivor' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.handle.tookOverFrom?.pid).toBe(DEAD_PID);
    expect(result.ok && result.handle.takeoverReason).toContain('not running');
    expect(result.ok && result.handle.token).not.toBe('ghost-token');
    if (result.ok) expect(releaseLock(result.handle)).toBe(true);
  });

  it('takes over a lock whose heartbeat has gone stale, even when the pid is this process', () => {
    const dir = workspace('lock-stale');
    const path = join(dir, 'bridge.lock');
    const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    writeJsonAtomic(path, {
      pid: process.pid,
      token: 'stale-token',
      acquiredAt: longAgo,
      heartbeatAt: longAgo,
      owner: 'forge-bridge:previous-boot',
      lockVersion: 1,
    });

    const result = acquireLock(path, { staleMs: DEFAULT_LOCK_STALE_MS, owner: 'survivor' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.handle.takeoverReason).toContain('heartbeat is');
    expect(result.ok && result.handle.takeoverReason).toContain('limit 30000ms');
    if (result.ok) expect(releaseLock(result.handle)).toBe(true);
  });

  it('the store turns a stale takeover into a degraded note rather than a silent recovery', () => {
    const dir = workspace('lock-note');
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(join(dir, 'bridge.lock'), {
      pid: DEAD_PID,
      token: 'ghost-token',
      acquiredAt: nowIso(),
      heartbeatAt: nowIso(),
      owner: 'forge-bridge:ghost',
      lockVersion: 1,
    });

    const store = openAt(dir, 'takeover');
    const notes = store.degradedNotes().filter((note) => note.reason === 'lock.stale-takeover');
    expect(notes).toHaveLength(1);
    expect(notes[0].detail).toContain(String(DEAD_PID));

    const recorded = store
      .readEvents({ projectId: '__bridge__', runId: null, types: ['bridge.degraded'], limit: 50 })
      .events.map((e) => (e.payload as { reason: string }).reason);
    expect(recorded).toContain('lock.stale-takeover');
  });

  it('a handle that no longer owns the lock can neither renew nor release it', () => {
    const dir = workspace('lock-foreign');
    const path = join(dir, 'bridge.lock');
    const mine = acquireLock(path, { staleMs: DEFAULT_LOCK_STALE_MS, owner: 'mine' });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    expect(renewLock(mine.handle)).toBe(true);

    // Someone else took over between our heartbeats.
    const current = readLock(path);
    expect(current.ok).toBe(true);
    if (current.ok) writeJsonAtomic(path, { ...current.value, token: 'someone-else' });

    expect(renewLock(mine.handle)).toBe(false);
    expect(releaseLock(mine.handle)).toBe(false);
    // The other holder's lock file is left strictly alone.
    const after = readLock(path);
    expect(after.ok && after.value.token).toBe('someone-else');
  });

  it('the workspace opens again once the first store closes', () => {
    const dir = workspace('lock-reopen');
    const first = openAt(dir, 'reopen-A');
    first.close();
    const second = openAt(dir, 'reopen-B');
    expect(second.lockHeld).toBe(true);
  });

  it('a store opened without the lock refuses to reconcile', () => {
    const dir = workspace('lock-readonly');
    const holder = openAt(dir, 'holder');
    expect(holder.lockHeld).toBe(true);

    const reader = openAt(dir, 'reader', { acquireLock: false });
    expect(reader.lockHeld).toBe(false);
    expect(() => reader.reconcileOnStartup()).toThrow(StoreLockError);
  });
});

/* ========================================================================== */
/*  4. Reconciling a run that still claims to be RUNNING                       */
/* ========================================================================== */

describe('reconcileOnStartup with a persisted RUNNING run', () => {
  it('moves a RUNNING run whose pid is dead to INTERRUPTED — never COMPLETED, never still RUNNING', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);

    const dir = workspace('recon-dead');
    const seed = openAt(dir, 'boot-1');
    seed.saveRecord('run', runRecord('run-dead', 'RUNNING', DEAD_PID, 'boot-1'));
    seed.close();

    const store = openAt(dir, 'boot-2');
    const report = store.reconcileOnStartup();
    const reconciled = report.reconciled.find((r) => r.runId === 'run-dead');

    expect(reconciled).toBeDefined();
    expect(reconciled?.from).toBe('RUNNING');
    expect(reconciled?.to).toBe('INTERRUPTED');
    expect(reconciled?.pidAlive).toBe(false);
    expect(reconciled?.reason).toContain('no exit was recorded');
    expect(report.reconciled.every((r) => r.to !== 'COMPLETED')).toBe(true);

    const onDisk = store.getRecord('run', 'run-dead');
    expect(onDisk.ok).toBe(true);
    if (!onDisk.ok) return;
    expect(onDisk.record.status).toBe('INTERRUPTED');
    expect(onDisk.record.status).not.toBe('RUNNING');
    expect(isTerminalRunStatus(onDisk.record.status)).toBe(true);
    expect(onDisk.record.endedAt).not.toBeNull();
    expect(onDisk.record.ownerBridgeInstanceId).toBeNull();
    // No exit code was ever observed, so none is invented.
    expect(onDisk.record.exitCode).toBeNull();

    const stateEvents = store.readEvents({ projectId: 'projr', runId: 'run-dead', types: ['run.state'] }).events;
    expect(stateEvents).toHaveLength(1);
    expect(stateEvents[0].status).toBe('INTERRUPTED');
    expect((stateEvents[0].payload as { from: string; to: string }).from).toBe('RUNNING');
    expect((stateEvents[0].payload as { pidAlive: boolean | null }).pidAlive).toBe(false);
  });

  it('carries evidence for the change, including the absence of an exit code', () => {
    const dir = workspace('recon-evidence');
    const seed = openAt(dir, 'ev-1');
    seed.saveRecord('run', runRecord('run-dead', 'RUNNING', DEAD_PID, 'ev-1'));
    seed.close();

    const store = openAt(dir, 'ev-2');
    const reconciled = store.reconcileOnStartup().reconciled[0];

    expect(reconciled.evidenceRefs.length).toBeGreaterThan(0);
    const exitRef = reconciled.evidenceRefs.find((ref) => ref.kind === 'exit-code');
    expect(exitRef?.ref).toBe('none-recorded');
    expect(exitRef?.note).toContain('no exit code was ever captured');
    expect(reconciled.evidenceRefs.some((ref) => ref.kind === 'event')).toBe(true);
  });

  it('moves a run with no pid at all to ORPHANED, because nothing could ever have proved it', () => {
    const dir = workspace('recon-nopid');
    const seed = openAt(dir, 'np-1');
    seed.saveRecord('run', runRecord('run-nopid', 'RUNNING', null, 'np-1'));
    seed.close();

    const store = openAt(dir, 'np-2');
    const reconciled = store.reconcileOnStartup().reconciled.find((r) => r.runId === 'run-nopid');

    expect(reconciled?.to).toBe('ORPHANED');
    expect(reconciled?.pidAlive).toBeNull(); // "could not be determined", not false
    expect(reconciled?.reason).toContain('no process id was recorded');
  });

  it('moves a run whose pid is alive but unowned to ORPHANED, because pids are reused', () => {
    const dir = workspace('recon-alive');
    const seed = openAt(dir, 'al-1');
    seed.saveRecord('run', runRecord('run-alive', 'RUNNING', process.pid, 'al-1'));
    seed.close();

    const store = openAt(dir, 'al-2');
    const reconciled = store.reconcileOnStartup().reconciled.find((r) => r.runId === 'run-alive');

    expect(reconciled?.to).toBe('ORPHANED');
    expect(reconciled?.pidAlive).toBe(true);
    expect(reconciled?.reason).toContain('process ids are reused');
  });

  it('never produces COMPLETED and never leaves a live status, for ANY live status', () => {
    const dir = workspace('recon-all');
    const seed = openAt(dir, 'all-1');
    const ids = LIVE_RUN_STATUSES.map((status) => `run-${status.toLowerCase()}`);
    LIVE_RUN_STATUSES.forEach((status, index) => {
      seed.saveRecord('run', runRecord(ids[index], status, DEAD_PID, 'all-1'));
    });
    seed.close();

    const store = openAt(dir, 'all-2');
    const report = store.reconcileOnStartup();

    expect(report.reconciled).toHaveLength(LIVE_RUN_STATUSES.length);
    for (const reconciliation of report.reconciled) {
      expect(reconciliation.to).not.toBe('COMPLETED');
      expect(reconciliation.to).toBe('INTERRUPTED');
      expect(isTerminalRunStatus(reconciliation.to)).toBe(true);
      expect(reconciliation.reason.length).toBeGreaterThan(0);
    }
    for (const id of ids) {
      const record = store.getRecord('run', id);
      expect(record.ok).toBe(true);
      if (!record.ok) continue;
      expect(isTerminalRunStatus(record.record.status)).toBe(true);
      expect(record.record.status).not.toBe('COMPLETED');
      expect(record.record.endedAt).not.toBeNull();
      expect(record.record.ownerBridgeInstanceId).toBeNull();
    }
  });

  it('leaves an already terminal run alone and is a no-op on the second boot', () => {
    const dir = workspace('recon-idempotent');
    const seed = openAt(dir, 'id-1');
    seed.saveRecord('run', {
      ...runRecord('run-done', 'COMPLETED', DEAD_PID, null),
      endedAt: nowIso(),
      exitCode: 0,
    });
    seed.saveRecord('run', runRecord('run-live', 'RUNNING', DEAD_PID, 'id-1'));
    seed.close();

    const store = openAt(dir, 'id-2');
    const first = store.reconcileOnStartup();
    expect(first.reconciled.map((r) => r.runId)).toEqual(['run-live']);
    expect(store.getRecord('run', 'run-done').ok && store.getRecord('run', 'run-done')).toBeTruthy();

    const done = store.getRecord('run', 'run-done');
    expect(done.ok && done.record.status).toBe('COMPLETED');
    expect(done.ok && done.record.exitCode).toBe(0);

    const second = store.reconcileOnStartup();
    expect(second.reconciled).toHaveLength(0);
  });

  it('reports a run record it cannot read as UNKNOWN instead of skipping it silently', () => {
    const dir = workspace('recon-unreadable');
    const seed = openAt(dir, 'un-1');
    seed.saveRecord('run', runRecord('run-ok', 'RUNNING', DEAD_PID, 'un-1'));
    seed.close();
    writeFileSync(join(dir, 'records', 'run', 'run-broken.json'), '{"kind":"run","id":"run-broken","sch');

    const store = openAt(dir, 'un-2');
    const report = store.reconcileOnStartup();

    expect(report.runsUnreadable.map((r) => r.id)).toEqual(['run-broken']);
    expect(report.runsUnreadable[0].detail).toContain('CORRUPT');
    expect(report.corruption.some((note) => note.reason === 'run.unreadable')).toBe(true);
    // The readable one was still handled.
    expect(report.reconciled.map((r) => r.runId)).toEqual(['run-ok']);
  });
});
