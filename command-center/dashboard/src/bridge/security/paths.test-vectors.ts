/**
 * Forge Workspace — the path guard's adversarial corpus.
 *
 * This file is DATA ONLY. It imports nothing, so it can be loaded by the unit
 * suite, by a standalone `node` script, or by a future fuzzer without dragging
 * the guard (or the protocol) along with it.
 *
 * ---------------------------------------------------------------------------
 * HOW TO READ `expect`
 * ---------------------------------------------------------------------------
 * Every vector carries the same two fields so one runner can drive all of them:
 *
 *   'reject'  the guard must refuse. For slug vectors that means
 *             `inspectSlug(input).ok === false` (equivalently `sanitizeSlug`
 *             throws a PathGuardError). For containment vectors it means
 *             `assertInsideRoot(input, root)` throws. For sensitive-file
 *             vectors it means `isSensitivePath(input) === true` — the file is
 *             refused WITHOUT an explicit owner approval.
 *
 *   'accept'  the guard must let it through, and where `expectedSlug` /
 *             `expectedCanonical` is given, must produce exactly that value.
 *
 * The 'accept' rows are not filler. A guard that rejects everything is trivially
 * "secure" and completely useless; roughly a third of this corpus exists to
 * catch over-blocking, and several of those rows are deliberately scary-looking
 * inputs that are nonetheless legitimate ("..evil" is a real directory name,
 * "console" is not the CON device, "com10" is not a serial port).
 *
 * ---------------------------------------------------------------------------
 * PLATFORM AND FILESYSTEM
 * ---------------------------------------------------------------------------
 * `platform: 'win32' | 'posix' | 'any'` says which semantics a vector asserts.
 * The runner must pass the matching `{ platform }` option to the guard, and must
 * SKIP link vectors whose `platform` does not match the real host — symlink
 * resolution against a foreign path flavour produces a meaningless answer, and
 * a meaningless pass is worse than a skip.
 *
 * `LINK_VECTORS` need real filesystem setup. On Windows, creating a directory
 * SYMLINK needs Developer Mode or elevation, while a JUNCTION does not — so
 * those rows carry `mayRequireElevation`. If the runner cannot create the link,
 * it must report the vector as SKIPPED. It must never report it as passed.
 */

/* ========================================================================== */
/*  Shared shapes                                                              */
/* ========================================================================== */

export type VectorExpectation = 'reject' | 'accept';
export type VectorPlatform = 'win32' | 'posix' | 'any';

export interface SlugVector {
  readonly id: string;
  readonly kind: 'slug';
  readonly input: string;
  readonly expect: VectorExpectation;
  readonly why: string;
  readonly platform: VectorPlatform;
  /** Required exact output when `expect` is 'accept'. */
  readonly expectedSlug?: string;
  /** Substrings that must never appear in an accepted slug. */
  readonly forbiddenInSlug?: readonly string[];
}

export interface ContainmentVector {
  readonly id: string;
  readonly kind: 'containment';
  readonly root: string;
  readonly input: string;
  readonly expect: VectorExpectation;
  readonly why: string;
  readonly platform: VectorPlatform;
  /** Expected canonical return value when `expect` is 'accept'. */
  readonly expectedCanonical?: string;
  /** The guard should accept it, but the UI should warn about MAX_PATH. */
  readonly expectLongPathWarning?: boolean;
}

export interface SensitiveVector {
  readonly id: string;
  readonly kind: 'sensitive';
  readonly input: string;
  /** 'reject' = must be flagged restricted. See the header note on `expect`. */
  readonly expect: VectorExpectation;
  readonly why: string;
  readonly platform: VectorPlatform;
}

export interface CollisionVector {
  readonly id: string;
  readonly kind: 'collision';
  readonly existing: readonly string[];
  readonly input: string;
  /** 'reject' = detectCollision must report `collides: true`. */
  readonly expect: VectorExpectation;
  readonly why: string;
  readonly platform: VectorPlatform;
  readonly expectedReason?:
    | 'exact'
    | 'case'
    | 'separator'
    | 'diacritic'
    | 'confusable'
    | 'truncation';
}

export interface LinkVector {
  readonly id: string;
  readonly kind: 'link';
  /** Name of the link to create directly inside the temporary root. */
  readonly linkName: string;
  readonly linkType: 'symlink-dir' | 'symlink-file' | 'junction';
  /** Where the link points: outside the root, or a sibling inside it. */
  readonly target: 'outside-root' | 'inside-root';
  /** Path the runner asks the guard about, relative to the root. */
  readonly input: string;
  readonly expect: VectorExpectation;
  readonly why: string;
  readonly platform: VectorPlatform;
  readonly requiresRealFs: true;
  /** Windows refuses symlink creation without Developer Mode or elevation. */
  readonly mayRequireElevation: boolean;
}

export type PathVector =
  | SlugVector
  | ContainmentVector
  | SensitiveVector
  | CollisionVector
  | LinkVector;

/* ========================================================================== */
/*  Roots used by the containment corpus                                       */
/* ========================================================================== */

/**
 * The short root exists purely to express the prefix trap in its clearest form.
 * "C:\rootEVIL" shares a character prefix with "C:\root" but not a path prefix,
 * and any guard that reaches for `startsWith` fails this one row.
 */
export const TRAP_ROOT_WIN32 = 'C:\\root';
export const REAL_ROOT_WIN32 = 'C:\\Users\\test\\Documents\\ForgeProjecten';
export const TRAP_ROOT_POSIX = '/home/test/root';

/* ========================================================================== */
/*  Slug vectors                                                               */
/* ========================================================================== */

const OVERSIZED_NAME = 'a'.repeat(300);
const MAX_LENGTH_NAME = 'b'.repeat(128);

export const SLUG_VECTORS: readonly SlugVector[] = [
  /* --- classic traversal ------------------------------------------------- */
  {
    id: 'slug/traversal/posix-parent',
    kind: 'slug',
    input: '../secrets',
    expect: 'reject',
    why: 'Classic parent-directory escape. A slug is one path segment; a separator is never legitimate.',
    platform: 'any',
  },
  {
    id: 'slug/traversal/windows-parent',
    kind: 'slug',
    input: '..\\secrets',
    expect: 'reject',
    why: 'Backslash form of the same escape. Guards that only test "/" miss it on the one OS that matters here.',
    platform: 'any',
  },
  {
    id: 'slug/traversal/bare-dotdot',
    kind: 'slug',
    input: '..',
    expect: 'reject',
    why: 'Joining "root/.." lands on the parent of the trusted root with no separator involved.',
    platform: 'any',
  },
  {
    id: 'slug/traversal/bare-dot',
    kind: 'slug',
    input: '.',
    expect: 'reject',
    why: 'Joining "root/." returns the root itself, so the project would BE the root directory.',
    platform: 'any',
  },
  {
    id: 'slug/traversal/embedded',
    kind: 'slug',
    input: 'safe/../../etc',
    expect: 'reject',
    why: 'Traversal in the middle, not at the start — a prefix-only check passes this.',
    platform: 'any',
  },
  {
    id: 'slug/traversal/deep-repeat',
    kind: 'slug',
    input: '....//....//etc',
    expect: 'reject',
    why: 'The "....//" trick: a naive single-pass strip of "../" turns this back into "../../".',
    platform: 'any',
  },

  /* --- encoded traversal -------------------------------------------------- */
  {
    id: 'slug/encoded/percent-dotdot-slash',
    kind: 'slug',
    input: '%2e%2e%2fetc',
    expect: 'reject',
    why: 'Percent-encoded "../". Anything that decodes before it validates, or validates before it decodes, loses.',
    platform: 'any',
  },
  {
    id: 'slug/encoded/uppercase-hex',
    kind: 'slug',
    input: '%2E%2E%5Cwindows',
    expect: 'reject',
    why: 'Uppercase hex and an encoded backslash — the same attack past a case-sensitive denylist.',
    platform: 'any',
  },
  {
    id: 'slug/encoded/mixed-literal-and-encoded',
    kind: 'slug',
    input: '..%2f..%2f',
    expect: 'reject',
    why: 'Half literal, half encoded, so neither a pure literal check nor a pure decode check sees the whole thing.',
    platform: 'any',
  },
  {
    id: 'slug/encoded/double-encoded',
    kind: 'slug',
    input: '%252e%252e%252fetc',
    expect: 'reject',
    why: 'Double-encoded: one decode pass yields "%2e%2e%2f", which still looks harmless. Requires iterated decoding.',
    platform: 'any',
  },
  {
    id: 'slug/encoded/overlong-utf8-slash',
    kind: 'slug',
    input: '..%c0%afetc',
    expect: 'reject',
    why: 'Overlong UTF-8 encoding of "/" (the IIS unicode bug). Invalid UTF-8 must be treated as hostile, not as a plain "%".',
    platform: 'any',
  },
  {
    id: 'slug/encoded/null-byte-encoded',
    kind: 'slug',
    input: 'safe%00.txt',
    expect: 'reject',
    why: 'Encoded NUL. Once decoded, C string handling truncates the name and the extension check becomes meaningless.',
    platform: 'any',
  },

  /* --- unicode dot and separator lookalikes ------------------------------- */
  {
    id: 'slug/unicode/fullwidth-dots',
    kind: 'slug',
    input: '\uff0e\uff0e/etc',
    expect: 'reject',
    why: 'U+FF0E FULLWIDTH FULL STOP twice. NFKC folds it to ".." — which is why normalisation must run BEFORE the traversal check.',
    platform: 'any',
  },
  {
    id: 'slug/unicode/two-dot-leader',
    kind: 'slug',
    input: '\u2025\\etc',
    expect: 'reject',
    why: 'U+2025 TWO DOT LEADER is a single character that NFKC expands to two dots.',
    platform: 'any',
  },
  {
    id: 'slug/unicode/ellipsis',
    kind: 'slug',
    input: '\u2026',
    expect: 'reject',
    why: 'U+2026 HORIZONTAL ELLIPSIS expands to three dots under NFKC, which contains "..".',
    platform: 'any',
  },
  {
    id: 'slug/unicode/one-dot-leader',
    kind: 'slug',
    input: '\u2024\u2024\uff0fetc',
    expect: 'reject',
    why: 'ONE DOT LEADER twice plus FULLWIDTH SOLIDUS: an entirely non-ASCII spelling of "../".',
    platform: 'any',
  },
  {
    id: 'slug/unicode/fraction-slash',
    kind: 'slug',
    input: 'a\u2044\u2044b',
    expect: 'reject',
    why: 'U+2044 FRACTION SLASH is NOT folded by NFKC, so it needs an explicit lookalike table.',
    platform: 'any',
  },
  {
    id: 'slug/unicode/division-slash',
    kind: 'slug',
    input: 'a\u2215b',
    expect: 'reject',
    why: 'U+2215 DIVISION SLASH — same gap in NFKC as the fraction slash.',
    platform: 'any',
  },
  {
    id: 'slug/unicode/small-reverse-solidus',
    kind: 'slug',
    input: 'a\ufe68b',
    expect: 'reject',
    why: 'U+FE68 SMALL REVERSE SOLIDUS folds to a backslash under NFKC.',
    platform: 'any',
  },
  {
    id: 'slug/unicode/ideographic-full-stop',
    kind: 'slug',
    input: '\u3002\u3002\\x',
    expect: 'reject',
    why: 'U+3002 IDEOGRAPHIC FULL STOP is not NFKC-folded; without the explicit table this reads as a harmless CJK name.',
    platform: 'any',
  },
  {
    id: 'slug/unicode/rtl-override',
    kind: 'slug',
    input: 'invoice\u202egnp.exe',
    expect: 'reject',
    why: 'U+202E RIGHT-TO-LEFT OVERRIDE renders "invoice\u202egnp.exe" as "invoiceexe.png" in every file list.',
    platform: 'any',
  },
  {
    id: 'slug/unicode/zero-width-space',
    kind: 'slug',
    input: 'for\u200bge',
    expect: 'reject',
    why: 'A zero-width space produces a second folder that is pixel-identical to the first.',
    platform: 'any',
  },
  {
    id: 'slug/unicode/bom',
    kind: 'slug',
    input: '\ufeffproject',
    expect: 'reject',
    why: 'A leading BOM survives copy-paste from many editors and silently creates a distinct name.',
    platform: 'any',
  },
  {
    id: 'slug/unicode/soft-hyphen',
    kind: 'slug',
    input: 'pro\u00adject',
    expect: 'reject',
    why: 'SOFT HYPHEN is invisible in most renderers — same duplicate-folder problem as the zero-width space.',
    platform: 'any',
  },

  /* --- absolute paths, drives, UNC, devices ------------------------------- */
  {
    id: 'slug/absolute/windows-drive',
    kind: 'slug',
    input: 'C:\\Windows\\System32',
    expect: 'reject',
    why: 'An absolute path used as a name. path.join would keep the root prefix in several languages; here it must never get that far.',
    platform: 'any',
  },
  {
    id: 'slug/absolute/drive-relative',
    kind: 'slug',
    input: 'C:project',
    expect: 'reject',
    why: 'Drive-RELATIVE form: "C:project" means "project in the current directory of drive C:", which is not under the root.',
    platform: 'any',
  },
  {
    id: 'slug/absolute/posix-root',
    kind: 'slug',
    input: '/etc/passwd',
    expect: 'reject',
    why: 'POSIX absolute path. Rejected on every platform because the slug is a segment, not a path.',
    platform: 'any',
  },
  {
    id: 'slug/absolute/root-relative',
    kind: 'slug',
    input: '\\Windows',
    expect: 'reject',
    why: 'Root-relative on Windows: resolves to the current drive root, escaping the trusted root entirely.',
    platform: 'any',
  },
  {
    id: 'slug/absolute/unc',
    kind: 'slug',
    input: '\\\\attacker\\share',
    expect: 'reject',
    why: 'UNC path. Beyond escaping the root, opening it leaks NTLM credentials to the named host.',
    platform: 'any',
  },
  {
    id: 'slug/absolute/device-namespace',
    kind: 'slug',
    input: '\\\\?\\C:\\Windows',
    expect: 'reject',
    why: 'The \\\\?\\ prefix disables Win32 path normalisation, so "." and ".." stop being collapsed at all.',
    platform: 'any',
  },
  {
    id: 'slug/absolute/dos-device',
    kind: 'slug',
    input: '\\\\.\\pipe\\forge',
    expect: 'reject',
    why: 'The \\\\.\\ device namespace reaches pipes and raw volumes, not files.',
    platform: 'any',
  },
  {
    id: 'slug/ads/colon-stream',
    kind: 'slug',
    input: 'report:$DATA',
    expect: 'reject',
    why: 'NTFS alternate data stream. Writes hidden content that directory listings and most scanners never show.',
    platform: 'any',
  },
  {
    id: 'slug/ads/plain-colon',
    kind: 'slug',
    input: 'notes:draft',
    expect: 'reject',
    why: 'Any colon is an ADS separator on NTFS, even without the $DATA suffix.',
    platform: 'any',
  },

  /* --- control characters -------------------------------------------------- */
  {
    id: 'slug/control/null-byte',
    kind: 'slug',
    input: 'safe\u0000../../etc',
    expect: 'reject',
    why: 'A raw NUL truncates the string at the C boundary: JavaScript validates the long form, the OS opens the short one.',
    platform: 'any',
  },
  {
    id: 'slug/control/newline',
    kind: 'slug',
    input: 'line\nbreak',
    expect: 'reject',
    why: 'A newline in a name forges entries in any line-oriented log or event file.',
    platform: 'any',
  },
  {
    id: 'slug/control/carriage-return',
    kind: 'slug',
    input: 'name\r\nInjected: true',
    expect: 'reject',
    why: 'CRLF injection against the event stream, using a project name as the carrier.',
    platform: 'any',
  },
  {
    id: 'slug/control/escape-char',
    kind: 'slug',
    input: 'ansi\u001b[31mred',
    expect: 'reject',
    why: 'ANSI escape sequences let a project name repaint or clear an operator terminal.',
    platform: 'any',
  },
  {
    id: 'slug/control/c1-range',
    kind: 'slug',
    input: 'name\u0085next',
    expect: 'reject',
    why: 'U+0085 NEXT LINE is a C1 control that behaves as a line break in several parsers.',
    platform: 'any',
  },

  /* --- reserved device names ---------------------------------------------- */
  {
    id: 'slug/device/con',
    kind: 'slug',
    input: 'CON',
    expect: 'reject',
    why: 'The kernel resolves CON before the directory is consulted, so <root>\\CON is the console, not a folder.',
    platform: 'any',
  },
  {
    id: 'slug/device/prn',
    kind: 'slug',
    input: 'prn',
    expect: 'reject',
    why: 'Device names are case-insensitive.',
    platform: 'any',
  },
  {
    id: 'slug/device/aux',
    kind: 'slug',
    input: 'AuX',
    expect: 'reject',
    why: 'Mixed case is still the AUX device.',
    platform: 'any',
  },
  {
    id: 'slug/device/nul',
    kind: 'slug',
    input: 'NUL',
    expect: 'reject',
    why: 'Writes to NUL vanish, so a "project" named NUL would silently discard everything written into it.',
    platform: 'any',
  },
  {
    id: 'slug/device/com1',
    kind: 'slug',
    input: 'COM1',
    expect: 'reject',
    why: 'Serial port device.',
    platform: 'any',
  },
  {
    id: 'slug/device/com9',
    kind: 'slug',
    input: 'com9',
    expect: 'reject',
    why: 'The COM range ends at 9 — both ends of the range need a vector.',
    platform: 'any',
  },
  {
    id: 'slug/device/lpt1',
    kind: 'slug',
    input: 'LPT1',
    expect: 'reject',
    why: 'Parallel port device.',
    platform: 'any',
  },
  {
    id: 'slug/device/lpt9',
    kind: 'slug',
    input: 'lpt9',
    expect: 'reject',
    why: 'Upper end of the LPT range.',
    platform: 'any',
  },
  {
    id: 'slug/device/with-extension',
    kind: 'slug',
    input: 'CON.txt',
    expect: 'reject',
    why: 'Windows ignores the extension: CON.txt is still the console device. Extension-blind checks are required.',
    platform: 'any',
  },
  {
    id: 'slug/device/with-double-extension',
    kind: 'slug',
    input: 'LPT3.tar.gz',
    expect: 'reject',
    why: 'Only the part before the FIRST dot matters, so a multi-part extension does not disguise it.',
    platform: 'any',
  },
  {
    id: 'slug/device/nul-log',
    kind: 'slug',
    input: 'nul.log',
    expect: 'reject',
    why: 'A plausible-looking log filename that is actually the null device.',
    platform: 'any',
  },
  {
    id: 'slug/device/superscript-one',
    kind: 'slug',
    input: 'COM\u00b9',
    expect: 'reject',
    why: 'NFKC folds SUPERSCRIPT ONE to "1", turning an innocent-looking name into COM1 AFTER the naive check would have run.',
    platform: 'any',
  },
  {
    id: 'slug/device/conin',
    kind: 'slug',
    input: 'CONIN$',
    expect: 'reject',
    why: 'CONIN$ and CONOUT$ are real console devices that most reserved-name lists forget.',
    platform: 'any',
  },
  {
    id: 'slug/device/clock',
    kind: 'slug',
    input: 'clock$',
    expect: 'reject',
    why: 'Legacy CLOCK$ device, still reserved.',
    platform: 'any',
  },
  {
    id: 'slug/device/trailing-dot',
    kind: 'slug',
    input: 'CON.',
    expect: 'reject',
    why: 'Windows strips the trailing dot, so this reaches the device after the name check would have passed it.',
    platform: 'any',
  },
  {
    id: 'slug/device/trailing-space',
    kind: 'slug',
    input: 'CON ',
    expect: 'reject',
    why: 'Windows strips the trailing space too. Trimming must happen BEFORE the device check.',
    platform: 'any',
  },
  {
    id: 'slug/device/leading-dot',
    kind: 'slug',
    input: '.con',
    expect: 'reject',
    why: 'The leading dot is stripped as a hidden-file marker, revealing the device name underneath.',
    platform: 'any',
  },
  {
    id: 'slug/device/collapses-to-device',
    kind: 'slug',
    input: 'C-O-N',
    expect: 'accept',
    why: 'Hyphens are preserved, so this stays "c-o-n" and is NOT the device. Guards the re-check against over-blocking.',
    platform: 'any',
    expectedSlug: 'c-o-n',
  },
  {
    id: 'slug/device/dashes-collapse-to-con',
    kind: 'slug',
    input: 'CON---',
    expect: 'reject',
    why: 'Survives the first device check (base name is "CON---") but the slug rewrite collapses it to exactly "con". The post-rewrite re-check is what catches it.',
    platform: 'any',
  },

  /* --- trailing/leading trimming ------------------------------------------ */
  {
    id: 'slug/trim/trailing-dot',
    kind: 'slug',
    input: 'Project.',
    expect: 'accept',
    why: 'Neutralised, not rejected: Windows would strip the dot anyway. The resulting collision with "Project" is detectCollision\u2019s job.',
    platform: 'any',
    expectedSlug: 'project',
  },
  {
    id: 'slug/trim/trailing-spaces',
    kind: 'slug',
    input: 'Project   ',
    expect: 'accept',
    why: 'Same reasoning as the trailing dot — the filesystem silently discards it, so the guard must too.',
    platform: 'any',
    expectedSlug: 'project',
  },
  {
    id: 'slug/trim/leading-spaces',
    kind: 'slug',
    input: '   Project',
    expect: 'accept',
    why: 'Leading whitespace is invisible in a UI list and must not create a second folder.',
    platform: 'any',
    expectedSlug: 'project',
  },
  {
    id: 'slug/trim/dot-and-space',
    kind: 'slug',
    input: 'Project. ',
    expect: 'accept',
    why: 'Dot then space: both trailers have to be stripped in one pass, not just the last one.',
    platform: 'any',
    expectedSlug: 'project',
  },
  {
    id: 'slug/trim/only-whitespace',
    kind: 'slug',
    input: '     ',
    expect: 'reject',
    why: 'Trimming leaves nothing. An empty slug would resolve to the projects root itself.',
    platform: 'any',
  },
  {
    id: 'slug/trim/only-dots',
    kind: 'slug',
    input: '...',
    expect: 'reject',
    why: 'Contains "..", and trims to nothing regardless.',
    platform: 'any',
  },
  {
    id: 'slug/trim/only-punctuation',
    kind: 'slug',
    input: '!!!@@@###',
    expect: 'reject',
    why: 'Every character is rewritten away; the empty result must be refused rather than silently become the root.',
    platform: 'any',
  },
  {
    id: 'slug/trim/empty',
    kind: 'slug',
    input: '',
    expect: 'reject',
    why: 'The degenerate case. join(root, "") === root.',
    platform: 'any',
  },

  /* --- length ------------------------------------------------------------- */
  {
    id: 'slug/length/oversized',
    kind: 'slug',
    input: OVERSIZED_NAME,
    expect: 'reject',
    why: '300 characters is not a display name; refusing early keeps long-path handling out of the guard entirely.',
    platform: 'any',
  },
  {
    id: 'slug/length/at-limit',
    kind: 'slug',
    input: MAX_LENGTH_NAME,
    expect: 'accept',
    why: 'Exactly at MAX_DISPLAY_NAME_LENGTH: accepted, then truncated to MAX_SLUG_LENGTH. The boundary must not be off by one.',
    platform: 'any',
    expectedSlug: 'b'.repeat(64),
  },

  /* --- mixed separators --------------------------------------------------- */
  {
    id: 'slug/separator/mixed',
    kind: 'slug',
    input: 'mixed/sep\\path',
    expect: 'reject',
    why: 'Both separator styles in one name. Windows honours both, so checking only one is checking neither.',
    platform: 'any',
  },
  {
    id: 'slug/separator/trailing-slash',
    kind: 'slug',
    input: 'project/',
    expect: 'reject',
    why: 'A trailing separator still makes this a path rather than a segment.',
    platform: 'any',
  },

  /* --- legitimate names that must NOT be over-blocked --------------------- */
  {
    id: 'slug/accept/plain',
    kind: 'slug',
    input: 'My Project',
    expect: 'accept',
    why: 'The ordinary case. If this fails, the guard is unusable.',
    platform: 'any',
    expectedSlug: 'my-project',
  },
  {
    id: 'slug/accept/version-suffix',
    kind: 'slug',
    input: 'Forge Dashboard v2',
    expect: 'accept',
    why: 'Digits and multiple words.',
    platform: 'any',
    expectedSlug: 'forge-dashboard-v2',
  },
  {
    id: 'slug/accept/underscores-and-digits',
    kind: 'slug',
    input: 'web_app-01',
    expect: 'accept',
    why: 'Underscore and hyphen are safe on every filesystem and must survive unchanged.',
    platform: 'any',
    expectedSlug: 'web_app-01',
  },
  {
    id: 'slug/accept/single-char',
    kind: 'slug',
    input: 'A',
    expect: 'accept',
    why: 'Minimum viable name.',
    platform: 'any',
    expectedSlug: 'a',
  },
  {
    id: 'slug/accept/console-not-con',
    kind: 'slug',
    input: 'console',
    expect: 'accept',
    why: 'Starts with "con" but is not the CON device. A prefix-based device check would wrongly reject it.',
    platform: 'any',
    expectedSlug: 'console',
  },
  {
    id: 'slug/accept/com10-not-reserved',
    kind: 'slug',
    input: 'com10',
    expect: 'accept',
    why: 'Only COM1-COM9 are reserved. A lazy /COM\\d+/ pattern gets this wrong.',
    platform: 'any',
    expectedSlug: 'com10',
  },
  {
    id: 'slug/accept/aux-panel',
    kind: 'slug',
    input: 'Aux Panel',
    expect: 'accept',
    why: 'Contains "Aux" as a word but the whole segment is "aux-panel", which is not a device.',
    platform: 'any',
    expectedSlug: 'aux-panel',
  },
  {
    id: 'slug/accept/dot-config',
    kind: 'slug',
    input: '.config',
    expect: 'accept',
    why: 'Leading dot stripped, leaving "config" — deliberately paired with the ".con" reject row above.',
    platform: 'any',
    expectedSlug: 'config',
  },
  {
    id: 'slug/accept/percent-literal',
    kind: 'slug',
    input: '100% Done',
    expect: 'accept',
    why: 'A percent sign with no hex behind it is not an escape sequence. Rejecting it would break ordinary names.',
    platform: 'any',
    expectedSlug: '100-done',
    forbiddenInSlug: ['%'],
  },
  {
    id: 'slug/accept/markup-neutralised',
    kind: 'slug',
    input: '<script>alert(1)',
    expect: 'accept',
    why: 'Illegal filename characters are rewritten rather than refused; the result must contain none of them.',
    platform: 'any',
    expectedSlug: 'script-alert-1',
    forbiddenInSlug: ['<', '>', '(', ')'],
  },
  {
    id: 'slug/accept/parentheses',
    kind: 'slug',
    input: 'Project (2026)',
    expect: 'accept',
    why: 'Very common real-world name; parentheses are legal but are normalised away for predictability.',
    platform: 'any',
    expectedSlug: 'project-2026',
  },
  {
    id: 'slug/accept/collapsing-spaces',
    kind: 'slug',
    input: '  Spaced   Out  ',
    expect: 'accept',
    why: 'Repeated separators must collapse to one, otherwise slugs differ only by invisible runs of hyphens.',
    platform: 'any',
    expectedSlug: 'spaced-out',
  },
  {
    id: 'slug/accept/accented',
    kind: 'slug',
    input: 'Caf\u00e9 Ordering',
    expect: 'accept',
    why: 'Accented Latin letters are legitimate. The collision with "cafe" is reported by detectCollision, not by refusing the name.',
    platform: 'any',
    expectedSlug: 'caf\u00e9-ordering',
  },
  {
    id: 'slug/accept/cjk',
    kind: 'slug',
    input: '\u65e5\u672c\u8a9e\u30d7\u30ed\u30b8\u30a7\u30af\u30c8',
    expect: 'accept',
    why: 'Non-Latin scripts are not an attack. An ASCII-only rule would lock out most of the world.',
    platform: 'any',
    expectedSlug: '\u65e5\u672c\u8a9e\u30d7\u30ed\u30b8\u30a7\u30af\u30c8',
  },
  {
    id: 'slug/accept/cyrillic-name',
    kind: 'slug',
    input: '\u0440aypal',
    expect: 'accept',
    why: 'Cyrillic er + "aypal". Legitimate as a name on its own; the DANGER is collision with "paypal", which is a separate check.',
    platform: 'any',
  },
  {
    id: 'slug/accept/emoji-stripped',
    kind: 'slug',
    input: 'Rocket \ud83d\ude80 Launch',
    expect: 'accept',
    why: 'Emoji are symbols, not letters, so they are rewritten out instead of ending up in a directory name.',
    platform: 'any',
    expectedSlug: 'rocket-launch',
  },
];

/* ========================================================================== */
/*  Containment vectors                                                        */
/* ========================================================================== */

const LONG_TAIL = 'seg'.repeat(90); // ~270 chars, over Windows MAX_PATH
const ABSURD_TAIL = 'x'.repeat(5000);

export const CONTAINMENT_VECTORS: readonly ContainmentVector[] = [
  /* --- THE prefix trap ----------------------------------------------------- */
  {
    id: 'contain/prefix/rootEVIL',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\rootEVIL',
    expect: 'reject',
    why: 'THE canonical prefix trap. "C:\\rootEVIL".startsWith("C:\\root") is true; it is a sibling directory. Only a segment-aware comparison gets this right.',
    platform: 'win32',
  },
  {
    id: 'contain/prefix/rootEVIL-child',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\rootEVIL\\secrets.txt',
    expect: 'reject',
    why: 'Same trap one level deeper, where a "startsWith(root + sep)" fix still fails if the separator was appended to the wrong string.',
    platform: 'win32',
  },
  {
    id: 'contain/prefix/root-dot-evil',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root.evil\\x',
    expect: 'reject',
    why: 'Prefix trap using a dot instead of letters, which slips past denylists written around "EVIL".',
    platform: 'win32',
  },
  {
    id: 'contain/prefix/root2',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root2\\x',
    expect: 'reject',
    why: 'The one-character version of the same mistake.',
    platform: 'win32',
  },
  {
    id: 'contain/prefix/real-root-sibling',
    kind: 'containment',
    root: REAL_ROOT_WIN32,
    input: 'C:\\Users\\test\\Documents\\ForgeProjectenBACKUP\\p\\file.ts',
    expect: 'reject',
    why: 'The trap with the real root name — the shape this bug would actually take in production.',
    platform: 'win32',
  },

  /* --- ordinary containment ------------------------------------------------ */
  {
    id: 'contain/accept/child',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\sub\\file.txt',
    expect: 'accept',
    why: 'The ordinary case.',
    platform: 'win32',
    expectedCanonical: 'C:\\root\\sub\\file.txt',
  },
  {
    id: 'contain/accept/root-itself',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root',
    expect: 'accept',
    why: 'The root is inside itself. Listing the projects root would otherwise be impossible.',
    platform: 'win32',
    expectedCanonical: 'C:\\root',
  },
  {
    id: 'contain/accept/case-insensitive-win32',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\ROOT\\SUB',
    expect: 'accept',
    why: 'NTFS is case-insensitive, so a case-sensitive comparison would reject a path that is genuinely inside the root.',
    platform: 'win32',
  },
  {
    id: 'contain/accept/drive-letter-case',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'c:\\root\\sub',
    expect: 'accept',
    why: 'Drive letter case must fold too — "c:" and "C:" are the same volume.',
    platform: 'win32',
  },
  {
    id: 'contain/accept/forward-slashes',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:/root/sub/file.txt',
    expect: 'accept',
    why: 'Windows accepts forward slashes; normalisation must happen before comparison.',
    platform: 'win32',
    expectedCanonical: 'C:\\root\\sub\\file.txt',
  },
  {
    id: 'contain/accept/repeated-separators',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\\\\\sub',
    expect: 'accept',
    why: 'Repeated separators collapse; empty segments must not be compared as real segments.',
    platform: 'win32',
    expectedCanonical: 'C:\\root\\sub',
  },
  {
    id: 'contain/accept/trailing-separator',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\sub\\',
    expect: 'accept',
    why: 'A trailing separator must not produce a phantom empty segment.',
    platform: 'win32',
    expectedCanonical: 'C:\\root\\sub',
  },
  {
    id: 'contain/accept/dot-segment',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\.\\sub',
    expect: 'accept',
    why: 'A single-dot segment is a no-op and must be normalised away rather than treated as a directory named ".".',
    platform: 'win32',
    expectedCanonical: 'C:\\root\\sub',
  },
  {
    id: 'contain/accept/dotdot-inside',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\sub\\..\\ok',
    expect: 'accept',
    why: 'Traversal that stays inside the root is legitimate. Rejecting any ".." at all would be over-blocking.',
    platform: 'win32',
    expectedCanonical: 'C:\\root\\ok',
  },
  {
    id: 'contain/accept/leading-dots-in-name',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\..evil',
    expect: 'accept',
    why: 'A directory literally named "..evil" is inside the root. Only a segment that is EXACTLY ".." is traversal.',
    platform: 'win32',
    expectedCanonical: 'C:\\root\\..evil',
  },
  {
    id: 'contain/accept/relative-child',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'sub\\file.txt',
    expect: 'accept',
    why: 'Relative inputs resolve against the ROOT, never against process.cwd() — otherwise the boundary moves with the working directory.',
    platform: 'win32',
    expectedCanonical: 'C:\\root\\sub\\file.txt',
  },

  /* --- escapes ------------------------------------------------------------- */
  {
    id: 'contain/escape/dotdot-out',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\..\\other',
    expect: 'reject',
    why: 'One level up and back down into a sibling.',
    platform: 'win32',
  },
  {
    id: 'contain/escape/dotdot-deep',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\a\\b\\..\\..\\..\\windows\\system32',
    expect: 'reject',
    why: 'Enough ".." to exit, buried deep enough that a truncated inspection looks fine.',
    platform: 'win32',
  },
  {
    id: 'contain/escape/relative-dotdot',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: '..\\escape',
    expect: 'reject',
    why: 'Relative traversal out of the root.',
    platform: 'win32',
  },
  {
    id: 'contain/escape/relative-nested-dotdot',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'sub/../../escape',
    expect: 'reject',
    why: 'Net effect is one level above the root even though it starts by going down.',
    platform: 'win32',
  },
  {
    id: 'contain/escape/parent-of-root',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\..',
    expect: 'reject',
    why: 'Resolves to "C:\\", which has FEWER segments than the root — the short-path case a loop-only comparison forgets.',
    platform: 'win32',
  },
  {
    id: 'contain/escape/different-drive',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'D:\\root\\sub',
    expect: 'reject',
    why: 'Same path, different volume. The drive letter is a real segment and must be compared.',
    platform: 'win32',
  },
  {
    id: 'contain/escape/unc',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: '\\\\attacker\\share\\payload.txt',
    expect: 'reject',
    why: 'UNC path: outside the root by definition, and opening it authenticates to a remote host.',
    platform: 'win32',
  },
  {
    id: 'contain/escape/device-namespace',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: '\\\\?\\C:\\root\\sub',
    expect: 'reject',
    why: 'Even though it names a path inside the root, the \\\\?\\ prefix suppresses normalisation, so nothing after it can be trusted.',
    platform: 'win32',
  },
  {
    id: 'contain/escape/dos-device',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: '\\\\.\\PhysicalDrive0',
    expect: 'reject',
    why: 'Raw device access.',
    platform: 'win32',
  },

  /* --- device names below the root ---------------------------------------- */
  {
    id: 'contain/device/con-inside-root',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\CON',
    expect: 'reject',
    why: 'Genuinely inside the root and still forbidden: the kernel resolves CON before the directory, so this opens the console.',
    platform: 'win32',
  },
  {
    id: 'contain/device/nul-with-extension-inside-root',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\logs\\nul.txt',
    expect: 'reject',
    why: 'A write here silently disappears — the worst kind of failure, because it looks like it worked.',
    platform: 'win32',
  },
  {
    id: 'contain/device/console-dir-is-fine',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\console\\index.ts',
    expect: 'accept',
    why: 'Paired with the row above to prove the device check matches whole segments, not prefixes.',
    platform: 'win32',
  },
  {
    id: 'contain/segment/trailing-space',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\sub \\file.txt',
    expect: 'reject',
    why: 'Windows strips the trailing space on open, so "sub " and "sub" are one directory addressed by two different strings — silent aliasing.',
    platform: 'win32',
  },
  {
    id: 'contain/segment/trailing-dot',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\sub.\\file.txt',
    expect: 'reject',
    why: 'Same aliasing with a trailing dot.',
    platform: 'win32',
  },
  {
    id: 'contain/segment/ads',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\notes.txt:hidden',
    expect: 'reject',
    why: 'Alternate data stream on a file that is otherwise inside the root — content that no listing will ever show.',
    platform: 'win32',
  },

  /* --- malformed input ------------------------------------------------------ */
  {
    id: 'contain/malformed/empty',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: '',
    expect: 'reject',
    why: 'An empty candidate resolves to the root, which usually means a caller forgot to pass something.',
    platform: 'win32',
  },
  {
    id: 'contain/malformed/null-byte',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\file\u0000.txt',
    expect: 'reject',
    why: 'NUL truncation. Node itself throws on this, but the guard must produce a TYPED error, not a raw TypeError.',
    platform: 'win32',
  },
  {
    id: 'contain/malformed/relative-root',
    kind: 'containment',
    root: 'relative\\root',
    input: 'sub\\file.txt',
    expect: 'reject',
    why: 'A relative trusted root would make the security boundary depend on the process working directory.',
    platform: 'win32',
  },
  {
    id: 'contain/malformed/rtl-override',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: 'C:\\root\\invoice\u202egnp.exe',
    expect: 'reject',
    why: 'Direction override inside a path, so an approval dialog would show the operator a different filename than the one being opened.',
    platform: 'win32',
  },

  /* --- length -------------------------------------------------------------- */
  {
    id: 'contain/length/absurd',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: `C:\\root\\${ABSURD_TAIL}`,
    expect: 'reject',
    why: '5000 characters is a resource-exhaustion input, not a path. Refuse before handing it to the OS.',
    platform: 'win32',
  },
  {
    id: 'contain/length/over-max-path-but-valid',
    kind: 'containment',
    root: TRAP_ROOT_WIN32,
    input: `C:\\root\\${LONG_TAIL}`,
    expect: 'accept',
    why: 'Over Windows MAX_PATH but genuinely inside the root. Node can open it, so the guard accepts and the UI warns instead of the guard lying about containment.',
    platform: 'win32',
    expectLongPathWarning: true,
  },

  /* --- POSIX ---------------------------------------------------------------- */
  {
    id: 'contain/posix/prefix-trap',
    kind: 'containment',
    root: TRAP_ROOT_POSIX,
    input: '/home/test/rootEVIL/x',
    expect: 'reject',
    why: 'The prefix trap is not Windows-specific.',
    platform: 'posix',
  },
  {
    id: 'contain/posix/case-sensitive',
    kind: 'containment',
    root: TRAP_ROOT_POSIX,
    input: '/home/test/ROOT/x',
    expect: 'reject',
    why: 'POSIX filesystems are case-sensitive, so "/home/test/ROOT" is a DIFFERENT directory. Applying the Windows fold here would open a hole.',
    platform: 'posix',
  },
  {
    id: 'contain/posix/child',
    kind: 'containment',
    root: TRAP_ROOT_POSIX,
    input: '/home/test/root/sub/file.txt',
    expect: 'accept',
    why: 'Ordinary POSIX containment.',
    platform: 'posix',
    expectedCanonical: '/home/test/root/sub/file.txt',
  },
  {
    id: 'contain/posix/escape',
    kind: 'containment',
    root: TRAP_ROOT_POSIX,
    input: '/home/test/root/../../../etc/passwd',
    expect: 'reject',
    why: 'The oldest escape there is.',
    platform: 'posix',
  },
];

/* ========================================================================== */
/*  Link vectors — require real filesystem setup                               */
/* ========================================================================== */

/**
 * The runner must, per vector: create a temporary root, create an "outside"
 * directory as a SIBLING of that root, create `linkName` inside the root
 * pointing at the stated target, then call `assertInsideRoot(join(root, input),
 * root)`.
 *
 * These are the rows that a purely string-based guard cannot pass. No amount of
 * normalisation sees through a junction; only realpath does.
 */
export const LINK_VECTORS: readonly LinkVector[] = [
  {
    id: 'link/symlink/dir-escape',
    kind: 'link',
    linkName: 'escape-link',
    linkType: 'symlink-dir',
    target: 'outside-root',
    input: 'escape-link\\stolen.txt',
    expect: 'reject',
    why: 'A directory symlink inside the root pointing outside it. The string "<root>\\escape-link\\stolen.txt" is textually inside the root and physically is not.',
    platform: 'win32',
    requiresRealFs: true,
    mayRequireElevation: true,
  },
  {
    id: 'link/junction/dir-escape',
    kind: 'link',
    linkName: 'escape-junction',
    linkType: 'junction',
    target: 'outside-root',
    input: 'escape-junction\\stolen.txt',
    expect: 'reject',
    why: 'NTFS junction, the Windows-specific version of the same escape — and the dangerous one, because an unprivileged user CAN create it.',
    platform: 'win32',
    requiresRealFs: true,
    mayRequireElevation: false,
  },
  {
    id: 'link/symlink/file-escape',
    kind: 'link',
    linkName: 'escape-file-link',
    linkType: 'symlink-file',
    target: 'outside-root',
    input: 'escape-file-link',
    expect: 'reject',
    why: 'A file symlink pointing outside. Reading through it exfiltrates a file the root never contained.',
    platform: 'win32',
    requiresRealFs: true,
    mayRequireElevation: true,
  },
  {
    id: 'link/junction/escape-then-traverse-back',
    kind: 'link',
    linkName: 'escape-junction',
    linkType: 'junction',
    target: 'outside-root',
    input: 'escape-junction\\..\\..\\outside\\stolen.txt',
    expect: 'reject',
    why: 'Combines a junction with textual traversal, so lexical normalisation and realpath must BOTH be applied, in that order.',
    platform: 'win32',
    requiresRealFs: true,
    mayRequireElevation: false,
  },
  {
    id: 'link/junction/inside-is-allowed',
    kind: 'link',
    linkName: 'inside-junction',
    linkType: 'junction',
    target: 'inside-root',
    input: 'inside-junction\\file.txt',
    expect: 'accept',
    why: 'A link whose target stays inside the root is legitimate. Refusing all links would break ordinary workspaces and teach people to disable the guard.',
    platform: 'win32',
    requiresRealFs: true,
    mayRequireElevation: false,
  },
  {
    id: 'link/posix/symlink-escape',
    kind: 'link',
    linkName: 'escape-link',
    linkType: 'symlink-dir',
    target: 'outside-root',
    input: 'escape-link/stolen.txt',
    expect: 'reject',
    why: 'The POSIX form. Included so the same guarantee is asserted on both platforms rather than assumed.',
    platform: 'posix',
    requiresRealFs: true,
    mayRequireElevation: false,
  },
];

/* ========================================================================== */
/*  Collision vectors                                                          */
/* ========================================================================== */

export const COLLISION_VECTORS: readonly CollisionVector[] = [
  {
    id: 'collide/confusable/cyrillic-paypal',
    kind: 'collision',
    existing: ['paypal'],
    input: '\u0440a\u0443pal',
    expect: 'reject',
    why: 'Cyrillic er and u inside "paypal". Different bytes, different folder, identical on screen — the homograph attack this check exists for.',
    platform: 'any',
    expectedReason: 'confusable',
  },
  {
    id: 'collide/confusable/cyrillic-a',
    kind: 'collision',
    existing: ['apple'],
    input: '\u0430pple',
    expect: 'reject',
    why: 'The single-character version: Cyrillic a (U+0430) against Latin a.',
    platform: 'any',
    expectedReason: 'confusable',
  },
  {
    id: 'collide/confusable/greek-omicron',
    kind: 'collision',
    existing: ['forge'],
    input: 'f\u03bfrge',
    expect: 'reject',
    why: 'Greek omicron for Latin o. Greek is as usable for this as Cyrillic.',
    platform: 'any',
    expectedReason: 'confusable',
  },
  {
    id: 'collide/confusable/dotless-i',
    kind: 'collision',
    existing: ['ping'],
    input: 'p\u0131ng',
    expect: 'reject',
    why: 'Turkish dotless i. Also the reason case folding must be locale-independent.',
    platform: 'any',
    expectedReason: 'confusable',
  },
  {
    id: 'collide/case/simple',
    kind: 'collision',
    existing: ['myproject'],
    input: 'MyProject',
    expect: 'reject',
    why: 'On Windows these are literally the same directory. Reported as "case", not as an exotic attack — the report has to be believable.',
    platform: 'any',
    expectedReason: 'case',
  },
  {
    id: 'collide/exact/identical',
    kind: 'collision',
    existing: ['forge-dashboard'],
    input: 'forge-dashboard',
    expect: 'reject',
    why: 'The trivial case must still be reported, and reported as "exact".',
    platform: 'any',
    expectedReason: 'exact',
  },
  {
    id: 'collide/separator/space-vs-hyphen',
    kind: 'collision',
    existing: ['my-project'],
    input: 'My Project',
    expect: 'reject',
    why: 'Both slugify to "my-project", so the second project would silently adopt the first project\u2019s directory.',
    platform: 'any',
  },
  {
    id: 'collide/separator/underscore-vs-hyphen',
    kind: 'collision',
    existing: ['my-project'],
    input: 'my_project',
    expect: 'reject',
    why: 'Different slugs, one character apart, trivially mistaken for each other in a project list.',
    platform: 'any',
    expectedReason: 'separator',
  },
  {
    id: 'collide/diacritic/cafe',
    kind: 'collision',
    existing: ['cafe'],
    input: 'caf\u00e9',
    expect: 'reject',
    why: 'Two real, distinct directories that no human reliably tells apart in a list.',
    platform: 'any',
    expectedReason: 'diacritic',
  },
  {
    id: 'collide/compat/fullwidth',
    kind: 'collision',
    existing: ['test'],
    input: '\uff54\uff45\uff53\uff54',
    expect: 'reject',
    why: 'Fullwidth Latin. NFKC folds it onto plain ASCII, which is why normalisation belongs in the collision fold too.',
    platform: 'any',
  },
  {
    id: 'collide/compat/ligature',
    kind: 'collision',
    existing: ['file'],
    input: '\ufb01le',
    expect: 'reject',
    why: 'The fi ligature U+FB01 decomposes to "fi" under NFKC.',
    platform: 'any',
  },
  {
    id: 'collide/trailer/trailing-dot',
    kind: 'collision',
    existing: ['forge'],
    input: 'forge.',
    expect: 'reject',
    why: 'Windows discards the trailing dot, so this IS the existing directory.',
    platform: 'any',
  },
  {
    id: 'collide/trailer/trailing-space',
    kind: 'collision',
    existing: ['forge'],
    input: 'forge ',
    expect: 'reject',
    why: 'Same for a trailing space.',
    platform: 'any',
  },
  {
    id: 'collide/truncation/shared-prefix',
    kind: 'collision',
    existing: [`${'p'.repeat(64)}alpha`],
    input: `${'p'.repeat(64)}beta`,
    expect: 'reject',
    why: 'Two clearly different names whose slugs are identical after truncation at MAX_SLUG_LENGTH. Without this rung the second project takes over the first one\u2019s folder.',
    platform: 'any',
    expectedReason: 'truncation',
  },
  {
    id: 'collide/accept/distinct',
    kind: 'collision',
    existing: ['project-a', 'project-c'],
    input: 'project-b',
    expect: 'accept',
    why: 'Genuinely different names must not be flagged, or the warning becomes noise and gets ignored.',
    platform: 'any',
  },
  {
    id: 'collide/accept/empty-existing',
    kind: 'collision',
    existing: [],
    input: 'anything',
    expect: 'accept',
    why: 'First project ever created.',
    platform: 'any',
  },
  {
    id: 'collide/accept/digit-vs-letter',
    kind: 'collision',
    existing: ['vl-parser'],
    input: 'v1-parser',
    expect: 'accept',
    why: 'Deliberately NOT folded. Treating 1/l and 0/O as confusable produces constant false alarms on ordinary names like "v1".',
    platform: 'any',
  },
  {
    id: 'collide/accept/substring',
    kind: 'collision',
    existing: ['forge'],
    input: 'forge-dashboard',
    expect: 'accept',
    why: 'Containment is not collision. A substring check here would block most sensible naming schemes.',
    platform: 'any',
  },
];

/* ========================================================================== */
/*  Sensitive-file vectors                                                     */
/* ========================================================================== */

export const SENSITIVE_VECTORS: readonly SensitiveVector[] = [
  /* --- must be flagged ----------------------------------------------------- */
  {
    id: 'sensitive/git/config',
    kind: 'sensitive',
    input: 'project\\.git\\config',
    expect: 'reject',
    why: 'Git config can carry credential helpers and remote URLs with embedded tokens.',
    platform: 'any',
  },
  {
    id: 'sensitive/git/objects',
    kind: 'sensitive',
    input: 'project/.git/objects/ab/cdef123',
    expect: 'reject',
    why: 'Writing into .git internals corrupts history in ways no test would catch.',
    platform: 'any',
  },
  {
    id: 'sensitive/env/plain',
    kind: 'sensitive',
    input: '.env',
    expect: 'reject',
    why: 'The default home of every local secret.',
    platform: 'any',
  },
  {
    id: 'sensitive/env/local',
    kind: 'sensitive',
    input: 'apps/api/.env.local',
    expect: 'reject',
    why: 'Suffixed variants are the same file with a different name, at any depth.',
    platform: 'any',
  },
  {
    id: 'sensitive/env/example',
    kind: 'sensitive',
    input: '.env.example',
    expect: 'reject',
    why: 'Conventionally safe, and routinely filled with real values by accident. One extra approval costs far less than one leaked key.',
    platform: 'any',
  },
  {
    id: 'sensitive/key/pem',
    kind: 'sensitive',
    input: 'certs/server.pem',
    expect: 'reject',
    why: 'PEM files hold private keys.',
    platform: 'any',
  },
  {
    id: 'sensitive/key/dot-key',
    kind: 'sensitive',
    input: 'deploy.key',
    expect: 'reject',
    why: 'Deploy keys grant repository write access.',
    platform: 'any',
  },
  {
    id: 'sensitive/key/pfx',
    kind: 'sensitive',
    input: 'signing\\cert.pfx',
    expect: 'reject',
    why: 'PKCS#12 bundle: certificate plus private key.',
    platform: 'any',
  },
  {
    id: 'sensitive/key/id-ed25519',
    kind: 'sensitive',
    input: 'C:\\Users\\test\\.ssh\\id_ed25519',
    expect: 'reject',
    why: 'SSH private key.',
    platform: 'any',
  },
  {
    id: 'sensitive/key/id-rsa-pub',
    kind: 'sensitive',
    input: '.ssh/id_rsa.pub',
    expect: 'reject',
    why: 'Public half is not secret, but it lives in .ssh and identifies the user; flagging the whole directory is cheaper than reasoning per file.',
    platform: 'any',
  },
  {
    id: 'sensitive/creds/aws',
    kind: 'sensitive',
    input: 'C:\\Users\\test\\.aws\\credentials',
    expect: 'reject',
    why: 'Long-lived cloud access keys.',
    platform: 'any',
  },
  {
    id: 'sensitive/creds/npmrc',
    kind: 'sensitive',
    input: '.npmrc',
    expect: 'reject',
    why: 'Holds registry auth tokens.',
    platform: 'any',
  },
  {
    id: 'sensitive/creds/netrc',
    kind: 'sensitive',
    input: '_netrc',
    expect: 'reject',
    why: 'The Windows spelling of .netrc — plaintext passwords.',
    platform: 'any',
  },
  {
    id: 'sensitive/creds/pgpass',
    kind: 'sensitive',
    input: '.pgpass',
    expect: 'reject',
    why: 'Plaintext Postgres passwords.',
    platform: 'any',
  },
  {
    id: 'sensitive/creds/service-account',
    kind: 'sensitive',
    input: 'config/service-account.json',
    expect: 'reject',
    why: 'GCP service-account JSON contains a private key.',
    platform: 'any',
  },
  {
    id: 'sensitive/word/token',
    kind: 'sensitive',
    input: 'token.txt',
    expect: 'reject',
    why: 'Named after what it holds.',
    platform: 'any',
  },
  {
    id: 'sensitive/word/api-key',
    kind: 'sensitive',
    input: 'config/api-keys.json',
    expect: 'reject',
    why: 'Hyphenated and pluralised form still has to match.',
    platform: 'any',
  },
  {
    id: 'sensitive/word/secrets-dir',
    kind: 'sensitive',
    input: 'infra/secrets/db.yaml',
    expect: 'reject',
    why: 'A directory named "secrets" makes everything under it restricted.',
    platform: 'any',
  },
  {
    id: 'sensitive/vault/kdbx',
    kind: 'sensitive',
    input: 'personal.kdbx',
    expect: 'reject',
    why: 'KeePass database.',
    platform: 'any',
  },

  /* --- must NOT be flagged (over-blocking traps) --------------------------- */
  {
    id: 'sensitive/accept/gitignore',
    kind: 'sensitive',
    input: '.gitignore',
    expect: 'accept',
    why: 'Starts with ".git" and is an ordinary file. A prefix match on ".git" would restrict it and train the owner to click Approve reflexively.',
    platform: 'any',
  },
  {
    id: 'sensitive/accept/github-workflow',
    kind: 'sensitive',
    input: '.github/workflows/ci.yml',
    expect: 'accept',
    why: 'Same prefix trap one directory up.',
    platform: 'any',
  },
  {
    id: 'sensitive/accept/gitattributes',
    kind: 'sensitive',
    input: '.gitattributes',
    expect: 'accept',
    why: 'Third variation of the ".git" prefix trap.',
    platform: 'any',
  },
  {
    id: 'sensitive/accept/environment-ts',
    kind: 'sensitive',
    input: 'src/environment.ts',
    expect: 'accept',
    why: 'Contains "env" but is source code. The ".env" pattern must anchor on the whole component.',
    platform: 'any',
  },
  {
    id: 'sensitive/accept/tokenizer',
    kind: 'sensitive',
    input: 'src/tokenizer.ts',
    expect: 'accept',
    why: 'Contains "token" as a prefix of a longer word. This is why the word patterns use token boundaries.',
    platform: 'any',
  },
  {
    id: 'sensitive/accept/keyboard-doc',
    kind: 'sensitive',
    input: 'docs/keyboard-shortcuts.md',
    expect: 'accept',
    why: 'Contains "key" and is documentation.',
    platform: 'any',
  },
  {
    id: 'sensitive/accept/monkey-ts',
    kind: 'sensitive',
    input: 'src/monkey.ts',
    expect: 'accept',
    why: 'Ends in "key" and has nothing to do with credentials — a substring rule flags it, a boundary rule does not.',
    platform: 'any',
  },
  {
    id: 'sensitive/accept/package-json',
    kind: 'sensitive',
    input: 'package.json',
    expect: 'accept',
    why: 'The most ordinary file in the tree. If this is restricted, nothing works.',
    platform: 'any',
  },
  {
    id: 'sensitive/accept/readme',
    kind: 'sensitive',
    input: 'node_modules/left-pad/README.md',
    expect: 'accept',
    why: 'Deep, boring, and must stay unrestricted.',
    platform: 'any',
  },
  {
    id: 'sensitive/accept/certificate',
    kind: 'sensitive',
    input: 'certs/server.crt',
    expect: 'accept',
    why: 'A certificate is public by design; only the matching .key or .pem is secret.',
    platform: 'any',
  },
];

/* ========================================================================== */
/*  Aggregate                                                                  */
/* ========================================================================== */

/**
 * Everything in one array for a suite that wants a single count, plus per-kind
 * exports above for a suite that wants readable failure output. `LINK_VECTORS`
 * are included, so a runner iterating ALL_VECTORS must honour `requiresRealFs`.
 */
export const ALL_VECTORS: readonly PathVector[] = [
  ...SLUG_VECTORS,
  ...CONTAINMENT_VECTORS,
  ...LINK_VECTORS,
  ...COLLISION_VECTORS,
  ...SENSITIVE_VECTORS,
];

/** Guards against a merge that silently drops half the corpus. */
export const VECTOR_COUNTS = {
  slug: SLUG_VECTORS.length,
  containment: CONTAINMENT_VECTORS.length,
  link: LINK_VECTORS.length,
  collision: COLLISION_VECTORS.length,
  sensitive: SENSITIVE_VECTORS.length,
  total: ALL_VECTORS.length,
} as const;
