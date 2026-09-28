/**
 * bot-activity-format — small pure helpers for the Discord view's "Bot activity" panel
 * (v2.9.0, Command Center audit finding 31). Kept apart from the component so each rule is
 * unit-tested on its own.
 */

import type { StatusKey } from '@/prototype/types/prototype-types';

/**
 * The bot's own queue state -> the dashboard's status treatment (icon and border). The real state
 * name is always shown next to it as text (see jobStateLabel), so a cancelled or expired job reads
 * "Cancelled" even though it borrows the quiet "idle" treatment: it finished without a result, it
 * did not fail and it is not queued.
 */
export function statusKeyForJobState(state: string): StatusKey {
  switch (state) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
    case 'DEAD_LETTER':
      return 'failed';
    case 'RUNNING':
    case 'STARTING':
      return 'running';
    case 'RECEIVED':
    case 'VALIDATED':
    case 'QUEUED':
    case 'WAITING_FOR_PROJECT':
    case 'WAITING_FOR_CONFIRMATION':
      return 'waiting';
    default:
      return 'idle';
  }
}

/** "WAITING_FOR_CONFIRMATION" -> "Waiting for confirmation"; DEAD_LETTER gets its plain meaning. */
export function jobStateLabel(state: string): string {
  if (state === 'DEAD_LETTER') return 'Gave up after retries';
  if (state === 'UNKNOWN' || state === '') return 'Unknown state';
  const words = state.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat('en-US');
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatUsd(amount: number): string {
  return USD.format(Number.isFinite(amount) ? amount : 0);
}

export function formatCount(n: number): string {
  return COUNT.format(Number.isFinite(n) ? n : 0);
}

/** 62478568 -> "62.5M", 7890 -> "7.9K", 614 -> "614". */
export function formatCompact(n: number): string {
  return COMPACT.format(Number.isFinite(n) ? n : 0);
}

/** "12 jobs", "1 job". */
export function jobsLabel(n: number): string {
  return `${formatCount(n)} job${n === 1 ? '' : 's'}`;
}
