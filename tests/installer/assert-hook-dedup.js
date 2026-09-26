#!/usr/bin/env node
'use strict';
/*
 * assert-hook-dedup.js -- used only by .github/workflows/fresh-install.yml's "Upgrading a
 * 2.7.2-shaped settings.json ..." steps (WP-D1, v2.8.0 laptop re-audit N8/D1).
 *
 * A pre-2.8.0 (2.7.2-shaped) settings.json has cwd-relative hook commands with no
 * $CLAUDE_PROJECT_DIR and no separate PowerShell matcher. Merging the current template into it
 * must recognise each old-form hook entry as the SAME hook (just an older form of the identical
 * script under the identical event) and normalise it in place -- never leave the old form
 * untouched AND add a second, duplicate entry for the same script under the same matcher. This
 * check is deliberately matcher-STRING-agnostic (an upgrade may widen "Bash" to "Bash|PowerShell",
 * which is fine) -- what it never allows is two entries under the SAME (event, matcher) pair both
 * referencing the same script, or a surviving reference still in the old cwd-relative form.
 *
 * Usage: node assert-hook-dedup.js <path-to-settings.json>
 * Exit 0 = every one of the known scripts survives the merge, with no (event, matcher) group
 *          referencing it more than once, and no surviving reference left in the old form.
 * Exit 1 = a duplicate group, a script that vanished entirely, or a surviving reference still
 *          using the old cwd-relative form -- printed to stderr so the CI log names exactly what
 *          failed.
 */

const fs = require('fs');

const settingsPath = process.argv[2];
if (!settingsPath) {
  console.error('usage: node assert-hook-dedup.js <path-to-settings.json>');
  process.exit(2);
}

let settings;
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {
  console.error('could not read/parse ' + settingsPath + ': ' + e.message);
  process.exit(2);
}

// The scripts the OLD (2.7.2-shaped) fixture in fresh-install.yml seeds under a cwd-relative,
// unquoted, no-$CLAUDE_PROJECT_DIR command -- every one of these must still be wired after a merge.
const KNOWN_SCRIPTS = [
  'forge-snapshot-marker.cjs',
  'forge-snapshot-reinject.cjs',
  'forge-toolhook.cjs',
  'forge-gate-hook.cjs',
];

const hooks = (settings && settings.hooks) || {};
let bad = 0;

for (const script of KNOWN_SCRIPTS) {
  // groupKey -> [{ command }]
  const groups = new Map();
  for (const event of Object.keys(hooks)) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    entries.forEach((entry, idx) => {
      if (!entry) return;
      const matcher = typeof entry.matcher === 'string' ? entry.matcher : '';
      for (const h of (entry.hooks || [])) {
        if (typeof h.command === 'string' && h.command.indexOf(script) !== -1) {
          const key = event + '\u0000' + matcher + '\u0000' + idx;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(h.command);
        }
      }
    });
  }

  const allCommands = [].concat(...groups.values());
  if (allCommands.length === 0) {
    console.error('MISSING: no hook entry references ' + script + ' after the merge');
    bad = 1;
    continue;
  }

  // Duplicate check is per (event, matcher-string) pair, not per array index -- two SEPARATE
  // entries under the identical event with the identical matcher string, both referencing the
  // same script, is the actual bug this test exists to catch.
  const byEventMatcher = new Map();
  for (const event of Object.keys(hooks)) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const entry of entries) {
      if (!entry) continue;
      const matcher = typeof entry.matcher === 'string' ? entry.matcher : '';
      for (const h of (entry.hooks || [])) {
        if (typeof h.command === 'string' && h.command.indexOf(script) !== -1) {
          const key = event + '|' + matcher;
          byEventMatcher.set(key, (byEventMatcher.get(key) || 0) + 1);
        }
      }
    }
  }
  const dupes = [...byEventMatcher.entries()].filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    console.error('DUPLICATE: ' + script + ' is referenced more than once under the same (event, matcher): ' + JSON.stringify(dupes));
    bad = 1;
    continue;
  }

  const stale = allCommands.filter((c) => c.indexOf('$CLAUDE_PROJECT_DIR') === -1);
  if (stale.length > 0) {
    console.error('STALE FORM: ' + script + ' still has a surviving reference without $CLAUDE_PROJECT_DIR: ' + JSON.stringify(stale));
    bad = 1;
    continue;
  }

  console.log('ok   ' + script + ' -> ' + allCommands.length + ' hook entry/entries, none duplicated per (event, matcher), all in the $CLAUDE_PROJECT_DIR form');
}

process.exit(bad);
