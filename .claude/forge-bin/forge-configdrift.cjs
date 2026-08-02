#!/usr/bin/env node
'use strict';
/**
 * forge-configdrift.cjs — hashes the files that determine a run's BEHAVIOUR at run start, re-hashes them at
 * run end, and diffs the two. Zero-dependency (fs/path/crypto only), Windows-safe, ADVISORY-ONLY.
 *
 * WHY THIS EXISTS (measured, not assumed). On 2026-08-01 `config-baseline` / `configBaseline` returned zero
 * hits anywhere in this project outside a research note. The doctor hashes EVENTS (chainCheck) and nothing
 * else: forge-verify compares claims against events.jsonl and the ticket store, forge-integrity checks the
 * event chain — but not one tool in the repo recorded what the GOVERNING CONFIGURATION looked like when a run
 * began. Two concrete failures follow from that gap, and they point in opposite directions:
 *
 *   (1) SILENT SELF-WIDENING. An agent edits `config/agents/agent-tool-policy.json` mid-run to grant itself a
 *       tool it was not dispatched with. Every later event in that run is then legitimate under the NEW policy
 *       and there is no record that the old one ever said otherwise. Nothing detects it, because nothing knows
 *       what the policy said an hour ago.
 *   (2) THE CLAIM THAT CHANGED NOTHING. An agent logs "tightened the hard rules" / "widened the skill's
 *       trigger" and the bytes are byte-identical afterwards. This is the failure the research note recorded
 *       from a real incident: two stored versions of a system prompt were identical while the chat insisted
 *       the knowledge had been added. A completion claim like that is not a small inaccuracy — it is a NO-OP
 *       being carried forward as done work.
 *
 * SO THE CHECK RUNS IN BOTH DIRECTIONS, and each direction needs the other to be useful:
 *   direction 1 — a hash that CHANGED with no event announcing it   -> `unannounced_change`
 *   direction 2 — an event ANNOUNCING a change with an identical hash -> `noop_claim` (the claim is rejected)
 * A change that was announced AND really happened is clean and is reported as such (`announced_changes`), so
 * legitimate governance edits during a run are never punished — only undeclared ones and imaginary ones.
 *
 * WHY A MODULE AND NOT A DOCTOR CHECK. forge-doctor.cjs answers "is the project healthy RIGHT NOW" from a
 * single snapshot; it has no run context and no notion of before/after. This check is inherently two-moment
 * and run-scoped: it needs a `run_id`, it must be able to write a baseline at dispatch time and read it back
 * at completion time, and its verdict is about one run, not about the project. A doctor check literally cannot
 * hold the "before". So the two-moment logic lives here with its own CLI (`snapshot` / `diff`), and the place
 * it is SURFACED is forge-verify.cjs — the tool that already asks "does this run's claim hold up against what
 * was really logged", already reads the same run dir and events.jsonl, and already has an established pattern
 * for advisory sections (Evidence:, Loop:). Nothing about that wiring changes forge-verify's exit code.
 *
 * ADVISORY. `ok:false` here means "a human should look at this", never "the run failed". forge-verify prints
 * the section and folds NOTHING into its gate — same contract as its Evidence:/Loop: sections. A drift meter
 * that can fail a build would get switched off the first time it was inconvenient, and then it would be
 * guarding nothing.
 *
 * WHAT IS HASHED (the governance surface — the files that change how a run BEHAVES):
 *   agent_registry        .claude/config/agents/agent-registry.json
 *   agent_tool_policy     .claude/config/agents/agent-tool-policy.json
 *   hard_rules            .claude/config/orchestration/FORGE_HARD_RULES.json
 *   recovery_policy       .claude/config/orchestration/FORGE_RECOVERY_POLICY.json
 *   project_claude_md     CLAUDE.md
 *   skill_frontmatter:<n> .claude/skills/<n>/SKILL.md — THE FRONTMATTER BLOCK ONLY
 * The skill entries hash the frontmatter and not the body ON PURPOSE: the frontmatter is what decides whether
 * a skill is offered to the model at all (its name and description are the always-loaded trigger surface —
 * see forge-contextbudget.cjs), while the body is ordinary prose that is read only after invocation. Rewriting
 * a paragraph of guidance is authoring; rewriting a trigger line changes which skill fires on which request,
 * which is governance. Hashing the whole file would drown the second in the first.
 *
 * TWO HASHES PER JSON SOURCE, so reformatting is not reported as drift. `sha256` is over the raw bytes;
 * `semantic_sha256` is over a key-sorted canonical re-serialisation. When the raw hash moves and the semantic
 * one does not, the file was reformatted and nothing about the run's behaviour changed — that is a NOTE
 * (`formatting_only`), not a finding. A file that stops being valid JSON has no semantic hash and is compared
 * on raw bytes alone, which is the safe direction: it will be reported.
 *
 * MODEL:
 *   sources(root)                      -> [{id, kind, path}] — the declared governance surface
 *   snapshot(root, opts)               -> {generated_at, root, entries:[{id, kind, path, exists, sha256, semantic_sha256, bytes}]}
 *   writeBaseline(root, runId, opts)   -> {path, baseline} — writes <runDir>/config-baseline.json
 *   readBaseline(root, runId, opts)    -> baseline | null
 *   announcementsFor(events, entries, root) -> Map(id -> [{event_type, agent, note}])
 *   checkDrift(root, runId, opts)      -> report (below)
 *   summarize(report)                  -> one human line
 *
 * REPORT: {ok, comparable, run_id, generated_at, baseline_at, findings[], notes[], announced_changes[],
 *          unchanged, checked, reason}
 *   findings[]: {kind:'unannounced_change'|'noop_claim'|'source_removed'|'source_added', id, path, detail, claimed_by?}
 *   notes[]   : {kind:'formatting_only'|'unannounced_removal_note', id, detail} — informational, never flip ok
 *   ok = findings.length === 0. comparable=false means there was no baseline to compare against (an honest
 *   "cannot tell", never a red).
 *
 * CLI:
 *   node forge-configdrift.cjs snapshot <run_id> [--root DIR]        # at run start
 *   node forge-configdrift.cjs diff <run_id> [--root DIR] [--json]   # at run end
 *   Exit code is ALWAYS 0 — advisory (see above). Usage errors exit 1.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASELINE_FILE = 'config-baseline.json';
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** The declared governance surface. Kept as DATA rather than inline reads so adding a source is one line and
 *  every source automatically gets the same hashing, the same announcement matching and the same baseline
 *  entry — the mistake that would otherwise happen is a new config file being guarded in one direction only. */
const FIXED_SOURCES = [
  { id: 'agent_registry', kind: 'json', rel: ['.claude', 'config', 'agents', 'agent-registry.json'] },
  { id: 'agent_tool_policy', kind: 'json', rel: ['.claude', 'config', 'agents', 'agent-tool-policy.json'] },
  { id: 'hard_rules', kind: 'json', rel: ['.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'] },
  { id: 'recovery_policy', kind: 'json', rel: ['.claude', 'config', 'orchestration', 'FORGE_RECOVERY_POLICY.json'] },
  { id: 'project_claude_md', kind: 'text', rel: ['CLAUDE.md'] },
];

/** Event types that can ANNOUNCE a governance change. Every one is already registered in
 *  forge-dashboard/log-event.cjs KNOWN_EVENT_TYPES — this module invents no event vocabulary, exactly like
 *  forge-verify.cjs. `decision_logged` is included because a deliberate policy change is often recorded as a
 *  decision rather than as a file write, and refusing to accept that would push people to log less, not more. */
const ANNOUNCE_EVENT_TYPES = new Set([
  'file_changed', 'claude_md_created', 'claude_md_updated',
  'custom_skill_created', 'custom_skill_updated', 'decision_logged',
]);
/** Where a path may sit on an announcing event — the same field vocabulary forge-verify.cjs's isolation
 *  tripwire already scans, plus `config_path` for a decision that names the file it governs. */
const ANNOUNCE_PATH_FIELDS = ['path', 'file', 'config_path', 'target_path', 'output_path'];
const ANNOUNCE_PATH_ARRAY_FIELDS = ['files_changed'];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readFileSafe(p) { try { return fs.readFileSync(p); } catch { return null; } }

/** canonicalJson — key-sorted, whitespace-free re-serialisation, so `semantic_sha256` answers "did the MEANING
 *  change" rather than "did somebody run a formatter". Recurses through objects and arrays; array ORDER is
 *  preserved because in every one of these configs order is meaningful (a rules list, an allow list). */
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

/** frontmatterBlock(text) -> the raw text BETWEEN the leading `---` fences, or null when there is none.
 *  Returns the block only — not the fences, not the body. A SKILL.md with no frontmatter has nothing that
 *  decides when it fires, so it hashes as the empty string rather than as its prose. */
function frontmatterBlock(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** MAX_SKILL_DEPTH — how far below `.claude/skills` the SKILL.md walk descends.
 *
 *  IT IS NOT 1, and that is a measured correction rather than a preference. The first version of this file
 *  read `.claude/skills/<name>/SKILL.md` only — the literal shape the design note named — and found 49 of this
 *  project's 57 skills. The missing 8 are the `gsap/gsap-*` bundle one level deeper, and their frontmatter
 *  decides when they fire exactly like every other skill's. A governance meter that quietly covers 86% of the
 *  governed surface is the same failure forge-contextbudget.cjs's header documents at 21%: it converts an
 *  unknown into a false reassurance. 4 = the deepest layout that exists here (2) plus headroom, BOUNDED so a
 *  symlink loop can never turn a read-only hash into an unbounded crawl, and a walk that stops at the cap
 *  records `capped` so a too-shallow limit reads as a warning instead of a smaller number. */
const MAX_SKILL_DEPTH = 4;

/** listSkillDirs(root) -> [{name, path}] — every SKILL.md under `.claude/skills`, at any depth up to the cap,
 *  named by its path relative to that root (`gsap/gsap-core`) so nested bundle skills get distinct, stable
 *  ids. Symlink/cycle-guarded: each directory is resolved with realpath and visited at most once. */
function listSkillDirs(root, maxDepth) {
  const limit = Number.isFinite(maxDepth) && maxDepth > 0 ? Math.floor(maxDepth) : MAX_SKILL_DEPTH;
  const base = path.join(root, '.claude', 'skills');
  const out = [];
  const seen = new Set();
  let capped = false;
  try { if (!fs.statSync(base).isDirectory()) return out; } catch { return out; }
  try { seen.add(fs.realpathSync(base)); } catch { seen.add(path.resolve(base)); }
  (function walk(dir, depth) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.name === 'SKILL.md' && !e.isDirectory()) {
        if (depth === 0) continue; // a SKILL.md directly in the skills root has no skill directory to name
        out.push({ name: path.relative(base, dir).split(path.sep).join('/'), path: p });
        continue;
      }
      let isDir = e.isDirectory();
      // isDirectory() is false for a symlinked directory on Windows — stat it rather than trusting the flag
      if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch { isDir = false; } }
      if (!isDir) continue;
      if (depth >= limit) { capped = true; continue; }
      let real; try { real = fs.realpathSync(p); } catch { real = path.resolve(p); }
      if (seen.has(real)) continue;
      seen.add(real);
      walk(p, depth + 1);
    }
  })(base, 0);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.capped = capped;
  return out;
}

/** sources(root) -> the full declared surface for THIS project, fixed files first then one entry per skill.
 *  Pure path computation: it does not read a byte, so a caller can show what WOULD be guarded. */
function sources(root) {
  const r = path.resolve(root);
  const out = FIXED_SOURCES.map((s) => ({ id: s.id, kind: s.kind, path: path.join(r, ...s.rel) }));
  for (const s of listSkillDirs(r)) out.push({ id: 'skill_frontmatter:' + s.name, kind: 'frontmatter', path: s.path });
  return out;
}

/** hashSource — one source, one entry. A missing file is `exists:false` with a null hash, NEVER an omitted
 *  entry: an entry that silently vanishes between baseline and now would read as "nothing to compare" when it
 *  actually means the file was deleted. */
function hashSource(src) {
  const buf = readFileSafe(src.path);
  if (buf === null) return { id: src.id, kind: src.kind, path: src.path, exists: false, sha256: null, semantic_sha256: null, bytes: 0 };
  if (src.kind === 'frontmatter') {
    const block = frontmatterBlock(buf.toString('utf8'));
    const material = block === null ? '' : block;
    return {
      id: src.id, kind: src.kind, path: src.path, exists: true,
      sha256: sha256(Buffer.from(material, 'utf8')), semantic_sha256: null,
      bytes: Buffer.byteLength(material, 'utf8'), has_frontmatter: block !== null,
    };
  }
  let semantic = null;
  if (src.kind === 'json') {
    // a file that stopped being valid JSON has NO semantic hash and is compared on raw bytes alone — the safe
    // direction, because "I cannot tell whether the meaning changed" must resolve to "report it", not to "pass"
    try { semantic = sha256(Buffer.from(canonicalJson(JSON.parse(buf.toString('utf8'))), 'utf8')); } catch { semantic = null; }
  }
  return { id: src.id, kind: src.kind, path: src.path, exists: true, sha256: sha256(buf), semantic_sha256: semantic, bytes: buf.length };
}

/** snapshot(root, opts) -> {generated_at, root, entries[]}. PURE READ — opens files, writes nothing. */
function snapshot(root, opts) {
  opts = opts || {};
  const r = path.resolve(root);
  const list = (opts.sources || sources(r));
  return { generated_at: new Date().toISOString(), root: r, entries: list.map(hashSource) };
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !ID_RE.test(runId)) {
    throw new Error('forge-configdrift: invalid run_id (allowed: A-Z a-z 0-9 _ -): ' + runId);
  }
}
function runDirOf(root, runId, opts) {
  assertRunId(runId);
  if (opts && opts.runDir) return path.resolve(opts.runDir);
  return path.join(path.resolve(root), '.claude', 'forge-runs', runId);
}

/** writeBaseline(root, runId, opts) -> {path, baseline}. The ONLY write this module performs, and it lands
 *  next to the run it describes — never in a shared config file, because a baseline is a fact about ONE run
 *  and a shared one would be overwritten by whichever run finished last. */
function writeBaseline(root, runId, opts) {
  const dir = runDirOf(root, runId, opts);
  const snap = snapshot(root, opts);
  const baseline = {
    _doc: 'Governance-config baseline for this run, written by forge-bin/forge-configdrift.cjs at run start '
      + 'and diffed at run end (`diff <run_id>`). ADVISORY: a finding means a human should look, never that '
      + 'the run failed. Hashes cover the files that decide how a run BEHAVES — the agent registry, the agent '
      + 'tool policy, the hard rules, the recovery policy, the project CLAUDE.md, and the FRONTMATTER of every '
      + 'project skill (not their bodies).',
    run_id: runId,
    generated_at: snap.generated_at,
    root: snap.root,
    entries: snap.entries,
  };
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, BASELINE_FILE);
  fs.writeFileSync(p, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  return { path: p, baseline };
}

function readBaseline(root, runId, opts) {
  const dir = runDirOf(root, runId, opts);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, BASELINE_FILE), 'utf8'));
    if (!raw || !Array.isArray(raw.entries)) return null;
    return raw;
  } catch { return null; }
}

/** readEvents — same tolerance forge-verify.cjs's readEventsJsonl uses: BOM-tolerant, malformed lines skipped,
 *  a missing file is an empty list rather than a throw (a run that logged nothing still gets its hashes
 *  compared — see the test "a run with no events.jsonl still compares hashes"). */
function readEvents(runDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.replace(/^﻿/, '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { const e = JSON.parse(s); if (e && typeof e === 'object') out.push(e); } catch { /* skip */ }
  }
  return out;
}

function samePath(a, b) {
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** eventPaths(e, root) — every path field on an announcing event, resolved against the project root so a
 *  RELATIVE announcement ("CLAUDE.md") matches the absolute source path it names. An agent that logs a
 *  relative path is being no less honest than one that logs an absolute path. */
function eventPaths(e, root) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) out.push(path.resolve(root, v.trim())); };
  for (const f of ANNOUNCE_PATH_FIELDS) push(e[f]);
  for (const f of ANNOUNCE_PATH_ARRAY_FIELDS) if (Array.isArray(e[f])) e[f].forEach(push);
  return out;
}

/** announcementsFor(events, entries, root) -> Map(source id -> [{event_type, agent, note}])
 *  An announcement is an event of an announcing type carrying a path that resolves to that source's file.
 *  Matching by PATH and not by name is deliberate: a note saying "updated the tool policy" is prose, while a
 *  path is a fact, and this check must not be satisfiable by wording. */
function announcementsFor(events, entries, root) {
  const map = new Map();
  for (const e of events) {
    if (!e || typeof e !== 'object' || !ANNOUNCE_EVENT_TYPES.has(e.event_type)) continue;
    const paths = eventPaths(e, root);
    if (!paths.length) continue;
    for (const entry of entries) {
      if (!paths.some((p) => samePath(p, entry.path))) continue;
      const rec = {
        event_type: e.event_type,
        agent: (typeof e.agent === 'string' && e.agent.trim()) || null,
        note: (typeof e.note === 'string' && e.note.trim()) || (typeof e.decision === 'string' && e.decision.trim()) || '',
      };
      if (!map.has(entry.id)) map.set(entry.id, []);
      map.get(entry.id).push(rec);
    }
  }
  return map;
}

/** changedHow(before, after) -> 'same' | 'formatting_only' | 'changed'
 *  `formatting_only` requires BOTH sides to have a semantic hash and those to agree — an unparseable side is
 *  never quietly treated as unchanged. */
function changedHow(before, after) {
  if (before.sha256 === after.sha256) return 'same';
  if (before.semantic_sha256 && after.semantic_sha256 && before.semantic_sha256 === after.semantic_sha256) return 'formatting_only';
  return 'changed';
}

/**
 * checkDrift(root, runId, opts) -> report (see the file header). PURE READ — it never writes and never
 * touches a governance file (a test asserts bytes and mtimes are unchanged afterwards).
 */
function checkDrift(root, runId, opts) {
  opts = opts || {};
  const r = path.resolve(root);
  const runDir = runDirOf(r, runId, opts);
  const now = snapshot(r, opts);
  const baseline = opts.baseline || readBaseline(r, runId, opts);
  const events = readEvents(runDir);
  const announced = announcementsFor(events, now.entries, r);

  if (!baseline) {
    return {
      ok: true, comparable: false, run_id: runId, generated_at: now.generated_at, baseline_at: null,
      findings: [], notes: [], announced_changes: [], unchanged: 0, checked: now.entries.length,
      reason: 'no config baseline recorded for this run (' + path.join(runDir, BASELINE_FILE) + ') — nothing to '
        + 'compare against; run `node .claude/forge-bin/forge-configdrift.cjs snapshot ' + runId + '` at run '
        + 'START so the next run end has a before-picture. Reported as NOT COMPARABLE, never as clean.',
    };
  }

  const beforeById = new Map();
  for (const e of baseline.entries) if (e && e.id) beforeById.set(e.id, e);

  const findings = [];
  const notes = [];
  const announcedChanges = [];
  let unchanged = 0;

  for (const after of now.entries) {
    const before = beforeById.get(after.id);
    const anns = announced.get(after.id) || [];
    const claimedBy = anns.length ? (anns.find((a) => a.agent) || anns[0]).agent : null;

    if (!before) {
      // a source that did not exist at baseline: new skill, new config file
      if (anns.length) { announcedChanges.push({ id: after.id, path: after.path, kind: 'added', announced_by: claimedBy, events: anns }); continue; }
      findings.push({
        kind: 'source_added', id: after.id, path: after.path,
        detail: 'a governance source appeared during this run that the baseline never covered (' + after.path
          + ') and no event announced it — a run that grows its own rule set without saying so is exactly the '
          + 'case this check exists for',
      });
      continue;
    }

    if (before.exists && !after.exists) {
      findings.push({
        kind: 'source_removed', id: after.id, path: after.path,
        detail: 'governance source ' + after.id + ' existed at run start and is gone now (' + after.path
          + ')' + (anns.length ? ' — an event announced a change to it, but a deletion is not a change and is reported either way' : ' and no event announced it'),
        claimed_by: claimedBy,
      });
      continue;
    }
    if (!before.exists && after.exists) {
      if (anns.length) { announcedChanges.push({ id: after.id, path: after.path, kind: 'created', announced_by: claimedBy, events: anns }); continue; }
      findings.push({
        kind: 'source_added', id: after.id, path: after.path,
        detail: 'governance source ' + after.id + ' did not exist at run start and exists now (' + after.path + ') with no event announcing it',
      });
      continue;
    }
    if (!before.exists && !after.exists) { unchanged++; continue; }

    const how = changedHow(before, after);
    if (how === 'same') {
      if (anns.length) {
        // DIRECTION 2 — the claim that changed nothing.
        findings.push({
          kind: 'noop_claim', id: after.id, path: after.path, claimed_by: claimedBy,
          detail: 'a ' + anns[0].event_type + ' event' + (claimedBy ? ' from ' + claimedBy : '') + ' claims '
            + after.id + ' was changed' + (anns[0].note ? ' ("' + anns[0].note + '")' : '') + ', but its hash is '
            + 'byte-identical to the run-start baseline (' + after.sha256.slice(0, 12) + '…) — before == after, so '
            + 'this is a NO-OP and the claim is rejected: the work package it belongs to is not done',
        });
      } else unchanged++;
      continue;
    }
    if (how === 'formatting_only') {
      notes.push({
        kind: 'formatting_only', id: after.id,
        detail: after.id + ' was re-serialised (raw hash moved, key-sorted canonical hash did not) — the file '
          + 'was reformatted and its meaning is unchanged, so this is a note rather than drift',
      });
      unchanged++;
      continue;
    }
    // how === 'changed'
    if (anns.length) {
      announcedChanges.push({ id: after.id, path: after.path, kind: 'changed', announced_by: claimedBy, events: anns });
    } else {
      // DIRECTION 1 — the change nobody announced.
      findings.push({
        kind: 'unannounced_change', id: after.id, path: after.path,
        detail: 'governance source ' + after.id + ' (' + after.path + ') changed during this run — '
          + before.sha256.slice(0, 12) + '… -> ' + after.sha256.slice(0, 12) + '… — and no event in this run\'s '
          + 'events.jsonl announced it. An undeclared edit to the rules a run is judged by is not a small '
          + 'bookkeeping miss: every event logged afterwards was evaluated under different rules than the ones '
          + 'the run started with',
      });
    }
  }

  // a baselined source that produces no entry at all now (e.g. the whole skill directory was removed)
  const liveIds = new Set(now.entries.map((e) => e.id));
  for (const b of baseline.entries) {
    if (!b || !b.id || liveIds.has(b.id)) continue;
    findings.push({
      kind: 'source_removed', id: b.id, path: b.path || null,
      detail: 'governance source ' + b.id + ' was in the run-start baseline and is no longer produced at all '
        + '(the file or its directory is gone) — reported rather than dropped, because a vanished source would '
        + 'otherwise read as "nothing to compare"',
    });
  }

  return {
    ok: findings.length === 0,
    comparable: true,
    run_id: runId,
    generated_at: now.generated_at,
    baseline_at: baseline.generated_at || null,
    findings, notes, announced_changes: announcedChanges,
    unchanged, checked: now.entries.length,
    reason: 'compared ' + now.entries.length + ' governance source(s) against the baseline recorded '
      + (baseline.generated_at || 'at an unrecorded time'),
  };
}

/** summarize(report) -> one human line, the shape forge-verify's "Config Drift:" section reuses. */
function summarize(rep) {
  if (!rep) return 'config drift: unavailable';
  if (!rep.comparable) return 'not comparable — ' + rep.reason;
  const head = rep.checked + ' governance source(s) checked · ' + rep.unchanged + ' unchanged · '
    + rep.announced_changes.length + ' announced change(s)';
  if (rep.ok) return head + ' · no undeclared changes and no no-op claims';
  return head + ' · ' + rep.findings.length + ' finding(s): ' + rep.findings.map((f) => f.kind + ' ' + f.id).join(', ');
}

module.exports = {
  sources, snapshot, writeBaseline, readBaseline, checkDrift, summarize,
  announcementsFor, frontmatterBlock, canonicalJson, changedHow, hashSource, readEvents,
  FIXED_SOURCES, ANNOUNCE_EVENT_TYPES, ANNOUNCE_PATH_FIELDS, BASELINE_FILE,
};

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    let root = path.resolve(__dirname, '..', '..');
    let wantJson = false;
    const pos = [];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--root') root = argv[++i];
      else if (argv[i] === '--json') wantJson = true;
      else pos.push(argv[i]);
    }
    const runId = pos[0];

    if (cmd === 'snapshot') {
      if (!runId) { console.error('Usage: node forge-configdrift.cjs snapshot <run_id> [--root DIR]'); process.exitCode = 1; return; }
      const res = writeBaseline(root, runId);
      console.log('config baseline written: ' + res.path);
      console.log('  ' + res.baseline.entries.length + ' governance source(s) hashed at run start');
      return;
    }

    if (cmd === 'diff') {
      if (!runId) { console.error('Usage: node forge-configdrift.cjs diff <run_id> [--root DIR] [--json]'); process.exitCode = 1; return; }
      const rep = checkDrift(root, runId);
      if (wantJson) { console.log(JSON.stringify(rep, null, 2)); return; }
      console.log('Forge config drift — ' + runId + ' (ADVISORY)');
      console.log('  ' + summarize(rep));
      for (const a of rep.announced_changes) console.log('  ✓ announced ' + a.kind + ': ' + a.id + (a.announced_by ? ' by ' + a.announced_by : ''));
      for (const n of rep.notes) console.log('  note (' + n.kind + '): ' + n.detail);
      for (const f of rep.findings) console.log('  ⚠ ' + f.kind.toUpperCase() + ' ' + f.id + ' — ' + f.detail);
      return;
    }

    console.error('Usage: node forge-configdrift.cjs <snapshot|diff> <run_id> [--root DIR] [--json]');
    process.exitCode = 1;
  };
  // ADVISORY: the exit code is 0 even with findings — see the file header. Only a usage error sets it above.
  try { main(); } catch (e) { console.error('forge-configdrift: ' + e.message); process.exitCode = 1; }
}
