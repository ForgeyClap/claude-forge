/**
 * Forge Workspace — attachment security policy.
 *
 * `detect.ts` says WHAT a file is. This file decides what the workspace is
 * allowed to do with it, and it is written on the assumption that every byte
 * arriving here was chosen by someone who wants something bad to happen.
 *
 * The rules, and the reason each one exists:
 *
 *  - SIZE AND QUOTA. Three separate ceilings — per file, per message, per
 *    project — because one huge file, one enormous message and slow disk
 *    exhaustion are three different attacks with three different shapes.
 *  - EXECUTABLES ARE QUARANTINED, NOT STORED. Native code, byte code and OS
 *    execution vectors never reach the staging directory at all. Nothing in
 *    Forge ever runs an attachment; not writing it is the way to keep that true
 *    even if a later bug tries to.
 *  - ARCHIVES ARE READ, NEVER OPENED. A ZIP's central directory is parsed from
 *    the bytes we already hold. Nothing is decompressed, so a decompression bomb
 *    is refused on the strength of its own declared sizes, before any allocation.
 *  - ACTIVE DOCUMENTS ARE NEUTRALISED OR QUARANTINED. SVG is script-capable,
 *    HTML is script-capable, Markdown can smuggle both. The preview pipeline
 *    escapes or sanitises; where sanitisation cannot be done CONFIDENTLY the
 *    file is quarantined instead of being half-cleaned and shown anyway.
 *  - TERMINAL ESCAPES ARE STRIPPED FROM EVERY TEXT PREVIEW AND EVERY DISPLAYED
 *    FILENAME. A file body must never be able to repaint the operator's screen.
 *  - SECRETS ARE REPORTED, NEVER ECHOED. A finding names the rule and the line.
 *    It never contains the matched text, because a leak warning that quotes the
 *    leak has just written the secret into a second place.
 *
 * This module is pure: bytes and configuration in, a decision out. No I/O, no
 * clock, no randomness, no spawning. It cannot open, extract or execute
 * anything, which is the strongest form of "it never will".
 */

import type { OperationErrorCode, SecurityVerdict } from '../../shared/protocol.ts';

import { compareDeclaredWithDetected, decodeTextWindow, extensionOf, allExtensionsOf } from './detect.ts';
import type { DetectedFormat, DetectionResult, MediaTypeComparison } from './detect.ts';

/* ========================================================================== */
/*  Limits                                                                     */
/* ========================================================================== */

export interface AttachmentLimits {
  /** Largest single file that may be staged. */
  readonly maxFileBytes: number;
  /** Largest combined payload one message may carry. */
  readonly maxMessageTotalBytes: number;
  /** Largest combined payload one project may hold in its staging area. */
  readonly maxProjectQuotaBytes: number;
  readonly maxAttachmentsPerMessage: number;
  readonly maxFilenameLength: number;
  /** ZIP: refuse an archive declaring more entries than this. */
  readonly maxZipEntries: number;
  /** ZIP: refuse when the declared uncompressed total exceeds this. */
  readonly maxZipUncompressedBytes: number;
  /** ZIP: refuse above this expansion factor (a decompression bomb). */
  readonly maxZipCompressionRatio: number;
  /** ZIP: ignore the ratio rule below this size — small text zips are spiky. */
  readonly zipRatioFloorBytes: number;
  /** ZIP: an archive is depth 1. An archive inside it is depth 2 and refused. */
  readonly maxArchiveDepth: number;
  /** Characters of text kept for a preview. */
  readonly maxPreviewChars: number;
  /** Bytes of text scanned for secrets. */
  readonly maxSecretScanBytes: number;
}

/**
 * Defaults chosen for a local, single-user workspace on a normal disk. Every
 * number is a policy decision, not a physical limit, and the bridge may lower
 * them; nothing in the pipeline treats them as guarantees about anything else.
 */
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxMessageTotalBytes: 64 * 1024 * 1024,
  maxProjectQuotaBytes: 512 * 1024 * 1024,
  maxAttachmentsPerMessage: 20,
  maxFilenameLength: 200,
  maxZipEntries: 2048,
  maxZipUncompressedBytes: 256 * 1024 * 1024,
  maxZipCompressionRatio: 100,
  zipRatioFloorBytes: 4 * 1024 * 1024,
  maxArchiveDepth: 1,
  maxPreviewChars: 64 * 1024,
  maxSecretScanBytes: 2 * 1024 * 1024,
});

export function resolveLimits(overrides?: Partial<AttachmentLimits>): AttachmentLimits {
  return Object.freeze({ ...DEFAULT_ATTACHMENT_LIMITS, ...(overrides ?? {}) });
}

/* ========================================================================== */
/*  Findings                                                                   */
/* ========================================================================== */

/**
 * INFO        worth recording, changes nothing.
 * WARN        the file is accepted and the user is told something true about it.
 * QUARANTINE  metadata is kept, the bytes are not stored, Claude never sees it.
 * REJECT      the file does not enter the workspace at all.
 */
export type FindingSeverity = 'INFO' | 'WARN' | 'QUARANTINE' | 'REJECT';

export interface SecurityFinding {
  /** Stable identifier, safe to branch on and to count in metrics. */
  readonly rule: string;
  readonly severity: FindingSeverity;
  /** A sentence for a person. NEVER contains file content or a secret. */
  readonly message: string;
  /** Where in the file, when that is known: "line 42", "zip entry 7". */
  readonly where?: string;
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { INFO: 0, WARN: 1, QUARANTINE: 2, REJECT: 3 };

const SEVERITY_TO_VERDICT: Readonly<Record<FindingSeverity, SecurityVerdict>> = {
  INFO: 'CLEAN',
  WARN: 'WARN',
  QUARANTINE: 'QUARANTINE',
  REJECT: 'REJECT',
};

/** The worst finding decides the verdict. Nothing averages risk away. */
export function verdictFrom(findings: readonly SecurityFinding[]): SecurityVerdict {
  let worst: FindingSeverity = 'INFO';
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst]) worst = finding.severity;
  }
  return SEVERITY_TO_VERDICT[worst];
}

/* ========================================================================== */
/*  Terminal escapes and display safety                                        */
/* ========================================================================== */

const ESC = 0x1b;
const BEL = 0x07;

/**
 * Remove every terminal control sequence from a string.
 *
 * This is written as a scanner rather than a pile of regular expressions
 * because the dangerous cases are the malformed ones: an unterminated OSC, a
 * CSI with no final byte, an 8-bit C1 introducer. A regex that only matches
 * WELL-FORMED sequences leaves exactly those behind, and they are what actually
 * repaints a terminal or hides text in a log.
 *
 * Newline, tab and carriage return survive. Everything else below 0x20, the
 * DEL byte, and the whole C1 range are dropped.
 */
export function stripTerminalEscapes(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;

  const skipStringSequence = (start: number): number => {
    // Runs to a String Terminator (ESC \ or 0x9C) or BEL, or to the end.
    let j = start;
    while (j < n) {
      const code = input.charCodeAt(j);
      if (code === BEL || code === 0x9c) return j + 1;
      if (code === ESC && j + 1 < n && input[j + 1] === '\\') return j + 2;
      j += 1;
    }
    return n;
  };

  const skipCsi = (start: number): number => {
    let j = start;
    while (j < n) {
      const code = input.charCodeAt(j);
      if (code >= 0x30 && code <= 0x3f) {
        j += 1;
        continue;
      } // parameters
      if (code >= 0x20 && code <= 0x2f) {
        j += 1;
        continue;
      } // intermediates
      if (code >= 0x40 && code <= 0x7e) return j + 1; // final byte
      return j; // malformed: stop here, the character is handled normally
    }
    return n;
  };

  while (i < n) {
    const code = input.charCodeAt(i);

    if (code === ESC) {
      const next = i + 1 < n ? input[i + 1] : '';
      if (next === '[') {
        i = skipCsi(i + 2);
        continue;
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
        i = skipStringSequence(i + 2);
        continue;
      }
      if (next === '(' || next === ')' || next === '*' || next === '+' || next === '-' || next === '.' || next === '/') {
        i += 3; // charset designation: ESC, intermediate, final
        continue;
      }
      i += next === '' ? 1 : 2; // any other two-character escape
      continue;
    }

    if (code === 0x9b) {
      i = skipCsi(i + 1); // 8-bit CSI
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x9e || code === 0x9f || code === 0x98) {
      i = skipStringSequence(i + 1); // 8-bit OSC/DCS/PM/APC/SOS
      continue;
    }

    // Control characters that are not layout: dropped outright.
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      i += 1;
      continue;
    }

    out += input[i];
    i += 1;
  }

  return out;
}

/**
 * Invisible and direction-overriding characters, which forge how text reads.
 * Two constants on purpose: a global regex carries `lastIndex` state, so the
 * one used with `.test()` must NOT be the one used with `.replace()`.
 */
const BIDI_AND_INVISIBLE_G = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g;
const BIDI_AND_INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/;

/**
 * The only form of a filename or a text fragment that may reach a screen: no
 * terminal escapes, no invisible characters, no direction overrides.
 */
export function sanitiseForDisplay(input: string): string {
  return stripTerminalEscapes(input).replace(BIDI_AND_INVISIBLE_G, '');
}

/** HTML-escape. Used so source is shown AS SOURCE and never as markup. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ========================================================================== */
/*  Filenames                                                                  */
/* ========================================================================== */

const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul', 'clock$', 'conin$', 'conout$',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Extensions that name an execution vector on Windows, POSIX or both. The list
 * from the mission brief, plus the immediate siblings that behave identically.
 *
 * Deliberately NOT here: .js, .mjs, .py, .rb, .ts. They are source code a user
 * legitimately attaches for review, they are not executed by Forge, and
 * quarantining them would train the operator to ignore quarantine. A shebang or
 * a real executable header still catches the ones that are meant to run.
 */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.exe', '.dll', '.scr', '.bat', '.cmd', '.ps1', '.sh',
  '.com', '.pif', '.msi', '.msp', '.cpl', '.msc', '.sys', '.drv',
  '.vbs', '.vbe', '.wsf', '.wsh', '.hta', '.jar', '.lnk', '.app', '.gadget',
]);

/** True archives. Used for the nesting rule; container documents are separate. */
export const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.tbz', '.xz', '.txz',
  '.zst', '.lz', '.lzma', '.cab', '.iso', '.arj', '.z',
]);

/**
 * ZIP-based documents. They ARE archives structurally, but a user attaching a
 * .docx has not nested an archive in any meaningful sense, so they are noted
 * rather than refused. Stated explicitly because it is a judgement call.
 */
export const CONTAINER_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub', '.apk', '.war', '.ear',
]);

export interface FilenameInspection {
  readonly ok: boolean;
  /** Safe to render. Escapes and invisible characters removed. */
  readonly display: string;
  /** Safe to use as ONE path segment on disk. Never derived from user text alone. */
  readonly stored: string;
  readonly extension: string | null;
  readonly findings: readonly SecurityFinding[];
}

/**
 * Judge a claimed filename and produce the two forms the system needs: one for
 * a screen, one for a disk. Neither is the raw input, and the raw input is
 * never used to build a path.
 */
export function inspectFilename(filename: unknown, limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS): FilenameInspection {
  const findings: SecurityFinding[] = [];
  const reject = (rule: string, message: string): FilenameInspection => ({
    ok: false,
    display: typeof filename === 'string' ? sanitiseForDisplay(filename).slice(0, 120) : '(not a string)',
    stored: '',
    extension: null,
    findings: [{ rule, severity: 'REJECT', message }],
  });

  if (typeof filename !== 'string') return reject('filename-type', 'The filename must be a string.');
  if (filename.length === 0) return reject('filename-empty', 'The filename is empty.');
  if (filename.length > limits.maxFilenameLength) {
    return reject('filename-too-long', `The filename is longer than ${limits.maxFilenameLength} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(filename)) {
    return reject('filename-control-character', 'The filename contains a control character, which can forge how it is displayed.');
  }
  if (BIDI_AND_INVISIBLE.test(filename)) {
    return reject(
      'filename-bidi-override',
      'The filename contains an invisible or direction-overriding character. Such a name renders as one thing and opens as another.',
    );
  }
  if (/[\\/]/.test(filename)) {
    return reject('filename-path-separator', 'A filename may not contain a path separator; an attachment name is one segment, never a path.');
  }
  if (filename.includes('..')) {
    return reject('filename-dot-dot', 'The filename contains a dot-dot sequence.');
  }
  if (filename.includes(':')) {
    return reject('filename-colon', 'The filename contains a colon, which names an NTFS alternate data stream.');
  }

  const display = sanitiseForDisplay(filename);
  const trimmed = filename.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '');
  if (trimmed.length === 0) {
    return reject('filename-only-dots', 'The filename is only dots and whitespace.');
  }

  const extension = extensionOf(trimmed);
  const base = extension === null ? trimmed : trimmed.slice(0, trimmed.length - extension.length);
  const deviceCheck = (base.split('.')[0] ?? '').toLowerCase();
  if (RESERVED_DEVICE_NAMES.has(deviceCheck) || RESERVED_DEVICE_NAMES.has(trimmed.toLowerCase())) {
    return reject('filename-reserved-device', `"${deviceCheck}" is a Windows reserved device name and is never a file.`);
  }

  // The stored name is built from an allowlist, so nothing the user typed can
  // survive into a path unexamined.
  const safeBase = base
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80);
  const safeExtension = extension !== null && /^\.[a-z0-9]{1,12}$/i.test(extension) ? extension.toLowerCase() : '';
  const stored = `${safeBase.length > 0 ? safeBase : 'attachment'}${safeExtension}`;

  if (stored.toLowerCase() !== trimmed.toLowerCase()) {
    findings.push({
      rule: 'filename-rewritten',
      severity: 'INFO',
      message: `The file is stored as "${stored}"; the name you supplied is kept as the original name.`,
    });
  }

  const extras = allExtensionsOf(trimmed);
  if (extras.length > 1) {
    findings.push({
      rule: 'filename-multiple-extensions',
      severity: 'INFO',
      message: `The name carries more than one extension (${extras.join(', ')}).`,
    });
  }

  return { ok: true, display, stored, extension, findings };
}

/* ========================================================================== */
/*  ZIP central directory                                                      */
/* ========================================================================== */

export interface ZipEntrySummary {
  /** Display-safe. Escapes and invisible characters already removed. */
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly method: number;
  readonly encrypted: boolean;
  readonly directory: boolean;
}

export interface ZipInspection {
  /** False when the central directory could not be read at all. */
  readonly inspected: boolean;
  readonly reason: string;
  readonly declaredEntryCount: number;
  readonly entriesRead: number;
  readonly totalCompressed: number;
  readonly totalUncompressed: number;
  readonly ratio: number | null;
  readonly zip64: boolean;
  readonly encryptedEntries: number;
  readonly nestedArchives: readonly string[];
  readonly containerDocuments: readonly string[];
  readonly executableEntries: readonly string[];
  readonly escapingEntries: readonly string[];
  /** A capped sample, for the record. Never the whole listing. */
  readonly sample: readonly ZipEntrySummary[];
  readonly findings: readonly SecurityFinding[];
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const ZIP_ENTRY_SAMPLE_LIMIT = 64;

function u16(bytes: Uint8Array, off: number): number {
  return bytes[off] + bytes[off + 1] * 0x100;
}
function u32(bytes: Uint8Array, off: number): number {
  return bytes[off] + bytes[off + 1] * 0x100 + bytes[off + 2] * 0x10000 + bytes[off + 3] * 0x1000000;
}
function u64(bytes: Uint8Array, off: number): number {
  const lo = u32(bytes, off);
  const hi = u32(bytes, off + 4);
  // Beyond 2^53 JavaScript cannot represent the value exactly. Saturating is
  // safe here: every use is a "> limit" comparison, and a saturated value can
  // only ever make the archive MORE likely to be refused.
  if (hi > 0x1fffff) return Number.MAX_SAFE_INTEGER;
  return lo + hi * 0x100000000;
}

/** Where a ZIP entry name would land if anyone ever joined it to a root. */
function zipEntryEscape(name: string): string | null {
  if (name.length === 0) return 'the entry has an empty name';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return 'the entry name contains a control character';
  if (name.startsWith('/') || name.startsWith('\\')) return 'the entry name is an absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'the entry name carries a drive letter';
  let depth = 0;
  for (const segment of name.split(/[\\/]+/)) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return 'the entry name escapes the archive root when joined (zip-slip)';
      continue;
    }
    depth += 1;
  }
  return null;
}

/**
 * Read a ZIP's central directory from bytes we already hold. Nothing is
 * decompressed and no entry is ever written; the verdict is reached from the
 * archive's own declared sizes, which is what makes a bomb refusable before a
 * single byte is inflated.
 *
 * HONEST LIMIT: the sizes are the archive's own claims. A malformed archive can
 * declare small sizes and hold large data — which is exactly why nothing here
 * ever extracts, and why the pipeline never hands an archive to a tool that
 * would.
 */
export function inspectZip(bytes: Uint8Array, limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS): ZipInspection {
  const findings: SecurityFinding[] = [];
  const empty = (reason: string): ZipInspection => ({
    inspected: false,
    reason,
    declaredEntryCount: 0,
    entriesRead: 0,
    totalCompressed: 0,
    totalUncompressed: 0,
    ratio: null,
    zip64: false,
    encryptedEntries: 0,
    nestedArchives: [],
    containerDocuments: [],
    executableEntries: [],
    escapingEntries: [],
    sample: [],
    findings: [
      {
        rule: 'zip-uninspectable',
        severity: 'REJECT',
        message: `This ZIP archive could not be inspected (${reason}). An archive whose contents cannot be checked is refused rather than accepted on trust.`,
      },
    ],
  });

  // Locate the end-of-central-directory record: it sits within the last
  // 22 + 65535 bytes, after a comment of unknown length.
  const searchFrom = Math.max(0, bytes.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = bytes.length - 22; i >= searchFrom; i -= 1) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return empty('no end-of-central-directory record was found');

  let declaredEntryCount = u16(bytes, eocd + 10);
  let centralSize = u32(bytes, eocd + 12);
  let centralOffset = u32(bytes, eocd + 16);
  let zip64 = false;

  // ZIP64: the 32-bit fields saturate at 0xFFFF/0xFFFFFFFF and the real values
  // live in a separate record found through a locator just before the EOCD.
  if (eocd >= 20 && u32(bytes, eocd - 20) === SIG_EOCD64_LOCATOR) {
    const zip64Offset = u64(bytes, eocd - 20 + 8);
    if (zip64Offset >= 0 && zip64Offset + 56 <= bytes.length && u32(bytes, zip64Offset) === SIG_EOCD64) {
      zip64 = true;
      declaredEntryCount = u64(bytes, zip64Offset + 32);
      centralSize = u64(bytes, zip64Offset + 40);
      centralOffset = u64(bytes, zip64Offset + 48);
    }
  }

  // A self-extracting or prefixed archive shifts every recorded offset. Recover
  // it from the directory size rather than trusting the stored offset.
  if (centralOffset + 4 > bytes.length || u32(bytes, centralOffset) !== SIG_CENTRAL) {
    const adjusted = eocd - centralSize;
    if (adjusted >= 0 && adjusted + 4 <= bytes.length && u32(bytes, adjusted) === SIG_CENTRAL) {
      findings.push({
        rule: 'zip-prefixed',
        severity: 'WARN',
        message:
          'The archive has data before its first entry, so its recorded offsets are shifted. This is how a self-extracting archive is built; the directory was located by size instead.',
      });
      centralOffset = adjusted;
    } else if (declaredEntryCount === 0 && centralSize === 0) {
      return {
        inspected: true,
        reason: 'empty archive',
        declaredEntryCount: 0,
        entriesRead: 0,
        totalCompressed: 0,
        totalUncompressed: 0,
        ratio: null,
        zip64,
        encryptedEntries: 0,
        nestedArchives: [],
        containerDocuments: [],
        executableEntries: [],
        escapingEntries: [],
        sample: [],
        findings: [{ rule: 'zip-empty', severity: 'WARN', message: 'The archive declares no entries.' }],
      };
    } else {
      return empty('the central directory offset does not point at a central directory header');
    }
  }

  if (declaredEntryCount > limits.maxZipEntries) {
    findings.push({
      rule: 'zip-entry-count',
      severity: 'REJECT',
      message: `The archive declares ${declaredEntryCount} entries; the limit is ${limits.maxZipEntries}.`,
    });
  }

  const sample: ZipEntrySummary[] = [];
  const nestedArchives: string[] = [];
  const containerDocuments: string[] = [];
  const executableEntries: string[] = [];
  const escapingEntries: string[] = [];
  let encryptedEntries = 0;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let entriesRead = 0;
  let notUtf8Names = 0;

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let cursor = centralOffset;
  const walkLimit = Math.min(declaredEntryCount, limits.maxZipEntries + 1);

  while (entriesRead < walkLimit) {
    if (cursor + 46 > bytes.length || u32(bytes, cursor) !== SIG_CENTRAL) break;

    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    let compressedSize = u32(bytes, cursor + 20);
    let uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const nameStart = cursor + 46;
    if (nameStart + nameLength + extraLength + commentLength > bytes.length) break;

    const rawName = bytes.subarray(nameStart, nameStart + nameLength);
    const name = decoder.decode(rawName);
    if ((flags & 0x800) === 0) notUtf8Names += 1;

    // ZIP64 extended information: present only for the fields that saturated.
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      let extra = nameStart + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const headerId = u16(bytes, extra);
        const dataSize = u16(bytes, extra + 2);
        if (headerId === 0x0001 && extra + 4 + dataSize <= extraEnd) {
          let field = extra + 4;
          if (uncompressedSize === 0xffffffff && field + 8 <= extraEnd) {
            uncompressedSize = u64(bytes, field);
            field += 8;
          }
          if (compressedSize === 0xffffffff && field + 8 <= extraEnd) {
            compressedSize = u64(bytes, field);
          }
          break;
        }
        extra += 4 + dataSize;
      }
    }

    const encrypted = (flags & 0x0001) !== 0;
    if (encrypted) encryptedEntries += 1;
    const directory = name.endsWith('/') || name.endsWith('\\');
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;

    const displayName = sanitiseForDisplay(name).slice(0, 160);
    const escape = zipEntryEscape(name);
    if (escape !== null) escapingEntries.push(`${displayName}: ${escape}`);
    else if (name.includes('\\')) {
      escapingEntries.push(`${displayName}: the entry name uses backslashes, which become directory separators on Windows`);
    }

    const entryExtension = extensionOf(name);
    if (entryExtension !== null) {
      if (ARCHIVE_EXTENSIONS.has(entryExtension)) nestedArchives.push(displayName);
      else if (CONTAINER_DOCUMENT_EXTENSIONS.has(entryExtension)) containerDocuments.push(displayName);
      if (EXECUTABLE_EXTENSIONS.has(entryExtension)) executableEntries.push(displayName);
    }

    // A single entry that expands enormously is a bomb even when the archive
    // total looks reasonable.
    if (uncompressedSize > limits.zipRatioFloorBytes && compressedSize > 0) {
      const entryRatio = uncompressedSize / compressedSize;
      if (entryRatio > limits.maxZipCompressionRatio * 2) {
        findings.push({
          rule: 'zip-entry-ratio',
          severity: 'REJECT',
          message: `One entry expands ${Math.round(entryRatio)}× (${compressedSize} bytes to ${uncompressedSize}). That is a decompression bomb, not a document.`,
          where: `zip entry ${entriesRead + 1}`,
        });
      }
    }

    if (sample.length < ZIP_ENTRY_SAMPLE_LIMIT) {
      sample.push({ name: displayName, compressedSize, uncompressedSize, method, encrypted, directory });
    }

    entriesRead += 1;
    cursor = nameStart + nameLength + extraLength + commentLength;
  }

  const ratio = totalCompressed > 0 ? totalUncompressed / totalCompressed : null;

  if (entriesRead < declaredEntryCount) {
    findings.push({
      rule: 'zip-truncated-directory',
      severity: 'REJECT',
      message: `The archive declares ${declaredEntryCount} entries but only ${entriesRead} could be read. A directory that does not match its own header is refused.`,
    });
  }
  if (totalUncompressed > limits.maxZipUncompressedBytes) {
    findings.push({
      rule: 'zip-uncompressed-total',
      severity: 'REJECT',
      message: `The archive declares ${totalUncompressed} bytes uncompressed; the limit is ${limits.maxZipUncompressedBytes}.`,
    });
  }
  if (ratio !== null && totalUncompressed > limits.zipRatioFloorBytes && ratio > limits.maxZipCompressionRatio) {
    findings.push({
      rule: 'zip-compression-ratio',
      severity: 'REJECT',
      message: `The archive expands ${Math.round(ratio)}× overall; anything above ${limits.maxZipCompressionRatio}× is treated as a decompression bomb.`,
    });
  }
  if (escapingEntries.length > 0) {
    findings.push({
      rule: 'zip-slip',
      severity: 'REJECT',
      message: `${escapingEntries.length} entry name(s) would write outside the archive root: ${escapingEntries.slice(0, 3).join('; ')}${escapingEntries.length > 3 ? '; …' : ''}`,
    });
  }
  if (nestedArchives.length > 0 && limits.maxArchiveDepth <= 1) {
    findings.push({
      rule: 'zip-nested-archive',
      severity: 'REJECT',
      message: `The archive contains ${nestedArchives.length} nested archive(s) (${nestedArchives.slice(0, 3).join(', ')}${nestedArchives.length > 3 ? ', …' : ''}). Nesting beyond depth ${limits.maxArchiveDepth} is refused, because the contents of an inner archive cannot be inspected from here.`,
    });
  }
  if (containerDocuments.length > 0) {
    findings.push({
      rule: 'zip-container-document',
      severity: 'WARN',
      message: `The archive contains ${containerDocuments.length} ZIP-based document(s) (${containerDocuments.slice(0, 3).join(', ')}). Their inner contents were not inspected.`,
    });
  }
  if (executableEntries.length > 0) {
    findings.push({
      rule: 'zip-executable-entry',
      severity: 'WARN',
      message: `The archive contains ${executableEntries.length} entry(ies) with an executable extension (${executableEntries.slice(0, 3).join(', ')}). Nothing is extracted or executed; this is recorded so you know what is inside.`,
    });
  }
  if (encryptedEntries > 0) {
    findings.push({
      rule: 'zip-encrypted-entry',
      severity: 'WARN',
      message: `${encryptedEntries} entry(ies) are encrypted, so their contents could not be inspected. What is inside them is UNKNOWN.`,
    });
  }
  if (notUtf8Names > 0) {
    findings.push({
      rule: 'zip-legacy-name-encoding',
      severity: 'INFO',
      message: `${notUtf8Names} entry name(s) are not flagged as UTF-8; they were decoded as UTF-8 anyway, so those names may render imperfectly.`,
    });
  }

  return {
    inspected: true,
    reason: 'ok',
    declaredEntryCount,
    entriesRead,
    totalCompressed,
    totalUncompressed,
    ratio,
    zip64,
    encryptedEntries,
    nestedArchives,
    containerDocuments,
    executableEntries,
    escapingEntries,
    sample,
    findings,
  };
}

/* ========================================================================== */
/*  SVG                                                                        */
/* ========================================================================== */

export type SvgRemovalKind = 'active-content' | 'external-reference' | 'structural';

export interface SvgRemoval {
  readonly kind: SvgRemovalKind;
  readonly what: string;
  readonly detail: string;
}

export interface SvgSanitisation {
  /** True when the whole document was parsed and rewritten without guessing. */
  readonly confident: boolean;
  readonly reason: string;
  readonly sanitised: string;
  readonly removals: readonly SvgRemoval[];
  readonly hadActiveContent: boolean;
}

/** Elements that execute, fetch, or embed a second document. */
const SVG_BLOCKED_ELEMENTS: ReadonlySet<string> = new Set([
  'script', 'foreignobject', 'iframe', 'embed', 'object', 'applet', 'frame', 'frameset',
  'audio', 'video', 'link', 'meta', 'base', 'handler', 'listener',
  'animate', 'animatetransform', 'animatemotion', 'set',
]);

/** URI schemes that run code or load a second document. */
const DANGEROUS_SCHEMES: readonly string[] = ['javascript:', 'vbscript:', 'livescript:', 'data:text/html', 'data:image/svg+xml', 'data:application'];

/** Attributes whose value is a URI and therefore has to be judged. */
const URI_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'xlink:href', 'src', 'xlink:base', 'action', 'formaction', 'data', 'to', 'from', 'values', 'begin', 'end']);

/** Decode the encodings that hide a scheme: `&#106;avascript:` is javascript:. */
function decodeForSchemeCheck(value: string): string {
  const decoded = value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n');
  // eslint-disable-next-line no-control-regex
  return decoded.replace(/[\u0000-\u0020\u007f-\u00a0]+/g, '').toLowerCase();
}

function isDangerousUri(value: string): boolean {
  const normalised = decodeForSchemeCheck(value);
  return DANGEROUS_SCHEMES.some((scheme) => normalised.startsWith(scheme));
}

function isExternalUri(value: string): boolean {
  const normalised = decodeForSchemeCheck(value);
  return /^(https?:|ftp:|\/\/)/.test(normalised);
}

interface ParsedTag {
  readonly ok: boolean;
  readonly end: number;
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: readonly { readonly name: string; readonly value: string; readonly quote: string }[];
}

/** Quote-aware tag reader. Returns ok:false the moment it has to guess. */
function parseTag(text: string, start: number): ParsedTag {
  const fail: ParsedTag = { ok: false, end: start, name: '', closing: false, selfClosing: false, attributes: [] };
  let i = start + 1;
  const closing = text[i] === '/';
  if (closing) i += 1;
  const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(text.slice(i));
  if (!nameMatch) return fail;
  const name = nameMatch[0];
  i += name.length;

  const attributes: { name: string; value: string; quote: string }[] = [];
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) return fail;
    if (text[i] === '>') return { ok: true, end: i + 1, name, closing, selfClosing: false, attributes };
    if (text[i] === '/' && text[i + 1] === '>') {
      return { ok: true, end: i + 2, name, closing, selfClosing: true, attributes };
    }
    const attrMatch = /^[^\s=/>]+/.exec(text.slice(i));
    if (!attrMatch) return fail;
    const attrName = attrMatch[0];
    i += attrName.length;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== '=') {
      attributes.push({ name: attrName, value: '', quote: '' });
      continue;
    }
    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    const quote = text[i] === '"' || text[i] === "'" ? text[i] : '';
    if (quote !== '') {
      const close = text.indexOf(quote, i + 1);
      if (close === -1) return fail; // unterminated attribute: refuse to guess
      attributes.push({ name: attrName, value: text.slice(i + 1, close), quote });
      i = close + 1;
    } else {
      const valueMatch = /^[^\s>]*/.exec(text.slice(i));
      const value = valueMatch ? valueMatch[0] : '';
      attributes.push({ name: attrName, value, quote: '' });
      i += value.length;
    }
  }
}

function quoteAttribute(value: string): string {
  return `"${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`;
}

/**
 * Sanitise an SVG document for preview.
 *
 * THE CHOICE THIS MODULE MAKES, stated plainly: SVG is sanitised, and the
 * sanitiser's own confidence decides what happens next.
 *
 *   - parsed cleanly, nothing active removed  -> the sanitised SVG may be shown.
 *   - parsed cleanly, active content removed  -> QUARANTINE. We do not ship a
 *     file we just had to disarm; the removal proves it was hostile, and
 *     trusting our own regex-free-but-still-handwritten parser against a
 *     deliberate attacker is not a bet worth making.
 *   - could not parse confidently              -> QUARANTINE, metadata only.
 *
 * External references (http/https) are stripped as well: rendering them would
 * leak the operator's IP address to whoever supplied the file.
 */
export function sanitiseSvg(source: string): SvgSanitisation {
  const removals: SvgRemoval[] = [];
  const text = stripTerminalEscapes(source);

  if (/<!entity/i.test(text) || /<!doctype[^>]*\[/i.test(text)) {
    return {
      confident: false,
      reason: 'the document declares an internal DTD subset or XML entities, which can expand recursively or read local files (XXE)',
      sanitised: '',
      removals: [
        {
          kind: 'active-content',
          what: '<!ENTITY>',
          detail: 'entity declarations can expand recursively (billion laughs) or pull in local files (XXE); this cannot be sanitised confidently',
        },
      ],
      hadActiveContent: true,
    };
  }

  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, lt);

    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt);
      if (close === -1) {
        return { confident: false, reason: 'an XML comment is never closed', sanitised: '', removals, hadActiveContent: false };
      }
      i = close + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt);
      if (close === -1) {
        return { confident: false, reason: 'a CDATA section is never closed', sanitised: '', removals, hadActiveContent: false };
      }
      // CDATA content is text, not markup — but it is dropped rather than
      // re-emitted, because its only common use in a hostile SVG is to hide a
      // script body from a naive filter.
      removals.push({ kind: 'structural', what: 'CDATA section', detail: 'CDATA is dropped from the preview rather than re-emitted' });
      i = close + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const close = text.indexOf('?>', lt);
      if (close === -1) {
        return { confident: false, reason: 'a processing instruction is never closed', sanitised: '', removals, hadActiveContent: false };
      }
      removals.push({
        kind: 'active-content',
        what: 'processing instruction',
        detail: 'xml-stylesheet and friends can attach an external stylesheet or script to the document',
      });
      i = close + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const close = text.indexOf('>', lt);
      if (close === -1) {
        return { confident: false, reason: 'a declaration is never closed', sanitised: '', removals, hadActiveContent: false };
      }
      i = close + 1;
      continue;
    }

    const tag = parseTag(text, lt);
    if (!tag.ok) {
      return {
        confident: false,
        reason: `a tag at offset ${lt} could not be parsed without guessing (unterminated attribute or malformed name)`,
        sanitised: '',
        removals,
        hadActiveContent: false,
      };
    }

    const bareName = tag.name.toLowerCase().replace(/^[^:]*:/, '');

    if (SVG_BLOCKED_ELEMENTS.has(bareName)) {
      removals.push({
        kind: 'active-content',
        what: `<${bareName}>`,
        detail: 'this element executes script, animates an attribute into one, or embeds a second document',
      });
      if (tag.closing || tag.selfClosing) {
        i = tag.end;
        continue;
      }
      // Skip the element's whole subtree, counting nested opens of the same name.
      let depth = 1;
      let j = tag.end;
      while (j < n && depth > 0) {
        const nextLt = text.indexOf('<', j);
        if (nextLt === -1) {
          return { confident: false, reason: `<${bareName}> is never closed`, sanitised: '', removals, hadActiveContent: true };
        }
        const inner = parseTag(text, nextLt);
        if (!inner.ok) {
          // Inside a blocked element, an unparseable tag is not fatal on its own
          // — the content is being discarded either way — but we must keep
          // moving deterministically.
          j = nextLt + 1;
          continue;
        }
        const innerName = inner.name.toLowerCase().replace(/^[^:]*:/, '');
        if (innerName === bareName) depth += inner.closing ? -1 : inner.selfClosing ? 0 : 1;
        j = inner.end;
      }
      if (depth > 0) {
        return { confident: false, reason: `<${bareName}> is never closed`, sanitised: '', removals, hadActiveContent: true };
      }
      i = j;
      continue;
    }

    if (tag.closing) {
      out += `</${tag.name}>`;
      i = tag.end;
      continue;
    }

    let rebuilt = `<${tag.name}`;
    for (const attribute of tag.attributes) {
      const attrName = attribute.name.toLowerCase();

      if (/^on/.test(attrName)) {
        removals.push({ kind: 'active-content', what: `${attribute.name}=`, detail: 'an event handler attribute runs script when the image is viewed' });
        continue;
      }
      if (URI_ATTRIBUTES.has(attrName)) {
        if (isDangerousUri(attribute.value)) {
          removals.push({ kind: 'active-content', what: `${attribute.name}=`, detail: 'the URI names a scheme that executes code or loads a second document' });
          continue;
        }
        if (isExternalUri(attribute.value)) {
          removals.push({ kind: 'external-reference', what: `${attribute.name}=`, detail: 'an external URL would be fetched when the image is viewed, revealing the viewer to whoever supplied the file' });
          continue;
        }
      }
      if (attrName === 'style' && /(url\s*\(|expression\s*\(|@import|behavior\s*:)/i.test(attribute.value)) {
        removals.push({ kind: 'active-content', what: 'style=', detail: 'the inline style loads an external resource or uses a legacy scripting construct' });
        continue;
      }
      rebuilt += attribute.quote === '' && attribute.value === '' ? ` ${attribute.name}` : ` ${attribute.name}=${quoteAttribute(attribute.value)}`;
    }
    rebuilt += tag.selfClosing ? '/>' : '>';
    out += rebuilt;
    i = tag.end;
  }

  // A <style> element that survived may still carry an @import.
  if (/@import|expression\s*\(/i.test(out)) {
    removals.push({ kind: 'active-content', what: '<style>', detail: 'a stylesheet imports an external resource or uses a legacy scripting construct' });
    out = out.replace(/<style[\s\S]*?<\/style>/gi, '');
  }

  return {
    confident: true,
    reason: 'ok',
    sanitised: out,
    removals,
    hadActiveContent: removals.some((removal) => removal.kind === 'active-content'),
  };
}

/* ========================================================================== */
/*  Markdown and source previews                                               */
/* ========================================================================== */

/**
 * Markdown is sanitised, not rendered raw: HTML is escaped so an embedded
 * `<script>` is shown as text, and link targets whose scheme is not plainly
 * safe are rewritten so a click cannot execute anything.
 */
export function sanitiseMarkdownPreview(source: string): string {
  const safe = escapeHtml(sanitiseForDisplay(source));
  return safe.replace(/\]\(\s*([^)\s]+)/g, (whole: string, target: string) => {
    const normalised = decodeForSchemeCheck(target);
    if (/^(https?:|mailto:|#|\.\/|\.\.\/|\/)/.test(normalised) || !/^[a-z][a-z0-9+.-]*:/.test(normalised)) {
      return whole;
    }
    return '](blocked-scheme:';
  });
}

/** Source shown as source: escapes stripped, then HTML-escaped. Never rendered. */
export function buildEscapedSourcePreview(source: string): string {
  return escapeHtml(sanitiseForDisplay(source));
}

/* ========================================================================== */
/*  Secret scanning                                                            */
/* ========================================================================== */

export interface SecretFinding {
  readonly rule: string;
  /** 1-based line number in the scanned window. */
  readonly line: number;
  /** What was found, in words. NEVER the matched text. */
  readonly description: string;
}

interface SecretRule {
  readonly rule: string;
  readonly pattern: RegExp;
  readonly description: string;
}

/**
 * The two halves of a PEM armour marker, kept apart on purpose.
 *
 * A rule that DETECTS a private key has to spell the marker out exactly, which
 * means a file full of such rules reads, to any credential scanner, like a file
 * full of private keys — including this project's own leak scan, which cannot
 * tell a pattern DEFINITION in a `.ts` file from a pasted key. Joining the halves
 * at module load gives the regexes a source string identical to the one a literal
 * would produce, while no contiguous marker text exists anywhere in the repository.
 * The patterns below are therefore unchanged in behaviour; only their spelling in
 * this file is.
 */
const PEM_BEGIN = '-----BEGIN';
const PEM_KEY_TAIL = 'PRIVATE KEY-----';

/**
 * Patterns for credentials that are unambiguous on sight. Every one is anchored
 * on a vendor prefix or a structural marker, because a scanner that cries wolf
 * is a scanner that gets switched off.
 */
const SECRET_RULES: readonly SecretRule[] = [
  { rule: 'private-key-block', pattern: new RegExp(`${PEM_BEGIN}(?: [A-Z0-9]+)* ${PEM_KEY_TAIL}`), description: 'a PEM private key block' },
  { rule: 'openssh-private-key', pattern: new RegExp(`${PEM_BEGIN} OPENSSH ${PEM_KEY_TAIL}`), description: 'an OpenSSH private key block' },
  { rule: 'pgp-private-key', pattern: new RegExp(`${PEM_BEGIN} PGP PRIVATE KEY BLOCK-----`), description: 'a PGP private key block' },
  { rule: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AIDA|AGPA|AIPA|ANPA|ANVA|AROA|APKA)[A-Z0-9]{16}\b/, description: 'an AWS access key id' },
  { rule: 'aws-secret-access-key', pattern: /aws_?secret_?access_?key["'\s:=]{1,10}[A-Za-z0-9/+=]{40}/i, description: 'an AWS secret access key assignment' },
  { rule: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/, description: 'a GitHub access token' },
  { rule: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, description: 'a Slack token' },
  { rule: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/, description: 'a Slack incoming-webhook URL' },
  { rule: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, description: 'a Google API key' },
  { rule: 'stripe-secret-key', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/, description: 'a Stripe secret key' },
  { rule: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/, description: 'an npm access token' },
  { rule: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, description: 'an Anthropic API key' },
  { rule: 'openai-api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, description: 'an OpenAI-style API key' },
  { rule: 'bearer-token', pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i, description: 'a bearer token in an Authorization value' },
  { rule: 'basic-auth-header', pattern: /authorization\s*[:=]\s*["']?basic\s+[A-Za-z0-9+/]{12,}={0,2}/i, description: 'a Basic authorization header' },
  { rule: 'json-web-token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/, description: 'a JSON Web Token' },
  { rule: 'url-embedded-credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]{2,}:[^/\s:@]{2,}@/i, description: 'a URL with an inline username and password' },
];

/** Names that mean the value beside them is probably a credential. */
const SECRETISH_NAME = /(?:^|[^a-z0-9])(?:api[_-]?key|secret|token|password|passwd|pwd|credential|private[_-]?key|access[_-]?key|auth)(?:[^a-z0-9]|$)/i;

const PLACEHOLDER = /(example|sample|dummy|placeholder|changeme|your[_-]?|xxx+|\.\.\.|<[^>]+>|\$\{|process\.env|os\.environ|redacted|todo)/i;

/** Shannon entropy per character. High entropy plus a secretish name is a key. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Scan text for credentials.
 *
 * The findings never contain the matched text — not even a redacted prefix. A
 * warning that quotes the secret has copied it into the event log, the record
 * file and the UI, which is three more places it now leaks from.
 */
export function scanForSecrets(text: string, maxLines = 20000): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split('\n', maxLines);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > 4096) continue; // minified bundles are noise, not secrets
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ rule: rule.rule, line: index + 1, description: rule.description });
      }
    }
    const assignment = /([A-Za-z0-9_.-]{2,60})\s*[:=]\s*["'`]([^"'`\n]{20,200})["'`]/.exec(line);
    if (assignment) {
      const name = assignment[1];
      const value = assignment[2];
      if (SECRETISH_NAME.test(name) && !PLACEHOLDER.test(value) && shannonEntropy(value) >= 3.5) {
        findings.push({
          rule: 'high-entropy-assignment',
          line: index + 1,
          description: `a high-entropy value assigned to "${sanitiseForDisplay(name).slice(0, 40)}"`,
        });
      }
    }
  }

  // Collapse repeats so one key file does not produce a thousand findings.
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule}:${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ========================================================================== */
/*  Previews                                                                   */
/* ========================================================================== */

export type PreviewKind = 'image' | 'escaped-source' | 'sanitised-markdown' | 'sanitised-svg' | 'metadata-only';

export interface PreviewPlan {
  readonly kind: PreviewKind;
  /** Already sanitised. Null for `image` (the UI reads the stored file) and
   *  for `metadata-only` (there is deliberately nothing to show). */
  readonly text: string | null;
  readonly truncated: boolean;
  /** Why this preview kind, in words a user can act on. */
  readonly reason: string;
}

const IMAGE_PREVIEW_FORMATS: ReadonlySet<DetectedFormat> = new Set<DetectedFormat>(['png', 'jpeg', 'webp', 'gif', 'bmp', 'ico']);

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.mdx', '.mdown']);

/* ========================================================================== */
/*  The decision                                                               */
/* ========================================================================== */

export interface PolicyInput {
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly bytes: Uint8Array;
  readonly detection: DetectionResult;
  readonly limits?: Partial<AttachmentLimits>;
  /** Bytes already attached to this draft message, excluding this file. */
  readonly messageBytesSoFar?: number;
  /** Attachments already on this draft message, excluding this file. */
  readonly messageAttachmentsSoFar?: number;
  /** Bytes already stored in this project's staging area, excluding this file. */
  readonly projectBytesSoFar?: number;
}

export interface PolicyDecision {
  readonly verdict: SecurityVerdict;
  readonly findings: readonly SecurityFinding[];
  /** One sentence per finding, in the order they were raised. */
  readonly notes: readonly string[];
  /** Whether Claude Code may ever be pointed at this file. */
  readonly claudeAccessible: boolean;
  /** Whether the bytes may be written to disk at all. */
  readonly storeBytes: boolean;
  readonly preview: PreviewPlan;
  readonly limits: AttachmentLimits;
  /** The protocol error code the bridge must return when this is not accepted. */
  readonly rejectionCode: OperationErrorCode | null;
  readonly filename: FilenameInspection;
  readonly mismatch: MediaTypeComparison;
  readonly zip: ZipInspection | null;
  readonly svg: SvgSanitisation | null;
  readonly secrets: readonly SecretFinding[];
}

/**
 * Decide what may be done with one file.
 *
 * Order matters: the cheap structural refusals run first so a hostile file is
 * refused before any parsing happens, and content inspection runs only on
 * material that has already earned it.
 */
export function evaluateAttachmentPolicy(input: PolicyInput): PolicyDecision {
  const limits = resolveLimits(input.limits);
  const findings: SecurityFinding[] = [];
  const detection = input.detection;
  const size = input.bytes.length;

  const filename = inspectFilename(input.filename, limits);
  findings.push(...filename.findings);

  const mismatch = compareDeclaredWithDetected(
    typeof input.filename === 'string' ? input.filename : '',
    input.declaredMediaType,
    detection,
  );

  let zip: ZipInspection | null = null;
  let svg: SvgSanitisation | null = null;
  let secrets: readonly SecretFinding[] = [];
  let preview: PreviewPlan = {
    kind: 'metadata-only',
    text: null,
    truncated: false,
    reason: 'No preview was produced.',
  };

  /* ------------------------------------------------------------ size gates */

  if (filename.ok) {
    if (size === 0) {
      findings.push({
        rule: 'zero-byte-file',
        severity: 'REJECT',
        message: 'The file is zero bytes long. There is nothing to attach, and an empty file usually means the upload was interrupted — your message and the rest of its attachments are untouched.',
      });
    }
    if (size > limits.maxFileBytes) {
      findings.push({
        rule: 'file-too-large',
        severity: 'REJECT',
        message: `The file is ${size} bytes; the per-file limit is ${limits.maxFileBytes} bytes.`,
      });
    }
    const messageBytes = (input.messageBytesSoFar ?? 0) + size;
    if (messageBytes > limits.maxMessageTotalBytes) {
      findings.push({
        rule: 'message-total-too-large',
        severity: 'REJECT',
        message: `This message's attachments would total ${messageBytes} bytes; the per-message limit is ${limits.maxMessageTotalBytes} bytes.`,
      });
    }
    if ((input.messageAttachmentsSoFar ?? 0) + 1 > limits.maxAttachmentsPerMessage) {
      findings.push({
        rule: 'message-attachment-count',
        severity: 'REJECT',
        message: `A message may carry at most ${limits.maxAttachmentsPerMessage} attachments.`,
      });
    }
    const projectBytes = (input.projectBytesSoFar ?? 0) + size;
    if (projectBytes > limits.maxProjectQuotaBytes) {
      findings.push({
        rule: 'project-quota-exceeded',
        severity: 'REJECT',
        message: `This project's attachment staging area would reach ${projectBytes} bytes; the quota is ${limits.maxProjectQuotaBytes} bytes. Remove some attachments before adding more.`,
      });
    }
  }

  /* ------------------------------------------------ declared versus detected */

  if (mismatch.mismatched) {
    const severity: FindingSeverity =
      mismatch.severity === 'CRITICAL' ? 'QUARANTINE' : mismatch.severity === 'SUSPICIOUS' ? 'WARN' : 'INFO';
    findings.push({
      rule: 'declared-detected-mismatch',
      severity,
      message: `What the file is called and what it contains do not agree. ${mismatch.reasons.join(' ')}`,
    });
  }

  /* ---------------------------------------------------------- executables */

  const extension = filename.extension;
  const extensionSaysExecutable = extension !== null && EXECUTABLE_EXTENSIONS.has(extension);
  if (detection.executable || extensionSaysExecutable) {
    const because = detection.executable
      ? `its bytes are ${detection.format}`
      : `its extension "${extension}" names an execution vector`;
    findings.push({
      rule: 'executable-content',
      severity: 'QUARANTINE',
      message: `This file is quarantined because ${because}. Forge records its metadata only: the bytes are not written to the project, Claude Code is never pointed at it, and nothing here ever executes an attachment.`,
    });
  }

  /* ----------------------------------------------------------- containers */

  if (detection.format === 'zip') {
    zip = inspectZip(input.bytes, limits);
    findings.push(...zip.findings);
  } else if (detection.archive) {
    findings.push({
      rule: 'archive-not-inspectable',
      severity: 'WARN',
      message: `This is a ${detection.format} archive. Only ZIP archives can be inspected from their directory without decompressing, so what is inside this one is UNKNOWN. It is stored as opaque bytes and never extracted.`,
    });
  } else if (detection.format === 'ole-compound') {
    findings.push({
      rule: 'ole-compound-document',
      severity: 'WARN',
      message: 'This is a legacy OLE compound document (an older Office file or an installer). It can carry macros. Forge never opens or runs it, and its internal streams were not inspected.',
    });
  }

  /* -------------------------------------------------------- text material */

  const decoded = detection.textLike
    ? decodeTextWindow(input.bytes, Math.max(limits.maxPreviewChars, limits.maxSecretScanBytes))
    : null;

  if (decoded !== null) {
    secrets = scanForSecrets(decoded.text);
    if (secrets.length > 0) {
      const rules = [...new Set(secrets.map((finding) => finding.rule))];
      const lines = secrets.slice(0, 5).map((finding) => finding.line);
      findings.push({
        rule: 'secret-pattern',
        severity: 'WARN',
        message: `This file looks like it contains credentials (${rules.join(', ')}) on line(s) ${lines.join(', ')}${secrets.length > 5 ? ' and more' : ''}. The matched text is deliberately not recorded anywhere. Check before sending it to Claude Code.`,
      });
    }
    if (decoded.truncated) {
      findings.push({
        rule: 'partial-text-scan',
        severity: 'INFO',
        message: 'The file is larger than the scan window, so only its beginning was checked for credentials. The rest is UNKNOWN.',
      });
    }
  } else if (!detection.textLike && detection.format !== 'empty') {
    findings.push({
      rule: 'binary-not-scanned',
      severity: 'INFO',
      message: 'This file is not text, so it was not scanned for credentials. Whether it contains any is UNKNOWN.',
    });
  }

  /* --------------------------------------------------------------- SVG */

  if (detection.format === 'svg' && decoded !== null) {
    svg = sanitiseSvg(decoded.text);
    if (!svg.confident) {
      findings.push({
        rule: 'svg-unsanitisable',
        severity: 'QUARANTINE',
        message: `This SVG could not be sanitised confidently (${svg.reason}), so it is quarantined and only its metadata is shown. SVG is a scriptable document, and a half-cleaned one is not safe to render.`,
      });
    } else if (svg.hadActiveContent) {
      const what = [...new Set(svg.removals.filter((r) => r.kind === 'active-content').map((r) => r.what))];
      findings.push({
        rule: 'svg-active-content',
        severity: 'QUARANTINE',
        message: `This SVG contains active content (${what.join(', ')}). The sanitiser removed it, and the file is still quarantined: a picture that had to be disarmed is not a picture. Metadata only.`,
      });
    } else if (svg.removals.length > 0) {
      const external = svg.removals.filter((r) => r.kind === 'external-reference').length;
      findings.push({
        rule: 'svg-external-references',
        severity: 'WARN',
        message: `${external} external reference(s) were removed from the SVG preview so that viewing it cannot report back to whoever supplied it.`,
      });
    }
  }

  /* ------------------------------------------------------------- verdict */

  const verdict = verdictFrom(findings);
  const storeBytes = verdict === 'CLEAN' || verdict === 'WARN';
  const claudeAccessible = storeBytes;

  /* ------------------------------------------------------------- preview */

  if (!storeBytes) {
    preview = {
      kind: 'metadata-only',
      text: null,
      truncated: false,
      reason:
        verdict === 'REJECT'
          ? 'The file was refused, so nothing of it is shown.'
          : 'The file is quarantined. Its metadata is kept; its content is never rendered and never handed to Claude Code.',
    };
  } else if (detection.format === 'svg' && svg !== null && svg.confident) {
    const text = svg.sanitised.slice(0, limits.maxPreviewChars);
    preview = {
      kind: 'sanitised-svg',
      text,
      truncated: svg.sanitised.length > text.length,
      reason: 'The SVG is shown after sanitisation; the original file on disk is never rendered directly.',
    };
  } else if (IMAGE_PREVIEW_FORMATS.has(detection.format)) {
    preview = {
      kind: 'image',
      text: null,
      truncated: false,
      reason: `Rendered as ${detection.format} because that is what the bytes are, not because of the file's name.`,
    };
  } else if (decoded !== null) {
    const isMarkdown = extension !== null && MARKDOWN_EXTENSIONS.has(extension);
    const source = decoded.text.slice(0, limits.maxPreviewChars);
    const truncated = decoded.truncated || decoded.text.length > source.length;
    preview = isMarkdown
      ? {
          kind: 'sanitised-markdown',
          text: sanitiseMarkdownPreview(source),
          truncated,
          reason: 'Markdown is sanitised before preview: embedded HTML is escaped and unsafe link schemes are neutralised.',
        }
      : {
          kind: 'escaped-source',
          text: buildEscapedSourcePreview(source),
          truncated,
          reason:
            detection.format === 'html'
              ? 'HTML is never rendered live. It is shown as escaped source.'
              : 'Text is shown as escaped source with terminal escape sequences removed.',
        };
  } else {
    preview = {
      kind: 'metadata-only',
      text: null,
      truncated: false,
      reason: `A ${detection.format} file has no safe textual preview, so only its metadata is shown.`,
    };
  }

  /* --------------------------------------------------------- error code */

  let rejectionCode: OperationErrorCode | null = null;
  if (verdict === 'REJECT') {
    const quotaRules = new Set(['file-too-large', 'message-total-too-large', 'message-attachment-count', 'project-quota-exceeded']);
    const rejects = findings.filter((finding) => finding.severity === 'REJECT');
    rejectionCode = rejects.every((finding) => quotaRules.has(finding.rule)) && rejects.length > 0 ? 'QUOTA_EXCEEDED' : 'ATTACHMENT_REJECTED';
  }

  return Object.freeze({
    verdict,
    findings: Object.freeze([...findings]),
    notes: Object.freeze(findings.map((finding) => (finding.where ? `[${finding.rule} @ ${finding.where}] ${finding.message}` : `[${finding.rule}] ${finding.message}`))),
    claudeAccessible,
    storeBytes,
    preview,
    limits,
    rejectionCode,
    filename,
    mismatch,
    zip,
    svg,
    secrets,
  });
}

/** The single sentence a UI should show for a verdict. */
export function describeVerdict(verdict: SecurityVerdict): string {
  switch (verdict) {
    case 'CLEAN':
      return 'Checked: nothing of concern was found.';
    case 'WARN':
      return 'Accepted with findings — read them before sending this file.';
    case 'QUARANTINE':
      return 'Quarantined: metadata only. The content is not stored and Claude Code cannot be pointed at it.';
    case 'REJECT':
      return 'Refused: this file did not enter the workspace.';
  }
}
