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

/** One server the bot is currently a member of (WP-v290-B beginner onboarding). */
export interface DiscordGuild {
  readonly id: string;
  readonly name: string;
}

export interface DiscordService {
  readonly installed: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly startedAt: string | null;
  /** `'mock'` | `'discord'` | `null`, verbatim from the gateway. */
  readonly transport: string | null;
  readonly ports: DiscordPorts;
  /** The bot's own health JSON when reachable — `null` otherwise. Shape is not fixed; render
   *  whatever keys are actually present, never assume one. The gateway deep-redacts every string
   *  field in this object before it ever crosses the HTTP boundary (WP-L2 finding 3), so this is
   *  never the raw, unredacted payload even though it is otherwise passed through structurally
   *  unchanged. */
  readonly health: Record<string, unknown> | null;
  /** An honest reason the service cannot start right now (e.g. another instance already
   *  listening), shown verbatim — `null` when there is no conflict. */
  readonly conflict: string | null;
  readonly envKeys: readonly DiscordEnvKey[];
  readonly stateDir: string;
  readonly logFile: string;
  /* ---- WP-v290-B (beginner onboarding): promoted top-level fields, same honesty contract as
   * every field above — an absent/unreachable value reads back null/[], never a guess. ---- */
  /** The bot's own Discord username, once logged in. */
  readonly username: string | null;
  /** The bot's real Discord application id — the OAuth2 invite URL's `client_id`. */
  readonly applicationId: string | null;
  /** Every server the bot is currently a member of. */
  readonly guilds: readonly DiscordGuild[];
  /** The ready-to-click OAuth2 invite URL, built from real discord.js permission flags. */
  readonly inviteUrl: string | null;
  /** The bot's own onboarding phase (e.g. `'awaiting-invite'`, `'awaiting-guild-selection'`,
   *  `'ready'`, `'login-failed'`), verbatim — drives which wizard step the view shows. */
  readonly setupState: string | null;
  /** A plain-language reason the LAST connection attempt failed (bad token, Message Content
   *  Intent not enabled, ...), verbatim from the bot itself — `null` when there is no failure to
   *  report. Only meaningful together with `setupState === 'login-failed'`. */
  readonly loginError: string | null;
  /* ---- WP-P1 (Forge v2.9.0): the bot's own npm dependencies (discord.js) may need a one-time
   * automatic install on a fresh machine/central install — reported so the wizard can show an
   * honest status instead of a silent multi-minute pause on the first "Connect" click. ---- */
  readonly depsInstalled: boolean;
  /** `'installed'` | `'installing'` | `'failed'` | `'not-installed'`, verbatim from the gateway. */
  readonly depsInstallPhase: string | null;
  /** A plain-language reason the LAST automatic install attempt failed — `null` when there is
   *  none to report. Only meaningful together with `depsInstallPhase === 'failed'`. */
  readonly depsInstallError: string | null;
  /** v2.9.0 WP-DA: whether the bot comes back by itself when the Command Center starts. `null` when
   *  the gateway predates this field (never a guessed "yes"). */
  readonly autostart: DiscordAutostart | null;
}

/** v2.9.0 WP-DA — the `autostart` block of `GET /api/discord/status`, verbatim. */
export interface DiscordAutostart {
  /** The owner setting `discord-autostart`; `null` when it could not be read (the default, on, applies). */
  readonly setting: boolean | null;
  /** The owner's own last choice (dashboard switch, Connect Discord, server pick); `null` when none yet. */
  readonly desired: 'running' | 'stopped' | null;
  /** The saved choice exists but cannot be read — treated as unknown, so the bot is not started. */
  readonly desiredInvalid: boolean;
  readonly desiredNote: string | null;
  /** Codex DA-1: can the bot be started at all (installed and connected)? Reported apart from the setting. */
  readonly ready: boolean;
  readonly readyReason: string | null;
  /** Codex DA-3: this Command Center process was started with CC_DISCORD_AUTOSTART=off. */
  readonly envOptOut: boolean;
  /** Codex DA-3: another process already answers on the bot port, so no bot would be started — verbatim. */
  readonly conflict: string | null;
  /** True only when the bot will TRY to start by itself next time: setting on, not switched off, ready. */
  readonly effective: boolean;
  /** Codex DA-2: the last failed save of the owner's on/off choice, verbatim — `null` when none. */
  readonly saveError: string | null;
  /** What happened at the last Command Center start (`'started'` | `'skipped'` | `'failed'`), verbatim. */
  readonly lastOutcome: string | null;
  /** The plain-language reason for that outcome, already redacted by the gateway. */
  readonly lastDetail: string | null;
  readonly lastAt: string | null;
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
  username: null,
  applicationId: null,
  guilds: [],
  inviteUrl: null,
  setupState: null,
  loginError: null,
  depsInstalled: false,
  depsInstallPhase: null,
  depsInstallError: null,
  autostart: null,
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

function toGuild(row: Record<string, unknown>): DiscordGuild {
  return {
    id: pickString(row, ['id']) ?? '',
    name: pickString(row, ['name']) ?? '',
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
    username: pickString(service, ['username']),
    applicationId: pickString(service, ['application_id']),
    guilds: pickArray(service, ['guilds']).map(toGuild),
    inviteUrl: pickString(service, ['invite_url']),
    setupState: pickString(service, ['setup_state']),
    loginError: pickString(service, ['login_error']),
    depsInstalled: pickBool(service, ['deps_installed']) ?? false,
    depsInstallPhase: pickString(service, ['deps_install_phase']),
    depsInstallError: pickString(service, ['deps_install_error']),
    autostart: toAutostart(pickRecord(service, ['autostart'])),
  };
}

/** WP-DA: maps the `autostart` block; an absent block (an older gateway) stays `null`. */
function toAutostart(raw: Record<string, unknown> | null): DiscordAutostart | null {
  if (raw === null) return null;
  const desired = pickString(raw, ['desired']);
  const last = pickRecord(raw, ['last']);
  const saveError = pickRecord(raw, ['save_error']);
  return {
    setting: pickBool(raw, ['setting']),
    desired: desired === 'running' || desired === 'stopped' ? desired : null,
    desiredInvalid: pickBool(raw, ['desired_invalid']) ?? false,
    desiredNote: pickString(raw, ['desired_note']),
    // An older gateway without `ready` never gets a guessed "ready": false is the honest default.
    ready: pickBool(raw, ['ready']) ?? false,
    readyReason: pickString(raw, ['ready_reason']),
    envOptOut: pickBool(raw, ['env_opt_out']) ?? false,
    conflict: pickString(raw, ['conflict']),
    effective: pickBool(raw, ['effective']) ?? false,
    saveError: saveError !== null ? pickString(saveError, ['detail']) : null,
    lastOutcome: last !== null ? pickString(last, ['outcome']) : null,
    lastDetail: last !== null ? pickString(last, ['detail']) : null,
    lastAt: last !== null ? pickString(last, ['at']) : null,
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
  /** WP-DA (Codex DA-2): the bot started, but the gateway could not save the owner's "on" — its own
   *  plain warning, verbatim. `null` when the choice was saved (or an older gateway said nothing). */
  readonly warning: string | null;
}

/** WP-DA: `remembered:false` comes with the gateway's own warning; anything else means nothing to warn. */
function choiceWarning(data: Record<string, unknown>): string | null {
  return pickBool(data, ['remembered']) === false ? pickString(data, ['warning']) : null;
}

/** `POST /api/discord/start` — 202 `{ok:true, pid}` | 409 `{ok:false, error}`. Never optimistic:
 *  the caller must wait for the next `useGatewayDiscordStatus` poll to see `running` flip. */
export async function requestDiscordStart(): Promise<DiscordStartResult> {
  const result = await gwPost('/api/discord/start', {}, execHeaders());
  if (!result.ok) return { ok: false, pid: null, error: result.error, warning: null };
  return { ok: true, pid: pickNumber(result.data, ['pid']), error: null, warning: choiceWarning(result.data) };
}

export interface DiscordStopResult {
  readonly ok: boolean;
  readonly stopped: boolean;
  readonly error: string | null;
  /** WP-DA (Codex DA-2): the bot stopped, but the gateway could not save the owner's "off". */
  readonly warning: string | null;
}

/** `POST /api/discord/stop` — 200 `{ok:true, stopped:boolean}`. Same no-optimism rule as start. */
export async function requestDiscordStop(): Promise<DiscordStopResult> {
  const result = await gwPost('/api/discord/stop', {}, execHeaders());
  if (!result.ok) return { ok: false, stopped: false, error: result.error, warning: null };
  return { ok: true, stopped: pickBool(result.data, ['stopped']) ?? false, error: null, warning: choiceWarning(result.data) };
}

export interface DiscordConnectResult {
  readonly ok: boolean;
  readonly pid: number | null;
  /** The gateway's own real error text (verbatim) — a bad token format, a save failure, or
   *  anything startDiscordService() itself can fail with. Never a client-invented message. */
  readonly error: string | null;
}

/**
 * `POST /api/discord/connect` — WP-v290-B's ONE beginner-facing "log in" action: sends the pasted
 * token (and an optional already-known guildId) to the gateway, which validates the FORMAT, saves
 * it, and starts the bot. The token is sent over the loopback-only gateway connection and is never
 * stored by this module — it exists only for the duration of this one call.
 */
export async function requestDiscordConnect(token: string, guildId?: string): Promise<DiscordConnectResult> {
  const body: Record<string, string> = { token };
  if (guildId !== undefined && guildId.length > 0) body.guildId = guildId;
  const result = await gwPost('/api/discord/connect', body, execHeaders());
  if (!result.ok) return { ok: false, pid: null, error: result.error };
  return { ok: true, pid: pickNumber(result.data, ['pid']), error: null };
}

export interface DiscordSelectGuildResult {
  readonly ok: boolean;
  readonly pid: number | null;
  readonly error: string | null;
}

/**
 * `POST /api/discord/guild` — the owner's explicit pick when the bot is in several servers and
 * auto-detect could not choose alone (`service.setupState === 'awaiting-guild-selection'`, pick
 * from `service.guilds`).
 */
export async function requestDiscordSelectGuild(guildId: string): Promise<DiscordSelectGuildResult> {
  const result = await gwPost('/api/discord/guild', { guildId }, execHeaders());
  if (!result.ok) return { ok: false, pid: null, error: result.error };
  return { ok: true, pid: pickNumber(result.data, ['pid']), error: null };
}
