#!/usr/bin/env node
'use strict';
// forge-configdrift.test.cjs — real tests for the run-scoped governance-config baseline + drift check
// (2026-08-01). Every fixture builds its own throwaway project under os.tmpdir(); this file NEVER reads or
// writes the owner's real project outside its own tmp dirs, except for two explicitly read-only
// measurements against the real repo at the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cd = require('./forge-configdrift.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-configdrift tests (governance-config baseline + drift)');

/** buildProject — a synthetic project carrying exactly the governance surface this module claims to guard:
 *  the agent registry, the agent tool policy, the two orchestration policy files, the project CLAUDE.md and
 *  two project skills. Returns {root, runId, runDir} with the run dir already created so a baseline can be
 *  written next to the run exactly as it is in the real layout. */
function buildProject(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const root = path.join(base, 'project');
  const c = path.join(root, '.claude');
  fs.mkdirSync(path.join(c, 'config', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(c, 'config', 'orchestration'), { recursive: true });
  fs.mkdirSync(path.join(c, 'skills', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(c, 'skills', 'beta'), { recursive: true });
  const runId = 'run-drift-1';
  const runDir = path.join(c, 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(c, 'config', 'agents', 'agent-registry.json'),
    JSON.stringify({ agents: [{ name: 'Search Boss', model: 'claude-opus-5' }] }, null, 2) + '\n');
  fs.writeFileSync(path.join(c, 'config', 'agents', 'agent-tool-policy.json'),
    JSON.stringify({ 'Search Boss': { allow: ['Read', 'Grep'] } }, null, 2) + '\n');
  fs.writeFileSync(path.join(c, 'config', 'orchestration', 'FORGE_HARD_RULES.json'),
    JSON.stringify({ rules: [{ id: 'no-deploy', text: 'never deploy without the owner' }] }, null, 2) + '\n');
  fs.writeFileSync(path.join(c, 'config', 'orchestration', 'FORGE_RECOVERY_POLICY.json'),
    JSON.stringify({ min_alternatives: 3 }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# project rules\nonly this folder.\n');
  fs.writeFileSync(path.join(c, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: does alpha things\n---\n\n# alpha\n\nbody text that is not governance.\n');
  fs.writeFileSync(path.join(c, 'skills', 'beta', 'SKILL.md'),
    '---\nname: beta\ndescription: does beta things\n---\n\n# beta\n');
  return { base, root, runId, runDir };
}
function writeEvents(fx, events) {
  fs.writeFileSync(path.join(fx.runDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}
function findingKinds(rep) { return rep.findings.map((f) => f.kind).sort(); }
function byId(list, id) { return list.find((x) => x.id === id); }

// --- the surface it claims to guard -------------------------------------------------------------------
t('snapshot() covers every governance source the design names, each with a hash', () => {
  const fx = buildProject('cd-surface');
  const snap = cd.snapshot(fx.root);
  const ids = snap.entries.map((e) => e.id);
  for (const want of ['agent_registry', 'agent_tool_policy', 'hard_rules', 'recovery_policy', 'project_claude_md']) {
    assert.ok(ids.includes(want), 'missing governance source ' + want + ' — got ' + JSON.stringify(ids));
  }
  assert.ok(ids.includes('skill_frontmatter:alpha'), 'skill frontmatter is not a source — got ' + JSON.stringify(ids));
  assert.ok(ids.includes('skill_frontmatter:beta'), 'skill frontmatter is not a source — got ' + JSON.stringify(ids));
  for (const e of snap.entries) {
    assert.ok(e.exists, e.id + ' should exist in the fixture');
    assert.ok(/^[0-9a-f]{64}$/.test(e.sha256), e.id + ' has no sha256: ' + e.sha256);
  }
});

t('a NESTED bundle skill is a governance source too — the walk is not depth-1', () => {
  const fx = buildProject('cd-nested');
  fs.mkdirSync(path.join(fx.root, '.claude', 'skills', 'bundle', 'nested-one'), { recursive: true });
  fs.writeFileSync(path.join(fx.root, '.claude', 'skills', 'bundle', 'nested-one', 'SKILL.md'),
    '---\nname: nested-one\ndescription: lives one level deeper\n---\n');
  const ids = cd.snapshot(fx.root).entries.map((e) => e.id);
  assert.ok(ids.includes('skill_frontmatter:bundle/nested-one'),
    'a nested skill is not covered — got ' + JSON.stringify(ids.filter((i) => i.startsWith('skill_frontmatter'))));
});

t('a SKILL.md hash covers ONLY the frontmatter — a body edit is not a governance change', () => {
  const fx = buildProject('cd-frontmatter');
  const before = byId(cd.snapshot(fx.root).entries, 'skill_frontmatter:alpha');
  const p = path.join(fx.root, '.claude', 'skills', 'alpha', 'SKILL.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\n\nan extra paragraph of prose in the body.\n');
  const afterBody = byId(cd.snapshot(fx.root).entries, 'skill_frontmatter:alpha');
  assert.strictEqual(afterBody.sha256, before.sha256, 'a body-only edit changed the frontmatter hash');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('does alpha things', 'does alpha things AND may write files'));
  const afterFm = byId(cd.snapshot(fx.root).entries, 'skill_frontmatter:alpha');
  assert.notStrictEqual(afterFm.sha256, before.sha256, 'a frontmatter edit did NOT change the hash');
});

// --- direction 1: a change nobody announced ------------------------------------------------------------
t('direction 1 — an UNANNOUNCED governance change is a finding', () => {
  const fx = buildProject('cd-unannounced');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, [{ event_type: 'run_started', agent: 'orchestrator' }]);
  // an agent quietly widens its own tool grant mid-run
  fs.writeFileSync(path.join(fx.root, '.claude', 'config', 'agents', 'agent-tool-policy.json'),
    JSON.stringify({ 'Search Boss': { allow: ['Read', 'Grep', 'Bash', 'Write'] } }, null, 2) + '\n');
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.strictEqual(rep.ok, false, 'an unannounced change must not read as ok');
  assert.ok(findingKinds(rep).includes('unannounced_change'), JSON.stringify(findingKinds(rep)));
  const f = rep.findings.find((x) => x.kind === 'unannounced_change');
  assert.strictEqual(f.id, 'agent_tool_policy', 'the finding does not name the changed source: ' + f.id);
  assert.ok(/agent_tool_policy|agent-tool-policy/.test(f.detail), 'the detail does not name the file: ' + f.detail);
});

t('an ANNOUNCED real change is clean and is reported as an announced change', () => {
  const fx = buildProject('cd-announced');
  cd.writeBaseline(fx.root, fx.runId);
  const policyPath = path.join(fx.root, '.claude', 'config', 'agents', 'agent-tool-policy.json');
  writeEvents(fx, [
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'file_changed', agent: 'Config Boss', path: policyPath, note: 'granted Bash to Search Boss' },
  ]);
  fs.writeFileSync(policyPath, JSON.stringify({ 'Search Boss': { allow: ['Read', 'Grep', 'Bash'] } }, null, 2) + '\n');
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.strictEqual(rep.ok, true, 'an announced, real change must be clean: ' + JSON.stringify(rep.findings));
  assert.ok(rep.announced_changes.some((a) => a.id === 'agent_tool_policy'),
    'the announced change is not reported: ' + JSON.stringify(rep.announced_changes));
});

t('a relative path on the announcing event still matches the source it names', () => {
  const fx = buildProject('cd-relpath');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, [{ event_type: 'claude_md_updated', agent: 'orchestrator', path: 'CLAUDE.md', note: 'tightened isolation' }]);
  fs.writeFileSync(path.join(fx.root, 'CLAUDE.md'), '# project rules\nonly this folder. no exceptions.\n');
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.strictEqual(rep.ok, true, 'a relative announcement path did not match: ' + JSON.stringify(rep.findings));
});

// --- direction 2: a claim that changed nothing ----------------------------------------------------------
t('direction 2 — a CLAIMED change where before == after is a rejected NO-OP', () => {
  const fx = buildProject('cd-noop');
  cd.writeBaseline(fx.root, fx.runId);
  // the agent says it rewrote the hard rules; the bytes are identical
  writeEvents(fx, [
    { event_type: 'file_changed', agent: 'Rules Boss', path: path.join(fx.root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), note: 'added the no-force-push rule' },
  ]);
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.strictEqual(rep.ok, false, 'a no-op claim must not read as ok');
  const f = rep.findings.find((x) => x.kind === 'noop_claim');
  assert.ok(f, 'no noop_claim finding: ' + JSON.stringify(findingKinds(rep)));
  assert.strictEqual(f.id, 'hard_rules', 'the no-op finding names the wrong source: ' + f.id);
  assert.ok(/no-op|noop/i.test(f.detail) && /reject/i.test(f.detail),
    'the detail must say the claim is rejected as a no-op: ' + f.detail);
  assert.ok(f.claimed_by === 'Rules Boss', 'the finding does not attribute the claim: ' + f.claimed_by);
});

t('a claimed skill-frontmatter change that only touched the body is also a NO-OP', () => {
  const fx = buildProject('cd-noop-skill');
  cd.writeBaseline(fx.root, fx.runId);
  const p = path.join(fx.root, '.claude', 'skills', 'beta', 'SKILL.md');
  writeEvents(fx, [{ event_type: 'custom_skill_updated', agent: 'Skill Boss', path: p, note: 'widened the beta trigger' }]);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\nmore body prose.\n');
  const rep = cd.checkDrift(fx.root, fx.runId);
  const f = rep.findings.find((x) => x.kind === 'noop_claim' && x.id === 'skill_frontmatter:beta');
  assert.ok(f, 'a body-only edit claimed as a trigger change is not caught: ' + JSON.stringify(rep.findings));
});

// --- honest non-findings ---------------------------------------------------------------------------------
t('reformatting a JSON policy without changing its meaning is a NOTE, not a drift finding', () => {
  const fx = buildProject('cd-format');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, [{ event_type: 'run_started', agent: 'orchestrator' }]);
  const p = path.join(fx.root, '.claude', 'config', 'orchestration', 'FORGE_RECOVERY_POLICY.json');
  fs.writeFileSync(p, JSON.stringify({ min_alternatives: 3 }) + '\n'); // same meaning, different whitespace
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.strictEqual(rep.ok, true, 'pure reformatting must not be reported as drift: ' + JSON.stringify(rep.findings));
  assert.ok(rep.notes.some((n) => n.kind === 'formatting_only' && n.id === 'recovery_policy'),
    'a reformat is not even noted: ' + JSON.stringify(rep.notes));
});

t('no baseline is an honest "not comparable", never a false red', () => {
  const fx = buildProject('cd-nobaseline');
  writeEvents(fx, [{ event_type: 'run_started' }]);
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.strictEqual(rep.ok, true, 'a missing baseline must not be a finding');
  assert.strictEqual(rep.comparable, false, 'it must say it could not compare');
  assert.ok(/baseline/i.test(rep.reason), 'the reason does not mention the missing baseline: ' + rep.reason);
  assert.strictEqual(rep.findings.length, 0);
});

t('a run with no events.jsonl still compares hashes and still says nothing was announced', () => {
  const fx = buildProject('cd-noevents');
  cd.writeBaseline(fx.root, fx.runId);
  fs.writeFileSync(path.join(fx.root, 'CLAUDE.md'), '# project rules\nrewritten.\n');
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.strictEqual(rep.ok, false);
  assert.ok(rep.findings.some((f) => f.kind === 'unannounced_change' && f.id === 'project_claude_md'),
    JSON.stringify(rep.findings));
});

t('a governance file that disappears mid-run is its own finding, not a silent pass', () => {
  const fx = buildProject('cd-removed');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, [{ event_type: 'run_started' }]);
  fs.unlinkSync(path.join(fx.root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.ok(rep.findings.some((f) => f.kind === 'source_removed' && f.id === 'hard_rules'), JSON.stringify(rep.findings));
});

t('a NEW skill appearing mid-run without an announcement is a finding', () => {
  const fx = buildProject('cd-added');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, [{ event_type: 'run_started' }]);
  fs.mkdirSync(path.join(fx.root, '.claude', 'skills', 'gamma'), { recursive: true });
  fs.writeFileSync(path.join(fx.root, '.claude', 'skills', 'gamma', 'SKILL.md'),
    '---\nname: gamma\ndescription: appeared out of nowhere\n---\n');
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.ok(rep.findings.some((f) => f.kind === 'source_added' && f.id === 'skill_frontmatter:gamma'), JSON.stringify(rep.findings));
});

t('nothing changed and nothing claimed = clean, with the unchanged count reported', () => {
  const fx = buildProject('cd-clean');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, [{ event_type: 'run_started' }, { event_type: 'agent_completed', agent: 'Search Boss' }]);
  const rep = cd.checkDrift(fx.root, fx.runId);
  assert.strictEqual(rep.ok, true, JSON.stringify(rep.findings));
  assert.strictEqual(rep.comparable, true);
  assert.ok(rep.unchanged >= 7, 'unchanged count looks wrong: ' + rep.unchanged);
});

// --- the baseline file itself -----------------------------------------------------------------------------
t('writeBaseline writes config-baseline.json NEXT TO THE RUN and nowhere else', () => {
  const fx = buildProject('cd-baselinefile');
  const res = cd.writeBaseline(fx.root, fx.runId);
  assert.strictEqual(path.resolve(res.path), path.resolve(path.join(fx.runDir, 'config-baseline.json')),
    'baseline landed at ' + res.path);
  const raw = JSON.parse(fs.readFileSync(res.path, 'utf8'));
  assert.strictEqual(raw.run_id, fx.runId);
  assert.ok(Array.isArray(raw.entries) && raw.entries.length >= 7, 'baseline entries: ' + (raw.entries || []).length);
});

t('a run_id that tries to escape the runs directory is refused', () => {
  const fx = buildProject('cd-escape');
  assert.throws(() => cd.writeBaseline(fx.root, '../../etc'), /invalid run_id/i);
  assert.throws(() => cd.checkDrift(fx.root, 'a/b'), /invalid run_id/i);
});

t('checkDrift is READ-ONLY on the governance files it measures', () => {
  const fx = buildProject('cd-readonly');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, [{ event_type: 'run_started' }]);
  const p = path.join(fx.root, '.claude', 'config', 'agents', 'agent-registry.json');
  const before = { bytes: fs.readFileSync(p), mtime: fs.statSync(p).mtimeMs };
  cd.checkDrift(fx.root, fx.runId);
  assert.ok(before.bytes.equals(fs.readFileSync(p)), 'checkDrift modified a governance file');
  assert.strictEqual(fs.statSync(p).mtimeMs, before.mtime, 'checkDrift touched a governance file mtime');
});

// --- the forge-verify wiring: SURFACED, never gating ---------------------------------------------------------
// forge-verify.cjs is where this check is shown, because it already reads the same run dir and events.jsonl and
// already has an advisory-section convention (Evidence:, Loop:). These two tests pin BOTH halves of that
// contract: the section is really printed, and a drift finding really does not move the exit code.
const { spawnSync } = require('child_process');
function runVerify(fx, extra) {
  const env = Object.assign({}, process.env, { FORGE_STORE_ROOT: path.join(fx.root, '.claude') });
  return spawnSync(process.execPath,
    [path.join(__dirname, 'forge-verify.cjs'), fx.runId, '--root', fx.root].concat(extra || []),
    { env, encoding: 'utf8' });
}
/** a run that verify itself calls completely clean: one agent, one done task, no tickets, no PRD. */
function cleanRunEvents() {
  return [
    { event_type: 'run_started', agent: 'orchestrator', ts: new Date().toISOString() },
    { event_type: 'agent_started', agent: 'Search Boss', ts: new Date().toISOString() },
    { event_type: 'check_passed', agent: 'Search Boss', command: 'node t.cjs', output: 'ok', ts: new Date().toISOString() },
    { event_type: 'agent_completed', agent: 'Search Boss', ts: new Date().toISOString() },
  ];
}

t('forge-verify prints a Config Drift section and names the undeclared change', () => {
  const fx = buildProject('cd-verify-wire');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, cleanRunEvents());
  fs.writeFileSync(path.join(fx.root, '.claude', 'config', 'agents', 'agent-tool-policy.json'),
    JSON.stringify({ 'Search Boss': { allow: ['Read', 'Grep', 'Bash'] } }, null, 2) + '\n');
  const r = runVerify(fx);
  assert.ok(/Config Drift \(advisory, non-blocking\):/.test(r.stdout), 'no Config Drift section in verify output:\n' + r.stdout + r.stderr);
  assert.ok(/UNANNOUNCED_CHANGE agent_tool_policy/.test(r.stdout),
    'the undeclared change is not named:\n' + r.stdout);
});

t('a config-drift finding is ADVISORY — it does not change forge-verify\'s exit code', () => {
  const fx = buildProject('cd-verify-advisory');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, cleanRunEvents());
  const clean = runVerify(fx);
  assert.strictEqual(clean.status, 0, 'the fixture run must be clean before the drift is introduced:\n' + clean.stdout);
  fs.writeFileSync(path.join(fx.root, 'CLAUDE.md'), '# project rules\nquietly rewritten mid-run.\n');
  const drifted = runVerify(fx);
  assert.ok(/UNANNOUNCED_CHANGE project_claude_md/.test(drifted.stdout), 'drift not detected:\n' + drifted.stdout);
  assert.strictEqual(drifted.status, 0,
    'an advisory drift finding must NOT gate the run — exit was ' + drifted.status + ':\n' + drifted.stdout);
});

t('forge-verify --json carries the config-drift report', () => {
  const fx = buildProject('cd-verify-json');
  cd.writeBaseline(fx.root, fx.runId);
  writeEvents(fx, cleanRunEvents().concat([
    { event_type: 'file_changed', agent: 'Rules Boss', path: path.join(fx.root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), note: 'added a rule' },
  ]));
  const r = runVerify(fx, ['--json']);
  const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.ok(j.config_drift, 'no config_drift key in --json output: ' + Object.keys(j).join(', '));
  assert.strictEqual(j.config_drift.comparable, true);
  assert.ok(j.config_drift.findings.some((f) => f.kind === 'noop_claim' && f.id === 'hard_rules'),
    'the no-op claim is missing from --json: ' + JSON.stringify(j.config_drift.findings));
});

t('a run with no config baseline says so in verify instead of reading as clean', () => {
  const fx = buildProject('cd-verify-nobaseline');
  writeEvents(fx, cleanRunEvents());
  const r = runVerify(fx);
  assert.ok(/Config Drift \(advisory, non-blocking\):/.test(r.stdout), r.stdout);
  assert.ok(/not comparable/i.test(r.stdout), 'a missing baseline must be stated, not hidden:\n' + r.stdout);
  assert.strictEqual(r.status, 0);
});

// --- the real project (read-only) --------------------------------------------------------------------------
t('on the REAL project every named governance source is found and hashed', () => {
  const root = path.resolve(__dirname, '..', '..');
  const snap = cd.snapshot(root);
  for (const id of ['agent_registry', 'agent_tool_policy', 'hard_rules', 'recovery_policy', 'project_claude_md']) {
    const e = byId(snap.entries, id);
    assert.ok(e, 'source ' + id + ' not produced at all');
    assert.strictEqual(e.exists, true, id + ' does not exist at ' + e.path);
    assert.ok(/^[0-9a-f]{64}$/.test(e.sha256), id + ' has no hash');
  }
  const skills = snap.entries.filter((e) => e.id.startsWith('skill_frontmatter:'));
  // 57 = 49 at depth 1 + the 8-skill gsap bundle at depth 2 (the same 57 forge-contextbudget.cjs reports for
  // this project's own catalog). A depth-1-only walk finds 49 and looks perfectly calm doing it.
  assert.ok(skills.length >= 57, 'this project has 57 skills; hashed only ' + skills.length);
  assert.ok(skills.some((s) => s.id === 'skill_frontmatter:gsap/gsap-core'),
    'the nested gsap bundle is not covered on the real project');
});

t('hashing the real project twice in a row is stable (no timestamps leak into the hash)', () => {
  const root = path.resolve(__dirname, '..', '..');
  const a = cd.snapshot(root), b = cd.snapshot(root);
  const key = (s) => s.entries.map((e) => e.id + '=' + e.sha256).join('|');
  assert.strictEqual(key(a), key(b), 'the same tree hashed differently twice');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
