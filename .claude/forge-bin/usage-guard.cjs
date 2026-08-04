#!/usr/bin/env node
'use strict';
/**
 * Forge Usage Guard — REAL subscription usage watchdog (zero-dependency).
 *
 * Reads the OFFICIAL Anthropic OAuth usage endpoint (the same source as /usage in Claude Code —
 * no estimates, no log-counting). At >= pause-at % (default 95) on the 5h session window OR the
 * weekly window it PAUSES all Paperclip agents (runtime/dashboard stays UP) and writes a global
 * state file that the global usage-guard hook uses to (a) tell active Claude sessions to PAUSE
 * (in-chat, via PreToolUse deny + UserPromptSubmit context) and (b) after reset, tell them to
 * CONTINUE + run a mandatory checkup. Resumes automatically when the triggering metric is back
 * to <= resume-at % (default 0 — i.e. after the reset).
 *
 * HONESTY RULES: percentages are always the live endpoint values; on ANY fetch error the guard
 * takes NO action (fail-safe) and logs the error; it only auto-resumes agents IT paused (never
 * agents a human paused earlier); the OAuth token is read in-memory and NEVER logged/printed.
 *
 * Usage:
 *   node .claude/forge-bin/usage-guard.cjs check                    # one-shot: print real usage %
 *   node .claude/forge-bin/usage-guard.cjs status                   # guard state + live %
 *   node .claude/forge-bin/usage-guard.cjs watch [--interval 120] [--pause-at 95] [--resume-at 0]
 *                                          [--nvidia-shift-at 80] [--grace-min 5] [--companies a,b]
 *                                          [--once] [--state <file>] [--dry-run]
 *   node .claude/forge-bin/usage-guard.cjs start                    # detached watch (single instance)
 *   node .claude/forge-bin/usage-guard.cjs stop                     # stop the detached watcher
 *   node .claude/forge-bin/usage-guard.cjs credits                  # print purchased usage-credit balance (extra_usage)
 *   node .claude/forge-bin/usage-guard.cjs override-on [--reason ..] [--until <iso>]  # work on credits: suppress the plan-limit guard until credits run out
 *   node .claude/forge-bin/usage-guard.cjs override-off             # re-arm the normal plan-limit guard
 *
 * OWNER OVERRIDE: when usage credits are bought, `override-on` sets state.ownerOverride so the guard
 * (and the session hook) stop pausing on the plan limit; the watchdog auto-clears it the moment the
 * credits are exhausted (extra_usage used >= limit / disabled) and re-arms the normal guard.
 *
 * RESET-RHYTHM AUTO-RESUME: on pause, the guard also stores `resumeAtEpoch` = the SOONEST crossed
 * metric's official `resets_at` + `--grace-min` (default 5) minutes. The exact reset second can flip
 * the usage endpoint before a poll observes it, so resume is deliberately timed ~5 min AFTER the
 * reset instant rather than racing it. While paused, tick() resumes on EITHER the real utilization
 * dropping to <= resume-at (existing behavior) OR wall-clock time reaching resumeAtEpoch — whichever
 * comes first. resumeAtEpoch is cleared on every resume and recomputed fresh from the next pause.
 *
 * NVIDIA-SHIFT SOFT THRESHOLD (owner policy, advisory only — never pauses/blocks anything): at
 * `--nvidia-shift-at` (default 80) weekly usage %, the guard signals that NVIDIA agents should be
 * PREFERRED over Claude agents for new routing decisions, without any quality downgrade. This is
 * purely a routing hint for callers (e.g. forge-router) — the existing pause behavior at `--pause-at`
 * is completely unchanged and always wins above it (nothing here alters pause/resume semantics). On
 * every `status` and `watch` (tick) evaluation, the guard writes `FORGE_USAGE_PRESSURE.json` next to
 * the other guard state files: {"level":"nvidia-preferred"|"normal"|"unknown","week":<n|null>,
 * "nvidia_shift_at":<n>,"pause_at":<n>,"updated_at":"<iso>"} — always written (even when usage data is
 * missing/unreadable, as level "unknown") so a reader never sees a stale flag. `status` additionally
 * prints a one-line `pressure: ...` summary. Real week% only — never fabricated.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const HOME = path.join(os.homedir(), '.claude');
const CRED_FILE = path.join(HOME, '.credentials.json');
const STATE_FILE = process.env.FORGE_USAGE_GUARD_STATE || argv('state', path.join(HOME, 'FORGE_USAGE_GUARD_STATE.json'));
const PRESSURE_FILE = process.env.FORGE_USAGE_PRESSURE_FILE || path.join(HOME, 'FORGE_USAGE_PRESSURE.json');
const PID_FILE = path.join(HOME, 'forge-usage-guard.pid');
const LOG_FILE = path.join(HOME, 'forge-usage-guard.log');
const PC_BASE = process.env.PAPERCLIP_URL || 'http://127.0.0.1:3100';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
function argv(name, dflt) { const a = process.argv.slice(2); const i = a.indexOf('--' + name); return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : dflt; }
const has = (f) => args.includes('--' + f);
const PAUSE_AT = Number(argv('pause-at', 93)); // owner 2026-07-09: pause at 93% (headroom before rate-limit)
const RESUME_AT = Number(argv('resume-at', 0));
// owner policy: at ~80% weekly usage, PREFER NVIDIA agents over Claude agents (no quality downgrade) —
// purely advisory (see NVIDIA-SHIFT SOFT THRESHOLD doc above). Same config mechanism as PAUSE_AT
// (CLI arg + default; never itself read back from state — only recorded there for observability).
const NVIDIA_SHIFT_AT = Number(argv('nvidia-shift-at', 80));
const INTERVAL = Math.max(30, Number(argv('interval', 120)));
const _graceMinRaw = Number(argv('grace-min', 5));
const GRACE_MIN = Number.isFinite(_graceMinRaw) && _graceMinRaw >= 0 ? _graceMinRaw : 5; // reset-rhythm grace period (minutes)
const ONLY_COMPANIES = (argv('companies', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const DRY = has('dry-run');

function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { mode: 'ok' }; } }
/** writeStateTo(file, s) — THE single choke point for every state write (audit finding 2026-08-03).
 *  doPause()/doResume() deliberately build a FRESH state object so a stale pause cannot survive, carrying
 *  only ownerOverride/credits forward by hand. The account stamp was not on that hand-written carry list,
 *  so every pause/resume erased it and the next tick mistook a REAL account switch for a first stamp —
 *  the account gate died exactly when it mattered. Carrying it here (unless the writer explicitly sets a
 *  new one, which is what a genuine switch does) makes that impossible to forget at any future call site.
 *  Every write also stamps a heartbeat: a watcher that stopped ticking is then visible in the state
 *  itself, not only in a PID that outlives the work it was supposed to be doing. */
function writeStateTo(file, s) {
  const next = Object.assign({}, s);
  if (!next.account) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prev && prev.account) next.account = prev.account;
    } catch { /* no previous state — nothing to carry */ }
  }
  next.heartbeatAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}
function writeState(s) { return writeStateTo(STATE_FILE, s); }

// ---- NVIDIA-shift soft threshold — pure, advisory-only classification (never fabricates a %) ----
function computePressureLevel(weekPct, nvidiaShiftAt) {
  if (!Number.isFinite(weekPct) || !Number.isFinite(nvidiaShiftAt)) return 'unknown';
  return weekPct >= nvidiaShiftAt ? 'nvidia-preferred' : 'normal';
}
function buildPressureData(weekPct, nvidiaShiftAt, pauseAt) {
  return {
    level: computePressureLevel(weekPct, nvidiaShiftAt),
    week: Number.isFinite(weekPct) ? weekPct : null,
    nvidia_shift_at: nvidiaShiftAt,
    pause_at: pauseAt,
    updated_at: new Date().toISOString(),
  };
}
// writes unconditionally (even level:"unknown") so a reader never sees a stale flag — advisory only,
// never pauses/blocks anything and never influences the real pause/resume decision above.
function writePressureFile(weekPct, nvidiaShiftAt, pauseAt) {
  const data = buildPressureData(weekPct, nvidiaShiftAt, pauseAt);
  try { fs.writeFileSync(PRESSURE_FILE, JSON.stringify(data, null, 2) + '\n'); }
  catch (e) { log('pressure-file write failed (no action taken): ' + e.message); }
  return data;
}

// ---- ACCOUNT IDENTITY (2026-08-03) --------------------------------------------------------------
// MEASURED DEFECT: the owner switches between TWO Claude accounts. Nothing in this guard carried an
// account identity, so ONE state file served both: after a switch the state still held account A's
// numbers (week 37%) while the live endpoint reported account B (week 86%) — pause/resume decisions,
// the pressure signal and the credits override were all being made on the wrong account's data.
// Identity is a SHORT SHA-256 FINGERPRINT, never the raw uuid/email/token: state files are read by
// dashboards, synced between projects and (sanitized) published, so no raw identifier may land in one.
const IDENTITY_FILE = path.join(os.homedir(), '.claude.json'); // Claude Code's own profile store
function fingerprintAccount(oauthAccount) {
  const a = oauthAccount || {};
  const uuid = typeof a.accountUuid === 'string' ? a.accountUuid.trim() : '';
  if (uuid) {
    const org = typeof a.organizationUuid === 'string' ? a.organizationUuid.trim() : '';
    return { fp: crypto.createHash('sha256').update('acct:' + uuid + '|org:' + org).digest('hex').slice(0, 12), source: 'account-uuid' };
  }
  return { fp: null, source: 'unknown' };
}
/** readAccountIdentity — best-effort, never throws. Primary source is Claude Code's own oauthAccount
 *  profile; the fallback fingerprints the refresh token (stable within one login) so a machine without
 *  the profile file still distinguishes accounts. Unknown identity is reported honestly and must never
 *  be treated as "same account" evidence (see detectAccountSwitch). */
function readAccountIdentity() {
  try {
    const j = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    const id = fingerprintAccount(j && j.oauthAccount);
    if (id.fp) return id;
  } catch { /* fall through to the token fallback */ }
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    const rt = cred && cred.claudeAiOauth && cred.claudeAiOauth.refreshToken;
    if (typeof rt === 'string' && rt) {
      return { fp: crypto.createHash('sha256').update('rt:' + rt).digest('hex').slice(0, 12), source: 'refresh-token' };
    }
  } catch { /* no identity available */ }
  return { fp: null, source: 'unknown' };
}
/** detectAccountSwitch(state, ident) -> {switched, from, to, reason}. Pure. A switch requires TWO known
 *  fingerprints that differ: an unstamped legacy state (adoption) and an unknown current identity both
 *  degrade to "no switch" — wiping real state on a missing profile file would be worse than the bug. */
function detectAccountSwitch(state, ident) {
  const from = state && state.account && typeof state.account.fp === 'string' ? state.account.fp : null;
  const to = ident && typeof ident.fp === 'string' ? ident.fp : null;
  if (!from) return { switched: false, from: null, to, reason: to ? 'first-stamp (adoption)' : 'no identity available' };
  if (!to) return { switched: false, from, to: null, reason: 'current identity unknown — keeping existing state rather than guessing' };
  if (from === to) return { switched: false, from, to, reason: 'same account' };
  return { switched: true, from, to, reason: 'account fingerprint changed' };
}
/** stateForAccount(state, ident) -> state to use for THIS account. On a real switch the guard starts
 *  CLEAN: percentages, pause/trigger, paused-agent list and — deliberately — the paid-credits
 *  ownerOverride are account-A facts and must never suppress or trip the guard on account B. The switch
 *  itself is recorded (previousAccount) rather than erased. */
function stateForAccount(state, ident) {
  const st = state && typeof state === 'object' ? state : { mode: 'ok' };
  const sw = detectAccountSwitch(st, ident);
  if (!sw.switched) {
    if (sw.to && (!st.account || st.account.fp !== sw.to)) {
      return Object.assign({}, st, { account: { fp: sw.to, source: ident.source, stampedAt: new Date().toISOString() } });
    }
    return st;
  }
  return {
    mode: 'ok',
    account: { fp: sw.to, source: ident.source, stampedAt: new Date().toISOString() },
    previousAccount: { fp: sw.from, switchedAt: new Date().toISOString(), lastPercents: st.percents || null },
    accountSwitchNotice: 'ACCOUNT SWITCH gedetecteerd (' + sw.from + ' -> ' + sw.to + '): guard-state is opnieuw begonnen. '
      + 'Cijfers, pauze-status en een eventuele credits-override van het vorige account zijn NIET overgenomen.',
  };
}

// ---- TYPED USAGE WINDOWS (2026-08-03) ------------------------------------------------------------
// MEASURED DEFECT: the endpoint now returns a typed `limits` array (kinds seen live: session,
// weekly_all, weekly_scoped with a per-model scope) alongside the legacy five_hour/seven_day fields.
// The guard read ONLY those two legacy fields, so every other window — a scoped per-model limit, and
// any daily window — was invisible: it could sit at 100% while the guard happily reported "ok".
// normalizeWindows() reads the typed array when present (that is the authoritative, forward-compatible
// shape: unknown future kinds are carried through unchanged) and falls back to the legacy pair.
function windowLabel(l) {
  const kind = l && l.kind ? String(l.kind) : 'onbekend';
  const model = l && l.scope && l.scope.model && l.scope.model.display_name;
  const surface = l && l.scope && l.scope.surface;
  const extra = [model, surface].filter(Boolean).join('/');
  return extra ? kind + ' (' + extra + ')' : kind;
}
function normalizeWindows(j) {
  const out = [];
  const seen = new Set();
  // CODEX ADVERSARIAL REVIEW (gpt-5.6-sol, 2026-08-03) finding #10: the first version RETURNED EARLY as
  // soon as limits[] yielded one usable entry, which silently dropped the legacy pair. A response with
  // limits=[{weekly_scoped, 10%}] and five_hour=99% then reported ONLY 10% and would never pause — the
  // exact blindness this rewrite existed to remove, reintroduced from the other side. Typed windows WIN
  // per identity (kind+group+scope), legacy fills the gaps, and nothing is counted twice.
  const key = (kind, group, label) => kind + '|' + (group || '') + '|' + (label || '');
  const limits = j && Array.isArray(j.limits) ? j.limits : null;
  if (limits && limits.length) {
    for (const l of limits) {
      // `Number(null)` is 0, so a null/absent percent would silently become a confident "0% used".
      // NO data must stay no data (same discipline as the legacy `utilization ?? NaN` read below).
      const raw = l && l.percent != null ? l.percent : NaN;
      const pct = Number(raw);
      if (!Number.isFinite(pct)) continue;
      const kind = l.kind ? String(l.kind) : 'onbekend';
      const group = l.group ? String(l.group) : null;
      const label = windowLabel(l);
      const k = key(kind, group, label);
      if (seen.has(k)) continue; // a duplicate typed record must not be counted (or resumed from) twice
      seen.add(k);
      out.push({ kind, group, pct, resetsAt: (l && l.resets_at) || null, severity: (l && l.severity) || null,
        isActive: l && l.is_active === true, label, source: 'limits' });
    }
  }
  const legacy = [['session', 'session', j && j.five_hour], ['weekly_all', 'weekly', j && j.seven_day]];
  for (const [kind, group, w] of legacy) {
    const pct = Number(w && w.utilization != null ? w.utilization : NaN);
    if (!Number.isFinite(pct)) continue;
    if (seen.has(key(kind, group, kind))) continue; // already reported as a typed window — same window
    seen.add(key(kind, group, kind));
    out.push({ kind, group, pct, resetsAt: (w && w.resets_at) || null,
      severity: null, isActive: false, label: kind, source: 'legacy' });
  }
  return out;
}
/** crossedWindows(windows, pauseAt) -> the windows at/over the pause threshold, ANY kind. */
function crossedWindows(windows, pauseAt) {
  if (!Number.isFinite(pauseAt)) return [];
  return (Array.isArray(windows) ? windows : []).filter((w) => Number.isFinite(w.pct) && w.pct >= pauseAt);
}
/** watcherHealth — a live PID is NOT proof the watcher is doing its job: on 2026-08-03 the process was
 *  alive while its last real check was 80 minutes old (it had silently stopped ticking). Freshness is
 *  judged against 3 intervals; no timestamp at all is honest uncertainty, never a green light. */
function watcherHealth(o) {
  const now = Number.isFinite(o && o.now) ? o.now : Date.now();
  const intervalSec = Number.isFinite(o && o.intervalSec) && o.intervalSec > 0 ? o.intervalSec : 120;
  if (!o || !o.pidAlive) return { state: 'not-running', staleSec: null, intervalSec };
  const ms = o.lastCheckAt ? Date.parse(o.lastCheckAt) : NaN;
  if (!Number.isFinite(ms)) return { state: 'unknown', staleSec: null, intervalSec };
  const staleSec = Math.max(0, Math.round((now - ms) / 1000));
  return { state: staleSec > intervalSec * 3 ? 'stale' : 'running', staleSec, intervalSec };
}

// ---- real usage (official endpoint; token in-memory only, never logged) ----
function readToken() {
  const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
  const t = cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
  if (!t) throw new Error('no OAuth token in ' + CRED_FILE);
  return t;
}
async function fetchUsage() {
  const r = await fetch(USAGE_URL, { headers: { authorization: 'Bearer ' + readToken(), 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' } });
  if (!r.ok) throw new Error('usage endpoint HTTP ' + r.status);
  const j = await r.json();
  const fh = j.five_hour || {}, sd = j.seven_day || {};
  return {
    session: { pct: Number(fh.utilization ?? NaN), resetsAt: fh.resets_at || null },
    week: { pct: Number(sd.utilization ?? NaN), resetsAt: sd.resets_at || null },
    // every window the endpoint reports, typed — session/weekly_all/weekly_scoped and any future kind
    // (see normalizeWindows). The two named fields above stay for the existing pressure/reporting paths.
    windows: normalizeWindows(j),
    credits: creditsFrom(j),
  };
}
// ---- purchased usage credits ("extra_usage") — the SEPARATE budget that keeps working past the plan limit ----
function creditsFrom(j) { const e = (j && j.extra_usage);
  const present = !!e && typeof e === 'object';        // distinguish "no credit data" from "credits disabled" (fix 2026-07-09)
  const src = present ? e : {};
  const limit = Number(src.monthly_limit), used = Number(src.used_credits);
  return { present, enabled: src.is_enabled === true, limit, used,
    remaining: (Number.isFinite(limit) && Number.isFinite(used)) ? (limit - used) : NaN,
    disabledReason: src.disabled_reason || null, currency: src.currency || 'EUR', decimals: Number(src.decimal_places != null ? src.decimal_places : 2) }; }
function creditsExhausted(c) { if (!c || !c.present) return false; // NO data (endpoint omitted extra_usage) → do NOT lift the override
  if (c.enabled === false) return true;                 // extra usage turned off / depleted
  if (c.disabledReason) return true;                    // provider disabled it (e.g. spend limit reached)
  if (Number.isFinite(c.remaining) && c.remaining <= 0) return true; // spend limit hit
  return false; }
function fmtMoney(cents, cur, dec) { if (!Number.isFinite(cents)) return '?'; dec = dec == null ? 2 : dec; return '€' + (cents / Math.pow(10, dec)).toFixed(dec) + (cur && cur !== 'EUR' ? ' ' + cur : ''); }

// ---- paperclip helpers (loopback only) ----
async function pc(method, p, body) {
  try {
    const r = await fetch(PC_BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  } catch (e) { return { status: 0, json: null, err: String(e.message) }; }
}
async function allAgents() {
  const comps = await pc('GET', '/api/companies');
  if (!Array.isArray(comps.json)) return null; // runtime down / unreachable
  const out = [];
  for (const c of comps.json) {
    if (ONLY_COMPANIES.length && !ONLY_COMPANIES.includes(c.name)) continue;
    const ag = await pc('GET', '/api/companies/' + c.id + '/agents');
    for (const a of (Array.isArray(ag.json) ? ag.json : [])) out.push({ id: a.id, name: a.name, company: c.name, status: a.status });
  }
  return out;
}

// A null/absent/unparseable reset must read as "onbekend" — `new Date(null)` is the epoch, which printed
// a confident, fabricated-looking "1/1/1970" in every notice and status line (measured 2026-08-03).
function fmtReset(iso) {
  if (iso === null || iso === undefined || iso === '') return 'onbekend';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'onbekend';
  try { return new Date(ms).toLocaleString(); } catch { return String(iso); }
}

// ---- transitions ----
async function doPause(u, crossed) {
  const cur = readState(); // preserve owner intent across a pause (fix 2026-07-09 checkup)
  const agents = await allAgents();
  const toPause = (agents || []).filter((a) => a.status !== 'paused');
  const reason = 'USAGE GUARD: ' + crossed.map((c) => c.name + ' ' + c.pct + '%').join(' + ') + ' >= ' + PAUSE_AT + '% — auto-paused. Auto-resume when back to <= ' + RESUME_AT + '%.';
  if (DRY) { log('[dry-run] WOULD pause ' + toPause.length + ' agents (' + reason + ')'); return; }
  const paused = [];
  for (const a of toPause) {
    const r = await pc('POST', '/api/agents/' + a.id + '/pause', { reason });
    if (r.status >= 200 && r.status < 300) paused.push({ id: a.id, name: a.name, company: a.company });
  }
  // RESET-RHYTHM: resumeAtEpoch = soonest crossed metric's resets_at + GRACE_MIN. NaN-safe — if every
  // crossed metric's resets_at is unparseable, resumeAtEpoch is OMITTED (not stored as null/NaN) so
  // both this watchdog and the hook fall back cleanly to the utilization-based resume only.
  let soonestResetMs = NaN;
  for (const c of crossed) {
    // the crossed window carries its OWN resets_at (typed windows); the legacy session/week lookup is
    // only the fallback for a caller that still passes the old {metric:'session'|'week'} shape.
    const resetsAt = c.resetsAt || (c.metric === 'session' ? u.session.resetsAt : u.week.resetsAt);
    const ms = Date.parse(resetsAt);
    if (Number.isFinite(ms)) soonestResetMs = Number.isFinite(soonestResetMs) ? Math.min(soonestResetMs, ms) : ms;
  }
  const resumeAtEpoch = Number.isFinite(soonestResetMs) ? (soonestResetMs + GRACE_MIN * 60000) : NaN;
  writeState({
    mode: 'paused', trigger: crossed, pauseAt: PAUSE_AT, resumeAt: RESUME_AT,
    // NEVER silently drop the owner's paid-credits override / last credit snapshot on a pause — the hook
    // reads ownerOverride to keep working; a fresh object without it defeated that (boekhouder flapping).
    ...(cur.ownerOverride ? { ownerOverride: cur.ownerOverride } : {}),
    ...(cur.credits ? { credits: cur.credits } : {}),
    percents: { session: u.session.pct, week: u.week.pct }, resets: { session: u.session.resetsAt, week: u.week.resetsAt },
    pausedAgents: paused, lastPauseAt: new Date().toISOString(), lastCheckAt: new Date().toISOString(),
    graceMin: GRACE_MIN,
    ...(Number.isFinite(resumeAtEpoch) ? { resumeAtEpoch } : {}),
    notice: '⛔ USAGE GUARD — PAUZEER. Gemeten (echt): sessie ' + u.session.pct + '% · week ' + u.week.pct + '% (drempel ' + PAUSE_AT + '%). '
      + 'Geen nieuwe subagents/workflows starten. Rond lopend werk minimaal af en meld de pauze. '
      + 'Auto-hervat bij <= ' + RESUME_AT + '% (sessie-reset: ' + fmtReset(u.session.resetsAt) + ')'
      + (Number.isFinite(resumeAtEpoch) ? ', of ritme-hervat rond ' + fmtReset(new Date(resumeAtEpoch).toISOString()) + ' (reset + ' + GRACE_MIN + ' min marge)' : '') + '. '
      + (agents === null ? '(Paperclip runtime onbereikbaar — geen agents te pauzeren; subagent-stop geldt wel.)' : paused.length + ' Paperclip agents gepauzeerd (dashboard blijft UP).'),
  });
  log('PAUSED — ' + reason + ' · paperclip agents paused: ' + paused.length + (agents === null ? ' (runtime unreachable)' : '') + (Number.isFinite(resumeAtEpoch) ? ' · rhythm-resume at ' + new Date(resumeAtEpoch).toISOString() : ' · rhythm-resume: n/a (unparseable resets_at)'));
}
async function doResume(u, st) {
  if (DRY) { log('[dry-run] WOULD resume ' + (st.pausedAgents || []).length + ' agents'); return; }
  let ok = 0;
  for (const a of (st.pausedAgents || [])) { // ONLY what the guard paused — never human-paused agents
    const r = await pc('POST', '/api/agents/' + a.id + '/resume', {});
    if (r.status >= 200 && r.status < 300) ok++;
  }
  writeState({
    mode: 'ok', percents: { session: u.session.pct, week: u.week.pct }, resets: { session: u.session.resetsAt, week: u.week.resetsAt },
    ...(st.ownerOverride ? { ownerOverride: st.ownerOverride } : {}), // survive the reset (credits mode is orthogonal)
    lastResumeAt: new Date().toISOString(), lastCheckAt: new Date().toISOString(), resumedAgents: ok, pendingCheckup: true,
    resumeNotice: '✅ USAGE GUARD — usage gereset (sessie ' + u.session.pct + '% · week ' + u.week.pct + '%). GA VERDER met waar je mee bezig was. '
      + 'VERPLICHTE CHECKUP: (1) verifieer via de Paperclip API dat de agents resumed zijn en ECHT draaien (statuses + heartbeat-runs/tickets bewegen), '
      + '(2) verifieer dat je eigen taak-status klopt met de werkelijkheid, (3) rapporteer eerlijk wat wel/niet hervat is. '
      + ok + '/' + (st.pausedAgents || []).length + ' Paperclip agents hervat.',
  });
  log('RESUMED — session ' + u.session.pct + '% week ' + u.week.pct + '% · agents resumed: ' + ok + '/' + (st.pausedAgents || []).length);
}

async function tick() {
  let u;
  try { u = await fetchUsage(); } catch (e) {
    const st = readState(); st.lastError = String(e.message); st.lastCheckAt = new Date().toISOString(); writeState(st);
    writePressureFile(NaN, NVIDIA_SHIFT_AT, PAUSE_AT); // level "unknown" — write on EVERY evaluation, no stale flag
    log('CHECK FAILED (no action taken — fail-safe): ' + e.message); return;
  }
  // advisory NVIDIA-shift pressure signal — written on every watch evaluation, before any pause/resume
  // branching below, so it fires regardless of which branch this tick takes (pause always wins for the
  // real pause/resume decision; this file never influences it).
  writePressureFile(u.week.pct, NVIDIA_SHIFT_AT, PAUSE_AT);
  if (!(u.windows || []).length) { log('CHECK: endpoint reported no usable usage window (no action)'); return; }
  // ACCOUNT GATE (2026-08-03): resolve identity BEFORE any decision is made on the stored state, so a
  // switch can never be decided on the previous account's percentages/pause/override.
  const ident = readAccountIdentity();
  const rawState = readState();
  const sw = detectAccountSwitch(rawState, ident);
  const st = stateForAccount(rawState, ident);
  if (sw.switched) {
    writeState(st);
    log('ACCOUNT SWITCH — fingerprint ' + sw.from + ' -> ' + sw.to + ' (' + ident.source + '): guard state reset; previous account\'s percentages, pause state and credits override NOT carried over');
  }
  // OWNER OVERRIDE (usage credits): while purchased credits remain, do NOT pause on the plan limit.
  // Auto re-arm the normal guard the moment credits are exhausted (or the override's optional expiry passes).
  if (st.ownerOverride && st.ownerOverride.active !== false) {
    // an unparseable `until` = NO expiry (ignore it) so hook + watchdog agree (fix 2026-07-09 checkup)
    const untilMs = st.ownerOverride.until ? Date.parse(st.ownerOverride.until) : NaN;
    const expired = Number.isFinite(untilMs) && Date.now() > untilMs;
    const c = u.credits;
    if (!expired && !creditsExhausted(c)) {
      st.mode = 'ok'; st.percents = { session: u.session.pct, week: u.week.pct }; st.credits = c;
      st.lastCheckAt = new Date().toISOString(); delete st.lastError; writeState(st);
      const low = Number.isFinite(c.remaining) && Number.isFinite(c.limit) && c.limit > 0 && (c.remaining / c.limit) <= 0.1;
      log('OVERRIDE active (credits mode) — NOT pausing · session ' + u.session.pct + '% week ' + u.week.pct + '% · credits used ' + fmtMoney(c.used, c.currency, c.decimals) + '/' + fmtMoney(c.limit, c.currency, c.decimals) + (low ? ' · ⚠ CREDITS LOW' : ''));
      return;
    }
    log('OVERRIDE lifted — ' + (expired ? 'override expired' : 'credits exhausted') + ' (used ' + fmtMoney(c && c.used, c && c.currency, c && c.decimals) + '/' + fmtMoney(c && c.limit, c && c.currency, c && c.decimals) + ') → normal guard re-armed');
    delete st.ownerOverride; writeState(st);
    // fall through to the normal pause/resume logic below (pauses if still over the plan limit)
  }
  if (st.mode !== 'paused') {
    // EVERY reported window can trip the guard, not just the legacy session/week pair — a daily or
    // per-model scoped limit at 100% used to be completely invisible here (fix 2026-08-03).
    const crossed = crossedWindows(u.windows, PAUSE_AT)
      .map((w) => ({ name: w.label, metric: w.kind, pct: w.pct, resetsAt: w.resetsAt }));
    if (crossed.length) { await doPause(u, crossed); return; }
    // keep pauseAt/resumeAt fresh on every tick (fix 2026-07-08) — otherwise a running watchdog started
    // with a different --pause-at than the last actual pause event leaves a stale threshold in the
    // state file, even though the real in-process trigger (PAUSE_AT, checked above) is already correct.
    st.mode = 'ok'; st.pauseAt = PAUSE_AT; st.resumeAt = RESUME_AT; st.nvidiaShiftAt = NVIDIA_SHIFT_AT; st.percents = { session: u.session.pct, week: u.week.pct }; st.lastCheckAt = new Date().toISOString(); delete st.lastError; writeState(st);
    // log EVERY window, not just the legacy pair — otherwise a daily/scoped limit climbing toward 100%
    // is invisible in the log as well as in the decision (fix 2026-08-03).
    log('ok — ' + (u.windows || []).map((w) => w.label + ' ' + w.pct + '%').join(' · ') + ' (pause-at ' + PAUSE_AT + '%)');
  } else {
    // Look the CURRENT value of each triggering window up by its own kind (typed windows); the legacy
    // session/week pair remains the fallback for a trigger recorded by an older build.
    const curPct = (t) => {
      const w = (u.windows || []).find((x) => x.kind === t.metric);
      if (w && Number.isFinite(w.pct)) return w.pct;
      return t.metric === 'session' ? u.session.pct : u.week.pct;
    };
    const stillHigh = (st.trigger || []).some((t) => curPct(t) > RESUME_AT);
    // RESET-RHYTHM: resume on EITHER the real utilization drop OR wall-clock reaching resumeAtEpoch —
    // whichever comes first. NaN-safe: an absent/unparseable resumeAtEpoch never triggers this branch.
    const resumeAtEpoch = Number(st.resumeAtEpoch);
    const rhythmDue = Number.isFinite(resumeAtEpoch) && Date.now() >= resumeAtEpoch;
    if (!stillHigh || rhythmDue) { await doResume(u, st); return; }
    st.percents = { session: u.session.pct, week: u.week.pct }; st.lastCheckAt = new Date().toISOString(); writeState(st);
    log('paused — waiting for reset (session ' + u.session.pct + '% · week ' + u.week.pct + '% · resume at <= ' + RESUME_AT + '%' + (Number.isFinite(resumeAtEpoch) ? ' · or rhythm-resume at ' + new Date(resumeAtEpoch).toISOString() : '') + ')');
  }
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
/** readPidRecord — the pid file is now {pid,startedAt,script}; a bare number is the legacy form and is
 *  still read (never break an already-running watcher), just without the extra identity evidence. */
function readPidRecord() {
  let raw = '';
  try { raw = fs.readFileSync(PID_FILE, 'utf8').trim(); } catch { return { pid: 0, legacy: false }; }
  if (!raw) return { pid: 0, legacy: false };
  try { const j = JSON.parse(raw); if (j && Number(j.pid)) return { pid: Number(j.pid), startedAt: j.startedAt || null, script: j.script || null, legacy: false }; } catch { /* legacy bare number */ }
  return { pid: Number(raw) || 0, startedAt: null, script: null, legacy: true };
}
/** ownsPid — HARD RULE (owner directive after the 2026-07-29 incident where a cleanup killed an unrelated
 *  service): only ever kill a process we can PROVE is ours. Windows recycles PIDs, and the stale pid file
 *  found on 2026-08-03 pointed at a number no longer belonging to any watcher — a `taskkill /T /F` on that
 *  number could have taken down an unrelated process tree. We verify the live command line still refers to
 *  this script before killing anything; when we cannot verify, we refuse and say so. */
function ownsPid(pid, rec) {
  if (!pid || !pidAlive(pid)) return { ok: false, reason: 'process not running' };
  if (process.platform !== 'win32') {
    // CODEX finding #17: the verification was Windows-only. Elsewhere we cannot read another process's
    // command line without extra tooling, so we only accept a pid this install itself recorded WITH its
    // own script path — and refuse otherwise rather than killing something unverified.
    if (rec && rec.script && path.resolve(rec.script) === path.resolve(__filename)) return { ok: true, cmdline: '(recorded by this script; command line not verifiable on ' + process.platform + ')' };
    return { ok: false, reason: 'cannot verify pid ' + pid + ' on ' + process.platform + ' (no recorded script match) — refusing to kill it' };
  }
  try {
    const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \'ProcessId=' + Number(pid) + '\').CommandLine"', { encoding: 'utf8', windowsHide: true }).trim();
    if (!out) return { ok: false, reason: 'no command line readable for pid ' + pid };
    // CODEX finding #16: matching the bare word "usage-guard" also matched a `usage-guard.cjs status`
    // process or a helper with that substring in its name. Require the EXACT recorded script path (when
    // the pid file has one) AND the `watch` subcommand — a status/CLI invocation is never the watcher.
    const scriptName = path.basename(__filename).toLowerCase();
    const lower = out.toLowerCase();
    const scriptOk = rec && rec.script
      ? lower.includes(path.resolve(rec.script).toLowerCase()) || lower.includes(path.basename(rec.script).toLowerCase())
      : lower.includes(scriptName);
    if (!scriptOk) return { ok: false, reason: 'pid ' + pid + ' does not run this guard script (recycled pid) — refusing to kill it' };
    if (!/\bwatch\b/.test(lower)) return { ok: false, reason: 'pid ' + pid + ' runs the guard script but NOT as a watcher (e.g. a status/CLI call) — refusing to kill it' };
    return { ok: true, cmdline: out };
  } catch (e) { return { ok: false, reason: 'could not verify pid ' + pid + ' (' + e.message + ') — refusing to kill it' }; }
}

// CLI only when run directly — require()-ing this file used to immediately hit the live usage endpoint,
// which is why its own tests had to MIRROR the logic inline instead of testing the real functions
// (2026-08-03: the mirrored copies were what let the account/limits gaps go untested for so long).
if (require.main === module) {
  (async () => {
  if (cmd === 'check' || cmd === 'status') {
    let u;
    try {
      u = await fetchUsage();
      // EVERY window the endpoint reports, typed — printing only session+week hid a daily/scoped limit
      // that could already be at 100% (fix 2026-08-03).
      const wl = (u.windows || []).map((w) => w.label + ' ' + w.pct + '% (reset ' + fmtReset(w.resetsAt) + ')').join(' · ');
      console.log('REAL usage (official endpoint) — ' + (wl || 'geen bruikbaar venster gerapporteerd'));
    } catch (e) {
      console.error('usage fetch failed: ' + e.message); process.exitCode = 1;
      if (cmd === 'status') { writePressureFile(NaN, NVIDIA_SHIFT_AT, PAUSE_AT); console.log('pressure: unknown (usage data unavailable — fetch failed)'); }
      return;
    }
    if (cmd === 'status') {
      const ident = readAccountIdentity();
      const rawSt = readState();
      const swNow = detectAccountSwitch(rawSt, ident);
      const st = rawSt;
      console.log('account: ' + (ident.fp ? ident.fp + ' (' + ident.source + ')' : 'ONBEKEND — geen accountidentiteit leesbaar')
        + (swNow.switched
          ? ' · ⚠ ACCOUNT SWITCH t.o.v. de opgeslagen state (' + swNow.from + ' -> ' + swNow.to + '): de cijfers/pauze/override hieronder zijn van het VORIGE account en worden bij de eerstvolgende watch-tick gereset'
          : (st.account ? '' : ' · state nog niet gestempeld (wordt bij de eerstvolgende tick geadopteerd)')));
      const ovr = st.ownerOverride && st.ownerOverride.active !== false ? ' · OVERRIDE ACTIVE (credits mode)' : '';
      const cr = st.credits ? ' · credits used ' + fmtMoney(st.credits.used, st.credits.currency, st.credits.decimals) + '/' + fmtMoney(st.credits.limit, st.credits.currency, st.credits.decimals) : '';
      console.log('guard state: ' + (st.mode || 'ok') + ' · pauseAt ' + (st.pauseAt != null ? st.pauseAt : '?') + '%' + ovr + cr + (st.lastPauseAt ? ' · lastPause ' + st.lastPauseAt : '') + (st.lastResumeAt ? ' · lastResume ' + st.lastResumeAt : ''));
      const rec = readPidRecord();
      const pid = rec.pid;
      // A live PID is not proof of a working watcher: on 2026-08-03 the process existed while its last
      // real check was 80 minutes old — it had silently stopped ticking and status still said RUNNING.
      // The heartbeat (stamped on every state write) is the freshness source; lastCheckAt is the fallback
      // for a state written by an older build.
      const wh = watcherHealth({ pidAlive: !!(pid && pidAlive(pid)), lastCheckAt: st.heartbeatAt || st.lastCheckAt, intervalSec: INTERVAL });
      const staleTxt = wh.staleSec != null ? ' · laatste check ' + Math.round(wh.staleSec / 60) + ' min geleden' : '';
      console.log('watcher: ' + (
        wh.state === 'running' ? 'RUNNING (pid ' + pid + ')' + staleTxt
        : wh.state === 'stale' ? '⚠ HANGT — proces leeft (pid ' + pid + ') maar tikt niet meer' + staleTxt + ' (interval ' + wh.intervalSec + 's); herstart met: node .claude/forge-bin/usage-guard.cjs stop && node .claude/forge-bin/usage-guard.cjs start'
        : wh.state === 'unknown' ? 'proces leeft (pid ' + pid + ') maar heeft nog nooit een check gelogd — status onbekend'
        : 'not running' + (pid ? ' (achtergebleven pid-bestand: ' + pid + ')' : '')));
      // NVIDIA-shift soft pressure signal — advisory only, real week% only, written on every status evaluation.
      const pressure = writePressureFile(u.week.pct, NVIDIA_SHIFT_AT, PAUSE_AT);
      if (pressure.level === 'nvidia-preferred') console.log('pressure: nvidia-preferred (week ' + u.week.pct + '% >= ' + NVIDIA_SHIFT_AT + '%)');
      else if (pressure.level === 'unknown') console.log('pressure: unknown (week usage data missing/unreadable)');
      else console.log('pressure: normal (week ' + u.week.pct + '% < ' + NVIDIA_SHIFT_AT + '%)');
    }
    return; // clean exit (process.exit after pending fetch handles triggers a libuv assertion on Windows)
  }
  if (cmd === 'credits') {
    try { const u = await fetchUsage(); const c = u.credits;
      console.log('usage credits (extra_usage): ' + (c.enabled ? 'ENABLED' : 'disabled') + ' · used ' + fmtMoney(c.used, c.currency, c.decimals) + ' / limit ' + fmtMoney(c.limit, c.currency, c.decimals) + ' · remaining ' + fmtMoney(c.remaining, c.currency, c.decimals) + (c.disabledReason ? ' · reason: ' + c.disabledReason : '') + (creditsExhausted(c) ? ' · EXHAUSTED' : ' · available'));
    } catch (e) { console.error('credits fetch failed: ' + e.message); process.exitCode = 1; }
    return;
  }
  if (cmd === 'override-on') {
    const st = readState();
    // best-effort resume any agents THIS guard paused — override-on used to strand them forever (fix 2026-07-09 checkup)
    let resumed = 0; const wasPaused = (st.pausedAgents || []).length;
    for (const a of (st.pausedAgents || [])) { const r = await pc('POST', '/api/agents/' + a.id + '/resume', {}); if (r.status >= 200 && r.status < 300) resumed++; }
    st.mode = 'ok'; st.pausedAgents = []; delete st.notice; delete st.pendingCheckup; delete st.lastError;
    let until = argv('until', null) || null;
    if (until && !Number.isFinite(Date.parse(until))) { console.error('ignoring invalid --until "' + until + '" (not a parseable date) — override will have no time expiry'); until = null; }
    st.ownerOverride = { active: true, at: new Date().toISOString(),
      reason: argv('reason', 'Eigenaar kocht usage credits — doorwerken op credits tot ze op zijn'),
      reArmWhenCreditsExhausted: true, until };
    writeState(st);
    console.log('usage-guard OVERRIDE ON — plan-limit guard suppressed' + (wasPaused ? ' · resumed ' + resumed + '/' + wasPaused + ' paused agent(s)' : '') + '; auto re-arm when credits exhausted' + (st.ownerOverride.until ? ' or after ' + st.ownerOverride.until : ''));
    process.exit(0);
  }
  if (cmd === 'override-off') {
    const st = readState(); const had = !!st.ownerOverride; delete st.ownerOverride; writeState(st);
    console.log('usage-guard OVERRIDE ' + (had ? 'CLEARED' : 'was not set') + ' — normal plan-limit guard re-armed');
    process.exit(0);
  }
  if (cmd === 'watch') {
    if (has('once')) { await tick(); return; }
    // refuse a 2nd concurrent watcher — two would race the same non-atomic state file (fix 2026-07-09 checkup)
    // CODEX finding #15: this still parsed the pid file as a BARE NUMBER after the writer switched to
    // JSON — Number('{"pid":123,…}') is NaN, so the "refuse a second watcher" guard silently stopped
    // guarding and two watchers could race the same non-atomic state file. Use the one reader.
    const existing = readPidRecord().pid;
    if (existing && existing !== process.pid && pidAlive(existing)) { console.error('another usage-guard watcher already running (pid ' + existing + ') — refusing to start a second'); process.exit(1); }
    log('usage-guard watch started — interval ' + INTERVAL + 's · pause-at ' + PAUSE_AT + '% · resume-at ' + RESUME_AT + '% · nvidia-shift-at ' + NVIDIA_SHIFT_AT + '%' + (ONLY_COMPANIES.length ? ' · companies: ' + ONLY_COMPANIES.join(',') : ''));
    // SILENT-DEATH GUARD (2026-08-03): on this machine the loop stopped at 16:55 without a single error
    // line while the process stayed alive — only fetchUsage() was inside a try/catch, so a throw anywhere
    // else (e.g. an EPERM/EBUSY on the state write) became an unhandled rejection that killed the ticking
    // but not the process. The watcher must never die quietly again: log it, and keep ticking.
    process.on('unhandledRejection', (e) => log('WATCHER unhandled rejection (loop kept alive): ' + ((e && e.stack) || e)));
    process.on('uncaughtException', (e) => log('WATCHER uncaught exception (loop kept alive): ' + ((e && e.stack) || e)));
    // The pid file now records WHO we are and WHEN we started, so `stop` can verify it is killing this
    // watcher and not whatever process later inherited a recycled PID (Windows reuses PIDs).
    fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), script: __filename }) + '\n');
    const safeTick = async () => { try { await tick(); } catch (e) { log('TICK FAILED (watcher stays alive): ' + ((e && e.stack) || e)); } };
    await safeTick();
    setInterval(safeTick, INTERVAL * 1000);
    return; // keep alive
  }
  if (cmd === 'start') {
    // A recycled PID must not make `start` believe a watcher exists — that would leave the account
    // permanently unguarded while the CLI cheerfully reports "already running" (audit, 2026-08-03).
    const rec = readPidRecord();
    if (rec.pid && ownsPid(rec.pid, rec).ok) { console.log('usage-guard already running (pid ' + rec.pid + ')'); process.exit(0); }
    if (rec.pid) console.log('note: stale pid file (' + rec.pid + ' is not a usage-guard process) — starting a fresh watcher');
    const out = fs.openSync(LOG_FILE, 'a');
    const extra = [];
    if (ONLY_COMPANIES.length) extra.push('--companies', ONLY_COMPANIES.join(','));
    if (argv('state', null)) extra.push('--state', argv('state'));
    // --grace-min was parsed but never forwarded, so `start --grace-min 30` silently ran on 5 (audit).
    extra.push('--grace-min', String(GRACE_MIN));
    if (DRY) extra.push('--dry-run');
    // stdout → ignore (log() already appendFileSync's to LOG_FILE; redirecting stdout too double-logged every line);
    // keep stderr → LOG_FILE so a crash is still captured (fix 2026-07-09 checkup).
    const child = spawn(process.execPath, [__filename, 'watch', '--interval', String(INTERVAL), '--pause-at', String(PAUSE_AT), '--resume-at', String(RESUME_AT), '--nvidia-shift-at', String(NVIDIA_SHIFT_AT), ...extra], { detached: true, stdio: ['ignore', 'ignore', out], windowsHide: true });
    child.unref();
    console.log('usage-guard started (pid ' + child.pid + ') — pause-at ' + PAUSE_AT + '% · resume-at ' + RESUME_AT + '% · nvidia-shift-at ' + NVIDIA_SHIFT_AT + '% · log: ' + LOG_FILE);
    process.exit(0);
  }
  if (cmd === 'stop') {
    // Never kill a PID we cannot prove is ours, and never `/T` (a tree-kill on a recycled pid is exactly
    // the incident class the owner's HARD MUST was written for). Unverifiable = refuse + say so.
    const rec = readPidRecord();
    if (!rec.pid) console.log('usage-guard not running (no pid file)');
    else {
      const own = ownsPid(rec.pid, rec);
      if (own.ok) {
        try {
          if (process.platform === 'win32') execSync('taskkill /PID ' + rec.pid + ' /F', { stdio: 'ignore' });
          else process.kill(rec.pid, 'SIGTERM');
        } catch { /* verified below by liveness, not by the exit code */ }
        // CODEX finding #17: the pid file used to be deleted unconditionally — including when the kill
        // was REFUSED or failed — which erased the only ownership evidence and let the next `start`
        // spawn a duplicate alongside a watcher that was still alive. Delete only on confirmed death.
        const dead = !pidAlive(rec.pid);
        if (dead) { try { fs.unlinkSync(PID_FILE); } catch {} console.log('usage-guard stopped (pid ' + rec.pid + ')'); }
        else console.log('usage-guard NOT stopped — pid ' + rec.pid + ' is still alive after the kill attempt; pid file kept so the next start does not spawn a duplicate');
      } else {
        console.log('usage-guard not stopped — ' + own.reason + (rec.startedAt ? ' (pid file written ' + rec.startedAt + ')' : '') + '; removing the stale pid file only');
        try { fs.unlinkSync(PID_FILE); } catch {}
      }
    }
    process.exit(0);
  }
  console.error('unknown command: ' + cmd + ' (use check|status|credits|watch|start|stop|override-on|override-off)');
  process.exit(1);
  })();
}

module.exports = {
  writeStateTo,
  fingerprintAccount, readAccountIdentity, detectAccountSwitch, stateForAccount,
  normalizeWindows, crossedWindows, windowLabel, watcherHealth, fmtReset,
  computePressureLevel, buildPressureData, creditsExhausted,
};
