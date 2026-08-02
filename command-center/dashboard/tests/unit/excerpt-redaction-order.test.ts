/**
 * A secret must be redacted from the WHOLE value, then capped — never cut first.
 *
 * Found by a witness audit on 2026-08-01. The gateway side of this project had already been fixed at 19
 * call sites (redactAndCap: redact-then-cap), but two dashboard-bridge call sites still handed
 * safeExcerpt() a PRE-SLICED string. safeExcerpt itself is correct — it redacts before it caps — so the
 * defect lives entirely in the caller: slicing first can cut a token in half, and half a JWT matches no
 * pattern, so it is emitted verbatim into the event stream.
 *
 * The tests below pin the property, not the implementation: given a value whose secret straddles the
 * excerpt boundary, the emitted excerpt must not contain any recognisable fragment of it.
 */
import { describe, expect, it } from 'vitest';

import { safeExcerpt } from '../../src/bridge/claude/parse.ts';

/** A JWT-shaped token. Not a real credential — it is three base64url segments, which is what the
 *  detector keys on. */
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkZvcmdlIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('excerpt redaction order', () => {
  it('redacts a secret that sits well inside the cap (the easy case that already worked)', () => {
    const out = safeExcerpt(`starting up: token=${JWT} ok`, 500);
    expect(out).not.toContain(JWT.slice(0, 40));
    expect(out).toContain('[REDACTED');
  });

  // The detector anchors on \b, so filler must not be GLUED to the secret: 'xxxeyJ...' has no word
  // boundary and would never match even in the fixed version. A first draft of this file made exactly
  // that mistake and "proved" the fix while testing nothing. The separator below is what a real log
  // line looks like anyway.
  const straddling = `${'x'.repeat(460)} token=${JWT}${'y'.repeat(200)}`; // secret spans index 500

  it('THE DEFECT: pre-slicing to the cap length cuts the token and defeats the detector', () => {
    const preSliced = safeExcerpt(straddling.slice(0, 500), 500); // what the call site used to do
    expect(preSliced).toContain(JWT.slice(0, 30));                // a live fragment survives — the leak
    expect(preSliced).not.toContain('[REDACTED');
  });

  it('THE FIX: handing the full value to safeExcerpt redacts it before the cap is applied', () => {
    const whole = safeExcerpt(straddling, 500); // what the call site does now
    expect(whole).not.toContain(JWT.slice(0, 30));
    expect(whole).toContain('[REDACTED');
    expect(whole.length).toBeLessThanOrEqual(500 + 32); // still capped (plus the "…(N chars)" suffix)
  });

  it('WHY THIS HID: a prefix-anchored shape (Bearer) survives truncation, so it never showed the bug', () => {
    // Only patterns that need a TRAILING anchor are defeated by cutting: a JWT needs its third segment,
    // a PEM needs its END marker. `Bearer <12+ chars>` has no closing anchor, so a truncated token still
    // matches and is still redacted. A test written with Bearer alone would have been green throughout —
    // which is exactly how a cap-before-redact defect stays invisible.
    const line = `${'x'.repeat(960)} Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789${'y'.repeat(50)}`;
    expect(safeExcerpt(line.slice(0, 1000), 1000)).toContain('[REDACTED');
    expect(safeExcerpt(line, 1000)).toContain('[REDACTED');
    expect(safeExcerpt(line, 1000)).not.toContain('abcdefghijklmnop');
  });
});
