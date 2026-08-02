/**
 * Runnable proof for src/bridge/projects. Not a vitest suite: a standalone
 * script, so it runs through the same `node file.ts` path the bridge uses.
 *
 *   node tests/unit/projects-exercise.mjs
 *
 * Every check below touches the real file system and the real git executable.
 * Nothing is asserted from a function returning without throwing: the checks
 * read exit codes, re-read files off disk, and count records.
 */
import { mkdtempSync, rmSync, existsSync, statSync, renameSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import console from 'node:console';

import * as git from '../../src/bridge/projects/git.ts';
import { ProjectRegistry } from '../../src/bridge/projects/registry.ts';
import { createProject, runProjectDoctor, mergeClaudeMd, CLAUDE_MD_BEGIN_MARKER } from '../../src/bridge/projects/create.ts';
import { discoverProjects, readProjectMarker } from '../../src/bridge/projects/discover.ts';
import { openStore } from '../../src/bridge/storage/store.ts';
import { resolveProjectsRootInfo } from '../../src/bridge/security/paths.ts';

let pass = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function section(title) {
  console.log(`\n== ${title}`);
}
function throws(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'forge-projects-smoke-'));
const dataDir = join(scratch, 'workspace');
const projectsRoot = join(scratch, 'ForgeProjecten');
mkdirSync(projectsRoot);

const store = openStore({ dataDir });
const registry = new ProjectRegistry(store, { projectsRoot });

/* ========================================================================== */
section('git.ts — locating and running the real executable');

const availability = git.isAvailable();
check('isAvailable() ran `git version` and read its exit code', availability.available === true, availability.detail);
console.log(`        version=${availability.version} source=${availability.source}`);
console.log(`        path=${availability.executablePath}`);
check('a version string was parsed from real output', typeof availability.version === 'string' && availability.version.length > 0);

// The brief's exact scenario: a freshly spawned process whose PATH has not
// caught up with the MinGit install. PATH is narrowed to the Node directory
// alone, so the only way to find git is the documented fallback.
const savedPath = process.env.PATH;
process.env.PATH = join(process.execPath, '..');
const withoutPath = git.locateGit();
const availableWithoutPath = git.isAvailable();
process.env.PATH = savedPath;
check(
  'with git absent from PATH, the MinGit fallback is located',
  withoutPath.location !== null && withoutPath.location.source === 'mingit-fallback',
  withoutPath.detail,
);
check(
  '  and it actually runs from there',
  availableWithoutPath.available === true && availableWithoutPath.source === 'mingit-fallback',
  availableWithoutPath.detail,
);
check('git is restored on PATH for the rest of the run', git.isAvailable().available === true);

/* ========================================================================== */
section('git.ts — the policy gate refuses every network verb');

for (const args of [
  ['fetch', 'origin'],
  ['pull'],
  ['push', 'origin', 'main'],
  ['clone', 'https://example.invalid/x.git'],
  ['ls-remote'],
  ['submodule', 'update'],
  ['archive', 'HEAD'],
  ['credential', 'fill'],
]) {
  const err = throws(() => git.runGit({ cwd: scratch, args }));
  check(`git ${args[0]} is refused before any process starts`, err !== null && err.name === 'GitPolicyError', String(err));
}
for (const args of [
  ['remote', '-v'],
  ['remote', 'add', 'origin', 'https://example.invalid/x.git'],
  ['config', '--get', 'credential.helper'],
  ['config', '--global', 'user.name', 'x'],
  ['log', '--exec=calc.exe'],
  ['status', '--upload-pack=calc.exe'],
  ['unknown-subcommand'],
]) {
  const err = throws(() => git.runGit({ cwd: scratch, args }));
  check(`git ${args.join(' ')} is refused`, err !== null && err.name === 'GitPolicyError', String(err));
}
const badConfig = throws(() => git.runGit({ cwd: scratch, args: ['status'], configOverrides: { 'core.sshCommand': 'calc.exe' } }));
check('an arbitrary -c config override is refused', badConfig !== null && badConfig.name === 'GitPolicyError', String(badConfig));

/* ========================================================================== */
section('git.ts — real repository lifecycle');

const repo = join(scratch, 'plain-repo');
mkdirSync(repo);

const notARepo = git.status(repo);
check('a plain directory reports initialized:false', notARepo.state.initialized === false, notARepo.detail);

const initResult = git.init(repo);
check('git init exited 0', initResult.ok === true && initResult.exitCode === 0, initResult.stderr);
check('git init used an explicit initial branch', initResult.args.includes('--initial-branch=main'));

const branchBeforeCommit = git.currentBranch(repo);
check('the unborn branch is reported as main', branchBeforeCommit.branch === 'main', JSON.stringify(branchBeforeCommit.branch));

const emptyHead = git.lastCommit(repo);
check('an unborn HEAD is "no commits yet", not an error', emptyHead.ok === true && emptyHead.commit === null, emptyHead.detail);

writeFileSync(join(repo, 'a.txt'), 'hello\n', 'utf8');
const addResult = git.addAll(repo);
check('git add exited 0', addResult.ok === true && addResult.exitCode === 0, addResult.stderr);

// A message full of shell metacharacters. If anything in the wrapper reached a
// shell, this would redirect and create a file. It must arrive verbatim.
const hostileMessage = 'baseline & echo pwned > pwned.txt | whoami `id` $(id)';
const commitResult = git.commit(repo, hostileMessage, { author: { name: 'Exercise', email: 'exercise@localhost' } });
check('git commit exited 0 with a per-invocation identity', commitResult.ok === true, commitResult.stderr);
check('no shell was involved: the redirect did not create a file', existsSync(join(repo, 'pwned.txt')) === false);

const afterCommit = git.lastCommit(repo);
check('the commit is readable after the fact', afterCommit.ok === true && afterCommit.commit !== null, afterCommit.detail);
check(
  'the hostile message survived verbatim as the commit subject',
  afterCommit.commit?.subject === hostileMessage,
  JSON.stringify(afterCommit.commit?.subject),
);

const remoteResult = git.hasRemote(repo);
check('hasRemote is false on a repo nothing published', remoteResult.ok === true && remoteResult.hasRemote === false, remoteResult.detail);

const fullStatus = git.status(repo);
check('status assembled a complete GitState', fullStatus.ok === true && fullStatus.undetermined.length === 0, fullStatus.detail);
check('  initialized', fullStatus.state.initialized === true);
check('  branch', fullStatus.state.branch === 'main');
check('  lastCommit is a real sha', /^[0-9a-f]{40}$/.test(fullStatus.state.lastCommit ?? ''));
check('  hasRemote', fullStatus.state.hasRemote === false);

writeFileSync(join(repo, 'dirty.txt'), 'x\n', 'utf8');
const dirtyStatus = git.status(repo);
check('an untracked file is counted as dirty', dirtyStatus.state.dirtyFiles === 1, String(dirtyStatus.state.dirtyFiles));

// A directory nested inside a repository must NOT claim the parent's history.
const nested = join(repo, 'nested');
mkdirSync(nested);
const nestedStatus = git.status(nested);
check(
  'a folder inside another repo reports initialized:false',
  nestedStatus.state.initialized === false && nestedStatus.insideForeignRepository === true,
  nestedStatus.detail,
);
check('  and it does not inherit the parent commit', nestedStatus.state.lastCommit === null);

/* ========================================================================== */
section('create.ts — the full New Project flow');

const created = createProject(registry, store, {
  displayName: 'My Test Project',
  type: 'website',
  description: 'An exercise project.',
});

console.log(`        outcome=${created.outcome} steps=${created.receipt.stepsSucceeded}/${created.receipt.steps.length}`);
for (const step of created.receipt.steps) {
  console.log(`        ${String(step.number).padStart(2)} ${step.status.padEnd(12)} ${step.id} — ${step.detail.slice(0, 90)}`);
}

check('the outcome is CREATED', created.outcome === 'CREATED', `${created.outcome}: ${JSON.stringify(created.error)}`);
check('all eleven steps succeeded', created.receipt.stepsSucceeded === 11 && created.receipt.stepsFailed === 0);
check('a project record came back', created.project !== null);
check('the id is a generated UUID, not derived from the name', /^[0-9a-f-]{36}$/.test(created.project?.id ?? ''));
check('the slug came from the name, the id did not', created.project?.slug === 'my-test-project');

const projectDir = created.project?.canonicalPath ?? '';
check('the project directory exists on disk', existsSync(projectDir) && statSync(projectDir).isDirectory());
for (const relative of [
  '.claude',
  '.claude/agent-memory',
  '.claude/agents',
  '.claude/commands',
  '.claude/config',
  '.claude/docs',
  '.claude/forge-runs',
  '.claude/skills',
  '.forge',
  '.forge/receipts',
]) {
  check(`  directory ${relative}`, existsSync(join(projectDir, ...relative.split('/'))));
}
for (const relative of [
  '.claude/FORGE_VERSION.json',
  '.claude/FORGE_MEMORY.md',
  '.claude/FORGE_SESSION_STATE.json',
  '.claude/FORGE_ECC_MODE.json',
  '.claude/FORGE_DECISIONS.md',
  '.claude/FORGE_TASK_HISTORY.md',
  '.claude/FORGE_AGENT_LEDGER.md',
  '.claude/FORGE_PROJECT_PROFILE.md',
  '.claude/FORGE_SKILL_REGISTRY.md',
  '.forge/project.json',
  'CLAUDE.md',
  '.gitignore',
]) {
  const target = join(projectDir, ...relative.split('/'));
  check(`  file ${relative} exists and is non-empty`, existsSync(target) && statSync(target).size > 0);
}

const markerRead = readProjectMarker(projectDir);
check('the marker carries the same id as the record', markerRead.ok && markerRead.marker.projectId === created.project?.id);

const baselineStatus = git.status(projectDir);
check('the new project is its own git repository', baselineStatus.state.initialized === true, baselineStatus.detail);
check('it has a real baseline commit', /^[0-9a-f]{40}$/.test(baselineStatus.state.lastCommit ?? ''), String(baselineStatus.state.lastCommit));
check('it has NO remote', baselineStatus.state.hasRemote === false);
check('the working tree is clean after the baseline commit', baselineStatus.state.dirtyFiles === 0, String(baselineStatus.state.dirtyFiles));

check('the record health is HEALTHY only because the doctor passed', created.project?.health === 'HEALTHY', created.project?.health);
check('the doctor verdict is PASS with nothing undetermined', created.receipt.doctor?.verdict === 'PASS' && created.receipt.doctor?.undetermined === 0);
check('lastDoctorResult records the real counts', (created.project?.lastDoctorResult ?? '').startsWith('PASS — '), created.project?.lastDoctorResult);

check('a receipt was written to the workspace', created.receiptPaths.length >= 1 && existsSync(created.receiptPaths[0]));
check('a receipt copy was written into the project', created.receiptPaths.length === 2 && existsSync(created.receiptPaths[1]));
const receiptOnDisk = JSON.parse(readFileSync(created.receiptPaths[0], 'utf8'));
check('the receipt on disk matches the returned outcome', receiptOnDisk.outcome === created.outcome);
check('the receipt records every step with timestamps', receiptOnDisk.steps.length === 11 && receiptOnDisk.steps.every((s) => s.startedAt && s.finishedAt));
check('the receipt names the git executable and version', typeof receiptOnDisk.environment.gitVersion === 'string');
check('the receipt contains no environment dump', JSON.stringify(receiptOnDisk).includes('LOCALAPPDATA=') === false);

/* ========================================================================== */
section('create.ts — a duplicate stops honestly at step 4');

const duplicate = createProject(registry, store, { displayName: 'My Test Project' });
console.log(`        outcome=${duplicate.outcome} failedAtStep=${duplicate.receipt.failedAtStep}`);
check('the outcome is FAILED, not a second creation', duplicate.outcome === 'FAILED');
check('it failed at step 4 (collision check)', duplicate.receipt.failedAtStep === 4, String(duplicate.receipt.failedAtStep));
check('steps 1-3 are recorded as SUCCEEDED', duplicate.receipt.steps.slice(0, 3).every((s) => s.status === 'SUCCEEDED'));
check('steps 5-11 are recorded as NOT_REACHED', duplicate.receipt.steps.slice(4).every((s) => s.status === 'NOT_REACHED'));
check('the error code is CONFLICT', duplicate.receipt.steps[3].error?.code === 'CONFLICT', JSON.stringify(duplicate.receipt.steps[3].error));
check('no second record was created', registry.list().records.filter((r) => r.slug === 'my-test-project').length === 1);
check('a receipt was still written for the failure', duplicate.receiptPaths.length >= 1 && existsSync(duplicate.receiptPaths[0]));

/* ========================================================================== */
section('create.ts — a look-alike name needs an explicit override');

const paypal = createProject(registry, store, { displayName: 'paypal' });
check('the plain name is created', paypal.outcome === 'CREATED', JSON.stringify(paypal.error));

const cyrillic = 'р' + 'а' + 'ypal'; // Cyrillic er + a
const confusable = createProject(registry, store, { displayName: cyrillic });
check('a homoglyph twin is refused by default', confusable.outcome === 'FAILED' && confusable.receipt.failedAtStep === 4, confusable.outcome);
check('  and the refusal names the existing project', (confusable.receipt.steps[3].error?.message ?? '').includes('paypal'));

const overridden = createProject(registry, store, { displayName: cyrillic, allowConfusable: true });
check('an explicit owner override lets it through', overridden.outcome === 'CREATED', JSON.stringify(overridden.error));
check('  and the override is recorded in the receipt notes', overridden.receipt.notes.some((n) => n.includes('override')));

/* ========================================================================== */
section('create.ts — CLAUDE.md is merged, never overwritten');

const preExisting = join(projectsRoot, 'has-claude-md');
mkdirSync(preExisting);
const ownerText = '# My own notes\n\nDo not lose this line.\n';
writeFileSync(join(preExisting, 'CLAUDE.md'), ownerText, 'utf8');

const merge = mergeClaudeMd(preExisting, {
  id: 'test-id',
  displayName: 'Has Claude Md',
  slug: 'has-claude-md',
  canonicalPath: preExisting,
  createdAt: new Date().toISOString(),
  type: 'unknown',
  description: '',
});
const mergedText = readFileSync(join(preExisting, 'CLAUDE.md'), 'utf8');
check('the merge reported append mode', merge.ok && merge.mode === 'managed-block-appended', merge.detail);
check('every byte of the original survived', mergedText.startsWith(ownerText) && mergedText.includes('Do not lose this line.'));
check('the Forge block was added below it', mergedText.includes(CLAUDE_MD_BEGIN_MARKER));
check('the original hash was recorded before the write', typeof merge.originalHash === 'string' && merge.originalHash.length === 64);

const secondMerge = mergeClaudeMd(preExisting, {
  id: 'test-id',
  displayName: 'Has Claude Md',
  slug: 'has-claude-md',
  canonicalPath: preExisting,
  createdAt: new Date().toISOString(),
  type: 'unknown',
  description: '',
});
const twiceMerged = readFileSync(join(preExisting, 'CLAUDE.md'), 'utf8');
check('a second merge replaces the block instead of stacking it', secondMerge.mode === 'managed-block-replaced', secondMerge.mode);
check('  the file still has exactly one managed block', twiceMerged.split(CLAUDE_MD_BEGIN_MARKER).length - 1 === 1);
check('  and the owner text is still there', twiceMerged.includes('Do not lose this line.'));

/* ========================================================================== */
section('registry.ts — identity, renaming and the health gate');

const original = created.project;
const renamed = registry.rename(original.id, 'Completely Different Name');
check('rename succeeded', renamed.ok === true, JSON.stringify(renamed.error));
check('the id did not change', renamed.value?.id === original.id);
check('the canonical path did not change', renamed.value?.canonicalPath === original.canonicalPath);
check('the slug did not change', renamed.value?.slug === original.slug);
check('the folder on disk was not renamed', existsSync(original.canonicalPath));

const resolved = registry.resolvePath(original.id);
check('resolvePath still finds the project by id', resolved.ok && resolved.value === original.canonicalPath);

const dishonestHealth = registry.setHealth(original.id, 'HEALTHY', null);
check('HEALTHY without evidence is refused', dishonestHealth.ok === false && dishonestHealth.error.code === 'INVALID_STATE', JSON.stringify(dishonestHealth));
const noRefs = registry.setHealth(original.id, 'HEALTHY', { summary: 'looks fine', evidenceRefs: [] });
check('HEALTHY with a summary but no evidence refs is refused', noRefs.ok === false, JSON.stringify(noRefs));
const withEvidence = registry.setHealth(original.id, 'HEALTHY', {
  summary: 'doctor PASS',
  evidenceRefs: [{ kind: 'file', ref: original.canonicalPath }],
});
check('HEALTHY with real evidence is accepted', withEvidence.ok === true, JSON.stringify(withEvidence.error));
const unknownHealth = registry.setHealth(original.id, 'UNKNOWN', null);
check('UNKNOWN needs no evidence — it asserts nothing', unknownHealth.ok === true);

const badId = registry.get('does-not-exist');
check('an unknown id is NOT_FOUND, not a crash', badId.ok === false && badId.error.code === 'NOT_FOUND');

/* ========================================================================== */
section('discover.ts — idempotence, moves and vanished folders');

// A folder with .claude but unknown to the registry.
const strayProject = join(projectsRoot, 'stray-forge-project');
mkdirSync(join(strayProject, '.claude'), { recursive: true });
writeFileSync(join(strayProject, '.claude', 'FORGE_VERSION.json'), JSON.stringify({ forge_version: 'external-1' }), 'utf8');
// A folder that is not a Forge project at all.
const foreign = join(projectsRoot, 'not-a-forge-project');
mkdirSync(foreign);
writeFileSync(join(foreign, 'readme.txt'), 'someone else’s folder\n', 'utf8');

const beforeCount = registry.list({ includeArchived: true }).records.length;
const firstScan = discoverProjects(registry);
console.log(`        registered=${firstScan.registered.length} alreadyKnown=${firstScan.alreadyKnown.length} skipped=${firstScan.skipped.length}`);
check('the stray Forge project was adopted', firstScan.registered.some((p) => p.canonicalPath === strayProject));
check('the non-Forge folder was skipped, not adopted', firstScan.skipped.some((s) => s.name === 'not-a-forge-project'));
check('the already-known projects were recognised', firstScan.alreadyKnown.length >= 3, String(firstScan.alreadyKnown.length));
const afterFirst = registry.list({ includeArchived: true }).records.length;
// TWO folders qualify: `stray-forge-project` has a .claude directory and
// `has-claude-md` (built for the merge test above) has a CLAUDE.md. Both are
// Forge metadata, so adopting both is the correct behaviour.
check('exactly the two Forge-looking folders were added', afterFirst === beforeCount + 2, `${beforeCount} -> ${afterFirst}`);
check('  and the CLAUDE.md-only folder was one of them', firstScan.registered.some((p) => p.canonicalPath === preExisting));

const adopted = registry.findByCanonicalPath(strayProject);
check('an adopted project starts at UNKNOWN health, never HEALTHY', adopted?.health === 'UNKNOWN', adopted?.health);
check('  and its forgeVersion came from its own file', adopted?.forgeVersion === 'external-1', adopted?.forgeVersion);

const secondScan = discoverProjects(registry);
const afterSecond = registry.list({ includeArchived: true }).records.length;
check('rescanning registers nothing new', secondScan.registered.length === 0, JSON.stringify(secondScan.registered));
check('  and the record count is unchanged', afterSecond === afterFirst, `${afterFirst} -> ${afterSecond}`);

// Move a project's folder inside the root.
const movedFrom = created.project.canonicalPath;
const movedTo = join(projectsRoot, 'moved-elsewhere');
renameSync(movedFrom, movedTo);
const thirdScan = discoverProjects(registry);
console.log(`        moved=${JSON.stringify(thirdScan.moved.map((m) => m.id))}`);
check('the move was detected via the project marker', thirdScan.moved.some((m) => m.id === original.id && m.to === movedTo));
check('  no duplicate record was created', registry.list({ includeArchived: true }).records.length === afterSecond);
const movedRecord = registry.get(original.id);
check('  the record now points at the new folder', movedRecord.ok && movedRecord.value.canonicalPath === movedTo);
check('  and the id is still the original one', movedRecord.value?.id === original.id);
check('  the project is not marked MISSING', movedRecord.value?.health !== 'MISSING', movedRecord.value?.health);

// Make a project vanish from the root entirely.
const vanishing = registry.findByCanonicalPath(strayProject);
renameSync(strayProject, join(scratch, 'taken-away'));
const fourthScan = discoverProjects(registry);
check('the vanished folder is reported as missing', fourthScan.missing.some((m) => m.id === vanishing.id));
const vanishedRecord = registry.get(vanishing.id);
check('  the record was KEPT, not deleted', vanishedRecord.ok === true);
check('  and its health is MISSING', vanishedRecord.value?.health === 'MISSING', vanishedRecord.value?.health);
check('  with the reason recorded', (vanishedRecord.value?.lastDoctorResult ?? '').includes('Folder not found'));

const fifthScan = discoverProjects(registry);
check('rescanning does not re-report or re-write the missing project', fifthScan.missing.length === fourthScan.missing.length);

/* ========================================================================== */
section('doctor — an incomplete project is DEGRADED, not HEALTHY');

const broken = join(projectsRoot, 'broken-project');
mkdirSync(join(broken, '.claude'), { recursive: true });
const brokenReport = runProjectDoctor(broken);
check('the verdict is FAIL', brokenReport.verdict === 'FAIL', brokenReport.summary);
check('  which maps to DEGRADED, never HEALTHY', brokenReport.health === 'DEGRADED');
check('  and names the missing scaffolds', brokenReport.checks.some((c) => c.id === 'forge-memory-files' && c.ok === false));

const absent = runProjectDoctor(join(projectsRoot, 'never-existed'));
check('a project directory that does not exist is MISSING', absent.health === 'MISSING' && absent.verdict === 'FAIL');

/* ========================================================================== */
section('events — every claim reached the log under a contract event type');

const events = store.readEvents({ limit: 5000 });
const projectEvents = events.events.filter((e) => e.type.startsWith('project.'));
check('project.created events were persisted', projectEvents.some((e) => e.type === 'project.created'));
check('project.discovered events were persisted', projectEvents.some((e) => e.type === 'project.discovered'));
check('project.updated events were persisted', projectEvents.some((e) => e.type === 'project.updated'));
check('no event carries an invented type', events.issues.length === 0, JSON.stringify(events.issues));
check('every project event carries at least one evidence ref', projectEvents.every((e) => e.evidenceRefs.length > 0));

/* ========================================================================== */
section('the real projects root is resolved, not hardcoded');

const rootInfo = resolveProjectsRootInfo();
console.log(`        documentsDir=${rootInfo.documentsDir}`);
console.log(`        projectsRoot=${rootInfo.projectsRoot}`);
console.log(`        source=${rootInfo.source} exists=${rootInfo.documentsDirExists}`);
check('the Documents directory was found on disk, not assumed', rootInfo.documentsDirExists === true && rootInfo.source !== 'fallback-unverified');
check('the projects root sits under it', rootInfo.projectsRoot.startsWith(rootInfo.documentsDir));

/* ========================================================================== */
store.close();
rmSync(scratch, { recursive: true, force: true });

console.log(`\n${'='.repeat(70)}`);
console.log(`PASSED ${pass}   FAILED ${failures.length}`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('All checks passed against the real file system and the real git executable.');
}
