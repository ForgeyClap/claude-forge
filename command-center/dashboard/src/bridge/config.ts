/**
 * Forge Workspace — bridge configuration.
 *
 * Two kinds of setting live in this file and they are treated completely
 * differently.
 *
 * 1. SECURITY CONSTANTS. `BIND_ADDRESS`, `LAN_MODE` and `REMOTE_ACCESS` are
 *    `const` declarations with no environment path into them. There is no
 *    `process.env` read that can change any of the three, and `loadConfig`
 *    REFUSES TO PRODUCE A CONFIG at all if an environment variable that looks
 *    like an attempt to flip them is present. Widening the bridge beyond
 *    loopback therefore requires editing this file — a diff, a review, and a
 *    commit — rather than an env var somebody exports once and forgets.
 *
 *    Silently ignoring such a variable would be worse than refusing: the
 *    operator would believe the bridge was on the LAN, and would act on that
 *    belief. Refusing to start is the only outcome that cannot mislead.
 *
 * 2. OPERATIONAL SETTINGS. Port, heartbeat interval, body limit and the extra
 *    allowed origins are tunable, because getting them wrong is an annoyance,
 *    not a breach. Each one is parsed, range-checked, and rejected with a
 *    specific message when it is not usable — never silently defaulted, because
 *    "I set the port and it ignored me" is its own class of bug.
 *
 * This module reads the environment and nothing else. It opens no file, spawns
 * no process and performs no network call.
 */

import process from 'node:process';

import { REQUIRED_BIND_ADDRESS } from '../shared/protocol.ts';

/* ========================================================================== */
/*  Frozen security constants                                                  */
/* ========================================================================== */

/**
 * The only interface the bridge may listen on.
 *
 * 127.0.0.1 and not 'localhost': on Windows 'localhost' resolves to ::1 first,
 * which would leave the IPv4 loopback unserved and make every 127.0.0.1 client
 * (including Playwright and the health probe) time out. It is also not
 * '0.0.0.0' — that would expose the bridge to every interface on the machine,
 * which is exactly what this constant exists to prevent.
 */
export const BIND_ADDRESS = '127.0.0.1';

/** LAN serving. Disabled in code. See `FUTURE_LAN_DESIGN` at the end of this file. */
export const LAN_MODE = false;

/** Remote access of any kind — tunnel, proxy, relay. Disabled in code. */
export const REMOTE_ACCESS = false;

/**
 * Compile-time proof that the literal above is exactly the address the contract
 * demands. If `REQUIRED_BIND_ADDRESS` in protocol.ts ever changes, this
 * assignment stops compiling instead of the two quietly drifting apart.
 * Exported so it counts as used under `noUnusedLocals`.
 */
export const BIND_ADDRESS_MATCHES_CONTRACT: typeof REQUIRED_BIND_ADDRESS = BIND_ADDRESS;

/**
 * Environment variables that would, if honoured, move the bridge off loopback
 * or switch on remote access. None of them is read for its value: the mere
 * presence of any one is a hard configuration error.
 *
 * `FORGE_BRIDGE_HOST` is included even though nothing reads it, because it is
 * the name an operator would reach for first, and a variable that appears to
 * work but does nothing is a trap.
 */
export const FROZEN_ENV_VARS: readonly string[] = [
  'FORGE_BRIDGE_BIND',
  'FORGE_BRIDGE_BIND_ADDRESS',
  'FORGE_BRIDGE_HOST',
  'FORGE_BRIDGE_HOSTNAME',
  'FORGE_BRIDGE_LAN',
  'FORGE_BRIDGE_LAN_MODE',
  'FORGE_BRIDGE_REMOTE',
  'FORGE_BRIDGE_REMOTE_ACCESS',
  'FORGE_BRIDGE_PUBLIC',
  'FORGE_BRIDGE_EXPOSE',
  'FORGE_BRIDGE_TUNNEL',
];

/* ========================================================================== */
/*  Defaults and limits                                                        */
/* ========================================================================== */

/** Chosen well away from Vite's 5173/4173 so the two never collide. */
export const DEFAULT_PORT = 4517;

export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const HEARTBEAT_MS_MIN = 1_000;
export const HEARTBEAT_MS_MAX = 300_000;

/** 1 MiB. An operation payload is ids and short strings; files are staged, not posted. */
export const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
export const MAX_REQUEST_BYTES_MIN = 1_024;
export const MAX_REQUEST_BYTES_MAX = 8_388_608;

/** How long a completed response stays in the idempotency cache. */
export const DEFAULT_REQUEST_CACHE_MS = 300_000;

/** Hard cap on cached responses, so a client cannot grow the cache forever. */
export const DEFAULT_REQUEST_CACHE_ENTRIES = 512;

/** How long shutdown waits for a registered task before recording a timeout. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/** Hostnames that are unambiguously this machine's loopback. */
export const LOCAL_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** Ports the UI is served from during development and preview. */
export const UI_ORIGIN_PORTS: readonly number[] = [5173, 4173];

/* ========================================================================== */
/*  Origin and Host validation                                                 */
/* ========================================================================== */

/**
 * Is this Origin header value a loopback web origin?
 *
 * Deliberately strict. `null` (a sandboxed iframe or a `file://` page) is NOT
 * accepted: those are precisely the contexts where a page the user did not
 * choose to run could be talking to the bridge. A hostname that merely contains
 * "localhost" — `localhost.attacker.com` — fails because the comparison is on
 * the parsed hostname, not on a substring.
 */
export function isLocalOrigin(origin: string): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (origin.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // An Origin never carries a path, a query or credentials. Anything that does
  // is not an Origin header, it is something being smuggled through one.
  if (url.username !== '' || url.password !== '') return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  if (url.search !== '' || url.hash !== '') return false;
  return LOCAL_HOSTNAMES.includes(url.hostname);
}

/**
 * Is this Host header pointing at our own loopback listener?
 *
 * This is the DNS-rebinding check. A hostile page cannot read a cross-origin
 * response, but it can make the browser resolve `evil.example` to 127.0.0.1 and
 * then issue same-origin requests to the bridge. Those requests carry
 * `Host: evil.example`, which fails here.
 */
export function isLocalHostHeader(host: string | undefined, expectedPort: number): boolean {
  if (typeof host !== 'string' || host.length === 0 || host.length > 512) return false;
  let hostname: string;
  let portPart: string;
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return false;
    hostname = host.slice(0, close + 1);
    portPart = host.slice(close + 1);
    if (portPart !== '' && !portPart.startsWith(':')) return false;
    portPart = portPart.slice(1);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon < 0) {
      hostname = host;
      portPart = '';
    } else {
      hostname = host.slice(0, colon);
      portPart = host.slice(colon + 1);
    }
  }
  if (!LOCAL_HOSTNAMES.includes(hostname)) return false;
  // No port means port 80, which is never our listener.
  if (portPart === '') return false;
  if (!/^\d{1,5}$/.test(portPart)) return false;
  return Number(portPart) === expectedPort;
}

function defaultAllowedOrigins(bridgePort: number): string[] {
  const origins: string[] = [];
  for (const host of ['127.0.0.1', 'localhost']) {
    for (const port of UI_ORIGIN_PORTS) origins.push(`http://${host}:${port}`);
    // The bridge's own origin, so a page served from the bridge (there is none
    // today, but a diagnostics page is a plausible future) still works.
    origins.push(`http://${host}:${bridgePort}`);
  }
  return origins;
}

/* ========================================================================== */
/*  The config                                                                 */
/* ========================================================================== */

export interface BridgeConfig {
  /** Always `127.0.0.1`. Asserted again by the server before it listens. */
  readonly bindAddress: string;
  readonly port: number;
  readonly lanMode: false;
  readonly remoteAccess: false;
  /** Exact Origin header values accepted on the WebSocket upgrade and on POSTs. */
  readonly allowedOrigins: readonly string[];
  readonly maxRequestBytes: number;
  readonly heartbeatIntervalMs: number;
  readonly requestCacheMs: number;
  readonly requestCacheEntries: number;
  readonly shutdownTimeoutMs: number;
  /** Explicit workspace data directory, when the operator named one. */
  readonly dataDir: string | null;
  /**
   * Settings that came from the environment rather than a default. Reported in
   * diagnostics so an operator can see what is actually in force — names only,
   * never values, and never anything outside the allowlist above.
   */
  readonly overrides: readonly string[];
}

export type ConfigResult =
  | { readonly ok: true; readonly config: BridgeConfig; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

type Env = Readonly<Record<string, string | undefined>>;

function parseInteger(
  raw: string,
  name: string,
  min: number,
  max: number,
  errors: string[],
): number | null {
  if (!/^-?\d{1,10}$/.test(raw.trim())) {
    errors.push(`${name} must be a whole number (got ${JSON.stringify(raw.slice(0, 40))}).`);
    return null;
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(`${name} must be between ${min} and ${max} (got ${value}).`);
    return null;
  }
  return value;
}

/**
 * Build the runtime config from the environment.
 *
 * Returns a result rather than throwing, and returns EVERY error rather than
 * the first one, so a misconfigured install is fixed in one pass instead of
 * five restarts.
 */
export function loadConfig(env: Env = process.env): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const overrides: string[] = [];

  // ---- the frozen three -------------------------------------------------
  for (const name of FROZEN_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined) continue;
    errors.push(
      `${name} is set, but the bridge's bind address, LAN mode and remote access are compile-time ` +
        `constants and cannot be changed by the environment. Unset ${name}. Widening the bridge ` +
        `beyond ${BIND_ADDRESS} requires editing src/bridge/config.ts and a security review.`,
    );
  }

  // ---- port -------------------------------------------------------------
  let port = DEFAULT_PORT;
  const rawPort = env.FORGE_BRIDGE_PORT;
  if (rawPort !== undefined && rawPort.trim() !== '') {
    const parsed = parseInteger(rawPort, 'FORGE_BRIDGE_PORT', PORT_MIN, PORT_MAX, errors);
    if (parsed !== null) {
      port = parsed;
      overrides.push('FORGE_BRIDGE_PORT');
    }
  }

  // ---- heartbeat --------------------------------------------------------
  let heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS;
  const rawHeartbeat = env.FORGE_BRIDGE_HEARTBEAT_MS;
  if (rawHeartbeat !== undefined && rawHeartbeat.trim() !== '') {
    const parsed = parseInteger(
      rawHeartbeat,
      'FORGE_BRIDGE_HEARTBEAT_MS',
      HEARTBEAT_MS_MIN,
      HEARTBEAT_MS_MAX,
      errors,
    );
    if (parsed !== null) {
      heartbeatIntervalMs = parsed;
      overrides.push('FORGE_BRIDGE_HEARTBEAT_MS');
    }
  }

  // ---- request body limit ----------------------------------------------
  let maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES;
  const rawBody = env.FORGE_BRIDGE_MAX_REQUEST_BYTES;
  if (rawBody !== undefined && rawBody.trim() !== '') {
    const parsed = parseInteger(
      rawBody,
      'FORGE_BRIDGE_MAX_REQUEST_BYTES',
      MAX_REQUEST_BYTES_MIN,
      MAX_REQUEST_BYTES_MAX,
      errors,
    );
    if (parsed !== null) {
      maxRequestBytes = parsed;
      overrides.push('FORGE_BRIDGE_MAX_REQUEST_BYTES');
    }
  }

  // ---- extra origins ----------------------------------------------------
  //
  // Additive only, and every entry must itself be a loopback origin. This exists
  // for a UI served from a non-standard local port, not as a back door to
  // `Access-Control-Allow-Origin: *`.
  const allowed = new Set<string>(defaultAllowedOrigins(port));
  const rawOrigins = env.FORGE_BRIDGE_EXTRA_ORIGINS;
  if (rawOrigins !== undefined && rawOrigins.trim() !== '') {
    const parts = rawOrigins
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length > 16) {
      errors.push('FORGE_BRIDGE_EXTRA_ORIGINS lists more than 16 origins; that is not a local setup.');
    }
    for (const candidate of parts.slice(0, 16)) {
      if (!isLocalOrigin(candidate)) {
        errors.push(
          `FORGE_BRIDGE_EXTRA_ORIGINS contains ${JSON.stringify(candidate.slice(0, 80))}, which is not a ` +
            `loopback origin. Only http(s) origins on ${LOCAL_HOSTNAMES.join(', ')} may be added.`,
        );
        continue;
      }
      allowed.add(new URL(candidate).origin);
    }
    if (parts.length > 0) overrides.push('FORGE_BRIDGE_EXTRA_ORIGINS');
  }

  // ---- data directory ---------------------------------------------------
  //
  // Passed through to the store, which does its own absolute-path and
  // not-a-filesystem-root validation. Recorded here only so diagnostics can say
  // the workspace location was overridden.
  let dataDir: string | null = null;
  const rawDataDir = env.FORGE_WORKSPACE_DIR;
  if (rawDataDir !== undefined && rawDataDir.trim() !== '') {
    dataDir = rawDataDir.trim();
    overrides.push('FORGE_WORKSPACE_DIR');
  }

  if (heartbeatIntervalMs < 5_000) {
    warnings.push(
      `heartbeat interval ${heartbeatIntervalMs}ms is aggressive; every connected client is woken that often.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    warnings,
    config: {
      bindAddress: BIND_ADDRESS,
      port,
      lanMode: LAN_MODE,
      remoteAccess: REMOTE_ACCESS,
      allowedOrigins: [...allowed].sort(),
      maxRequestBytes,
      heartbeatIntervalMs,
      requestCacheMs: DEFAULT_REQUEST_CACHE_MS,
      requestCacheEntries: DEFAULT_REQUEST_CACHE_ENTRIES,
      shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      dataDir,
      overrides,
    },
  };
}

/**
 * A description of the config that is safe to log, return over the API and put
 * in a diagnostics bundle. It contains no environment values — only the names of
 * the variables that were honoured.
 */
export function describeConfig(config: BridgeConfig): Record<string, unknown> {
  return {
    bindAddress: config.bindAddress,
    port: config.port,
    lanMode: config.lanMode,
    remoteAccess: config.remoteAccess,
    allowedOrigins: config.allowedOrigins,
    maxRequestBytes: config.maxRequestBytes,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    requestCacheMs: config.requestCacheMs,
    requestCacheEntries: config.requestCacheEntries,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    workspaceDirOverridden: config.dataDir !== null,
    overrides: config.overrides,
  };
}

/* ========================================================================== */
/*  Future LAN design — DISABLED                                               */
/* ========================================================================== */

/*
 * If LAN access is ever wanted, this is the shape it must take. It is written
 * down so that the eventual change is a review of a known design rather than an
 * improvisation under time pressure. NOTHING BELOW IS IMPLEMENTED.
 *
 *  1. A new constant `LAN_MODE = true` in THIS FILE, in a reviewed commit. No
 *     env var, no CLI flag, no settings toggle in the UI. The blast radius of
 *     this switch is the whole machine, so it must cost a code review.
 *
 *  2. Bind address stays a fixed allowlist, never `0.0.0.0`. The operator names
 *     one interface address; the server enumerates the machine's interfaces and
 *     refuses to bind an address it cannot find, so a typo fails closed instead
 *     of falling back to "everything".
 *
 *  3. TLS becomes mandatory. Over loopback a plaintext socket cannot leave the
 *     machine; over a LAN it is on the wire. That means a certificate, which
 *     means a trust decision, which means the UI must show the fingerprint.
 *
 *  4. Authentication becomes mandatory and must be per-client, not a shared
 *     bearer token: a token that every device holds is a credential nobody can
 *     revoke. The Origin check stays, but it stops being sufficient — an Origin
 *     header is trivially forged by a non-browser client.
 *
 *  5. The operation allowlist SHRINKS on LAN. Filesystem verbs
 *     (`readProjectFile`, `listProjectFiles`, `getFileDiff`, `stageAttachment`)
 *     and `runApprovedTest` must be denied to a non-loopback client outright;
 *     path containment protects the trusted root, not the machine's owner from
 *     a device on their coffee-shop wifi.
 *
 *  6. Per-client rate limiting and a connection cap become required, because
 *     the set of possible clients stops being "processes the user already
 *     trusts on their own machine".
 *
 *  7. `RUNTIME_DECLARATIONS.LAN_MODE` in protocol.ts must change in the SAME
 *     commit, and the runtime-declarations test must be updated to match — the
 *     declaration is a claim about reality and would otherwise become false.
 *
 * REMOTE_ACCESS has no design here on purpose. Tunnels, relays and reverse
 * proxies put an operation surface that can write files and spawn processes on
 * the public internet. That is not a feature with a safe configuration.
 */
