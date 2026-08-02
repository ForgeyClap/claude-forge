/**
 * feat-agent-model-edit: the real `PATCH /api/agents/:slug/model` call the Agents tab uses to
 * change ONE agent's `claudeTier` or `claudeEffort`. Mirrors `gateway-actions.ts`'s own
 * `requestDeleteConversation` shape (the same per-boot exec token every real write route needs,
 * `readExecToken()` degrading to an omitted header when the meta tag is absent — the gateway then
 * honestly answers with a real 403, same documented degrade path every other write route already
 * has). Kept here (adapter/, not components/shell/) since this is the Agents view's own concern,
 * not a shell-level action shared across unrelated views.
 */
import { EXEC_TOKEN_HEADER, gwPatch, pickString, readExecToken } from '@/prototype/state/gateway-client';

export type AgentModelField = 'claudeTier' | 'claudeEffort';

export interface AgentModelPatchResult {
  readonly ok: boolean;
  readonly error: string | null;
  /**
   * The value the gateway reports right after the write — read FRESH from disk server-side
   * (`agents-write.mjs`'s own re-read step), never merely the value that was requested. `null` on
   * failure; the caller shows `error` and leaves whatever value it already had on screen.
   */
  readonly modelTier: string | null;
  readonly claudeEffort: string | null;
}

/**
 * Sends one real `PATCH /api/agents/:slug/model?project=<project>` with `{ [field]: value }`.
 * Never throws — every failure is a typed `{ok:false}` carrying the gateway's real error text.
 */
export async function patchAgentModel(
  project: string,
  slug: string,
  field: AgentModelField,
  value: string,
): Promise<AgentModelPatchResult> {
  const token = readExecToken();
  const headers: Record<string, string> = token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};
  const path = `/api/agents/${encodeURIComponent(slug)}/model?project=${encodeURIComponent(project)}`;
  const result = await gwPatch(path, { [field]: value }, headers);
  if (!result.ok) return { ok: false, error: result.error, modelTier: null, claudeEffort: null };
  return {
    ok: true,
    error: null,
    modelTier: pickString(result.data, ['model_tier']),
    claudeEffort: pickString(result.data, ['claude_effort']),
  };
}
