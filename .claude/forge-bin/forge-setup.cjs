#!/usr/bin/env node
'use strict';
/**
 * forge-setup.cjs — the onboarding ENGINE behind the /setup-forge wizard. Zero-dependency,
 * Windows-safe. This is the security-critical half of first-run onboarding: it never guesses at a
 * secret, never echoes a value, and refuses to touch a project whose .env is already committed.
 *
 * WHAT THIS FILE DOES (each a CLI command + an exported function of the same shape):
 *   status      -> read markers (project .claude/.forge-setup.json, global ~/.claude/.forge-global.json)
 *                  and report onboarded?/name/lang.
 *   guard       -> STEP 0 hard invariant. Ensure .gitignore protects secrets (creates the file if
 *                  missing; append-once/grep-before-append for: .env, .env.local, .env.*.local,
 *                  .env.forge-setup; keeps !.env.example). If .env is already TRACKED by git
 *                  (`git ls-files --error-unmatch .env` exits 0), this is a hard stop: exit code 3 +
 *                  a loud warning to run `git rm --cached .env` and rotate keys. Idempotent.
 *   init-keys   -> runs guard() first (refuses if .env is tracked); writes a temp fill-file
 *                  (default .env.forge-setup) with COMMENTED placeholder lines for the keys the given
 *                  --type needs, each with one-line help + a where-to-get URL. Never overwrites a
 *                  temp file that already has real (non-comment, non-blank) content.
 *   place-keys  -> runs guard() first (refuses if .env is tracked); reads the temp file (default
 *                  .env.forge-setup, or an explicit --tmp — an absolute/"~/"/separator-containing --tmp
 *                  is used as-is, never silently re-rooted under projectDir); registers the fill-file with
 *                  .gitignore (if it lives inside the project) BEFORE reading/processing it; validates
 *                  each non-blank value (rejects placeholders like REPLACE_ME/xxxx/<...> — anchored/
 *                  whole-token, so a real secret merely CONTAINING "xxxx" mid-value stays accepted while
 *                  an obvious placeholder word with a trailing suffix like "CHANGEMENOW" is still caught —
 *                  and values that are implausibly short or missing an expected prefix); MOVES real values
 *                  into the gitignored .env via an ATOMIC temp-path+rename write (append-or-update a key,
 *                  unrelated keys/comments/line-endings/leading-BOM untouched, and an existing symlinked/
 *                  hardlinked .env is REPLACED rather than written through); best-effort chmod 600 on
 *                  .env; updates .env.example with KEY NAMES + comments only (never values). FINAL
 *                  temp-file lifecycle rule: ONLY the managed default fill-file is ever auto-deleted — a
 *                  user-pointed --tmp/--keys-from import source is NEVER deleted (but IS gitignored if
 *                  inside the project). The managed default is DELETED on a clean full success OR when
 *                  nothing real was pasted at all (nothing to lose); it is RETAINED (still gitignored)
 *                  ONLY when at least one pasted value was actually skipped/rejected, so a real secret the
 *                  user typed is never silently lost. Refuses outright (no merge, no delete) if --tmp
 *                  resolves to .env or .env.example itself — compared case-insensitively on win32/darwin
 *                  so `.ENV`/`.ENV.EXAMPLE` can't bypass the refusal on a case-insensitive filesystem.
 *                  Returns a names-only summary (stored/skipped/missing) + deletedTemp/tempRetained/
 *                  tempRetainReason/gitignored. Never prints or returns a secret value.
 *   mark        -> writes/merges the project marker (.claude/.forge-setup.json) and the global marker
 *                  (~/.claude/.forge-global.json) with {name, lang, goal, type, version, completedAt}.
 *                  --lang is validated against /^[a-z]{2}(-[A-Z]{2})?$/ and falls back to 'en' otherwise —
 *                  a marker can never be corrupted with an unvalidated/injected language token.
 *                  Idempotent — safe to re-run, always safe/idempotent to merge over an existing marker.
 *   self-heal   -> create-if-absent for required .claude/ subdirs, append-if-missing .gitignore lines,
 *                  create-if-absent .env.example skeleton. Reports ONLY what changed; never clobbers an
 *                  existing file's contents.
 *   doctor      -> PASS/FAIL lines: Node >=18, .claude/ present, .env NOT git-tracked, markers valid
 *                  (if present), skills/agents dirs present. Exit 0 if all pass, else 1. --json supported.
 *   lang        -> prints the configured language from the marker (coerced + re-validated so a corrupted
 *                  marker can never yield a garbage/injected language), or 'en' if unset.
 *
 * SECURITY INVARIANTS (all covered by forge-setup.test.cjs):
 *   - VERIFY, DON'T ASSUME: a literal .gitignore line is not proof of protection (a `!pattern` negation
 *     elsewhere defeats it under git's last-match-wins rule). guard()/ensureTmpGitignored() actually run
 *     `git check-ignore -q` against .env, the '.env.tmp-*' scratch pattern, and the resolved fill-file; if
 *     git reports NOT ignored, the same pattern is reinforced at the very END of .gitignore (beats an
 *     earlier negation) and re-checked once.
 *   - HONEST DEGRADATION: no command ever prints "git-ignored, never committed" unless git POSITIVELY
 *     confirmed it. If verification is impossible (no git / not a repo) or a fill-file lives outside the
 *     project, an honest warning/NOTE is printed instead of a false safety promise. If .env itself is
 *     DEFINITIVELY confirmed NOT ignored even after reinforcement, that is a hard stop (exit 3, same
 *     severity class as an already-tracked .env) — a secret is never written where positive evidence
 *     says it would be exposed.
 *   - FAIL-SAFE / NEVER LOSE A SECRET: the managed default fill-file is deleted only on a clean full
 *     success or when nothing real was pasted. It is retained whenever a pasted value was skipped, OR
 *     when the file has raw content lines this tool could not parse as KEY=value (export-prefixed and
 *     lone-CR lines are parsed directly; anything else unparseable is a fail-safe, never a silent delete).
 *   - ROBUST IO: every fs-touching entrypoint stats before it reads/writes — a --tmp resolving to a
 *     directory returns a clean {ok:false}, never a raw EISDIR; a non-existent --tmp subdirectory is
 *     mkdir-p'd before writing (init-keys never crashes with ENOENT, and never leaves an orphan .gitignore
 *     line for a file that was never actually created); --project validated as a real directory first.
 *   - --tmp is hard-refused (case-insensitively on win32/darwin) if it resolves to .env, .env.example,
 *     .gitignore, or anywhere inside .git/ itself.
 *   - .env is written atomically (temp-path + rename), so an existing symlinked/hardlinked .env is
 *     replaced rather than written through, and a failed write can never leave a torn/partial .env. A
 *     UTF-16-encoded existing .env is refused outright rather than silently mis-decoded (which would
 *     leave a stale secret fully readable while claiming a rotation happened).
 *   - upsertEnvFile() strips/re-prepends a leading UTF-8 BOM so a BOM-prefixed existing .env can never
 *     silently produce a duplicate key (and therefore a stale, un-rotated secret) on update.
 *   - Every command that could touch secrets refuses outright (exit code 3) if .env is already tracked
 *     by git — no gitignore rewrite, no key file, no .env write happens after that point.
 *   - No command ever echoes, logs, or returns a raw secret value — only key NAMES appear in output.
 *   - Every command is idempotent: safe to re-run with no side effect beyond convergence.
 *
 * TEST ISOLATION: every exported function takes an explicit `projectDir` (never resolves paths from
 * `__dirname` internally) so tests can point it at a throwaway os.tmpdir() fixture and never touch the
 * real repo. The one exception is the GLOBAL marker directory, which defaults to
 * `os.homedir()/.claude` — tests must override this via the `FORGE_SETUP_GLOBAL_ROOT` env var (checked
 * fresh on every call, never cached) or by passing an explicit `globalDir` argument. This mirrors the
 * FORGE_STORE_ROOT escape hatch already used by forge-store.cjs's tests.
 *
 * CLI:
 *   node .claude/forge-bin/forge-setup.cjs <command> [--project <dir>] [--json] [--quiet]
 *     status | guard | init-keys [--type <t>] [--tmp <file>] | place-keys [--tmp <file>]
 *     mark --name <n> --lang <code> [--goal <g>] [--type <t>] | self-heal | doctor | lang
 *   --project defaults to two levels up from this file (i.e. the project this forge-bin/ ships in).
 *
 * Module API: require(...) ->
 *   { status, guard, checkEnvTracked, initKeys, placeKeys, mark, selfHeal, doctor, getLang,
 *     detectKeysForType, classifyValue, looksLikePlaceholder, parseKeyValueLines, upsertEnvFile,
 *     upsertEnvExampleNames, resolveGlobalDir, readForgeVersion, validateProjectDir, resolveTmpPath,
 *     isManagedDefaultTmp, refusesAsEnvTarget, detectLineEnding, sanitizeLang, pathsEqualForFs,
 *     ensureTmpGitignored, isPathInside, detectUtf16Bom, checkGitIgnoreStatus, verifyAndReinforceIgnored,
 *     countUnparseableContentLines, isAllPlaceholderVocab, findConflictingDuplicateKeys,
 *     extractKeyValueFromLine, KEY_INFO, TYPE_KEYS, REQUIRED_GITIGNORE_LINES,
 *     KEEP_NEGATION_LINE, DEFAULT_TMP_NAME }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// ---- project dir validation ------------------------------------------------------------------------
// A non-existent --project path or a path that resolves to a FILE (not a directory) must never crash
// with a raw Node errno — every fs-touching entrypoint (guard/initKeys/placeKeys) checks this first and
// returns a clean, structured {ok:false, reason} instead.
function validateProjectDir(projectDir) {
  let st = null;
  try { st = fs.statSync(projectDir); } catch { st = null; }
  if (!st || !st.isDirectory()) {
    return { ok: false, reason: 'project dir not found: ' + projectDir };
  }
  return null;
}

// ---- gitignore guard ------------------------------------------------------------------------------
// '.env.tmp-*' covers writeFileAtomic()'s own scratch-write-then-rename filename pattern
// ('<target>.tmp-<pid>-<ts>-<rand>') so a rename+unlink double-failure never leaves an unignored
// plaintext-secret scratch file sitting next to .env.
const REQUIRED_GITIGNORE_LINES = ['.env', '.env.local', '.env.*.local', '.env.forge-setup', '.env.tmp-*'];
const KEEP_NEGATION_LINE = '!.env.example';

// STEP 0 hard invariant: is a .env already committed in this repo? Permissive-by-default when git is
// unavailable or this isn't a git repo at all — there is nothing to "already be tracked" in that case.
function checkEnvTracked(projectDir) {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', '.env'], { cwd: projectDir, encoding: 'utf8' });
  if (r.error) return { tracked: false, gitAvailable: false };
  return { tracked: r.status === 0, gitAvailable: true };
}

// ---- PRINCIPLE A: VERIFY, DON'T ASSUME -------------------------------------------------------------
// A literal line existing somewhere in .gitignore is NOT proof a path is actually ignored: git evaluates
// .gitignore patterns top-to-bottom with LAST MATCH WINS, and honors `!pattern` negation — a pre-existing
// `!.env` (or `!.env.forge-setup`, etc) anywhere AFTER our own line silently defeats it even though our
// line is technically present. `checkGitIgnoreStatus` asks git directly via `git check-ignore -q`
// (confirmed by direct probe: exit 0 = ignored, exit 1 = NOT ignored, anything else — e.g. 128 "not a git
// repository" — means we honestly cannot tell). No file needs to exist on disk for this to work; git
// evaluates the PATTERN against the given path.
function checkGitIgnoreStatus(projectDir, relPath) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', relPath], { cwd: projectDir, encoding: 'utf8' });
  if (r.error) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

// Always appends (never grep-before-append) — the whole point is to plant a FRESH occurrence at the very
// END of the file, which beats an earlier `!` negation under git's last-match-wins rule. Only called from
// verifyAndReinforceIgnored(), and only when a definitive "NOT ignored" verdict already came back — never
// called speculatively, so it cannot grow the file every run once genuinely fixed.
function appendGitignoreLineAtEnd(projectDir, line) {
  const gitignorePath = path.join(projectDir, '.gitignore');
  let content = '';
  try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch { content = '# Forge V2 — secrets (managed by forge-setup guard)\n'; }
  if (content.length > 0 && !content.endsWith('\n')) content += '\n';
  content += line + '\n';
  fs.writeFileSync(gitignorePath, content, 'utf8');
}

// Verify a path is actually ignored; if git says it isn't, reinforce (append the SAME pattern again at
// the end) and check ONCE more. Returns the final HONEST verdict — `verified` is true only when git gave
// a definitive positive-or-negative answer; `ignored` is only meaningful when `verified` is true. Never
// collapses "could not verify" into either "ignored" or "not ignored" — see PRINCIPLE B (honest
// degradation) at every call site that consumes this.
function verifyAndReinforceIgnored(projectDir, relPath) {
  const first = checkGitIgnoreStatus(projectDir, relPath);
  if (first === true) return { verified: true, ignored: true, reinforced: false };
  if (first === null) return { verified: false, ignored: false, reinforced: false };
  appendGitignoreLineAtEnd(projectDir, relPath);
  const second = checkGitIgnoreStatus(projectDir, relPath);
  return { verified: second !== null, ignored: second === true, reinforced: true };
}

// Ensure .gitignore protects secrets. Grep-before-append, create-if-missing, never rewrites/removes
// existing content — only appends lines that are not already present verbatim. ALWAYS runs (and writes)
// before the tracked-check below is even consulted, so the temp/real .env files are gitignored the
// instant this function returns, regardless of the tracked verdict. Then (PRINCIPLE A) actually asks git
// whether .env and the '.env.tmp-*' scratch pattern are REALLY ignored — not just "the line is present" —
// and reinforces once if a negation elsewhere is overriding either one.
function guard(projectDir) {
  const invalidDir = validateProjectDir(projectDir);
  if (invalidDir) {
    return {
      ok: false, path: null, created: false, appended: [], tracked: false, gitAvailable: false, reason: invalidDir.reason,
      envIgnoreVerified: false, envIgnoreConfirmed: false, envUnignorable: false,
    };
  }
  const gitignorePath = path.join(projectDir, '.gitignore');
  const existedBefore = fs.existsSync(gitignorePath);
  let content = existedBefore ? fs.readFileSync(gitignorePath, 'utf8') : '# Forge V2 — secrets (managed by forge-setup guard)\n';
  const existingLines = new Set(content.split(/\r?\n/).map((l) => l.trim()));
  const appended = [];
  const ensureLine = (line) => {
    if (existingLines.has(line)) return;
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += line + '\n';
    existingLines.add(line);
    appended.push(line);
  };
  for (const line of REQUIRED_GITIGNORE_LINES) ensureLine(line);
  ensureLine(KEEP_NEGATION_LINE);
  if (!existedBefore || appended.length > 0) fs.writeFileSync(gitignorePath, content, 'utf8');

  const envVerify = verifyAndReinforceIgnored(projectDir, '.env');
  if (envVerify.reinforced) appended.push('.env (reinforced at end of file — a negation elsewhere was overriding it)');
  const scratchVerify = verifyAndReinforceIgnored(projectDir, '.env.tmp-verify-probe');
  if (scratchVerify.reinforced) appended.push('.env.tmp-* (reinforced at end of file — a negation elsewhere was overriding it)');

  const trackedInfo = checkEnvTracked(projectDir);
  // Definitively confirmed (via git, not assumed) that .env is STILL not ignored even after reinforcing —
  // this is the same severity class as "tracked": we have positive evidence a secret written here could
  // be committed. Fold it into the STEP 0 hard invariant rather than silently proceeding.
  const envUnignorable = envVerify.verified && !envVerify.ignored;
  return {
    ok: !trackedInfo.tracked && !envUnignorable,
    path: gitignorePath,
    created: !existedBefore,
    appended,
    tracked: trackedInfo.tracked,
    gitAvailable: trackedInfo.gitAvailable,
    envIgnoreVerified: envVerify.verified,
    envIgnoreConfirmed: envVerify.verified && envVerify.ignored,
    envUnignorable,
    scratchIgnoreVerified: scratchVerify.verified,
    scratchIgnoreConfirmed: scratchVerify.verified && scratchVerify.ignored,
  };
}

// ---- key catalog ------------------------------------------------------------------------------------
// Help text + validation shape per known key. Keys not in this catalog are still handled generically
// (non-empty, not a placeholder, length >= 4) — users may add custom keys to the temp file too.
const KEY_INFO = {
  ANTHROPIC_API_KEY: { help: 'Anthropic Claude API key (starts with sk-ant-...).', url: 'https://console.anthropic.com/settings/keys', prefixes: ['sk-ant-'], minLen: 20 },
  OPENAI_API_KEY: { help: 'OpenAI API key (starts with sk-...).', url: 'https://platform.openai.com/api-keys', prefixes: ['sk-'], minLen: 20 },
  NVIDIA_API_KEY: { help: 'NVIDIA Build/NIM key (starts with nvapi-...).', url: 'https://build.nvidia.com/settings/api-keys', prefixes: ['nvapi-'], minLen: 20 },
  DATABASE_URL: { help: 'Database connection string.', url: 'https://www.postgresql.org/docs/current/libpq-connect.html', prefixes: [], minLen: 8 },
  VECTOR_DB_URL: { help: 'Vector database connection URL (Pinecone/Weaviate/Qdrant/etc).', url: 'https://docs.pinecone.io/', prefixes: [], minLen: 8 },
  N8N_WEBHOOK_URL: { help: 'n8n webhook URL for this workflow.', url: 'https://docs.n8n.io/webhooks/', prefixes: [], minLen: 10 },
  WEBHOOK_SIGNING_SECRET: { help: 'Shared secret used to verify inbound webhook signatures.', url: 'https://docs.n8n.io/webhooks/', prefixes: [], minLen: 8 },
  TELEGRAM_BOT_TOKEN: { help: 'Telegram bot token from @BotFather.', url: 'https://core.telegram.org/bots#botfather', prefixes: [], minLen: 20 },
  THIRD_PARTY_API_KEY: { help: 'Third-party integration API key.', url: '', prefixes: [], minLen: 8 },
};

// Which keys a project TYPE plausibly needs. Deliberately conservative — only prompt for what the
// project actually needs; an unknown/unspecified type gets an empty, "add your own" set.
const TYPE_KEYS = {
  website: [],
  fullstack: ['DATABASE_URL'],
  automation: ['N8N_WEBHOOK_URL', 'WEBHOOK_SIGNING_SECRET'],
  rag: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VECTOR_DB_URL'],
  chatbot: ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN'],
  scraper: [],
  integration: ['THIRD_PARTY_API_KEY'],
  other: [],
};

function detectKeysForType(type) {
  const t = String(type || 'other').toLowerCase();
  return (TYPE_KEYS[t] || TYPE_KEYS.other || []).slice();
}

// ---- placeholder / plausibility validation ------------------------------------------------------
// Deliberately conservative: only rejects values that clearly look like an unfilled placeholder. A
// real-looking value that happens to be short/wrong-prefix for its catalog entry is "skipped" (not
// silently accepted), never "stored" — see classifyValue().
//
// Anchored/whole-token matching: a placeholder marker must stand alone (bounded by a non-alphanumeric
// character or a string edge), not merely appear as a coincidental substring of a real value — e.g. a
// real webhook secret that happens to contain the four characters "xxxx" mid-string must NOT be
// misclassified as an unfilled template placeholder just because "xxxx" appears embedded inside a longer
// real token. `containsIsolatedToken` requires a boundary on BOTH sides (used for the xxxx-run check,
// where a real secret containing "xxxx" mid-string must stay accepted).
function containsIsolatedToken(low, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + escaped + '($|[^a-z0-9])').test(low);
}

// `startsWithIsolatedToken` requires a boundary ONLY on the LEFT side — used for the obvious-placeholder
// WORD markers (replace_me/change_me/your_key_here and their variants). A trailing alnum run must NOT
// defeat detection of an obviously-fake value: 'CHANGEMENOW', 'REPLACEMENOW', 'your_key_hereXX' are still
// unambiguously placeholder-shaped even though something follows the marker word. Left-boundary alone is
// still required so an embedded mid-word occurrence (e.g. "interchangemechanism") is correctly ignored.
function startsWithIsolatedToken(low, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + escaped).test(low);
}

// Mirror of startsWithIsolatedToken: a boundary required ONLY on the RIGHT side — used for placeholder
// SUFFIX markers (e.g. "..._GOES_HERE"), where anything can precede the marker but it must genuinely end
// the value (or be followed by a non-alnum boundary), not just appear as a coincidental mid-string run.
function endsWithIsolatedToken(low, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped + '($|[^a-z0-9])').test(low);
}

// A value composed ENTIRELY of placeholder vocabulary words (optionally separated by non-alnum
// characters, with bare numeric words like a trailing "_1" tolerated as a template-index suffix) is
// itself placeholder-shaped even when no single word alone would trigger the anchored-token checks above
// — e.g. 'PASTE_KEY_HERE', 'ADD_YOUR_KEY', 'YOUR_TOKEN', 'example_key_1'. Requires at least 2 words so a
// single short/generic real value is left to the existing length/prefix checks in classifyValue rather
// than being flagged here. A real secret is virtually never a clean sequence of ONLY these dictionary
// words — random API keys/tokens don't decompose into whole English placeholder vocabulary.
const PLACEHOLDER_VOCAB_WORDS = new Set([
  'your', 'paste', 'insert', 'add', 'replace', 'change', 'fill', 'here', 'goes',
  'key', 'keys', 'token', 'tokens', 'secret', 'secrets', 'example', 'sample', 'demo', 'xxx', 'me',
]);
function isAllPlaceholderVocab(v) {
  const words = v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length < 2) return false;
  return words.every((w) => PLACEHOLDER_VOCAB_WORDS.has(w) || /^\d+$/.test(w));
}

function looksLikePlaceholder(v) {
  const low = v.toLowerCase();
  if (/^<[^>]*>$/.test(v)) return true;                       // <your key here> / <paste here>
  if (/(^|[^a-z0-9])x{4,}($|[^a-z0-9])/.test(low)) return true; // isolated xxxx/xxxxxxxxxxxx run, not embedded in a real value
  if (startsWithIsolatedToken(low, 'replace_me') || startsWithIsolatedToken(low, 'replaceme') || startsWithIsolatedToken(low, 'replace-me')) return true;
  if (startsWithIsolatedToken(low, 'change_me') || startsWithIsolatedToken(low, 'changeme') || startsWithIsolatedToken(low, 'change-me')) return true;
  if (startsWithIsolatedToken(low, 'your_key_here') || startsWithIsolatedToken(low, 'your-key-here') || startsWithIsolatedToken(low, 'yourkeyhere')) return true;
  if (startsWithIsolatedToken(low, 'insert_') || startsWithIsolatedToken(low, 'paste_') || startsWithIsolatedToken(low, 'add_your') || startsWithIsolatedToken(low, 'fill_me')) return true;
  if (endsWithIsolatedToken(low, 'goes_here')) return true;
  if (low === 'todo' || low === 'tbd' || low === 'n/a' || low === 'na') return true;
  if (/^\.+$/.test(v)) return true;                            // "...", "."
  // Whole-value SHAPE check, not mere co-occurrence: the value must actually START with example/sample/
  // demo AND END with "key" — 'example_api_key' matches; a real connection string that merely CONTAINS
  // "example.com" and an isolated "key" path segment after a protocol prefix (e.g.
  // "https://example.com/api/key/realsecret123") does NOT start with example/sample/demo, so it is
  // correctly left alone.
  if (/^(example|sample|demo)[_-]?.*key$/.test(low)) return true;
  if (isAllPlaceholderVocab(low)) return true;
  return false;
}

function classifyValue(key, rawVal) {
  // `original` is preserved EXACTLY as received (no re-trim) so a quoted value's meaningful inner
  // whitespace, already correctly extracted by parseKeyValueLines, survives into the stored value.
  // `check` is a trimmed view used ONLY for blank/placeholder/length/prefix validation.
  const original = String(rawVal == null ? '' : rawVal);
  const check = original.trim();
  if (!check) return { status: 'missing' };
  if (looksLikePlaceholder(check)) return { status: 'skipped', reason: 'placeholder-looking value, not stored' };
  const info = KEY_INFO[key];
  if (info) {
    if (info.minLen && check.length < info.minLen) return { status: 'skipped', reason: 'too short to plausibly be a real ' + key };
    if (info.prefixes && info.prefixes.length && !info.prefixes.some((p) => check.startsWith(p))) {
      return { status: 'skipped', reason: 'does not start with the expected prefix (' + info.prefixes.join('/') + ')' };
    }
  } else if (check.length < 4) {
    return { status: 'skipped', reason: 'too short to plausibly be a real value' };
  }
  return { status: 'stored', value: original };
}

// ---- KEY=VALUE parsing / file upsert ----------------------------------------------------------------
// Split on CRLF, lone-CR (old-Mac-style line endings), OR lone-LF — never JUST "\r?\n", which silently
// treats an entire lone-CR-separated file as ONE unparseable line (confirmed by direct probe: a bare
// `\r?\n` split leaves 'KEY1=val1\rKEY2=val2\r' completely unsplit, while this alternation correctly
// yields ['KEY1=val1','KEY2=val2','']).
const LINE_SPLIT_RE = /\r\n|\r|\n/;
// Comment lines (leading #) never match — this doubles as "ignore commented placeholders" for free. An
// optional leading "export " (shell-export style, e.g. `export ANTHROPIC_API_KEY=sk-ant-...` pasted
// straight from a .bashrc/.env.sh) is stripped before the KEY=value match.
const KEY_VALUE_LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
// Extract the same normalized KEY + value pair a single fill-file LINE would produce, or null if the
// line is blank/a comment/not KEY=value shaped. Shared by parseKeyValueLines() and
// findConflictingDuplicateKeys() so both apply IDENTICAL quote-stripping/trim rules to every line.
function extractKeyValueFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const m = KEY_VALUE_LINE_RE.exec(trimmed);
  if (!m) return null;
  let v = m[2].trim();
  if (v.length >= 2 && /^(["']).*\1$/.test(v)) v = v.slice(1, -1);
  return { key: m[1], value: v };
}

// ROUND-4 HIGH FIX: a real newcomer flow is "paste real keys at the TOP of the init-keys scaffold, leave
// the scaffold's own blank `KEY=` template lines below" — each key then appears TWICE (real value, then
// a trailing blank duplicate). A non-empty value must ALWAYS win over a later empty one for the same key
// — the scaffold's own blank line must never silently erase a real pasted value (confirmed by direct
// repro: naive last-occurrence-wins turned a real value into "missing", which then deleted the ONLY copy
// of the secret). Two DIFFERENT non-empty values for the same key still resolve here (last one wins,
// deterministic) so this function can keep returning a flat map for existing callers/tests — but that is
// a genuine CONFLICT (e.g. a corrected typo) that callers must check via findConflictingDuplicateKeys()
// before trusting silently; see placeKeys() below.
function parseKeyValueLines(raw) {
  const map = {};
  for (const line of String(raw || '').split(LINE_SPLIT_RE)) {
    const kv = extractKeyValueFromLine(line);
    if (!kv) continue;
    if (!(kv.key in map) || kv.value !== '' || map[kv.key] === '') {
      map[kv.key] = kv.value;
    }
  }
  return map;
}

// PRINCIPLE C continuation (fail-safe / never lose a secret): detect when the SAME key appeared more than
// once with two (or more) DIFFERENT non-empty values — e.g. the user pasted a real value, then corrected
// a typo below it, or genuinely has two different real values and doesn't know which is current. A blank
// duplicate never counts as a conflict (that is the normal, expected paste-at-top-leave-scaffold-blanks
// shape and must resolve cleanly via parseKeyValueLines() above) — only two or more DISTINCT non-empty
// values for the same key count. placeKeys() uses this to RETAIN the fill-file (never silently pick one
// and delete the user's only copy) and report exactly which key(s) need manual resolution.
function findConflictingDuplicateKeys(raw) {
  const seen = new Map(); // key -> Set of distinct non-empty values seen for that key
  for (const line of String(raw || '').split(LINE_SPLIT_RE)) {
    const kv = extractKeyValueFromLine(line);
    if (!kv || !kv.value) continue;
    if (!seen.has(kv.key)) seen.set(kv.key, new Set());
    seen.get(kv.key).add(kv.value);
  }
  const conflicts = [];
  for (const [key, values] of seen.entries()) {
    if (values.size > 1) conflicts.push(key);
  }
  return conflicts;
}

// PRINCIPLE C (fail-safe / never lose a secret): count raw non-blank, non-comment lines that do NOT even
// match the recognizable (export-prefixed) KEY=value SHAPE — independent of whether parseKeyValueLines
// produced any entries at all. A non-zero count means the fill-file has real content in a format this
// tool could not understand (an unusual separator, a corrupted/garbled encoding, etc) — placeKeys() must
// treat that as "cannot safely conclude nothing was pasted" and RETAIN the file rather than delete it.
function countUnparseableContentLines(raw) {
  return String(raw || '')
    .split(LINE_SPLIT_RE)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => !KEY_VALUE_LINE_RE.test(l)).length;
}

// Detect the dominant line ending of an existing file's content so an upsert preserves it, instead of
// silently rewriting every unrelated line's CRLF endings to bare LF just because the changed lines were
// re-joined with '\n'. Falls back to '\n' for an empty/newline-less/missing file.
function detectLineEnding(raw) {
  if (!raw) return '\n';
  const crlfCount = (raw.match(/\r\n/g) || []).length;
  const totalNlCount = (raw.match(/\n/g) || []).length;
  const lfOnlyCount = totalNlCount - crlfCount;
  return crlfCount > 0 && crlfCount >= lfOnlyCount ? '\r\n' : '\n';
}

// Append-or-update: only lines matching a key in `updates` are rewritten in place; every other line
// (comments, unrelated keys, blank lines) is preserved byte-for-byte (including its original CRLF-vs-LF
// line-ending style). New keys are appended at the end.
function upsertEnvFile(envFilePath, updates) {
  let raw = '';
  try { raw = fs.readFileSync(envFilePath, 'utf8'); } catch { raw = ''; }
  // Node's utf8 decode does NOT strip a leading UTF-8 BOM (the U+FEFF codepoint) — left in place, it
  // glues onto the first key name (e.g. the line becomes "<BOM>EXISTING_KEY=...") so the KEY=value
  // regex below never matches that line, the key is treated as "not present yet", and a rotated value
  // gets APPENDED as a duplicate line instead
  // of updating the original — silently leaving the stale BOM-prefixed value as whichever a downstream
  // .env parser reads first. Strip it before splitting/matching, then re-prepend it to the output so the
  // file's original encoding marker survives untouched for editors/tools that expect it.
  let hadBom = false;
  if (raw.length > 0 && raw.charCodeAt(0) === 0xFEFF) { hadBom = true; raw = raw.slice(1); }
  const eol = detectLineEnding(raw);
  const lines = raw ? raw.split(/\r?\n/) : [];
  const remaining = new Set(Object.keys(updates));
  const out = lines.map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      remaining.delete(m[1]);
      return m[1] + '=' + updates[m[1]];
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const k of remaining) out.push(k + '=' + updates[k]);
  const BOM_CHAR = String.fromCharCode(0xFEFF);
  return (hadBom ? BOM_CHAR : '') + out.join(eol) + eol;
}

// Update .env.example with KEY NAMES + a short comment only — never a value. Skips keys already
// present (commented or not) so re-running never duplicates a line.
function upsertEnvExampleNames(envExamplePath, keys) {
  const existed = fs.existsSync(envExamplePath);
  let content = existed
    ? fs.readFileSync(envExamplePath, 'utf8')
    : '# Forge V2 — example environment (placeholders only; never put real secrets here)\n';
  const present = new Set();
  for (const line of content.split(/\r?\n/)) {
    const m = /^#?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (m) present.add(m[1]);
  }
  const toAdd = keys.filter((k) => !present.has(k));
  if (toAdd.length === 0) {
    if (!existed) fs.writeFileSync(envExamplePath, content, 'utf8');
    return { changed: !existed, added: [] };
  }
  let addition = (content.endsWith('\n') ? '' : '\n') + '\n# --- Added by /setup-forge (names only; set real values in your local .env, gitignored) ---\n';
  for (const k of toAdd) addition += '# ' + k + '=\n';
  fs.writeFileSync(envExamplePath, content + addition, 'utf8');
  return { changed: true, added: toAdd };
}

function buildTempContent(keys) {
  const lines = [
    '# Forge onboarding — temporary key fill-in file.',
    '# Fill in ONLY the keys you have. Leave the rest blank — add them later with the "init-keys" step again.',
    '# This file is git-ignored and is DELETED automatically once its values are moved into .env.',
    '',
  ];
  if (keys.length === 0) {
    lines.push('# This project type has no required keys detected. Add any you need below, e.g.:');
    lines.push('# ANTHROPIC_API_KEY=');
    lines.push('');
  }
  for (const k of keys) {
    const info = KEY_INFO[k] || {};
    if (info.help) lines.push('# ' + info.help + (info.url ? ' Get it at ' + info.url : ''));
    lines.push(k + '=');
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n') + '\n';
}

// ---- init-keys / place-keys --------------------------------------------------------------------------
const DEFAULT_TMP_NAME = '.env.forge-setup';

// Resolve a --tmp/--keys-from value the same way for both init-keys and place-keys. An absolute path,
// a "~/..." home-relative path, or any path containing a separator is used AS-IS (resolved against cwd,
// never silently re-rooted under projectDir) — a bare filename is still joined under projectDir, exactly
// as before. Always returns a fully resolved absolute path so downstream identity checks (is this the
// managed default? is this actually .env?) are simple string equality.
function resolveTmpPath(projectDir, tmpName) {
  let name = tmpName || DEFAULT_TMP_NAME;
  if (name === '~' || name.startsWith('~/') || name.startsWith('~\\')) {
    name = path.join(os.homedir(), name.slice(1));
  }
  const full = (path.isAbsolute(name) || name.includes('/') || name.includes('\\'))
    ? name
    : path.join(projectDir, name);
  return path.resolve(full);
}

// Path identity for filesystem-level "is this the same file" decisions. Windows and macOS default to a
// case-INSENSITIVE filesystem — comparing resolved path STRINGS case-sensitively would let `--tmp .ENV`
// silently bypass the refuse-guard / managed-default check purely because of letter casing, even though
// the OS treats it as literally the same file. Linux stays case-sensitive (its normal, correct behavior).
function pathsEqualForFs(a, b) {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Only the managed default fill-file (.env.forge-setup at the project root, whether reached via the
// implicit default or an explicit --tmp that happens to resolve to that same path) is ever eligible for
// automatic deletion. A user-pointed --tmp/--keys-from import source is never the managed file.
function isManagedDefaultTmp(projectDir, resolvedTmp) {
  return pathsEqualForFs(resolvedTmp, path.resolve(path.join(projectDir, DEFAULT_TMP_NAME)));
}

// Case-insensitive-aware (win32/darwin) "is childPath inside parentDir" check, mirroring
// pathsEqualForFs's platform handling — used by the .git-directory refusal below so `--tmp .GIT\config`
// can't bypass it on a case-insensitive filesystem either.
function isPathInside(childPath, parentDir) {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const child = caseInsensitive ? childPath.toLowerCase() : childPath;
  const parent = caseInsensitive ? parentDir.toLowerCase() : parentDir;
  const rel = path.relative(parent, child);
  return !!rel && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Hard refuse: never let the fill-file resolve to .env, .env.example, .gitignore, or anywhere inside
// .git/ itself — merging any of these into a fill-file and then deleting/retaining it (or writing
// placeholder scaffolding over it) either destroys real data or writes a real secret straight into
// tracked git internals. Case-insensitive on win32/darwin so `.ENV`/`.GITIGNORE` can't bypass it.
function refusesAsEnvTarget(projectDir, resolvedTmp) {
  const envPath = path.resolve(path.join(projectDir, '.env'));
  const envExamplePath = path.resolve(path.join(projectDir, '.env.example'));
  const gitignorePath = path.resolve(path.join(projectDir, '.gitignore'));
  const gitDirPath = path.resolve(path.join(projectDir, '.git'));
  if (pathsEqualForFs(resolvedTmp, envPath) || pathsEqualForFs(resolvedTmp, envExamplePath)) return true;
  if (pathsEqualForFs(resolvedTmp, gitignorePath)) return true;
  if (pathsEqualForFs(resolvedTmp, gitDirPath) || isPathInside(resolvedTmp, gitDirPath)) return true;
  return false;
}

// Write a file atomically via temp-path + rename. This is what makes an EXISTING symlinked or
// hardlinked (nlink>1) .env get REPLACED rather than written-through: rename() atomically swaps the
// directory entry itself — a symlink at the destination is replaced (never followed/written through),
// and any OTHER hardlink to the same original inode keeps its untouched original bytes. Also makes a
// failed write (e.g. a read-only destination) a single catchable, synchronous error instead of a
// partial/torn write, and cleans up its own scratch file on failure. The scratch filename
// ('<target>.tmp-<pid>-<ts>-<rand>') is covered by the '.env.tmp-*' REQUIRED_GITIGNORE_LINES entry.
function writeFileAtomic(targetPath, content) {
  const tmpWritePath = targetPath + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(tmpWritePath, content, 'utf8');
  try {
    fs.renameSync(tmpWritePath, targetPath);
  } catch (e) {
    try { fs.unlinkSync(tmpWritePath); } catch { /* best-effort cleanup of our own scratch file */ }
    throw e;
  }
}

// Ensure a --tmp/--keys-from fill-file path is actually covered by THIS project's .gitignore before any
// value is ever written into or merged from it — closes the gap where a custom in-project name (e.g.
// `init-keys --tmp mykeys.txt`) was never covered by REQUIRED_GITIGNORE_LINES and could get staged by a
// plain `git add .`. Only meaningful for a resolved path that actually lives INSIDE projectDir — an
// import source that lives OUTSIDE the project can't be protected by this project's own .gitignore, and
// this function honestly reports that instead of silently doing nothing.
//
// PRINCIPLE A: after ensuring the literal line is present (grep-before-append, unchanged), actually ASK
// GIT whether the path is really ignored (verifyAndReinforceIgnored) rather than trusting Set-membership
// alone — a `!pattern` negation elsewhere in .gitignore can defeat a technically-present line. Returns
// `verified`/`ignored` as an honest tri-state: verified=false means we genuinely could not tell (no git,
// not a repo) — callers must not silently treat that as success (PRINCIPLE B).
function ensureTmpGitignored(projectDir, resolvedTmp) {
  const rel = path.relative(projectDir, resolvedTmp);
  const insideProject = !!rel && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!insideProject) return { insideProject: false, appended: false, verified: false, ignored: false };
  const relPosix = rel.split(path.sep).join('/');
  const gitignorePath = path.join(projectDir, '.gitignore');
  const existedBefore = fs.existsSync(gitignorePath);
  let content = existedBefore ? fs.readFileSync(gitignorePath, 'utf8') : '# Forge V2 — secrets (managed by forge-setup guard)\n';
  const existingLines = new Set(content.split(/\r?\n/).map((l) => l.trim()));
  let appended = false;
  if (!existingLines.has(relPosix)) {
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += relPosix + '\n';
    fs.writeFileSync(gitignorePath, content, 'utf8');
    appended = true;
  }
  const v = verifyAndReinforceIgnored(projectDir, relPosix);
  return { insideProject: true, appended: appended || v.reinforced, verified: v.verified, ignored: v.ignored };
}

// Detect a UTF-16 byte-order-mark at the start of a file's RAW bytes (0xFF 0xFE = UTF-16LE, 0xFE 0xFF =
// UTF-16BE). Reading a UTF-16-encoded .env as if it were UTF-8 (this tool's only supported encoding)
// produces garbled/mojibake text the KEY=value regex cannot reliably match — silently "rotating" a
// secret in that state would leave the real stale value fully readable in the untouched UTF-16 bytes
// while a new value gets appended in UTF-8, corrupting the file rather than actually rotating anything.
function detectUtf16Bom(filePath) {
  let buf = null;
  try { buf = fs.readFileSync(filePath); } catch { return null; }
  if (buf.length >= 2) {
    if (buf[0] === 0xFF && buf[1] === 0xFE) return 'UTF-16LE';
    if (buf[0] === 0xFE && buf[1] === 0xFF) return 'UTF-16BE';
  }
  return null;
}

function initKeys(projectDir, opts) {
  opts = opts || {};
  const invalidDir = validateProjectDir(projectDir);
  if (invalidDir) return { ok: false, reason: invalidDir.reason };
  const g = guard(projectDir);
  if (g.tracked) {
    return { ok: false, blocked: true, reason: '.env is already tracked by git — run "git rm --cached .env" and rotate any exposed keys before continuing.', guard: g };
  }
  if (g.envUnignorable) {
    return { ok: false, blocked: true, reason: '.env could not be confirmed as git-ignored even after reinforcement (a `!` negation or similar rule in .gitignore is overriding the exclusion) — fix your .gitignore before continuing, or your secrets could be committed.', guard: g };
  }
  const tmp = resolveTmpPath(projectDir, opts.tmpName);
  if (refusesAsEnvTarget(projectDir, tmp)) {
    return { ok: false, reason: 'refusing to use .env, .env.example, .gitignore, or anything inside .git/ as the temp fill-file path: ' + tmp };
  }

  // PRINCIPLE D (robust IO): stat before read/write. A pre-existing DIRECTORY at the resolved --tmp path
  // must be a clean {ok:false}, never a raw EISDIR crash from a later readFileSync/writeFileSync.
  let tmpStat = null;
  try { tmpStat = fs.statSync(tmp); } catch { tmpStat = null; }
  if (tmpStat && tmpStat.isDirectory()) {
    return { ok: false, reason: 'tmp fill-file is a directory: ' + tmp };
  }

  const keys = detectKeysForType(opts.type);

  if (tmpStat) {
    // Already exists (and is a regular file, per the isDirectory() check above). Register it with
    // .gitignore even on this early-return path, so a pre-existing custom-name temp from before this fix
    // (or hand-created by the user) still gets covered on the next init-keys run.
    const raw = fs.readFileSync(tmp, 'utf8');
    const existingNonEmpty = raw.split(LINE_SPLIT_RE).some((l) => { const t = l.trim(); return t && !t.startsWith('#'); });
    if (existingNonEmpty) {
      const gi = ensureTmpGitignored(projectDir, tmp);
      return {
        ok: true, skipped: true, path: tmp, keys,
        gitignored: gi.insideProject && !(gi.verified && !gi.ignored),
        gitignoreVerified: gi.insideProject && gi.verified && gi.ignored,
        gitignoreInsideProject: gi.insideProject,
        reason: 'temp file already has content — not overwritten', guard: g,
      };
    }
  }

  // PRINCIPLE D: doesn't exist yet (or exists but is empty/comment-only) — ensure the parent directory
  // exists first (a custom --tmp into a non-existent subdir must not crash with a raw ENOENT), THEN write
  // the scaffold, THEN — only on a CONFIRMED successful write — register .gitignore. Never leave an
  // orphan .gitignore line pointing at a file that was never actually created.
  const parentDir = path.dirname(tmp);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(tmp, buildTempContent(keys), 'utf8');
  } catch (e) {
    return { ok: false, reason: 'failed to create the fill-file: ' + ((e && e.message) ? e.message : String(e)) };
  }
  const gi = ensureTmpGitignored(projectDir, tmp);
  return {
    ok: true, created: true, path: tmp, keys,
    gitignored: gi.insideProject && !(gi.verified && !gi.ignored),
    gitignoreVerified: gi.insideProject && gi.verified && gi.ignored,
    gitignoreInsideProject: gi.insideProject,
    guard: g,
  };
}

function placeKeys(projectDir, opts) {
  opts = opts || {};
  const invalidDir = validateProjectDir(projectDir);
  if (invalidDir) return { ok: false, reason: invalidDir.reason };
  const g = guard(projectDir);
  if (g.tracked) {
    return { ok: false, blocked: true, reason: '.env is already tracked by git — run "git rm --cached .env" and rotate any exposed keys before continuing.', guard: g };
  }
  if (g.envUnignorable) {
    return { ok: false, blocked: true, reason: '.env could not be confirmed as git-ignored even after reinforcement (a `!` negation or similar rule in .gitignore is overriding the exclusion) — fix your .gitignore before continuing, or your secrets could be committed.', guard: g };
  }
  const tmp = resolveTmpPath(projectDir, opts.tmpName);
  if (refusesAsEnvTarget(projectDir, tmp)) {
    return { ok: false, reason: 'refusing to merge-and-delete .env, .env.example, .gitignore, or anything inside .git/ as the temp fill-file — point --tmp at a separate file: ' + tmp };
  }

  // PRINCIPLE D: stat before read. A pre-existing DIRECTORY at --tmp must be a clean {ok:false}, never a
  // raw EISDIR crash from readFileSync.
  let tmpStat = null;
  try { tmpStat = fs.statSync(tmp); } catch { tmpStat = null; }
  if (!tmpStat) {
    return { ok: false, reason: 'file not found: ' + tmp + (opts.tmpName ? '' : ' — run "init-keys" first') };
  }
  if (tmpStat.isDirectory()) {
    return { ok: false, reason: 'tmp fill-file is a directory: ' + tmp };
  }

  // Cover it with .gitignore before we read/process/possibly-retain it — matters most for a
  // user-pointed --tmp/--keys-from source that never went through init-keys at all (it is NEVER
  // auto-deleted per bug #13, so if it lives inside the project it MUST be gitignored here).
  const gi = ensureTmpGitignored(projectDir, tmp);
  const gitignored = gi.insideProject && !(gi.verified && !gi.ignored);
  const gitignoreVerified = gi.insideProject && gi.verified && gi.ignored;
  const gitignoreInsideProject = gi.insideProject;

  const raw = fs.readFileSync(tmp, 'utf8');
  const parsed = parseKeyValueLines(raw);
  // ROUND-4 HIGH FIX: a key that appeared more than once with two DIFFERENT non-empty values is a real
  // conflict (e.g. a corrected typo) — never silently pick one and write it to .env. Exclude it from
  // classification entirely this round; the retention logic below keeps the fill-file so the user can
  // resolve it manually and re-run.
  const conflictKeySet = new Set(findConflictingDuplicateKeys(raw));
  const stored = [], skipped = [], missing = [], conflicting = [];
  const updates = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (conflictKeySet.has(key)) { conflicting.push(key); continue; }
    const verdict = classifyValue(key, val);
    if (verdict.status === 'stored') { stored.push(key); updates[key] = verdict.value; }
    else if (verdict.status === 'skipped') skipped.push({ key, reason: verdict.reason });
    else missing.push(key);
  }

  const envFile = path.join(projectDir, '.env');

  // Bug #7: a UTF-16-encoded existing .env would be silently mis-decoded as UTF-8 and never actually
  // rotated. Refuse cleanly (before attempting any write) rather than claim a rotation that didn't
  // really happen while a stale secret survives fully readable in the untouched UTF-16 bytes.
  if (Object.keys(updates).length > 0) {
    const existingEncoding = detectUtf16Bom(envFile);
    if (existingEncoding) {
      return {
        ok: false,
        reason: 'existing .env is ' + existingEncoding + ' — this tool only reads/writes UTF-8; convert .env to UTF-8 first, then re-run place-keys',
        envPath: envFile,
        stored: [], skipped, missing, conflicting,
        deletedTemp: false,
        tempRetained: true,
        tempRetainReason: '.env encoding is not UTF-8 — the fill-file was kept so nothing is lost; convert .env to UTF-8 and re-run place-keys',
        gitignored, gitignoreVerified, gitignoreInsideProject,
        envExampleUpdated: false,
      };
    }
  }

  let writeError = null;
  if (Object.keys(updates).length > 0) {
    try {
      writeFileAtomic(envFile, upsertEnvFile(envFile, updates));
      try { fs.chmodSync(envFile, 0o600); } catch { /* best-effort only (e.g. unsupported on this fs) */ }
    } catch (e) {
      writeError = (e && e.message) ? e.message : String(e);
    }
  }

  if (writeError) {
    // Never claim success on a failed write. Never lose the user's pasted secrets either: the temp
    // fill-file is the ONLY remaining copy of what they typed at this point, so it is always kept
    // intact (not deleted, not partially consumed) whenever the .env write itself failed.
    return {
      ok: false,
      reason: 'failed to write .env: ' + writeError,
      envPath: envFile,
      stored: [], skipped, missing, conflicting,
      deletedTemp: false,
      tempRetained: true,
      tempRetainReason: '.env write failed — the fill-file was kept so nothing is lost; fix the .env permission/lock issue and re-run place-keys',
      gitignored, gitignoreVerified, gitignoreInsideProject,
      envExampleUpdated: false,
    };
  }

  const exampleResult = stored.length > 0
    ? upsertEnvExampleNames(path.join(projectDir, '.env.example'), stored)
    : { changed: false, added: [] };

  // Temp-file lifecycle — the FINAL coherent rule:
  //   - ONLY the managed default fill-file is EVER eligible for automatic deletion. A user-pointed
  //     --tmp/--keys-from import source is NEVER auto-deleted — it is an import, not a consumed scratch
  //     file — but IS gitignored above whenever it lives inside the project.
  //   - The managed default is DELETED on a clean full success OR when nothing real was pasted at all.
  //     There is nothing to lose by cleaning those up.
  //   - The managed default is RETAINED (still gitignored) when at least one PASTED value was actually
  //     skipped/rejected (a real secret the user typed could otherwise be silently lost), OR — PRINCIPLE C
  //     — when the fill-file has raw content lines this tool could not even PARSE as KEY=value (export-
  //     prefixed and lone-CR lines are now handled directly by the parser; anything else unparseable is a
  //     fail-safe against ever silently deleting real-but-unparsed secret content), OR — ROUND-4 — when a
  //     key appeared more than once with two DIFFERENT non-empty values (a real conflict the tool cannot
  //     safely resolve on its own).
  const managed = isManagedDefaultTmp(projectDir, tmp);
  const keepDueToSkip = skipped.length > 0;
  const unparseableCount = countUnparseableContentLines(raw);
  const keepDueToUnparsedContent = unparseableCount > 0;
  const keepDueToConflict = conflicting.length > 0;
  let deletedTemp = false, tempRetained = false, tempRetainReason = null;
  if (managed && !keepDueToSkip && !keepDueToUnparsedContent && !keepDueToConflict) {
    try { fs.unlinkSync(tmp); deletedTemp = true; } catch { /* already gone is fine */ }
  } else {
    tempRetained = true;
    if (!managed) {
      tempRetainReason = 'this is a user-provided --tmp/--keys-from import source, not the managed default fill-file — it is never deleted';
    } else if (keepDueToConflict) {
      tempRetainReason = 'duplicate key ' + conflicting.join(', ') + ' with conflicting (different, non-empty) values — kept the temp so you can resolve which value to use';
    } else if (keepDueToUnparsedContent) {
      tempRetainReason = 'the fill-file has content I could not parse as KEY=value lines (unusual format/separator) — kept so nothing real is lost; check the format and re-run place-keys';
    } else {
      tempRetainReason = 'at least one pasted value was skipped/rejected — the fill-file was kept so you can fix it and re-run place-keys';
    }
  }

  return {
    ok: true,
    envPath: envFile,
    stored, skipped, missing, conflicting,
    deletedTemp,
    tempRetained,
    tempRetainReason,
    gitignored, gitignoreVerified, gitignoreInsideProject,
    envGitignoreVerified: g.envIgnoreVerified,
    envGitignoreConfirmed: g.envIgnoreConfirmed,
    envExampleUpdated: exampleResult.changed,
  };
}

// ---- markers ------------------------------------------------------------------------------------------
function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function readForgeVersion(projectDir) {
  try { const v = fs.readFileSync(path.join(projectDir, 'VERSION'), 'utf8').trim(); return v || 'unknown'; } catch { return 'unknown'; }
}
// TEST-ONLY escape hatch (checked fresh every call, never cached): set FORGE_SETUP_GLOBAL_ROOT to
// redirect the "global" marker dir away from the real ~/.claude. Never point this at a real user's home.
function resolveGlobalDir(explicitGlobalDir) {
  if (explicitGlobalDir) return path.resolve(explicitGlobalDir);
  if (process.env.FORGE_SETUP_GLOBAL_ROOT) return path.resolve(process.env.FORGE_SETUP_GLOBAL_ROOT);
  return path.join(os.homedir(), '.claude');
}

// A language code must be a plain, short BCP-47-ish token (e.g. "en", "nl", "en-US"). Coerces any input
// to a string first (a corrupted marker could hold a number/array/object), then validates against a
// strict anchored pattern — anything else (shell metachars, an overlong string, injected content) falls
// back to 'en' rather than ever being echoed/stored/used as-is.
const LANG_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
function sanitizeLang(v) {
  const s = (typeof v === 'string') ? v : String(v == null ? '' : v);
  return LANG_PATTERN.test(s) ? s : 'en';
}

function mark(projectDir, answers, globalDir) {
  answers = answers || {};
  const gDir = resolveGlobalDir(globalDir);
  const version = readForgeVersion(projectDir);
  const nowIso = new Date().toISOString();

  const projMarkerPath = path.join(projectDir, '.claude', '.forge-setup.json');
  const existingProj = readJsonSafe(projMarkerPath) || {};
  const prevAnswers = existingProj.answers || {};
  const projMarker = {
    ...existingProj,
    version,
    completedAt: nowIso,
    answers: {
      name: answers.name !== undefined ? answers.name : prevAnswers.name,
      lang: answers.lang !== undefined ? sanitizeLang(answers.lang) : (prevAnswers.lang || 'en'),
      goal: answers.goal !== undefined ? answers.goal : prevAnswers.goal,
      type: answers.type !== undefined ? answers.type : prevAnswers.type,
    },
  };
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(projMarkerPath, JSON.stringify(projMarker, null, 2) + '\n', 'utf8');

  const globalMarkerPath = path.join(gDir, '.forge-global.json');
  const existingGlobal = readJsonSafe(globalMarkerPath) || {};
  const globalMarker = {
    ...existingGlobal,
    version,
    completedAt: nowIso,
    name: answers.name !== undefined ? answers.name : existingGlobal.name,
    defaultLanguage: answers.lang !== undefined ? sanitizeLang(answers.lang) : (existingGlobal.defaultLanguage || 'en'),
  };
  fs.mkdirSync(gDir, { recursive: true });
  fs.writeFileSync(globalMarkerPath, JSON.stringify(globalMarker, null, 2) + '\n', 'utf8');

  return { ok: true, project: projMarker, global: globalMarker, projectMarkerPath: projMarkerPath, globalMarkerPath };
}

function status(projectDir, globalDir) {
  const gDir = resolveGlobalDir(globalDir);
  const projMarkerPath = path.join(projectDir, '.claude', '.forge-setup.json');
  const globalMarkerPath = path.join(gDir, '.forge-global.json');
  const proj = readJsonSafe(projMarkerPath);
  const glob = readJsonSafe(globalMarkerPath);
  const onboarded = !!(proj && proj.completedAt);
  const name = (proj && proj.answers && proj.answers.name) || (glob && glob.name) || null;
  const lang = (proj && proj.answers && proj.answers.lang) || (glob && glob.defaultLanguage) || 'en';
  return { onboarded, name, lang, project: proj, global: glob };
}

function getLang(projectDir, globalDir) {
  // Defense in depth: status().lang may reflect a marker written before sanitizeLang() existed, or a
  // hand-edited/corrupted marker file — coerce + validate again here so a garbage/injected value can
  // never escape as the "configured language", regardless of how it got into the marker on disk.
  return sanitizeLang(status(projectDir, globalDir).lang || 'en');
}

// ---- self-heal ------------------------------------------------------------------------------------------
const REQUIRED_DIRS = [
  '.claude',
  path.join('.claude', 'forge-bin'),
  path.join('.claude', 'agents'),
  path.join('.claude', 'skills'),
  path.join('.claude', 'commands'),
  path.join('.claude', 'config'),
  path.join('.claude', 'forge-runs'),
];

function selfHeal(projectDir) {
  const changed = [];
  for (const rel of REQUIRED_DIRS) {
    const dir = path.join(projectDir, rel);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); changed.push('created dir: ' + rel); }
  }
  const g = guard(projectDir);
  if (g.created) changed.push('created .gitignore');
  for (const line of g.appended) changed.push('gitignore: appended "' + line + '"');
  const examplePath = path.join(projectDir, '.env.example');
  if (!fs.existsSync(examplePath)) {
    fs.writeFileSync(
      examplePath,
      '# Forge V2 — example environment (placeholders only; never put real secrets here)\n' +
      '# Copy to .env, then fill only the vars your task actually uses. Real values NEVER belong in this file.\n',
      'utf8'
    );
    changed.push('created .env.example');
  }
  return { ok: true, changed, tracked: g.tracked };
}

// ---- doctor ------------------------------------------------------------------------------------------
function doctor(projectDir) {
  const checks = {};

  const nodeMajor = parseInt(String(process.versions.node).split('.')[0], 10);
  const nodeOk = Number.isFinite(nodeMajor) && nodeMajor >= 18;
  checks.node = { ok: nodeOk, reason: nodeOk ? '' : 'Node ' + process.versions.node + ' is below the minimum supported v18' };

  const claudeOk = fs.existsSync(path.join(projectDir, '.claude'));
  checks.claudeDir = { ok: claudeOk, reason: claudeOk ? '' : '.claude/ directory not found at project root' };

  const trackedInfo = checkEnvTracked(projectDir);
  checks.envNotTracked = {
    ok: !trackedInfo.tracked,
    reason: trackedInfo.tracked
      ? '.env is tracked by git — run "git rm --cached .env" and rotate any exposed keys'
      : (trackedInfo.gitAvailable ? '' : 'git not available — could not verify, treated as pass'),
  };

  const projMarkerPath = path.join(projectDir, '.claude', '.forge-setup.json');
  let markersOk = true, markersReason = '';
  if (fs.existsSync(projMarkerPath)) {
    markersOk = readJsonSafe(projMarkerPath) !== null;
    if (!markersOk) markersReason = 'project marker exists but is not valid JSON';
  }
  checks.markersValid = { ok: markersOk, reason: markersReason };

  const skillsAgentsOk = fs.existsSync(path.join(projectDir, '.claude', 'agents')) && fs.existsSync(path.join(projectDir, '.claude', 'skills'));
  checks.skillsAgentsPresent = { ok: skillsAgentsOk, reason: skillsAgentsOk ? '' : '.claude/agents or .claude/skills directory missing' };

  const ok = Object.values(checks).every((c) => c.ok);
  return { ok, checks };
}

module.exports = {
  status, guard, checkEnvTracked, initKeys, placeKeys, mark, selfHeal, doctor, getLang,
  detectKeysForType, classifyValue, looksLikePlaceholder, parseKeyValueLines, upsertEnvFile,
  upsertEnvExampleNames, resolveGlobalDir, readForgeVersion,
  validateProjectDir, resolveTmpPath, isManagedDefaultTmp, refusesAsEnvTarget, detectLineEnding, sanitizeLang,
  pathsEqualForFs, ensureTmpGitignored, isPathInside, detectUtf16Bom,
  checkGitIgnoreStatus, verifyAndReinforceIgnored, countUnparseableContentLines, isAllPlaceholderVocab,
  findConflictingDuplicateKeys, extractKeyValueFromLine,
  KEY_INFO, TYPE_KEYS, REQUIRED_GITIGNORE_LINES, KEEP_NEGATION_LINE, DEFAULT_TMP_NAME,
};

// ---- CLI ------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--type') out.type = argv[++i];
    else if (a === '--tmp') out.tmp = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--lang') out.lang = argv[++i];
    else if (a === '--goal') out.goal = argv[++i];
    else out._.push(a);
  }
  return out;
}

if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const opts = parseArgs(argv.slice(1));
    const projectDir = opts.project ? path.resolve(opts.project) : path.resolve(__dirname, '..', '..');

    switch (cmd) {
      case 'status': {
        const s = status(projectDir);
        if (opts.json) { console.log(JSON.stringify(s, null, 2)); return; }
        console.log(s.onboarded
          ? 'onboarded: yes (name=' + (s.name || '?') + ', lang=' + s.lang + ')'
          : 'onboarded: no — run /setup-forge');
        return;
      }
      case 'guard': {
        const g = guard(projectDir);
        if (g.tracked) {
          console.error('!!! WARNING: .env is TRACKED by git in this repo. STOP.');
          console.error('!!! Run: git rm --cached .env  — then rotate any exposed keys before continuing.');
          process.exitCode = 3; return;
        }
        if (g.envUnignorable) {
          console.error('!!! WARNING: .env could NOT be confirmed as git-ignored, even after reinforcing .gitignore.');
          console.error('!!! Check .gitignore for a `!.env` (or similar) negation rule overriding the exclusion, then fix it — your secrets could otherwise be committed.');
          process.exitCode = 3; return;
        }
        if (!g.ok) { console.error(g.reason || 'guard failed'); process.exitCode = 1; return; }
        if (!opts.quiet) {
          if (g.created) console.log('created .gitignore');
          for (const l of g.appended) console.log('gitignore: added "' + l + '"');
          if (!g.created && g.appended.length === 0) console.log('.gitignore already protects secrets — no changes needed');
        }
        return;
      }
      case 'init-keys': {
        const r = initKeys(projectDir, { type: opts.type, tmpName: opts.tmp });
        if (r.blocked) { console.error('!!! WARNING: ' + r.reason); process.exitCode = 3; return; }
        if (!r.ok) { console.error(r.reason); process.exitCode = 1; return; }
        if (r.skipped) { console.log('temp key file already has content, left untouched: ' + r.path); return; }
        console.log('Created a fill-in file: ' + r.path);
        if (!opts.quiet) {
          console.log('Open it, paste each key after the "=", save, then run: node .claude/forge-bin/forge-setup.cjs place-keys');
          // PRINCIPLE B (honest degradation): only make the "never committed to git" promise when git
          // POSITIVELY CONFIRMED it — never assume from mere line-presence. A --tmp OUTSIDE the project
          // cannot be protected by this project's own .gitignore at all; a path we could not verify (git
          // unavailable, not a repo, or a negation we could not fully reinforce) gets an honest warning
          // instead of a false safety promise.
          if (!r.gitignoreInsideProject) {
            console.log('Leave any key blank if you do not have it yet — you can add it later. NOTE: this file is OUTSIDE the project, so it is NOT protected by this project\'s .gitignore — make sure it is not tracked by whatever repo (if any) it lives in.');
          } else if (r.gitignoreVerified) {
            console.log('Leave any key blank if you do not have it yet — you can add it later. Nothing here is ever committed to git.');
          } else {
            console.log('Leave any key blank if you do not have it yet — you can add it later. ⚠ I could NOT verify this file is actually git-ignored (run `git check-ignore ' + r.path + '` to check) — make sure it is excluded before you commit.');
          }
        }
        return;
      }
      case 'place-keys': {
        const r = placeKeys(projectDir, { tmpName: opts.tmp });
        if (r.blocked) { console.error('!!! WARNING: ' + r.reason); process.exitCode = 3; return; }
        if (!r.ok) { console.error(r.reason); process.exitCode = 1; return; }
        // PRINCIPLE B: only claim ".env is git-ignored, never committed" when guard() POSITIVELY
        // CONFIRMED it via `git check-ignore` — this is the exact bug #1 repro (a `!.env` negation left
        // the secret stageable while the old code printed a confident, false promise regardless).
        if (r.envGitignoreConfirmed) {
          console.log('Stored ' + r.stored.length + ' key(s) to .env (git-ignored, never committed): ' + (r.stored.join(', ') || '(none)'));
        } else {
          console.log('Stored ' + r.stored.length + ' key(s) to .env: ' + (r.stored.join(', ') || '(none)'));
          console.log('⚠ I could NOT verify .env is actually git-ignored (run `git check-ignore .env` to check, and look for a `!` negation in .gitignore) — check it is excluded before you commit.');
        }
        if (r.skipped.length) console.log('Skipped (looked invalid, not stored): ' + r.skipped.map((s) => s.key).join(', '));
        if (r.missing.length) console.log('Missing (left blank, add later): ' + r.missing.join(', '));
        if (r.conflicting && r.conflicting.length) console.log('Conflicting (2+ different pasted values, none stored — fix and re-run): ' + r.conflicting.join(', '));
        if (r.deletedTemp) console.log('Deleted the temp file.');
        else if (r.tempRetained) console.log('Kept the temp file (' + r.tempRetainReason + ').');
        return;
      }
      case 'mark': {
        if (!opts.name || !opts.lang) {
          console.error('Usage: mark --name <n> --lang <code> [--goal <g>] [--type <t>]');
          process.exitCode = 1; return;
        }
        const r = mark(projectDir, { name: opts.name, lang: opts.lang, goal: opts.goal, type: opts.type });
        console.log('marker written: ' + r.projectMarkerPath);
        return;
      }
      case 'self-heal': {
        const r = selfHeal(projectDir);
        if (r.changed.length === 0) console.log('nothing to heal — already intact');
        else r.changed.forEach((c) => console.log(c));
        return;
      }
      case 'doctor': {
        const r = doctor(projectDir);
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else for (const [name, c] of Object.entries(r.checks)) console.log((c.ok ? 'PASS' : 'FAIL') + ' ' + name + (c.reason ? ' — ' + c.reason : ''));
        process.exitCode = r.ok ? 0 : 1;
        return;
      }
      case 'lang': {
        console.log(getLang(projectDir));
        return;
      }
      default:
        console.error('Usage: node forge-setup.cjs <status|guard|init-keys|place-keys|mark|self-heal|doctor|lang> [--project <dir>] [--json] [--quiet]');
        process.exitCode = 1;
    }
  };
  try { main(); } catch (e) { console.error('forge-setup: ' + e.message); process.exitCode = 1; }
}
