#!/usr/bin/env node
/**
 * analyze-bundle — the regression gate for dist/.
 *
 * Reports every emitted asset raw + gzipped, checks each against a budget, and
 * exits 1 when one is blown. Zero dependencies on purpose: this has to run in
 * CI and on a fresh clone without an install step, so it uses node:zlib rather
 * than a bundle-analyzer package.
 *
 * WHY THIS EXISTS
 * The JS bundle was 1,233.63 kB (343.68 kB gzip) because
 * src/components/primitives/Icon.tsx resolved lucide icons by name off an
 * `import * as Lucide`. A namespace import is opaque to tree-shaking, so all
 * ~1,600 icons shipped. Replacing it with the static map in
 * src/components/primitives/icon-map.ts, plus vendor splitting in
 * vite.config.ts, brought that to 691.07 kB (202.33 kB gzip).
 *
 * That kind of regression is invisible in review — one `import *` reintroduces
 * half a megabyte and nothing fails. This script is what makes it fail.
 *
 * USAGE
 *   node scripts/analyze-bundle.cjs           # report + enforce (exit 1 on breach)
 *   node scripts/analyze-bundle.cjs --json    # machine-readable, still enforces
 *   node scripts/analyze-bundle.cjs --no-fail # report only, always exit 0
 *
 * UPDATING BUDGETS
 * Budgets are the measured size plus ~10% headroom. When a deliberate feature
 * genuinely grows a chunk, re-measure with `npm run build` and raise the number
 * in the same commit, so the increase is reviewed rather than absorbed.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIST = path.join(__dirname, '..', 'dist');
const ASSETS = path.join(DIST, 'assets');

/**
 * Budgets in kB, where kB is 1000 bytes — the same unit Vite prints, so these
 * numbers can be compared directly against build output without conversion.
 * Keys are "<chunk>.<ext>" with the content hash stripped.
 */
const BUDGETS = {
  // WP11 — re-baselined after route-level code splitting (App.tsx: every view
  // is now `React.lazy` + `import()`, one chunk per route, instead of one
  // eager import each). measured 268.78 raw / 79.02 gzip, DOWN from 506.38 /
  // 141.96 before the split — the same app code still ships, just not all in
  // the entry chunk. Previous (monolithic-views) baseline was 540 / 151; kept
  // here only as the historical note, not the budget, so a regression back
  // toward "every view eager again" is caught close to where it happens
  // rather than only once the generous old 540 kB ceiling was blown.
  'index.js': { raw: 300, gzip: 90 },
  // measured 192.36 raw / 60.30 gzip — react + react-dom + scheduler
  'react.js': { raw: 212, gzip: 67 },
  // measured 44.82 raw / 13.84 gzip — 172 explicitly imported lucide icons.
  // This is the canary. A namespace import lands here and blows it instantly.
  'icons.js': { raw: 50, gzip: 16 },
  // measured 37.30 raw / 13.49 gzip — react-router
  'router.js': { raw: 41, gzip: 15 },
  // WP11 — re-baselined the same way as index.js: measured 100.20 raw / 13.02
  // gzip, DOWN from 270.95 / 31.45, now that each view's own stylesheet is a
  // separate async chunk (see the per-view *.css rows, unbudgeted individually
  // but still counted in TOTAL css below) rather than one shared index.css.
  'index.css': { raw: 115, gzip: 15 },
};

/**
 * Totals catch anything that slips in under a new, unbudgeted chunk name.
 * WP11 — total JS raw/gzip bytes are essentially unchanged by code-splitting
 * (same source, just re-chunked: measured 788.66 / 241.58, budget unchanged).
 * Total CSS raw is also unchanged (same stylesheet content: measured 270.96,
 * budget unchanged), but total CSS GZIP genuinely grew (31.14 -> 40.93): gzip
 * compresses one 270 kB stream far better than fourteen small independent
 * streams, since cross-view repeated tokens (custom-property names, utility
 * class fragments) can no longer share a compression window. That is a real,
 * measured, and expected side effect of splitting one file into many — not a
 * regression to chase back down — so the gzip budget is re-baselined with the
 * same ~10% headroom convention as every other entry in this file.
 */
const TOTALS = {
  js: { raw: 840, gzip: 247 }, // measured 788.66 / 241.58 (WP11 split build)
  css: { raw: 300, gzip: 45 }, // measured 270.96 / 40.93 (WP11 split build)
};

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const noFail = argv.includes('--no-fail');

const kb = (bytes) => bytes / 1000;
const fmt = (bytes) => kb(bytes).toFixed(2).padStart(9);

/** `index-dT0r-hGS.js` -> `index.js`. The hash itself may contain a dash. */
function stripHash(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const m = /^(.*)-([A-Za-z0-9_$-]{8})$/.exec(base);
  return (m ? m[1] : base) + ext;
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

if (!fs.existsSync(ASSETS)) {
  fail(
    'analyze-bundle: no dist/assets directory.\n' +
      'Run `npm run build` first — there is nothing to measure.',
  );
}

const files = fs
  .readdirSync(ASSETS)
  .filter((f) => fs.statSync(path.join(ASSETS, f)).isFile())
  .sort();

if (files.length === 0) fail('analyze-bundle: dist/assets is empty. Run `npm run build` first.');

const rows = [];
const totals = { js: { raw: 0, gzip: 0 }, css: { raw: 0, gzip: 0 }, other: { raw: 0, gzip: 0 } };

for (const file of files) {
  const buf = fs.readFileSync(path.join(ASSETS, file));
  // Default level, matching what Vite reports, so these numbers line up with
  // the build log rather than quietly disagreeing with it.
  const gzip = zlib.gzipSync(buf).length;
  const key = stripHash(file);
  const ext = path.extname(file).slice(1);
  const group = ext === 'js' ? 'js' : ext === 'css' ? 'css' : 'other';

  totals[group].raw += buf.length;
  totals[group].gzip += gzip;

  rows.push({ file, key, group, raw: buf.length, gzip, budget: BUDGETS[key] || null });
}

const breaches = [];
for (const r of rows) {
  if (!r.budget) continue;
  if (kb(r.raw) > r.budget.raw) {
    breaches.push(`${r.key} raw ${kb(r.raw).toFixed(2)} kB exceeds budget ${r.budget.raw} kB`);
  }
  if (kb(r.gzip) > r.budget.gzip) {
    breaches.push(`${r.key} gzip ${kb(r.gzip).toFixed(2)} kB exceeds budget ${r.budget.gzip} kB`);
  }
}
for (const group of ['js', 'css']) {
  const t = totals[group];
  const b = TOTALS[group];
  if (kb(t.raw) > b.raw) {
    breaches.push(`total ${group} raw ${kb(t.raw).toFixed(2)} kB exceeds budget ${b.raw} kB`);
  }
  if (kb(t.gzip) > b.gzip) {
    breaches.push(`total ${group} gzip ${kb(t.gzip).toFixed(2)} kB exceeds budget ${b.gzip} kB`);
  }
}

const unbudgeted = rows.filter((r) => !r.budget && r.group !== 'other').map((r) => r.key);

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: breaches.length === 0,
        files: rows.map((r) => ({
          file: r.file,
          chunk: r.key,
          raw: r.raw,
          gzip: r.gzip,
          budget: r.budget,
        })),
        totals,
        unbudgeted,
        breaches,
      },
      null,
      2,
    ) + '\n',
  );
} else {
  const out = [];
  out.push('');
  out.push('  BUNDLE BUDGET REPORT                              raw kB    gzip kB    budget');
  out.push('  ' + '-'.repeat(76));
  for (const r of rows) {
    const b = r.budget ? `${String(r.budget.raw).padStart(6)} /${String(r.budget.gzip).padStart(5)}` : '     -';
    const over =
      r.budget && (kb(r.raw) > r.budget.raw || kb(r.gzip) > r.budget.gzip) ? '  OVER' : '';
    out.push(`  ${r.file.padEnd(34)}${fmt(r.raw)}  ${fmt(r.gzip)}   ${b}${over}`);
  }
  out.push('  ' + '-'.repeat(76));
  out.push(
    `  ${'TOTAL js'.padEnd(34)}${fmt(totals.js.raw)}  ${fmt(totals.js.gzip)}   ${String(TOTALS.js.raw).padStart(6)} /${String(TOTALS.js.gzip).padStart(5)}`,
  );
  out.push(
    `  ${'TOTAL css'.padEnd(34)}${fmt(totals.css.raw)}  ${fmt(totals.css.gzip)}   ${String(TOTALS.css.raw).padStart(6)} /${String(TOTALS.css.gzip).padStart(5)}`,
  );
  if (totals.other.raw > 0) {
    out.push(`  ${'TOTAL other'.padEnd(34)}${fmt(totals.other.raw)}  ${fmt(totals.other.gzip)}        -`);
  }
  out.push('');
  if (unbudgeted.length > 0) {
    out.push(`  note: no per-chunk budget for ${unbudgeted.join(', ')} — covered by the totals.`);
    out.push('');
  }
  process.stdout.write(out.join('\n'));
}

if (breaches.length > 0) {
  const msg = [
    '',
    '  BUNDLE BUDGET EXCEEDED',
    '',
    ...breaches.map((b) => '    - ' + b),
    '',
    '  Most likely causes:',
    '    - A namespace import of an icon/utility library (`import * as X`).',
    '      That defeats tree-shaking; it is what made this bundle 1.23 MB before.',
    '      Import the specific names instead.',
    '    - A heavy new dependency pulled into app code.',
    '',
    '  If the growth is deliberate, re-measure and raise the budget in',
    '  scripts/analyze-bundle.cjs in the same commit, so it gets reviewed.',
    '',
  ].join('\n');
  process.stderr.write(msg);
  if (!noFail) process.exit(1);
}

if (!asJson && breaches.length === 0) {
  process.stdout.write('  All chunks within budget.\n\n');
}
