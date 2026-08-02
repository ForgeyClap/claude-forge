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

// Test-only export so a unit test can assert the exact pattern set without duplicating the regex
// literals (and drifting from them) in the test file.
export function _secretPatternNamesForTests() {
  return SECRET_PATTERNS.map((p) => p.name);
}
