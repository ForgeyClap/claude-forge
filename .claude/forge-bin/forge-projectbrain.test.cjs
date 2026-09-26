#!/usr/bin/env node
'use strict';
// forge-projectbrain.test.cjs — real hermetic tests for the project-CLAUDE.md generator (Piece P4, 2026-07-22).
// Uses os.mkdtemp fixtures for three real project shapes (Astro-ish website, plain node-tool, n8n-ish
// automation) so detectStack is proven against REAL files, never mocked. Proves the generated CLAUDE.md is
// NOT the thin "file-listing" anti-pattern (identity + Hard Rules + Governance + a project-flagged adapted
// rule + >800 chars), and that writeClaudeMd's safe-merge NEVER clobbers an existing, unmarked owner file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const PB = require('./forge-projectbrain.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-projectbrain.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }
function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

// ---------------------------------------------------------------------------------------------------------
// Fixtures — three real project shapes, built from real files (no mocking of fs)
// ---------------------------------------------------------------------------------------------------------
function makeAstroFixture() {
  const dir = freshDir('pb-astro');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@acme/astro-demo',
    description: 'A demo marketing site for Acme, built with Astro.',
    scripts: { dev: 'astro dev --port 4321', build: 'astro build', test: 'vitest run' },
    dependencies: { astro: '^4.0.0' },
    devDependencies: { vitest: '^1.0.0', '@playwright/test': '^1.40.0', eslint: '^9.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Astro Demo\nReal readme content.\n');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};\n');
  return dir;
}
function makeNodeFixture() {
  const dir = freshDir('pb-node');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'plain-node-tool',
    scripts: { start: 'node index.js', test: 'node test.js' },
    dependencies: {},
    devDependencies: {},
  }));
  return dir;
}
function makeN8nFixture() {
  const dir = freshDir('pb-n8n');
  fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workflows', 'lead-intake.json'), JSON.stringify({
    name: 'Lead Intake', nodes: [{ id: '1', type: 'n8n-nodes-base.webhook' }], connections: {},
  }));
  return dir;
}
function makeUnknownFixture() {
  const dir = freshDir('pb-unknown');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'just some notes, no package.json, no workflows');
  return dir;
}

console.log('forge-projectbrain tests');

// ---------------------------------------------------------------------------------------------------------
// 1) detectStack — real fixtures
// ---------------------------------------------------------------------------------------------------------
console.log('\n1) detectStack — real project fixtures');

const astroDir = makeAstroFixture();
const astro = PB.detectStack({ projectDir: astroDir });
t('astro fixture: name strips the npm scope', () => assert.strictEqual(astro.name, 'astro-demo'));
t('astro fixture: type detected as website', () => assert.strictEqual(astro.type, 'website'));
t('astro fixture: stack includes Astro', () => assert.ok(astro.stack.includes('Astro')));
t('astro fixture: test tooling includes Vitest and Playwright', () => assert.ok(astro.tooling.test.includes('Vitest') && astro.tooling.test.includes('Playwright')));
t('astro fixture: lint detected (eslint devDependency)', () => assert.strictEqual(astro.tooling.lint, true));
t('astro fixture: port 4321 detected from the real dev script', () => assert.ok(astro.ports.some((p) => p.port === 4321 && p.source === 'script:dev')));
t('astro fixture: real scripts are captured verbatim', () => assert.strictEqual(astro.scripts.dev, 'astro dev --port 4321'));

const nodeDir = makeNodeFixture();
const nodeTool = PB.detectStack({ projectDir: nodeDir });
t('node fixture: type detected as node-tool', () => assert.strictEqual(nodeTool.type, 'node-tool'));
t('node fixture: stack is empty (no framework deps)', () => assert.strictEqual(nodeTool.stack.length, 0));
t('node fixture: no ports detected -> honest note added, no invented default', () => assert.ok(nodeTool.ports.length === 0 && nodeTool.notes.some((n) => /no explicit port/.test(n))));

const n8nDir = makeN8nFixture();
const n8n = PB.detectStack({ projectDir: n8nDir });
t('n8n fixture: type detected as automation-n8n', () => assert.strictEqual(n8n.type, 'automation-n8n'));
t('n8n fixture: no package.json -> note added, never assumed', () => assert.ok(n8n.notes.some((n) => /no package.json/.test(n))));
t('n8n fixture: workflow export note names the real file', () => assert.ok(n8n.notes.some((n) => n.includes('lead-intake.json'))));

const unknownDir = makeUnknownFixture();
const unknown = PB.detectStack({ projectDir: unknownDir });
t('unknown fixture (no package.json, no workflow signal): type is "unknown"', () => assert.strictEqual(unknown.type, 'unknown'));

t('detectStack throws on a missing projectDir', () => {
  assert.throws(() => PB.detectStack({ projectDir: path.join(freshDir('pb-missing'), 'does-not-exist') }));
});
t('detectStack throws when projectDir is omitted', () => {
  assert.throws(() => PB.detectStack({}));
});
t('detectStack tolerates a malformed package.json (falls back to no-package-json heuristics, never throws)', () => {
  const dir = freshDir('pb-badpkg');
  fs.writeFileSync(path.join(dir, 'package.json'), '{ not valid json');
  const r = PB.detectStack({ projectDir: dir });
  assert.strictEqual(r.hasPackageJson, false);
});

// ---------------------------------------------------------------------------------------------------------
// 2) loadHardRules — universal defaults + optional project-local FORGE_PROJECT_HARD_RULES.json
// (renamed 2026-09-26, N9 laptop re-audit: the old name FORGE_HARD_RULES.json collided with Forge's own
// internal run-contract file at .claude/config/orchestration/FORGE_HARD_RULES.json — a different shape,
// a different purpose. See test at the bottom of this section that proves the collision is gone.)
// ---------------------------------------------------------------------------------------------------------
console.log('\n2) loadHardRules — defaults + project-local merge');

t('no FORGE_PROJECT_HARD_RULES.json present -> default-only, exactly the built-in universal rules', () => {
  const r = PB.loadHardRules({ projectDir: nodeDir });
  assert.strictEqual(r.source, 'default-only');
  assert.strictEqual(r.rules.length, PB.DEFAULT_HARD_RULES.length);
});
t('a project-local FORGE_PROJECT_HARD_RULES.json extends (not replaces) the defaults', () => {
  const dir = freshDir('pb-hardrules');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'FORGE_PROJECT_HARD_RULES.json'), JSON.stringify({
    rules: [{ id: 'no-lorem-ipsum', text: 'Never ship lorem ipsum placeholder copy to production.' }],
  }));
  const r = PB.loadHardRules({ projectDir: dir });
  assert.strictEqual(r.source, 'default+project-file');
  assert.strictEqual(r.rules.length, PB.DEFAULT_HARD_RULES.length + 1);
  assert.ok(r.rules.some((x) => x.id === 'no-lorem-ipsum'));
});
t('a project rule cannot silently shadow a universal default id (same id is ignored, not overridden)', () => {
  const dir = freshDir('pb-hardrules-shadow');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'FORGE_PROJECT_HARD_RULES.json'), JSON.stringify({
    rules: [{ id: 'honesty-core', text: 'a weakened override attempt' }],
  }));
  const r = PB.loadHardRules({ projectDir: dir });
  const honesty = r.rules.find((x) => x.id === 'honesty-core');
  assert.ok(!honesty.text.includes('weakened'));
  assert.strictEqual(r.rules.length, PB.DEFAULT_HARD_RULES.length);
});
t('a malformed FORGE_PROJECT_HARD_RULES.json throws (fail-closed, not silently ignored)', () => {
  const dir = freshDir('pb-hardrules-bad');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'FORGE_PROJECT_HARD_RULES.json'), '{ not valid json');
  assert.throws(() => PB.loadHardRules({ projectDir: dir }));
});
t('a FORGE_PROJECT_HARD_RULES.json rule missing "text" throws', () => {
  const dir = freshDir('pb-hardrules-missing');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'FORGE_PROJECT_HARD_RULES.json'), JSON.stringify({ rules: [{ id: 'x' }] }));
  assert.throws(() => PB.loadHardRules({ projectDir: dir }));
});
t('N9 regression: a real Forge orchestration FORGE_HARD_RULES.json (different shape, different path) never confuses loadHardRules', () => {
  const dir = freshDir('pb-hardrules-collision');
  fs.mkdirSync(path.join(dir, '.claude', 'config', 'orchestration'), { recursive: true });
  // Forge's OWN internal run-contract file: same basename as the pre-fix bug, a totally different shape
  // ({id,rule,trigger,...}, no "text" field) — before the rename this sat one path segment away from where
  // loadHardRules looked, so it was silently invisible; now it is a DIFFERENT file entirely and must stay so.
  fs.writeFileSync(path.join(dir, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({
    rules: [{ id: 'memory-read', rule: 'Project memory must be read before routing a run.', trigger: 'always' }],
  }));
  const r = PB.loadHardRules({ projectDir: dir });
  assert.strictEqual(r.source, 'default-only');
  assert.strictEqual(r.rules.length, PB.DEFAULT_HARD_RULES.length);
  assert.ok(!r.rules.some((x) => x.id === 'memory-read'));
});

// ---------------------------------------------------------------------------------------------------------
// 3) assemble — NOT thin: identity + Hard Rules + Governance + a [<project>]-flagged adapted rule + >800 chars
// ---------------------------------------------------------------------------------------------------------
console.log('\n3) assemble — generated CLAUDE.md is a real project brain, not a thin file list');

// EXCLUDED_PHRASES — the research is explicit these must NEVER appear in a generated CLAUDE.md: obvious
// advice a competent model already knows, and generic filler. Case-insensitive substring check.
const EXCLUDED_PHRASES = [
  'write clean code', 'follow best practices', 'as needed', 'good luck', 'happy coding',
];

function assertNotThin(md, projectName) {
  assert.ok(md.includes('## Project identity'), 'missing ## Project identity');
  assert.ok(md.includes('## Commands'), 'missing ## Commands (exact build/test/lint/run commands — highest ROI, core-framework item)');
  assert.ok(md.includes('## Architecture'), 'missing ## Architecture (key dirs, not prose)');
  assert.ok(md.includes('## Conventions'), 'missing ## Conventions (a linter can\'t enforce)');
  assert.ok(md.includes('## Boundaries'), 'missing ## Boundaries (off-limits dirs)');
  assert.ok(md.includes('## Detail docs'), 'missing ## Detail docs (pointers to detail docs)');
  assert.ok(md.includes('## Hard Rules'), 'missing ## Hard Rules');
  assert.ok(md.includes('## Governance'), 'missing ## Governance');
  assert.ok(md.includes('[' + projectName + ']'), 'missing at least one [' + projectName + ']-flagged adapted rule');
  assert.ok(md.length > 800, 'generated CLAUDE.md is only ' + md.length + ' chars — too thin');
  assert.ok(md.includes(PB.MARK_BEGIN) && md.includes(PB.MARK_END), 'missing Forge-managed markers');
  assert.ok(!/```/.test(md), 'generated CLAUDE.md must never contain a pasted fenced code block');
  const lower = md.toLowerCase();
  for (const phrase of EXCLUDED_PHRASES) {
    assert.ok(!lower.includes(phrase), 'generated CLAUDE.md contains excluded generic-advice phrase: "' + phrase + '"');
  }
}

t('website fixture (Astro): full project-brain shape + verbatim anti-generic guardrails', () => {
  const md = PB.assemble({ projectDir: astroDir });
  assertNotThin(md, astro.name);
  assert.ok(md.includes('Anti-Generic Guardrails'));
  assert.ok(md.includes('Never use flat `shadow-md`'));
  assert.ok(md.includes('## Frontend Website Rules'));
});
t('node-tool fixture: full project-brain shape (generic ruleset)', () => {
  const md = PB.assemble({ projectDir: nodeDir });
  assertNotThin(md, nodeTool.name);
  assert.ok(md.includes('## Project Rules'));
});
t('n8n fixture: full project-brain shape (n8n ruleset)', () => {
  const md = PB.assemble({ projectDir: n8nDir });
  assertNotThin(md, n8n.name);
  assert.ok(md.includes('## Automation (n8n) Rules'));
  assert.ok(md.includes('inactive by default'));
});
t('assemble accepts a pre-computed detected/hardRules pair without re-touching the filesystem', () => {
  const md = PB.assemble({ projectDir: nodeDir, detected: nodeTool, hardRules: PB.loadHardRules({ projectDir: nodeDir }) });
  assertNotThin(md, nodeTool.name);
});

// ---------------------------------------------------------------------------------------------------------
// 3b) research-enriched core-framework sections: description, versions, exact commands, architecture,
//     conventions, boundaries, detail docs (@-imports), and emphasis reserved for the 1-2 critical Hard Rules
// ---------------------------------------------------------------------------------------------------------
console.log('\n3b) research-enriched core-framework sections');

t('a real package.json "description" renders as the one-line project description (never fabricated)', () => {
  const md = PB.assemble({ projectDir: astroDir });
  assert.ok(md.includes('A demo marketing site for Acme, built with Astro.'), 'real description missing from output');
});
t('a project with NO package.json description never fabricates one', () => {
  const md = PB.assemble({ projectDir: nodeDir });
  assert.ok(!nodeTool.description, 'fixture sanity: node fixture truly has no description');
  // no assertion of absence-of-a-specific-string is meaningful here beyond the sanity check above —
  // the real proof is renderDescriptionLine() returning '' for a falsy description (unit-tested directly below).
});
t('renderDescriptionLine returns empty string when no description was detected (never invents one)', () => {
  assert.strictEqual(PB.renderDescriptionLine({ description: null }), '');
});
t('renderDescriptionLine renders the real description as a blockquote when present', () => {
  const out = PB.renderDescriptionLine({ description: 'Real one-liner.' });
  assert.ok(out.startsWith('> Real one-liner.'));
});

t('tech stack renders WITH the real literal declared version next to each framework', () => {
  const md = PB.assemble({ projectDir: astroDir });
  assert.ok(md.includes('Astro (^4.0.0)'), 'expected "Astro (^4.0.0)" with the literal declared version, got: ' + md.slice(0, 400));
});
t('fmtStackWithVersions falls back to a plain name when no version is known for a detected framework', () => {
  const out = PB.fmtStackWithVersions({ stack: ['Astro'], versions: {} });
  assert.strictEqual(out, 'Astro');
});

t('## Commands lists every real package.json script verbatim, near the top (before the environment ruleset)', () => {
  const md = PB.assemble({ projectDir: astroDir });
  assert.ok(md.includes('## Commands'));
  assert.ok(md.includes('`npm run dev` -> `astro dev --port 4321`'));
  assert.ok(md.includes('`npm run build` -> `astro build`'));
  assert.ok(md.includes('`npm run test` -> `vitest run`'));
  const commandsIdx = md.indexOf('## Commands');
  const rulesetIdx = md.indexOf('## Frontend Website Rules');
  assert.ok(commandsIdx > 0 && rulesetIdx > 0 && commandsIdx < rulesetIdx, '## Commands must appear before the environment ruleset (highest-ROI content near the top)');
});
t('## Commands honestly reports no scripts when none exist', () => {
  const md = PB.assemble({ projectDir: unknownDir });
  assert.ok(md.includes('none detected in package.json'));
});

t('## Architecture lists real top-level dirs with a real entry-file pointer when one exists', () => {
  const md = PB.assemble({ projectDir: astroDir });
  assert.ok(md.includes('## Architecture'));
  assert.ok(md.includes('`src/`'), 'expected the real src/ dir to be listed');
  assert.ok(md.includes('entry: `src/index.ts`'), 'expected a real file:path entry pointer, not prose');
});
t('## Architecture honestly reports no real dirs for a project with none', () => {
  const md = PB.assemble({ projectDir: unknownDir });
  assert.ok(md.includes('No real top-level source directories detected'));
});

t('## Conventions is stack-tied (mentions the real detected test tooling) and never a fabricated rule', () => {
  const md = PB.assemble({ projectDir: astroDir });
  assert.ok(md.includes('## Conventions'));
  assert.ok(/Vitest|Playwright/.test(md.slice(md.indexOf('## Conventions'), md.indexOf('## Conventions') + 400)));
});
t('## Conventions honestly flags missing test tooling for a project with none', () => {
  const md = PB.assemble({ projectDir: n8nDir });
  const section = md.slice(md.indexOf('## Conventions'), md.indexOf('## Conventions') + 400);
  assert.ok(/No test tooling detected/.test(section));
});

t('## Boundaries names this project\'s own `.claude/` as Forge machinery when a real .claude dir exists', () => {
  const dir = freshDir('pb-claudedir');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'has-claude-dir', scripts: {} }));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const md = PB.assemble({ projectDir: dir });
  assert.ok(md.includes('## Boundaries'));
  assert.ok(md.includes('.claude/` is Forge machinery'));
});
t('## Boundaries omits the .claude-specific note when no real .claude dir exists', () => {
  const md = PB.assemble({ projectDir: nodeDir });
  assert.ok(!md.includes('is Forge machinery'));
});

t('## Detail docs renders real docs as @-imports when a README.md exists', () => {
  const md = PB.assemble({ projectDir: astroDir });
  assert.ok(md.includes('## Detail docs'));
  assert.ok(md.includes('@README.md'));
});
t('## Detail docs honestly reports nothing found for a project with no README/docs', () => {
  const md = PB.assemble({ projectDir: nodeDir });
  assert.ok(md.includes('No `README.md` or `docs/*.md` found yet'));
});

t('Hard Rules emphasis is reserved for ONLY the 1-2 truly critical rule ids (honesty-core, project-isolation)', () => {
  const md = PB.assemble({ projectDir: nodeDir });
  assert.ok(md.includes('**IMPORTANT:** `[honesty-core]`'), 'honesty-core must carry the IMPORTANT emphasis');
  assert.ok(md.includes('**IMPORTANT:** `[project-isolation]`'), 'project-isolation must carry the IMPORTANT emphasis');
  assert.ok(!md.includes('**IMPORTANT:** `[secrets-in-env]`'), 'a non-critical rule must NOT carry the IMPORTANT emphasis');
  assert.ok(!md.includes('**IMPORTANT:** `[no-auto-push]`'), 'a non-critical rule must NOT carry the IMPORTANT emphasis');
  const importantCount = (md.match(/\*\*IMPORTANT:\*\*/g) || []).length;
  assert.strictEqual(importantCount, PB.EMPHASIZED_RULE_IDS.size, 'exactly the emphasized-rule-id count of IMPORTANT tags, no more, no less');
});

// ---------------------------------------------------------------------------------------------------------
// 4) writeClaudeMd — safe-merge, never a blind overwrite
// ---------------------------------------------------------------------------------------------------------
console.log('\n4) writeClaudeMd — safe-merge never clobbers an existing CLAUDE.md');

t('fresh outPath (no existing file) -> created', () => {
  const dir = freshDir('pb-write-fresh');
  const outPath = path.join(dir, 'CLAUDE.md');
  const generated = PB.assemble({ projectDir: nodeDir });
  const r = PB.writeClaudeMd({ outPath, generated });
  assert.strictEqual(r.written, true);
  assert.strictEqual(r.status, 'created');
  assert.strictEqual(fs.readFileSync(outPath, 'utf8'), generated);
});

t('existing file WITH markers -> safe-merge replaces only the marked region, owner text outside preserved', () => {
  const dir = freshDir('pb-write-merge');
  const outPath = path.join(dir, 'CLAUDE.md');
  const before = '# Owner preamble\nOwner-specific notes stay here.\n\n';
  const after = '\n\n# Owner appendix\nMore owner notes below the Forge section.\n';
  fs.writeFileSync(outPath, before + PB.MARK_BEGIN + '\nOLD GENERATED CONTENT\n' + PB.MARK_END + after);
  const generated = PB.assemble({ projectDir: nodeDir });
  const r = PB.writeClaudeMd({ outPath, generated });
  assert.strictEqual(r.status, 'merged');
  const final = fs.readFileSync(outPath, 'utf8');
  assert.ok(final.startsWith(before), 'owner preamble was not preserved');
  assert.ok(final.endsWith(after), 'owner appendix was not preserved');
  assert.ok(!final.includes('OLD GENERATED CONTENT'), 'old marked region was not replaced');
  assert.ok(final.includes('## Project identity'), 'new generated content missing from merge');
});

t('existing file WITHOUT markers, no force -> REFUSED, file left byte-for-byte unchanged', () => {
  const dir = freshDir('pb-write-refuse');
  const outPath = path.join(dir, 'CLAUDE.md');
  const ownerContent = '# CLAUDE.md — hand-written by the owner\nOwner rules, no Forge markers here.\n';
  fs.writeFileSync(outPath, ownerContent);
  const generated = PB.assemble({ projectDir: nodeDir });
  const r = PB.writeClaudeMd({ outPath, generated });
  assert.strictEqual(r.written, false);
  assert.strictEqual(r.status, 'refused');
  assert.ok(/no Forge-managed markers/.test(r.reason));
  assert.strictEqual(fs.readFileSync(outPath, 'utf8'), ownerContent, 'refused write must leave the file byte-for-byte unchanged');
});

t('existing file WITHOUT markers, force:true -> explicit full overwrite', () => {
  const dir = freshDir('pb-write-force');
  const outPath = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(outPath, '# hand-written, no markers\n');
  const generated = PB.assemble({ projectDir: nodeDir });
  const r = PB.writeClaudeMd({ outPath, generated, force: true });
  assert.strictEqual(r.status, 'overwritten-forced');
  assert.strictEqual(fs.readFileSync(outPath, 'utf8'), generated);
});

t('writeClaudeMd throws when outPath or generated is missing', () => {
  assert.throws(() => PB.writeClaudeMd({ generated: 'x' }));
  assert.throws(() => PB.writeClaudeMd({ outPath: '/x/y' }));
});

// ---------------------------------------------------------------------------------------------------------
// 5) CLI — real spawned subprocess, exit codes 0 / 2 / 3
// ---------------------------------------------------------------------------------------------------------
console.log('\n5) CLI (real spawned subprocess)');

t('CLI detect --json on the Astro fixture reports type website', () => {
  const r = runCLI(['detect', '--dir', astroDir, '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.type, 'website');
  assert.ok(parsed.ports.some((p) => p.port === 4321));
});
t('CLI detect without --dir exits 2 (usage error)', () => {
  const r = runCLI(['detect']);
  assert.strictEqual(r.status, 2);
});
t('CLI generate without --out prints the generated CLAUDE.md to stdout and never writes a file', () => {
  const r = runCLI(['generate', '--dir', nodeDir]);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('# CLAUDE.md —'));
  assert.ok(r.stdout.includes('## Hard Rules'));
});
t('CLI generate --out on a fresh path creates the file (exit 0)', () => {
  const dir = freshDir('pb-cli-fresh');
  const outPath = path.join(dir, 'CLAUDE.md');
  const r = runCLI(['generate', '--dir', nodeDir, '--out', outPath]);
  assert.strictEqual(r.status, 0);
  assert.ok(fs.existsSync(outPath));
});
t('CLI generate --out on an existing unmarked file without --force exits 3 and leaves the file untouched', () => {
  const dir = freshDir('pb-cli-refuse');
  const outPath = path.join(dir, 'CLAUDE.md');
  const ownerContent = '# owner CLAUDE.md, no markers\n';
  fs.writeFileSync(outPath, ownerContent);
  const r = runCLI(['generate', '--dir', nodeDir, '--out', outPath]);
  assert.strictEqual(r.status, 3);
  assert.strictEqual(fs.readFileSync(outPath, 'utf8'), ownerContent);
});
t('CLI generate --out on an existing unmarked file WITH --force overwrites (exit 0)', () => {
  const dir = freshDir('pb-cli-force');
  const outPath = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(outPath, '# owner CLAUDE.md, no markers\n');
  const r = runCLI(['generate', '--dir', nodeDir, '--out', outPath, '--force']);
  assert.strictEqual(r.status, 0);
  assert.ok(fs.readFileSync(outPath, 'utf8').includes('## Project identity'));
});
t('CLI generate without --dir exits 2', () => {
  const r = runCLI(['generate']);
  assert.strictEqual(r.status, 2);
});
t('CLI with an unknown command exits 2', () => {
  const r = runCLI(['bogus']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
