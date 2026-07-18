#!/usr/bin/env node
'use strict';
/**
 * forge-prd.cjs — zero-dependency PRD writer for Forge Mission Control Phase 2 (WP3 "PRD generator").
 * Windows-safe (node "C:/Program Files/nodejs/node.exe" or any Node on PATH).
 *
 * Renders a structured PRD object to a markdown document + a JSON meta sidecar, stores both via
 * forge-store.cjs (`.claude/forge-prd/`), and can auto-create one ticket per acceptance criterion
 * (`.claude/forge-tickets/`) so review gates and the Ticket Board pick them up automatically.
 *
 * REUSES forge-bin/forge-store.cjs (do not re-implement its guards):
 *   - redactValue      — deep-redacts every string leaf before anything touches disk or stdout.
 *   - resolveStoreDir  — path-contained resolution of the forge-prd/ store dir.
 *   - putEntity        — hardened, redacting, id-validated ticket writer (forge-tickets/).
 *   - isValidId        — same ^[A-Za-z0-9_-]+$ guard used everywhere in Forge (blocks traversal).
 *   - CLAUDE_DIR        — project .claude/ root (honors FORGE_STORE_ROOT for hermetic tests).
 *
 * PRD shape (`prd.sections` object, snake_case keys, each value a string OR an array of strings):
 *   goal, users, problem, solution, modules, user_stories, mvp_scope, non_goals, architecture, risks,
 *   test_plan, roadmap, and acceptance_criteria (array of {id?, text, owner?, required_tests?[]} or
 *   plain strings). A missing section renders as "_(not specified)_" — never crashes.
 *
 * CLI:
 *   node forge-prd.cjs render '<prd-json>'
 *     -> prints the rendered markdown to stdout. DRY — never writes anything.
 *   node forge-prd.cjs write '<prd-json>' [--run <run_id>] [--tickets]
 *     -> writePrd(); with --tickets also runs criteriaToTickets(); with --run logs prd_generated
 *        (and one ticket_created per created ticket) to that run's dashboard events via
 *        ../forge-dashboard/log-event.cjs (event types are already registered — nothing to add there).
 *   Bad or missing JSON exits 1 with a clear message. Guarded end-to-end; never throws uncaught.
 *
 * Module API: require('./forge-prd.cjs') -> { renderPrd, writePrd, criteriaToTickets }
 *
 * SECRET HYGIENE: every string in the PRD is redacted (forge-store's redactValue) before it is
 * rendered to markdown or written to disk — a raw secret is never rendered, stored, or printed.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { redactValue, resolveStoreDir, putEntity, isValidId, CLAUDE_DIR } = require('./forge-store.cjs');

// ---- markdown rendering ----
const SECTION_ORDER = [
  ['Goal', 'goal'], ['Users', 'users'], ['Problem', 'problem'], ['Solution', 'solution'],
  ['Modules', 'modules'], ['User Stories', 'user_stories'], ['MVP Scope', 'mvp_scope'],
  ['Non-Goals', 'non_goals'], ['Architecture', 'architecture'], ['Risks', 'risks'],
  ['Acceptance Criteria', 'acceptance_criteria'], ['Test Plan', 'test_plan'], ['Roadmap', 'roadmap'],
];
const NOT_SPECIFIED = '_(not specified)_';

function renderCriterion(c, idx) {
  if (typeof c === 'string') { const s = c.trim(); return '- ' + (s || '(empty criterion)'); }
  if (c && typeof c === 'object') {
    const id = c.id || ('ac-' + (idx + 1));
    const text = (typeof c.text === 'string' && c.text.trim()) || '(no text)';
    let line = '- **' + id + '** — ' + text;
    if (c.owner) line += ' _(owner: ' + c.owner + ')_';
    if (Array.isArray(c.required_tests) && c.required_tests.length) line += ' _(tests: ' + c.required_tests.join(', ') + ')_';
    return line;
  }
  return '- (invalid criterion)';
}
function renderSectionBody(key, value) {
  if (key === 'acceptance_criteria') {
    if (!Array.isArray(value) || !value.length) return NOT_SPECIFIED;
    return value.map(renderCriterion).join('\n');
  }
  if (Array.isArray(value)) {
    if (!value.length) return NOT_SPECIFIED;
    return value.map((v) => '- ' + (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return NOT_SPECIFIED;
}
/** renderPrd(prd) -> markdown string. Pure, guarded — never throws on a malformed/partial prd. */
function renderPrd(prd) {
  const p = (prd && typeof prd === 'object') ? redactValue(prd) : {};
  const sections = (p.sections && typeof p.sections === 'object') ? p.sections : {};
  const lines = [];
  lines.push('# ' + (p.title || 'Untitled PRD'));
  lines.push('');
  lines.push('_prd_id: ' + (p.prd_id || '—') + ' · project: ' + (p.project || '—') + ' · created: ' + (p.created || '—') + '_');
  for (const [heading, key] of SECTION_ORDER) {
    lines.push('');
    lines.push('## ' + heading);
    lines.push('');
    lines.push(renderSectionBody(key, sections[key]));
  }
  return lines.join('\n').trimEnd() + '\n';
}

// ---- store writes (forge-prd/<id>.md + <id>.meta.json + index.jsonl) ----
function resolvePrdFile(id, ext) {
  if (!isValidId(id)) throw new Error('writePrd: invalid prd_id (allowed: A-Z a-z 0-9 _ -): ' + id);
  const dir = resolveStoreDir('prd');
  const file = path.join(dir, id + ext);
  const base = path.resolve(dir), resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('writePrd: id escapes forge-prd/ — refused');
  return { dir, file };
}
/** writePrd(prd) -> { prd_id, mdPath, metaPath }. Validates prd_id, redacts, writes md+meta+index row. */
function writePrd(prd) {
  if (!prd || typeof prd !== 'object') throw new Error('writePrd: prd must be an object');
  const id = prd.prd_id;
  const { dir, file: mdPath } = resolvePrdFile(id, '.md');
  const { file: metaPath } = resolvePrdFile(id, '.meta.json');
  fs.mkdirSync(dir, { recursive: true });
  const redacted = redactValue(prd);
  const md = renderPrd(redacted);
  const generated = new Date().toISOString();
  const meta = Object.assign({}, redacted, { _generated: generated });
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify({ id, ts: generated, store: 'prd', title: redacted.title || '' }) + '\n', 'utf8');
  return { prd_id: id, mdPath, metaPath };
}

// ---- acceptance criteria -> tickets (forge-tickets/tk-<prd_id>-<n>) ----
/** criteriaToTickets(prd, opts) -> array of created ticket ids. Never crashes on a bad ticket id — skips + warns. */
function criteriaToTickets(prd, opts) {
  opts = opts || {};
  if (!prd || typeof prd !== 'object') return [];
  const redacted = redactValue(prd);
  const prdId = redacted.prd_id;
  const raw = (redacted.sections && redacted.sections.acceptance_criteria) || [];
  const criteria = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const created = [];
  criteria.forEach((c, i) => {
    const n = i + 1;
    const ticketId = 'tk-' + prdId + '-' + n;
    if (!isValidId(ticketId)) { console.error('forge-prd: skipping invalid ticket id "' + ticketId + '"'); return; }
    const text = typeof c === 'string' ? c : ((c && c.text) || ('acceptance criterion ' + n));
    const owner = (c && typeof c === 'object' && c.owner) || null;
    const requiredTests = (c && typeof c === 'object' && Array.isArray(c.required_tests)) ? c.required_tests : [];
    const criterionId = (c && typeof c === 'object' && c.id) || ('ac-' + n);
    const value = {
      ticket_id: ticketId, prd_id: prdId, run_id: opts.run_id || opts.run || null,
      title: text, description: 'Acceptance criterion ' + criterionId + ' for PRD ' + prdId,
      owner, status: 'open', required_tests: requiredTests, related_files: [], risk_level: 'med',
      created: new Date().toISOString(),
    };
    try { putEntity('tickets', ticketId, value); created.push(ticketId); }
    catch (e) { console.error('forge-prd: failed to create ticket ' + ticketId + ': ' + e.message); }
  });
  return created;
}

function logEvent(runId, eventType, extra) {
  const logEventPath = path.join(CLAUDE_DIR, 'forge-dashboard', 'log-event.cjs');
  return spawnSync(process.execPath, [logEventPath, runId, eventType, JSON.stringify(extra || {})], { encoding: 'utf8' });
}

module.exports = { renderPrd, writePrd, criteriaToTickets };

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0];

    if (cmd === 'render') {
      const json = argv[1];
      if (!json) { console.error("Usage: node forge-prd.cjs render '<prd-json>'"); process.exitCode = 1; return; }
      let prd;
      try { prd = JSON.parse(json); } catch (e) { console.error('forge-prd: invalid JSON: ' + e.message); process.exitCode = 1; return; }
      console.log(renderPrd(prd));
      return;
    }

    if (cmd === 'write') {
      const json = argv[1];
      if (!json) { console.error("Usage: node forge-prd.cjs write '<prd-json>' [--run <id>] [--tickets]"); process.exitCode = 1; return; }
      let prd;
      try { prd = JSON.parse(json); } catch (e) { console.error('forge-prd: invalid JSON: ' + e.message); process.exitCode = 1; return; }

      let run = null, wantTickets = false;
      for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--run') run = argv[++i];
        else if (argv[i] === '--tickets') wantTickets = true;
      }

      let result;
      try { result = writePrd(prd); }
      catch (e) { console.error('forge-prd: write failed: ' + e.message); process.exitCode = 1; return; }

      let ticketIds = [];
      if (wantTickets) {
        try { ticketIds = criteriaToTickets(prd, { run_id: run }); }
        catch (e) { console.error('forge-prd: ticket creation failed: ' + e.message); }
      }

      if (run) {
        const g = logEvent(run, 'prd_generated', { agent: 'orchestrator', note: 'PRD generated: ' + (prd.title || result.prd_id), prd_id: result.prd_id });
        if (g.status !== 0) console.error('forge-prd: log-event (prd_generated) warning: ' + (g.stderr || '').trim());
        for (const tid of ticketIds) {
          const te = logEvent(run, 'ticket_created', { agent: 'orchestrator', note: 'Ticket created from acceptance criterion', ticket_id: tid, prd_id: result.prd_id });
          if (te.status !== 0) console.error('forge-prd: log-event (ticket_created) warning: ' + (te.stderr || '').trim());
        }
      }

      console.log('PRD written: ' + result.prd_id);
      console.log('  md:   ' + result.mdPath);
      console.log('  meta: ' + result.metaPath);
      console.log('  tickets created: ' + ticketIds.length + (ticketIds.length ? ' (' + ticketIds.join(', ') + ')' : ''));
      return;
    }

    console.error('Usage: node forge-prd.cjs <render|write> \'<prd-json>\' [--run <id>] [--tickets]');
    process.exitCode = 1;
  };
  try { main(); } catch (e) { console.error('forge-prd: ' + e.message); process.exitCode = 1; }
}
