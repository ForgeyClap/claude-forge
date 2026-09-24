#!/usr/bin/env node
'use strict';
/**
 * forge-toolhook.cjs — the tool-behaviour LEDGER: one compact line per real tool call, written by a
 * `PostToolUse` hook, i.e. by the harness — NOT by the agent that made the call.
 *
 * ---------------------------------------------------------------------------------------------------
 * WHY IT EXISTS (measured 2026-08-01, not assumed)
 * ---------------------------------------------------------------------------------------------------
 * Across all 28 `events.jsonl` in this project: 846 events, of which `file_read` 0 and `command_run` 1.
 * Both types ARE registered in `forge-dashboard/log-event.cjs`; they are simply never written, because an
 * agent has to log them by hand and doesn't. `grep`, `test_run` and `tool_call` are not even in the
 * vocabulary. Consequence: "I ran the tests" is a CLAIM in this project, with nothing to contradict it.
 * That is precisely the hole the honesty rules are supposed to close.
 *
 * It is now measured that a hook CAN close it: a temporary probe recorded 10 real invocations, including
 * `PostToolUse` inside Agent-tool subagents (`agent_type: general-purpose` on its own Glob/Read, and
 * `agent_type: workflow-subagent` on concurrently running agents). See
 * `config/orchestration/HOOKS_OPT_IN.md`'s 2026-08-01 correction. The payload carries: session_id,
 * transcript_path, cwd, prompt_id, permission_mode, agent_id, agent_type, effort, hook_event_name,
 * tool_name, tool_input, tool_response, tool_use_id, duration_ms.
 *
 * ---------------------------------------------------------------------------------------------------
 * WHERE IT WRITES — and why NOT into the run's events.jsonl
 * ---------------------------------------------------------------------------------------------------
 *   `.claude/forge-runs/_toollog/<session_id>.jsonl`  (+ one rotated generation `<session_id>.1.jsonl`)
 *
 * 1. VOLUME / BLAST RADIUS. `events.jsonl` is a run's NARRATIVE ledger, read whole by forge-verify,
 *    forge-manifest, forge-briefing, forge-certify, the chain check, and every Command Center lens. A run
 *    can make thousands of tool calls; injecting them there would drown the real events and silently change
 *    what every one of those consumers measures (event counts, "last event", stall detection). It would
 *    also force a new registered `event_type` and a rendering decision in each of them. A separate file
 *    changes nothing that already works.
 * 2. COST PER CALL. This fires on EVERY tool call in a live session. Resolving "which run is running" the
 *    way `forge-snapshot.cjs` does (rank every run dir, then read and parse each run's events to find the
 *    newest with real work) is O(all runs x all events) — unaffordable at tool-call frequency, and it would
 *    mean loading the 123 KB `forge-doctor.cjs` in every hook process. Partitioning by `session_id` is O(1)
 *    and needs no filesystem scan at all.
 * 3. CORRECTNESS. That same mtime-based run picker is documented in `forge-snapshot.cjs` as having actively
 *    misrouted to a throwaway `doctor-selfcheck-<pid>/` directory. Doctor creates those constantly — and
 *    this hook fires DURING a doctor run — so a write-time run guess would demonstrably scatter the ledger
 *    into throwaway dirs. Reproducing a known-broken heuristic at 1000x the frequency is a regression by
 *    design.
 * 4. TRUST. The partition key comes from the hook payload, the same untamperable source as the rest of the
 *    line. An agent can create a run directory; it cannot change its own `session_id`.
 * 5. JOINING IS A READ-TIME PROBLEM, AND IT IS EXACT. `tool_use_id` is the SAME id that appears as
 *    `dispatch_id` on `agent_started`/`subagent_started` events (log-event.cjs's DISPATCH_PROOF_EVENTS), so
 *    a reader can join this log to a run precisely, instead of this hook guessing at write time. When the
 *    orchestrator already knows the run, `FORGE_RUN_ID` (or opts.runId) stamps it on the line for free.
 * 6. IT COSTS NOTHING TO PLACE IT THERE. `_toollog/` sits under `.claude/forge-runs/`, so the EXISTING
 *    per-run-contents .gitignore rule already makes it uncommittable (proven by test G3 — no .gitignore
 *    edit needed; NOTE: never write that rule's literal star-slash-star glob inside this block comment —
 *    it closes the comment early and breaks the file, the same trap forge-secret-scrub.cjs documents in
 *    its own header). Because it carries neither `run.json` nor `events.jsonl`, every run picker
 *    in the codebase skips it by its existing filter (forge-doctor.cjs::rankRunCandidates, the Command
 *    Center's runs.mjs, the chain check). `.hotspot-locks` is the existing precedent for exactly this.
 *
 * NO NEW EVENT TYPE is introduced, so the 3-place registration rule (log-event.cjs KNOWN_EVENT_TYPES +
 * forge-verify.cjs classification set + forge-dashboard/app.js taskStatus/SYNTH) does not apply here.
 * Test G1 enforces that claim statically: this file must never reference `log-event` or `events.jsonl`.
 *
 * ---------------------------------------------------------------------------------------------------
 * WHAT IT RECORDS — behaviour, never content
 * ---------------------------------------------------------------------------------------------------
 *   { ts, session, agent_id, agent_type, tool, target, target_kind, ok, ok_basis, ms, tool_use_id,
 *     permission_mode?, run?, truncated?, line_trimmed? }
 *
 * `target` is a SUMMARY, never an argument list: a file path (project-relative when inside the project),
 * or a command's CANONICAL NAME (see below), or a URL's HOST only (query strings carry tokens), or a
 * subagent/skill name. A Grep/Glob PATTERN is never stored — it is content. `tool_input` bodies
 * (old_string/new_string/prompt) and `tool_response` bodies are never stored; only a derived success
 * boolean plus the BASIS for it (`ok_basis`), so a reader knows whether success was asserted by the tool or
 * merely inferred.
 *
 * ---------------------------------------------------------------------------------------------------
 * SCRUBBING — one gate, at serialisation, keyed by nothing (rebuilt 2026-08-01 after 7 measured leaks)
 * ---------------------------------------------------------------------------------------------------
 * An independent witness reproduced seven leaks through the real CLI subprocess and then found the canary
 * markers ON DISK. Three root causes, three structural fixes — none of them a new pattern in a list:
 *
 *   1. Scrubbing was PER FIELD, and only `target` had it. `agent_type`, `permission_mode`, `tool_use_id`,
 *      `agent_id`, `tool` and `session` went to disk raw. Fixed by moving the gate to serialize(): every
 *      string in whatever record is handed over is redacted through `forge-store.cjs`'s SECRET_PATTERNS
 *      (the single scrub source of truth this project already trusts), so a field invented tomorrow is
 *      covered on the day it is added. If that module cannot be loaded, the record DEGRADES to the values
 *      this file produced itself rather than being written unvouched.
 *   2. The leading-assignment skip was POSIX-only (`NAME=value `), and PowerShell — this project's main
 *      shell — writes `$pw="…";` and `$env:NAME="…";` with no space anywhere. The whole assignment became
 *      "the first token". Fixed by ASSIGN_PREFIX_RE, which covers both shells' forms with and without
 *      spaces and consumes `;`/`&`/`|` separators.
 *   3. The EXECUTABLE NAME can itself be the secret (`./hunter2….sh --go`), which no rule can detect.
 *      Fixed by never deriving the name from input: a command target is a constant from KNOWN_COMMANDS or
 *      nothing at all. See the block above KNOWN_COMMANDS for the usability that buys the safety.
 *
 * `session` is the one field a redaction marker cannot repair, because it is also the log's FILENAME —
 * so an id the scrubber would alter is refused into `unknown-session` instead (see sessionBucket).
 *
 * ---------------------------------------------------------------------------------------------------
 * LIVE-SESSION CONTRACT (non-negotiable — this runs on every tool call of every agent)
 * ---------------------------------------------------------------------------------------------------
 *   - NEVER throws. Every failure path is caught and returned as {ok:false, reason}; the CLI always exit 0.
 *   - NEVER blocks: no `decision:"block"`, no non-zero exit, ever.
 *   - NEVER writes stdout. Not one byte, on any path. Diagnostics go to a size-capped local file.
 *   - Owner setting `tool-log` (v2.7.0, forge-config.cjs; default ON): OFF -> run() returns
 *     {ok:true, wrote:false, skipped:true, reason:'owner config tool-log=off'} before parsing the payload —
 *     no ledger line, no diagnostics line, exit 0. Read for the root this hook acts on (FORGE_PROJECT_ROOT,
 *     the resolver's own seam, wins when set). forge-config.cjs is soft-required and read through its fail-safe
 *     safeGet(): absent, throwing or a damaged settings file -> the schema default (ON; `tool-log` carries no
 *     data flag) plus a `config_note` in the returned result (stdout stays silent), so a missing or damaged
 *     settings file can neither break a tool call nor silently switch the ledger off. opts.configModule injects
 *     a module in tests (null = "absent").
 *   - Has its OWN hard timeout (FAILSAFE_MS) well under the settings timeout, so it self-terminates before
 *     the harness ever has to wait on it.
 *   - Bounded work: only the first HEAD_BYTES of stdin is retained (the rest is drained and dropped); an
 *     oversized/unparseable payload falls back to bounded regex SALVAGE so the call is still recorded,
 *     honestly marked `truncated:true`, instead of being silently lost.
 *   - Bounded disk: every line is capped (MAX_LINE_BYTES) and the file rotates at MAX_LOG_BYTES keeping
 *     exactly one previous generation.
 *
 * MODEL (pure and testable without a real stdin pipe or a real session):
 *   summarizeTarget(toolName, toolInput, root) -> { target, target_kind }
 *   deriveOk(toolResponse)                     -> { ok, ok_basis }
 *   sessionBucket(sessionId)                   -> safe filename component
 *   buildLine(payload, opts)                   -> the record object
 *   run(rawStdinJson, opts)                    -> { ok, wrote, path, reason, rotated, line, skipped? }
 *
 * CLI: reads stdin, calls run(), ALWAYS exits 0, ALWAYS silent.
 *   opts: { root, runId, now, truncated, headBytes, maxLogBytes, configModule }
 */
const fs = require('fs');
const path = require('path');

const MAX_TARGET_CHARS = 200;      // a string field is a label, not a payload — one cap for ALL of them
const MAX_LINE_BYTES = 2048;       // hard cap per written line
const MAX_LOG_BYTES = 4 * 1024 * 1024; // rotate at 4 MB (~20k lines); 1 kept generation => <=8 MB/session
const HEAD_BYTES = 262144;         // only the first 256 KB of stdin is retained; tool_input precedes tool_response
const DIAG_MAX_BYTES = 65536;      // a broken hook must not fill the disk with its own complaints
const FAILSAFE_MS = 2500;          // self-terminate well under the proposed 5000ms settings timeout
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;  // also the path-traversal guard for the filename
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath'];
const LOG_DIRNAME = '_toollog';

// Single scrub source of truth (forge-store.cjs's SECRET_PATTERNS — the exact set forge-doctor's leak scan
// and forge-secret-scrub.cjs already trust). Loaded once per process, never duplicated here: a second copy
// of the pattern list would drift. If it cannot be loaded we do not fall back to a weaker home-made
// scrubber — we omit the target entirely (see scrub()).
// `redactFn` takes ANY value (string / array / object) because store.redactValue is recursive and uses each
// KEY as a hint — which is what makes the record-level gate in scrubRecord() field-agnostic.
let redactFn = null;
try {
  const store = require('./forge-store.cjs'); // eslint-disable-line global-require
  if (typeof store.redactValue === 'function') redactFn = (v) => store.redactValue(v);
} catch { redactFn = null; }

// Owner settings (forge-config.cjs, v2.7.0) — soft-required, see the LIVE-SESSION CONTRACT above.
let cfg = null;
try { cfg = require('./forge-config.cjs'); } catch { cfg = null; }
/** configRead(key, fallback, opts) -> { value, source, degraded, reason } via forge-config.safeGet (FAIL-SAFE,
 *  review-boss M3: a damaged settings file never switches a flagged feature on). `fallback` is this file's copy of
 *  the schema default, used only when forge-config.cjs is absent or broken; an older copy without safeGet is read
 *  through get(). Never throws. opts.projectRoot = the root this hook acts on (ignored when FORGE_PROJECT_ROOT is
 *  set); opts.configModule injects a module (tests; null = "absent"). */
function configRead(key, fallback, opts) {
  opts = opts || {};
  const mod = opts.configModule !== undefined ? opts.configModule : cfg;
  const o = opts.projectRoot && !process.env.FORGE_PROJECT_ROOT ? { projectRoot: opts.projectRoot } : {};
  let why = 'forge-config.cjs not found';
  try {
    if (mod && typeof mod.safeGet === 'function') {
      const r = mod.safeGet(key, Object.assign({ fallback }, o));
      if (r && typeof r.value === typeof fallback) return r;
      why = 'forge-config gave no usable value';
    } else if (mod && typeof mod.get === 'function') {
      const e = mod.get(key, o);
      if (e && typeof e.value === typeof fallback) return { value: e.value, source: e.source || 'unknown', degraded: false, reason: null };
      why = 'forge-config gave a value of the wrong type';
    }
  } catch (e) { why = 'settings unreadable: ' + ((e && e.message) || e); }
  return { value: fallback, source: 'built-in', degraded: true, reason: why + ' — ' + key + ' uses the built-in ' + JSON.stringify(fallback) };
}
/** configOn(key, def, opts) -> just the value of configRead(). */
function configOn(key, def, opts) { return configRead(key, def, opts).value; }

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' && v.length ? v : null; }
function capStr(v) {
  return (typeof v === 'string' && v.length > MAX_TARGET_CHARS) ? v.slice(0, MAX_TARGET_CHARS - 1) + '…' : v;
}

/** scrub — redact, then cap. Redaction runs on the FULL string, before any truncation, so a pattern can
 *  never be cut in half and missed (the old 1000-char pre-slice quietly broke that promise; a secret
 *  straddling char 1000 lost only its tail and left a readable head behind).
 *  Returns undefined when no scrubber is available: an unscrubbed string must never reach disk. */
function scrub(s) {
  if (typeof s !== 'string' || !s.length) return null;
  if (!redactFn) return undefined;
  let out;
  try { out = redactFn(s); } catch { return undefined; }
  if (typeof out !== 'string') return undefined;
  return capStr(out);
}
function done(target, kind) {
  const t = scrub(target);
  if (t === undefined) return { target: null, target_kind: 'scrubber-unavailable' };
  return t === null ? { target: null, target_kind: 'none' } : { target: t, target_kind: kind };
}

function relPath(p, root) {
  if (typeof p !== 'string' || !p.length) return null;
  if (!root) return p;
  try {
    const abs = path.resolve(p);
    const r = path.resolve(root);
    if (abs === r) return '.';
    if (abs.startsWith(r + path.sep)) return path.relative(r, abs) || '.';
  } catch { /* an unresolvable path is kept verbatim — it is still the honest target */ }
  return p;
}

// ---------------------------------------------------------------------------------------------------
// LEADING ASSIGNMENTS — shell-agnostic (leaks B1/B2, measured 2026-08-01)
// ---------------------------------------------------------------------------------------------------
// The old guard was `^NAME=value` + REQUIRED trailing whitespace: POSIX-only, and it demanded a space that
// PowerShell never writes. PowerShell is this project's MAIN shell, so its idioms are the LIKELIEST form
// in practice, and every one of them slipped through — `$pw="hunter2…"; node login.js` matched nothing, so
// the whole assignment became "the first token" and the password was written verbatim to disk.
// The forms this now covers, taken from the measured cases:
//   POSIX      NAME=value cmd            NAME=value; cmd
//   PowerShell $pw="value"; cmd          $pw = "value" ; cmd          $pw='value'; cmd
//   PowerShell $env:NAME="value"; cmd    $env:NAME = "value" ; cmd    ${env:NAME}="value"; cmd
// Separators (`;` `&` `|` `&&` `||`) are consumed as well as spaces, because the no-space PowerShell form
// has no whitespace to key on at all. Every quantifier is upper-bounded and the alternation branches are
// anchored at `^`, so this stays linear and ReDoS-free at per-tool-call frequency.
const ASSIGN_PREFIX_RE = new RegExp(
  '^(?:'
  + '\\$(?:\\{[^}\\s]{1,80}\\}|[A-Za-z_][A-Za-z0-9_]{0,64}(?::[A-Za-z_][A-Za-z0-9_]{0,64})?)' // $pw · $env:NAME · ${env:NAME}
  + '|[A-Za-z_][A-Za-z0-9_]{0,64}'                                                            // POSIX NAME
  + ')'
  + '[ \\t]{0,8}=[ \\t]{0,8}'
  + '(?:"[^"]{0,512}"|\'[^\']{0,512}\'|[^\\s;&|]{0,512})'
  + '[ \\t]{0,8}[;&|]{0,3}[ \\t]{0,8}'
);

/** firstToken — the executable token only. Leading assignments in ANY of this project's shells are skipped
 *  (a key in an env prefix must never land on disk) and a quoted program path is kept whole. Everything
 *  after it — every flag, every argument, every heredoc — is dropped and never seen again.
 *  NOTE: this returns the RAW token; it is not what gets written. See canonicalCommand(). */
function firstToken(cmd) {
  let s = String(cmd).trim();
  for (let guard = 0; guard < 8; guard++) {
    const m = ASSIGN_PREFIX_RE.exec(s);
    if (!m || !m[0].length) break;
    s = s.slice(m[0].length);
  }
  if (!s.length) return null;
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end > 0) return s.slice(1, end);
  }
  const sp = s.search(/\s/);
  return sp === -1 ? s : s.slice(0, sp);
}

// ---------------------------------------------------------------------------------------------------
// THE EXECUTABLE NAME CAN ITSELF BE THE SECRET (leak X1, measured 2026-08-01)
// ---------------------------------------------------------------------------------------------------
// `./hunter2CorrectHorseBatteryStaple.sh --go` — the "first token" rule offers no protection here BY
// DEFINITION, and the scrubber cannot help either: a password with no recognised key format is
// indistinguishable from a script name. Nothing can decide, at this point, whether a name is a secret.
//
// So the name is never DERIVED from the input at all. A command target is either a string that already
// exists as a literal constant in this file, or it is nothing. The input only ever selects an entry; it
// never contributes bytes. The set of values `target` can take for a command is therefore finite and fixed
// at build time, which makes this case safe by construction rather than by pattern-matching luck.
//
// PRICE PAID (deliberate, see the file header): any executable that is not on this list is recorded as
// `target:null, target_kind:'command-unlisted'`. You still get proof that a command ran, from which agent,
// when, how long it took and whether it succeeded — but not WHICH command. Custom scripts, project
// binaries and one-off tools are exactly the population that loses its name. That is accepted: an
// unnamed-but-counted command call is a smaller loss than a password written into a permanent ledger.
const KNOWN_COMMANDS = [
  // JS/TS
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'tsc', 'ts-node', 'eslint', 'prettier',
  'jest', 'vitest', 'mocha', 'playwright', 'cypress', 'nodemon', 'pm2', 'serve', 'http-server', 'concurrently',
  // VCS
  'git', 'gh', 'svn', 'hg',
  // Python / Ruby / PHP
  'python', 'python3', 'py', 'pip', 'pip3', 'pytest', 'poetry', 'uv', 'ruff', 'black', 'mypy', 'conda',
  'ruby', 'gem', 'bundle', 'rake', 'rails', 'php', 'composer',
  // Compiled toolchains
  'go', 'gofmt', 'golangci-lint', 'cargo', 'rustc', 'rustup', 'java', 'javac', 'mvn', 'gradle', 'gradlew',
  'kotlin', 'kotlinc', 'dotnet', 'nuget', 'msbuild', 'swift', 'xcodebuild', 'make', 'cmake', 'ninja',
  'gcc', 'g++', 'clang', 'clang++',
  // Cloud / infra
  'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'terraform', 'ansible', 'vagrant',
  'aws', 'az', 'gcloud', 'flyctl', 'vercel', 'netlify', 'wrangler', 'heroku', 'supabase', 'railway',
  // Shells
  'bash', 'sh', 'zsh', 'fish', 'dash', 'pwsh', 'powershell', 'cmd', 'wsl',
  // Network
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ping', 'netstat',
  // POSIX-ish file & text tools
  'cat', 'ls', 'dir', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'ln', 'chmod', 'chown', 'stat',
  'du', 'df', 'find', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'sed', 'awk', 'cut', 'sort', 'uniq',
  'head', 'tail', 'wc', 'tr', 'tee', 'xargs', 'echo', 'printf', 'diff', 'patch', 'tar', 'zip', 'unzip',
  'gzip', 'gunzip', '7z',
  // Process / environment
  'ps', 'top', 'kill', 'taskkill', 'tasklist', 'which', 'where', 'whoami', 'env', 'printenv', 'set',
  'cd', 'pwd', 'sleep', 'timeout', 'date', 'hostname', 'start', 'open', 'explorer', 'xdg-open',
  // Data / editors / misc
  'jq', 'yq', 'sqlite3', 'psql', 'mysql', 'mongo', 'mongosh', 'redis-cli',
  'code', 'vim', 'nvim', 'nano', 'emacs', 'less', 'more', 'man',
  'claude', 'codex', 'ollama', 'n8n',
  // PowerShell cmdlets (explicit, not a Verb-Noun shape rule: a shape rule would let arbitrary input bytes
  // through the noun half, which is exactly the property this list exists to deny)
  'Get-ChildItem', 'Get-Content', 'Get-Command', 'Get-Item', 'Get-ItemProperty', 'Get-Date', 'Get-Process',
  'Get-Location', 'Get-Member', 'Set-Content', 'Set-Location', 'Set-ItemProperty', 'New-Item', 'New-Object',
  'Remove-Item', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Test-Path', 'Join-Path', 'Resolve-Path',
  'Select-String', 'Select-Object', 'Where-Object', 'ForEach-Object', 'Sort-Object', 'Measure-Object',
  'Group-Object', 'Compare-Object', 'Out-File', 'Out-String', 'Write-Output', 'Write-Host', 'Write-Error',
  'Start-Process', 'Stop-Process', 'Start-Sleep', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Invoke-Expression',
  'ConvertTo-Json', 'ConvertFrom-Json', 'Expand-Archive', 'Compress-Archive', 'Push-Location', 'Pop-Location',
];
const COMMAND_INDEX = new Map(KNOWN_COMMANDS.map((n) => [n.toLowerCase(), n]));
const EXE_EXT_RE = /\.(exe|cmd|bat|com|ps1|psm1|sh|bash|js|cjs|mjs|py)$/i;

/** canonicalCommand — map a raw executable token onto an entry of KNOWN_COMMANDS, or onto nothing. The
 *  RETURNED string is always the constant from the list, never the caller's bytes: `NODE.EXE`,
 *  `C:/Program Files/nodejs/node.exe` and `/usr/local/bin/node` all become the literal `node`. */
function canonicalCommand(token) {
  if (typeof token !== 'string' || !token.length) return null;
  let base = token;
  const cut = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
  if (cut >= 0) base = base.slice(cut + 1);
  base = base.replace(EXE_EXT_RE, '');
  if (!base.length || base.length > 64) return null;
  return COMMAND_INDEX.get(base.toLowerCase()) || null;
}

/** hostOf — host only. Userinfo (`user:pass@`) and the whole path/query are discarded: an access token in
 *  a query string is exactly the kind of thing this ledger must never immortalize. */
function hostOf(u) {
  const m = /^[A-Za-z][A-Za-z0-9+.\-]{0,30}:\/\/(?:[^@/\s]{0,256}@)?([^/?#\s:]{1,256})/.exec(String(u));
  return m ? m[1] : null;
}

/** summarizeTarget — WHAT the call acted on, in one safe label. Order matters: an explicit path beats a
 *  command beats a URL beats a dispatch/skill name. A Grep/Glob `pattern` is deliberately unreachable
 *  here — a search pattern is content (it can encode the very secret being hunted for). */
function summarizeTarget(toolName, toolInput, root) {
  if (!isPlainObject(toolInput)) return { target: null, target_kind: 'none' };
  for (const k of PATH_KEYS) {
    if (typeof toolInput[k] === 'string' && toolInput[k].length) return done(relPath(toolInput[k], root), 'path');
  }
  if (typeof toolInput.command === 'string' && toolInput.command.trim().length) {
    // NOT done(): the value written here is a constant from KNOWN_COMMANDS, never input bytes. An
    // unrecognised executable is recorded as a counted-but-unnamed call rather than guessed at (leak X1).
    const known = canonicalCommand(firstToken(toolInput.command));
    return known ? { target: known, target_kind: 'command' } : { target: null, target_kind: 'command-unlisted' };
  }
  if (typeof toolInput.url === 'string' && toolInput.url.length) return done(hostOf(toolInput.url), 'url_host');
  if (typeof toolInput.subagent_type === 'string' && toolInput.subagent_type.length) return done(toolInput.subagent_type, 'subagent');
  if (typeof toolInput.skill === 'string' && toolInput.skill.length) return done(toolInput.skill, 'skill');
  return { target: null, target_kind: 'none' };
}

/** deriveOk — did it succeed, and on WHAT basis. The basis is recorded because "true because the tool said
 *  so" and "true because something came back" are different claims, and a ledger that blurs them is the
 *  same kind of unearned confidence this file exists to eliminate. Never guesses true from nothing. */
function deriveOk(toolResponse) {
  if (toolResponse === undefined || toolResponse === null) return { ok: null, ok_basis: 'absent' };
  if (isPlainObject(toolResponse)) {
    if (toolResponse.is_error === true) return { ok: false, ok_basis: 'is_error' };
    if (typeof toolResponse.success === 'boolean') return { ok: toolResponse.success, ok_basis: 'success-field' };
    if (typeof toolResponse.error === 'string') return toolResponse.error.trim().length ? { ok: false, ok_basis: 'error-field' } : { ok: true, ok_basis: 'present' };
    if (toolResponse.error != null) return { ok: false, ok_basis: 'error-field' };
    return { ok: true, ok_basis: 'present' };
  }
  return { ok: true, ok_basis: 'present' };
}

/** sessionBucket — the partition key IS a filename component, so this is the path-traversal guard AND the
 *  one string the record-level scrubber cannot save: `***REDACTED***` is not a legal filename, so a secret
 *  here cannot be redacted IN PLACE the way every other field can. Measured leak X5 (2026-08-01): a
 *  secret-shaped session id (`sk-…`) satisfies SESSION_RE perfectly and was written as the log's FILENAME.
 *  An id the scrubber would alter is therefore refused outright into the same honest bucket as a traversal
 *  attempt — never "sanitized" into a plausible-looking new name. With no scrubber available nothing can be
 *  vouched for, so every id is refused. */
function sessionBucket(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return 'unknown-session';
  if (!redactFn) return 'unknown-session';
  let red;
  try { red = redactFn(sessionId); } catch { return 'unknown-session'; }
  return red === sessionId ? sessionId : 'unknown-session';
}

function buildLine(payload, opts) {
  opts = opts || {};
  const p = isPlainObject(payload) ? payload : {};
  const tgt = summarizeTarget(str(p.tool_name), p.tool_input, opts.root || null);
  const outcome = deriveOk(p.tool_response);
  const line = {
    ts: opts.now || new Date().toISOString(),
    session: sessionBucket(p.session_id),
    agent_id: str(p.agent_id),
    agent_type: str(p.agent_type),
    tool: str(p.tool_name),
    target: tgt.target,
    target_kind: tgt.target_kind,
    ok: outcome.ok,
    ok_basis: outcome.ok_basis,
    ms: Number.isFinite(p.duration_ms) ? p.duration_ms : null,
    tool_use_id: str(p.tool_use_id),
  };
  const pmode = str(p.permission_mode);
  if (pmode) line.permission_mode = pmode;
  if (opts.truncated) line.truncated = true;
  const rid = opts.runId != null ? String(opts.runId) : (process.env.FORGE_RUN_ID || '');
  if (rid && RUN_ID_RE.test(rid)) line.run = rid;
  return line;
}

// ---------------------------------------------------------------------------------------------------
// THE SCRUB GATE — at SERIALISATION, not per field (leaks X2/X5, measured 2026-08-01)
// ---------------------------------------------------------------------------------------------------
// Originally only `target` was scrubbed, because `target` was the only field anyone thought of as
// "content". `agent_type`, `permission_mode`, `tool_use_id`, `agent_id`, `tool` and `session` went to disk
// raw, and a real recognised key format placed in any of them was written verbatim. The bug was not the
// six missed fields — it was that the gate was per field at all, so field number seven was always going to
// be missed too. The gate now sits on the ONLY path to disk and is keyed by nothing: it walks whatever
// object it is handed. A field added to buildLine() tomorrow is covered on the day it is added, without
// anyone remembering to do anything (test H6 holds that property).
const OK_BASES = new Set(['absent', 'is_error', 'success-field', 'error-field', 'present']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]{6,16}Z?$/;

/** degraded — what a record looks like when there is no scrubber at all. Only values this file itself
 *  produced survive; every string that came from the payload is dropped rather than written unvouched. */
function degraded(src) {
  const p = isPlainObject(src) ? src : {};
  return {
    ts: (typeof p.ts === 'string' && ISO_RE.test(p.ts)) ? p.ts : null,
    session: 'unknown-session',
    tool: null,
    target: null,
    target_kind: 'scrubber-unavailable',
    ok: typeof p.ok === 'boolean' ? p.ok : null,
    ok_basis: OK_BASES.has(p.ok_basis) ? p.ok_basis : 'absent',
    ms: Number.isFinite(p.ms) ? p.ms : null,
    scrubbed: false,
  };
}

/** scrubRecord — redact EVERY string in the record (store.redactValue recurses and uses each key as a
 *  credential hint), then cap. Redact-before-cap, so a pattern is never sliced in half and missed.
 *  Idempotent: `***REDACTED***` matches no pattern, so running it twice changes nothing. */
function scrubRecord(line) {
  if (!redactFn) return degraded(line);
  const src = isPlainObject(line) ? line : {};
  let red;
  try { red = redactFn(src); } catch { return degraded(src); }
  if (!isPlainObject(red)) return degraded(src);
  const out = {};
  for (const k of Object.keys(red)) out[k] = capStr(red[k]);
  return out;
}

/** serialize — THE single gate to disk: scrub first, then enforce MAX_LINE_BYTES by degrading, never by
 *  dropping the record. Callers may hand it an already-scrubbed record; scrubbing is idempotent. */
function serialize(line) {
  const safe = scrubRecord(line);
  let s = JSON.stringify(safe);
  if (Buffer.byteLength(s, 'utf8') <= MAX_LINE_BYTES) return s;
  const trimmed = Object.assign({}, safe, { line_trimmed: true });
  if (typeof trimmed.target === 'string') trimmed.target = trimmed.target.slice(0, 80) + '…';
  if (typeof trimmed.agent_type === 'string') trimmed.agent_type = trimmed.agent_type.slice(0, 40);
  s = JSON.stringify(trimmed);
  if (Buffer.byteLength(s, 'utf8') <= MAX_LINE_BYTES) return s;
  return JSON.stringify({
    ts: safe.ts, session: safe.session, tool: String(safe.tool || '').slice(0, 40),
    target: null, target_kind: 'unavailable', ok: safe.ok, ok_basis: safe.ok_basis,
    ms: safe.ms, line_trimmed: true,
  });
}

// ---- SALVAGE: an oversized or truncated payload still proves the call happened. Bounded regexes only
// (`(?:[^"\\]|\\.){0,512}` — the two branches are disjoint on their first character, so matching is linear
// and ReDoS-free). We pull only short scalar keys; no body, no response, ever. ----
function salvageStr(head, key) {
  let m;
  try { m = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,512})"').exec(head); } catch { return null; }
  if (!m) return null;
  try { return JSON.parse('"' + m[1] + '"'); } catch { return null; }
}
function salvageNum(head, key) {
  let m;
  try { m = new RegExp('"' + key + '"\\s*:\\s*(-?\\d{1,15})').exec(head); } catch { return null; }
  return m ? Number(m[1]) : null;
}
function salvage(head) {
  const tool = salvageStr(head, 'tool_name');
  if (!tool) return null; // nothing identifiable happened — better no line than an invented one
  const p = {
    tool_name: tool,
    session_id: salvageStr(head, 'session_id'),
    agent_id: salvageStr(head, 'agent_id'),
    agent_type: salvageStr(head, 'agent_type'),
    tool_use_id: salvageStr(head, 'tool_use_id'),
    permission_mode: salvageStr(head, 'permission_mode'),
    duration_ms: salvageNum(head, 'duration_ms'),
    tool_input: {},
    tool_response: undefined, // deliberately unknown -> ok:null/'absent', never a guessed success
  };
  const fp = salvageStr(head, 'file_path');
  const cmd = fp ? null : salvageStr(head, 'command');
  const url = (fp || cmd) ? null : salvageStr(head, 'url');
  const sub = (fp || cmd || url) ? null : salvageStr(head, 'subagent_type');
  if (fp) p.tool_input.file_path = fp;
  else if (cmd) p.tool_input.command = cmd;
  else if (url) p.tool_input.url = url;
  else if (sub) p.tool_input.subagent_type = sub;
  return p;
}

function resolveProjectRoot(opts) {
  if (opts && opts.root) return path.resolve(opts.root);
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  return process.cwd();
}
/** diag — the SECOND path to disk, so it passes the same gate. An OS error message quotes the path it
 *  failed on, and that path can carry whatever was in the payload; a diagnostic must not become the leak
 *  that the ledger itself refuses to be. With no scrubber, only this file's own constant survives. */
function diag(root, obj) {
  try {
    const dir = path.join(root, '.claude');
    if (!fs.existsSync(dir)) return;
    const f = path.join(dir, '.forge-toolhook.log');
    let size = 0;
    try { size = fs.statSync(f).size; } catch { size = 0; }
    if (size > DIAG_MAX_BYTES) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
    const src = isPlainObject(obj) ? obj : {};
    const safe = redactFn
      ? scrubRecord(src)
      : { step: String(src.step || '').slice(0, 32), error: null, scrubbed: false }; // `step` is a literal in this file
    fs.appendFileSync(f, JSON.stringify(safe).slice(0, MAX_LINE_BYTES) + '\n');
  } catch { /* diagnostics are best-effort only — never allowed to throw */ }
}

/** run — see file header MODEL. NEVER throws: every failure is caught and returned. A degraded settings read
 *  (damaged FORGE_CONFIG.json, absent forge-config.cjs) adds `config_note` to whatever comes back. */
function run(rawStdinJson, opts) {
  opts = opts || {};
  let root;
  try { root = resolveProjectRoot(opts); } catch { return { ok: false, wrote: false, reason: 'no-root', path: null }; }
  const sc = configRead('tool-log', true, { projectRoot: root, configModule: opts.configModule });
  const r = sc.value === false
    ? { ok: true, wrote: false, skipped: true, reason: 'owner config tool-log=off', path: null }
    : record(rawStdinJson, opts, root);
  return sc.degraded ? Object.assign(r, { config_note: sc.reason }) : r;
}
function record(rawStdinJson, opts, root) {
  const raw = typeof rawStdinJson === 'string' ? rawStdinJson : '';
  const headBytes = Number.isFinite(opts.headBytes) ? opts.headBytes : HEAD_BYTES;

  let payload = null;
  let truncated = !!opts.truncated;
  if (!truncated && raw.length <= headBytes) {
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!isPlainObject(payload)) payload = null;
  }
  if (!payload) {
    const salvaged = salvage(raw.length > headBytes ? raw.slice(0, headBytes) : raw);
    if (salvaged) { payload = salvaged; truncated = true; }
  }
  if (!payload) return { ok: true, wrote: false, reason: 'unparseable', path: null };
  if (typeof payload.tool_name !== 'string' || !payload.tool_name.length) {
    return { ok: true, wrote: false, reason: 'no-tool_name', path: null };
  }
  // A project with no Forge install degrades SILENTLY (same convention as forge-snapshot-marker.cjs) —
  // this must never create a stray .claude/ tree in whatever directory it happens to be invoked from.
  if (!fs.existsSync(path.join(root, '.claude'))) return { ok: true, wrote: false, reason: 'no-forge-project', path: null };

  const dir = path.join(root, '.claude', 'forge-runs', LOG_DIRNAME);
  const bucket = sessionBucket(payload.session_id);
  const file = path.join(dir, bucket + '.jsonl');
  // belt-and-braces containment (SESSION_RE already forbids separators and dots)
  if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) {
    return { ok: false, wrote: false, reason: 'containment-refused', path: null };
  }

  let line;
  try {
    // scrubRecord here as well as inside serialize(): the returned `.line` is a caller-visible copy of what
    // went to disk, and it must not be the one unscrubbed copy in the system. Scrubbing is idempotent.
    line = scrubRecord(buildLine(payload, { root, truncated, runId: opts.runId, now: opts.now }));
  } catch (e) { diag(root, { step: 'build', error: e.message }); return { ok: false, wrote: false, reason: 'build-failed', path: null }; }

  const text = serialize(line) + '\n';
  const maxLog = Number.isFinite(opts.maxLogBytes) ? opts.maxLogBytes : MAX_LOG_BYTES;
  let rotated = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size > 0 && size + Buffer.byteLength(text, 'utf8') > maxLog) {
      const prev = path.join(dir, bucket + '.1.jsonl');
      try { fs.rmSync(prev, { force: true }); } catch { /* best effort */ }
      try { fs.renameSync(file, prev); rotated = true; } catch { /* keep appending rather than lose the line */ }
    }
    fs.appendFileSync(file, text, 'utf8');
  } catch (e) {
    diag(root, { ts: line.ts, step: 'append', error: e.message });
    return { ok: false, wrote: false, reason: 'write-failed: ' + e.message, path: file, rotated };
  }
  return { ok: true, wrote: true, reason: null, path: file, rotated, line };
}

module.exports = {
  run, summarizeTarget, deriveOk, sessionBucket, buildLine, serialize, salvage, scrubRecord,
  firstToken, canonicalCommand, hostOf, relPath, resolveProjectRoot, configOn, configRead,
  MAX_TARGET_CHARS, MAX_LINE_BYTES, MAX_LOG_BYTES, HEAD_BYTES, FAILSAFE_MS, LOG_DIRNAME,
  KNOWN_COMMANDS, ASSIGN_PREFIX_RE,
};

// ---- CLI (advisory hook target — ALWAYS exits 0, ALWAYS silent, NEVER blocks a tool call).
// Async stdin collection, the pattern already proven safe on Windows by forge-snapshot-marker.cjs and
// forge-hook-secret-scrub.cjs (a synchronous fd-0 read is avoided deliberately). Only the first HEAD_BYTES
// are retained; the rest is drained and dropped so a multi-megabyte tool_response can neither blow up
// memory nor stall the pipe. The failsafe timer guarantees an exit even if stdin never ends. ----
if (require.main === module) {
  let finished = false;
  const finish = () => { if (finished) return; finished = true; process.exit(0); };
  const failsafe = setTimeout(finish, FAILSAFE_MS);
  if (failsafe.unref) failsafe.unref();

  const chunks = [];
  let stored = 0;
  let dropped = false;
  process.stdin.on('data', (c) => {
    if (stored < HEAD_BYTES) { chunks.push(c); stored += c.length; }
    else dropped = true;
  });
  process.stdin.on('error', finish);
  process.stdin.on('end', () => {
    try {
      let buf = Buffer.concat(chunks);
      let truncated = dropped;
      if (buf.length > HEAD_BYTES) { buf = buf.subarray(0, HEAD_BYTES); truncated = true; }
      run(buf.toString('utf8'), { truncated });
    } catch { /* an advisory hook must never fail the tool call it observes */ }
    clearTimeout(failsafe);
    finish();
  });
  process.stdin.resume();
}
