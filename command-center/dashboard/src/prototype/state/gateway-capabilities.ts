/**
 * Forge Command Center — model routing, tool inventory, MCP servers and Claude
 * install capabilities (forge-2026-07-29-cc-finish, WP wire-capabilities).
 *
 * Exposes 5 real, tested gateway endpoints — `GET /api/models`,
 * `GET /api/tools`, `GET /api/mcp`, `GET /api/capabilities` (this WP) and
 * `GET /api/config` (forge-2026-09-24-config-v250 wp12: the active project's
 * Forge settings, read-only) — in the exact house style `gateway-recovery.ts`
 * already established for this seam: `gwGet` + the `pick*` defensive
 * extractors from `gateway-client.ts`, one hook per route, a 15s poll, and the
 * same honesty contract stated in that file's header —
 *
 *   a missing field becomes `null`/absence, NEVER a plausible default.
 *
 * (The one exception, matching `gateway-recovery.ts`'s own precedent for
 * `GatewayDocdriftFinding.drifted`: a genuinely boolean field with no real
 * "unknown" state on the wire — `has_test`, `credentials_needed`,
 * `opted_in`, `present` — defaults to `false` on absence, the same neutral
 * choice that file already made, not a fabricated "yes".)
 *
 * NEW IN THIS FILE, not in `gateway-recovery.ts`: every hook returns a
 * `GatewayFetchState<T>` — `{ loading, error, data }` — because this WP's task
 * explicitly calls for a distinguishable loading/error/empty presentation in
 * Settings, and `gateway-recovery.ts`'s bare parsed-object return has no way
 * to tell "gateway unreachable" apart from "asked, got a real empty answer".
 * A private `useGatewayPoll<T>` factors the identical fetch/poll/cancel
 * wiring once (DRY) rather than pasting it five times; each of the five
 * EXPORTED hooks below is still exactly "one hook per route" at the public
 * API surface. On a failed poll, the LAST known-good `data` is kept (never
 * wiped to a fabricated empty state) while `error` carries the real transport
 * message — mirrors `gateway-adapter.ts`'s own connection store keeping its
 * last good reading through a failed health check.
 *
 * `GET /api/models` carries no `?project=` — it reports THIS gateway's own
 * installation (the model-capability matrix + a live NVIDIA probe), not a
 * per-project view — see `models.mjs`'s own header. The other four take the
 * selected project's name, exactly like `gateway-recovery.ts`'s hooks
 * (`state.activeProjectId`, `''` meaning none selected yet).
 */

import { useEffect, useState } from 'react';

import {
  asRecord,
  gwGet,
  pickArray,
  pickBool,
  pickNumber,
  pickRecord,
  pickString,
  pickStringArray,
} from '@/prototype/state/gateway-client';

const POLL_MS = 15000;

/** `{ loading, error, data }` — see this file's header for why every hook
 *  here returns this shape rather than `gateway-recovery.ts`'s bare object. */
export interface GatewayFetchState<T> {
  /** True only until the FIRST response (success or failure) resolves. */
  readonly loading: boolean;
  /** The real transport/HTTP error from the most recent failed poll, or
   *  `null` when the most recent poll succeeded (or none has run yet). */
  readonly error: string | null;
  readonly data: T;
}

/**
 * Shared fetch/poll/cancel wiring for every hook in this file. `parse` and
 * `empty` are always module-level pure functions/constants (stable identity
 * across renders), so they are safe dependency-array entries. `url === null`
 * skips fetching entirely — the project-scoped hooks use this while no
 * project is selected, mirroring `gateway-recovery.ts`'s own
 * `projectName === ''` guard.
 */
function useGatewayPoll<T>(
  url: string | null,
  parse: (data: Record<string, unknown>) => T,
  empty: T,
): GatewayFetchState<T> {
  const [state, setState] = useState<{ resolved: boolean; error: string | null; data: T }>({
    resolved: false,
    error: null,
    data: empty,
  });

  useEffect(() => {
    if (url === null) return undefined;
    const activeUrl = url; // narrowed to `string`, captured for the closure below
    let cancelled = false;

    async function tick(): Promise<void> {
      const result = await gwGet(activeUrl);
      if (cancelled) return;
      if (result.ok) {
        setState({ resolved: true, error: null, data: parse(result.data) });
      } else {
        setState((current) => ({ resolved: true, error: result.error, data: current.data }));
      }
    }

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [url, parse, empty]);

  return { loading: !state.resolved, error: state.error, data: state.data };
}

/* ========================================================================== */
/*  1. Models — GET /api/models (this gateway's own install, no ?project=)   */
/* ========================================================================== */

export interface GatewayModelRole {
  readonly role: string;
  readonly model: string | null;
  readonly envOverride: string | null;
  readonly why: string | null;
}

export interface GatewayModelCatalogEntry {
  readonly id: string;
  readonly caps: readonly string[];
  readonly ctx: number | null;
  readonly tier: string | null;
  readonly probe: string | null;
  readonly verified: string | null;
}

export interface GatewayNvidiaHealth {
  readonly state: string | null;
  readonly models: number | null;
  readonly ms: number | null;
  readonly baseUrl: string | null;
  readonly ageMs: number | null;
  readonly note: string | null;
}

export interface GatewayModels {
  readonly ok: boolean;
  readonly matrixAvailable: boolean;
  readonly matrixError: string | null;
  readonly roles: readonly GatewayModelRole[];
  readonly catalog: readonly GatewayModelCatalogEntry[];
  readonly brokenCount: number | null;
  readonly latestVerifiedDate: string | null;
  readonly nvidia: GatewayNvidiaHealth | null;
  readonly capturedAt: string | null;
  readonly provenance: string | null;
}

export const EMPTY_GATEWAY_MODELS: GatewayModels = {
  ok: false,
  matrixAvailable: false,
  matrixError: null,
  roles: [],
  catalog: [],
  brokenCount: null,
  latestVerifiedDate: null,
  nvidia: null,
  capturedAt: null,
  provenance: null,
};

function toModelRoles(rolesObj: Record<string, unknown> | null): readonly GatewayModelRole[] {
  if (rolesObj === null) return [];
  const roles: GatewayModelRole[] = [];
  for (const [name, value] of Object.entries(rolesObj)) {
    const row = asRecord(value);
    if (row === null) continue;
    roles.push({
      role: name,
      model: pickString(row, ['model']),
      envOverride: pickString(row, ['envOverride']),
      why: pickString(row, ['why']),
    });
  }
  return roles;
}

function toModelCatalogEntry(row: Record<string, unknown>): GatewayModelCatalogEntry {
  return {
    id: pickString(row, ['id']) ?? '',
    caps: pickStringArray(row, ['caps']),
    ctx: pickNumber(row, ['ctx']),
    tier: pickString(row, ['tier']),
    probe: pickString(row, ['probe']),
    verified: pickString(row, ['verified']),
  };
}

function toNvidiaHealth(row: Record<string, unknown> | null): GatewayNvidiaHealth | null {
  if (row === null) return null;
  return {
    state: pickString(row, ['state']),
    models: pickNumber(row, ['models']),
    ms: pickNumber(row, ['ms']),
    baseUrl: pickString(row, ['base_url']),
    ageMs: pickNumber(row, ['age_ms']),
    note: pickString(row, ['note']),
  };
}

/** Maps `GET /api/models`'s real response 1:1 — every field is real, derived
 *  from a real response, or explicitly absent (never invented). */
export function parseGatewayModels(data: Record<string, unknown>): GatewayModels {
  return {
    ok: pickBool(data, ['ok']) ?? false,
    matrixAvailable: pickBool(data, ['matrix_available']) ?? false,
    matrixError: pickString(data, ['matrix_error']),
    roles: toModelRoles(pickRecord(data, ['roles'])),
    catalog: pickArray(data, ['catalog']).map(toModelCatalogEntry),
    brokenCount: pickNumber(data, ['broken_count']),
    latestVerifiedDate: pickString(data, ['latest_verified_date']),
    nvidia: toNvidiaHealth(pickRecord(data, ['nvidia'])),
    capturedAt: pickString(data, ['captured_at']),
    provenance: pickString(data, ['provenance']),
  };
}

/** Polls this gateway's own model-routing view. No `?project=` — see this
 *  file's header. */
export function useGatewayModels(): GatewayFetchState<GatewayModels> {
  return useGatewayPoll('/api/models', parseGatewayModels, EMPTY_GATEWAY_MODELS);
}

/* ========================================================================== */
/*  2. Tools — GET /api/tools?project=                                       */
/* ========================================================================== */

export interface GatewayToolEntry {
  readonly name: string;
  readonly hasTest: boolean;
  readonly size: number | null;
  readonly mtime: string | null;
}

export interface GatewayTools {
  readonly ok: boolean;
  readonly tools: readonly GatewayToolEntry[];
  readonly toolsCount: number | null;
  readonly note: string | null;
  readonly error: string | null;
  readonly capturedAt: string | null;
  readonly provenance: string | null;
}

export const EMPTY_GATEWAY_TOOLS: GatewayTools = {
  ok: false,
  tools: [],
  toolsCount: null,
  note: null,
  error: null,
  capturedAt: null,
  provenance: null,
};

function toToolEntry(row: Record<string, unknown>): GatewayToolEntry {
  return {
    name: pickString(row, ['name']) ?? '',
    hasTest: pickBool(row, ['has_test']) ?? false,
    size: pickNumber(row, ['size']),
    mtime: pickString(row, ['mtime']),
  };
}

/** Maps `GET /api/tools`'s real response 1:1 — the selected project's own
 *  `.claude/forge-bin/*.cjs` inventory, read-only (this module never
 *  executes a tool). */
export function parseGatewayTools(data: Record<string, unknown>): GatewayTools {
  return {
    ok: pickBool(data, ['ok']) ?? false,
    tools: pickArray(data, ['tools']).map(toToolEntry),
    toolsCount: pickNumber(data, ['tools_count']),
    note: pickString(data, ['note']),
    error: pickString(data, ['error']),
    capturedAt: pickString(data, ['captured_at']),
    provenance: pickString(data, ['provenance']),
  };
}

/** Polls the selected project's own tool inventory. */
export function useGatewayTools(projectName: string): GatewayFetchState<GatewayTools> {
  const url = projectName !== '' ? `/api/tools?project=${encodeURIComponent(projectName)}` : null;
  return useGatewayPoll(url, parseGatewayTools, EMPTY_GATEWAY_TOOLS);
}

/* ========================================================================== */
/*  3. MCP — GET /api/mcp?project=                                           */
/* ========================================================================== */

export interface GatewayMcpServer {
  readonly id: string;
  readonly purpose: string | null;
  readonly tier: number | null;
  readonly network: string | null;
  readonly credentialsNeeded: boolean;
  readonly status: string | null;
  readonly optedIn: boolean;
  readonly notes: string | null;
}

export interface GatewayBossGrant {
  readonly slug: string;
  readonly maxTier: number | null;
  readonly allowServers: readonly string[];
  readonly why: string | null;
}

export interface GatewayMcp {
  readonly ok: boolean;
  readonly servers: readonly GatewayMcpServer[];
  readonly serversCount: number | null;
  readonly installedCount: number | null;
  readonly optedInCount: number | null;
  readonly bossGrants: readonly GatewayBossGrant[];
  readonly registryPresent: boolean | null;
  readonly grantsPresent: boolean | null;
  readonly optInFilePresent: boolean | null;
  readonly error: string | null;
  readonly capturedAt: string | null;
  readonly provenance: string | null;
}

export const EMPTY_GATEWAY_MCP: GatewayMcp = {
  ok: false,
  servers: [],
  serversCount: null,
  installedCount: null,
  optedInCount: null,
  bossGrants: [],
  registryPresent: null,
  grantsPresent: null,
  optInFilePresent: null,
  error: null,
  capturedAt: null,
  provenance: null,
};

function toMcpServer(row: Record<string, unknown>): GatewayMcpServer {
  return {
    id: pickString(row, ['id']) ?? '',
    purpose: pickString(row, ['purpose']),
    tier: pickNumber(row, ['tier']),
    network: pickString(row, ['network']),
    credentialsNeeded: pickBool(row, ['credentials_needed']) ?? false,
    status: pickString(row, ['status']),
    optedIn: pickBool(row, ['opted_in']) ?? false,
    notes: pickString(row, ['notes']),
  };
}

function toBossGrant(row: Record<string, unknown>): GatewayBossGrant {
  return {
    slug: pickString(row, ['slug']) ?? '',
    maxTier: pickNumber(row, ['max_tier']),
    allowServers: pickStringArray(row, ['allow_servers']),
    why: pickString(row, ['why']),
  };
}

/** Maps `GET /api/mcp`'s real response 1:1 — the dormant server catalog plus
 *  the per-Boss least-privilege grant matrix. A server's `opted_in` is only
 *  ever `true` when a real, owner-authored `mcp-opt-in.json` lists it — see
 *  `mcp.mjs`'s own header. */
export function parseGatewayMcp(data: Record<string, unknown>): GatewayMcp {
  return {
    ok: pickBool(data, ['ok']) ?? false,
    servers: pickArray(data, ['servers']).map(toMcpServer),
    serversCount: pickNumber(data, ['servers_count']),
    installedCount: pickNumber(data, ['installed_count']),
    optedInCount: pickNumber(data, ['opted_in_count']),
    bossGrants: pickArray(data, ['boss_grants']).map(toBossGrant),
    registryPresent: pickBool(data, ['registry_present']),
    grantsPresent: pickBool(data, ['grants_present']),
    optInFilePresent: pickBool(data, ['opt_in_file_present']),
    error: pickString(data, ['error']),
    capturedAt: pickString(data, ['captured_at']),
    provenance: pickString(data, ['provenance']),
  };
}

/** Polls the selected project's own MCP registry + grant matrix. */
export function useGatewayMcp(projectName: string): GatewayFetchState<GatewayMcp> {
  const url = projectName !== '' ? `/api/mcp?project=${encodeURIComponent(projectName)}` : null;
  return useGatewayPoll(url, parseGatewayMcp, EMPTY_GATEWAY_MCP);
}

/* ========================================================================== */
/*  4. Capabilities — GET /api/capabilities?project=                         */
/* ========================================================================== */

export interface GatewayCapabilityEntry {
  readonly capability: string;
  readonly name: string | null;
  readonly kind: string | null;
  readonly present: boolean;
  readonly status: string | null;
  readonly timesUsed: number | null;
  readonly lastUsedRun: string | null;
  readonly lastUsedTs: string | null;
}

export interface GatewayCapabilitySummary {
  readonly total: number | null;
  readonly active: number | null;
  readonly dormant: number | null;
  readonly optIn: number | null;
  readonly neverUsed: number | null;
}

export interface GatewayCapabilities {
  readonly ok: boolean;
  readonly available: boolean;
  readonly state: string | null;
  readonly note: string | null;
  readonly capabilities: readonly GatewayCapabilityEntry[];
  readonly summary: GatewayCapabilitySummary | null;
  readonly capturedAt: string | null;
  readonly provenance: string | null;
}

export const EMPTY_GATEWAY_CAPABILITIES: GatewayCapabilities = {
  ok: false,
  available: false,
  state: null,
  note: null,
  capabilities: [],
  summary: null,
  capturedAt: null,
  provenance: null,
};

function toCapabilityEntry(row: Record<string, unknown>): GatewayCapabilityEntry {
  return {
    capability: pickString(row, ['capability']) ?? '',
    name: pickString(row, ['name']),
    kind: pickString(row, ['kind']),
    present: pickBool(row, ['present']) ?? false,
    status: pickString(row, ['status']),
    timesUsed: pickNumber(row, ['times_used']),
    lastUsedRun: pickString(row, ['last_used_run']),
    lastUsedTs: pickString(row, ['last_used_ts']),
  };
}

function toCapabilitySummary(row: Record<string, unknown> | null): GatewayCapabilitySummary | null {
  if (row === null) return null;
  return {
    total: pickNumber(row, ['total']),
    active: pickNumber(row, ['active']),
    dormant: pickNumber(row, ['dormant']),
    optIn: pickNumber(row, ['opt_in']),
    neverUsed: pickNumber(row, ['never_used']),
  };
}

/** Maps `GET /api/capabilities`'s real response 1:1 — the selected project's
 *  own `forge-capabilities.cjs report --json`, the one allowlisted
 *  forge-bin execution this whole gateway permits (see `capabilities.mjs`'s
 *  own header). `state: 'UNAVAILABLE'` on a timeout/spawn-failure is
 *  reported honestly, never masked as a real reading. */
export function parseGatewayCapabilities(data: Record<string, unknown>): GatewayCapabilities {
  return {
    ok: pickBool(data, ['ok']) ?? false,
    available: pickBool(data, ['available']) ?? false,
    state: pickString(data, ['state']),
    note: pickString(data, ['note']),
    capabilities: pickArray(data, ['capabilities']).map(toCapabilityEntry),
    summary: toCapabilitySummary(pickRecord(data, ['summary'])),
    capturedAt: pickString(data, ['captured_at']),
    provenance: pickString(data, ['provenance']),
  };
}

/** Polls the selected project's own Claude-install / Forge-tooling
 *  capability report. */
export function useGatewayCapabilities(projectName: string): GatewayFetchState<GatewayCapabilities> {
  const url = projectName !== '' ? `/api/capabilities?project=${encodeURIComponent(projectName)}` : null;
  return useGatewayPoll(url, parseGatewayCapabilities, EMPTY_GATEWAY_CAPABILITIES);
}

/* ========================================================================== */
/*  5. Forge settings — GET /api/config?project= (read-only)                 */
/* ========================================================================== */

/** A setting's raw value as the tool reports it — on/off, a number or a word. */
export type GatewayForgeSettingValue = boolean | number | string;

export interface GatewayForgeSetting {
  readonly key: string;
  readonly value: GatewayForgeSettingValue | null;
  readonly defaultValue: GatewayForgeSettingValue | null;
  readonly display: string | null;
  /** `'on'`, `'off'`, or `null` for a setting with no on/off meaning. */
  readonly status: string | null;
  readonly source: string | null;
  readonly scope: string | null;
  readonly group: string | null;
  readonly type: string | null;
  readonly unit: string | null;
  readonly desc: string | null;
  readonly offMeans: string | null;
  readonly disclosure: string | null;
  readonly flags: readonly string[];
  readonly setAt: string | null;
  readonly setBy: string | null;
}

export interface GatewayForgeGroup {
  readonly id: string;
  readonly title: string | null;
}

export interface GatewayForgeLocked {
  readonly id: string;
  readonly text: string | null;
  readonly source: string | null;
}

export interface GatewayForgeConfigFile {
  readonly path: string | null;
  readonly pretty: string | null;
  readonly present: boolean;
}

export interface GatewayForgeConfig {
  readonly ok: boolean;
  readonly available: boolean;
  readonly state: string | null;
  readonly note: string | null;
  readonly settings: readonly GatewayForgeSetting[];
  readonly locked: readonly GatewayForgeLocked[];
  readonly groups: readonly GatewayForgeGroup[];
  readonly globalFile: GatewayForgeConfigFile | null;
  readonly projectFile: GatewayForgeConfigFile | null;
  readonly notes: readonly string[];
  readonly hidden: number | null;
  readonly lang: string | null;
  readonly project: string | null;
  readonly capturedAt: string | null;
  readonly provenance: string | null;
}

export const EMPTY_GATEWAY_FORGE_CONFIG: GatewayForgeConfig = {
  ok: false,
  available: false,
  state: null,
  note: null,
  settings: [],
  locked: [],
  groups: [],
  globalFile: null,
  projectFile: null,
  notes: [],
  hidden: null,
  lang: null,
  project: null,
  capturedAt: null,
  provenance: null,
};

/** A raw setting value: kept only when it is a real on/off, finite number or
 *  non-empty word — anything else is `null`, never a coerced stand-in. */
function pickSettingValue(row: Record<string, unknown>, key: string): GatewayForgeSettingValue | null {
  const value = row[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return null;
}

function toForgeSetting(row: Record<string, unknown>): GatewayForgeSetting {
  return {
    key: pickString(row, ['key']) ?? '',
    value: pickSettingValue(row, 'value'),
    defaultValue: pickSettingValue(row, 'default'),
    display: pickString(row, ['display']),
    status: pickString(row, ['status']),
    source: pickString(row, ['source']),
    scope: pickString(row, ['scope']),
    group: pickString(row, ['group']),
    type: pickString(row, ['type']),
    unit: pickString(row, ['unit']),
    desc: pickString(row, ['desc']),
    offMeans: pickString(row, ['off_means']),
    disclosure: pickString(row, ['disclosure']),
    flags: pickStringArray(row, ['flags']),
    setAt: pickString(row, ['set_at']),
    setBy: pickString(row, ['set_by']),
  };
}

function toForgeGroup(row: Record<string, unknown>): GatewayForgeGroup {
  return { id: pickString(row, ['id']) ?? '', title: pickString(row, ['title']) };
}

function toForgeLocked(row: Record<string, unknown>): GatewayForgeLocked {
  return {
    id: pickString(row, ['id']) ?? '',
    text: pickString(row, ['text']),
    source: pickString(row, ['source']),
  };
}

function toForgeConfigFile(row: Record<string, unknown> | null): GatewayForgeConfigFile | null {
  if (row === null) return null;
  return {
    path: pickString(row, ['path']),
    pretty: pickString(row, ['pretty']),
    present: pickBool(row, ['present']) ?? false,
  };
}

/** Maps `GET /api/config`'s real response 1:1 — the selected project's own
 *  `forge-config.cjs list --json --all`, spawned read-only by the gateway
 *  (see `config.mjs`'s own header). `state: 'UNAVAILABLE'` (no script, a
 *  timeout, a damaged settings file) is reported honestly with the real
 *  note, never masked as a set of default settings. */
export function parseGatewayForgeConfig(data: Record<string, unknown>): GatewayForgeConfig {
  const files = pickRecord(data, ['files']);
  return {
    ok: pickBool(data, ['ok']) ?? false,
    available: pickBool(data, ['available']) ?? false,
    state: pickString(data, ['state']),
    note: pickString(data, ['note']),
    settings: pickArray(data, ['settings']).map(toForgeSetting),
    locked: pickArray(data, ['locked']).map(toForgeLocked),
    groups: pickArray(data, ['groups']).map(toForgeGroup),
    globalFile: toForgeConfigFile(pickRecord(files, ['global'])),
    projectFile: toForgeConfigFile(pickRecord(files, ['project'])),
    notes: pickStringArray(data, ['notes']),
    hidden: pickNumber(data, ['hidden']),
    lang: pickString(data, ['lang']),
    project: pickString(data, ['project']),
    capturedAt: pickString(data, ['captured_at']),
    provenance: pickString(data, ['provenance']),
  };
}

/** Polls the selected project's own Forge settings (read-only — a setting is
 *  changed in chat or with `/forge config set`, never from this hook). */
export function useGatewayForgeConfig(projectName: string): GatewayFetchState<GatewayForgeConfig> {
  const url = projectName !== '' ? `/api/config?project=${encodeURIComponent(projectName)}` : null;
  return useGatewayPoll(url, parseGatewayForgeConfig, EMPTY_GATEWAY_FORGE_CONFIG);
}
