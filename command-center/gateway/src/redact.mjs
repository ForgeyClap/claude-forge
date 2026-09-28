// Runtime secret-redaction filter (WP10 should-fix-now #12). Promotes the SECRET_PATTERNS
// TEST-time constant (test/routes-wp6.test.mjs's "SECRET BOUNDARY" scan) into an actual runtime
// guard applied at write AND read boundaries, rather than relying only on "the data happens to be
// clean" (WP10 threat model, Secrets-audit: "the current beauty rests on data that happens to be
// clean, not on a control"). Five real credential shapes: the four the existing test already
// checks (NVIDIA, generic sk- style, GitHub PAT, AWS access key id) plus a PEM private-key block —
// a stray credential accidentally logged/echoed by a spawned child is the realistic path here
// (D.2/D.3 in the threat model), never a deliberately-stored secret (repo hygiene is already
// correct per that same audit).
//
// This is a cheap regex replace, not a report — it never throws, never logs what it redacted, and
// is safe to call on every turn/event/error message without measurable overhead.

// Shared with discord-service.mjs's own isValidBotTokenFormat() (the FORMAT validator on the token's
// way IN) — Codex finding K3-4 wants "one shared definition" rather than two independently
// maintained near-duplicates that can silently drift apart, which is exactly what had already
// happened here. One source string, two RegExp objects built from it: this file's own pattern below
// prefixes it with a lone `\b` for a free-text scan; discord-service.mjs anchors both ends (`^...$`)
// to validate a single, whole, standalone value.
export const DISCORD_BOT_TOKEN_CORE_SOURCE = '[A-Za-z0-9_-]{10,70}\\.[A-Za-z0-9_-]{3,20}\\.[A-Za-z0-9_-]{10,70}';

const SECRET_PATTERNS = [
  { name: 'NVIDIA_API_KEY', re: /nvapi-[A-Za-z0-9_-]{10,}/g },
  { name: 'GENERIC_SK_KEY', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'GITHUB_PAT', re: /\bghp_[A-Za-z0-9]{10,}/g },
  { name: 'AWS_ACCESS_KEY_ID', re: /\bAKIA[A-Z0-9]{10,}/g },
  // Body UPPER-BOUNDED at 8192 chars, mirroring `.claude/forge-bin/forge-store.cjs`'s own PEM pattern
  // and for the same reason. The unbounded lazy `[\s\S]*?` rescans to end-of-input for EVERY unmatched
  // `-----BEGIN ... PRIVATE KEY-----` marker, which is O(n^2) in the number of markers. That was
  // survivable while this pattern only ever saw a pre-cut 4000-char field; redactAndCap() below now
  // (correctly) runs it on the FULL, uncapped value, so the quadratic path became reachable from real
  // child output. Measured on this machine: 1 MB of unterminated BEGIN markers took 814 ms unbounded
  // and 3.6 ms bounded. 8 KB covers every real key (RSA-8192 PEM is ~6.5 KB), so no genuine key stops
  // matching — see test/redact-cap-order.test.mjs.
  { name: 'PEM_PRIVATE_KEY', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  // WP-v290-B (beginner Discord onboarding): three dot-separated base64url-ish parts — the real
  // shape of a Discord bot token (see discord-service.mjs's own isValidBotTokenFormat() for the
  // same shape used to VALIDATE one on the way in; this is the matching shape to catch one on the
  // way OUT, e.g. echoed into an uncaught-exception message from the spawned bot child).
  //
  // Codex finding K3-4: this pattern used to require 20/4/20-char segments while the validator
  // accepted 10/3/10 — a real gap where a token the validator happily accepted on the way in was
  // NOT recognised by this pattern on the way out. Both now build from ONE shared source string,
  // `DISCORD_BOT_TOKEN_CORE_SOURCE` below, so the two can never drift apart again.
  //
  // A leading `\b` only — deliberately NO trailing `\b`, matching every other pattern above
  // (GENERIC_SK_KEY/GITHUB_PAT/AWS_ACCESS_KEY_ID anchor only their distinctive prefix, never their
  // end). Found live while writing this pattern's own straddle-coverage test: a trailing `\b`
  // requires a word/non-word transition right after the match — if the leaked token is
  // immediately abutted by more word characters with no separator (e.g. inside a longer log line
  // with no whitespace before the next word), that transition never happens and the WHOLE pattern
  // silently fails to match at all, even on the clean, uncapped value. Dropping it costs nothing:
  // the character-class upper bounds already stop the match from running away past a real token's
  // length.
  { name: 'DISCORD_BOT_TOKEN', re: new RegExp('\\b' + DISCORD_BOT_TOKEN_CORE_SOURCE, 'g') },
];

// Redacts every recognized secret shape inside a string. Non-strings pass through unchanged (the
// callers here always guard the type themselves too — this is belt-and-suspenders, never a place
// that could itself throw on unexpected input).
export function redact(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern.re, '[REDACTED:' + pattern.name + ']');
  }
  return out;
}

// Same as redact(), but passes null/undefined through untouched — the common shape for optional
// fields (e.g. a turn's `stderr`, which is `null` when the child produced none).
export function redactNullable(value) {
  return value == null ? value : redact(value);
}

// Structure-preserving deep redaction (WP8-13 gap-closing round, forge-2026-07-27-cc-wp8-13): a
// shallow, single-field redact() is not enough for data an agent/child process can shape freely
// (an events.jsonl record, a parsed stream-json line) — a credential could land anywhere: a
// top-level string, nested inside an object (e.g. `evidence`/`note`), or inside an array. This
// walks the WHOLE value and redacts every string it finds while preserving the exact shape:
// object keys, array order/length, and every non-string type (number/boolean/null/undefined) are
// left completely untouched — nothing is ever dropped or coerced. Safe on any JSON.parse() output
// (no cycles are possible there), so no depth/visited-set guard is needed.
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = redactDeep(v);
    return out;
  }
  return value; // numbers, booleans, null, undefined pass through unchanged
}

// THE ONE WAY TO BOUND A FREE-TEXT FIELD (fix-cap-order). Redacts on the FULL value, THEN caps.
//
// Doing it the other way round silently breaks every pattern that needs a trailing anchor to match:
// PEM_PRIVATE_KEY only fires once its `-----END ... PRIVATE KEY-----` is present, so cutting first
// removes the anchor, the pattern stops matching, and the readable HEAD of the key survives into the
// stored record and into the DOM. Measured live: a real Write tool_use of a 5462-char PEM produced
// 4000 chars of raw key material with `diff_state:"present"` and no `[REDACTED:` marker anywhere.
//
// This project has now hit that exact fault TWICE — `.claude/forge-bin/forge-toolhook.cjs` cut at 1000
// chars and redacted afterwards while its own header promised the opposite. A comment is evidently not
// enough, so the order lives HERE, in one function next to the patterns it protects, and every capped
// field calls it. A future developer cannot reverse the order by editing a call site, because no call
// site performs the cut: reversing it now requires editing this function, in this file, directly under
// this paragraph. `capString`-style helpers that only slice are deliberately gone from the parser.
//
// Cost: the scan now runs on the whole value instead of the first `maxLen` chars. Measured on this
// machine, 5.2 MB of ordinary source costs 1.95 ms per call — the tool_use blocks this bounds are
// kilobytes, so the real per-call cost is microseconds. The one input class that was genuinely
// expensive (repeated unterminated PEM markers) is handled by the bounded PEM body above, not by
// cutting first.
//
// Non-strings return null — the same honest "there was no string here" value the parser's callers
// already relied on, never a coerced empty string.
export function redactAndCap(value, maxLen) {
  if (typeof value !== 'string') return null;
  const redacted = redact(value);
  return redacted.length > maxLen ? redacted.slice(0, maxLen) : redacted;
}

// Discord ids ("snowflakes", 17 to 20 digits today) are not secrets, so redact() leaves them alone, but
// the routes that promise never to hand out a Discord identifier must not pass one on inside an error
// text either, e.g. "Unknown Channel 123456789012345678" (Codex run B F-10). Any run of 17 or more digits
// is replaced; call this BEFORE any length cap, so a cut can never leave a shortened id behind.
const LONG_DIGIT_RUN_RE = /\d{17,}/g;
export function stripDiscordIds(value) {
  return typeof value === 'string' ? value.replace(LONG_DIGIT_RUN_RE, '[discord id]') : value;
}

// ── STREAM-AWARE REDACTION (Codex finding K3-4) ─────────────────────────────────────────────────
//
// redact()/redactAndCap() above assume the WHOLE value is already in memory. A live child process's
// stdout/stderr instead arrives as a series of arbitrarily-sized `data` chunks — discord-service.mjs
// used to call `redact(chunk)` per chunk, so a secret whose bytes happened to straddle two chunks
// (e.g. the first half of a Discord bot token at the very end of one chunk, the rest at the start of
// the next) was never recognised by either call alone and reached the log file in the clear.
//
// The fix holds back a bounded RAW tail (`STREAM_REDACT_TAIL_CHARS`) after every write instead of
// flushing immediately: only text older than that tail is ever redacted-and-emitted, and a match
// found anywhere in the accumulated (carry + new text) buffer is redacted using its REAL position in
// the raw text (never a naive slice-then-redact, which would corrupt a match that spans the cut
// point). The next chunk's data is prepended to whatever was held back, giving a split token another
// chance to complete and match before anything reaches the sink. `end()` flushes whatever remains
// (fully redacted) once the stream is known to be finished — a still-incomplete trailing fragment at
// that point can never complete anyway.
//
// 256 chars comfortably covers the longest possible DISCORD_BOT_TOKEN match (70+1+20+1+70 = 162
// chars) with margin — the concrete secret shape this finding named — while keeping log latency to a
// couple hundred bytes at most. It does NOT change the pre-existing, documented limitation that the
// four unbounded prefix patterns (NVIDIA/sk-/ghp_/AKIA) and the 8192-char-bounded PEM pattern were
// never guaranteed against an adversarially-placed split at an arbitrary offset — that bound is about
// a single already-complete value, not about chunk boundaries, and is unchanged by this fix.
const STREAM_REDACT_TAIL_CHARS = 256;

function findSecretSpans(str) {
  const spans = [];
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.re.source, 'g');
    let m;
    while ((m = re.exec(str)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, name: pattern.name });
      if (m[0].length === 0) re.lastIndex += 1; // never used by these patterns, kept for safety only
    }
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function redactSpans(str, spans) {
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += str.slice(cursor, span.start) + '[REDACTED:' + span.name + ']';
    cursor = span.end;
  }
  return out + str.slice(cursor);
}

/**
 * createStreamRedactor(writeFn) -> { write(chunk), end() }
 *
 * `writeFn(text)` is called with already-redacted text whenever there is a safe amount to flush —
 * never with raw, unredacted text. `write()` accepts a string or a Buffer-like value (anything
 * `String()` can turn into text, matching how child.stdout/stderr chunks already reach the existing
 * `.on('data', ...)` handlers). `end()` flushes any remaining held-back tail (fully redacted) and
 * must be called once when the underlying stream is known to be finished (child exit/error) — never
 * mid-stream, or a still-forming secret could be flushed as an incomplete, unredacted fragment.
 */
export function createStreamRedactor(writeFn) {
  let carry = '';
  return {
    write(chunk) {
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      if (text.length === 0) return;
      const combined = carry + text;
      let boundary = Math.max(0, combined.length - STREAM_REDACT_TAIL_CHARS);
      const spans = findSecretSpans(combined);
      // Never cut a boundary inside a real match — pull it back to before that match starts so the
      // whole thing stays held back together for a future write() (or the final end()) instead of a
      // credential being split right at the hold-back line.
      for (const span of spans) {
        if (span.start < boundary && span.end > boundary) boundary = span.start;
      }
      if (boundary <= 0) {
        carry = combined;
        return;
      }
      const emitSpans = spans.filter((s) => s.end <= boundary);
      const out = redactSpans(combined.slice(0, boundary), emitSpans);
      carry = combined.slice(boundary);
      if (out.length > 0) writeFn(out);
    },
    end() {
      if (carry.length === 0) return;
      const out = redact(carry);
      carry = '';
      writeFn(out);
    },
  };
}

// Test-only export so a unit test can assert the exact pattern set without duplicating the regex
// literals (and drifting from them) in the test file.
export function _secretPatternNamesForTests() {
  return SECRET_PATTERNS.map((p) => p.name);
}
