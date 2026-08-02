/**
 * UsageBar must keep feeding the conversation's REAL measured totals into its snapshot.
 *
 * Why this test exists, and why it is shaped like this:
 *
 * `exec-bridge.mjs` writes a true `cost_usd` and `duration_ms` onto every assistant turn, and
 * `sumConversationUsage` turns those into two MEASURED usage fields. The capability is covered by
 * `gateway-usage-conversation-cost.test.ts` at the unit level. The regression this file guards is
 * different and one level up: **UsageBar dropping the third argument again.** If someone
 * "simplifies" the call back to `buildGatewayUsageState(scope, scopeId)`, every unit test still
 * passes, the types still compile (the parameter is optional by design, so the pre-existing
 * callers and tests kept working), and the bar silently goes back to declaring two measured
 * scalars unmeasured — the exact false statement this round removed.
 *
 * There is no render harness for UsageBar in this suite (it needs the prototype store plus the
 * chat-send context, and `recovery-approvals-panels.test.tsx`'s panel-level harness does not
 * reach it). Building one just for this assertion would be a lot of scaffolding for one line of
 * behaviour. So this reads the component source instead, which is honest about what it can and
 * cannot prove: it verifies the wiring is present, not that the pixels are right.
 *
 * Part 2 checks the arithmetic the wiring depends on, so a passing pair means "real totals are
 * computed correctly AND the bar still asks for them".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { toGatewayMessage } from '@/prototype/state/gateway-chat';
import {
  buildGatewayUsageState,
  sumConversationUsage,
} from '@/prototype/state/gateway-usage';
import type { ChatMessage } from '@/prototype/types/prototype-types';

// `process.cwd()` rather than `import.meta.url`: under vitest's transform the module URL is not a
// file: URL, so `fileURLToPath` throws. The runner's root is this package (vite.config.ts), so the
// package-relative path is the stable way in.
const USAGE_BAR_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/components/usage/UsageBar.tsx'),
  'utf8',
);

describe('UsageBar wiring', () => {
  it('still computes the conversation totals from the real stored turns', () => {
    expect(USAGE_BAR_SOURCE).toMatch(/sumConversationUsage\(\s*conversation\?\.messages\s*\?\?\s*\[\]\s*\)/);
  });

  it('still passes those totals into the snapshot instead of calling the 2-arg form', () => {
    // The parameter is optional, so a 2-arg call compiles and quietly reverts to all-UNAVAILABLE.
    // fix-unavailable added a 4th argument (real observed/firstEventAt evidence) — the trailing
    // `,[^)]*` tolerates that (or any future additional argument) without weakening what this
    // guard actually protects: `conversationUsage` must still be the 3rd positional argument.
    expect(USAGE_BAR_SOURCE).toMatch(/buildGatewayUsageState\(\s*scope,\s*scopeId,\s*conversationUsage\s*(,[^)]*)?\)/);
  });
});

describe('the totals the wiring depends on', () => {
  // Built through the real `toGatewayMessage` mapper rather than a hand-rolled ChatMessage. That
  // is what the mapper is exported for (see its own doc comment): a stand-in fixture can silently
  // drift from what the production mapping actually produces, and then the test proves nothing.
  // The input below is shaped exactly like a `GET /api/conversations/:id` turn record.
  const turn = (costUsd: number | null, durationMs: number | null, index = 0): ChatMessage =>
    toGatewayMessage(
      { role: 'assistant', text: '', cost_usd: costUsd, duration_ms: durationMs },
      index,
    );

  it('sums only the turns that really carry a measurement', () => {
    const totals = sumConversationUsage([turn(0.5, 1000, 0), turn(null, null, 1), turn(0.25, 500, 2)]);

    expect(totals.costUsd).toBeCloseTo(0.75, 10);
    expect(totals.elapsedMs).toBe(1500);
  });

  it('reports absence as absence — a conversation with no measured turn is never a zero', () => {
    const totals = sumConversationUsage([turn(null, null)]);

    expect(totals.costUsd).toBeNull();
    expect(totals.elapsedMs).toBeNull();
  });

  it('an empty conversation yields a snapshot, not a crash and not a fabricated total', () => {
    const state = buildGatewayUsageState('conversation', 'c-empty', sumConversationUsage([]));

    expect(state.snapshot).toBeTruthy();
    expect(state.snapshot.scopeId).toBe('c-empty');
  });
});
