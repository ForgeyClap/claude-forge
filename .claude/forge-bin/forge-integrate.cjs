#!/usr/bin/env node
'use strict';
/**
 * forge-integrate.cjs — HERMETIC INTEGRATION GATE (2026-07-11).
 *
 * Turns a "green" from ASSERTED into OBSERVED. It takes the assembled project, runs its REAL
 * install → build → test commands in a clean git worktree (or in place if not a git repo), parses the
 * test output for pass/fail counts, writes <run>/artifacts/integration-gate.json, and — when a run id is
 * given — logs a content-oracle-backed quality_gate_passed / quality_gate_blocked event (carrying the real
 * exit_code + evidence path) via log-event.cjs. A done-ticket can then be required to reference a parsed
 * pass here, instead of a free-text "it works".
 *
 * Zero-dependency (child_process/fs/path only). Node projects (package.json) are supported today; other
 * stacks report SKIP honestly rather than a fake pass. The browser/console-error check is deliberately NOT
 * here — that belongs to the screenshot-loop tool (Playwright exact viewport); this gate is build+test.
 *
 * Usage:
 *   node forge-integrate.cjs <projectDir> [--run <run_id>] [--json] [--in-place] [--no-install]
 * Exit: 0 = gate PASSED · 1 = gate BLOCKED · 2 = SKIP/unsupported/error.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

function parseArgs(argv) {
  const a = { projectDir: null, run: null, json: false, inPlace: false, install: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--run') a.run = argv[++i];
    else if (x === '--json') a.json = true;
    else if (x === '--in-place') a.inPlace = true;
    else if (x === '--no-install') a.install = false;
    else if (!a.projectDir) a.projectDir = x;
  }
  return a;
}

/** CODEX ronde-3 #11 (2026-08-06): shell:true concateneerde OVERAL de argumenten door een echte shell —
 *  een projectpad met `&`, spaties of quotes was bij de git-aanroepen (pad als ARGUMENT) quoting-breekbaar
 *  en command-injecteerbaar. Alle git-aanroepen draaien nu shell-loos. npm is de ene uitzondering: Node
 *  20+ weigert een .cmd/.bat zonder shell (EINVAL, CVE-2024-27980-mitigatie), dus npm houdt op Windows
 *  zijn shell — veilig omdat elk npm-argument hier een VASTE string is ('ci', 'run', 'build', 'test',
 *  '--no-audit'...) en het projectpad alleen als cwd meegaat, dat nooit door de shell geparst wordt. */
function run(cmd, args, cwd, timeoutMs) {
  const needsShell = process.platform === 'win32' && cmd === 'npm';
  const r = spawnSync(cmd, args, { cwd, shell: needsShell, encoding: 'utf8', timeout: timeoutMs || 600000 });
  const out = ((r.stdout || '') + (r.stderr || ''));
  return { cmd: cmd + ' ' + args.join(' '), code: r.status == null ? -1 : r.status, out, timedOut: !!r.error && /ETIMEDOUT|timed?out/i.test(String(r.error)) };
}

// Best-effort test-count parse across common JS runners (vitest/jest/mocha/tap/playwright).
function parseTestCounts(out) {
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  let passed = num(/(\d+)\s+passed/i);
  let failed = num(/(\d+)\s+failed/i);
  if (passed == null) passed = num(/(\d+)\s+passing/i);        // mocha
  if (failed == null) failed = num(/(\d+)\s+failing/i);        // mocha
  if (passed == null) passed = num(/#\s*pass\s+(\d+)/i);       // TAP
  if (failed == null) failed = num(/#\s*fail\s+(\d+)/i);       // TAP
  return { passed, failed, parseable: passed != null || failed != null };
}

function isGitRepo(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return r.status === 0 && /true/.test(r.stdout || '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = { tool: 'forge-integrate', project: null, hermetic: false, worktree: null, steps: [], testCounts: null, verdict: 'skip', reason: '', generated_at: new Date().toISOString() };

  if (!args.projectDir) { console.error('usage: node forge-integrate.cjs <projectDir> [--run <id>] [--json] [--in-place] [--no-install]'); process.exit(2); }
  const projectDir = path.resolve(args.projectDir);
  result.project = projectDir;
  if (!fs.existsSync(projectDir)) { result.reason = 'project dir not found'; finish(result, args, 2); }

  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')); } catch { /* none */ }
  if (!pkg) { result.reason = 'no package.json — non-Node stack not supported by this gate (reported SKIP, not a fake pass)'; finish(result, args, 2); }
  const scripts = pkg.scripts || {};

  // Choose a hermetic workdir: a fresh detached git worktree if possible, else in place (flagged non-hermetic).
  /** THE WORKTREE MUST CARRY THE DIRTY STATE (broad Codex audit #26, fixed 2026-08-06).
   *  `worktree add --detach HEAD` checks out the LAST COMMIT — by definition without the uncommitted
   *  changes and untracked files this gate exists to judge: a Forge run writes code, does not commit yet,
   *  and runs this gate before claiming completion. Testing HEAD then green-lights the OLD code (even
   *  when the new code is completely broken) and can just as easily false-BLOCK a genuinely green fix.
   *  The worktree is therefore built from the REAL working tree: (1) tracked changes via a non-destructive
   *  `git stash create` (touches nothing in the owner's tree) checked out directly; (2) untracked,
   *  non-ignored files copied in via `git ls-files --others --exclude-standard`. If ANY snapshot step
   *  fails we fall back to running IN PLACE on the real tree — honest and correct — rather than silently
   *  testing a stale HEAD. The owner's working tree is never mutated: stash create writes only objects. */
  let workdir = projectDir;
  let cleanupWorktree = null;
  result.dirty = null;
  if (!args.inPlace && isGitRepo(projectDir)) {
    const st = spawnSync('git', ['-C', projectDir, 'status', '--porcelain'], { encoding: 'utf8' });
    const dirtyLines = st.status === 0 ? st.stdout.split(/\r?\n/).filter(Boolean) : null;
    result.dirty = dirtyLines ? dirtyLines.length : null;
    const wt = path.join(os.tmpdir(), 'forge-integrate-' + Date.now());
    // snapshot of tracked state: a stash commit when the tree is dirty, HEAD when it is clean.
    // CODEX ronde-3 #10 (2026-08-06): als `git status` zelf faalde bleef snapshotOk true en werd een
    // kale-HEAD-worktree alsnog als "hermetisch" getest terwijl de vuilheid ONBEKEND was — precies het
    // #26-defect langs een zijdeur. Onbekende vuilheid = in-place op de echte boom, nooit een gok.
    let ref = 'HEAD', snapshotOk = dirtyLines !== null;
    if (dirtyLines && dirtyLines.length) {
      const stash = spawnSync('git', ['-C', projectDir, 'stash', 'create'], { encoding: 'utf8' });
      const hash = stash.status === 0 ? stash.stdout.trim() : '';
      if (hash) ref = hash;
      else if (dirtyLines.some((l) => !l.startsWith('??'))) snapshotOk = false; // tracked changes exist but could not be snapshotted
    }
    if (snapshotOk) {
      const add = spawnSync('git', ['-C', projectDir, 'worktree', 'add', '--detach', wt, ref], { encoding: 'utf8' });
      if (add.status === 0) {
        /** CODEX ronde-3 #9 (2026-08-06): `worktree add` checkt de REPO-ROOT uit. Voor een project dat
         *  een SUBDIRECTORY van een monorepo is, wees workdir=wt dan naar de root — npm las daar de
         *  verkeerde package.json (een groene root-suite kon een rood subproject een vals PASS geven) en
         *  untracked bestanden belandden op het verkeerde niveau (`ls-files` geeft paden relatief aan de
         *  cwd-subdirectory). `--show-prefix` levert de subdirectory-prefix; workdir en de untracked-
         *  kopie gebruiken die allebei. Een lege prefix (project == repo-root) verandert niets. */
        const pfx = spawnSync('git', ['-C', projectDir, 'rev-parse', '--show-prefix'], { encoding: 'utf8' });
        const prefix = pfx.status === 0 ? pfx.stdout.trim().replace(/\/+$/, '') : null;
        let untrackedOk = prefix !== null, untrackedCount = 0;
        if (untrackedOk) {
          const ls = spawnSync('git', ['-C', projectDir, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' });
          if (ls.status === 0) {
            for (const rel of ls.stdout.split('\0').filter(Boolean)) {
              try {
                const dst = path.join(wt, prefix, rel);
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.copyFileSync(path.join(projectDir, rel), dst);
                untrackedCount++;
              } catch { untrackedOk = false; break; }
            }
          } else untrackedOk = false;
        }
        /** CRLF-FIDELITEIT (uitgesteld punt 4, gesloten 2026-08-06): `worktree add` is een CHECKOUT —
         *  smudge-filters en core.autocrlf/.gitattributes-EOL-regels kunnen de uitgecheckte bytes laten
         *  afwijken van wat er ECHT in de werkboom staat; EOL-gevoelige tests/hashes oordelen dan over
         *  andere bytes dan de owner heeft, onder een "hermetic"-label. De tracked-DIRTY bestanden worden
         *  daarom na de checkout byte-voor-byte uit de echte werkboom over de worktree gelegd (zelfde
         *  techniek als de untracked-kopie) en per bestand sha256-geverifieerd; elke afwijking of
         *  kopieerfout = worktree weg + eerlijk in-place op de echte boom. (-c core.autocrlf=false bij de
         *  checkout is bewust afgewezen: dat forceert de FILTERstand, niet de echte werkboombytes.) */
        let fidelityOk = true, overlaid = 0;
        if (untrackedOk && dirtyLines && dirtyLines.length) {
          /** Codex r4 #17 (2026-08-07): porcelain-v1-paden zijn ALTIJD relatief aan de REPO-ROOT, niet aan
           *  projectDir. In een monorepo (projectDir = <root>/packages/app) zocht de overlay daardoor naar
           *  <root>/packages/app/packages/app/... (bestond niet), nam de "deleted"-tak, liet de door de
           *  checkout genormaliseerde bytes staan en rapporteerde toch hermetic:true. Bron = repoRoot/rel,
           *  doel = wt/rel (de worktree IS een checkout van de repo-root) — het prefix hoort hier nergens. */
          const top = spawnSync('git', ['-C', projectDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
          const repoRoot = top.status === 0 ? top.stdout.trim() : null;
          if (!repoRoot) fidelityOk = false;
          const sha = (p2) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p2)).digest('hex'); } catch { return null; } };
          /** r5 #24 (2026-08-07): porcelain-v1 als TEKST parsen brak op bestandsnamen met ' -> ' (die
           *  werden als rename gesplitst en belandden in de deleted-tak onder een hermetic-label). De
           *  overlay leest nu `--porcelain=v1 -z`: NUL-gescheiden records, bij een rename volgt het
           *  OUDE pad als eigen NUL-record direct na het nieuwe. Typecontrole via lstat: een symlink
           *  in de dirty set is geen kandidaat voor een byte-overlay (fidelityOk=false -> eerlijk
           *  in-place), en een delete moet ECHT een delete zijn (lstat op de bron, geen existsSync-gok). */
          const stz = repoRoot ? spawnSync('git', ['-C', projectDir, 'status', '--porcelain=v1', '-z'], { encoding: 'utf8' }) : { status: 1 };
          if (stz.status !== 0) fidelityOk = false;
          if (fidelityOk && repoRoot) {
            const recs = stz.stdout.split(' ');
            for (let ri = 0; ri < recs.length; ri++) {
              const rec = recs[ri];
              if (!rec || rec.length < 4) continue;
              const xy = rec.slice(0, 2);
              let rel = rec.slice(3);
              if (xy.includes('?')) continue; // untracked is al byte-getrouw gekopieerd
              if (xy.includes('R') || xy.includes('C')) ri++; // volgend NUL-record is het OUDE pad — overslaan
              const srcP = path.join(repoRoot, rel);
              const dstP = path.join(wt, rel);
              try {
                let lst = null;
                try { lst = fs.lstatSync(srcP); } catch { lst = null; }
                if (lst === null) { try { fs.rmSync(dstP, { force: true }); } catch { } continue; } // echt verwijderd in de boom
                if (!lst.isFile()) { fidelityOk = false; break; } // symlink/dir in de dirty set: geen byte-overlay — eerlijk in-place
                fs.mkdirSync(path.dirname(dstP), { recursive: true });
                fs.copyFileSync(srcP, dstP);
                if (sha(srcP) !== sha(dstP)) { fidelityOk = false; break; }
                overlaid++;
              } catch { fidelityOk = false; break; }
            }
          }
        }
        if (untrackedOk && fidelityOk) {
          workdir = prefix ? path.join(wt, prefix) : wt; result.hermetic = true; result.worktree = wt;
          result.worktreeSource = (ref === 'HEAD' ? 'HEAD (clean tree)' : 'working-tree snapshot (stash ' + ref.slice(0, 12) + ' + ' + untrackedCount + ' untracked file(s))')
            + (prefix ? ' · subdir ' + prefix : '')
            + (overlaid ? ' · EOL-fideliteit geverifieerd (' + overlaid + ' dirty bestand(en) byte-exact overgelegd)' : '');
          cleanupWorktree = () => spawnSync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' });
        } else {
          // half a snapshot would quietly test the wrong tree — remove it and run on the real thing
          spawnSync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' });
        }
      }
    }
  }
  if (!result.hermetic) result.reason = result.dirty
    ? 'ran IN PLACE on the real (dirty) working tree — snapshotting it into a worktree was not possible, and testing a stale HEAD instead would verify the wrong code'
    : 'ran in place (not a git repo or --in-place) — less hermetic';

  const steps = [];
  const record = (label, r) => { const step = { label, cmd: r.cmd, exit_code: r.code, timedOut: r.timedOut, tail: r.out.slice(-1500) }; steps.push(step); return r; };

  // 1) install (from lockfile when present → reproducible)
  let installOk = true;
  if (args.install) {
    const hasLock = fs.existsSync(path.join(workdir, 'package-lock.json'));
    const inst = record('install', run('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund'], workdir, 600000));
    installOk = inst.code === 0;
  } else { steps.push({ label: 'install', cmd: '(skipped --no-install)', exit_code: 0 }); }

  // 2) build (only if a build script exists)
  let buildOk = true;
  if (scripts.build) { const b = record('build', run('npm', ['run', 'build'], workdir, 600000)); buildOk = b.code === 0; }
  else steps.push({ label: 'build', cmd: '(no build script)', exit_code: 0, skipped: true });

  // 3) test (only if a test script exists)
  let testOk = true, counts = { passed: null, failed: null, parseable: false };
  if (scripts.test) { const t = record('test', run('npm', ['test'], workdir, 600000)); counts = parseTestCounts(t.out); testOk = t.code === 0 && (counts.failed == null || counts.failed === 0); t.exit_code = t.code; }
  else steps.push({ label: 'test', cmd: '(no test script)', exit_code: 0, skipped: true });

  result.steps = steps;
  result.testCounts = counts;
  const failed = !(installOk && buildOk && testOk);
  // AUDIT FIX (2026-08-03): a project with no test script used to come out as verdict:"pass" with a
  // `quality_gate_passed` event carrying exit_code 0 — this tool, whose entire job is to turn an
  // ASSERTED green into an OBSERVED one, was emitting an observation of nothing at all. Nothing ran, so
  // nothing is verified: that is a third outcome, not a pass and not a failure. `blocked` would be a lie
  // in the other direction (nothing is broken), hence an explicit `not-verified` with a non-zero exit so
  // a caller that only checks the exit code is never told "verified".
  // A SCRIPT THAT EXITS 0 IS NOT EVIDENCE THAT TESTS RAN (broad Codex audit #3, fixed 2026-08-05).
  // The previous fix only caught a MISSING test script. `"test": "node -e \"process.exit(0)\""` — or the
  // npm default `echo "Error: no test specified" && exit 1` replaced with a no-op, or a runner that
  // silently matched zero files — still produced verdict:"pass". A gate whose whole purpose is to turn an
  // ASSERTED green into an OBSERVED one may not accept an exit code as the observation: it needs a real,
  // POSITIVE count of executed tests. No parseable count, or a parseable count of zero, is
  // `not-verified` — honest about what it does not know, and never a pass.
  const ranSomething = counts.parseable && Number.isFinite(counts.passed) && counts.passed > 0;
  const verified = !!scripts.test && ranSomething;
  result.verdict = failed ? 'blocked' : (verified ? 'pass' : 'not-verified');
  const passed = result.verdict === 'pass';
  if (failed) result.reason = [!installOk ? 'install failed' : '', !buildOk ? 'build failed' : '', !testOk ? 'tests failed' : ''].filter(Boolean).join('; ');
  else if (!scripts.test) result.reason = 'no test script in package.json — nothing was executed, so this gate verifies nothing (not a pass)';
  else if (!counts.parseable) result.reason = 'the test script exited 0 but printed no readable pass/fail tally — an exit code is not evidence that any test ran (not a pass)';
  else result.reason = 'the test script reported ' + (counts.passed === null ? 'no' : counts.passed) + ' passing tests — a run that executes zero tests verifies nothing (not a pass)';

  if (cleanupWorktree) cleanupWorktree();

  // Write artifact into the run's artifacts dir (durable proof), if a run id + forge-runs exist in the project.
  if (args.run && /^[A-Za-z0-9_-]+$/.test(args.run)) {
    const artDir = path.join(projectDir, '.claude', 'forge-runs', args.run, 'artifacts');
    try {
      fs.mkdirSync(artDir, { recursive: true });
      const artPath = path.join(artDir, 'integration-gate.json');
      fs.writeFileSync(artPath, JSON.stringify(result, null, 2), 'utf8');
      result.artifact = artPath;
      // Log a content-oracle-backed gate event (exit_code carried so the honesty gate can verify it).
      const logEvent = path.join(projectDir, '.claude', 'forge-dashboard', 'log-event.cjs');
      if (fs.existsSync(logEvent)) {
        const testStep = steps.find((s) => s.label === 'test') || { cmd: 'npm test', tail: '', exit_code: passed ? 0 : 1 };
        const payload = {
          agent: 'Integration Boss', role: 'integration-gate',
          command: testStep.cmd, output: (testStep.tail || '').slice(-400),
          evidence: artPath, exit_code: passed ? 0 : 1,
          note: 'hermetic integration gate ' + result.verdict
            + (result.verdict === 'not-verified' ? ' — nothing executed (' + result.reason + ')' : '')
            + (counts.parseable ? (' (' + (counts.passed || 0) + ' passed / ' + (counts.failed || 0) + ' failed)') : ''),
        };
        // A not-verified gate is logged as BLOCKED, never as passed: the dashboard and the run contract
        // must never see a green gate for a check that did not run (audit fix 2026-08-03).
        const logged = spawnSync(process.execPath, [logEvent, args.run, passed ? 'quality_gate_passed' : 'quality_gate_blocked', JSON.stringify(payload)], { encoding: 'utf8' });
        // A PASS whose proof could not be written is not a pass (broad Codex audit #27, fixed
        // 2026-08-05). The return code used to be ignored entirely, so a rejected/failing log-event left
        // the gate reporting success with no durable record anywhere — the one thing this gate exists to
        // produce. A blocked verdict is unaffected: it needs no proof to stand.
        if (logged && logged.status !== 0) result.event_error = 'log-event exited ' + logged.status + ': ' + String(logged.stderr || '').trim();
      }
      // Read the artifact back: writing it is not the same as it being there (an unwritable dir, a full
      // disk or a racing cleanup all end with "we said pass, and nothing recorded it").
      if (result.artifact && (!fs.existsSync(result.artifact) || fs.statSync(result.artifact).size === 0)) {
        result.artifact_error = 'the gate artifact was not readable back after writing (' + result.artifact + ')';
      }
    } catch (e) { result.artifact_error = String(e.message || e); }
  }
  // Demote a PASS whose durable proof failed. Honest third state again: the work may well be fine, but
  // this gate can no longer show it, and a gate that cannot show its evidence has not verified anything.
  if (result.verdict === 'pass' && (result.artifact_error || result.event_error)) {
    result.verdict = 'not-verified';
    result.reason = 'tests passed, but the durable proof could not be recorded (' + (result.artifact_error || result.event_error) + ') — a gate that cannot show its evidence has not verified anything';
  }

  // exit 0 ONLY for a genuinely verified pass; `not-verified` exits 3 so it is distinguishable from a
  // real failure (1) for a caller that reads exit codes rather than the JSON.
  // The exit code follows the FINAL verdict, including a pass demoted above because its proof could not
  // be recorded — otherwise a caller checking only the exit code would still be told "verified".
  finish(result, args, result.verdict === 'pass' ? 0 : (result.verdict === 'not-verified' ? 3 : 1));
}

function finish(result, args, code) {
  if (args && args.json) console.log(JSON.stringify(result, null, 2));
  else {
    const v = result.verdict.toUpperCase();
    console.log('forge-integrate: ' + v + (result.reason ? ' — ' + result.reason : ''));
    for (const s of result.steps) console.log('  ' + (s.exit_code === 0 ? '✓' : (s.skipped ? '·' : '✗')) + ' ' + s.label.padEnd(8) + (s.skipped ? s.cmd : ('exit ' + s.exit_code)));
    if (result.testCounts && result.testCounts.parseable) console.log('  tests: ' + (result.testCounts.passed || 0) + ' passed / ' + (result.testCounts.failed || 0) + ' failed');
    if (result.hermetic) console.log('  (hermetic: fresh git worktree)'); else if (result.reason && /in place/.test(result.reason)) console.log('  (non-hermetic: in place)');
  }
  process.exit(code);
}

main();
