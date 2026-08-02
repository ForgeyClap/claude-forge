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
function writeState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n'); }

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

function fmtReset(iso) { try { return new Date(iso).toLocaleString(); } catch { return String(iso); } }

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
    const resetsAt = c.metric === 'session' ? u.session.resetsAt : u.week.resetsAt;
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
  if (!Number.isFinite(u.session.pct) || !Number.isFinite(u.week.pct)) { log('CHECK: non-numeric utilization (no action)'); return; }
  const st = readState();
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
    const crossed = [];
    if (u.session.pct >= PAUSE_AT) crossed.push({ name: 'sessie', metric: 'session', pct: u.session.pct });
    if (u.week.pct >= PAUSE_AT) crossed.push({ name: 'week', metric: 'week', pct: u.week.pct });
    if (crossed.length) { await doPause(u, crossed); return; }
    // keep pauseAt/resumeAt fresh on every tick (fix 2026-07-08) — otherwise a running watchdog started
    // with a different --pause-at than the last actual pause event leaves a stale threshold in the
    // state file, even though the real in-process trigger (PAUSE_AT, checked above) is already correct.
    st.mode = 'ok'; st.pauseAt = PAUSE_AT; st.resumeAt = RESUME_AT; st.nvidiaShiftAt = NVIDIA_SHIFT_AT; st.percents = { session: u.session.pct, week: u.week.pct }; st.lastCheckAt = new Date().toISOString(); delete st.lastError; writeState(st);
    log('ok — session ' + u.session.pct + '% · week ' + u.week.pct + '% (pause-at ' + PAUSE_AT + '%)');
  } else {
    const stillHigh = (st.trigger || []).some((t) => (t.metric === 'session' ? u.session.pct : u.week.pct) > RESUME_AT);
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

(async () => {
  if (cmd === 'check' || cmd === 'status') {
    let u;
    try {
      u = await fetchUsage();
      console.log('REAL usage (official endpoint) — sessie(5h): ' + u.session.pct + '% (reset ' + fmtReset(u.session.resetsAt) + ') · week: ' + u.week.pct + '% (reset ' + fmtReset(u.week.resetsAt) + ')');
    } catch (e) {
      console.error('usage fetch failed: ' + e.message); process.exitCode = 1;
      if (cmd === 'status') { writePressureFile(NaN, NVIDIA_SHIFT_AT, PAUSE_AT); console.log('pressure: unknown (usage data unavailable — fetch failed)'); }
      return;
    }
    if (cmd === 'status') {
      const st = readState();
      const ovr = st.ownerOverride && st.ownerOverride.active !== false ? ' · OVERRIDE ACTIVE (credits mode)' : '';
      const cr = st.credits ? ' · credits used ' + fmtMoney(st.credits.used, st.credits.currency, st.credits.decimals) + '/' + fmtMoney(st.credits.limit, st.credits.currency, st.credits.decimals) : '';
      console.log('guard state: ' + (st.mode || 'ok') + ' · pauseAt ' + (st.pauseAt != null ? st.pauseAt : '?') + '%' + ovr + cr + (st.lastPauseAt ? ' · lastPause ' + st.lastPauseAt : '') + (st.lastResumeAt ? ' · lastResume ' + st.lastResumeAt : ''));
      const pid = Number((fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim()) || 0);
      console.log('watcher: ' + (pid && pidAlive(pid) ? 'RUNNING (pid ' + pid + ')' : 'not running'));
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
    const existing = Number((fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim()) || 0);
    if (existing && existing !== process.pid && pidAlive(existing)) { console.error('another usage-guard watcher already running (pid ' + existing + ') — refusing to start a second'); process.exit(1); }
    log('usage-guard watch started — interval ' + INTERVAL + 's · pause-at ' + PAUSE_AT + '% · resume-at ' + RESUME_AT + '% · nvidia-shift-at ' + NVIDIA_SHIFT_AT + '%' + (ONLY_COMPANIES.length ? ' · companies: ' + ONLY_COMPANIES.join(',') : ''));
    fs.writeFileSync(PID_FILE, String(process.pid));
    await tick();
    setInterval(tick, INTERVAL * 1000);
    return; // keep alive
  }
  if (cmd === 'start') {
    const pid = Number((fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim()) || 0);
    if (pid && pidAlive(pid)) { console.log('usage-guard already running (pid ' + pid + ')'); process.exit(0); }
    const out = fs.openSync(LOG_FILE, 'a');
    const extra = [];
    if (ONLY_COMPANIES.length) extra.push('--companies', ONLY_COMPANIES.join(','));
    if (argv('state', null)) extra.push('--state', argv('state'));
    if (DRY) extra.push('--dry-run');
    // stdout → ignore (log() already appendFileSync's to LOG_FILE; redirecting stdout too double-logged every line);
    // keep stderr → LOG_FILE so a crash is still captured (fix 2026-07-09 checkup).
    const child = spawn(process.execPath, [__filename, 'watch', '--interval', String(INTERVAL), '--pause-at', String(PAUSE_AT), '--resume-at', String(RESUME_AT), '--nvidia-shift-at', String(NVIDIA_SHIFT_AT), ...extra], { detached: true, stdio: ['ignore', 'ignore', out], windowsHide: true });
    child.unref();
    console.log('usage-guard started (pid ' + child.pid + ') — pause-at ' + PAUSE_AT + '% · resume-at ' + RESUME_AT + '% · nvidia-shift-at ' + NVIDIA_SHIFT_AT + '% · log: ' + LOG_FILE);
    process.exit(0);
  }
  if (cmd === 'stop') {
    const pid = Number((fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim()) || 0);
    if (pid && pidAlive(pid)) { try { execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' }); } catch {} console.log('usage-guard stopped (pid ' + pid + ')'); }
    else console.log('usage-guard not running');
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }
  console.error('unknown command: ' + cmd + ' (use check|status|credits|watch|start|stop|override-on|override-off)');
  process.exit(1);
})();
