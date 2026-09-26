#!/usr/bin/env node
'use strict';
/**
 * forge-gate-selfdisable.cjs — the `gate-hook-self-disable` detection subsystem (security wp9b M3, codex-recheck
 * S05/V02), split out of forge-gate-hook.cjs (wp-v3, sec-v1r-H1 remediation) so BOTH the main thread
 * (forge-gate-hook.cjs, for the watchdog-unavailable fallback and any opts.gate-stubbed test) and the
 * worker_threads Worker (via forge-gate-inspect.cjs, the normal protected path) call the EXACT SAME
 * implementation — one function, every caller, no risk of the two drifting apart. Behaviour is unchanged from
 * before this split; see forge-gate-hook.cjs's own header for the full self-disable policy narrative.
 *
 * API: selfDisable(seen) -> boolean · parseConfigCall(segment) -> parsed|null · isSelfDisableCall(p) -> boolean ·
 * isOnceExempt(p) -> boolean (all re-exported unchanged from forge-gate-hook.cjs for backward compatibility).
 */
// Absent -> every config-shaped segment is treated as unparseable (falls through to the loose
// ambiguous-mutation fallback below, never to permission) — same fail-closed contract as before the split.
let CONFIG_CLI = null;
try { CONFIG_CLI = require('./forge-config-cli.cjs'); } catch { CONFIG_CLI = null; }
// tokenize() needs forge-gate-scratch.cjs's own lexer; absent -> parseConfigCall() can never confidently tokenize
// a segment, so it returns null (unparseable), same fail-closed contract as before the split.
let SCRATCH = null;
try { SCRATCH = require('./forge-gate-scratch.cjs'); } catch { SCRATCH = null; }
const tokenize = (...a) => (SCRATCH ? SCRATCH.tokenize(...a) : null);

// ---- SELF-DISABLE (security wp9b M3), read from PARSED ARGV rather than a spelling match (codex-recheck S05):
// any Bash/PowerShell forge-config.cjs invocation — any path form, a quoted verb, flags in any order/position,
// `--json`/`--global` — whose target key is `gate-hook` with `set <off-word>` or `unset` is blocked, except the
// exact one-off shape `set gate-hook off --once "<quote>"` on its own, with no other flag or trailing argument.
const OFF_WORDS = new Set(['off', 'uit', 'false', 'no', 'nee', '0', 'disabled', 'disable', 'uitzetten', 'uitschakelen', 'deactiveren']);
const CONFIG_SPLIT_RE = /&&|\|\||;;|;|\||&|\r\n|\n|\r|\$\(|`/g; // mirrors forge-actiongate's own SHELL_SPLIT_RE,
// duplicated on purpose: self-disable detection must keep working even if forge-actiongate.cjs is missing/broken.
// sec-v3r M2 (independent re-review): a Bash backslash-newline or PowerShell backtick-newline is a LINE
// CONTINUATION, not a real statement separator — the shell deletes the backslash/backtick-plus-newline pair and
// joins the surrounding text as-is before it ever sees a whole command. Splitting on \n BEFORE joining these
// would silently break `set gate-hook \<newline>off` into two segments ("set gate-hook \" and "off") that
// neither look like a self-disable call on its own, bypassing detection entirely — this must run FIRST.
function joinLineContinuations(text) {
  return String(text).replace(/\\\r?\n/g, '').replace(/`\r?\n/g, '');
}
function splitForSelfDisable(text) {
  return joinLineContinuations(text).split(CONFIG_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
}

// V02 (codex-recheck 2026-09-24, wave 1 + wave 2): the real, equivalent ways this project's own docs and
// scripts invoke forge-config.cjs — a node CLI flag before the script path, a full interpreter path, `env`
// re-resolving it from PATH, sudo/time/nohup wrappers, AND every value-taking CLI option the real
// forge-config-cli.cjs itself recognises (`--lang`, `--run`, `--flag`, `--once`, plus the boolean `--json`/
// `--global`/`--yes`/`--ascii`/`--all`/`--mark-seen`/`--help`) in any order, before or between or after the
// positional key/value — must all still reach the SAME parsed verdict as the bare `node forge-config.cjs set
// gate-hook off` form, never fall through to "not a config call" = permission (wave-2 finding V02: a segment
// like `set --lang en gate-hook off` used to mis-derive key="en" instead of "gate-hook" because the old
// hand-rolled flag stripper only ever handled flags that take NO value).
const CONFIG_WRAPPER_RE = /^(?:sudo|time|nohup)$/i;
const CONFIG_BASENAME_RE = /^forge-config(?:-cli)?\.cjs$/i;
// WP-S4 (v2.8.0 laptop-audit Part V-F): the fresh-laptop re-audit executed `forge.cmd|forge.ps1|forge.sh config
// set gate-hook off|uit` (and `unset gate-hook`) end to end and found it passed the gate 4/4 with nothing
// printed — this file only ever recognised the SCRIPT itself (forge-config(-cli).cjs), never the dispatcher
// wrapper that forwards its `config` subcommand straight to that same script (see forge.cmd/.ps1/.sh's own
// `config` branch: `shift` + forward everything else verbatim, or PowerShell's `@rest`). A wrapper call must
// reach the exact same verdict as the direct call it is byte-for-byte equivalent to.
const WRAPPER_BASENAME_RE = /^forge(?:\.(?:cmd|ps1|sh))?$/i; // forge | forge.cmd | forge.ps1 | forge.sh (any path prefix — basename only, same convention as CONFIG_BASENAME_RE)
// A shell explicitly launching the wrapper file (`powershell -File forge.ps1 …`, `bash forge.sh …`) rather than
// the OS resolving it directly (`forge.cmd`, `.\forge.ps1`) — mirrors the node-launcher handling below.
const WRAPPER_LAUNCHER_RE = /^(?:powershell|pwsh|cmd|bash|sh|dash|zsh)(?:\.exe)?$/i;
const WRAPPER_CONFIG_SUBCOMMAND = 'config'; // the ONLY forge(.cmd|.ps1|.sh) subcommand that reaches forge-config(-cli).cjs
// The only two forge-config.cjs subcommands that can ever mutate a setting (see forge-config-cli.cjs's own
// runCommand() switch) — anything else (list/get/explain/diff/parse/help, or a garbled non-command like the
// literal string "--json" landing in argv[0] when a flag precedes the subcommand) is never trusted enough to
// derive verb/key/value from; it falls through to the loose ambiguous-mutation fallback instead (see below).
const CONFIG_MUTATING_CMDS = new Set(['set', 'unset']);
function isNodeToken(tok) {
  if (!tok || tok.quoted) return false;
  return /^node(?:\.exe)?$/i.test(String(tok.v).split(/[\\/]/).pop());
}

/** shellUnescapeForCompare(raw) -> raw with every backslash character removed — sec-v5 M1 (independent
 *  re-review): a real shell consumes an unescaped backslash before it ever hands argv to node, so an escaped
 *  spelling like `s\et`/`gate-h\ook`/`of\f` actually runs as `set`/`gate-hook`/`off` even though this file's own
 *  RAW token text still shows the backslash — comparing raw text against `CONFIG_MUTATING_CMDS`/`gate-hook`/
 *  `OFF_WORDS` then misses every one of them. Deleting every backslash (mirrors this file's own `deglue()` and
 *  forge-gate-inspect.cjs's crude fallback, both `replace(/["'\\]/g,'')`) is equivalent to the precise "remove
 *  a backslash before the character it escapes" rule for every input that matters here, and — per the review's
 *  own escape hatch — is applied uniformly to quoted and unquoted tokens alike: this file's tokenizer already
 *  discards which quote character (single vs double) was used, so it cannot tell Bash's own single-quote
 *  ("literal backslash") exception from a double-quoted one anyway, and treating a quoted backslash as
 *  removable too is the conservative, fail-toward-refuse direction, never fail-toward-permission. Used ONLY to
 *  compute the comparison text this module reasons about (verb/key/value/option-name matching, and the
 *  dynamic-marker/glob check) — never for the script PATH's own basename split, since `\` there may be a
 *  genuine PowerShell/Windows directory separator this file cannot safely tell apart from an escape (see
 *  parseConfigCall's own basename check below for how that specific case is instead handled), and never for
 *  anything this file would itself execute, write, or store. */
function shellUnescapeForCompare(raw) { return String(raw).replace(/\\/g, ''); }

/** positionalTokenObjects(restTokens) -> the ORIGINAL TOKEN OBJECTS (never flattened strings) that
 *  CONFIG_CLI.parseArgv() would place in its own `pos` array for this SAME `restTokens` slice, or null when
 *  the shared option tables are unavailable (cannot confidently walk). sec-v3r M2 (independent re-review):
 *  parseArgv()'s own argv contract only ever returns plain strings, which throws away exactly the raw
 *  quoting/shape information a literal-vs-dynamic check needs — rather than duplicating BOOL_OPTS/VALUE_OPTS
 *  here (the exact drift risk this module's whole design already rejects, see the header above), this walks
 *  the SAME tables, imported from forge-config-cli.cjs, so the two can never silently disagree about which
 *  argv slot is a flag vs. a positional. */
function positionalTokenObjects(restTokens) {
  if (!CONFIG_CLI || !CONFIG_CLI.BOOL_OPTS || !CONFIG_CLI.VALUE_OPTS) return null;
  const BOOL_OPTS = CONFIG_CLI.BOOL_OPTS;
  const VALUE_OPTS = CONFIG_CLI.VALUE_OPTS;
  const pos = [];
  for (let i = 1; i < restTokens.length; i++) {
    // sec-v5 M1: de-escaped, so this walk's own flag-vs-positional decisions stay aligned with parseArgv's —
    // parseConfigCall() below now calls parseArgv() on the SAME de-escaped strings, never the raw ones.
    const raw = shellUnescapeForCompare(String(restTokens[i].v));
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    if (BOOL_OPTS[name] && inline === undefined) continue;
    if (VALUE_OPTS[name] || name === '--flag') {
      if (inline === undefined) i++; // the NEXT token is this option's own value — parseArgv consumes it too
      continue;
    }
    if (raw.startsWith('--')) continue; // an unrecognised long flag (parseArgv sets a.bad here) — not positional
    pos.push(restTokens[i]);
  }
  return pos;
}

const DYNAMIC_MARKER_RE = /[$`%]/;
const GLOB_RE = /[*?[\]]/;
/** isLiteralToken(tok) -> true when this token's raw text cannot plausibly resolve to something OTHER than
 *  what it visibly spells at runtime. Absent (e.g. `unset` has no value token at all) counts as literal —
 *  nothing dynamic to distrust there. A `$`/backtick/`%` anywhere is always distrusted (a shell/PowerShell
 *  variable or command-substitution marker — quoting a variable reference does not stop it from expanding). An
 *  UNQUOTED glob character is distrusted too (it could expand to anything at runtime); a QUOTED glob character
 *  is inert (the shell passes it through literally), so it stays trusted. */
function isLiteralToken(tok) {
  if (!tok) return true;
  // sec-v5 M1: checked on the DE-ESCAPED text (a real shell removes the backslash before this hook would ever
  // see the result), never the raw text — an over-cautious side effect (a truly-literal escaped `\$`/`\*` now
  // reads as a bare, distrusted `$`/`*`) is acceptable and consistent with this file's own fail-toward-refuse
  // posture everywhere else; the alternative (checking raw text only) is what let an escaped marker hide.
  const raw = shellUnescapeForCompare(String(tok.v));
  if (DYNAMIC_MARKER_RE.test(raw)) return false;
  if (!tok.quoted && GLOB_RE.test(raw)) return false;
  return true;
}

/** parseConfigCall(segment) -> a best-effort read of a single segment invoking forge-config.cjs or
 *  forge-config-cli.cjs (any path form: relative, absolute, quoted, bare basename, a full interpreter path,
 *  `env`-resolved, sudo/time/nohup-wrapped, with or without node CLI flags before the script), or null when
 *  this segment is not one OR when it cannot be read with FULL confidence (see below) — the caller
 *  (selfDisable) treats every null as "cannot read", never as "permitted" (V02).
 *
 *  Once the interpreter/script prefix is recognised, the REAL forge-config-cli.cjs::parseArgv() parses the
 *  remaining argv — the exact function the real CLI dispatches through, required directly so the two can
 *  never drift onto two different option tables (a drift-canary test pins that this module keeps exporting
 *  it). Two signals mean "do not trust this derivation, treat as unparseable": `a.bad` (the real CLI itself
 *  would exit on an option it does not recognise, so nothing would actually mutate) and `a.cmd` not being one
 *  of the two mutating subcommands (a flag landing in the subcommand slot — e.g. `--json set gate-hook off`
 *  parses to cmd:"--json", pos:["set","gate-hook","off"] — is exactly a "non-null but not a real schema
 *  mutation" parse; falling through to the ambiguous-mutation fallback rather than silently deriving a
 *  garbage key/value from it is the fix, not a special case). `tokenize()` refusing a glued-quote trick
 *  (`s"et"`) already returns null upstream of this, for the same reason. */
function parseConfigCall(segment) {
  const tokens = tokenize(segment);
  if (!tokens || !tokens.length) return null;
  let i = 0;
  while (tokens[i] && !tokens[i].quoted && (CONFIG_WRAPPER_RE.test(tokens[i].v) || /^env$/i.test(tokens[i].v))) i++;
  if (isNodeToken(tokens[i])) {
    i++;
    while (tokens[i] && !tokens[i].quoted && /^-/.test(tokens[i].v)) i++; // node's own CLI flags, e.g. --no-warnings
  } else if (tokens[i] && !tokens[i].quoted && WRAPPER_LAUNCHER_RE.test(tokens[i].v)) {
    // WP-S4: `powershell -File forge.ps1 …` / `bash forge.sh …` — skip the launcher and any flag tokens before
    // the wrapper's own script path, the same simplistic (but sufficient, fail-toward-refuse) skip node's own
    // flags get above; the wrapper path token itself never starts with `-`/`/` so this cannot skip past it.
    i++;
    while (tokens[i] && !tokens[i].quoted && /^[-/]/.test(tokens[i].v)) i++;
  }
  if (!tokens[i]) return null;
  // sec-v5 M1: `\` here may be a genuine PowerShell/Windows directory separator (real, meaningful, never an
  // escape in PowerShell) — de-escaping the WHOLE path before splitting would wrongly glue real path segments
  // together. Instead, try the RAW split first (handles every genuine path form, unchanged); only if that
  // fails, ALSO try de-escaping the full token THEN splitting (catches a Bash-escaped script name like
  // `forge-config\.cjs`, which a real Bash shell reduces to the literal `forge-config.cjs` before node ever
  // sees it, but whose raw text a naive split misreads as ending in `.cjs` with a spurious extra separator).
  // Never used to derive anything this file writes or executes — only to decide whether THIS segment names
  // the config script (or the wrapper that forwards to it) at all.
  const rawBase = String(tokens[i].v).split(/[\\/]/).pop();
  const unescapedBase = shellUnescapeForCompare(String(tokens[i].v)).split(/[\\/]/).pop();
  const isConfigScript = CONFIG_BASENAME_RE.test(rawBase) || CONFIG_BASENAME_RE.test(unescapedBase);
  const isWrapperScript = !isConfigScript && (WRAPPER_BASENAME_RE.test(rawBase) || WRAPPER_BASENAME_RE.test(unescapedBase));
  if (!isConfigScript && !isWrapperScript) return null;
  let scriptEnd = i + 1;
  if (isWrapperScript) {
    // WP-S4: forge(.cmd|.ps1|.sh) forwards everything AFTER its own `config` subcommand verbatim to
    // forge-config(-cli).cjs (see each wrapper's own `config` branch) — so `forge.ps1 config set gate-hook off`
    // must parse to the exact same verdict as `forge-config.cjs set gate-hook off`. Any other subcommand (or
    // none at all — `forge.ps1 status`, `forge.ps1 config` alone) never reaches forge-config.cjs, so it is not
    // a config call; benign counterfactuals like `forge.ps1 config list` still fall through the mutating-cmd
    // check below (list is not `set`/`unset`), same as calling forge-config.cjs directly.
    const sub = tokens[scriptEnd];
    if (!sub) return null;
    if (shellUnescapeForCompare(String(sub.v)).toLowerCase() !== WRAPPER_CONFIG_SUBCOMMAND) return null;
    scriptEnd += 1;
  }
  if (!CONFIG_CLI || typeof CONFIG_CLI.parseArgv !== 'function') return null; // cannot confidently parse -> ambiguous fallback
  const restTokens = tokens.slice(scriptEnd);
  // sec-v5 M1: de-escaped BEFORE parseArgv ever sees it, so `a.cmd`/`a.pos[]`/`a.once`/etc. all already reflect
  // what a real shell would actually pass to node — an escaped verb/key/value (`s\et`, `gate-h\ook`, `of\f`)
  // now compares correctly without any special-casing downstream (isSelfDisableCall/isOnceExempt are
  // unchanged; they already just compare these fields).
  const rest = restTokens.map((t) => shellUnescapeForCompare(String(t.v)));
  let a;
  try { a = CONFIG_CLI.parseArgv(rest); } catch { return null; }
  if (!a || !a.cmd || a.bad || !CONFIG_MUTATING_CMDS.has(String(a.cmd).toLowerCase())) return null;
  const norm = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
  // sec-v3r M2 (independent re-review): posTokens[0]/[1] are the ORIGINAL key/value TOKEN OBJECTS (see
  // positionalTokenObjects above) — used ONLY to judge whether the key/value are plain literals; `key`/`value`
  // themselves stay the plain lower-cased strings every existing caller already expects, unchanged.
  const posTokens = positionalTokenObjects(restTokens);
  return {
    verb: norm(a.cmd),
    key: norm(a.pos[0]),
    value: norm(a.pos[1]), // the FIRST word after the key only — matching OFF_WORDS' exact-word membership test;
    // extraPositional below still disqualifies the once-exemption when a third positional (garbage/an
    // unmatched trailing argument) is present, exactly as the real CLI's own `pos.slice(1).join(' ')` value
    // would then fail forge-config.cjs's own boolean parseValue() and never actually apply.
    once: typeof a.once === 'string' ? a.once : null,
    extraFlags: !!(a.json || a.all || a.global || a.yes || a.markSeen || a.help || a.ascii || a.lang != null || a.run != null || (a.flags && a.flags.length > 0)),
    extraPositional: a.pos.length > 2,
    // fail-closed when posTokens itself could not be computed (BOOL_OPTS/VALUE_OPTS unavailable): treat as
    // NOT literal, same "cannot confidently derive -> distrust" posture as every other guard in this file.
    keyLiteral: posTokens ? isLiteralToken(posTokens[0]) : false,
    valueLiteral: posTokens ? isLiteralToken(posTokens[1]) : false,
  };
}

function isSelfDisableCall(p) {
  if (!p || p.key !== 'gate-hook') return false;
  if (p.verb === 'unset') return true;
  if (p.verb === 'set') return OFF_WORDS.has(p.value);
  return false;
}
function isOnceExempt(p) {
  return !!p && p.verb === 'set' && p.key === 'gate-hook' && p.value === 'off'
    && !p.extraFlags && !p.extraPositional
    && typeof p.once === 'string' && p.once.trim().length > 0;
}

/** looksLikeAmbiguousConfigMutation(segment) -> boolean — V02 fail-closed fallback for a segment the STRICT
 *  tokenizer refuses to parse at all (e.g. a shell word-concatenation trick like `s"et"` or `'se't`, which is
 *  not a whole-word quote and correctly makes tokenize()/parseConfigCall() return null). Removing every quote
 *  character is a crude but honest normalisation: `s"et"` and `'se't` both de-glue to the word "set", exactly
 *  what a real shell would also assemble. This is used ONLY to decide whether an UNPARSEABLE segment must
 *  still be refused (blocked) as an ambiguous self-disable attempt — an ordinary, cleanly-tokenized segment
 *  always goes through the precise parseConfigCall()/isSelfDisableCall() path instead. */
// sec-v5 M1 (independent re-review): also strips backslashes now, mirroring forge-gate-inspect.cjs's own
// crude fallback (`replace(/["'\\]/g,'')`) — a segment the strict tokenizer refuses (e.g. `s"et"`) could
// ALSO be an escaped spelling (`s\et`); without this, `words.includes('set')` still misses it and the
// ambiguous-mutation fallback silently treats an escaped verb as permission instead of refusing it.
function deglue(segment) { return String(segment).replace(/["'\\]/g, ''); }
function looksLikeAmbiguousConfigMutation(segment) {
  const words = deglue(segment).trim().split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  if (!words.length) return false;
  const hasConfigScript = words.some((w) => CONFIG_BASENAME_RE.test(String(w).split(/[\\/]/).pop()));
  // WP-S4: the same crude fallback, extended to the wrapper form — a bare wrapper basename only counts once
  // its own `config` subcommand word is also present (mirrors parseConfigCall's own wrapper branch above),
  // so `forge.ps1 status` (no "config" word) still cannot match here.
  const hasWrapperScript = !hasConfigScript && words.includes(WRAPPER_CONFIG_SUBCOMMAND)
    && words.some((w) => WRAPPER_BASENAME_RE.test(String(w).split(/[\\/]/).pop()));
  const hasScript = hasConfigScript || hasWrapperScript;
  return hasScript && (words.includes('set') || words.includes('unset')) && words.includes('gate-hook');
}

/** hasNonLiteralConfigMutation(p) -> boolean — sec-v3r M2 (independent re-review): a `set`/`unset` call whose
 *  KEY or VALUE token is not a plain literal ($, backtick, %, a substitution, or an unquoted glob) could
 *  resolve to ANYTHING at runtime, including `gate-hook`/`off` — a string comparison against the unresolved
 *  token text (isSelfDisableCall) only ever tells us what that text happens to SPELL, never what it will
 *  actually expand to. Treated as an ambiguous self-disable attempt REGARDLESS of which literal key the call
 *  otherwise names, exactly like an unparseable segment — a call with a fully literal key and value (e.g.
 *  `set some-other-key value`, or `set gate-hook on`) is completely unaffected and keeps working exactly as
 *  before. `p` is already guaranteed to be a `set`/`unset` call by parseConfigCall's own CONFIG_MUTATING_CMDS
 *  filter (a null/non-mutating parse never reaches this check). */
function hasNonLiteralConfigMutation(p) {
  return !!p && (!p.keyLiteral || !p.valueLiteral);
}

/** selfDisable(seen) -> true when ANY segment of `seen` (the data-stripped text — a self-disable string quoted
 *  inside inert heredoc/echo/commit-message data must not itself trigger this) is a self-disabling forge-config
 *  call that is not the one exempt once-shape, OR a `set`/`unset` call with a non-literal key/value (M2, see
 *  hasNonLiteralConfigMutation above), OR (V02) a segment the strict parser could not read at all but whose
 *  de-quoted text still plausibly names forge-config.cjs + gate-hook with a mutating verb — refused rather
 *  than silently treated as permission. */
function selfDisable(seen) {
  for (const segment of splitForSelfDisable(seen)) {
    const parsed = parseConfigCall(segment);
    if (parsed) {
      if (isSelfDisableCall(parsed) && !isOnceExempt(parsed)) return true;
      if (hasNonLiteralConfigMutation(parsed)) return true;
      continue;
    }
    if (looksLikeAmbiguousConfigMutation(segment)) return true;
  }
  return false;
}

module.exports = {
  selfDisable, parseConfigCall, isSelfDisableCall, isOnceExempt, splitForSelfDisable,
  looksLikeAmbiguousConfigMutation, deglue, isNodeToken, OFF_WORDS, CONFIG_WRAPPER_RE, CONFIG_BASENAME_RE,
  CONFIG_MUTATING_CMDS, CONFIG_SPLIT_RE, joinLineContinuations, positionalTokenObjects, isLiteralToken,
  hasNonLiteralConfigMutation, shellUnescapeForCompare,
  WRAPPER_BASENAME_RE, WRAPPER_LAUNCHER_RE, WRAPPER_CONFIG_SUBCOMMAND,
};
