/**
 * The project's own documents must agree with the code about checkable facts.
 *
 * `forge-docdrift.cjs` watches EXTERNAL sources — the Anthropic docs, the n8n docs — and reported
 * 11/11 OK while `CLAUDE.md`, the file every agent reads first and which outranks every other
 * instruction, described the WRONG dashboard as this project's own: the legacy Control Center on
 * port 3737–3999, and `/forge dashboard` as the thing that starts it. An agent following it would
 * have started the wrong process. Nothing was watching the inside.
 *
 * That was the third finding in a row of one class: text that names the wrong thing with complete
 * confidence — a component ("start the bridge"), an instruction (a relative command with no stated
 * directory), and then the governing document. None of them would trip a forbidden-word scan,
 * because none of them sounds fake. They are ordinary words for real things — just not the thing in
 * front of you.
 *
 * So this guard checks the claims themselves rather than adding a fourth one-off correction.
 *
 * Deliberately NARROW. A naive "every port in the docs must be 4100" would immediately cry wolf:
 * `.claude/commands/forge.md` legitimately cites `127.0.0.1:3100` for the Paperclip runtime, a
 * different opt-in subsystem. A guard that reports false alarms gets switched off, and then it
 * protects nothing — so this only checks claims that are *about the Command Center* and can be
 * settled against the code or the filesystem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GATEWAY_ORIGIN, GATEWAY_START_COMMAND } from '@/prototype/state/gateway-client';

/** vitest's root is `command-center/dashboard`; the project root is two levels up. */
const PROJECT_ROOT = resolve(process.cwd(), '..', '..');

/** The documents that describe how to run this project. */
const DOCS = ['CLAUDE.md', join('.claude', 'commands', 'forge.md')];

function readDoc(relativePath: string): string {
  const full = join(PROJECT_ROOT, relativePath);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
}

describe('project docs agree with the code about the Command Center', () => {
  it('every doc that names the gateway start command names the real one', () => {
    for (const doc of DOCS) {
      const text = readDoc(doc);
      if (!text.includes('gateway/bin.mjs')) continue;
      expect(
        text,
        `${doc} mentions the gateway entrypoint but not the exact command the UI shows ("${GATEWAY_START_COMMAND}"). ` +
          'Two spellings of the same instruction is how a reader ends up running neither.',
      ).toContain(GATEWAY_START_COMMAND);
    }
  });

  it('every path those docs cite for the Command Center really exists', () => {
    // Only the paths that are load-bearing for starting it. A doc citing a file that moved is the
    // same defect as a UI citing one: an instruction that cannot be followed.
    const REQUIRED = ['command-center/gateway/bin.mjs', 'command-center/dashboard/dist'];
    const missing: string[] = [];

    for (const doc of DOCS) {
      const text = readDoc(doc);
      for (const path of REQUIRED) {
        if (!text.includes(path)) continue;
        if (!existsSync(resolve(PROJECT_ROOT, path))) missing.push(`${doc} cites ${path}, which does not exist`);
      }
    }

    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('the origin the docs give for the Command Center is the origin the code uses', () => {
    const originHostPort = GATEWAY_ORIGIN.replace(/^https?:\/\//, '');

    for (const doc of DOCS) {
      const text = readDoc(doc);
      // Only look at docs that actually talk about this gateway — other subsystems have their own
      // ports and are none of this guard's business (see the header's Paperclip note).
      if (!text.includes('command-center/gateway')) continue;
      expect(
        text,
        `${doc} describes the Command Center gateway but never states its real origin ${originHostPort}.`,
      ).toContain(originHostPort);
    }
  });

  it('CLAUDE.md does not present the legacy Control Center as this project’s dashboard', () => {
    const text = readDoc('CLAUDE.md');
    if (text === '') return; // A project without this file is out of scope, not a failure.

    // The regression this pins: the Command Center must be named as this project's dashboard
    // BEFORE the legacy section, so a reader acting on the first answer acts on the right one.
    const commandCenterIndex = text.indexOf('command-center/gateway/bin.mjs');
    const legacyIndex = text.indexOf('.claude/forge-dashboard/server.cjs');

    expect(commandCenterIndex, 'CLAUDE.md no longer names the Command Center gateway at all').toBeGreaterThan(-1);
    if (legacyIndex === -1) return; // Legacy section removed entirely — also fine.
    expect(
      commandCenterIndex,
      'CLAUDE.md describes the legacy Control Center before the Command Center. A reader stops at the ' +
        'first answer, and the first answer would be the wrong dashboard for this project.',
    ).toBeLessThan(legacyIndex);
  });
});
