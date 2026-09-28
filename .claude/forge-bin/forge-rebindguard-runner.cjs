#!/usr/bin/env node
'use strict';
/**
 * forge-rebindguard-runner.cjs — the SEPARATE, real-Node-process half of
 * forge-doctor.cjs::rebindingGuardBehavioral() (DOCTOR-1 fix, Lead review round 2, 2026-09-28: the
 * behavioural layer had to be wired into runDoctor()'s real report, not just exported/callable on its
 * own — Codex judged it NOT CLOSED twice while it stayed a standalone async function nobody called).
 *
 * WHY A SEPARATE PROCESS: security.mjs is an ESM module — importing it for real requires the async
 * `import()` expression. forge-doctor.cjs (and the whole runDoctor() call chain built on top of it) is
 * deliberately kept fully SYNCHRONOUS. Rather than make that large, heavily-tested file async just for
 * one check, this tiny script runs in its OWN Node process: forge-doctor.cjs spawns it with
 * child_process.spawnSync (which blocks synchronously until this process exits or a timeout fires), so
 * from forge-doctor.cjs's point of view the whole behavioural check is one ordinary, synchronous,
 * bounded-time function call.
 *
 * Usage:
 *   node forge-rebindguard-runner.cjs <security.mjs path> <hostGuardExportName> <crossSiteGuardExportName>
 *
 * Contract with the parent (forge-doctor.cjs::rebindingGuardBehavioral()):
 *   - Prints EXACTLY ONE line of JSON to stdout: {"ok": boolean, "reason": string} — the parent reads
 *     only the LAST non-blank stdout line, so any accidental extra logging from the imported module
 *     itself never corrupts the verdict (it would just be an earlier, ignored line).
 *   - Exits 0 whenever a real verdict (ok:true OR ok:false) was produced and printed — a REJECTED guard
 *     is still a successful, informative run of this script, not a script failure.
 *   - Exits non-zero ONLY for a genuinely unexpected crash in this runner itself (should not happen in
 *     normal operation; the parent treats a non-zero exit, a timeout, or unparsable stdout as its OWN
 *     FAIL with a reason — never a silent pass on anything less than a verified ok:true from here).
 */
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const [, , secFile, hostGuardName, crossSiteGuardName] = process.argv;
  if (!secFile || !hostGuardName || !crossSiteGuardName) {
    console.log(JSON.stringify({ ok: false, reason: 'runner invoked without secFile/hostGuardName/crossSiteGuardName' }));
    return;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(path.resolve(secFile)).href);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: 'could not import security.mjs for the behavioural check: ' + (e && e.message) }));
    return;
  }
  const hostGuard = mod[hostGuardName];
  const crossSiteGuard = mod[crossSiteGuardName];
  if (typeof hostGuard !== 'function' || typeof crossSiteGuard !== 'function') {
    console.log(JSON.stringify({ ok: false, reason: 'security.mjs does not actually export ' + hostGuardName + '/' + crossSiteGuardName + ' as callable functions' }));
    return;
  }
  let evilRejected, localAccepted, crossSiteRejected, sameSiteAccepted;
  try {
    evilRejected = hostGuard({ headers: { host: 'evil.example' } }) === false;
    localAccepted = hostGuard({ headers: { host: '127.0.0.1' } }) === true;
    crossSiteRejected = crossSiteGuard({ headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' } }) === false;
    sameSiteAccepted = crossSiteGuard({ headers: { host: '127.0.0.1' } }) === true;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: 'calling the real guard functions threw: ' + (e && e.message) }));
    return;
  }
  const failures = [];
  if (!evilRejected) failures.push(hostGuardName + '(Host: evil.example) did not return false');
  if (!localAccepted) failures.push(hostGuardName + '(Host: 127.0.0.1) did not return true');
  if (!crossSiteRejected) failures.push(crossSiteGuardName + '(Sec-Fetch-Site: cross-site) did not return false');
  if (!sameSiteAccepted) failures.push(crossSiteGuardName + '(no Sec-Fetch-Site) did not return true');
  console.log(JSON.stringify(failures.length ? { ok: false, reason: failures.join('; ') } : { ok: true, reason: '' }));
}

main().catch((e) => {
  try { console.log(JSON.stringify({ ok: false, reason: 'runner crashed: ' + (e && e.message) })); }
  catch { /* stdout itself unavailable — the non-zero exit below is the parent's remaining signal */ }
  process.exitCode = 1;
});
