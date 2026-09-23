/**
 * Two leaks on the stderr path of `ClaudeAdapter`, both inside `consumeStderr`.
 *
 * (D) CHUNK-BOUNDARY ESCAPE. stderr arrives as arbitrary chunks — the OS decides where the split
 *     lands, not the writer. `safeExcerpt(chunk, 1000)` redacted each chunk INDEPENDENTLY, so a
 *     credential that straddles the seam was incomplete in both halves, matched no pattern in
 *     either, and went out verbatim in two pieces. This is NOT the cap-before-redact ordering bug
 *     fixed on 2026-08-01 (tests/unit/excerpt-redaction-order.test.ts): that one was one value being
 *     sliced, this one is two calls that never see the whole token. The fix is a hand-over buffer.
 *
 * (E) RAW STDERR ON DISK. `this.appendEvidence(entry, 'stderr', chunk)` appended the UNREDACTED
 *     chunk to `<evidenceDir>/<runId>/stderr.log`. The comment called it deliberate ("the full
 *     capture is in the evidence file"), and the forensic intent is real — but a live API token in
 *     plain text on disk is a credential at rest that nobody chose to store.
 *
 * The adapter is driven for real: a scripted child is handed to it through the documented TEST-ONLY
 * `spawnChild` seam, so the chunk boundary under test is the actual boundary the adapter sees, and
 * the evidence file assertions read the actual file the adapter wrote.
 *
 * WHY NOT `vi.mock('node:child_process')`: verified on 2026-08-02 in this repo — the mock is applied
 * to the test file's own import but NOT to `src/bridge/claude/adapter.ts`, which kept calling the
 * real `spawn` (proven with a probe that spawned a nonexistent binary and got a live ENOENT). The
 * seam is the only way to reach this code path from a test.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../../src/bridge/claude/adapter.ts';
import type { AdapterOptions } from '../../src/bridge/claude/adapter.ts';
import type { LocatedClaude } from '../../src/bridge/claude/locate.ts';
import type { ForgeEventDraft } from '../../src/bridge/claude/parse.ts';

/* ------------------------------------------------------------------ fixtures */

/** JWT-shaped. Not a real credential: three base64url segments is what the detector keys on. */
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkZvcmdlIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

/** The split lands mid-token: the first half carries two of the three JWT segments, which matches
 *  nothing, and the second half starts mid-segment, which also matches nothing. */
const SPLIT_AT = 45;
const JWT_HEAD = JWT.slice(0, SPLIT_AT);
const JWT_TAIL = JWT.slice(SPLIT_AT);

interface FakeStream extends EventEmitter {
  setEncoding: (enc: string) => void;
}

/** The minimum surface `wire()` touches. Nothing here starts a process. */
function fakeChild(): ChildProcess & { stdout: FakeStream; stderr: FakeStream } {
  const makeStream = (): FakeStream => {
    const stream = new EventEmitter() as FakeStream;
    stream.setEncoding = () => undefined;
    return stream;
  };
  const child = new EventEmitter() as unknown as ChildProcess & { stdout: FakeStream; stderr: FakeStream };
  Object.assign(child, { pid: 4242, stdout: makeStream(), stderr: makeStream(), kill: () => true });
  return child;
}

const dirs: string[] = [];

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-stderr-${label}-`));
  dirs.push(dir);
  return dir;
}

function located(executablePath: string): LocatedClaude {
  return {
    executablePath,
    source: 'path-entry',
    version: '2.1.217',
    versionRaw: '2.1.217 (Claude Code)',
    flags: new Set<string>(['-p', '--print', '--output-format', '--permission-mode', '--verbose']),
    choices: new Map<string, readonly string[]>([
      ['--output-format', ['text', 'json', 'stream-json']],
      ['--permission-mode', ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan']],
    ]),
    descriptions: new Map(),
    probedAt: new Date().toISOString(),
    candidatesConsidered: [],
    notes: [],
  };
}

interface Harness {
  readonly drafts: ForgeEventDraft[];
  readonly stderrIn: (chunk: string) => void;
  readonly stderrLog: () => string;
  readonly close: () => Promise<void>;
}

function startRun(label: string, overrides: Partial<AdapterOptions> = {}, runId = 'run-1'): Harness {
  const root = tempRoot(label);
  const projectPath = join(root, 'project');
  mkdirSync(projectPath, { recursive: true });
  const evidenceDir = join(root, 'evidence');

  const child = fakeChild();
  const drafts: ForgeEventDraft[] = [];
  const adapter = new ClaudeAdapter({
    located: located(join(root, 'claude.exe')),
    trustedRoot: resolve(root),
    evidenceDir,
    emit: (draft) => drafts.push(draft),
    spawnChild: (() => child) as unknown as AdapterOptions['spawnChild'],
    ...overrides,
  });

  const handle = adapter.start({
    runId,
    projectId: 'proj-1',
    projectPath,
    conversationId: null,
    prompt: 'hello',
    permissionMode: 'acceptEdits',
  });

  return {
    drafts,
    stderrIn: (chunk) => child.stderr.emit('data', chunk),
    stderrLog: () => readFileSync(join(evidenceDir, runId, 'stderr.log'), 'utf8'),
    close: async () => {
      child.emit('close', 0, null);
      await handle.completed;
    },
  };
}

function stderrExcerpts(drafts: readonly ForgeEventDraft[]): string {
  return drafts
    .filter((d) => d.type === 'claude.stderr')
    .map((d) => String((d.payload as { excerpt?: unknown }).excerpt ?? ''))
    .join('\n');
}

function totalRedactions(drafts: readonly ForgeEventDraft[]): number {
  return drafts
    .filter((d) => d.type === 'claude.stderr')
    .reduce((sum, d) => sum + Number((d.payload as { redactions?: unknown }).redactions ?? 0), 0);
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

/* --------------------------------------------------------------------- tests */

describe('(D) a secret that straddles two stderr chunks', () => {
  // GREEN BEFORE AND AFTER, on purpose. It is a counterweight, not proof: it pins that the fix did
  // not achieve its result by over-redacting, and it shows that a test written with the secret
  // inside a single chunk would have stayed green through the entire defect.
  it('CONTROL: the same secret inside ONE chunk was already redacted — a green result here proves nothing about the seam', async () => {
    const h = startRun('control');
    h.stderrIn(`auth failed: token=${JWT}\n`);
    await h.close();

    const excerpts = stderrExcerpts(h.drafts);
    expect(excerpts).toContain('[REDACTED');
    expect(excerpts).not.toContain(JWT_HEAD);
  });

  it('THE LEAK: split across the chunk boundary, neither half matched and both halves were emitted verbatim', async () => {
    const h = startRun('seam');
    h.stderrIn(`auth failed: token=${JWT_HEAD}`);
    h.stderrIn(`${JWT_TAIL}\n`);
    await h.close();

    const excerpts = stderrExcerpts(h.drafts);
    // Reassembling the event stream must not reproduce the credential.
    expect(excerpts.replace(/\n/g, '')).not.toContain(JWT);
    expect(excerpts).not.toContain(JWT_HEAD);
    expect(excerpts).not.toContain(JWT_TAIL);
    expect(excerpts).toContain('[REDACTED');
    expect(totalRedactions(h.drafts)).toBe(1);
  });

  it('a three-way split is closed too: the carry survives more than one hand-over', async () => {
    const h = startRun('seam3');
    h.stderrIn(`token=${JWT.slice(0, 20)}`);
    h.stderrIn(JWT.slice(20, 70));
    h.stderrIn(`${JWT.slice(70)} done\n`);
    await h.close();

    const excerpts = stderrExcerpts(h.drafts);
    expect(excerpts).not.toContain(JWT.slice(0, 20));
    expect(excerpts).toContain('[REDACTED:jwt]');
    expect(excerpts).toContain('done');
  });

  it('the seam is handed over ONCE: the carried tail is not emitted twice', async () => {
    const h = startRun('nodupe');
    h.stderrIn('first line\nsecond ');
    h.stderrIn('line\nthird line\n');
    await h.close();

    const excerpts = stderrExcerpts(h.drafts);
    expect(excerpts.match(/second line/g)?.length ?? 0).toBe(1);
    expect(excerpts.match(/first line/g)?.length ?? 0).toBe(1);
    expect(excerpts.match(/third line/g)?.length ?? 0).toBe(1);
    // And the evidence file must not double-write either.
    expect(h.stderrLog().match(/second line/g)?.length ?? 0).toBe(1);
  });

  it('the LAST chunk still lands: a run that ends without a trailing newline flushes its tail', async () => {
    const h = startRun('flush');
    h.stderrIn('a dangling final line with no newline');
    await h.close();

    expect(stderrExcerpts(h.drafts)).toContain('a dangling final line with no newline');
    expect(h.stderrLog()).toContain('a dangling final line with no newline');
  });

  it('a run that ends with a straddled secret and no trailing newline still redacts it at flush', async () => {
    const h = startRun('flushsecret');
    h.stderrIn(`token=${JWT_HEAD}`);
    h.stderrIn(JWT_TAIL); // no newline, then the process dies
    await h.close();

    const excerpts = stderrExcerpts(h.drafts);
    expect(excerpts).not.toContain(JWT_HEAD);
    expect(excerpts).toContain('[REDACTED:jwt]');
    expect(h.stderrLog()).not.toContain(JWT_HEAD);
    expect(h.stderrLog()).toContain('[REDACTED:jwt]');
  });

  it('a run that produces no stderr at all writes nothing and emits nothing', async () => {
    const h = startRun('silent');
    await h.close();

    expect(stderrExcerpts(h.drafts)).toBe('');
    expect(h.stderrLog()).toBe('');
  });

  it('an enormous newline-free chunk is released rather than buffered forever', async () => {
    const h = startRun('huge');
    h.stderrIn('X'.repeat(200_000));
    // No newline and no close yet: the forced release must have fired on its own.
    const emittedBeforeClose = stderrExcerpts(h.drafts);
    await h.close();

    expect(emittedBeforeClose).toContain('XXXXXXXXXX');
    // Everything arrives exactly once across the forced release and the final flush.
    expect(h.stderrLog().length).toBe(200_000);
  });

  it('the per-run event cap still holds when the chunks are line-terminated', async () => {
    const h = startRun('cap', { maxStderrEvents: 3 });
    for (let i = 0; i < 6; i += 1) h.stderrIn(`line ${String(i)}\n`);
    await h.close();

    const events = h.drafts.filter((d) => d.type === 'claude.stderr');
    expect(events.length).toBe(4); // 3 real + 1 "no longer emitted" notice
    expect(String((events[3]?.payload as { excerpt?: unknown }).excerpt)).toContain('no longer emitted as events');
    // The cap is on EVENTS only — the evidence file keeps everything.
    expect(h.stderrLog()).toContain('line 5');
  });
});

describe('(E) the evidence file must not hold a live credential', () => {
  it('THE LEAK: the raw chunk was appended to stderr.log verbatim', async () => {
    const h = startRun('evidence');
    h.stderrIn(`fatal: request rejected, token=${JWT}\n`);
    await h.close();

    const log = h.stderrLog();
    expect(log).not.toContain(JWT);
    expect(log).not.toContain(JWT_HEAD);
  });

  it('forensic value is kept: the log still shows WHERE something was and WHAT KIND it was', async () => {
    const h = startRun('forensic');
    h.stderrIn(`fatal: request rejected, token=${JWT}\n`);
    await h.close();

    const log = h.stderrLog();
    // Position and kind survive in place; only the value is gone.
    expect(log).toContain('fatal: request rejected, token=');
    expect(log).toContain('[REDACTED:jwt]');
  });

  it('the run reports HOW MANY values were scrubbed, so the loss is visible instead of silent', async () => {
    const h = startRun('tally');
    h.stderrIn(`token=${JWT} and key=sk-ant-abcdefghijklmnopqrstuvwx\n`);
    await h.close();

    expect(totalRedactions(h.drafts)).toBe(2);
    const finalState = h.drafts.filter((d) => d.type === 'run.state').at(-1);
    const stderrRef = (finalState?.evidenceRefs ?? []).find((r) => r.kind === 'stderr');
    expect(stderrRef?.note).toContain('2 secret-shaped values redacted');
  });

  it('a secret straddling the chunk boundary is redacted on disk too', async () => {
    const h = startRun('evidence-seam');
    h.stderrIn(`fatal: token=${JWT_HEAD}`);
    h.stderrIn(`${JWT_TAIL}\n`);
    await h.close();

    const log = h.stderrLog();
    expect(log).not.toContain(JWT_HEAD);
    expect(log).not.toContain(JWT_TAIL);
    expect(log).toContain('[REDACTED:jwt]');
  });

  it('a bearer header and an sk- key are scrubbed from the file as well as the event', async () => {
    const h = startRun('shapes');
    h.stderrIn('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n');
    h.stderrIn('using key sk-ant-api03-ZZZZYYYYXXXXWWWWVVVV\n');
    await h.close();

    const log = h.stderrLog();
    expect(log).not.toContain('abcdefghijklmnop');
    expect(log).not.toContain('ZZZZYYYYXXXX');
    expect(log).toContain('Authorization: Bearer [REDACTED]');
    expect(log).toContain('[REDACTED:anthropic-key]');
  });

  it('ordinary stderr is untouched — redaction must not mangle the diagnostics it exists to preserve', async () => {
    const h = startRun('plain');
    const noise = 'warning: node:xyz deprecated\n  at Object.<anonymous> (C:\\app\\index.js:12:9)\n';
    h.stderrIn(noise);
    await h.close();

    expect(h.stderrLog()).toBe(noise);
    expect(totalRedactions(h.drafts)).toBe(0);
  });

  it('a log line that already quotes "[REDACTED" does not inflate the tally', async () => {
    const h = startRun('spoof');
    h.stderrIn('previous run said: [REDACTED:jwt] and nothing else\n');
    await h.close();

    expect(totalRedactions(h.drafts)).toBe(0);
  });
});
