/**
 * gateway-discord — the Discord↔Forge remote-control bot's status and on/off actions
 * (WP-D2, forge-2026-07-30-discord).
 *
 * Reads `GET /api/discord/status` (no `?project=` — this route reports one gateway-wide
 * service, not a per-project view, per the fixed contract this WP was built against) and
 * exposes the two write routes, `POST /api/discord/start` / `POST /api/discord/stop`, through
 * the same `gwGet`/`gwPost` + `pick*` house style every other `gateway-*.ts` module in this
 * folder already uses (see `gateway-recovery.ts`'s and `gateway-agent-dispatches.ts`'s own
 * headers for the identical convention: one tiny parse function, one poll hook, never a shared
 * cross-file factory).
 *
 * HONESTY CONTRACT (mirrors `gateway-capabilities.ts`'s header):
 *   - a missing/absent field on the wire becomes `null`/an empty value, never a guessed default.
 *   - `health` is rendered defensively by the view (its shape is not fixed) — this module only
 *     ever returns it as a plain record or `null`, never invents fields inside it.
 *   - `ports.manager` is always `null` per the fixed API contract (the contract literally types
 *     it as the `null` singleton) — there is nothing to parse for it.
 *   - starting/stopping never mutates local "running" state optimistically. Both actions return
 *     only what the gateway's response said (`pid` / `stopped`) or a real error string; the
 *     view is the one that waits for the NEXT status poll before it ever shows a changed switch.
 *
 * Poll cadence: `HEALTH_POLL_MS` (5s) — the same cadence `adapter/connection.ts` already uses
 * for its own live health check, since a start/stop control needs to feel responsive on the
 * next poll rather than the slower 15s `gateway-capabilities.ts` uses for read-mostly panels.
 */

import { useEffect, useState } from 'react';

import {
  EXEC_TOKEN_HEADER,
  gwGet,
  gwPost,
  pickArray,
  pickBool,
  pickNumber,
  pickRecord,
  pickString,
  readExecToken,
} from '@/prototype/state/gateway-client';
import { HEALTH_POLL_MS } from '@/prototype/state/adapter/connection';

/* ------------------------------------------------------------------- types */

export interface DiscordEnvKey {
  readonly name: string;
  readonly present: boolean;
}

export interface DiscordPorts {
  readonly bot: number | null;
  /** Always `null` per the fixed API contract. */
  readonly manager: null;
}

export interface DiscordService {
  readonly installed: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly startedAt: string | null;
  /** `'mock'` | `'discord'` | `null`, verbatim from the gateway. */
  readonly transport: string | null;
  readonly ports: DiscordPorts;
  /** The bot's own health JSON, verbatim, when reachable — `null` otherwise. Shape is not fixed;
   *  render whatever keys are actually present, never assume one. */
  readonly health: Record<string, unknown> | null;
  /** An honest reason the service cannot start right now (e.g. another instance already
   *  listening), shown verbatim — `null` when there is no conflict. */
  readonly conflict: string | null;
  readonly envKeys: readonly DiscordEnvKey[];
  readonly stateDir: string;
  readonly logFile: string;
}

export const EMPTY_DISCORD_SERVICE: DiscordService = {
  installed: false,
  running: false,
  pid: null,
  startedAt: null,
  transport: null,
  ports: { bot: null, manager: null },
  health: null,
  conflict: null,
  envKeys: [],
  stateDir: '',
  logFile: '',
};

/** `{ loading, error, data }` — mirrors `gateway-capabilities.ts`'s `GatewayFetchState<T>` shape,
 *  the same distinguishable loading/error/empty presentation Settings already relies on. */
export interface GatewayDiscordState {
  /** True only until the FIRST response (success or failure) resolves. */
  readonly loading: boolean;
  /** The real transport/HTTP error from the most recent failed poll, or `null` when the most
   *  recent poll succeeded (or none has run yet). The last known-good `data` is kept regardless. */
  readonly error: string | null;
  readonly data: DiscordService;
}

/* -------------------------------------------------------------------- parse */

function toEnvKey(row: Record<string, unknown>): DiscordEnvKey {
  return {
    name: pickString(row, ['name']) ?? '',
    present: pickBool(row, ['present']) ?? false,
  };
}

/** Maps `GET /api/discord/status`'s real `service` object 1:1 onto `DiscordService`. An absent
 *  `service` field (a malformed/unexpected response) reads back the honest empty constant. */
export function parseDiscordService(data: Record<string, unknown>): DiscordService {
  const service = pickRecord(data, ['service']);
  if (service === null) return EMPTY_DISCORD_SERVICE;

  const ports = pickRecord(service, ['ports']);

  return {
    installed: pickBool(service, ['installed']) ?? false,
    running: pickBool(service, ['running']) ?? false,
    pid: pickNumber(service, ['pid']),
    startedAt: pickString(service, ['started_at']),
    transport: pickString(service, ['transport']),
    ports: { bot: ports !== null ? pickNumber(ports, ['bot']) : null, manager: null },
    health: pickRecord(service, ['health']),
    conflict: pickString(service, ['conflict']),
    envKeys: pickArray(service, ['env_keys']).map(toEnvKey),
    stateDir: pickString(service, ['state_dir']) ?? '',
    logFile: pickString(service, ['log_file']) ?? '',
  };
}

/* --------------------------------------------------------------------- poll */

/** Polls `GET /api/discord/status` every `HEALTH_POLL_MS`. Not project-scoped — the fixed
 *  contract this route was built against carries no `?project=` parameter. */
export function useGatewayDiscordStatus(): GatewayDiscordState {
  const [state, setState] = useState<{ resolved: boolean; error: string | null; data: DiscordService }>({
    resolved: false,
    error: null,
    data: EMPTY_DISCORD_SERVICE,
  });

  useEffect(() => {
    let cancelled = false;

    async function tick(): Promise<void> {
      const result = await gwGet('/api/discord/status');
      if (cancelled) return;
      if (result.ok) {
        setState({ resolved: true, error: null, data: parseDiscordService(result.data) });
      } else {
        setState((current) => ({ resolved: true, error: result.error, data: current.data }));
      }
    }

    void tick();
    const id = setInterval(() => void tick(), HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { loading: !state.resolved, error: state.error, data: state.data };
}

/* ------------------------------------------------------------------- actions */

function execHeaders(): Record<string, string> {
  const token = readExecToken();
  return token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};
}

export interface DiscordStartResult {
  readonly ok: boolean;
  readonly pid: number | null;
  /** The gateway's own real error text (verbatim) on a 409 conflict or any other failure. */
  readonly error: string | null;
}

/** `POST /api/discord/start` — 202 `{ok:true, pid}` | 409 `{ok:false, error}`. Never optimistic:
 *  the caller must wait for the next `useGatewayDiscordStatus` poll to see `running` flip. */
export async function requestDiscordStart(): Promise<DiscordStartResult> {
  const result = await gwPost('/api/discord/start', {}, execHeaders());
  if (!result.ok) return { ok: false, pid: null, error: result.error };
  return { ok: true, pid: pickNumber(result.data, ['pid']), error: null };
}

export interface DiscordStopResult {
  readonly ok: boolean;
  readonly stopped: boolean;
  readonly error: string | null;
}

/** `POST /api/discord/stop` — 200 `{ok:true, stopped:boolean}`. Same no-optimism rule as start. */
export async function requestDiscordStop(): Promise<DiscordStopResult> {
  const result = await gwPost('/api/discord/stop', {}, execHeaders());
  if (!result.ok) return { ok: false, stopped: false, error: result.error };
  return { ok: true, stopped: pickBool(result.data, ['stopped']) ?? false, error: null };
}
