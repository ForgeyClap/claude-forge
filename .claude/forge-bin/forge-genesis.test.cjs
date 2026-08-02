#!/usr/bin/env node
'use strict';
// forge-genesis.test.cjs — real tests for staged, approval-gated self-authoring (2026-07-19, PIECE J1).
// Proves the safety core two ways every time: (1) a proposal ALWAYS lands in staging, NEVER in the live
// skills dir, and (2) promotion out of staging happens ONLY via approve() with an explicit ownerApproval
// token — missing/blank token is refused, and an evidence-less proposal is rejected before anything is
// written at all. CLI exit codes (0/2/3) are proven via a real spawned subprocess.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const genesis = require('./forge-genesis.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-genesis.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }
function freshRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'genesis') + '-'));
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  return root;
}

console.log('forge-genesis tests (staged, approval-gated self-authoring)');

// ---------------------------------------------------------------------------
// 1) evidence-less proposal is rejected — nothing written at all
// ---------------------------------------------------------------------------
console.log('\n1) evidence-less / gap-less proposals are rejected before any write');

t('proposeSkill with no evidence at all is rejected', () => {
  const root = freshRoot('genesis-noevidence');
  const r = genesis.proposeSkill({ gap: 'no skill covers X' }, { root });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.staged, false);
  assert.ok(/no real evidence/.test(r.reason));
});

t('rejected proposal writes NOTHING to disk (no staging dir created)', () => {
  const root = freshRoot('genesis-noevidence-nowrite');
  genesis.proposeSkill({ gap: 'no skill covers X' }, { root });
  assert.strictEqual(fs.existsSync(path.join(root, '.claude', 'forge-genesis-staging')), false);
});

t('proposeSkill with no gap is rejected even if evidence is supplied', () => {
  const root = freshRoot('genesis-nogap');
  const r = genesis.proposeSkill({ gap: '', evidence: 'real run log showing the gap' }, { root });
  assert.strictEqual(r.ok, false);
  assert.ok(/no gap description/.test(r.reason));
});

t('proposeSkill with only whitespace evidence is rejected (not fooled by blank content)', () => {
  const root = freshRoot('genesis-blankevidence');
  const r = genesis.proposeSkill({ gap: 'real gap', evidence: '   \n  ' }, { root });
  assert.strictEqual(r.ok, false);
  assert.ok(/no real evidence/.test(r.reason));
});

t('a nonexistent evidencePath is refused with a clear reason (never silently empty)', () => {
  const root = freshRoot('genesis-badpath');
  const r = genesis.proposeSkill({ gap: 'real gap', evidencePath: path.join(root, 'does-not-exist.txt') }, { root });
  assert.strictEqual(r.ok, false);
  assert.ok(/evidencePath could not be read/.test(r.reason));
});

// ---------------------------------------------------------------------------
// 2) a real proposal is staged — and ONLY staged, never in the live skills dir
// ---------------------------------------------------------------------------
console.log('\n2) a real proposal is staged, never in .claude/skills/');

t('a proposal with real gap+evidence is staged under forge-genesis-staging', () => {
  const root = freshRoot('genesis-stage');
  const r = genesis.proposeSkill({ gap: 'no skill covers voice-agent call-transfer QA', evidence: 'run 42 hit this gap: no existing skill validated call transfer; evidence: run.json line 88' }, { root });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.staged, true);
  assert.ok(fs.existsSync(r.skillPath));
  assert.ok(r.dir.includes('forge-genesis-staging'));
});

t('staging NEVER touches the live .claude/skills/ dir', () => {
  const root = freshRoot('genesis-stage-isolation');
  const r = genesis.proposeSkill({ gap: 'gap A', evidence: 'evidence A' }, { root });
  const liveSkillsDir = path.join(root, '.claude', 'skills', r.name);
  assert.strictEqual(fs.existsSync(liveSkillsDir), false, 'staged proposal must not appear in the live skills dir');
});

t('staged SKILL.md carries the PROPOSED banner + evidence block + test stub', () => {
  const root = freshRoot('genesis-content');
  const r = genesis.proposeSkill({ gap: 'gap B needing coverage', evidence: 'evidence text B from a real run' }, { root });
  const content = fs.readFileSync(r.skillPath, 'utf8');
  assert.ok(content.includes('status: PROPOSED — requires owner approval via /forge approve-skill'));
  assert.ok(content.includes('gap B needing coverage'));
  assert.ok(content.includes('evidence text B from a real run'));
  assert.ok(content.includes('Test stub'));
  assert.ok(content.includes('_not yet approved_'));
});

t('a sibling proposal.json metadata record is written with status PROPOSED', () => {
  const root = freshRoot('genesis-meta');
  const r = genesis.proposeSkill({ gap: 'gap C', evidence: 'evidence C' }, { root });
  const meta = JSON.parse(fs.readFileSync(path.join(r.dir, 'proposal.json'), 'utf8'));
  assert.strictEqual(meta.status, 'PROPOSED');
  assert.strictEqual(meta.approvedAt, null);
  assert.strictEqual(meta.gap, 'gap C');
});

t('proposing the same name twice without overwrite is refused (no silent clobber)', () => {
  const root = freshRoot('genesis-dup');
  genesis.proposeSkill({ gap: 'dup gap', evidence: 'ev1', name: 'dup-skill' }, { root });
  const r2 = genesis.proposeSkill({ gap: 'dup gap v2', evidence: 'ev2', name: 'dup-skill' }, { root });
  assert.strictEqual(r2.ok, false);
  assert.ok(/already staged/.test(r2.reason));
});

t('evidencePath is read from a real file and quoted into the draft', () => {
  const root = freshRoot('genesis-evfile');
  const evFile = path.join(root, 'evidence.txt');
  fs.writeFileSync(evFile, 'real run evidence from a file on disk');
  const r = genesis.proposeSkill({ gap: 'gap from file', evidencePath: evFile }, { root });
  assert.strictEqual(r.ok, true);
  const content = fs.readFileSync(r.skillPath, 'utf8');
  assert.ok(content.includes('real run evidence from a file on disk'));
  assert.ok(content.includes(evFile));
});

// ---------------------------------------------------------------------------
// 3) list() shows staged proposals, read-only
// ---------------------------------------------------------------------------
console.log('\n3) list()');

t('list() returns every staged proposal with name/gap/status', () => {
  const root = freshRoot('genesis-list');
  genesis.proposeSkill({ gap: 'gap1', evidence: 'ev1', name: 'skill-one' }, { root });
  genesis.proposeSkill({ gap: 'gap2', evidence: 'ev2', name: 'skill-two' }, { root });
  const r = genesis.list({ root });
  const names = r.proposals.map((p) => p.name).sort();
  assert.deepStrictEqual(names, ['skill-one', 'skill-two']);
  assert.ok(r.proposals.every((p) => p.status === 'PROPOSED'));
});

t('list() on an empty/nonexistent staging dir returns an empty array, not an error', () => {
  const root = freshRoot('genesis-list-empty');
  const r = genesis.list({ root });
  assert.deepStrictEqual(r.proposals, []);
});

// ---------------------------------------------------------------------------
// 4) approve() — the ONLY promotion path, gated on an explicit ownerApproval token
// ---------------------------------------------------------------------------
console.log('\n4) approve() — approval-gate + never-auto-activate');

t('approve() WITHOUT ownerApproval is refused — nothing promoted, live skills dir untouched', () => {
  const root = freshRoot('genesis-noapproval');
  const staged = genesis.proposeSkill({ gap: 'gate gap', evidence: 'gate evidence' }, { root });
  const r = genesis.approve({ name: staged.name }, { root });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.promoted, false);
  assert.ok(/ownerApproval/.test(r.reason));
  assert.strictEqual(fs.existsSync(path.join(root, '.claude', 'skills', staged.name)), false);
});

t('approve() with an EMPTY STRING ownerApproval is refused (not treated as truthy)', () => {
  const root = freshRoot('genesis-emptyapproval');
  const staged = genesis.proposeSkill({ gap: 'gate gap 2', evidence: 'gate evidence 2' }, { root });
  const r = genesis.approve({ name: staged.name }, { root, ownerApproval: '   ' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.existsSync(path.join(root, '.claude', 'skills', staged.name)), false);
});

t('approve() for an unknown/never-staged name is refused', () => {
  const root = freshRoot('genesis-unknown');
  const r = genesis.approve({ name: 'never-proposed' }, { root, ownerApproval: 'TOKEN-123' });
  assert.strictEqual(r.ok, false);
  assert.ok(/no staged proposal/.test(r.reason));
});

t('approve() WITH an explicit ownerApproval token promotes to .claude/skills/ and records the approval', () => {
  const root = freshRoot('genesis-approve-ok');
  const staged = genesis.proposeSkill({ gap: 'promotable gap', evidence: 'promotable evidence' }, { root });
  const r = genesis.approve({ name: staged.name }, { root, ownerApproval: 'APPROVE-TOKEN-XYZ', approver: 'owner@example.test' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.promoted, true);
  const liveSkill = path.join(root, '.claude', 'skills', staged.name, 'SKILL.md');
  assert.ok(fs.existsSync(liveSkill));
  const content = fs.readFileSync(liveSkill, 'utf8');
  assert.ok(content.includes('status: active'));
  assert.ok(!content.includes('status: PROPOSED — requires owner approval'));
  assert.ok(content.includes('owner@example.test'));
});

t('approve() records the approval in the staged proposal.json (status APPROVED)', () => {
  const root = freshRoot('genesis-approve-meta');
  const staged = genesis.proposeSkill({ gap: 'meta gap', evidence: 'meta evidence' }, { root });
  genesis.approve({ name: staged.name }, { root, ownerApproval: 'TOKEN-ABC' });
  const meta = JSON.parse(fs.readFileSync(path.join(staged.dir, 'proposal.json'), 'utf8'));
  assert.strictEqual(meta.status, 'APPROVED');
  assert.ok(meta.approvedAt);
  assert.ok(meta.approvalTokenHash && meta.approvalTokenHash.length > 0);
  assert.ok(!JSON.stringify(meta).includes('TOKEN-ABC'), 'raw approval token must never be persisted');
});

t('approve() appends to an audit log (_approvals.jsonl) rather than only mutating one file', () => {
  const root = freshRoot('genesis-approve-log');
  const staged = genesis.proposeSkill({ gap: 'log gap', evidence: 'log evidence' }, { root });
  genesis.approve({ name: staged.name }, { root, ownerApproval: 'TOKEN-LOG' });
  const logPath = path.join(root, '.claude', 'forge-genesis-staging', '_approvals.jsonl');
  assert.ok(fs.existsSync(logPath));
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(rec.name, staged.name);
  assert.ok(!JSON.stringify(rec).includes('TOKEN-LOG'), 'raw token must never appear in the audit log either');
});

t('list() reflects APPROVED status after promotion', () => {
  const root = freshRoot('genesis-list-after-approve');
  const staged = genesis.proposeSkill({ gap: 'listed gap', evidence: 'listed evidence' }, { root });
  genesis.approve({ name: staged.name }, { root, ownerApproval: 'TOKEN-LIST' });
  const r = genesis.list({ root });
  const entry = r.proposals.find((p) => p.name === staged.name);
  assert.ok(entry);
  assert.strictEqual(entry.status, 'APPROVED');
  assert.ok(entry.approvedAt);
});

// ---------------------------------------------------------------------------
// 5) CLI — real spawned subprocess, exit codes 0/2/3
// ---------------------------------------------------------------------------
console.log('\n5) CLI (spawned subprocess)');

t('CLI propose with missing --gap/--evidence prints usage and exits 2', () => {
  const r = runCLI(['propose']);
  assert.strictEqual(r.status, 2);
});

t('CLI propose with a real evidence file stages a proposal and exits 0', () => {
  const root = freshRoot('genesis-cli-propose');
  const evFile = path.join(root, 'ev.txt');
  fs.writeFileSync(evFile, 'CLI evidence content');
  const r = spawnSync(process.execPath, [CLI, 'propose', '--gap', 'cli gap', '--evidence', evFile, '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.ok, true);
  assert.ok(fs.existsSync(parsed.skillPath));
});

t('CLI propose with a nonexistent evidence file exits 3 (refused, not a crash)', () => {
  const root = freshRoot('genesis-cli-propose-bad');
  const r = spawnSync(process.execPath, [CLI, 'propose', '--gap', 'cli gap', '--evidence', path.join(root, 'nope.txt'), '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
  assert.strictEqual(r.status, 3);
});

t('CLI list --json on a fresh root prints an empty proposals array and exits 0', () => {
  const root = freshRoot('genesis-cli-list');
  const r = spawnSync(process.execPath, [CLI, 'list', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(parsed.proposals, []);
});

t('CLI approve without --owner-approval exits 2 (usage error, refused before touching anything)', () => {
  const root = freshRoot('genesis-cli-approve-noflag');
  const r = spawnSync(process.execPath, [CLI, 'approve', 'some-skill'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
  assert.strictEqual(r.status, 2);
});

t('CLI approve for an unknown proposal WITH a token exits 3 (refused, not a crash)', () => {
  const root = freshRoot('genesis-cli-approve-unknown');
  const r = spawnSync(process.execPath, [CLI, 'approve', 'never-existed', '--owner-approval', 'TOKEN', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
  assert.strictEqual(r.status, 3);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.ok, false);
});

t('CLI end-to-end: propose then approve promotes the skill via two real subprocess calls', () => {
  const root = freshRoot('genesis-cli-e2e');
  const evFile = path.join(root, 'ev.txt');
  fs.writeFileSync(evFile, 'end to end evidence');
  const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root });
  const proposeR = spawnSync(process.execPath, [CLI, 'propose', '--gap', 'e2e gap', '--evidence', evFile, '--name', 'e2e-skill', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(proposeR.status, 0);
  assert.strictEqual(fs.existsSync(path.join(root, '.claude', 'skills', 'e2e-skill')), false);

  const approveR = spawnSync(process.execPath, [CLI, 'approve', 'e2e-skill', '--owner-approval', 'E2E-TOKEN', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(approveR.status, 0);
  const parsed = JSON.parse(approveR.stdout.trim());
  assert.strictEqual(parsed.ok, true);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'e2e-skill', 'SKILL.md')));
});

t('CLI with an unknown command exits 2', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
