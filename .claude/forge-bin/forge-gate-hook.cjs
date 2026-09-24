#!/usr/bin/env node
'use strict';
/**
 * forge-gate-hook.cjs — PreToolUse hook (matcher `Bash|PowerShell`): the FOUR command hard gates become a real
 * stop (v2.7.0, WP16, run forge-2026-09-24-config-v250; opaque-exec added in the codex-recheck-2026-09-24
 * remediation, wp-f1). Written rules are advice; a hook runs BEFORE the tool call and exit 2 blocks it and
 * feeds stderr back to Claude. ON by default for beginners (config key `gate-hook`, FORGE_CONFIG_SCHEMA.json)
 * after the beginner sweep (rows A4/B10). Doctrine + honest limits: config/orchestration/HOOKS_OPT_IN.md §6.
 *
 * BLOCKS the match.kind "command" gates of hard-gates.json via the single classifier forge-actiongate.cjs:
 * destructive-delete, kill-by-name, git-destructive, opaque-exec — plus the hook's own `gate-hook-self-disable`
 * (security wp9b M3): a Bash/PowerShell forge-config call that sets gate-hook off, unsets it, with a mutating
 * verb, read from a PARSED argv rather than a spelling match (codex-recheck S05). The ONE allowed off-switch is
 * the owner-approved one-off `node .claude/forge-bin/forge-config.cjs set gate-hook off --once "<owner's
 * words>"` (review wp9a M4). A once-grant is consumed ATOMICALLY, per affected command, through
 * forge-config.cjs::consumeOnce() (codex-recheck S06) — never a blanket window. Text gates and
 * write-outside-root are NOT enforced here (legitimate flows; no reliable target path in a command line).
 *
 * EXIT CODES (security wp9b M2, tightened by codex-recheck C01/S07): 2 = blocked · 1 = non-blocking but
 * VISIBLE (hook internal error, oversized/hanging/unparseable/ambiguous stdin, gate-hook OFF while a gate
 * would have fired, classifier unavailable and the fallback regex silent) · 0 = allowed. A call this hook
 * cannot actually judge — malformed JSON, a null/array/string payload, a shell tool with a missing or
 * non-string command, or an UNRECOGNISED hook_event_name (codex-recheck V01: only a name Claude Code really
 * sends for a non-tool-call event is silently unrelated) — is NEVER silently allowed: it exits 1 with a
 * visible "NOT checked" line. Silent exit 0 is reserved for a call this hook can POSITIVELY tell is unrelated
 * (a real recognised non-PreToolUse event, a recognised non-shell tool, or an empty no-op command). A
 * self-disable attempt is BLOCKED (exit 2) whenever gate-hook is ON, and also while a ONCE-style grant is
 * PENDING (codex-recheck V03 — the plain off/unset form must never upgrade a one-off approval into a
 * persistent OFF); it is visible-but-allowed only under a PERSISTENT off with no once-window open. When
 * hard-gates.json / the classifier cannot load, FALLBACK_RE
 * blocks the obviously destructive verbs (fail-CLOSED). Inert data is stripped first (forge-gate-data.cjs;
 * absent -> nothing is stripped); a delete whose every segment is a provable scratch delete passes
 * (scratchPassThrough, fail-closed) — and this proof now runs for EVERY recursive-delete SHAPE, even one the
 * classifier's own except-valve already excused (codex-recheck I01: that valve is supplemental detection, never
 * enforcement, for this hook). Never writes stdout or disk; zero dependencies beyond Node core (fs/os/path/
 * crypto). PowerShell is matched because the tool ledger shows real PowerShell tool calls (same `command`
 * field) and kill-by-name's forbidden forms are PowerShell-native.
 *
 * MODEL: gateHookEnabled · selfDisable · scratchPassThrough · decide(payload, opts) -> {block, warn, gates,
 * reason, notice, why} · run(rawStdin, opts) -> {exitCode, stderr, why}. CLI: stdin -> run() -> stderr + exit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let DATA = null;
try { DATA = require('./forge-gate-data.cjs'); } catch { DATA = null; } // absent -> nothing is stripped (stricter)
let SCRATCH = null;
try { SCRATCH = require('./forge-gate-scratch.cjs'); } catch { SCRATCH = null; } // absent -> no pass-through (stricter)

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// V01 (codex-recheck 2026-09-24): only a hook_event_name Claude Code ACTUALLY sends for something other than a
// tool call may pass silently as "not-pretooluse" — an unrecognised/corrupted name (a bogus envelope, not a
// real Claude Code event) is never proof this call is unrelated, so it stays VISIBLE (exit 1) instead.
const KNOWN_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd', 'PreCompact',
  'UserPromptSubmit', 'Notification', 'SubagentStop', 'SubagentStart', 'PermissionRequest']);
const FAILSAFE_MS = 3000;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAX_NOTICE_CHARS = 300;
const FALLBACK_RE = /\b(rm|Remove-Item|rd|rmdir|del|taskkill|Stop-Process|pkill|killall)\b|\bgit\b[^\n]*\b(reset|clean|checkout|restore|switch|stash)\b|\biex\b|\bInvoke-Expression\b/i;

/** sha256(s) -> hex digest, used only to bind a once-consumption call to the exact command being evaluated
 *  (codex-recheck S06); never logged, never echoed back to the user. */
function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

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
  'opaque-exec': {
    nl: 'Forge kan niet zien wat dit commando echt zou uitvoeren (het geeft onbekende of gedecodeerde inhoud door aan een interpreter)',
    en: 'Forge cannot see what this would run (it hands unknown or decoded content to an interpreter)',
    safeNl: 'schrijf het commando voluit uit (geen iex/eval/sh -c op een variabele, geen pipe naar sh/bash/pwsh), of laat het als een los, leesbaar script-bestand draaien',
    safeEn: 'write the command out in full (no iex/eval/sh -c on a variable, no pipe into sh/bash/pwsh), or run it as a separate, readable script file instead',
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
function resolveConfigModule(opts) {
  let cfg = opts.config;
  if (cfg === undefined) { try { cfg = require('./forge-config.cjs'); } catch { cfg = null; } }
  return cfg;
}
function gateHookEnabled(opts) {
  opts = opts || {};
  const cfg = resolveConfigModule(opts);
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

// ---- SCRATCH PASS-THROUGH — delegated to forge-gate-scratch.cjs (split out 2026-09-24 to keep this file under
// 500 lines). A destructive-delete SHAPE passes only when EVERY segment is itself a provable delete whose
// targets all resolve inside a scratch area; reached for every such shape, including one the classifier's own
// except-valve already excused (codex-recheck I01). An absent scratch module fails closed: no pass-through. The
// tokenize/verbIndex/extractTargets/resolveTarget/areaOf re-exports below exist only for direct unit testing.
function scratchPassThrough(command, ctx) {
  if (!SCRATCH) return { ok: false, why: 'scratch-module-unavailable' };
  return SCRATCH.scratchPassThrough(command, ctx);
}
const tokenize = (...a) => (SCRATCH ? SCRATCH.tokenize(...a) : null);
const verbIndex = (...a) => (SCRATCH ? SCRATCH.verbIndex(...a) : -1);
const extractTargets = (...a) => (SCRATCH ? SCRATCH.extractTargets(...a) : null);
const resolveTarget = (...a) => (SCRATCH ? SCRATCH.resolveTarget(...a) : null);
const areaOf = (...a) => (SCRATCH ? SCRATCH.areaOf(...a) : null);

const cap = (s) => (s.length > MAX_NOTICE_CHARS ? s.slice(0, MAX_NOTICE_CHARS - 1) + '…' : s);
const passNotice = (targets) => cap('FORGE GATE: destructive delete allowed — all targets inside a project scratch area or in the OS temp dir outside the project (' + targets.join(', ') + ')');

// ---- SELF-DISABLE (security wp9b M3), read from PARSED ARGV rather than a spelling match (codex-recheck S05):
// any Bash/PowerShell forge-config.cjs invocation — any path form, a quoted verb, flags in any order/position,
// `--json`/`--global` — whose target key is `gate-hook` with `set <off-word>` or `unset` is blocked, except the
// exact one-off shape `set gate-hook off --once "<quote>"` on its own, with no other flag or trailing argument.
const OFF_WORDS = new Set(['off', 'uit', 'false', 'no', 'nee', '0', 'disabled', 'disable', 'uitzetten', 'uitschakelen', 'deactiveren']);
const CONFIG_SPLIT_RE = /&&|\|\||;;|;|\||&|\r\n|\n|\r|\$\(|`/g; // mirrors forge-actiongate's own SHELL_SPLIT_RE,
// duplicated on purpose: self-disable detection must keep working even if forge-actiongate.cjs is missing/broken.
function splitForSelfDisable(text) {
  return String(text).split(CONFIG_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
}

// V02 (codex-recheck 2026-09-24): the real, equivalent ways this project's own docs and scripts invoke
// forge-config.cjs — a node CLI flag before the script path, a full interpreter path, `env` re-resolving it
// from PATH, and sudo/time/nohup wrappers — must all still reach the SAME parsed verdict as the bare `node
// forge-config.cjs` form, not fall through to "not a config call" = permission.
const CONFIG_WRAPPER_RE = /^(?:sudo|time|nohup)$/i;
const CONFIG_BASENAME_RE = /^forge-config(?:-cli)?\.cjs$/i;
function isNodeToken(tok) {
  if (!tok || tok.quoted) return false;
  return /^node(?:\.exe)?$/i.test(String(tok.v).split(/[\\/]/).pop());
}

/** parseConfigCall(segment) -> a best-effort ARGV read of a single segment invoking forge-config.cjs or
 *  forge-config-cli.cjs (any path form: relative, absolute, quoted, bare basename, a full interpreter path,
 *  `env`-resolved, sudo/time/nohup-wrapped, with or without node CLI flags before the script), or null when
 *  this segment is not one. Not a full shell parser: `tokenize()` refuses a glued quote (a shell
 *  concatenation trick such as `s"et"`), which correctly makes THIS function refuse too — the caller
 *  (selfDisable) treats that refusal as "cannot read, not as "permitted"" (V02), unlike a segment that is
 *  cleanly parsed and genuinely is not a config call. */
function parseConfigCall(segment) {
  const tokens = tokenize(segment);
  if (!tokens || !tokens.length) return null;
  let i = 0;
  while (tokens[i] && !tokens[i].quoted && (CONFIG_WRAPPER_RE.test(tokens[i].v) || /^env$/i.test(tokens[i].v))) i++;
  if (isNodeToken(tokens[i])) {
    i++;
    while (tokens[i] && !tokens[i].quoted && /^-/.test(tokens[i].v)) i++; // node's own CLI flags, e.g. --no-warnings
  }
  if (!tokens[i]) return null;
  const base = String(tokens[i].v).split(/[\\/]/).pop();
  if (!CONFIG_BASENAME_RE.test(base)) return null;
  const rest = tokens.slice(i + 1);
  const isFlag = (t) => !t.quoted && /^-{1,2}[A-Za-z]/.test(t.v);
  const flags = rest.filter(isFlag).map((t) => t.v.toLowerCase());
  const positional = rest.filter((t) => !isFlag(t));
  const norm = (t) => (t ? String(t.v).toLowerCase() : '');
  return {
    verb: norm(positional[0]),
    key: norm(positional[1]),
    value: norm(positional[2]),
    quoteRaw: positional[3] ? positional[3].v : null,
    extraPositional: positional.length > 4, // set, gate-hook, off, the quote — a 5th positional is extra
    flags,
  };
}

function isSelfDisableCall(p) {
  if (!p || p.key !== 'gate-hook') return false;
  if (p.verb === 'unset') return true;
  if (p.verb === 'set') return OFF_WORDS.has(p.value);
  return false;
}
function isOnceExempt(p) {
  return !!p && p.verb === 'set' && p.key === 'gate-hook' && p.value === 'off'
    && p.flags.length === 1 && p.flags[0] === '--once'
    && !!p.quoteRaw && p.quoteRaw.trim().length > 0 && !p.extraPositional;
}

/** looksLikeAmbiguousConfigMutation(segment) -> boolean — V02 fail-closed fallback for a segment the STRICT
 *  tokenizer refuses to parse at all (e.g. a shell word-concatenation trick like `s"et"` or `'se't`, which is
 *  not a whole-word quote and correctly makes tokenize()/parseConfigCall() return null). Removing every quote
 *  character is a crude but honest normalisation: `s"et"` and `'se't` both de-glue to the word "set", exactly
 *  what a real shell would also assemble. This is used ONLY to decide whether an UNPARSEABLE segment must
 *  still be refused (blocked) as an ambiguous self-disable attempt — an ordinary, cleanly-tokenized segment
 *  always goes through the precise parseConfigCall()/isSelfDisableCall() path instead. */
function deglue(segment) { return String(segment).replace(/["']/g, ''); }
function looksLikeAmbiguousConfigMutation(segment) {
  const words = deglue(segment).trim().split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  if (!words.length) return false;
  const hasScript = words.some((w) => CONFIG_BASENAME_RE.test(String(w).split(/[\\/]/).pop()));
  return hasScript && (words.includes('set') || words.includes('unset')) && words.includes('gate-hook');
}

/** selfDisable(seen) -> true when ANY segment of `seen` (the data-stripped text — a self-disable string quoted
 *  inside inert heredoc/echo/commit-message data must not itself trigger this) is a self-disabling forge-config
 *  call that is not the one exempt once-shape, OR (V02) a segment the strict parser could not read at all but
 *  whose de-quoted text still plausibly names forge-config.cjs + gate-hook with a mutating verb — refused
 *  rather than silently treated as permission. */
function selfDisable(seen) {
  for (const segment of splitForSelfDisable(seen)) {
    const parsed = parseConfigCall(segment);
    if (parsed) { if (isSelfDisableCall(parsed) && !isOnceExempt(parsed)) return true; continue; }
    if (looksLikeAmbiguousConfigMutation(segment)) return true;
  }
  return false;
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
  if (selfDisable(seen)) {
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
  let fired = (result.matched || []).filter((id) => commandIds.has(id));
  // I01 / ISO-SCRATCH-SHORTCIRCUIT: the classifier's exact-segment `except` valve is supplemental detection for
  // its own advisory verdict, never an enforcement shortcut for this hook. A destructive-delete SHAPE reaches
  // scratchPassThrough regardless of whether the valve already excused it.
  let ddGate = null;
  try {
    if (commandIds.has('destructive-delete') && typeof gateModule.loadGates === 'function') {
      ddGate = gateModule.loadGates().gates.find((g) => g.id === 'destructive-delete');
    }
  } catch { ddGate = null; } // cannot determine the raw shape either -> fall back to the classifier's own verdict
  const ddExcused = !!ddGate && !fired.includes('destructive-delete')
    && typeof gateModule.testCommandGateRaw === 'function' && gateModule.testCommandGateRaw(ddGate, seen);
  if (!fired.length && !ddExcused) return { block: false, gates: [], why: (result.gate ? 'no-command-gate (' + result.matched.join(', ') + ')' : 'no-gate') + note };
  let why = 'command-gate';
  const onlyDD = fired.length === 1 && fired[0] === 'destructive-delete';
  if (onlyDD || (fired.length === 0 && ddExcused)) {
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
    if (pass.ok) {
      if (!fired.length) return { block: false, gates: [], notice: passNotice(pass.targets), why: 'scratch-pass-through (except-valve overridden by proof)' };
      return { block: false, gates: fired, notice: passNotice(pass.targets), why: 'scratch-pass-through' };
    }
    if (!fired.length) fired = ['destructive-delete'];
    why = 'command-gate (no pass-through: ' + pass.why + ')';
  }
  return { block: true, gates: fired, reason: blockReason(fired), why };
}

/** decide(payload, opts) -> { block, warn, gates, reason, notice, why }. Seams: opts.gate (classifier), opts.config,
 *  opts.projectRoot (scratch-area root), opts.tmpdir, opts.platform. When gate-hook is OFF the verdict is still
 *  computed: a call that WOULD have been blocked is never silently allowed (S07) — an inspection failure stays
 *  visible regardless of on/off, a self-disable attempt still gets the off-notice, and (S06) a call that WOULD
 *  have been blocked while a ONCE-style grant is active must be individually consumed through
 *  forge-config.cjs::consumeOnce(); absent/throwing/refused means BLOCK, fail-closed. */
function decide(payload, opts) {
  opts = opts || {};
  const none = (why) => ({ block: false, gates: [], reason: null, why });
  const unchecked = (why) => ({ block: false, warn: true, gates: [], notice: cap('forge-gate-hook: ' + why + ' — this call was NOT checked'), why });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return unchecked('invalid-payload');
  if (payload.hook_event_name !== undefined && payload.hook_event_name !== null) {
    if (typeof payload.hook_event_name !== 'string') return unchecked('invalid-hook-event');
    if (payload.hook_event_name !== 'PreToolUse') {
      // V01: an unrecognised event name is never positively known to be unrelated — visible, not silent.
      if (!KNOWN_HOOK_EVENTS.has(payload.hook_event_name)) return unchecked('unknown-hook-event');
      return none('not-pretooluse');
    }
  }
  if (typeof payload.tool_name !== 'string' || !payload.tool_name) return unchecked('missing-tool-name');
  if (!SHELL_TOOLS.has(payload.tool_name)) return none('not-a-shell-tool');
  const input = payload.tool_input;
  const command = input && typeof input === 'object' && !Array.isArray(input) ? input.command : null;
  if (typeof command !== 'string') return unchecked('missing-or-non-string-command');
  if (!command.trim()) return none('no-command'); // an empty command runs nothing; nothing to classify
  const en = gateHookEnabled(opts);
  const verdict = evaluate(payload, command, opts);
  if (verdict.warn && !verdict.block) return verdict; // S07: an inspection failure is always visible, on or off
  if (en.on) return verdict;
  if (!verdict.block) return none('gate-hook-off (' + en.source + ')');
  if (en.expires_at) {
    // a ONCE-style grant: never a blanket window (S06) — self-disable is never approvable through it either.
    // V03 (codex-recheck 2026-09-24): a self-disable attempt while a grant is PENDING is BLOCKED outright, not
    // merely noticed — a warn-only verdict here would let the plain "set gate-hook off"/"unset gate-hook" call
    // actually EXECUTE and persist a permanent OFF through forge-config.cjs's own writer, upgrading a one-off
    // approval into indefinite disablement. The once-exempt shape itself (`set gate-hook off --once "<quote>"`)
    // never reaches this branch at all — selfDisable() excludes it before evaluate() ever names this gate.
    if (verdict.gates[0] === 'gate-hook-self-disable') {
      return { block: true, gates: verdict.gates, reason: verdict.reason, why: 'gate-hook-once-pending-self-disable-blocked' };
    }
    const cfg = resolveConfigModule(opts);
    let outcome;
    try {
      outcome = (cfg && typeof cfg.consumeOnce === 'function')
        ? cfg.consumeOnce('gate-hook', { commandSha256: sha256(command) })
        : { ok: false, reason: 'consumeOnce-unavailable' };
    } catch (e) {
      outcome = { ok: false, reason: 'consumeOnce-threw (' + String(e && e.message || e).split('\n')[0] + ')' };
    }
    if (outcome && outcome.ok === true) {
      return { block: false, warn: true, gates: verdict.gates, notice: cap('FORGE GATE: one-off approval used for this command (' + verdict.gates.join(', ') + ')'), why: 'gate-hook-once-consumed' };
    }
    return { block: true, gates: verdict.gates, reason: verdict.reason, why: 'gate-hook-once-not-consumed (' + (outcome && outcome.reason || 'unknown') + ')' };
  }
  // a PERSISTENT off (no expiry) is an out-of-band owner action outside this hook's own matcher (e.g. the
  // dashboard); stays visible-but-allowed, unchanged from the pre-codex-recheck behaviour.
  return { block: false, warn: true, gates: verdict.gates, notice: offNotice(en, verdict.gates), why: 'gate-hook-off, would have blocked' };
}

/** run(rawStdin, opts) -> { exitCode, stderr, why }. Never throws. */
function run(rawStdin, opts) {
  let payload;
  try { payload = JSON.parse(String(rawStdin || '')); }
  catch { return { exitCode: 1, stderr: 'forge-gate-hook: unparseable stdin, this call was NOT checked', why: 'unparseable-stdin' }; }
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
  extractTargets, resolveTarget, areaOf, parseConfigCall, isSelfDisableCall, isOnceExempt, sha256,
  SHELL_TOOLS, WORDS, FAILSAFE_MS, MAX_STDIN_BYTES, PROJECT_ROOT, FALLBACK_RE, KNOWN_HOOK_EVENTS,
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
