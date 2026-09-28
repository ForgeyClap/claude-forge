// WP-CC1 (Lead review round 2) — a reviewer dispatch (`subagent_started`/`agent_started` with
// `role:'reviewer'`) is never closed by `subagent_completed`/`agent_completed`: the run-contract
// rule counts those event types as real WORK-PACKAGE evidence, so a reviewing agent (whose job is
// read-only judgement, not building a work package) legitimately never logs one. It closes at its
// own `review_completed` instead — self-reported by the reviewing agent, a genuinely SEPARATE
// logging path from the Lead's own `subagent_started` — which carries NO `dispatch_id` at all.
// Real shape, verified live (forge-2026-09-26-dashboard-discord-usage, lines 129-130):
//   {"event_type":"subagent_started","agent":"Review Boss","dispatch_id":"a944c14acc68d0110",
//    "role":"reviewer", ...}
//   {"event_type":"review_completed","agent":"Review Boss","review_id":"rv-v290-final",
//    "verdict":"changes_required", ...}                       <- no dispatch_id
//
// Matched by AGENT SLUG (never the raw display string, in case the two logging paths ever drift in
// exact casing/spelling), FIFO per agent: a `review_completed` closes the OLDEST still-open
// `role:'reviewer'` dispatch for that same agent — never a newer one, and never a `role:'worker'`
// dispatch even from the very same agent (a worker dispatch is tracked in a completely separate
// bucket here and is never visible to closeReviewer() at all).
import { slugFor } from './agent-names.mjs';

/**
 * createReviewerTracker() -> { openReviewer(nameIndex, agent, dispatchId), closeReviewer(nameIndex, agent) }
 * One instance per run scan; never shared across runs or calls. Both methods are safe no-ops when
 * `agent` cannot be resolved to any slug at all (nothing reliable to key by — never guessed).
 */
export function createReviewerTracker() {
  const openBySlug = new Map(); // slug -> [dispatchId, ...] oldest-first (a plain FIFO queue)
  return {
    /** Record a NEW open role:'reviewer' dispatch for `agent`. */
    openReviewer(nameIndex, agent, dispatchId) {
      const slug = slugFor(nameIndex, agent);
      if (slug === null || typeof dispatchId !== 'string' || dispatchId === '') return;
      if (!openBySlug.has(slug)) openBySlug.set(slug, []);
      openBySlug.get(slug).push(dispatchId);
    },
    /**
     * A `review_completed` from `agent` arrived — closes and returns the OLDEST still-open
     * reviewer dispatch_id for that agent's slug, or `null` when that agent has no open reviewer
     * dispatch at all (an honest orphan review — never guessed, never closes anything).
     */
    closeReviewer(nameIndex, agent) {
      const slug = slugFor(nameIndex, agent);
      if (slug === null) return null;
      const queue = openBySlug.get(slug);
      if (!queue || queue.length === 0) return null;
      return queue.shift();
    },
  };
}
