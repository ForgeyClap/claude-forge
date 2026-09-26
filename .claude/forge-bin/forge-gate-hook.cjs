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
 * WP-V3 (sec-v1r-H1/L1/L2, independent re-review): the WHOLE inspection pipeline — stripInertData, selfDisable,
 * classify, the destructive-delete raw recheck, scratchPassThrough — now runs in forge-gate-inspect.cjs::
 * inspect(), called from EITHER the worker_threads Worker (forge-gate-watchdog.cjs, the normal protected path)
 * OR, only when the watchdog module itself is unavailable and the command is small enough
 * (WATCHDOG_UNAVAILABLE_FALLBACK_CHARS), directly from evaluate() below. This file's OWN job is now narrow: read
 * input, apply the cheap top-level size ceiling, run the watchdog (or the explicitly-bounded fallback), map the
 * result, and do the parts that must stay on the main thread because they read/write persistent state
 * (gateHookEnabled()'s config read; decide()'s once-approval consumption via forge-config.cjs::consumeOnce()).
 * Nothing else runs unbounded on the main thread — see forge-gate-inspect.cjs's own header for the full "why".
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
 * hard-gates.json / the classifier cannot load, FALLBACK_RE blocks the obviously destructive verbs (fail-CLOSED).
 * Never writes stdout or disk; zero dependencies beyond Node core (fs/os/path/crypto). PowerShell is matched
 * because the tool ledger shows real PowerShell tool calls (same `command` field) and kill-by-name's forbidden
 * forms are PowerShell-native.
 *
 * MODEL: gateHookEnabled · selfDisable · scratchPassThrough · decide(payload, opts) -> {block, warn, gates,
 * reason, notice, why} · run(rawStdin, opts) -> {exitCode, stderr, why}. CLI: stdin -> run() -> stderr + exit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// SCRATCH is still required directly here for the exported direct-test wrappers below (scratchPassThrough,
// tokenize, verbIndex, extractTargets, resolveTarget, areaOf) — those are test conveniences, not part of the
// quadratic-risk inspection pipeline (which reaches SCRATCH's scratchPassThrough independently, via
// forge-gate-inspect.cjs). Absent -> no pass-through (stricter).
let SCRATCH = null;
try { SCRATCH = require('./forge-gate-scratch.cjs'); } catch { SCRATCH = null; }
// wp-v1/wp-v3 (wave 13, codex-fixes): the worker_threads watchdog that now runs the WHOLE inspection pipeline —
// see forge-gate-watchdog.cjs's header for the full design. Absent -> evaluate() falls back to running
// forge-gate-inspect.cjs::inspect() directly, bounded by WATCHDOG_UNAVAILABLE_FALLBACK_CHARS.
let WATCHDOG = null;
try { WATCHDOG = require('./forge-gate-watchdog.cjs'); } catch { WATCHDOG = null; }
// wp-v4 (sec-v3 M1, independent review): these three used to be required UNGUARDED — a broken or missing file
// made THIS require() throw, which made require('./forge-gate-hook.cjs') itself throw, which crashed the WHOLE
// process before run()'s CLI handler ever ran: every command (destructive or not) exited non-zero with no
// verdict computed at all, the exact "every command runs unchecked" regression this fix closes. Before wave 13
// every dependency was optional with a fail-closed fallback (FALLBACK_RE still blocked destructive verbs when
// the classifier could not load) — restored below via minimal, zero-dependency LOCAL fallbacks for the handful
// of exports evaluate()/decide()/run() actually call, so this file can never crash at require-time again
// regardless of which sibling is missing or corrupted.
let SELFDISABLE = null;
try { SELFDISABLE = require('./forge-gate-selfdisable.cjs'); } catch { SELFDISABLE = null; }
let MSG = null;
try { MSG = require('./forge-gate-messages.cjs'); } catch { MSG = null; }
let INSPECT = null;
try { INSPECT = require('./forge-gate-inspect.cjs'); } catch { INSPECT = null; }

// Fallback self-disable (mirrors forge-gate-inspect.cjs's own copy — see that file's header for why a small
// duplication is deliberate here): a crude, over-inclusive check that still catches the obvious "forge-config
// ... set/unset ... gate-hook" shape when the precise parser cannot load. Only used for this file's OWN
// backward-compat exports (hook.selfDisable etc.) — the real pipeline's self-disable check lives in
// forge-gate-inspect.cjs and has its own, independently-guarded copy of the same fallback.
//
// sec-v3r L3 (independent re-review): the old single ordered regex only matched two of the six possible
// orderings of (script name, mutating verb, "gate-hook"), and never stripped quotes/backslashes or joined a
// Bash backslash-newline / PowerShell backtick-newline line continuation before testing, so a trivially
// reordered or quote-broken or continuation-split call could slip past this LAST-RESORT net. Replaced with
// three independent, unordered word-boundary checks (script present AND a mutating verb present AND
// "gate-hook" present, in ANY order) over a normalised copy of the text — every check is a single linear
// scan, so this stays exactly as safe against ReDoS as the regex it replaces despite matching more shapes.
function fallbackSelfDisableNormalize(seen) {
  return String(seen)
    .replace(/\\\r?\n/g, '') // Bash line continuation: backslash-newline is deleted, not a real separator
    .replace(/`\r?\n/g, '') // PowerShell line continuation: backtick-newline is deleted, not a real separator
    .replace(/["'\\]/g, ''); // quotes/backslashes stripped, same de-gluing looksLikeAmbiguousConfigMutation does
}
const FALLBACK_SELFDISABLE_SCRIPT_RE = /forge-config(?:-cli)?\.cjs/i;
const FALLBACK_SELFDISABLE_VERB_RE = /\b(?:set|unset)\b/i;
const FALLBACK_SELFDISABLE_KEY_RE = /\bgate-hook\b/i;
function fallbackSelfDisableTest(seen) {
  const norm = fallbackSelfDisableNormalize(seen);
  return FALLBACK_SELFDISABLE_SCRIPT_RE.test(norm) && FALLBACK_SELFDISABLE_VERB_RE.test(norm)
    && FALLBACK_SELFDISABLE_KEY_RE.test(norm);
}

// Fallback messages: no per-gate wording (that lives in forge-gate-messages.cjs), but still a real, honest,
// NL/EN block reason and a bounded notice — used by evaluate()/decide()/offNotice() below whenever MSG itself
// could not load, so a broken forge-gate-messages.cjs can never crash THIS file's own require either.
const FALLBACK_NOTICE_CHARS = 300;
function fallbackCap(s) { return s.length > FALLBACK_NOTICE_CHARS ? s.slice(0, FALLBACK_NOTICE_CHARS - 1) + '…' : s; }
function fallbackBlockReason(ids) {
  return 'FORGE GATE (' + ids.join(', ') + '): dit commando lijkt destructief; de uitleg-module kon niet laden, '
    + 'dus is het voor de zekerheid geweigerd — herstel forge-gate-messages.cjs (draai de doctor). / '
    + 'this command looks destructive; the wording module could not load, so it was refused to be safe — '
    + 'restore forge-gate-messages.cjs (run the doctor).';
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// V01 (codex-recheck 2026-09-24): only a hook_event_name Claude Code ACTUALLY sends for something other than a
// tool call may pass silently as "not-pretooluse" — an unrecognised/corrupted name (a bogus envelope, not a
// real Claude Code event) is never proof this call is unrelated, so it stays VISIBLE (exit 1) instead.
const KNOWN_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd', 'PreCompact',
  'UserPromptSubmit', 'Notification', 'SubagentStop', 'SubagentStart', 'PermissionRequest']);
const FAILSAFE_MS = 3000;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
// SB-M5 (wave 12, codex-recheck twelfth pass / wp-t1). MAX_STDIN_BYTES above bounds the whole JSON payload
// (8 MiB); it says nothing about how expensive the inspection pipeline is on whatever command text sits inside
// that payload. MAX_COMMAND_CHARS is a much smaller, cheap-to-check ceiling on the COMMAND TEXT ALONE
// (comfortably above any real Bash/PowerShell command a normal session ever constructs, comfortably below
// MAX_STDIN_BYTES) checked BEFORE anything else runs; DEADLINE_MS is a wall-clock safety net measured around
// the inspection call itself (inline OR the watchdog round-trip, whichever runs).
// wp-v1 (wave 13, codex-fixes, security probe secl17-m1): DEADLINE_MS ALONE was proven insufficient — it is
// only ever compared AFTER the inspection call returns, so it cannot stop a call that has not returned yet.
// wp-v3 (sec-v1r-H1, independent re-review): the SAME danger existed one level deeper than wp-v1/wp-v2 ever
// protected — stripInertData() (called on the MAIN thread, entirely BEFORE the watchdog branch) had its own
// super-linear cost on harmless input (many `echo a`-shaped segments; see forge-gate-data.cjs's own header for
// the measured numbers), and the destructive-delete recheck / scratchPassThrough ALSO ran unguarded on the main
// thread afterwards (sec-v1r L2). evaluate() below now routes the WHOLE inspection pipeline — not just
// classify() — through the worker_threads Worker guarded by a 6000ms Atomics.wait whenever the watchdog module
// is available (sec-v1 M2: no size threshold — see forge-gate-watchdog.cjs's header), so a runaway step
// ANYWHERE in that pipeline is ABANDONED (and answered with this same "too large / too slow to inspect" BLOCK)
// instead of silently exceeding the hook's own external timeout. DEADLINE_MS still catches the case where the
// inspection genuinely finishes, just too slowly (4s-6s). WATCHDOG_UNAVAILABLE_FALLBACK_CHARS (sec-v1 M1,
// lowered from 20,000 to 10,000 by sec-v1r L1) is the fail-closed ceiling used ONLY when the watchdog module
// itself could not be required at all (e.g. no worker_threads in this environment): a command at or under it is
// still classified inline (the pre-wp-v1 behaviour for an ordinary small command); anything larger is refused
// outright rather than silently running an unbounded classification with nothing left to bound it. Justified
// from measurements, not a guess: kill-by-name's own worst confirmed benign shape (a search piped through many
// "| xargs echo" stages, no kill word anywhere) costs ~503ms at 10,000 chars (interpolated from 67ms/5,000 and
// 4,028ms/20,000) — comfortably fast for an inline fallback path — and forge-gate-data.cjs's own
// MAX_INERT_SCAN_SEGMENTS fix makes stripInertData() itself linear regardless of size, so 10,000 chars carries
// negligible extra risk from that stage either. All three refuse with a plain "too large to inspect" BLOCK
// (exit 2), never the non-blocking "NOT checked" exit 1 an ordinary inspection failure gets — an oversized or
// slow-to-judge command is exactly the shape this hook exists to stop from running unchecked, not a shape to
// wave through with a warning.
const MAX_COMMAND_CHARS = 200000;
const DEADLINE_MS = 4000;
const WATCHDOG_UNAVAILABLE_FALLBACK_CHARS = 10000;
// sec-v3r L1 (independent re-review): four additions below, each kept BOUNDED — this regex still runs
// unprotected on the main thread (the watchdog only ever protects the REAL classifier, never this fallback),
// so no new alternative may reintroduce the \S*-before-a-literal shape sec-v1r-H1 already proved catastrophic
// on adversarial dense input. `eval` uses a negative lookahead so a legitimate hyphenated token like
// "eval-source-map" (a real webpack --devtool value) does not trip it. The pipe-into-a-shell and
// kill-with-substitution alternatives use `\s*`/`{0,200}` (bounded), never `[^\n]*`. The encoded-PowerShell-flag
// alternative is a fully deterministic nested-literal chain (no repeated class, so no backtracking ambiguity is
// possible regardless of nesting depth) covering every real unambiguous abbreviation of -EncodedCommand,
// starting at -en (the shortest prefix powershell.exe itself accepts without also matching -ExecutionPolicy).
const FALLBACK_RE = /\b(rm|Remove-Item|rd|rmdir|del|taskkill|Stop-Process|pkill|killall)\b|\bgit\b[^\n]*\b(reset|clean|checkout|restore|switch|stash)\b|\biex\b|\bInvoke-Expression\b|\beval\b(?!-)|\|\s*(?:sudo\s+|env\s+)?(?:sh|bash|zsh|powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?)\b|-en(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?\b|\bkill\b[^\n]{0,200}(?:\$\(|`)\s*(?:pgrep|pidof)\b/i;

/** sha256(s) -> hex digest, used only to bind a once-consumption call to the exact command being evaluated
 *  (codex-recheck S06); never logged, never echoed back to the user. */
function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

// WORDS/blockReason/cap/passNotice/ONCE_HINT now live in forge-gate-messages.cjs (wp-v3) so BOTH this file and
// the worker build the exact same message text from one source. wp-v4 (sec-v3 M1): read defensively (never
// destructure MSG directly — that would throw immediately at require-time if MSG is null) and fall back to the
// minimal local implementations above when the real module could not load.
const WORDS = MSG ? MSG.WORDS : {};
const blockReason = MSG ? MSG.blockReason : fallbackBlockReason;
const cap = MSG ? MSG.cap : fallbackCap;
const passNotice = MSG ? MSG.passNotice : ((targets) => fallbackCap('FORGE GATE: destructive delete allowed — all targets inside a project scratch area or in the OS temp dir outside the project (' + targets.join(', ') + ')'));

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

/** commandGateIds(gateModule) -> Set of the "command"-kind gate ids — delegates to forge-gate-inspect.cjs so
 *  there is exactly one implementation. wp-v4 (sec-v3 M1): INSPECT may be null (guarded require) — an empty
 *  Set is the honest, fail-safe answer (this export is a convenience for callers/tests, never part of the real
 *  block/allow decision, which lives entirely inside forge-gate-inspect.cjs::inspect() itself). */
function commandGateIds(gateModule) {
  return INSPECT ? INSPECT.commandGateIds(gateModule) : new Set();
}

// ---- SCRATCH PASS-THROUGH — direct-test wrappers only (the real inspection pipeline reaches SCRATCH through
// forge-gate-inspect.cjs independently). Delegated to forge-gate-scratch.cjs (split out 2026-09-24 to keep this
// file under 500 lines). An absent scratch module fails closed: no pass-through.
function scratchPassThrough(command, ctx) {
  if (!SCRATCH) return { ok: false, why: 'scratch-module-unavailable' };
  return SCRATCH.scratchPassThrough(command, ctx);
}
const tokenize = (...a) => (SCRATCH ? SCRATCH.tokenize(...a) : null);
const verbIndex = (...a) => (SCRATCH ? SCRATCH.verbIndex(...a) : -1);
const extractTargets = (...a) => (SCRATCH ? SCRATCH.extractTargets(...a) : null);
const resolveTarget = (...a) => (SCRATCH ? SCRATCH.resolveTarget(...a) : null);
const areaOf = (...a) => (SCRATCH ? SCRATCH.areaOf(...a) : null);

// selfDisable/parseConfigCall/isSelfDisableCall/isOnceExempt now live in forge-gate-selfdisable.cjs (wp-v3) so
// BOTH this file (fallback path) and the worker call the exact same implementation. wp-v4 (sec-v3 M1): read
// defensively — SELFDISABLE may be null (guarded require); these exports are backward-compat/test surface only
// (the real pipeline's self-disable check lives inside forge-gate-inspect.cjs, independently guarded there).
const selfDisable = SELFDISABLE ? SELFDISABLE.selfDisable : (seen) => fallbackSelfDisableTest(seen);
const parseConfigCall = SELFDISABLE ? SELFDISABLE.parseConfigCall : () => null;
const isSelfDisableCall = SELFDISABLE ? SELFDISABLE.isSelfDisableCall : () => false;
const isOnceExempt = SELFDISABLE ? SELFDISABLE.isOnceExempt : () => false;

function offNotice(en, gates) {
  const tail = ' — this would have been blocked (' + gates.join(', ') + ')';
  if (en.expires_at) return cap('FORGE GATE is OFF until ' + en.expires_at + ' — one-off approval: "' + (en.quote || '?') + '"' + tail);
  return cap('FORGE GATE is OFF (set_at ' + (en.set_at || 'unknown') + ', set_by ' + (en.set_by || 'unknown') + ')' + tail);
}

/** buildInspectCtx(payload, opts) -> the plain, structured-cloneable context forge-gate-inspect.cjs::inspect()
 *  (and, via classifyWithWatchdog(), the worker's own copy of it) needs — mirrors forge-gate-scratch.cjs's own
 *  scratchPassThrough(seen, ctx) shape exactly, so it threads straight through unchanged. ctx.gate is read ONLY
 *  on the inline path (a function cannot cross a Worker boundary; evaluate() never sets useWatchdog when
 *  opts.gate is present, so the worker path never sees it). */
function buildInspectCtx(payload, opts) {
  const cwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
  const env = opts.env || process.env;
  return {
    gate: opts.gate,
    shell: payload.tool_name,
    cwd,
    root: opts.projectRoot || PROJECT_ROOT,
    protectedRoots: [opts.projectRoot || PROJECT_ROOT, env.CLAUDE_PROJECT_DIR || cwd],
    tmp: opts.tmpdir || os.tmpdir(),
    platform: opts.platform || process.platform,
    configPath: opts.configPath,
  };
}

/** evaluate(payload, command, opts) -> the ON-verdict { block, warn?, gates, reason, notice, why }. SB-M5 (wave
 *  12): opts.maxCommandChars/opts.deadlineMs/opts.now are test seams (defaults MAX_COMMAND_CHARS/DEADLINE_MS/
 *  Date.now) for the size ceiling and wall-clock deadline described at their own declaration above.
 *
 *  wp-v3 (sec-v1r-H1/L2): this function's OWN job is now narrow — the size ceiling, deciding whether the
 *  watchdog is usable, and mapping whichever result comes back. The entire inspection (stripInertData,
 *  selfDisable, classify, the destructive-delete recheck, scratchPassThrough) lives in ONE shared function,
 *  forge-gate-inspect.cjs::inspect(), called either through the watchdog (normal path) or directly here (the
 *  watchdog-unavailable fallback, and any opts.gate-stubbed test — a test-injected classifier module can never
 *  cross a Worker boundary). opts.watchdog is a test seam overriding the required WATCHDOG module for this one
 *  call (default: the real module-level WATCHDOG; pass null to simulate an environment where
 *  worker_threads/forge-gate-watchdog.cjs itself is unavailable). opts.watchdogTimeoutMs/opts.simulateSlowMs/
 *  opts.simulateCrash/opts.WorkerImpl/opts.SharedArrayBufferImpl/opts.atomicsWait/opts.simulateInspectThrow are
 *  test seams threaded straight through to classifyWithWatchdog(). */
function evaluate(payload, command, opts) {
  const maxChars = opts.maxCommandChars || MAX_COMMAND_CHARS;
  if (command.length > maxChars) {
    const ids = ['command-too-large'];
    return { block: true, gates: ids, reason: blockReason(ids), why: 'command-too-large (' + command.length + ' chars > ' + maxChars + ')' };
  }
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const deadlineMs = opts.deadlineMs || DEADLINE_MS;
  const startedAt = now();

  const watchdogModule = opts.watchdog !== undefined ? opts.watchdog : WATCHDOG;
  // wp-v4 (sec-v3 M1, "the watchdog and worker included"): a missing/deleted WORKER SCRIPT FILE means the same
  // thing as the watchdog MODULE itself being unavailable (no working watchdog-protected path) — both must
  // degrade identically to the inline fallback below, not one gracefully and the other by blocking everything.
  // Only checked for the REAL, non-test-injected watchdog (opts.watchdog === undefined); a test supplying its
  // own opts.watchdog stub is never second-guessed by a filesystem check it may not even need to satisfy.
  const watchdogFileIntact = opts.watchdog !== undefined || !watchdogModule || !watchdogModule.WORKER_SCRIPT
    || fs.existsSync(watchdogModule.WORKER_SCRIPT);
  const useWatchdog = !!watchdogModule && watchdogFileIntact && !opts.gate;
  // sec-v1 M1 / sec-v1r L1: when the watchdog is genuinely unavailable (not merely absent from a test stub via
  // opts.gate), a command past this fail-closed fallback ceiling is refused outright rather than silently
  // running an unbounded, unprotected inline inspection with nothing left to bound it.
  if (!useWatchdog && !opts.gate && command.length > WATCHDOG_UNAVAILABLE_FALLBACK_CHARS) {
    const ids = ['command-too-large'];
    return {
      block: true, gates: ids, reason: blockReason(ids),
      why: 'watchdog-unavailable (' + command.length + ' chars > ' + WATCHDOG_UNAVAILABLE_FALLBACK_CHARS + ' fallback ceiling)',
    };
  }

  const ctx = buildInspectCtx(payload, opts);
  try {
    let verdict;
    if (useWatchdog) {
      const w = watchdogModule.classifyWithWatchdog(command, Object.assign({}, ctx, {
        watchdogTimeoutMs: opts.watchdogTimeoutMs, simulateSlowMs: opts.simulateSlowMs,
        simulateCrash: opts.simulateCrash, WorkerImpl: opts.WorkerImpl,
        SharedArrayBufferImpl: opts.SharedArrayBufferImpl, atomicsWait: opts.atomicsWait,
        simulateInspectThrow: opts.simulateInspectThrow, // sec-v3r L2 test seam — never set outside a test
      }));
      if (!w.ok) {
        // sec-v3 L1 (independent review): the worker tags a THROW INSIDE inspect() itself (a broken/missing
        // hard-gates.json, a broken forge-actiongate.cjs, etc.) distinctly from a genuine watchdog/infrastructure
        // failure (timeout, crash, payload corruption) — only the former is "the classifier could not run at
        // all", which restores the EXACT pre-wave-13 classifier-unavailable branch (FALLBACK_RE + honest
        // wording) instead of blanket-blocking it as "too large to inspect", a claim that would be false here.
        if (w.classifierUnavailable) return classifierUnavailableVerdict(command, w.error || w.why);
        const ids = ['command-too-large'];
        return { block: true, gates: ids, reason: blockReason(ids), why: w.why + (w.error ? ' (' + String(w.error).split('\n')[0] + ')' : '') };
      }
      verdict = w.verdict;
    } else {
      if (!INSPECT) throw new Error('forge-gate-inspect.cjs unavailable');
      verdict = INSPECT.inspect(command, ctx);
    }
    const elapsedMs = now() - startedAt;
    if (elapsedMs > deadlineMs) {
      const ids = ['command-too-large'];
      return { block: true, gates: ids, reason: blockReason(ids), why: 'inspection-deadline-exceeded (' + elapsedMs + 'ms > ' + deadlineMs + 'ms)' };
    }
    return verdict;
  } catch (e) {
    // Defense in depth (the sec-v1 M1 lesson: never trust a "never throws" claim without covering every path) —
    // classifyWithWatchdog() and inspect() are both designed to never throw/always resolve safely, but a throw
    // here (from either, or INSPECT being unavailable on the inline path) still fails toward the SAME
    // classifier-unavailable handling every prior version used.
    return classifierUnavailableVerdict(command, String(e && e.message || e).split('\n')[0]);
  }
}

/** classifierUnavailableVerdict(command, msg) -> the pre-wave-13 classifier-unavailable ON-verdict (sec-v3 L1):
 *  a destructive-SHAPED command (FALLBACK_RE) is still BLOCKED (exit 2, fail-closed) even with the real
 *  classifier unreachable; anything else is a VISIBLE, non-blocking "this call was NOT checked" notice (exit 1)
 *  — never a silent allow, and never the (inaccurate) "too large to inspect" wording for a command that was
 *  never actually too large or too slow, just unclassifiable. */
function classifierUnavailableVerdict(command, msg) {
  if (FALLBACK_RE.test(command)) {
    const ids = ['classifier-unavailable'];
    return { block: true, gates: ids, reason: blockReason(ids), why: 'classifier-unavailable, fail-closed fallback (' + msg + ')' };
  }
  return { block: false, warn: true, gates: [], notice: cap('forge-gate-hook: classifier unavailable (' + msg + ') — this call was NOT checked'), why: 'classifier-unavailable' };
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
  fallbackSelfDisableTest, fallbackSelfDisableNormalize,
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
