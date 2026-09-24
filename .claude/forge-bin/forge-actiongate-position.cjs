'use strict';
/**
 * forge-actiongate-position.cjs — the COMMAND-POSITION widening layer for forge-actiongate.cjs's command-kind
 * gates, split out on 2026-09-24 (codex-recheck wave 2, wp-h1) to keep forge-actiongate.cjs under 500 lines.
 * Pure functions, zero dependencies, no I/O. Required by forge-actiongate.cjs; not a standalone entry point.
 *
 * WHAT THIS FILE DOES. A command-kind gate's `pattern` is tested per split SEGMENT (see
 * forge-actiongate.cjs::splitCommandsDetailed). Testing the raw segment text alone misses a dangerous verb
 * that sits behind a grouping/control-flow opener (`{ eval "$x"; }`, `if true; then eval "$x"; fi`), behind a
 * LATER case arm or PowerShell branch that is not the segment's first clause (`case y in x) :;; y) eval
 * "$cmd";; esac`, `if ($false) { Write-Output ok } else { iex $cmd }`), or loses its own substitution evidence
 * to the classifier's own segment split (`bash -c "$(cat payload.txt)"` splits into the segment `bash -c "`
 * with no `$` left in it). commandPositionCandidates() below is the single place that widens what a
 * command-kind pattern is tested against to cover all three, WITHOUT ever touching entry.segment itself — the
 * exact split() text isExcusedSegment() and every other caller pins.
 *
 * API: AMPUTATING_SEPARATORS · COMMAND_OPENER_STEPS · stripCommandOpeners(segment) ·
 *      LATER_BRANCH_RE · laterBranchStarts(text) · commandPositionCandidates(entry).
 */

/** AMPUTATING_SEPARATORS — the two separators that do NOT end a command: they OPEN a nested one inside the
 *  current command's argument list. Splitting on them is necessary for detection (the nested command must be
 *  tested too) but it always cuts the OUTER command mid-argument, so no segment on either side of one can be
 *  trusted as a complete, provable target. Note the whitespace rule below cannot save these: even the
 *  well-spaced `rm -rf ./_scratch/x $(cat list)` hides a SECOND target the classifier will never see. */
const AMPUTATING_SEPARATORS = new Set(['$(', '`']);

/** COMMAND_OPENER_STEPS / stripCommandOpeners (codex-recheck 2026-09-24, V06 — a regression `ccadad7`
 *  reintroduced) — a leading grouping or control-flow token that is not itself part of the command it
 *  introduces: `{`/`(` grouping, `!` negation, a bare bash keyword (then/do/else/elif/while/until/for/if), a
 *  header with its own `(...)` condition (if/while/elseif/foreach/for/switch/try/catch/finally), a bare
 *  PowerShell `try`, or a `case … )` arm label. `{ eval "$x"; }` splits (on `;`) into the segment
 *  `{ eval "$x"`, whose leading `{` defeated the command-position anchor entirely; `if true; then eval "$x";
 *  fi` splits into `then eval "$x"`, whose leading `then` did the same. Applied iteratively (capped) because
 *  a nested opener needs more than one strip (`then { eval …` needs "then " AND "{ " removed). This function
 *  is used ONLY to build extra candidates a command-kind PATTERN is tested against below — it never touches
 *  entry.segment itself, which stays the exact split() text isExcusedSegment() and every other caller pins. */
// ORDER MATTERS: the header-with-its-own-`(...)` step MUST run before the bare-keyword step, or a bare
// "if"/"while"/"for" strip fires first and leaves the header's own condition parens as orphaned, unmatched
// text (`if ($true) {...}` would otherwise strip only "if " and get stuck on the leftover "($true) {...}").
// wave 2 (codex-recheck 2026-09-24, V06): "catch"/"finally" joined the bare-keyword step (a bare
// `catch { ... }`/`finally { ... }` carries no `(...)` for the header-with-parens step to strip), and a new
// final step strips a LATER case-arm label (`y)`, `*)`, `"quoted")`) that is not preceded by the literal word
// "case" at all — the split already isolates each arm into its own segment starting directly at the label
// (`case y in x) :;; y) eval "$cmd";; esac` splits the second arm to the segment `y) eval "$cmd"`), so the
// dedicated `case\b...` step never fires for it. A case-arm label is conventionally a single whitespace-free
// token (no space before its own `)`), which is what keeps this from swallowing an unrelated
// "several words) more words" span that merely happens to contain a stray parenthesis (`foo(bar)` also never
// matches: the class excludes `(` too, so it cannot reach a `)` without first hitting the excluded opener).
const COMMAND_OPENER_STEPS = [
  /^[{(]\s*/,
  /^!\s*/,
  /^(?:if|while|elseif|foreach|for|switch|catch|finally|try)\b\s*\([\s\S]*?\)\s*/i,
  /^(?:then|do|else|elif|while|until|for|if|catch|finally)\b\s*/i,
  /^try\b\s*/i,
  /^case\b[\s\S]*?\)\s*/i,
  /^[^\s()\n]{1,40}\)\s*/,
];
function stripCommandOpeners(segment) {
  let s = String(segment);
  for (let i = 0; i < 6; i++) {
    let changed = false;
    for (const re of COMMAND_OPENER_STEPS) {
      const m = re.exec(s);
      if (m && m[0].length) { s = s.slice(m[0].length); changed = true; }
    }
    if (!changed) break;
  }
  return s;
}

/** LATER_BRANCH_RE / laterBranchStarts (V06 wave 2; quote-aware since N04) — a later `else`/`elseif`/`catch`/
 *  `finally` keyword occurring ANYWHERE inside a single split segment, not only at its own start. A
 *  multi-clause construct on one line/segment with no `;` between its clauses (`if ($false) { Write-Output ok
 *  } else { iex $cmd }` is one whole segment: nothing in it is a shell/PowerShell statement separator this
 *  classifier splits on) never advances past its FIRST clause's own closing brace, because
 *  stripCommandOpeners() only ever strips from position 0. Each keyword match becomes an ADDITIONAL candidate
 *  start — the segment's own text from there to the end (openers re-stripped on it too, exactly like any
 *  other candidate) — never a replacement for the existing position-0 candidates, so nothing that used to
 *  match can stop matching. Cutting only ever happens at a genuine control-flow-keyword boundary, never inside
 *  an actual command word, so a real command's own preceding context (e.g. `git ` immediately before `rm` for
 *  git-destructive's/destructive-delete's lookbehind exceptions) is never severed by this — whatever precedes
 *  `rm` in the ORIGINAL segment still precedes it in every slice that still contains it.
 *  N04 (codex-recheck 2026-09-24, third independent pass — a new false-positive regression): the keyword scan
 *  used to match the plain WORD anywhere, including inside quoted DATA — `node docs.cjs "else eval report"`
 *  and `Write-Host "catch iex is an alias"` both promoted their quoted argument's own text to a fake
 *  command-position candidate, which then matched opaque-exec's eval/iex alternative on ordinary output text
 *  and a file name. `simpleQuoteMask()` below skips a match sitting inside a `'...'`/`"..."` span; every
 *  wave-2 positive above has NO quoting around its else/elseif/catch/finally keyword at all, so none of them
 *  are affected. */
function simpleQuoteMask(text) {
  const marks = new Array(text.length + 1).fill(false);
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "'" && ch !== '"') { i++; continue; }
    let j = i + 1;
    let closed = false;
    for (; j < text.length; j++) {
      if (ch === '"' && text[j] === '\\') { j++; continue; }
      if (text[j] === ch) { closed = true; j++; break; }
    }
    for (let k = i; k < j; k++) marks[k] = true;
    if (!closed) { for (let k = j; k <= text.length; k++) marks[k] = true; break; }
    i = j;
  }
  return (pos) => marks[pos] === true;
}
const LATER_BRANCH_RE = /\b(?:else|elseif|catch|finally)\b/ig;
function laterBranchStarts(text) {
  const starts = [];
  const inside = simpleQuoteMask(text);
  LATER_BRANCH_RE.lastIndex = 0;
  let m;
  while ((m = LATER_BRANCH_RE.exec(text)) !== null) {
    if (m.index > 0 && !inside(m.index)) starts.push(text.slice(m.index));
    if (m[0].length === 0) LATER_BRANCH_RE.lastIndex++; // defensive: never spin on a zero-width match
  }
  return starts;
}

/** commandPositionCandidates(entry) -> the string(s) a command-kind gate's `pattern` is tested against for
 *  ONE split segment: the segment itself; the same text with its own amputating separator's marker
 *  (`$(`/backtick) RE-ATTACHED (V06 — the classifier's own split silently ate that exact character before a
 *  `[^\n]*\$` / backtick lookahead ever ran, e.g. `bash -c "$(cat payload.txt)"` split into the segment
 *  `bash -c "` with no `$` left in it at all); that text with leading grouping/control-flow openers stripped;
 *  and (V06 wave 2) the text from every LATER else/elseif/catch/finally keyword to the end, each with its own
 *  openers stripped too. Every candidate is a SUPERSET of the plain segment text (never a rewrite of it), so a
 *  pattern with no start/end anchor (every pattern except opaque-exec's own iex/eval alternative) can only
 *  ever gain a match on inert trailing/leading noise, never lose one — the three other command gates are
 *  unaffected in practice (measured: the shipped corpus is unchanged) and entry.segment itself is never
 *  modified. */
function ampSuffix(entry) {
  return entry.sepAfter && AMPUTATING_SEPARATORS.has(entry.sepAfter) ? entry.sepAfter : '';
}
function commandPositionCandidates(entry) {
  const withSuffix = entry.segment + ampSuffix(entry);
  const bases = [entry.segment, withSuffix].concat(laterBranchStarts(withSuffix));
  const out = [];
  const seen = new Set();
  const add = (s) => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
  for (const b of bases) {
    add(b);
    const stripped = stripCommandOpeners(b);
    if (stripped !== b) add(stripped);
  }
  return out;
}

/** hasLiveCArg(text) -> boolean — N02 (codex-recheck 2026-09-24, THIRD independent pass): a live variable or
 *  substitution inside a `sh -c`/`bash -c`/`pwsh -c`/`powershell -c` argument cannot be told apart from a
 *  genuinely inert one by a single declarative regex, so this replaces forge-actiongate.cjs's own wave-2
 *  blanket "an escaped $/backtick is always inert" exemption — itself a live bypass Codex reproduced
 *  (`x='printf SAFE_N02_PROBE'`; `/bin/bash -c "\$x"` really ran it). A backslash before `$`/backtick inside a
 *  DOUBLE-quoted `-c` argument is escaped for the OUTER shell ONLY: the outer shell strips exactly that one
 *  backslash and hands the INNER `-c` interpreter the resulting bare `$x` / `` `cmd` ``, which it then expands
 *  and executes. The escape is genuinely inert only when the character it protects ALSO sits inside a pair of
 *  literal single quotes within that same argument — bash gives single quotes zero special characters,
 *  including backslash, so the outer shell passes a `'...'` span straight through untouched and the inner
 *  shell re-reads that exact span as its OWN real single-quoting (`bash -c "printf '\$(word)'"` stays literal
 *  — the wave-1 fixture this must not reopen). cArgHasLiveMarker() walks every double-quoted span in `text`
 *  and fires the moment ANY `$`/backtick inside one — escaped or not — is not currently inside an open
 *  single-quote run; a fully static `-c "echo hello"` argument, with no `$`/backtick at all, stays silent
 *  exactly as documented. Both PURE, never throw. */
const C_SHAPE_RE = /\b(?:sh|bash|pwsh|powershell)\b/i;
const C_FLAG_RE = /\s-c\b/i;
function cArgHasLiveMarker(text) {
  const s = String(text);
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '"') { i++; continue; }
    let j = i + 1;
    let singleOpen = false;
    let live = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length) {
        const n = s[j + 1];
        if (n === '$' || n === '`') { if (!singleOpen) live = true; j++; continue; }
        if (n === '"' || n === '\\' || n === '\n') { j++; continue; }
        continue; // an unrecognised double-quote escape: the backslash is a literal char, protects nothing
      }
      if (c === "'") { singleOpen = !singleOpen; continue; }
      if (c === '"') break; // closing quote of this double-quoted span
      if ((c === '$' || c === '`') && !singleOpen) live = true;
    }
    if (live) return true;
    i = j + 1;
  }
  return false;
}
function hasLiveCArg(text) {
  const s = String(text);
  return C_SHAPE_RE.test(s) && C_FLAG_RE.test(s) && cArgHasLiveMarker(s);
}

module.exports = {
  AMPUTATING_SEPARATORS, COMMAND_OPENER_STEPS, stripCommandOpeners,
  LATER_BRANCH_RE, laterBranchStarts, commandPositionCandidates,
  hasLiveCArg, cArgHasLiveMarker,
};
