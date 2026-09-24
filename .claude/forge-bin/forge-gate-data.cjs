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
 * API: stripInertData(command, shell) -> { text, regions } · stripHeredocs(text) · scanWords(s, shell) ·
 *      literalDataSpans(segs) · laterRisk(text) · quoteMask(text) · gitSubcommand(ws). `shell` is the tool
 *      name: 'Bash' or 'PowerShell'.
 */
const INTERPRETER_RE = /^(bash|sh|zsh|dash|ksh|fish|node|nodejs|deno|bun|python\d*(\.\d+)?|py|perl|ruby|php|pwsh|powershell|cmd|eval|source|iex|invoke-expression|xargs|chmod|env|exec|command|builtin)$/;
const LAYOUT = new Set(['mv', 'move', 'move-item', 'mi', 'ln', 'mklink', 'cp', 'copy', 'copy-item', 'cpi', 'rename', 'ren',
  'rename-item', 'rni', 'robocopy', 'xcopy', 'new-item', 'ni']);
const SEARCH = new Set(['grep', 'rg', 'egrep', 'fgrep', 'ag', 'select-string', 'sls', 'findstr']);
const SCRIPT_EXT_RE = /\.(sh|bash|zsh|ps1|psm1|cmd|bat|js|cjs|mjs|ts|py|rb|pl|php)$/i;
const MARKER_RE = /(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_]\w*))/g;
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

/** skipSubstitution(text, at) -> index just past the matching `)` of a `$(` starting at `at` (balanced paren
 *  count; text.length when unbalanced). A command substitution is its own lexical context — bash evaluates it
 *  regardless of an enclosing quote, so its content (including a real heredoc inside it, the Claude Code
 *  `git commit -m "$(cat <<'EOF' ...)"` form) must never be swallowed by the OUTER quote scan. */
function skipSubstitution(text, at) {
  let depth = 1;
  let j = at + 2;
  for (; j < text.length && depth > 0; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') depth--;
  }
  return j;
}

/** quoteMask(text) -> { inside(pos), unterminated } — a BASH-ONLY, whole-text (never per-line) scan of `'`/`"`
 *  runs, so a heredoc operator that only LOOKS like one while sitting inside an already-open multi-line quote
 *  is never mistaken for a real one (codex-recheck S01). Backslash escaping is honoured only inside double
 *  quotes, mirroring scanWords()'s own bash rules. A `$(...)` command substitution at the OUTER (not-yet-
 *  inside-any-quote) scan level — even one found WHILE scanning for a DOUBLE quote's closing character — is
 *  skipped over unmarked: its content is not "inside" the outer quote for this scanner's purposes, and a
 *  genuinely nested heredoc inside it is judged on its own. SINGLE QUOTES ARE DIFFERENT (codex-recheck V05,
 *  fixing a real bypass): bash gives single quotes ZERO special characters until the next literal `'` — not
 *  even `$(`. Skipping `$(...)` while scanning FOR that closing `'` used to jump straight to whatever `)`
 *  balanced it, silently leaving every character in between UNMARKED (not "inside" the quote) even though it
 *  truly is; a fake `<<EOF` heredoc marker sitting inside a single-quoted literal like `echo '$(\ncat
 *  <<EOF\n)'` then looked "outside" any quote to stripHeredocs() and swallowed the real command that followed
 *  it. Inside a single quote every character up to the literal closing `'` is now marked one at a time — no
 *  substitution, no backslash escaping, exactly like a real shell. An unterminated quote poisons everything
 *  from its opening character to the end of the text; `unterminated` tells the caller to refuse the whole
 *  heredoc pass. */
function quoteMask(text) {
  const marks = new Array(text.length + 1).fill(false);
  let unterminated = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '$' && text[i + 1] === '(') { i = skipSubstitution(text, i); continue; }
    if (ch !== "'" && ch !== '"') { i++; continue; }
    marks[i] = true;
    let j = i + 1;
    let closed = false;
    while (j < text.length) {
      // V05: a single quote suppresses `$(` too — only a double quote lets a substitution run inside it.
      if (ch === '"' && text[j] === '$' && text[j + 1] === '(') { j = skipSubstitution(text, j); continue; }
      if (ch === '"' && text[j] === '\\') { marks[j] = true; if (j + 1 < text.length) marks[j + 1] = true; j += 2; continue; }
      if (text[j] === ch) { marks[j] = true; closed = true; j++; break; }
      marks[j] = true;
      j++;
    }
    if (!closed) { for (let k = i; k <= text.length; k++) marks[k] = true; unterminated = true; break; }
    i = j;
  }
  return { inside: (pos) => marks[pos] === true, unterminated };
}

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

/** stripHeredocs(text) -> { text, regions, unstripped }. Two markers on one line, an unterminated quote
 *  anywhere in the WHOLE text, or an unterminated heredoc strip nothing; a heredoc that fails the rule is kept
 *  verbatim and skipped whole (an executed body is never re-read). `offset`/`lineOffset` track each line's
 *  real byte position in the ORIGINAL `text` so qmask.inside() (built once against that original text) is
 *  asked about the right position — codex-recheck V05: after successfully recognising a heredoc the loop
 *  jumps `i` straight to its `end` line to avoid re-scanning the body, but `offset` used to advance ONLY by
 *  the marker line's own length, never by the SKIPPED body+delimiter lines' lengths too. Every later line's
 *  `lineOffset` then understated the true offset by exactly that skipped span, so a second, FAKE heredoc
 *  marker sitting inside an earlier still-open single-quoted literal got checked against the WRONG (too-early,
 *  unquoted) position in the mask and wrongly looked "outside" any quote — exactly the bypass this fixes. */
function stripHeredocs(text) {
  const qmask = quoteMask(text);
  if (qmask.unterminated) return { text, regions: 0, unstripped: true }; // S01: cannot tell "inside" from "outside"
  const lines = text.split('\n');
  const out = [];
  let regions = 0;
  let unstripped = false;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const lineOffset = offset;
    offset += line.length + 1; // '\n' consumed by split
    // S01: a `<<` sitting inside an already-open quote (from an earlier or the same line) is not a real marker.
    const markers = [...line.matchAll(MARKER_RE)].filter((m) => !qmask.inside(lineOffset + m.index));
    if (!markers.length) continue;
    if (markers.length > 1) return { text, regions: 0, unstripped: true };
    const [, dash, sq, dq, bare] = markers[0];
    const delim = sq || dq || bare;
    let end = -1;
    for (let k = i + 1; k < lines.length; k++) if ((dash ? lines[k].replace(/^\t+/, '') : lines[k]) === delim) { end = k; break; }
    if (end < 0) return { text, regions: 0, unstripped: true };
    const body = lines.slice(i + 1, end).join('\n');
    const rest = lines.slice(end + 1).join('\n');
    let ok = false;
    const w = WRITER_HEAD_RE.exec(line);
    if (w && (!bare || !/\$\(|`|\$\{/.test(body))) {
      ok = !writerDests(w[1], w[2], w[3]).some((d) => SCRIPT_EXT_RE.test(d)) && !laterRisk(rest);
    } else if (!bare && COMMIT_HEAD_RE.test(line)) {
      const closer = lines[end + 1] || '';
      ok = /^\)"/.test(closer) && !laterRisk(closer.slice(2) + '\n' + lines.slice(end + 2).join('\n'));
    }
    if (ok) regions++; else { unstripped = true; out.push(...lines.slice(i + 1, end)); }
    out.push(lines[end]);
    // V05: account for the body+delimiter lines' length BEFORE jumping `i` — offset must reflect their real
    // span in `text` even though the outer loop never visits them as their own iteration.
    for (let k = i + 1; k <= end; k++) offset += lines[k].length + 1;
    i = end;
  }
  return { text: out.join('\n'), regions, unstripped };
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

/** literalDataSpans(segs) -> the quoted-literal spans that are pure data (rule b, with L1 and L3). */
function literalDataSpans(segs) {
  const head = (seg) => (seg.words[0] && !seg.words[0].spans.length ? seg.words[0].raw.toLowerCase() : '');
  for (let k = 1; k < segs.length; k++) {
    const h = head(segs[k]).split(/[\\/]/).pop().replace(/\.exe$/, '');
    if (segs[k - 1].sepAfter === '|' && (INTERPRETER_RE.test(h) || h === '.')) return [];
  }
  const spans = [];
  segs.forEach((seg, k) => {
    const ws = seg.words;
    const h = head(seg);
    if (!h || seg.sepAfter === '|') return;
    const later = segs.slice(k + 1).map((z) => z.words.map((x) => x.raw).join(' ')).join('\n');
    if (later && laterRisk(later)) return;
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

/** stripInertData(command, shell) -> { text, regions }. Never throws: on any internal error nothing is stripped. */
function stripInertData(command, shell) {
  try {
    let text = String(command).replace(/\r\n/g, '\n');
    let regions = 0;
    let heredocLeft = false;
    if (shell !== 'PowerShell') { const h = stripHeredocs(text); text = h.text; regions += h.regions; heredocLeft = h.unstripped; }
    if (!heredocLeft && !regions) {
      const segs = scanWords(text, shell);
      const spans = segs ? literalDataSpans(segs) : [];
      const seen = new Set();
      for (const sp of spans.sort((a, b) => b.start - a.start)) {
        if (seen.has(sp.start)) continue;
        seen.add(sp.start);
        text = text.slice(0, sp.start) + "''" + text.slice(sp.end);
        regions++;
      }
    }
    return { text, regions };
  } catch {
    return { text: String(command), regions: 0 };
  }
}

module.exports = { stripInertData, stripHeredocs, scanWords, literalDataSpans, laterRisk, quoteMask, gitSubcommand, INTERPRETER_RE, LAYOUT, SEARCH };
