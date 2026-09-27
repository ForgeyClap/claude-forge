#!/usr/bin/env node
'use strict';
/**
 * forge-explain-error.cjs — a plain-language error explainer for BEGINNERS (Forge v2.9.0, WP-D). Maps a raw
 * error message (a failed command's stderr, a thrown exception's .message, a build/test failure line) to
 * ONE plain sentence (what happened) plus ONE safe next step that FORGE ITSELF will take — never a next
 * step phrased as an instruction for the user to go run something. Zero-dependency (no requires beyond this
 * file), pure, never throws.
 *
 * WHY: a beginner who barely knows computers sees a raw "ENOENT: no such file or directory, open
 * 'C:\\Users\\...\\x.json'" or "spawn claude ENOENT" and has no way to tell whether that is dangerous, a
 * typo, or nothing at all. This module gives Claude ONE honest, short, bilingual (NL/EN) line to show
 * instead — modelled in spirit on this project's command-center/discord/src/friendly-error.js (read, not
 * copied: that file redacts via a sibling audit.js this project does not have, and only returns one English
 * line with no family/next-step data), but written fresh for forge-bin's own zero-dependency, bilingual,
 * `module.exports` + CLI convention (see forge-actiongate.cjs/forge-gate-messages.cjs for the same shape).
 *
 * MODEL:
 *   explainError(rawText) -> {
 *     recognized: boolean,          // false -> every other field except redactedInput is null
 *     family: string|null,          // a stable machine id, e.g. "command_not_found"
 *     category: string|null,        // the broader group the family belongs to, e.g. "path"
 *     message: {nl, en}|null,       // ONE plain sentence: what happened
 *     nextStep: {nl, en}|null,      // ONE safe action FORGE will take — never a raw shell command to type
 *     redactedInput: string,        // rawText with token-shaped runs masked (see redact() below)
 *     inputRedacted: boolean,       // true when redactedInput differs from the trimmed raw input
 *   }
 *   Unknown/unmatched input returns recognized:false with an honest "not recognised" shape — this module
 *   never guesses a family it is not confident about, and never fabricates a family for empty input.
 *
 * FAMILIES (10 categories from the WP-D work package; "git" covers three distinct shapes so there are 12
 * concrete family ids — see FAMILIES below for the full, evidence-based list). Order matters: FAMILIES is
 * walked top-to-bottom and the FIRST match wins, most-specific-first (e.g. "spawn X ENOENT" is
 * command_not_found, checked before the generic ENOENT-is-a-missing-file family so a missing PROGRAM is
 * never misreported as a missing plain file).
 *
 * REDACTION (never echo secrets): redact() masks common token/key shapes (known provider prefixes,
 * `key=value`/`token: value` pairs — via forge-store.cjs's own redactText(), see below — and, as an
 * ADDITIONAL net, the same defensive technique this project's own usage-guard-redact.cjs::sanitizeReason()
 * already uses: any long (32+ char) run drawn from the token-safe alphabet). This is a DEFENSIVE MASK, not
 * a token detector with false-negative guarantees: a cleverly split or unusually-shaped secret can still
 * slip through, and a harmless long identifier (a UUID, a long filename with no separators) can be
 * over-redacted. Both prices are accepted on purpose — the safe direction is to redact too much, never too
 * little.
 *
 * v2.9.0 independent review F10 follow-up (WP-L1, 2026-09-27): this file's OWN `key=value` regex stopped at
 * the first whitespace/quote/comma, so a quoted MULTI-WORD value only had its first word masked —
 * `client_secret="correct horse battery staple"` became `client_secret="[REDACTED] horse battery staple"`,
 * leaking the rest. Fixed by delegating the key=value/token: value scan to the sibling forge-store.cjs's
 * redactText() (Codex stop-gate K2-01 already made THAT redact a quoted value in full, up to its closing
 * quote). This file stays zero-dependency-SAFE, not zero-dependency-only: the require is guarded, and if it
 * fails (forge-store.cjs missing/broken/renamed) redact() falls back to fallbackKeyValueRedact() below — a
 * local implementation extended the same way (full-quoted-value redaction), so the fix holds either way.
 *
 * CLI:
 *   node forge-explain-error.cjs "<error text>" [--lang nl|en] [--json]
 * Exit codes: 0 = recognized (explained) · 1 = not recognized (honest, still not a tool failure) ·
 *   2 = usage error (no text given).
 */

// F10 follow-up (WP-L1): guarded require, same idiom as forge-gate-inspect.cjs's own DATA/SCRATCH guards —
// absent/broken -> redact() falls back to fallbackKeyValueRedact() (below) instead of throwing or skipping
// redaction. Never assigned anything but a function or null.
let STORE_REDACT_TEXT = null;
try {
  const store = require('./forge-store.cjs');
  STORE_REDACT_TEXT = typeof store.redactText === 'function' ? store.redactText : null;
} catch { STORE_REDACT_TEXT = null; }

/** FAMILIES — ordered, most-specific-first. Each entry: id, category, a RegExp `test`, and bilingual
 *  `message`/`nextStep` sentences. `nextStep` always describes what FORGE does, never an instruction handed
 *  back to the user to type. */
const FAMILIES = [
  {
    id: 'command_not_found',
    category: 'path',
    test: /spawn\s+\S+\s+ENOENT|is not recognized as an internal or external command|not recognized as the name of a cmdlet|command not found|:\s*not found\b/i,
    message: {
      nl: 'het programma is niet gevonden — het staat niet op PATH of is niet geïnstalleerd',
      en: 'the program was not found — it is not on PATH, or not installed',
    },
    nextStep: {
      nl: 'Forge controleert of het programma echt geïnstalleerd is en zoekt het opnieuw op PATH voordat het commando opnieuw wordt geprobeerd',
      en: 'Forge checks whether the program is actually installed and looks for it on PATH again before retrying the command',
    },
  },
  {
    id: 'port_in_use',
    category: 'network',
    test: /EADDRINUSE|address already in use|port\b[^\n]{0,40}(?:already in use|is already allocated)/i,
    message: {
      nl: 'die netwerkpoort is al in gebruik door een ander programma',
      en: 'that network port is already in use by another program',
    },
    nextStep: {
      nl: 'Forge zoekt op welk proces die poort al gebruikt en kiest een andere poort in plaats van blind opnieuw te proberen',
      en: 'Forge finds what is already using that port and picks a different one instead of blindly retrying',
    },
  },
  {
    id: 'permission_denied',
    category: 'filesystem',
    test: /EACCES|EPERM|permission denied|access is denied/i,
    message: {
      nl: 'er zijn geen rechten om dat bestand of die map te gebruiken',
      en: 'there are no permissions to use that file or folder',
    },
    nextStep: {
      nl: 'Forge stopt en vraagt de eigenaar in plaats van te proberen de toegang te forceren',
      en: 'Forge stops and asks the owner rather than trying to force access',
    },
  },
  {
    id: 'network_unreachable',
    category: 'network',
    test: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|fetch failed|getaddrinfo/i,
    message: {
      nl: 'er is een netwerkprobleem — de andere kant reageert niet of is niet bereikbaar',
      en: 'there is a network problem — the other side is not responding or unreachable',
    },
    nextStep: {
      nl: 'Forge wacht kort en probeert het één keer opnieuw; blijft het mislukken, dan meldt Forge de storing in plaats van eindeloos te blijven proberen',
      en: 'Forge waits briefly and retries once; if it still fails, Forge reports the outage instead of retrying forever',
    },
  },
  {
    id: 'npm_error',
    category: 'dependencies',
    test: /npm (?:err!|error)|cannot find module|module_not_found|eresolve/i,
    message: {
      nl: 'een pakket kon niet gevonden of geïnstalleerd worden',
      en: 'a package could not be found or installed',
    },
    nextStep: {
      nl: 'Forge draait de installatiestap van het project opnieuw voordat het commando opnieuw wordt geprobeerd',
      en: "Forge re-runs the project's install step before retrying the command",
    },
  },
  {
    id: 'enoent_missing_file',
    category: 'filesystem',
    test: /ENOENT/i,
    message: {
      nl: 'een bestand of map die het commando nodig heeft, bestaat niet op dat pad',
      en: 'a file or folder the command needs does not exist at that path',
    },
    nextStep: {
      nl: 'Forge controleert het exacte pad en vraagt de eigenaar om bevestiging in plaats van een vervanging te raden',
      en: 'Forge checks the exact path and asks the owner to confirm it rather than guessing a replacement',
    },
  },
  {
    id: 'git_not_a_repo',
    category: 'git',
    test: /not a git repository/i,
    message: {
      nl: 'dit is geen git-repository (of niet de juiste map)',
      en: 'this is not a git repository (or not the right folder)',
    },
    nextStep: {
      nl: 'Forge controleert of het echt in de juiste projectmap staat voordat het een git-commando opnieuw probeert',
      en: 'Forge checks it is really in the right project folder before retrying a git command',
    },
  },
  {
    id: 'git_merge_conflict',
    category: 'git',
    test: /CONFLICT\s*\(|automatic merge failed|merge conflict/i,
    message: {
      nl: 'git kon twee versies niet automatisch samenvoegen — er is een conflict',
      en: 'git could not automatically combine two versions — there is a conflict',
    },
    nextStep: {
      nl: 'Forge stopt en laat de conflicterende bestanden zien in plaats van het conflict automatisch op te lossen',
      en: 'Forge stops and shows the conflicting files instead of resolving the conflict automatically',
    },
  },
  {
    id: 'git_detached_head',
    category: 'git',
    test: /detached head|head detached\b/i,
    message: {
      nl: 'git staat op een "detached HEAD" — niet op een echte branch',
      en: 'git is on a "detached HEAD" — not on a real branch',
    },
    nextStep: {
      nl: 'Forge gaat terug naar de echte branch voordat het verdergaat, in plaats van door te werken op de losse HEAD',
      en: 'Forge switches back to the real branch before continuing, instead of working on the detached HEAD',
    },
  },
  {
    id: 'powershell_execution_policy',
    category: 'shell',
    test: /running scripts is disabled on this system|execution of scripts is disabled on this system|cannot be loaded because running scripts is disabled/i,
    message: {
      nl: 'Windows staat het uitvoeren van dit script standaard niet toe (execution policy)',
      en: 'Windows does not allow running this script by default (execution policy)',
    },
    nextStep: {
      nl: 'Forge voert het script uit met een beperkte, eenmalige bypass voor dat ene commando in plaats van het systeembeleid overal te wijzigen',
      en: 'Forge runs the script with a scoped, one-off bypass for that single command instead of changing the system-wide policy everywhere',
    },
  },
  {
    id: 'usage_limit',
    category: 'claude',
    test: /usage limit|rate[-\s]?limit|\b429\b|too many requests|quota exceeded/i,
    message: {
      nl: 'de gebruikslimiet (rate limit) is bereikt',
      en: 'the usage limit (rate limit) has been reached',
    },
    nextStep: {
      nl: 'Forge pauzeert en wacht tot de limiet weer vrijgeeft, in plaats van de aanvraag te blijven herhalen',
      en: 'Forge pauses and waits for the limit to reset, instead of hammering the request again',
    },
  },
  {
    id: 'auth_invalid',
    category: 'auth',
    test: /invalid[_\s-]?api[_\s-]?key|\b401\b|unauthorized|authentication failed|invalid[_\s-]?token|token expired|invalid_grant/i,
    message: {
      nl: 'de inloggegevens (API-key of token) worden afgewezen',
      en: 'the credentials (API key or token) are being rejected',
    },
    nextStep: {
      nl: 'Forge stopt en vraagt de eigenaar de sleutel te controleren of te vervangen, in plaats van zelf een nieuwe te raden',
      en: 'Forge stops and asks the owner to check or replace the key, instead of guessing a new one itself',
    },
  },
];

// Known provider/token PREFIXES, redacted whole regardless of length (catches a short-ish real token this
// project has seen before a long-run mask alone would). Order-independent; each entry is tried everywhere.
const KNOWN_TOKEN_PREFIX_RE = /\b(?:sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._-]{10,})\b/g;
// The same defensive "mask any long token-safe run" technique usage-guard-redact.cjs::sanitizeReason()
// already uses (REASON_TOKEN_LOOKALIKE_RE there) — deliberately duplicated in spirit, not imported, so this
// net keeps working even when forge-store.cjs (required above) is unavailable.
const LONG_TOKEN_RUN_RE = /[A-Za-z0-9._~+/-]{32,}/g;

// ---- fallbackKeyValueRedact() — F10 follow-up (WP-L1, 2026-09-27), used only when forge-store.cjs's own
// redactText() cannot be loaded (see STORE_REDACT_TEXT above). Same vocabulary and boundary fix as the
// original 2026-09-27 WP-K2 fix (a negative lookbehind for an ALNUM character, not `\b`, so "client_secret="
// still matches even though "_"/"s" share no \b boundary), but the VALUE is now read in full up to its
// closing quote (or end of line, for an unterminated quote — fail toward redacting more, never less) —
// quoted forms are tried FIRST so the later bare/punctuated form never re-matches a value already handled.
const KEY_TERM = '(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password|passwd|pwd|authorization|bearer|credentials?)';
const KEY_PART = '(?<![A-Za-z0-9])(' + KEY_TERM + ')(\\s*[:=]\\s*)';
const KEY_VALUE_DQ_RE = new RegExp(KEY_PART + '"([^"\\r\\n]{1,4096})("?)', 'gi');
const KEY_VALUE_SQ_RE = new RegExp(KEY_PART + "'([^'\\r\\n]{1,4096})('?)", 'gi');
const KEY_VALUE_PLAIN_RE = new RegExp(KEY_PART + "([^\\s\"',]{4,})", 'gi');
function fallbackKeyValueRedact(s) {
  let out = s.replace(KEY_VALUE_DQ_RE, (_m, key, sep, _val, close) => key + sep + '"[REDACTED]' + close);
  out = out.replace(KEY_VALUE_SQ_RE, (_m, key, sep, _val, close) => key + sep + "'[REDACTED]" + close);
  out = out.replace(KEY_VALUE_PLAIN_RE, (_m, key, sep) => key + sep + '[REDACTED]');
  return out;
}

/** redact(text) -> a string with token/key-shaped runs masked. Never throws; non-string input becomes ''.
 *  The key=value/token: value scan prefers forge-store.cjs's redactText() (redacts a quoted value in full);
 *  fallbackKeyValueRedact() (above) takes over, with the same full-quoted-value fix, when that sibling
 *  cannot be loaded or itself throws. KNOWN_TOKEN_PREFIX_RE and LONG_TOKEN_RUN_RE run in both cases — they
 *  are this file's OWN additional nets (a bare provider-prefixed token, or a long unlabelled run) that
 *  forge-store.cjs's redactText() does not claim to cover on its own. */
function redact(text) {
  if (typeof text !== 'string' || !text) return '';
  let s = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  if (typeof STORE_REDACT_TEXT === 'function') {
    try { s = STORE_REDACT_TEXT(s); } catch { s = fallbackKeyValueRedact(s); }
  } else {
    s = fallbackKeyValueRedact(s);
  }
  s = s.replace(KNOWN_TOKEN_PREFIX_RE, '[REDACTED]');
  s = s.replace(LONG_TOKEN_RUN_RE, '[REDACTED]');
  return s;
}

/** explainError(rawText) -> see this file's header for the full return shape. Pure, never throws. */
function explainError(rawText) {
  const original = typeof rawText === 'string' ? rawText : (rawText == null ? '' : String(rawText));
  const trimmed = original.trim();
  const redactedInput = redact(trimmed);
  const inputRedacted = redactedInput !== trimmed;
  if (!trimmed) {
    return { recognized: false, family: null, category: null, message: null, nextStep: null, redactedInput, inputRedacted };
  }
  for (const fam of FAMILIES) {
    if (fam.test.test(trimmed)) {
      return {
        recognized: true, family: fam.id, category: fam.category,
        message: { nl: fam.message.nl, en: fam.message.en },
        nextStep: { nl: fam.nextStep.nl, en: fam.nextStep.en },
        redactedInput, inputRedacted,
      };
    }
  }
  return { recognized: false, family: null, category: null, message: null, nextStep: null, redactedInput, inputRedacted };
}

module.exports = { explainError, redact, FAMILIES, fallbackKeyValueRedact };

// ---- CLI ----
function parseArgs(argv) {
  const opts = { lang: null, json: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-explain-error.cjs "<error text>" [--lang nl|en] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const text = opts.positional.join(' ');
  if (!text.trim()) {
    printUsage();
    process.exitCode = 2;
  } else {
    const result = explainError(text);
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else if (!result.recognized) {
      console.log('FORGE: onbekende foutmelding, niet herkend — behandel handmatig. / FORGE: unrecognised error, not identified — handle manually.');
      if (result.inputRedacted) console.log('(input redacted before display: ' + result.redactedInput + ')');
    } else {
      const langs = opts.lang === 'nl' || opts.lang === 'en' ? [opts.lang] : ['nl', 'en'];
      for (const l of langs) {
        console.log('FORGE [' + result.family + ']: ' + result.message[l] + ' — ' + result.nextStep[l]);
      }
    }
    process.exitCode = result.recognized ? 0 : 1;
  }
}
