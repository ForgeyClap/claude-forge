#!/usr/bin/env node
'use strict';
/**
 * forge-memory.cjs — upgraded per-Boss memory (2026-07-11, NEXT tier): TYPED lessons (episodic/semantic/
 * procedural), tag+keyword+recency top-K RECALL (so a run injects the few relevant lessons instead of a
 * whole-file read), and MECHANICALLY-ENFORCED secret redaction on every write (memory must never hold a
 * secret). Stored as one-JSON-per-line under .claude/agent-memory/<boss-slug>/lessons.jsonl.
 *
 * This is the NATIVE-memory companion, not a replacement: Bosses with `memory: project` still get their
 * harness MEMORY.md; this adds a queryable, redaction-guaranteed lesson store the Lead can recall from.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const TYPES = new Set(['episodic', 'semantic', 'procedural']);

// belt-and-suspenders redaction: Forge's store redactor (if present) + a local secret scrub, so a lesson
// can NEVER persist a key/token regardless of which redactor is available.
let baseRedact = (s) => String(s == null ? '' : s);
try { const store = require('./forge-store.cjs'); if (typeof store.redactValue === 'function') baseRedact = (s) => { try { return store.redactValue(String(s == null ? '' : s)); } catch { return String(s == null ? '' : s); } }; } catch {}
const SECRET_RE = [/nvapi-[A-Za-z0-9_-]{8,}/g, /sk-[A-Za-z0-9]{16,}/g, /sk_(live|test)_[A-Za-z0-9]{16,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g, /AKIA[0-9A-Z]{16}/g, /xox[baprs]-[A-Za-z0-9-]{10,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g];
function scrub(s) { s = baseRedact(String(s == null ? '' : s)); for (const re of SECRET_RE) s = s.replace(re, '[REDACTED]'); return s; }

function memDir(boss, root) { const slug = String(boss).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'; return path.join(root || PROJECT_ROOT, '.claude', 'agent-memory', slug); }
function lessonsFile(boss, root) { return path.join(memDir(boss, root), 'lessons.jsonl'); }

function addLesson(boss, lesson, root) {
  lesson = lesson || {};
  const type = TYPES.has(lesson.type) ? lesson.type : 'semantic';
  const rec = {
    id: '', type,
    tags: (Array.isArray(lesson.tags) ? lesson.tags : []).map((t) => String(t).toLowerCase().slice(0, 40)).slice(0, 12),
    text: scrub(lesson.text).slice(0, 2000),
    evidence: scrub(lesson.evidence).slice(0, 500),
    ts: lesson.ts || new Date().toISOString(),
  };
  rec.id = crypto.createHash('sha1').update(rec.type + rec.text + rec.ts + Math.random()).digest('hex').slice(0, 12);
  const dir = memDir(boss, root); fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(lessonsFile(boss, root), JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}
function listLessons(boss, root) { let raw; try { raw = fs.readFileSync(lessonsFile(boss, root), 'utf8'); } catch { return []; } return raw.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
function recall(boss, query, k, root) {
  const all = listLessons(boss, root); if (!all.length) return [];
  const terms = String(query == null ? '' : query).toLowerCase().split(/\W+/).filter(Boolean);
  const now = Date.parse(new Date().toISOString());
  const scored = all.map((l) => {
    const hay = (l.text + ' ' + (l.tags || []).join(' ')).toLowerCase();
    let s = 0; for (const t of terms) { if ((l.tags || []).includes(t)) s += 2; else if (hay.includes(t)) s += 1; }
    const ageDays = (now - Date.parse(l.ts)) / 86400000; const recency = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / 60) : 0;
    return { l, score: s + recency * 0.5 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k || 5).filter((x) => x.score > 0).map((x) => x.l);
}
// Safety-net scan: walk agent-memory for any secret that slipped past write-time redaction.
function scanMemory(root) {
  const base = path.join(root || PROJECT_ROOT, '.claude', 'agent-memory');
  const hits = []; const walk = (d) => { let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; } for (const re of SECRET_RE) { re.lastIndex = 0; if (re.test(txt)) { hits.push({ file: path.relative(root || PROJECT_ROOT, p) }); break; } } } } };
  walk(base);
  return { ok: hits.length === 0, hits };
}

module.exports = { addLesson, listLessons, recall, scanMemory, memDir, scrub, TYPES };

if (require.main === module) {
  const [boss, cmd, ...rest] = process.argv.slice(2);
  if (!boss || !cmd) { console.log('usage: forge-memory.cjs <boss> add "<text>" [tag,tag] [type] | recall "<query>" | list | scan'); process.exit(1); }
  if (cmd === 'add') { const rec = addLesson(boss, { text: rest[0], tags: (rest[1] || '').split(',').filter(Boolean), type: rest[2] }); console.log('lesson ' + rec.id + ' (' + rec.type + ') stored for ' + boss); }
  else if (cmd === 'recall') { console.log(JSON.stringify(recall(boss, rest[0], 5), null, 2)); }
  else if (cmd === 'list') { console.log(JSON.stringify(listLessons(boss), null, 2)); }
  else if (cmd === 'scan') { const r = scanMemory(); console.log(r.ok ? 'agent-memory clean' : 'SECRETS FOUND: ' + JSON.stringify(r.hits)); process.exit(r.ok ? 0 : 1); }
}
