'use strict';
/* FAKE-CALLOUT adversarial test of the REAL usage-guard session hook.
   Runs the actual forge-usage-guard-hook.cjs against simulated state+event files via env override —
   never touches the live guard state or the network. Asserts the true reaction of each scenario. */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const HOOK = path.join(os.homedir(), '.claude', 'hooks', 'forge-usage-guard-hook.cjs');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const NODE = process.execPath;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fc-'));
const NOW = Date.now();

// run the real hook with a fake state + optional resume-state + a hook event; return its reaction
function runHook(state, event, resumeState) {
  const sf = path.join(DIR, 'state-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(sf, state == null ? '' : (typeof state === 'string' ? state : JSON.stringify(state)));
  const env = { ...process.env, FORGE_USAGE_GUARD_STATE: sf };
  if (resumeState !== undefined) { const rf = path.join(DIR, 'resume.json'); fs.writeFileSync(rf, JSON.stringify(resumeState)); env.FORGE_RESUME_STATE = rf; }
  else { env.FORGE_RESUME_STATE = path.join(DIR, 'no-resume.json'); }
  const r = cp.spawnSync(NODE, [HOOK], { input: JSON.stringify(event), env, encoding: 'utf8' });
  let finalMode = null; try { finalMode = JSON.parse(fs.readFileSync(sf, 'utf8')).mode; } catch {}
  const denied = /"permissionDecision":"deny"/.test(r.stdout || '');
  return { stdout: r.stdout || '', exit: r.status, denied, finalMode, statePath: sf };
}
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); } };
const PT = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };
const UP = { hook_event_name: 'UserPromptSubmit' };
console.log('FAKE-CALLOUT guard-hook adversarial tests\n');

// 1. paused + reset in PAST -> self-heal (no deny, state flips to ok)
let r = runHook({ mode: 'paused', resumeAtEpoch: NOW - 1000, notice: 'PAUZEER' }, PT);
t('1 paused+reset-past PreToolUse -> SELF-HEAL (no deny, mode ok)', !r.denied && r.finalMode === 'ok', 'denied=' + r.denied + ' mode=' + r.finalMode);

// 2. paused + reset in FUTURE -> still deny (PreToolUse)
r = runHook({ mode: 'paused', resumeAtEpoch: NOW + 600000, notice: 'PAUZEER week 100%' }, PT);
t('2 paused+reset-future PreToolUse Bash -> DENY', r.denied && r.finalMode === 'paused', 'denied=' + r.denied);

// 3. paused + reset future + UserPromptSubmit -> inject notice (not deny)
r = runHook({ mode: 'paused', resumeAtEpoch: NOW + 600000, notice: 'PAUZEER 93%' }, UP);
t('3 paused+future UserPromptSubmit -> notice injected', /PAUZEER/.test(r.stdout) && !r.denied);

// 4. paused + NaN resumeAtEpoch -> NO self-heal (stays paused, denies)
r = runHook({ mode: 'paused', resumeAtEpoch: 'not-a-number', notice: 'PAUZEER' }, PT);
t('4 paused+NaN resumeAtEpoch -> stays paused (deny)', r.denied && r.finalMode === 'paused');

// 5. paused + MISSING resumeAtEpoch -> stays paused (no rhythm data)
r = runHook({ mode: 'paused', notice: 'PAUZEER' }, PT);
t('5 paused+missing resumeAtEpoch -> stays paused (deny)', r.denied);

// 6. ownerOverride active -> suppressed even if paused (no deny)
r = runHook({ mode: 'paused', resumeAtEpoch: NOW + 600000, ownerOverride: { active: true }, notice: 'PAUZEER' }, PT);
t('6 ownerOverride active -> SUPPRESSED (no deny) even when paused', !r.denied);

// 7. ownerOverride until in PAST (expired) -> NOT suppressed -> paused behavior
r = runHook({ mode: 'paused', resumeAtEpoch: NOW + 600000, ownerOverride: { active: true, until: new Date(NOW - 1000).toISOString() }, notice: 'PAUZEER' }, PT);
t('7 ownerOverride expired -> NOT suppressed (deny)', r.denied);

// 8. ownerOverride until NaN -> treated as no-expiry -> suppressed
r = runHook({ mode: 'paused', resumeAtEpoch: NOW + 600000, ownerOverride: { active: true, until: 'bad-date' }, notice: 'PAUZEER' }, PT);
t('8 ownerOverride NaN-until -> no-expiry -> suppressed (no deny)', !r.denied);

// 9. PreToolUse Edit when paused -> deny (hook denies any PreToolUse it is invoked for)
r = runHook({ mode: 'paused', resumeAtEpoch: NOW + 600000, notice: 'P' }, { hook_event_name: 'PreToolUse', tool_name: 'Edit' });
t('9 paused PreToolUse Edit -> DENY', r.denied);

// 10. Read stays allowed = the MATCHER excludes Read/Grep/Glob (settings.json)
const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const guardMatchers = (settings.hooks.PreToolUse || []).filter((h) => (h.hooks || []).some((x) => /forge-usage-guard-hook/.test(x.command))).map((h) => h.matcher);
const m = guardMatchers.join('|');
t('10 guard matcher covers work tools', /Bash/.test(m) && /Edit/.test(m) && /Write/.test(m) && /Agent/.test(m), m);
t('10b guard matcher EXCLUDES Read/Grep/Glob (cheap reads stay allowed)', !/\bRead\b/.test(m) && !/Grep/.test(m) && !/Glob/.test(m), m);

// 11. corrupt state file -> fail-open (exit 0, no deny)
r = runHook('{ this is : not json', PT);
t('11 corrupt state -> FAIL-OPEN (no deny)', !r.denied && r.exit === 0);

// 12. empty state file -> fail-open
r = runHook('', PT);
t('12 empty state -> FAIL-OPEN (no deny)', !r.denied && r.exit === 0);

// 13. mode ok -> no deny on any tool
r = runHook({ mode: 'ok' }, PT);
t('13 mode ok -> Bash allowed (no deny)', !r.denied);

// 14. self-heal reminder fires ONCE: after self-heal, pendingRhythmResume set; UserPromptSubmit consumes it
r = runHook({ mode: 'paused', resumeAtEpoch: NOW - 1000 }, UP, { project: 'X', phase: 'F1', last_done: 'WP2', next: 'WP3', todo: [{ id: 1, status: 'pending' }] });
t('14 self-heal on UserPromptSubmit -> 📍 HERVAT reminder shown', /HERVAT/.test(r.stdout) && r.finalMode === 'ok', r.stdout.slice(0, 40));
// second prompt on the now-ok state (pendingRhythmResume cleared) -> NO reminder again
r = runHook({ mode: 'ok' }, UP, { project: 'X', phase: 'F1', last_done: 'WP2', next: 'WP3', todo: [] });
t('14b reminder does NOT repeat on later ok prompt', !/HERVAT/.test(r.stdout));

// 15. ScheduleWakeup must NOT be blocked when paused (so the session can arm autonomous resume)
r = runHook({ mode: 'paused', resumeAtEpoch: NOW + 600000, notice: 'P' }, { hook_event_name: 'PreToolUse', tool_name: 'ScheduleWakeup' });
// the hook itself denies ANY PreToolUse it is invoked for; ScheduleWakeup stays usable ONLY if the matcher excludes it:
t('15 ScheduleWakeup excluded from guard matcher (usable while paused)', !/ScheduleWakeup/.test(m));

// 16. STALE FALLBACK: paused + no resumeAtEpoch + lastPauseAt older than 5.5h -> self-heal (never stuck)
r = runHook({ mode: 'paused', lastPauseAt: new Date(NOW - 6 * 3600 * 1000).toISOString(), notice: 'PAUZEER' }, PT);
t('16 paused+no-resumeAtEpoch+6h-old -> STALE FALLBACK self-heal (no deny)', !r.denied && r.finalMode === 'ok', 'denied=' + r.denied + ' mode=' + r.finalMode);
// 16b. paused + no resumeAtEpoch + lastPauseAt only 1h ago -> still paused (not stale enough)
r = runHook({ mode: 'paused', lastPauseAt: new Date(NOW - 3600 * 1000).toISOString(), notice: 'PAUZEER' }, PT);
t('16b paused+no-resumeAtEpoch+1h-old -> still paused (deny, not yet stale)', r.denied && r.finalMode === 'paused');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exitCode = fail ? 1 : 0;
