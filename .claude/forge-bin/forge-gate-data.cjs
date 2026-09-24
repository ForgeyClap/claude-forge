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
 *      head line free of quotes, `$(`, backticks and `#` before the writer, redirects to plain paths only, no
 *      script-file destination (.sh .ps1 .cmd .bat .js .cjs .mjs .ts .py …). An UNQUOTED delimiter qualifies
 *      only when the body has no `$(`, backtick or `${`. Also the Claude Code commit form
 *      `git commit -m "$(cat <<'EOF'` whose substitution is closed by `)"` on the line after the delimiter.
 *  (b) QUOTED LITERALS — single-quoted always, double-quoted only without `$` — given to echo / printf, to
 *      `git commit -m|-am|--message`, to the project's own .claude/forge-dashboard/log-event.cjs, and (review
 *      L3) to the search tools grep / rg / egrep / fgrep / ag / Select-String / sls / findstr / `git grep` /
 *      `git log --grep`: a search tool never executes its pattern. Only when that segment is not piped (into
 *      anything) and no segment of the command is a pipe into an interpreter.
 *  L1 (review wp9a): a region is never stripped when ANY interpreter (bash sh zsh node python* pwsh powershell
 *      cmd eval source `.` iex xargs chmod …) or layout/rename command (mv ln mklink cp rename Move-Item
 *      Copy-Item …) appears anywhere LATER in the same command — write-then-run (`… > x.txt; mv x.txt x.sh;
 *      bash x.sh`, `… | sh`) must stay classified.
 *
 * API: stripInertData(command, shell) -> { text, regions } · stripHeredocs(text) · scanWords(s, shell) ·
 *      literalDataSpans(segs) · laterRisk(text). `shell` is the tool name: 'Bash' or 'PowerShell'.
 */
const INTERPRETER_RE = /^(bash|sh|zsh|dash|ksh|fish|node|nodejs|deno|bun|python\d*(\.\d+)?|py|perl|ruby|php|pwsh|powershell|cmd|eval|source|iex|invoke-expression|xargs|chmod|env|exec|command|builtin)$/;
const LAYOUT = new Set(['mv', 'move', 'move-item', 'mi', 'ln', 'mklink', 'cp', 'copy', 'copy-item', 'cpi', 'rename', 'ren',
  'rename-item', 'rni', 'robocopy', 'xcopy', 'new-item', 'ni']);
const SEARCH = new Set(['grep', 'rg', 'egrep', 'fgrep', 'ag', 'select-string', 'sls', 'findstr']);
const SCRIPT_EXT_RE = /\.(sh|bash|zsh|ps1|psm1|cmd|bat|js|cjs|mjs|ts|py|rb|pl|php)$/i;
const MARKER_RE = /(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_]\w*))/g;
const WRITER_HEAD_RE = /^(?:[^'"`$()#\n]*?(?:&&|\|\||;)\s*)?(cat|tee|printf|echo)\b([\w\s.\-/\\:=+>@,]*?)(?<!<)<<(?!<)-?\s*(?:'[^'\n]+'|"[^"\n]+"|[A-Za-z_]\w*)((?:\s*\d?>>?\s*[\w.\-/\\:@+]+)*)\s*$/;
const COMMIT_HEAD_RE = /^\s*git\s+(?:[^'"`$()|;&#\n]*\s)?commit\b[^'"`$()|;&#\n]*\s(?:-m|-am|--message)\s+"\$\(cat\s+<<-?\s*'[^'\n]+'\s*$/;
const LOG_EVENT_RE = /(^|[\\/])\.claude[\\/]forge-dashboard[\\/]log-event\.cjs$/;

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

function writerDests(consumer, between, tail) {
  const dests = [];
  const re = /\d?>>?\s*([^\s>]+)/g;
  let m;
  for (const part of [between, tail]) { re.lastIndex = 0; while ((m = re.exec(part)) !== null) dests.push(m[1]); }
  if (consumer === 'tee') {
    for (const w of between.replace(/\d?>>?\s*[^\s>]+/g, ' ').trim().split(/\s+/)) if (w && !w.startsWith('-')) dests.push(w);
  }
  return dests;
}

/** stripHeredocs(text) -> { text, regions, unstripped }. Two markers on one line or an unterminated heredoc strip
 *  nothing; a heredoc that fails the rule is kept verbatim and skipped whole (an executed body is never re-read). */
function stripHeredocs(text) {
  const lines = text.split('\n');
  const out = [];
  let regions = 0;
  let unstripped = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const markers = [...line.matchAll(MARKER_RE)];
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
    i = end;
  }
  return { text: out.join('\n'), regions, unstripped };
}

/** scanWords(s, shell) -> [{words:[{start,end,raw,spans}], sepAfter}] | null — refuses what it cannot read exactly:
 *  `$(`, backticks, parentheses, word-initial `#`, `<<`, unclosed quotes; PowerShell also lone `&`, `@'`/`@"`. */
function scanWords(s, shell) {
  const bash = shell !== 'PowerShell';
  if (/\$\(|`|<</.test(s) || (!bash && /@['"]|(^|[^&])&(?!&)/.test(s))) return null;
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
      const has = (word) => ws.some((x) => x.raw === word);
      if (has('commit')) ws.forEach((x, n) => { if (/^(-m|-am|--message)$/.test(x.raw) && wholeInert(ws[n + 1])) picked.push(ws[n + 1]); });
      if (has('grep')) picked.push(...ws.slice(1).filter(wholeInert));
      if (has('log')) {
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

module.exports = { stripInertData, stripHeredocs, scanWords, literalDataSpans, laterRisk, INTERPRETER_RE, LAYOUT, SEARCH };
