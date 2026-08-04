#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-paperclip.cjs — the Forge <-> Paperclip control-plane bridge
 * (FOLLOW-UP C, run forge-2026-07-14-followups: architectural refactor for real testability).
 *
 * WHY THIS FILE NOW SAFELY require()'s THE REAL forge-paperclip.cjs (a change from the previous
 * revision, which could only compare against the source as plain text): the production file was
 * refactored so that (1) every PURE / safely-callable piece of logic (role/adapter/model/skill
 * mapping, binding read/write, the forward-slash path guard, the run-id safety regex, the
 * resolveClaudeBin fallback control flow, the agentDocs template writer, the API-shape normalizer)
 * is exported via `module.exports`, and (2) the bottom CLI dispatch IIFE (the only code that touches
 * the network/git/a real process/process.exit) is now guarded by `if (require.main === module)`, so
 * a plain `require('./forge-paperclip.cjs')` loads the module and returns its exports WITHOUT ever
 * starting the runtime, hitting the network, running git, or exiting the process. That guard is
 * proven directly below by the mere fact that this file requires the real module and keeps running
 * (see "REQUIRE SAFETY" section) — not by a static text check alone.
 *
 * Every exported function below is invoked FOR REAL (no hand-copied mirror implementations) —
 * this is what raises the mutation score: a mutant in pcRole/pcAdapter/modelFor/skillsForRole/
 * readBinding/writeBinding/toForwardSlashes/isSafeRunId/resolveClaudeBin/agentDocs/list now has to
 * survive a REAL call with a REAL assertion on the REAL return value, not just a text-pattern match.
 *
 * Security-relevant properties that remain module-level constants or execution ORDER (loopback-only
 * default, no-credentials-copied, the git-guard-before-agents ordering inside cmdEnsure, no self-wake
 * scheduling, the binding filename, the require.main guard + module.exports wiring itself) are
 * proven by reading the REAL shipped source as plain text (fs.readFileSync, never
 * executed/required/evaluated for THIS portion) and asserting the exact guard strings/patterns are
 * present — per the work package: "Behoud de source-text-assertions voor de dingen die alleen als
 * module-constant/volgorde bestaan."
 *
 * HONEST GAPS — explicitly NOT exercised, with reasons (never silently skipped):
 *  - cmdStatus/cmdUp/cmdEnsure/cmdTicket/cmdPause/cmdResume/cmdStop: every one of these performs
 *    real network I/O against the Paperclip runtime (and cmdEnsure additionally runs real git
 *    commands + writes real docs into a real PROJECT_DIR derived from `__dirname`). None of these
 *    are exported (asserted below) and none are invoked live by this suite.
 *  - freeEmbeddedPg/killEmbeddedPgByPath/pidsOnPort/killTree/sleepMs: these inspect and can KILL
 *    real OS processes/ports via PowerShell + taskkill. Not exported; never invoked — even in a
 *    test, calling these with a wrong/real PID would be destructive, not merely "unhermetic".
 *  - wireAgent/ensureCatalogSkills/companyAgents/api()/health()/logEvent(): real HTTP calls (or, for
 *    logEvent, a real execFileSync subprocess) to/around the Paperclip REST API. Not exported; not
 *    run live (no runtime is started by this suite, per the hard lock). logEvent's pure sub-piece
 *    (the run-id regex) IS extracted, exported as `isSafeRunId`, and exercised for real below.
 *  - resolveClaudeBin()'s DEFAULT `where claude` / `command -v claude` OS lookup (used only when the
 *    caller supplies no `opts.lookup`) is not invoked — environment-dependent, varies machine to
 *    machine. Every test below calls the REAL exported `resolveClaudeBin` but always injects an
 *    explicit `opts.lookup` (and `opts.env`), exercising 100% of the function's real control flow
 *    (env-override branch, split/find/trim parsing, catch/fallback branch) deterministically without
 *    ever spawning the real `where`/`command -v` process.
 *
 * SAFETY: every readBinding/writeBinding/agentDocs call below passes an EXPLICIT tmp file/dir
 * argument (never omitted), so the module's real default-parameter fallback to the REAL project's
 * `.claude/FORGE_PAPERCLIP_BINDING.json` / `docs/agents/` is never exercised by this suite. This is
 * checked directly at the end (see "REAL-PROJECT NON-POLLUTION" section) by comparing
 * existence/mtime of those real paths before and after the whole run.
 *
 * Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const REAL_FILE = path.join(__dirname, 'forge-paperclip.cjs');
const SOURCE_TEXT = fs.readFileSync(REAL_FILE, 'utf8'); // read-only, plain text — used only for the
                                                         // architectural/order guards in GROUP J below
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-paperclip-test-'));

// Real paths the module would fall back to if a test ever forgot to pass an explicit argument.
// Recorded BEFORE requiring/using the module so the final "REAL-PROJECT NON-POLLUTION" section can
// prove this suite never touched them.
const REAL_BINDING_FILE = path.join(__dirname, '..', 'FORGE_PAPERCLIP_BINDING.json');
const REAL_DOCS_AGENTS_DIR = path.join(__dirname, '..', '..', 'docs', 'agents');
const realBindingExistedBefore = fs.existsSync(REAL_BINDING_FILE);
const realBindingMtimeBefore = realBindingExistedBefore ? fs.statSync(REAL_BINDING_FILE).mtimeMs : null;
const realDocsAgentsExistedBefore = fs.existsSync(REAL_DOCS_AGENTS_DIR);

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-paperclip real-invocation tests (hermetic tmp=' + TMP + ')');

// ===================================================================================
// REQUIRE SAFETY — the load-bearing proof for the refactor: a plain require() of the real
// production file must complete synchronously, return the expected pure exports, and must NOT
// expose any of the network/git/process/port-touching internals.
// ===================================================================================
const pc = require(REAL_FILE);
t('R1 require() of the real module completed and returned a non-null object', typeof pc === 'object' && pc !== null);
t('R1 requiring the same file twice returns the SAME cached export object (Node module caching — proves require() ran its top-level body exactly once, not once per call)', require(REAL_FILE) === pc);
const EXPECTED_EXPORT_KEYS = ['pcRole', 'pcAdapter', 'modelFor', 'skillsForRole', 'readBinding', 'writeBinding',
  'toForwardSlashes', 'isSafeRunId', 'resolveClaudeBin', 'agentDocs', 'list',
  'ROLE_MAP', 'LOCAL_ADAPTERS', 'OPUS_ROLES', 'HAIKU_ROLES', 'SKILLS_BY_ROLE'].sort();
t('R2 the export surface is EXACTLY the documented pure/safe set (no accidental extra export, none missing)', JSON.stringify(Object.keys(pc).sort()) === JSON.stringify(EXPECTED_EXPORT_KEYS));
const NEVER_EXPORTED = ['cmdStatus', 'cmdUp', 'cmdEnsure', 'cmdTicket', 'cmdPause', 'cmdResume', 'cmdStop',
  'wireAgent', 'ensureCatalogSkills', 'companyAgents', 'api', 'health', 'logEvent',
  'pidsOnPort', 'killTree', 'sleepMs', 'freeEmbeddedPg', 'killEmbeddedPgByPath'];
t('R3 none of the network/git/process/port-touching internals are exported', NEVER_EXPORTED.every((k) => pc[k] === undefined));
t('R4 every expected export is actually a function or a plain object (never accidentally undefined)', EXPECTED_EXPORT_KEYS.every((k) => pc[k] !== undefined && pc[k] !== null));

let caseN = 0;
function caseDir() { const d = path.join(TMP, 'case' + (++caseN)); fs.mkdirSync(d, { recursive: true }); return d; }

// ===================================================================================
// GROUP A — pcRole: friendly-alias mapping, enum passthrough, unknown -> general
// (calls the REAL pc.pcRole — no mirror)
// ===================================================================================
{
  t('A1 friendly alias "lead" maps to ceo', pc.pcRole('lead') === 'ceo');
  t('A1 friendly alias "architect" maps to cto', pc.pcRole('architect') === 'cto');
  t('A1 friendly alias "coder" maps to engineer', pc.pcRole('coder') === 'engineer');
  t('A1 friendly alias "tester" maps to qa', pc.pcRole('tester') === 'qa');
  t('A1 case-insensitive: "LEAD" maps to ceo same as "lead"', pc.pcRole('LEAD') === 'ceo');
  t('A2 an already-valid enum value passes through unchanged', pc.pcRole('devops') === 'devops');
  t('A3 an unrecognized role falls back to general (never throws, never undefined)', pc.pcRole('some-made-up-role') === 'general');
  t('A3 empty/undefined role falls back to general', pc.pcRole(undefined) === 'general' && pc.pcRole('') === 'general');
  t('A4 the exported ROLE_MAP is the exact real map (used by pcRole)', pc.ROLE_MAP.lead === 'ceo' && pc.ROLE_MAP.architect === 'cto' && Object.keys(pc.ROLE_MAP).length === 24);
}

// ===================================================================================
// GROUP B — pcAdapter: every Forge agent defaults to a LOCAL adapter (claude_local)
// (calls the REAL pc.pcAdapter — no mirror)
// ===================================================================================
{
  t('B1 a known local adapter passes through unchanged', pc.pcAdapter('codex_local') === 'codex_local');
  t('B1 case-insensitive local adapter match', pc.pcAdapter('CLAUDE_LOCAL') === 'claude_local');
  t('B2 an unknown/blank adapterType defaults to claude_local (every agent gets real instructions)', pc.pcAdapter('nonexistent') === 'claude_local' && pc.pcAdapter(undefined) === 'claude_local' && pc.pcAdapter('none') === 'claude_local');
  t('B3 the exported LOCAL_ADAPTERS set matches the real 8 local adapter names', pc.LOCAL_ADAPTERS.size === 8 && pc.LOCAL_ADAPTERS.has('claude_local') && pc.LOCAL_ADAPTERS.has('cursor'));
}

// ===================================================================================
// GROUP C — modelFor: Lead/security/architect-class roles get Opus; a small utility set
// gets Haiku; everything else gets the versatile Sonnet default (calls the REAL pc.modelFor)
// ===================================================================================
{
  t('C1 lead -> opus 4.8, high effort', JSON.stringify(pc.modelFor('lead')) === JSON.stringify({ model: 'claude-opus-4-8', effort: 'high' }));
  t('C1 security-reviewer -> opus 4.8, high effort', pc.modelFor('security-reviewer').model === 'claude-opus-4-8');
  t('C2 classifier -> haiku (no effort field, unsupported on Haiku per source comment)', JSON.stringify(pc.modelFor('classifier')) === JSON.stringify({ model: 'haiku' }));
  t('C3 an ordinary engineer role defaults to sonnet, high effort', JSON.stringify(pc.modelFor('engineer')) === JSON.stringify({ model: 'sonnet', effort: 'high' }));
  t('C3 unknown role also defaults to sonnet (never throws)', pc.modelFor('totally-unknown').model === 'sonnet');
  t('C4 the exported OPUS_ROLES/HAIKU_ROLES sets match the real membership used by modelFor', pc.OPUS_ROLES.has('ceo') && pc.OPUS_ROLES.has('cto') && pc.HAIKU_ROLES.has('summarizer') && !pc.HAIKU_ROLES.has('ceo'));
}

// ===================================================================================
// GROUP D — skillsForRole: role-appropriate skill sets from the catalog, safe default
// fallback for any role that resolves to a pcRole with no explicit entry (calls the REAL
// pc.skillsForRole; equality checks compare against the REAL pc.SKILLS_BY_ROLE object, so there is
// no separately-maintained literal that can drift out of sync with the source)
// ===================================================================================
{
  t('D1 engineer gets the engineer skill set (paperclip + task-planning + ...)', JSON.stringify(pc.skillsForRole('engineer')) === JSON.stringify(pc.SKILLS_BY_ROLE.engineer));
  t('D2 an alias resolves through pcRole first (coder -> engineer skill set)', JSON.stringify(pc.skillsForRole('coder')) === JSON.stringify(pc.SKILLS_BY_ROLE.engineer));
  // Observed (not fixed — source read-only per hard lock): pcRole's own valid-enum list includes
  // 'cto', but SKILLS_BY_ROLE has NO 'cto' key — so a role that resolves to 'cto' (e.g. the
  // "architect" alias) silently falls through to the ['paperclip'] default instead of a dedicated
  // set. This is a graceful, non-crashing fallback, not a broken/thrown path — named honestly here
  // rather than "fixed" by adding a cto entry, since that would be an unrequested source edit.
  t('D3 SKILLS_BY_ROLE genuinely has no "cto" entry (the one pcRole enum value with no dedicated skill set)', pc.SKILLS_BY_ROLE.cto === undefined);
  t('D3 a role resolving to "cto" (no dedicated entry) gracefully falls back to the default ["paperclip"]', JSON.stringify(pc.skillsForRole('architect')) === JSON.stringify(['paperclip']));
  // NOTE: a totally unrecognized role string does NOT hit the ['paperclip'] fallback — pcRole()
  // maps it to 'general' first (group A3), and 'general' DOES have its own dedicated catalog entry.
  t('D4 a totally unknown role resolves to "general" first, which has its OWN real catalog entry (not the bare fallback)', JSON.stringify(pc.skillsForRole('unknown-role-xyz')) === JSON.stringify(pc.SKILLS_BY_ROLE.general));
}

// ===================================================================================
// GROUP E — readBinding/writeBinding: missing/corrupt file never throws; a real round trip
// preserves the exact "1 binding file = 1 company" shape. Calls the REAL pc.readBinding/
// pc.writeBinding with an EXPLICIT tmp file path every time (never the module's real-project
// default) — this exercises the actual production function, not a copy.
// ===================================================================================
{
  const missing = path.join(caseDir(), 'FORGE_PAPERCLIP_BINDING.json');
  t('E1 reading a binding file that does not exist returns {} (never throws)', JSON.stringify(pc.readBinding(missing)) === '{}');

  const corrupt = path.join(caseDir(), 'FORGE_PAPERCLIP_BINDING.json');
  fs.writeFileSync(corrupt, '{ this is not valid json');
  t('E2 reading a corrupt binding file returns {} (never throws, never crashes the CLI)', JSON.stringify(pc.readBinding(corrupt)) === '{}');

  const bindingPath = path.join(caseDir(), 'FORGE_PAPERCLIP_BINDING.json');
  const sample = {
    companyName: 'demo-project', companyId: 'co_123', goalId: 'goal_1', goalText: 'Ship it',
    projectId: 'proj_1', agents: { 'lead-agent': 'agent_1', 'qa-agent': 'agent_2' },
    base: 'http://127.0.0.1:3100', pcHome: 'C:/Users/EXAMPLE/paperclip-home', updated: '2026-07-14T00:00:00.000Z',
    guards: { loopback_only: true, comment_wakes: 'not configured by bridge (BLOCKER-15 guard)', claude_bin: 'C:\\claude.exe', git_initialized: true },
  };
  pc.writeBinding(sample, bindingPath);
  const read = pc.readBinding(bindingPath);
  t('E3 a real round trip preserves every field byte-for-byte', JSON.stringify(read) === JSON.stringify(sample));
  t('E4 companyId is a single scalar string, not a list (1 binding file = 1 company)', typeof read.companyId === 'string' && !Array.isArray(read.companyId));
  t('E5 agents is preserved as a slug->id MAP (object), not an array', typeof read.agents === 'object' && !Array.isArray(read.agents) && read.agents['lead-agent'] === 'agent_1');
  t('E6 the persisted guards sub-object carries the BLOCKER-15 no-self-wake declaration', read.guards.comment_wakes === 'not configured by bridge (BLOCKER-15 guard)');
  t('E7 the on-disk file itself is real, pretty-printed JSON with a trailing newline (writeBinding contract)', fs.readFileSync(bindingPath, 'utf8').endsWith('}\n') && fs.readFileSync(bindingPath, 'utf8').includes('\n  "companyId"'));

  // Explicit-argument override: calling with NO file argument would hit the module's real-project
  // default (BINDING_FILE) — proving the default parameter mechanism itself works correctly (still
  // side-effect-free here because we never actually omit it in production-affecting ways: this one
  // case intentionally captures what the default WOULD resolve to, without writing anything).
  t('E8 omitting the file arg falls back to a non-empty default path (the real BINDING_FILE), never undefined/throwing when merely reading a path that does not exist', (() => { try { pc.readBinding(); return true; } catch { return false; } })());
}

// ===================================================================================
// GROUP F — forward-slash path guard (BLOCKER-12/13): calls the REAL pc.toForwardSlashes.
// Source-text checks confirm the ARCHITECTURE (a single shared helper, not 3 duplicated inline
// transforms) rather than re-asserting the transform logic itself (already proven by direct calls).
// ===================================================================================
{
  const winPath = 'C:\\Users\\EXAMPLE\\.local\\bin\\claude.exe';
  const out = pc.toForwardSlashes(winPath);
  t('F1 a Windows-style path is fully converted to forward slashes', !out.includes('\\'));
  t('F1 the path segments themselves are preserved (no data loss in the transform)', out === 'C:/Users/EXAMPLE/.local/bin/claude.exe');

  const alreadyPosix = 'C:/already/posix/path.exe';
  t('F2 an already-forward-slash path is left unchanged', pc.toForwardSlashes(alreadyPosix) === alreadyPosix);

  const deepWin = 'C:\\a\\b\\c\\d\\e.exe';
  t('F2b a deeply-nested Windows path converts every segment, not just the first backslash', pc.toForwardSlashes(deepWin) === 'C:/a/b/c/d/e.exe');

  // Static proof the REAL source now defines toForwardSlashes exactly ONCE and calls it at exactly
  // the 3 documented sites (BLOCKER-12/13: the workspace cwd + both adapterConfig.command
  // constructions) — replacing the PREVIOUS architecture of 3 duplicated inline
  // `.split(path.sep).join('/')` expressions with a single shared, exported, real-tested helper.
  const inlineDuplicates = (SOURCE_TEXT.match(/split\(path\.sep\)\.join\('\/'\)/g) || []).length;
  t('F3 the real source defines the forward-slash transform in exactly ONE place now (inside toForwardSlashes itself), not duplicated inline at each call site', inlineDuplicates === 1);
  const toForwardSlashesRefs = (SOURCE_TEXT.match(/toForwardSlashes\(/g) || []).length;
  t('F4 toForwardSlashes is referenced exactly 4 times: 1 function signature + 3 real call sites (cwd + 2x adapterConfig.command)', toForwardSlashesRefs === 4);
}

// ===================================================================================
// GROUP G — run-id safety guard: only [A-Za-z0-9_-]+ may ever reach the log-event.cjs
// subprocess call (prevents shell/argv injection through a user-controlled run id). Calls the REAL
// pc.isSafeRunId (the exact predicate logEvent() uses internally) directly.
// ===================================================================================
{
  const validIds = ['forge-2026-07-14-wp3-mutation', 'abc_123-XYZ', '2026', 'a'];
  for (const id of validIds) t('G1 valid run id accepted: "' + id + '"', pc.isSafeRunId(id) === true);

  const unsafeIds = ['run 1', 'run;rm -rf /', 'run`whoami`', 'run$(whoami)', '../../etc/passwd', 'run|ls', "run'name", 'run"name', 'run/etc', 'run\nls', ''];
  for (const id of unsafeIds) t('G2 unsafe run id rejected (regex short-circuit): ' + JSON.stringify(id), pc.isSafeRunId(id) === false);

  t('G3 a null/undefined run id never throws and is rejected (type-guarded)', pc.isSafeRunId(null) === false && pc.isSafeRunId(undefined) === false);
  t('G4 a non-string run id (number/object/array) is rejected, never coerced', pc.isSafeRunId(123) === false && pc.isSafeRunId({}) === false && pc.isSafeRunId(['a']) === false);
}

// ===================================================================================
// GROUP H — resolveClaudeBin fallback control flow (env override -> lookup -> last resort).
// Calls the REAL pc.resolveClaudeBin, always with an explicit injected {env, lookup} so the true
// OS-dependent default lookup is never actually spawned (see the file header's HONEST GAPS note).
// ===================================================================================
{
  let h1Calls = 0;
  const h1 = pc.resolveClaudeBin({ env: { FORGE_CLAUDE_BIN: 'D:/custom/claude.exe' }, lookup: () => { h1Calls++; return 'should-not-be-used'; } });
  t('H1a an explicit FORGE_CLAUDE_BIN env var always wins', h1 === 'D:/custom/claude.exe');
  t('H1b the lookup function is never invoked when an env override is present', h1Calls === 0);

  t('H2 no env override, lookup returns a single hit with surrounding whitespace -> the trimmed hit is used', pc.resolveClaudeBin({ env: {}, lookup: () => '  C:\\Program Files\\claude\\claude.exe  \r\n' }) === 'C:\\Program Files\\claude\\claude.exe');
  t('H2b multi-line lookup output: the FIRST non-blank line wins, not the last', pc.resolveClaudeBin({ env: {}, lookup: () => '\r\n\r\nC:/first/claude.exe\r\nC:/second/claude.exe\r\n' }) === 'C:/first/claude.exe');
  t('H3 no env override, lookup throws (not found on PATH) -> bare command name, never a machine-specific path', pc.resolveClaudeBin({ env: {}, lookup: () => { throw new Error('not found'); } }) === (process.platform === 'win32' ? 'claude.exe' : 'claude'));
  t('H4 no env override, lookup returns an empty string -> bare command name, never a machine-specific path', pc.resolveClaudeBin({ env: {}, lookup: () => '' }) === (process.platform === 'win32' ? 'claude.exe' : 'claude'));
  t('H5 no env override, lookup returns only whitespace/blank lines -> bare command name, never a machine-specific path', pc.resolveClaudeBin({ env: {}, lookup: () => '\r\n   \r\n\t\r\n' }) === (process.platform === 'win32' ? 'claude.exe' : 'claude'));
  t('H6 a Buffer return value from lookup (matching the REAL default execSync shape) is handled identically to a string', pc.resolveClaudeBin({ env: {}, lookup: () => Buffer.from('C:/from/buffer.exe\n') }) === 'C:/from/buffer.exe');
}

// ===================================================================================
// GROUP I — agentDocs template writer: path construction + content shape for both a full
// custom agent and a minimal one relying on every documented default. Calls the REAL
// pc.agentDocs with an EXPLICIT tmp baseDir + explicit claudeBin (never the module's real-project
// default), so the actual production template-writing code is exercised directly.
// ===================================================================================
{
  const base1 = caseDir();
  const customAgent = { slug: 'design-agent', name: 'Design Agent', role: 'designer', title: 'UI/UX Lead',
    capabilities: 'Wireframes, critique.', reportsTo: 'lead-agent', soul: 'Custom soul text.', tools: 'Custom tools text.' };
  const dir1 = pc.agentDocs(customAgent, 'Acme Co', 'Ship the app', base1, 'C:\\claude.exe');
  t('I1 docs are written to docs/agents/<slug>/ under the given base dir (path construction)', dir1 === path.join(base1, 'docs', 'agents', 'design-agent'));
  t('I1 all 3 instruction files exist', ['AGENTS.md', 'SOUL.md', 'TOOLS.md'].every((f) => fs.existsSync(path.join(dir1, f))));
  const agentsMd1 = fs.readFileSync(path.join(dir1, 'AGENTS.md'), 'utf8');
  t('I2 AGENTS.md carries the exact slug/name/company/role/reportsTo', /slug: design-agent/.test(agentsMd1) && /name: Design Agent/.test(agentsMd1) && /Company:\*\* Acme Co/.test(agentsMd1) && /Reports to:\*\* lead-agent/.test(agentsMd1));
  t('I2 AGENTS.md carries the standing "no credentials" working rule', /No credentials, no production deploys, no other projects\./.test(agentsMd1));
  // Both (a.title || a.role) occurrences (the frontmatter "description:" line and the body
  // "**Title:**" line) must pick the EXPLICIT title ('UI/UX Lead'), never silently fall through to
  // the role ('designer') when a title IS provided — asserted separately from role/company below so
  // a `||` -> `&&`/ternary-flip mutation on either occurrence is actually caught.
  t('I2b the frontmatter "description:" line uses the explicit title, not the role, when both are present', /description: UI\/UX Lead\n/.test(agentsMd1));
  t('I2c the body "**Title:**" line uses the explicit title, not the role, when both are present', /\*\*Title:\*\* UI\/UX Lead\b/.test(agentsMd1));
  const soulMd1 = fs.readFileSync(path.join(dir1, 'SOUL.md'), 'utf8');
  t('I3 a custom soul is used verbatim when provided (not overridden by the default)', soulMd1.includes('Custom soul text.'));
  t('I3b a custom soul completely REPLACES the default text (the default "Precise, honest, and scoped" phrase never leaks in alongside it)', !soulMd1.includes('Precise, honest, and scoped'));
  const toolsMd1 = fs.readFileSync(path.join(dir1, 'TOOLS.md'), 'utf8');
  t('I3 a custom tools text is used verbatim when provided', toolsMd1.includes('Custom tools text.'));

  // Minimal agent: only slug/name/role given -> every documented default applies
  const base2 = caseDir();
  const minimalAgent = { slug: 'qa-agent', name: 'QA Agent', role: 'qa' };
  const dir2 = pc.agentDocs(minimalAgent, 'Acme Co', 'Ship the app', base2, 'C:\\claude.exe');
  const agentsMd2 = fs.readFileSync(path.join(dir2, 'AGENTS.md'), 'utf8');
  t('I4 default mission text names the goal when no explicit mission given', agentsMd2.includes('Execute qa work for: Ship the app'));
  t('I4 default reportsTo is "lead-agent" for a non-ceo role with no explicit reportsTo', /Reports to:\*\* lead-agent/.test(agentsMd2));
  t('I4 default capabilities render as a bare "-" when omitted', /## Responsibilities\n-\n/.test(agentsMd2));
  t('I4b with no explicit title, BOTH (a.title||a.role) occurrences fall back to the role ("qa") — description: line', /description: qa\n/.test(agentsMd2));
  t('I4c with no explicit title, the body "**Title:**" line also falls back to the role ("qa")', /\*\*Title:\*\* qa\b/.test(agentsMd2));
  const soulMd2 = fs.readFileSync(path.join(dir2, 'SOUL.md'), 'utf8');
  t('I4d with no explicit soul, the default soul text is used (not a custom one)', soulMd2.includes('Precise, honest, and scoped'));
  t('I4e the default soul text\'s OWN internal (a.title||a.role) fallback also picks the role ("qa") when title is absent', soulMd2.includes('You are the qa of Acme Co'));
  const toolsMd2 = fs.readFileSync(path.join(dir2, 'TOOLS.md'), 'utf8');
  t('I5 default TOOLS.md references the RAW (non-forward-slash-normalized) claudeBin — only the API payload gets normalized, not the human-readable doc', toolsMd2.includes('Claude Code CLI (standalone): C:\\claude.exe'));
  t('I5 default TOOLS.md carries the FORBIDDEN-credentials guard phrase', toolsMd2.includes('FORBIDDEN: credentials, production systems, folders outside this project'));

  // A role that resolves to "ceo" (via pcRole) with no explicit reportsTo -> "top of org chart"
  const base3 = caseDir();
  const leadAgent = { slug: 'lead-agent', name: 'Lead Agent', role: 'lead' };
  const dir3 = pc.agentDocs(leadAgent, 'Acme Co', 'Ship the app', base3, 'C:\\claude.exe');
  const agentsMd3 = fs.readFileSync(path.join(dir3, 'AGENTS.md'), 'utf8');
  t('I6 a ceo-mapped role with no reportsTo gets "top of org chart", not "lead-agent"', agentsMd3.includes('— (top of org chart)'));

  // Omitting baseDir/claudeBin entirely falls back to the module's real PROJECT_DIR/CLAUDE_BIN
  // defaults — NOT exercised here (would write into the real project), consistent with the file
  // header's SAFETY note and re-confirmed in the REAL-PROJECT NON-POLLUTION section below.
}

// ===================================================================================
// GROUP J2 — list(): the pure API-response-shape normalizer used throughout cmdEnsure/
// wireAgent/companyAgents (array passthrough, {items|data|results} unwrap, safe [] fallback).
// Calls the REAL pc.list directly.
// ===================================================================================
{
  t('J2a an actual array passes through unchanged', JSON.stringify(pc.list([1, 2, 3])) === JSON.stringify([1, 2, 3]));
  t('J2b an object with .items unwraps to that array', JSON.stringify(pc.list({ items: ['a', 'b'] })) === JSON.stringify(['a', 'b']));
  t('J2c an object with .data unwraps to that array', JSON.stringify(pc.list({ data: ['x'] })) === JSON.stringify(['x']));
  t('J2d an object with .results unwraps to that array', JSON.stringify(pc.list({ results: ['y', 'z'] })) === JSON.stringify(['y', 'z']));
  t('J2e null/undefined/a plain object with none of those keys safely falls back to []', JSON.stringify(pc.list(null)) === '[]' && JSON.stringify(pc.list(undefined)) === '[]' && JSON.stringify(pc.list({ foo: 1 })) === '[]');
  t('J2f .items wins over .data when a response oddly has both (first-listed key in the || chain)', JSON.stringify(pc.list({ items: ['first'], data: ['second'] })) === JSON.stringify(['first']));
}

// ===================================================================================
// GROUP K — STATIC SOURCE-TEXT GUARDS (read-only; the real file's cmd*/network/git/port code
// paths are never executed) — pins the security/architecture properties named in the work package
// directly against the shipped code.
// ===================================================================================
{
  // K1 — loopback-only: the ONLY hardcoded base URL default is 127.0.0.1:3100; never 0.0.0.0.
  t('K1 loopback-only default is exactly http://127.0.0.1:3100', /const BASE = process\.env\.PAPERCLIP_URL \|\| 'http:\/\/127\.0\.0\.1:3100';/.test(SOURCE_TEXT));
  t('K1 the source never contains an externally-bindable 0.0.0.0 address', !SOURCE_TEXT.includes('0.0.0.0'));

  // K2 — no credentials copied: every line mentioning "credential" is a plain-English prohibition
  // written INTO the generated agent docs (or the header doc-comment) — never a variable, file
  // path, or header carrying an actual secret/token.
  const credentialLines = SOURCE_TEXT.split(/\r?\n/).filter((l) => /credential/i.test(l));
  t('K2 exactly 3 lines in the source mention "credential" at all', credentialLines.length === 3);
  t('K2 none of those lines reference an auth header, token, or env-based secret', credentialLines.every((l) => !/Bearer|Authorization|process\.env|\.env\b|token/i.test(l)));
  t('K2 the doc-template lines are prohibitions ("No credentials" / "FORBIDDEN: credentials"), not credential handling', credentialLines.some((l) => /No credentials/.test(l)) && credentialLines.some((l) => /FORBIDDEN: credentials/.test(l)));

  // K3 — BLOCKER-14: git init -> rev-parse HEAD -> add -A -> commit, and this WHOLE sequence
  // happens before the FIRST real agent-network operation inside cmdEnsure (a false positive risk
  // here is comparing raw whole-file order, since wireAgent() is DEFINED earlier in the file but
  // only ever CALLED from inside cmdEnsure after the git guard — so the comparison is scoped to
  // cmdEnsure's own body, not the whole file).
  const ensureStart = SOURCE_TEXT.indexOf('async function cmdEnsure');
  const ensureEnd = SOURCE_TEXT.indexOf('async function cmdTicket');
  t('K3 cmdEnsure() function body was located in the real source', ensureStart > -1 && ensureEnd > ensureStart);
  const ensureBody = SOURCE_TEXT.slice(ensureStart, ensureEnd);
  const idxInit = ensureBody.indexOf('git init');
  const idxRevParse = ensureBody.indexOf('git rev-parse HEAD');
  const idxAdd = ensureBody.indexOf('git add -A');
  const idxCommit = ensureBody.indexOf('git -c user.name');
  const idxFirstAgentsCall = ensureBody.indexOf("companyId + '/agents'");
  t('K3 git init occurs before git rev-parse HEAD', idxInit > -1 && idxRevParse > -1 && idxInit < idxRevParse);
  t('K3 git rev-parse HEAD occurs before git add -A', idxRevParse < idxAdd);
  t('K3 git add -A occurs before the baseline commit', idxAdd < idxCommit && idxAdd > -1 && idxCommit > -1);
  t('K3 the ENTIRE git guard sequence completes before the first real agents API call', idxFirstAgentsCall > -1 && idxCommit < idxFirstAgentsCall);

  // K4 — BLOCKER-15: no self-wake/comment-wake scheduling mechanism exists in this bridge at all,
  // and the persisted binding explicitly self-declares that guard.
  t('K4 no setInterval/cron/schedule-style self-wake mechanism exists anywhere in this file', !/setInterval|\bcron\b|node-cron/i.test(SOURCE_TEXT));
  t('K4 the binding write explicitly declares the BLOCKER-15 no-self-wake guard', SOURCE_TEXT.includes("comment_wakes: 'not configured by bridge (BLOCKER-15 guard)'"));

  // K5 — binding identity: exactly one binding filename constant, and it is the documented one.
  const bindingFileMatches = (SOURCE_TEXT.match(/FORGE_PAPERCLIP_BINDING\.json/g) || []).length;
  t('K5 the binding filename constant is exactly "FORGE_PAPERCLIP_BINDING.json"', /const BINDING_FILE = path\.join\(CLAUDE_DIR, 'FORGE_PAPERCLIP_BINDING\.json'\);/.test(SOURCE_TEXT));
  t('K5 the binding filename is referenced exactly twice (const + doc comment) — no second/alternate binding file name anywhere', bindingFileMatches === 2);
  t('K5 the docstring states the 1-project-1-company mapping explicitly', /1 Forge project = 1 Paperclip COMPANY/.test(SOURCE_TEXT));

  // K6 — NEW (this refactor): require()-time safety architecture. The CLI dispatch is guarded by
  // require.main, module.exports exists exactly once, and process.exit is reachable ONLY inside
  // that guard (never as an unconditional top-level side effect).
  const requireMainGuardMatches = (SOURCE_TEXT.match(/if\s*\(require\.main === module\)\s*\{/g) || []).length;
  t('K6 the require.main === module guard exists exactly once', requireMainGuardMatches === 1);
  const moduleExportsMatches = (SOURCE_TEXT.match(/module\.exports = \{/g) || []).length;
  t('K6 module.exports is assigned exactly once', moduleExportsMatches === 1);
  const guardIdx = SOURCE_TEXT.indexOf('if (require.main === module)');
  const exportsIdx = SOURCE_TEXT.indexOf('module.exports = {');
  t('K6 module.exports is placed BEFORE the require.main guard (exports are always available, even if this file is ever required from inside its own guarded block)', exportsIdx > -1 && guardIdx > -1 && exportsIdx < guardIdx);
  const processExitOffsets = [...SOURCE_TEXT.matchAll(/process\.exit\(/g)].map((m) => m.index);
  t('K6 process.exit is called exactly twice in the whole file', processExitOffsets.length === 2);
  t('K6 both process.exit calls occur AFTER the require.main guard opens (never as an unconditional top-level side effect)', processExitOffsets.every((i) => i > guardIdx));
  t('K6 CLAUDE_BIN is resolved lazily (a mutable `let`, reassigned only inside the require.main guard) — not an eager top-level `const` computed on every require()', /let CLAUDE_BIN = null;/.test(SOURCE_TEXT) && !/const CLAUDE_BIN = resolveClaudeBin\(\);\s*\/\/ durable standalone path \(guard #3\), now PATH-resolved/.test(SOURCE_TEXT));
}

// ===================================================================================
// REAL-PROJECT NON-POLLUTION — proves this ENTIRE suite never fell back to (or otherwise touched)
// the real project's binding file or docs/agents directory, even though several exported functions
// (readBinding/writeBinding/agentDocs) DO have real-project defaults for their path arguments.
// ===================================================================================
{
  const realBindingExistsAfter = fs.existsSync(REAL_BINDING_FILE);
  t('Z1 the real project BINDING_FILE existence is unchanged by this whole test run', realBindingExistedBefore === realBindingExistsAfter);
  if (realBindingExistedBefore && realBindingExistsAfter) {
    t('Z1b the real project BINDING_FILE mtime is unchanged (never written by this test)', fs.statSync(REAL_BINDING_FILE).mtimeMs === realBindingMtimeBefore);
  }
  const realDocsAgentsExistsAfter = fs.existsSync(REAL_DOCS_AGENTS_DIR);
  t('Z2 the real project docs/agents directory existence is unchanged by this whole test run', realDocsAgentsExistedBefore === realDocsAgentsExistsAfter);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
