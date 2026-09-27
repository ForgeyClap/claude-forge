#!/usr/bin/env node
'use strict';
/**
 * forge-env-names.cjs — WP-K1 (2026-09-27, independent Codex review of the v2.9.0 integration, finding F1).
 * secret-print's grep-family `-o`/`--only-matching` exemption used to let `grep -o 'DATABASE_URL=.*' .env`
 * through as "the safe variant" while it still printed the matched VALUE, not just the name — the exemption
 * was unsound and has been removed entirely (see hard-gates.json's secret-print gate _pattern_doc). This
 * script is the sanctioned replacement Forge now points to: it prints ONLY the variable NAMES of a
 * dotenv-style file, one per line, and NEVER a value — even on a malformed line. Zero dependencies (fs only).
 *
 * The command line `node .claude/forge-bin/forge-env-names.cjs <file>` does not itself contain any of
 * secret-print's reader/search verbs (cat/type/Get-Content/grep/…), so it never trips that gate either —
 * proven in forge-gate-secretprint.test.cjs and this file's own forge-env-names.test.cjs.
 *
 * FORMAT: one `KEY=value` (or `export KEY=value`) per line; a `#`-led line (after optional leading
 * whitespace) or a blank line is a comment. KEY must be a normal shell identifier (`[A-Za-z_][A-Za-z0-9_]*`).
 * A line that does not have this shape — no `=`, or a key that is not a valid identifier — is skipped
 * ENTIRELY rather than partially printed, so a corrupted or value-only line can never leak a fragment of its
 * own text. The value side of a matching line is never read past the point needed to find the `=`.
 *
 * CLI: node forge-env-names.cjs <file> [--json]
 * Exit codes: 0 = printed (possibly zero names) · 2 = usage error, or the file is missing/unreadable — the
 * failure is reported honestly on stderr, never a raw stack trace.
 */
const fs = require('fs');

/** LINE_RE — matches `[export ]KEY=` at the very start of an (already left-trimmed) line. Anchored with `^`
 *  so a line whose key portion is not a clean identifier (`KEY-WITH-DASH=value`, `123KEY=value`, `=value`)
 *  never matches at all, rather than matching some other substring of the line. */
const LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** envNames(text) -> string[] — the variable NAMES only, in file order, duplicates kept (mirrors what a
 *  simple line-oriented name extractor would list). Never returns, logs, or inspects anything that follows
 *  the `=` on any line — including a value that SPANS MULTIPLE LINES inside a quoted string (WP-M1,
 *  2026-09-27, independent review R5). A naive per-physical-line scan let a CONTINUATION line of a multi-line
 *  quoted value be re-read as if it were its own fresh `KEY=` entry: for
 *      PRIVATE_KEY="-----BEGIN KEY-----
 *      abc
 *      Kx9Qp3==
 *      -----END KEY-----"
 *  the third physical line `Kx9Qp3==` matches LINE_RE just like a normal entry (a valid identifier immediately
 *  followed by `=`) and used to be printed as a second, fabricated "name" that is really a FRAGMENT of the
 *  secret value. Fixed by tracking ONE open quote character (`"` or `'`) across lines: once a matched `KEY=`
 *  line's own value opens a quote it does not also close on that same physical line, every following line is
 *  read ONLY to ask "does this line contain the closing quote", never as a candidate new entry, until that
 *  quote closes. An unterminated quote (never closes before EOF) fails the same direction this project's other
 *  quote-aware scanners already do (forge-gate-quotes.cjs's own header: "any doubt -> stay stricter") — nothing
 *  is ever printed again after the key name that opened it, for the rest of the file, rather than guessing
 *  where an unresolvable value really ends. Pure, never throws. */
function envNames(text) {
  const names = [];
  let openQuote = null; // the unterminated quote CHARACTER carried over from a previous line, or null
  for (const rawLine of String(text).split(/\r\n|\n|\r/)) {
    if (openQuote) {
      if (rawLine.includes(openQuote)) openQuote = null; // this line closes it; nothing on it is ever printed
      continue; // a continuation line is never a candidate KEY= entry, whether it closes the quote or not
    }
    const line = rawLine.trimStart();
    if (!line || line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    names.push(m[1]);
    const value = line.slice(m[0].length).trimStart();
    const q = value[0];
    if ((q === '"' || q === "'") && !value.slice(1).includes(q)) openQuote = q; // opened, not closed on this line
  }
  return names;
}

function printUsage() {
  console.error('Usage: node forge-env-names.cjs <file> [--json]');
  console.error('Prints ONLY the variable NAMES of a dotenv-style file, one per line — never the values.');
}

/** run(argv) -> exit code. Never throws — a missing/unreadable file is reported once on stderr, honestly,
 *  and returns a non-zero code instead of letting a raw stack trace leak file-system detail. */
function run(argv) {
  const positional = [];
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else positional.push(a);
  }
  if (positional.length !== 1) { printUsage(); return 2; }
  const file = positional[0];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error('forge-env-names: cannot read ' + file + ' (' + (e && (e.code || e.message) || 'unknown error') + ')');
    return 2;
  }
  const names = envNames(text);
  if (json) console.log(JSON.stringify(names));
  else for (const n of names) console.log(n);
  return 0;
}

module.exports = { envNames, run, LINE_RE };

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
