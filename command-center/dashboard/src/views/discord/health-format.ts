/**
 * health-format — turns the bot's own health report (what GET /api/discord/status passes through as
 * `health`) into short readable text, one value per row (v2.9.0, Command Center audit finding 31).
 * Nested values used to be printed as raw JSON: `{"COMPLETED":29,"CANCELLED":2}`, or a 14-item
 * project list as one long line of braces.
 *
 * Nothing is hidden or invented: every key still gets its own row, a key this module does not know
 * gets a plain humanized label, and a value it cannot describe more simply falls back to a count,
 * never to a guess.
 */

const MAX_LISTED = 5;
const MAX_FIELDS = 8;
/** Anything below this is a count or a duration, not an epoch-milliseconds timestamp (about 1973). */
const EPOCH_MS_MIN = 1e11;

/** Friendly labels for the fields the bot's health server reports today (discord/src/health-server.js). */
const KNOWN_LABELS: Readonly<Record<string, string>> = {
  live: 'Live',
  phase: 'Phase',
  pid: 'Process ID',
  startedAt: 'Started',
  uptimeSec: 'Uptime',
  transport: 'Transport',
  connected: 'Connected to Discord',
  busy: 'Busy',
  activeRuns: 'Active runs',
  queueDepth: 'Jobs by state',
  runner: 'Runner',
  guildId: 'Server ID',
  loginError: 'Login error',
  botUsername: 'Bot name',
  applicationId: 'Application ID',
  guilds: 'Servers',
  inviteUrl: 'Invite link',
  projects: 'Project channels',
  ts: 'Reported at',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** camelCase or snake_case -> "Sentence case", for a key without a known label. */
export function healthKeyLabel(key: string): string {
  const known = KNOWN_LABELS[key];
  if (known !== undefined) return known;
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  // A unit word is dropped when formatHealthValue() already renders the value with its own unit.
  const withoutUnit = isSecondsKey(key) ? words.replace(/ (sec|secs|seconds)$/, '') : words;
  if (withoutUnit === '') return key;
  return withoutUnit.charAt(0).toUpperCase() + withoutUnit.slice(1);
}

/** Whole seconds -> "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function formatSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return `${minutes} min`;
  return `${s} s`;
}

function looksLikeTimestampKey(key: string): boolean {
  return key === 'ts' || /(At|_at)$/.test(key);
}

function isSecondsKey(key: string): boolean {
  return /(Sec|Secs|Seconds|_sec|_secs|_seconds)$/.test(key);
}

function formatScalar(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (looksLikeTimestampKey(key) && value > EPOCH_MS_MIN) return new Date(value).toLocaleString();
    if (isSecondsKey(key) && value >= 0) return formatSeconds(value);
    return String(value);
  }
  if (typeof value === 'string') return value === '' ? '—' : value;
  return null;
}

function labelOf(item: unknown): string | null {
  if (typeof item === 'string') return item === '' ? null : item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (isRecord(item)) {
    for (const key of ['name', 'projectId', 'label', 'title', 'id']) {
      const v = item[key];
      if (typeof v === 'string' && v.trim() !== '') return v;
    }
  }
  return null;
}

function formatList(items: readonly unknown[]): string {
  if (items.length === 0) return 'none';
  const labels = items.map(labelOf);
  if (labels.every((label): label is string => label !== null)) {
    if (labels.length <= MAX_LISTED) return labels.join(', ');
    return `${labels.length} — ${labels.slice(0, MAX_LISTED).join(', ')} and ${labels.length - MAX_LISTED} more`;
  }
  return `${items.length} item${items.length === 1 ? '' : 's'}`;
}

function formatObject(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return 'none';
  const parts = entries.map(([key, value]) => {
    const scalar = formatScalar(key, value);
    if (scalar !== null) return `${key}: ${scalar}`;
    if (Array.isArray(value)) return `${key}: ${value.length} item${value.length === 1 ? '' : 's'}`;
    return `${key}: ${Object.keys(isRecord(value) ? value : {}).length} fields`;
  });
  const shown = parts.slice(0, MAX_FIELDS).join(' · ');
  return parts.length > MAX_FIELDS ? `${shown} · and ${parts.length - MAX_FIELDS} more` : shown;
}

/** One health value -> one short readable line. */
export function formatHealthValue(key: string, value: unknown): string {
  const scalar = formatScalar(key, value);
  if (scalar !== null) return scalar;
  if (Array.isArray(value)) return formatList(value);
  if (isRecord(value)) return formatObject(value);
  return String(value);
}
