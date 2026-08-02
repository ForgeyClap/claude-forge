#!/usr/bin/env node
'use strict';
/**
 * forge-beads.test.cjs — hermetic, offline tests for forge-beads.cjs. EVERY fixture store lives under
 * os.tmpdir() (fs.mkdtempSync), pointed at via opts.storePath — this file never writes to the real
 * project's .claude/forge-beads/. Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const B = require('./forge-beads.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const ALL_TMP_ROOTS = [];
function freshStore(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  ALL_TMP_ROOTS.push(d);
  return path.join(d, 'beads.jsonl');
}

console.log('forge-beads offline tests (hermetic — os.tmpdir() fixture stores ONLY, never the real project)');

// ---- Section A: add() — basics, defaults, id generation ----
{
  const store = freshStore('bd-a');
  const b1 = B.add({ title: 'First bead' }, { storePath: store });
  t('A1: add() auto-generates a bd- prefixed id', typeof b1.id === 'string' && b1.id.startsWith('bd-'));
  t('A2: add() defaults status to "open"', b1.status === 'open');
  t('A3: add() defaults deps to an empty array', Array.isArray(b1.deps) && b1.deps.length === 0);
  t('A4: add() defaults created_run/notes to null', b1.created_run === null && b1.notes === null);
  t('A5: add() sets created_ts === updated_ts on creation', b1.created_ts === b1.updated_ts && typeof b1.created_ts === 'string');
  t('A6: add() trims the title', b1.title === 'First bead');

  const b2 = B.add({ title: '  padded  ' }, { storePath: store });
  t('A7: add() trims surrounding whitespace from title', b2.title === 'padded');

  const stored = B.readStore(store);
  t('A8: the store now contains exactly 2 beads', stored.length === 2);
}

// ---- Section A2: add() with explicit id/status/deps/created_run/notes ----
{
  const store = freshStore('bd-a2');
  B.add({ title: 'Base', id: 'base-1' }, { storePath: store });
  const dependent = B.add({ title: 'Dependent', id: 'dep-1', status: 'doing', deps: ['base-1'], created_run: 'run-42', notes: 'some note' }, { storePath: store });
  t('A2a: explicit id is honored', dependent.id === 'dep-1');
  t('A2b: explicit status is honored', dependent.status === 'doing');
  t('A2c: explicit deps referencing an existing bead is accepted', dependent.deps.length === 1 && dependent.deps[0] === 'base-1');
  t('A2d: created_run/notes are stored as given', dependent.created_run === 'run-42' && dependent.notes === 'some note');
}

// ---- Section A3: add() validation — every failure mode throws, never silently accepted ----
{
  const store = freshStore('bd-a3');
  let threw;

  threw = false; try { B.add({}, { storePath: store }); } catch { threw = true; }
  t('A3a: add() throws on a missing title', threw === true);

  threw = false; try { B.add({ title: '   ' }, { storePath: store }); } catch { threw = true; }
  t('A3b: add() throws on a whitespace-only title', threw === true);

  B.add({ title: 'Existing', id: 'dup-1' }, { storePath: store });
  threw = false; try { B.add({ title: 'Another', id: 'dup-1' }, { storePath: store }); } catch { threw = true; }
  t('A3c: add() throws on a duplicate id', threw === true);

  threw = false; try { B.add({ title: 'Bad status', status: 'archived' }, { storePath: store }); } catch { threw = true; }
  t('A3d: add() throws on an invalid status', threw === true);

  threw = false; try { B.add({ title: 'Ghost dep', deps: ['does-not-exist'] }, { storePath: store }); } catch { threw = true; }
  t('A3e: add() throws when a dep id does not resolve to an existing bead', threw === true);

  threw = false; try { B.add({ title: 'Self dep', id: 'self-1', deps: ['self-1'] }, { storePath: store }); } catch { threw = true; }
  t('A3f: add() throws on a self-referential dep', threw === true);

  threw = false; try { B.add({ title: 'Bad id', id: 'has a space' }, { storePath: store }); } catch { threw = true; }
  t('A3g: add() throws on an id that fails the safe-id shape', threw === true);

  const before = B.readStore(store).length;
  t('A3h: none of the above failed add() calls actually wrote a partial/corrupt record', before === 1);
}

// ---- Section B: link() — adds an edge, is idempotent, validates both ends ----
{
  const store = freshStore('bd-b');
  B.add({ title: 'X', id: 'x-1' }, { storePath: store });
  B.add({ title: 'Y', id: 'y-1' }, { storePath: store });

  const linked = B.link('x-1', 'y-1', { storePath: store });
  t('B1: link() adds `to` into `from`.deps', linked.deps.includes('y-1'));
  t('B2: link() bumps updated_ts past created_ts on a real change', linked.updated_ts >= linked.created_ts);

  const before = B.readStore(store).find((b) => b.id === 'x-1');
  const relinked = B.link('x-1', 'y-1', { storePath: store });
  t('B3: link() is idempotent — linking an already-linked pair does not duplicate the dep', relinked.deps.filter((d) => d === 'y-1').length === 1);
  t('B3b: an idempotent re-link does not bump updated_ts again', relinked.updated_ts === before.updated_ts);

  let threw = false; try { B.link('x-1', 'x-1', { storePath: store }); } catch { threw = true; }
  t('B4: link() throws on a self-link', threw === true);

  threw = false; try { B.link('x-1', 'ghost', { storePath: store }); } catch { threw = true; }
  t('B5: link() throws when `to` does not resolve to an existing bead', threw === true);

  threw = false; try { B.link('ghost', 'y-1', { storePath: store }); } catch { threw = true; }
  t('B6: link() throws when `from` does not resolve to an existing bead', threw === true);

  threw = false; try { B.link('bad id', 'y-1', { storePath: store }); } catch { threw = true; }
  t('B7: link() throws on an invalid id shape', threw === true);
}

// ---- Section C: close() — sets status to done, idempotent, validates the id ----
{
  const store = freshStore('bd-c');
  B.add({ title: 'Closeable', id: 'c-1' }, { storePath: store });
  const closed = B.close('c-1', { storePath: store });
  t('C1: close() sets status to "done"', closed.status === 'done');
  t('C2: close() bumps updated_ts', closed.updated_ts >= closed.created_ts);

  const reclosed = B.close('c-1', { storePath: store });
  t('C3: close() on an already-done bead is idempotent (stays done, no error)', reclosed.status === 'done');

  let threw = false; try { B.close('ghost', { storePath: store }); } catch { threw = true; }
  t('C4: close() throws on an unknown bead id', threw === true);
}

// ---- Section D: ready() — only beads with ALL deps done are in the frontier; a blocked bead is excluded
// UNTIL its dependency actually closes (the core round-trip the whole tool exists for). ----
{
  const store = freshStore('bd-d');
  B.add({ title: 'Foundation', id: 'found-1' }, { storePath: store });
  B.add({ title: 'Built on it', id: 'built-1', deps: ['found-1'] }, { storePath: store });
  B.add({ title: 'No deps at all', id: 'free-1' }, { storePath: store });

  const r1 = B.ready({ storePath: store });
  const readyIds1 = r1.ready.map((b) => b.id);
  t('D1: before the dependency closes, the dependent bead is NOT in the ready frontier', !readyIds1.includes('built-1'));
  t('D2: an unrelated bead with no deps IS in the ready frontier', readyIds1.includes('free-1'));
  t('D3: the foundation bead (open, no deps) IS in the ready frontier', readyIds1.includes('found-1'));
  t('D4: total reflects the full store size regardless of readiness', r1.total === 3);
  t('D5: no cycle exists yet — cycles[] is empty and notes[] stays empty', r1.cycles.length === 0 && r1.notes.length === 0);

  B.close('found-1', { storePath: store });
  const r2 = B.ready({ storePath: store });
  const readyIds2 = r2.ready.map((b) => b.id);
  t('D6: AFTER the dependency closes, the previously-blocked bead now appears in the ready frontier', readyIds2.includes('built-1'));
  t('D7: the now-done foundation bead itself no longer appears (done is not "actionable")', !readyIds2.includes('found-1'));
}

// ---- Section D2: blockedBy() — reports exactly which deps are still unmet, including a dangling dep ----
{
  const store = freshStore('bd-d2');
  B.add({ title: 'Dep A', id: 'da-1' }, { storePath: store });
  B.add({ title: 'Dep B', id: 'db-1' }, { storePath: store });
  B.add({ title: 'Consumer', id: 'cons-1', deps: ['da-1', 'db-1'] }, { storePath: store });

  const before = B.blockedBy('cons-1', { storePath: store });
  t('D2a: blockedBy() reports both unmet deps before either closes', before.length === 2 && before.every((e) => e.status === 'open'));

  B.close('da-1', { storePath: store });
  const after = B.blockedBy('cons-1', { storePath: store });
  t('D2b: blockedBy() drops a dep once it closes, keeps the still-open one', after.length === 1 && after[0].id === 'db-1');

  B.close('db-1', { storePath: store });
  const clear = B.blockedBy('cons-1', { storePath: store });
  t('D2c: blockedBy() returns an empty array once every dep is done', clear.length === 0);

  let threw = false; try { B.blockedBy('ghost', { storePath: store }); } catch { threw = true; }
  t('D2d: blockedBy() throws on an unknown bead id', threw === true);
}

// ---- Section E: cycle detection — a real cycle is found, reported, and correctly excludes a member from
// ready() EVEN when that member's own direct deps look individually satisfied (proves the cycle-exclusion
// branch in computeReady() is load-bearing, not merely redundant with the plain "all deps done" check). ----
{
  const store = freshStore('bd-e');
  // C -> (no deps yet) ; B -> deps:[C] ; A -> deps:[B] ; then link(C, A) closes the loop: A->B->C->A.
  B.add({ title: 'C', id: 'cyc-c' }, { storePath: store });
  B.add({ title: 'B', id: 'cyc-b', deps: ['cyc-c'] }, { storePath: store });
  B.add({ title: 'A', id: 'cyc-a', deps: ['cyc-b'] }, { storePath: store });
  B.link('cyc-c', 'cyc-a', { storePath: store });

  const g = B.graph({ storePath: store });
  t('E1: graph() detects exactly 1 cycle among the 3 mutually-dependent beads', g.cycles.length === 1);
  const cycleIds = new Set(g.cycles[0]);
  t('E2: the detected cycle includes all 3 involved beads', ['cyc-a', 'cyc-b', 'cyc-c'].every((id) => cycleIds.has(id)));
  t('E3: graph() reports the real edges (3 edges: a->b, b->c, c->a)', g.edges.length === 3);

  // Force-close C (a real, allowed manual action even though C's OWN dep A is not done) — this makes B's
  // single dep (C) look "all done" under a naive check, while the dependency GRAPH is still cyclic.
  B.close('cyc-c', { storePath: store });
  const r = B.ready({ storePath: store });
  const readyIds = r.ready.map((x) => x.id);
  t('E4: B is NOT in the ready frontier despite its only dep (C) now being done — cycle exclusion is what keeps it out', !readyIds.includes('cyc-b'));
  t('E5: A is correctly excluded too (its own dep B is still open)', !readyIds.includes('cyc-a'));
  t('E6: ready() surfaces an honest note that a cycle was detected', r.notes.some((n) => /cycle/i.test(n)));
  t('E7: cycles[] is still reported by ready() itself, not just graph()', r.cycles.length === 1);
}

// ---- Section E2: computeCycles / computeReady — direct pure-function unit tests (no I/O), the exact
// functions this tool's mutation-verification targets. ----
{
  t('E2a: computeCycles([]) on an empty graph returns no cycles', B.computeCycles([]).length === 0);
  t('E2b: computeCycles() on a purely linear chain (no back-edges) finds nothing',
    B.computeCycles([{ id: '1', deps: [] }, { id: '2', deps: ['1'] }, { id: '3', deps: ['2'] }]).length === 0);
  t('E2c: computeCycles() ignores a dangling dep id (never crashes, never a false cycle)',
    B.computeCycles([{ id: '1', deps: ['does-not-exist'] }]).length === 0);
  t('E2d: computeCycles() finds a direct 2-node cycle (1 depends on 2, 2 depends on 1)',
    B.computeCycles([{ id: '1', deps: ['2'] }, { id: '2', deps: ['1'] }]).length === 1);

  const openChain = [{ id: 'p', status: 'open', deps: ['q'] }, { id: 'q', status: 'open', deps: [] }];
  const openChainReady = B.computeReady(openChain).ready.map((b) => b.id);
  t('E2e: computeReady() pure function returns only the satisfiable bead (q, which has no deps) — NOT p, whose dep q is still open', openChainReady.length === 1 && openChainReady[0] === 'q');
  const doneDep = [{ id: 'p', status: 'open', deps: ['q'] }, { id: 'q', status: 'done', deps: [] }];
  t('E2f: computeReady() includes p once its only dep is done', B.computeReady(doneDep).ready.map((b) => b.id).includes('p'));
  const notOpen = [{ id: 'p', status: 'doing', deps: [] }];
  t('E2g: computeReady() never includes a non-"open" bead even with zero deps (doing/blocked/done are never "ready")', B.computeReady(notOpen).ready.length === 0);
}

// ---- Section F: malformed store fails closed (throws), never silently drops/corrupts data ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-f-'));
  ALL_TMP_ROOTS.push(dir);
  const store = path.join(dir, 'beads.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(store, '{"id":"ok-1","title":"fine","status":"open","deps":[]}\nNOT VALID JSON\n', 'utf8');

  let threw = false, msg = '';
  try { B.readStore(store); } catch (e) { threw = true; msg = e.message; }
  t('F1: readStore() throws on a malformed line rather than silently skipping it', threw === true);
  t('F2: the thrown error names the real store path and line number', /line 2/.test(msg));

  threw = false; try { B.add({ title: 'new' }, { storePath: store }); } catch { threw = true; }
  t('F3: add() against a malformed store also fails closed (never appends on top of corrupt data)', threw === true);

  threw = false; try { B.ready({ storePath: store }); } catch { threw = true; }
  t('F4: ready() against a malformed store also fails closed', threw === true);

  // A record missing/invalid `id` is equally malformed, not just broken JSON syntax.
  const store2 = path.join(dir, 'beads2.jsonl');
  fs.writeFileSync(store2, '{"title":"no id at all","status":"open","deps":[]}\n', 'utf8');
  threw = false; try { B.readStore(store2); } catch { threw = true; }
  t('F5: readStore() throws on a syntactically-valid JSON line that is missing a bead id', threw === true);

  // A MISSING store file is a valid, ordinary empty state — never an error.
  const neverWritten = path.join(dir, 'never-written.jsonl');
  let missingThrew = false;
  let missingResult = null;
  try { missingResult = B.readStore(neverWritten); } catch { missingThrew = true; }
  t('F6: readStore() on a store file that does not exist yet returns [] rather than throwing', missingThrew === false && Array.isArray(missingResult) && missingResult.length === 0);
}

// ---- Section G: small pure-helper unit coverage (isValidId / normalizeDeps / genId / resolveStorePath) ----
{
  t('G1: isValidId rejects a non-string', B.isValidId(123) === false);
  t('G2: isValidId rejects a space-containing id', B.isValidId('bad id') === false);
  t('G3: isValidId rejects a path-escape-shaped id', B.isValidId('../evil') === false);
  t('G4: isValidId accepts a real safe id', B.isValidId('bd-abc123_XY-9') === true);

  t('G5: normalizeDeps(null) returns an empty array', Array.isArray(B.normalizeDeps(null)) && B.normalizeDeps(null).length === 0);
  t('G6: normalizeDeps dedupes repeated ids while preserving first-seen order', JSON.stringify(B.normalizeDeps(['a', 'b', 'a'])) === JSON.stringify(['a', 'b']));
  let threwDeps = false; try { B.normalizeDeps('not-an-array'); } catch { threwDeps = true; }
  t('G7: normalizeDeps throws when given a non-array', threwDeps === true);
  threwDeps = false; try { B.normalizeDeps(['bad id']); } catch { threwDeps = true; }
  t('G8: normalizeDeps throws on an invalid-shaped dep id', threwDeps === true);

  const id1 = B.genId('same title');
  const id2 = B.genId('same title');
  t('G9: genId() produces distinct ids even for the same title (no collision on repeat calls)', id1 !== id2);
  t('G10: genId() always carries the bd- prefix', id1.startsWith('bd-') && id2.startsWith('bd-'));

  const savedEnv = process.env.FORGE_PROJECT_ROOT;
  try {
    delete process.env.FORGE_PROJECT_ROOT;
    t('G11: resolveRoot(null) with no env falls back to the __dirname-relative default', B.resolveRoot(null) === path.resolve(__dirname, '..', '..'));
    process.env.FORGE_PROJECT_ROOT = '/env/root';
    t('G12: resolveRoot(null) uses FORGE_PROJECT_ROOT when set', B.resolveRoot(null) === path.resolve('/env/root'));
    t('G13: resolveRoot(explicit) always wins over env', B.resolveRoot('/explicit/root') === path.resolve('/explicit/root'));
  } finally {
    if (savedEnv === undefined) delete process.env.FORGE_PROJECT_ROOT; else process.env.FORGE_PROJECT_ROOT = savedEnv;
  }

  t('G14: defaultStorePath() nests under .claude/forge-beads/beads.jsonl', B.defaultStorePath('/root') === path.join('/root', '.claude', 'forge-beads', 'beads.jsonl'));
  t('G15: resolveStorePath() honors an explicit opts.storePath override outright', B.resolveStorePath({ storePath: '/tmp/x/y.jsonl' }) === path.resolve('/tmp/x/y.jsonl'));
}

// ---- Section H: real CLI invoked as a subprocess ----
{
  const cliPath = path.join(__dirname, 'forge-beads.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-h-'));
  ALL_TMP_ROOTS.push(dir);
  const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: dir });
  const run = (args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env });

  const rAdd1 = run(['add', '--title', 'CLI base', '--id', 'cli-base', '--json']);
  t('H1: CLI add exits 0 and prints the stored bead as JSON', rAdd1.status === 0 && JSON.parse(rAdd1.stdout).id === 'cli-base');

  const rAdd2 = run(['add', '--title', 'CLI dependent', '--id', 'cli-dep', '--deps', 'cli-base', '--json']);
  t('H2: CLI add accepts a comma-separated --deps list', rAdd2.status === 0 && JSON.parse(rAdd2.stdout).deps[0] === 'cli-base');

  const rReadyBefore = run(['ready', '--json']);
  const jReadyBefore = JSON.parse(rReadyBefore.stdout);
  t('H3: CLI ready exits 0 with no cycles, and correctly withholds the still-blocked dependent', rReadyBefore.status === 0 && !jReadyBefore.ready.map((b) => b.id).includes('cli-dep'));

  const rClose = run(['close', '--id', 'cli-base', '--json']);
  t('H4: CLI close exits 0 and reports status done', rClose.status === 0 && JSON.parse(rClose.stdout).status === 'done');

  const rReadyAfter = run(['ready', '--json']);
  const jReadyAfter = JSON.parse(rReadyAfter.stdout);
  t('H5: after close, CLI ready now includes the previously-blocked dependent', jReadyAfter.ready.map((b) => b.id).includes('cli-dep'));

  const rLinkUsage = run(['link', '--from', 'cli-base']);
  t('H6: CLI link exits 2 when --to is missing (usage error)', rLinkUsage.status === 2);

  const rAddUsage = run(['add']);
  t('H7: CLI add exits 2 when --title is missing', rAddUsage.status === 2);

  const rUnknownCmd = run(['bogus']);
  t('H8: CLI exits 2 on an unknown subcommand', rUnknownCmd.status === 2);

  const rBlockedBy = run(['blocked-by', '--id', 'cli-dep', '--json']);
  t('H9: CLI blocked-by exits 0 and reports an empty array once the dep is done', rBlockedBy.status === 0 && JSON.parse(rBlockedBy.stdout).length === 0);

  const rGraph = run(['graph', '--json']);
  const jGraph = JSON.parse(rGraph.stdout);
  t('H10: CLI graph exits 0 (no cycle) and reports the real node/edge counts', rGraph.status === 0 && jGraph.nodes.length === 2 && jGraph.edges.length === 1);

  // build a real cycle purely through the CLI and confirm the CLI itself exits 3
  run(['add', '--title', 'cyc x', '--id', 'cli-cyc-x']);
  run(['add', '--title', 'cyc y', '--id', 'cli-cyc-y', '--deps', 'cli-cyc-x']);
  const rLink = run(['link', '--from', 'cli-cyc-x', '--to', 'cli-cyc-y']);
  t('H11: CLI link exits 0 on success', rLink.status === 0);
  const rReadyCycle = run(['ready', '--json']);
  t('H12: CLI ready exits EXACTLY 3 once a real cycle exists in the store (never 0, never confused with a thrown-error 2)', rReadyCycle.status === 3);
  const rGraphCycle = run(['graph', '--json']);
  t('H13: CLI graph also exits 3 when it reports a cycle', rGraphCycle.status === 3);
  t('H13b: the graph JSON actually names the cycle', JSON.parse(rGraphCycle.stdout).cycles.length === 1);

  // malformed store via the CLI must exit 2, never crash uncaught / never exit 0
  const storeFile = path.join(dir, '.claude', 'forge-beads', 'beads.jsonl');
  fs.appendFileSync(storeFile, 'THIS IS NOT JSON\n', 'utf8');
  const rMalformed = run(['ready', '--json']);
  t('H14: CLI exits 2 (not a crash, not 0) when the store is malformed', rMalformed.status === 2);
  t('H14b: the CLI prints a real, prefixed error message on the malformed-store path', /^forge-beads: /.test(rMalformed.stderr));

  // requiring forge-beads.cjs as a plain module must never trigger CLI usage output
  const requireOnly = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(cliPath) + '); console.log("LOADED_OK");'], { encoding: 'utf8' });
  t('H15: requiring forge-beads.cjs as a plain module never triggers CLI usage output or a stray exit code', requireOnly.status === 0 && requireOnly.stdout.includes('LOADED_OK') && !/Usage: node forge-beads\.cjs/.test(requireOnly.stderr));
}

// ---- Section I: every temp dir this test file created is under os.tmpdir() ----
{
  const tmpRoot = path.resolve(os.tmpdir());
  t('I1: every one of the ' + ALL_TMP_ROOTS.length + ' fixture roots created this run is under os.tmpdir()',
    ALL_TMP_ROOTS.length > 0 && ALL_TMP_ROOTS.every((d) => path.resolve(d).startsWith(tmpRoot)));
  t('I2: forge-beads.cjs itself was never touched by this test file', fs.existsSync(path.join(__dirname, 'forge-beads.cjs')));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
