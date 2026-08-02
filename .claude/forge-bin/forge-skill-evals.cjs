#!/usr/bin/env node
'use strict';
/**
 * forge-skill-evals.cjs — per-skill self-improvement substrate, FOUNDATION piece (backlog item 1,
 * YT-SWEEP-2026-07-31, 8 source videos — see .claude/forge-research/YT-SWEEP-2026-07-31.md). Zero-
 * dependency (fs/path only), deterministic, no LLM judging — every assertion is a BINARY true/false
 * check so an eventual autonomous keep/revert loop (nightshift-gated, NOT built by this file) can act on
 * a pass/fail signal without subjective judgement. This iteration is the runner + evals only; no
 * autonomous "edit skill.md then re-test" loop exists yet.
 *
 * STEP 2 (wp-disclosure-ab, backlog item 8, 2026-07-31): these binary evals answer "is the skill
 * structurally correct?" — cheap, deterministic, always safe to run. They do NOT answer "does the skill
 * actually get selected on real phrasing, and does it help once selected?". For that, see the
 * `forge-skill-testing` skill (`.claude/skills/forge-skill-testing/SKILL.md`) — the activation-test +
 * opt-in fresh-session A/B benchmark protocol to run AFTER these evals pass, whenever a description/body
 * genuinely changed and that harder question actually matters.
 *
 * DESIGN:
 *   Each skill dir under `.claude/skills/<name>/` MAY carry an `evals.json` (schema below). A skill
 *   with no evals.json is simply skipped — evals are opt-in per skill, not a universal requirement.
 *   Every assertion type is a cheap, honest filesystem/string check — never an LLM call, never a
 *   network call, never a "looks about right" judgement.
 *
 * evals.json SCHEMA (an object):
 *   { "skill": "<dir-name>", "assertions": [ {assertion}, ... ] }
 *   - "skill" MUST match the directory it was found in (copy/paste-drift guard — catches an evals.json
 *     cloned from a sibling skill without updating this field).
 *   - "assertions" MUST be a non-empty array; each entry needs a unique non-empty "id", a "type" from
 *     ASSERTION_TYPES below, and that type's required fields. An optional "why" string is carried
 *     through to the result for human-readable reporting but never validated/used by the runner logic.
 *
 * ASSERTION TYPES (binary only — see file header):
 *   file_exists      {path}                    — project-relative path resolves to a real FILE.
 *   file_absent      {path}                    — project-relative path does NOT exist.
 *   json_valid       {path}                    — file exists, is readable, and JSON.parse()s cleanly.
 *   max_lines        {path, n}                 — file's line count is <= n.
 *   contains         {path, needle}            — file's raw text includes the exact literal `needle`.
 *   not_contains     {path, needle}             — file's raw text does NOT include `needle`.
 *   frontmatter_field {field, max_length?, skill?} — the `field` key (e.g. "description") is present and
 *     non-empty in the CURRENT skill's own SKILL.md frontmatter (or the `skill` dir's SKILL.md when that
 *     optional override is given); when `max_length` is set, the field's string length must not exceed
 *     it. This is the one assertion type that intentionally does NOT take a `path` — "validates the
 *     skill's own SKILL.md" per the work package, so the path is derived, never hand-typed per assertion.
 *
 * All `path` values resolve PROJECT-RELATIVE (path.resolve(root, path)) — a path a skill's evals.json
 * references in `.claude/forge-bin/` or another skill's directory works exactly the same as a path
 * inside the skill's own folder. A referenced file that doesn't exist is an HONEST assertion FAILURE
 * (ok:false, a real `detail` string), never a thrown exception — a single missing/moved file must never
 * crash the whole eval run for every other skill.
 *
 * MODULE API:
 *   listSkillDirs(root) -> [{name, dir, evalsPath}, ...] — every immediate subdir of .claude/skills/
 *     that has an evals.json present (existence check only; malformed content is still LISTED here and
 *     surfaced as a real per-skill error by runSkill(), never silently dropped). [] when skills/ itself
 *     is missing/unreadable (never throws).
 *   loadEvals(evalsPath, expectedSkillName) -> {skill, assertions} — throws (err.code='ECONFIG') on ANY
 *     malformed config: unreadable file, invalid JSON, non-object shape, missing/empty "skill", a
 *     "skill" that doesn't match its own directory, missing/empty "assertions" array, a malformed
 *     assertion entry (non-object, missing/duplicate id, unknown/missing type, missing a type's required
 *     field). See loadEvals's own inline comments for the exact rule per type.
 *   runAssertion(root, currentSkillName, assertion) -> {ok, detail} — NEVER throws (a thrown error from a
 *     buggy assertion is caught and surfaced as an honest ok:false with the error message in `detail`).
 *   runSkill(root, skillDirName) -> {skill, ok, error, total, passed, failed, results:[...]}. A malformed
 *     evals.json degrades to {ok:false, error:<message>, total:0, passed:0, failed:0, results:[]} rather
 *     than throwing — one bad skill's config must never abort runAll() for every other skill.
 *   runAll(opts) -> {checked_at, root, skills:[...], summary, ok}. opts.root (default: two dirs up from
 *     this file), opts.skill (filter to exactly one skill dir name — throws err.code='ECONFIG' when no
 *     such dir/evals.json exists, mirroring forge-docdrift.cjs's `--source` contract), opts.now (Date,
 *     test-hermeticity seam for `checked_at`).
 *
 * CLI:
 *   node forge-skill-evals.cjs run [--skill <name>] [--json] [--root <dir>]
 * Exit codes: 0 = ran, every assertion in every evaluated skill passed · 1 = ran, at least one assertion
 * failed or a skill's evals.json was malformed (a real, reportable finding — never a crash) · 2 =
 * usage/config error (bad CLI args, or an unknown --skill name with no evals.json).
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');
const ASSERTION_TYPES = new Set([
  'file_exists', 'file_absent', 'json_valid', 'max_lines', 'contains', 'not_contains', 'frontmatter_field',
]);

function skillsDir(root) { return path.join(root, '.claude', 'skills'); }
function configError(msg) { const e = new Error('forge-skill-evals: ' + msg); e.code = 'ECONFIG'; return e; }

/** listSkillDirs(root) -> [{name, dir, evalsPath}, ...]. See file header. Never throws. */
function listSkillDirs(root) {
  const dir = skillsDir(root);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const evalsPath = path.join(dir, e.name, 'evals.json');
    if (fs.existsSync(evalsPath)) out.push({ name: e.name, dir: path.join(dir, e.name), evalsPath });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** validateAssertionShape(a) -> throws (ECONFIG) when a type-specific required field is missing/bad.
 *  Pure validation only — never reads the filesystem. */
function validateAssertionShape(a) {
  const needPath = () => {
    if (typeof a.path !== 'string' || !a.path.trim()) throw configError('assertion "' + a.id + '" (' + a.type + ') requires a non-empty "path"');
  };
  switch (a.type) {
    case 'file_exists':
    case 'file_absent':
    case 'json_valid':
      needPath();
      break;
    case 'max_lines':
      needPath();
      if (!Number.isInteger(a.n) || a.n <= 0) throw configError('assertion "' + a.id + '" (max_lines) requires a positive integer "n"');
      break;
    case 'contains':
    case 'not_contains':
      needPath();
      if (typeof a.needle !== 'string' || !a.needle) throw configError('assertion "' + a.id + '" (' + a.type + ') requires a non-empty "needle"');
      break;
    case 'frontmatter_field':
      if (typeof a.field !== 'string' || !a.field.trim()) throw configError('assertion "' + a.id + '" (frontmatter_field) requires a non-empty "field"');
      if (a.max_length !== undefined && (!Number.isInteger(a.max_length) || a.max_length <= 0)) throw configError('assertion "' + a.id + '" (frontmatter_field) "max_length" must be a positive integer when given');
      if (a.skill !== undefined && (typeof a.skill !== 'string' || !a.skill.trim())) throw configError('assertion "' + a.id + '" (frontmatter_field) "skill" must be a non-empty string when given');
      break;
    default:
      // unreachable — the caller already rejects an unknown type before calling this
      break;
  }
}

/** loadEvals(evalsPath, expectedSkillName) -> {skill, assertions}. See file header for the full
 *  validation contract. `expectedSkillName` is optional (a direct module caller may omit it — the CLI/
 *  listSkillDirs path always supplies it as the copy/paste-drift guard). */
function loadEvals(evalsPath, expectedSkillName) {
  let raw;
  try { raw = fs.readFileSync(evalsPath, 'utf8'); }
  catch (e) { throw configError('cannot read ' + evalsPath + ': ' + e.message); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw configError(evalsPath + ' is not valid JSON: ' + e.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw configError(evalsPath + ' must be a JSON object');
  if (typeof data.skill !== 'string' || !data.skill.trim()) throw configError(evalsPath + ' is missing a non-empty "skill" field');
  if (expectedSkillName && data.skill !== expectedSkillName) {
    throw configError(evalsPath + ' "skill" field ("' + data.skill + '") does not match its own directory ("' + expectedSkillName + '")');
  }
  if (!Array.isArray(data.assertions) || data.assertions.length === 0) throw configError(evalsPath + ' is missing a non-empty "assertions" array');

  const seenIds = new Set();
  for (const a of data.assertions) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw configError(evalsPath + ': an assertion entry must be an object');
    if (typeof a.id !== 'string' || !a.id.trim()) throw configError(evalsPath + ': an assertion is missing a non-empty "id"');
    if (seenIds.has(a.id)) throw configError(evalsPath + ': duplicate assertion id "' + a.id + '"');
    seenIds.add(a.id);
    if (typeof a.type !== 'string' || !ASSERTION_TYPES.has(a.type)) throw configError(evalsPath + ': assertion "' + a.id + '" has an unknown/missing "type" (' + a.type + ')');
    validateAssertionShape(a);
  }
  return { skill: data.skill, assertions: data.assertions };
}

/** parseFrontmatter(text) -> {} on no fenced block (never throws). Mirrors forge-doctor.cjs's own
 *  parseFrontmatter shape/regex (re-implemented here, not required, to keep this tool's only real
 *  dependency fs/path — see file header). */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function readFileHonest(p) {
  try { return { ok: true, text: fs.readFileSync(p, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/** runAssertion(root, currentSkillName, assertion) -> {ok, detail}. NEVER throws — see file header. */
function runAssertion(root, currentSkillName, a) {
  try {
    switch (a.type) {
      case 'file_exists': {
        const p = path.resolve(root, a.path);
        let ok = false;
        try { ok = fs.statSync(p).isFile(); } catch { ok = false; }
        return { ok, detail: (ok ? 'exists: ' : 'missing: ') + a.path };
      }
      case 'file_absent': {
        const p = path.resolve(root, a.path);
        const exists = fs.existsSync(p);
        return { ok: !exists, detail: (exists ? 'present (expected absent): ' : 'absent as expected: ') + a.path };
      }
      case 'json_valid': {
        const p = path.resolve(root, a.path);
        const r = readFileHonest(p);
        if (!r.ok) return { ok: false, detail: 'cannot read ' + a.path + ': ' + r.error };
        try { JSON.parse(r.text); return { ok: true, detail: 'valid JSON: ' + a.path }; }
        catch (e) { return { ok: false, detail: a.path + ' is not valid JSON: ' + e.message }; }
      }
      case 'max_lines': {
        const p = path.resolve(root, a.path);
        const r = readFileHonest(p);
        if (!r.ok) return { ok: false, detail: 'cannot read ' + a.path + ': ' + r.error };
        const lines = r.text.split(/\r?\n/).length;
        return { ok: lines <= a.n, detail: a.path + ': ' + lines + ' line(s) (max ' + a.n + ')' };
      }
      case 'contains':
      case 'not_contains': {
        const p = path.resolve(root, a.path);
        const r = readFileHonest(p);
        if (!r.ok) return { ok: false, detail: 'cannot read ' + a.path + ': ' + r.error };
        const found = r.text.includes(a.needle);
        const ok = a.type === 'contains' ? found : !found;
        return { ok, detail: (found ? 'needle FOUND in ' : 'needle NOT found in ') + a.path };
      }
      case 'frontmatter_field': {
        const targetSkill = a.skill || currentSkillName;
        const p = path.join(skillsDir(root), targetSkill, 'SKILL.md');
        const r = readFileHonest(p);
        if (!r.ok) return { ok: false, detail: 'cannot read ' + targetSkill + '/SKILL.md: ' + r.error };
        const fm = parseFrontmatter(r.text);
        const value = fm[a.field];
        if (value === undefined || value === '') return { ok: false, detail: 'frontmatter field "' + a.field + '" missing/empty in ' + targetSkill + '/SKILL.md' };
        if (a.max_length && value.length > a.max_length) return { ok: false, detail: '"' + a.field + '" is ' + value.length + ' chars (max ' + a.max_length + ') in ' + targetSkill + '/SKILL.md' };
        return { ok: true, detail: '"' + a.field + '" present' + (a.max_length ? (' (' + value.length + '/' + a.max_length + ' chars)') : '') + ' in ' + targetSkill + '/SKILL.md' };
      }
      default:
        return { ok: false, detail: 'unknown assertion type: ' + a.type };
    }
  } catch (e) {
    return { ok: false, detail: 'assertion threw unexpectedly: ' + e.message };
  }
}

/** runSkill(root, skillDirName) -> {skill, ok, error, total, passed, failed, results}. A malformed
 *  evals.json degrades to an honest per-skill error (see file header) rather than throwing. */
function runSkill(root, skillDirName) {
  const evalsPath = path.join(skillsDir(root), skillDirName, 'evals.json');
  let config;
  try { config = loadEvals(evalsPath, skillDirName); }
  catch (e) {
    return { skill: skillDirName, ok: false, error: e.message, total: 0, passed: 0, failed: 0, results: [] };
  }
  const results = config.assertions.map((a) => {
    const r = runAssertion(root, config.skill, a);
    return { id: a.id, type: a.type, ok: r.ok, detail: r.detail, why: typeof a.why === 'string' ? a.why : undefined };
  });
  const passed = results.filter((r) => r.ok).length;
  return { skill: config.skill, ok: passed === results.length, error: null, total: results.length, passed, failed: results.length - passed, results };
}

/** runAll(opts) -> {checked_at, root, skills, summary, ok}. See file header MODULE API. */
function runAll(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || PROJECT_ROOT_DEFAULT);
  let dirs = listSkillDirs(root);
  if (opts.skill) {
    dirs = dirs.filter((d) => d.name === opts.skill);
    if (dirs.length === 0) throw configError('no evals.json found for skill "' + opts.skill + '"');
  }
  const skills = dirs.map((d) => runSkill(root, d.name));
  const summary = {
    totalSkills: skills.length,
    passedSkills: skills.filter((s) => s.ok).length,
    failedSkills: skills.filter((s) => !s.ok).length,
    totalAssertions: skills.reduce((n, s) => n + s.total, 0),
    passedAssertions: skills.reduce((n, s) => n + s.passed, 0),
    failedAssertions: skills.reduce((n, s) => n + s.failed, 0),
  };
  return {
    checked_at: (opts.now instanceof Date ? opts.now : new Date()).toISOString(),
    root, skills, summary,
    ok: skills.every((s) => s.ok),
  };
}

module.exports = {
  PROJECT_ROOT_DEFAULT, ASSERTION_TYPES,
  listSkillDirs, loadEvals, validateAssertionShape, runAssertion, runSkill, runAll, parseFrontmatter,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, json: false, skill: null, root: null, usageError: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--skill') { opts.skill = rest[++i]; if (!opts.skill && !opts.usageError) opts.usageError = '--skill requires a <name>'; }
    else if (a === '--root') { opts.root = rest[++i]; if (!opts.root && !opts.usageError) opts.usageError = '--root requires a <dir>'; }
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-skill-evals.cjs run [--skill <name>] [--json] [--root <dir>]');
}
function formatResults(out) {
  const lines = ['forge-skill-evals — checked ' + out.skills.length + ' skill(s) @ ' + out.checked_at];
  for (const s of out.skills) {
    if (s.error) { lines.push('  [ERROR] ' + s.skill + ' — ' + s.error); continue; }
    lines.push('  [' + (s.ok ? 'PASS' : 'FAIL') + '] ' + s.skill + ' — ' + s.passed + '/' + s.total + ' assertion(s) passed');
    for (const r of s.results) {
      if (!r.ok) lines.push('    x ' + r.id + ' (' + r.type + ') — ' + r.detail);
    }
  }
  lines.push('  summary: ' + out.summary.passedSkills + '/' + out.summary.totalSkills + ' skill(s) · '
    + out.summary.passedAssertions + '/' + out.summary.totalAssertions + ' assertion(s)');
  return lines.join('\n');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.usageError) {
    console.error('forge-skill-evals: ' + args.usageError);
    printUsage();
    process.exitCode = 2;
  } else if (args.cmd === 'run') {
    try {
      const out = runAll({ root: args.root ? path.resolve(args.root) : undefined, skill: args.skill });
      if (args.json) console.log(JSON.stringify(out));
      else console.log(formatResults(out));
      process.exitCode = out.ok ? 0 : 1;
    } catch (e) {
      console.error('forge-skill-evals: ' + e.message);
      process.exitCode = e && e.code === 'ECONFIG' ? 2 : 1;
    }
  } else {
    printUsage();
    process.exitCode = 2;
  }
}
