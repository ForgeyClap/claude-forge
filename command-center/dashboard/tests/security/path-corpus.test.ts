/**
 * Forge Workspace — the adversarial path corpus, driven through the REAL guard.
 *
 * `src/bridge/security/paths.test-vectors.ts` is data with no imports. This file
 * is the runner. Every one of its vectors is pushed through the actual exported
 * functions in `src/bridge/security/paths.ts` — no re-implementation, no
 * paraphrase of the rule, no mock. If the guard changes, this suite changes its
 * answer, which is the only reason a corpus like this is worth having.
 *
 * THREE RULES THIS RUNNER HOLDS
 *
 * 1. EVERY VECTOR IS ACCOUNTED FOR. A vector is either EXECUTED or SKIPPED, and
 *    the final tests in this file assert that the two sets together cover
 *    `VECTOR_COUNTS.total`. A merge that drops half the corpus makes this suite
 *    fail rather than quietly get faster.
 *
 * 2. A SKIP IS LOUD. `LINK_VECTORS` need a real filesystem and, for directory
 *    SYMLINKS on Windows, Developer Mode or elevation. When the link cannot be
 *    created, or the vector's platform is not the host's, the test SKIPS with the
 *    reason printed to the console and recorded in the skip ledger. It is never
 *    reported as a pass. A green security test that never ran is worse than a red
 *    one, because a red one gets read.
 *
 * 3. REJECT ROWS ASSERT THE CODE, NOT JUST THE THROW. `PATH_REJECTED` means
 *    "malformed or hostile on its face"; `OUTSIDE_TRUSTED_ROOT` means
 *    "well-formed and pointing somewhere it may not reach". Those are different
 *    facts, the UI says different things about them, and a guard that started
 *    conflating them would still satisfy a bare `toThrow()`. So the expected code
 *    for every containment reject row is written down here explicitly.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  PathGuardError,
  assertInsideRoot,
  detectCollision,
  exceedsWindowsMaxPath,
  inspectSlug,
  isPathGuardError,
  isSensitivePath,
  sanitizeSlug,
} from '@/bridge/security/paths';
import type { PathErrorCode } from '@/bridge/security/paths';
import {
  ALL_VECTORS,
  COLLISION_VECTORS,
  CONTAINMENT_VECTORS,
  LINK_VECTORS,
  SENSITIVE_VECTORS,
  SLUG_VECTORS,
  VECTOR_COUNTS,
} from '@/bridge/security/paths.test-vectors';
import type { LinkVector } from '@/bridge/security/paths.test-vectors';

/**
 * C0 and C1 control characters. Built from a string so the source file itself
 * stays plain ASCII — a test file with a raw NUL in it is a file that greps,
 * diffs and code review all handle badly.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]');

/* ========================================================================== */
/*  Coverage ledger                                                            */
/* ========================================================================== */

const executed = new Set<string>();
const skipped = new Map<string, string>();

function markExecuted(id: string): void {
  executed.add(id);
}

/** Records the skip AND prints it, so it cannot pass for a silent success. */
function noteSkip(id: string, reason: string): string {
  skipped.set(id, reason);
  console.warn(`[security] SKIPPED ${id} — ${reason}`);
  return reason;
}

afterAll(() => {
  if (skipped.size === 0) return;
  console.warn(
    `\n[security] ${String(skipped.size)} of ${String(VECTOR_COUNTS.total)} path vectors were SKIPPED, not passed:\n` +
      [...skipped].map(([id, reason]) => `  - ${id}: ${reason}`).join('\n') +
      '\n',
  );
});

/* ========================================================================== */
/*  Shared helpers                                                             */
/* ========================================================================== */

const HOST_IS_WIN32 = os.platform() === 'win32';

/** The typed error, or a failure that names what came back instead. */
function guardErrorFrom(run: () => unknown, what: string): PathGuardError {
  let thrown: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    threw = true;
    thrown = error;
  }
  if (!threw) {
    throw new Error(`${what}: the guard ACCEPTED an input the corpus says it must reject.`);
  }
  if (!isPathGuardError(thrown)) {
    throw new Error(
      `${what}: the guard threw ${
        thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)
      } instead of a typed PathGuardError. An untyped throw crosses the bridge as RUNTIME_ERROR and tells the UI nothing.`,
    );
  }
  return thrown;
}

/* ========================================================================== */
/*  Corpus integrity                                                           */
/* ========================================================================== */

describe('corpus integrity', () => {
  it('the aggregate really is the sum of the per-kind arrays', () => {
    expect(VECTOR_COUNTS.slug).toBe(SLUG_VECTORS.length);
    expect(VECTOR_COUNTS.containment).toBe(CONTAINMENT_VECTORS.length);
    expect(VECTOR_COUNTS.link).toBe(LINK_VECTORS.length);
    expect(VECTOR_COUNTS.collision).toBe(COLLISION_VECTORS.length);
    expect(VECTOR_COUNTS.sensitive).toBe(SENSITIVE_VECTORS.length);
    expect(ALL_VECTORS.length).toBe(VECTOR_COUNTS.total);
    expect(VECTOR_COUNTS.total).toBe(
      VECTOR_COUNTS.slug +
        VECTOR_COUNTS.containment +
        VECTOR_COUNTS.link +
        VECTOR_COUNTS.collision +
        VECTOR_COUNTS.sensitive,
    );
  });

  it('every vector id is unique, so no row can silently shadow another', () => {
    const ids = ALL_VECTORS.map((v) => v.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it('every vector carries a reason, so a failure explains itself', () => {
    const mute = ALL_VECTORS.filter((v) => typeof v.why !== 'string' || v.why.trim().length === 0);
    expect(mute.map((v) => v.id)).toEqual([]);
  });

  it('the corpus is not trivially "reject everything"', () => {
    const accepts = ALL_VECTORS.filter((v) => v.expect === 'accept').length;
    // A guard that refuses every input passes any reject-only corpus and is
    // useless. Roughly a third of these rows exist to catch over-blocking.
    expect(accepts).toBeGreaterThan(ALL_VECTORS.length / 5);
  });
});

/* ========================================================================== */
/*  Slug vectors                                                               */
/* ========================================================================== */

describe(`slug vectors (${String(VECTOR_COUNTS.slug)})`, () => {
  for (const vector of SLUG_VECTORS) {
    it(`${vector.expect === 'reject' ? 'refuses' : 'accepts'} ${vector.id}`, () => {
      markExecuted(vector.id);

      const inspection = inspectSlug(vector.input);

      if (vector.expect === 'reject') {
        expect(inspection.ok, `${vector.id}: ${vector.why}`).toBe(false);
        // The throwing sibling must agree with the inspecting one, or callers
        // of one get a different security answer than callers of the other.
        const error = guardErrorFrom(() => sanitizeSlug(vector.input), vector.id);
        expect(error).toBeInstanceOf(PathGuardError);
        // A slug is one segment; there is no "outside the root" verdict to reach.
        expect(error.code, `${vector.id} must be PATH_REJECTED, not a containment verdict`).toBe(
          'PATH_REJECTED' satisfies PathErrorCode,
        );
        expect(error.message.length).toBeGreaterThan(0);
        // The rejected input reaches `detail` only through `safeForDetail`, so a
        // hostile name cannot forge a log line on its way into the event store.
        if (error.detail !== undefined) {
          expect(
            CONTROL_CHARACTERS.test(error.detail),
            `${vector.id}: a raw control character survived into the error detail`,
          ).toBe(false);
          expect(error.detail.length).toBeLessThanOrEqual(240);
        }
        return;
      }

      expect(
        inspection.ok,
        `${vector.id} was REFUSED but must be accepted - ${vector.why}${
          inspection.ok ? '' : ` (guard said: ${inspection.reason})`
        }`,
      ).toBe(true);
      if (!inspection.ok) return;

      const slug = sanitizeSlug(vector.input);
      expect(slug).toBe(inspection.slug);

      if (vector.expectedSlug !== undefined) {
        expect(slug, `${vector.id}: ${vector.why}`).toBe(vector.expectedSlug);
      }
      for (const forbidden of vector.forbiddenInSlug ?? []) {
        expect(slug.includes(forbidden), `${vector.id}: "${forbidden}" survived into the slug`).toBe(false);
      }

      // Properties that must hold for EVERY accepted slug, whatever the row says.
      expect(slug.length).toBeGreaterThan(0);
      expect(slug.length).toBeLessThanOrEqual(64);
      expect(/[\\/]/.test(slug), `${vector.id}: an accepted slug may never contain a separator`).toBe(false);
      expect(slug.includes('..'), `${vector.id}: an accepted slug may never contain a dot-dot`).toBe(false);
      expect(slug.includes(':'), `${vector.id}: an accepted slug may never contain a colon`).toBe(false);
      expect(
        slug.startsWith('-'),
        `${vector.id}: a slug starting with "-" becomes a command-line option wherever it is used`,
      ).toBe(false);
      expect(CONTROL_CHARACTERS.test(slug), `${vector.id}: a control character survived into the slug`).toBe(false);
    });
  }
});

/* ========================================================================== */
/*  Containment vectors                                                        */
/* ========================================================================== */

/**
 * The exact code each containment reject row must produce.
 *
 * Written out rather than derived, because the distinction is the point:
 * `OUTSIDE_TRUSTED_ROOT` says the path was well-formed and pointed somewhere it
 * may not reach — that is the louder audit line and a different UI sentence.
 * `PATH_REJECTED` says the input was malformed or hostile before containment was
 * even a question (UNC, the device namespace, a NUL, a reserved device name, an
 * alternate data stream, a relative root).
 */
const CONTAINMENT_REJECT_CODE: Readonly<Record<string, PathErrorCode>> = {
  'contain/prefix/rootEVIL': 'OUTSIDE_TRUSTED_ROOT',
  'contain/prefix/rootEVIL-child': 'OUTSIDE_TRUSTED_ROOT',
  'contain/prefix/root-dot-evil': 'OUTSIDE_TRUSTED_ROOT',
  'contain/prefix/root2': 'OUTSIDE_TRUSTED_ROOT',
  'contain/prefix/real-root-sibling': 'OUTSIDE_TRUSTED_ROOT',
  'contain/escape/dotdot-out': 'OUTSIDE_TRUSTED_ROOT',
  'contain/escape/dotdot-deep': 'OUTSIDE_TRUSTED_ROOT',
  'contain/escape/relative-dotdot': 'OUTSIDE_TRUSTED_ROOT',
  'contain/escape/relative-nested-dotdot': 'OUTSIDE_TRUSTED_ROOT',
  'contain/escape/parent-of-root': 'OUTSIDE_TRUSTED_ROOT',
  'contain/escape/different-drive': 'OUTSIDE_TRUSTED_ROOT',
  'contain/escape/unc': 'PATH_REJECTED',
  'contain/escape/device-namespace': 'PATH_REJECTED',
  'contain/escape/dos-device': 'PATH_REJECTED',
  'contain/device/con-inside-root': 'PATH_REJECTED',
  'contain/device/nul-with-extension-inside-root': 'PATH_REJECTED',
  'contain/segment/trailing-space': 'PATH_REJECTED',
  'contain/segment/trailing-dot': 'PATH_REJECTED',
  'contain/segment/ads': 'PATH_REJECTED',
  'contain/malformed/empty': 'PATH_REJECTED',
  'contain/malformed/null-byte': 'PATH_REJECTED',
  'contain/malformed/relative-root': 'PATH_REJECTED',
  'contain/malformed/rtl-override': 'PATH_REJECTED',
  'contain/length/absurd': 'PATH_REJECTED',
  'contain/posix/prefix-trap': 'OUTSIDE_TRUSTED_ROOT',
  'contain/posix/case-sensitive': 'OUTSIDE_TRUSTED_ROOT',
  'contain/posix/escape': 'OUTSIDE_TRUSTED_ROOT',
};

describe(`containment vectors (${String(VECTOR_COUNTS.containment)})`, () => {
  it('every reject row has a declared expected error code', () => {
    const missing = CONTAINMENT_VECTORS.filter(
      (v) => v.expect === 'reject' && CONTAINMENT_REJECT_CODE[v.id] === undefined,
    ).map((v) => v.id);
    expect(missing, 'a reject row with no declared code would be asserted too weakly').toEqual([]);
  });

  for (const vector of CONTAINMENT_VECTORS) {
    it(`${vector.expect === 'reject' ? 'refuses' : 'accepts'} ${vector.id}`, () => {
      markExecuted(vector.id);
      // The platform seam is what lets one machine assert both flavours. The
      // guard itself skips link resolution when the seam disagrees with the
      // host, and these rows are purely lexical, so nothing is faked here.
      const options = { platform: vector.platform === 'any' ? os.platform() : vector.platform };

      if (vector.expect === 'reject') {
        const error = guardErrorFrom(
          () => assertInsideRoot(vector.input, vector.root, options),
          `${vector.id} (${vector.why})`,
        );
        expect(error.code, `${vector.id}: ${vector.why}`).toBe(CONTAINMENT_REJECT_CODE[vector.id]);
        return;
      }

      const canonical = assertInsideRoot(vector.input, vector.root, options);
      expect(typeof canonical).toBe('string');
      expect(canonical.length).toBeGreaterThan(0);

      if (vector.expectedCanonical !== undefined) {
        expect(canonical, `${vector.id}: ${vector.why}`).toBe(vector.expectedCanonical);
      }
      if (vector.expectLongPathWarning === true) {
        expect(
          exceedsWindowsMaxPath(canonical),
          `${vector.id}: the guard must accept it AND the UI must be told it is over MAX_PATH`,
        ).toBe(true);
      }

      // The returned value is the one callers must act on, so it has to be a
      // fixed point of the guard: feeding it back in must not change it.
      expect(assertInsideRoot(canonical, vector.root, options)).toBe(canonical);
    });
  }
});

/* ========================================================================== */
/*  Link vectors — real filesystem, real junctions, real symlinks              */
/* ========================================================================== */

interface LinkFixture {
  readonly base: string;
  readonly root: string;
  readonly outside: string;
  readonly candidate: string;
}

/**
 * Build the temporary tree a link vector describes, or explain why it could not
 * be built. Returning a reason rather than throwing is what keeps "the link
 * could not be created" distinguishable from "the guard failed".
 */
function buildLinkFixture(vector: LinkVector): { readonly fixture: LinkFixture } | { readonly reason: string } {
  // realpath the temp directory first: on Windows `os.tmpdir()` can be an 8.3
  // short path, and comparing a short path against a canonicalised one is a
  // meaningless answer dressed up as a pass.
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'forge-linkvec-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  const insideReal = path.join(root, 'real');

  mkdirSync(root);
  mkdirSync(outside);
  mkdirSync(insideReal);
  writeFileSync(path.join(outside, 'stolen.txt'), 'a secret the root never contained');
  writeFileSync(path.join(insideReal, 'file.txt'), 'legitimately inside the root');

  const linkPath = path.join(root, vector.linkName);
  const target =
    vector.target === 'outside-root'
      ? vector.linkType === 'symlink-file'
        ? path.join(outside, 'stolen.txt')
        : outside
      : insideReal;
  const linkType =
    vector.linkType === 'junction' ? 'junction' : vector.linkType === 'symlink-file' ? 'file' : 'dir';

  try {
    symlinkSync(target, linkPath, linkType);
  } catch (error) {
    rmSync(base, { recursive: true, force: true });
    const code = (error as { code?: string }).code ?? 'unknown';
    return {
      reason:
        `the ${vector.linkType} could not be created (${code})` +
        (vector.mayRequireElevation
          ? ' - on Windows a directory SYMLINK needs Developer Mode or elevation; a junction does not'
          : ''),
    };
  }

  return { fixture: { base, root, outside, candidate: path.join(root, vector.input) } };
}

describe(`link vectors (${String(VECTOR_COUNTS.link)}) - real filesystem`, () => {
  for (const vector of LINK_VECTORS) {
    it(`${vector.expect === 'reject' ? 'refuses' : 'accepts'} ${vector.id}`, (ctx) => {
      const hostFlavour = HOST_IS_WIN32 ? 'win32' : 'posix';
      if (vector.platform !== 'any' && vector.platform !== hostFlavour) {
        ctx.skip(
          noteSkip(
            vector.id,
            `this vector asserts ${vector.platform} link semantics and the host is ${hostFlavour}; ` +
              'resolving a foreign path flavour against this filesystem produces a meaningless answer',
          ),
        );
        return;
      }

      const built = buildLinkFixture(vector);
      if ('reason' in built) {
        ctx.skip(noteSkip(vector.id, built.reason));
        return;
      }

      const { fixture } = built;
      try {
        markExecuted(vector.id);

        if (vector.expect === 'reject') {
          const error = guardErrorFrom(
            () => assertInsideRoot(fixture.candidate, fixture.root),
            `${vector.id} (${vector.why})`,
          );
          // No amount of string normalisation sees through a junction. Only
          // realpath does, and realpath is what produces this verdict.
          expect(error.code, `${vector.id}: ${vector.why}`).toBe(
            'OUTSIDE_TRUSTED_ROOT' satisfies PathErrorCode,
          );
          return;
        }

        const canonical = assertInsideRoot(fixture.candidate, fixture.root);
        const realRoot = realpathSync.native(fixture.root);
        expect(
          canonical.toLowerCase().startsWith(realRoot.toLowerCase()),
          `${vector.id}: ${vector.why}`,
        ).toBe(true);
        expect(canonical.toLowerCase().startsWith(realpathSync.native(fixture.outside).toLowerCase())).toBe(
          false,
        );
      } finally {
        rmSync(fixture.base, { recursive: true, force: true });
      }
    });
  }

  it('a junction standing in for the root itself does not move the boundary', (ctx) => {
    if (!HOST_IS_WIN32) {
      ctx.skip(
        noteSkip('link/extra/root-is-a-junction', 'junctions are a Windows construct and the host is not win32'),
      );
      return;
    }
    const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'forge-rootjunction-'));
    try {
      const real = path.join(base, 'elsewhere');
      const link = path.join(base, 'root-link');
      const sibling = path.join(base, 'sibling');
      mkdirSync(real);
      mkdirSync(sibling);
      writeFileSync(path.join(real, 'x.txt'), 'x');
      symlinkSync(real, link, 'junction');

      // Asking about a path under the LINK, with the link as the root, must
      // resolve to the real directory on both sides and still be contained.
      const canonical = assertInsideRoot(path.join(link, 'x.txt'), link);
      expect(canonical.toLowerCase()).toBe(path.join(realpathSync.native(real), 'x.txt').toLowerCase());

      // And a sibling of the link's real target is still outside it.
      const error = guardErrorFrom(
        () => assertInsideRoot(path.join(sibling, 'y.txt'), link),
        'link/extra/root-is-a-junction sibling',
      );
      expect(error.code).toBe('OUTSIDE_TRUSTED_ROOT' satisfies PathErrorCode);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/* ========================================================================== */
/*  Collision vectors                                                          */
/* ========================================================================== */

describe(`collision vectors (${String(VECTOR_COUNTS.collision)})`, () => {
  for (const vector of COLLISION_VECTORS) {
    it(`${vector.expect === 'reject' ? 'reports' : 'clears'} ${vector.id}`, () => {
      markExecuted(vector.id);
      const report = detectCollision(vector.existing, vector.input);

      if (vector.expect === 'reject') {
        expect(report.collides, `${vector.id}: ${vector.why}`).toBe(true);
        expect(report.matches.length).toBeGreaterThan(0);
        expect(report.matches[0]!.existing).toBe(vector.existing[0]);
        if (vector.expectedReason !== undefined) {
          // The ladder reports the TIGHTEST rung that matched. A plain case
          // clash reported as a homoglyph attack is a report nobody believes.
          expect(report.matches[0]!.reason, `${vector.id}: ${vector.why}`).toBe(vector.expectedReason);
        }
        return;
      }

      expect(
        report.collides,
        `${vector.id} was flagged as a collision but must not be - ${vector.why} (matched: ${JSON.stringify(
          report.matches,
        )})`,
      ).toBe(false);
      expect(report.matches).toEqual([]);
    });
  }

  it('collision detection is symmetric', () => {
    // Not a corpus row, but a property the ladder must hold: if A collides with
    // B then B collides with A, or the verdict depends on creation order.
    for (const vector of COLLISION_VECTORS) {
      if (vector.existing.length !== 1) continue;
      const forward = detectCollision(vector.existing, vector.input).collides;
      const backward = detectCollision([vector.input], vector.existing[0]!).collides;
      expect(backward, `${vector.id}: collision is order-dependent`).toBe(forward);
    }
  });
});

/* ========================================================================== */
/*  Sensitive-file vectors                                                     */
/* ========================================================================== */

describe(`sensitive-file vectors (${String(VECTOR_COUNTS.sensitive)})`, () => {
  for (const vector of SENSITIVE_VECTORS) {
    it(`${vector.expect === 'reject' ? 'restricts' : 'leaves unrestricted'} ${vector.id}`, () => {
      markExecuted(vector.id);
      const sensitive = isSensitivePath(vector.input);
      expect(
        sensitive,
        vector.expect === 'reject'
          ? `${vector.id} must require explicit owner approval - ${vector.why}`
          : `${vector.id} must NOT be restricted - ${vector.why}. Over-blocking trains the owner to click Approve without reading.`,
      ).toBe(vector.expect === 'reject');
    });
  }

  it('separator style does not change the verdict', () => {
    // A guard that answers differently for "a/b/.env" and "a\\b\\.env" is a
    // guard that can be bypassed by choosing a slash.
    for (const vector of SENSITIVE_VECTORS) {
      const forward = isSensitivePath(vector.input.replace(/\\/g, '/'));
      const backward = isSensitivePath(vector.input.replace(/\//g, '\\'));
      expect(backward, `${vector.id}: the verdict depends on the separator style`).toBe(forward);
    }
  });
});

/* ========================================================================== */
/*  Coverage — declared last so it observes everything above                   */
/* ========================================================================== */

describe('coverage', () => {
  it('every vector in the corpus was either executed or explicitly skipped', () => {
    const accountedFor = new Set([...executed, ...skipped.keys()]);
    const missed = ALL_VECTORS.map((v) => v.id).filter((id) => !accountedFor.has(id));
    expect(
      missed,
      'these corpus vectors were never driven through the guard, so this suite is greener than it has earned',
    ).toEqual([]);
  });

  it('no vector was both executed and skipped', () => {
    const both = [...skipped.keys()].filter((id) => executed.has(id));
    expect(both).toEqual([]);
  });

  it('only filesystem-dependent link vectors were allowed to skip', () => {
    const linkIds = new Set<string>(LINK_VECTORS.map((v) => v.id));
    const wronglySkipped = [...skipped.keys()].filter((id) => !linkIds.has(id) && !id.startsWith('link/'));
    expect(wronglySkipped, 'only link vectors may skip; anything else is a runner bug').toEqual([]);
  });
});
