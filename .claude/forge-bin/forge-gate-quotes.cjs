#!/usr/bin/env node
'use strict';
/**
 * forge-gate-quotes.cjs — the ONE shared quote/heredoc-aware scanning pass for the PreToolUse gate hook and its
 * classifier (root-cause rewrite, 2026-09-24, codex-recheck wave 5 / wp-j1, after three straight waves each
 * patched a SYMPTOM and regressed a SIBLING). Before this file, forge-gate-data.cjs (bash quoteMask/
 * stripHeredocs, the INERT-DATA rule) and forge-actiongate-position.cjs (a separate, much simpler
 * simpleQuoteMask, used only for later-branch detection) each rescanned quote structure independently and
 * disagreed at the seams — N02/N04/N05 (codex-recheck p10) were all instances of the SAME root cause: two
 * scanners of the same text producing two different answers about where a quote begins, ends, or never closes.
 * This file is now the ONLY place that decides "is character position P inside a quote/heredoc body", computed
 * ONCE per command text; every caller (forge-gate-data.cjs's stripHeredocs/stripInertData,
 * forge-actiongate-position.cjs's laterBranchStarts and the `-c` argument reader) queries that SAME result with
 * ORIGINAL, unmodified offsets into that text — never a fresh mask started over on a fragment.
 *
 * TERMINATION (N05, codex-recheck p10 — a REGRESSION the third pass introduced, not a first bug: an EMPTY
 * heredoc, `cat > f <<'EOF'` immediately followed by `EOF` on the very next line, hung the wave-4 quoteMask
 * forever). The bug: the literal-heredoc-body skip recorded `skipTo.set(bodyStart, delimStart)`, and for an
 * EMPTY body `delimStart === bodyStart` — a skip entry pointing AT ITSELF. The main loop then repeatedly read
 * that same entry and jumped back to the position it started from, forever. scanQuotes() below fixes this at
 * the ROOT: a skip is only ever recorded when its destination is STRICTLY GREATER than its key (an empty body
 * needs no skip at all — the delimiter line is already the very next thing the loop would read, and it contains
 * no quote characters by construction, see findHeredocDelim's own doc). A defensive per-call iteration cap
 * (`text.length + 1`) is layered on top so non-termination stays structurally impossible even if some future
 * change reintroduces a bad skip — every real iteration strictly advances `i`, so a bug-free scan can never
 * reach the cap; hitting it is treated as `unterminated` (fail toward "strip/allow nothing"), never a hang.
 *
 * QUOTE SEMANTICS (unchanged from the pre-existing, well-tested design; see the V05/wave-2 history this file
 * carries forward): single quotes give bash ZERO special characters, including `$(` and backslash, until the
 * next literal `'`; double quotes let `$(...)` substitution and backslash-escaping run; a `$(...)` reached
 * OUTSIDE any quote (or from inside a double quote) is its own fresh lexical context, recursed into via
 * mergeNestedSubstitution() so a fake heredoc/quote nested arbitrarily deep inside one is still judged
 * correctly. An unterminated quote or unbalanced substitution poisons the rest of the scan as `unterminated`
 * (fail closed).
 *
 * -c ARGUMENT POLICY (N02, FOURTH pass — hard-gates.json's opaque-exec `_pattern_doc` is the canonical
 * statement of this policy; this file is its implementation). A `sh -c`/`bash -c`/`pwsh -c`/`powershell -c`
 * argument is LIVE (dynamic, unknown content) unless it is provably literal for BOTH shells involved:
 *
 *   NONE (a bare, unquoted token right after -c): the OUTER shell fully expands/word-splits it before -c ever
 *     runs. Any `$`/backtick anywhere in the bare token means the outer shell hands -c content it built itself
 *     -> LIVE. A token with neither character is a static literal -> not live.
 *   SINGLE ('...'): bash gives single quotes zero special characters, so this exact literal text (including any
 *     `$`/backtick in it, verbatim) becomes the -c argument UNCHANGED, and THAT text is what the inner `-c`
 *     interpreter then reads as ITS OWN script. A literal `'` can never appear inside a single-quoted span (it
 *     would close it), so nothing inside can be "protected by inner single-quoting" either — any `$`/backtick
 *     anywhere in the content -> LIVE.
 *   DOUBLE ("..."): the outer shell expands an UNESCAPED `$`/backtick inside double quotes regardless of any
 *     literal `'` characters nearby (single quotes carry no meaning inside double quotes to the OUTER shell) ->
 *     always LIVE. A backslash-escaped `\$`/`` \` `` is stripped by the outer shell only, handing the inner -c
 *     interpreter a bare `$`/backtick it will itself expand, UNLESS that exact character also sits inside a
 *     pair of literal `'` characters within the SAME double-quoted argument (those pass through the outer shell
 *     unchanged and become real single-quoting once the inner shell reads the resulting string as its own
 *     script) -> live only when NOT currently inside such a span.
 *   Anything this reader cannot bound (a `-c` argument whose opening quote never closes) is judged dynamic —
 *     fail toward fire, per the same "cannot inspect it -> stop and ask" principle opaque-exec exists for.
 *
 * API: scanQuotes(text) -> {inside(pos), unterminated, spans} · stripHeredocs(text) [bash-only heredoc removal,
 *      moved here unchanged in external contract from forge-gate-data.cjs] · findHeredocDelim(text, bodyStart,
 *      dash, delim) -> {delimStart, delimEnd} | null · cArgLiveAfterFlag(text) -> boolean.
 */

// A heredoc marker recognised exactly AT the scanner's current position (never searching ahead), so scanQuotes()
// can decide, character by character, whether `<<` right here really opens a heredoc.
const MARKER_AT_RE = /(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_]\w*))/y;
// The line-scanning counterpart used by forge-gate-data.cjs's stripHeredocs() to find a marker anywhere on a
// given line (may match more than once per line, which stripHeredocs treats as "cannot resolve, strip nothing").
const MARKER_RE = /(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_]\w*))/g;

/** findHeredocDelim(text, bodyStart, dash, delim) -> {delimStart, delimEnd} | null. The ONE place either caller
 *  (scanQuotes' own literal-body skip, and forge-gate-data.cjs's stripHeredocs) locates the line whose content
 *  equals `delim` — leading tabs stripped first when `dash` is truthy — scanning forward from `bodyStart`. A
 *  trailing `\r` (CRLF line endings) is stripped before comparison, so a Windows-authored heredoc still
 *  resolves; a delimiter line carrying trailing SPACE, or one wrapped in quote characters, deliberately still
 *  does NOT match — real bash requires the closing line to consist solely of the delimiter, nothing more — so
 *  failing to resolve those (fail closed: strip/skip nothing) mirrors real shell behaviour rather than being
 *  merely cautious. Returns null (never a guess) when no such line exists before the text ends. */
function findHeredocDelim(text, bodyStart, dash, delim) {
  let pos = bodyStart;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    let line = text.slice(pos, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1); // CRLF: a trailing \r is never part of the delimiter word
    const cmp = dash ? line.replace(/^\t+/, '') : line;
    if (cmp === delim) return { delimStart: pos, delimEnd: lineEnd };
    if (nl === -1) return null;
    pos = nl + 1;
  }
  return null;
}

/** skipSubstitution(text, at) -> {end, balanced}. Naive balanced-paren count over raw characters starting at a
 *  `$(` — this does not lex the substitution's own quoting while counting; mergeNestedSubstitution() below
 *  does that separately by recursing scanQuotes() over the inner text. `balanced:false` means depth never
 *  reached 0 (an unbalanced/truncated substitution); the caller must treat that as unresolved (fail closed). */
function skipSubstitution(text, at) {
  let depth = 1;
  let j = at + 2;
  for (; j < text.length && depth > 0; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') depth--;
  }
  return { end: j, balanced: depth === 0 };
}

/** mergeNestedSubstitution(text, at, marks) -> {end, unterminated}. A `$(...)` command substitution is bash's
 *  own fresh lexical context: a heredoc marker or quote sitting inside it is judged on ITS OWN nested quote
 *  structure, never on whatever quote (or lack of one) merely contains the substitution. Recursing scanQuotes()
 *  over the substitution's own inner text and merging its "inside" positions (offset-adjusted) into the outer
 *  `marks` array resolves arbitrary nesting depth through ordinary recursion. */
function mergeNestedSubstitution(text, at, marks) {
  const sub = skipSubstitution(text, at);
  const innerStart = at + 2;
  const innerEnd = sub.balanced ? Math.max(innerStart, sub.end - 1) : sub.end;
  const inner = scanQuotes(text.slice(innerStart, innerEnd));
  for (let p = 0; p < innerEnd - innerStart; p++) if (inner.inside(p)) marks[innerStart + p] = true;
  return { end: sub.end, unterminated: !sub.balanced || inner.unterminated };
}

/** scanQuotes(text) -> {inside(pos), unterminated, spans}. A BASH-ONLY, whole-text (never per-line, never
 *  per-fragment) single pass over `'`/`"` runs and `$(...)` substitutions, so a heredoc operator or a control-
 *  flow keyword that only LOOKS free-standing while actually sitting inside an already-open quote is never
 *  misread — the exact class of bug N04 was (a naive per-segment rescan started fresh at a position that was
 *  really still inside an earlier, still-open double quote). `spans` records every top-level quote span found
 *  (`{start, end, kind}`, `end` exclusive past the closing quote character) in ORIGINAL-text offsets, for
 *  callers (cArgLiveAfterFlag) that need to reason about a specific argument's own outer quoting form rather
 *  than a plain inside/outside boolean. See this file's header for the N05 termination fix and quote-semantics
 *  summary. Never throws. */
function scanQuotes(text) {
  text = String(text);
  const n = text.length;
  const marks = new Array(n + 1).fill(false);
  const spans = [];
  let unterminated = false;
  let i = 0;
  let guard = 0;
  const guardMax = n + 1; // N05: a hard cap makes non-termination structurally impossible, belt-and-suspenders
  const skipTo = new Map(); // literal heredoc body start -> its own delimiter line's start, THIS scan only
  while (i < n) {
    if (guard++ > guardMax) { unterminated = true; break; } // should never trigger given the invariant below
    if (skipTo.has(i)) {
      const dest = skipTo.get(i);
      i = dest > i ? dest : i + 1; // never accept a non-advancing or backward jump through this map
      continue;
    }
    const ch = text[i];
    if (ch === '<' && text[i + 1] === '<') {
      MARKER_AT_RE.lastIndex = i;
      const hm = MARKER_AT_RE.exec(text);
      if (hm) {
        const delim = hm[2] || hm[3] || hm[4];
        const nl = text.indexOf('\n', i + hm[0].length);
        if (nl !== -1) {
          const body = findHeredocDelim(text, nl + 1, hm[1], delim);
          // N05 root-cause fix: an EMPTY body means the delimiter line already starts at nl+1 — there is
          // nothing to skip, and recording skipTo.set(nl+1, nl+1) would be the exact self-referencing jump
          // that hung the previous implementation forever. Only a skip landing STRICTLY AFTER its own key is
          // ever recorded; the delimiter line itself contains no quote characters (see findHeredocDelim's
          // own doc), so leaving it to the ordinary per-character scan is harmless either way.
          if (body && body.delimStart > nl + 1) skipTo.set(nl + 1, body.delimStart);
        }
      }
    }
    if (ch === '$' && text[i + 1] === '(') {
      const sub = mergeNestedSubstitution(text, i, marks);
      if (sub.unterminated) { for (let k = i; k <= n; k++) marks[k] = true; unterminated = true; break; }
      i = sub.end;
      continue;
    }
    if (ch !== "'" && ch !== '"') { i++; continue; }
    const spanStart = i;
    const kind = ch === "'" ? 'single' : 'double';
    marks[i] = true;
    let j = i + 1;
    let closed = false;
    while (j < n) {
      // single quotes suppress `$(` too — only a double quote lets a substitution run inside it.
      if (ch === '"' && text[j] === '$' && text[j + 1] === '(') {
        const sub = mergeNestedSubstitution(text, j, marks);
        if (sub.unterminated) { j = n; break; } // the outer quote-open-to-end poison below fires
        j = sub.end;
        continue;
      }
      if (ch === '"' && text[j] === '\\') { marks[j] = true; if (j + 1 < n) marks[j + 1] = true; j += 2; continue; }
      if (text[j] === ch) { marks[j] = true; closed = true; j++; break; }
      marks[j] = true;
      j++;
    }
    if (!closed) { for (let k = spanStart; k <= n; k++) marks[k] = true; unterminated = true; break; }
    spans.push({ start: spanStart, end: j, kind });
    i = j;
  }
  return { inside: (pos) => marks[pos] === true, unterminated, spans };
}

/** stripHeredocs(text) -> {text, regions, unstripped}. Bash-only literal-heredoc-body removal for the
 *  INERT-DATA rule; moved here unchanged in external contract from forge-gate-data.cjs (2026-09-24 quoting-
 *  layer redesign) so quote-state and heredoc-body resolution share exactly ONE implementation
 *  (findHeredocDelim/scanQuotes) instead of forge-gate-data.cjs's own line-array search that used to disagree
 *  with the one scanQuotes used internally. Two markers on one line, an unterminated quote anywhere in the
 *  WHOLE text, or an unresolved heredoc strip nothing; a heredoc that fails the rule is kept verbatim and
 *  skipped whole (an executed body is never re-read). */
function stripHeredocs(text, deps) {
  const { WRITER_HEAD_RE, COMMIT_HEAD_RE, writerDests, laterRisk, SCRIPT_EXT_RE } = deps;
  const qmask = scanQuotes(text);
  if (qmask.unterminated) return { text, regions: 0, unstripped: true }; // cannot tell "inside" from "outside"
  const lines = text.split('\n');
  const out = [];
  let regions = 0;
  let unstripped = false;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const lineOffset = offset;
    offset += line.length + 1; // '\n' consumed by split; `offset` now equals this line's OWN body-start offset
    const markers = [...line.matchAll(MARKER_RE)].filter((m) => !qmask.inside(lineOffset + m.index));
    if (!markers.length) continue;
    if (markers.length > 1) return { text, regions: 0, unstripped: true };
    const [, dash, sq, dq, bare] = markers[0];
    const delim = sq || dq || bare;
    const body = findHeredocDelim(text, offset, dash, delim); // the SAME delimiter search scanQuotes() itself
    // uses (single source of truth) — `offset` here is exactly the character position right after this
    // marker line's own newline, i.e. the heredoc body's first character, in the ORIGINAL text.
    if (!body) return { text, regions: 0, unstripped: true };
    const numBodyLines = (text.slice(offset, body.delimStart).match(/\n/g) || []).length;
    const end = i + 1 + numBodyLines; // convert the offset-based match back to this function's own line index
    const bodyLines = lines.slice(i + 1, end);
    const rest = lines.slice(end + 1).join('\n');
    let ok = false;
    const w = WRITER_HEAD_RE.exec(line);
    if (w && (!bare || !/\$\(|`|\$\{/.test(bodyLines.join('\n')))) {
      ok = !writerDests(w[1], w[2], w[3]).some((d) => SCRIPT_EXT_RE.test(d)) && !laterRisk(rest);
    } else if (!bare && COMMIT_HEAD_RE.test(line)) {
      const closer = lines[end + 1] || '';
      ok = /^\)"/.test(closer) && !laterRisk(closer.slice(2) + '\n' + lines.slice(end + 2).join('\n'));
    }
    if (ok) regions++; else { unstripped = true; out.push(...bodyLines); }
    out.push(lines[end]);
    for (let k = i + 1; k <= end; k++) offset += lines[k].length + 1;
    i = end;
  }
  return { text: out.join('\n'), regions, unstripped };
}

/** skipWs(s, i) -> the index of the next non-whitespace character at/after i (or s.length). */
function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }

/** scanDoubleQuoteLive(s, i) -> true/false/null. `s[i]` must be the OPENING `"` of a `-c` argument. Reads to
 *  its matching closing `"` applying the two-shell-layer rule from this file's own header: an UNESCAPED
 *  `$`/backtick is always live (the outer shell expands it regardless of any literal `'` nearby); an ESCAPED
 *  `\$`/`` \` `` is live only when NOT currently inside a still-open literal `'` span within this same
 *  argument. Returns null when the quote never closes (unterminated -> the caller must fail toward fire). */
function scanDoubleQuoteLive(s, i) {
  let j = i + 1;
  let singleOpen = false;
  let live = false;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) {
      const nx = s[j + 1];
      if (nx === '$' || nx === '`') { if (!singleOpen) live = true; j++; continue; }
      if (nx === '"' || nx === '\\' || nx === '\n') { j++; continue; }
      continue; // an unrecognised double-quote escape: the backslash is a literal char, protects nothing
    }
    if (c === "'") { singleOpen = !singleOpen; continue; }
    if (c === '"') return live; // closing quote of this argument
    if (c === '$' || c === '`') live = true; // N02 fourth pass: ALWAYS live when unescaped, regardless of
    // singleOpen — inside double quotes, a literal `'` character has no special meaning to the OUTER shell and
    // never suppresses its expansion; only backslash can protect a character from the outer shell here.
  }
  return null; // never closed -> unterminated, fail toward fire
}

/** readBareWord(s, i) -> the shell "word" starting at i: everything up to the next whitespace or a shell
 *  metacharacter that would end an unquoted word (`;|&()<>` or newline), or the end of the string. */
function readBareWord(s, i) {
  let j = i;
  while (j < s.length && !/[\s;|&()<>]/.test(s[j])) j++;
  return s.slice(i, j);
}

const C_FLAG_OCCUR_RE = /(?:^|\s)-c\b/g;

/** cArgLiveAfterFlag(text) -> boolean. The -c ARGUMENT POLICY (see this file's header) implemented for all
 *  three outer quoting forms. Locates every standalone `-c` token in `text` and classifies the very next shell
 *  word — bare, single-quoted, or double-quoted — firing the instant any one of them is judged live. An
 *  unterminated quote right after `-c` is unresolved shape, not a known-safe one: judged live (fail toward
 *  fire), matching the same principle opaque-exec exists for ("Forge cannot see what this would run"). Pure,
 *  never throws. */
function cArgLiveAfterFlag(text) {
  const s = String(text);
  const re = new RegExp(C_FLAG_OCCUR_RE.source, 'g');
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = skipWs(s, m.index + m[0].length);
    if (i >= s.length) continue; // a trailing "-c" with nothing after it: no argument to judge
    const ch = s[i];
    if (ch === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return true; // unterminated -> cannot bound -> fire
      if (/[$`]/.test(s.slice(i + 1, close))) return true;
      continue;
    }
    if (ch === '"') {
      const r = scanDoubleQuoteLive(s, i);
      if (r === null || r === true) return true;
      continue;
    }
    if (/[$`]/.test(readBareWord(s, i))) return true;
  }
  return false;
}

module.exports = {
  scanQuotes, stripHeredocs, findHeredocDelim, mergeNestedSubstitution, skipSubstitution,
  cArgLiveAfterFlag, scanDoubleQuoteLive, readBareWord, MARKER_RE, MARKER_AT_RE,
};
