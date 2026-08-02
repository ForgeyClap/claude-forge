/**
 * `gateway-capabilities.ts` — model routing, tool inventory, MCP servers and
 * Claude install capabilities (forge-2026-07-29-cc-finish, WP wire-capabilities).
 *
 * Two layers, mirroring `gateway-recovery.test.ts`'s own precedent plus
 * `gateway-connection-store.test.ts`'s fetch-stub convention for the hook
 * layer this WP adds:
 *
 *   1. Pure-function tests against representative `/api/models`, `/api/tools`,
 *      `/api/mcp` and `/api/capabilities` response shapes — no network, no
 *      React, no timers. The sample payloads below are trimmed copies of REAL
 *      responses this WP live-curled from http://127.0.0.1:4100 while
 *      building this file (78 real tools, 134 real capabilities, 8 real MCP
 *      servers, the real NVIDIA-backed model matrix).
 *   2. A small set of `renderHook` tests proving the loading -> ready
 *      transition, an honest error state on a failed poll, and a genuinely
 *      empty response staying empty — never fabricated.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  EMPTY_GATEWAY_CAPABILITIES,
  EMPTY_GATEWAY_MCP,
  EMPTY_GATEWAY_MODELS,
  EMPTY_GATEWAY_TOOLS,
  parseGatewayCapabilities,
  parseGatewayMcp,
  parseGatewayModels,
  parseGatewayTools,
  useGatewayModels,
  useGatewayTools,
} from '@/prototype/state/gateway-capabilities';

/* ========================================================================== */
/*  1. Pure parsers                                                          */
/* ========================================================================== */

describe('parseGatewayModels — GET /api/models (no ?project=)', () => {
  it('reads real roles, catalog and the live NVIDIA probe straight off the response', () => {
    const result = parseGatewayModels({
      ok: true,
      matrix_available: true,
      roles: {
        default: {
          model: 'nvidia/nemotron-3-nano-30b-a3b',
          envOverride: 'NVIDIA_DEFAULT_MODEL',
          why: 'REMAPPED 2026-07-26',
        },
      },
      catalog: [
        {
          id: 'nvidia/nemotron-3-nano-30b-a3b',
          caps: ['general', 'coding', 'fast'],
          ctx: 1000000,
          tier: 'cheap',
          probe: 'WORKING (526ms)',
          verified: 'live-probe-2026-07-25',
        },
      ],
      broken_count: 26,
      latest_verified_date: '2026-07-25',
      nvidia: { state: 'CONNECTED', models: 102, ms: 131, base_url: 'https://integrate.api.nvidia.com/v1', age_ms: 0 },
      captured_at: '2026-07-28T23:55:21.910Z',
      age_ms: 0,
      provenance: 'DERIVED',
    });

    expect(result.matrixAvailable).toBe(true);
    expect(result.roles).toEqual([
      { role: 'default', model: 'nvidia/nemotron-3-nano-30b-a3b', envOverride: 'NVIDIA_DEFAULT_MODEL', why: 'REMAPPED 2026-07-26' },
    ]);
    expect(result.catalog).toEqual([
      { id: 'nvidia/nemotron-3-nano-30b-a3b', caps: ['general', 'coding', 'fast'], ctx: 1000000, tier: 'cheap', probe: 'WORKING (526ms)', verified: 'live-probe-2026-07-25' },
    ]);
    expect(result.brokenCount).toBe(26);
    expect(result.nvidia).toEqual({ state: 'CONNECTED', models: 102, ms: 131, baseUrl: 'https://integrate.api.nvidia.com/v1', ageMs: 0, note: null });
  });

  it('the matrix-unavailable branch reports honestly: empty roles/catalog, a real matrixError, never a guess', () => {
    const result = parseGatewayModels({
      ok: true,
      matrix_available: false,
      matrix_error: 'ENOENT: model-capability-matrix.json not found',
      roles: {},
      catalog: [],
      nvidia: { state: 'DISCONNECTED', note: 'nvidia-provider health probe failed' },
      captured_at: '2026-07-28T23:55:21.910Z',
      age_ms: 0,
    });

    expect(result.matrixAvailable).toBe(false);
    expect(result.matrixError).toBe('ENOENT: model-capability-matrix.json not found');
    expect(result.roles).toEqual([]);
    expect(result.catalog).toEqual([]);
    expect(result.nvidia).toEqual({ state: 'DISCONNECTED', models: null, ms: null, baseUrl: null, ageMs: null, note: 'nvidia-provider health probe failed' });
  });

  it('an empty object resolves to the module constant shape', () => {
    expect(parseGatewayModels({})).toEqual(EMPTY_GATEWAY_MODELS);
  });
});

describe('parseGatewayTools — GET /api/tools?project=', () => {
  it('reads real tool entries straight off the response (representative of the 78 real forge-bin tools)', () => {
    const result = parseGatewayTools({
      ok: true,
      tools: [
        { name: 'forge-a2a.cjs', has_test: true, size: 4983, mtime: '2026-07-11T15:09:27.023Z' },
        { name: 'forge-doctor.cjs', has_test: true, size: 90813, mtime: '2026-07-22T12:54:00.013Z' },
      ],
      tools_count: 78,
      captured_at: '2026-07-28T23:55:30.560Z',
      age_ms: 0,
      provenance: 'DERIVED',
    });

    expect(result.toolsCount).toBe(78);
    expect(result.tools).toEqual([
      { name: 'forge-a2a.cjs', hasTest: true, size: 4983, mtime: '2026-07-11T15:09:27.023Z' },
      { name: 'forge-doctor.cjs', hasTest: true, size: 90813, mtime: '2026-07-22T12:54:00.013Z' },
    ]);
    expect(result.note).toBeNull();
    expect(result.error).toBeNull();
  });

  it('a genuinely empty forge-bin directory parses to an empty tools array, never fabricated rows', () => {
    const result = parseGatewayTools({
      ok: true,
      tools: [],
      tools_count: 0,
      note: 'forge-bin directory not readable: ENOENT',
      captured_at: '2026-07-28T23:55:30.560Z',
      age_ms: 0,
    });

    expect(result.tools).toEqual([]);
    expect(result.toolsCount).toBe(0);
    expect(result.note).toBe('forge-bin directory not readable: ENOENT');
  });

  it('a path-containment failure carries the real error, ok:false, never a plausible default', () => {
    const result = parseGatewayTools({ ok: false, error: 'path containment violation', tools: [], tools_count: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('path containment violation');
    expect(result.tools).toEqual([]);
  });

  it('a missing has_test on a real row defaults to false, the same neutral choice gateway-recovery.ts already made', () => {
    const result = parseGatewayTools({ tools: [{ name: 'forge-x.cjs', size: 10, mtime: null }] });
    expect(result.tools[0]).toEqual({ name: 'forge-x.cjs', hasTest: false, size: 10, mtime: null });
  });

  it('an empty object resolves to the module constant shape', () => {
    expect(parseGatewayTools({})).toEqual(EMPTY_GATEWAY_TOOLS);
  });
});

describe('parseGatewayMcp — GET /api/mcp?project=', () => {
  it('reads real server entries and boss grants (representative of the 8 real registered servers)', () => {
    const result = parseGatewayMcp({
      ok: true,
      servers: [
        {
          id: 'context7',
          purpose: 'Up-to-date library/API documentation lookup.',
          tier: 1,
          network: 'read',
          credentials_needed: false,
          status: 'not-installed',
          opted_in: false,
          notes: 'Read-only docs fetch.',
        },
      ],
      servers_count: 8,
      installed_count: 0,
      opted_in_count: 0,
      boss_grants: [{ slug: 'test-boss', max_tier: 2, allow_servers: ['playwright', 'chrome-devtools'], why: 'Automated browser-driven QA.' }],
      registry_present: true,
      grants_present: true,
      opt_in_file_present: false,
      captured_at: '2026-07-28T23:55:34.162Z',
      age_ms: 0,
      provenance: 'DERIVED',
    });

    expect(result.serversCount).toBe(8);
    expect(result.servers[0]).toEqual({
      id: 'context7',
      purpose: 'Up-to-date library/API documentation lookup.',
      tier: 1,
      network: 'read',
      credentialsNeeded: false,
      status: 'not-installed',
      optedIn: false,
      notes: 'Read-only docs fetch.',
    });
    expect(result.bossGrants).toEqual([{ slug: 'test-boss', maxTier: 2, allowServers: ['playwright', 'chrome-devtools'], why: 'Automated browser-driven QA.' }]);
    expect(result.optInFilePresent).toBe(false);
  });

  it('a containment violation reports only ok:false + the real error, never invents a server list', () => {
    const result = parseGatewayMcp({ ok: false, error: 'path containment violation' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('path containment violation');
    expect(result.servers).toEqual([]);
    expect(result.registryPresent).toBeNull();
  });

  it('an empty object resolves to the module constant shape', () => {
    expect(parseGatewayMcp({})).toEqual(EMPTY_GATEWAY_MCP);
  });
});

describe('parseGatewayCapabilities — GET /api/capabilities?project=', () => {
  it('reads real capability entries and the summary (representative of the 134 real tracked capabilities)', () => {
    const result = parseGatewayCapabilities({
      ok: true,
      available: true,
      state: 'OK',
      capabilities: [
        {
          capability: 'tool:forge-doctor',
          name: 'forge-doctor',
          kind: 'tool',
          present: true,
          status: 'active',
          times_used: 82,
          last_used_run: 'forge-2026-07-26-command-center',
          last_used_ts: '2026-07-26T15:55:06.972Z',
        },
      ],
      summary: { total: 134, active: 134, dormant: 0, opt_in: 0, never_used: 0 },
      captured_at: '2026-07-28T23:55:34.406Z',
      age_ms: 0,
      provenance: 'DERIVED',
    });

    expect(result.available).toBe(true);
    expect(result.state).toBe('OK');
    expect(result.capabilities[0]).toEqual({
      capability: 'tool:forge-doctor',
      name: 'forge-doctor',
      kind: 'tool',
      present: true,
      status: 'active',
      timesUsed: 82,
      lastUsedRun: 'forge-2026-07-26-command-center',
      lastUsedTs: '2026-07-26T15:55:06.972Z',
    });
    expect(result.summary).toEqual({ total: 134, active: 134, dormant: 0, optIn: 0, neverUsed: 0 });
  });

  it('a real never-used capability keeps its null last_used fields as null, never a fabricated timestamp', () => {
    const result = parseGatewayCapabilities({
      capabilities: [{ capability: 'tool:forge-a2a', name: 'forge-a2a', kind: 'tool', present: true, status: 'active', times_used: 3, last_used_run: null, last_used_ts: null }],
    });
    expect(result.capabilities[0].lastUsedRun).toBeNull();
    expect(result.capabilities[0].lastUsedTs).toBeNull();
  });

  it('UNAVAILABLE (spawn failure/timeout) reports honestly: available:false, empty list, the real note', () => {
    const result = parseGatewayCapabilities({
      ok: true,
      available: false,
      state: 'UNAVAILABLE',
      note: 'forge-capabilities.cjs report timed out after 60000ms',
      capabilities: [],
      summary: null,
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe('UNAVAILABLE');
    expect(result.note).toBe('forge-capabilities.cjs report timed out after 60000ms');
    expect(result.capabilities).toEqual([]);
    expect(result.summary).toBeNull();
  });

  it('an empty object resolves to the module constant shape', () => {
    expect(parseGatewayCapabilities({})).toEqual(EMPTY_GATEWAY_CAPABILITIES);
  });
});

/* ========================================================================== */
/*  2. Hooks — loading -> ready, honest error, genuine empty (real timers;    */
/*     the 15s poll interval itself is not exercised — only the first tick)  */
/* ========================================================================== */

function stubFetchJson(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useGatewayModels — GET /api/models (no ?project=)', () => {
  it('starts loading, then resolves the real matrix on a successful response', async () => {
    stubFetchJson({ ok: true, matrix_available: true, roles: {}, catalog: [], nvidia: { state: 'CONNECTED', models: 102 }, captured_at: 'x', age_ms: 0, provenance: 'DERIVED' });

    const { result } = renderHook(() => useGatewayModels());
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual(EMPTY_GATEWAY_MODELS);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data.matrixAvailable).toBe(true);
    expect(result.current.data.nvidia).toEqual({ state: 'CONNECTED', models: 102, ms: null, baseUrl: null, ageMs: null, note: null });
  });

  it('reports an honest error state when the gateway is unreachable, without fabricating data', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { result } = renderHook(() => useGatewayModels());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('fetch failed');
    expect(result.current.data).toEqual(EMPTY_GATEWAY_MODELS);
  });
});

describe('useGatewayTools — GET /api/tools?project=', () => {
  it('never fetches while no project is selected — loading stays true, data stays empty', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { result } = renderHook(() => useGatewayTools(''));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual(EMPTY_GATEWAY_TOOLS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a genuinely empty real project (0 tools) resolves to an empty array, not a fabricated row', async () => {
    stubFetchJson({ ok: true, tools: [], tools_count: 0, captured_at: 'x', age_ms: 0, provenance: 'DERIVED' });

    const { result } = renderHook(() => useGatewayTools('my-forge-project'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.data.tools).toEqual([]);
    expect(result.current.data.toolsCount).toBe(0);
  });

  it('a failed poll (15s later) keeps the last known-good tools list instead of wiping it to empty', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, tools: [{ name: 'forge-doctor.cjs', has_test: true, size: 90813, mtime: null }], tools_count: 1 }),
      });
      fetchMock.mockRejectedValueOnce(new Error('HTTP 502'));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const { result } = renderHook(() => useGatewayTools('my-forge-project'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // the mount-time immediate poll resolves
      });
      expect(result.current.data.tools).toHaveLength(1);
      expect(result.current.error).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000); // the next scheduled poll fires and fails
      });
      expect(result.current.error).toBe('HTTP 502');
      expect(result.current.data.tools).toHaveLength(1); // preserved, never wiped to a fabricated empty
    } finally {
      vi.useRealTimers();
    }
  });
});
