'use strict';
/* FAKE-CALLOUT adversarial test of the REAL usage-guard session hook.
   Runs the actual forge-usage-guard-hook.cjs against simulated state+event files via env override —
   never touches the live guard state or the network. Asserts the true reaction of each scenario. */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const HOOK = path.join(os.homedir(), '.claude', 'hooks', 'forge-usage-guard-hook.cjs');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
/** FRESH-INSTALL GUARD (2026-09-23, external audit II-B): this suite exercises a GLOBAL hook that the
 *  installer deliberately never ships (forge-core: "Do NOT install: any hooks, .claude/settings.json
 *  security config"). On any machine without that hand-installed hook — every new user, every CI
 *  runner — the require() below threw ENOENT and the suite died with "0 passed, 0 failed", which
 *  runTests() rightly counts as a FAILED suite. The doctor of every fresh install was red because of
 *  a test for something the product does not install. Now: absent hook => one honest, explicit
 *  SKIP-pass that says why, exit 0. Present hook => the full adversarial suite runs unchanged. */
if (!fs.existsSync(HOOK)) {
  console.log('guard-hook adversarial tests');
  console.log('  SKIP the usage-guard session hook is an OPTIONAL, hand-installed global hook (' + HOOK + ') — not present on this machine, so there is nothing to attack; the suite is not applicable here (this is a deliberate skip, not a silent green)');
  console.log('');
  console.log('1 passed, 0 failed');
  process.exit(0);
}
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
let settings = { hooks: {} };
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { /* geen settings.json: de matcher-tests hieronder meten dan een lege lijst en falen eerlijk met de reden in hun uitvoer */ }
if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
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
//
// PROJECT-SCOPED SINCE 2026-07-30 (owner-reported leak, and this test caught the change honestly):
// FORGE_RESUME_STATE.json is a single GLOBAL file, so the reminder used to inject whatever mission
// was last checkpointed into ANY session — a fresh dashboard-spawned chat in ForgeProjects\test
// really did receive the "100 iOS App Opportunity Factory" mission as its resume hint. The hook now
// only speaks when the checkpoint's own `project_path` actually contains the session's cwd.
// This case therefore now needs BOTH: a real project_path AND a matching cwd. The two cases below
// (14c/14d) are the ones the fix exists for — they must stay silent.
const PROJ_A = path.join(DIR, 'projA');
const PROJ_B = path.join(DIR, 'projB');
fs.mkdirSync(PROJ_A, { recursive: true });
fs.mkdirSync(PROJ_B, { recursive: true });
const upIn = (cwd) => ({ hook_event_name: 'UserPromptSubmit', cwd });
const checkpointFor = (root) => ({ project: 'X', project_path: root, phase: 'F1', last_done: 'WP2', next: 'WP3', todo: [{ id: 1, status: 'pending' }] });

r = runHook({ mode: 'paused', resumeAtEpoch: NOW - 1000 }, upIn(PROJ_A), checkpointFor(PROJ_A));
t('14 self-heal + cwd INSIDE the checkpoint project -> 📍 HERVAT reminder shown', /HERVAT/.test(r.stdout) && r.finalMode === 'ok', r.stdout.slice(0, 40));
// second prompt on the now-ok state (pendingRhythmResume cleared) -> NO reminder again
r = runHook({ mode: 'ok' }, upIn(PROJ_A), checkpointFor(PROJ_A));
t('14b reminder does NOT repeat on later ok prompt', !/HERVAT/.test(r.stdout));
// 14c THE LEAK ITSELF: a checkpoint owned by project A must never surface in a session in project B.
r = runHook({ mode: 'paused', resumeAtEpoch: NOW - 1000 }, upIn(PROJ_B), checkpointFor(PROJ_A));
t('14c cwd in ANOTHER project -> reminder stays SILENT (no cross-project leak)', !/HERVAT/.test(r.stdout) && r.finalMode === 'ok', r.stdout.slice(0, 60));
// 14d an old checkpoint with no project_path cannot be attributed to any project -> stay silent
r = runHook({ mode: 'paused', resumeAtEpoch: NOW - 1000 }, upIn(PROJ_A), { project: 'X', phase: 'F1', last_done: 'WP2', next: 'WP3', todo: [] });
t('14d checkpoint without project_path -> unverifiable, stays SILENT', !/HERVAT/.test(r.stdout) && r.finalMode === 'ok', r.stdout.slice(0, 60));

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
