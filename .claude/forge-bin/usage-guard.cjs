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
const { spawn, spawnSync, execSync } = require('child_process');

const HOME = path.join(os.homedir(), '.claude');
const CRED_FILE = path.join(HOME, '.credentials.json');
const STATE_FILE = process.env.FORGE_USAGE_GUARD_STATE || argv('state', path.join(HOME, 'FORGE_USAGE_GUARD_STATE.json'));
const PRESSURE_FILE = process.env.FORGE_USAGE_PRESSURE_FILE || path.join(HOME, 'FORGE_USAGE_PRESSURE.json');
const PID_FILE = process.env.FORGE_USAGE_GUARD_PID || path.join(HOME, 'forge-usage-guard.pid');
const LOG_FILE = process.env.FORGE_USAGE_GUARD_LOG || path.join(HOME, 'forge-usage-guard.log');
// COMPENSATIEJOURNAL (uitgesteld punt 1, gesloten 2026-08-06): account-ONAFHANKELIJK append-only journal
// van door de guard gepauzeerde Paperclip-agents. stateForAccount() reset bij een account-switch de state
// (terecht — cijfers van A mogen B niet sturen), maar de pausedAgents-lijst stond ALLEEN in die state:
// agents die onder account A gepauzeerd waren, waren na een switch voorgoed onvindbaar en bleven hangen
// tot een mens ze handmatig hervatte. Paperclip is een lokale, account-agnostische runtime — hervatten
// onder account B van wat de guard zelf onder A pauzeerde is precies de bedoeling.
const PAUSED_JOURNAL = process.env.FORGE_USAGE_GUARD_JOURNAL || path.join(HOME, 'forge-usage-guard-paused.jsonl');
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

// LOGROTATIE (audit G9a, 2026-08-06): het logbestand groeide onbegrensd (appendFileSync zonder enige
// check — gemeten: multi-MB op deze machine). Bij >5MB roteert log() naar .1 (twee generaties: actueel +
// een vorige) — begrensd, en de recente historie blijft altijd beschikbaar voor diagnose.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** rotateLogIfNeeded (r4 #20, 2026-08-07): twee gelijktijdige logwriters konden BEIDE .1 verwijderen en
 *  elkaars generatie verliezen, en de rename liet elk open geërfd fd (de stderr van de detached watcher!)
 *  naar de weggedraaide inode schrijven. Nu: (1) rotatie is geserialiseerd achter een 'wx'-lock — bij
 *  contentie slaat deze aanroep de rotatie gewoon over (een gemiste poging is onschadelijk, een dubbele
 *  rm/rename niet); (2) copy+truncate i.p.v. rename — ieder open fd (ook de geërfde stderr) blijft op het
 *  ACTIEVE bestand schrijven en het Windows-hazard van rename-met-open-handle vervalt. Het bekende
 *  copytruncate-venster (een regel geappend tussen copy en truncate gaat verloren) is hier een bewuste,
 *  kleine prijs voor een diagnoselog — nooit voor bewijsdata. */
function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < LOG_MAX_BYTES) return;
    const lockPath = LOG_FILE + '.rotate.lock';
    let lfd = null;
    try { lfd = fs.openSync(lockPath, 'wx'); }
    catch (e) {
      if (e.code === 'EEXIST') {
        // achtergebleven lock van een gecrashte roteerder na STALE_LOCK_MS opruimen; deze ronde overslaan
        try { if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(lockPath); } catch { }
      }
      return;
    }
    try {
      const st2 = fs.statSync(LOG_FILE);
      if (st2.size >= LOG_MAX_BYTES) {
        fs.copyFileSync(LOG_FILE, LOG_FILE + '.1');
        fs.truncateSync(LOG_FILE, 0);
      }
    } finally {
      try { fs.closeSync(lfd); } catch { }
      try { fs.unlinkSync(lockPath); } catch { }
    }
  } catch { /* geen log of niet leesbaar — niets te roteren */ }
}
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try { rotateLogIfNeeded(); fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
/** journalAppend / unresolvedPausedAgents — het compensatiejournal (zie PAUSED_JOURNAL boven).
 *  r4 #15 (2026-08-07): het journal is nu WRITE-AHEAD en generation-aware:
 *  - elke pauzeronde draagt een pauseId; per agent wordt VOOR de pause-API een 'pause-intent'-record
 *    geschreven en na API-succes een 'paused'-result met dezelfde pauseId — een crash tussen API en
 *    journal verliest de compensatie niet meer (de intent staat er al);
 *  - een resolved:true-record sluit UITSLUITEND de pauseId die hij noemt; een oud, laat arriverend
 *    resolve-record (gelijktijdige watch --once) kan een NIEUWERE pauze dus nooit meer maskeren;
 *  - compactJournalIfNeeded houdt het bestand begrensd: boven de drempel wordt per agent alleen het
 *    laatst relevante spoor bewaard (atomisch, onder een wx-lock — nooit een tweede compacteerder). */
function journalLockPath() { return PAUSED_JOURNAL + '.compact.lock'; }
/** journalAppend — r5 #18/#20 (2026-08-07): gefsynct (een intent die de power loss niet overleeft is
 *  geen write-ahead) en geserialiseerd met de compactielock, zodat een append nooit op de oude inode
 *  landt terwijl de compactor zijn rename doet. Bij een blijvend bezette lock appenden we alsnog
 *  (een pauze-compensatie mag nooit sneuvelen aan een diagnostische compactie) en melden dat. */
function journalAppend(rec) {
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, rec)) + '\n';
  let lfd = null;
  for (let i = 0; i < 40 && lfd === null; i++) {
    try { lfd = fs.openSync(journalLockPath(), 'wx'); }
    catch (e) { if (e.code !== 'EEXIST') break; try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch { } }
  }
  try {
    const fd = fs.openSync(PAUSED_JOURNAL, 'a');
    try { fs.writeSync(fd, line, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (lfd === null) log('paused-journal: append zonder lock (compactor hield hem >1s vast) — record is wel duurzaam geschreven');
    return true;
  }
  catch (e) { log('paused-journal write failed (resume must then rely on state alone): ' + e.message); return false; }
  finally { if (lfd !== null) { try { fs.closeSync(lfd); } catch { } try { fs.unlinkSync(journalLockPath()); } catch { } } }
}
/** journalScan — r5 #19: ALLE onopgeloste pauze-generaties per agent blijven staan (een concurrerende
 *  pauze B die faalt en resolvet mag generatie A niet uit de recovery drukken). */
function journalScan() {
  let raw;
  try { raw = fs.readFileSync(PAUSED_JOURNAL, 'utf8'); } catch { return new Map(); }
  const agents = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { continue; /* halve regel: overslaan */ }
    if (!r || r.agentId == null) continue;
    const id = String(r.agentId);
    if (!agents.has(id)) agents.set(id, { pauses: new Map(), legacyPause: null, resolvedIds: new Set(), legacyResolved: false });
    const a = agents.get(id);
    if (r.resolved === true) {
      if (r.pauseId) a.resolvedIds.add(String(r.pauseId));
      else a.legacyResolved = true; // legacy resolve zonder pauseId: sluit alleen legacy pauzes (zonder pauseId)
    } else if (r.pauseId) {
      a.pauses.set(String(r.pauseId), r); // laatste record per generatie (intent daarna result) wint
    } else {
      a.legacyPause = r;
    }
  }
  return agents;
}
function unresolvedPausedAgents() {
  const out = [];
  for (const [, a] of journalScan()) {
    for (const [pid, rec] of a.pauses) if (!a.resolvedIds.has(pid)) out.push(rec);
    if (a.legacyPause && !a.legacyResolved) out.push(a.legacyPause);
  }
  return out;
}
const JOURNAL_COMPACT_BYTES = 256 * 1024;
function compactJournalIfNeeded() {
  try {
    const st = fs.statSync(PAUSED_JOURNAL);
    if (st.size < JOURNAL_COMPACT_BYTES) return;
    const lockPath = PAUSED_JOURNAL + '.compact.lock';
    let lfd = null;
    try { lfd = fs.openSync(lockPath, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') { try { if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(lockPath); } catch { } } return; }
    try {
      // bewaar per agent alleen het onopgeloste laatste pause-spoor; alles wat geresolved is mag weg
      const keep = unresolvedPausedAgents().map((r) => JSON.stringify(r));
      const tmp = PAUSED_JOURNAL + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
      fs.renameSync(tmp, PAUSED_JOURNAL);
      log('paused-journal gecompacteerd: ' + st.size + 'B -> ' + (keep.join('\n').length + 1) + 'B (' + keep.length + ' onopgelost spoor/sporen bewaard)');
    } finally {
      try { fs.closeSync(lfd); } catch { }
      try { fs.unlinkSync(lockPath); } catch { }
    }
  } catch { /* geen journal — niets te compacteren */ }
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
  // ATOMIC WRITE (Codex adversarial review #6, 2026-08-03): this used to truncate-and-rewrite the live
  // file in place. Three processes share it — the watcher, the CLI and the PreToolUse hook — so a reader
  // landing mid-write got a truncated file and, because every reader treats unparseable JSON as "no
  // state", failed OPEN: a real pause could be silently ignored at exactly the moment it mattered.
  // Write to a unique temp file in the same directory, then rename: on both Windows and POSIX a rename
  // within one filesystem is atomic, so a reader sees either the whole old file or the whole new one.
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    // A failed atomic write must not silently leave the caller believing the state was persisted.
    throw e;
  }
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
/** readCredentialFp — de vingerafdruk van het credential dat NU in .credentials.json staat (zelfde
 *  derivatie als fetchUsage's credentialFp en readAccountIdentity's fallback). Null-veilig. */
function readCredentialFp() {
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    const rt = cred && cred.claudeAiOauth && cred.claudeAiOauth.refreshToken;
    if (typeof rt === 'string' && rt) return crypto.createHash('sha256').update('rt:' + rt).digest('hex').slice(0, 12);
  } catch { /* geen credential leesbaar */ }
  return null;
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
      // `id` is the window's STABLE identity (kind|group|label) — broad Codex audit #15, 2026-08-05:
      // the pause trigger used to store only the bare kind, and resume matched `find(x.kind === t.metric)`,
      // so with two weekly_scoped windows (Opus 96%, Sonnet 20%) whichever came FIRST in limits[] decided
      // whether the guard resumed — pausing on Opus and resuming because Sonnet was low, then re-pausing
      // next tick: flapping, or the mirror image, staying paused on a window that never crossed.
      out.push({ id: k, kind, group, pct, resetsAt: (l && l.resets_at) || null, severity: (l && l.severity) || null,
        isActive: l && l.is_active === true, label, source: 'limits' });
    }
  }
  const legacy = [['session', 'session', j && j.five_hour], ['weekly_all', 'weekly', j && j.seven_day]];
  for (const [kind, group, w] of legacy) {
    const pct = Number(w && w.utilization != null ? w.utilization : NaN);
    if (!Number.isFinite(pct)) continue;
    if (seen.has(key(kind, group, kind))) continue; // already reported as a typed window — same window
    seen.add(key(kind, group, kind));
    out.push({ id: key(kind, group, kind), kind, group, pct, resetsAt: (w && w.resets_at) || null,
      severity: null, isActive: false, label: kind, source: 'legacy' });
  }
  return out;
}
/** stillHighTrigger — the resume decision, pure and testable (broad Codex audit #15, 2026-08-05).
 *  Each pause trigger is looked up by its STABLE id first. A trigger without an id (recorded by an older
 *  build) may fall back to its bare kind ONLY when exactly one current window carries that kind — with
 *  two candidates the match would be a guess, and both wrong guesses are worse than the fallbacks below.
 *  Last resorts mirror the legacy pair (session / weekly_all); anything else unresolvable counts as NOT
 *  still high: the window is no longer reported, so there is nothing to wait for — and if that judgment
 *  is wrong, crossedWindows() re-pauses on the very next tick and resumeAtEpoch stays the backstop. */
function stillHighTrigger(triggers, windows, resumeAt, legacy) {
  const ws = Array.isArray(windows) ? windows : [];
  const leg = legacy || {};
  const curPct = (t) => {
    if (t && t.id) {
      const byId = ws.find((x) => x.id === t.id);
      if (byId && Number.isFinite(byId.pct)) return byId.pct;
      return NaN; // the identified window vanished — do not silently judge a DIFFERENT window instead
    }
    const sameKind = ws.filter((x) => x.kind === t.metric);
    if (sameKind.length === 1 && Number.isFinite(sameKind[0].pct)) return sameKind[0].pct;
    if (t.metric === 'session' && Number.isFinite(leg.sessionPct)) return leg.sessionPct;
    if (t.metric === 'weekly_all' && Number.isFinite(leg.weekPct)) return leg.weekPct;
    return NaN;
  };
  return (Array.isArray(triggers) ? triggers : []).some((t) => curPct(t) > resumeAt);
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
  // CODEX ronde-3 #1 (2026-08-06): de vingerafdruk van het credential dat DEZE fetch werkelijk gebruikt,
  // afgeleid in DEZELFDE read als het token zelf (zelfde derivatie als readAccountIdentity's fallback).
  // De dubbele identiteits-lezing rond de fetch leest ~/.claude.json — een ANDER bestand dat tijdens een
  // login later kan omklappen dan .credentials.json. Zonder deze binding kon het token al van account B
  // zijn terwijl beide identiteits-lezingen nog A meldden.
  const rt = cred.claudeAiOauth && cred.claudeAiOauth.refreshToken;
  const credFp = typeof rt === 'string' && rt ? crypto.createHash('sha256').update('rt:' + rt).digest('hex').slice(0, 12) : null;
  return { token: t, credFp };
}
async function fetchUsage() {
  // TIMEOUT (Codex adversarial review #8, 2026-08-03): this call had none. A hung request does not throw —
  // it simply never settles, so the tick never finishes and the watcher stops measuring while its process
  // stays alive: exactly the silent-death shape this guard was fixed for once already. 30s is far beyond
  // a healthy response and far below the tick interval, so a timeout can never stack ticks.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  const cred = readToken(); // token + credential-vingerafdruk uit EEN read (ronde-3 #1)
  let r;
  try {
    r = await fetch(USAGE_URL, {
      headers: { authorization: 'Bearer ' + cred.token, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      signal: ac.signal,
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) throw new Error('usage endpoint timed out after 30s (no response) — treated as a failed check, never as "usage is fine"');
    throw e;
  } finally { clearTimeout(timer); }
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
    credentialFp: cred.credFp, // welke credential deze cijfers ECHT ophaalde (ronde-3 #1)
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
/** accountStamp — the explicit account field for a pause/resume write (broad Codex audit #13,
 *  2026-08-05). doPause/doResume build FRESH state objects; the stamp used to arrive only via
 *  writeStateTo's read-the-previous-file carry — one more disk read in exactly the window where a
 *  mid-check login switches accounts. The tick now hands its VALIDATED identity down, so the write
 *  carries the account it actually measured, not whatever happens to be on disk at write time. */
function accountStamp(ident) {
  return ident && ident.fp ? { account: { fp: ident.fp, source: ident.source, stampedAt: new Date().toISOString() } } : {};
}
async function doPause(u, crossed, ident) {
  const cur = readState(); // preserve owner intent across a pause (fix 2026-07-09 checkup)
  const agents = await allAgents();
  const toPause = (agents || []).filter((a) => a.status !== 'paused');
  const reason = 'USAGE GUARD: ' + crossed.map((c) => c.name + ' ' + c.pct + '%').join(' + ') + ' >= ' + PAUSE_AT + '% — auto-paused. Auto-resume when back to <= ' + RESUME_AT + '%.';
  if (DRY) { log('[dry-run] WOULD pause ' + toPause.length + ' agents (' + reason + ')'); return; }
  const paused = [];
  // r4 #15: een pauzeronde heeft een eigen pauseId en het journal is WRITE-AHEAD — de intent staat er
  // VOOR de API-call, zodat een crash direct na een geslaagde pause de compensatie nooit meer verliest.
  const pauseId = crypto.randomUUID();
  for (const a of toPause) {
    journalAppend({ agentId: a.id, name: a.name, company: a.company, action: 'pause-intent', pauseId, accountFp: (ident && ident.fp) || null, resolved: false });
    const r = await pc('POST', '/api/agents/' + a.id + '/pause', { reason });
    if (r.status >= 200 && r.status < 300) {
      paused.push({ id: a.id, name: a.name, company: a.company });
      journalAppend({ agentId: a.id, name: a.name, company: a.company, action: 'paused', pauseId, accountFp: (ident && ident.fp) || null, resolved: false });
    } else {
      // de pause-API faalde: de intent afsluiten — er is niets te compenseren voor deze agent
      journalAppend({ agentId: a.id, action: 'pause-failed', pauseId, resolved: true });
    }
  }
  compactJournalIfNeeded();
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
    ...accountStamp(ident),
    // NEVER silently drop the owner's paid-credits override / last credit snapshot on a pause — the hook
    // reads ownerOverride to keep working; a fresh object without it defeated that (an accounting desktop app flapping).
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
async function doResume(u, st, ident) {
  if (DRY) { log('[dry-run] WOULD resume ' + (st.pausedAgents || []).length + ' agents'); return; }
  let ok = 0;
  // UNIE van de state-lijst en de onopgeloste journalregels (uitgesteld punt 1, 2026-08-06): de state
  // kan door een account-switch gereset zijn terwijl het journal de guard-gepauzeerde agents nog kent.
  // Nog steeds ALLEEN wat de guard zelf pauzeerde — nooit human-paused agents.
  const journalUnresolved = unresolvedPausedAgents();
  const pauseIdByAgent = new Map(journalUnresolved.map((j) => [String(j.agentId), j.pauseId || null]));
  const byId = new Map();
  for (const a of (st.pausedAgents || [])) byId.set(String(a.id), { id: a.id, name: a.name, company: a.company });
  for (const j of journalUnresolved) if (!byId.has(String(j.agentId))) byId.set(String(j.agentId), { id: j.agentId, name: j.name, company: j.company, fromJournal: true });
  const failed = [];
  for (const a of byId.values()) {
    const r = await pc('POST', '/api/agents/' + a.id + '/resume', {});
    if (r.status >= 200 && r.status < 300) {
      ok++;
      // r4 #15: de resolve draagt de pauseId die hij afsluit — een laat arriverende oude resolve kan een
      // nieuwere pauze dan nooit meer maskeren (unresolvedPausedAgents matcht op pauseId).
      journalAppend({ agentId: a.id, action: 'resumed', pauseId: pauseIdByAgent.get(String(a.id)) || null, resolved: true });
    } else {
      failed.push({ id: a.id, name: a.name, company: a.company });
    }
  }
  if (failed.length) {
    // r4 #15: een GEDEELTELIJKE resume schrijft geen mode:'ok' meer — de staat blijft paused met
    // resumePending, zodat de paused-tak van de volgende tick de rest opnieuw probeert.
    writeState(Object.assign({}, st, {
      mode: 'paused', pausedAgents: failed, resumePending: true,
      ...accountStamp(ident),
      lastCheckAt: new Date().toISOString(),
      lastError: 'resume gedeeltelijk: ' + ok + '/' + byId.size + ' agents hervat — ' + failed.length + ' faalden; volgende tick probeert opnieuw',
    }));
    log('RESUME PARTIAL — ' + ok + '/' + byId.size + ' hervat; ' + failed.length + ' gefaald (' + failed.map((f) => f.id).join(',') + ') — staat blijft paused/resumePending');
    return;
  }
  writeState({
    mode: 'ok', percents: { session: u.session.pct, week: u.week.pct }, resets: { session: u.session.resetsAt, week: u.week.resetsAt },
    ...accountStamp(ident),
    ...(st.ownerOverride ? { ownerOverride: st.ownerOverride } : {}), // survive the reset (credits mode is orthogonal)
    lastResumeAt: new Date().toISOString(), lastCheckAt: new Date().toISOString(), resumedAgents: ok, pendingCheckup: true,
    resumeNotice: '✅ USAGE GUARD — usage gereset (sessie ' + u.session.pct + '% · week ' + u.week.pct + '%). GA VERDER met waar je mee bezig was. '
      + 'VERPLICHTE CHECKUP: (1) verifieer via de Paperclip API dat de agents resumed zijn en ECHT draaien (statuses + heartbeat-runs/tickets bewegen), '
      + '(2) verifieer dat je eigen taak-status klopt met de werkelijkheid, (3) rapporteer eerlijk wat wel/niet hervat is. '
      + ok + '/' + byId.size + ' Paperclip agents hervat.',
  });
  log('RESUMED — session ' + u.session.pct + '% week ' + u.week.pct + '% · agents resumed: ' + ok + '/' + byId.size);
}

async function tick(deps) {
  // Injectable seams (broad Codex audit #13, 2026-08-05): the identity/fetch SEQUENCING below is the
  // fix, and sequencing can only be tested when the parts are replaceable. Production behaviour is
  // identical: every default is the real function.
  const D = Object.assign({
    fetchUsage, readIdentity: readAccountIdentity, readState, writeState, doPause, doResume, log,
    writePressureFile, readCredentialFp,
  }, deps || {});
  // AUDIT #13 (2026-08-05): the identity used to be read ONCE, and only AFTER the fetch. The fetch reads
  // the OAuth token from .credentials.json at ITS moment and can take up to 30s; a login during that
  // window meant account A's percentages were stamped and acted on under account B's fingerprint —
  // doPause then paused a fresh account at "95%". Identity is now captured BEFORE the fetch and
  // re-checked AFTER it; when the two disagree, this tick takes NO action (fail-safe) — the next tick
  // measures the new account consistently. Two different files feed this (token from .credentials.json,
  // identity from ~/.claude.json, updated at different moments during a login), so the double read is
  // the only honest consistency check available without an identity-carrying usage endpoint.
  const identBefore = D.readIdentity();
  let u;
  try { u = await D.fetchUsage(); } catch (e) {
    const st = D.readState(); st.lastError = String(e.message); st.lastCheckAt = new Date().toISOString(); D.writeState(st);
    D.writePressureFile(NaN, NVIDIA_SHIFT_AT, PAUSE_AT); // level "unknown" — write on EVERY evaluation, no stale flag
    D.log('CHECK FAILED (no action taken — fail-safe): ' + e.message); return;
  }
  const ident = D.readIdentity();
  if (identBefore.fp && ident.fp && identBefore.fp !== ident.fp) {
    const st = D.readState();
    st.lastCheckAt = new Date().toISOString();
    st.lastError = 'account switched mid-check (' + identBefore.fp + ' -> ' + ident.fp + ') — measurements discarded, no action taken';
    D.writeState(st);
    D.log('ACCOUNT SWITCHED MID-CHECK (' + identBefore.fp + ' -> ' + ident.fp + ') — this tick\'s numbers belong to the OLD account; discarded (fail-safe), next tick measures the new account');
    return;
  }
  // CODEX ronde-3 #1 (2026-08-06): ~/.claude.json kan tijdens een login LATER omklappen dan
  // .credentials.json — beide identiteits-lezingen melden dan nog account A terwijl de fetch al met
  // account B's token liep. De fetch draagt daarom de vingerafdruk van het credential dat hij ECHT
  // gebruikte; is het credential NU al anders (geroteerd/gewisseld tijdens de fetch), dan zijn deze
  // cijfers niet meer aan een consistente identiteit te binden — verwerpen, volgende tick meet opnieuw.
  const credNow = D.readCredentialFp();
  if (u.credentialFp && credNow && u.credentialFp !== credNow) {
    const st = D.readState();
    st.lastCheckAt = new Date().toISOString();
    st.lastError = 'credential rotated mid-check (' + u.credentialFp + ' -> ' + credNow + ') — measurements discarded, no action taken';
    D.writeState(st);
    D.log('CREDENTIAL ROTATED MID-CHECK — this tick\'s numbers were fetched with a credential that no longer matches; discarded (fail-safe)');
    return;
  }
  // advisory NVIDIA-shift pressure signal — written on every watch evaluation, before any pause/resume
  // branching below, so it fires regardless of which branch this tick takes (pause always wins for the
  // real pause/resume decision; this file never influences it).
  D.writePressureFile(u.week.pct, NVIDIA_SHIFT_AT, PAUSE_AT);
  if (!(u.windows || []).length) { D.log('CHECK: endpoint reported no usable usage window (no action)'); return; }
  // ACCOUNT GATE (2026-08-03): resolve identity BEFORE any decision is made on the stored state, so a
  // switch can never be decided on the previous account's percentages/pause/override.
  const rawState = D.readState();
  const sw = detectAccountSwitch(rawState, ident);
  const st = stateForAccount(rawState, ident);
  if (sw.switched) {
    D.writeState(st);
    D.log('ACCOUNT SWITCH — fingerprint ' + sw.from + ' -> ' + sw.to + ' (' + ident.source + '): guard state reset; previous account\'s percentages, pause state and credits override NOT carried over');
    // COMPENSATIE (uitgesteld punt 1, 2026-08-06): de reset hierboven wist de pausedAgents-lijst van het
    // VORIGE account — maar het journal kent ze nog. Hervat ze nu (Paperclip is account-agnostisch;
    // dit zijn uitsluitend agents die de guard ZELF pauzeerde) en sluit hun journalregels af.
    const orphans = unresolvedPausedAgents();
    if (orphans.length) {
      let rok = 0;
      for (const j of orphans) {
        const r = await pc('POST', '/api/agents/' + j.agentId + '/resume', {});
        // r5 #21: de resolve draagt de pauseId van het record dat hij afsluit — zonder die binding bleef
        // de pauze onopgelost en resumede iedere volgende tick opnieuw.
        if (r.status >= 200 && r.status < 300) { rok++; journalAppend({ agentId: j.agentId, action: 'resumed', pauseId: j.pauseId || null, resolved: true }); }
      }
      D.log('ACCOUNT SWITCH — ' + rok + '/' + orphans.length + ' guard-gepauzeerde agents van het vorige account hervat via het compensatiejournal');
    }
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
      st.lastCheckAt = new Date().toISOString(); delete st.lastError; D.writeState(st);
      const low = Number.isFinite(c.remaining) && Number.isFinite(c.limit) && c.limit > 0 && (c.remaining / c.limit) <= 0.1;
      D.log('OVERRIDE active (credits mode) — NOT pausing · session ' + u.session.pct + '% week ' + u.week.pct + '% · credits used ' + fmtMoney(c.used, c.currency, c.decimals) + '/' + fmtMoney(c.limit, c.currency, c.decimals) + (low ? ' · ⚠ CREDITS LOW' : ''));
      return;
    }
    D.log('OVERRIDE lifted — ' + (expired ? 'override expired' : 'credits exhausted') + ' (used ' + fmtMoney(c && c.used, c && c.currency, c && c.decimals) + '/' + fmtMoney(c && c.limit, c && c.currency, c && c.decimals) + ') → normal guard re-armed');
    delete st.ownerOverride; D.writeState(st);
    // fall through to the normal pause/resume logic below (pauses if still over the plan limit)
  }
  if (st.mode !== 'paused') {
    // EVERY reported window can trip the guard, not just the legacy session/week pair — a daily or
    // per-model scoped limit at 100% used to be completely invisible here (fix 2026-08-03).
    // The trigger now records the window's STABLE id so resume can find THIS window again (audit #15).
    const crossed = crossedWindows(u.windows, PAUSE_AT)
      .map((w) => ({ id: w.id, name: w.label, metric: w.kind, pct: w.pct, resetsAt: w.resetsAt }));
    if (crossed.length) { await D.doPause(u, crossed, ident); return; }
    // keep pauseAt/resumeAt fresh on every tick (fix 2026-07-08) — otherwise a running watchdog started
    // with a different --pause-at than the last actual pause event leaves a stale threshold in the
    // state file, even though the real in-process trigger (PAUSE_AT, checked above) is already correct.
    st.mode = 'ok'; st.pauseAt = PAUSE_AT; st.resumeAt = RESUME_AT; st.nvidiaShiftAt = NVIDIA_SHIFT_AT; st.percents = { session: u.session.pct, week: u.week.pct }; st.lastCheckAt = new Date().toISOString(); delete st.lastError; D.writeState(st);
    // RECONCILIATIE (r4 #15): staat de guard op ok maar kent het journal nog onopgeloste guard-pauzes
    // (crash na de pause-API, of een switch waarvan de orphan-resume deels faalde), hervat ze dan nu —
    // de write-ahead-intent garandeert dat zo'n agent hier altijd zichtbaar is.
    const orphansOk = unresolvedPausedAgents();
    if (orphansOk.length) {
      let rok = 0;
      for (const j of orphansOk) {
        const r = await pc('POST', '/api/agents/' + j.agentId + '/resume', {});
        if (r.status >= 200 && r.status < 300) { rok++; journalAppend({ agentId: j.agentId, action: 'resumed', pauseId: j.pauseId || null, resolved: true }); }
      }
      D.log('RECONCILIATIE — ' + rok + '/' + orphansOk.length + ' onopgeloste guard-pauzes uit het journal hervat (mode was ok)');
    }
    // log EVERY window, not just the legacy pair — otherwise a daily/scoped limit climbing toward 100%
    // is invisible in the log as well as in the decision (fix 2026-08-03).
    D.log('ok — ' + (u.windows || []).map((w) => w.label + ' ' + w.pct + '%').join(' · ') + ' (pause-at ' + PAUSE_AT + '%)');
  } else {
    // AUDIT #15 (2026-08-05): the old lookup was `find(x.kind === t.metric)` — the FIRST window with the
    // same bare kind decided the resume, so with two weekly_scoped windows the guard could resume off the
    // wrong model's percentage (flapping) or stay paused on a window that never crossed. The decision now
    // lives in stillHighTrigger(): stable id first, kind only when unambiguous, legacy pair as last resort.
    const stillHigh = stillHighTrigger(st.trigger, u.windows, RESUME_AT, { sessionPct: u.session.pct, weekPct: u.week.pct });
    // RESET-RHYTHM: resume on EITHER the real utilization drop OR wall-clock reaching resumeAtEpoch —
    // whichever comes first. NaN-safe: an absent/unparseable resumeAtEpoch never triggers this branch.
    const resumeAtEpoch = Number(st.resumeAtEpoch);
    const rhythmDue = Number.isFinite(resumeAtEpoch) && Date.now() >= resumeAtEpoch;
    // CODEX ronde-3 #2 (2026-08-06): "de trigger is weg/gereset" mocht een resume opleveren terwijl een
    // ÁNDER huidig venster al boven PAUSE_AT stond — een resume gevolgd door een re-pauze een tick later
    // (tot 120s wapperen, met resume/pauze-notices en agent-bounce). Staat er NU een venster boven de
    // pauzedrempel, dan wordt de pauze op DAT venster voortgezet (verse trigger + vers ritme) in plaats
    // van hervat; agents die al gepauzeerd zijn raakt doPause niet opnieuw aan.
    if (!stillHigh || rhythmDue) {
      const nowCrossed = crossedWindows(u.windows, PAUSE_AT)
        .map((w) => ({ id: w.id, name: w.label, metric: w.kind, pct: w.pct, resetsAt: w.resetsAt }));
      if (nowCrossed.length) {
        D.log('trigger cleared/rhythm due, but ' + nowCrossed.map((c) => c.name + ' ' + c.pct + '%').join(' + ') + ' is at/over pause-at ' + PAUSE_AT + '% — staying paused on the CURRENT window instead of resume-then-repause flapping');
        await D.doPause(u, nowCrossed, ident);
        return;
      }
      await D.doResume(u, st, ident); return;
    }
    st.percents = { session: u.session.pct, week: u.week.pct }; st.lastCheckAt = new Date().toISOString(); D.writeState(st);
    D.log('paused — waiting for reset (session ' + u.session.pct + '% · week ' + u.week.pct + '% · resume at <= ' + RESUME_AT + '%' + (Number.isFinite(resumeAtEpoch) ? ' · or rhythm-resume at ' + new Date(resumeAtEpoch).toISOString() : '') + ')');
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
/** readPosixCmdline(pid) — the live process's REAL command line without extra dependencies (broad Codex
 *  audit #18, 2026-08-05). Linux: /proc/<pid>/cmdline (NUL-separated). macOS/BSD: `ps -ww -p <pid>
 *  -o command=` via spawnSync, no shell, -ww against truncation (a truncated line would misclassify a
 *  real watcher as recycled). Returns null when neither source can be read — the caller must then
 *  refuse, never guess. */
function readPosixCmdline(pid) {
  try {
    const raw = fs.readFileSync('/proc/' + Number(pid) + '/cmdline', 'utf8');
    if (raw) return raw.split('\0').filter(Boolean).join(' ');
  } catch { /* no /proc (macOS) or unreadable — try ps */ }
  try {
    const r = spawnSync('ps', ['-ww', '-p', String(Number(pid)), '-o', 'command='], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  } catch { /* ps unavailable */ }
  return null;
}
/** verdictFromCmdline — shared classification for both platforms: the live command line must name THIS
 *  guard script AND the `watch` subcommand. Every failure carries a machine-readable `code` so callers
 *  (incumbentStatus) never have to parse English prose to tell "recycled, safe to take over" from
 *  "unidentifiable, refuse" (audit #18 — the old prose-matching left POSIX without a recycled class at
 *  all: a stale record either false-positived as a live watcher or blocked every restart forever). */
function verdictFromCmdline(pid, rec, out) {
  // CODEX ronde-3 #3 (2026-08-06): een basename-substring + het woord "watch" ergens in de regel was te
  // los — een ANDERE usage-guard.cjs (ander project) of een `--watch=false`-vlag matchte ook. Nu: het
  // VOLLEDIGE opgeloste scriptpad wanneer het record er een draagt (basename alleen nog als legacy-
  // fallback voor een record zonder pad), en `watch` moet een losstaand argument-token zijn — niet een
  // substring van een vlag of een naam.
  const lower = String(out).toLowerCase();
  let scriptOk;
  if (rec && rec.script) scriptOk = lower.includes(path.resolve(rec.script).toLowerCase());
  else scriptOk = lower.includes(path.basename(__filename).toLowerCase());
  if (!scriptOk) return { ok: false, code: 'recycled', reason: 'pid ' + pid + ' does not run this guard script (recycled pid) — refusing to kill it' };
  if (!/(^|[\s"'])watch($|[\s"'])/.test(lower)) return { ok: false, code: 'not-watcher', reason: 'pid ' + pid + ' runs the guard script but NOT as a watcher (e.g. a status/CLI call) — refusing to kill it' };
  return { ok: true, cmdline: out };
}
function ownsPid(pid, rec) {
  if (!pid || !pidAlive(pid)) return { ok: false, code: 'dead', reason: 'process not running' };
  if (process.platform !== 'win32') {
    // AUDIT #18 (2026-08-05): this branch used to accept a pid purely because the RECORD named our own
    // script path — nothing about the LIVE process was checked, while claimWatcherSlot writes that very
    // path into every record it creates, so every stale record matched by construction. A watcher killed
    // hard (SIGKILL/OOM/reboot) leaves its record; the OS recycles the pid; `stop` would then SIGTERM an
    // unrelated process — the exact 2026-07-29 incident class — and `start` would report "already
    // running" over an unguarded account. The live command line is now read (readPosixCmdline) and judged
    // by the same rule as Windows; unreadable = refuse honestly, never accept on record evidence alone.
    const out = readPosixCmdline(pid);
    if (out == null) return { ok: false, code: 'unverifiable', reason: 'cannot verify pid ' + pid + ' on ' + process.platform + ' (no /proc and no usable ps) — a pid-file record alone is not proof; refusing to kill it' };
    return verdictFromCmdline(pid, rec, out);
  }
  try {
    const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \'ProcessId=' + Number(pid) + '\').CommandLine"', { encoding: 'utf8', windowsHide: true }).trim();
    if (!out) return { ok: false, code: 'unverifiable', reason: 'no command line readable for pid ' + pid };
    // CODEX finding #16: matching the bare word "usage-guard" also matched a `usage-guard.cjs status`
    // process or a helper with that substring in its name. Require the EXACT recorded script path (when
    // the pid file has one) AND the `watch` subcommand — a status/CLI invocation is never the watcher.
    return verdictFromCmdline(pid, rec, out);
  } catch (e) { return { ok: false, code: 'unverifiable', reason: 'could not verify pid ' + pid + ' (' + e.message + ') — refusing to kill it' }; }
}

/** ================= WATCHER SINGLETON — ATOMIC CLAIM (broad Codex audit #17, 2026-08-05) ================
 *  The "refuse a second watcher" guard was check-then-write: `watch` READ the pid file, decided the slot was
 *  free, and only ~10 lines later wrote its own pid — unconditionally. Two watchers started in the same
 *  moment (a supervisor restart racing a manual `start`, or two `/forge` sessions) both read the same empty
 *  or stale file, both passed the check, and both wrote — the second clobbering the first's record. The
 *  result is exactly what the guard exists to prevent: two watchers ticking the same account, racing the
 *  same state file, and a `stop` that can only ever find ONE of them (the other keeps pausing/resuming
 *  invisibly). A window of a few milliseconds is enough, and a supervisor restart hits it repeatedly.
 *
 *  The claim is now atomic: `open(..., 'wx')` either creates the pid file or fails with EEXIST — the OS
 *  decides the winner, not a read followed by a hopeful write. On EEXIST we classify the incumbent honestly
 *  instead of assuming:
 *    - live-watcher   — provably ours and running: REFUSE (this is the case the guard was written for).
 *    - stale          — provably dead, or a recycled pid running something else entirely: take the slot
 *                       over, but only ONE starter may do so, serialized by an exclusive takeover lock.
 *    - unverifiable   — alive, and we CANNOT prove what it is (e.g. no command-line access on this
 *                       platform): REFUSE and say exactly that. A duplicate watcher racing the state file
 *                       is worse than a guard that declines to start and tells you why.
 *  An abandoned takeover lock (a process killed mid-takeover) is not allowed to block the guard forever:
 *  after STALE_LOCK_MS it is reclaimed, which is safe because the lock only ever guards a few filesystem
 *  operations. Every parameter is injectable so this is testable without touching the real pid file. */
const STALE_LOCK_MS = 60 * 1000;
function incumbentStatus(rec, deps) {
  const alive = deps.isAlive;
  // RACE IN DE CLAIM ZELF, door de eigen racetest gevangen (2026-08-06): tussen open(wx) en de
  // record-write van de winnaar zag een concurrent een BESTAAND maar nog LEEG pid-bestand, las pid 0,
  // behandelde dat als 'stale', wiste de kersverse claim en won alsnog — twee watchers. Een bestaand
  // bestand zonder pid is daarom 'nascent': iemand is NU aan het claimen; even wachten, nooit stelen.
  if (rec && rec.exists && !rec.pid) return { kind: 'nascent' };
  if (!rec || !rec.pid) return { kind: 'none' };
  if (rec.pid === deps.pid) return { kind: 'self' };
  if (!alive(rec.pid)) return { kind: 'stale', why: 'pid ' + rec.pid + ' is not running' };
  const own = deps.verify(rec.pid, rec);
  if (own.ok) return { kind: 'live-watcher', why: 'pid ' + rec.pid + ' is a running usage-guard watcher' };
  // Machine-readable code first (audit #18) — prose matching stays only as a fallback for older or
  // injected verifiers, so a reworded reason can never silently turn "recycled" into a forever-block.
  if (own.code === 'recycled' || own.code === 'not-watcher' || /recycled pid|NOT as a watcher/.test(own.reason || '')) return { kind: 'stale', why: own.reason };
  return { kind: 'unverifiable', why: own.reason || 'pid ' + rec.pid + ' could not be identified' };
}
function takeOverStaleSlot(pidFile, deps) {
  const lock = pidFile + '.takeover.lock';
  let lfd = null;
  try { lfd = fs.openSync(lock, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, reason: 'could not create the takeover lock (' + e.message + ')' };
    let age = Infinity;
    try { age = deps.now() - fs.statSync(lock).mtimeMs; } catch { /* vanished under us: treat as abandoned */ }
    if (age < STALE_LOCK_MS) return { ok: false, reason: 'another starter is taking over the stale pid file right now — refusing to start a second watcher' };
    try { fs.unlinkSync(lock); } catch { /* someone else got there first */ }
    return { ok: true, reclaimedAbandonedLock: true };
  }
  try {
    // Re-check UNDER the lock: a real watcher may have claimed the slot between our read and our lock,
    // en een nascent record krijgt ook hier zijn gratie (de eigen racetest ving het steel-scenario).
    const st = settledStatus(pidFile, deps);
    if (st.kind === 'live-watcher' || st.kind === 'unverifiable') return { ok: false, reason: st.why };
    try { fs.unlinkSync(pidFile); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, reason: 'could not clear the stale pid file (' + e.message + ')' }; }
    return { ok: true };
  } finally {
    try { fs.closeSync(lfd); } catch { /* already closed */ }
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}
function readPidRecordFrom(pidFile) {
  let raw = '';
  try { raw = fs.readFileSync(pidFile, 'utf8').trim(); } catch { return { pid: 0, exists: false, legacy: false }; }
  if (!raw) return { pid: 0, exists: true, legacy: false }; // bestaat maar (nog) leeg: nascent-kandidaat
  try { const j = JSON.parse(raw); if (j && Number(j.pid)) return { pid: Number(j.pid), exists: true, startedAt: j.startedAt || null, script: j.script || null, nonce: j.nonce || null, legacy: false }; } catch { /* legacy bare number */ }
  return { pid: Number(raw) || 0, exists: true, startedAt: null, script: null, nonce: null, legacy: true };
}
/** sleepSyncMs — synchrone micro-slaap zonder CPU-verbranding (zelfde techniek als de racetests). */
function sleepSyncMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB onbeschikbaar: dan maar niet slapen */ } }
/** settledStatus — lees het pid-record en geef een 'nascent' record een korte gratieperiode om zijn
 *  bytes te landen; pas als het NA de gratie nog leeg is telt het als een gecrashte creator (stale). */
function settledStatus(pidFile, deps) {
  for (let i = 0; i < 10; i++) {
    const st = incumbentStatus(readPidRecordFrom(pidFile), deps);
    if (st.kind !== 'nascent') return st;
    sleepSyncMs(15);
  }
  return { kind: 'stale', why: 'pid file exists but stayed empty through the grace window — its creator crashed mid-claim' };
}
function claimWatcherSlot(opts) {
  opts = opts || {};
  const pidFile = opts.pidFile || PID_FILE;
  const deps = {
    pid: opts.pid || process.pid,
    script: opts.script || __filename,
    now: opts.now || (() => Date.now()),
    isAlive: opts.isAlive || pidAlive,
    verify: opts.verify || ownsPid,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    // De claim schrijft zijn record in EEN writeFileSync-wx-call — geen open+write-tweetrap meer, zodat
    // het venster waarin een concurrent een lege pid-file kan zien minimaal is (de nascent-gratie
    // hierboven dekt wat er overblijft).
    let claimed = false;
    try { fs.writeFileSync(pidFile, JSON.stringify({ pid: deps.pid, startedAt: new Date(deps.now()).toISOString(), script: deps.script, ...(opts.nonce ? { nonce: opts.nonce } : {}) }) + '\n', { flag: 'wx' }); claimed = true; }
    catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: 'could not claim the watcher slot (' + e.message + ')' };
      const st = settledStatus(pidFile, deps); // nascent-gratie: een winnaar-in-wording nooit als stale bestelen
      if (st.kind === 'live-watcher') return { ok: false, incumbent: st, reason: 'another usage-guard watcher already running — ' + st.why };
      if (st.kind === 'unverifiable') return { ok: false, incumbent: st, reason: 'a process is holding the watcher slot and cannot be identified — ' + st.why + '; refusing to start a second watcher' };
      // 'self' means an earlier record of THIS pid (a restart inside the same process id): treat as stale.
      const took = takeOverStaleSlot(pidFile, deps);
      if (!took.ok) return { ok: false, incumbent: st, reason: took.reason };
      continue; // the slot is free now — retry the exclusive create, which is still the only winner-picker
    }
    if (claimed) return { ok: true, mode: attempt === 0 ? 'created' : 'took-over-stale', pidFile };
  }
  return { ok: false, reason: 'could not claim the watcher slot after 3 attempts — the pid file kept changing under us (another starter is racing); refusing to start a second watcher' };
}
/** awaitChildClaim — de start-handshake (uitgesteld punt 2, 2026-08-06): poll het pid-bestand tot het
 *  kind-pid er ECHT in staat (ok), een ANDER levend pid het slot houdt (weigering: het kind verloor de
 *  claim), het kind dood is (weigering: het kind weigerde/crashte — zie het log), of de timeout
 *  verstrijkt. Injecteerbare deps voor hermetische tests. */
function awaitChildClaim(opts) {
  opts = opts || {};
  const pidFile = opts.pidFile || PID_FILE;
  const childPid = Number(opts.childPid);
  const isAlive = opts.isAlive || pidAlive;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 10000;
  const pollMs = opts.pollMs != null ? opts.pollMs : 200;
  const nonce = opts.nonce || null;
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };
  for (;;) {
    const rec = readPidRecordFrom(pidFile);
    if (rec.pid === childPid) {
      /** r4 #16 (2026-08-07): pid-gelijkheid alleen bewees geen levend, uniek kind — een stale record van
       *  een gerecycled pid of een kind dat claimde en direct crashte gold als "started". Nu: (1) de
       *  NONCE die deze start meegaf moet in het record staan (een oud record van een eerder gestart
       *  kind met toevallig hetzelfde pid kan die nonce niet dragen); (2) liveness NA de record-match;
       *  (3) een herlezing die het record stabiel toont. */
      if (nonce && rec.nonce !== nonce) return { ok: false, reason: 'pid record draagt niet de start-nonce van DIT start-commando (record-nonce ' + String(rec.nonce).slice(0, 8) + '…) — dit is een oud/vreemd record, geen bewijs van ons kind' };
      if (!isAlive(childPid)) return { ok: false, reason: 'child pid ' + childPid + ' claimde het slot maar is direct daarna gecrasht — geen levende watcher' };
      const rec2 = readPidRecordFrom(pidFile);
      if (rec2.pid !== childPid || (nonce && rec2.nonce !== nonce)) return { ok: false, reason: 'pid record veranderde direct na de claim-verificatie — geen stabiel eigendom' };
      return { ok: true, pid: childPid };
    }
    if (rec.pid && rec.pid !== childPid && isAlive(rec.pid)) {
      return { ok: false, reason: 'watcher slot is held by pid ' + rec.pid + ' (not the child ' + childPid + ') — the child lost the claim to an existing/racing watcher' };
    }
    if (!isAlive(childPid)) {
      return { ok: false, reason: 'child pid ' + childPid + ' exited before claiming the watcher slot — it refused (already running / claim conflict) or crashed; see the log' };
    }
    if (Date.now() >= deadline) return { ok: false, reason: 'child pid ' + childPid + ' did not claim the watcher slot within ' + timeoutMs + 'ms' };
    sleep(pollMs);
  }
}
/** releaseWatcherSlot — give the slot back on a clean exit, but ONLY if the record is still ours. Deleting
 *  someone else's record would re-open the very race this closes. */
function releaseWatcherSlot(opts) {
  opts = opts || {};
  const pidFile = opts.pidFile || PID_FILE;
  const me = opts.pid || process.pid;
  const rec = readPidRecordFrom(pidFile);
  if (!rec.pid) return { ok: true, removed: false, reason: 'no pid file' };
  if (rec.pid !== me) return { ok: false, removed: false, reason: 'pid file belongs to ' + rec.pid + ', not to us (' + me + ') — leaving it alone' };
  try { fs.unlinkSync(pidFile); return { ok: true, removed: true }; }
  catch (e) { return { ok: false, removed: false, reason: e.message }; }
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
    // OWNER AUTHORISATION REQUIRED (broad Codex audit #6, fixed 2026-08-05). This command switches the
    // usage guard OFF for the rest of the window and resumes everything it paused — and it had NO check
    // at all, so any local agent could run it and un-guard the account it was meant to protect. It now
    // goes through the one shared verification (forge-ownergrant.cjs): a token matched against a secret
    // in a FILE the owner writes. An env var is deliberately not accepted — the process asking for
    // permission can set its own environment.
    const og = require('./forge-ownergrant.cjs');
    const grant = og.verifyOwnerGrant({ token: argv('owner-approval', null), projectRoot: path.resolve(__dirname, '..', '..') });
    if (!grant.ok) {
      console.error('usage-guard override-on REFUSED — ' + grant.reason);
      console.error('  run: node .claude/forge-bin/usage-guard.cjs override-on --owner-approval <token> --reason "<why>"');
      process.exit(3);
    }
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
    // Refuse a 2nd concurrent watcher — two would race the same state file (fix 2026-07-09 checkup).
    // CODEX finding #15: this parsed the pid file as a BARE NUMBER after the writer switched to JSON —
    // Number('{"pid":123,…}') is NaN, so the guard silently stopped guarding. CODEX audit #17 (2026-08-05):
    // it was also check-then-write — read the pid file, decide, and write ~10 lines later — so two watchers
    // starting in the same moment both passed. The claim is now ATOMIC (open 'wx'); the OS picks the winner.
    // r4 #16: het start-commando geeft een nonce mee; de claim schrijft hem in het pid-record zodat de
    // handshake van de starter een OUD record met een gerecycled pid nooit als "ons kind" aanziet.
    const claim = claimWatcherSlot({ nonce: argv('start-nonce', null) || undefined });
    if (!claim.ok) { console.error(claim.reason); process.exit(1); }
    if (claim.mode === 'took-over-stale') log('took over a stale watcher slot (previous holder was gone) — this is now the only watcher');
    log('usage-guard watch started — interval ' + INTERVAL + 's · pause-at ' + PAUSE_AT + '% · resume-at ' + RESUME_AT + '% · nvidia-shift-at ' + NVIDIA_SHIFT_AT + '%' + (ONLY_COMPANIES.length ? ' · companies: ' + ONLY_COMPANIES.join(',') : ''));
    // SILENT-DEATH GUARD (2026-08-03): on this machine the loop stopped at 16:55 without a single error
    // line while the process stayed alive — only fetchUsage() was inside a try/catch, so a throw anywhere
    // else (e.g. an EPERM/EBUSY on the state write) became an unhandled rejection that killed the ticking
    // but not the process. The watcher must never die quietly again: log it, and keep ticking.
    process.on('unhandledRejection', (e) => log('WATCHER unhandled rejection (loop kept alive): ' + ((e && e.stack) || e)));
    process.on('uncaughtException', (e) => log('WATCHER uncaught exception (loop kept alive): ' + ((e && e.stack) || e)));
    // The pid file (written by claimWatcherSlot above, as part of the atomic claim itself) records WHO we
    // are and WHEN we started, so `stop` can verify it is killing this watcher and not whatever process
    // later inherited a recycled PID (Windows reuses PIDs). Hand the slot back on a clean exit so a
    // restart never has to wait for the stale-takeover path — but only ever if the record is still ours.
    process.on('exit', () => { try { releaseWatcherSlot(); } catch { /* best effort on the way out */ } });
    // SERIALIZED TICKS (Codex adversarial review #8, 2026-08-03): `setInterval` fires on the clock, not
    // on completion, so a slow usage fetch or a slow Paperclip pause round could leave two ticks running
    // at once — both reading the same pre-write state and then racing each other's writes, which is how a
    // pause decision gets made on stale numbers and then overwritten. A self-scheduling loop can only
    // ever have one tick in flight; the next one is scheduled after the previous finishes.
    let stopping = false;
    // r5 #22: iedere tick her-fenced zijn slot-eigendom — draagt het pid-bestand niet meer ONS pid (en,
    // indien meegegeven, ONZE start-nonce), dan heeft een ander het slot en stopt deze watcher direct.
    const myNonce = argv('start-nonce', null);
    const stillOwnsSlot = () => {
      const rec = readPidRecordFrom(PID_FILE);
      if (rec.pid !== process.pid) return false;
      if (myNonce && rec.nonce && rec.nonce !== myNonce) return false;
      return true;
    };
    const safeTick = async () => {
      if (!stillOwnsSlot()) { log('SLOT VERLOREN — pid-bestand draagt niet meer dit pid/nonce; deze watcher stopt (een ander bewaakt het account)'); process.exit(1); }
      try { await tick(); } catch (e) { log('TICK FAILED (watcher stays alive): ' + ((e && e.stack) || e)); }
      if (!stopping) setTimeout(safeTick, INTERVAL * 1000).unref?.();
    };
    process.on('SIGTERM', () => { stopping = true; });
    await safeTick();
    // Keep the event loop alive even though the scheduling timer is unref'd, so the process never exits
    // between ticks (an unref'd timer alone would let node consider the loop empty and quit).
    setInterval(() => {}, 1 << 30);
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
    const startNonce = crypto.randomUUID();
    const child = spawn(process.execPath, [__filename, 'watch', '--interval', String(INTERVAL), '--pause-at', String(PAUSE_AT), '--resume-at', String(RESUME_AT), '--nvidia-shift-at', String(NVIDIA_SHIFT_AT), '--start-nonce', startNonce, ...extra], { detached: true, stdio: ['ignore', 'ignore', out], windowsHide: true });
    child.unref();
    // START-HANDSHAKE (uitgesteld punt 2, gesloten 2026-08-06): dit pad printte "started (pid X)" en
    // exitte 0 TERWIJL het kind zijn claim later nog kon weigeren (claimWatcherSlot exit 1, alleen
    // zichtbaar in het logbestand) — een supervisor-race of tweede starter kreeg dus "gestart" te horen
    // over een account dat onbewaakt bleef. Nu wachten we tot het pid-bestand ECHT het kind-pid draagt;
    // een ander pid, een dood kind of een timeout is een eerlijke weigering met exit != 0.
    const hs = awaitChildClaim({ pidFile: PID_FILE, childPid: child.pid, timeoutMs: 10000, nonce: startNonce });
    if (!hs.ok) {
      // r4 #16: een mislukte handshake mag geen levend, onbeheerd detached kind achterlaten. Dit pid komt
      // uit ONS eigen spawn-resultaat — exact-PID kill is precies wat de HARD MUST toestaat.
      if (pidAlive(child.pid)) {
        // r5 #22: kill via het EIGEN ChildProcess-handle — geen numerieke pid-herresolutie, dus geen
        // recycling-venster tussen de liveness-check en de kill. De watcher spawnt zelf geen kinderen,
        // dus een tree-kill is hier niet nodig.
        try {
          child.kill();
          console.error('handshake gefaald — eigen kind pid ' + child.pid + ' beeindigd via het proceshandle (geen wees-watcher)');
        } catch (e) { console.error('handshake gefaald en kind pid ' + child.pid + ' kon niet beeindigd worden: ' + e.message); }
      }
      console.error('usage-guard NOT started — ' + hs.reason + ' (log: ' + LOG_FILE + ')');
      process.exit(1);
    }
    console.log('usage-guard started (pid ' + child.pid + ', claim geverifieerd) — pause-at ' + PAUSE_AT + '% · resume-at ' + RESUME_AT + '% · nvidia-shift-at ' + NVIDIA_SHIFT_AT + '% · log: ' + LOG_FILE);
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
      } else if (own.code === 'unverifiable') {
        // CODEX ronde-3 #4 (2026-08-06): 'unverifiable' betekent "mogelijk een ECHTE watcher waarvan we
        // de command line nu even niet kunnen lezen" (/proc weg, ps faalt). Het pid-bestand wissen zou
        // precies dan de claim van een levende watcher vernietigen en de volgende `start` een duplicaat
        // laten spawnen. Claim behouden, weigering melden, non-zero exit.
        console.log('usage-guard NOT stopped — ' + own.reason + '; pid file KEPT (this may be a live watcher whose identity is temporarily unreadable)');
        process.exit(1);
      } else {
        // dead / recycled / not-watcher: aantoonbaar niet onze levende watcher — record opruimen is veilig.
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
  normalizeWindows, crossedWindows, windowLabel, watcherHealth, fmtReset, stillHighTrigger,
  tick, doPause, doResume, accountStamp, ownsPid, readPosixCmdline, verdictFromCmdline, pidAlive, readCredentialFp,
  claimWatcherSlot, releaseWatcherSlot, incumbentStatus, readPidRecordFrom, STALE_LOCK_MS,
  awaitChildClaim, journalAppend, unresolvedPausedAgents, rotateLogIfNeeded, compactJournalIfNeeded,
  computePressureLevel, buildPressureData, creditsExhausted,
};
