#!/usr/bin/env node
'use strict';
/**
 * forge-gate-hook.cjs — PreToolUse hook (matcher `Bash|PowerShell`): the three COMMAND hard gates become a real
 * stop (v2.7.0, WP16, run forge-2026-09-24-config-v250). Written rules are advice; a hook runs BEFORE the tool
 * call and exit 2 blocks it and feeds stderr back to Claude. ON by default for beginners (config key `gate-hook`,
 * FORGE_CONFIG_SCHEMA.json) after the beginner sweep (rows A4/B10). Doctrine + honest limits:
 * config/orchestration/HOOKS_OPT_IN.md section 6.
 *
 * BLOCKS the match.kind "command" gates of hard-gates.json via the single classifier forge-actiongate.cjs:
 * destructive-delete, kill-by-name, git-destructive — plus the hook's own `gate-hook-self-disable` (security
 * wp9b M3): a Bash/PowerShell forge-config call that sets gate-hook off, unsets it or resets. The ONE allowed
 * off-switch is the owner-approved one-off `node .claude/forge-bin/forge-config.cjs set gate-hook off --once
 * "<owner's words>"` (review wp9a M4; the 10-minute expiry lives in forge-config.cjs). Text gates and
 * write-outside-root are NOT enforced here (legitimate flows; no reliable target path in a command line).
 *
 * EXIT CODES (security wp9b M2): 2 = blocked · 1 = non-blocking but VISIBLE (hook internal error, oversized or
 * hanging stdin, gate-hook OFF while a gate would have fired, classifier unavailable and the fallback regex
 * silent) · 0 = allowed. When hard-gates.json / the classifier cannot load, FALLBACK_RE blocks the obviously
 * destructive verbs (fail-CLOSED). Inert data is stripped first (forge-gate-data.cjs; absent -> nothing is
 * stripped); a delete whose every segment is a provable scratch delete passes (scratchPassThrough, fail-closed).
 * Never writes stdout or disk; zero dependencies. PowerShell is matched because the tool ledger shows real
 * PowerShell tool calls (same `command` field) and kill-by-name's forbidden forms are PowerShell-native.
 *
 * MODEL: gateHookEnabled · selfDisable · scratchPassThrough · decide(payload, opts) -> {block, warn, gates,
 * reason, notice, why} · run(rawStdin, opts) -> {exitCode, stderr, why}. CLI: stdin -> run() -> stderr + exit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let DATA = null;
try { DATA = require('./forge-gate-data.cjs'); } catch { DATA = null; } // absent -> nothing is stripped (stricter)

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FAILSAFE_MS = 3000;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAX_NOTICE_CHARS = 300;
const FALLBACK_RE = /\b(rm|Remove-Item|rd|rmdir|del|taskkill|Stop-Process|pkill|killall)\b|\bgit\b[^\n]*\b(reset|clean|checkout|restore|switch|stash)\b/i;
const CONFIG_CMD_RE = /forge[-\s]?config/i;
const SELF_DISABLE_RE = /\bset\s+["']?gate-hook["']?\s+["']?(?:off|uit|false|no|nee|0|disabled|disable|uitzetten|uitschakelen|deactiveren)["']?(?=\s|$)|\bunset\s+["']?gate-hook\b/i; // `reset` restores the default (ON) -> allowed (wp21 follow-up)
const ONCE_SHAPE_RE = /^\s*node\s+(?:\.\/)?\.claude[\\/]forge-bin[\\/]forge-config\.cjs\s+set\s+gate-hook\s+off\s+--once\s+(?:"[^"$`\\\n]+"|'[^'\n]+')\s*$/;
const ONCE_HINT = 'node .claude/forge-bin/forge-config.cjs set gate-hook off --once "<the owner\'s words>"';

/** Plain-language wording per gate — what the command does, and the safe variant to offer. */
const WORDS = {
  'destructive-delete': {
    nl: 'dit commando verwijdert een hele map in één keer, zonder prullenbak',
    en: 'this command deletes a whole folder tree at once, with no recycle bin',
    safeNl: 'noem het exacte pad en controleer het eerst, verwijder losse bestanden, of ruim alleen op binnen _scratch/, node_modules/, dist/ of de tijdelijke map (dat mag zonder vragen)',
    safeEn: 'name the exact path and check it first, delete single files, or clean up only inside _scratch/, node_modules/, dist/ or the temp folder (allowed without asking)',
  },
  'kill-by-name': {
    nl: 'dit commando stopt ALLE processen met die naam, ook andere draaiende diensten',
    en: 'this command kills EVERY process with that name, including unrelated running services',
    safeNl: 'stop alleen het exacte PID dat je zelf gestart hebt (taskkill /PID <pid>, Stop-Process -Id <pid>)',
    safeEn: 'kill only the exact PID you started yourself (taskkill /PID <pid>, Stop-Process -Id <pid>)',
  },
  'git-destructive': {
    nl: 'dit commando gooit onvastgelegd werk weg',
    en: 'this command discards uncommitted work',
    safeNl: 'commit of stash eerst (git stash push), dan is het terug te halen',
    safeEn: 'commit or stash first (git stash push), so it can be recovered',
  },
  'gate-hook-self-disable': {
    nl: 'dit commando zet de Forge-poort zelf uit',
    en: 'this command switches the Forge gate itself off',
    safeNl: 'alleen de eigenaar zet de poort uit; met een uitdrukkelijke ja van de eigenaar mag eenmalig (10 minuten): ' + ONCE_HINT,
    safeEn: 'only the owner switches the gate off; with the owner\'s explicit yes a one-off (10 minutes) is allowed: ' + ONCE_HINT,
  },
  'classifier-unavailable': {
    nl: 'de poort-classifier kon niet laden en dit commando lijkt destructief',
    en: 'the gate classifier could not load and this command looks destructive',
    safeNl: 'herstel .claude/config/orchestration/hard-gates.json of forge-actiongate.cjs (draai de doctor)',
    safeEn: 'restore .claude/config/orchestration/hard-gates.json or forge-actiongate.cjs (run the doctor)',
  },
};

/** gateHookEnabled(opts) -> { on, source, set_at, set_by, expires_at, quote }. opts.config injects a forge-config
 *  module (tests); null = "module absent". Never throws; an absent/unreadable config means the default ON.
 *  The one-off fields come from forge-config.cjs (wp21); the quote's field name is read defensively. */
function gateHookEnabled(opts) {
  opts = opts || {};
  let cfg = opts.config;
  if (cfg === undefined) { try { cfg = require('./forge-config.cjs'); } catch { cfg = null; } }
  if (!cfg || typeof cfg.get !== 'function') return { on: true, source: 'schema-default (forge-config.cjs absent)' };
  try {
    const e = cfg.get('gate-hook');
    const quote = e.once_quote || e.approval_quote || e.quote || e.approval || null;
    return { on: e.value !== false, source: e.source || 'unknown', set_at: e.set_at || null, set_by: e.set_by || null,
      expires_at: e.expires_at || null, quote: typeof quote === 'string' ? quote : null };
  } catch (err) {
    return { on: true, source: 'schema-default (config unreadable: ' + (err.code || err.name || 'error') + ')' };
  }
}

/** commandGateIds(gateModule) -> Set of the "command"-kind gate ids, read from the classifier's own config. */
function commandGateIds(gateModule) {
  return new Set(gateModule.listGates().filter((g) => g.kind === 'command').map((g) => g.id));
}

function blockReason(ids) {
  const lines = ['FORGE GATE (' + ids.join(', ') + '):'];
  for (const id of ids) {
    const w = WORDS[id] || WORDS['classifier-unavailable'];
    lines.push('- ' + w.nl + ' — Forge vraagt eerst. / ' + w.en + ' — Forge asks first.');
    lines.push('  Veilige variant: ' + w.safeNl + '. / Safe variant: ' + w.safeEn + '.');
  }
  lines.push('Forge biedt eerst de veilige variant aan (een gedateerde back-upmap in plaats van verwijderen, alleen dat ene proces stoppen op zijn exacte PID, eerst committen of stashen voordat er iets wordt weggegooid); alleen als de eigenaar uitdrukkelijk ja zegt tegen DIT commando, voert Forge zelf de eenmalige toestemming uit: ' + ONCE_HINT + '.');
  lines.push('Forge offers the safe variant first (dated backup folder instead of delete, stop the one process by its exact PID, commit or stash before discarding); only when the owner explicitly says yes to THIS command does Forge run the one-off approval itself: ' + ONCE_HINT + '.');
  return lines.join('\n');
}

// ---- SCRATCH PASS-THROUGH (hook-level; classifier untouched). A destructive-delete that fired ALONE passes only
// when EVERY segment of the command is itself a provable delete (review wp9a L2) whose targets all resolve inside
// a scratch area; no `{ } ( )` and no cwd/layout/exec token anywhere (security wp9b L3). Any error keeps the block.
const DELETE_VERBS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'rimraf']);
const REFUSED_TOKENS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location',
  'mv', 'move', 'move-item', 'mi', 'cp', 'copy', 'copy-item', 'cpi', 'ren', 'rename', 'rename-item', 'rni', 'ln', 'mklink',
  'new-item', 'ni', 'robocopy', 'xcopy', 'cmd', 'builtin', 'command', 'exec', 'env', 'eval', 'source', 'xargs']);
const PROVABLE_SEGMENT_RE = /^[A-Za-z0-9_\s.\-/\\:'"=+]*$/; // no expansion, glob, redirection or second command
const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** tokenize(segment) -> [{v, quoted}] | null. Whole-word quotes only; a quote glued to other text is refused. */
function tokenize(segment) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const next = segment[re.lastIndex];
    if (next !== undefined && !/\s/.test(next)) return null;
    if (m[3] !== undefined) {
      if (/["']/.test(m[3])) return null;
      out.push({ v: m[3], quoted: false });
    } else out.push({ v: m[1] !== undefined ? m[1] : m[2], quoted: true });
  }
  return out;
}

/** verbIndex(tokens) -> index of the delete verb, or -1 (allowed in front: sudo, npx [--flags], pnpm/yarn dlx). */
function verbIndex(tokens) {
  const low = (k) => (tokens[k] && !tokens[k].quoted ? tokens[k].v.toLowerCase() : null);
  let i = 0;
  if (low(i) === 'sudo') i++;
  if (low(i) === 'npx') { i++; while (low(i) && low(i).startsWith('-')) i++; }
  else if ((low(i) === 'pnpm' || low(i) === 'yarn') && low(i + 1) === 'dlx') i += 2;
  return low(i) && DELETE_VERBS.has(low(i)) ? i : -1;
}

/** extractTargets(tokens, verbAt) -> targets | null. Every non-flag token is a target (a misread flag value can
 *  only add a block); `--` ends options; `-Param:value` is refused; `/s` is a PATH in Git Bash and PowerShell. */
function extractTargets(tokens, verbAt) {
  const targets = [];
  let endOfOptions = false;
  for (let k = verbAt + 1; k < tokens.length; k++) {
    const { v, quoted } = tokens[k];
    if (!endOfOptions && !quoted && v === '--') { endOfOptions = true; continue; }
    if (!endOfOptions && !quoted && v.startsWith('-')) { if (v.includes(':')) return null; continue; }
    targets.push(v);
  }
  return targets;
}

/** realish(p) -> realpath of the longest existing ancestor + the missing tail (a link is judged by its target). */
function realish(p) {
  let existing = p;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real;
  try { real = fs.realpathSync.native(existing); } catch { real = existing; }
  return tail.length ? path.join(real, ...tail) : real;
}

function relInside(base, p) {
  const rel = path.relative(base, p);
  if (rel === '') return '';
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

/** resolveTarget(raw, ctx) -> absolute path | null (null = cannot be proven, block). */
function resolveTarget(raw, ctx) {
  let p = String(raw);
  if (!p || p.length > 1024) return null;
  if (ctx.shell === 'Bash' && p.includes('\\')) return null; // bash reads `\` as an escape, not a separator
  if (ctx.shell === 'PowerShell') p = p.replace(/\\/g, '/');  // PowerShell accepts both separators
  if (/^[A-Za-z]:(?![\\/])/.test(p)) return null;              // drive-relative `C:foo`
  if (ctx.platform === 'win32' && ctx.shell === 'Bash') {      // Git Bash drive form /c/Users/... -> C:/Users/...
    const m = /^\/([A-Za-z])(\/|$)/.exec(p);
    if (m) p = m[1].toUpperCase() + ':/' + p.slice(3);
  }
  if (p.split(/[\\/]+/).includes('..')) return null;            // never reason about `..` (links make it physical)
  return path.resolve(ctx.cwd, p);
}

/** areaOf(abs, ctx) -> { area, display } | null — the scratch area that contains abs, judged on real paths. */
// eindtest fix (2026-09-24): a project that itself lives under the OS temp dir must NOT be swallowed by the
// temp rule. ctx.protectedRoots = this file's project root + CLAUDE_PROJECT_DIR (else the payload cwd). A target
// that equals or CONTAINS a protected root never passes; a target INSIDE one passes only via a named scratch
// sub-area of ctx.root; the temp rule applies only to targets outside every protected root.
function areaOf(abs, ctx) {
  const real = realish(abs);
  const protectedRoots = (ctx.protectedRoots || [ctx.root]).filter(Boolean).map((r) => realish(path.resolve(r)));
  if (protectedRoots.some((r) => relInside(real, r) !== null)) return null; // the root itself or an ancestor of it
  const insideProject = protectedRoots.some((r) => relInside(r, real) !== null);
  const tmpRel = insideProject ? null : relInside(realish(ctx.tmp), real);
  const rootRel = relInside(realish(ctx.root), real);
  if (rootRel) {
    const s = rootRel.split(/[\\/]+/);
    const show = s.join('/');
    const is = (i, name) => s[i] !== undefined && sameName(s[i], name);
    if (is(0, '_scratch')) return { area: '_scratch', display: show };
    if (s.some((x) => sameName(x, 'node_modules'))) return { area: 'node_modules', display: show };
    if (s.some((x) => sameName(x, 'dist'))) return { area: 'dist', display: show };
    if (is(0, '.claude') && is(1, 'forge-backups') && s.length >= 3) return { area: 'forge-backups', display: show };
    if (is(0, '.claude') && is(1, 'forge-runs') && s.slice(2).some((x) => sameName(x, 'gate-output'))) return { area: 'gate-output', display: show };
    if (is(0, 'command-center') && is(1, '.data') && is(2, 'tmp')) return { area: 'command-center/.data/tmp', display: show };
  }
  if (tmpRel) return { area: 'tmpdir', display: '<tmp>/' + tmpRel.split(/[\\/]+/).join('/') }; // strictly inside, outside the project
  return null;
}

/** scratchPassThrough(command, ctx) -> { ok:true, targets } | { ok:false, why }. Never throws. */
function scratchPassThrough(command, ctx) {
  try {
    const g = ctx.gate.loadGates().gates.find((x) => x.id === 'destructive-delete');
    if (!g || !g.match || !g.match.pattern) return { ok: false, why: 'no-gate-config' };
    if (g.match.pattern_line && new RegExp(g.match.pattern_line, g.match.flags || 'i').test(command)) return { ok: false, why: 'pipeline-delete' };
    if (/[{}()]/.test(command)) return { ok: false, why: 'grouping-or-subshell' };
    const words = command.split(/[\s;&|]+/).map((t) => t.replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, ''));
    if (words.some((t) => REFUSED_TOKENS.has(t))) return { ok: false, why: 'cwd-layout-or-exec-token' };
    const shown = [];
    for (const e of ctx.gate.splitCommandsDetailed(command)) {
      if (!e.intact) return { ok: false, why: 'amputated-segment' };
      if (!PROVABLE_SEGMENT_RE.test(e.segment)) return { ok: false, why: 'unprovable-characters' };
      const tokens = tokenize(e.segment);
      if (!tokens) return { ok: false, why: 'unreadable-quoting' };
      const verbAt = verbIndex(tokens);
      if (verbAt < 0) return { ok: false, why: 'segment-is-not-a-plain-delete' };
      const targets = extractTargets(tokens, verbAt);
      if (!targets || !targets.length) return { ok: false, why: 'no-provable-targets' };
      for (const t of targets) {
        const abs = resolveTarget(t, ctx);
        const area = abs && areaOf(abs, ctx);
        if (!area) return { ok: false, why: 'target-outside-scratch' };
        shown.push(area.display);
      }
    }
    return shown.length ? { ok: true, targets: shown } : { ok: false, why: 'nothing-to-prove' };
  } catch (e) {
    return { ok: false, why: 'internal-error (' + String(e && e.message || e).split('\n')[0] + ')' };
  }
}

const cap = (s) => (s.length > MAX_NOTICE_CHARS ? s.slice(0, MAX_NOTICE_CHARS - 1) + '…' : s);
const passNotice = (targets) => cap('FORGE GATE: destructive delete allowed — all targets inside a project scratch area or in the OS temp dir outside the project (' + targets.join(', ') + ')');

/** selfDisable(seen, raw) -> true when a forge-config call would switch the gate off (M3), except the one
 *  owner-approved `--once "<quote>"` shape run on its own (M4). `seen` is the data-stripped text. */
function selfDisable(seen, raw) {
  return CONFIG_CMD_RE.test(seen) && SELF_DISABLE_RE.test(seen) && !ONCE_SHAPE_RE.test(raw);
}

function offNotice(en, gates) {
  const tail = ' — this would have been blocked (' + gates.join(', ') + ')';
  if (en.expires_at) return cap('FORGE GATE is OFF until ' + en.expires_at + ' — one-off approval: "' + (en.quote || '?') + '"' + tail);
  return cap('FORGE GATE is OFF (set_at ' + (en.set_at || 'unknown') + ', set_by ' + (en.set_by || 'unknown') + ')' + tail);
}

/** evaluate(payload, command, opts) -> the ON-verdict { block, warn?, gates, reason, notice, why }. */
function evaluate(payload, command, opts) {
  const data = DATA ? DATA.stripInertData(command, payload.tool_name) : { text: command, regions: 0 };
  const seen = data.text;
  const note = data.regions ? ' (after stripping ' + data.regions + ' inert data region(s))' : '';
  if (selfDisable(seen, command)) {
    const ids = ['gate-hook-self-disable'];
    return { block: true, gates: ids, reason: blockReason(ids), why: 'gate-hook-self-disable' };
  }
  let gateModule;
  let result;
  let commandIds;
  try {
    gateModule = opts.gate || require('./forge-actiongate.cjs');
    commandIds = commandGateIds(gateModule);
    result = gateModule.classify({ text: seen });
  } catch (e) {
    const msg = String(e && e.message || e).split('\n')[0];
    if (FALLBACK_RE.test(command)) {
      const ids = ['classifier-unavailable'];
      return { block: true, gates: ids, reason: blockReason(ids), why: 'classifier-unavailable, fail-closed fallback (' + msg + ')' };
    }
    return { block: false, warn: true, gates: [], notice: cap('forge-gate-hook: classifier unavailable (' + msg + ') — this call was NOT checked'), why: 'classifier-unavailable' };
  }
  const fired = (result.matched || []).filter((id) => commandIds.has(id));
  if (!fired.length) return { block: false, gates: [], why: (result.gate ? 'no-command-gate (' + result.matched.join(', ') + ')' : 'no-gate') + note };
  let why = 'command-gate';
  if (fired.length === 1 && fired[0] === 'destructive-delete') {
    const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
    const env = opts.env || process.env;
    const pass = scratchPassThrough(seen, {
      gate: gateModule,
      shell: payload.tool_name,
      cwd,
      root: opts.projectRoot || PROJECT_ROOT,
      protectedRoots: [opts.projectRoot || PROJECT_ROOT, env.CLAUDE_PROJECT_DIR || cwd],
      tmp: opts.tmpdir || os.tmpdir(),
      platform: opts.platform || process.platform,
    });
    if (pass.ok) return { block: false, gates: fired, notice: passNotice(pass.targets), why: 'scratch-pass-through' };
    why = 'command-gate (no pass-through: ' + pass.why + ')';
  }
  return { block: true, gates: fired, reason: blockReason(fired), why };
}

/** decide(payload, opts) -> { block, warn, gates, reason, notice, why }. Seams: opts.gate (classifier), opts.config,
 *  opts.projectRoot (scratch-area root), opts.tmpdir, opts.platform. When gate-hook is OFF the verdict is still
 *  computed: a call that WOULD have been blocked becomes a visible exit-1 notice (security M3 / review M4). */
function decide(payload, opts) {
  opts = opts || {};
  const none = (why) => ({ block: false, gates: [], reason: null, why });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return none('no-payload');
  if (payload.hook_event_name && payload.hook_event_name !== 'PreToolUse') return none('not-pretooluse');
  if (!SHELL_TOOLS.has(payload.tool_name)) return none('not-a-shell-tool');
  const input = payload.tool_input;
  const command = input && typeof input === 'object' ? input.command : null;
  if (typeof command !== 'string' || !command.trim()) return none('no-command');
  const en = gateHookEnabled(opts);
  const verdict = evaluate(payload, command, opts);
  if (en.on) return verdict;
  if (verdict.block && verdict.gates[0] !== 'gate-hook-self-disable') {
    return { block: false, warn: true, gates: verdict.gates, notice: offNotice(en, verdict.gates), why: 'gate-hook-off, would have blocked' };
  }
  return none('gate-hook-off (' + en.source + ')');
}

/** run(rawStdin, opts) -> { exitCode, stderr, why }. Never throws. */
function run(rawStdin, opts) {
  let payload;
  try { payload = JSON.parse(String(rawStdin || '')); } catch { return { exitCode: 0, stderr: '', why: 'unparseable-stdin' }; }
  try {
    const d = decide(payload, opts);
    if (d.block) return { exitCode: 2, stderr: d.reason, why: d.why };
    return { exitCode: d.warn ? 1 : 0, stderr: d.notice || '', why: d.why };
  } catch (e) {
    return { exitCode: 1, stderr: 'forge-gate-hook: internal error, this call was NOT checked: ' + String(e && e.message || e).split('\n')[0], why: 'internal-error' };
  }
}

module.exports = {
  run, decide, evaluate, gateHookEnabled, commandGateIds, blockReason, selfDisable, scratchPassThrough, tokenize, verbIndex,
  extractTargets, resolveTarget, areaOf, SHELL_TOOLS, WORDS, FAILSAFE_MS, MAX_STDIN_BYTES, PROJECT_ROOT, FALLBACK_RE, ONCE_SHAPE_RE,
};

// ---- CLI (PreToolUse hook target). Async stdin collection (proven safe on Windows by forge-toolhook.cjs); every
// path that cannot inspect the call exits 1 — non-blocking but visible to the user (security wp9b M2). ----
if (require.main === module) {
  let finished = false;
  const finish = (code, text) => {
    if (finished) return;
    finished = true;
    // synchronous write: an async stderr write can be cut off by process.exit() on a pipe
    if (text) { try { fs.writeSync(2, text + '\n'); } catch { /* nothing left to report to */ } }
    process.exit(code);
  };
  const failsafe = setTimeout(() => finish(1, 'forge-gate-hook: stdin did not end in time, this call was NOT checked'), FAILSAFE_MS);
  if (failsafe.unref) failsafe.unref();
  const chunks = [];
  let size = 0;
  let oversize = false;
  process.stdin.on('data', (c) => {
    size += c.length;
    if (size > MAX_STDIN_BYTES) oversize = true;
    else chunks.push(c);
  });
  process.stdin.on('error', () => finish(1, 'forge-gate-hook: stdin error, this call was NOT checked'));
  process.stdin.on('end', () => {
    clearTimeout(failsafe);
    if (oversize) { finish(1, 'forge-gate-hook: payload larger than ' + MAX_STDIN_BYTES + ' bytes, this call was NOT checked'); return; }
    let r;
    try { r = run(Buffer.concat(chunks).toString('utf8')); }
    catch (e) { r = { exitCode: 1, stderr: 'forge-gate-hook: internal error, this call was NOT checked: ' + (e && e.message) }; }
    finish(r.exitCode, r.stderr);
  });
  process.stdin.resume();
}
