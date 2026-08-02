#!/usr/bin/env node
/**
 * build-theme.cjs - turns brand/tokens.json into brand/forge-tokens.css
 *
 * Zero dependencies. Node 18+.
 *
 *   node brand/build-theme.cjs            write forge-tokens.css
 *   node brand/build-theme.cjs --check    exit 1 if the CSS has drifted from tokens.json
 *   node brand/build-theme.cjs --inline   print a <style> block on stdout (self-contained HTML)
 *
 * Only the semantic layer reaches CSS. The raw `palette` block stays in JSON so
 * nobody can reach past the semantic names and hardcode a material colour.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const TOKENS_PATH = path.join(DIR, 'tokens.json');
const CSS_PATH = path.join(DIR, 'forge-tokens.css');

/* ------------------------------------------------------------------ utils */

function fail(msg) {
  process.stderr.write(`build-theme: ${msg}\n`);
  process.exit(1);
}

/** Walk an object into flat [name, value] pairs, skipping `_comment` keys. */
function flatten(obj, prefix = [], out = []) {
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_') || key.startsWith('$')) continue;
    const next = prefix.concat(key);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, next, out);
    } else {
      out.push([next.join('-'), String(value)]);
    }
  }
  return out;
}

/** Read `{palette.ember.500}` style references out of the raw token tree. */
function lookup(tree, dottedPath) {
  return dottedPath.split('.').reduce((node, key) => {
    if (node == null || typeof node !== 'object') return undefined;
    return node[key];
  }, tree);
}

function resolveAliases(value, tree, seen = new Set()) {
  const ALIAS = /\{([a-zA-Z0-9._-]+)\}/g;
  return value.replace(ALIAS, (match, ref) => {
    if (seen.has(ref)) fail(`circular alias: ${ref}`);
    const found = lookup(tree, ref);
    if (typeof found !== 'string') fail(`unresolved alias ${match}`);
    return resolveAliases(found, tree, new Set(seen).add(ref));
  });
}

function hexToRgb(hex) {
  const clean = hex.trim().replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/* ----------------------------------------------------------------- emitter */

/**
 * Status and group colours each get two derived companions so badges, chips and
 * node fills never need a one-off rgba() written by hand:
 *   --forge-status-running        solid
 *   --forge-status-running-soft   tinted fill
 *   --forge-status-running-line   tinted border
 */
function declarations(scope, tokens, meta) {
  const lines = [];
  for (const [name, raw] of tokens) {
    const varName = `--${meta.prefix}-${name}`;
    lines.push(`  ${varName}: ${raw};`);

    const derivable = name.startsWith('status-') || name.startsWith('group-');
    if (derivable && hexToRgb(raw)) {
      lines.push(`  ${varName}-soft: ${rgba(raw, meta.softAlpha)};`);
      lines.push(`  ${varName}-line: ${rgba(raw, meta.lineAlpha)};`);
    }
  }
  return `${scope} {\n${lines.join('\n')}\n}`;
}

function build() {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch (err) {
    fail(`cannot read tokens.json - ${err.message}`);
  }

  const meta = source.$meta || {};
  if (!meta.prefix) fail('tokens.json is missing $meta.prefix');

  const resolve = (tokens) =>
    tokens.map(([name, value]) => [name, resolveAliases(value, source)]);

  const globals = resolve(flatten(source.global || {}));
  const dark = resolve(flatten(source.modes.dark || {}));
  const light = resolve(flatten(source.modes.light || {}));

  const body = [
    declarations(':root', globals, meta),
    '',
    '/* Dark is the default. The forge is a dark room. */',
    declarations(':root, [data-theme="dark"]', dark, meta),
    '',
    declarations('[data-theme="light"]', light, meta),
    '',
    '@media (prefers-color-scheme: light) {',
    declarations('  :root:not([data-theme])', light, meta)
      .split('\n')
      .map((l) => (l ? `  ${l}` : l))
      .join('\n'),
    '}',
  ].join('\n');

  const digest = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);

  const header = [
    '/*',
    ` * ${meta.name} design tokens v${meta.version} - GENERATED FILE, DO NOT EDIT.`,
    ' * Source: brand/tokens.json   Rebuild: node brand/build-theme.cjs',
    ` * Content hash: ${digest}`,
    ' */',
    '',
  ].join('\n');

  return { css: header + body + '\n', digest };
}

/* -------------------------------------------------------------------- main */

const args = new Set(process.argv.slice(2));
const { css, digest } = build();

if (args.has('--inline')) {
  process.stdout.write(`<style>\n${css}</style>\n`);
  process.exit(0);
}

if (args.has('--check')) {
  let onDisk = '';
  try {
    onDisk = fs.readFileSync(CSS_PATH, 'utf8');
  } catch {
    process.stderr.write('build-theme: forge-tokens.css is missing. Run: node brand/build-theme.cjs\n');
    process.exit(1);
  }
  if (onDisk !== css) {
    process.stderr.write(
      'build-theme: forge-tokens.css has drifted from tokens.json.\n' +
        '             Someone edited the generated CSS by hand, or forgot to rebuild.\n' +
        '             Fix with: node brand/build-theme.cjs\n'
    );
    process.exit(1);
  }
  process.stdout.write(`build-theme: tokens in sync (${digest})\n`);
  process.exit(0);
}

fs.writeFileSync(CSS_PATH, css, 'utf8');
const count = (css.match(/^\s+--/gm) || []).length;
process.stdout.write(`build-theme: wrote forge-tokens.css - ${count} declarations (${digest})\n`);
