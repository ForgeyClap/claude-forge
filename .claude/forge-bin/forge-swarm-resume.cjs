#!/usr/bin/env node
'use strict';
/**
 * forge-swarm-resume.cjs — mission-level swarm AUTO-RESUME (WAVE D / D1, 2026-07-18). The #1 owner pain
 * this piece exists for: a session/usage limit kills a big swarm mid-run and work is lost. This gives one
 * command that re-dispatches ONLY the unfinished work packages, reconstructed honestly from what a run's
 * `.claude/forge-runs/<run_id>/manifest.json` (see `forge-manifest.cjs`) says was ARMED plus what
 * `events.jsonl` actually logged since.
 *
 * NAMING NOTE (real collision, not a WP shortcut): the work package that requested this piece named the
 * file `forge-resume.cjs`. That exact filename ALREADY EXISTS in this project (untracked, pre-existing —
 * `git log` shows no prior commit for it) as a completely different, unrelated tool: a GLOBAL
 * cross-session checkpoint/to-do reminder CLI keyed by a home-directory state file
 * (`<home>/.claude/FORGE_RESUME_STATE.json`), with no `module.exports` at all (a top-level argv switch),
 * consumed by the usage-guard hook after an auto-resume. Overwriting it would destroy real, unrelated,
 * already-built functionality this file has nothing to do with. This piece is named
 * `forge-swarm-resume.cjs` instead to avoid that collision — flagged explicitly for Head Chef / D-integrate
 * to confirm/rename if a different final name is preferred.
 *
 * MODEL:
 *   resume({run_id}, opts) -> {run_id, unfinished, done, plan, resumable}. Internally calls
 *   `forge-manifest.cjs::reconcile({run_id}, opts)` (never re-implements the event-projection logic) and
 *   returns ONLY the not-done work packages (`status !== 'done'`, i.e. "armed" or "failed") with their
 *   original `narrowed_prompt`/`deps` so the caller can re-dispatch each one exactly as originally scoped.
 *   A `done` WP is NEVER re-dispatched — returned separately, purely for the caller's own reporting.
 *   `plan` is a short human-readable summary of what would be re-run (a string, not an executed action —
 *   this module has ZERO side effects beyond what `reconcile()` itself persists to manifest.json).
 *   Throws exactly when `forge-manifest.cjs::reconcile` throws (invalid run_id, or no manifest was ever
 *   armed for this run via `arm()`) — never silently returns an empty/fabricated resume plan.
 *
 * COMPOSITION (reference, not duplication): this file does NOT read usage-guard state or checkpoint
 * idempotency itself. A caller that wants "don't resume while usage-guard has us paused" should check
 * `usage-guard.cjs status` first; a caller re-dispatching a side-effecting WP (email/deploy/payment/etc.)
 * should still use `forge-checkpoint.cjs::shouldRun/claim` for that WP's own idempotency key before
 * repeating the real side effect — `resume()` only tells you WHICH work packages are unfinished, it does
 * not itself guard against double-running a side effect a WP's own re-dispatch might trigger.
 *
 * EVENT LOGGING (caller's responsibility, not this file's): this module is zero-dependency and does not
 * shell out to `log-event.cjs` itself (keeps it a pure library call, and avoids `log-event.cjs`'s STRICT
 * agent-registry/dispatch-proof checks firing on a plain library read). The orchestration layer that
 * actually re-dispatches a returned `unfinished` WP should log a `wp_resumed` event per WP, and whatever
 * called `forge-manifest.cjs::arm()` at swarm-dispatch time should log a `manifest_armed` event — both are
 * NEW event_type names this piece needs registered in `log-event.cjs`'s KNOWN_EVENT_TYPES (declared, not
 * wired here — see the SHARED-FILE RULE for this wave).
 *
 * CLI:
 *   node forge-swarm-resume.cjs --run <id> [--json]
 * Exit codes: 0 = complete (nothing to resume) · 3 = resumable (unfinished work packages remain, mirrors
 * forge-checkpoint.cjs's resume-plan convention) · 2 = usage error (bad run_id, or no manifest ever armed).
 */
const manifestMod = require('./forge-manifest.cjs');
const fs = require('fs');
const path = require('path');

/** ================= ATOMISCHE WP-LEASES (audit G5, 2026-08-06) =================
 *  resume() was een pure planner: twee gelijktijdige resumes (of een crash + herstart halverwege het
 *  dispatchen) kregen exact dezelfde unfinished-lijst en dispatchten dezelfde WP's DUBBEL — en daarmee
 *  elk side effect dat zo'n WP draagt (mail, deploy, migratie, publicatie). De lease is het bewezen
 *  wx-patroon: één bestand per WP, exclusieve create beslist de winnaar; staleness UITSLUITEND op
 *  leeftijd (TTL) met een ino-geverifieerde unlink (zelfde ontwerp als de events-lock — pid-bewijs is
 *  ABA-gevoelig gebleken). De lease is het idempotency-anker: wp_id is de key, de lease de claim, het
 *  bestaande wp_completed/wp_resumed-event de durable receipt.
 *    claimWp({run_id, wp_id, holder}, opts)  -> {ok, lease?|heldBy?, tookOverStale?}
 *    releaseWp({run_id, wp_id, holder}, opts) -> {ok, released}
 *    resume({run_id, claim:true, holder}, opts) -> unfinished bevat ALLEEN de WP's waarvan de lease NU
 *      door deze aanroep is verworven; de rest staat in leased_elsewhere (dispatch die NOOIT dubbel). */
const crypto = require('crypto');
const LEASE_TTL_MS_DEFAULT = 30 * 60 * 1000;
const LEASE_TTL_CLAMP_MS = 24 * 60 * 60 * 1000; // geen WP houdt legitiem een dag een lease vast
function rootOf(opts) {
  if (opts && opts.root) return path.resolve(opts.root);
  // zelfde root-resolutie als forge-manifest: FORGE_PROJECT_ROOT wint — anders lekte een CLI-claim in een
  // testsandbox zijn leasebestanden naar de ECHTE projectroot (gevonden bij de r4-#5-testronde, 2026-08-07).
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  return path.resolve(__dirname, '..', '..');
}
function leaseDirOf(root, runId) { return path.join(root, '.claude', 'forge-runs', runId, 'wp-leases'); }
// INJECTIEVE key (r4 #6): de leesbare prefix bleef, maar de sha1 van de EXACTE wp_id maakt de mapping
// injectief — 'foo/bar' en 'foo?bar' delen niet langer een leasebestand (release van de een gaf de ander vrij).
function leaseFileOf(root, runId, wpId) {
  const safe = String(wpId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  const h = crypto.createHash('sha256').update(String(wpId)).digest('hex').slice(0, 32); // r5 #15: 128 bits — collisions praktisch uitgesloten
  return path.join(leaseDirOf(root, runId), safe + '.' + h + '.lease');
}
function leaseExpiry(rec) {
  const base = Number.isFinite(rec.acquired_at) ? rec.acquired_at : 0;
  const claimed = Number.isFinite(rec.expires_at) ? rec.expires_at : 0;
  return Math.min(claimed, base + LEASE_TTL_CLAMP_MS);
}
/** claimWp (r4 #5/#6, 2026-08-07): de lease draagt nu een EIGEN, door de houder verklaarde expiry + een
 *  uniek token. Steal beoordeelt de expiry UIT het record (een contender met ttlMs:1 kon voorheen met
 *  zijn eigen ttl de leeftijd van de ander beoordelen en een levende default-lease direct stelen) en
 *  verplaatst het verlopen bestand ino-geverifieerd naar een uniek pad (rename), nooit unlink op het
 *  gedeelde pad. Een her-claim door dezelfde houder is NIET meer stil ok (dat maakte alreadyMine opnieuw
 *  dispatchbaar): hij meldt alreadyMine en weigert, tenzij de aanroeper expliciet reclaim:true meegeeft
 *  (het recoveryprotocol na een eigen crash). refreshWp verlengt een levende eigen lease token-geverifieerd. */
function claimWp(input, opts) {
  opts = opts || {};
  const { run_id, wp_id } = input || {};
  const holder = (input && input.holder) || ('pid-' + process.pid);
  if (!manifestMod.isValidRunId(run_id) || !wp_id) return { ok: false, reason: 'run_id en wp_id zijn verplicht' };
  const root = rootOf(opts);
  const file = leaseFileOf(root, run_id, wp_id);
  const ttl = opts.ttlMs > 0 ? opts.ttlMs : LEASE_TTL_MS_DEFAULT;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.now();
  const token = crypto.randomUUID();
  const rec = { holder, token, wp_id, acquired_at: now, ttl_ms: ttl, expires_at: now + ttl, ts: new Date(now).toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(rec), { flag: 'wx' });
      return attempt === 0 ? { ok: true, lease: file, token } : { ok: true, lease: file, token, tookOverStale: true };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: 'lease niet aan te maken: ' + e.message };
      try {
        const st1 = fs.statSync(file, { bigint: true });
        let existing = null; try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
        if (existing && existing.holder === holder) {
          // r5 #14: reclaim herclaimt UITSLUITEND een VERLOPEN eigen lease — een levende eigen lease
          // reclaimen zou twee processen met dezelfde holder-string hetzelfde WP laten dispatchen.
          // Crash-recovery wacht dus op de expiry (of de crashende houder releaset met zijn token).
          if (input.reclaim === true && now >= leaseExpiry(existing)) {
            const st2 = fs.statSync(file, { bigint: true });
            if (st2.ino === st1.ino && st2.birthtimeMs === st1.birthtimeMs) {
              const grave = file + '.reclaimed.' + now + '.' + Math.random().toString(36).slice(2, 8);
              try { fs.renameSync(file, grave); fs.unlinkSync(grave); } catch { }
            }
            continue;
          }
          if (input.reclaim === true) return { ok: false, alreadyMine: true, heldBy: holder, reason: 'reclaim geweigerd: de eigen lease LEEFT nog (verloopt ' + new Date(leaseExpiry(existing)).toISOString() + ') — wacht op de expiry of release met het token; een levende lease herclaimen = dubbel dispatchen (r5 #14)' };
          return { ok: false, alreadyMine: true, heldBy: holder, reason: 'wp is al door DEZE houder geleased — herdispatch alleen via expliciet reclaim:true op een VERLOPEN lease (recoveryprotocol), nooit stilzwijgend dubbel' };
        }
        // expiry komt UIT het record van de houder (r4 #6) — nooit uit de ttl van de contender.
        const expiredNow = existing ? now >= leaseExpiry(existing) : (now - Number(st1.mtimeMs)) > LEASE_TTL_MS_DEFAULT;
        if (expiredNow) {
          const st2 = fs.statSync(file, { bigint: true });
          if (st2.ino === st1.ino && st2.birthtimeMs === st1.birthtimeMs) {
            const grave = file + '.expired.' + now + '.' + Math.random().toString(36).slice(2, 8);
            try { fs.renameSync(file, grave); fs.unlinkSync(grave); } catch { }
          }
          continue;
        }
        return { ok: false, heldBy: (existing && existing.holder) || 'onbekend', since: existing && existing.ts, reason: 'wp is geleased door ' + ((existing && existing.holder) || 'onbekend') + ' — niet dubbel dispatchen' };
      } catch { continue; }
    }
  }
  return { ok: false, reason: 'lease bleef onder ons veranderen (contentie) — niet raden wie mag dispatchen' };
}
/** refreshWp — heartbeat voor WP's die langer lopen dan hun TTL: token-geverifieerde verlenging. Bestand
 *  weg of token anders = lease verloren ⇒ ok:false, en de houder hoort zijn WP-werk te staken. */
function refreshWp(input, opts) {
  opts = opts || {};
  const { run_id, wp_id, token } = input || {};
  if (!manifestMod.isValidRunId(run_id) || !wp_id || !token) return { ok: false, reason: 'run_id, wp_id en token zijn verplicht' };
  const file = leaseFileOf(rootOf(opts), run_id, wp_id);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, reason: 'lease verloren (bestand weg/onleesbaar) — WP-werk staken' }; }
  if (existing.token !== token) return { ok: false, reason: 'lease verloren (token mismatch — overgenomen door ' + existing.holder + ')' };
  const now = Date.now();
  if (now >= leaseExpiry(existing)) return { ok: false, reason: 'lease al verlopen — opnieuw claimen, niet verversen' };
  const ttl = opts.ttlMs > 0 ? opts.ttlMs : (existing.ttl_ms || LEASE_TTL_MS_DEFAULT);
  const rec = Object.assign({}, existing, { expires_at: now + ttl, refreshed_at: now });
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, file); return { ok: true, lease: file }; }
  catch (e) { try { fs.unlinkSync(tmp); } catch { } return { ok: false, reason: 'refresh-write faalde: ' + e.message }; }
}
function releaseWp(input, opts) {
  const { run_id, wp_id, token } = input || {};
  const holder = (input && input.holder) || ('pid-' + process.pid);
  const file = leaseFileOf(rootOf(opts), run_id, wp_id);
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: true, released: false, reason: 'geen lease' }; }
  if (rec.holder !== holder) return { ok: false, released: false, reason: 'lease is van ' + rec.holder + ', niet van ' + holder };
  // token-CAS (r4 #6): een lease MET token vereist het exacte token; legacy-leases vallen terug op holder.
  if (rec.token && token !== rec.token) return { ok: false, released: false, reason: 'token mismatch — alleen de exacte claimer mag releasen' };
  try {
    const st1 = fs.statSync(file, { bigint: true });
    const st2 = fs.statSync(file, { bigint: true });
    if (st2.ino !== st1.ino || st2.birthtimeMs !== st1.birthtimeMs) return { ok: false, released: false, reason: 'lease veranderde onder de release — weigeren' };
    const grave = file + '.released.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
    fs.renameSync(file, grave);
    try { fs.unlinkSync(grave); } catch { }
    return { ok: true, released: true };
  } catch (e) { return { ok: false, released: false, reason: e.message }; }
}

/** resume({run_id}, opts) -> {run_id, unfinished, done, plan, resumable}. See file header MODEL section. */
function resume(input, opts) {
  opts = opts || {};
  input = input || {};
  const runId = input.run_id;
  if (!manifestMod.isValidRunId(runId)) throw new Error('forge-swarm-resume: resume requires a valid run_id');

  const r = manifestMod.reconcile({ run_id: runId }, opts); // throws if no manifest armed for this run

  let unfinished = r.unfinished.map((wp) => ({
    wp_id: wp.wp_id, agent: wp.agent, status: wp.status,
    narrowed_prompt: wp.narrowed_prompt, deps: wp.deps, last_proof: wp.last_proof,
  }));
  // AUDIT G5 (2026-08-06): met claim:true verwerft deze aanroep per unfinished WP eerst de atomische
  // lease; alleen verworven WP's komen in unfinished terug — een tweede gelijktijdige resume ziet ze in
  // leased_elsewhere en dispatcht ze dus NOOIT dubbel.
  let leasedElsewhere = [];
  if (input.claim) {
    const holder = input.holder || ('resume-' + process.pid);
    const mine = [];
    for (const wp of unfinished) {
      const c = claimWp({ run_id: runId, wp_id: wp.wp_id, holder, reclaim: input.reclaim === true }, opts);
      if (c.ok) mine.push(Object.assign({}, wp, { lease_token: c.token }));
      else leasedElsewhere.push({ wp_id: wp.wp_id, heldBy: c.heldBy || 'onbekend', alreadyMine: c.alreadyMine === true });
    }
    unfinished = mine;
  }
  const done = r.done.map((wp) => ({ wp_id: wp.wp_id, agent: wp.agent, status: wp.status, last_proof: wp.last_proof }));

  // r5 #17: "unfinished na claimen == 0" betekende COMPLETE, ook wanneer al het onafgeronde werk
  // gewoon elders geleased was — de CLI meldde dan vals "all done". work_remaining draagt de echte
  // resterende hoeveelheid; resumable blijft "kan IK nu dispatchen".
  const workRemaining = unfinished.length + leasedElsewhere.length;
  const plan = workRemaining === 0
    ? 'nothing to resume — all ' + r.manifest.length + ' work package(s) already done'
    : unfinished.length === 0
      ? 'geen WP nu claimbaar — ' + leasedElsewhere.length + ' onafgerond(e) WP(s) zijn elders geleased (run is NIET compleet)'
      : 're-dispatch ' + unfinished.length + ' of ' + r.manifest.length + ' work package(s): ' + unfinished.map((w) => w.wp_id + ' (' + w.status + ')').join(', ');

  return { run_id: runId, unfinished, done, plan, resumable: unfinished.length > 0, work_remaining: workRemaining, complete: workRemaining === 0, ...(input.claim ? { leased_elsewhere: leasedElsewhere } : {}) };
}

module.exports = { resume, claimWp, refreshWp, releaseWp, leaseFileOf };

// ---- CLI ----
function parseArgs(argv) {
  const opts = { run: null, json: false, plan: false, reclaim: false, holder: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') opts.run = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--plan') opts.plan = true;
    else if (a === '--reclaim') opts.reclaim = true;
    else if (a === '--holder') opts.holder = argv[++i];
  }
  return opts;
}
function printUsage() { console.error('Usage: node forge-swarm-resume.cjs --run <id> [--plan] [--holder <naam>] [--reclaim] [--json]\n  default = CLAIMENDE resume (r4 #5): unfinished bevat alleen NU door deze aanroep verworven WP-leases;\n  --plan = read-only droogloop zonder claims (dispatch hier NOOIT op);\n  --reclaim = expliciet recoveryprotocol voor een eigen (crash-)lease.'); }

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (!opts.run) { printUsage(); process.exitCode = 2; }
    else {
      // r4 #5 (2026-08-07): de CLI was een pure planner — twee gelijktijdige `--run`-aanroepen kregen
      // exact dezelfde unfinished-lijst en dispatchten dubbel. Uitvoerend resumen CLAIMT nu standaard;
      // wie alleen wil kijken gebruikt --plan en dispatcht daar per definitie niet op.
      const holder = opts.holder || ('resume-cli-' + process.pid);
      const r = resume({ run_id: opts.run, claim: !opts.plan, holder, reclaim: opts.reclaim }, {});
      if (opts.json) {
        console.log(JSON.stringify(r));
      } else {
        console.log('forge-swarm-resume · ' + r.run_id + (r.resumable ? ' · RESUMABLE' : ' · COMPLETE') + (opts.plan ? ' · PLAN-ONLY (geen claims — niet op dispatchen)' : ' · geclaimd door ' + holder));
        console.log('  ' + r.plan);
        console.log('  done: ' + r.done.length + '  unfinished: ' + r.unfinished.length + (r.leased_elsewhere && r.leased_elsewhere.length ? '  leased_elsewhere: ' + r.leased_elsewhere.length : ''));
        for (const w of r.unfinished) console.log('  [' + w.status + '] ' + w.wp_id + ' (' + w.agent + ') <- ' + w.narrowed_prompt);
        if (r.leased_elsewhere) for (const l of r.leased_elsewhere) console.log('  [geleased] ' + l.wp_id + ' door ' + l.heldBy + (l.alreadyMine ? ' (eigen lease — gebruik --reclaim voor recovery)' : ''));
      }
      process.exitCode = r.resumable ? 3 : 0;
    }
  } catch (e) {
    console.error('forge-swarm-resume: ' + e.message);
    process.exitCode = 2;
  }
}
