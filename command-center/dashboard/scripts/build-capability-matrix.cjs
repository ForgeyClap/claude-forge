#!/usr/bin/env node
/**
 * build-capability-matrix.cjs — mechanically inventories the product by parsing
 * the source, and writes two committed artefacts:
 *
 *   capability/matrix.json    one record per capability, machine-readable
 *   docs/capability-matrix.md a readable summary whose centrepiece is the
 *                             COVERAGE GAP list
 *
 * WHY THIS IS A PARSER AND NOT A LIST
 * A hand-maintained inventory is a lie with a delay fuse: it is correct on the
 * day it is written and wrong the first time somebody adds a button. Everything
 * below is read out of the source at build time, so the inventory cannot drift
 * from the product without the diff saying so.
 *
 * WHAT IT READS
 *   src/App.tsx                          routes
 *   src/views/**                         view modules
 *   src/**\/*.tsx                         interactive controls
 *   src/components/shell/CommandPalette.tsx   palette actions
 *   src/**\/*.ts(x)                       keyboard handlers and KeyHint usages
 *   src/shared/protocol.ts               OPERATIONS, EVENT_TYPES
 *   src/bridge/**\/*.ts                   handler registrations
 *   src/shared/state-machines.ts         states and transitions
 *   tests/**                             @capability links (see below)
 *
 * HOW TESTS GET LINKED
 * Nothing is linked today, by design — a later pass does that. The convention
 * this script already implements is a comment in a test file:
 *
 *     // @capability bridge:sendMessage positive
 *     // @capability control:src-views-chat-Composer-tsx-256 negative
 *
 * where the trailing word is one of positive | negative | security | chaos.
 * Until such a comment exists, the four test fields stay null and the record's
 * status stays UNVERIFIED. "No test linked" is not the same claim as "no test
 * exists", and the report says so out loud rather than implying otherwise.
 *
 * DETERMINISM
 * There is no timestamp and no absolute path in either output, so re-running on
 * an unchanged tree produces a byte-identical file and `--check` is meaningful
 * in CI.
 *
 * HONEST LIMITS OF THE PARSER (also printed into the markdown)
 *   - It reads text, not a type-checked AST. A control produced by a loop is one
 *     record at its JSX site, not one record per rendered instance.
 *   - An accessible name is only read when it is a literal in the JSX. A name
 *     that comes from a variable is reported as unreadable, never guessed.
 *   - Keyboard chords are matched heuristically (key literal + modifier idents
 *     on the same line). A documented chord reported as unhandled means the
 *     parser found no matching handler, which is strong evidence but not proof.
 *
 * Zero dependencies. Node only.
 *
 *   node scripts/build-capability-matrix.cjs
 *   node scripts/build-capability-matrix.cjs --check    (CI: fail if stale)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TESTS = path.join(ROOT, 'tests');
const JSON_OUT = path.join(ROOT, 'capability', 'matrix.json');
const MD_OUT = path.join(ROOT, 'docs', 'capability-matrix.md');

const CHECK = process.argv.includes('--check');

function fail(msg) {
  process.stderr.write(`build-capability-matrix: ${msg}\n`);
  process.exit(1);
}

/* ========================================================================== */
/*  Filesystem                                                                 */
/* ========================================================================== */

/** Repo-relative, forward-slashed. Every path in the output looks like this. */
function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(abs, filter, out);
    } else if (filter(abs)) {
      out.push(abs);
    }
  }
  return out;
}

function read(abs) {
  return fs.readFileSync(abs, 'utf8');
}

/** Index -> 1-based line number, via a precomputed table of line starts. */
function lineIndexer(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1);
  return function lineAt(index) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function lineTextAt(src, index) {
  const from = src.lastIndexOf('\n', index) + 1;
  let to = src.indexOf('\n', index);
  if (to === -1) to = src.length;
  return src.slice(from, to);
}

/* ========================================================================== */
/*  Source masking                                                             */
/* ========================================================================== */

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '>']);
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'instanceof',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Is the `/` at `i` the start of a regex literal rather than a division or a
 * JSX closing tag? Decided from the previous significant character, the usual
 * lexer heuristic. `</div>` is excluded explicitly: `<` would otherwise look
 * like an operator and swallow the rest of the file.
 */
function regexAllowedAt(src, i) {
  if (i > 0 && src[i - 1] === '<') return false;
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (j < 0) return true;
  const c = src[j];
  if (REGEX_PRECEDERS.has(c)) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k -= 1;
    return REGEX_KEYWORDS.has(src.slice(k + 1, j + 1));
  }
  return false;
}

/** End of a single-line regex literal including flags, or -1. */
function regexEnd(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '\n') return -1;
    if (inClass) {
      if (c === ']') inClass = false;
      j += 1;
      continue;
    }
    if (c === '[') {
      inClass = true;
      j += 1;
      continue;
    }
    if (c === '/') {
      j += 1;
      while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return -1;
}

/**
 * Marks every offset that lives inside a comment, a string, a template literal
 * or a regex literal, so a `<button>` written in a doc comment is never counted
 * as a control.
 *
 * Two subtleties, both learned the hard way on this codebase:
 *
 * 1. JSX text contains apostrophes, and an apostrophe is not a string quote.
 *    Before entering a quoted state the scanner looks ahead for a closing quote
 *    on the SAME line (a JS string literal cannot span a newline unescaped). An
 *    unpaired quote is therefore treated as prose, which is what it is.
 *
 * 2. A regex literal can contain a backtick or a quote — `/[*`_]/g` really is in
 *    this source. Without regex handling that lone backtick opens a template
 *    literal and silently swallows the rest of the file, which is exactly the
 *    kind of quiet under-count this whole inventory exists to prevent.
 */
function maskInert(src) {
  const mask = new Uint8Array(src.length);
  const n = src.length;
  let i = 0;

  function closesOnLine(quote, from) {
    for (let j = from; j < n; j += 1) {
      const c = src[j];
      if (c === '\\') {
        j += 1;
        continue;
      }
      if (c === '\n') return -1;
      if (c === quote) return j;
    }
    return -1;
  }

  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';

    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') mask[i++] = 1;
      continue;
    }
    if (c === '/' && d === '*') {
      mask[i++] = 1;
      mask[i++] = 1;
      while (i < n) {
        if (src[i] === '*' && src[i + 1] === '/') {
          mask[i++] = 1;
          mask[i++] = 1;
          break;
        }
        mask[i++] = 1;
      }
      continue;
    }
    if (c === '/' && regexAllowedAt(src, i)) {
      const close = regexEnd(src, i);
      if (close !== -1) {
        for (let j = i + 1; j < close; j += 1) mask[j] = 1;
        i = close;
        continue;
      }
    }
    if (c === '`') {
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          mask[i++] = 1;
          if (i < n) mask[i++] = 1;
          continue;
        }
        if (src[i] === '`') {
          i += 1;
          break;
        }
        mask[i++] = 1;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const close = closesOnLine(c, i + 1);
      if (close === -1) {
        i += 1; // prose apostrophe, not a literal
        continue;
      }
      for (let j = i + 1; j < close; j += 1) mask[j] = 1;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return mask;
}

/**
 * A cheap smoke test on the masker itself. An unterminated construct — the
 * failure mode that silently ate a third of the controls before regex literals
 * were handled — shows up as a very long masked run reaching the end of file.
 * Anything this flags is a parser bug, not a source-code problem, so it is
 * surfaced loudly rather than swallowed.
 */
function maskHealth(src, mask) {
  let masked = 0;
  let run = 0;
  let longest = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      masked += 1;
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  let trailing = 0;
  for (let i = mask.length - 1; i >= 0 && mask[i]; i -= 1) trailing += 1;
  // The longest legitimate run in this tree is a ~4 kB file header. A run past
  // LONGEST_SANE_RUN means an unterminated literal swallowed real code. The
  // ratio is not a signal on its own: a fixture file is mostly string data and a
  // .d.ts is mostly comment, and both are fine.
  const LONGEST_SANE_RUN = 8000;
  return {
    ratio: src.length === 0 ? 0 : masked / src.length,
    trailing,
    longest,
    suspect: trailing > 400 || longest > LONGEST_SANE_RUN,
  };
}

const MASK_WARNINGS = [];

function maskFile(relPath, src) {
  const mask = maskInert(src);
  const health = maskHealth(src, mask);
  if (health.suspect) {
    MASK_WARNINGS.push(
      `${relPath}: longest masked run ${health.longest} chars, ${health.trailing} of them trailing to EOF — the scanner may have lost its place`,
    );
  }
  return mask;
}

/* ========================================================================== */
/*  A very small JSX reader                                                    */
/* ========================================================================== */

function skipQuoted(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === quote) return j + 1;
    j += 1;
  }
  return src.length;
}

function matchBrace(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      j = skipQuoted(src, j);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return j;
    }
    j += 1;
  }
  return src.length - 1;
}

/** From the `<` of an opening tag to its `>`, tolerating braces and strings. */
function readOpeningTag(src, start) {
  let i = start + 1;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(src, i);
      continue;
    }
    if (c === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && c === '/' && src[i + 1] === '>') {
      return { end: i + 2, selfClosing: true, inner: src.slice(start, i) };
    }
    if (depth === 0 && c === '>') {
      return { end: i + 1, selfClosing: false, inner: src.slice(start, i) };
    }
    i += 1;
  }
  return null;
}

/** `{ name: { kind: 'literal'|'expression'|'boolean', value } }` */
function parseAttributes(inner) {
  const attrs = Object.create(null);
  let i = 1;
  while (i < inner.length && /[A-Za-z0-9_.$]/.test(inner[i])) i += 1;

  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i])) i += 1;
    if (i >= inner.length) break;

    if (inner[i] === '{') {
      const close = matchBrace(inner, i);
      const raw = inner.slice(i + 1, close).trim();
      if (raw.startsWith('...')) attrs['{spread}'] = { kind: 'expression', value: raw };
      i = close + 1;
      continue;
    }

    const nameStart = i;
    while (i < inner.length && /[A-Za-z0-9_:\-]/.test(inner[i])) i += 1;
    if (i === nameStart) {
      i += 1;
      continue;
    }
    const name = inner.slice(nameStart, i);

    let j = i;
    while (j < inner.length && /\s/.test(inner[j])) j += 1;
    if (inner[j] !== '=') {
      attrs[name] = { kind: 'boolean', value: true };
      continue;
    }
    i = j + 1;
    while (i < inner.length && /\s/.test(inner[i])) i += 1;

    const c = inner[i];
    if (c === '"' || c === "'") {
      const close = skipQuoted(inner, i);
      attrs[name] = { kind: 'literal', value: inner.slice(i + 1, close - 1) };
      i = close;
      continue;
    }
    if (c === '{') {
      const close = matchBrace(inner, i);
      const raw = inner.slice(i + 1, close).trim();
      const single = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/.exec(raw);
      attrs[name] = single
        ? { kind: 'literal', value: single[2] }
        : { kind: 'expression', value: raw.replace(/\s+/g, ' ') };
      i = close + 1;
      continue;
    }
    const bare = i;
    while (i < inner.length && !/\s/.test(inner[i])) i += 1;
    attrs[name] = { kind: 'literal', value: inner.slice(bare, i) };
  }
  return attrs;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Children source between a non-self-closing tag and its matching close. */
function readChildren(src, afterOpen, tagName) {
  const openRe = new RegExp(`<${escapeRe(tagName)}(?=[\\s/>])`, 'g');
  const closeRe = new RegExp(`</\\s*${escapeRe(tagName)}\\s*>`, 'g');
  let depth = 1;
  let cursor = afterOpen;

  for (let guard = 0; guard < 10000; guard += 1) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const open = openRe.exec(src);
    const close = closeRe.exec(src);
    if (!close) return null;
    if (open && open.index < close.index) {
      const tag = readOpeningTag(src, open.index);
      if (tag && !tag.selfClosing) depth += 1;
      cursor = tag ? tag.end : open.index + 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return src.slice(afterOpen, close.index);
    cursor = close.index + close[0].length;
  }
  return null;
}

const ENTITIES = { '&amp;': '&', '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&rarr;': '→', '&lt;': '<', '&gt;': '>' };

/** Children source -> the visible text a person would read, or null. */
function childrenText(raw) {
  if (raw == null) return null;
  let text = raw;
  // Drop balanced {expressions} — they are values, not labels.
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') {
      i = matchBrace(text, i);
      continue;
    }
    out += text[i];
  }
  text = out.replace(/<[^>]*>/g, ' ');
  for (const [entity, char] of Object.entries(ENTITIES)) text = text.split(entity).join(char);
  text = text.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** Every literal string inside a `['a', 'b']` array expression. */
function literalArray(expr) {
  if (typeof expr !== 'string') return null;
  const trimmed = expr.trim();
  if (!trimmed.startsWith('[')) return null;
  const items = [];
  const re = /(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(trimmed)) !== null) items.push(m[2]);
  return items;
}

/* ========================================================================== */
/*  Extractor: routes                                                          */
/* ========================================================================== */

function extractRoutes() {
  const abs = path.join(SRC, 'App.tsx');
  if (!fs.existsSync(abs)) fail('src/App.tsx not found — cannot inventory routes.');
  const src = read(abs);
  const lineAt = lineIndexer(src);

  const imports = new Map();
  const importRe = /import\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']+)'/g;
  let im;
  while ((im = importRe.exec(src)) !== null) imports.set(im[1], im[2]);

  const routes = [];
  const routeRe = /<Route\b/g;
  let m;
  while ((m = routeRe.exec(src)) !== null) {
    const tag = readOpeningTag(src, m.index);
    if (!tag) continue;
    const attrs = parseAttributes(tag.inner);
    const routePath = attrs.path && attrs.path.kind === 'literal' ? attrs.path.value : null;
    if (routePath === null) continue;
    const element = attrs.element ? attrs.element.value : '';
    const comp = /<\s*([A-Za-z_$][\w$]*)/.exec(String(element));
    const component = comp ? comp[1] : null;
    const redirect = /<\s*Navigate\b/.test(String(element));
    const to = /to=["']([^"']+)["']/.exec(String(element));
    routes.push({
      path: routePath,
      component,
      module: component && imports.has(component) ? imports.get(component) : null,
      redirect,
      redirectTo: redirect && to ? to[1] : null,
      file: rel(abs),
      line: lineAt(m.index),
    });
  }
  return routes;
}

/** '@/views/tasks/TasksView' -> 'src/views/tasks/TasksView.tsx' */
function resolveAlias(spec) {
  if (!spec || !spec.startsWith('@/')) return null;
  const base = path.join(SRC, spec.slice(2));
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    if (fs.existsSync(base + ext)) return rel(base + ext);
  }
  return null;
}

/* ========================================================================== */
/*  Extractor: view modules                                                    */
/* ========================================================================== */

function extractViews(routes) {
  const files = walk(path.join(SRC, 'views'), (f) => f.endsWith('.tsx') || f.endsWith('.ts'));
  const routedModule = new Map();
  for (const route of routes) {
    const mod = resolveAlias(route.module);
    if (mod) routedModule.set(mod, route.path);
  }

  return files.map((abs) => {
    const relPath = rel(abs);
    const src = read(abs);
    const lineAt = lineIndexer(src);
    const def = /export\s+default\s+(?:function\s+)?([A-Za-z_$][\w$]*)?/.exec(src);
    const named = [...src.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    const first = /export\s+default\b/.exec(src);
    return {
      file: relPath,
      line: first ? lineAt(first.index) : 1,
      area: relPath.split('/')[2] || 'views',
      component: (def && def[1]) || named[0] || path.basename(relPath).replace(/\.tsx?$/, ''),
      route: routedModule.get(relPath) ?? null,
      exports: named,
      lines: src.split('\n').length,
    };
  });
}

/* ========================================================================== */
/*  Extractor: interactive controls                                            */
/* ========================================================================== */

const CONTROL_TAGS = [
  'Button',
  'IconButton',
  'Switch',
  'Tabs',
  'SegmentedControl',
  'button',
  'input',
  'textarea',
  'select',
  'NavLink',
  'Link',
];

/** Which attribute carries the accessible name, in the order aria resolves it. */
const NAME_ATTRS = ['aria-label', 'ariaLabel', 'label', 'title', 'placeholder', 'alt'];

function extractControls() {
  const files = walk(SRC, (f) => f.endsWith('.tsx'));
  const controls = [];

  for (const abs of files) {
    const relPath = rel(abs);
    const src = read(abs);
    const mask = maskFile(relPath, src);
    const lineAt = lineIndexer(src);

    for (const tagName of CONTROL_TAGS) {
      const re = new RegExp(`<${escapeRe(tagName)}(?=[\\s/>])`, 'g');
      let m;
      while ((m = re.exec(src)) !== null) {
        if (mask[m.index]) continue;
        const tag = readOpeningTag(src, m.index);
        if (!tag) continue;
        const attrs = parseAttributes(tag.inner);

        let name = null;
        let nameSource = null;
        let nameExpression = null;
        for (const key of NAME_ATTRS) {
          const attr = attrs[key];
          if (!attr) continue;
          if (attr.kind === 'literal') {
            name = attr.value;
            nameSource = key;
            nameExpression = null;
            break;
          }
          if (!nameSource) {
            nameSource = `${key} (expression)`;
            nameExpression = `${key}={${String(attr.value)}}`;
          }
        }

        let rawChildren = null;
        if (!name && !tag.selfClosing) {
          rawChildren = readChildren(src, tag.end, tagName);
          const children = childrenText(rawChildren);
          if (children) {
            name = children;
            nameSource = 'children';
          }
        }

        const notes = [];
        if (relPath.startsWith('src/components/primitives/')) notes.push('primitive implementation');
        if (attrs.disabled) notes.push('can be disabled');
        if (attrs['{spread}']) notes.push('props spread — attributes may be supplied by the caller');
        if (!name) {
          notes.push('no accessible name readable from the JSX');
          // Say WHERE the name will come from at runtime, so the row is
          // actionable instead of merely being a complaint.
          if (nameExpression) notes.push(`name comes from ${nameExpression.replace(/\s+/g, ' ').slice(0, 120)}`);
          else if (rawChildren) {
            const snippet = rawChildren.replace(/\s+/g, ' ').trim();
            if (snippet) notes.push(`children: ${snippet.slice(0, 120)}${snippet.length > 120 ? '…' : ''}`);
          }
        }

        const handlerAttr = ['onClick', 'onChange', 'onSubmit', 'onKeyDown', 'onInput'].find((k) => attrs[k]);

        controls.push({
          tag: tagName,
          file: relPath,
          line: lineAt(m.index),
          name,
          nameSource,
          handler: handlerAttr ? String(attrs[handlerAttr].value).slice(0, 120) : null,
          handlerAttr: handlerAttr ?? null,
          type: attrs.type && attrs.type.kind === 'literal' ? attrs.type.value : null,
          role: attrs.role && attrs.role.kind === 'literal' ? attrs.role.value : null,
          to: attrs.to && attrs.to.kind === 'literal' ? attrs.to.value : null,
          notes,
        });
      }
    }
  }

  controls.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return controls;
}

/* ========================================================================== */
/*  Extractor: command-palette actions                                         */
/* ========================================================================== */

function extractPaletteActions() {
  const abs = path.join(SRC, 'components', 'shell', 'CommandPalette.tsx');
  if (!fs.existsSync(abs)) return [];
  const src = read(abs);
  const lineAt = lineIndexer(src);
  const actions = [];

  const re = /list\.push\(\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    const close = matchBrace(src, open);
    const body = src.slice(open, close + 1);

    const field = (key) => {
      const lit = new RegExp(`\\b${key}\\s*:\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(body);
      if (lit) return { value: lit[2], dynamic: false };
      const tpl = new RegExp(`\\b${key}\\s*:\\s*\`([^\`]*)\``).exec(body);
      if (tpl) return { value: tpl[1], dynamic: /\$\{/.test(tpl[1]) };
      return null;
    };

    const id = field('id');
    const group = field('group');
    const title = field('title');
    const detail = field('detail');
    const icon = field('icon');
    const keysMatch = /\bkeys\s*:\s*(\[[^\]]*\])/.exec(body);
    const runMatch = /\brun\s*:\s*(\(\)\s*=>[\s\S]*)$/.exec(body.slice(0, -1));

    if (!id || !title) continue;

    const run = runMatch ? runMatch[1].replace(/\s+/g, ' ').trim().replace(/,$/, '') : null;
    const navTarget = run ? [...run.matchAll(/go\('([^']+)'\)/g)].map((g) => g[1]) : [];
    const dispatches = run ? [...run.matchAll(/type:\s*'([^']+)'/g)].map((g) => g[1]) : [];

    actions.push({
      id: id.value,
      dynamic: Boolean(id.dynamic),
      group: group ? group.value : null,
      title: title.value,
      detail: detail ? detail.value : null,
      icon: icon ? icon.value : null,
      keys: keysMatch ? literalArray(keysMatch[1]) : null,
      navigatesTo: navTarget,
      dispatches,
      file: rel(abs),
      line: lineAt(m.index),
    });
  }
  return actions;
}

/* ========================================================================== */
/*  Extractor: keyboard shortcuts                                              */
/* ========================================================================== */

const KEY_ALIASES = {
  esc: 'escape',
  escape: 'escape',
  '↑': 'arrowup',
  '↓': 'arrowdown',
  '←': 'arrowleft',
  '→': 'arrowright',
  space: ' ',
  spacebar: ' ',
  '−': '-',
  '_': '-',
  '=': '+',
};

function normaliseKey(key) {
  const lower = String(key).toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

function chordOf(keys) {
  const mods = new Set();
  const plain = [];
  for (const key of keys) {
    const lower = String(key).toLowerCase();
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'meta') mods.add('ctrl');
    else if (lower === 'shift') mods.add('shift');
    else if (lower === 'alt' || lower === 'option') mods.add('alt');
    else plain.push(normaliseKey(key));
  }
  return { mods: [...mods].sort(), keys: plain };
}

function chordId(chord) {
  return [...chord.mods, ...chord.keys].join('+');
}

/**
 * The text of the innermost `{ ... }` block that encloses `index`, back to its
 * opening brace. Modifier guards are usually an early-return a few lines above
 * the key comparison (`if (!event.ctrlKey) return;`), so the block is the right
 * unit to read them from — the same line alone misses them, and a fixed line
 * window would steal a guard from a neighbouring handler.
 */
function enclosingBlock(src, mask, index, limit = 4000) {
  let depth = 0;
  const floor = Math.max(0, index - limit);
  for (let i = index; i >= floor; i -= 1) {
    if (mask[i]) continue;
    const c = src[i];
    if (c === '}') depth += 1;
    else if (c === '{') {
      if (depth === 0) return src.slice(i, index);
      depth -= 1;
    }
  }
  return src.slice(floor, index);
}

function extractKeyHandlers() {
  const files = walk(SRC, (f) => f.endsWith('.ts') || f.endsWith('.tsx')).filter(
    (f) => !rel(f).startsWith('src/bridge/'),
  );
  const handlers = [];

  for (const abs of files) {
    const relPath = rel(abs);
    const src = read(abs);
    const mask = maskFile(relPath, src);
    const lineAt = lineIndexer(src);

    // `event.key === 'X'` / `event.key !== 'X'`
    const cmpRe = /\b([A-Za-z_$][\w$]*)\.key\s*(===|!==)\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/g;
    let m;
    while ((m = cmpRe.exec(src)) !== null) {
      if (mask[m.index]) continue;
      const line = lineTextAt(src, m.index);
      const scope = enclosingBlock(src, mask, m.index) + line;
      // Modifier IDENTIFIERS seen in scope, not a decoded chord. `!chord ||
      // event.altKey` reads the same as `event.altKey &&` to a text scanner, so
      // this is reported as an observation and never used to reject a match.
      const mods = ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'].filter((ident) => scope.includes(ident));
      handlers.push({
        key: m[4],
        negated: m[2] === '!==',
        modifiers: mods,
        file: relPath,
        line: lineAt(m.index),
        form: 'comparison',
        context: line.trim().slice(0, 160),
      });
    }

    // `switch (event.key) { case 'X': ... }`
    const switchRe = /switch\s*\(\s*[A-Za-z_$][\w$]*\.key\s*\)\s*\{/g;
    while ((m = switchRe.exec(src)) !== null) {
      if (mask[m.index]) continue;
      const open = src.indexOf('{', m.index);
      const close = matchBrace(src, open);
      const body = src.slice(open, close + 1);
      const caseRe = /case\s+(['"])((?:\\.|(?!\1)[^\\])*)\1\s*:/g;
      let c;
      while ((c = caseRe.exec(body)) !== null) {
        handlers.push({
          key: c[2],
          negated: false,
          modifiers: [],
          file: relPath,
          line: lineAt(open + c.index),
          form: 'switch-case',
          context: lineTextAt(src, open + c.index).trim().slice(0, 160),
        });
      }
    }
  }

  handlers.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  // `if (event.key === 'k' || event.key === 'K')` is two handlers on one line and
  // one slug. Number the repeats so every capability id stays unique.
  const seen = new Map();
  for (const handler of handlers) {
    const key = `${handler.file}:${handler.line}:${slug(handler.key || 'key')}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    handler.ordinal = n;
  }
  return handlers;
}

function extractDocumentedShortcuts() {
  const files = walk(SRC, (f) => f.endsWith('.tsx'));
  const documented = [];

  for (const abs of files) {
    const relPath = rel(abs);
    const src = read(abs);
    const mask = maskFile(relPath, src);
    const lineAt = lineIndexer(src);

    // <KeyHint keys={['Ctrl', 'K']} />
    const re = /<KeyHint(?=[\s/>])/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (mask[m.index]) continue;
      const tag = readOpeningTag(src, m.index);
      if (!tag) continue;
      const attrs = parseAttributes(tag.inner);
      const keysAttr = attrs.keys;
      const keys = keysAttr ? literalArray(keysAttr.value) : null;
      documented.push({
        keys: keys && keys.length > 0 ? keys : null,
        expression: keys && keys.length > 0 ? null : keysAttr ? String(keysAttr.value) : null,
        action: null,
        origin: 'KeyHint',
        file: relPath,
        line: lineAt(m.index),
      });
    }

    // { keys: ['Ctrl', 'K'], action: 'Open the command palette' }
    const rowRe = /\{\s*keys:\s*(\[[^\]]*\]),\s*action:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2\s*\}/g;
    while ((m = rowRe.exec(src)) !== null) {
      if (mask[m.index]) continue;
      documented.push({
        keys: literalArray(m[1]),
        expression: null,
        action: m[3],
        origin: 'shortcut table',
        file: relPath,
        line: lineAt(m.index),
      });
    }
  }

  documented.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return documented;
}

/* ========================================================================== */
/*  Extractor: protocol (operations, events)                                   */
/* ========================================================================== */

function constArray(src, name) {
  const re = new RegExp(`export\\s+const\\s+${escapeRe(name)}\\s*=\\s*\\[`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('[', m.index);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(src, i) - 1;
      continue;
    }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;
  return { items: literalArray(src.slice(open, close + 1)) ?? [], index: m.index };
}

function extractProtocol() {
  const abs = path.join(SRC, 'shared', 'protocol.ts');
  if (!fs.existsSync(abs)) fail('src/shared/protocol.ts not found — cannot inventory the bridge contract.');
  const src = read(abs);
  const lineAt = lineIndexer(src);

  const ops = constArray(src, 'OPERATIONS');
  const events = constArray(src, 'EVENT_TYPES');
  if (!ops) fail('could not parse OPERATIONS from src/shared/protocol.ts');
  if (!events) fail('could not parse EVENT_TYPES from src/shared/protocol.ts');

  const lineOf = (needle) => {
    const at = src.indexOf(`'${needle}'`);
    return at === -1 ? lineAt(ops.index) : lineAt(at);
  };

  return {
    file: rel(abs),
    operations: ops.items.map((op) => ({ name: op, file: rel(abs), line: lineOf(op) })),
    events: events.items.map((type) => ({ name: type, file: rel(abs), line: lineOf(type) })),
  };
}

/** `this.register('getHealth', () => this.health())` across the bridge. */
function extractHandlerRegistrations() {
  const files = walk(path.join(SRC, 'bridge'), (f) => f.endsWith('.ts'));
  const found = new Map();

  for (const abs of files) {
    const relPath = rel(abs);
    const src = read(abs);
    const mask = maskFile(relPath, src);
    const lineAt = lineIndexer(src);
    const re = /\.register\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (mask[m.index]) continue;
      const line = lineTextAt(src, m.index);
      const impl = /=>\s*this\.([A-Za-z_$][\w$]*)/.exec(line);
      found.set(m[2], {
        file: relPath,
        line: lineAt(m.index),
        method: impl ? impl[1] : null,
        source: line.trim().slice(0, 160),
      });
    }
  }
  return found;
}

/**
 * Does the browser bundle reach the bridge at all? Measured rather than
 * asserted: gap 2 is a claim about this product, so it has to be re-established
 * on every run instead of being frozen into prose that quietly goes stale.
 */
function extractUiBridgeBinding() {
  const files = walk(SRC, (f) => /\.tsx?$/.test(f)).filter((f) => {
    const r = rel(f);
    return !r.startsWith('src/bridge/') && !r.startsWith('src/shared/');
  });

  const protocolImporters = [];
  const networkCalls = [];

  for (const abs of files) {
    const relPath = rel(abs);
    const src = read(abs);
    const mask = maskFile(relPath, src);
    const lineAt = lineIndexer(src);

    const importRe = /from\s+'(@\/shared\/protocol|@\/shared\/state-machines|[^']*\/bridge\/[^']*)'/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      protocolImporters.push({ file: relPath, line: lineAt(m.index), spec: m[1] });
    }

    const netRe = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(/g;
    while ((m = netRe.exec(src)) !== null) {
      if (mask[m.index]) continue;
      networkCalls.push({ file: relPath, line: lineAt(m.index), api: m[1] });
    }
  }

  protocolImporters.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  networkCalls.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { protocolImporters, networkCalls };
}

/* ========================================================================== */
/*  Extractor: state machines                                                  */
/* ========================================================================== */

function extractMachines() {
  const abs = path.join(SRC, 'shared', 'state-machines.ts');
  if (!fs.existsSync(abs)) fail('src/shared/state-machines.ts not found — cannot inventory states.');
  const src = read(abs);
  const lineAt = lineIndexer(src);
  const machines = [];

  const re = /defineMachine<[^>]*>\(\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    const close = matchBrace(src, open);
    const body = src.slice(open, close + 1);

    const strField = (key) => {
      const hit = new RegExp(`\\b${key}\\s*:\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(body);
      return hit ? hit[2] : null;
    };
    const arrField = (key) => {
      const at = new RegExp(`\\b${key}\\s*:\\s*\\[`).exec(body);
      if (!at) return [];
      const bracket = body.indexOf('[', at.index);
      let depth = 0;
      for (let i = bracket; i < body.length; i += 1) {
        const c = body[i];
        if (c === '"' || c === "'" || c === '`') {
          i = skipQuoted(body, i) - 1;
          continue;
        }
        if (c === '[') depth += 1;
        else if (c === ']') {
          depth -= 1;
          if (depth === 0) return literalArray(body.slice(bracket, i + 1)) ?? [];
        }
      }
      return [];
    };

    const id = strField('id');
    if (!id) continue;

    const transitions = {};
    const transAt = /\btransitions\s*:\s*\{/.exec(body);
    if (transAt) {
      const tOpen = body.indexOf('{', transAt.index);
      const tClose = matchBrace(body, tOpen);
      const tBody = body.slice(tOpen + 1, tClose);
      const rowRe = /([A-Z_][A-Z0-9_]*)\s*:\s*(\[[^\]]*\])/g;
      let row;
      while ((row = rowRe.exec(tBody)) !== null) {
        transitions[row[1]] = literalArray(row[2]) ?? [];
      }
    }

    machines.push({
      id,
      label: strField('label'),
      description: strField('description'),
      initial: strField('initial'),
      states: arrField('states'),
      terminal: arrField('terminal'),
      transitions,
      file: rel(abs),
      line: lineAt(m.index),
    });
  }

  machines.sort((a, b) => (a.id < b.id ? -1 : 1));
  return machines;
}

/* ========================================================================== */
/*  Test links                                                                 */
/* ========================================================================== */

const TEST_KINDS = { positive: 'positiveTest', negative: 'negativeTest', security: 'securityTest', chaos: 'chaosTest' };

function extractTestLinks() {
  const files = walk(TESTS, (f) => /\.(ts|tsx|mjs|cjs|js)$/.test(f));
  const links = new Map();

  for (const abs of files) {
    const relPath = rel(abs);
    const src = read(abs);
    const lineAt = lineIndexer(src);
    const re = /@capability\s+([^\s]+)\s+(positive|negative|security|chaos)\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const id = m[1];
      const field = TEST_KINDS[m[2]];
      if (!links.has(id)) links.set(id, {});
      links.get(id)[field] = `${relPath}:${lineAt(m.index)}`;
    }
  }
  return links;
}

/* ========================================================================== */
/*  Capability records                                                         */
/* ========================================================================== */

function slug(value) {
  return String(value)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

const READ_PREFIXES = ['get', 'list', 'inspect', 'read', 'export', 'replay'];
const APPROVAL_OPS = new Set(['runApprovedTest', 'approveAction', 'denyAction']);

function operationPermission(name) {
  if (APPROVAL_OPS.has(name)) return 'APPROVAL_GATED';
  if (READ_PREFIXES.some((p) => name.startsWith(p))) return 'READ_ONLY';
  return 'MUTATING';
}

function makeRecord(fields) {
  return {
    id: fields.id,
    category: fields.category,
    screen: fields.screen,
    control: fields.control,
    expectedBehaviour: fields.expectedBehaviour,
    implementation: fields.implementation,
    bridgeHandler: fields.bridgeHandler ?? null,
    permission: fields.permission,
    positiveTest: null,
    negativeTest: null,
    securityTest: null,
    chaosTest: null,
    status: fields.status,
    proof: fields.proof ?? null,
    accessibleName: fields.accessibleName ?? null,
    accessibleNameSource: fields.accessibleNameSource ?? null,
    notes: fields.notes ?? [],
  };
}

function build() {
  const routes = extractRoutes();
  const views = extractViews(routes);
  const controls = extractControls();
  const palette = extractPaletteActions();
  const keyHandlers = extractKeyHandlers();
  const documentedKeys = extractDocumentedShortcuts();
  const protocol = extractProtocol();
  const registrations = extractHandlerRegistrations();
  const machines = extractMachines();
  const binding = extractUiBridgeBinding();
  const testLinks = extractTestLinks();

  /* --- screen attribution -------------------------------------------- */

  const routeOfModule = new Map();
  for (const route of routes) {
    const mod = resolveAlias(route.module);
    if (mod) routeOfModule.set(mod, route.path);
  }
  const routesOfArea = new Map();
  for (const [mod, routePath] of routeOfModule) {
    const area = mod.split('/')[2];
    if (!routesOfArea.has(area)) routesOfArea.set(area, []);
    routesOfArea.get(area).push(routePath);
  }

  function screenOf(file) {
    if (routeOfModule.has(file)) return routeOfModule.get(file);
    if (file.startsWith('src/views/')) {
      const area = file.split('/')[2];
      const found = routesOfArea.get(area);
      return found ? found.slice().sort().join(' + ') : `views/${area}`;
    }
    if (file.startsWith('src/components/shell/')) return 'app shell (every route)';
    if (file.startsWith('src/components/primitives/')) return 'design system (primitive)';
    if (file.startsWith('src/prototype/')) return 'local store';
    if (file === 'src/App.tsx' || file === 'src/main.tsx') return 'app root';
    return file;
  }

  const records = [];

  /* --- routes --------------------------------------------------------- */

  for (const route of routes) {
    records.push(
      makeRecord({
        id: `route:${route.path}`,
        category: 'route',
        screen: route.path,
        control: 'HashRouter route',
        expectedBehaviour: route.redirect
          ? `Any unmatched hash redirects to ${route.redirectTo ?? '/'}`
          : route.component
            ? `Renders <${route.component} /> at #${route.path}`
            : 'TODO',
        implementation: `${route.file}:${route.line}`,
        permission: 'NAVIGATION',
        status: 'UNVERIFIED',
        accessibleName: route.component,
        accessibleNameSource: route.component ? 'element attribute' : null,
        notes: route.module ? [`module ${resolveAlias(route.module) ?? route.module}`] : [],
      }),
    );
  }

  /* --- view modules --------------------------------------------------- */

  for (const view of views) {
    records.push(
      makeRecord({
        id: `view:${view.file}`,
        category: 'view',
        screen: view.route ?? screenOf(view.file),
        control: 'view module',
        expectedBehaviour: view.route
          ? `Mounts <${view.component} /> as the content area of #${view.route}`
          : `Renders <${view.component} /> inside the ${view.area} views; not routed directly`,
        implementation: `${view.file}:${view.line}`,
        permission: 'NAVIGATION',
        status: 'UNVERIFIED',
        accessibleName: view.component,
        accessibleNameSource: 'default export',
        notes: [`${view.lines} lines`, ...(view.route ? [] : ['not reachable by URL on its own'])],
      }),
    );
  }

  /* --- interactive controls ------------------------------------------ */

  for (const control of controls) {
    const verb =
      control.tag === 'Switch'
        ? 'Toggle'
        : control.tag === 'Tabs'
          ? 'Select a tab in'
          : control.tag === 'SegmentedControl'
            ? 'Choose an option in'
            : control.tag === 'input' || control.tag === 'textarea'
              ? 'Enter a value in'
              : control.tag === 'select'
                ? 'Pick an option from'
                : control.tag === 'NavLink' || control.tag === 'Link'
                  ? 'Navigate via'
                  : 'Activate';

    const target = control.to ? ` (to ${control.to})` : '';
    records.push(
      makeRecord({
        id: `control:${slug(control.file)}-${control.line}-${slug(control.tag)}`,
        category: 'control',
        screen: screenOf(control.file),
        control: control.role ? `<${control.tag} role="${control.role}">` : `<${control.tag}>`,
        expectedBehaviour: control.name ? `${verb} "${control.name}"${target}` : 'TODO',
        implementation: `${control.file}:${control.line}`,
        // Nothing in the browser bundle imports the bridge protocol today, so a
        // control cannot be matched to a handler. Reported, never invented.
        bridgeHandler: null,
        permission: 'LOCAL_STATE',
        status: 'UNVERIFIED',
        accessibleName: control.name,
        accessibleNameSource: control.nameSource,
        notes: [
          ...control.notes,
          ...(control.handlerAttr ? [`${control.handlerAttr}=${control.handler}`] : ['no handler attribute in the JSX']),
        ],
      }),
    );
  }

  /* --- command-palette actions ---------------------------------------- */

  for (const action of palette) {
    const effect = [
      ...action.navigatesTo.map((t) => `navigates to ${t}`),
      ...action.dispatches.map((d) => `dispatches ${d}`),
    ];
    records.push(
      makeRecord({
        id: `palette:${action.dynamic ? slug(action.id.replace(/\$\{[^}]*\}/g, 'dynamic')) : action.id}`,
        category: 'palette-action',
        screen: 'command palette (every route)',
        control: `palette command · ${action.group ?? 'ungrouped'}`,
        expectedBehaviour: effect.length > 0 ? `"${action.title}" — ${effect.join(', ')}` : `"${action.title}"`,
        implementation: `${action.file}:${action.line}`,
        permission: action.navigatesTo.length > 0 && action.dispatches.length === 0 ? 'NAVIGATION' : 'LOCAL_STATE',
        status: 'UNVERIFIED',
        accessibleName: action.title,
        accessibleNameSource: 'title',
        notes: [
          ...(action.dynamic ? ['generated per record — one row here stands for N rendered commands'] : []),
          ...(action.detail ? [`detail: ${action.detail}`] : []),
          ...(action.keys ? [`shortcut ${action.keys.join('+')}`] : []),
        ],
      }),
    );
  }

  /* --- keyboard shortcuts --------------------------------------------- */

  for (const handler of keyHandlers) {
    records.push(
      makeRecord({
        id: `shortcut:handler:${slug(handler.file)}-${handler.line}-${slug(handler.key || 'key')}${
          handler.ordinal > 1 ? `-${handler.ordinal}` : ''
        }`,
        category: 'shortcut',
        screen: screenOf(handler.file),
        control: `key handler (${handler.form})`,
        expectedBehaviour: handler.negated
          ? `Ignores every key except "${handler.key}"`
          : `Responds to the "${handler.key}" key`,
        implementation: `${handler.file}:${handler.line}`,
        permission: 'LOCAL_STATE',
        status: 'UNVERIFIED',
        accessibleName: handler.key,
        accessibleNameSource: 'key literal',
        notes: [
          ...(handler.modifiers.length > 0
            ? [`modifier identifiers in scope: ${handler.modifiers.join(', ')} (observed, not decoded)`]
            : []),
          handler.context,
        ],
      }),
    );
  }

  /*
   * A documented chord with no handler anywhere is the interesting case. The
   * test is on the KEYS only: a text scanner cannot tell `event.altKey` in a
   * guard from `!event.altKey` in an early return, so requiring the modifiers to
   * agree would manufacture failures. Under-claiming here is deliberate — every
   * row that survives into the gap list is one where no handler anywhere in the
   * source names that key at all.
   */
  const handlerKeysOnly = new Set(
    keyHandlers.filter((handler) => !handler.negated).map((handler) => normaliseKey(handler.key)),
  );

  const documentedSeen = new Set();
  for (const doc of documentedKeys) {
    if (!doc.keys || doc.keys.length === 0) {
      records.push(
        makeRecord({
          id: `shortcut:hint:${slug(doc.file)}-${doc.line}`,
          category: 'shortcut',
          screen: screenOf(doc.file),
          control: 'KeyHint (dynamic)',
          expectedBehaviour: 'TODO',
          implementation: `${doc.file}:${doc.line}`,
          permission: 'DISPLAY_ONLY',
          status: 'UNVERIFIED',
          accessibleName: null,
          accessibleNameSource: null,
          notes: [`keys come from an expression: ${doc.expression ?? 'unknown'}`],
        }),
      );
      continue;
    }
    const chord = chordOf(doc.keys);
    const id = chordId(chord);
    const key = `${doc.file}:${doc.line}`;
    if (documentedSeen.has(key)) continue;
    documentedSeen.add(key);

    const missing = chord.keys.filter((key) => !handlerKeysOnly.has(key));
    const handled = chord.keys.length > 0 && missing.length === 0;
    const notes = [`origin: ${doc.origin}`, `keys checked: ${chord.keys.join(', ') || '(modifiers only)'}`];
    if (chord.mods.length > 0) notes.push(`modifiers advertised: ${chord.mods.join(', ')} — not verified`);
    if (!handled) notes.push(`NO KEY HANDLER IN THE SOURCE NAMES: ${missing.join(', ') || '(nothing to match)'}`);

    records.push(
      makeRecord({
        id: `shortcut:documented:${slug(doc.file)}-${doc.line}-${slug(id || doc.keys.join('-'))}`,
        category: 'shortcut',
        screen: screenOf(doc.file),
        control: doc.origin === 'shortcut table' ? 'documented shortcut' : 'KeyHint',
        expectedBehaviour: doc.action ? `${doc.keys.join(' + ')} — ${doc.action}` : `${doc.keys.join(' + ')}`,
        implementation: `${doc.file}:${doc.line}`,
        permission: 'DISPLAY_ONLY',
        status: handled ? 'UNVERIFIED' : 'NOT_IMPLEMENTED',
        accessibleName: doc.keys.join(' + '),
        accessibleNameSource: 'keys array',
        notes,
      }),
    );
  }

  /* --- bridge operations ---------------------------------------------- */

  for (const op of protocol.operations) {
    const reg = registrations.get(op.name) ?? null;
    records.push(
      makeRecord({
        id: `bridge:${op.name}`,
        category: 'bridge-operation',
        screen: 'bridge (no UI binding)',
        control: `operation ${op.name}`,
        expectedBehaviour: `Browser sends {op: "${op.name}"}; the bridge validates the payload and answers ok | error`,
        implementation: `${op.file}:${op.line}`,
        bridgeHandler: reg ? `${reg.file}:${reg.line}${reg.method ? ` (${reg.method})` : ''}` : null,
        permission: operationPermission(op.name),
        status: reg ? 'UNVERIFIED' : 'NOT_IMPLEMENTED',
        proof: reg ? `${reg.file}:${reg.line}` : null,
        accessibleName: op.name,
        accessibleNameSource: 'OPERATIONS',
        notes: reg
          ? ['handler registered in the router']
          : ['NO HANDLER REGISTERED — the router answers UNKNOWN_OPERATION for this verb'],
      }),
    );
  }

  /* --- event types ---------------------------------------------------- */

  for (const event of protocol.events) {
    records.push(
      makeRecord({
        id: `event:${event.name}`,
        category: 'event-type',
        screen: 'event stream',
        control: `event ${event.name}`,
        expectedBehaviour: `The bridge may emit a ForgeEvent of type "${event.name}" with a monotonic sequence`,
        implementation: `${event.file}:${event.line}`,
        permission: 'BRIDGE_EMITTED',
        status: 'UNVERIFIED',
        accessibleName: event.name,
        accessibleNameSource: 'EVENT_TYPES',
        notes: [],
      }),
    );
  }

  /* --- states and transitions ----------------------------------------- */

  for (const machine of machines) {
    for (const state of machine.states) {
      const outgoing = machine.transitions[state] ?? [];
      const terminal = machine.terminal.includes(state);
      records.push(
        makeRecord({
          id: `state:${machine.id}/${state}`,
          category: 'state',
          screen: `state machine · ${machine.label ?? machine.id}`,
          control: `${machine.id}.${state}`,
          expectedBehaviour: terminal
            ? `${state} is terminal in the ${machine.id} machine — nothing may leave it`
            : `${state} may advance to ${outgoing.length > 0 ? outgoing.join(', ') : '(nothing)'}`,
          implementation: `${machine.file}:${machine.line}`,
          permission: 'BRIDGE_INTERNAL',
          status: 'UNVERIFIED',
          accessibleName: state,
          accessibleNameSource: 'states array',
          notes: [
            ...(state === machine.initial ? ['initial state'] : []),
            ...(terminal ? ['terminal'] : []),
            `${outgoing.length} outgoing`,
          ],
        }),
      );
    }
    for (const [from, targets] of Object.entries(machine.transitions)) {
      for (const to of targets) {
        records.push(
          makeRecord({
            id: `transition:${machine.id}/${from}->${to}`,
            category: 'transition',
            screen: `state machine · ${machine.label ?? machine.id}`,
            control: `${machine.id}: ${from} -> ${to}`,
            expectedBehaviour: `${from} -> ${to} is legal in the ${machine.id} machine and must pass the evidence gate for ${to}`,
            implementation: `${machine.file}:${machine.line}`,
            permission: 'BRIDGE_INTERNAL',
            status: 'UNVERIFIED',
            accessibleName: `${from} -> ${to}`,
            accessibleNameSource: 'transitions table',
            notes: [],
          }),
        );
      }
    }
  }

  /* --- link tests ------------------------------------------------------ */

  let linked = 0;
  for (const record of records) {
    const link = testLinks.get(record.id);
    if (!link) continue;
    Object.assign(record, link);
    const any = record.positiveTest || record.negativeTest || record.securityTest || record.chaosTest;
    if (any && record.status === 'UNVERIFIED') record.status = 'VERIFIED';
    if (any) linked += 1;
  }

  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const duplicates = [];
  const seenIds = new Set();
  for (const record of records) {
    if (seenIds.has(record.id)) duplicates.push(record.id);
    seenIds.add(record.id);
  }

  return {
    records,
    linked,
    duplicates,
    warnings: [...new Set(MASK_WARNINGS)].sort(),
    raw: {
      routes,
      views,
      controls,
      palette,
      keyHandlers,
      documentedKeys,
      protocol,
      registrations,
      machines,
      binding,
    },
  };
}

/* ========================================================================== */
/*  Emit: JSON                                                                 */
/* ========================================================================== */

const CATEGORY_ORDER = [
  'route',
  'view',
  'control',
  'palette-action',
  'shortcut',
  'bridge-operation',
  'event-type',
  'state',
  'transition',
];

function countBy(records, key) {
  const out = new Map();
  for (const record of records) out.set(record[key], (out.get(record[key]) ?? 0) + 1);
  return out;
}

function buildJson(model) {
  const { records } = model;
  const byCategory = countBy(records, 'category');
  const untested = records.filter((r) => !r.positiveTest && !r.negativeTest && !r.securityTest && !r.chaosTest);
  const missingHandlers = records.filter((r) => r.category === 'bridge-operation' && r.bridgeHandler === null);
  const unnamed = records.filter((r) => r.category === 'control' && r.accessibleName === null);
  const unimplementedShortcuts = records.filter((r) => r.category === 'shortcut' && r.status === 'NOT_IMPLEMENTED');

  return {
    schemaVersion: 1,
    generator: 'scripts/build-capability-matrix.cjs',
    method: 'static parse of the source tree — no hand-written entries',
    testLinkConvention: '// @capability <id> positive|negative|security|chaos',
    totals: {
      capabilities: records.length,
      byCategory: Object.fromEntries(CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((c) => [c, byCategory.get(c)])),
      withAnyLinkedTest: records.length - untested.length,
      withNoLinkedTest: untested.length,
      bridgeOperationsWithoutHandler: missingHandlers.length,
      controlsWithoutAccessibleName: unnamed.length,
      documentedShortcutsWithoutHandler: unimplementedShortcuts.length,
    },
    parserWarnings: model.warnings,
    gaps: {
      noLinkedTest: untested.map((r) => r.id),
      bridgeOperationsWithoutHandler: missingHandlers.map((r) => r.id.replace(/^bridge:/, '')),
      controlsWithoutAccessibleName: unnamed.map((r) => r.implementation),
      documentedShortcutsWithoutHandler: unimplementedShortcuts.map((r) => r.accessibleName),
    },
    capabilities: records,
  };
}

/* ========================================================================== */
/*  Emit: Markdown                                                             */
/* ========================================================================== */

function esc(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(esc).join(' | ')} |`).join('\n');
  return rows.length === 0 ? `${head}\n${rule}\n| _none_ |${' |'.repeat(headers.length - 1)}` : `${head}\n${rule}\n${body}`;
}

const CATEGORY_BLURB = {
  route: 'Hash routes declared in `src/App.tsx`.',
  view: 'View modules under `src/views`.',
  control: 'Interactive controls found in JSX: `<button> <Button> <IconButton> <Switch> <Tabs> <SegmentedControl> <input> <textarea> <select> <NavLink> <Link>`.',
  'palette-action': 'Commands pushed onto the command-palette list.',
  shortcut: 'Key handlers in the source plus every documented chord (`KeyHint`, the settings shortcut table).',
  'bridge-operation': 'The `OPERATIONS` allowlist in `src/shared/protocol.ts`.',
  'event-type': 'The `EVENT_TYPES` union in `src/shared/protocol.ts`.',
  state: 'Every state of every machine in `src/shared/state-machines.ts`.',
  transition: 'Every legal transition in those machines.',
};

function buildMarkdown(model, json) {
  const { records, raw } = model;
  const totals = json.totals;
  const untested = records.filter((r) => !r.positiveTest && !r.negativeTest && !r.securityTest && !r.chaosTest);
  const missingHandlers = records.filter((r) => r.category === 'bridge-operation' && r.bridgeHandler === null);
  const haveHandlers = records.filter((r) => r.category === 'bridge-operation' && r.bridgeHandler !== null);
  const unnamed = records.filter((r) => r.category === 'control' && r.accessibleName === null);
  const deadShortcuts = records.filter((r) => r.category === 'shortcut' && r.status === 'NOT_IMPLEMENTED');
  const byCategory = countBy(records, 'category');
  const byScreen = countBy(
    records.filter((r) => r.category === 'control'),
    'screen',
  );

  const out = [];
  const push = (...lines) => out.push(...lines);

  push(
    '# Capability matrix',
    '',
    '> Generated by `scripts/build-capability-matrix.cjs`. **Do not edit by hand** — every row is parsed out of the',
    '> source tree, so the file is regenerated, not maintained. Run `node scripts/build-capability-matrix.cjs`',
    '> after any change to routes, views, controls, the palette, the protocol or the state machines.',
    '> `--check` fails when the committed copy is stale.',
    '',
    `Machine-readable twin: [\`capability/matrix.json\`](../capability/matrix.json) — ${records.length} records.`,
    '',
  );

  /* ---- the banner ---------------------------------------------------- */

  push(
    '## The number that matters',
    '',
    '```',
    `capabilities inventoried .................. ${String(totals.capabilities).padStart(5)}`,
    `with at least one linked test ............. ${String(totals.withAnyLinkedTest).padStart(5)}`,
    `WITH NO LINKED TEST ....................... ${String(totals.withNoLinkedTest).padStart(5)}  <-- the gap`,
    `bridge operations with NO handler ......... ${String(totals.bridgeOperationsWithoutHandler).padStart(5)}  <-- the gap`,
    `controls with no readable accessible name . ${String(totals.controlsWithoutAccessibleName).padStart(5)}`,
    `documented shortcuts with no handler ...... ${String(totals.documentedShortcutsWithoutHandler).padStart(5)}`,
    '```',
    '',
    `Test coverage of the inventory: **${((totals.withAnyLinkedTest / Math.max(1, totals.capabilities)) * 100).toFixed(1)}%**.`,
    '',
    '"No linked test" means no test in `tests/` carries a `@capability <id>` comment for that row. It is a statement',
    'about the link, not about the test suite: the suite may well exercise the behaviour without saying which',
    'capability it covers. Until it says so, this inventory refuses to claim coverage on its behalf.',
    '',
  );

  /* ---- totals per category ------------------------------------------- */

  push(
    '## Totals per category',
    '',
    table(
      ['Category', 'Count', 'No linked test', 'Parsed from'],
      CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => [
        category,
        byCategory.get(category),
        untested.filter((r) => r.category === category).length,
        CATEGORY_BLURB[category],
      ]),
    ),
    '',
  );

  /* ---- routes and views ---------------------------------------------- */

  push(
    '## Routes',
    '',
    table(
      ['Route', 'Renders', 'Module', 'Declared at'],
      raw.routes.map((route) => [
        `\`${route.path}\``,
        route.redirect ? `redirect -> ${route.redirectTo ?? '/'}` : `<${route.component} />`,
        resolveAlias(route.module) ?? '—',
        `${route.file}:${route.line}`,
      ]),
    ),
    '',
    '## View modules',
    '',
    table(
      ['Module', 'Component', 'Route', 'Lines', 'Controls'],
      raw.views.map((view) => [
        view.file,
        `<${view.component} />`,
        view.route ? `\`${view.route}\`` : '_not routed_',
        view.lines,
        raw.controls.filter((c) => c.file === view.file).length,
      ]),
    ),
    '',
  );

  /* ---- controls ------------------------------------------------------ */

  const controlsByTag = countBy(
    raw.controls.map((c) => ({ tag: c.tag })),
    'tag',
  );

  push(
    '## Interactive controls',
    '',
    `${raw.controls.length} control sites across ${new Set(raw.controls.map((c) => c.file)).size} files.`,
    'One row per JSX site: a control rendered inside a loop counts once here, where it is written.',
    '',
    table(
      ['Element', 'Sites'],
      [...controlsByTag.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => [`\`<${tag}>\``, count]),
    ),
    '',
    '### Controls by screen',
    '',
    table(
      ['Screen', 'Controls'],
      [...byScreen.entries()].sort((a, b) => b[1] - a[1]).map(([screen, count]) => [screen, count]),
    ),
    '',
  );

  /* ---- palette, shortcuts, protocol ---------------------------------- */

  push(
    '## Command palette',
    '',
    table(
      ['Group', 'Command', 'Effect', 'Site'],
      raw.palette.map((action) => [
        action.group ?? '—',
        action.title,
        [...action.navigatesTo.map((t) => `-> ${t}`), ...action.dispatches.map((d) => `dispatch ${d}`)].join(', ') ||
          '—',
        `${action.file}:${action.line}`,
      ]),
    ),
    '',
    '## Bridge operations',
    '',
    `${raw.protocol.operations.length} verbs in the \`OPERATIONS\` allowlist. ${haveHandlers.length} have a registered handler.`,
    '',
    table(
      ['Operation', 'Permission', 'Handler'],
      records
        .filter((r) => r.category === 'bridge-operation')
        .map((r) => [
          `\`${r.accessibleName}\``,
          r.permission,
          r.bridgeHandler ? `\`${r.bridgeHandler}\`` : '**NONE**',
        ]),
    ),
    '',
    '## Event types',
    '',
    `${raw.protocol.events.length} event types. Grouped by prefix:`,
    '',
    table(
      ['Prefix', 'Count', 'Types'],
      [
        ...[...countBy(raw.protocol.events.map((e) => ({ p: e.name.split('.')[0] })), 'p').entries()].sort((a, b) =>
          a[0] < b[0] ? -1 : 1,
        ),
      ].map(([prefix, count]) => [
        `\`${prefix}.*\``,
        count,
        raw.protocol.events
          .filter((e) => e.name.startsWith(`${prefix}.`))
          .map((e) => e.name.slice(prefix.length + 1))
          .join(', '),
      ]),
    ),
    '',
    '## State machines',
    '',
    table(
      ['Machine', 'States', 'Transitions', 'Initial', 'Terminal'],
      raw.machines.map((machine) => [
        `\`${machine.id}\``,
        machine.states.length,
        Object.values(machine.transitions).reduce((sum, list) => sum + list.length, 0),
        machine.initial,
        machine.terminal.length > 0 ? machine.terminal.join(', ') : '_none_',
      ]),
    ),
    '',
  );

  /* ================= THE POINT OF THE EXERCISE ======================== */

  push(
    '---',
    '',
    '# COVERAGE GAP',
    '',
    'Everything below is a capability this workspace can perform, or claims it can perform, that nothing proves.',
    'This section is the reason the file exists. It is not a backlog suggestion; it is the list of statements the',
    'product currently makes without evidence.',
    '',
  );

  /* ---- gap 1: bridge operations with no handler ---------------------- */

  push(`## Gap 1 — bridge operations with NO handler (${missingHandlers.length} of ${raw.protocol.operations.length})`, '');

  if (missingHandlers.length === 0) {
    push(
      '**Closed.** Every verb in the `OPERATIONS` allowlist has a handler registered against it, so none of them',
      'answers `UNKNOWN_OPERATION`. This says the wiring exists; it says nothing about whether any handler is',
      'correct — that is gap 5, and all',
      `${untested.filter((r) => r.category === 'bridge-operation').length} of them are still in it.`,
      '',
      table(
        ['Operation', 'Permission', 'Handler'],
        haveHandlers.map((r) => [`\`${r.accessibleName}\``, r.permission, `\`${r.bridgeHandler}\``]),
      ),
      '',
    );
  } else {
    push(
      'These verbs are in the contract, so the browser is entitled to send them and the type system says they exist.',
      'No handler is registered against them, so `BridgeRouter.dispatch` answers `UNKNOWN_OPERATION`. Each one is a',
      'capability the protocol advertises and the bridge cannot perform.',
      '',
      table(
        ['Operation', 'Permission', 'Declared at'],
        missingHandlers.map((r) => [`\`${r.accessibleName}\``, r.permission, r.implementation]),
      ),
      '',
      haveHandlers.length > 0
        ? `Registered today: ${haveHandlers.map((r) => `\`${r.accessibleName}\``).join(', ')}.`
        : 'No operation has a handler at all.',
      '',
    );
  }

  /* ---- gap 2: UI never reaches the bridge ---------------------------- */

  const controlCount = byCategory.get('control') ?? 0;
  const { protocolImporters, networkCalls } = raw.binding;
  const wired = protocolImporters.length > 0 || networkCalls.length > 0;

  push(
    `## Gap 2 — UI controls bound to a bridge operation (0 of ${controlCount})`,
    '',
    'Re-measured on every run, because this is the gap most likely to close without anyone updating a document.',
    'Two things are counted across every `.ts`/`.tsx` outside `src/bridge/` and `src/shared/`: imports that reach',
    'the bridge or the protocol, and calls to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or',
    '`sendBeacon`.',
    '',
    table(
      ['Signal', 'Found'],
      [
        ['imports of `@/shared/protocol`, `@/shared/state-machines` or `src/bridge/**`', protocolImporters.length],
        ['network APIs called in the browser bundle', networkCalls.length],
      ],
    ),
    '',
  );

  if (!wired) {
    push(
      `Both are zero, so every one of the ${controlCount} controls ends at the local prototype store. The`,
      '`bridgeHandler` field is `null` on all of them because that is the truth, not because the parser could not',
      'work it out. Until a control can be traced to an operation, no screen in this product can be said to do what',
      'it appears to do.',
      '',
    );
  } else {
    push(
      'Something now reaches the bridge from the browser side. These sites are where a control could begin to be',
      'traced to an operation — and where this generator will need a call-graph step it does not yet have, so treat',
      'the `bridgeHandler` nulls below as "not yet established" rather than "not wired".',
      '',
      table(
        ['Kind', 'Detail', 'Site'],
        [
          ...protocolImporters.map((i) => ['import', `\`${i.spec}\``, `${i.file}:${i.line}`]),
          ...networkCalls.map((c) => ['network', `\`${c.api}(…)\``, `${c.file}:${c.line}`]),
        ],
      ),
      '',
    );
  }

  /* ---- gap 3: documented shortcuts with no handler ------------------- */

  push(
    `## Gap 3 — documented shortcuts with no key handler (${deadShortcuts.length})`,
    '',
    'These chords are printed on screen — in the settings shortcut table or as a `KeyHint` — and **no key handler',
    'anywhere in `src` names their key at all**. The check is deliberately generous: modifiers are ignored, because a',
    'text scanner cannot tell `event.altKey` in a guard from `!event.altKey` in an early return. A row survives here',
    'only when the bare key (`i`, `j`, `,`, `g`, …) appears in no `event.key ===` comparison and no `switch (event.key)`',
    'case in the whole tree. Each one is a keystroke the product advertises to a user and does not listen for.',
    '',
    table(
      ['Chord', 'Advertised as', 'Keys with no handler', 'Printed at'],
      deadShortcuts.map((r) => [
        `\`${r.accessibleName}\``,
        r.expectedBehaviour,
        (r.notes.find((n) => n.startsWith('NO KEY HANDLER')) ?? '').replace('NO KEY HANDLER IN THE SOURCE NAMES: ', ''),
        r.implementation,
      ]),
    ),
    '',
  );

  /* ---- gap 4: controls with no accessible name ----------------------- */

  push(
    `## Gap 4 — controls with no accessible name readable from the JSX (${unnamed.length})`,
    '',
    'The name may still exist at runtime (a variable, a child component, an `aria-labelledby`). The parser reads',
    'literals only and refuses to guess. Each row is a control whose name a reviewer has to establish by hand.',
    '',
    table(
      ['Control', 'Screen', 'Name resolves from', 'Site'],
      unnamed.map((r) => [
        `\`${r.control}\``,
        r.screen,
        r.notes.find((n) => n.startsWith('name comes from ') || n.startsWith('children: ')) ?? 'nothing found',
        r.implementation,
      ]),
    ),
    '',
  );

  /* ---- gap 5: everything with no linked test ------------------------- */

  push(
    `## Gap 5 — capabilities with NO linked test (${untested.length} of ${records.length})`,
    '',
    'Link a test by putting a comment in it:',
    '',
    '```ts',
    '// @capability bridge:sendMessage positive',
    '// @capability bridge:sendMessage negative',
    '```',
    '',
    'The four kinds are `positive`, `negative`, `security`, `chaos`. Re-run the generator and the row moves out of',
    'this list. Grouped by category so the list can be worked through:',
    '',
  );

  for (const category of CATEGORY_ORDER) {
    const rows = untested.filter((r) => r.category === category);
    if (rows.length === 0) continue;
    push(
      `### ${category} — ${rows.length} with no linked test`,
      '',
      table(
        ['id', 'Screen', 'Expected behaviour', 'Implementation'],
        rows.map((r) => [`\`${r.id}\``, r.screen, r.expectedBehaviour, r.implementation]),
      ),
      '',
    );
  }

  /* ---- method and limits --------------------------------------------- */

  push(
    '---',
    '',
    '## How this file is produced',
    '',
    table(
      ['Category', 'Source read'],
      [
        ['route', '`src/App.tsx` — every `<Route path element>`'],
        ['view', 'every module under `src/views`'],
        ['control', 'every `.tsx` under `src`, JSX tag scan'],
        ['palette-action', '`src/components/shell/CommandPalette.tsx` — every `list.push({...})`'],
        ['shortcut', '`event.key === / !==`, `switch (event.key)`, `<KeyHint keys>`, the settings shortcut table'],
        ['bridge-operation', '`OPERATIONS` in `src/shared/protocol.ts`, matched against `.register(...)` in `src/bridge`'],
        ['event-type', '`EVENT_TYPES` in `src/shared/protocol.ts`'],
        ['state / transition', '`defineMachine(...)` in `src/shared/state-machines.ts`'],
        ['test links', '`@capability <id> <kind>` comments anywhere under `tests/`'],
      ],
    ),
    '',
    '## What the parser cannot do',
    '',
    '- It reads text, not a type-checked AST. A control rendered by a loop is one row at its JSX site, not one row',
    '  per rendered instance; the same is true of the per-project palette commands.',
    '- An accessible name is read only when it is a literal in the JSX (`aria-label`, `label`, `ariaLabel`, `title`,',
    '  `placeholder`, `alt`, or literal children). A name that arrives through a variable is reported as unreadable.',
    '- Keyboard modifiers are observed, not decoded. The generator records which of `ctrlKey`, `metaKey`, `shiftKey`,',
    '  `altKey` appear in the block enclosing a key comparison, and stops there: `if (!chord || event.altKey) return`',
    '  and `if (event.altKey)` are the same text and opposite meanings. A documented chord is therefore matched on its',
    '  bare keys alone, so gap 3 under-claims rather than over-claims.',
    '- Comments and string literals are masked before scanning, so a `<button>` written in prose is not counted. The',
    '  masker treats an unpaired quote as an apostrophe, which is correct for JSX text and wrong for a string that',
    '  spans a line break — a shape this codebase does not use.',
    '',
    '### Self-check',
    '',
    'The generator measures how much of each file its own masker swallowed and flags anything that looks like it',
    'lost its place, because a scanner that quietly stops counting is worse than no scanner. Warnings from the last',
    'run:',
    '',
    model.warnings.length === 0
      ? '- none. Every scanned file ended in a sane state.'
      : model.warnings.map((warning) => `- \`${warning}\``).join('\n'),
    '',
  );

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/* ========================================================================== */
/*  Main                                                                       */
/* ========================================================================== */

function writeIfNeeded(file, content) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === content) return 'unchanged';
  if (CHECK) return 'stale';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return existing === null ? 'created' : 'updated';
}

function main() {
  const model = build();
  if (model.duplicates.length > 0) {
    fail(`duplicate capability ids: ${[...new Set(model.duplicates)].join(', ')}`);
  }

  const json = buildJson(model);
  const jsonText = `${JSON.stringify(json, null, 2)}\n`;
  const mdText = buildMarkdown(model, json);

  const jsonState = writeIfNeeded(JSON_OUT, jsonText);
  const mdState = writeIfNeeded(MD_OUT, mdText);

  if (CHECK && (jsonState === 'stale' || mdState === 'stale')) {
    fail('the committed capability matrix is stale. Run: node scripts/build-capability-matrix.cjs');
  }

  const t = json.totals;
  const lines = [
    `build-capability-matrix: ${rel(JSON_OUT)} ${jsonState} - ${t.capabilities} capabilities`,
    `build-capability-matrix: ${rel(MD_OUT)} ${mdState}`,
    ...CATEGORY_ORDER.filter((c) => t.byCategory[c] !== undefined).map(
      (c) => `  ${c.padEnd(18)} ${String(t.byCategory[c]).padStart(4)}`,
    ),
    `  ${'-'.repeat(23)}`,
    `  ${'no linked test'.padEnd(18)} ${String(t.withNoLinkedTest).padStart(4)}`,
    `  ${'no bridge handler'.padEnd(18)} ${String(t.bridgeOperationsWithoutHandler).padStart(4)}`,
    `  ${'unnamed controls'.padEnd(18)} ${String(t.controlsWithoutAccessibleName).padStart(4)}`,
    `  ${'dead shortcuts'.padEnd(18)} ${String(t.documentedShortcutsWithoutHandler).padStart(4)}`,
    ...(model.warnings.length > 0
      ? ['', 'parser warnings (the scanner may have lost its place):', ...model.warnings.map((w) => `  ! ${w}`)]
      : []),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
