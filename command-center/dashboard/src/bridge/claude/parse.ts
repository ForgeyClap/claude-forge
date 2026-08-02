/**
 * Forge Workspace — normalising Claude Code's `stream-json` output.
 *
 * This module turns one line of the CLI's stdout into zero or more
 * `ForgeEventDraft`s and, at the end, into a `UsageSnapshot`. It is pure: no
 * file system, no process, no clock it did not receive. That is deliberate —
 * everything here is the part of the adapter that has to be provable by reading
 * it, and a pure function can be tested against a recorded stream.
 *
 * THE ONE RULE, APPLIED TO NUMBERS. A `UsageField` carries its own provenance.
 * Four accuracies exist and each one means something different:
 *
 *   EXACT       the runtime printed this number in its own envelope.
 *   DERIVED     arithmetic over EXACT values, or an exact count of events we
 *               actually observed on this stream.
 *   ESTIMATED   we approximated it locally. NOTHING in this file produces one.
 *               The CLI's own `system/thinking_tokens` line carries a field the
 *               runtime itself calls `estimated_tokens`; it is passed through as
 *               a message and never folded into a token total, because an
 *               estimate that has been added to an exact number has destroyed
 *               both.
 *   UNAVAILABLE the installed runtime does not expose it. This is a correct
 *               answer, not a failure, and `usageField` enforces it: a field
 *               whose value is null is rewritten to UNAVAILABLE no matter what
 *               the caller asked for, so a null can never claim to be a fact.
 *
 * WHAT WAS VERIFIED, AND HOW. Every shape below was read off two real runs of
 * `claude.exe 2.1.217` on this machine (captured to
 * `scratchpad/probe-stream.jsonl` and `scratchpad/probe-tool.jsonl`), not from
 * documentation. The line types actually observed were: `system` (subtypes
 * `init`, `status`, `thinking_tokens`), `stream_event` (inner `message_start`,
 * `content_block_start`, `content_block_delta`, `content_block_stop`,
 * `message_delta`, `message_stop`), `assistant`, `user`, `rate_limit_event` and
 * `result`. Anything else is handled as an unrecognised line rather than
 * dropped.
 *
 * PLAN USAGE. The runtime does emit a `rate_limit_event`, and it was tempting
 * to read plan usage out of it. It contains `status`, `resetsAt`,
 * `rateLimitType`, `overageStatus` and `isUsingOverage` — a state and a reset
 * time, and no quota, no remaining amount, no percentage. So `planUsage` stays
 * UNAVAILABLE with the contract's sentence, and the rate-limit line is surfaced
 * as a message so the UI can still say "five-hour window, resets at ...".
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports.
 */

import { Buffer } from 'node:buffer';

import { PLAN_USAGE_UNAVAILABLE_MESSAGE } from '../../shared/protocol.ts';
import type {
  Accuracy,
  EventType,
  EvidenceRef,
  ForgeEvent,
  UsageField,
  UsageSnapshot,
} from '../../shared/protocol.ts';

/* ========================================================================== */
/*  Text hygiene                                                               */
/* ========================================================================== */

/**
 * Best-effort secret scrubbing for any runtime text that may end up in an
 * event payload, an evidence file or a log line.
 *
 * HONEST LIMIT: this is a denylist. It catches the credential shapes that are
 * actually common and it will not catch a secret that looks like ordinary
 * prose. It is therefore the *second* line of defence, never the first — the
 * first is not putting the text somewhere it can leak, which is why tool
 * results and stderr are summarised rather than echoed by default.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED:anthropic-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED:api-key]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[REDACTED:github-token]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, '[REDACTED:aws-key-id]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED:jwt]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)\b(\s*[:=]\s*|"\s*:\s*")["']?([^\s"',;}]{6,})/gi,
      '$1$2[REDACTED]',
    );
}

/**
 * Control characters can forge a log line and an unbounded string can flood the
 * event store, so any raw excerpt is escaped and capped before it is recorded.
 */
export function safeExcerpt(value: unknown, maxChars = 500): string {
  const raw = typeof value === 'string' ? value : Object.prototype.toString.call(value);
  const escaped = redactSecrets(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return escaped.length > maxChars ? `${escaped.slice(0, maxChars)}…(${escaped.length} chars)` : escaped;
}

/* ========================================================================== */
/*  The seam between a parsed line and a persisted event                       */
/* ========================================================================== */

/**
 * What the parser produces.
 *
 * It is a `ForgeEvent` minus the four fields the parser has no right to invent:
 * `eventId` and `ingestedAt` belong to whoever writes the event, `schemaVersion`
 * belongs to the storage layer, and `sequence` is assigned by the store and only
 * by the store — that single-writer rule is exactly what makes `detectGaps`
 * meaningful. A draft is structurally assignable to `AppendEventInput`, so the
 * bridge hands it straight to `ForgeStore.appendEvent` with no translation.
 */
export type ForgeEventDraft<P = unknown> = Omit<
  ForgeEvent<P>,
  'eventId' | 'sequence' | 'schemaVersion' | 'ingestedAt'
>;

/** For callers that need a whole event without a store (tests, replay tools). */
export function materialiseEvent<P>(
  draft: ForgeEventDraft<P>,
  identity: { readonly eventId: string; readonly sequence: number; readonly schemaVersion: number; readonly ingestedAt?: number },
): ForgeEvent<P> {
  return {
    eventId: identity.eventId,
    schemaVersion: identity.schemaVersion,
    sequence: identity.sequence,
    ...draft,
    ...(identity.ingestedAt === undefined ? {} : { ingestedAt: identity.ingestedAt }),
  };
}

/* ========================================================================== */
/*  Untrusted-JSON accessors                                                   */
/* ========================================================================== */

/*
 * A line off a child process's stdout is untrusted input. Every read below goes
 * through one of these, so a field that is missing or of the wrong type yields
 * null instead of a `TypeError` that would kill the stream reader.
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/* ========================================================================== */
/*  Usage fields                                                               */
/* ========================================================================== */

/**
 * Build a usage field.
 *
 * The invariant enforced here is small and load-bearing: a field with no value
 * is UNAVAILABLE, whatever accuracy the caller passed. Without it, a refactor
 * that stops finding a number leaves an EXACT-labelled null on screen, and the
 * bar renders "0 tokens" as though the runtime had said so.
 */
export function usageField<T>(
  name: string,
  value: T | null,
  unit: UsageField['unit'],
  source: string,
  accuracy: Accuracy,
  updatedAt: string,
): UsageField<T> {
  if (value === null || value === undefined) {
    return { name, value: null, unit, source, accuracy: 'UNAVAILABLE', updatedAt };
  }
  return { name, value, unit, source, accuracy, updatedAt };
}

/** A field the installed runtime genuinely does not expose. */
export function unavailableField<T = number>(
  name: string,
  unit: UsageField['unit'],
  source: string,
  updatedAt: string,
): UsageField<T> {
  return { name, value: null, unit, source, accuracy: 'UNAVAILABLE', updatedAt };
}

/* ========================================================================== */
/*  The shapes the 2.1.217 envelope actually has                               */
/* ========================================================================== */

/** The four token counters the runtime prints. Every one of them is EXACT. */
export interface RawTokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
}

function readTokenUsage(usage: unknown): RawTokenUsage | null {
  const record = asRecord(usage);
  if (record === null) return null;
  const parsed: RawTokenUsage = {
    inputTokens: asNumber(record.input_tokens),
    outputTokens: asNumber(record.output_tokens),
    cacheReadTokens: asNumber(record.cache_read_input_tokens),
    cacheCreationTokens: asNumber(record.cache_creation_input_tokens),
  };
  const anyPresent =
    parsed.inputTokens !== null ||
    parsed.outputTokens !== null ||
    parsed.cacheReadTokens !== null ||
    parsed.cacheCreationTokens !== null;
  return anyPresent ? parsed : null;
}

/** One `modelUsage[<model>]` entry. `contextWindow` is what the bar needs. */
export interface ModelUsageEntry {
  readonly key: string;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly costUsd: number | null;
}

/**
 * Find the `modelUsage` entry that belongs to the session's model.
 *
 * This is fussier than it looks, and the fussiness is the point. A real run
 * produced TWO entries — `claude-haiku-4-5-20251001` and `claude-opus-4-8[1m]`
 * — because a background helper used a second model. Their `contextWindow`
 * values differ by 5x (200000 vs 1000000). Picking the wrong one would put a
 * confidently wrong percentage on screen.
 *
 * So: exact key match first. Then a match after stripping a bracketed variant
 * tag, and only when exactly one candidate survives — the `system/init` line
 * reports `claude-opus-4-8[1m]` while the assistant message reports
 * `claude-opus-4-8`, so the two forms have to reconcile. Then, only if the model
 * is unknown and the envelope contains exactly one entry, that entry (there is
 * nothing to confuse it with). Otherwise null, and the context window is
 * reported UNAVAILABLE rather than guessed.
 */
export function resolveModelUsageEntry(modelUsage: unknown, modelId: string | null): ModelUsageEntry | null {
  const table = asRecord(modelUsage);
  if (table === null) return null;
  const keys = Object.keys(table);
  if (keys.length === 0) return null;

  const read = (key: string): ModelUsageEntry | null => {
    const entry = asRecord(table[key]);
    if (entry === null) return null;
    return {
      key,
      contextWindow: asNumber(entry.contextWindow),
      maxOutputTokens: asNumber(entry.maxOutputTokens),
      costUsd: asNumber(entry.costUSD),
    };
  };

  if (modelId !== null) {
    if (Object.prototype.hasOwnProperty.call(table, modelId)) return read(modelId);
    const base = (value: string): string => value.replace(/\[[^\]]*\]$/, '');
    const wanted = base(modelId);
    const matches = keys.filter((key) => base(key) === wanted);
    if (matches.length === 1) return read(matches[0]!);
    return null;
  }

  return keys.length === 1 ? read(keys[0]!) : null;
}

/* ========================================================================== */
/*  Event payloads                                                             */
/* ========================================================================== */

export type OutputChannel = 'text' | 'thinking';

export interface RunOutputDeltaPayload {
  readonly channel: OutputChannel;
  readonly text: string;
  readonly blockIndex: number | null;
  /**
   * True when the chunk was reconstructed from a whole assistant message
   * because partial streaming was not available. The text is identical; the
   * timing is not, and the UI should not claim token-by-token liveness it did
   * not have.
   */
  readonly synthesizedFromFullMessage: boolean;
}

export interface ClaudeToolStartPayload {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** Non-null when the call was made inside a subagent's context. */
  readonly parentToolUseId: string | null;
  readonly messageId: string | null;
}

export interface ClaudeToolEndPayload {
  readonly toolUseId: string;
  /** Null when no matching start was observed. Never invented from the result. */
  readonly toolName: string | null;
  readonly isError: boolean;
  readonly durationMs: number | null;
  /** Size of the result, not the result. See `includeToolResultExcerpt`. */
  readonly resultBytes: number | null;
  readonly resultExcerpt: string | null;
  readonly parentToolUseId: string | null;
}

export interface RunOutputCompletePayload {
  readonly subtype: string | null;
  readonly isError: boolean | null;
  readonly stopReason: string | null;
  readonly terminalReason: string | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly durationApiMs: number | null;
  readonly sessionId: string | null;
  readonly resultText: string | null;
  readonly resultTruncated: boolean;
  readonly permissionDenials: readonly unknown[] | null;
  readonly apiErrorStatus: unknown;
}

export interface ClaudeUsagePayload {
  readonly snapshot: UsageSnapshot;
  /** False for the interim snapshots emitted mid-turn from `message_delta`. */
  readonly final: boolean;
}

export type ClaudeMessageKind =
  | 'assistant'
  | 'user'
  | 'system'
  | 'rate-limit'
  | 'thinking-tokens'
  | 'tool-input-delta'
  | 'unrecognised';

export interface ClaudeMessagePayload {
  readonly kind: ClaudeMessageKind;
  readonly subtype: string | null;
  readonly detail: JsonRecord;
}

export type StreamParseErrorReason =
  | 'claude.stream.unparsable-line'
  | 'claude.stream.not-an-object'
  | 'claude.stream.missing-type'
  | 'claude.stream.line-too-long';

export interface StreamParseErrorPayload {
  readonly reason: StreamParseErrorReason;
  readonly lineNumber: number;
  readonly byteLength: number;
  readonly detail: string;
  /** Escaped, redacted and capped. The full line lives in the evidence file. */
  readonly rawExcerpt: string;
}

/* ========================================================================== */
/*  Parser context and options                                                 */
/* ========================================================================== */

export interface ParseContext {
  readonly projectId: string;
  readonly runId: string;
  readonly conversationId: string | null;
  readonly taskId?: string | null;
  readonly agentId?: string | null;
  /**
   * True only when `--include-partial-messages` was actually passed AND the
   * installed CLI accepts it. It decides where output deltas come from: from
   * `content_block_delta` when partial streaming is on, and reconstructed from
   * whole `assistant` messages when it is off. Getting this wrong duplicates
   * every character of the answer.
   */
  readonly partialMessagesEnabled: boolean;
  /** True when the run was started with `--resume`. Picks the session event. */
  readonly resumed: boolean;
  /**
   * Path (project-relative where possible) of the file the raw stdout is being
   * written to. Every event points at the line it came from, so any claim on
   * screen can be traced back to a byte on disk.
   */
  readonly stdoutRef?: string | null;
  /**
   * Off by default. A tool result can be a whole file, so echoing it into the
   * event log is a credential-leak vector and a disk-space problem at once.
   */
  readonly includeToolResultExcerpt?: boolean;
  readonly maxResultTextChars?: number;
  readonly now?: () => Date;
}

const DEFAULT_MAX_RESULT_TEXT_CHARS = 64 * 1024;

/** Counts the parser accumulated. Every one is an observation, not a guess. */
export interface StreamCounters {
  readonly lines: number;
  readonly toolCalls: number;
  readonly skillUses: number;
  readonly toolErrors: number;
  readonly parseErrors: number;
  readonly unrecognisedLines: number;
  readonly compactions: number;
  readonly subagentContexts: number;
  readonly textChars: number;
  readonly toolsAnnouncedWithoutStart: number;
  readonly toolResultsWithoutStart: number;
}

interface StartedTool {
  readonly toolUseId: string;
  readonly name: string;
  readonly parentToolUseId: string | null;
}

/* ========================================================================== */
/*  The parser                                                                 */
/* ========================================================================== */

/**
 * Stateful over one run's stdout. Feed it whole lines in order; it returns the
 * events that line justified, and nothing else.
 *
 * It never throws for bad input. A line it cannot parse produces a
 * `bridge.degraded` event carrying the line number and a capped excerpt, and
 * parsing continues — a malformed line must never crash the run and must never
 * silently vanish. `bridge.degraded` rather than `run.error` is a deliberate
 * choice: our failure to read a line is not evidence that the run failed, and
 * labelling it `run.error` would be exactly the kind of false claim this system
 * exists to prevent.
 */
export class ClaudeStreamParser {
  private readonly ctx: ParseContext;
  private readonly now: () => Date;
  private readonly maxResultTextChars: number;

  private sessionId: string | null = null;
  private modelId: string | null = null;
  private permissionMode: string | null = null;

  private readonly startedTools = new Map<string, StartedTool>();
  private readonly announcedToolIds = new Set<string>();
  private readonly toolIdByBlockIndex = new Map<number, string>();
  private readonly subagentContexts = new Set<string>();

  private lines = 0;
  private toolCalls = 0;
  private skillUses = 0;
  private toolErrors = 0;
  private parseErrors = 0;
  private unrecognisedLines = 0;
  private compactions = 0;
  private textChars = 0;
  private toolResultsWithoutStart = 0;

  private interimTokens: RawTokenUsage | null = null;
  private finalTokens: RawTokenUsage | null = null;
  private modelUsageTable: unknown = null;
  private totalCostUsd: number | null = null;
  private numTurns: number | null = null;
  private durationMs: number | null = null;
  private resultSeen = false;
  private resultIsError: boolean | null = null;
  private latencySamplesMs: number[] = [];

  constructor(context: ParseContext) {
    this.ctx = context;
    this.now = context.now ?? (() => new Date());
    this.maxResultTextChars = context.maxResultTextChars ?? DEFAULT_MAX_RESULT_TEXT_CHARS;
  }

  /* ------------------------------------------------------------- accessors */

  /** The session id the runtime reported. Null until it actually reports one. */
  get claudeSessionId(): string | null {
    return this.sessionId;
  }

  /** The model from `system/init`, which is the form `modelUsage` is keyed by. */
  get model(): string | null {
    return this.modelId;
  }

  /** True once a `result` envelope was seen. The only proof a turn finished. */
  get sawResult(): boolean {
    return this.resultSeen;
  }

  get resultWasError(): boolean | null {
    return this.resultIsError;
  }

  counters(): StreamCounters {
    return {
      lines: this.lines,
      toolCalls: this.toolCalls,
      skillUses: this.skillUses,
      toolErrors: this.toolErrors,
      parseErrors: this.parseErrors,
      unrecognisedLines: this.unrecognisedLines,
      compactions: this.compactions,
      subagentContexts: this.subagentContexts.size,
      textChars: this.textChars,
      toolsAnnouncedWithoutStart: [...this.announcedToolIds].filter((id) => !this.startedTools.has(id)).length,
      toolResultsWithoutStart: this.toolResultsWithoutStart,
    };
  }

  /** Feed one measured stdout-chunk-to-line latency, in ms, for the p95 field. */
  recordLatencySample(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.latencySamplesMs.push(ms);
  }

  /* ------------------------------------------------------------------ input */

  /**
   * Parse one line. Returns every event it justified, in order.
   *
   * `lineNumber` is 1-based and is what the evidence ref points at, so it must
   * be the line's position in the persisted stdout file, not in this parser.
   */
  pushLine(raw: string, lineNumber: number): readonly ForgeEventDraft[] {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    this.lines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return [
        this.parseErrorEvent(
          'claude.stream.unparsable-line',
          lineNumber,
          raw,
          error instanceof Error ? error.message : String(error),
        ),
      ];
    }

    const line = asRecord(parsed);
    if (line === null) {
      return [
        this.parseErrorEvent(
          'claude.stream.not-an-object',
          lineNumber,
          raw,
          `top-level JSON value is ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object`,
        ),
      ];
    }

    const type = asString(line.type);
    if (type === null) {
      return [this.parseErrorEvent('claude.stream.missing-type', lineNumber, raw, 'no string "type" field')];
    }

    // A session id can appear on any line; the first one wins and later ones are
    // only recorded if we still have none, so a stray line cannot rewrite it.
    const lineSession = asString(line.session_id);
    if (lineSession !== null && this.sessionId === null) this.sessionId = lineSession;

    switch (type) {
      case 'system':
        return this.handleSystem(line, lineNumber);
      case 'stream_event':
        return this.handleStreamEvent(line, lineNumber);
      case 'assistant':
        return this.handleAssistant(line, lineNumber);
      case 'user':
        return this.handleUser(line, lineNumber);
      case 'rate_limit_event':
        return this.handleRateLimit(line, lineNumber);
      case 'result':
        return this.handleResult(line, lineNumber);
      default:
        this.unrecognisedLines += 1;
        return [
          this.message(
            'unrecognised',
            null,
            { rawType: type, keys: Object.keys(line).slice(0, 40) },
            lineNumber,
          ),
        ];
    }
  }

  /**
   * Called by the adapter once the process has exited and every line has been
   * fed in. Returns a final usage snapshot built from whatever the stream
   * actually produced — which may be nothing, in which case every field is
   * honestly UNAVAILABLE.
   */
  finalSnapshot(options: { readonly stale?: boolean; readonly elapsedMsFallback?: number | null } = {}): UsageSnapshot {
    return this.buildSnapshot(this.resultSeen, options.stale ?? false, options.elapsedMsFallback ?? null);
  }

  /* -------------------------------------------------------------- handlers */

  private handleSystem(line: JsonRecord, lineNumber: number): readonly ForgeEventDraft[] {
    const subtype = asString(line.subtype);

    if (subtype === 'init') {
      this.sessionId = asString(line.session_id) ?? this.sessionId;
      this.modelId = asString(line.model) ?? this.modelId;
      this.permissionMode = asString(line.permissionMode) ?? this.permissionMode;
      const tools = asArray(line.tools);
      const agents = asArray(line.agents);
      const skills = asArray(line.skills);
      return [
        this.draft(this.ctx.resumed ? 'session.resumed' : 'session.started', {
          sessionId: this.sessionId,
          model: this.modelId,
          permissionMode: this.permissionMode,
          cwd: asString(line.cwd),
          claudeCodeVersion: asString(line.claude_code_version),
          // The NAME of the credential source, never a credential. Observed
          // value on this machine: "none" — the local session, no API key.
          apiKeySource: asString(line.apiKeySource),
          toolCount: tools === null ? null : tools.length,
          agentCount: agents === null ? null : agents.length,
          skillCount: skills === null ? null : skills.length,
          outputStyle: asString(line.output_style),
        }, lineNumber),
      ];
    }

    if (subtype === 'thinking_tokens') {
      // The runtime labels this `estimated_tokens`. It is passed through as a
      // message and never added to a token total: see the header.
      return [
        this.message('thinking-tokens', subtype, {
          estimatedTokens: asNumber(line.estimated_tokens),
          estimatedTokensDelta: asNumber(line.estimated_tokens_delta),
          note: 'reported by the runtime as an estimate; not folded into any UsageField',
        }, lineNumber),
      ];
    }

    return [
      this.message('system', subtype, { status: asString(line.status), keys: Object.keys(line).slice(0, 40) }, lineNumber),
    ];
  }

  private handleStreamEvent(line: JsonRecord, lineNumber: number): readonly ForgeEventDraft[] {
    const event = asRecord(line.event);
    if (event === null) {
      return [this.parseErrorEvent('claude.stream.missing-type', lineNumber, JSON.stringify(line), 'stream_event has no "event" object')];
    }
    const innerType = asString(event.type);
    const parentToolUseId = asString(line.parent_tool_use_id);
    if (parentToolUseId !== null) this.subagentContexts.add(parentToolUseId);

    switch (innerType) {
      case 'message_start': {
        const message = asRecord(event.message);
        if (message !== null && this.modelId === null) this.modelId = asString(message.model);
        const tokens = message === null ? null : readTokenUsage(message.usage);
        if (tokens !== null) this.interimTokens = tokens;
        return [];
      }

      case 'content_block_start': {
        const block = asRecord(event.content_block);
        const index = asNumber(event.index);
        if (block === null) return [];
        if (asString(block.type) === 'tool_use') {
          const id = asString(block.id);
          if (id !== null) {
            // ANNOUNCED, not started. At this point `input` is `{}` — the
            // arguments are still streaming in. Emitting claude.tool.start here
            // would claim a tool call whose subject we cannot describe, so the
            // id is only registered; the start event comes from the completed
            // assistant message.
            this.announcedToolIds.add(id);
            if (index !== null) this.toolIdByBlockIndex.set(index, id);
          }
        }
        return [];
      }

      case 'content_block_delta': {
        const delta = asRecord(event.delta);
        const index = asNumber(event.index);
        if (delta === null) return [];
        const deltaType = asString(delta.type);

        if (deltaType === 'text_delta') {
          const text = asString(delta.text) ?? '';
          if (text.length === 0) return [];
          this.textChars += text.length;
          return [this.outputDelta('text', text, index, false, lineNumber)];
        }
        if (deltaType === 'thinking_delta') {
          const text = asString(delta.thinking) ?? '';
          if (text.length === 0) return [];
          return [this.outputDelta('thinking', text, index, false, lineNumber)];
        }
        if (deltaType === 'input_json_delta') {
          const partial = asString(delta.partial_json) ?? '';
          if (partial.length === 0) return [];
          return [
            this.message('tool-input-delta', null, {
              toolUseId: index === null ? null : (this.toolIdByBlockIndex.get(index) ?? null),
              blockIndex: index,
              partialJson: safeExcerpt(partial, 2000),
            }, lineNumber),
          ];
        }
        return [];
      }

      case 'message_delta': {
        const tokens = readTokenUsage(event.usage);
        if (tokens !== null) this.interimTokens = tokens;
        const management = asRecord(event.context_management);
        const edits = management === null ? null : asArray(management.applied_edits);
        if (edits !== null && edits.length > 0) this.compactions += edits.length;
        if (tokens === null) return [];
        return [this.usageEvent(false, lineNumber)];
      }

      case 'content_block_stop':
      case 'message_stop':
        return [];

      default:
        return [];
    }
  }

  private handleAssistant(line: JsonRecord, lineNumber: number): readonly ForgeEventDraft[] {
    const message = asRecord(line.message);
    if (message === null) return [];
    const parentToolUseId = asString(line.parent_tool_use_id);
    if (parentToolUseId !== null) this.subagentContexts.add(parentToolUseId);
    const messageId = asString(message.id);
    const content = asArray(message.content) ?? [];
    const drafts: ForgeEventDraft[] = [];
    const blockKinds: string[] = [];

    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (block === null) continue;
      const blockType = asString(block.type);
      blockKinds.push(blockType ?? 'unknown');

      if (blockType === 'tool_use') {
        const id = asString(block.id);
        const name = asString(block.name);
        if (id === null || name === null) continue;
        if (this.startedTools.has(id)) continue;
        this.startedTools.set(id, { toolUseId: id, name, parentToolUseId });
        this.toolCalls += 1;
        // Heuristic, and named as one: a skill invocation shows up as a tool
        // call whose tool name is exactly "Skill". If the runtime ever renames
        // it this count silently goes to zero, which is why the source string
        // on the field records the rule.
        if (name === 'Skill') this.skillUses += 1;
        const payload: ClaudeToolStartPayload = {
          toolUseId: id,
          toolName: name,
          input: block.input ?? null,
          parentToolUseId,
          messageId,
        };
        drafts.push(this.draft('claude.tool.start', payload, lineNumber));
        continue;
      }

      // When partial streaming is unavailable the whole message IS the delta.
      // When it is available the characters already went out one at a time, and
      // re-emitting them here would double every answer on screen.
      if (!this.ctx.partialMessagesEnabled && blockType === 'text') {
        const text = asString(block.text) ?? '';
        if (text.length > 0) {
          this.textChars += text.length;
          drafts.push(this.outputDelta('text', text, null, true, lineNumber));
        }
      }
      if (!this.ctx.partialMessagesEnabled && blockType === 'thinking') {
        const text = asString(block.thinking) ?? '';
        if (text.length > 0) drafts.push(this.outputDelta('thinking', text, null, true, lineNumber));
      }
    }

    drafts.push(
      this.message('assistant', null, {
        messageId,
        model: asString(message.model),
        stopReason: asString(message.stop_reason),
        blockKinds,
        parentToolUseId,
      }, lineNumber),
    );
    return drafts;
  }

  private handleUser(line: JsonRecord, lineNumber: number): readonly ForgeEventDraft[] {
    const message = asRecord(line.message);
    if (message === null) return [];
    const parentToolUseId = asString(line.parent_tool_use_id);
    if (parentToolUseId !== null) this.subagentContexts.add(parentToolUseId);
    const toolMeta = asRecord(line.tool_use_result);
    const content = asArray(message.content);
    const drafts: ForgeEventDraft[] = [];

    if (content === null) {
      const text = asString(message.content);
      return [this.message('user', null, { textLength: text === null ? null : text.length }, lineNumber)];
    }

    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (block === null) continue;
      if (asString(block.type) !== 'tool_result') {
        drafts.push(this.message('user', asString(block.type), { blockType: asString(block.type) }, lineNumber));
        continue;
      }

      const toolUseId = asString(block.tool_use_id);
      if (toolUseId === null) continue;
      const started = this.startedTools.get(toolUseId) ?? null;
      if (started === null) this.toolResultsWithoutStart += 1;
      const isError = asBoolean(block.is_error) ?? false;
      if (isError) this.toolErrors += 1;

      const resultContent = block.content;
      const asText = asString(resultContent);
      const serialised = asText ?? (resultContent === undefined ? null : JSON.stringify(resultContent) ?? null);

      const payload: ClaudeToolEndPayload = {
        toolUseId,
        // Null, not a guess. A result whose start we never saw is a result whose
        // tool we do not know.
        toolName: started?.name ?? null,
        isError,
        durationMs: toolMeta === null ? null : asNumber(toolMeta.durationMs),
        resultBytes: serialised === null ? null : serialised.length,
        resultExcerpt: this.ctx.includeToolResultExcerpt === true && serialised !== null ? safeExcerpt(serialised, 1000) : null,
        parentToolUseId: started?.parentToolUseId ?? parentToolUseId,
      };
      drafts.push(this.draft('claude.tool.end', payload, lineNumber));
    }

    return drafts;
  }

  private handleRateLimit(line: JsonRecord, lineNumber: number): readonly ForgeEventDraft[] {
    const info = asRecord(line.rate_limit_info);
    return [
      this.message('rate-limit', null, {
        status: info === null ? null : asString(info.status),
        rateLimitType: info === null ? null : asString(info.rateLimitType),
        resetsAtEpochSeconds: info === null ? null : asNumber(info.resetsAt),
        overageStatus: info === null ? null : asString(info.overageStatus),
        isUsingOverage: info === null ? null : asBoolean(info.isUsingOverage),
        note:
          'the runtime reports a window state and a reset time and no quota, ' +
          'so plan usage remains UNAVAILABLE',
      }, lineNumber),
    ];
  }

  private handleResult(line: JsonRecord, lineNumber: number): readonly ForgeEventDraft[] {
    this.resultSeen = true;
    this.resultIsError = asBoolean(line.is_error);
    this.finalTokens = readTokenUsage(line.usage) ?? this.interimTokens;
    this.modelUsageTable = line.modelUsage ?? null;
    this.totalCostUsd = asNumber(line.total_cost_usd);
    this.numTurns = asNumber(line.num_turns);
    this.durationMs = asNumber(line.duration_ms);
    this.sessionId = asString(line.session_id) ?? this.sessionId;

    const rawResult = asString(line.result);
    const truncated = rawResult !== null && rawResult.length > this.maxResultTextChars;
    const payload: RunOutputCompletePayload = {
      subtype: asString(line.subtype),
      isError: this.resultIsError,
      stopReason: asString(line.stop_reason),
      terminalReason: asString(line.terminal_reason),
      numTurns: this.numTurns,
      durationMs: this.durationMs,
      durationApiMs: asNumber(line.duration_api_ms),
      sessionId: this.sessionId,
      resultText: rawResult === null ? null : truncated ? rawResult.slice(0, this.maxResultTextChars) : rawResult,
      resultTruncated: truncated,
      permissionDenials: asArray(line.permission_denials),
      apiErrorStatus: line.api_error_status ?? null,
    };

    return [this.draft('run.output.complete', payload, lineNumber), this.usageEvent(true, lineNumber)];
  }

  /* ------------------------------------------------------------- snapshots */

  private usageEvent(final: boolean, lineNumber: number): ForgeEventDraft<ClaudeUsagePayload> {
    const payload: ClaudeUsagePayload = { snapshot: this.buildSnapshot(final, false, null), final };
    return this.draft('claude.usage', payload, lineNumber);
  }

  /**
   * Assemble the snapshot.
   *
   * Read the `source` strings: each one names the exact field of the exact line
   * the number came from, so a value on screen can be audited back to the
   * runtime that produced it — or shown to be something we counted ourselves.
   */
  private buildSnapshot(final: boolean, stale: boolean, elapsedMsFallback: number | null): UsageSnapshot {
    const at = this.now().toISOString();
    const tokens = final ? (this.finalTokens ?? this.interimTokens) : (this.interimTokens ?? this.finalTokens);
    const origin = final ? 'claude-code:2.1.217 result.usage' : 'claude-code:2.1.217 stream_event.message_delta.usage';

    const entry = resolveModelUsageEntry(this.modelUsageTable, this.modelId);

    const contextTokensUsed =
      tokens === null
        ? null
        : sumIfAllPresent([tokens.inputTokens, tokens.cacheReadTokens, tokens.cacheCreationTokens, tokens.outputTokens]);
    const contextWindow = entry?.contextWindow ?? null;
    const contextPercent =
      contextTokensUsed !== null && contextWindow !== null && contextWindow > 0
        ? (contextTokensUsed / contextWindow) * 100
        : null;

    const p95 = percentile(this.latencySamplesMs, 95);
    const elapsed = this.durationMs ?? elapsedMsFallback;

    return {
      scope: 'run',
      scopeId: this.ctx.runId,
      sessionId: this.sessionId,

      model: usageField<string>('model', this.modelId, 'none', 'claude-code:2.1.217 system/init.model', 'EXACT', at),

      // Verified by reading every key of a real `system/init` line and a real
      // `result` envelope: neither carries the effort level. What the adapter
      // requested is recorded on the run.state event, where it is plainly a
      // request and not a report.
      effort: unavailableField<string>(
        'effort',
        'none',
        'not reported by claude-code 2.1.217 (absent from system/init and from the result envelope)',
        at,
      ),

      inputTokens: usageField('inputTokens', tokens?.inputTokens ?? null, 'tokens', `${origin}.input_tokens`, 'EXACT', at),
      outputTokens: usageField('outputTokens', tokens?.outputTokens ?? null, 'tokens', `${origin}.output_tokens`, 'EXACT', at),
      cacheReadTokens: usageField(
        'cacheReadTokens',
        tokens?.cacheReadTokens ?? null,
        'tokens',
        `${origin}.cache_read_input_tokens`,
        'EXACT',
        at,
      ),
      cacheCreationTokens: usageField(
        'cacheCreationTokens',
        tokens?.cacheCreationTokens ?? null,
        'tokens',
        `${origin}.cache_creation_input_tokens`,
        'EXACT',
        at,
      ),

      contextTokensUsed: usageField(
        'contextTokensUsed',
        contextTokensUsed,
        'tokens',
        `DERIVED: input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens, all from ${origin}`,
        'DERIVED',
        at,
      ),
      contextWindow: usageField(
        'contextWindow',
        contextWindow,
        'tokens',
        entry === null
          ? 'result.modelUsage did not contain an entry that could be matched to the session model without guessing'
          : `claude-code:2.1.217 result.modelUsage["${entry.key}"].contextWindow`,
        'EXACT',
        at,
      ),
      contextPercent: usageField(
        'contextPercent',
        contextPercent,
        'percent',
        'DERIVED: contextTokensUsed / contextWindow × 100',
        'DERIVED',
        at,
      ),

      costUsd: usageField('costUsd', this.totalCostUsd, 'usd', 'claude-code:2.1.217 result.total_cost_usd', 'EXACT', at),
      turns: usageField('turns', this.numTurns, 'count', 'claude-code:2.1.217 result.num_turns', 'EXACT', at),

      toolCalls: usageField(
        'toolCalls',
        this.toolCalls,
        'count',
        'DERIVED: distinct tool_use blocks observed on this run\'s stream',
        'DERIVED',
        at,
      ),
      agentCount: usageField(
        'agentCount',
        this.subagentContexts.size,
        'count',
        'DERIVED: distinct non-null parent_tool_use_id values observed on this run\'s stream',
        'DERIVED',
        at,
      ),
      skillUses: usageField(
        'skillUses',
        this.skillUses,
        'count',
        'DERIVED: tool_use blocks whose tool name is exactly "Skill"',
        'DERIVED',
        at,
      ),
      errors: usageField(
        'errors',
        this.toolErrors + this.parseErrors + (this.resultIsError === true ? 1 : 0),
        'count',
        'DERIVED: tool_result blocks with is_error true, plus unparsable stream lines, plus a result envelope with is_error true',
        'DERIVED',
        at,
      ),
      retries: unavailableField('retries', 'count', 'not reported by claude-code 2.1.217 and not observable from the stream', at),
      compactions: usageField(
        'compactions',
        this.compactions,
        'count',
        'DERIVED: entries in stream_event.message_delta.context_management.applied_edits',
        'DERIVED',
        at,
      ),

      elapsedMs: usageField(
        'elapsedMs',
        elapsed,
        'ms',
        this.durationMs !== null
          ? 'claude-code:2.1.217 result.duration_ms'
          : 'DERIVED: bridge-measured wall clock, because no result envelope arrived',
        this.durationMs !== null ? 'EXACT' : 'DERIVED',
        at,
      ),
      eventLatencyP95: usageField(
        'eventLatencyP95',
        p95,
        'ms',
        this.latencySamplesMs.length === 0
          ? 'no latency samples were recorded for this run'
          : `DERIVED: p95 over ${this.latencySamplesMs.length} bridge-measured stdout-chunk-to-event latencies`,
        'DERIVED',
        at,
      ),

      lastUpdate: at,
      stale,
      planUsage: unavailableField<string>('planUsage', 'none', PLAN_USAGE_UNAVAILABLE_MESSAGE, at),
    };
  }

  /* ---------------------------------------------------------------- helpers */

  private evidence(lineNumber: number): readonly EvidenceRef[] {
    const ref = this.ctx.stdoutRef ?? null;
    if (ref === null) return [];
    return [{ kind: 'stdout', ref: `${ref}#L${lineNumber}`, note: 'the stream-json line this event was read from' }];
  }

  private draft<P>(type: EventType, payload: P, lineNumber: number): ForgeEventDraft<P> {
    return {
      timestamp: this.now().toISOString(),
      projectId: this.ctx.projectId,
      runId: this.ctx.runId,
      sessionId: this.sessionId,
      conversationId: this.ctx.conversationId,
      taskId: this.ctx.taskId ?? null,
      agentId: this.ctx.agentId ?? null,
      source: 'claude-code',
      type,
      payload,
      evidenceRefs: this.evidence(lineNumber),
    };
  }

  private outputDelta(
    channel: OutputChannel,
    text: string,
    blockIndex: number | null,
    synthesized: boolean,
    lineNumber: number,
  ): ForgeEventDraft<RunOutputDeltaPayload> {
    return this.draft<RunOutputDeltaPayload>(
      'run.output.delta',
      { channel, text, blockIndex, synthesizedFromFullMessage: synthesized },
      lineNumber,
    );
  }

  private message(
    kind: ClaudeMessageKind,
    subtype: string | null,
    detail: JsonRecord,
    lineNumber: number,
  ): ForgeEventDraft<ClaudeMessagePayload> {
    return this.draft<ClaudeMessagePayload>('claude.message', { kind, subtype, detail }, lineNumber);
  }

  private parseErrorEvent(
    reason: StreamParseErrorReason,
    lineNumber: number,
    raw: string,
    detail: string,
  ): ForgeEventDraft<StreamParseErrorPayload> {
    this.parseErrors += 1;
    const payload: StreamParseErrorPayload = {
      reason,
      lineNumber,
      byteLength: Buffer.byteLength(raw, 'utf8'),
      detail,
      rawExcerpt: safeExcerpt(raw, 500),
    };
    return {
      ...this.draft<StreamParseErrorPayload>('bridge.degraded', payload, lineNumber),
      source: 'bridge',
      status: 'DEGRADED',
    };
  }
}

/* ========================================================================== */
/*  Small pure helpers                                                         */
/* ========================================================================== */

/**
 * Sum, but only when every part is present. A missing part would silently
 * become zero and turn "we do not know the cache read count" into a total that
 * looks authoritative and is wrong.
 */
export function sumIfAllPresent(parts: readonly (number | null)[]): number | null {
  let total = 0;
  for (const part of parts) {
    if (part === null) return null;
    total += part;
  }
  return total;
}

/** Nearest-rank percentile. Returns null for an empty sample — never 0. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index] ?? null;
}

/**
 * Split a growing stdout buffer into whole lines.
 *
 * Chunk boundaries land in the middle of lines constantly, and a 200 KB tool
 * result arrives as a dozen chunks. Returns the complete lines plus the
 * remainder to carry into the next chunk.
 */
export function splitLines(buffer: string): { readonly lines: readonly string[]; readonly rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)), rest };
}
