/**
 * Forge Workspace — durable, crash-safe local file primitives.
 *
 * This module is the only place in the storage layer that touches the file
 * system directly. It exists because of one fact: the machine can lose power in
 * the middle of a write, and when it comes back the bridge must be able to tell
 * the difference between "this data is fine" and "this data is damaged". It is
 * never allowed to guess.
 *
 * Three guarantees, and the honest limits of each:
 *
 * 1. WRITES ARE ALL-OR-NOTHING. `writeAtomic` writes to a temp file in the same
 *    directory, fsyncs it, then renames over the target. A rename within a
 *    directory is atomic on NTFS and on POSIX, so a reader sees either the old
 *    file or the new one — never half of either. The one thing we cannot always
 *    do on Windows is fsync the *directory* itself, so the result reports
 *    `directorySynced` instead of pretending the metadata was flushed.
 *
 * 2. READS NEVER THROW ON BAD DATA. `readJsonSafe` and `readJsonlSafe` return a
 *    typed result describing exactly what was wrong. Corruption is an expected
 *    state after a crash, not an exception.
 *
 * 3. THE LOCK IS ADVISORY, AND SAYS SO. `acquireLock` is a lockfile with a pid,
 *    a token and a heartbeat, plus staleness takeover. It stops two bridge
 *    instances from interleaving writes in every realistic case. It is NOT a
 *    distributed mutex: the residual race is documented on the function.
 *
 * No network. No native modules. Synchronous by design — the sequence assigner
 * in `store.ts` depends on there being no await point between "read the head"
 * and "append the line".
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';

/* ========================================================================== */
/*  Typed results                                                              */
/* ========================================================================== */

/** Why a read did not produce a usable value. Never a thrown exception. */
export type ReadFailureReason =
  | 'MISSING'
  | 'NOT_A_FILE'
  | 'EMPTY'
  | 'UNREADABLE'
  | 'MALFORMED_JSON'
  | 'NOT_AN_OBJECT';

export type ReadResult<T> =
  | { readonly ok: true; readonly value: T; readonly bytes: number }
  | {
      readonly ok: false;
      readonly reason: ReadFailureReason;
      readonly detail: string;
      /** The bytes we did manage to read, when there were any. For diagnosis. */
      readonly bytes: number;
    };

export interface AtomicWriteResult {
  readonly path: string;
  readonly bytes: number;
  /** True when the file's own contents were fsynced before the rename. */
  readonly fileSynced: boolean;
  /**
   * True only when the containing directory was also fsynced. Windows usually
   * refuses to open a directory for that, so this is commonly `false` — and we
   * report it rather than claiming a durability level we did not reach.
   */
  readonly directorySynced: boolean;
}

/* ========================================================================== */
/*  Directories and paths                                                      */
/* ========================================================================== */

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Containment check. Returns the resolved child only when it really sits under
 * `root`; otherwise returns null. Case-insensitive on win32 because NTFS is.
 *
 * This is the storage layer's own last line of defence. It does not replace the
 * bridge's path guard on the request boundary — it is the belt to that braces,
 * applied to every path this module builds.
 */
export function containedPath(root: string, child: string): string | null {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(child);
  const rootKey = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const childKey = process.platform === 'win32' ? resolvedChild.toLowerCase() : resolvedChild;
  if (childKey === rootKey) return resolvedChild;
  const prefix = rootKey.endsWith(sep) ? rootKey : rootKey + sep;
  return childKey.startsWith(prefix) ? resolvedChild : null;
}

export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Directory listing that reports emptiness instead of throwing on ENOENT. */
export function readDirSafe(dir: string): { readonly existed: boolean; readonly files: readonly string[] } {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isFile()) files.push(entry.name);
    }
    files.sort();
    return { existed: true, files };
  } catch {
    return { existed: false, files: [] };
  }
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash of a file's bytes, or null when the file cannot be read. */
export function sha256File(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/* ========================================================================== */
/*  Atomic write                                                               */
/* ========================================================================== */

let tempCounter = 0;

function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Write-to-temp, fsync, rename. A crash at any point leaves either the previous
 * complete file or the new complete file — never a half-written record.
 *
 * Throws only on a genuine I/O failure (no space, permission denied). The
 * temporary file is removed on every failure path, so a crashed write cannot
 * leave litter that a later reader could mistake for a record.
 */
export function writeAtomic(path: string, data: string | Uint8Array): AtomicWriteResult {
  const target = resolve(path);
  const dir = dirname(target);
  ensureDir(dir);

  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  tempCounter += 1;
  const tempPath = join(dir, `.${basename(target)}.${process.pid}.${tempCounter}.${randomUUID().slice(0, 8)}.tmp`);

  let fileSynced = false;
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, 'wx');
    writeSync(fd, payload, 0, payload.byteLength, 0);
    fsyncSync(fd);
    fileSynced = true;
    closeSync(fd);
    fd = null;
    renameSync(tempPath, target);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* the write already failed; a close failure adds nothing */
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      /* the temp file may never have been created */
    }
    throw new Error(`writeAtomic failed for ${target}: ${errMessage(err)}`);
  }

  // Best effort. Windows normally refuses O_RDONLY on a directory, so this is
  // expected to fail there — which is why the caller is told, not lied to.
  let directorySynced = false;
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
      directorySynced = true;
    } finally {
      closeSync(dirFd);
    }
  } catch {
    directorySynced = false;
  }

  return { path: target, bytes: payload.byteLength, fileSynced, directorySynced };
}

/** `writeAtomic` with pretty-printed JSON and a trailing newline. */
export function writeJsonAtomic(path: string, value: unknown): AtomicWriteResult {
  return writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Append one line durably: open in append mode, write, fsync, close.
 *
 * The line is written with a single `writeSync`, so the kernel is asked to
 * append it in one go. That is not a hard atomicity guarantee across all file
 * systems, which is exactly why `readJsonlSafe` knows how to recognise and drop
 * a truncated final line instead of assuming the log is fine.
 */
export function appendLineDurable(path: string, line: string): number {
  const target = resolve(path);
  ensureDir(dirname(target));
  const payload = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
  const fd = openSync(target, 'a');
  try {
    writeSync(fd, payload, 0, payload.byteLength);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return payload.byteLength;
}

/* ========================================================================== */
/*  Safe reads                                                                 */
/* ========================================================================== */

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readTextSafe(path: string): ReadResult<string> {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT') return { ok: false, reason: 'MISSING', detail: `no such file: ${path}`, bytes: 0 };
    return { ok: false, reason: 'UNREADABLE', detail: `${code ?? 'error'}: ${errMessage(err)}`, bytes: 0 };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'NOT_A_FILE', detail: `not a regular file: ${path}`, bytes: 0 };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    return { ok: true, value: stripBom(raw), bytes: stat.size };
  } catch (err) {
    return { ok: false, reason: 'UNREADABLE', detail: `${errCode(err) ?? 'error'}: ${errMessage(err)}`, bytes: stat.size };
  }
}

/**
 * Read a JSON file without throwing. A missing file, an empty file, a truncated
 * file and a file containing a JSON scalar are four different outcomes, and the
 * caller gets to see which one it hit.
 *
 * The value is NOT validated against any record contract here — that is
 * `schema.validateRecord`'s job. This function only proves the bytes parse.
 */
export function readJsonSafe<T = unknown>(path: string): ReadResult<T> {
  const text = readTextSafe(path);
  if (!text.ok) return text;
  const trimmed = text.value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'EMPTY', detail: `file is empty: ${path}`, bytes: text.bytes };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      reason: 'MALFORMED_JSON',
      detail: `${errMessage(err)} (${path})`,
      bytes: text.bytes,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'NOT_AN_OBJECT',
      detail: `expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed} (${path})`,
      bytes: text.bytes,
    };
  }
  return { ok: true, value: parsed as T, bytes: text.bytes };
}

/* -------------------------------------------------------------------- JSONL */

export type JsonlCorruptionKind = 'TRUNCATED_TAIL' | 'MALFORMED_JSON' | 'NOT_AN_OBJECT';

export interface JsonlCorruption {
  readonly kind: JsonlCorruptionKind;
  /** 1-based line number in the file as it exists on disk. */
  readonly lineNumber: number;
  readonly bytes: number;
  readonly detail: string;
}

export interface JsonlLine {
  readonly lineNumber: number;
  readonly value: Record<string, unknown>;
}

export interface JsonlReadResult {
  readonly existed: boolean;
  /** False when the file exists but could not be read at all (permissions). */
  readonly readable: boolean;
  readonly lines: readonly JsonlLine[];
  readonly corruption: readonly JsonlCorruption[];
  /**
   * True when the last line was unterminated AND unparseable — the classic
   * hard-crash signature. Only that line is dropped; everything before it is
   * kept, because it was already fsynced and is genuinely good data.
   */
  readonly truncatedTailDropped: boolean;
  /**
   * True when the file does not end in a newline but the final line still
   * parsed. The data is kept; the flag exists so a caller can note that the
   * writer did not finish cleanly.
   */
  readonly finalLineUnterminated: boolean;
  readonly bytes: number;
  readonly detail: string | null;
}

/**
 * Read an append-only JSONL log, tolerating the damage a crash actually causes.
 *
 * Rules, deliberately narrow:
 *  - A final line that is unterminated and unparseable is a truncated tail:
 *    dropped, reported, nothing else discarded.
 *  - Any other unparseable line is reported and skipped for replay, but the log
 *    is neither rewritten nor thrown away. Deleting evidence to make a reader
 *    happy is the opposite of what this layer is for.
 */
export function readJsonlSafe(path: string): JsonlReadResult {
  const text = readTextSafe(path);
  if (!text.ok) {
    return {
      existed: text.reason !== 'MISSING',
      readable: false,
      lines: [],
      corruption: [],
      truncatedTailDropped: false,
      finalLineUnterminated: false,
      bytes: text.bytes,
      detail: text.reason === 'MISSING' ? null : text.detail,
    };
  }

  const raw = text.value;
  if (raw.length === 0) {
    return {
      existed: true,
      readable: true,
      lines: [],
      corruption: [],
      truncatedTailDropped: false,
      finalLineUnterminated: false,
      bytes: text.bytes,
      detail: null,
    };
  }

  const endsWithNewline = raw.endsWith('\n');
  const chunks = raw.split('\n');
  if (endsWithNewline) chunks.pop(); // trailing empty segment after the last \n

  const lines: JsonlLine[] = [];
  const corruption: JsonlCorruption[] = [];
  let truncatedTailDropped = false;
  let finalLineUnterminated = false;

  for (let i = 0; i < chunks.length; i += 1) {
    const lineNumber = i + 1;
    const isLast = i === chunks.length - 1;
    const chunk = chunks[i].replace(/\r$/, '');
    if (chunk.trim().length === 0) continue; // blank separator line; not damage

    let parsed: unknown;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(chunk);
    } catch (err) {
      parseError = errMessage(err);
    }

    if (parseError !== null) {
      if (isLast && !endsWithNewline) {
        truncatedTailDropped = true;
        corruption.push({
          kind: 'TRUNCATED_TAIL',
          lineNumber,
          bytes: Buffer.byteLength(chunk, 'utf8'),
          detail: `final line is unterminated and does not parse; dropped (${parseError})`,
        });
      } else {
        corruption.push({
          kind: 'MALFORMED_JSON',
          lineNumber,
          bytes: Buffer.byteLength(chunk, 'utf8'),
          detail: `line does not parse; skipped for replay, left on disk (${parseError})`,
        });
      }
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      corruption.push({
        kind: 'NOT_AN_OBJECT',
        lineNumber,
        bytes: Buffer.byteLength(chunk, 'utf8'),
        detail: `expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      });
      continue;
    }

    if (isLast && !endsWithNewline) finalLineUnterminated = true;
    lines.push({ lineNumber, value: parsed as Record<string, unknown> });
  }

  return {
    existed: true,
    readable: true,
    lines,
    corruption,
    truncatedTailDropped,
    finalLineUnterminated,
    bytes: text.bytes,
    detail: null,
  };
}

/* ========================================================================== */
/*  Advisory lock                                                              */
/* ========================================================================== */

export interface LockFileContents {
  readonly pid: number;
  /** Random per acquisition. Distinguishes two locks held by the same pid. */
  readonly token: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly owner: string;
  readonly lockVersion: number;
}

export const LOCK_VERSION = 1;
export const DEFAULT_LOCK_STALE_MS = 30_000;

export interface LockHandle {
  readonly path: string;
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: string;
  /** Non-null when we took a stale lock over, so the takeover can be logged. */
  readonly tookOverFrom: LockFileContents | null;
  readonly takeoverReason: string | null;
}

export type LockFailureReason = 'HELD' | 'RACE_LOST' | 'IO_ERROR';

export type LockResult =
  | { readonly ok: true; readonly handle: LockHandle }
  | {
      readonly ok: false;
      readonly reason: LockFailureReason;
      readonly detail: string;
      readonly heldBy: LockFileContents | null;
    };

export interface AcquireLockOptions {
  /** A lock whose heartbeat is older than this may be taken over. */
  readonly staleMs?: number;
  /** Identifies the acquirer in the lock file. Never a secret. */
  readonly owner?: string;
  readonly now?: () => Date;
}

/**
 * Is this pid running?
 *
 * `true`  — signal 0 succeeded, or was refused for permissions (EPERM means the
 *           process exists but belongs to someone else).
 * `false` — ESRCH: the OS says no such process.
 * `null`  — we could not tell. Callers must not convert this into either.
 *
 * PID reuse is real, so a `true` here is not proof that it is *our* process.
 * `store.reconcileOnStartup` treats an alive-but-unowned pid as ORPHANED, never
 * as still-RUNNING.
 */
export function isPidAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = errCode(err);
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable: skip the settle delay, verification still runs */
  }
}

function isLockContents(value: unknown): value is LockFileContents {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === 'number' &&
    typeof v.token === 'string' &&
    typeof v.acquiredAt === 'string' &&
    typeof v.heartbeatAt === 'string'
  );
}

export function readLock(path: string): ReadResult<LockFileContents> {
  const result = readJsonSafe<unknown>(path);
  if (!result.ok) return result;
  if (!isLockContents(result.value)) {
    return {
      ok: false,
      reason: 'NOT_AN_OBJECT',
      detail: `lock file is present but not a lock record: ${path}`,
      bytes: result.bytes,
    };
  }
  return { ok: true, value: result.value, bytes: result.bytes };
}

function stalenessOf(
  contents: LockFileContents,
  staleMs: number,
  nowMs: number,
): { readonly stale: boolean; readonly reason: string } {
  const alive = isPidAlive(contents.pid);
  if (alive === false) return { stale: true, reason: `holder pid ${contents.pid} is not running` };
  const heartbeat = Date.parse(contents.heartbeatAt);
  if (!Number.isFinite(heartbeat)) {
    return { stale: true, reason: 'holder heartbeat is unreadable' };
  }
  const age = nowMs - heartbeat;
  if (age > staleMs) {
    return { stale: true, reason: `holder heartbeat is ${age}ms old (limit ${staleMs}ms)` };
  }
  // A holder whose pid equals ours is NOT treated as stale. Inside one process
  // that is us, and stealing our own lock would let two stores in one process
  // interleave writes. The pid-reuse-after-a-crash case is still recovered, by
  // the heartbeat rule above — a few seconds later rather than instantly.
  if (contents.pid === process.pid) {
    return { stale: false, reason: 'holder is this process id and its heartbeat is fresh' };
  }
  return { stale: false, reason: alive === null ? 'holder liveness unknown, heartbeat fresh' : 'holder is alive' };
}

/**
 * Acquire the advisory bridge lock.
 *
 * Mechanism: exclusive create (`wx`) is atomic at the OS level, so the common
 * case has exactly one winner. A stale lock — dead pid, or a heartbeat older
 * than `staleMs` — is removed only after re-reading it and confirming it has
 * not changed, then the exclusive create is retried.
 *
 * HONEST LIMIT: between the re-read and the unlink there is a window in which
 * two racing processes could both proceed. It is narrowed by the re-read and by
 * the post-acquisition token verification below, but it is not eliminated. This
 * is an advisory lock for two bridge instances on one machine, not a consensus
 * protocol, and it is documented as such rather than overclaimed.
 */
export function acquireLock(path: string, options: AcquireLockOptions = {}): LockResult {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const now = options.now ?? (() => new Date());
  const owner = options.owner ?? 'forge-bridge';
  const target = resolve(path);
  ensureDir(dirname(target));

  let tookOverFrom: LockFileContents | null = null;
  let takeoverReason: string | null = null;
  let lastHolder: LockFileContents | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nowDate = now();
    const contents: LockFileContents = {
      pid: process.pid,
      token: randomUUID(),
      acquiredAt: nowDate.toISOString(),
      heartbeatAt: nowDate.toISOString(),
      owner,
      lockVersion: LOCK_VERSION,
    };

    let created = false;
    try {
      const fd = openSync(target, 'wx');
      try {
        const payload = Buffer.from(`${JSON.stringify(contents, null, 2)}\n`, 'utf8');
        writeSync(fd, payload, 0, payload.byteLength, 0);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      created = true;
    } catch (err) {
      if (errCode(err) !== 'EEXIST') {
        return { ok: false, reason: 'IO_ERROR', detail: errMessage(err), heldBy: null };
      }
    }

    if (created) {
      // Verify we still own it after a short settle. If another process took it
      // over in the same instant, we lose here rather than corrupting its data.
      sleepSync(25);
      const verify = readLock(target);
      if (!verify.ok) {
        return { ok: false, reason: 'IO_ERROR', detail: `lock unreadable after create: ${verify.detail}`, heldBy: null };
      }
      if (verify.value.token !== contents.token) {
        return {
          ok: false,
          reason: 'RACE_LOST',
          detail: 'another process replaced the lock immediately after we created it',
          heldBy: verify.value,
        };
      }
      return {
        ok: true,
        handle: {
          path: target,
          token: contents.token,
          pid: contents.pid,
          acquiredAt: contents.acquiredAt,
          tookOverFrom,
          takeoverReason,
        },
      };
    }

    // Someone holds it. Decide whether that claim is still true.
    const held = readLock(target);
    if (!held.ok) {
      if (held.reason === 'MISSING') continue; // released between our create and our read
      // Unreadable or corrupt lock file: treat as stale, but only after a
      // confirming second read so we do not race a writer mid-rename.
      sleepSync(25);
      const second = readLock(target);
      if (second.ok) {
        lastHolder = second.value;
        continue;
      }
      tookOverFrom = null;
      takeoverReason = `previous lock file was unreadable (${held.detail})`;
      try {
        unlinkSync(target);
      } catch {
        /* already gone */
      }
      continue;
    }

    lastHolder = held.value;
    const staleness = stalenessOf(held.value, staleMs, now().getTime());
    if (!staleness.stale) {
      return {
        ok: false,
        reason: 'HELD',
        detail: `lock held by pid ${held.value.pid} (${staleness.reason})`,
        heldBy: held.value,
      };
    }

    // Confirm nothing changed between the read and the removal.
    const confirm = readLock(target);
    if (confirm.ok && confirm.value.token !== held.value.token) continue;
    tookOverFrom = held.value;
    takeoverReason = staleness.reason;
    try {
      unlinkSync(target);
    } catch (err) {
      if (errCode(err) !== 'ENOENT') {
        return { ok: false, reason: 'IO_ERROR', detail: errMessage(err), heldBy: held.value };
      }
    }
  }

  return {
    ok: false,
    reason: 'HELD',
    detail: 'could not acquire the lock after 3 attempts',
    heldBy: lastHolder,
  };
}

/**
 * Refresh the heartbeat. Returns false when the lock is gone or now belongs to
 * someone else — which is information the caller needs, not an error to swallow.
 */
export function renewLock(handle: LockHandle, now: () => Date = () => new Date()): boolean {
  const current = readLock(handle.path);
  if (!current.ok) return false;
  if (current.value.token !== handle.token) return false;
  const updated: LockFileContents = { ...current.value, heartbeatAt: now().toISOString() };
  try {
    writeJsonAtomic(handle.path, updated);
    return true;
  } catch {
    return false;
  }
}

/** Release only our own lock. A lock we no longer own is left strictly alone. */
export function releaseLock(handle: LockHandle): boolean {
  const current = readLock(handle.path);
  if (!current.ok) return false;
  if (current.value.token !== handle.token) return false;
  try {
    unlinkSync(handle.path);
    return true;
  } catch {
    return false;
  }
}
