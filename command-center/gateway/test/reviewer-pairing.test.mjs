// WP-CC1 (Lead review round 2) — unit tests for reviewer-pairing.mjs in isolation from any file
// that consumes it (agent-dispatches.mjs / missions.mjs / runs.mjs each have their own integration
// tests for the end-to-end behavior).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewerTracker } from '../src/reviewer-pairing.mjs';

function nameIndex(map) {
  // Same shape agent-names.mjs's buildAgentNameIndex() returns — built by hand here so this file
  // never needs a real .claude/config/agents/agent-registry.json fixture on disk.
  const slugToDisplay = new Map();
  const displayToSlug = new Map();
  for (const [slug, display] of Object.entries(map)) {
    slugToDisplay.set(slug, display);
    displayToSlug.set(slug.toLowerCase(), slug);
    displayToSlug.set(display.toLowerCase(), slug);
  }
  return { slugToDisplay, displayToSlug };
}

test('a review_completed closes the matching open reviewer dispatch for the same agent', () => {
  const idx = nameIndex({ 'review-boss': 'Review Boss' });
  const tracker = createReviewerTracker();
  tracker.openReviewer(idx, 'Review Boss', 'd1');
  const closed = tracker.closeReviewer(idx, 'Review Boss');
  assert.equal(closed, 'd1');
});

test('a review_completed from a DIFFERENT agent does not close it', () => {
  const idx = nameIndex({ 'review-boss': 'Review Boss', 'build-boss': 'Build Boss' });
  const tracker = createReviewerTracker();
  tracker.openReviewer(idx, 'Review Boss', 'd1');
  const closed = tracker.closeReviewer(idx, 'Build Boss');
  assert.equal(closed, null, 'no open reviewer dispatch exists for Build Boss');
  // Review Boss's own dispatch must still be open afterward.
  const stillThere = tracker.closeReviewer(idx, 'Review Boss');
  assert.equal(stillThere, 'd1');
});

test('matching is by SLUG, not exact string — a casing/spelling difference between the two logging paths still pairs', () => {
  const idx = nameIndex({ 'review-boss': 'Review Boss' });
  const tracker = createReviewerTracker();
  tracker.openReviewer(idx, 'Review Boss', 'd1');
  const closed = tracker.closeReviewer(idx, 'REVIEW BOSS'); // different casing, same real agent
  assert.equal(closed, 'd1');
});

test('FIFO: two open reviewer dispatches for the same agent close oldest-first', () => {
  const idx = nameIndex({ 'review-boss': 'Review Boss' });
  const tracker = createReviewerTracker();
  tracker.openReviewer(idx, 'Review Boss', 'd-first');
  tracker.openReviewer(idx, 'Review Boss', 'd-second');
  assert.equal(tracker.closeReviewer(idx, 'Review Boss'), 'd-first');
  assert.equal(tracker.closeReviewer(idx, 'Review Boss'), 'd-second');
  assert.equal(tracker.closeReviewer(idx, 'Review Boss'), null, 'nothing left to close a third time');
});

test('a review_completed with no open reviewer dispatch at all is an honest orphan — never fabricates a close', () => {
  const idx = nameIndex({ 'review-boss': 'Review Boss' });
  const tracker = createReviewerTracker();
  assert.equal(tracker.closeReviewer(idx, 'Review Boss'), null);
});

test('an unresolvable agent (empty/missing) is a safe no-op on both sides', () => {
  const idx = nameIndex({ 'review-boss': 'Review Boss' });
  const tracker = createReviewerTracker();
  tracker.openReviewer(idx, '', 'd1'); // never registered — nothing to key by
  tracker.openReviewer(idx, null, 'd2');
  assert.equal(tracker.closeReviewer(idx, ''), null);
  assert.equal(tracker.closeReviewer(idx, undefined), null);
  // a real dispatch for a real agent is completely unaffected by those no-ops
  tracker.openReviewer(idx, 'Review Boss', 'd-real');
  assert.equal(tracker.closeReviewer(idx, 'Review Boss'), 'd-real');
});
