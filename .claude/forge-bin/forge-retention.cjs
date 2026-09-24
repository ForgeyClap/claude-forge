#!/usr/bin/env node
'use strict';
/**
 * forge-retention.cjs — begrensde retentie voor logs, toollogs en backups (audit G9, 2026-08-06).
 *
 * PROBLEEM: forge-usage-guard.log groeide onbegrensd (nu geroteerd door usage-guard zelf, G9a), de
 * per-project _toollog en forge-backups en de centrale .forge-backup-hub en de globale
 * template-backup-* mappen kenden GEEN enkele prune. Dit tool maakt retentie expliciet, begrensd en
 * testbaar — en verliest nooit rollbackvermogen zonder dat dat zichtbaar is.
 *
 * VEILIGHEID:
 *   - DRY-RUN IS DE DEFAULT. Er wordt pas echt verwijderd met --apply.
 *   - Backup-prune bewaart ALTIJD de laatste --keep batches (default 5) EN alles jonger dan --days
 *     (default 14) — beide grenzen moeten overschreden zijn voor verwijdering.
 *   - Alleen paden BINNEN de opgegeven root (containment-check per kandidaat).
 *   - Rapporteert per kandidaat wat en waarom; een apply zonder voorafgaande dry-run-uitvoer bestaat
 *     niet (de apply print dezelfde lijst).
 *
 * EIGENAARSINSTELLING `cleanup` (v2.7.0, forge-config.cjs; standaard `report`): zolang die op `report`
 * staat WEIGERT de CLI `apply` met een gewone zin + exit 3 (er wordt niets verwijderd); `apply --force`
 * (een expliciete vraag nu) of `/forge config set cleanup auto` laat hem door. `scan` mag altijd. Gelezen
 * voor de --root die opgeruimd zou worden (FORGE_PROJECT_ROOT, de eigen seam van de resolver, wint als die
 * gezet is). forge-config.cjs is soft-required: afwezig of een throw -> de schema-default (`report`), dus
 * een kapot instellingenbestand verwijdert nooit iets. cleanupGate(command, opts) is de pure beslissing;
 * de module-functie apply() zelf is ongewijzigd (de CLI is het enige ingangspunt).
 *
 * CLI:
 *   node forge-retention.cjs scan  [--root <projectRoot>] [--keep N] [--days D] [--json]
 *   node forge-retention.cjs apply [--root <projectRoot>] [--keep N] [--days D] [--json] [--force]
 * Exit: 0 = ok (ook: niets te doen) · 1 = apply met gefaalde verwijderingen · 2 = usage/fout ·
 *       3 = apply geweigerd door de eigenaarsinstelling cleanup=report (niets verwijderd).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_KEEP = 5;
const DEFAULT_DAYS = 14;

// ---- eigenaarsinstelling `cleanup` (forge-config.cjs, v2.7.0) — soft-required, zie de header ----
const CLEANUP_REFUSAL = 'opruimen staat op "report" (alleen rapporteren), dus er is niets verwijderd. Automatisch opruimen aanzetten: /forge config set cleanup auto (of eenmalig: apply --force). Eerst zien wat er weg zou gaan: scan';
let cfg = null;
try { cfg = require('./forge-config.cjs'); } catch { cfg = null; }
/** configRead(key, fallback, opts) -> { value, source, degraded, reason } via forge-config.safeGet (FAIL-SAFE,
 *  review-boss M3: a damaged settings file never switches a flagged feature on). `fallback` is this file's copy of
 *  the schema default — for a flagged key like cleanup (D) the SAFE value, report — used only when
 *  forge-config.cjs is absent or broken; an older copy without safeGet is read through get(). Never throws.
 *  opts.projectRoot = the root this tool acts on (ignored when FORGE_PROJECT_ROOT is set); opts.configModule
 *  injects a module (tests; null = "absent"). */
function configRead(key, fallback, opts) {
  opts = opts || {};
  const mod = opts.configModule !== undefined ? opts.configModule : cfg;
  const o = opts.projectRoot && !process.env.FORGE_PROJECT_ROOT ? { projectRoot: opts.projectRoot } : {};
  let why = 'forge-config.cjs not found';
  try {
    if (mod && typeof mod.safeGet === 'function') {
      const r = mod.safeGet(key, Object.assign({ fallback }, o));
      if (r && typeof r.value === typeof fallback) return r;
      why = 'forge-config gave no usable value';
    } else if (mod && typeof mod.get === 'function') {
      const e = mod.get(key, o);
      if (e && typeof e.value === typeof fallback) return { value: e.value, source: e.source || 'unknown', degraded: false, reason: null };
      why = 'forge-config gave a value of the wrong type';
    }
  } catch (e) { why = 'settings unreadable: ' + ((e && e.message) || e); }
  return { value: fallback, source: 'built-in', degraded: true, reason: why + ' — ' + key + ' uses the built-in ' + JSON.stringify(fallback) };
}
/** configOn(key, def, opts) -> just the value of configRead(). */
function configOn(key, def, opts) { return configRead(key, def, opts).value; }
/** cleanupGate(command, opts) -> { allowed, reason, message, config_note? }. `scan` is never gated; `apply` only
 *  with cleanup=auto or opts.force. opts: { force, projectRoot, configModule }. */
function cleanupGate(command, opts) {
  const o = opts || {};
  if (command !== 'apply') return { allowed: true, reason: 'not-gated', message: null };
  if (o.force === true) return { allowed: true, reason: 'force', message: null };
  const sc = configRead('cleanup', 'report', { projectRoot: o.projectRoot, configModule: o.configModule });
  const note = sc.degraded ? { config_note: sc.reason } : {};
  if (sc.value === 'auto') {
    return Object.assign({ allowed: true, reason: 'owner config cleanup=auto', message: null }, note);
  }
  return Object.assign({ allowed: false, reason: 'owner config cleanup=report', message: CLEANUP_REFUSAL }, note);
}

function dirSize(p) {
  let total = 0;
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else { try { total += fs.statSync(fp).size; } catch { } }
    }
  };
  walk(p);
  return total;
}

function within(root, p) {
  const rp = path.resolve(p), rr = path.resolve(root);
  return rp === rr || rp.startsWith(rr + path.sep);
}

/** backupCandidates — batch-mappen in <root>/.claude/forge-backups, gesorteerd nieuw→oud op mtime.
 *  Kandidaat voor prune = voorbij keep-N EN ouder dan days-D. */
function backupCandidates(root, keep, days) {
  const bdir = path.join(root, '.claude', 'forge-backups');
  let entries = [];
  try { entries = fs.readdirSync(bdir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return { dir: bdir, batches: [], candidates: [] }; }
  const batches = entries.map((e) => {
    const p = path.join(bdir, e.name);
    let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch { }
    return { name: e.name, path: p, mtimeMs: mtime, bytes: dirSize(p) };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = Date.now() - days * 86400000;
  const candidates = batches.filter((b, i) => i >= keep && b.mtimeMs < cutoff && within(root, b.path));
  return { dir: bdir, batches, candidates };
}

/** toollogCandidates — jsonl-bestanden in <root>/.claude/forge-runs/_toollog ouder dan days. */
function toollogCandidates(root, days) {
  const tdir = path.join(root, '.claude', 'forge-runs', '_toollog');
  let files = [];
  try { files = fs.readdirSync(tdir).filter((f) => f.endsWith('.jsonl')); } catch { return { dir: tdir, candidates: [] }; }
  const cutoff = Date.now() - days * 86400000;
  const candidates = [];
  for (const f of files) {
    const p = path.join(tdir, f);
    try { const st = fs.statSync(p); if (st.mtimeMs < cutoff && within(root, p)) candidates.push({ name: f, path: p, bytes: st.size, mtimeMs: st.mtimeMs }); } catch { }
  }
  return { dir: tdir, candidates };
}

function scan(root, keep, days) {
  const backups = backupCandidates(root, keep, days);
  const toollog = toollogCandidates(root, days);
  const totalBytes = backups.candidates.reduce((s, c) => s + c.bytes, 0) + toollog.candidates.reduce((s, c) => s + c.bytes, 0);
  return {
    root, keep, days,
    backups: {
      dir: backups.dir, total_batches: backups.batches.length,
      kept: backups.batches.length - backups.candidates.length,
      prune_candidates: backups.candidates.map((c) => ({ name: c.name, mb: +(c.bytes / 1048576).toFixed(1), age_days: +((Date.now() - c.mtimeMs) / 86400000).toFixed(1) })),
    },
    toollog: {
      dir: toollog.dir,
      prune_candidates: toollog.candidates.map((c) => ({ name: c.name, mb: +(c.bytes / 1048576).toFixed(1), age_days: +((Date.now() - c.mtimeMs) / 86400000).toFixed(1) })),
    },
    reclaim_mb: +(totalBytes / 1048576).toFixed(1),
  };
}

/** safeDelete — Codex ronde-4 #19 (2026-08-06): lexicale containment alleen was niet genoeg voor een
 *  DESTRUCTIEVE operatie. Vlak voor elke delete: (a) lstat — een reparse-punt/symlink wordt GEWEIGERD
 *  (nooit een junction recursief volgen); (b) realpath van de parent moet onder de echte root blijven.
 *  En apply verwijdert het BEVROREN plan (exact wat gerapporteerd is), niet een verse herberekening. */
function safeDelete(root, p, recursive, failed) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { failed.push({ path: p, error: 'reparse-punt/symlink — geweigerd (nooit door een junction heen verwijderen)' }); return false; }
    const realParent = fs.realpathSync.native(path.dirname(p));
    const realRoot = fs.realpathSync.native(root);
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
      failed.push({ path: p, error: 'parent resolvet buiten de root — geweigerd' }); return false;
    }
    fs.rmSync(p, { recursive, force: true });
    return true;
  } catch (e) { failed.push({ path: p, error: e.message }); return false; }
}
function apply(root, keep, days) {
  const plan = scan(root, keep, days); // BEVROREN plan: dit is exact wat verwijderd wordt
  const removed = [], failed = [];
  const bdir = path.join(root, '.claude', 'forge-backups');
  const tdir = path.join(root, '.claude', 'forge-runs', '_toollog');
  for (const c of plan.backups.prune_candidates) {
    if (safeDelete(root, path.join(bdir, c.name), true, failed)) removed.push(c.name);
  }
  for (const c of plan.toollog.prune_candidates) {
    if (safeDelete(root, path.join(tdir, c.name), false, failed)) removed.push(c.name);
  }
  return { ...plan, applied: true, removed_count: removed.length, failed };
}

module.exports = { scan, apply, backupCandidates, toollogCandidates, cleanupGate, configOn, configRead, CLEANUP_REFUSAL, DEFAULT_KEEP, DEFAULT_DAYS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const get = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
  const root = get('root') ? path.resolve(get('root')) : path.resolve(__dirname, '..', '..');
  const keep = Number(get('keep')) > 0 ? Number(get('keep')) : DEFAULT_KEEP;
  const days = get('days') !== null && Number(get('days')) >= 0 ? Number(get('days')) : DEFAULT_DAYS; // Number(null)===0 zou de default stil overrulen
  const asJson = args.includes('--json');
  if (cmd !== 'scan' && cmd !== 'apply') {
    console.error('usage: node forge-retention.cjs scan|apply [--root <dir>] [--keep N] [--days D] [--json] [--force]  (scan = dry-run, DE default-houding; apply alleen met cleanup=auto of --force)');
    process.exit(2);
  }
  const gate = cleanupGate(cmd, { force: args.includes('--force'), projectRoot: root });
  if (gate.config_note) console.error('NOTE (settings): ' + gate.config_note);
  if (!gate.allowed) { console.error(gate.message); process.exit(3); }
  const r = cmd === 'apply' ? apply(root, keep, days) : scan(root, keep, days);
  if (r.applied && r.failed && r.failed.length) process.exitCode = 1; // Codex ronde-4 #19: falen is nooit exit 0
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    console.log((cmd === 'apply' ? 'RETENTIE TOEGEPAST' : 'DRY-RUN (niets verwijderd)') + ' — root ' + r.root + ' · keep ' + r.keep + ' · days ' + r.days);
    console.log('backups: ' + r.backups.total_batches + ' batches, ' + r.backups.kept + ' bewaard, ' + r.backups.prune_candidates.length + ' kandidaat(en)');
    for (const c of r.backups.prune_candidates) console.log('  - ' + c.name + ' (' + c.mb + ' MB, ' + c.age_days + 'd oud)');
    console.log('toollog: ' + r.toollog.prune_candidates.length + ' kandidaat(en)');
    console.log('terug te winnen: ' + r.reclaim_mb + ' MB' + (r.applied ? ' · verwijderd: ' + r.removed_count + (r.failed.length ? ' · GEFAALD: ' + r.failed.length : '') : ''));
  }
  if (process.exitCode !== 1) process.exit(0);
}
