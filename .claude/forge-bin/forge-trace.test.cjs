#!/usr/bin/env node
'use strict';
/**
 * forge-trace.test.cjs — hermetic, offline tests for forge-trace.cjs. EVERY fixture run lives under
 * os.tmpdir() (fs.mkdtempSync), pointed at via opts.root/FORGE_PROJECT_ROOT — this file never writes to
 * the real project's .claude/forge-runs/. Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const TR = require('./forge-trace.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const ALL_TMP_ROOTS = [];
function freshDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); ALL_TMP_ROOTS.push(d); return d; }
function writeEvents(root, runId, events) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

console.log('forge-trace offline tests (hermetic — os.tmpdir() fixture runs ONLY, never the real project)');

// ---- Section A: projectTrace (pure function) — a FULLY-TRACED requirement, every stage present ----
{
  const events = [
    { event_type: 'run_started' },
    { event_type: 'agent_note', note: 'forge-intake: 6 intake-vragen voor type website (3 verplicht)' },
    { event_type: 'prd_generated', prd_id: 'prd-1', note: 'PRD generated: Site' },
    { event_type: 'ticket_created', ticket_id: 'tk-prd-1-1', prd_id: 'prd-1', title: 'AC1' },
    { event_type: 'artifact_stored', artifact_id: 'art-1', ticket_id: 'tk-prd-1-1', kind: 'code' },
    { event_type: 'check_passed', ticket_id: 'tk-prd-1-1', command: 'npm test', output: 'ok', evidence: 'e', output_artifact: 'art-1' },
  ];
  const r = TR.projectTrace(events);
  t('A1: exactly 1 requirement discovered', r.total === 1);
  const req = r.requirements[0];
  t('A2: the requirement is fully met', req.met === true && req.gap_at === null);
  t('A3: every one of the 5 stages is individually reported as met', ['intake', 'prd', 'wp', 'artifact', 'verified'].every((s) => req.stages[s].met === true));
  t('A4: coverage is exactly 1 (1 of 1 met)', r.coverage === 1);
  t('A5: gaps[] is empty', r.gaps.length === 0);
  t('A6: stage evIdx values point at the real matching event indices', req.stages.prd.evIdx === 2 && req.stages.wp.evIdx === 3 && req.stages.artifact.evIdx === 4 && req.stages.verified.evIdx === 5);
  t('A7: notes[] stays empty when requirements WERE discovered (the "nothing to trace" note never leaks in)', r.notes.length === 0);
}

// ---- Section B: projectTrace — a GAP at "artifact" (no ticket_id/prd_id threaded through downstream) ----
{
  const events = [
    { event_type: 'agent_note', note: 'forge-intake: 4 intake-vragen voor type n8n (2 verplicht)' },
    { event_type: 'prd_generated', prd_id: 'prd-2', note: 'PRD generated: Flow' },
    { event_type: 'ticket_created', ticket_id: 'tk-prd-2-1', prd_id: 'prd-2', title: 'AC1' },
    // artifact_stored logged WITHOUT ticket_id/prd_id (exactly the real-world default shape
    // forge-artifact.cjs::storeArtifact produces today) — the thread breaks here.
    { event_type: 'artifact_stored', artifact_id: 'art-2', kind: 'code' },
  ];
  const r = TR.projectTrace(events);
  t('B1: exactly 1 requirement discovered', r.total === 1);
  const req = r.requirements[0];
  t('B2: the requirement is NOT met', req.met === false);
  t('B3: intake/prd/wp are all still met (the break is genuinely at artifact)', req.stages.intake.met && req.stages.prd.met && req.stages.wp.met);
  t('B4: gap_at is exactly "artifact" (first unmet stage in chain order)', req.gap_at === 'artifact');
  t('B5: verified is also unmet (never reached without a matching artifact link)', req.stages.verified.met === false);
  t('B6: coverage is exactly 0 (0 of 1 met)', r.coverage === 0);
  t('B7: gaps[] carries the ticket_id/prd_id/gap_at for exactly this one requirement', r.gaps.length === 1 && r.gaps[0].ticket_id === 'tk-prd-2-1' && r.gaps[0].gap_at === 'artifact');
}

// ---- Section C: projectTrace — a GAP at "intake" (no intake note logged at all in the run) ----
{
  const events = [
    { event_type: 'prd_generated', prd_id: 'prd-3', note: 'PRD' },
    { event_type: 'ticket_created', ticket_id: 'tk-prd-3-1', prd_id: 'prd-3' },
    { event_type: 'artifact_stored', artifact_id: 'art-3', ticket_id: 'tk-prd-3-1' },
    { event_type: 'check_passed', ticket_id: 'tk-prd-3-1', output_artifact: 'art-3' },
  ];
  const r = TR.projectTrace(events);
  t('C1: gap_at is exactly "intake" (the very first chain stage) even though every later stage is present', r.requirements[0].gap_at === 'intake');
  t('C2: every LATER stage (prd/wp/artifact/verified) is still honestly reported as met on its own', ['prd', 'wp', 'artifact', 'verified'].every((s) => r.requirements[0].stages[s].met === true));
}

// ---- Section D: projectTrace — a DISPROVEN event never counts as evidence for any stage ----
{
  const events = [
    { event_type: 'agent_note', note: 'forge-intake: 5 intake-vragen voor type rag (2 verplicht)' },
    { event_type: 'prd_generated', prd_id: 'prd-4', note: 'PRD' },
    { event_type: 'ticket_created', ticket_id: 'tk-prd-4-1', prd_id: 'prd-4' },
    { event_type: 'artifact_stored', artifact_id: 'art-4', ticket_id: 'tk-prd-4-1' },
    // a check_passed event log-event.cjs's own CONTENT ORACLE already disproved (e.g. a non-zero exit
    // code slipped through) — must NOT count as "verified", exactly like forge-orchestrate/forge-manifest.
    { event_type: 'check_passed', ticket_id: 'tk-prd-4-1', output_artifact: 'art-4', _forge_verify: { proof_verified: false } },
  ];
  const r = TR.projectTrace(events);
  t('D1: the disproven check_passed is ignored — verified stays unmet', r.requirements[0].stages.verified.met === false);
  t('D2: gap_at correctly lands on "verified" (everything before it is real)', r.requirements[0].gap_at === 'verified');
}

// ---- Section E: discoverRequirements — dedup keeps only the FIRST occurrence of a repeated ticket_id ----
{
  const events = [
    { event_type: 'ticket_created', ticket_id: 'tk-dup-1', prd_id: 'prd-x', title: 'first' },
    { event_type: 'ticket_created', ticket_id: 'tk-dup-1', prd_id: 'prd-x', title: 'SECOND (a real retry re-logging the same ticket)' },
    { event_type: 'ticket_created', ticket_id: '', prd_id: 'prd-x' }, // empty ticket_id — never a requirement
    { event_type: 'ticket_created' }, // missing ticket_id entirely — never a requirement
  ];
  const reqs = TR.discoverRequirements(events);
  t('E1: exactly 1 requirement discovered (the duplicate + the 2 invalid entries are all excluded/deduped)', reqs.length === 1);
  t('E2: the FIRST occurrence wins (title stays "first", not the later duplicate)', reqs[0].title === 'first');
}

// ---- Section F: an empty / no-requirements run is a valid, honest zero result, never an error ----
{
  const r = TR.projectTrace([{ event_type: 'run_started' }]);
  t('F1: total is 0', r.total === 0);
  t('F2: coverage is null (nothing to divide by, not 0 or 1)', r.coverage === null);
  t('F3: gaps[] is empty (nothing discovered means nothing is unmet either)', r.gaps.length === 0);
  t('F4: an honest note explains why', r.notes.some((n) => /no ticket_created events found/.test(n)));
}

// ---- Section F2: resolveRoot / isValidRunId / eventsPath / readEventsJsonl / findFirstIndex — direct
// unit coverage of every small pure helper, isolating boundary behavior a higher-level fixture can hide. ----
{
  // resolveRoot: explicit wins over env; env wins over the __dirname-relative default.
  t('F2a: resolveRoot(explicit) uses the explicit path regardless of env', TR.resolveRoot('/some/explicit/root') === path.resolve('/some/explicit/root'));
  const savedEnv = process.env.FORGE_PROJECT_ROOT;
  try {
    delete process.env.FORGE_PROJECT_ROOT;
    t('F2b: resolveRoot(null) with NO env var falls back to the __dirname-relative default (../..)', TR.resolveRoot(null) === path.resolve(__dirname, '..', '..'));
    process.env.FORGE_PROJECT_ROOT = '/env/root/value';
    t('F2c: resolveRoot(null) WITH env var set uses the env var (not the __dirname default)', TR.resolveRoot(null) === path.resolve('/env/root/value'));
  } finally {
    if (savedEnv === undefined) delete process.env.FORGE_PROJECT_ROOT; else process.env.FORGE_PROJECT_ROOT = savedEnv;
  }

  // isValidRunId: must reject non-string inputs even when RUN_ID_RE.test() would coerce-and-match.
  t('F2d: isValidRunId rejects a plain number even though RUN_ID_RE.test() would coerce it to a matching string', TR.isValidRunId(123) === false);
  t('F2e: isValidRunId rejects null/undefined', TR.isValidRunId(null) === false && TR.isValidRunId(undefined) === false);
  t('F2f: isValidRunId accepts a real safe run id', TR.isValidRunId('forge-2026-07-18-e3') === true);
  t('F2g: isValidRunId rejects a run id containing a space (fails RUN_ID_RE, does not escape any directory either)', TR.isValidRunId('bad id') === false);

  // eventsPath: called DIRECTLY (bypassing trace()'s own isValidRunId gate) to prove its OWN
  // belt-and-braces containment check really fires, not just that trace() rejects bad ids earlier.
  const escRoot = freshDir('tr-f2-escape');
  let escThrew = false;
  try { TR.eventsPath(escRoot, '..' + path.sep + '..' + path.sep + 'evil'); } catch { escThrew = true; }
  t('F2h: eventsPath() itself throws on a path-escaping run id, called directly (not via trace())', escThrew === true);
  t('F2i: eventsPath() does NOT throw for an ordinary safe run id', (() => { try { TR.eventsPath(escRoot, 'safe-run-1'); return true; } catch { return false; } })());

  // readEventsJsonl: a REAL byte-order-mark-prefixed file must still parse its first line correctly.
  const bomDir = freshDir('tr-f2-bom');
  const bomFile = path.join(bomDir, 'events.jsonl');
  fs.writeFileSync(bomFile, '﻿' + JSON.stringify({ event_type: 'run_started' }) + '\n' + JSON.stringify({ event_type: 'agent_note', note: 'ok' }) + '\n', 'utf8');
  const bomEvents = TR.readEventsJsonl(bomFile);
  t('F2j: readEventsJsonl strips a leading BOM so the FIRST line still parses (not silently dropped/corrupted)', bomEvents.length === 2 && bomEvents[0].event_type === 'run_started');

  // findFirstIndex: the predicate must NEVER be invoked out of bounds (i < events.length, not <=).
  t('F2k: findFirstIndex never calls its predicate out of bounds', TR.findFirstIndex([1, 2, 3], (e) => e === undefined) === -1);
  t('F2l: findFirstIndex finds a real in-bounds match', TR.findFirstIndex([1, 2, 3], (e) => e === 2) === 1);
}

// ---- Section F3: discoverRequirements — near-miss entries that fail exactly ONE guard clause must never
// be mistaken for a real requirement (kills every possible &&-weakened-to-|| variant of the type guard). ----
{
  const events = [
    null, // malformed/non-object entry — must be skipped, never crash
    { event_type: 'run_started' }, // right shape, wrong type, no ticket_id at all
    { event_type: 'something_else', ticket_id: 'tk-wrong-type', prd_id: 'prd-z' }, // WRONG type but a real-looking ticket_id/prd_id — must still be excluded
    { event_type: 'ticket_created', ticket_id: 'tk-disproven', prd_id: 'prd-z', _forge_verify: { proof_verified: false } }, // right type, but disproven
  ];
  const reqs = TR.discoverRequirements(events);
  t('F3a: none of the 4 near-miss/malformed entries becomes a requirement (0 discovered, no crash)', reqs.length === 0);
}

// ---- Section F4: discoverRequirements — prd_id/title field coercion must stay strict (string-only) ----
{
  const events = [
    { event_type: 'ticket_created', ticket_id: 'tk-numeric-prd', prd_id: 42 }, // non-string prd_id must NOT be coerced through
    { event_type: 'ticket_created', ticket_id: 'tk-title-fallback', title: '', note: 'real note text used as title' }, // empty title falls through to note
    { event_type: 'ticket_created', ticket_id: 'tk-title-only', title: 'Real Title' }, // no note at all — title alone must still be kept, not dropped to null
  ];
  const reqs = TR.discoverRequirements(events);
  const numericPrd = reqs.find((r) => r.ticket_id === 'tk-numeric-prd');
  const titleFallback = reqs.find((r) => r.ticket_id === 'tk-title-fallback');
  const titleOnly = reqs.find((r) => r.ticket_id === 'tk-title-only');
  t('F4a: a non-string prd_id (e.g. a number) is never coerced through — stays null', numericPrd.prd_id === null);
  t('F4b: an empty-string title correctly falls through to the note text', titleFallback.title === 'real note text used as title');
  t('F4c: a real title with no note is kept as-is, not dropped to null', titleOnly.title === 'Real Title');
}

// ---- Section F5: projectRequirement — prd stage must not false-positive on a same-run, wrong-type/
// wrong-prd_id "look-alike" event, and must correctly stay a GAP when a referenced prd_id was truly
// never generated (an orphan ticket) rather than silently reporting it as met. ----
{
  const lookalikeEvents = [
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'artifact_stored', artifact_id: 'a1', prd_id: 'prd-real' }, // WRONG type, but prd_id matches — must not satisfy "prd"
    { event_type: 'prd_generated', prd_id: 'prd-real', note: 'the real one' },
    { event_type: 'ticket_created', ticket_id: 'tk-lookalike', prd_id: 'prd-real' },
  ];
  const r1 = TR.projectTrace(lookalikeEvents);
  t('F5a: the prd stage matches the REAL prd_generated event (index 2), not the earlier wrong-type look-alike (index 1)', r1.requirements[0].stages.prd.evIdx === 2);

  const orphanEvents = [
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-orphan', prd_id: 'prd-never-generated' }, // references a prd_id, but NO prd_generated event exists anywhere in the run
    { event_type: 'artifact_stored', artifact_id: 'a2', ticket_id: 'tk-orphan' },
    { event_type: 'check_passed', ticket_id: 'tk-orphan' },
  ];
  const r2 = TR.projectTrace(orphanEvents);
  t('F5b: an orphan ticket (references a prd_id that was never actually generated) is honestly reported as a gap at "prd"', r2.requirements[0].stages.prd.met === false && r2.requirements[0].gap_at === 'prd');

  // a ticket_created event with NO prd_id AT ALL (never even referenced a PRD) — the prdIdx short-circuit
  // (`req.prd_id ? find... : -1`) must still correctly report met:false AND evIdx:null (not accidentally
  // evIdx:0, which is a DIFFERENT, real "found at index 0" outcome — the two must never be confused).
  const noPrdIdEvents = [
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-no-prd' }, // no prd_id field whatsoever
    { event_type: 'artifact_stored', artifact_id: 'a-no-prd', ticket_id: 'tk-no-prd' },
    { event_type: 'check_passed', ticket_id: 'tk-no-prd' },
  ];
  const r3 = TR.projectTrace(noPrdIdEvents);
  t('F5c: a ticket with no prd_id at all reports prd stage met:false with evIdx:null (never 0)', r3.requirements[0].stages.prd.met === false && r3.requirements[0].stages.prd.evIdx === null);
  t('F5d: gap_at correctly lands on "prd" for a ticket with no prd_id reference', r3.requirements[0].gap_at === 'prd');
}

// ---- Section F6: projectRequirement — every stage's index-boundary (index 0) is a real, distinct
// outcome from "not found" (index -1) — proves the two are never confused. ----
{
  const prdFirstEvents = [
    { event_type: 'prd_generated', prd_id: 'prd-first', note: 'first event in the whole run' },
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-prd-first', prd_id: 'prd-first' },
  ];
  const rPrdFirst = TR.projectTrace(prdFirstEvents);
  t('F6a: a prd_generated event literally AT index 0 is correctly matched (met:true, evIdx:0)', rPrdFirst.requirements[0].stages.prd.met === true && rPrdFirst.requirements[0].stages.prd.evIdx === 0);

  const artifactFirstEvents = [
    { event_type: 'artifact_stored', artifact_id: 'a0', ticket_id: 'tk-art-first' },
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-art-first' },
  ];
  const rArtifactFirst = TR.projectTrace(artifactFirstEvents);
  t('F6b: an artifact_stored event literally AT index 0 is correctly matched (met:true, evIdx:0)', rArtifactFirst.requirements[0].stages.artifact.met === true && rArtifactFirst.requirements[0].stages.artifact.evIdx === 0);

  const verifiedFirstEvents = [
    { event_type: 'check_passed', ticket_id: 'tk-verified-first' },
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-verified-first' },
  ];
  const rVerifiedFirst = TR.projectTrace(verifiedFirstEvents);
  t('F6c: a check_passed event literally AT index 0 is correctly matched (met:true, evIdx:0)', rVerifiedFirst.requirements[0].stages.verified.met === true && rVerifiedFirst.requirements[0].stages.verified.evIdx === 0);

  const intakeFirstEvents = [
    { event_type: 'agent_note', note: 'forge-intake: ok, literally first' },
    { event_type: 'ticket_created', ticket_id: 'tk-intake-first' },
  ];
  const rIntakeFirst = TR.projectTrace(intakeFirstEvents);
  t('F6d: an intake note literally AT index 0 is correctly matched (met:true, evIdx:0)', rIntakeFirst.requirements[0].stages.intake.met === true && rIntakeFirst.requirements[0].stages.intake.evIdx === 0);
}

// ---- Section F7: projectRequirement — artifact stage: malformed/disproven entries and strict string
// typing (mirrors F3/F4's discoverRequirements coverage, one level up the chain). ----
{
  const noRealArtifact = [
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-no-artifact' },
    null, // malformed entry mixed in — must never crash, and must never be mistaken for an artifact
    { event_type: 'run_started' }, // real object, no artifact fields at all
  ];
  const r1 = TR.projectTrace(noRealArtifact);
  t('F7a: with no real artifact evidence anywhere (only malformed/unrelated entries), artifact stage stays unmet', r1.requirements[0].stages.artifact.met === false);

  const disprovenArtifact = [
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-disproven-artifact' },
    { event_type: 'artifact_stored', artifact_id: 'a-disproven', ticket_id: 'tk-disproven-artifact', _forge_verify: { proof_verified: false } },
  ];
  const r2 = TR.projectTrace(disprovenArtifact);
  t('F7b: a DISPROVEN artifact_stored event never satisfies the artifact stage', r2.requirements[0].stages.artifact.met === false);

  const strictTyping = [
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-strict-type' },
    { event_type: 'artifact_stored', artifact_id: 42, ticket_id: 'tk-strict-type' }, // non-string artifact_id
    { event_type: 'artifact_stored', output_artifact: '   ', ticket_id: 'tk-strict-type' }, // whitespace-only output_artifact
  ];
  const r3 = TR.projectTrace(strictTyping);
  t('F7c: a non-string artifact_id and a whitespace-only output_artifact are BOTH rejected as real artifact evidence', r3.requirements[0].stages.artifact.met === false);
}

// ---- Section F8: projectRequirement — verified stage: cross-requirement isolation + the prd_id
// fallback path (previously completely untested — every earlier fixture only exercised ticket_id
// matching for "verified"). ----
{
  const crossReq = [
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-a', prd_id: 'prd-shared' },
    { event_type: 'ticket_created', ticket_id: 'tk-b', prd_id: 'prd-other' },
    { event_type: 'artifact_stored', artifact_id: 'a-a', ticket_id: 'tk-a' },
    { event_type: 'artifact_stored', artifact_id: 'a-b', ticket_id: 'tk-b' },
    // this check_passed belongs ONLY to tk-a (matching ticket_id) — tk-b must NOT be considered verified.
    { event_type: 'check_passed', ticket_id: 'tk-a' },
  ];
  const rCross = TR.projectTrace(crossReq);
  const reqA = rCross.requirements.find((r) => r.ticket_id === 'tk-a');
  const reqB = rCross.requirements.find((r) => r.ticket_id === 'tk-b');
  t('F8a: the verified event only satisfies the requirement it actually belongs to (tk-a)', reqA.stages.verified.met === true);
  t('F8b: an unrelated requirement in the SAME run (tk-b) is correctly NOT verified by another requirement\'s event', reqB.stages.verified.met === false);

  const prdFallback = [
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-c', prd_id: 'prd-fallback' },
    { event_type: 'artifact_stored', artifact_id: 'a-c', ticket_id: 'tk-c' },
    // no ticket_id on this one — links ONLY via prd_id (the documented fallback path).
    { event_type: 'check_passed', prd_id: 'prd-fallback' },
  ];
  const rFallback = TR.projectTrace(prdFallback);
  t('F8c: verified stage is satisfied via the prd_id fallback when no ticket_id was threaded through', rFallback.requirements[0].stages.verified.met === true);

  const prdMismatch = [
    { event_type: 'agent_note', note: 'forge-intake: ok' },
    { event_type: 'ticket_created', ticket_id: 'tk-d', prd_id: 'prd-d' },
    { event_type: 'artifact_stored', artifact_id: 'a-d', ticket_id: 'tk-d' },
    // right event type, but NEITHER ticket_id nor prd_id actually matches this requirement.
    { event_type: 'check_passed', ticket_id: 'tk-unrelated', prd_id: 'prd-unrelated' },
  ];
  const rMismatch = TR.projectTrace(prdMismatch);
  t('F8d: a verified-type event with a genuinely non-matching ticket_id AND prd_id never satisfies verified', rMismatch.requirements[0].stages.verified.met === false);
}

// ---- Section F9: projectTrace — intake stage: a battery of near-misses, each failing exactly one
// guard clause, proves no single relaxed clause could ever accidentally count as intake evidence. ----
{
  const events = [
    { event_type: 'other_type', note: 'this text mentions intake but the event_type is wrong' }, // wrong type
    { event_type: 'agent_note', note: ['intake-related'] }, // non-string note whose coercion happens to mention "intake"
    { event_type: 'agent_note', note: 'a totally unrelated note with no keyword match' }, // right type+string, wrong content
    { event_type: 'agent_note', note: 'forge-intake: disproven claim', _forge_verify: { proof_verified: false } }, // everything right EXCEPT disproven
    { event_type: 'ticket_created', ticket_id: 'tk-intake-battery' },
  ];
  const r = TR.projectTrace(events);
  t('F9: none of the 4 near-miss intake entries (each failing exactly one guard clause) counts as real intake evidence', r.requirements[0].stages.intake.met === false);
}

// ---- Section G: trace() end-to-end — reads a REAL fixture events.jsonl from an isolated project root ----
let projRoot;
{
  projRoot = freshDir('tr-g-project');
  writeEvents(projRoot, 'run-full', [
    { event_type: 'agent_note', note: 'forge-intake: 3 intake-vragen voor type website (1 verplicht)' },
    { event_type: 'prd_generated', prd_id: 'prd-g', note: 'PRD' },
    { event_type: 'ticket_created', ticket_id: 'tk-prd-g-1', prd_id: 'prd-g' },
    { event_type: 'artifact_stored', artifact_id: 'art-g', ticket_id: 'tk-prd-g-1' },
    { event_type: 'check_passed', ticket_id: 'tk-prd-g-1', output_artifact: 'art-g' },
  ]);
  writeEvents(projRoot, 'run-gap', [
    { event_type: 'agent_note', note: 'forge-intake: 3 intake-vragen voor type website (1 verplicht)' },
    { event_type: 'prd_generated', prd_id: 'prd-h', note: 'PRD' },
    { event_type: 'ticket_created', ticket_id: 'tk-prd-h-1', prd_id: 'prd-h' },
  ]);

  const rFull = TR.trace({ run_id: 'run-full' }, { root: projRoot });
  t('G1: trace() on a fully-traced run reports ok:true with 0 gaps', rFull.ok === true && rFull.gaps.length === 0);
  t('G2: trace() run_id echoes the input run_id', rFull.run_id === 'run-full');

  const rGap = TR.trace({ run_id: 'run-gap' }, { root: projRoot });
  t('G3: trace() on an incomplete run reports exactly 1 gap at "artifact"', rGap.gaps.length === 1 && rGap.gaps[0].gap_at === 'artifact');

  const rMissing = TR.trace({ run_id: 'run-never-started' }, { root: projRoot });
  t('G4: trace() on a run whose events.jsonl does not exist yet returns an honest empty result (never throws)', rMissing.total === 0 && rMissing.gaps.length === 0);

  let threw = false;
  try { TR.trace({ run_id: '../escape' }, { root: projRoot }); } catch { threw = true; }
  t('G5: trace() throws on an invalid run_id (path-escape shape) — fail closed, same as forge-manifest.cjs', threw === true);

  // an invalid run_id that does NOT escape the forge-runs directory (empty string / a space) must STILL
  // be rejected by isValidRunId's own guard — proves that guard is load-bearing on its own, not merely
  // "rescued" by eventsPath's separate containment check (which only fires on a genuine path escape).
  let threwEmpty = false;
  try { TR.trace({ run_id: '' }, { root: projRoot }); } catch { threwEmpty = true; }
  t('G6: trace() throws on an EMPTY run_id (fails RUN_ID_RE, but never escapes any directory)', threwEmpty === true);

  let threwSpace = false;
  try { TR.trace({ run_id: 'bad id' }, { root: projRoot }); } catch { threwSpace = true; }
  t('G7: trace() throws on a run_id containing a space (same non-escaping-but-still-invalid shape)', threwSpace === true);
}

// ---- Section H: real CLI (trace --run, --json) invoked as a subprocess ----
{
  const cliPath = path.join(__dirname, 'forge-trace.cjs');
  const envFull = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: projRoot });
  const rFull = spawnSync(process.execPath, [cliPath, 'trace', '--run', 'run-full', '--json'], { encoding: 'utf8', env: envFull });
  let jFull = null; try { jFull = JSON.parse(rFull.stdout); } catch { /* asserted below */ }
  t('H1: CLI exits 0 on a fully-traced run', rFull.status === 0);
  t('H2: CLI --json reports the same fully-met result', jFull !== null && jFull.gaps.length === 0 && jFull.total === 1);

  const rGap = spawnSync(process.execPath, [cliPath, 'trace', '--run', 'run-gap', '--json'], { encoding: 'utf8', env: envFull });
  t('H3: CLI exits 3 when a gap exists (mirrors forge-orchestrate\'s audit / forge-manifest\'s resumable convention)', rGap.status === 3);

  const rUsage = spawnSync(process.execPath, [cliPath, 'trace'], { encoding: 'utf8', env: envFull });
  t('H4: CLI exits 2 when --run is missing (usage error)', rUsage.status === 2);
  t('H4b: the missing --run case prints the real USAGE text (not a generic caught-exception message — proves the early guard actually fired, not a downstream throw)', /Usage: node forge-trace\.cjs/.test(rUsage.stderr));

  const rUnknownCmd = spawnSync(process.execPath, [cliPath, 'bogus'], { encoding: 'utf8', env: envFull });
  t('H5: CLI exits 2 on an unknown subcommand', rUnknownCmd.status === 2);

  // an unknown subcommand that STILL carries --run must be rejected the same way — proves the
  // `opts.cmd === 'trace'` gate is a real, load-bearing check, not something a truthy --run can bypass.
  const rUnknownCmdWithRun = spawnSync(process.execPath, [cliPath, 'bogus', '--run', 'run-full'], { encoding: 'utf8', env: envFull });
  t('H5b: an unknown subcommand exits 2 EVEN WHEN --run is present (never silently falls into trace-handling)', rUnknownCmdWithRun.status === 2);

  // non-JSON (human-readable) output path — proves --json actually toggles behavior end to end.
  const rHuman = spawnSync(process.execPath, [cliPath, 'trace', '--run', 'run-full'], { encoding: 'utf8', env: envFull });
  let parsedAsJson = true; try { JSON.parse(rHuman.stdout); } catch { parsedAsJson = false; }
  t('H6: CLI without --json exits 0 on the same fully-traced run', rHuman.status === 0);
  t('H7: CLI without --json prints HUMAN text (not JSON) and names the exact coverage percentage format', parsedAsJson === false && /forge-trace ·/.test(rHuman.stdout) && /100\.0% coverage/.test(rHuman.stdout));

  // an extra, unrecognized trailing token (not literally "--json") must NEVER be silently treated as if
  // it were --json — proves the else-if('--json') branch really checks the token text, not "any token".
  const rTrailingGarbage = spawnSync(process.execPath, [cliPath, 'trace', '--run', 'run-full', 'unexpected-trailing-token'], { encoding: 'utf8', env: envFull });
  let trailingParsedAsJson = true; try { JSON.parse(rTrailingGarbage.stdout); } catch { trailingParsedAsJson = false; }
  t('H8: an unrecognized trailing token never flips output to JSON mode', trailingParsedAsJson === false && /forge-trace ·/.test(rTrailingGarbage.stdout));

  // a run_id that PASSES the `!opts.run` truthiness check but FAILS isValidRunId inside trace() itself
  // must be caught by the OUTER catch block with exit code EXACTLY 2 (not accidentally 3, which is the
  // distinct "a real gap was found" signal — the two must never be confused).
  const rInvalidRunIdInCli = spawnSync(process.execPath, [cliPath, 'trace', '--run', 'bad run id with spaces'], { encoding: 'utf8', env: envFull });
  t('H9: CLI exits EXACTLY 2 (never 3) when trace() itself throws on a truthy-but-invalid run_id', rInvalidRunIdInCli.status === 2);
  t('H9b: the outer catch prints the real thrown error text, prefixed honestly', /forge-trace: forge-trace: trace requires a valid run_id/.test(rInvalidRunIdInCli.stderr));

  // requiring forge-trace.cjs as a PLAIN module (require.main !== module) must NEVER trigger its CLI
  // main() block — no usage text on stderr, no unexpected side effect merely from being require()'d.
  const requireOnly = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(cliPath) + '); console.log("LOADED_OK");'], { encoding: 'utf8' });
  t('H10: requiring forge-trace.cjs as a plain module never triggers CLI usage output or a stray exit code', requireOnly.status === 0 && requireOnly.stdout.includes('LOADED_OK') && !/Usage: node forge-trace\.cjs/.test(requireOnly.stderr));
}

// ---- Section I: EVERY temp dir this test file created is under os.tmpdir() ----
{
  const tmpRoot = path.resolve(os.tmpdir());
  t('I1: every one of the ' + ALL_TMP_ROOTS.length + ' fixture roots created this run is under os.tmpdir()',
    ALL_TMP_ROOTS.length > 0 && ALL_TMP_ROOTS.every((d) => path.resolve(d).startsWith(tmpRoot)));
  t('I2: forge-trace.cjs itself was never touched by this test file', fs.existsSync(path.join(__dirname, 'forge-trace.cjs')));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
