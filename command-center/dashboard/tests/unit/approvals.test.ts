/**
 * Owner approval — the gate (WP10 half).
 *
 * These run against the REAL store (`src/bridge/storage/store.ts`) writing to a
 * fresh `mkdtemp` directory per test, so a persisted verdict is a fact on disk,
 * not a mock. Nothing here touches the repo's own `.forge-workspace` or any user
 * project: every `ForgeStore.open` is given an explicit `dataDir` under the OS
 * temp dir, and `resolveDataDir` prefers an explicit `dataDir` over any env var.
 *
 * What has to be true, and is proven below:
 *   - a PENDING request BLOCKS the caller — its promise does not settle;
 *   - an APPROVED verdict unblocks it with proceed=true;
 *   - a DENIED verdict refuses it (proceed=false) and is never reported successful;
 *   - an EXPIRED request resolves EXPIRED and can NEVER become APPROVED;
 *   - a verdict written by another path (the operations layer) is observed;
 *   - the policy classifies a sample of every gated category correctly.
 *
 * Time and scheduling are injected, so every test is deterministic: an inert
 * scheduler means no timer ever fires on its own, and a mutable clock means
 * expiry happens exactly when the test advances it and calls `notify`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ForgeStore } from '../../src/bridge/storage/store.ts';
import type { AppendEventInput } from '../../src/bridge/storage/store.ts';
import { ApprovalGate, GateError } from '../../src/bridge/approvals/gate.ts';
import type { GateEventSink, GateIo, GateRequestInput, GateScheduler } from '../../src/bridge/approvals/gate.ts';
import { APPROVAL_REQUIRED_RISKS, classifyAction, requiresApproval } from '../../src/bridge/approvals/policy.ts';
import type { ActionCategory, ProposedAction } from '../../src/bridge/approvals/policy.ts';
import type { RiskLevel } from '../../src/shared/protocol.ts';

/* ------------------------------------------------------------------ fixtures */

let scratchDirs: string[] = [];
let openStores: ForgeStore[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-approvals-'));
  if (!resolve(dir).startsWith(resolve(tmpdir()))) {
    throw new Error(`refusing to run: the scratch workspace ${dir} is not under the OS temp directory`);
  }
  scratchDirs.push(dir);
  return dir;
}

function openStore(): ForgeStore {
  const store = ForgeStore.open({ dataDir: workspace() });
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* closing twice is documented as safe */
    }
  }
  openStores = [];
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  scratchDirs = [];
});

/** Captures every event the gate publishes, without a real transport. */
class CapturingSink implements GateEventSink {
  readonly events: { type: string; status: string | undefined; payload: Record<string, unknown> }[] = [];
  publish(input: AppendEventInput<Record<string, unknown>>): unknown {
    this.events.push({ type: input.type, status: input.status, payload: input.payload });
    return undefined;
  }
  ofType(type: string): { type: string; status: string | undefined; payload: Record<string, unknown> }[] {
    return this.events.filter((e) => e.type === type);
  }
}

/** A scheduler that never fires: the tests drive resolution and expiry by hand. */
const inertScheduler: GateScheduler = { set: () => ({}), clear: () => undefined };

interface Harness {
  readonly store: ForgeStore;
  readonly sink: CapturingSink;
  readonly gate: ApprovalGate;
  setNow(date: Date): void;
  getNow(): Date;
}

function harness(): Harness {
  const store = openStore();
  const sink = new CapturingSink();
  let clock = new Date('2026-07-24T00:00:00.000Z');
  const io: GateIo = { store, events: sink, now: () => clock };
  const gate = new ApprovalGate(io, { pollIntervalMs: 0, scheduler: inertScheduler });
  return { store, sink, gate, setNow: (d) => { clock = d; }, getNow: () => clock };
}

function hiRequest(overrides: Partial<GateRequestInput> = {}): GateRequestInput {
  return {
    projectId: 'proj1',
    runId: 'run1',
    requestedBy: 'agent-x',
    action: 'Push to origin',
    operation: 'sendMessage',
    affects: ['origin/main'],
    risk: 'HIGH',
    reason: 'pushing makes local work public',
    rollbackPlan: 'reset origin/main back to the previous head',
    ...overrides,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function stateOf(store: ForgeStore, id: string): string {
  const read = store.getRecord('approval', id);
  if (!read.ok) throw new Error(`approval ${id} unreadable: ${read.detail}`);
  return read.record.state;
}

/* ----------------------------------------------------------------- the gate */

describe('the approval gate blocks until a real verdict', () => {
  it('a pending request blocks the caller and emits approval.requested (WAITING_FOR_PERMISSION)', async () => {
    const h = harness();
    const { approval, settled } = h.gate.open(hiRequest());

    expect(approval.state).toBe('PENDING');
    expect(h.gate.pending()).toContain(approval.id);

    let settledFlag = false;
    void settled.then(() => { settledFlag = true; }).catch(() => { settledFlag = true; });
    await flush();
    expect(settledFlag).toBe(false); // the promise has NOT settled — the caller is still blocked

    const requested = h.sink.ofType('approval.requested');
    expect(requested).toHaveLength(1);
    expect(requested[0].status).toBe('WAITING_FOR_PERMISSION');
    expect(requested[0].payload.approvalId).toBe(approval.id);
    expect(stateOf(h.store, approval.id)).toBe('PENDING');
  });

  it('approving a pending request unblocks it with proceed=true', async () => {
    const h = harness();
    const { approval, settled } = h.gate.open(hiRequest());

    const direct = h.gate.resolve({ approvalId: approval.id, verdict: 'APPROVED', resolvedBy: 'owner@example.com' });
    expect(direct.outcome).toBe('APPROVED');

    const awaited = await settled;
    expect(awaited.outcome).toBe('APPROVED');
    expect(awaited.proceed).toBe(true);

    expect(stateOf(h.store, approval.id)).toBe('APPROVED');
    const resolved = h.sink.ofType('approval.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].payload.verdict).toBe('APPROVED');
    expect(resolved[0].payload.resolvedBy).toBe('owner@example.com');
    expect(h.gate.pending()).toHaveLength(0);
  });

  it('denying a pending request refuses it — proceed=false — and is never reported successful', async () => {
    const h = harness();
    const { approval, settled } = h.gate.open(hiRequest());

    h.gate.resolve({ approvalId: approval.id, verdict: 'DENIED', resolvedBy: 'owner' });

    const res = await settled;
    expect(res.outcome).toBe('DENIED');
    expect(res.proceed).toBe(false); // a denied action must NOT proceed

    // A denial is final: it can never later be walked forward to APPROVED.
    expect(() => h.gate.resolve({ approvalId: approval.id, verdict: 'APPROVED', resolvedBy: 'owner' })).toThrow(GateError);
    expect(stateOf(h.store, approval.id)).toBe('DENIED');
    // No APPROVED verdict was ever recorded — the outcome cannot be read as success.
    expect(h.sink.ofType('approval.resolved').every((e) => e.payload.verdict !== 'APPROVED')).toBe(true);
  });

  it('an expired request resolves EXPIRED and can never become APPROVED', async () => {
    const h = harness();
    const { approval, settled } = h.gate.open(hiRequest({ ttlMs: 60_000 }));

    // Advance the clock past the deadline, then poke the gate.
    h.setNow(new Date(Date.parse(approval.expiresAt) + 1_000));
    h.gate.notify(approval.id);

    const res = await settled;
    expect(res.outcome).toBe('EXPIRED');
    expect(res.proceed).toBe(false);
    expect(stateOf(h.store, approval.id)).toBe('EXPIRED');

    // The core security property: an expired request is never an approval.
    expect(() => h.gate.resolve({ approvalId: approval.id, verdict: 'APPROVED', resolvedBy: 'owner' })).toThrow(GateError);
    expect(stateOf(h.store, approval.id)).toBe('EXPIRED');

    const expiredEvents = h.sink.ofType('approval.resolved').filter((e) => e.payload.verdict === 'EXPIRED');
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0].payload.resolvedBy).toBeNull();
  });

  it('does not expire a request whose deadline has not yet passed', async () => {
    const h = harness();
    const { approval, settled } = h.gate.open(hiRequest({ ttlMs: 60_000 }));

    // One second before the deadline: notify must NOT settle the promise.
    h.setNow(new Date(Date.parse(approval.expiresAt) - 1_000));
    h.gate.notify(approval.id);

    let settledFlag = false;
    void settled.then(() => { settledFlag = true; }).catch(() => { settledFlag = true; });
    await flush();
    expect(settledFlag).toBe(false);
    expect(stateOf(h.store, approval.id)).toBe('PENDING');
  });

  it('observes a verdict written directly to the store by another path (operations interop)', async () => {
    const h = harness();
    const { approval, settled } = h.gate.open(hiRequest());

    // Simulate the existing approveAction operation persisting the verdict; the
    // gate is not told about it except through the shared store record.
    h.store.saveRecord('approval', { ...approval, state: 'APPROVED', resolvedAt: h.getNow().toISOString() });
    h.gate.notify(approval.id);

    const res = await settled;
    expect(res.outcome).toBe('APPROVED');
    expect(res.proceed).toBe(true);
    // The gate did not re-emit a resolved event — the resolver owns that.
    expect(h.sink.ofType('approval.resolved')).toHaveLength(0);
  });

  it('disposing the gate rejects an in-flight request so the action cannot proceed', async () => {
    const h = harness();
    const { approval, settled } = h.gate.open(hiRequest());

    h.gate.dispose();
    await expect(settled).rejects.toBeInstanceOf(GateError);
    // The PENDING record survives for the next bridge instance — nothing was approved.
    expect(stateOf(h.store, approval.id)).toBe('PENDING');
  });

  it('reuses the one live pending request for the same action instead of minting duplicates', () => {
    const h = harness();
    const first = h.gate.open(hiRequest());
    const second = h.gate.open(hiRequest());
    expect(second.approval.id).toBe(first.approval.id);
    expect(h.store.listRecords('approval').records).toHaveLength(1);
    // Attach a catch so the still-pending promises never surface as unhandled.
    void first.settled.catch(() => undefined);
    void second.settled.catch(() => undefined);
  });
});

/* ------------------------------------------------------------- guard (policy) */

describe('guard combines policy classification with the gate', () => {
  it('lets a low-risk action proceed without opening a request', async () => {
    const h = harness();
    const result = await h.gate.guard({
      action: { type: 'filesystem', operation: 'read', withinTrustedRoot: true, targets: [{ path: 'src/a.ts' }] },
      projectId: 'proj1',
      requestedBy: 'agent-x',
      operation: 'readProjectFile',
      affects: ['src/a.ts'],
      rollbackPlan: 'none required',
    });
    expect(result.gated).toBe(false);
    expect(result.proceed).toBe(true);
    expect(result.resolution).toBeNull();
    expect(h.gate.pending()).toHaveLength(0);
    expect(h.store.listRecords('approval').records).toHaveLength(0);
  });

  it('blocks a high-risk action until a verdict, and a denial stops it', async () => {
    const h = harness();
    const action: ProposedAction = { type: 'git', operation: 'push' };
    const pending = h.gate.guard({
      action,
      projectId: 'proj1',
      runId: 'run1',
      requestedBy: 'agent-x',
      operation: 'sendMessage',
      affects: ['origin/main'],
      rollbackPlan: 'reset origin/main to the previous head',
    });

    // The request is persisted synchronously, before guard awaits.
    const ids = h.gate.pending();
    expect(ids).toHaveLength(1);

    h.gate.resolve({ approvalId: ids[0], verdict: 'DENIED', resolvedBy: 'owner' });
    const result = await pending;
    expect(result.gated).toBe(true);
    expect(result.proceed).toBe(false);
    expect(result.resolution?.outcome).toBe('DENIED');
    expect(result.decision.category).toBe('PUBLISH_OR_DEPLOY');
  });
});

/* ------------------------------------------------------------------- policy */

describe('policy risk classification', () => {
  interface Sample {
    readonly label: string;
    readonly action: ProposedAction;
    readonly category: ActionCategory;
    readonly risk: RiskLevel;
  }

  const gated: readonly Sample[] = [
    {
      label: 'delete project',
      action: { type: 'filesystem', operation: 'delete', withinTrustedRoot: true, targets: [{ path: '.', isProjectRoot: true }] },
      category: 'DELETE_PROJECT',
      risk: 'CRITICAL',
    },
    {
      label: 'delete important file',
      action: { type: 'filesystem', operation: 'delete', withinTrustedRoot: true, targets: [{ path: '.git/config', important: true }] },
      category: 'DELETE_IMPORTANT_FILE',
      risk: 'HIGH',
    },
    {
      label: 'broad filesystem access outside the root',
      action: { type: 'filesystem', operation: 'read', withinTrustedRoot: false, targets: [{ path: 'C:/Users', outsideTrustedRoot: true }] },
      category: 'BROAD_FILESYSTEM_ACCESS',
      risk: 'HIGH',
    },
    {
      label: 'command outside the trusted root',
      action: { type: 'command', withinTrustedRoot: false },
      category: 'COMMAND_OUTSIDE_TRUSTED_ROOT',
      risk: 'HIGH',
    },
    {
      label: 'push',
      action: { type: 'git', operation: 'push' },
      category: 'PUBLISH_OR_DEPLOY',
      risk: 'HIGH',
    },
    {
      label: 'create a remote repo',
      action: { type: 'git', operation: 'create-remote', remote: true },
      category: 'REMOTE_REPO_CREATION',
      risk: 'HIGH',
    },
    {
      label: 'expose to the LAN',
      action: { type: 'network', operation: 'expose-lan' },
      category: 'LAN_EXPOSURE',
      risk: 'CRITICAL',
    },
    {
      label: 'enable remote access',
      action: { type: 'network', operation: 'enable-remote-access' },
      category: 'REMOTE_ACCESS',
      risk: 'CRITICAL',
    },
    {
      label: 'external communication',
      action: { type: 'network', operation: 'outbound-message' },
      category: 'EXTERNAL_COMMS',
      risk: 'HIGH',
    },
    {
      label: 'destructive live database op',
      action: { type: 'database', environment: 'production', destructive: true },
      category: 'LIVE_DB_DESTRUCTIVE',
      risk: 'CRITICAL',
    },
    {
      label: 'payment',
      action: { type: 'payment', live: true },
      category: 'PAYMENT',
      risk: 'CRITICAL',
    },
    {
      label: 'live service modification',
      action: { type: 'service', environment: 'production', operation: 'deploy' },
      category: 'LIVE_SERVICE_MODIFICATION',
      risk: 'CRITICAL',
    },
    {
      label: 'high-risk dependency install',
      action: { type: 'dependency', scope: 'project', source: 'git', highRisk: true },
      category: 'HIGH_RISK_DEPENDENCY_INSTALL',
      risk: 'HIGH',
    },
    {
      label: 'credential access',
      action: { type: 'credential', operation: 'read', target: 'env' },
      category: 'CREDENTIAL_ACCESS',
      risk: 'HIGH',
    },
    {
      label: 'global system change',
      action: { type: 'system', operation: 'env' },
      category: 'GLOBAL_SYSTEM_CHANGE',
      risk: 'HIGH',
    },
    {
      label: 'global dependency install (system change)',
      action: { type: 'dependency', scope: 'global' },
      category: 'GLOBAL_SYSTEM_CHANGE',
      risk: 'HIGH',
    },
  ];

  for (const sample of gated) {
    it(`gates "${sample.label}" as ${sample.category} (${sample.risk})`, () => {
      const decision = classifyAction(sample.action);
      expect(decision.category).toBe(sample.category);
      expect(decision.risk).toBe(sample.risk);
      expect(decision.requiresApproval).toBe(true);
      expect(APPROVAL_REQUIRED_RISKS).toContain(decision.risk);
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.summary.length).toBeGreaterThan(0);
    });
  }

  const notGated: readonly Sample[] = [
    {
      label: 'read a contained file',
      action: { type: 'filesystem', operation: 'read', withinTrustedRoot: true, targets: [{ path: 'src/a.ts' }] },
      category: 'UNCLASSIFIED',
      risk: 'LOW',
    },
    {
      label: 'a local commit',
      action: { type: 'git', operation: 'commit' },
      category: 'UNCLASSIFIED',
      risk: 'LOW',
    },
    {
      label: 'a routine registry install',
      action: { type: 'dependency', scope: 'project', source: 'registry' },
      category: 'UNCLASSIFIED',
      risk: 'MEDIUM',
    },
    {
      label: 'a local database write',
      action: { type: 'database', environment: 'local', destructive: false },
      category: 'UNCLASSIFIED',
      risk: 'LOW',
    },
  ];

  for (const sample of notGated) {
    it(`does not gate "${sample.label}" (${sample.risk})`, () => {
      const decision = classifyAction(sample.action);
      expect(decision.category).toBe(sample.category);
      expect(decision.risk).toBe(sample.risk);
      expect(decision.requiresApproval).toBe(false);
    });
  }

  it('the gating rule is exactly HIGH and CRITICAL', () => {
    expect(requiresApproval('LOW')).toBe(false);
    expect(requiresApproval('MEDIUM')).toBe(false);
    expect(requiresApproval('HIGH')).toBe(true);
    expect(requiresApproval('CRITICAL')).toBe(true);
  });
});
