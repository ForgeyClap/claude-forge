// GET /api/discord/activity (v2.9.0, Command Center audit finding 31) — a read-only summary of what
// the Discord bot has actually done: the jobs in its queue and the cost Claude Code recorded for
// them. Before this, 31 bot jobs and their recorded cost appeared in no Command Center view at all.
//
// What it reads, and nothing else: three files in the bot's gateway-owned state folder (the folder
// GET /api/discord/status reports as `state_dir`; see discord-service.mjs getDiscordStateDir()):
//   - queue.json    — the bot's durable job queue ({ items: [...], nextSeq }).
//   - usage.jsonl   — one line per finished job with Claude Code's own cost and token numbers.
//   - mappings.json — only for project display names (projects[].projectId -> name).
//
// What it NEVER returns: a message's text (`content`), its prompt hash or attachments, and every
// Discord identifier (user, guild, channel, thread, message, conversation). Only the project, the
// job's state, its times, its attempt count, a short redacted error, the Forge run id it started,
// and the recorded numbers. The one free-text field (the error) goes through redactAndCap(), which
// redacts first and caps second (see redact.mjs for why that order matters).
//
// Honest about its limits: every file is read with a size cap (usage.jsonl from its END, so the
// newest jobs always count), a symlinked file is refused, and an unreadable file or line becomes a
// plain note in `notes` — never a crash and never a silently wrong zero. `cost_usd` is Claude Code's
// own per-job figure (its total_cost_usd); on a Claude subscription that is an estimate of API value
// rather than a separate bill, and the dashboard says so next to the number.
//
// Wire shape: snake_case keys, the same convention as every other /api/discord/* route.

import fs from 'node:fs';
import path from 'node:path';
import { DISCORD_STATE_DIR } from './paths.mjs';
import { redactAndCap, stripDiscordIds } from './redact.mjs';

export const QUEUE_MAX_BYTES = 8 * 1024 * 1024;
export const USAGE_MAX_BYTES = 8 * 1024 * 1024;
export const MAPPINGS_MAX_BYTES = 2 * 1024 * 1024;
export const RECENT_JOBS_LIMIT = 12;
export const BY_PROJECT_LIMIT = 8;
const ERROR_MAX_CHARS = 200;
const ID_MAX_CHARS = 200;
const NAME_MAX_CHARS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_RE = /^[A-Z_]{1,40}$/;

// The bot's own queue states (discord/src/queue.js QueueState). "Open" means not finished yet; an
// unknown state is still counted under its own name in by_state, never dropped and never "open".
const OPEN_STATES = new Set([
  'RECEIVED', 'VALIDATED', 'WAITING_FOR_PROJECT', 'WAITING_FOR_CONFIRMATION', 'QUEUED', 'STARTING', 'RUNNING',
]);

/** Reads a file with a byte cap. `fromEnd` reads the LAST maxBytes of an append-only log (dropping the
 *  partial first line); otherwise a file over the cap is not read at all ('too-large'), because a cut
 *  JSON document cannot be parsed honestly. Returns
 *  { status: 'missing' | 'too-large' | 'error' | 'ok', text?, truncated?, message? }. */
function readCapped(filePath, maxBytes, fromEnd) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'error', message: (err && err.code) || 'could not inspect' };
  }
  if (st.isSymbolicLink()) return { status: 'error', message: 'refused: the file is a link' };
  if (!st.isFile()) return { status: 'error', message: 'not a regular file' };
  if (!fromEnd && st.size > maxBytes) return { status: 'too-large' };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    return { status: 'error', message: (err && err.code) || 'could not open' };
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString('utf8');
    const truncated = size > maxBytes;
    if (truncated) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { status: 'ok', text, truncated };
  } catch (err) {
    return { status: 'error', message: (err && err.code) || 'could not read' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoOrNull(ms) {
  const n = finiteOrNull(ms);
  return n !== null && n > 0 ? new Date(n).toISOString() : null;
}

function shortString(value, max) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function stateOf(item) {
  return typeof item.state === 'string' && STATE_RE.test(item.state) ? item.state : 'UNKNOWN';
}

// Codex run B F-10: a Discord id inside the bot's error text (e.g. "Unknown Channel 1234...") is
// removed before redaction and the cap, so this route keeps its promise of no Discord identifiers.
function errorText(value) {
  if (value === null || value === undefined) return null;
  let text;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'object' && typeof value.message === 'string') text = value.message;
  else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  return redactAndCap(stripDiscordIds(text), ERROR_MAX_CHARS);
}

function megabytes(bytes) {
  return Math.round(bytes / (1024 * 1024));
}

function roundUsd(n) {
  return Math.round(n * 10000) / 10000;
}

function readProjectNames(stateDir, notes) {
  const names = new Map();
  const r = readCapped(path.join(stateDir, 'mappings.json'), MAPPINGS_MAX_BYTES, false);
  if (r.status === 'missing') return names; // names are a nicety: no file simply means ids are shown
  if (r.status !== 'ok') {
    notes.push('Project names could not be read from mappings.json, so project ids are shown instead.');
    return names;
  }
  try {
    const parsed = JSON.parse(r.text);
    const projects = Array.isArray(parsed && parsed.projects) ? parsed.projects : [];
    for (const p of projects) {
      const id = p && shortString(p.projectId, ID_MAX_CHARS);
      const name = p && shortString(p.name, NAME_MAX_CHARS);
      if (id && name) names.set(id, name);
    }
  } catch {
    notes.push('Project names could not be read from mappings.json, so project ids are shown instead.');
  }
  return names;
}

function summarizeJobs(stateDir, names, notes) {
  const jobs = { total: 0, open: 0, by_state: {}, recent: [] };
  const r = readCapped(path.join(stateDir, 'queue.json'), QUEUE_MAX_BYTES, false);
  if (r.status === 'missing') return { jobs, found: false };
  if (r.status === 'too-large') {
    notes.push(`queue.json is larger than ${megabytes(QUEUE_MAX_BYTES)} MB, so the job list was not read.`);
    return { jobs, found: true };
  }
  if (r.status === 'error') {
    notes.push(`queue.json could not be read (${r.message}).`);
    return { jobs, found: true };
  }
  let items = null;
  try {
    const parsed = JSON.parse(r.text);
    if (Array.isArray(parsed)) items = parsed;
    else if (parsed && Array.isArray(parsed.items)) items = parsed.items;
  } catch {
    items = null;
  }
  if (!items) {
    notes.push('queue.json is not in the expected shape, so the job list was not read.');
    return { jobs, found: true };
  }
  const valid = items.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  jobs.total = valid.length;
  for (const item of valid) {
    const state = stateOf(item);
    jobs.by_state[state] = (jobs.by_state[state] || 0) + 1;
    if (OPEN_STATES.has(state)) jobs.open += 1;
  }
  const lastActivity = (item) =>
    finiteOrNull(item.completedAt) ?? finiteOrNull(item.startedAt) ?? finiteOrNull(item.enqueuedAt) ?? finiteOrNull(item.receivedAt) ?? 0;
  jobs.recent = valid
    .slice()
    .sort((a, b) => lastActivity(b) - lastActivity(a))
    .slice(0, RECENT_JOBS_LIMIT)
    .map((item) => {
      const projectId = shortString(item.projectId, ID_MAX_CHARS);
      const startedAt = finiteOrNull(item.startedAt);
      const completedAt = finiteOrNull(item.completedAt);
      return {
        id: shortString(item.id, 80),
        project_id: projectId,
        project_name: projectId ? names.get(projectId) ?? null : null,
        state: stateOf(item),
        received_at: isoOrNull(item.receivedAt),
        started_at: isoOrNull(startedAt),
        completed_at: isoOrNull(completedAt),
        duration_ms: startedAt !== null && completedAt !== null && completedAt >= startedAt ? completedAt - startedAt : null,
        attempts: finiteOrNull(item.attempts),
        run_id: shortString(item.runId, ID_MAX_CHARS),
        error: errorText(item.error),
      };
    });
  return { jobs, found: true };
}

function summarizeCost(stateDir, names, notes, nowMs) {
  const cost = {
    recorded_runs: 0,
    runs_without_cost: 0,
    total_usd: 0,
    last_7d_usd: 0,
    last_24h_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    first_at: null,
    last_at: null,
    by_project: [],
  };
  const r = readCapped(path.join(stateDir, 'usage.jsonl'), USAGE_MAX_BYTES, true);
  if (r.status === 'missing') return { cost, found: false };
  if (r.status !== 'ok') {
    notes.push(`usage.jsonl could not be read (${r.message || r.status}).`);
    return { cost, found: true };
  }
  if (r.truncated) {
    notes.push(`usage.jsonl is larger than ${megabytes(USAGE_MAX_BYTES)} MB, so only its most recent part is counted.`);
  }
  let unreadable = 0;
  let first = Infinity;
  let last = -Infinity;
  const perProject = new Map();
  for (const line of r.text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      unreadable += 1;
      continue;
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      unreadable += 1;
      continue;
    }
    cost.recorded_runs += 1;
    const usd = finiteOrNull(row.costUsd);
    const ts = finiteOrNull(row.ts);
    if (usd === null) {
      cost.runs_without_cost += 1;
    } else {
      cost.total_usd += usd;
      if (ts !== null && nowMs - ts <= 7 * DAY_MS) cost.last_7d_usd += usd;
      if (ts !== null && nowMs - ts <= DAY_MS) cost.last_24h_usd += usd;
    }
    cost.input_tokens += finiteOrNull(row.inputTokens) ?? 0;
    cost.output_tokens += finiteOrNull(row.outputTokens) ?? 0;
    cost.cache_read_tokens += finiteOrNull(row.cacheReadTokens) ?? 0;
    if (ts !== null) {
      first = Math.min(first, ts);
      last = Math.max(last, ts);
    }
    const projectId = shortString(row.projectId, ID_MAX_CHARS);
    const key = projectId ?? '';
    const entry = perProject.get(key) || { project_id: projectId, project_name: projectId ? names.get(projectId) ?? null : null, runs: 0, cost_usd: 0 };
    entry.runs += 1;
    entry.cost_usd += usd ?? 0;
    perProject.set(key, entry);
  }
  if (unreadable > 0) {
    notes.push(`${unreadable} line${unreadable === 1 ? '' : 's'} in usage.jsonl could not be read and ${unreadable === 1 ? 'was' : 'were'} skipped.`);
  }
  cost.total_usd = roundUsd(cost.total_usd);
  cost.last_7d_usd = roundUsd(cost.last_7d_usd);
  cost.last_24h_usd = roundUsd(cost.last_24h_usd);
  cost.first_at = Number.isFinite(first) ? isoOrNull(first) : null;
  cost.last_at = Number.isFinite(last) ? isoOrNull(last) : null;
  cost.by_project = [...perProject.values()]
    .map((entry) => ({ ...entry, cost_usd: roundUsd(entry.cost_usd) }))
    .sort((a, b) => b.cost_usd - a.cost_usd || b.runs - a.runs)
    .slice(0, BY_PROJECT_LIMIT);
  return { cost, found: true };
}

/** readDiscordActivity({ stateDir?, now? }) -> { available, state_dir, jobs, cost, notes }. Never throws
 *  for anything on disk: every problem becomes a note. `available` is false only when neither the
 *  queue nor the usage log exists yet (the bot has never run on this machine). */
export function readDiscordActivity({ stateDir = DISCORD_STATE_DIR, now = Date.now() } = {}) {
  const notes = [];
  const names = readProjectNames(stateDir, notes);
  const jobs = summarizeJobs(stateDir, names, notes);
  const cost = summarizeCost(stateDir, names, notes, now);
  return { available: jobs.found || cost.found, state_dir: stateDir, jobs: jobs.jobs, cost: cost.cost, notes };
}
