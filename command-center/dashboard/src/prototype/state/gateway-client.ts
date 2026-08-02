/**
 * Forge Command Center — the gateway's HTTP/SSE primitives.
 *
 * WP7b (`gateway-adapter.ts` / `gateway-chat.ts` build on this). No React here —
 * this file is pure transport: a fetch/EventSource wrapper plus the small,
 * defensive JSON-extraction helpers this codebase already uses in
 * `store-adapter.ts` / `graph-builder.ts` / `live-store.ts` (each file keeps its
 * own tiny copy rather than sharing one utility module — the existing
 * convention this file follows).
 *
 * TRANSPORT CHOICE (see `gateway-adapter.ts`'s header for the full 3-line
 * justification): REST polling + Server-Sent Events, never the bridge's 39-op
 * WebSocket protocol. `GATEWAY_ORIGIN` is a hardcoded loopback literal — the
 * same convention `bridge-client.ts` documents for "the one legitimate place
 * the frontend reaches its own loopback backend": reach the network only via
 * `globalThis.fetch` / `globalThis.EventSource`, never the bare identifier
 * (the repo's `no-restricted-globals`/`no-restricted-syntax` ESLint rules and
 * `tests/unit/no-runtime-contact.test.ts`'s loopback-host scan both already
 * accept this exact shape with zero rule changes — verified against the gateway's
 * own :4100 port, which is a different port than the bridge's :4517 but the same
 * loopback host).
 */

/** The gateway's own origin. Literal and loopback-only, on purpose — see header. */
export const GATEWAY_ORIGIN = 'http://127.0.0.1:4100';

/**
 * fix-sec-round #1 (HIGH): the header name for the gateway's per-boot exec token — MUST stay in
 * sync with `gateway/src/security.mjs`'s own `EXEC_TOKEN_HEADER` literal (two separate builds/
 * packages, so this is a hardcoded mirror, not a shared import — the same convention this file
 * already uses for `GATEWAY_ORIGIN` itself).
 */
export const EXEC_TOKEN_HEADER = 'x-cc-exec-token';

const EXEC_TOKEN_META_NAME = 'cc-exec-token';

/**
 * Reads the real per-boot exec token the gateway injects into its own served HTML (see
 * `gateway/src/static.mjs`'s `injectExecToken`) as a `<meta name="cc-exec-token">` tag. Returns
 * `null` when the tag is absent — a test/jsdom render that never loaded the real served HTML, or a
 * gateway build that predates this fix — so a caller degrades honestly (the gateway then answers
 * with a real 403 for a non-'plan' send) rather than guessing or fabricating a token.
 */
export function readExecToken(): string | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector(`meta[name="${EXEC_TOKEN_META_NAME}"]`);
  const content = meta ? meta.getAttribute('content') : null;
  return content !== null && content.trim().length > 0 ? content : null;
}

/** The real command that starts the gateway, shown in the honest DISCONNECTED state. */
export const GATEWAY_START_COMMAND = 'node command-center/gateway/bin.mjs';

function gatewayUrl(path: string): string {
  return `${GATEWAY_ORIGIN}${path}`;
}

export interface GatewayOk {
  readonly ok: true;
  readonly data: Record<string, unknown>;
}

export interface GatewayFail {
  readonly ok: false;
  readonly error: string;
}

export type GatewayResult = GatewayOk | GatewayFail;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** GET one gateway route. Never throws — every failure is a typed `{ok:false}`. */
export async function gwGet(path: string): Promise<GatewayResult> {
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), { method: 'GET' });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // A non-JSON body is handled below by the !res.ok / empty-record fallback.
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return { ok: true, data: asRecord(body) ?? {} };
}

/**
 * POST one gateway route with a JSON body. Never throws.
 *
 * `extraHeaders` (fix-sec-round #1): additive, optional headers — e.g. the exec token a real
 * write route may require. Omitted by every pre-existing call site, so this stays byte-identical
 * to before for every route that does not need it.
 */
export async function gwPost(
  path: string,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<GatewayResult> {
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Handled by the !res.ok fallback below.
  }
  const record = asRecord(parsed) ?? {};
  if (!res.ok) {
    const errField = typeof record.error === 'string' ? record.error : `HTTP ${res.status}`;
    return { ok: false, error: errField };
  }
  return { ok: true, data: record };
}

/**
 * PATCH one gateway route with a JSON body. Never throws. Mirrors `gwPost`'s own shape exactly
 * (same extraHeaders convention for the exec token a real write route requires) — added for
 * feat-agent-model-edit's `PATCH /api/agents/:slug/model`, the first PATCH route this gateway has.
 */
export async function gwPatch(
  path: string,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<GatewayResult> {
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Handled by the !res.ok fallback below.
  }
  const record = asRecord(parsed) ?? {};
  if (!res.ok) {
    const errField = typeof record.error === 'string' ? record.error : `HTTP ${res.status}`;
    return { ok: false, error: errField };
  }
  return { ok: true, data: record };
}

/**
 * DELETE one gateway route. Never throws — every failure is a typed `{ok:false}`.
 *
 * `extraHeaders` (feat-delete-conversation): additive, optional headers — the real write route
 * this drives (`DELETE /api/conversations/:id`) requires the same per-boot exec token every other
 * real write route needs (see `gwPost`'s own doc comment for the identical convention).
 */
export async function gwDelete(
  path: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<GatewayResult> {
  let res: Response;
  try {
    res = await globalThis.fetch(gatewayUrl(path), { method: 'DELETE', headers: { ...extraHeaders } });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Handled by the !res.ok fallback below.
  }
  const record = asRecord(parsed) ?? {};
  if (!res.ok) {
    const errField = typeof record.error === 'string' ? record.error : `HTTP ${res.status}`;
    return { ok: false, error: errField };
  }
  return { ok: true, data: record };
}

/**
 * Opens a real EventSource to one gateway SSE route. Referenced through
 * `globalThis.EventSource` (a MemberExpression, not the banned bare
 * `new EventSource(...)` — mirrors `bridge-client.ts`'s own `globalThis.WebSocket`
 * convention) so the offline-only ESLint guard stays meaningful everywhere else.
 */
export function gwEventSource(path: string): EventSource {
  return new globalThis.EventSource(gatewayUrl(path));
}

/* ========================================================================== */
/*  Defensive extraction — mirrors the pattern already used throughout this   */
/*  codebase (store-adapter.ts, graph-builder.ts, live-store.ts, UsageBar.tsx) */
/* ========================================================================== */

export function pickRecord(payload: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const obj = asRecord(payload);
  if (obj === null) return null;
  for (const key of keys) {
    const value = asRecord(obj[key]);
    if (value !== null) return value;
  }
  return null;
}

export function pickString(payload: unknown, keys: readonly string[]): string | null {
  const obj = asRecord(payload);
  if (obj === null) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

export function pickNumber(payload: unknown, keys: readonly string[]): number | null {
  const obj = asRecord(payload);
  if (obj === null) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function pickBool(payload: unknown, keys: readonly string[]): boolean | null {
  const obj = asRecord(payload);
  if (obj === null) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

export function pickArray(payload: unknown, keys: readonly string[]): readonly Record<string, unknown>[] {
  const obj = asRecord(payload);
  if (obj === null) return [];
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null);
  }
  return [];
}

/** Like `pickArray`, but for an array of plain strings (e.g. a task's `notes`). */
export function pickStringArray(payload: unknown, keys: readonly string[]): readonly string[] {
  const obj = asRecord(payload);
  if (obj === null) return [];
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

export { asRecord };
