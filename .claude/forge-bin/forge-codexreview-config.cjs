#!/usr/bin/env node
'use strict';
/**
 * forge-codexreview-config.cjs — the ONE effective-config reader for the independent Codex review
 * (WP-S10, 2026-09-26, fresh-laptop re-audit N4 / Part V-G, "the Codex pin").
 *
 * PROBLEM (measured): the shipped `config/orchestration/codex-review.json` hard-pinned the MAINTAINER's
 * own account-specific model (`gpt-6-astra`, `reasoning_effort: "xhigh"`) — chosen because a previous
 * model returned HTTP 400 on the maintainer's ChatGPT account. A fresh user's account may reject that
 * exact model too, and every account hiccup on the maintainer's side meant editing a file every user's
 * install ships. codex-review.json's own `_doc` already named the intended fix and why it had not
 * been wired yet (WP-S6b handoff, 2026-09-26): the only real readers at the time
 * (`forge-codexreview.test.cjs`, and the prose in `agents/codex-reviewer.md` +
 * `skills/forge-code-review/SKILL.md`) all read the raw shipped file directly and were owned by other
 * work packages, so changing the default there without rewiring those readers would either break the
 * pinning test or silently stop matching the prose.
 *
 * FIX (this file): ONE merge + ONE command-builder, so every consumer describes/uses the EFFECTIVE
 * config instead of assuming a model:
 *   - `config/orchestration/codex-review.json` (SHIPPED, template-owned) now ships a PORTABLE default:
 *     `review.model: null`, `review.reasoning_effort: null` — no pin at all, so a fresh account uses
 *     whatever default model/effort the codex CLI itself carries.
 *   - `config/orchestration/codex-review.user.json` (NEVER shipped, gitignored, excluded from sync — same
 *     template/user split already used for FORGE_STANDING_RULES.user.json / FORGE_SCOUT_VETTING.json) is
 *     an OPTIONAL override, same shape, only the fields being overridden. One specific account (e.g. the
 *     maintainer's) can keep a real pin there without forcing it onto every other install.
 *   - `effectiveConfig(root)` merges shipped + user and `buildCommand(effective, opts)` DERIVES the
 *     actual CLI invocation from the effective values.
 *
 * WP-S14 finding 3.1 (2026-09-26 independent review, MEDIUM): the user file used to win on EVERY field of
 * EVERY section — `{review:{sandbox:"danger-full-access"}}` went straight into `-s`, and an unvalidated
 * `model`/`reasoning_effort` string went straight into the command with no shape check at all (a model
 * string containing a space and an extra flag would have smuggled that flag into the real invocation with
 * no shell metacharacters needed). The user file is gitignored and never reviewed, so a weakening there
 * was invisible in git. FIX, all in this file:
 *   - the user file may now override ONLY `review.model` and `review.reasoning_effort` — every other
 *     field, in `review` or in any other section, always comes from the shipped file; an attempt to set
 *     anything else is ignored, with one visible warning (`effective._warnings`), never silently dropped
 *     AND never silently honoured.
 *   - `model` is validated against MODEL_PATTERN and `reasoning_effort` against ALLOWED_EFFORTS; an
 *     invalid value is ignored (with a warning) and the shipped value is kept — never passed through.
 *   - the review sandbox is now HARD-CODED to `read-only` in `buildCommand()` — it is no longer read from
 *     config (shipped or user) at all, so no override, valid or not, can ever loosen it.
 *   - `buildCommand()` now returns an argv ARRAY (never a shell string) so nothing downstream needs to
 *     parse/re-quote it; `commandToDisplayString()` renders that array as a human-readable string for
 *     prose/logs only — it is never itself executed.
 *
 * Every consumer (the codex-reviewer agent, the forge-code-review skill, this file's own test) reads
 * effectiveConfig()/buildCommand() — or, for a human/agent without Node in hand, reads BOTH json files
 * and applies the exact same "user may only override review.model/review.reasoning_effort, validated"
 * rule described here — instead of restating a model name from memory or hand-building a command string.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function configDirOf(root) { return path.join(root, '.claude', 'config', 'orchestration'); }
function shippedPathOf(root) { return path.join(configDirOf(root), 'codex-review.json'); }
function userPathOf(root) { return path.join(configDirOf(root), 'codex-review.user.json'); }

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function nonEmptyString(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

// WP-S14 3.1 — the only two fields a never-shipped, never-reviewed user file may ever change, and the
// shapes they are validated against. A model string is a CLI argument value, never a place to smuggle an
// extra flag or a shell metacharacter — the pattern is deliberately narrow (alphanumerics plus the
// separators real model ids use: `.`, `_`, `:`, `-`). The effort set is the CLI's own documented scale,
// per this repo's shipped codex-review.json (`review.operational_notes... "the highest level the CLI
// accepts is xhigh"`) plus the two levels verified live end-to-end in that same file's history
// (effort=max, 2026-08-04; effort=xhigh, 2026-08-09 and 2026-09-24) and the standard low/medium/high scale
// codex-cli builds on. An unlisted value is treated as a red flag, not an undocumented new tier — ignored
// with a warning, never passed through.
// N3 fix (2026-09-26 independent review, LOW): the pattern must reject a value that STARTS with `-` — a
// leading dash makes the "model" itself look like a CLI flag once it lands after `-m` in argv (e.g.
// `--dangerously-bypass-approvals-and-sandbox` used to match: it is 1-64 chars of the allowed alphabet, no
// space needed to smuggle it). Requiring the FIRST character to be alphanumeric closes that without
// narrowing the rest of the allowed alphabet real model ids use (`.`, `_`, `:`, `-`).
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ALLOWED_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// N3 fix — a script-extension codexBin (see runCodex()) is run via `node <script> <args>` instead of being
// exec'd directly, so a hermetic test can stand in a tiny fake "codex" on every OS without a compiled
// binary. This NEVER activates for the real 'codex' name — only when FORGE_CODEX_BIN/opts.codexBin is
// explicitly pointed at a .js/.cjs/.mjs file.
const SCRIPT_EXT_RE = /\.(c?js|mjs)$/i;

/** sanitizeModel(raw, warnings) -> a validated model string, or null to explicitly clear a pin, or
 *  undefined when the value must be REJECTED (a warning is pushed and the shipped value is kept). */
function sanitizeModel(raw, warnings) {
  if (raw === null || raw === undefined) return null; // an explicit null/absent clears to "no pin"
  if (typeof raw !== 'string' || !raw.trim()) {
    warnings.push('ignored review.model override (not a usable string) — keeping the shipped value');
    return undefined;
  }
  const v = raw.trim();
  if (!MODEL_PATTERN.test(v)) {
    warnings.push('ignored review.model override ' + JSON.stringify(raw) + ' — must match ' + MODEL_PATTERN + '; keeping the shipped value');
    return undefined;
  }
  return v;
}

/** sanitizeEffort(raw, warnings) -> a validated, lower-cased effort string, null to explicitly clear a
 *  pin, or undefined to REJECT (warning pushed, shipped value kept). */
function sanitizeEffort(raw, warnings) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || !raw.trim()) {
    warnings.push('ignored review.reasoning_effort override (not a usable string) — keeping the shipped value');
    return undefined;
  }
  const v = raw.trim().toLowerCase();
  if (ALLOWED_EFFORTS.indexOf(v) === -1) {
    warnings.push('ignored review.reasoning_effort override ' + JSON.stringify(raw) + ' — not one of: ' + ALLOWED_EFFORTS.join(', ') + '; keeping the shipped value');
    return undefined;
  }
  return v;
}

/** mergeReviewSection(shippedReview, userReview, warnings) -> the effective `review` object. Only
 *  `model`/`reasoning_effort` from the user section are ever applied (validated); every other key present
 *  in the user's `review` object (sandbox, engine, min_cli_version, ...) is ignored, with one combined
 *  warning naming exactly which keys were ignored — the shipped value always wins there. */
function mergeReviewSection(shippedReview, userReview, warnings) {
  const base = Object.assign({}, (shippedReview && typeof shippedReview === 'object') ? shippedReview : {});
  if (!userReview || typeof userReview !== 'object') return base;

  const ignoredKeys = Object.keys(userReview).filter((k) => k !== 'model' && k !== 'reasoning_effort');
  if (ignoredKeys.length) {
    warnings.push('codex-review.user.json: ignored review.' + ignoredKeys.join(', review.') +
      ' — only review.model and review.reasoning_effort may ever be overridden there; every other review ' +
      'field (sandbox, engine, min_cli_version, ...) always comes from the shipped codex-review.json');
  }
  if (Object.prototype.hasOwnProperty.call(userReview, 'model')) {
    const clean = sanitizeModel(userReview.model, warnings);
    if (clean !== undefined) base.model = clean;
  }
  if (Object.prototype.hasOwnProperty.call(userReview, 'reasoning_effort')) {
    const clean = sanitizeEffort(userReview.reasoning_effort, warnings);
    if (clean !== undefined) base.reasoning_effort = clean;
  }
  return base;
}

/** lockedSection(shippedSection, userSection, sectionName, warnings) -> the shipped section, unchanged.
 *  Every section OTHER than `review` (naming, fallback, honesty, operational_notes, and anything future)
 *  can never be overridden by the user file at all — this is what keeps `honesty.
 *  never_claim_model_that_did_not_run` (and everything else) un-weakenable from a gitignored file. */
function lockedSection(shippedSection, userSection, sectionName, warnings) {
  if (userSection && typeof userSection === 'object' && Object.keys(userSection).length) {
    warnings.push('codex-review.user.json: ignored the entire "' + sectionName + '" section (' + Object.keys(userSection).join(', ') +
      ') — only review.model/review.reasoning_effort can be overridden from the user file; the shipped value is kept');
  }
  return Object.assign({}, (shippedSection && typeof shippedSection === 'object') ? shippedSection : {});
}

/** effectiveConfig(root) -> the merged {review, naming, fallback, honesty, operational_notes} object, or
 *  null when the SHIPPED file itself is missing/unreadable (fail-closed — there is nothing to merge onto).
 *  A missing/unreadable/non-object user file is NOT an error: it simply means no override is active.
 *  `_warnings` lists every override attempt that was ignored (invalid value, or a field/section the user
 *  file is not allowed to touch at all) — empty when the user file is absent or fully within its allowed
 *  scope. */
function effectiveConfig(root) {
  const shipped = readJsonSafe(shippedPathOf(root));
  if (!shipped || typeof shipped !== 'object') return null;
  const rawUser = readJsonSafe(userPathOf(root));
  const user = (rawUser && typeof rawUser === 'object' && !Array.isArray(rawUser)) ? rawUser : null;

  const warnings = [];
  const review = mergeReviewSection(shipped.review, user && user.review, warnings);
  const naming = lockedSection(shipped.naming, user && user.naming, 'naming', warnings);
  const fallback = lockedSection(shipped.fallback, user && user.fallback, 'fallback', warnings);
  const honesty = lockedSection(shipped.honesty, user && user.honesty, 'honesty', warnings);
  const operational_notes = lockedSection(shipped.operational_notes, user && user.operational_notes, 'operational_notes', warnings);

  return {
    review, naming, fallback, honesty, operational_notes,
    _source: { shipped: shippedPathOf(root), user: user ? userPathOf(root) : null, user_present: !!user },
    _warnings: warnings,
  };
}

/** buildCommand(effective, opts) -> the real CLI invocation as an ARGV ARRAY, DERIVED from the effective
 *  model / reasoning_effort. `opts.adversarial: true` swaps in the adversarial prompt prefix. Omits `-m`
 *  when model is unset, and `-c model_reasoning_effort=...` when reasoning_effort is unset — never
 *  fabricates a value for either flag.
 *
 *  WP-S14 3.1: the sandbox is HARD-CODED to `read-only` — it is never read from `effective.review.sandbox`
 *  (shipped or user) at all, so no config value, valid or not, can ever loosen it. Returns an array so the
 *  caller can pass it straight to spawn(argv[0], argv.slice(1)) with no shell involved; use
 *  commandToDisplayString() to render it for a human-readable report line only. */
function buildCommand(effective, opts) {
  const o = opts || {};
  const r = (effective && effective.review) || {};
  const model = nonEmptyString(r.model);
  const effort = nonEmptyString(r.reasoning_effort);
  const argv = ['codex', 'exec'];
  if (model) argv.push('-m', model);
  if (effort) argv.push('-c', 'model_reasoning_effort=' + effort);
  argv.push('-s', 'read-only'); // hard-coded — see the doc comment above; never derived from config
  argv.push(o.adversarial ? 'ADVERSARIAL CODE REVIEW. <focus>' : '<review prompt>');
  return argv;
}

/** commandToDisplayString(argv) -> a human-readable, space-joined rendering of an argv array (quoting any
 *  argument that contains whitespace). Display/report use ONLY — never re-parsed or executed; the real
 *  invocation always uses the argv array itself. */
function commandToDisplayString(argv) {
  return (Array.isArray(argv) ? argv : []).map((a) => (/\s/.test(String(a)) ? JSON.stringify(String(a)) : String(a))).join(' ');
}

/** modelLabel/effortLabel(effective) -> a human-honest label for reports/prose. Never a fabricated model
 *  name: an unset pin reports the literal, explicit "Codex default model"/"Codex default effort" string
 *  so a reader can never mistake "unpinned" for "pinned to something unnamed". */
function modelLabel(effective) { return nonEmptyString(effective && effective.review && effective.review.model) || 'Codex default model'; }
function effortLabel(effective) { return nonEmptyString(effective && effective.review && effective.review.reasoning_effort) || 'Codex default effort'; }

/** isPinned(effective) -> true only when a real, non-empty model is set (by shipped default or by the
 *  user override) — the single place "is there an active pin at all?" is decided. */
function isPinned(effective) { return !!nonEmptyString(effective && effective.review && effective.review.model); }

/** resolveCodexBin(env, platform) -> the executable to spawn for a real run. FORGE_CODEX_BIN wins (a real
 *  per-machine binary path or a hermetic test's fake binary). Otherwise 'codex' (PATH lookup, no shell) —
 *  except on Windows, where `npm install -g @openai/codex` (the documented install) only puts a `codex.cmd`
 *  shim on PATH, which a shell:false spawn cannot start (see runCodex()). There the PATH is searched for a
 *  real `codex.exe` first, then for the npm shim's own script (`<dir>/node_modules/@openai/codex/bin/codex.js`
 *  next to `<dir>/codex.cmd`), which runCodex() runs as `node <script>` — still no shell, and a fresh laptop
 *  needs no hand-set variable. Never read from either config file, so a gitignored/unreviewed file can never
 *  redirect what actually gets executed. `env`/`platform` default to this process (injectable for tests). */
function resolveCodexBin(env, platform) {
  const e = env || process.env;
  const plat = platform || process.platform;
  if (e.FORGE_CODEX_BIN) return e.FORGE_CODEX_BIN;
  if (plat === 'win32') {
    const pathKey = Object.keys(e).find((k) => k.toUpperCase() === 'PATH');
    const dirs = String(pathKey ? e[pathKey] : '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
    for (const d of dirs) {
      const exe = path.join(d, 'codex.exe');
      if (fs.existsSync(exe)) return exe;
      if (fs.existsSync(path.join(d, 'codex.cmd'))) {
        const script = path.join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (fs.existsSync(script)) return script;
      }
    }
  }
  return 'codex';
}

/** runCodex(effective, opts) -> the ONE real, runnable, no-shell invocation route (N3 fix, 2026-09-26
 *  independent review: "spawn argv with no shell" had no runnable route for an agent that only has
 *  Bash/PowerShell tools — this function IS that route; an agent runs it via a single CLI call instead of
 *  constructing the spawn itself). Always `shell:false` — no shell EVER parses the model/effort/prompt
 *  values, however they were validated, so nothing in them can smuggle a second command. `opts.prompt`,
 *  when a non-empty string, REPLACES the trailing prompt-placeholder argv element with the real review
 *  text — still exactly one argv element, never concatenated into a shell string. `opts.dryRun` resolves
 *  and returns the exact argv without spawning anything (safe to call with no codex installed at all).
 *
 *  codexBin resolution: `opts.codexBin` / FORGE_CODEX_BIN, defaulting to 'codex'. When it ends in
 *  .js/.cjs/.mjs it is run as `node <that script> <args>` instead of being exec'd directly — Windows
 *  cannot execute a script file as a process image on its own, and this is the one honest way to stand in
 *  a tiny fake "codex" for a hermetic test on every OS without a compiled binary; it NEVER activates for
 *  the real 'codex' name, only when the operator/test explicitly points at a script file.
 *
 *  A `.cmd`/`.bat` codex install (possible on Windows for an npm-shimmed CLI) is NOT silently worked
 *  around with a shell: verified live on this Node (v24, win32) — a bare `.cmd` name spawns ENOENT and an
 *  absolute `.cmd` path spawns EINVAL under shell:false (Node's own CVE-2024-27980 mitigation), and
 *  `shell:true` with an argv array is Node's own documented "arguments are not escaped, only concatenated"
 *  footgun (reproduced live: a crafted "prompt" containing ` & echo ... ` executed as a second command)
 *  — so this function never falls back to it. That spawn failure is reported honestly in `spawn_error`,
 *  never silently swallowed and never retried with a shell; the caller is told to point FORGE_CODEX_BIN at
 *  a real executable (or the shim's underlying script, run via node) instead. */
function runCodex(effective, opts) {
  const o = opts || {};
  const codexBin = o.codexBin || resolveCodexBin();
  const argv = buildCommand(effective, { adversarial: !!o.adversarial });
  const finalArgv = argv.slice();
  // A prompt that starts with `-` would reach codex as an OPTION, not as the prompt (the same smuggling
  // route the MODEL_PATTERN leading-dash rule closes: `--prompt "--dangerously-bypass-approvals-and-sandbox"`).
  // Refused before anything is spawned; a real review prompt never needs to start with a dash.
  if (typeof o.prompt === 'string' && /^-/.test(o.prompt)) {
    return { dry_run: !!o.dryRun, codex_bin: codexBin, argv: finalArgv, exec_target: null, exec_args: [], status: -1, stdout: '', stderr: '', spawn_error: null,
      refused: 'the prompt starts with "-", so codex would read it as an option instead of the prompt — start it with a word' };
  }
  if (typeof o.prompt === 'string' && o.prompt.trim()) finalArgv[finalArgv.length - 1] = o.prompt;
  const args = finalArgv.slice(1); // argv[0] is always the literal 'codex' label; codexBin is the real target
  const isScript = SCRIPT_EXT_RE.test(codexBin);
  const execTarget = isScript ? process.execPath : codexBin;
  const execArgs = isScript ? [codexBin].concat(args) : args;

  if (o.dryRun) {
    return { dry_run: true, codex_bin: codexBin, argv: finalArgv, exec_target: execTarget, exec_args: execArgs, status: null, stdout: '', stderr: '', spawn_error: null };
  }
  const r = spawnSync(execTarget, execArgs, { shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    dry_run: false, codex_bin: codexBin, argv: finalArgv, exec_target: execTarget, exec_args: execArgs,
    status: (r.status === null || r.status === undefined) ? -1 : r.status,
    stdout: r.stdout || '', stderr: r.stderr || '',
    spawn_error: r.error ? (String(r.error.code || '') + ': ' + String(r.error.message || r.error)) : null,
  };
}

module.exports = {
  shippedPathOf, userPathOf, effectiveConfig, buildCommand, commandToDisplayString, modelLabel, effortLabel, isPinned,
  resolveCodexBin, runCodex,
  MODEL_PATTERN, ALLOWED_EFFORTS,
};

function parseRunArgs(rest) {
  const o = { adversarial: false, prompt: null, root: null, dryRun: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--adversarial') o.adversarial = true;
    else if (a === '--prompt') o.prompt = rest[++i];
    else if (a === '--root') o.root = rest[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
  }
  return o;
}

function printShow(root) {
  const eff = effectiveConfig(root);
  if (!eff) { console.error('no readable codex-review.json under ' + shippedPathOf(root)); process.exit(2); }
  const cmd = buildCommand(eff, { adversarial: false });
  const advCmd = buildCommand(eff, { adversarial: true });
  console.log(JSON.stringify({
    effective: eff,
    model: modelLabel(eff), effort: effortLabel(eff), pinned: isPinned(eff),
    command: cmd, command_display: commandToDisplayString(cmd),
    adversarial_command: advCmd, adversarial_command_display: commandToDisplayString(advCmd),
  }, null, 2));
}

function runRunCommand(rest) {
  const opts = parseRunArgs(rest);
  const root = opts.root ? path.resolve(opts.root) : path.resolve(__dirname, '..', '..');
  const eff = effectiveConfig(root);
  if (!eff) { console.error('forge-codexreview-config: no readable codex-review.json under ' + shippedPathOf(root)); process.exit(2); }
  for (const w of eff._warnings) console.error('forge-codexreview-config: ' + w);
  if (!opts.dryRun && !(typeof opts.prompt === 'string' && opts.prompt.trim())) {
    console.error('forge-codexreview-config: "run" needs --prompt "<the review prompt or focus>" (or --dry-run to only show the command) — codex is never started with the placeholder text.');
    process.exitCode = 2;
    return;
  }
  const result = runCodex(eff, { adversarial: opts.adversarial, prompt: opts.prompt, dryRun: opts.dryRun });
  if (result.refused) {
    if (opts.json) console.log(JSON.stringify(result));
    console.error('forge-codexreview-config: refused — ' + result.refused + '.');
    process.exitCode = 2;
    return;
  }
  const display = commandToDisplayString(result.argv);
  if (opts.json) {
    console.log(JSON.stringify(Object.assign({ command_display: display }, result)));
  } else {
    console.log((result.dry_run ? 'DRY RUN — would run: ' : 'ran: ') + display);
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.spawn_error) {
      console.error('forge-codexreview-config: could not spawn "' + result.codex_bin + '" without a shell (' + result.spawn_error + ').');
      console.error('forge-codexreview-config: set FORGE_CODEX_BIN to the real codex executable path — never falls back to a shell (that would reopen WP-S14 3.1).');
    }
  }
  process.exitCode = result.dry_run ? 0 : (result.spawn_error ? 2 : result.status);
}

if (require.main === module) {
  const argv2 = process.argv.slice(2);
  if (argv2[0] === 'run') {
    runRunCommand(argv2.slice(1));
  } else {
    printShow(path.resolve(__dirname, '..', '..'));
  }
}
