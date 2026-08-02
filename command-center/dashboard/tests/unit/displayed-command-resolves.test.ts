/**
 * The command the UI tells you to run must actually work.
 *
 * When the gateway is down, the connection banner shows `GATEWAY_START_COMMAND` with a Copy button,
 * and the chat chip repeats it. That is the one instruction a stuck reader has — and it is a
 * RELATIVE path, so it only resolves from the project root, one directory above `command-center`.
 * Pasted into a terminal that happens to sit inside `command-center`, it fails with "Cannot find
 * module": the sentence meant to unblock someone becomes a second puzzle.
 *
 * Nothing checked this. The copy is a string constant, the file it names lives two directories
 * away, and no test connected the two — so a future move of `bin.mjs`, or a rename of the folder,
 * would leave the banner confidently instructing the reader to run something that no longer exists.
 * That is the same defect class as naming the wrong component: an instruction that cannot be acted
 * on, stated with complete confidence.
 *
 * So this test resolves the displayed command against the real filesystem. It is deliberately about
 * the *displayed* string, not about a duplicate constant: reading the same value the user sees is
 * the whole point.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GATEWAY_ORIGIN, GATEWAY_START_COMMAND } from '@/prototype/state/gateway-client';

/** vitest's root is `command-center/dashboard`; the project root is two levels up. */
const PROJECT_ROOT = resolve(process.cwd(), '..', '..');

describe('the start command the UI displays', () => {
  it('names a script that really exists, relative to the project root the copy states', () => {
    const parts = GATEWAY_START_COMMAND.trim().split(/\s+/);

    expect(parts[0], `expected a node invocation, got: ${GATEWAY_START_COMMAND}`).toBe('node');

    const scriptPath = parts[1];
    expect(scriptPath, 'the command names no script').toBeTruthy();
    expect(isAbsolute(scriptPath), 'the displayed command should stay relative and readable').toBe(false);

    const resolved = resolve(PROJECT_ROOT, scriptPath);
    expect(
      existsSync(resolved),
      `The UI tells the user to run "${GATEWAY_START_COMMAND}" from the project root, but ${resolved} does not exist. ` +
        'Either the script moved, or the copy is stale — both leave a stuck reader with an instruction that fails.',
    ).toBe(true);
  });

  it('does NOT resolve from command-center — which is exactly why the copy states the directory', () => {
    // Not a nitpick: this asserts the reason the "Run from the project root" wording has to stay.
    // If someone later removes that wording as noise, this test explains what it was protecting.
    const fromCommandCenter = resolve(PROJECT_ROOT, 'command-center', GATEWAY_START_COMMAND.trim().split(/\s+/)[1]);
    expect(existsSync(fromCommandCenter)).toBe(false);
  });

  it('points at the loopback origin the gateway really binds', () => {
    // A remote or non-loopback origin here would contradict the privacy copy in Settings, which
    // states in so many words that the workspace only ever reaches 127.0.0.1:4100.
    expect(GATEWAY_ORIGIN).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
