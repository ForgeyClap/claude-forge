/**
 * WP-A (v2.9.0): the real `POST /api/config` call the Settings ▸ Forge settings section uses to
 * change a setting from the dashboard — "we also want to be able to change the config in the
 * dashboard" (owner). Mirrors `agent-model.ts`'s own shape exactly (same per-boot exec token every
 * real write route needs, `readExecToken()` degrading to an omitted header when the meta tag is
 * absent — the gateway then honestly answers with a real 403, same documented degrade path every
 * other write route already has). Kept here (adapter/, not components/shell/) since this is the
 * Settings view's own concern, not a shell-level action shared across unrelated views.
 */
import { EXEC_TOKEN_HEADER, gwPost, readExecToken } from '@/prototype/state/gateway-client';

export type ForgeConfigWriteAction = 'set' | 'unset';

export interface ForgeConfigWriteResult {
  readonly ok: boolean;
  readonly error: string | null;
}

/**
 * Sends one real `POST /api/config?project=<project>` with
 * `{ action, key, value? }`. Never throws — every failure is a typed `{ok:false}` carrying the
 * gateway's real error text (unknown key, bad value, locked, gate-hook-off refusal, ambiguous
 * project, a busy config lock, ...). `value` is omitted from the body entirely for `unset`.
 */
export async function writeForgeConfig(
  project: string,
  action: ForgeConfigWriteAction,
  key: string,
  value?: string | number | boolean,
): Promise<ForgeConfigWriteResult> {
  const token = readExecToken();
  const headers: Record<string, string> = token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};
  const path = `/api/config?project=${encodeURIComponent(project)}`;
  const body = action === 'set' ? { action, key, value } : { action, key };
  const result = await gwPost(path, body, headers);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, error: null };
}
