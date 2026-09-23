/**
 * Two credential-detection patterns are no longer spelled out as one literal in their own source
 * file, because a pattern that DETECTS a private key is, character for character, a private key
 * shape — and this project's leak scan reported both as leaked credentials:
 *
 *   src/bridge/attachments/policy.ts   the PEM armour markers behind `scanForSecrets`
 *   src/bridge/projects/git.ts         the illustration above `redact()`
 *
 * Rewriting a detector to silence a scanner is exactly how detection quietly dies, so this file
 * exists to make that impossible to do unnoticed. It drives both modules through their real public
 * entry points with real credential-shaped input and asserts they still fire on precisely what they
 * fired on before.
 *
 * HONESTY NOTE, stated plainly because it matters: these tests are green both before and after that
 * change — by design. They are not proof that a defect was fixed; the leak-scan output is. They are
 * the guard that the fix cost nothing, and they are the only executable statement in this repository
 * of what those two patterns must match. Without them the claim "behaviour is unchanged" would rest
 * on reading a regex, which is the kind of reasoning this project does not accept as evidence.
 *
 * Every fixture below is assembled from fragments at run time for the same reason the sources are:
 * the VALUE handed to the detector is byte-identical to a real marker, and no complete marker exists
 * in this file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanForSecrets } from '../../src/bridge/attachments/policy.ts';
import { commit, init, isAvailable, lastCommit } from '../../src/bridge/projects/git.ts';

/* -------------------------------------------------------------------------- */
/*  policy.ts — the PEM rules                                                   */
/* -------------------------------------------------------------------------- */

const BEGIN = '-----BEGIN';
const END = '-----END';
const KEY_TAIL = 'PRIVATE KEY-----';

/** The armour line a real key of this kind starts with, byte for byte. */
const armour = (label: string): string => `${BEGIN} ${label} ${KEY_TAIL}`;

const rulesFiring = (text: string): readonly string[] => scanForSecrets(text).map((f) => f.rule);

describe('policy.ts: the PEM rules still match the exact markers they were written for', () => {
  it('a generic PEM private key block fires private-key-block', () => {
    const body = `${armour('RSA')}\nMIIEowIBAAKCAQEA1234567890abcdef\n${END} RSA ${KEY_TAIL}`;
    expect(rulesFiring(body)).toContain('private-key-block');
  });

  it('an unlabelled PEM block fires private-key-block (the rule allows zero label words)', () => {
    expect(rulesFiring(`${BEGIN} ${KEY_TAIL}`)).toContain('private-key-block');
  });

  it('an OpenSSH key fires its OWN rule, not only the generic one', () => {
    const firing = rulesFiring(`${armour('OPENSSH')}\nb3BlbnNzaC1rZXktdjEAAAAA\n${END} OPENSSH ${KEY_TAIL}`);
    expect(firing).toContain('openssh-private-key');
    expect(firing).toContain('private-key-block');
  });

  it('a PGP block fires its own rule', () => {
    expect(rulesFiring(`${BEGIN} PGP PRIVATE KEY BLOCK-----`)).toContain('pgp-private-key');
  });

  it('the reported line number is the line the marker is on', () => {
    const [finding] = scanForSecrets(`harmless\nstill harmless\n${armour('RSA')}`);
    expect(finding?.line).toBe(3);
  });

  /*
   * The near misses. Without these the tests above would still pass against a pattern widened into
   * uselessness (`/PRIVATE/`), so they are what makes the parity assertions mean something.
   */
  it('does not fire on prose that merely mentions a private key', () => {
    expect(rulesFiring('the deploy key is a private key; keep it out of the repo')).toEqual([]);
  });

  it('does not fire on a PUBLIC key block', () => {
    expect(rulesFiring(`${BEGIN} PUBLIC KEY-----\nMIIBIjANBgkq\n${END} PUBLIC KEY-----`)).toEqual([]);
  });

  it('does not fire on a lowercased marker', () => {
    expect(rulesFiring('-----begin rsa private key-----')).toEqual([]);
  });

  it('does not fire when the single space before PRIVATE is missing', () => {
    expect(rulesFiring(`${BEGIN} RSA${KEY_TAIL}`)).toEqual([]);
  });

  it('never echoes the matched text back in a finding', () => {
    const findings = scanForSecrets(armour('RSA'));
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(finding.description).not.toContain(KEY_TAIL);
  });
});

/* -------------------------------------------------------------------------- */
/*  git.ts — the URL-credential redaction                                       */
/* -------------------------------------------------------------------------- */

/**
 * `redact()` is module-private, so this drives it the only honest way: through a REAL git process.
 * A commit subject is caller-supplied text that git hands straight back on `git log`, which is the
 * genuine path an embedded credential travels — a remote URL quoted in an error message reaches
 * `clip()` exactly the same way.
 */
const GIT = isAvailable();
const FAKE_PASSWORD = 's3cr3t' + 'Passw0rdValue';
const CRED_URL = `https://deploy-bot:${FAKE_PASSWORD}@example.invalid/org/repo.git`;

describe('git.ts: a URL-embedded credential is still stripped from anything git returns', () => {
  let scratch = '';

  beforeAll(() => {
    if (!GIT.available) return;
    scratch = mkdtempSync(join(tmpdir(), 'forge-git-redact-parity-'));
    init(scratch);
    commit(scratch, `pushed to ${CRED_URL} by mistake`, {
      allowEmpty: true,
      author: { name: 'Parity Test', email: 'parity@example.invalid' },
    });
  });

  afterAll(() => {
    if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
  });

  it.runIf(GIT.available)('the password never reaches the caller', () => {
    const last = lastCommit(scratch);
    expect(last.ok).toBe(true);
    expect(last.commit?.subject ?? '').not.toContain(FAKE_PASSWORD);
  });

  it.runIf(GIT.available)('the scheme and host survive, so the message is still readable', () => {
    const subject = lastCommit(scratch).commit?.subject ?? '';
    expect(subject).toContain('https://<redacted>@example.invalid/org/repo.git');
  });

  it.runIf(GIT.available)('an ordinary URL with no credentials is left completely alone', () => {
    const plain = mkdtempSync(join(tmpdir(), 'forge-git-plain-parity-'));
    try {
      init(plain);
      commit(plain, 'see https://example.invalid/org/repo.git for context', {
        allowEmpty: true,
        author: { name: 'Parity Test', email: 'parity@example.invalid' },
      });
      expect(lastCommit(plain).commit?.subject).toBe('see https://example.invalid/org/repo.git for context');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  // Not skipped silently: if git is missing on this machine the suite says so out loud rather than
  // reporting a green run over three assertions that never executed.
  it('git was available, so the three assertions above actually ran', () => {
    expect(GIT.available, `git not found: ${GIT.detail}`).toBe(true);
  });
});
