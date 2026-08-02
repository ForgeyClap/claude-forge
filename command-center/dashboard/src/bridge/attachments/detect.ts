/**
 * Forge Workspace — attachment content detection.
 *
 * ONE IDEA RUNS THROUGH THIS FILE: the name of a file is a claim made by whoever
 * handed it to us, and a claim is not evidence. `invoice.pdf` is a string. The
 * first eight bytes are a fact. Everything downstream — the policy, the preview,
 * whether Claude Code may ever be pointed at the file — is decided from the
 * bytes, and the declared extension is used only to detect that someone lied.
 *
 * What this module promises, and what it does not:
 *
 *  - It reads bytes. It never opens, executes, extracts, decompresses or renders
 *    anything. It has no I/O at all: bytes come in, a verdict goes out.
 *  - A detection carries its own evidence (offset + the signature that matched)
 *    so a later reader can re-check the claim instead of trusting the label.
 *  - When the bytes do not identify themselves, the answer is `unknown-binary`
 *    or `text` with a stated confidence — never a guess dressed as a fact. The
 *    policy layer is built to act sensibly on "we could not tell".
 *
 * Deliberate non-goal: this is not a virus scanner. It identifies FORMAT, and
 * the format of a thing is what decides how dangerous it is allowed to be.
 */

/* ========================================================================== */
/*  Formats                                                                    */
/* ========================================================================== */

/**
 * Every format this module can name. `unknown-binary` and `text` are real
 * answers, not failures — a plain .txt file genuinely has no magic number, and
 * pretending otherwise is how sniffers start inventing things.
 */
export const DETECTED_FORMATS = [
  // images
  'png',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'tiff',
  'ico',
  'avif-or-heif',
  // documents / archives
  'pdf',
  'zip',
  'gzip',
  'bzip2',
  'xz',
  'zstd',
  'sevenzip',
  'rar',
  'tar',
  'ole-compound',
  'rtf',
  // executable / code-bearing
  'elf',
  'pe',
  'macho',
  'java-class',
  'wasm',
  'windows-shortcut',
  'shebang-script',
  // text family
  'svg',
  'xml',
  'html',
  'json',
  'text',
  // honest non-answers
  'empty',
  'unknown-binary',
] as const;

export type DetectedFormat = (typeof DETECTED_FORMATS)[number];

/**
 * CERTAIN    a unique magic number matched at its defined offset.
 * PROBABLE   a magic number matched but a secondary check was unavailable
 *            (truncated file), or the format is identified by structure.
 * AMBIGUOUS  two formats share the signature and the tie-break is heuristic.
 * NONE       nothing identified it; the classification is by exclusion.
 */
export type DetectionConfidence = 'CERTAIN' | 'PROBABLE' | 'AMBIGUOUS' | 'NONE';

/** A re-checkable reason. `signature` is printable, never raw bytes. */
export interface DetectionEvidence {
  readonly offset: number;
  readonly signature: string;
  readonly note: string;
}

export interface DetectionResult {
  readonly format: DetectedFormat;
  /** The media type the FILE says it is. Null when nothing identified it. */
  readonly mediaType: string | null;
  readonly confidence: DetectionConfidence;
  readonly evidence: readonly DetectionEvidence[];
  /** Native machine code, byte code, or an OS-level execution vector. */
  readonly executable: boolean;
  /** A container whose entries must be inspected before it is trusted. */
  readonly archive: boolean;
  /** Safe to decode as text for a preview or a secret scan. */
  readonly textLike: boolean;
  readonly bytes: number;
  readonly bytesInspected: number;
  /** Sentences fit to show a person. Never contains file content. */
  readonly notes: readonly string[];
}

/** Formats that are code, or that exist to make code run. */
export const EXECUTABLE_FORMATS: ReadonlySet<DetectedFormat> = new Set<DetectedFormat>([
  'elf',
  'pe',
  'macho',
  'java-class',
  'wasm',
  'windows-shortcut',
  'shebang-script',
]);

/** Formats whose real payload is a set of other files. */
export const ARCHIVE_FORMATS: ReadonlySet<DetectedFormat> = new Set<DetectedFormat>([
  'zip',
  'gzip',
  'bzip2',
  'xz',
  'zstd',
  'sevenzip',
  'rar',
  'tar',
]);

export const TEXT_FORMATS: ReadonlySet<DetectedFormat> = new Set<DetectedFormat>([
  'svg',
  'xml',
  'html',
  'json',
  'text',
  'shebang-script',
]);

const FORMAT_MEDIA_TYPES: Readonly<Record<DetectedFormat, string | null>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  ico: 'image/vnd.microsoft.icon',
  'avif-or-heif': 'image/avif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gzip: 'application/gzip',
  bzip2: 'application/x-bzip2',
  xz: 'application/x-xz',
  zstd: 'application/zstd',
  sevenzip: 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  'ole-compound': 'application/x-ole-storage',
  rtf: 'application/rtf',
  elf: 'application/x-elf',
  pe: 'application/vnd.microsoft.portable-executable',
  macho: 'application/x-mach-binary',
  'java-class': 'application/java-vm',
  wasm: 'application/wasm',
  'windows-shortcut': 'application/x-ms-shortcut',
  'shebang-script': 'text/x-script',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  html: 'text/html',
  json: 'application/json',
  text: 'text/plain',
  empty: null,
  'unknown-binary': 'application/octet-stream',
};

export function mediaTypeForFormat(format: DetectedFormat): string | null {
  return FORMAT_MEDIA_TYPES[format];
}

export function isDetectedFormat(value: unknown): value is DetectedFormat {
  return typeof value === 'string' && (DETECTED_FORMATS as readonly string[]).includes(value);
}

/* ========================================================================== */
/*  Byte helpers                                                               */
/* ========================================================================== */

/** How much of a file the text heuristics are allowed to look at. */
export const TEXT_SNIFF_LIMIT = 8192;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (offset < 0 || offset + signature.length > bytes.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return '';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const code = bytes[offset + i];
    out += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : '.';
  }
  return out;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000 + bytes[offset + 3] * 0x1000000
  );
}

/** Printable form of a signature, for the evidence trail. Never raw bytes. */
function hexOf(bytes: Uint8Array, offset: number, length: number): string {
  const parts: string[] = [];
  const end = Math.min(offset + length, bytes.length);
  for (let i = offset; i < end; i += 1) parts.push(bytes[i].toString(16).padStart(2, '0').toUpperCase());
  return parts.join(' ');
}

/* ========================================================================== */
/*  Text decoding                                                              */
/* ========================================================================== */

export interface DecodedWindow {
  readonly text: string;
  readonly truncated: boolean;
  /** Share of decode failures. High means the bytes are not really text. */
  readonly replacementRatio: number;
  readonly hadNulByte: boolean;
}

/**
 * Decode the first `limit` bytes as UTF-8 without throwing.
 *
 * The decode is deliberately non-fatal and the caller is told how much of it
 * came back as U+FFFD, because "is this text?" is a judgement about a ratio, not
 * a yes/no the decoder can answer. A NUL byte is reported separately: a single
 * one is the strongest cheap signal that a file is binary.
 */
export function decodeTextWindow(bytes: Uint8Array, limit: number = TEXT_SNIFF_LIMIT): DecodedWindow {
  const end = Math.min(bytes.length, Math.max(0, limit));
  const window = bytes.subarray(0, end);
  let hadNulByte = false;
  for (let i = 0; i < window.length; i += 1) {
    if (window[i] === 0x00) {
      hadNulByte = true;
      break;
    }
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(window);
  let replacements = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) replacements += 1;
  }
  return {
    text,
    truncated: end < bytes.length,
    replacementRatio: text.length === 0 ? 0 : replacements / text.length,
    hadNulByte,
  };
}

/** Strips a UTF-8 BOM and leading whitespace so a sniff can see the first tag. */
function leadIn(text: string): string {
  return text.replace(/^\ufeff/, '').replace(/^[\s\r\n]+/, '');
}

/**
 * Skips XML prologue noise — declarations, comments, DOCTYPEs, processing
 * instructions — so `<svg` is found even when it is the fifth thing in the file.
 * Bounded so a pathological file cannot spin here.
 */
function skipXmlPrologue(text: string): string {
  let rest = leadIn(text);
  for (let guard = 0; guard < 32; guard += 1) {
    const before = rest;
    if (rest.startsWith('<?')) {
      const close = rest.indexOf('?>');
      rest = close === -1 ? '' : leadIn(rest.slice(close + 2));
    } else if (rest.startsWith('<!--')) {
      const close = rest.indexOf('-->');
      rest = close === -1 ? '' : leadIn(rest.slice(close + 3));
    } else if (/^<!doctype/i.test(rest)) {
      // A DOCTYPE may carry an internal subset in [...] which can itself
      // contain '>' — walk past the brackets before looking for the end.
      const bracket = rest.indexOf('[');
      const close = rest.indexOf('>');
      if (bracket !== -1 && close !== -1 && bracket < close) {
        const endBracket = rest.indexOf(']', bracket);
        const after = endBracket === -1 ? -1 : rest.indexOf('>', endBracket);
        rest = after === -1 ? '' : leadIn(rest.slice(after + 1));
      } else {
        rest = close === -1 ? '' : leadIn(rest.slice(close + 1));
      }
    }
    if (rest === before) break;
  }
  return rest;
}

/** Tags that mean "this is an HTML document" in the WHATWG sniffing sense. */
const HTML_HINTS: readonly RegExp[] = [
  /^<!doctype\s+html/i,
  /^<html[\s>]/i,
  /^<head[\s>]/i,
  /^<body[\s>]/i,
  /^<script[\s>]/i,
  /^<iframe[\s>]/i,
  /^<meta[\s>]/i,
  /^<title[\s>]/i,
  /^<table[\s>]/i,
  /^<div[\s>]/i,
  /^<p[\s>]/i,
  /^<h1[\s>]/i,
  /^<style[\s>]/i,
  /^<a\s/i,
];

/* ========================================================================== */
/*  detectFromBytes                                                            */
/* ========================================================================== */

interface Draft {
  format: DetectedFormat;
  confidence: DetectionConfidence;
  evidence: DetectionEvidence[];
  notes: string[];
}

function finish(bytes: Uint8Array, draft: Draft): DetectionResult {
  return Object.freeze({
    format: draft.format,
    mediaType: FORMAT_MEDIA_TYPES[draft.format],
    confidence: draft.confidence,
    evidence: Object.freeze([...draft.evidence]),
    executable: EXECUTABLE_FORMATS.has(draft.format),
    archive: ARCHIVE_FORMATS.has(draft.format),
    textLike: TEXT_FORMATS.has(draft.format),
    bytes: bytes.length,
    bytesInspected: Math.min(bytes.length, TEXT_SNIFF_LIMIT),
    notes: Object.freeze([...draft.notes]),
  });
}

/** One fixed-offset signature. Enough for most formats; the rest get functions. */
interface Signature {
  readonly format: DetectedFormat;
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly label: string;
  readonly note: string;
}

const SIGNATURES: readonly Signature[] = [
  { format: 'png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], label: '89 PNG\\r\\n\\x1a\\n', note: 'PNG signature, including the CR/LF trap bytes' },
  { format: 'gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], label: 'GIF87a', note: 'GIF header' },
  { format: 'gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], label: 'GIF89a', note: 'GIF header' },
  { format: 'pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], label: '%PDF-', note: 'PDF header at offset 0' },
  { format: 'gzip', offset: 0, bytes: [0x1f, 0x8b], label: '1F 8B', note: 'gzip member header' },
  { format: 'bzip2', offset: 0, bytes: [0x42, 0x5a, 0x68], label: 'BZh', note: 'bzip2 header' },
  { format: 'xz', offset: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], label: 'FD 7z XZ 00', note: 'xz container header' },
  { format: 'zstd', offset: 0, bytes: [0x28, 0xb5, 0x2f, 0xfd], label: '28 B5 2F FD', note: 'zstandard frame magic' },
  { format: 'sevenzip', offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: '7z BC AF 27 1C', note: '7-Zip header' },
  { format: 'rar', offset: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], label: 'Rar!\\x1a\\x07', note: 'RAR archive header' },
  { format: 'elf', offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46], label: '7F ELF', note: 'ELF executable header' },
  { format: 'wasm', offset: 0, bytes: [0x00, 0x61, 0x73, 0x6d], label: '\\0asm', note: 'WebAssembly module header' },
  { format: 'ole-compound', offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], label: 'D0 CF 11 E0 ...', note: 'OLE2 compound document (legacy Office, MSI)' },
  { format: 'rtf', offset: 0, bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66], label: '{\\rtf', note: 'Rich Text Format header' },
  { format: 'bmp', offset: 0, bytes: [0x42, 0x4d], label: 'BM', note: 'Windows bitmap header' },
  { format: 'tiff', offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00], label: 'II*\\0', note: 'TIFF, little-endian' },
  { format: 'tiff', offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a], label: 'MM\\0*', note: 'TIFF, big-endian' },
  { format: 'ico', offset: 0, bytes: [0x00, 0x00, 0x01, 0x00], label: '00 00 01 00', note: 'Windows icon header' },
  { format: 'windows-shortcut', offset: 0, bytes: [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00], label: '4C 00 00 00 01 14 02 00', note: 'Windows .lnk shell link — an execution vector, not a document' },
];

/** ZIP local/central/end signatures. All three start a legitimate archive. */
const ZIP_SIGNATURES: readonly { readonly bytes: readonly number[]; readonly label: string; readonly note: string }[] = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], label: 'PK\\x03\\x04', note: 'ZIP local file header' },
  { bytes: [0x50, 0x4b, 0x05, 0x06], label: 'PK\\x05\\x06', note: 'ZIP end-of-central-directory (empty archive)' },
  { bytes: [0x50, 0x4b, 0x07, 0x08], label: 'PK\\x07\\x08', note: 'ZIP spanned-archive marker' },
];

const MACHO_MAGICS: readonly { readonly value: number; readonly label: string; readonly note: string }[] = [
  { value: 0xfeedface, label: 'FE ED FA CE', note: 'Mach-O 32-bit, big-endian' },
  { value: 0xfeedfacf, label: 'FE ED FA CF', note: 'Mach-O 64-bit, big-endian' },
  { value: 0xcefaedfe, label: 'CE FA ED FE', note: 'Mach-O 32-bit, little-endian' },
  { value: 0xcffaedfe, label: 'CF FA ED FE', note: 'Mach-O 64-bit, little-endian' },
  { value: 0xcafebabf, label: 'CA FE BA BF', note: 'Mach-O 64-bit fat binary' },
  { value: 0xbebafeca, label: 'BE BA FE CA', note: 'Mach-O fat binary, byte-swapped' },
];

/**
 * Identify a file from its bytes.
 *
 * The order below is not cosmetic. Container and executable signatures are
 * checked before any text heuristic, because a file can be valid UTF-8 *and* a
 * shell script, and because "it decoded as text" must never outrank "it begins
 * with an ELF header".
 */
export function detectFromBytes(input: Uint8Array): DetectionResult {
  const bytes = input;
  const draft: Draft = { format: 'unknown-binary', confidence: 'NONE', evidence: [], notes: [] };

  if (bytes.length === 0) {
    draft.format = 'empty';
    draft.confidence = 'CERTAIN';
    draft.notes.push('The file is zero bytes long.');
    return finish(bytes, draft);
  }

  /* -------------------------------------------------- JPEG (SOI + a marker) */
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    draft.format = 'jpeg';
    draft.confidence = 'CERTAIN';
    draft.evidence.push({ offset: 0, signature: hexOf(bytes, 0, 3), note: 'JPEG start-of-image marker followed by a segment marker' });
    return finish(bytes, draft);
  }

  /* --------------------------------------- RIFF containers: WEBP lives here */
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) {
    if (ascii(bytes, 8, 4) === 'WEBP') {
      draft.format = 'webp';
      draft.confidence = 'CERTAIN';
      draft.evidence.push({ offset: 0, signature: 'RIFF....WEBP', note: 'RIFF container whose form type at offset 8 is WEBP' });
      return finish(bytes, draft);
    }
    draft.format = 'unknown-binary';
    draft.confidence = 'PROBABLE';
    draft.evidence.push({ offset: 0, signature: 'RIFF', note: `RIFF container, form type "${ascii(bytes, 8, 4)}"` });
    draft.notes.push('RIFF container that is not WEBP (WAV/AVI and friends are not identified further).');
    return finish(bytes, draft);
  }

  /* ------------------------------------------------------ ISO-BMFF (AVIF/HEIF) */
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    draft.format = 'avif-or-heif';
    draft.confidence = 'PROBABLE';
    draft.evidence.push({ offset: 4, signature: 'ftyp', note: `ISO base media file, brand "${ascii(bytes, 8, 4)}"` });
    draft.notes.push('ISO base media container (AVIF/HEIF/MP4 family); the exact brand is recorded, not interpreted.');
    return finish(bytes, draft);
  }

  /* ----------------------------------------------------------------- ZIP */
  for (const sig of ZIP_SIGNATURES) {
    if (startsWith(bytes, sig.bytes)) {
      draft.format = 'zip';
      draft.confidence = 'CERTAIN';
      draft.evidence.push({ offset: 0, signature: sig.label, note: sig.note });
      draft.notes.push('ZIP container. Its central directory must be inspected before the file is accepted; it is never extracted.');
      return finish(bytes, draft);
    }
  }

  /* ------------------------------------------------ PE (MZ + PE\0\0 at e_lfanew) */
  if (startsWith(bytes, [0x4d, 0x5a])) {
    draft.format = 'pe';
    draft.evidence.push({ offset: 0, signature: 'MZ', note: 'DOS MZ header — the start of every Windows executable image' });
    if (bytes.length >= 0x40) {
      const peOffset = u32le(bytes, 0x3c);
      if (peOffset > 0 && peOffset + 4 <= bytes.length && startsWith(bytes, [0x50, 0x45, 0x00, 0x00], peOffset)) {
        draft.confidence = 'CERTAIN';
        draft.evidence.push({ offset: peOffset, signature: 'PE\\0\\0', note: `PE header reached via e_lfanew = 0x${peOffset.toString(16)}` });
      } else {
        draft.confidence = 'PROBABLE';
        draft.notes.push(
          'MZ header present but no PE header was reachable at e_lfanew — a DOS-era executable, a truncated PE, or a deliberately malformed one. Treated as an executable either way.',
        );
      }
    } else {
      draft.confidence = 'PROBABLE';
      draft.notes.push('MZ header present but the file is too short to hold the PE offset field. Treated as an executable.');
    }
    return finish(bytes, draft);
  }

  /* ------------------------------------------------------------- Mach-O */
  if (bytes.length >= 4) {
    const magic = u32be(bytes, 0);
    for (const entry of MACHO_MAGICS) {
      if (magic === entry.value) {
        draft.format = 'macho';
        draft.confidence = 'CERTAIN';
        draft.evidence.push({ offset: 0, signature: entry.label, note: entry.note });
        return finish(bytes, draft);
      }
    }
    /*
     * 0xCAFEBABE is shared by Mach-O fat binaries and Java class files. Both are
     * executable code, so the security answer is the same either way — but the
     * report should still say which one it believes and why.
     */
    if (magic === 0xcafebabe && bytes.length >= 8) {
      const fatArchCount = u32be(bytes, 4);
      const classMajor = u16be(bytes, 6);
      const looksJava = classMajor >= 45 && classMajor <= 200 && u16be(bytes, 4) <= 20;
      draft.format = looksJava ? 'java-class' : 'macho';
      draft.confidence = 'AMBIGUOUS';
      draft.evidence.push({ offset: 0, signature: 'CA FE BA BE', note: 'shared by Mach-O fat binaries and Java class files' });
      draft.notes.push(
        looksJava
          ? `Read as a Java class file: major version ${classMajor} at offset 6. Either way this is executable code.`
          : `Read as a Mach-O fat binary: ${fatArchCount} architecture slice(s) declared at offset 4. Either way this is executable code.`,
      );
      return finish(bytes, draft);
    }
  }

  /* ------------------------------------------------------------------ tar */
  if (bytes.length >= 262 && ascii(bytes, 257, 5) === 'ustar') {
    draft.format = 'tar';
    draft.confidence = 'CERTAIN';
    draft.evidence.push({ offset: 257, signature: 'ustar', note: 'POSIX tar header magic' });
    return finish(bytes, draft);
  }

  /* ------------------------------------------------- fixed-offset signatures */
  for (const sig of SIGNATURES) {
    if (startsWith(bytes, sig.bytes, sig.offset)) {
      draft.format = sig.format;
      draft.confidence = 'CERTAIN';
      draft.evidence.push({ offset: sig.offset, signature: sig.label, note: sig.note });
      return finish(bytes, draft);
    }
  }

  /* ------------------------------------------------------ PDF, but not at 0 */
  if (bytes.length > 5) {
    const head = ascii(bytes, 0, Math.min(1024, bytes.length));
    const at = head.indexOf('%PDF-');
    if (at > 0) {
      draft.format = 'pdf';
      draft.confidence = 'PROBABLE';
      draft.evidence.push({ offset: at, signature: '%PDF-', note: `PDF header found at offset ${at}, not at 0` });
      draft.notes.push(
        `The PDF header is preceded by ${at} bytes of other data. Readers accept this; it is also how a file is made to look like two different formats at once.`,
      );
      return finish(bytes, draft);
    }
  }

  /* ----------------------------------------------------------- text family */
  const decoded = decodeTextWindow(bytes);
  if (decoded.hadNulByte) {
    draft.format = 'unknown-binary';
    draft.confidence = 'NONE';
    draft.notes.push('Contains a NUL byte in the first bytes read and matches no known signature: treated as opaque binary.');
    return finish(bytes, draft);
  }
  if (decoded.replacementRatio > 0.05) {
    draft.format = 'unknown-binary';
    draft.confidence = 'NONE';
    draft.notes.push(
      `Does not decode cleanly as UTF-8 (${Math.round(decoded.replacementRatio * 100)}% of the decoded window is replacement characters) and matches no known signature.`,
    );
    return finish(bytes, draft);
  }

  const text = decoded.text;
  const lead = leadIn(text);

  if (lead.startsWith('#!')) {
    draft.format = 'shebang-script';
    draft.confidence = 'CERTAIN';
    draft.evidence.push({ offset: 0, signature: '#!', note: 'shebang — the kernel is told which interpreter to run this with' });
    draft.notes.push('A shebang makes this file an execution instruction. Forge never runs it; it is treated as executable content.');
    return finish(bytes, draft);
  }

  const afterPrologue = skipXmlPrologue(text);
  if (/^<(?:[A-Za-z_][\w.-]*:)?svg[\s>]/i.test(afterPrologue)) {
    draft.format = 'svg';
    draft.confidence = 'CERTAIN';
    draft.evidence.push({ offset: 0, signature: '<svg', note: 'SVG root element found after the XML prologue' });
    draft.notes.push('SVG is a script-capable document, not a picture file. It is sanitised before any preview.');
    return finish(bytes, draft);
  }
  for (const hint of HTML_HINTS) {
    if (hint.test(afterPrologue)) {
      draft.format = 'html';
      draft.confidence = 'PROBABLE';
      draft.evidence.push({ offset: 0, signature: afterPrologue.slice(0, 16).replace(/\s+/g, ' '), note: 'HTML document element found at the start of the text' });
      return finish(bytes, draft);
    }
  }
  if (lead.startsWith('<?xml')) {
    draft.format = 'xml';
    draft.confidence = 'CERTAIN';
    draft.evidence.push({ offset: 0, signature: '<?xml', note: 'XML declaration' });
    return finish(bytes, draft);
  }
  if (!decoded.truncated && (lead.startsWith('{') || lead.startsWith('['))) {
    try {
      JSON.parse(text);
      draft.format = 'json';
      draft.confidence = 'CERTAIN';
      draft.evidence.push({ offset: 0, signature: lead[0], note: 'the whole file parses as JSON' });
      return finish(bytes, draft);
    } catch {
      // Starts like JSON but is not JSON. Fall through to plain text; saying
      // "JSON" here would be a claim the parser just refused to support.
      draft.notes.push('Begins like JSON but does not parse as JSON; classified as text.');
    }
  }
  if (decoded.truncated && (lead.startsWith('{') || lead.startsWith('['))) {
    draft.notes.push(
      `Begins like JSON but is larger than the ${TEXT_SNIFF_LIMIT}-byte sniff window, so it was not parsed. Classified as text rather than claimed as JSON.`,
    );
  }

  draft.format = 'text';
  draft.confidence = 'PROBABLE';
  draft.evidence.push({
    offset: 0,
    signature: '(no magic number)',
    note: `decodes as UTF-8 with no NUL bytes across the first ${Math.min(bytes.length, TEXT_SNIFF_LIMIT)} bytes`,
  });
  draft.notes.push('Plain text has no signature. This classification is by exclusion, and is labelled PROBABLE for that reason.');
  return finish(bytes, draft);
}

/* ========================================================================== */
/*  Declared vs detected                                                       */
/* ========================================================================== */

/** Lowercased final extension including the dot, or null. */
export function extensionOf(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot).toLowerCase();
}

/** Every extension-looking component, so `invoice.pdf.exe` is fully visible. */
export function allExtensionsOf(filename: string): readonly string[] {
  const base = (filename.split(/[\\/]/).pop() ?? '').toLowerCase();
  const parts = base.split('.');
  if (parts.length < 2) return [];
  return parts.slice(1).map((part) => `.${part}`);
}

/**
 * What each extension claims the bytes will be. Only formats that a correct file
 * could actually have — this table is used to catch lies, so being generous here
 * costs security.
 */
const EXTENSION_EXPECTATIONS: Readonly<Record<string, readonly DetectedFormat[]>> = {
  '.png': ['png'],
  '.jpg': ['jpeg'],
  '.jpeg': ['jpeg'],
  '.jfif': ['jpeg'],
  '.webp': ['webp'],
  '.gif': ['gif'],
  '.bmp': ['bmp'],
  '.tif': ['tiff'],
  '.tiff': ['tiff'],
  '.ico': ['ico'],
  '.avif': ['avif-or-heif'],
  '.heic': ['avif-or-heif'],
  '.svg': ['svg', 'xml'],
  '.pdf': ['pdf'],
  '.zip': ['zip'],
  '.docx': ['zip'],
  '.xlsx': ['zip'],
  '.pptx': ['zip'],
  '.odt': ['zip'],
  '.ods': ['zip'],
  '.epub': ['zip'],
  '.jar': ['zip'],
  '.gz': ['gzip'],
  '.tgz': ['gzip'],
  '.bz2': ['bzip2'],
  '.xz': ['xz'],
  '.zst': ['zstd'],
  '.7z': ['sevenzip'],
  '.rar': ['rar'],
  '.tar': ['tar'],
  '.doc': ['ole-compound'],
  '.xls': ['ole-compound'],
  '.ppt': ['ole-compound'],
  '.msi': ['ole-compound'],
  '.rtf': ['rtf'],
  '.exe': ['pe'],
  '.dll': ['pe'],
  '.scr': ['pe'],
  '.sys': ['pe'],
  '.com': ['pe'],
  '.so': ['elf'],
  '.dylib': ['macho'],
  '.class': ['java-class'],
  '.wasm': ['wasm'],
  '.lnk': ['windows-shortcut'],
  '.html': ['html', 'xml', 'text'],
  '.htm': ['html', 'xml', 'text'],
  '.xml': ['xml', 'html', 'text'],
  '.json': ['json', 'text'],
  '.md': ['text', 'html'],
  '.markdown': ['text', 'html'],
  '.txt': ['text'],
  '.log': ['text'],
  '.csv': ['text'],
  '.yaml': ['text'],
  '.yml': ['text'],
  '.toml': ['text'],
  '.ini': ['text'],
  '.sh': ['shebang-script', 'text'],
  '.bash': ['shebang-script', 'text'],
  '.zsh': ['shebang-script', 'text'],
  '.ps1': ['text', 'shebang-script'],
  '.bat': ['text'],
  '.cmd': ['text'],
  '.py': ['text', 'shebang-script'],
  '.rb': ['text', 'shebang-script'],
  '.js': ['text', 'shebang-script'],
  '.mjs': ['text', 'shebang-script'],
  '.cjs': ['text', 'shebang-script'],
  '.ts': ['text', 'shebang-script'],
  '.tsx': ['text'],
  '.jsx': ['text'],
  '.css': ['text'],
  '.sql': ['text'],
  '.go': ['text'],
  '.rs': ['text'],
  '.java': ['text'],
  '.c': ['text'],
  '.h': ['text'],
  '.cpp': ['text'],
  '.cs': ['text'],
  '.php': ['text'],
  '.diff': ['text'],
  '.patch': ['text'],
};

/**
 * NONE        the declaration and the bytes agree, or nothing could be checked.
 * BENIGN      a difference with no security meaning (a .jpg that is a .png).
 * SUSPICIOUS  the declaration is materially wrong about what the file is.
 * CRITICAL    the declaration hides executable content, or the filename itself
 *             is built to be misread by a human.
 */
export type MismatchSeverity = 'NONE' | 'BENIGN' | 'SUSPICIOUS' | 'CRITICAL';

export interface MediaTypeComparison {
  readonly mismatched: boolean;
  readonly severity: MismatchSeverity;
  readonly declaredExtension: string | null;
  readonly declaredMediaType: string;
  readonly detectedFormat: DetectedFormat;
  readonly detectedMediaType: string | null;
  /** Sentences fit to show a person. Never contains file content. */
  readonly reasons: readonly string[];
}

/** Characters that let a filename render as something other than what it is. */
// eslint-disable-next-line no-control-regex
const NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NAME_BIDI = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/;

const IMAGE_FORMATS: ReadonlySet<DetectedFormat> = new Set<DetectedFormat>([
  'png',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'tiff',
  'ico',
  'avif-or-heif',
]);

/**
 * Compare what was claimed with what the bytes say.
 *
 * A mismatch is a SECURITY FINDING, never a cosmetic note. The whole point of
 * sniffing is that `payload.png` containing an MZ header is the oldest trick
 * there is, and the only safe response is to believe the header.
 */
export function compareDeclaredWithDetected(
  filename: string,
  declaredMediaType: string,
  detection: DetectionResult,
): MediaTypeComparison {
  const reasons: string[] = [];
  let severity: MismatchSeverity = 'NONE';
  const raise = (next: MismatchSeverity): void => {
    const rank: Record<MismatchSeverity, number> = { NONE: 0, BENIGN: 1, SUSPICIOUS: 2, CRITICAL: 3 };
    if (rank[next] > rank[severity]) severity = next;
  };

  const declaredExtension = extensionOf(filename);
  const everyExtension = allExtensionsOf(filename);

  if (NAME_CONTROL.test(filename)) {
    raise('CRITICAL');
    reasons.push('The filename contains a control character, which can forge how it is displayed.');
  }
  if (NAME_BIDI.test(filename)) {
    raise('CRITICAL');
    reasons.push(
      'The filename contains an invisible or direction-overriding character. Such names render as one thing and execute as another.',
    );
  }

  // A hidden executable extension anywhere in the name — "report.exe.pdf" reads
  // as a PDF in a list and is still an executable to anyone who renames it.
  const executableExtensions = new Set(['.exe', '.dll', '.scr', '.bat', '.cmd', '.ps1', '.sh', '.com', '.msi', '.lnk', '.vbs', '.jar']);
  const hiddenExecutable = everyExtension.slice(0, -1).filter((ext) => executableExtensions.has(ext));
  if (hiddenExecutable.length > 0) {
    raise('SUSPICIOUS');
    reasons.push(`The filename carries an executable extension before its last one (${hiddenExecutable.join(', ')}).`);
  }

  if (detection.executable) {
    const extensionSaysExecutable = declaredExtension !== null && executableExtensions.has(declaredExtension);
    if (!extensionSaysExecutable) {
      raise('CRITICAL');
      reasons.push(
        `The bytes are ${detection.format} (executable code) but the name claims "${declaredExtension ?? 'no extension'}". An executable is being presented as something else.`,
      );
    }
  }

  const expected = declaredExtension === null ? undefined : EXTENSION_EXPECTATIONS[declaredExtension];
  if (expected && !expected.includes(detection.format)) {
    if (detection.format === 'empty') {
      raise('SUSPICIOUS');
      reasons.push('The file is empty, so it cannot be the format its extension claims.');
    } else if (IMAGE_FORMATS.has(detection.format) && expected.every((f) => IMAGE_FORMATS.has(f))) {
      raise('BENIGN');
      reasons.push(`Image format differs from the extension: "${declaredExtension}" versus detected ${detection.format}.`);
    } else if (detection.archive) {
      raise('SUSPICIOUS');
      reasons.push(`"${declaredExtension}" claims ${expected.join(' or ')}, but the bytes are an archive (${detection.format}).`);
    } else if (detection.format === 'unknown-binary' || detection.confidence === 'NONE') {
      raise('SUSPICIOUS');
      reasons.push(`"${declaredExtension}" claims ${expected.join(' or ')}, but nothing in the bytes confirms that.`);
    } else {
      raise('SUSPICIOUS');
      reasons.push(`"${declaredExtension}" claims ${expected.join(' or ')}, but the bytes are ${detection.format}.`);
    }
  }

  const declaredMajor = declaredMediaType.split('/')[0]?.trim().toLowerCase() ?? '';
  const detectedMajor = detection.mediaType?.split('/')[0]?.toLowerCase() ?? '';
  if (
    declaredMajor.length > 0 &&
    detectedMajor.length > 0 &&
    declaredMajor !== detectedMajor &&
    detection.confidence !== 'NONE' &&
    // "application/octet-stream" is what a browser sends when it does not know.
    declaredMediaType.toLowerCase() !== 'application/octet-stream'
  ) {
    raise('SUSPICIOUS');
    reasons.push(`The client declared "${declaredMediaType}" but the bytes are "${detection.mediaType}".`);
  }

  return Object.freeze({
    mismatched: severity !== 'NONE',
    severity,
    declaredExtension,
    declaredMediaType,
    detectedFormat: detection.format,
    detectedMediaType: detection.mediaType,
    reasons: Object.freeze(reasons),
  });
}

/** One line describing a detection, safe for a log or a UI row. */
export function describeDetection(detection: DetectionResult): string {
  const primary = detection.evidence[0];
  const where = primary ? ` (${primary.signature} at offset ${primary.offset})` : '';
  return `${detection.format} / ${detection.mediaType ?? 'no media type'} — ${detection.confidence}${where}`;
}
