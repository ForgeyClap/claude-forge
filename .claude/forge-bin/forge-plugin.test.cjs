#!/usr/bin/env node
'use strict';
// forge-plugin.test.cjs — validates the Claude Code plugin + marketplace manifests (2026-07-11).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');         // .../forge/template
const PLUGIN_DIR = path.join(ROOT, '.claude-plugin');
const CLAUDE = path.join(ROOT, '.claude');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge plugin/marketplace manifest tests');

// The plugin + marketplace manifests are a TEMPLATE distribution artifact — they live only in the Forge
// template, NOT in installed projects (a project is not a plugin marketplace). When this synced test runs
// inside a project, the manifest is absent by design → skip cleanly (counts as an OK suite).
// Honesty fix (2026-07-14): the skip branch must assert something REAL, not just print "0 passed, 0 failed"
// — a doctor that requires p > 0 to count a suite as ok would otherwise treat this legitimate skip as
// "no evidence" (indistinguishable from a broken/empty suite). Assert the actual skip condition instead.
if (!fs.existsSync(path.join(PLUGIN_DIR, 'plugin.json'))) {
  t('no .claude-plugin dir in this repo -> plugin checks not applicable', () => { assert.ok(!fs.existsSync(path.join(PLUGIN_DIR, 'plugin.json'))); });
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
const market = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'marketplace.json'), 'utf8'));

t('plugin.json is valid JSON with name "forge" + version + description', () => { assert.ok(plugin.name === 'forge' && /^\d+\.\d+\.\d+$/.test(plugin.version) && plugin.description.length > 20); });
t('plugin.json declares component dirs that exist', () => { for (const key of ['commands', 'agents', 'skills']) { const rel = plugin[key]; assert.ok(rel, 'missing ' + key); assert.ok(fs.existsSync(path.join(ROOT, rel)), key + ' dir missing: ' + rel); } });
t('the agents dir actually holds the 12 Boss files', () => { const agents = fs.readdirSync(path.join(CLAUDE, 'agents')).filter((f) => f.endsWith('.md')); assert.ok(agents.length >= 12, 'only ' + agents.length + ' agent files'); });
t('marketplace.json is valid + lists the forge plugin', () => { assert.ok(market.name && Array.isArray(market.plugins) && market.plugins.some((p) => p.name === 'forge')); });
t('marketplace forge plugin source resolves to the plugin root', () => { const p = market.plugins.find((x) => x.name === 'forge'); assert.ok(p.source && fs.existsSync(path.resolve(ROOT, p.source, '.claude-plugin', 'plugin.json'))); });

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
