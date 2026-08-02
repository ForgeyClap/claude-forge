/**
 * The single source of truth for how a status looks and reads.
 *
 * Status is never carried by colour alone. Every consumer gets an uppercase
 * label, a lucide icon name and a screen-reader sentence out of here; the
 * greyscale value and the border treatment come from the
 * --forge-status-<key> / -style / -width tokens in the stylesheet.
 *
 * Both <StatusBadge> and <StatusDot> read this map. Views that need a status
 * label without a badge should read it too rather than re-typing the strings.
 */

import type { StatusKey, StatusPresentation } from '@/prototype/types/prototype-types';

const PRESENTATION: Readonly<Record<StatusKey, StatusPresentation>> = {
  running: {
    key: 'running',
    label: 'RUNNING',
    icon: 'Loader',
    animated: true,
    description: 'Running — work is in progress right now.',
  },
  completed: {
    key: 'completed',
    label: 'COMPLETED',
    icon: 'Check',
    animated: false,
    description: 'Completed — finished and accepted.',
  },
  waiting: {
    key: 'waiting',
    label: 'WAITING',
    icon: 'Clock',
    animated: false,
    description: 'Waiting — queued behind an earlier step.',
  },
  verify: {
    key: 'verify',
    label: 'VERIFY',
    icon: 'SearchCheck',
    animated: false,
    description: 'Verifying — the claim is being checked against its evidence.',
  },
  review: {
    key: 'review',
    label: 'REVIEW',
    icon: 'ClipboardCheck',
    animated: false,
    description: 'In review — awaiting a review pass before it can be accepted.',
  },
  failed: {
    key: 'failed',
    label: 'FAILED',
    icon: 'TriangleAlert',
    animated: false,
    description: 'Failed — stopped with an error and needs attention.',
  },
  /* fix-status-honesty (2026-07-30, owner complaint "ik vind nog bugs in de ui"): unknown/idle
   * used to render as WAITING, painting every project card, every idle roster agent and every
   * loose activity line as if it were queued behind something. WAITING now means genuinely queued;
   * everything with no recorded state reads IDLE — the quietest treatment in the set (dotted,
   * transparent fill), because it is the absence of a claim, not a claim. */
  idle: {
    key: 'idle',
    label: 'IDLE',
    icon: 'Minus',
    animated: false,
    description: 'Idle — nothing is running or recorded here right now.',
  },
  blocked: {
    key: 'blocked',
    label: 'BLOCKED',
    icon: 'Lock',
    animated: false,
    description: 'Blocked — cannot proceed until something else clears.',
  },
};

/** Presentation for a status key. Falls back to `waiting` for unknown input. */
export function statusPresentation(status: StatusKey): StatusPresentation {
  return PRESENTATION[status] ?? PRESENTATION.waiting;
}

export type { StatusPresentation };
