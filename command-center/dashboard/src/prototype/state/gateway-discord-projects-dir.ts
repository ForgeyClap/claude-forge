/**
 * gateway-discord-projects-dir — WP-S1 (owner request 2026-09-27): where Discord looks for
 * project folders to turn into channels, and the read-only folder browser a beginner uses to pick
 * a new one. Same `gwGet`/`gwPost` + `pick*` house style as `gateway-discord.ts` (this file's own
 * sibling), and the same `{loading, error, data, refresh}` shape `gateway-capabilities.ts`
 * established for a read-mostly panel with a manual "re-fetch now" escape hatch after a write.
 *
 * Three gateway routes (discord-service.mjs / folder-browse.mjs):
 *   GET  /api/discord/projects-dir                  -> the current setting + honest live counts
 *   POST /api/discord/projects-dir { dir, create }  -> save it (+ restart the bot if it's running)
 *   GET  /api/discord/browse-folder?dir=<path>      -> one folder level of REAL subfolder NAMES,
 *                                                       for the picker — never file content.
 *
 * HONESTY CONTRACT (mirrors `gateway-discord.ts`'s own header): an absent/malformed field on the
 * wire becomes `null`/an empty value, never a guessed default. `restarted`/`exists` are genuinely
 * boolean fields with no real "unknown" state on the wire, so they default to `false` on absence —
 * the same neutral choice `gateway-capabilities.ts`'s header already documents for that class of
 * field, not a fabricated "yes".
 */

import { useCallback, useEffect, useState } from 'react';

import {
  EXEC_TOKEN_HEADER,
  gwGet,
  gwPost,
  pickBool,
  pickNumber,
  pickString,
  pickStringArray,
  readExecToken,
} from '@/prototype/state/gateway-client';

const POLL_MS = 15000;

/* ------------------------------------------------------------------- types */

export type ProjectsDirSource = 'setting' | 'default' | null;

export interface ProjectsDirSetting {
  readonly dir: string;
  /** `'setting'` — an owner-chosen value is saved; `'default'` — nothing saved yet, this is
   *  where Discord will look regardless. `null` only on a malformed/unreachable response. */
  readonly source: ProjectsDirSource;
  readonly exists: boolean;
  /** Real subfolder count, or `null` when the folder does not exist / could not be read. Never a
   *  fabricated `0` for "does not exist". */
  readonly projectCount: number | null;
  /** Codex run B F-04 (2026-09-28): true when the gateway's scan stopped at its budget before
   *  finishing the directory — `projectCount` is then a LOWER BOUND ("at least this many"), not an
   *  exact total. Absent/malformed on the wire defaults to `false` (the neutral "nothing unusual
   *  to report" reading, same convention this file's own header documents for boolean fields). */
  readonly projectCountTruncated: boolean;
}

export const EMPTY_PROJECTS_DIR_SETTING: ProjectsDirSetting = {
  dir: '',
  source: null,
  exists: false,
  projectCount: null,
  projectCountTruncated: false,
};

export interface GatewayProjectsDirState {
  /** True only until the FIRST response (success or failure) resolves. */
  readonly loading: boolean;
  readonly error: string | null;
  readonly data: ProjectsDirSetting;
  /** Re-fetches right now and resets the poll clock — call after a successful save so the panel
   *  reflects the value the write actually produced, not a stale pre-write reading. */
  readonly refresh: () => void;
}

/* -------------------------------------------------------------------- parse */

function parseProjectsDirSetting(data: Record<string, unknown>): ProjectsDirSetting {
  const source = pickString(data, ['source']);
  return {
    dir: pickString(data, ['dir']) ?? '',
    source: source === 'setting' || source === 'default' ? source : null,
    exists: pickBool(data, ['exists']) ?? false,
    projectCount: pickNumber(data, ['project_count']),
    projectCountTruncated: pickBool(data, ['project_count_truncated']) ?? false,
  };
}

/* --------------------------------------------------------------------- poll */

/** Polls `GET /api/discord/projects-dir` every `POLL_MS`. Not project-scoped — same fixed,
 *  gateway-wide contract `gateway-discord.ts`'s own status poll already follows. */
export function useGatewayProjectsDir(): GatewayProjectsDirState {
  const [state, setState] = useState<{ resolved: boolean; error: string | null; data: ProjectsDirSetting }>({
    resolved: false,
    error: null,
    data: EMPTY_PROJECTS_DIR_SETTING,
  });
  // Bumping this re-runs the effect below (same trick gateway-capabilities.ts's useGatewayPoll
  // already uses), which re-fetches immediately AND restarts the setInterval.
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function tick(): Promise<void> {
      const result = await gwGet('/api/discord/projects-dir');
      if (cancelled) return;
      if (result.ok) {
        setState({ resolved: true, error: null, data: parseProjectsDirSetting(result.data) });
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
    // refreshToken is a deliberate "re-run this effect now" trigger, not a value read inside it.
  }, [refreshToken]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  return { loading: !state.resolved, error: state.error, data: state.data, refresh };
}

/* ------------------------------------------------------------------- actions */

function execHeaders(): Record<string, string> {
  const token = readExecToken();
  return token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};
}

export interface SetProjectsDirResult {
  readonly ok: boolean;
  readonly dir: string | null;
  readonly restarted: boolean;
  /** A plain-language reason the bot could NOT be restarted automatically after a successful
   *  save — `null` when there was nothing to report (either no restart was needed, or it
   *  succeeded). Only meaningful together with `ok:true, restarted:false`. */
  readonly restartError: string | null;
  /** The gateway's own real error text (verbatim) when the SAVE itself failed — validation, a
   *  missing folder, a write failure. `null` on success. */
  readonly error: string | null;
}

/**
 * `POST /api/discord/projects-dir` — saves a new projects folder. `create:true` asks the gateway
 * to make the folder first when it does not exist yet (only ever inside the user's own home
 * folder — the gateway itself enforces that, never this client).
 */
export async function requestSetProjectsDir(dir: string, create = false): Promise<SetProjectsDirResult> {
  const result = await gwPost('/api/discord/projects-dir', { dir, create }, execHeaders());
  if (!result.ok) return { ok: false, dir: null, restarted: false, restartError: null, error: result.error };
  return {
    ok: true,
    dir: pickString(result.data, ['dir']),
    restarted: pickBool(result.data, ['restarted']) ?? false,
    restartError: pickString(result.data, ['restart_error']),
    error: null,
  };
}

export interface BrowseFolderResult {
  readonly ok: boolean;
  readonly path: string | null;
  /** The folder one level up, or `null` at the top of the tree (a real filesystem root). */
  readonly parent: string | null;
  readonly folders: readonly string[];
  /** Codex run B F-04 (2026-09-28): true when the gateway's scan stopped at its result cap or scan
   *  budget — `folders` may not be the COMPLETE list of real subfolders. Absent/malformed on the
   *  wire defaults to `false` (the neutral reading, same convention as every other boolean field
   *  in this file). */
  readonly truncated: boolean;
  readonly error: string | null;
}

/**
 * `GET /api/discord/browse-folder` — one folder level of real subfolder NAMES for the picker.
 * Omit `dir` to start at the user's own Documents folder.
 */
export async function requestBrowseFolder(dir?: string): Promise<BrowseFolderResult> {
  const query = dir !== undefined && dir.length > 0 ? `?dir=${encodeURIComponent(dir)}` : '';
  const result = await gwGet(`/api/discord/browse-folder${query}`);
  if (!result.ok) return { ok: false, path: null, parent: null, folders: [], truncated: false, error: result.error };
  return {
    ok: true,
    path: pickString(result.data, ['path']),
    parent: pickString(result.data, ['parent']),
    folders: pickStringArray(result.data, ['folders']),
    truncated: pickBool(result.data, ['truncated']) ?? false,
    error: null,
  };
}
