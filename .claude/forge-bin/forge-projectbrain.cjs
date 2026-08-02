#!/usr/bin/env node
'use strict';
/**
 * forge-projectbrain.cjs — top-tier project-CLAUDE.md generator (Piece P4, 2026-07-22; RESEARCH-ENRICHED
 * 2026-07-22 — applying the V9 deep-research pass on Anthropic/community CLAUDE.md best practices, see
 * scratchpad v9-deep-knowledge.json `claudemd_best_practices`). Turns the "AutoWeb" gold-standard pattern (a
 * real PROJECT BRAIN — identity + adapted environment rules + verbatim anti-generic guardrails + a real Hard
 * Rules section + Governance) into a repeatable, zero-dependency method any Forge project can run, instead of
 * the thin "bullet list of files" CLAUDE.md anti-pattern. Companion doc: skills/forge-projectbrain/SKILL.md
 * (the method) and skills/forge-projectbrain/template.md (the annotated template this generator's output
 * structurally matches). Zero-dependency (fs/path/child_process only).
 *
 * RESEARCH-DRIVEN DESIGN (why the output looks the way it does):
 *   - Five-part core framework (dev.to "CLAUDE.md Best Practices Complete 2026 Guide"): one-line description,
 *     tech stack WITH versions, EXACT commands, architecture as key dirs (not prose), conventions a linter
 *     can't enforce — plus boundaries and pointers to detail docs. `assemble()` renders these as their own
 *     `## Commands` / `## Architecture` / `## Conventions` / `## Boundaries` / `## Detail docs` sections, in
 *     that order, right after `## Project identity` and before the environment-specific ruleset — commands
 *     are the highest-ROI content (an agent that knows the real command makes fewer mistakes than one that
 *     guesses), so they sit near the top, not buried after a long domain ruleset.
 *   - EXCLUDE list (never rendered): anything derivable from the code itself, standard conventions Claude
 *     already knows, file-by-file listings, pasted code blocks, frequently-changing info, and "obvious advice"
 *     phrasing ("write clean code", "follow best practices"). Every render* function below only ever states a
 *     REAL detected fact or a genuinely non-obvious non-negotiable — never filler.
 *   - The prune test ("would omitting this cause Claude to make mistakes? if not, cut it") and imperative
 *     language ("never/always", not "we prefer") are applied throughout every render* function's wording.
 *   - Emphasis discipline: `EMPHASIZED_RULE_IDS` reserves IMPORTANT-style emphasis for exactly the 1-2 truly
 *     critical Hard Rules (honesty-core, project-isolation) — research shows diluting emphasis across every
 *     line makes readers (and models) stop noticing it.
 *   - `## Detail docs` uses real `@path` imports (Claude Code's own import syntax) instead of a bare "see the
 *     docs" mention — but the section's own note is honest that `@`-imports load automatically alongside this
 *     file (buying organization, not a context-budget saving), which is NOT the same guarantee a Skill gets
 *     (Skills are progressive-disclosure/trigger-matched and, per the research, are NOT reliably auto-invoked
 *     — Vercel evals measured 56% non-invocation). This is why every environment ruleset below states its
 *     rules as sharp, explicit, always-loaded text (e.g. "Apply the frontend-design method before writing ANY
 *     frontend code") instead of a bare pointer like "see the frontend-design skill."
 *
 * MODEL:
 *   detectStack({ projectDir }, opts) -> { name, type, description, stack, versions, scripts, ports, tooling,
 *     hasPackageJson, notes, dirs, docs, hasClaudeDir }
 *     Reads ONLY real files under projectDir — package.json (name/description/scripts/dependencies/
 *     devDependencies — `versions` is the LITERAL declared semver range per framework, never a resolved/
 *     guessed installed version), known eslint config filenames, a `.env.example` PORT= line, a `workflows/`
 *     (or `workflow/`, `.n8n/workflows/`) directory whose *.json files structurally look like an n8n workflow
 *     export ({nodes:[...], connections:{}}), up to 5 real top-level source dirs (`dirs`, noise/build dirs
 *     excluded — see NOISE_DIRS), up to 4 real detail docs (`docs` — README.md + docs/*.md), and whether a
 *     real `.claude/` directory exists (`hasClaudeDir`). NEVER assumes a framework's conventional default
 *     port — a port is only reported when it is literally found in a script string or `.env.example`;
 *     otherwise `ports` is empty and a note says so explicitly (never invent facts about a project we haven't
 *     inspected). `type` is one of: 'website', 'fullstack', 'automation-n8n', 'desktop-electron', 'node-tool',
 *     'unknown' (no package.json AND no other signal).
 *
 *   loadHardRules({ projectDir }, opts) -> { rules:[{id,text}], source:'default-only'|'default+project-file', path }
 *     `rules` always starts from DEFAULT_HARD_RULES (this Forge system's universal non-negotiables — project
 *     isolation, honesty core, secrets-in-env, no-auto-push, input validation, file-size discipline). If
 *     `<projectDir>/.claude/FORGE_HARD_RULES.json` (or opts.hardRulesPath) exists, it is parsed as either a
 *     plain array or `{rules:[...]}` of `{id,text}` entries and MERGED in (a project-supplied id can extend
 *     the list but never silently overrides/removes a universal default id) — this is the "machine-checkable
 *     non-negotiables" file a future doctor pass can read. Malformed config THROWS (fail-closed, same
 *     discipline forge-evidence.cjs/forge-actiongate.cjs use for their own config files) rather than silently
 *     falling back — a broken hard-rules file should never look like "no extra rules".
 *
 *   assemble({ projectDir, detected, hardRules }, opts) -> string (a complete generated CLAUDE.md)
 *     Picks ONE environment ruleset by detected.type (website / n8n / fullstack / generic node-tool), adapts
 *     its Local-Server/Output-Defaults/domain-specific lines to the REAL detected scripts/ports/stack (each
 *     adaptation flagged `` `[<name>]` `` so it reads as true for THIS project, mirroring AutoWeb's
 *     `[AutoWeb]` flags), keeps the anti-generic guardrails block VERBATIM for website-flavored projects, and
 *     always emits (in order): an optional one-line description, `## Project identity`, `## Commands`,
 *     `## Architecture`, `## Conventions`, the environment ruleset, `## Boundaries`, `## Detail docs`,
 *     `## Hard Rules` (from loadHardRules, with emphasis reserved per EMPHASIZED_RULE_IDS), and `## Governance`.
 *     The whole document is wrapped in `MARK_BEGIN`/`MARK_END` markers so a later run can safely re-generate
 *     just the Forge-managed region of an existing file (see writeClaudeMd).
 *
 *   writeClaudeMd({ outPath, generated, force }, opts) -> { written, status, path, reason? }
 *     SAFE-MERGE, never a blind overwrite of an owner's file:
 *       - outPath doesn't exist            -> writes it, status 'created'.
 *       - outPath exists WITH the markers  -> replaces ONLY the marked region, status 'merged' (everything
 *                                             the owner wrote before/after the markers is preserved verbatim).
 *       - outPath exists WITHOUT markers,
 *         force falsy                      -> refuses, writes nothing, status 'refused' (+ reason).
 *       - outPath exists WITHOUT markers,
 *         force truthy                     -> full overwrite, status 'overwritten-forced' (explicit opt-in).
 *
 * CLI:
 *   node forge-projectbrain.cjs detect --dir <d> [--json]
 *   node forge-projectbrain.cjs generate --dir <d> [--out <file>] [--force] [--json]
 *     Without --out, generate only PRINTS to stdout — it never writes. With --out it writes via writeClaudeMd
 *     above. Exit codes: 0 = ok · 3 = generate refused an unmarked existing file (use --force) · 2 = usage/
 *     config error.
 *
 * EVENT NOTE: event_type "projectbrain_generated" IS registered in log-event.cjs's KNOWN_EVENT_TYPES (added by
 * V9-integrate), but this module still deliberately does NOT spawn log-event.cjs itself — same doctrine as
 * forge-scout.cjs/forge-capabilities.cjs: the CALLING Boss/skill step owns the real log-event call site (this
 * keeps the generator a pure, side-effect-free-on-events string builder + file writer, testable without a
 * log-event.cjs fixture at all).
 */
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------------------------------------
// detectStack — real-file-only stack detection
// ---------------------------------------------------------------------------------------------------------
function safeReadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

const FRAMEWORK_MAP = [
  ['astro', 'Astro'], ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['vite', 'Vite'], ['react', 'React'],
  ['vue', 'Vue'], ['@sveltejs/kit', 'SvelteKit'], ['svelte', 'Svelte'], ['electron', 'Electron'],
  ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['@angular/core', 'Angular'],
];
const FRONTEND_FRAMEWORKS = ['Astro', 'Next.js', 'Nuxt', 'Vite', 'React', 'Vue', 'SvelteKit', 'Svelte', 'Angular'];
const BACKEND_FRAMEWORKS = ['Express', 'Fastify', 'NestJS'];

function detectFrameworks(deps) {
  const out = [];
  for (const [key, label] of FRAMEWORK_MAP) if (deps[key]) out.push(label);
  return out;
}

function detectTooling(deps, projectDir) {
  const test = [];
  if (deps.vitest) test.push('Vitest');
  if (deps.jest) test.push('Jest');
  if (deps.mocha) test.push('Mocha');
  if (deps['@playwright/test'] || deps.playwright) test.push('Playwright');
  if (deps.cypress) test.push('Cypress');
  const lintConfigFiles = ['.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];
  const lint = !!(deps.eslint || lintConfigFiles.some((f) => fs.existsSync(path.join(projectDir, f))));
  const build = [];
  if (deps.turbo) build.push('Turborepo');
  if (deps.vite) build.push('Vite');
  if (deps.webpack) build.push('Webpack');
  if (deps.typescript) build.push('TypeScript (tsc)');
  return { test, lint, build };
}

function detectN8n(projectDir) {
  for (const dir of ['workflows', 'workflow', path.join('.n8n', 'workflows')]) {
    const p = path.join(projectDir, dir);
    if (!isDir(p)) continue;
    let entries = [];
    try { entries = fs.readdirSync(p).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of entries) {
      const obj = safeReadJSON(path.join(p, f));
      if (obj && Array.isArray(obj.nodes) && obj.connections && typeof obj.connections === 'object') {
        return { found: true, dir, file: f };
      }
    }
  }
  return { found: false };
}

function extractScriptPorts(scripts) {
  const found = [];
  for (const [name, cmd] of Object.entries(scripts || {})) {
    if (typeof cmd !== 'string') continue;
    const m1 = cmd.match(/--port[= ]+(\d{2,5})/);
    if (m1) found.push({ port: Number(m1[1]), source: 'script:' + name });
    const m2 = cmd.match(/\bPORT=(\d{2,5})\b/);
    if (m2) found.push({ port: Number(m2[1]), source: 'script:' + name });
  }
  return found;
}

function extractEnvPort(projectDir) {
  const p = path.join(projectDir, '.env.example');
  if (!fs.existsSync(p)) return null;
  let content;
  try { content = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const m = content.match(/^\s*PORT\s*=\s*(\d{2,5})/m);
  return m ? { port: Number(m[1]), source: '.env.example' } : null;
}

/** detectVersions(deps) -> {label: declaredSemverRangeString}. Reports the LITERAL string declared in
 *  package.json (e.g. "^4.0.0") — never resolves/guesses an installed version, matching the "never invent a
 *  fact the real file doesn't show" discipline the whole module follows. */
function detectVersions(deps) {
  const out = {};
  for (const [key, label] of FRAMEWORK_MAP) if (deps[key]) out[label] = deps[key];
  return out;
}

// Directories excluded from "## Architecture" detection: build output, dependency caches, and Forge's own
// machinery (.claude) — architecture should point at the PRODUCT's real source layout, not tooling noise.
const NOISE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.astro', '.output', 'coverage', '.vercel', '.cache',
  'out', 'target', 'venv', '.venv', '__pycache__', '.turbo', '.vscode', '.idea', '.claude', '.github',
]);
const ENTRY_FILE_CANDIDATES = [
  'index.js', 'index.ts', 'index.mjs', 'index.cjs', 'main.js', 'main.ts', 'main.py', 'app.js', 'app.ts',
  '__init__.py', 'server.js', 'server.ts',
];

/** detectKeyDirs(projectDir) -> [{dir, fileCount, entryFile}], up to 5, real top-level dirs only (never a
 *  fabricated "typical" layout). `entryFile` is only set when a real, known entry-filename literally exists
 *  directly inside that directory — never inferred from directory name alone. */
function detectKeyDirs(projectDir) {
  let entries = [];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return []; }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NOISE_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
  const out = [];
  for (const d of dirs.slice(0, 5)) {
    const full = path.join(projectDir, d);
    let fileCount = 0;
    try { fileCount = fs.readdirSync(full).length; } catch { fileCount = 0; }
    let entryFile = null;
    for (const cand of ENTRY_FILE_CANDIDATES) {
      if (fs.existsSync(path.join(full, cand))) { entryFile = cand; break; }
    }
    out.push({ dir: d, fileCount, entryFile });
  }
  return out;
}

/** detectDetailDocs(projectDir) -> [relPath, ...], up to 4. Only real, already-existing docs (README.md at
 *  root, up to 3 *.md files directly under docs/) — this is what makes the generated CLAUDE.md's "Detail
 *  docs" section a set of real @-imports, never a pointer to a file that doesn't exist. */
function detectDetailDocs(projectDir) {
  const found = [];
  if (fs.existsSync(path.join(projectDir, 'README.md'))) found.push('README.md');
  const docsDir = path.join(projectDir, 'docs');
  if (isDir(docsDir)) {
    let files = [];
    try { files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')); } catch { files = []; }
    for (const f of files.sort().slice(0, 3)) found.push('docs/' + f);
  }
  return found.slice(0, 4);
}

/** detectStack — see file header MODEL section. Throws only on a missing/invalid projectDir. */
function detectStack(params, opts) {
  params = params || {};
  if (!params.projectDir) throw new Error('forge-projectbrain: detectStack() requires projectDir');
  const projectDir = path.resolve(String(params.projectDir));
  if (!isDir(projectDir)) throw new Error('forge-projectbrain: projectDir does not exist or is not a directory: ' + projectDir);

  const pkgPath = path.join(projectDir, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? safeReadJSON(pkgPath) : null;
  const scripts = (pkg && pkg.scripts) || {};
  const deps = Object.assign({}, pkg && pkg.dependencies, pkg && pkg.devDependencies);
  const name = pkg && pkg.name ? String(pkg.name).replace(/^@[^/]+\//, '') : path.basename(projectDir);
  const description = (pkg && typeof pkg.description === 'string' && pkg.description.trim()) ? pkg.description.trim() : null;

  const stack = detectFrameworks(deps);
  const versions = detectVersions(deps);
  const tooling = detectTooling(deps, projectDir);
  const n8n = detectN8n(projectDir);
  const ports = extractScriptPorts(scripts);
  const envPort = extractEnvPort(projectDir);
  if (envPort) ports.push(envPort);
  const dirs = detectKeyDirs(projectDir);
  const docs = detectDetailDocs(projectDir);
  const hasClaudeDir = isDir(path.join(projectDir, '.claude'));

  const hasFrontend = stack.some((f) => FRONTEND_FRAMEWORKS.includes(f));
  const hasBackend = stack.some((f) => BACKEND_FRAMEWORKS.includes(f));
  const isElectron = stack.includes('Electron');
  const isN8n = n8n.found || !!deps.n8n;

  let type;
  if (isN8n) type = 'automation-n8n';
  else if (isElectron) type = 'desktop-electron';
  else if (hasFrontend && hasBackend) type = 'fullstack';
  else if (hasFrontend) type = 'website';
  else if (pkg) type = 'node-tool';
  else type = 'unknown';

  const notes = [];
  if (!pkg) notes.push('no package.json found — stack detection limited to filesystem heuristics');
  if (ports.length === 0) notes.push('no explicit port found in scripts/.env.example — verify the real dev port at runtime, never assume a framework default');
  if (n8n.found) notes.push('n8n workflow export detected at ' + n8n.dir + '/' + n8n.file);

  return { name, type, description, stack, versions, scripts, ports, tooling, hasPackageJson: !!pkg, notes, dirs, docs, hasClaudeDir };
}

// ---------------------------------------------------------------------------------------------------------
// loadHardRules — universal defaults + optional project-local FORGE_HARD_RULES.json
// ---------------------------------------------------------------------------------------------------------
const DEFAULT_HARD_RULES = [
  { id: 'project-isolation', text: 'Work only inside this project folder. Never edit unrelated projects or global Claude/ECC config without explicit owner approval.' },
  { id: 'honesty-core', text: 'Never claim a build/test/check/screenshot ran unless it actually ran — quote real output, never an assumption.' },
  { id: 'secrets-in-env', text: 'Secrets live in `.env` (git-ignored) only, mirrored as placeholders in `.env.example` — never hardcoded, never committed.' },
  { id: 'no-auto-push', text: 'Never auto-push, force-push, deploy, or activate production without explicit, current owner approval.' },
  { id: 'input-validation', text: 'Validate input at every system boundary (API routes, forms, webhooks, CLI args) — never trust external data.' },
  { id: 'file-size', text: 'Keep files focused and reasonably sized; extract modules instead of letting one file sprawl.' },
];

/** loadHardRules — see file header MODEL section. Throws on a malformed project-local hard-rules file
 *  (fail-closed, matches forge-evidence.cjs/forge-actiongate.cjs's own config-integrity discipline). */
function loadHardRules(params, opts) {
  params = params || {}; opts = opts || {};
  const rules = DEFAULT_HARD_RULES.slice();
  let source = 'default-only';
  const rulesPath = opts.hardRulesPath
    || (params.projectDir ? path.join(path.resolve(params.projectDir), '.claude', 'FORGE_HARD_RULES.json') : null);

  if (rulesPath && fs.existsSync(rulesPath)) {
    let raw;
    try { raw = fs.readFileSync(rulesPath, 'utf8'); }
    catch (e) { throw new Error('forge-projectbrain: cannot read ' + rulesPath + ': ' + e.message); }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error('forge-projectbrain: ' + rulesPath + ' is not valid JSON: ' + e.message); }
    const extra = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rules) ? parsed.rules : null);
    if (!extra) throw new Error('forge-projectbrain: ' + rulesPath + ' must be an array or {rules:[...]} of {id,text} entries');
    const seen = new Set(rules.map((r) => r.id));
    for (const r of extra) {
      if (!r || !r.id || !r.text) throw new Error('forge-projectbrain: a rule entry in ' + rulesPath + ' is missing id/text: ' + JSON.stringify(r));
      if (seen.has(r.id)) continue; // a project can extend the list but never silently shadow a universal id
      rules.push({ id: r.id, text: r.text });
      seen.add(r.id);
    }
    source = 'default+project-file';
  }
  return { rules, source, path: rulesPath };
}

// ---------------------------------------------------------------------------------------------------------
// assemble — render the CLAUDE.md body from detected stack + hard rules
// ---------------------------------------------------------------------------------------------------------
const ANTI_GENERIC_GUARDRAILS_MD =
  '## Anti-Generic Guardrails  *(kept verbatim — the core)*\n' +
  '- **Colors:** Never use default Tailwind palette (indigo-500, blue-600, etc.). Pick a custom brand color and derive from it.\n' +
  '- **Shadows:** Never use flat `shadow-md`. Use layered, color-tinted shadows with low opacity.\n' +
  '- **Typography:** Never use the same font for headings and body. Pair a display/serif with a clean sans. Apply tight tracking (`-0.03em`) on large headings, generous line-height (`1.7`) on body.\n' +
  '- **Gradients:** Layer multiple radial gradients. Add grain/texture via SVG noise filter for depth.\n' +
  '- **Animations:** Only animate `transform` and `opacity`. Never `transition-all`. Use spring-style easing.\n' +
  '- **Interactive states:** Every clickable element needs hover, focus-visible, and active states. No exceptions.\n' +
  '- **Images:** Add a gradient overlay (`bg-gradient-to-t from-black/60`) and a color treatment layer with `mix-blend-multiply`.\n' +
  '- **Spacing:** Use intentional, consistent spacing tokens — not random Tailwind steps.\n' +
  '- **Depth:** Surfaces should have a layering system (base → elevated → floating), not all sit at the same z-plane.';

function fmtList(arr, empty) { return arr && arr.length ? arr.join(', ') : empty; }

/** fmtStackWithVersions — renders each detected framework alongside its LITERAL declared package.json
 *  semver range (e.g. "Astro (^4.0.0)") when known, plain name otherwise. Never resolves/guesses an
 *  installed version — same "only claim what a real file proves" discipline as detectVersions() itself. */
function fmtStackWithVersions(detected) {
  if (!detected.stack || !detected.stack.length) return 'none detected';
  return detected.stack.map((label) => {
    const v = detected.versions && detected.versions[label];
    return v ? label + ' (' + v + ')' : label;
  }).join(', ');
}

/** renderDescriptionLine — the ONE-LINE project description core-framework item. Only emitted when a real
 *  package.json "description" field exists (never fabricated); omitted entirely otherwise rather than
 *  inventing a plausible-sounding summary. */
function renderDescriptionLine(detected) {
  return detected.description ? '> ' + detected.description + '\n\n' : '';
}

function renderIdentity(name, detected) {
  const portLine = detected.ports.length
    ? detected.ports.map((p) => p.port + ' (' + p.source + ')').join(', ')
    : 'not detected — verify at runtime, never assume a framework default';
  const noteLines = detected.notes.length ? detected.notes.map((n) => '- Note: ' + n).join('\n') + '\n' : '';
  return '## Project identity\n' +
    '- **' + name + '** — detected type: **' + detected.type + '**.\n' +
    '- Detected stack: ' + fmtStackWithVersions(detected) + '. Test tooling: ' + fmtList(detected.tooling.test, 'none detected') +
    '. Lint configured: ' + (detected.tooling.lint ? 'yes' : 'not detected') + '. Build tooling: ' + fmtList(detected.tooling.build, 'none detected') + '.\n' +
    '- Detected port(s): ' + portLine + '.\n' + noteLines;
}

/** renderCommandsSection — the EXACT build/test/lint/run/deploy commands core-framework item, placed near
 *  the top of the document (highest-ROI content per the research: an agent that knows the real command to
 *  run makes fewer mistakes than one that has to guess). Every command is the real, verbatim package.json
 *  script string — never a framework's conventional guess. */
function renderCommandsSection(detected) {
  const entries = Object.entries(detected.scripts || {});
  const lines = entries.length
    ? entries.map(([k, v]) => '- `npm run ' + k + '` -> `' + v + '`').join('\n')
    : '- none detected in package.json — confirm the real build/test/lint/run commands by hand before claiming a change is done.';
  return '## Commands\n' +
    'Real, verbatim `package.json` scripts — run these for real before calling any change done, never assume green.\n\n' +
    lines;
}

/** renderArchitectureSection — the ARCHITECTURE core-framework item, rendered as real top-level dirs with a
 *  file-count + (when a real known entry file exists) a file pointer — NEVER a prose paragraph describing a
 *  "typical" layout the project may not actually have. */
function renderArchitectureSection(detected) {
  if (!detected.dirs || !detected.dirs.length) {
    return '## Architecture\nNo real top-level source directories detected beyond build/dependency noise — verify this project\'s real layout by hand before making structural claims.';
  }
  const lines = detected.dirs.map((d) => {
    const entry = d.entryFile ? ' — entry: `' + d.dir + '/' + d.entryFile + '`' : '';
    return '- `' + d.dir + '/` (' + d.fileCount + ' file' + (d.fileCount === 1 ? '' : 's') + ')' + entry;
  }).join('\n');
  return '## Architecture\nReal top-level directories (never a fabricated "typical" layout):\n\n' + lines;
}

/** renderConventionsSection — "conventions a linter can't enforce": kept deliberately SHORT and tied only
 *  to what real detection already proved (test-tooling presence, lint-config presence) — never an invented,
 *  unverifiable project-specific rule (e.g. "this project prefers X naming" without a real file proving it). */
function renderConventionsSection(name, detected) {
  const lines = ['- Match this project\'s existing file/module naming and structure before introducing a new pattern.'];
  if (detected.tooling.test.length) {
    lines.push('- `[' + name + ']` New behavior needs a real ' + detected.tooling.test.join('/') + ' test in the same style as existing tests — a manual check alone is never enough.');
  } else {
    lines.push('- `[' + name + ']` No test tooling detected — add a real test alongside new behavior; do not rely on a manual check alone.');
  }
  if (!detected.tooling.lint) {
    lines.push('- `[' + name + ']` No linter configured — match neighboring files\' style by hand; do not introduce a new formatting convention.');
  }
  return '## Conventions (a linter can\'t enforce)\n' + lines.join('\n');
}

/** renderBoundariesSection — off-limits directories. Universal boundaries plus one real, detected boundary
 *  (this project's own `.claude/` machinery, when present) — never a fabricated project-specific boundary. */
function renderBoundariesSection(name, detected) {
  const claudeNote = detected.hasClaudeDir
    ? '- `[' + name + ']` `.claude/` is Forge machinery in this project — change it via the forge-bin tools, never hand-edit a generated file inside it.\n'
    : '';
  return '## Boundaries\n' +
    '- Never edit `node_modules/`, build/dist output, or `.git/` directly — they are generated/managed, not source.\n' +
    claudeNote +
    '- Never edit another project\'s folder from inside this one; stay inside this project\'s own root.';
}

/** renderDetailDocsSection — pointers to detail docs, using Claude Code's real `@path` import syntax so the
 *  reference is directly actionable, never a bare "see the docs" mention. NOTE: unlike a Skill (which is
 *  progressive-disclosure/trigger-matched and, per the research, is NOT reliably auto-invoked — Vercel evals
 *  measured 56% non-invocation), an `@`-imported file DOES load automatically alongside this one at session
 *  start — so this section buys ORGANIZATION, not a context-budget saving; keep the imported docs focused. */
function renderDetailDocsSection(detected) {
  if (!detected.docs || !detected.docs.length) {
    return '## Detail docs\nNo `README.md` or `docs/*.md` found yet — add one and reference it here (`@README.md`) as the project grows.';
  }
  const lines = detected.docs.map((d) => '@' + d).join('\n');
  return '## Detail docs\nImported below — these load automatically alongside this file (organization, not a context-budget saver; keep them focused):\n\n' + lines;
}

function localServerBlock(name, detected) {
  const devScript = (detected.scripts && (detected.scripts.dev || detected.scripts.start)) || null;
  const portLine = detected.ports.length
    ? detected.ports.map((p) => p.port + ' (' + p.source + ')').join(', ')
    : 'not detected in scripts/.env.example — confirm the real port before screenshotting (never assume a framework default)';
  return '- `[' + name + ']` Real dev command: `' + (devScript || 'not detected — verify the real script in package.json') + '`.\n' +
    '- `[' + name + ']` Detected port(s): ' + portLine + '.\n' +
    '- Always serve on localhost, never screenshot a `file:///` URL. If a server is already running, do not start a second instance.';
}

function outputDefaultsBlock(name, detected) {
  const framework = detected.stack.length ? detected.stack.join(' + ') : 'no frontend framework detected';
  return '- `[' + name + ']` This project uses **' + framework + '** — follow ITS component/file conventions, not a generic single `index.html`.\n' +
    '- Mobile-first responsive. Real content — never lorem/placeholder in anything headed for production.';
}

function renderWebsiteRules(name, detected) {
  return '## Frontend Website Rules\n\n' +
    '### Always Do First\n- **Apply the frontend-design method before writing ANY frontend code, every session, no exceptions.**\n\n' +
    '### Reference Images\n- If a reference image is provided: match layout, spacing, typography, and color exactly. Swap in placeholder content unless real brand assets exist. Do not improve or add to the design.\n' +
    '- If no reference image: design from scratch with high craft (see guardrails below).\n' +
    '- Screenshot your output, compare against the reference, fix mismatches, re-screenshot. Do at least 2 comparison rounds.\n\n' +
    '### Local Server & Screenshots  `[' + name + ' — adapted to this project\'s real tooling]`\n' + localServerBlock(name, detected) + '\n\n' +
    '### Output Defaults  `[' + name + ' — adapted]`\n' + outputDefaultsBlock(name, detected) + '\n\n' +
    '### Brand Assets\n- Check `brand_assets/` (or this project\'s real asset folder) before designing. Use real logos/colors/photos when present — never invent brand colors.\n\n' +
    ANTI_GENERIC_GUARDRAILS_MD + '\n\n' +
    '### Hard Rules (frontend)\n- Do not add sections/features/content not asked for.\n- Do not "improve" a reference design — match it.\n- Do not stop after one screenshot pass.\n- Do not use `transition-all`.\n- Do not use default Tailwind blue/indigo as the primary color.';
}

function renderN8nRules(name, detected) {
  const n8nNote = detected.notes.some((n) => n.includes('n8n workflow export'))
    ? '- `[' + name + ']` Detected workflow export(s) — treat every file under that folder as inactive-by-default until proven otherwise.\n' : '';
  return '## Automation (n8n) Rules  `[' + name + ' — adapted]`\n' +
    '- Validate every webhook\'s method/schema/auth before trusting the payload.\n' +
    '- Every workflow needs an error branch plus retry/idempotency guard — no silent failure paths.\n' +
    '- Keep prod/test workflows separate; run `validate_workflow` before calling anything ready.\n' +
    '- Import workflows **inactive by default**; never live-activate without explicit owner approval (hard gate: workflow-activate).\n' +
    '- Credentials are metadata only — never a real secret value in a committed workflow JSON file.\n' + n8nNote;
}

function renderFullstackRules(name, detected) {
  return '## Full-stack App Rules  `[' + name + ' — adapted]`\n' +
    '- Enforce auth server-side on every protected route — never trust a client-side check alone.\n' +
    '- Validate input at every boundary (API routes, forms) with real schema validation.\n' +
    '- Secrets in `.env`, mirrored as placeholders in `.env.example` — never in committed source.\n' +
    '- Review DB migrations before applying; keep them reversible.\n' +
    '- `[' + name + ']` Detected stack: ' + fmtList(detected.stack, 'not detected') + '. Detected test tooling: ' + fmtList(detected.tooling.test, 'none detected') +
    ' — run it for real before calling a change done, never assume green.';
}

function renderGenericRules(name, detected) {
  return '## Project Rules  `[' + name + ' — adapted]`\n' +
    '- Detected stack: ' + fmtList(detected.stack, 'no framework detected — plain Node/CLI tooling') + '.\n' +
    '- Detected test tooling: ' + fmtList(detected.tooling.test, 'none detected — add real tests before claiming a change is done') + '.\n' +
    '- Run the project\'s real build/lint/test commands (see Commands above) before calling any change complete.';
}

/** EMPHASIZED_RULE_IDS — the research is explicit that emphasis (IMPORTANT/YOU MUST-style language) must be
 *  reserved for only the 1-2 truly critical rules, or it dilutes and stops working ("the worst CLAUDE.md
 *  files aren't empty; they're thorough ones... adherence quietly drops because important rules dilute
 *  among trivia"). Every other Hard Rule renders as a plain, still-imperative bullet. */
const EMPHASIZED_RULE_IDS = new Set(['honesty-core', 'project-isolation']);

function renderHardRulesSection(hardRulesResult) {
  const lines = hardRulesResult.rules.map((r) => {
    const tag = '`[' + r.id + ']`';
    return EMPHASIZED_RULE_IDS.has(r.id)
      ? '- **IMPORTANT:** ' + tag + ' ' + r.text
      : '- ' + tag + ' ' + r.text;
  }).join('\n');
  const sourceNote = hardRulesResult.source === 'default+project-file'
    ? 'Merged from Forge\'s universal defaults plus this project\'s own `.claude/FORGE_HARD_RULES.json`.'
    : 'Forge\'s universal defaults — this project has no `.claude/FORGE_HARD_RULES.json` yet, so no project-specific non-negotiables are added. Add that file to extend this list; it is machine-checkable.';
  return '## Hard Rules\n' + sourceNote + '\n\n' + lines;
}

function renderGovernance(detected) {
  const draftOnlyLine = (detected.type === 'website' || detected.type === 'fullstack')
    ? '- Outreach/publish paths stay **draft-only** unless the owner explicitly approves sending/publishing.\n' : '';
  return '## Governance\n' +
    '- Forge project — memory/decisions/ledger in `.claude/FORGE_MEMORY.md`, `FORGE_DECISIONS.md`, `FORGE_AGENT_LEDGER.md`, `FORGE_TASK_HISTORY.md`.\n' +
    '- Secrets in `.env` only (git-ignored) — never committed, never in this file.\n' + draftOnlyLine +
    '- **Never auto-push git, never deploy, never activate production** without explicit, current owner approval.\n' +
    '- Honesty core: never claim a check, test, build, or screenshot ran if it did not — quote real output.';
}

const MARK_BEGIN = '<!-- FORGE-PROJECTBRAIN:BEGIN v1 -->';
const MARK_END = '<!-- FORGE-PROJECTBRAIN:END -->';

/** assemble — see file header MODEL section. Pure string builder; does its own detectStack/loadHardRules
 *  only when the caller doesn't already supply `detected`/`hardRules` (test-hermeticity seam). */
function assemble(params, opts) {
  params = params || {}; opts = opts || {};
  if (!params.projectDir) throw new Error('forge-projectbrain: assemble() requires projectDir');
  const projectDir = path.resolve(String(params.projectDir));
  const detected = params.detected || detectStack({ projectDir }, opts);
  const hardRulesResult = params.hardRules || loadHardRules({ projectDir }, opts);
  const name = detected.name;

  let rulesetSection;
  if (detected.type === 'website') rulesetSection = renderWebsiteRules(name, detected);
  else if (detected.type === 'automation-n8n') rulesetSection = renderN8nRules(name, detected);
  else if (detected.type === 'fullstack') rulesetSection = renderFullstackRules(name, detected);
  else rulesetSection = renderGenericRules(name, detected);

  const body = '# CLAUDE.md — ' + name + '\n\n' +
    renderDescriptionLine(detected) +
    '> Project brain for **' + name + '** (a Forge project), generated by `forge-projectbrain`. Environment-specific rules below are adapted to this project\'s REAL detected stack/tooling (adaptations flagged `[' + name + ']`); universal anti-generic guardrails + honesty core are kept verbatim. Forge memory + governance live in `.claude/FORGE_*.md`.\n\n' +
    '---\n\n' + renderIdentity(name, detected) + '\n---\n\n' +
    renderCommandsSection(detected) + '\n\n---\n\n' +
    renderArchitectureSection(detected) + '\n\n---\n\n' +
    renderConventionsSection(name, detected) + '\n\n---\n\n' +
    rulesetSection + '\n\n---\n\n' +
    renderBoundariesSection(name, detected) + '\n\n---\n\n' +
    renderDetailDocsSection(detected) + '\n\n---\n\n' +
    renderHardRulesSection(hardRulesResult) + '\n\n---\n\n' +
    renderGovernance(detected);

  return MARK_BEGIN + '\n' + body.trim() + '\n' + MARK_END + '\n';
}

// ---------------------------------------------------------------------------------------------------------
// writeClaudeMd — safe-merge write
// ---------------------------------------------------------------------------------------------------------
const MARK_BEGIN_RE = /<!-- FORGE-PROJECTBRAIN:BEGIN[^>]*-->/;
const MARK_END_RE = /<!-- FORGE-PROJECTBRAIN:END -->/;

function extractMarkedRegion(content) {
  const bm = content.match(MARK_BEGIN_RE);
  const em = content.match(MARK_END_RE);
  if (!bm || !em || em.index < bm.index) return { hasMarkers: false };
  return { hasMarkers: true, before: content.slice(0, bm.index), after: content.slice(em.index + em[0].length) };
}

/** writeClaudeMd — see file header MODEL section. Never blindly clobbers an existing, unmarked CLAUDE.md. */
function writeClaudeMd(params) {
  params = params || {};
  const outPath = params.outPath;
  const generated = params.generated;
  if (!outPath) throw new Error('forge-projectbrain: writeClaudeMd() requires outPath');
  if (generated == null) throw new Error('forge-projectbrain: writeClaudeMd() requires generated content');

  if (!fs.existsSync(outPath)) {
    fs.writeFileSync(outPath, generated);
    return { written: true, status: 'created', path: outPath };
  }
  const existing = fs.readFileSync(outPath, 'utf8');
  const region = extractMarkedRegion(existing);
  if (region.hasMarkers) {
    fs.writeFileSync(outPath, region.before + generated + region.after);
    return { written: true, status: 'merged', path: outPath };
  }
  if (!params.force) {
    return {
      written: false, status: 'refused', path: outPath,
      reason: 'existing CLAUDE.md has no Forge-managed markers (' + MARK_BEGIN + ' / ' + MARK_END + ') — refusing to overwrite owner content. Re-run with force:true/--force to fully replace it, or add the markers manually to enable safe-merge.',
    };
  }
  fs.writeFileSync(outPath, generated);
  return { written: true, status: 'overwritten-forced', path: outPath };
}

module.exports = {
  detectStack, loadHardRules, assemble, writeClaudeMd, extractMarkedRegion,
  DEFAULT_HARD_RULES, MARK_BEGIN, MARK_END, EMPHASIZED_RULE_IDS,
  // exposed for direct unit testing of the individual core-framework sections (research-driven, see file header)
  renderCommandsSection, renderArchitectureSection, renderConventionsSection,
  renderBoundariesSection, renderDetailDocsSection, renderDescriptionLine, fmtStackWithVersions,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, dir: null, out: null, force: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dir') opts.dir = rest[++i];
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-projectbrain.cjs detect --dir <d> [--json]');
  console.error('       node forge-projectbrain.cjs generate --dir <d> [--out <file>] [--force] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'detect') {
      if (!opts.dir) { printUsage(); process.exitCode = 2; }
      else {
        const detected = detectStack({ projectDir: opts.dir }, {});
        if (opts.json) console.log(JSON.stringify(detected));
        else {
          console.log('type: ' + detected.type);
          console.log('stack: ' + fmtList(detected.stack, 'none detected'));
          console.log('ports: ' + (detected.ports.length ? detected.ports.map((p) => p.port + ' (' + p.source + ')').join(', ') : 'not detected'));
          console.log('test tooling: ' + fmtList(detected.tooling.test, 'none detected'));
          for (const n of detected.notes) console.log('note: ' + n);
        }
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'generate') {
      if (!opts.dir) { printUsage(); process.exitCode = 2; }
      else {
        const projectDir = path.resolve(opts.dir);
        const detected = detectStack({ projectDir }, {});
        const hardRules = loadHardRules({ projectDir }, {});
        const generated = assemble({ projectDir, detected, hardRules }, {});
        if (!opts.out) {
          console.log(generated);
          process.exitCode = 0;
        } else {
          const result = writeClaudeMd({ outPath: path.resolve(opts.out), generated, force: opts.force });
          if (opts.json) console.log(JSON.stringify(result));
          else if (result.written) console.log(result.status.toUpperCase() + ' — wrote ' + result.path);
          else console.log('REFUSED — ' + result.reason);
          process.exitCode = result.written ? 0 : 3;
        }
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-projectbrain: ' + e.message);
    process.exitCode = 2;
  }
}
