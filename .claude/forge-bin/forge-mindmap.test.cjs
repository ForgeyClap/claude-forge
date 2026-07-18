#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-mindmap.cjs — writes ONLY to an os.mkdtemp temp dir via the
 *  FORGE_STORE_ROOT override (shared with forge-store.cjs); never touches the real project's .claude/.
 *  Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');

// hermetic: point the shared store at a throwaway temp dir BEFORE requiring forge-mindmap.cjs (it
// requires forge-store.cjs internally, which resolves CLAUDE_DIR once at load time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mindmap-test-'));
process.env.FORGE_STORE_ROOT = TMP;
const { buildFromOutline, toMermaid, writeMindmap } = require('./forge-mindmap.cjs');
const { isValidId } = require('./forge-store.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-mindmap offline tests (hermetic root=' + TMP + ')');

// 1) buildFromOutline on a 3-level outline -> correct node count + parent/child edges + root kind
const OUTLINE = [
  'Mission Control Phase 2',
  '  WP4 Mind Map',
  '    Writer (forge-mindmap.cjs)',
  '    Radial lens (dashboard)',
  '  WP5 Next Work Package',
].join('\n');
const built = buildFromOutline(OUTLINE);
t('buildFromOutline returns 5 nodes for a 5-line outline', built.nodes.length === 5);
t('buildFromOutline returns 4 edges (tree: nodes-1)', built.edges.length === 4);
t('the first node is the root', built.nodes[0].kind === 'root' && built.nodes[0].label === 'Mission Control Phase 2');
const wp4 = built.nodes.find((n) => n.label === 'WP4 Mind Map');
const wp5 = built.nodes.find((n) => n.label === 'WP5 Next Work Package');
const writer = built.nodes.find((n) => n.label.startsWith('Writer'));
const lens = built.nodes.find((n) => n.label.startsWith('Radial lens'));
t('WP4 and WP5 are direct children of the root (parent/child edges correct)',
  built.edges.some((e) => e.from === built.nodes[0].id && e.to === wp4.id) && built.edges.some((e) => e.from === built.nodes[0].id && e.to === wp5.id));
t('Writer and Radial lens are children of WP4 (depth 2)',
  built.edges.some((e) => e.from === wp4.id && e.to === writer.id) && built.edges.some((e) => e.from === wp4.id && e.to === lens.id));
t('WP4 has kind "branch" (it has children)', wp4.kind === 'branch');
t('WP5 has kind "leaf" (no children)', wp5.kind === 'leaf');
t('Writer/Radial lens have kind "leaf"', writer.kind === 'leaf' && lens.kind === 'leaf');

// 2) ids are isValidId-safe even for labels with spaces/parens
t('every generated id is isValidId-safe', built.nodes.every((n) => isValidId(n.id)));
t('every generated id is unique', new Set(built.nodes.map((n) => n.id)).size === built.nodes.length);

// buildFromOutline never crashes on empty/malformed input
t('buildFromOutline on empty text returns no nodes/edges', buildFromOutline('').nodes.length === 0 && buildFromOutline('').edges.length === 0);
t('buildFromOutline on null/undefined never throws', (() => { try { buildFromOutline(null); buildFromOutline(undefined); return true; } catch { return false; } })());

// 3) writeMindmap creates <id>.json + index row
const map = { map_id: 'mm-full-001', title: built.nodes[0].label, nodes: built.nodes, edges: built.edges };
const written = writeMindmap(map, { mermaid: true });
t('writeMindmap returns map_id/jsonPath', written.map_id === 'mm-full-001' && !!written.jsonPath);
t('writeMindmap creates the .json file', fs.existsSync(written.jsonPath));
t('writeMindmap creates the .mmd file when opts.mermaid', !!written.mmdPath && fs.existsSync(written.mmdPath));
const idxPath = path.join(TMP, 'forge-mindmaps', 'index.jsonl');
t('writeMindmap appends a row to forge-mindmaps/index.jsonl', fs.existsSync(idxPath) && fs.readFileSync(idxPath, 'utf8').includes('mm-full-001'));
const storedJson = JSON.parse(fs.readFileSync(written.jsonPath, 'utf8'));
t('stored json carries a _generated ISO timestamp', typeof storedJson._generated === 'string' && !Number.isNaN(Date.parse(storedJson._generated)));
t('stored json round-trips the node/edge counts', storedJson.nodes.length === built.nodes.length && storedJson.edges.length === built.edges.length);

// 4) toMermaid contains '-->'
const mmd = toMermaid(map);
t('toMermaid output contains "-->"', mmd.includes('-->'));
t('toMermaid starts with "graph TD"', mmd.startsWith('graph TD'));
t('toMermaid never crashes on a malformed map', (() => { try { toMermaid({}); toMermaid(null); toMermaid({ nodes: 'x', edges: 'y' }); return true; } catch { return false; } })());

// 5) a fake secret in a label is ABSENT from the written json (redacted)
const FAKE_SECRET = '\x6Evapi-FAKEFAKEFAKEFAKE1234567890';
const secretOutline = 'Root Idea\n  leaked key: ' + FAKE_SECRET;
const secretBuilt = buildFromOutline(secretOutline);
const secretMap = { map_id: 'mm-secret-001', title: secretBuilt.nodes[0].label, nodes: secretBuilt.nodes, edges: secretBuilt.edges };
const writtenSecret = writeMindmap(secretMap, { mermaid: true });
const jsonText = fs.readFileSync(writtenSecret.jsonPath, 'utf8');
const mmdText = fs.readFileSync(writtenSecret.mmdPath, 'utf8');
t('fake secret ABSENT from the written .json', !jsonText.includes(FAKE_SECRET));
t('fake secret ABSENT from the written .mmd', !mmdText.includes(FAKE_SECRET));
t('redaction marker present in the written .json', jsonText.includes('***REDACTED***'));

// 6) invalid map_id ("../x") is rejected
let rejected = false;
try { writeMindmap({ map_id: '../x', title: 'bad', nodes: [], edges: [] }); } catch (e) { rejected = /invalid map_id/i.test(e.message); }
t('invalid map_id "../x" is REJECTED', rejected === true);
t('bad-id write did not escape forge-mindmaps/', !fs.existsSync(path.join(TMP, 'x.json')));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
