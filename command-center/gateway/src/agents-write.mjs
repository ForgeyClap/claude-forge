// feat-agent-model-edit: the ONE deliberate, owner-approved break of this gateway's "only writes
// under command-center/.data/" rule (see paths.mjs's own COMMAND_CENTER_DATA_DIR comment). This
// module changes exactly ONE thing in a target project: an existing agent's `claudeTier` and/or
// `claudeEffort` value inside `.claude/config/agents/agent-model-map.json`. It never adds an agent,
// never touches any other field (`nvidia`, `nvidiaFallback`, `premium`, `why`, `prohibited`, ...),
// and never writes any other file inside `.claude/` except the one backup copy this module makes
// of itself before every write.
//
// SURGICAL, LINE-LEVEL EDIT (not JSON.parse + JSON.stringify): every real agent entry in this file
// is hand-formatted onto ONE line (verified by reading the file before writing this module). A
// parse-then-restringify round trip would re-flow every entry across multiple lines and could
// reorder keys, turning a one-field change into a whole-file diff — the opposite of what the work
// package asks ("behoud de JSON-opmaak/sleutelvolgorde... diff klein blijft"). Instead: JSON.parse
// is used only to VALIDATE (does the slug exist? what are the real current values? what are the
// real allowed values across the whole file?) and to VERIFY the edit afterwards; the actual bytes
// on disk are changed via a narrow, per-line regex substitution that touches only the requested
// field's string value — every other byte on that line, and every other line in the file, is
// untouched.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { containmentOk, safeIdOk } from './security.mjs';
import { COMMAND_CENTER_DATA_DIR } from './paths.mjs';

// The only two fields this route is ever allowed to change (work package: "ALLEEN claudeTier
// en/of claudeEffort van EEN BESTAANDE agent-slug wijzigt. Nooit een ander veld").
export const PATCHABLE_FIELDS = Object.freeze(['claudeTier', 'claudeEffort']);

const AUDIT_LOG_FILE = path.join(COMMAND_CENTER_DATA_DIR, 'agent-model-edits.jsonl');

// Test-only override seam (mirrors this codebase's existing `_set*ForTests` convention, e.g.
// conversations.mjs's `_setConversationsDirForTests`) — a unit test that exercises a REAL
// successful patch must never append to this gateway's own real `.data/agent-model-edits.jsonl`.
let auditLogFileOverride = null;
export function _setAuditLogFileForTests(filePath) { auditLogFileOverride = filePath; }
export function _resetAuditLogFileForTests() { auditLogFileOverride = null; }
function activeAuditLogFile() { return auditLogFileOverride || AUDIT_LOG_FILE; }

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches the ONE line holding `"<slug>": { ... }` (with an optional trailing comma) — this
 *  file's real agent entries are each hand-formatted onto a single line, verified by reading it
 *  before writing this module. Captures: [1] everything up to and including the opening `{`
 *  (`"<slug>":` plus its leading/inner whitespace), [2] the object literal itself, [3] any trailing
 *  comma/whitespace to end of line. */
function agentLineRegex(slug) {
  return new RegExp('^(\\s*"' + escapeRegExp(slug) + '"\\s*:\\s*)(\\{.*\\})(,?\\s*)$');
}

/** Matches `"<field>": "<value>"` inside one object-literal fragment — used both to read the
 *  CURRENT value and to replace it with the new one, never touching any sibling field on the
 *  same line. */
function fieldValueRegex(field) {
  return new RegExp('("' + escapeRegExp(field) + '"\\s*:\\s*")([^"]*)(")');
}

/** Distinct real `claudeTier`/`claudeEffort` string values currently present ANYWHERE in the
 *  parsed `agents` map — the work package's explicit allowlist rule: "leid de toegestane
 *  tiers/efforts af uit wat er ECHT in de config staat; verzin er niets bij." Recomputed from the
 *  live file on every request rather than hardcoded, so the allowlist can never drift stale against
 *  the real config. */
function deriveAllowedValues(agentsMap) {
  const tiers = new Set();
  const efforts = new Set();
  for (const entry of Object.values(agentsMap)) {
    if (entry && typeof entry.claudeTier === 'string') tiers.add(entry.claudeTier);
    if (entry && typeof entry.claudeEffort === 'string') efforts.add(entry.claudeEffort);
  }
  return { claudeTier: [...tiers].sort(), claudeEffort: [...efforts].sort() };
}

function fail(status, error) {
  return { ok: false, status, body: { ok: false, error } };
}

/**
 * Patches an existing agent's `claudeTier` and/or `claudeEffort` in
 * `<projectPath>/.claude/config/agents/agent-model-map.json`.
 *
 * `patch` must be a plain object containing only keys from `PATCHABLE_FIELDS`, each a string value
 * already present as a real value somewhere in the file (see `deriveAllowedValues`). Every other
 * validation failure returns a real `{ok:false, status, body}` — nothing is ever written on a
 * rejected request.
 *
 * Returns `{ ok:true, status:200, body }` on success, where `body.model_tier`/`body.claude_effort`
 * are read back FRESH from the file the write just produced — never the merely-requested value —
 * per the work package's "nooit alleen optimistisch de gekozen waarde" rule.
 */
export function patchAgentModel({ projectPath, projectName, slug, patch }) {
  if (!safeIdOk(slug)) return fail(400, 'invalid agent slug');
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return fail(400, 'patch must be a JSON object');
  }
  const requestedFields = Object.keys(patch);
  if (requestedFields.length === 0) {
    return fail(400, 'at least one of ' + PATCHABLE_FIELDS.join('/') + ' must be provided');
  }
  for (const key of requestedFields) {
    if (!PATCHABLE_FIELDS.includes(key)) return fail(400, 'unknown field: ' + key);
    if (typeof patch[key] !== 'string' || patch[key].length === 0) {
      return fail(400, key + ' must be a non-empty string');
    }
  }

  const claudeDir = path.join(projectPath, '.claude');
  const configAgentsDir = path.join(claudeDir, 'config', 'agents');
  const modelMapFile = path.join(configAgentsDir, 'agent-model-map.json');
  // Defense in depth (never trust a single check point) — mirrors agents.mjs's own containment
  // guard, plus a NARROWER check scoped to exactly `.claude/config/agents/` per the work package's
  // explicit "nooit buiten .claude/config/agents/ geschreven wordt" instruction.
  if (!containmentOk(claudeDir, modelMapFile) || !containmentOk(configAgentsDir, modelMapFile)) {
    return fail(400, 'path containment violation');
  }

  if (!fs.existsSync(modelMapFile)) {
    return fail(404, 'agent-model-map.json not found for this project');
  }
  let rawText;
  try {
    rawText = fs.readFileSync(modelMapFile, 'utf8');
  } catch (err) {
    return fail(502, 'failed to read agent-model-map.json: ' + err.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return fail(502, 'agent-model-map.json is not valid JSON: ' + err.message);
  }
  const agentsMap = parsed && typeof parsed.agents === 'object' && parsed.agents !== null ? parsed.agents : {};
  if (!Object.prototype.hasOwnProperty.call(agentsMap, slug)) {
    return fail(404, 'unknown agent slug: ' + slug);
  }
  const currentEntry = agentsMap[slug];
  const allowed = deriveAllowedValues(agentsMap);

  for (const key of requestedFields) {
    if (!allowed[key].includes(patch[key])) {
      return fail(400, key + ' must be one of the real values already in agent-model-map.json: ' + allowed[key].join(', '));
    }
    if (!Object.prototype.hasOwnProperty.call(currentEntry, key)) {
      return fail(400, key + ' is not currently set for agent "' + slug + '" — this route can only modify an existing field, never add one');
    }
  }

  const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
  const lines = rawText.split(eol);
  const lineRe = agentLineRegex(slug);
  const matchIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineRe.test(lines[i])) matchIndices.push(i);
  }
  if (matchIndices.length !== 1) {
    return fail(500, 'could not uniquely locate the single-line entry for agent "' + slug + '" (found ' + matchIndices.length + ' candidates) — refusing to write');
  }
  const lineIndex = matchIndices[0];
  const lineMatch = lines[lineIndex].match(lineRe);
  const [, linePrefix, objectLiteral, lineSuffix] = lineMatch;

  // Belt-and-suspenders: the captured object literal must itself be valid JSON and deep-equal what
  // the earlier full-file parse already found at agentsMap[slug] — if this ever disagreed, the line
  // regex found the wrong line (or the file's real shape has drifted from the hand-formatted,
  // one-line-per-agent convention this module depends on), and writing would be unsafe.
  let objectFromLine;
  try {
    objectFromLine = JSON.parse(objectLiteral);
  } catch (err) {
    return fail(500, 'the located line is not valid JSON on its own — refusing to write: ' + err.message);
  }
  if (JSON.stringify(objectFromLine) !== JSON.stringify(currentEntry)) {
    return fail(500, 'internal consistency check failed (located line does not match the parsed config) — refusing to write');
  }

  let newObjectLiteral = objectLiteral;
  const changed = {};
  for (const key of requestedFields) {
    const fieldRe = fieldValueRegex(key);
    const fieldMatch = newObjectLiteral.match(fieldRe);
    if (!fieldMatch) return fail(500, 'could not locate "' + key + '" on the agent\'s own line — refusing to write');
    const oldValue = fieldMatch[2];
    if (oldValue === patch[key]) { changed[key] = { old: oldValue, new: patch[key] }; continue; } // no-op field, still honestly reported
    newObjectLiteral = newObjectLiteral.replace(fieldRe, '$1' + patch[key] + '$3');
    changed[key] = { old: oldValue, new: patch[key] };
  }

  const newLine = linePrefix + newObjectLiteral + lineSuffix;
  const newLines = lines.slice();
  newLines[lineIndex] = newLine;
  const newRawText = newLines.join(eol);

  // Second verification pass: the CANDIDATE new text must itself parse, and the target agent's new
  // values must match exactly what was requested, with every OTHER field on that agent byte-for-byte
  // unchanged. Nothing is written to disk until this passes.
  let verifyParsed;
  try {
    verifyParsed = JSON.parse(newRawText);
  } catch (err) {
    return fail(500, 'candidate edit produced invalid JSON — refusing to write: ' + err.message);
  }
  const verifyEntry = verifyParsed.agents && verifyParsed.agents[slug];
  if (!verifyEntry) return fail(500, 'candidate edit lost the agent entry — refusing to write');
  for (const key of requestedFields) {
    if (verifyEntry[key] !== patch[key]) return fail(500, 'candidate edit did not apply "' + key + '" — refusing to write');
  }
  for (const key of Object.keys(currentEntry)) {
    if (requestedFields.includes(key)) continue;
    if (JSON.stringify(verifyEntry[key]) !== JSON.stringify(currentEntry[key])) {
      return fail(500, 'candidate edit unexpectedly changed sibling field "' + key + '" — refusing to write');
    }
  }

  // ── Backup (mirrors this project's existing `.claude/forge-backups/<batchId>/<rel>` convention,
  // forge-bin/forge-sync.cjs's own backupDirFor) — taken BEFORE any write, from the bytes just read. ──
  const batchId = 'agent-model-edit-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const backupDir = path.join(claudeDir, 'forge-backups', batchId);
  const backupTarget = path.join(backupDir, 'config', 'agents', 'agent-model-map.json');
  if (!containmentOk(claudeDir, backupTarget)) return fail(500, 'backup path containment violation — refusing to write');
  try {
    fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
    fs.copyFileSync(modelMapFile, backupTarget);
  } catch (err) {
    return fail(500, 'failed to create backup before writing — nothing changed: ' + err.message);
  }

  // ── Atomic write: temp file in the SAME directory, then rename. Original bytes are untouched
  // unless/until the rename succeeds, so a failure mid-write never leaves a half-written file. ──
  const tmpFile = modelMapFile + '.tmp-' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(tmpFile, newRawText, 'utf8');
    fs.renameSync(tmpFile, modelMapFile);
  } catch (err) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup only */ }
    return fail(500, 'failed to write agent-model-map.json (a pre-write backup exists at ' + backupTarget + '): ' + err.message);
  }

  // ── Read back FRESH from disk — never the in-memory candidate — so the response reports the
  // REAL value now on disk, per the work package's "nooit alleen optimistisch" rule. ──
  let freshEntry = null;
  let freshReadOk = true;
  try {
    const freshParsed = JSON.parse(fs.readFileSync(modelMapFile, 'utf8'));
    freshEntry = freshParsed.agents ? freshParsed.agents[slug] : null;
  } catch {
    freshReadOk = false;
  }

  // ── Traceable audit trail — gateway-owned `.data/`, never `.claude/` (D2 write-boundary rule
  // stays intact for the audit trail even though the config write itself is an explicit, scoped
  // exception to it). Best-effort: a failure here never undoes or fails the already-verified,
  // already-written config change. ──
  let auditLogged = true;
  try {
    const targetAuditFile = activeAuditLogFile();
    fs.mkdirSync(path.dirname(targetAuditFile), { recursive: true });
    const auditLine = {
      event_type: 'file_changed',
      timestamp: new Date().toISOString(),
      project: projectName ?? null,
      agent: slug,
      path: 'config/agents/agent-model-map.json',
      changes: changed,
      backup_path: backupTarget,
    };
    fs.appendFileSync(targetAuditFile, JSON.stringify(auditLine) + '\n', 'utf8');
  } catch {
    auditLogged = false;
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      project: projectName ?? null,
      slug,
      model_tier: freshReadOk && freshEntry ? freshEntry.claudeTier ?? null : null,
      claude_effort: freshReadOk && freshEntry ? freshEntry.claudeEffort ?? null : null,
      changed,
      allowed,
      backup_path: backupTarget,
      audit_logged: auditLogged,
      fresh_read_ok: freshReadOk,
    },
  };
}
