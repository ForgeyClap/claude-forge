/**
 * Forge Workspace — the usage operations.
 *
 * Two contract verbs live here, `getUsageState` and `getUsageHistory`, and both
 * of them answer the same question: what did this bridge actually observe?
 *
 * ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────────
 *
 * The persisted event log, every time. Not a counter held in memory, not a
 * cache warmed by whatever happened to run since boot. `UsageAggregator` is
 * rebuilt from `ForgeStore.readEvents` on demand, which is what makes a bridge
 * restart a non-event: the log on disk is the same log it was a second before
 * the process died, so the totals come back identical. A browser refresh, a
 * crash and a cold start all read the same source.
 *
 * The rebuild is cached against the store's own counters (`eventsPersisted`,
 * `lastEventAt`, stream count). A cache that invalidates on an append is a
 * speed-up; a cache that invalidates on a timer would be a way to serve a stale
 * number without saying so, so there is not one.
 *
 * ── WHAT IS NEVER FLATTENED ──────────────────────────────────────────────
 *
 * `UsageSnapshot` leaves here exactly as `UsageAggregator.project()` built it:
 * every scalar is still a `UsageField` carrying `{value, unit, source, accuracy,
 * updatedAt}`. `assertSnapshotIntact()` checks that mechanically before the
 * response is returned, so a future refactor that "simplifies" a field into a
 * bare number fails the operation instead of quietly shipping a number the UI
 * can no longer label. A 12,000 the screen cannot mark as ESTIMATED is worse
 * than no number at all.
 *
 * `planUsage` is checked in the same place: it must be UNAVAILABLE and it must
 * carry `PLAN_USAGE_UNAVAILABLE_MESSAGE`. Claude Code 2.1.217 exposes no plan or
 * quota field, so any percentage-remaining here would be invented.
 *
 * ── WHY A SCOPE CAN BE REFUSED ───────────────────────────────────────────
 *
 * run, conversation and session are single-session scopes. If the log shows two
 * different session ids both pointing at one run id, there is no honest single
 * total for that run — the aggregator refuses to merge them, and this layer
 * refuses to answer, with CONFLICT and the two session ids named. Returning the
 * bound session's subtotal would look like a complete answer and would not be
 * one. project and day span sessions by definition; their snapshot reports
 * `sessionId: null` the moment more than one contributed.
 *
 * ── WHAT "NOT MEASURED" LOOKS LIKE ───────────────────────────────────────
 *
 * A scope with no events at all gets a snapshot whose every field is
 * UNAVAILABLE and whose `source` says why, plus `observed: false`. A history
 * with nothing in it gets an empty point array and series descriptors that say
 * UNAVAILABLE — never a decorative curve through zero.
 *
 * Latency percentiles get the same treatment. Nearest-rank p99 over four
 * samples is just the maximum wearing a percentile's name, so each percentile
 * declares how many samples it needs (ceil(1/(1-p/100)): 2, 20, 100) and reports
 * NOT_YET_MEASURED with a null value until it has them.
 *
 * ── LATENCY PROVENANCE ───────────────────────────────────────────────────
 *
 * The ingestion channel is reconstructed from the `(timestamp, ingestedAt)`
 * pairs the store wrote at the time; both numbers are historical, so replaying
 * them measures what really happened rather than how old the log is. Events
 * without an `ingestedAt` are skipped — using "now" as the arrival time would
 * turn an event's age into a latency. `delivery` and `ui-update` are not in the
 * log at all (one is a send/ack round trip, the other is painted in a browser),
 * so those channels report not measured, which is the truth about this source.
 */

import type { Accuracy, ForgeEvent, UsageField, UsageSnapshot } from '../../shared/protocol.ts';
import { PLAN_USAGE_UNAVAILABLE_MESSAGE } from '../../shared/protocol.ts';

import { asObject, fail, optInteger, reqString } from '../router.ts';
import type { DegradedNote, ForgeStore } from '../storage/store.ts';
import { SCOPE_BINDING, UsageAggregator, USAGE_SCOPES, unavailableField, weakestAccuracy } from '../usage/aggregator.ts';
import type { UsageAlert, UsageAnomaly, UsageRejection, UsageScope } from '../usage/aggregator.ts';
import { LATENCY_CHANNELS, LatencyTracker } from '../usage/latency.ts';
import type { LatencyChannel, LatencyRejectionReason, LatencyStat, ReportedClockBasis } from '../usage/latency.ts';

/* ========================================================================== */
/*  Limits — all of them stated, none of them silent                           */
/* ========================================================================== */

/** Events pulled per `readEvents` call while walking one stream. */
const STREAM_PAGE_SIZE = 5_000;

/**
 * Hard ceiling on a rebuild. Past this the operation FAILS rather than
 * returning a partial total: half a log produces a number that is smaller than
 * the truth and carries no sign of it.
 */
export const DEFAULT_MAX_REBUILD_EVENTS = 50_000;

export const DEFAULT_HISTORY_POINTS = 500;
export const MAX_HISTORY_POINTS = 2_000;

const MAX_REPORTED_REJECTIONS = 50;
const MAX_REPORTED_ANOMALIES = 50;
const MAX_REPORTED_ALERTS = 50;
const MAX_REPORTED_ISSUES = 50;
const MAX_REPORTED_GAPS = 50;

/**
 * Ids the bridge itself mints, plus the `YYYY-MM-DD` day bucket. Never used to
 * build a path — a scope id only ever becomes a Map key — but validated anyway,
 * because "it is not used as a path today" is not a security property.
 */
const SCOPE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}$/;

/** The three percentiles reported per channel. */
export type PercentileLevel = 50 | 95 | 99;

/**
 * How many samples a nearest-rank percentile needs before it means anything.
 * ceil(1 / (1 - p/100)): below this the "percentile" is just the window maximum.
 */
export function requiredSamplesForPercentile(percentile: number): number {
  if (percentile >= 100) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.ceil(1 / (1 - percentile / 100)));
}

const PLAN_USAGE_SOURCE = 'unavailable:claude-code 2.1.217 exposes no plan or quota field';

const UNOBSERVED_SCOPE_REASON =
  'unavailable:no event in the persisted event log references this scope, so nothing has been measured for it';

const LATENCY_SOURCE =
  'derived:LatencyTracker over (event.timestamp, event.ingestedAt) pairs replayed from the persisted event log';

const LATENCY_NOTE =
  'Only the ingestion hop is reconstructible from the event log. Delivery is a bridge-send to client-ack ' +
  'round trip and ui-update is painted in the browser; neither is recorded on an event, so those channels ' +
  'report not measured rather than a number built from something else.';

/* ========================================================================== */
/*  Response shapes                                                            */
/* ========================================================================== */

export interface UsageStreamGap {
  readonly streamKey: string;
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

/** What the rebuild actually managed to read. Reported with every answer. */
export interface UsageCoverage {
  readonly source: 'persisted-event-log';
  readonly dataDir: string;
  readonly streams: number;
  readonly eventsRead: number;
  readonly eventsIngested: number;
  readonly eventsAccepted: number;
  readonly usageEventsIngested: number;
  readonly rebuiltAt: string;
  /** False when the log exceeded the rebuild ceiling or a stream was unreadable. */
  readonly complete: boolean;
  readonly maxRebuildEvents: number;
  /** Sequences that were assigned but are not on disk. Events are missing. */
  readonly gaps: readonly UsageStreamGap[];
  readonly issues: readonly DegradedNote[];
  readonly dedupWindowExceeded: boolean;
  readonly timeZone: string;
  readonly note: string;
}

export interface UsagePercentileReading {
  readonly percentile: PercentileLevel;
  /** Null whenever `status` is NOT_YET_MEASURED. Never a stand-in value. */
  readonly field: UsageField;
  readonly status: 'MEASURED' | 'NOT_YET_MEASURED';
  readonly sampleCount: number;
  readonly requiredSamples: number;
}

export interface UsageChannelLatency {
  readonly channel: LatencyChannel;
  readonly measured: boolean;
  readonly sampleCount: number;
  readonly totalObserved: number;
  readonly rejectedSamples: number;
  readonly rejectionsByReason: Readonly<Record<LatencyRejectionReason, number>>;
  readonly windowSize: number;
  readonly clockBasis: ReportedClockBasis;
  readonly method: string;
  readonly targetP95Ms: number;
  /** Null means NOT MEASURED. It never means "passed". */
  readonly meetsP95Target: boolean | null;
  readonly p50: UsagePercentileReading;
  readonly p95: UsagePercentileReading;
  readonly p99: UsagePercentileReading;
  readonly minMs: UsageField;
  readonly maxMs: UsageField;
  readonly meanMs: UsageField;
  readonly lastSampleAt: string | null;
  readonly note: string | null;
}

export interface UsageLatencyReport {
  readonly generatedAt: string;
  readonly windowSize: number;
  readonly channels: Readonly<Record<LatencyChannel, UsageChannelLatency>>;
  readonly samplesReplayed: number;
  readonly eventsWithoutIngestedAt: number;
  readonly source: string;
  readonly note: string;
}

export interface UsageStateResult {
  readonly scope: UsageScope;
  readonly scopeId: string;
  readonly bindingPolicy: 'single-session' | 'multi-session';
  /** False when the log contains no event referencing this scope at all. */
  readonly observed: boolean;
  /** Every scalar inside is a UsageField. Checked, not assumed. */
  readonly snapshot: UsageSnapshot;
  readonly latency: UsageLatencyReport;
  readonly alerts: readonly UsageAlert[];
  readonly anomalies: readonly UsageAnomaly[];
  readonly rejections: readonly UsageRejection[];
  readonly coverage: UsageCoverage;
  /** Measured reasons the numbers above may be incomplete. Never cosmetic. */
  readonly warnings: readonly string[];
}

/** Names the descriptor list uses. Each one is a series in the history. */
const HISTORY_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'costUsd',
  'turns',
  'contextTokensUsed',
  'contextPercent',
] as const;

export type UsageHistoryField = (typeof HISTORY_FIELDS)[number];

/**
 * The label for one series. A point's number is meaningless without this, so
 * the descriptor list is always returned beside the points, never optional.
 */
export interface UsageSeriesDescriptor {
  readonly name: UsageHistoryField;
  readonly unit: UsageField['unit'];
  readonly source: string;
  /** The weakest accuracy any point in this series carried. */
  readonly accuracy: Accuracy;
}

export interface UsageHistoryPoint {
  readonly at: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly sessionId: string | null;
  readonly values: Readonly<Record<UsageHistoryField, number | null>>;
}

export interface UsageHistoryResult {
  readonly scope: UsageScope;
  readonly scopeId: string;
  readonly sessionId: string | null;
  readonly observed: boolean;
  readonly series: readonly UsageSeriesDescriptor[];
  /** Empty when nothing was recorded. The UI must render "no data yet". */
  readonly points: readonly UsageHistoryPoint[];
  readonly pointCount: number;
  readonly totalPoints: number;
  readonly truncated: boolean;
  readonly omittedEarlierPoints: number;
  readonly coverage: UsageCoverage;
  readonly warnings: readonly string[];
}

/* ========================================================================== */
/*  Payload validation                                                         */
/* ========================================================================== */

interface ScopeRequest {
  readonly scope: UsageScope;
  readonly scopeId: string;
}

function parseScopeRequest(payload: unknown): ScopeRequest {
  const body = asObject(payload);
  const scopeRaw = reqString(body, 'scope', 32);
  const scope = USAGE_SCOPES.find((candidate) => candidate === scopeRaw);
  if (scope === undefined) {
    fail('BAD_REQUEST', `scope must be one of ${USAGE_SCOPES.join(', ')}.`, `received ${scopeRaw.slice(0, 32)}`);
  }
  const scopeId = reqString(body, 'scopeId', 128);
  if (!SCOPE_ID_PATTERN.test(scopeId)) {
    fail('BAD_REQUEST', 'scopeId contains characters that are not part of a Forge identifier.');
  }
  return { scope, scopeId };
}

/* ========================================================================== */
/*  Reading the whole persisted log                                            */
/* ========================================================================== */

interface LogRead {
  readonly events: readonly ForgeEvent[];
  readonly streams: number;
  readonly complete: boolean;
  readonly gaps: readonly UsageStreamGap[];
  readonly issues: readonly DegradedNote[];
}

/**
 * Walks every stream to its end, page by page.
 *
 * `readEvents` merges streams for a broad query and then has no single cursor
 * to page with, so each stream is walked on its own key where the sequence is
 * monotonic and paging is exact. The result is then merged in the same order
 * the store itself uses.
 */
function readWholeLog(store: ForgeStore, maxEvents: number): LogRead {
  const streamKeys = store.listStreams();
  const events: ForgeEvent[] = [];
  const gaps: UsageStreamGap[] = [];
  const issues: DegradedNote[] = [];
  let complete = true;

  outer: for (const streamKey of streamKeys) {
    let fromSequence = 1;
    let firstPage = true;
    for (;;) {
      const page = store.readEvents({ streamKey, fromSequence, limit: STREAM_PAGE_SIZE });

      if (firstPage) {
        // `gaps` and `issues` are recomputed for the whole stream on every page,
        // so they are collected once rather than multiplied by the page count.
        for (const report of page.gaps) {
          for (const gap of report.gaps) {
            gaps.push({ streamKey: report.streamKey, from: gap.from, to: gap.to, count: gap.count });
          }
        }
        for (const issue of page.issues) issues.push(issue);
        firstPage = false;
      }

      for (const event of page.events) {
        if (events.length >= maxEvents) {
          complete = false;
          break outer;
        }
        events.push(event);
      }

      if (!page.hasMore || page.events.length === 0) break;
      const next = page.nextSequence;
      if (next === null || next <= fromSequence) break; // cursor did not advance
      fromSequence = next;
    }
  }

  // An unreadable stream is a hole in the evidence, not a stream with no events.
  if (issues.some((issue) => issue.reason === 'events.unreadable')) complete = false;

  events.sort((a, b) => {
    const at = a.ingestedAt ?? Date.parse(a.timestamp);
    const bt = b.ingestedAt ?? Date.parse(b.timestamp);
    if (at !== bt) return at - bt;
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    return a.sequence - b.sequence;
  });

  return { events, streams: streamKeys.length, complete, gaps, issues };
}

/* ========================================================================== */
/*  Rebuild                                                                    */
/* ========================================================================== */

interface Rebuild {
  readonly key: string;
  readonly read: LogRead;
  readonly aggregator: UsageAggregator;
  readonly latency: UsageLatencyReport;
  readonly rebuiltAt: string;
  readonly ingested: number;
  readonly accepted: number;
}

export interface UsageOperationsOptions {
  readonly store: ForgeStore;
  readonly now?: () => number;
  readonly maxRebuildEvents?: number;
  /** IANA zone for the `day` scope. Resolved from the host when omitted. */
  readonly timeZone?: string;
}

/**
 * The two usage verbs.
 *
 * Stateless with respect to telemetry: the only thing held between calls is a
 * rebuild of the log, and it is thrown away the moment the log changes.
 */
export class UsageOperations {
  private readonly store: ForgeStore;
  private readonly nowFn: () => number;
  private readonly maxRebuildEvents: number;
  private readonly timeZone: string | undefined;
  private cached: Rebuild | null = null;

  constructor(options: UsageOperationsOptions) {
    this.store = options.store;
    this.nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxRebuildEvents =
      typeof options.maxRebuildEvents === 'number' &&
      Number.isFinite(options.maxRebuildEvents) &&
      options.maxRebuildEvents > 0
        ? Math.floor(options.maxRebuildEvents)
        : DEFAULT_MAX_REBUILD_EVENTS;
    this.timeZone = options.timeZone;
  }

  /* ---------------------------------------------------------------- rebuild */

  private cacheKey(): string {
    const stats = this.store.stats();
    return `${stats.dataDir}|${stats.streams}|${stats.eventsPersisted}|${stats.lastEventAt ?? '-'}`;
  }

  /**
   * The current rebuild, reused only while the store's own counters say nothing
   * has been appended since it was made.
   */
  private rebuild(): Rebuild {
    const key = this.cacheKey();
    const cached = this.cached;
    if (cached !== null && cached.key === key) return cached;

    let read: LogRead;
    try {
      read = readWholeLog(this.store, this.maxRebuildEvents);
    } catch (err) {
      fail(
        'RUNTIME_ERROR',
        'The persisted event log could not be read, so no usage total can be reported.',
        err instanceof Error ? err.message.slice(0, 200) : undefined,
      );
    }

    if (!read.complete && read.events.length >= this.maxRebuildEvents) {
      fail(
        'RUNTIME_ERROR',
        `The persisted event log holds more than ${this.maxRebuildEvents} events, which is this build's ` +
          'rebuild ceiling. A total from a partial log would be lower than the truth, so none is reported.',
        `read ${read.events.length} event(s) before stopping`,
      );
    }

    // Ingestion latency is replayed from timestamps that were both written when
    // the event happened. Anything without `ingestedAt` is skipped rather than
    // measured against "now", which would report the event's age as latency.
    const tracker = new LatencyTracker({ now: this.nowFn });
    let samplesReplayed = 0;
    let withoutIngestedAt = 0;
    for (const event of read.events) {
      if (typeof event.ingestedAt !== 'number' || !Number.isFinite(event.ingestedAt)) {
        withoutIngestedAt += 1;
        continue;
      }
      const result = tracker.recordIngestionFromEvent(event);
      if (result.accepted) samplesReplayed += 1;
    }

    const aggregator = new UsageAggregator({
      now: this.nowFn,
      latency: tracker,
      // The tracker above already saw every event exactly once. Letting the
      // aggregator measure again would double-count the same samples.
      measureIngestion: false,
      timeZone: this.timeZone,
      maxTrackedScopes: Math.max(2_000, this.maxRebuildEvents),
      dedupCapacity: Math.max(50_000, this.maxRebuildEvents),
    });

    const summary = aggregator.rebuildFrom(read.events);

    const fresh: Rebuild = {
      key,
      read,
      aggregator,
      latency: projectLatency(tracker, samplesReplayed, withoutIngestedAt),
      rebuiltAt: new Date(this.nowFn()).toISOString(),
      ingested: summary.ingested,
      accepted: summary.accepted,
    };
    this.cached = fresh;
    return fresh;
  }

  private coverage(rebuild: Rebuild): UsageCoverage {
    const stats = rebuild.aggregator.getStats();
    return {
      source: 'persisted-event-log',
      dataDir: this.store.dataDir,
      streams: rebuild.read.streams,
      eventsRead: rebuild.read.events.length,
      eventsIngested: rebuild.ingested,
      eventsAccepted: rebuild.accepted,
      usageEventsIngested: stats.usageEventsIngested,
      rebuiltAt: rebuild.rebuiltAt,
      complete: rebuild.read.complete,
      maxRebuildEvents: this.maxRebuildEvents,
      gaps: rebuild.read.gaps.slice(0, MAX_REPORTED_GAPS),
      issues: rebuild.read.issues.slice(0, MAX_REPORTED_ISSUES),
      dedupWindowExceeded: stats.dedupWindowExceeded,
      timeZone: stats.timeZone,
      note:
        'Totals are rebuilt from the events on disk on every call, so a bridge restart neither loses nor ' +
        'invents history. They are a sum over what this bridge observed — not an account balance and not ' +
        'a plan quota.',
    };
  }

  private warnings(rebuild: Rebuild, request: ScopeRequest): readonly string[] {
    const out: string[] = [];
    if (!rebuild.read.complete) {
      out.push('The event log could not be read completely, so these totals are a lower bound.');
    }
    if (rebuild.read.gaps.length > 0) {
      const missing = rebuild.read.gaps.reduce((total, gap) => total + gap.count, 0);
      out.push(
        `${missing} event sequence(s) across ${rebuild.read.gaps.length} range(s) were assigned but are not ` +
          'on disk, so events are provably missing and these totals are a lower bound.',
      );
    }
    for (const issue of rebuild.read.issues) {
      out.push(`Event log fidelity: ${issue.reason} — ${issue.detail}`);
    }
    const stats = rebuild.aggregator.getStats();
    if (stats.dedupWindowExceeded) {
      out.push('The aggregator dedup window wrapped during the rebuild; duplicate suppression is bounded past that point.');
    }
    if (stats.rejectionsByReason.SCOPE_LIMIT_REACHED > 0) {
      out.push(
        `${stats.rejectionsByReason.SCOPE_LIMIT_REACHED} event(s) were not counted because the scope limit was reached.`,
      );
    }
    const scopeRejections = rejectionsFor(rebuild.aggregator, request);
    if (scopeRejections.length > 0) {
      out.push(`${scopeRejections.length} event(s) were rejected for this scope; see rejections for the reason.`);
    }
    return out;
  }

  /* ------------------------------------------------------------ getUsageState */

  /**
   * The snapshot for one scope, with every field's provenance intact.
   *
   * Refuses rather than answers when the requested scope is single-session and
   * the log shows more than one session claiming it.
   */
  getUsageState(payload: unknown): UsageStateResult {
    const request = parseScopeRequest(payload);
    const rebuild = this.rebuild();
    this.assertNoSessionMixing(rebuild, request);

    const at = new Date(this.nowFn()).toISOString();
    const found = rebuild.aggregator.getSnapshot(request.scope, request.scopeId);
    const snapshot = found ?? unobservedSnapshot(request.scope, request.scopeId, at);

    assertSnapshotIntact(snapshot);

    return {
      scope: request.scope,
      scopeId: request.scopeId,
      bindingPolicy: SCOPE_BINDING[request.scope],
      observed: found !== null,
      snapshot,
      latency: rebuild.latency,
      alerts: rebuild.aggregator
        .getActiveAlerts()
        .filter((alert) => alert.scope === request.scope && alert.scopeId === request.scopeId)
        .slice(0, MAX_REPORTED_ALERTS),
      anomalies: rebuild.aggregator
        .getAnomalies()
        .filter((anomaly) => anomaly.scope === request.scope && anomaly.scopeId === request.scopeId)
        .slice(-MAX_REPORTED_ANOMALIES),
      rejections: rejectionsFor(rebuild.aggregator, request).slice(-MAX_REPORTED_REJECTIONS),
      coverage: this.coverage(rebuild),
      warnings: this.warnings(rebuild, request),
    };
  }

  /* ---------------------------------------------------------- getUsageHistory */

  /**
   * One point per usage envelope that landed in this scope, carrying the scope's
   * running totals at that moment.
   *
   * The points are produced by replaying the persisted log through a fresh
   * aggregator and reading its snapshot after each accepted envelope — the same
   * arithmetic that produces `getUsageState`, not a second implementation of it
   * that could disagree.
   */
  getUsageHistory(payload: unknown): UsageHistoryResult {
    const request = parseScopeRequest(payload);
    const body = asObject(payload);
    const limit = optInteger(body, 'limit', 1, MAX_HISTORY_POINTS) ?? DEFAULT_HISTORY_POINTS;

    const rebuild = this.rebuild();
    this.assertNoSessionMixing(rebuild, request);

    const replay = new UsageAggregator({
      now: this.nowFn,
      // History is a shape over time, not a latency report; leaving ingestion
      // measurement off here keeps the reported latency to the one tracker that
      // saw each event exactly once.
      latency: new LatencyTracker({ now: this.nowFn }),
      measureIngestion: false,
      timeZone: this.timeZone,
      maxTrackedScopes: Math.max(2_000, this.maxRebuildEvents),
      dedupCapacity: Math.max(50_000, this.maxRebuildEvents),
    });

    const points: UsageHistoryPoint[] = [];
    const sources = new Map<UsageHistoryField, Set<string>>();
    const units = new Map<UsageHistoryField, UsageField['unit']>();
    const accuracies = new Map<UsageHistoryField, Accuracy[]>();
    for (const name of HISTORY_FIELDS) {
      sources.set(name, new Set<string>());
      accuracies.set(name, []);
    }

    for (const event of rebuild.read.events) {
      const result = replay.ingest(event);
      if (event.type !== 'claude.usage' || !result.accepted) continue;
      const touched = result.scopesUpdated.some(
        (ref) => ref.scope === request.scope && ref.scopeId === request.scopeId,
      );
      if (!touched) continue;

      const snapshot = replay.getSnapshot(request.scope, request.scopeId);
      if (snapshot === null) continue;

      const values: Record<UsageHistoryField, number | null> = {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        turns: null,
        contextTokensUsed: null,
        contextPercent: null,
      };
      for (const name of HISTORY_FIELDS) {
        const field = snapshot[name];
        values[name] = field.value;
        units.set(name, field.unit);
        sources.get(name)?.add(field.source);
        accuracies.get(name)?.push(field.accuracy);
      }

      points.push({
        at: event.timestamp,
        sequence: event.sequence,
        eventId: event.eventId,
        sessionId: event.sessionId,
        values,
      });
    }

    const series: UsageSeriesDescriptor[] = HISTORY_FIELDS.map((name) => {
      const observedSources = [...(sources.get(name) ?? new Set<string>())];
      const observedAccuracies = accuracies.get(name) ?? [];
      return {
        name,
        unit: units.get(name) ?? defaultUnitFor(name),
        source:
          observedSources.length === 0
            ? 'unavailable:no usage envelope for this scope exists in the persisted event log'
            : observedSources.join(' | '),
        accuracy: observedAccuracies.length === 0 ? 'UNAVAILABLE' : weakestAccuracy(...observedAccuracies),
      };
    });

    const totalPoints = points.length;
    const truncated = totalPoints > limit;
    // The series is cumulative, so keeping the newest window keeps the current
    // totals correct; what is dropped is said out loud rather than implied.
    const kept = truncated ? points.slice(totalPoints - limit) : points;

    const warnings = [...this.warnings(rebuild, request)];
    if (truncated) {
      warnings.push(
        `${totalPoints - limit} earlier point(s) were not returned; raise limit (max ${MAX_HISTORY_POINTS}) to see them.`,
      );
    }

    const snapshot = rebuild.aggregator.getSnapshot(request.scope, request.scopeId);

    return {
      scope: request.scope,
      scopeId: request.scopeId,
      sessionId: snapshot?.sessionId ?? null,
      observed: snapshot !== null,
      series,
      points: kept,
      pointCount: kept.length,
      totalPoints,
      truncated,
      omittedEarlierPoints: truncated ? totalPoints - limit : 0,
      coverage: this.coverage(rebuild),
      warnings,
    };
  }

  /* ----------------------------------------------------------- observation */

  /**
   * Every usage snapshot the current log rebuild holds, across every scope.
   *
   * Exposed for the bridge's `USES_REAL_USAGE_TELEMETRY` observer, which counts
   * how many snapshots carry a field Claude Code itself reported as EXACT. It
   * reads the SAME cached rebuild the two usage verbs serve, so the declaration
   * and the numbers on the screen can never disagree about what was observed —
   * a second aggregator would be a second source of truth, which is the one
   * thing this class exists to avoid.
   */
  observeSnapshots(): readonly UsageSnapshot[] {
    return this.rebuild().aggregator.getSnapshots();
  }

  /* --------------------------------------------------------- scope isolation */

  /**
   * A single-session scope claimed by two sessions has no honest total.
   *
   * The aggregator already refuses to merge them, so the number it holds is one
   * session's subtotal wearing the whole scope's name. That is worse than an
   * error, so this raises CONFLICT and names the sessions involved.
   */
  private assertNoSessionMixing(rebuild: Rebuild, request: ScopeRequest): void {
    if (SCOPE_BINDING[request.scope] !== 'single-session') return;

    const sessions = new Set<string>();
    for (const event of rebuild.read.events) {
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId.trim() : '';
      if (sessionId.length === 0) continue;
      const claims =
        request.scope === 'run'
          ? event.runId === request.scopeId
          : request.scope === 'conversation'
            ? event.conversationId === request.scopeId
            : sessionId === request.scopeId;
      if (claims) sessions.add(sessionId);
      if (sessions.size > 1) break;
    }

    if (sessions.size <= 1) return;
    const named = [...sessions].slice(0, 4).join(', ');
    fail(
      'CONFLICT',
      `The ${request.scope} "${request.scopeId}" is referenced by ${sessions.size} different Claude Code ` +
        'sessions in the persisted event log. A single total for it would merge sessions, so none is reported.',
      `sessions: ${named}`,
    );
  }
}

/* ========================================================================== */
/*  Free helpers                                                               */
/* ========================================================================== */

function rejectionsFor(aggregator: UsageAggregator, request: ScopeRequest): readonly UsageRejection[] {
  return aggregator
    .getRejections()
    .filter((rejection) => rejection.scope === request.scope && rejection.scopeId === request.scopeId);
}

function defaultUnitFor(name: UsageHistoryField): UsageField['unit'] {
  if (name === 'costUsd') return 'usd';
  if (name === 'turns') return 'count';
  if (name === 'contextPercent') return 'percent';
  return 'tokens';
}

/* ---------------------------------------------------------------- latency -- */

function percentileReading(
  stat: LatencyStat,
  percentile: PercentileLevel,
  valueMs: number | null,
  accuracy: Accuracy,
  at: string,
): UsagePercentileReading {
  const required = requiredSamplesForPercentile(percentile);
  const name = `${stat.channel}.p${percentile}`;
  const enough = stat.measured && stat.sampleCount >= required && valueMs !== null;

  if (!enough) {
    return {
      percentile,
      field: unavailableField<number>(
        name,
        'ms',
        stat.sampleCount === 0
          ? `unavailable:no ingestion sample has been accepted on the ${stat.channel} channel, so p${percentile} is not measured`
          : `unavailable:not yet measured — p${percentile} needs at least ${required} samples by nearest rank ` +
            `and only ${stat.sampleCount} are in the window; a value here would be the window maximum wearing a percentile's name`,
        at,
      ),
      status: 'NOT_YET_MEASURED',
      sampleCount: stat.sampleCount,
      requiredSamples: required,
    };
  }

  return {
    percentile,
    field: {
      name,
      value: valueMs,
      unit: 'ms',
      source: `${LATENCY_SOURCE} — ${stat.method}, clockBasis=${stat.clockBasis}, ${stat.sampleCount} sample(s)`,
      accuracy,
      updatedAt: at,
    },
    status: 'MEASURED',
    sampleCount: stat.sampleCount,
    requiredSamples: required,
  };
}

/**
 * Turns a raw `LatencyStat` into a report that cannot mislead: every percentile
 * is gated on having enough samples, and the aggregate values carry the same
 * accuracy the samples justify.
 */
function projectChannel(stat: LatencyStat, at: string): UsageChannelLatency {
  // A two-clock sample is an approximation by construction; a single-clock one
  // is a real measurement of this process.
  const accuracy: Accuracy = !stat.measured
    ? 'UNAVAILABLE'
    : stat.clockBasis === 'same-process'
      ? 'DERIVED'
      : 'ESTIMATED';
  const aggregateSource = `${LATENCY_SOURCE} — ${stat.sampleCount} sample(s), clockBasis=${stat.clockBasis}`;

  const scalar = (name: string, value: number | null): UsageField => ({
    name: `${stat.channel}.${name}`,
    value: stat.measured ? value : null,
    unit: 'ms',
    source: stat.measured ? aggregateSource : (stat.note ?? 'unavailable:no sample recorded on this channel'),
    accuracy: stat.measured && value !== null ? accuracy : 'UNAVAILABLE',
    updatedAt: at,
  });

  return {
    channel: stat.channel,
    measured: stat.measured,
    sampleCount: stat.sampleCount,
    totalObserved: stat.totalObserved,
    rejectedSamples: stat.rejectedSamples,
    rejectionsByReason: stat.rejectionsByReason,
    windowSize: stat.windowSize,
    clockBasis: stat.clockBasis,
    method: stat.method,
    targetP95Ms: stat.targetP95Ms,
    meetsP95Target: stat.meetsP95Target,
    p50: percentileReading(stat, 50, stat.p50Ms, accuracy, at),
    p95: percentileReading(stat, 95, stat.p95Ms, accuracy, at),
    p99: percentileReading(stat, 99, stat.p99Ms, accuracy, at),
    minMs: scalar('min', stat.minMs),
    maxMs: scalar('max', stat.maxMs),
    meanMs: scalar('mean', stat.meanMs),
    lastSampleAt: stat.lastSampleAt,
    note: stat.note,
  };
}

function projectLatency(
  tracker: LatencyTracker,
  samplesReplayed: number,
  eventsWithoutIngestedAt: number,
): UsageLatencyReport {
  const report = tracker.getLatencyReport();
  const at = report.generatedAt;
  const channels = {} as Record<LatencyChannel, UsageChannelLatency>;
  for (const channel of LATENCY_CHANNELS) {
    channels[channel] = projectChannel(report.channels[channel], at);
  }
  return {
    generatedAt: at,
    windowSize: report.windowSize,
    channels,
    samplesReplayed,
    eventsWithoutIngestedAt,
    source: LATENCY_SOURCE,
    note: `${report.note} ${LATENCY_NOTE}`,
  };
}

/* --------------------------------------------------------------- snapshot -- */

/** The scalar fields of a `UsageSnapshot`. Kept in one place so the guard below
 *  and the empty snapshot above can never drift apart. */
const SNAPSHOT_FIELD_NAMES = [
  'model',
  'effort',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'contextTokensUsed',
  'contextWindow',
  'contextPercent',
  'costUsd',
  'turns',
  'toolCalls',
  'agentCount',
  'skillUses',
  'errors',
  'retries',
  'compactions',
  'elapsedMs',
  'eventLatencyP95',
  'planUsage',
] as const;

const UNITS: ReadonlySet<string> = new Set(['tokens', 'ms', 'usd', 'count', 'percent', 'none']);
const ACCURACIES: ReadonlySet<string> = new Set(['EXACT', 'DERIVED', 'ESTIMATED', 'UNAVAILABLE']);

function isUsageField(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const field = value as Record<string, unknown>;
  if (typeof field.name !== 'string' || field.name.length === 0) return false;
  if (!Object.prototype.hasOwnProperty.call(field, 'value')) return false;
  if (typeof field.unit !== 'string' || !UNITS.has(field.unit)) return false;
  if (typeof field.source !== 'string' || field.source.length === 0) return false;
  if (typeof field.accuracy !== 'string' || !ACCURACIES.has(field.accuracy)) return false;
  if (typeof field.updatedAt !== 'string' || field.updatedAt.length === 0) return false;
  // A value we do not have cannot be exact. The aggregator's builder enforces
  // this; checking it again here is cheap and catches a hand-built field.
  if ((field.value === null || field.value === undefined) && field.accuracy !== 'UNAVAILABLE') return false;
  return true;
}

/**
 * The promise this module makes to the UI, checked instead of asserted: every
 * scalar in the snapshot is still a labelled `UsageField`, and `planUsage` still
 * says the one true thing it is allowed to say.
 */
export function assertSnapshotIntact(snapshot: UsageSnapshot): void {
  for (const name of SNAPSHOT_FIELD_NAMES) {
    if (isUsageField(snapshot[name])) continue;
    fail(
      'RUNTIME_ERROR',
      'The usage snapshot lost a field\'s provenance and was not returned.',
      `${name} is not a well-formed UsageField {value, unit, source, accuracy, updatedAt}`,
    );
  }
  if (snapshot.planUsage.accuracy !== 'UNAVAILABLE' || snapshot.planUsage.value !== PLAN_USAGE_UNAVAILABLE_MESSAGE) {
    fail(
      'RUNTIME_ERROR',
      'The usage snapshot claimed to know plan usage, which the local Claude Code runtime does not expose.',
      'planUsage must be UNAVAILABLE and carry PLAN_USAGE_UNAVAILABLE_MESSAGE',
    );
  }
}

/**
 * A snapshot for a scope the log has never mentioned.
 *
 * Every field is UNAVAILABLE with a reason. Nothing here is zero: zero tokens is
 * a measurement, and no measurement was taken.
 */
export function unobservedSnapshot(scope: UsageScope, scopeId: string, at: string): UsageSnapshot {
  const gone = (name: string, unit: UsageField['unit']): UsageField =>
    unavailableField<number>(name, unit, UNOBSERVED_SCOPE_REASON, at);

  return {
    scope,
    scopeId,
    sessionId: null,
    model: unavailableField<string>('model', 'none', UNOBSERVED_SCOPE_REASON, at),
    effort: unavailableField<string>('effort', 'none', UNOBSERVED_SCOPE_REASON, at),
    inputTokens: gone('inputTokens', 'tokens'),
    outputTokens: gone('outputTokens', 'tokens'),
    cacheReadTokens: gone('cacheReadTokens', 'tokens'),
    cacheCreationTokens: gone('cacheCreationTokens', 'tokens'),
    contextTokensUsed: gone('contextTokensUsed', 'tokens'),
    contextWindow: gone('contextWindow', 'tokens'),
    contextPercent: gone('contextPercent', 'percent'),
    costUsd: gone('costUsd', 'usd'),
    turns: gone('turns', 'count'),
    toolCalls: gone('toolCalls', 'count'),
    agentCount: gone('agentCount', 'count'),
    skillUses: gone('skillUses', 'count'),
    errors: gone('errors', 'count'),
    retries: gone('retries', 'count'),
    compactions: gone('compactions', 'count'),
    elapsedMs: gone('elapsedMs', 'ms'),
    eventLatencyP95: gone('eventLatencyP95', 'ms'),
    lastUpdate: at,
    // Nothing has ever arrived for this scope, so it is stale by definition.
    stale: true,
    planUsage: {
      name: 'planUsage',
      value: PLAN_USAGE_UNAVAILABLE_MESSAGE,
      unit: 'none',
      source: PLAN_USAGE_SOURCE,
      accuracy: 'UNAVAILABLE',
      updatedAt: at,
    },
  };
}

/** Factory, matching the house style of `openStore()` and `createUsageAggregator()`. */
export function createUsageOperations(options: UsageOperationsOptions): UsageOperations {
  return new UsageOperations(options);
}
