#!/usr/bin/env node
'use strict';
/**
 * forge-config-cli.cjs — the command-line layer of forge-config.cjs (v2.7.0, 2026-09-24): argv parsing,
 * command dispatch, --json / --ascii output and exit codes. WHY a separate file: forge-config.cjs is the
 * library (resolve/get/list/set/unset/reset/explain/diff) and stays a readable size; this file only turns
 * argv into one library call and one printed answer. The normal entry point is still
 *   node .claude/forge-bin/forge-config.cjs <list|get|set|unset|reset|explain|diff|parse> ... (--help on each)
 * which hands over to main() here; running this file directly does exactly the same. `set <key> off --once
 * "<owner's words>"` is the one-off approval (gate-hook only, 10 minutes); --once on any other command exits 2.
 * Exit codes: 0 ok · 1 not found (get/explain on an unknown key) · 2 usage / validation / malformed file
 * (nothing written) · 3 act on this (diff found changes · reset without --yes · a locked id refused · parse
 * ambiguous or unmatched). Zero-dependency.
 */
const cfg = require('./forge-config.cjs');
const text = require('./forge-config-text.cjs');

const BOOL_OPTS = { '--json': 'json', '--all': 'all', '--ascii': 'ascii', '--global': 'global', '--yes': 'yes', '--mark-seen': 'markSeen', '--help': 'help', '-h': 'help' };
const VALUE_OPTS = { '--lang': 'lang', '--run': 'run', '--once': 'once' };

function parseArgv(argv) {
  const o = { cmd: argv[0] || null, json: false, all: false, ascii: false, global: false, yes: false, markSeen: false, help: false, lang: null, run: null, once: null, flags: [], pos: [], bad: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    if (BOOL_OPTS[name] && inline === undefined) o[BOOL_OPTS[name]] = true;
    else if (VALUE_OPTS[name] || name === '--flag') {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined && name === '--once') o.once = ''; // a bare --once: set() answers "needs the owner's words" (exit 2)
      else if (v === undefined) o.bad = o.bad || name;
      else if (name === '--flag') o.flags.push(v);
      else o[VALUE_OPTS[name]] = v;
    } else if (a.startsWith('--')) o.bad = o.bad || a;
    else o.pos.push(a);
  }
  return o;
}

function nonUtf8Locale() {
  if (process.platform === 'win32') return false; // Node writes UTF-16 to a Windows console; pass --ascii for old code pages
  const loc = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '';
  return loc !== '' && !/utf-?8/i.test(loc);
}

function runCommand(a, base, T) {
  const need = (n, what) => { if (a.pos.length < n) throw new cfg.ConfigError('usage', T.missingArg(a.cmd, what), 2); };
  const withFlags = Object.assign({}, base, a.flags.length ? { flags: a.flags } : {});
  if (a.once != null && a.cmd !== 'set') throw new cfg.ConfigError('usage', T.onceOnlySet, 2);
  switch (a.cmd) {
    case 'list': {
      const L = cfg.list(Object.assign({ all: a.all }, withFlags));
      return { code: 0, json: L, text: text.renderList(L, { width: process.stdout.columns }) };
    }
    case 'get': {
      need(1, T.argKey);
      try {
        const e = cfg.get(a.pos[0], withFlags);
        return { code: 0, json: e, text: text.renderGet(e, e.lang) };
      } catch (err) {
        // CFG-06 (Codex recheck 2026-09-24): only turn a 'locked' error into a success when the REQUESTED
        // key itself is the locked one. cfg.get() also throws 'locked' when a --flag names a DIFFERENT
        // locked id (resolve() validates every flag) — that must still propagate as a real exit-3 error,
        // matching the core's behavior, not a misleading exit-0 "explanation" of the key that was asked for.
        if (err.code === 'locked' && err.key === a.pos[0]) return { code: 0, json: { key: a.pos[0], locked: true, message: err.message }, text: err.message };
        throw err;
      }
    }
    case 'set': {
      need(1, T.argKey);
      if (a.pos.length < 2) {
        // A locked id (exit 3) or an unknown key (exit 2) is refused even without a value; set() validates the
        // key and the value before it touches any file, so this probe can never write.
        try { cfg.set(a.pos[0], undefined, base); } catch (err) { if (err.code === 'locked' || err.code === 'unknown_key') throw err; }
        need(2, T.argValue);
      }
      const R = cfg.set(a.pos[0], a.pos.slice(1).join(' '), Object.assign({ global: a.global }, a.once != null ? { once: a.once } : {}, base));
      return { code: 0, json: R, text: text.renderSet(R, R.lang) };
    }
    case 'unset': {
      need(1, T.argKey);
      const R = cfg.unset(a.pos[0], Object.assign({ global: a.global }, base));
      return { code: 0, json: R, text: text.renderUnset(R, R.lang) };
    }
    case 'reset': {
      const R = cfg.reset(Object.assign({ global: a.global, yes: a.yes }, base));
      return { code: R.confirmed ? 0 : 3, json: R, text: text.renderReset(R, R.lang) };
    }
    case 'explain': {
      need(1, T.argKey);
      const E = cfg.explain(a.pos[0], withFlags);
      return { code: 0, json: E, text: text.renderExplain(E, E.lang) };
    }
    case 'diff': {
      const D = cfg.diff(Object.assign({ markSeen: a.markSeen, run: a.run || undefined }, withFlags));
      return { code: !D.first_run && D.changed.length ? 3 : 0, json: D, text: text.renderDiff(D, D.lang) };
    }
    case 'parse': {
      need(1, T.argSentence);
      const R = cfg.parseSentence(a.pos.join(' '), base);
      return { code: R.ok ? 0 : 3, json: R, text: R.message };
    }
    default: throw new cfg.ConfigError('usage', T.unknownCmd(a.cmd), 2);
  }
}

/** main(argv) -> exit code. Prints the answer on stdout (JSON with --json) and plain-language errors on stderr. */
function main(argv) {
  const a = parseArgv(argv);
  const lang = cfg.normLang(a.lang) || cfg.detectLang({});
  const T = text.t(lang);
  const fold = a.ascii || process.env.FORGE_CONFIG_ASCII === '1' || nonUtf8Locale() ? text.toAscii : (s) => s;
  const out = (s) => process.stdout.write(fold(s) + '\n');
  const err = (s) => process.stderr.write(fold(s) + '\n');
  if (!a.cmd || a.cmd === 'help' || a.cmd === '--help' || a.cmd === '-h') {
    (a.cmd ? out : err)(text.renderHelp(lang));
    return a.cmd ? 0 : 2;
  }
  if (a.help) { out(text.renderHelp(lang, a.cmd)); return 0; }
  try {
    if (a.lang != null && !cfg.normLang(a.lang)) throw new cfg.ConfigError('usage', T.badLang(a.lang), 2);
    if (a.bad) throw new cfg.ConfigError('usage', T.unknownOption(a.bad), 2);
    const r = runCommand(a, a.lang ? { lang: a.lang } : {}, T);
    out(a.json ? JSON.stringify(r.json, null, 2) : r.text);
    return r.code;
  } catch (e) {
    const isCfg = e instanceof cfg.ConfigError;
    const msg = isCfg ? e.message : 'forge-config: ' + e.message;
    if (a.json) out(JSON.stringify({ ok: false, error: { code: e.code || 'error', message: msg, suggestion: e.suggestion || null } }, null, 2));
    err(msg);
    return isCfg ? e.exitCode : 2;
  }
}

// sec-v3r M2 (independent re-review, forge-gate-selfdisable.cjs): BOOL_OPTS/VALUE_OPTS exported (read-only
// reuse, additive — nothing about parseArgv's own behaviour changes) so forge-gate-selfdisable.cjs can walk
// argv the SAME way parseArgv does, but keep the ORIGINAL TOKEN OBJECTS for whichever entries land in `pos`
// (parseArgv's own argv contract only ever returns flattened strings, which throws away exactly the raw
// quoting/shape information a literal-vs-dynamic check needs). One shared table, never a second hand-rolled
// copy that could quietly drift out of sync with this one.
module.exports = { main, parseArgv, BOOL_OPTS, VALUE_OPTS };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
