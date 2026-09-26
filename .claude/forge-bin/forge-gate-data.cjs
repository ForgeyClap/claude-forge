#!/usr/bin/env node
'use strict';
/**
 * forge-gate-data.cjs — the INERT-DATA rule of the PreToolUse gate hook (forge-gate-hook.cjs), split out on
 * 2026-09-24 (WP16 follow-up 2 + review-boss wp9a L1/L3) to keep both files under 500 lines. Pure functions,
 * zero dependencies, no I/O.
 *
 * WHY. On its first live day the hook blocked three calls whose QUOTED DATA only MENTIONED a gated command (a
 * Lead log payload, a verification line, a reviewer's prompt file). Before classifying, the hook removes ONLY
 * regions that provably never execute; everything else is classified exactly as before. Any doubt -> nothing
 * is stripped, which is the stricter behaviour. Every function here fails toward "strip nothing".
 *
 *  (a) HEREDOC BODIES (bash only) whose consumer is an unpiped pure writer — cat / tee / printf / echo — with a
 *      head line free of quotes, `$(`, backticks and `#` before the writer (leading indentation and a quoted or
 *      unquoted redirect destination are now read, not rejected — codex-recheck 2026-09-24, C02), redirects to
 *      plain paths only, no script-file destination (.sh .ps1 .cmd .bat .js .cjs .mjs .ts .py …). An UNQUOTED
 *      delimiter qualifies only when the body has no `$(`, backtick or `${`. Also the Claude Code commit form
 *      `git commit -m "$(cat <<'EOF'` whose substitution is closed by `)"` on the line after the delimiter.
 *  (b) QUOTED LITERALS — single-quoted always, double-quoted only without `$` — given to echo / printf, to
 *      `git commit -m|-am|--message`, to the project's own .claude/forge-dashboard/log-event.cjs, and (review
 *      L3) to the search tools grep / rg / egrep / fgrep / ag / Select-String / sls / findstr / `git grep` /
 *      `git log --grep`: a search tool never executes its pattern. Only when that segment is not piped (into
 *      anything) and no segment of the command is a pipe into an interpreter, AND (codex-recheck 2026-09-24,
 *      SEC-EXECUTABLE-QUOTE) only when the search tool is genuinely the git SUBCOMMAND of that segment — a
 *      `-c alias.x=<value>` or any other later argument that merely equals the word "grep"/"log"/"commit" is
 *      never enough; gitSubcommand() walks past git's own global options first.
 *  L1 (review wp9a): a region is never stripped when ANY interpreter (bash sh zsh node python* pwsh powershell
 *      cmd eval source `.` iex xargs chmod …) or layout/rename command (mv ln mklink cp rename Move-Item
 *      Copy-Item …) appears anywhere LATER in the same command — write-then-run (`… > x.txt; mv x.txt x.sh;
 *      bash x.sh`, `… | sh`) must stay classified.
 *  QUOTE-STATE AWARENESS (codex-recheck 2026-09-24, S01/S02): a `<<` operator that only LOOKS like a heredoc
 *      marker while it is actually sitting INSIDE an already-open shell quote (a multi-line single-quoted
 *      string) is never treated as a real heredoc — quoteMask() scans the WHOLE command once, not line by
 *      line, and an unterminated quote anywhere refuses the whole heredoc pass (fail closed). PowerShell also
 *      accepts the Unicode "smart quote" pair (‘ ’ “ ”) as string delimiters in addition to straight quotes;
 *      this scanner only understands straight quotes, so a PowerShell command containing ANY smart quote
 *      refuses the data exception entirely rather than mis-reading where a string really ends (S02) — the
 *      safer of the two options the finding names, since replicating PowerShell's own open/close matching
 *      exactly is not something a zero-dependency classifier should attempt.
 *
 * QUOTING-LAYER REDESIGN (2026-09-24, codex-recheck wave 5 / wp-j1): quoteMask() and stripHeredocs() are now
 * thin wrappers around the shared engine in forge-gate-quotes.cjs (scanQuotes()/findHeredocDelim()), the ONE
 * place that resolves quote/heredoc structure for both this file's INERT-DATA rule AND
 * forge-actiongate-position.cjs's command-position/`-c`-argument reading — see that file's own header for the
 * full "why" (three straight regressions, N02/N04/N05, were all two divergent scanners disagreeing at a seam)
 * and its N05 termination fix (an empty heredoc used to hang this function forever).
 *
 * API: stripInertData(command, shell) -> { text, regions } · stripHeredocs(text) · scanWords(s, shell) ·
 *      literalDataSpans(segs) · laterRisk(text) · quoteMask(text) · gitSubcommand(ws). `shell` is the tool
 *      name: 'Bash' or 'PowerShell'.
 */
const QUOTES = require('./forge-gate-quotes.cjs');
const INTERPRETER_RE = /^(bash|sh|zsh|dash|ksh|fish|node|nodejs|deno|bun|python\d*(\.\d+)?|py|perl|ruby|php|pwsh|powershell|cmd|eval|source|iex|invoke-expression|xargs|chmod|env|exec|command|builtin)$/;
const LAYOUT = new Set(['mv', 'move', 'move-item', 'mi', 'ln', 'mklink', 'cp', 'copy', 'copy-item', 'cpi', 'rename', 'ren',
  'rename-item', 'rni', 'robocopy', 'xcopy', 'new-item', 'ni']);
const SEARCH = new Set(['grep', 'rg', 'egrep', 'fgrep', 'ag', 'select-string', 'sls', 'findstr']);
const SCRIPT_EXT_RE = /\.(sh|bash|zsh|ps1|psm1|cmd|bat|js|cjs|mjs|ts|py|rb|pl|php)$/i;
// MARKER_RE/MARKER_AT_RE (the heredoc-marker regexes) now live in forge-gate-quotes.cjs — this file no longer
// scans for a marker itself, it only supplies the writer/commit-head detection stripHeredocs() there consumes.
// C02: `^\s*` admits leading indentation before the writer; the `between` group now also accepts a fully
// single- or double-quoted destination token (not just the bare, quote-free character set it used to).
const WRITER_HEAD_RE = /^\s*(?:[^'"`$()#\n]*?(?:&&|\|\||;)\s*)?(cat|tee|printf|echo)\b((?:[\w\s.\-/\\:=+>@,]|'[^'\n]*'|"[^"\n]*")*?)(?<!<)<<(?!<)-?\s*(?:'[^'\n]+'|"[^"\n]+"|[A-Za-z_]\w*)((?:\s*\d?>>?\s*(?:'[^'\n]*'|"[^"\n]*"|[\w.\-/\\:@+]+))*)\s*$/;
const COMMIT_HEAD_RE = /^\s*git\s+(?:[^'"`$()|;&#\n]*\s)?commit\b[^'"`$()|;&#\n]*\s(?:-m|-am|--message)\s+"\$\(cat\s+<<-?\s*'[^'\n]+'\s*$/;
const LOG_EVENT_RE = /(^|[\\/])\.claude[\\/]forge-dashboard[\\/]log-event\.cjs$/;
const SMART_QUOTE_RE = /[‘’“”]/; // ‘ ’ “ ”

/** laterRisk(text) -> true when `text` (what comes AFTER a data region) runs an interpreter or changes the file
 *  layout anywhere — as any whitespace token (basename, lower-case, `.exe` dropped), `.` only at a segment start. */
function laterRisk(text) {
  for (const seg of String(text).split(/&&|\|\||[;|&\n(){}]/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean)
      .map((t) => t.replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, ''));
    if (toks[0] === '.') return true;
    if (toks.some((t) => INTERPRETER_RE.test(t) || LAYOUT.has(t))) return true;
  }
  return false;
}

/** quoteMask(text) -> { inside(pos), unterminated } — thin wrapper over forge-gate-quotes.cjs::scanQuotes(),
 *  kept as a same-named/same-shape export so every existing caller and test in this project keeps working
 *  unchanged. See forge-gate-quotes.cjs's own header for the full quote-semantics and N05-termination story;
 *  this file no longer has its own copy of that scanning logic (2026-09-24 quoting-layer redesign). */
function quoteMask(text) {
  const r = QUOTES.scanQuotes(text);
  return { inside: r.inside, unterminated: r.unterminated };
}

/** findHeredocDelim — re-exported unchanged from forge-gate-quotes.cjs (single source of truth; see that
 *  file's own doc). Kept here too so `data.findHeredocDelim(...)` (existing tests, and any future caller that
 *  only ever required this file) keeps working without a second implementation to drift out of sync. */
const findHeredocDelim = QUOTES.findHeredocDelim;

function writerDests(consumer, between, tail) {
  const dests = [];
  const re = /\d?>>?\s*('[^'\n]*'|"[^"\n]*"|[^\s>]+)/g;
  let m;
  for (const part of [between, tail]) {
    re.lastIndex = 0;
    while ((m = re.exec(part)) !== null) dests.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  if (consumer === 'tee') {
    for (const w of between.replace(/\d?>>?\s*(?:'[^'\n]*'|"[^"\n]*"|[^\s>]+)/g, ' ').trim().split(/\s+/)) {
      if (w && !w.startsWith('-')) dests.push(w.replace(/^['"]|['"]$/g, ''));
    }
  }
  return dests;
}

/** stripHeredocs(text) -> { text, regions, unstripped } — thin wrapper over forge-gate-quotes.cjs::stripHeredocs(),
 *  supplying this file's own writer/commit-head detection so both the quote/heredoc SCANNING (shared, single
 *  source of truth) and the STRIPPING POLICY (which heredocs are safe to remove — pure writers, no script-file
 *  destination, no later interpreter/layout risk; this file's own concern) stay in their respective files. See
 *  forge-gate-quotes.cjs's own header for the N05 termination fix and the delimiter-search unification. */
function stripHeredocs(text) {
  return QUOTES.stripHeredocs(text, { WRITER_HEAD_RE, COMMIT_HEAD_RE, writerDests, laterRisk, SCRIPT_EXT_RE });
}

/** scanWords(s, shell) -> [{words:[{start,end,raw,spans}], sepAfter}] | null — refuses what it cannot read exactly:
 *  `$(`, backticks, parentheses, word-initial `#`, `<<`, unclosed quotes; PowerShell also lone `&`, `@'`/`@"`,
 *  and (S02) ANY smart/curly quote character anywhere — this scanner only understands straight ASCII quotes,
 *  and PowerShell accepts the smart-quote pair as real string delimiters, so a straight-quote-only scan can
 *  misjudge where a PowerShell string actually ends; refusing the whole pass is the safe direction. */
function scanWords(s, shell) {
  const bash = shell !== 'PowerShell';
  if (/\$\(|`|<</.test(s) || (!bash && (SMART_QUOTE_RE.test(s) || /@['"]|(^|[^&])&(?!&)/.test(s)))) return null;
  const segs = [];
  let words = [];
  let w = null;
  const touch = (i) => { if (!w) w = { start: i, end: i + 1, spans: [] }; w.end = i + 1; };
  const endWord = () => { if (w) { w.raw = s.slice(w.start, w.end); words.push(w); w = null; } };
  const endSeg = (sep) => { endWord(); segs.push({ words, sepAfter: sep }); words = []; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let inert = true;
      for (; j < s.length; j++) {
        if (ch === '"' && bash && s[j] === '\\') { j++; continue; }
        if (s[j] === ch) { if (!bash && s[j + 1] === ch) { j++; continue; } break; }
        if (ch === '"' && s[j] === '$') inert = false;
      }
      if (j >= s.length) return null;
      touch(i); w.spans.push({ start: i, end: j + 1, inert }); touch(j); i = j;
    } else if (bash && ch === '\\') { touch(i); if (i + 1 < s.length) touch(++i); }
    else if (ch === '(' || ch === ')' || (ch === '#' && !w)) return null;
    else if (ch === ';' || ch === '\n') endSeg(';');
    else if (ch === '&' || ch === '|') { const two = s[i + 1] === ch; endSeg(two ? ch + ch : ch); if (two) i++; }
    else if (/\s/.test(ch)) endWord();
    else touch(i);
  }
  endSeg(null);
  return segs;
}

const wholeInert = (x) => x && x.spans.length === 1 && x.spans[0].start === x.start && x.spans[0].end === x.end && x.spans[0].inert;

/** gitSubcommand(ws) -> { index, word } | null — the actual git SUBCOMMAND token: the first word after `git`
 *  that is not one of git's own global options (`-c <k=v>`, `-C <path>`, `--git-dir=…`, `--work-tree=…`, or any
 *  other `-x`/`--xxx` flag) and is not itself quoted (a quoted token can never BE the subcommand name).
 *  SEC-EXECUTABLE-QUOTE (codex-recheck 2026-09-24): this replaces a bare "is the word grep/log/commit present
 *  ANYWHERE in this segment" check, which let a `-c alias.x=<value>` (or any other later argument that merely
 *  equals one of those words) be mistaken for the subcommand and had its quoted VALUE stripped as if it were
 *  an inert search pattern. */
function gitSubcommand(ws) {
  let i = 1;
  while (i < ws.length) {
    const w = ws[i];
    if (w.spans.length) return { index: i, word: w };
    const raw = w.raw;
    if (raw === '-c' || raw === '-C' || raw === '--git-dir' || raw === '--work-tree') { i += 2; continue; }
    if (/^(?:--git-dir=|--work-tree=)/.test(raw)) { i += 1; continue; }
    if (/^-{1,2}[A-Za-z]/.test(raw)) { i += 1; continue; }
    return { index: i, word: w };
  }
  return null;
}

/** literalDataSpans(segs) -> the quoted-literal spans that are pure data (rule b, with L1 and L3).
 *  LINEAR REWRITE (wp-v3, sec-v1r-H1, independent review): the ORIGINAL implementation rebuilt the entire
 *  REMAINING text (`segs.slice(k+1)...join('\n')`) and re-ran laterRisk() over it for EVERY segment k -- O(segment
 *  count) work at EACH of O(segment count) segments, i.e. O(n^2) in the segment count. Lead-measured on harmless
 *  `echo a` chains (script `lead-probe-secv1r-h1.cjs`): 1.6s/20kB, 5.9s/40kB, 24.1s/80kB semicolon-joined;
 *  2.1s/8.5s/31.3s newline-joined; 1.1s/4.0s/15.1s `&&`-joined -- all well past this hook's own 10s timeout.
 *
 *  Fixed with ONE REVERSE PASS carrying a running "risk after this segment" flag. For each segment m, compute
 *  segRisk[m] = laterRisk() over THAT SEGMENT's own joined-words text alone (the exact same laterRisk() call the
 *  original code made, just on one segment's content instead of a freshly rebuilt suffix). Then fold a running
 *  OR from the end: suffixRisk[m] = segRisk[m] || suffixRisk[m+1]. This is PROVABLY equivalent to the original,
 *  not merely observed to match: laterRisk()'s own split regex treats `\n` as an UNCONDITIONAL separator with no
 *  quote-awareness, and the original code always joined segments with `\n` -- so for any strings A, B,
 *  laterRisk(A + '\n' + B) === laterRisk(A) || laterRisk(B), regardless of what either one contains (including a
 *  stray `;`/`\n` embedded inside what was originally quoted content -- the SAME pre-existing quirk the original
 *  whole-string rescan already had, preserved here rather than "fixed", since this function's job is an
 *  equivalent rewrite, not a behaviour change). Proven with a property-style equivalence test in
 *  forge-gate-hook.test.cjs comparing this function against the kept-verbatim ORIGINAL O(n^2) implementation
 *  (the test's own oracle) across many generated benign and dangerous-SHAPED command texts — see that test's
 *  own header for the exact case count. Total cost is now O(total segment content length), once. */
function literalDataSpans(segs) {
  const head = (seg) => (seg.words[0] && !seg.words[0].spans.length ? seg.words[0].raw.toLowerCase() : '');
  for (let k = 1; k < segs.length; k++) {
    const h = head(segs[k]).split(/[\\/]/).pop().replace(/\.exe$/, '');
    if (segs[k - 1].sepAfter === '|' && (INTERPRETER_RE.test(h) || h === '.')) return [];
  }
  const segRisk = segs.map((seg) => laterRisk(seg.words.map((x) => x.raw).join(' ')));
  const suffixRisk = new Array(segs.length + 1);
  suffixRisk[segs.length] = false;
  for (let m = segs.length - 1; m >= 0; m--) suffixRisk[m] = segRisk[m] || suffixRisk[m + 1];
  const spans = [];
  segs.forEach((seg, k) => {
    const ws = seg.words;
    const h = head(seg);
    if (!h || seg.sepAfter === '|') return;
    if (suffixRisk[k + 1]) return;
    let picked = [];
    if (h === 'echo' || h === 'printf') {
      const dests = [];
      ws.forEach((x, n) => {
        const m = /^\d?>>?(.*)$/.exec(x.raw);
        if (m) dests.push((m[1] || (ws[n + 1] ? ws[n + 1].raw : '')).replace(/^['"]|['"]$/g, ''));
      });
      if (dests.some((d) => SCRIPT_EXT_RE.test(d))) return;
      picked = ws.slice(1).filter(wholeInert);
    } else if (SEARCH.has(h)) {
      picked = ws.slice(1).filter(wholeInert);
    } else if (h === 'git') {
      const sub = gitSubcommand(ws);
      const subWord = sub && !sub.word.spans.length ? sub.word.raw.toLowerCase() : '';
      const subAt = sub ? sub.index : 1;
      if (subWord === 'commit') ws.forEach((x, n) => { if (/^(-m|-am|--message)$/.test(x.raw) && wholeInert(ws[n + 1])) picked.push(ws[n + 1]); });
      if (subWord === 'grep') picked.push(...ws.slice(subAt + 1).filter(wholeInert));
      if (subWord === 'log') {
        ws.forEach((x, n) => {
          if (x.raw === '--grep' && wholeInert(ws[n + 1])) picked.push(ws[n + 1]);
          const sp = x.spans[0];
          if (x.raw.startsWith('--grep=') && x.spans.length === 1 && sp.inert && sp.start === x.start + 7 && sp.end === x.end) {
            picked.push({ spans: [sp] });
          }
        });
      }
    } else if (h === 'node' && ws[1] && !ws[1].spans.length && LOG_EVENT_RE.test(ws[1].raw)) {
      picked = ws.slice(2).filter(wholeInert);
    }
    for (const x of picked) spans.push(x.spans[0]);
  });
  return spans;
}

// wp-v3 (sec-v1r, item 3): a defense-in-depth ceiling on scanWords()'s own segment count, independent of the
// literalDataSpans() linear fix above -- fails closed with the existing "too large to inspect" BLOCK (via
// stripInertData()'s new tooManySegments flag, read by forge-gate-inspect.cjs) rather than trusting the linear
// fix alone against a FUTURE regression in this or any other segment-driven code path. Justified from real
// measurements, not a guess: a generous CI-style command chain (a few hundred to low thousands of `&&`-joined
// steps) never comes close to this; the largest BENIGN adversarial shape this project's own timing probes
// exercise -- a 190,000-char "echo a;"/"echo a\n" chain (7 chars/segment) -- produces ~27,142 segments, so
// 50,000 stays comfortably (>1.8x) above every real probe shape while still bounding the theoretical worst case
// (MAX_COMMAND_CHARS=200,000 chars of minimal ~2-char segments, up to ~100,000 of them) to a fast, fail-closed
// BLOCK instead of unbounded segment-count-driven work, known or not yet discovered.
const MAX_INERT_SCAN_SEGMENTS = 50000;

/** stripInertData(command, shell) -> { text, regions, tooManySegments }. Never throws: on any internal error
 *  nothing is stripped. tooManySegments (wp-v3, additive field) is true only when scanWords() itself produced
 *  more than MAX_INERT_SCAN_SEGMENTS segments -- the caller (forge-gate-inspect.cjs) maps this straight to the
 *  existing "too large to inspect" BLOCK; text/regions stay at their fail-safe "nothing stripped" values in that
 *  case, exactly like any other refusal this function already makes. */
function stripInertData(command, shell) {
  try {
    let text = String(command).replace(/\r\n/g, '\n');
    let regions = 0;
    let heredocLeft = false;
    if (shell !== 'PowerShell') { const h = stripHeredocs(text); text = h.text; regions += h.regions; heredocLeft = h.unstripped; }
    if (!heredocLeft && !regions) {
      const segs = scanWords(text, shell);
      if (segs && segs.length > MAX_INERT_SCAN_SEGMENTS) {
        return { text: String(command), regions: 0, tooManySegments: true };
      }
      const spans = segs ? literalDataSpans(segs) : [];
      const seen = new Set();
      for (const sp of spans.sort((a, b) => b.start - a.start)) {
        if (seen.has(sp.start)) continue;
        seen.add(sp.start);
        text = text.slice(0, sp.start) + "''" + text.slice(sp.end);
        regions++;
      }
    }
    return { text, regions, tooManySegments: false };
  } catch {
    return { text: String(command), regions: 0, tooManySegments: false };
  }
}

module.exports = {
  stripInertData, stripHeredocs, scanWords, literalDataSpans, laterRisk, quoteMask, gitSubcommand,
  findHeredocDelim, // N05 (codex-recheck 2026-09-24, third pass) — exported for direct unit testing
  INTERPRETER_RE, LAYOUT, SEARCH, MAX_INERT_SCAN_SEGMENTS,
  wholeInert, SCRIPT_EXT_RE, LOG_EVENT_RE, // wp-v3: exported so forge-gate-hook.test.cjs's kept-verbatim ORIGINAL
  // literalDataSpans oracle (the sec-v1r-H1 equivalence proof) can rebuild the exact pre-fix function without a
  // second, drift-prone copy of these small pure helpers.
};
