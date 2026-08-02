#!/usr/bin/env node
'use strict';
/**
 * forge-beads.cjs — lightweight graph backlog / memory (WAVE H / PIECE H4, 2026-07-19). Zero-dependency
 * (fs/path/crypto only). A "bead" is one work item: { id, title, status, deps:[ids], created_run, notes,
 * created_ts, updated_ts }. Beads and their `deps` edges together form a dependency GRAPH, not a flat
 * todo list — this is what lets `ready()` answer "what can I actually start right now" honestly instead
 * of a human re-scanning a list by eye, and what lets a cycle (A depends on B depends on A — an
 * unresolvable deadlock) be DETECTED and REPORTED instead of silently hanging or being missed.
 *
 * STORE SHAPE: one JSON object per line (a "beads.jsonl" snapshot store — the same one-record-per-line
 * convention forge-memory.cjs's lessons.jsonl and forge-consolidate.cjs already use), read-modify-write in
 * full on every mutation (readStore -> mutate the in-memory array -> writeStore). Unlike forge-trace.cjs's
 * events.jsonl (an append-only LOG that tolerates and skips a malformed line, because it is a history of
 * what already happened), beads.jsonl is a live SNAPSHOT of current state — a malformed line there means
 * the store itself is corrupt, not just one stale historical entry, so readStore() FAILS CLOSED and throws
 * rather than silently dropping a bead a caller thinks still exists.
 *
 * STATUSES: open | doing | blocked | done (BEAD_STATUSES). `blocked` is a manual/advisory status a caller
 * may set; it is never inferred from unmet deps — an `open` bead with unmet deps is simply excluded from
 * ready() (see below), which is the honest computed signal. Only `done` beads count as satisfying another
 * bead's dependency.
 *
 * CYCLE DETECTION (never infinite-loops): computeCycles() runs a standard 3-color (white/gray/black) DFS
 * over the deps graph. Because a node is only ever entered once (marked black after full processing) and a
 * cycle is detected the moment a GRAY (currently-on-the-DFS-stack) node is revisited, termination is
 * guaranteed for any finite bead set regardless of how many cycles exist — this is a structural guarantee,
 * not a best-effort timeout. A dangling dep (an id that doesn't resolve to any bead in the store) can never
 * itself form part of a cycle and is skipped, never crashes the walk.
 *
 * MODULE API:
 *   add(bead, opts) -> the stored bead record (id auto-generated with a `bd-` prefix if not given; throws
 *     on a missing/empty title, a duplicate id, an invalid status, a self-referential dep, or a dep id that
 *     does not resolve to an EXISTING bead in the store — deps must reference beads created earlier; link()
 *     is the mechanism for wiring up beads created in either order).
 *   link(from, to, opts) -> the updated `from` bead (adds `to` to `from`.deps; idempotent — linking an
 *     already-linked pair is a no-op, not an error). Throws on an invalid/self id or an id that does not
 *     resolve to an existing bead. Does NOT block a link that would create a cycle — see file header on
 *     "detected + reported", not "prevented": ready()/graph() are where a cycle becomes visible.
 *   close(id, opts) -> the updated bead (status set to 'done'; idempotent on an already-done bead). Throws
 *     if `id` does not resolve to an existing bead.
 *   blockedBy(id, opts) -> [{id, status}, ...] — this bead's OWN deps that are not yet 'done' (status is
 *     'missing' for a dangling dep id). Empty array means nothing is blocking it. Throws if `id` unknown.
 *   ready(opts) -> { ready:[bead,...], cycles:[[id,...],...], total, notes } — the actionable frontier: every
 *     `open` bead whose deps are ALL 'done', excluding any bead that participates in a dependency cycle
 *     (a bead stuck in a cycle can never be honestly "ready" — its deps can never all resolve).
 *   graph(opts) -> { nodes:[{id,title,status},...], edges:[{from,to},...], cycles:[[id,...],...] } — a full
 *     projection of the current store, `edges` reading "from depends on to".
 *   opts.storePath (absolute file path) overrides the whole store location outright — the hermetic-test
 *   seam (mirrors forge-consolidate.cjs's opts.store / forge-harvest.cjs's opts.globalStore: an explicit
 *   override is trusted as-is, no containment check, because the caller supplied the whole path). opts.root
 *   overrides the PROJECT root used to derive the default path (mirrors forge-trace.cjs's opts.root),
 *   default `<root>/.claude/forge-beads/beads.jsonl`.
 *
 * CLI:
 *   node forge-beads.cjs add --title <t> [--id <id>] [--status open|doing|blocked|done] [--deps a,b,c]
 *     [--created-run <runId>] [--notes <text>] [--json]
 *   node forge-beads.cjs link --from <id> --to <id> [--json]
 *   node forge-beads.cjs close --id <id> [--json]
 *   node forge-beads.cjs blocked-by --id <id> [--json]
 *   node forge-beads.cjs ready [--json]
 *   node forge-beads.cjs graph [--json]
 * Exit codes: 0 = ran clean (including an honestly-empty ready/graph result) · 3 = `ready`/`graph` ran but
 * found at least one dependency cycle in the store (advisory "needs attention", mirrors forge-trace's
 * gaps>0 / forge-actiongate's gate-triggered convention — never thrown, always reported) · 2 = usage error
 * or a thrown error (bad id, unknown bead, invalid status, malformed store).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BEAD_STATUSES = ['open', 'doing', 'blocked', 'done'];
const ID_RE = /^[A-Za-z0-9_-]+$/; // same shape as forge-store.cjs::isValidId — no room for "/", "\", or ".."

function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }
function nowIso() { return new Date().toISOString(); }

function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  return path.resolve(__dirname, '..', '..');
}
function defaultStorePath(root) { return path.join(root, '.claude', 'forge-beads', 'beads.jsonl'); }
function resolveStorePath(opts) {
  opts = opts || {};
  if (opts.storePath) return path.resolve(opts.storePath);
  return defaultStorePath(resolveRoot(opts.root));
}

// ---- store IO: snapshot semantics — a malformed line means the STORE is corrupt, so this fails closed
// (throws) rather than silently dropping a bead, unlike the append-only-log readers elsewhere in Forge. ----
function readStore(storePath) {
  let raw;
  try { raw = fs.readFileSync(storePath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return []; // no store written yet — a valid, ordinary empty state
    throw new Error('forge-beads: could not read store ' + storePath + ': ' + e.message);
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/);
  const beads = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); }
    catch (e) { throw new Error('forge-beads: malformed store ' + storePath + ' at line ' + (i + 1) + ': ' + e.message); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.id !== 'string' || !obj.id) {
      throw new Error('forge-beads: malformed store ' + storePath + ' at line ' + (i + 1) + ': entry is not a valid bead record (missing/invalid id)');
    }
    beads.push(obj);
  }
  return beads;
}
function writeStore(storePath, beads) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const body = beads.map((b) => JSON.stringify(b)).join('\n');
  fs.writeFileSync(storePath, body.length ? body + '\n' : '', 'utf8');
}

function genId(title) {
  const h = crypto.createHash('sha1').update('bead:' + String(title) + ':' + Date.now() + ':' + Math.random()).digest('hex').slice(0, 10);
  return 'bd-' + h;
}
function normalizeDeps(deps) {
  if (deps == null) return [];
  if (!Array.isArray(deps)) throw new Error('forge-beads: deps must be an array of bead ids');
  const out = [];
  const seen = new Set();
  for (const d of deps) {
    if (!isValidId(d)) throw new Error('forge-beads: invalid dependency id: ' + JSON.stringify(d));
    if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

// ═══════════════════════════ PURE CORE (no I/O) — mutation-verified directly ═══════════════════════════
/** computeCycles(beads) -> [[id, id, ...], ...] — one array per detected cycle, each listing the cycle's
 *  bead ids in walk order (first id repeated at the end so the loop is visually explicit). 3-color DFS;
 *  see file header for the termination guarantee. Pure function of `beads`; never mutates its input. */
function computeCycles(beads) {
  const byId = new Map(beads.map((b) => [b.id, b]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(beads.map((b) => [b.id, WHITE]));
  const cycles = [];
  const stack = [];
  function visit(id) {
    color.set(id, GRAY);
    stack.push(id);
    const bead = byId.get(id);
    const deps = (bead && Array.isArray(bead.deps)) ? bead.deps : [];
    for (const dep of deps) {
      if (!byId.has(dep)) continue; // dangling dep — can never itself be part of a cycle
      const c = color.get(dep);
      if (c === WHITE) visit(dep);
      else if (c === GRAY) {
        const idx = stack.indexOf(dep);
        cycles.push(stack.slice(idx).concat(dep));
      }
      // BLACK: already fully explored elsewhere — no cycle reachable through here
    }
    stack.pop();
    color.set(id, BLACK);
  }
  for (const b of beads) if (color.get(b.id) === WHITE) visit(b.id);
  return cycles;
}

/** computeReady(beads) -> {ready:[bead,...], cycles:[[id,...],...]} — pure function of `beads`. A bead is
 *  in the actionable frontier only when status === 'open', it is NOT part of any detected cycle, and every
 *  one of its deps resolves to an EXISTING bead whose status is exactly 'done' (a dangling/missing dep, or
 *  any non-'done' dep, blocks it — fails closed, never assumes a dep is satisfied). */
function computeReady(beads) {
  const byId = new Map(beads.map((b) => [b.id, b]));
  const cycles = computeCycles(beads);
  const inCycle = new Set();
  for (const cyc of cycles) for (const id of cyc) inCycle.add(id);
  const ready = [];
  for (const b of beads) {
    if (b.status !== 'open') continue;
    if (inCycle.has(b.id)) continue;
    const deps = Array.isArray(b.deps) ? b.deps : [];
    const allDone = deps.every((d) => { const db = byId.get(d); return !!db && db.status === 'done'; });
    if (allDone) ready.push(b);
  }
  return { ready, cycles };
}
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/** add(bead, opts) -> the stored bead record. See MODULE API in the file header. */
function add(bead, opts) {
  bead = bead || {};
  if (typeof bead.title !== 'string' || !bead.title.trim()) throw new Error('forge-beads: add() requires a non-empty title');
  const storePath = resolveStorePath(opts);
  const beads = readStore(storePath);
  const byId = new Map(beads.map((b) => [b.id, b]));

  let id = bead.id;
  if (id != null) {
    if (!isValidId(id)) throw new Error('forge-beads: invalid bead id: ' + JSON.stringify(id));
    if (byId.has(id)) throw new Error('forge-beads: bead already exists: ' + id);
  } else {
    do { id = genId(bead.title); } while (byId.has(id));
  }

  const status = bead.status == null ? 'open' : bead.status;
  if (!BEAD_STATUSES.includes(status)) throw new Error('forge-beads: invalid status "' + status + '" — allowed: ' + BEAD_STATUSES.join(', '));

  const deps = normalizeDeps(bead.deps);
  for (const d of deps) {
    if (d === id) throw new Error('forge-beads: a bead cannot depend on itself');
    if (!byId.has(d)) throw new Error('forge-beads: unknown dependency id: ' + d + ' (create the dependency bead first, or use link() once both exist)');
  }

  const ts = nowIso();
  const record = {
    id, title: bead.title.trim(), status, deps,
    created_run: (typeof bead.created_run === 'string' && bead.created_run) ? bead.created_run : null,
    notes: (typeof bead.notes === 'string' && bead.notes) ? bead.notes : null,
    created_ts: ts, updated_ts: ts,
  };
  beads.push(record);
  writeStore(storePath, beads);
  return record;
}

/** link(from, to, opts) -> the updated `from` bead. See MODULE API in the file header. */
function link(from, to, opts) {
  if (!isValidId(from) || !isValidId(to)) throw new Error('forge-beads: link() requires valid bead ids');
  if (from === to) throw new Error('forge-beads: a bead cannot depend on itself');
  const storePath = resolveStorePath(opts);
  const beads = readStore(storePath);
  const fromBead = beads.find((b) => b.id === from);
  const toBead = beads.find((b) => b.id === to);
  if (!fromBead) throw new Error('forge-beads: unknown bead id: ' + from);
  if (!toBead) throw new Error('forge-beads: unknown bead id: ' + to);
  if (!Array.isArray(fromBead.deps)) fromBead.deps = [];
  if (!fromBead.deps.includes(to)) {
    fromBead.deps.push(to);
    fromBead.updated_ts = nowIso();
    writeStore(storePath, beads);
  }
  return fromBead;
}

/** close(id, opts) -> the updated bead (status -> 'done'). See MODULE API in the file header. */
function close(id, opts) {
  if (!isValidId(id)) throw new Error('forge-beads: close() requires a valid bead id');
  const storePath = resolveStorePath(opts);
  const beads = readStore(storePath);
  const bead = beads.find((b) => b.id === id);
  if (!bead) throw new Error('forge-beads: unknown bead id: ' + id);
  bead.status = 'done';
  bead.updated_ts = nowIso();
  writeStore(storePath, beads);
  return bead;
}

/** blockedBy(id, opts) -> [{id, status}, ...] — this bead's own deps that are not (yet) 'done'. See MODULE
 *  API in the file header. */
function blockedBy(id, opts) {
  if (!isValidId(id)) throw new Error('forge-beads: blockedBy() requires a valid bead id');
  const storePath = resolveStorePath(opts);
  const beads = readStore(storePath);
  const byId = new Map(beads.map((b) => [b.id, b]));
  const bead = byId.get(id);
  if (!bead) throw new Error('forge-beads: unknown bead id: ' + id);
  const deps = Array.isArray(bead.deps) ? bead.deps : [];
  return deps
    .map((d) => { const db = byId.get(d); return { id: d, status: db ? db.status : 'missing' }; })
    .filter((entry) => entry.status !== 'done');
}

/** ready(opts) -> {ready, cycles, total, notes}. Thin I/O wrapper around computeReady() — see MODULE API. */
function ready(opts) {
  const storePath = resolveStorePath(opts);
  const beads = readStore(storePath);
  const { ready: readyBeads, cycles } = computeReady(beads);
  const notes = [];
  if (cycles.length) notes.push(cycles.length + ' dependency cycle(s) detected — every bead inside a cycle is excluded from the ready frontier until the cycle is broken');
  return { ready: readyBeads, cycles, total: beads.length, notes };
}

/** graph(opts) -> {nodes, edges, cycles}. Thin I/O wrapper around computeCycles() — see MODULE API. */
function graph(opts) {
  const storePath = resolveStorePath(opts);
  const beads = readStore(storePath);
  const nodes = beads.map((b) => ({ id: b.id, title: b.title, status: b.status }));
  const edges = [];
  for (const b of beads) for (const d of (Array.isArray(b.deps) ? b.deps : [])) edges.push({ from: b.id, to: d });
  return { nodes, edges, cycles: computeCycles(beads) };
}

module.exports = {
  add, link, close, blockedBy, ready, graph,
  computeCycles, computeReady, readStore, writeStore,
  isValidId, resolveRoot, defaultStorePath, resolveStorePath, genId, normalizeDeps,
  BEAD_STATUSES,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = {
    cmd, title: null, id: null, status: null, deps: null, createdRun: null, notes: null,
    from: null, to: null, json: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--title') opts.title = rest[++i];
    else if (a === '--id') opts.id = rest[++i];
    else if (a === '--status') opts.status = rest[++i];
    else if (a === '--deps') opts.deps = rest[++i];
    else if (a === '--created-run') opts.createdRun = rest[++i];
    else if (a === '--notes') opts.notes = rest[++i];
    else if (a === '--from') opts.from = rest[++i];
    else if (a === '--to') opts.to = rest[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-beads.cjs add --title <t> [--id <id>] [--status open|doing|blocked|done]');
  console.error('         [--deps a,b,c] [--created-run <runId>] [--notes <text>] [--json]');
  console.error('       node forge-beads.cjs link --from <id> --to <id> [--json]');
  console.error('       node forge-beads.cjs close --id <id> [--json]');
  console.error('       node forge-beads.cjs blocked-by --id <id> [--json]');
  console.error('       node forge-beads.cjs ready [--json]');
  console.error('       node forge-beads.cjs graph [--json]');
}
function printBead(b) {
  console.log('[' + b.status + '] ' + b.id + ' — ' + b.title + (b.deps.length ? ' (deps: ' + b.deps.join(', ') + ')' : ''));
}
function printReady(r) {
  console.log('forge-beads ready · ' + r.ready.length + '/' + r.total + ' actionable' + (r.cycles.length ? ', ' + r.cycles.length + ' cycle(s) detected' : ''));
  for (const b of r.ready) printBead(b);
  for (const n of r.notes) console.log('  note: ' + n);
}
function printGraph(g) {
  console.log('forge-beads graph · ' + g.nodes.length + ' node(s), ' + g.edges.length + ' edge(s)' + (g.cycles.length ? ', ' + g.cycles.length + ' cycle(s) detected' : ''));
  for (const n of g.nodes) console.log('  [' + n.status + '] ' + n.id + ' — ' + n.title);
  for (const e of g.edges) console.log('  ' + e.from + ' -> ' + e.to);
  for (const c of g.cycles) console.log('  CYCLE: ' + c.join(' -> '));
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'add') {
      if (!opts.title) { printUsage(); process.exitCode = 2; }
      else {
        const deps = opts.deps ? opts.deps.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const record = add({ title: opts.title, id: opts.id || undefined, status: opts.status || undefined, deps, created_run: opts.createdRun || undefined, notes: opts.notes || undefined }, {});
        if (opts.json) console.log(JSON.stringify(record));
        else printBead(record);
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'link') {
      if (!opts.from || !opts.to) { printUsage(); process.exitCode = 2; }
      else {
        const record = link(opts.from, opts.to, {});
        if (opts.json) console.log(JSON.stringify(record));
        else printBead(record);
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'close') {
      if (!opts.id) { printUsage(); process.exitCode = 2; }
      else {
        const record = close(opts.id, {});
        if (opts.json) console.log(JSON.stringify(record));
        else printBead(record);
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'blocked-by') {
      if (!opts.id) { printUsage(); process.exitCode = 2; }
      else {
        const result = blockedBy(opts.id, {});
        if (opts.json) console.log(JSON.stringify(result));
        else if (!result.length) console.log('forge-beads: ' + opts.id + ' is not blocked');
        else for (const r of result) console.log('  blocked by ' + r.id + ' (' + r.status + ')');
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'ready') {
      const result = ready({});
      if (opts.json) console.log(JSON.stringify(result));
      else printReady(result);
      process.exitCode = result.cycles.length ? 3 : 0;
    } else if (opts.cmd === 'graph') {
      const result = graph({});
      if (opts.json) console.log(JSON.stringify(result));
      else printGraph(result);
      process.exitCode = result.cycles.length ? 3 : 0;
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-beads: ' + e.message);
    process.exitCode = 2;
  }
}
