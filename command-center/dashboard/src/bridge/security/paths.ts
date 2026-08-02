/**
 * Forge Workspace — the path security guard.
 *
 * Every filesystem operation the bridge performs crosses this file first. If a
 * check here is wrong, the "typed verbs only, no shell" design elsewhere buys
 * nothing: an attacker who can name a path can still read `%USERPROFILE%\.ssh`
 * or write outside the trusted root.
 *
 * Three properties this module holds on purpose:
 *
 * 1. NO AMBIENT INPUT. It reads no environment variables, no command line, no
 *    `process.cwd()`. Everything is derived from `os.homedir()` and the real
 *    filesystem, or passed in explicitly. An attacker who controls the bridge's
 *    environment still cannot move the trusted root.
 *
 * 2. NO SPAWNING. The guard never shells out — not even to `reg.exe` to read a
 *    shell folder. The most security-critical file in the system has the
 *    smallest possible blast radius.
 *
 * 3. TYPE-ONLY COUPLING TO THE PROTOCOL. The protocol import below is
 *    `import type`, so it is erased at compile time and at Node's type-stripping
 *    time. That keeps the error codes provably in sync with the contract without
 *    creating a runtime dependency from the guard onto app code.
 *
 * A note on what this module can and cannot promise. `assertInsideRoot` is a
 * CHECK, not a LOCK. Between the check and the open, a symlink can be swapped.
 * Callers must therefore use the canonical path this module RETURNS (never the
 * string they passed in) and act on it immediately. That closes the realistic
 * window; nothing short of an O_NOFOLLOW-style handle dance closes it entirely,
 * and Node does not expose one on Windows.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { OperationError, OperationErrorCode } from '../../shared/protocol';

/* ========================================================================== */
/*  Typed errors                                                               */
/* ========================================================================== */

/**
 * The only two codes this guard may raise, narrowed from the protocol union so
 * the compiler proves both literals still exist in `OperationErrorCode`. If
 * someone renames a code in protocol.ts, this file stops compiling — which is
 * the point.
 */
export type PathErrorCode = Extract<OperationErrorCode, 'PATH_REJECTED' | 'OUTSIDE_TRUSTED_ROOT'>;

/**
 * `PATH_REJECTED`        the input is malformed or hostile on its face.
 * `OUTSIDE_TRUSTED_ROOT` the input is well-formed but resolves somewhere it is
 *                        not allowed to reach. Kept distinct because the UI must
 *                        say different things, and because a containment failure
 *                        is worth a louder audit line than a typo.
 */
export class PathGuardError extends Error {
  readonly code: PathErrorCode;
  readonly detail: string | undefined;

  constructor(code: PathErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'PathGuardError';
    this.code = code;
    this.detail = detail;
    // Restores the prototype chain when this file is downlevelled; without it
    // `err instanceof PathGuardError` silently becomes false in some builds.
    Object.setPrototypeOf(this, PathGuardError.prototype);
  }

  toOperationError(): OperationError {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

export function isPathGuardError(value: unknown): value is PathGuardError {
  return value instanceof PathGuardError;
}

/**
 * Rejected input goes into error `detail` so an operator can debug, but raw
 * input must never be echoed verbatim: a control character can forge a log line
 * and an unbounded string can flood the event store. Cap it and escape it.
 */
function safeForDetail(value: unknown): string {
  const raw = typeof value === 'string' ? value : Object.prototype.toString.call(value);
  const escaped = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return escaped.length > 200 ? `${escaped.slice(0, 200)}…(${escaped.length} chars)` : escaped;
}

function reject(message: string, input: unknown): never {
  throw new PathGuardError('PATH_REJECTED', message, safeForDetail(input));
}

function outside(message: string, input: unknown): never {
  throw new PathGuardError('OUTSIDE_TRUSTED_ROOT', message, safeForDetail(input));
}

/* ========================================================================== */
/*  Limits                                                                     */
/* ========================================================================== */

/** The folder the workspace owns inside the user's Documents directory. */
export const PROJECTS_ROOT_FOLDER_NAME = 'ForgeProjecten';

/** A display name longer than this is not a name, it is a payload. */
export const MAX_DISPLAY_NAME_LENGTH = 128;

/**
 * Slugs are capped well below any filesystem limit so that a deep tree of files
 * *inside* a project still fits under Windows' 260-character MAX_PATH.
 */
export const MAX_SLUG_LENGTH = 64;

/** Absurd-length paths are rejected outright rather than passed to the OS. */
export const MAX_PATH_LENGTH = 4096;

/** Informational only — Node handles longer paths, many Win32 callers do not. */
export const WINDOWS_MAX_PATH = 260;

/** The sentence the UI shows for a file `isSensitivePath` flags. */
export const RESTRICTED_FILE_MESSAGE = 'Restricted file — explicit owner approval required.';

/* ========================================================================== */
/*  Platform seam                                                              */
/* ========================================================================== */

export interface PathGuardOptions {
  /**
   * TEST-ONLY seam. Forces win32 vs posix semantics so the adversarial corpus
   * can exercise both on one machine. Production callers pass nothing and get
   * the real platform.
   */
  readonly platform?: string;
  /**
   * TEST-ONLY seam. Overrides the user profile directory. Used ONLY as the
   * containment root for root resolution, never to widen an existing check.
   */
  readonly homeDir?: string;
  /** TEST-ONLY seam. Skips Documents discovery and uses this directory. */
  readonly documentsDir?: string;
}

function usesWin32(options?: PathGuardOptions): boolean {
  return (options?.platform ?? os.platform()) === 'win32';
}

function pathFor(win32: boolean): path.PlatformPath {
  return win32 ? path.win32 : path.posix;
}

/**
 * Windows compares filenames case-insensitively; POSIX does not. Using
 * `toLowerCase()` and never `toLocaleLowerCase()` matters: under a Turkish
 * locale the latter maps 'I' to 'ı', so "CONIN$" would stop matching the
 * reserved-device list on exactly the machines an attacker would pick.
 */
function foldCase(segment: string, win32: boolean): string {
  return win32 ? segment.toLowerCase() : segment;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/* ========================================================================== */
/*  Character-level traps                                                      */
/* ========================================================================== */

/**
 * Control characters. A NUL truncates the path at the C boundary, so
 * "safe.txt\u0000../../etc/passwd" passes a JavaScript check and opens
 * something else entirely. The C1 range is included because it survives some
 * encodings and can forge log lines.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Invisible and direction-changing characters. U+202E RIGHT-TO-LEFT OVERRIDE is
 * the classic one: "invoice\u202Egnp.exe" renders as "invoiceexe.png" in every
 * file list while still being an executable. Zero-width characters let two
 * visually identical names occupy two folders. Neither has any business in a
 * folder name, so they are rejected rather than stripped — stripping would
 * silently produce a different name than the user typed.
 */
const INVISIBLE_OR_BIDI =
  /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/;

/**
 * Separator and dot lookalikes that NFKC does NOT fold. NFKC already handles
 * U+FF0E FULLWIDTH FULL STOP, U+2024/2025/2026 dot leaders, U+FF0F FULLWIDTH
 * SOLIDUS and U+FE68 SMALL REVERSE SOLIDUS; these are the ones it leaves alone,
 * which is exactly why they are worth folding by hand before the traversal
 * checks run.
 */
const LOOKALIKE_FOLD: ReadonlyMap<string, string> = new Map([
  ['\u2044', '/'], // FRACTION SLASH
  ['\u2215', '/'], // DIVISION SLASH
  ['\u29f8', '/'], // BIG SOLIDUS
  ['\u01c0', '/'], // LATIN LETTER DENTAL CLICK
  ['\u29f9', '\\'], // BIG REVERSE SOLIDUS
  ['\u3002', '.'], // IDEOGRAPHIC FULL STOP
  ['\u06d4', '.'], // ARABIC FULL STOP
  ['\ua4f8', '.'], // LISU LETTER TONE MYA TI
  ['\u2236', ':'], // RATIO
  ['\ua789', ':'], // MODIFIER LETTER COLON
]);

function foldLookalikes(value: string): string {
  let out = '';
  for (const ch of value) out += LOOKALIKE_FOLD.get(ch) ?? ch;
  return out;
}

/**
 * Windows device names. These are resolved by the kernel BEFORE the directory
 * is consulted, so `C:\anywhere\CON` is the console device, not a file — and
 * `NUL.txt` is still NUL. The `$`-suffixed ones are real too. COM0/LPT0 are not
 * reserved, which is why the list is explicit rather than a lazy `COM\d`.
 */
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
  'conin$',
  'conout$',
  'clock$',
]);

/**
 * True when `name` would resolve to a device. The extension is stripped first
 * because Windows ignores it: CON, CON.txt and CON.tar.gz are all the console.
 * Trailing dots and spaces are stripped first for the same reason (see
 * `stripWindowsTrailers`).
 */
function isReservedDeviceName(name: string): boolean {
  const trimmed = stripWindowsTrailers(name).toLowerCase();
  if (trimmed.length === 0) return false;
  if (RESERVED_DEVICE_NAMES.has(trimmed)) return true;
  const base = trimmed.split('.')[0] ?? '';
  return RESERVED_DEVICE_NAMES.has(base);
}

/**
 * Windows silently discards trailing dots and spaces on create AND on open.
 * "report" and "report. " are therefore the same directory, which is a
 * collision the user cannot see. Strip them before every comparison so the
 * guard reasons about the name the filesystem will actually use.
 */
function stripWindowsTrailers(value: string): string {
  return value.replace(/[. \t]+$/u, '');
}

/**
 * Detects traversal hidden behind percent-encoding, including double-encoding
 * (`%252e%252e%252f`). Two decisions worth explaining:
 *
 *  - A malformed escape that still LOOKS encoded (`%c0%af`, the overlong-UTF-8
 *    slash from the IIS era) throws in `decodeURIComponent`. That is treated as
 *    hostile, not as "just a percent sign".
 *  - A plain percent with no hex behind it ("100% Done") also throws, but has no
 *    `%XX` shape, so it is allowed through and neutralised later.
 */
function hidesEncodedTraversal(value: string): boolean {
  // Control characters are the point of this check, not an oversight.
  // eslint-disable-next-line no-control-regex
  const dangerous = /[\\/]|\.\.|[\u0000-\u001f]/;
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // Looks like an escape sequence but is not valid UTF-8 — overlong or
      // truncated encodings exist to smuggle separators past naive decoders.
      return /%[0-9a-f]{2}/i.test(current);
    }
    if (decoded === current) return false;
    current = decoded;
    if (dangerous.test(current)) return true;
  }
  // Still changing after three passes: nobody names a folder that way.
  return true;
}

/* ========================================================================== */
/*  sanitizeSlug                                                               */
/* ========================================================================== */

export interface SlugRejection {
  readonly ok: false;
  readonly code: PathErrorCode;
  readonly reason: string;
}

export interface SlugAcceptance {
  readonly ok: true;
  readonly slug: string;
  /** Neutralisations applied, so the UI can tell the user what it renamed. */
  readonly notes: readonly string[];
}

export type SlugInspection = SlugRejection | SlugAcceptance;

/**
 * Turns a human display name into a single safe path segment, or explains why it
 * cannot. Non-throwing sibling of `sanitizeSlug`.
 *
 * The order of the checks is load-bearing: normalise first so that lookalikes
 * become the characters they impersonate, THEN look for traversal. Reversing
 * those two steps is the bug this whole function exists to avoid.
 */
export function inspectSlug(displayName: unknown): SlugInspection {
  if (typeof displayName !== 'string') {
    return { ok: false, code: 'PATH_REJECTED', reason: 'Display name must be a string.' };
  }
  if (displayName.length === 0) {
    return { ok: false, code: 'PATH_REJECTED', reason: 'Display name is empty.' };
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: `Display name exceeds ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARS.test(displayName)) {
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: 'Display name contains a NUL or control character.',
    };
  }
  if (INVISIBLE_OR_BIDI.test(displayName)) {
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: 'Display name contains an invisible or direction-overriding character.',
    };
  }
  if (hidesEncodedTraversal(displayName)) {
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: 'Display name contains percent-encoded path characters.',
    };
  }

  const notes: string[] = [];

  // NFKC collapses fullwidth, compatibility and ligature forms onto their plain
  // equivalents. It is also the step that turns "COM¹" into "COM1" and "．." into
  // "..", which is why the traversal checks below run AFTER it, never before.
  const normalised = foldLookalikes(displayName.normalize('NFKC'));
  if (normalised !== displayName) notes.push('normalised to NFKC and folded lookalike characters');

  if (CONTROL_CHARS.test(normalised)) {
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: 'Normalisation revealed a control character.',
    };
  }
  // A slug is ONE path segment. Any separator at all is fatal — this single
  // check subsumes "../", "..\", "/etc/passwd", "\\server\share" and "\\?\".
  if (/[\\/]/.test(normalised)) {
    return { ok: false, code: 'PATH_REJECTED', reason: 'Display name contains a path separator.' };
  }
  if (normalised.includes('..')) {
    // "My..Project" is a legal Windows folder name, and it is still rejected.
    // A double dot is cheap to avoid and catastrophic to get wrong.
    return { ok: false, code: 'PATH_REJECTED', reason: 'Display name contains a dot-dot sequence.' };
  }
  if (/^[a-z]:/i.test(normalised)) {
    // Also catches the drive-RELATIVE form "C:project", which means "project in
    // the current directory of drive C:" and is not a name at all.
    return { ok: false, code: 'PATH_REJECTED', reason: 'Display name looks like a drive path.' };
  }
  if (normalised.includes(':')) {
    // NTFS alternate data streams: "report:$DATA" writes a hidden stream that
    // most tools, and most humans, never see.
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: 'Display name contains a colon (alternate data stream).',
    };
  }

  // Trailing dots and spaces go before the device-name check so "CON. " is
  // recognised as CON, and leading whitespace goes with it so " con" is too.
  const trimmed = stripWindowsTrailers(normalised.replace(/^[\s.]+/u, ''));
  if (trimmed !== normalised) notes.push('stripped leading/trailing dots and whitespace');
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: 'Display name is only dots and whitespace.',
    };
  }
  if (isReservedDeviceName(trimmed)) {
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: `"${trimmed}" is a Windows reserved device name.`,
    };
  }

  // Everything outside letters/digits/marks becomes a hyphen. Dots go too: they
  // buy nothing in a folder name and cost an entire class of extension tricks.
  // `toLowerCase` (never `toLocaleLowerCase`) so slugs are locale-stable and so
  // Windows' case-insensitivity is visible in the slug itself.
  const slug = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-_]+$/g, '');

  if (slug.length === 0) {
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: 'Display name contains no usable characters.',
    };
  }
  // Re-check after the rewrite: "CON---" survives the first device check
  // (its base name is "CON---") but collapses to exactly "con" here.
  if (isReservedDeviceName(slug)) {
    return {
      ok: false,
      code: 'PATH_REJECTED',
      reason: `Display name reduces to the reserved device name "${slug}".`,
    };
  }
  if (slug !== trimmed.toLowerCase()) notes.push(`rewritten to "${slug}"`);
  if (trimmed.length > MAX_SLUG_LENGTH) notes.push(`truncated to ${MAX_SLUG_LENGTH} characters`);

  return { ok: true, slug, notes };
}

/**
 * Throwing form. Returns a slug that is safe to use as exactly one path segment
 * under the projects root — it still has to pass `assertInsideRoot` once joined.
 */
export function sanitizeSlug(displayName: unknown): string {
  const result = inspectSlug(displayName);
  if (!result.ok) throw new PathGuardError(result.code, result.reason, safeForDetail(displayName));
  return result.slug;
}

/* ========================================================================== */
/*  Confusable collision detection                                             */
/* ========================================================================== */

/**
 * Homoglyph folding table.
 *
 * "раypal" with a Cyrillic ер and а is a different string, a different slug and
 * a different folder from "paypal" — and indistinguishable on screen. Folding
 * catches that.
 *
 * Deliberately NOT in this table: digit/letter pairs (0/O, 1/l, 5/S) and the
 * rn/m pair. Folding those makes "v1" collide with "vl" and produces false
 * alarms on ordinary project names. The script homoglyphs below are the ones
 * with a real impersonation history; the rest are noise.
 *
 * Keys are lowercase only — folding runs after `toLowerCase()`.
 */
const CONFUSABLE_FOLD: ReadonlyMap<string, string> = new Map([
  // Cyrillic
  ['\u0430', 'a'], ['\u0432', 'b'], ['\u0435', 'e'], ['\u043a', 'k'], ['\u043c', 'm'],
  ['\u043d', 'h'], ['\u043e', 'o'], ['\u0440', 'p'], ['\u0441', 'c'], ['\u0442', 't'],
  ['\u0443', 'y'], ['\u0445', 'x'], ['\u0455', 's'], ['\u0456', 'i'], ['\u0458', 'j'],
  ['\u0501', 'd'], ['\u04bb', 'h'], ['\u051b', 'q'], ['\u051d', 'w'], ['\u0451', 'e'],
  ['\u0450', 'e'], ['\u0457', 'i'], ['\u04cf', 'l'], ['\u0433', 'r'],
  // Greek
  ['\u03b1', 'a'], ['\u03b2', 'b'], ['\u03b5', 'e'], ['\u03b7', 'n'], ['\u03b9', 'i'],
  ['\u03ba', 'k'], ['\u03bd', 'v'], ['\u03bf', 'o'], ['\u03c1', 'p'], ['\u03c4', 't'],
  ['\u03c5', 'u'], ['\u03c7', 'x'], ['\u03b3', 'y'], ['\u03bc', 'u'], ['\u03f2', 'c'],
  ['\u03c3', 'o'],
  // Latin letters that are visually plain letters but compare unequal
  ['\u0131', 'i'], ['\u0142', 'l'], ['\u00f8', 'o'], ['\u0111', 'd'], ['\u0261', 'g'],
  ['\u0250', 'a'], ['\u1d00', 'a'], ['\u1d0f', 'o'], ['\u026a', 'i'],
  // Armenian / Cherokee lookalikes seen in real homograph reports
  ['\u0585', 'o'], ['\u0578', 'n'], ['\u13a0', 'd'], ['\u13de', 'l'],
]);

/**
 * How two names collided. The caller decides severity: `exact`/`case` are hard
 * blocks on Windows (they are literally the same directory), while `confusable`
 * and `diacritic` are distinct directories that a human cannot tell apart — a
 * warning, or an owner approval, rather than an automatic refusal.
 */
export type CollisionReason =
  | 'exact'
  | 'case'
  | 'separator'
  | 'diacritic'
  | 'confusable'
  | 'truncation';

export interface CollisionMatch {
  readonly existing: string;
  readonly reason: CollisionReason;
}

export interface CollisionReport {
  readonly collides: boolean;
  readonly matches: readonly CollisionMatch[];
  /** The fully folded form the comparison used — useful in an audit line. */
  readonly folded: string;
}

const stripPunctuation = (value: string): string => value.replace(/[^\p{L}\p{N}]+/gu, '');

/** NFD splits a precomposed letter into base + combining mark; drop the marks. */
const stripDiacritics = (value: string): string =>
  value.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');

const foldConfusables = (value: string): string => {
  let out = '';
  for (const ch of value) out += CONFUSABLE_FOLD.get(ch) ?? ch;
  return out;
};

const caseFold = (value: string): string => stripWindowsTrailers(value.normalize('NFKC')).toLowerCase();

/**
 * A ladder from tightest to loosest. The FIRST rung that matches names the
 * reason, so a plain case clash is never reported as an exotic homoglyph
 * attack — the report has to be believable to be acted on.
 */
const COLLISION_LADDER: readonly { readonly reason: CollisionReason; readonly fold: (v: string) => string }[] = [
  { reason: 'exact', fold: (v) => v },
  { reason: 'case', fold: caseFold },
  { reason: 'separator', fold: (v) => stripPunctuation(caseFold(v)) },
  { reason: 'diacritic', fold: (v) => stripDiacritics(stripPunctuation(caseFold(v))) },
  { reason: 'confusable', fold: (v) => foldConfusables(stripDiacritics(stripPunctuation(caseFold(v)))) },
  {
    reason: 'truncation',
    fold: (v) =>
      foldConfusables(stripDiacritics(stripPunctuation(caseFold(v)))).slice(0, MAX_SLUG_LENGTH),
  },
];

/**
 * Would `candidate` land on the same folder as, or be mistaken for, something in
 * `existing`? Accepts slugs or raw display names on either side — both are run
 * through the same folds, so mixing them is safe.
 *
 * The `truncation` rung matters more than it looks: `sanitizeSlug` caps slugs at
 * MAX_SLUG_LENGTH, so two long, clearly different project names can produce one
 * identical folder. Without this check the second project would silently adopt
 * the first project's directory.
 */
export function detectCollision(
  existing: readonly string[],
  candidate: string,
): CollisionReport {
  const matches: CollisionMatch[] = [];
  const seen = new Set<string>();

  for (const other of existing) {
    if (typeof other !== 'string' || other.length === 0) continue;
    for (const rung of COLLISION_LADDER) {
      if (rung.fold(other) === rung.fold(candidate)) {
        if (!seen.has(other)) {
          seen.add(other);
          matches.push({ existing: other, reason: rung.reason });
        }
        break;
      }
    }
  }

  return {
    collides: matches.length > 0,
    matches,
    folded: COLLISION_LADDER[COLLISION_LADDER.length - 1]!.fold(candidate),
  };
}

/* ========================================================================== */
/*  assertInsideRoot                                                           */
/* ========================================================================== */

/** Splits an absolute, normalised path into comparable segments. */
function segmentsOf(absolute: string, win32: boolean): string[] {
  return absolute
    .split(/[\\/]+/)
    .filter((s) => s.length > 0)
    .map((s) => foldCase(s, win32));
}

/**
 * Resolves symlinks and NTFS junctions as far as the path actually exists.
 *
 * `fs.realpathSync` throws ENOENT for a path we are about to CREATE, but the
 * ancestors of that path may still be links pointing out of the root. So: walk
 * up to the longest existing prefix, canonicalise that, then re-attach the tail.
 * Skipping this step is how a `ForgeProjecten\shared -> C:\Windows` junction
 * turns "inside the root" into "System32".
 *
 * `realpathSync.native` is preferred because on Windows it goes through
 * GetFinalPathNameByHandle, which follows junctions that the JavaScript
 * implementation can miss.
 *
 * When the `platform` test seam disagrees with the host, link resolution is
 * SKIPPED rather than faked: asking a Windows filesystem to realpath
 * "/home/u/root" yields "C:\", which would silently turn a posix test vector
 * into a nonsense answer. The corpus marks link vectors as host-dependent for
 * exactly this reason — a skipped check is honest, a wrong one is not.
 */
function canonicalise(absolute: string, impl: path.PlatformPath): string {
  const implIsWin32 = impl === path.win32;
  if (implIsWin32 !== (os.platform() === 'win32')) return absolute;

  const realpath = (p: string): string =>
    typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(p) : fs.realpathSync(p);

  let current = absolute;
  const tail: string[] = [];

  for (;;) {
    try {
      const real = realpath(current);
      return tail.length === 0 ? real : impl.resolve(real, ...tail.reverse());
    } catch (error) {
      const code = errnoCode(error);
      // ENOENT/ENOTDIR: this level does not exist yet — keep walking up.
      // Anything else (EPERM, EACCES, ELOOP, EINVAL) is a real failure and must
      // not be swallowed into "looks fine".
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        reject(`Cannot canonicalise path (${code ?? 'unknown error'}).`, absolute);
      }
      const parent = impl.dirname(current);
      if (parent === current) return absolute; // reached the volume root
      tail.push(impl.basename(current));
      current = parent;
    }
  }
}

/**
 * Rejects the shapes that make Windows path handling unpredictable, before any
 * resolution happens.
 */
function assertWellFormed(candidate: unknown, win32: boolean): string {
  if (typeof candidate !== 'string') reject('Path must be a string.', candidate);
  if (candidate.length === 0) reject('Path is empty.', candidate);
  if (candidate.length > MAX_PATH_LENGTH) {
    reject(`Path exceeds ${MAX_PATH_LENGTH} characters.`, candidate);
  }
  if (CONTROL_CHARS.test(candidate)) {
    reject('Path contains a NUL or control character.', candidate);
  }
  if (INVISIBLE_OR_BIDI.test(candidate)) {
    reject('Path contains an invisible or direction-overriding character.', candidate);
  }
  if (win32) {
    // \\?\ and \\.\ switch Win32 into raw mode: "." and ".." stop being
    // normalised and device names become reachable. Never accept either.
    if (/^[\\/]{2}[?.][\\/]/.test(candidate)) {
      reject('Win32 device-namespace prefix is not permitted.', candidate);
    }
    // UNC. The trusted root is always local; a \\server\share path is by
    // definition outside it and is also a credential-leak vector (SMB auth).
    if (/^[\\/]{2}/.test(candidate)) {
      reject('UNC paths are not permitted.', candidate);
    }
  }
  return candidate;
}

/**
 * Non-throwing containment test. Both sides are canonicalised; comparison is by
 * whole path segments.
 */
export function isInsideRoot(candidate: string, root: string, options?: PathGuardOptions): boolean {
  try {
    assertInsideRoot(candidate, root, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * THE boundary check. Returns the canonical absolute path the caller must use
 * from here on — using the original string instead re-opens every hole this
 * function just closed.
 *
 * Why `path.relative`/`startsWith` are not enough on their own:
 *   startsWith('C:\\root')  accepts 'C:\\rootEVIL'   — a sibling directory
 *   startsWith('C:\\root')  accepts 'C:\\root.evil'  — another sibling
 * The comparison below is per segment, so 'rootEVIL' can never satisfy 'root'.
 */
export function assertInsideRoot(
  candidate: string,
  root: string,
  options?: PathGuardOptions,
): string {
  const win32 = usesWin32(options);
  const impl = pathFor(win32);

  assertWellFormed(root, win32);
  if (!impl.isAbsolute(root)) {
    // The guard never consults process.cwd(): a relative root would make the
    // trusted boundary depend on where the bridge happened to be started.
    reject('Trusted root must be an absolute path.', root);
  }
  assertWellFormed(candidate, win32);

  const rootResolved = impl.resolve(root);
  // A relative candidate is interpreted against the ROOT, never the process
  // working directory. "sub/file" therefore means "inside the root" always.
  const candidateResolved = impl.isAbsolute(candidate)
    ? impl.resolve(candidate)
    : impl.resolve(rootResolved, candidate);

  if (candidateResolved.length > MAX_PATH_LENGTH) {
    reject(`Resolved path exceeds ${MAX_PATH_LENGTH} characters.`, candidateResolved);
  }

  const rootReal = canonicalise(rootResolved, impl);
  const candidateReal = canonicalise(candidateResolved, impl);

  const rootSegments = segmentsOf(rootReal, win32);
  const candidateSegments = segmentsOf(candidateReal, win32);

  if (rootSegments.length === 0) {
    reject('Trusted root resolved to nothing.', root);
  }
  if (candidateSegments.length < rootSegments.length) {
    outside('Path is above the trusted root.', candidate);
  }
  for (let i = 0; i < rootSegments.length; i += 1) {
    if (candidateSegments[i] !== rootSegments[i]) {
      outside('Path resolves outside the trusted root.', candidate);
    }
  }

  // Per-segment hygiene on the part BELOW the root. Two traps live here:
  //  - a reserved device name anywhere in the tree still opens the device, so
  //    "<root>\CON" is inside the root and still forbidden;
  //  - a segment with a trailing dot or space is a different string but the
  //    same directory to Windows, which is a silent aliasing bug.
  if (win32) {
    for (let i = rootSegments.length; i < candidateSegments.length; i += 1) {
      const segment = candidateSegments[i]!;
      if (isReservedDeviceName(segment)) {
        reject(`Path segment "${segment}" is a Windows reserved device name.`, candidate);
      }
      if (segment !== stripWindowsTrailers(segment)) {
        reject(`Path segment "${segment}" has a trailing dot or space.`, candidate);
      }
      if (segment.includes(':')) {
        reject(`Path segment "${segment}" contains an alternate data stream.`, candidate);
      }
    }
  }

  return candidateReal;
}

/**
 * Advisory only. Node reaches past MAX_PATH, but plenty of Windows tooling the
 * user might open the project with does not — so the UI warns instead of the
 * guard refusing.
 */
export function exceedsWindowsMaxPath(absolute: string): boolean {
  return absolute.length > WINDOWS_MAX_PATH;
}

/* ========================================================================== */
/*  Projects root resolution                                                   */
/* ========================================================================== */

/**
 * Documents folder names across the locales Windows and the XDG spec actually
 * use on disk. Windows usually keeps the physical folder named "Documents" and
 * localises only the display name via desktop.ini — but "usually" is not
 * "always", and a hardcoded English string would leave those users with a
 * silently wrong root.
 */
const DOCUMENTS_FOLDER_NAMES: readonly string[] = [
  'Documents',
  'Documenten',
  'Dokumente',
  'Documentos',
  'Documenti',
  'Mes documents',
  'Dokumenty',
  'Dokumentumok',
  'Dokumendid',
  'Dokumenti',
  'Dokumentai',
  'Belgeler',
  'Dokument',
  'Dokumenter',
  'Asiakirjat',
  'Documente',
  '\u0414\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u044b',
  '\u0414\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u0438',
  '\u0388\u03b3\u03b3\u03c1\u03b1\u03c6\u03b1',
  '\u05de\u05e1\u05de\u05db\u05d9\u05dd',
  '\u0627\u0644\u0645\u0633\u062a\u0646\u062f\u0627\u062a',
  '\u6587\u6863',
  '\u6587\u4ef6',
  '\u30c9\u30ad\u30e5\u30e1\u30f3\u30c8',
  '\ubb38\uc11c',
  'Dokumen',
  'Mga Dokumento',
  'T\u00e0i li\u1ec7u',
];

export type ProjectsRootSource =
  | 'explicit-option'
  | 'home-documents'
  | 'onedrive-documents'
  | 'xdg-user-dirs'
  | 'fallback-unverified';

export interface ProjectsRootInfo {
  readonly home: string;
  readonly documentsDir: string;
  readonly projectsRoot: string;
  readonly source: ProjectsRootSource;
  /** False when nothing on disk confirmed the Documents directory. */
  readonly documentsDirExists: boolean;
  /** Every location that was probed, in order — an auditable trail. */
  readonly candidatesTried: readonly string[];
  /**
   * Directories that DO exist but were refused, with the reason. Without this,
   * a user whose Documents folder is redirected to another drive is told
   * "Documents does not exist" — a false statement about their machine, and one
   * that sends them looking for the wrong problem.
   */
  readonly rejectedCandidates: readonly { readonly path: string; readonly reason: string }[];
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** OneDrive Known Folder Move relocates Documents. Discovered by looking, not
 *  by reading %OneDrive% — the guard reads no environment variables. */
function oneDriveDirs(home: string, impl: path.PlatformPath): string[] {
  try {
    return fs
      .readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^onedrive( - .+)?$/i.test(entry.name))
      .map((entry) => impl.join(home, entry.name));
  } catch {
    return [];
  }
}

/**
 * The XDG answer on POSIX. Read from the config FILE rather than
 * $XDG_DOCUMENTS_DIR so an inherited environment cannot move the root.
 */
function xdgDocumentsDir(home: string, impl: path.PlatformPath): string | null {
  try {
    const text = fs.readFileSync(impl.join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const match = /^\s*XDG_DOCUMENTS_DIR\s*=\s*"([^"]*)"/m.exec(text);
    if (!match || match[1] === undefined) return null;
    const raw = match[1].replace(/^\$HOME/, home);
    return impl.isAbsolute(raw) ? impl.resolve(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Full provenance for the projects root. Nothing here is inferred from a
 * username, a drive letter or a hardcoded folder name; every candidate must both
 * EXIST as a directory and resolve under the current user profile before it is
 * accepted. A candidate that fails either test is skipped, not repaired.
 */
export function resolveProjectsRootInfo(options?: PathGuardOptions): ProjectsRootInfo {
  const win32 = usesWin32(options);
  const impl = pathFor(win32);
  const home = impl.resolve(options?.homeDir ?? os.homedir());
  const candidatesTried: string[] = [];
  const rejectedCandidates: { path: string; reason: string }[] = [];

  const accept = (dir: string, source: ProjectsRootSource, exists: boolean): ProjectsRootInfo => ({
    home,
    documentsDir: dir,
    projectsRoot: impl.join(dir, PROJECTS_ROOT_FOLDER_NAME),
    source,
    documentsDirExists: exists,
    candidatesTried,
    rejectedCandidates,
  });

  if (options?.documentsDir !== undefined) {
    const explicit = impl.resolve(options.documentsDir);
    candidatesTried.push(explicit);
    return accept(explicit, 'explicit-option', isDirectory(explicit));
  }

  // Only directories that are genuinely under the profile qualify. This is what
  // makes a poisoned or redirected candidate fail closed instead of silently
  // becoming the trusted root.
  const underHome = (dir: string): boolean => isInsideRoot(dir, home, options);

  const probe = (dir: string, source: ProjectsRootSource): ProjectsRootInfo | null => {
    candidatesTried.push(dir);
    if (!isDirectory(dir)) return null;
    if (!underHome(dir)) {
      // Exists, but its real target is off the profile — a redirected Documents
      // folder, or a link planted to move the trusted root. Recorded, not used.
      rejectedCandidates.push({
        path: dir,
        reason: 'exists but resolves outside the current user profile',
      });
      return null;
    }
    return accept(dir, source, true);
  };

  if (!win32) {
    const xdg = xdgDocumentsDir(home, impl);
    if (xdg !== null) {
      const hit = probe(xdg, 'xdg-user-dirs');
      if (hit) return hit;
    }
  }

  for (const name of DOCUMENTS_FOLDER_NAMES) {
    const hit = probe(impl.join(home, name), 'home-documents');
    if (hit) return hit;
  }

  if (win32) {
    for (const oneDrive of oneDriveDirs(home, impl)) {
      for (const name of DOCUMENTS_FOLDER_NAMES) {
        const hit = probe(impl.join(oneDrive, name), 'onedrive-documents');
        if (hit) return hit;
      }
    }
  }

  // Nothing on disk confirmed anything. Return the conventional location but
  // report `documentsDirExists: false` and source `fallback-unverified`, so a
  // caller cannot mistake a guess for a fact. `ensureProjectsRoot` will refuse
  // to create anything under it.
  const fallback = impl.join(home, 'Documents');
  candidatesTried.push(fallback);
  return accept(fallback, 'fallback-unverified', false);
}

/**
 * The canonical `<Documents>/ForgeProjecten` path. Resolution only — this
 * function never touches the filesystem for writing and never creates anything.
 */
export function resolveProjectsRoot(options?: PathGuardOptions): string {
  return resolveProjectsRootInfo(options).projectsRoot;
}

export interface EnsureProjectsRootResult {
  readonly projectsRoot: string;
  readonly documentsDir: string;
  readonly source: ProjectsRootSource;
  readonly created: boolean;
  readonly alreadyExisted: boolean;
}

/**
 * Creates the projects root, but only after proving it is safe to.
 *
 * Every precondition here exists because of a specific failure:
 *  - parent must exist        — otherwise a typo'd Documents path silently
 *                               creates a whole tree in the wrong place;
 *  - parent under the profile — a redirected Documents pointing at D:\ or a
 *                               network share would put project data outside
 *                               the boundary every later check assumes;
 *  - no conflicting FILE      — mkdir over an existing file fails confusingly,
 *                               and a caller that ignored the error would then
 *                               treat a file as a directory;
 *  - realpath re-check AFTER  — the only way to catch a symlink that was
 *    creation                   already sitting at that path, or was raced in.
 */
export function ensureProjectsRoot(options?: PathGuardOptions): EnsureProjectsRootResult {
  const info = resolveProjectsRootInfo(options);
  const win32 = usesWin32(options);
  const impl = pathFor(win32);

  if (!info.documentsDirExists || !isDirectory(info.documentsDir)) {
    // Say which of the two it actually is. "Does not exist" is a claim about the
    // user's machine, and it is false for the redirected-Documents case.
    const refused = info.rejectedCandidates[0];
    if (refused) {
      outside(
        `Documents directory ${refused.reason}, so the projects root cannot be created there.`,
        refused.path,
      );
    }
    reject(
      'No Documents directory could be found under the user profile, so the projects root cannot be created.',
      info.documentsDir,
    );
  }

  const homeReal = canonicalise(impl.resolve(info.home), impl);
  const documentsReal = canonicalise(impl.resolve(info.documentsDir), impl);
  if (!isInsideRoot(documentsReal, homeReal, options)) {
    outside(
      'Documents directory resolves outside the current user profile.',
      `${info.documentsDir} -> ${documentsReal}`,
    );
  }

  const target = impl.join(documentsReal, PROJECTS_ROOT_FOLDER_NAME);
  let alreadyExisted = false;

  // lstat, not stat: stat follows the link and would report a symlink-to-file
  // as whatever it points at, hiding exactly the case being checked for.
  try {
    const link = fs.lstatSync(target);
    if (link.isSymbolicLink()) {
      // A pre-existing link at the root is not automatically fatal, but it only
      // survives if its target is still inside the profile.
      const linkReal = canonicalise(target, impl);
      if (!isInsideRoot(linkReal, homeReal, options)) {
        outside('Projects root is a link pointing outside the user profile.', `${target} -> ${linkReal}`);
      }
      if (!isDirectory(target)) {
        reject('Projects root is a link that does not point at a directory.', target);
      }
      alreadyExisted = true;
    } else if (link.isDirectory()) {
      alreadyExisted = true;
    } else {
      reject('A file already exists where the projects root must be created.', target);
    }
  } catch (error) {
    // A PathGuardError raised INSIDE the block above is a verdict, not an
    // lstat failure. Re-throwing it unchanged keeps the real code and the real
    // reason; wrapping it produced "Cannot inspect the projects root
    // (OUTSIDE_TRUSTED_ROOT)", which reports the wrong code AND hides the cause.
    if (isPathGuardError(error)) throw error;
    const code = errnoCode(error);
    if (code !== 'ENOENT') {
      reject(`Cannot inspect the projects root (${code ?? 'unknown error'}).`, target);
    }
  }

  let created = false;
  if (!alreadyExisted) {
    try {
      // Not recursive: the parent was verified above, and `recursive: true`
      // would happily invent a whole tree if that verification were ever wrong.
      fs.mkdirSync(target);
      created = true;
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'EEXIST') {
        alreadyExisted = true; // lost a race with another bridge instance
      } else {
        reject(`Cannot create the projects root (${code ?? 'unknown error'}).`, target);
      }
    }
  }

  // Post-condition. Everything above described intent; this is the only part
  // that observes what is actually on disk now.
  const finalReal = canonicalise(target, impl);
  if (!isDirectory(finalReal)) {
    reject('Projects root is not a directory after creation.', finalReal);
  }
  if (!isInsideRoot(finalReal, homeReal, options)) {
    outside('Projects root resolves outside the user profile after creation.', finalReal);
  }

  return {
    projectsRoot: finalReal,
    documentsDir: documentsReal,
    source: info.source,
    created,
    alreadyExisted: alreadyExisted && !created,
  };
}

/* ========================================================================== */
/*  Sensitive files                                                            */
/* ========================================================================== */

/**
 * Exact filenames that are credentials by convention.
 */
const SENSITIVE_FILENAMES: ReadonlySet<string> = new Set([
  '.netrc',
  '_netrc',
  '.npmrc',
  '.yarnrc',
  '.pypirc',
  '.pgpass',
  '.my.cnf',
  '.htpasswd',
  '.dockercfg',
  '.git-credentials',
  '.gitconfig',
  'credentials',
  'credentials.json',
  'credential.json',
  'known_hosts',
  'authorized_keys',
  'secring.gpg',
  'trustdb.gpg',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa.pub',
  'id_ecdsa.pub',
  'id_ed25519.pub',
  'service-account.json',
  'serviceaccount.json',
  'keyfile.json',
  'master.key',
]);

/** Extensions that only ever hold key material or an encrypted vault. */
const SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pem',
  '.key',
  '.pfx',
  '.p12',
  '.p8',
  '.jks',
  '.keystore',
  '.asc',
  '.gpg',
  '.pgp',
  '.kdbx',
  '.ppk',
  '.ovpn',
  '.jwk',
]);

/** Directories whose entire contents are secrets or VCS internals. */
const SENSITIVE_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  'secrets',
  '.secrets',
]);

/**
 * Credential-ish words, matched on a token boundary rather than as a bare
 * substring. The boundary is what keeps "tokenizer.ts", "keyboard.md" and
 * "monkey.ts" out of the restricted list while still catching "token.txt" and
 * "deploy.key". Without it this check cries wolf on ordinary source files and
 * the approval prompt stops meaning anything.
 */
const SENSITIVE_WORDS: readonly RegExp[] = [
  /(^|[^a-z0-9])secrets?([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])credentials?([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])passwords?([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])passwd([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])tokens?([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])api[-_]?keys?([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])private[-_]?keys?([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])auth[-_]?tokens?([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])access[-_]?tokens?([^a-z0-9]|$)/i,
  /(^|[^a-z0-9])client[-_]?secrets?([^a-z0-9]|$)/i,
];

export interface SensitivePathReport {
  readonly sensitive: boolean;
  readonly reasons: readonly string[];
  /** Present only when sensitive; the exact sentence the UI must show. */
  readonly message: string | null;
}

/**
 * Explains WHY a path is restricted. The bridge attaches these reasons to the
 * approval request so the owner is approving a specific, named risk instead of
 * a yes/no dialog with no content.
 */
export function describeSensitivePath(candidate: string): SensitivePathReport {
  const reasons: string[] = [];
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { sensitive: false, reasons, message: null };
  }

  const segments = candidate.split(/[\\/]+/).filter((s) => s.length > 0);
  const filename = (segments[segments.length - 1] ?? '').toLowerCase();

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (SENSITIVE_DIRECTORIES.has(lower)) {
      reasons.push(`"${segment}" holds version-control internals or stored credentials`);
    }
  }

  // ".env", ".env.local", ".env.production" — and deliberately ".env.example"
  // too, because users routinely paste real values into the example file. The
  // cost of one extra approval is far below the cost of one leaked key.
  // ".environment.ts" and "environment.ts" are NOT matched: the pattern anchors
  // on the whole ".env" component.
  if (/^\.env(\.[^.]+)*$/i.test(filename)) {
    reasons.push('environment file — may contain secrets');
  }
  // ".gitignore" and ".github/" start with ".git" and are ordinary files. Only
  // the exact ".git" component (handled above) is VCS internals.
  if (SENSITIVE_FILENAMES.has(filename)) {
    reasons.push('filename is a well-known credential file');
  }

  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  if (SENSITIVE_EXTENSIONS.has(ext)) {
    reasons.push(`"${ext}" files hold key material`);
  }

  for (const word of SENSITIVE_WORDS) {
    if (word.test(filename)) {
      reasons.push('filename names a credential');
      break;
    }
  }

  const sensitive = reasons.length > 0;
  return { sensitive, reasons, message: sensitive ? RESTRICTED_FILE_MESSAGE : null };
}

/**
 * Would reading or writing this path expose a secret or corrupt VCS state?
 * A `true` here does not block the operation — it forces it through an explicit
 * owner approval.
 */
export function isSensitivePath(candidate: string): boolean {
  return describeSensitivePath(candidate).sensitive;
}
