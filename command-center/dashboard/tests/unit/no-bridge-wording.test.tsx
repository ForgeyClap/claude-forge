/**
 * Production copy must never name the "bridge".
 *
 * The bridge is this workspace's original backend. It is never connected any more — production
 * talks to the gateway on 127.0.0.1:4100 — but its 35 source files stay on disk by the owner's
 * "add only, never remove" rule, and its vocabulary lingered in user-facing strings.
 *
 * Why that mattered more than a stale word: `ClaudeCodeChip`'s disconnected state told the reader
 * **"Disconnected — start the bridge"** and then, in the popover, **"Start the local bridge with
 * `node command-center/gateway/bin.mjs`"** — naming one component while handing over the command
 * that starts a different one. The single sentence whose whole job is to unblock a stuck user sent
 * them looking for something that does not exist. The topbar's own chip already said "gateway", so
 * the same state had two different names depending on where you looked.
 *
 * The existing forbidden-copy scan could not catch this: "bridge" is not fake-sounding like
 * "example" or "prototype". It is a real word for a real thing — just not the thing on screen.
 *
 * This test is deliberately narrow. It does not ban "bridge" from the codebase (the bridge modules,
 * their tests, and `exec-bridge.mjs` references are all legitimate); it bans it from what a
 * production user READS.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');

/**
 * Files whose user-facing strings are checked. The bridge's own modules and the fixture data that
 * legitimately describes the prototype's bridge concept are out of scope by design — a fixture
 * state named "Waiting for the local bridge" is accurate about what it depicts, and never renders
 * in production.
 */
const EXCLUDED = [
  // The bridge's own modules. Their copy accurately describes the bridge.
  join(SRC, 'bridge'),
  join(SRC, 'prototype', 'state', 'bridge-client.ts'),
  join(SRC, 'shared', 'protocol.ts'),
  // Fixture data that depicts the prototype's bridge concept. Accurate about what it depicts, and
  // gated out of production by `allowFixtureData()`.
  join(SRC, 'prototype', 'fixtures'),
  join(SRC, 'prototype', 'data', 'claude-code.ts'),
  // Bridge-era modules that survive on disk under the owner's "add only, never remove" rule.
  // Each was checked for a production render path before being excluded, not waved through:
  //   · `chat-send.ts` — a complete send controller that is never mounted; `gateway-chat.ts` is
  //     the real path (found while tracing the chat project-mismatch defect).
  //   · `live-store.ts` — the never-connected store. Production imports exactly one thing from it,
  //     the pure `statusKeyOf` helper; the store connection itself is no longer reached.
  //   · `declarations.ts` — imported type-only, by `bridge-client.ts` alone. Nothing renders it.
  // All three are on OWNER-QUEUE.md item 4; when that is answered, this list shrinks with them.
  join(SRC, 'prototype', 'state', 'chat-send.ts'),
  join(SRC, 'prototype', 'state', 'live-store.ts'),
  join(SRC, 'shared', 'declarations.ts'),
];

function walk(dir: string): string[] {
  if (EXCLUDED.some((excluded) => dir === excluded)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (EXCLUDED.includes(full)) return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * A quoted string containing the word "bridge" — i.e. copy, not an identifier or an import path.
 * `exec-bridge.mjs` is explicitly allowed: that IS the gateway's real module name, and several
 * honest comments and strings cite it as a source.
 */
const BRIDGE_IN_COPY = /(['"`])([^'"`\n]*\bbridge\b[^'"`\n]*)\1/gi;

/**
 * Not copy: module paths, the gateway's real `exec-bridge.mjs`, machine tokens that happen to
 * carry the word (a state-machine event name, a fixture state id). These are identifiers a user
 * never reads as a sentence.
 */
const ALLOWED = /exec-bridge|bridge-client|@\/bridge|\.\/bridge|bridge\/|^bridge\.[a-z]|^awaiting-bridge$/i;

/**
 * Comments are stripped before matching. The first version of this test flagged its own
 * explanatory comments — a guard that reports the reasoning for the guard is noise, and noisy
 * guards get switched off. Only real string literals in code are checked.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('production copy names the gateway, never the bridge', () => {
  it('has no user-facing string that calls the backend a bridge', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(BRIDGE_IN_COPY)) {
        const text = match[2];
        if (ALLOWED.test(text)) continue;
        offenders.push(`${file.slice(SRC.length + 1)} → "${text.trim()}"`);
      }
    }

    expect(
      offenders,
      `Production-rendered copy still names the bridge. The user talks to the gateway:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
