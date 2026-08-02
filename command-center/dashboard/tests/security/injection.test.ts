/**
 * Forge Workspace — proving the operation layer cannot be turned into an
 * execute endpoint.
 *
 * The bridge's central claim is "typed verbs only, no shell". This file tries to
 * break it three ways:
 *
 *  1. STATICALLY. Every `.ts` file under `src/bridge` is read and scanned, with
 *     comments stripped first so a doc block that talks ABOUT `shell: false`
 *     cannot be mistaken for the thing itself. No `shell: true`, no
 *     `windowsVerbatimArguments: true`, no `exec`/`execSync`/`execFile` at all,
 *     nothing that reaches for `cmd.exe /c` or `sh -c`, and every single
 *     `spawn`/`spawnSync` call site must carry `shell: false` within sight.
 *
 *  2. THROUGH EVERY STRING AN OPERATION ACCEPTS. Shell metacharacters, newlines,
 *     NUL bytes, ANSI escapes and argument-injection attempts are pushed through
 *     project display names, attachment filenames, record ids, git arguments and
 *     the Claude prompt. Each one must be REJECTED or must survive as an INERT
 *     ARGV ELEMENT — a string that some process receives as data and no parser
 *     ever interprets.
 *
 *  3. AT THE ARGV BOUNDARY. `buildClaudeArgv` is pure, so the argv it assembles
 *     can be inspected element by element without spawning anything. That is the
 *     highest-value assertion here: given hostile input, which elements of the
 *     command line are OPTIONS and which are DATA.
 *
 * WHY THE LOCATED RUNTIME IS SYNTHETIC. `buildClaudeArgv` gates every flag on a
 * probed `LocatedClaude`. Building one by hand keeps these tests hermetic and
 * fast. The last describe block then probes the REAL Claude Code once and asserts
 * that the synthetic flag set is not a fiction — and SKIPS with a printed reason
 * if the CLI cannot be probed, rather than quietly passing.
 */

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AdapterError,
  ALLOWED_PERMISSION_MODES,
  assertArgvIsSafe,
  buildClaudeArgv,
} from '@/bridge/claude/adapter';
import type { StartRunRequest } from '@/bridge/claude/adapter';
import { FORBIDDEN_FLAGS, FORBIDDEN_PERMISSION_MODES, locateClaudeCode } from '@/bridge/claude/locate';
import type { LocatedClaude } from '@/bridge/claude/locate';
import { inspectSlug, sanitizeSlug } from '@/bridge/security/paths';
import { inspectFilename } from '@/bridge/attachments/policy';
import { createAttachmentPipeline } from '@/bridge/attachments/pipeline';
import { assertSafeId, makeStreamKey, parseStreamKey } from '@/bridge/storage/store';
import * as git from '@/bridge/projects/git';
import { asObject, optString, optStringArray } from '@/bridge/router';

/* ========================================================================== */
/*  The payload corpus                                                         */
/* ========================================================================== */

/**
 * One list, used against every string surface. Splitting it per-surface is how a
 * payload silently stops being tested somewhere.
 */
const INJECTION_PAYLOADS: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'command separator (semicolon)', value: 'proj; calc.exe' },
  { label: 'command separator (ampersand)', value: 'proj & calc.exe' },
  { label: 'conditional chain', value: 'proj && shutdown /s /t 0' },
  { label: 'pipe', value: 'proj | net user hacker /add' },
  { label: 'backtick substitution', value: 'proj `whoami`' },
  { label: 'dollar substitution', value: 'proj $(id)' },
  { label: 'brace substitution', value: 'proj ${IFS}cat' },
  { label: 'windows environment expansion', value: 'proj %SYSTEMROOT%' },
  { label: 'powershell subexpression', value: 'proj $(Get-Content C:\\secret.txt)' },
  { label: 'redirect', value: 'proj > C:\\Windows\\System32\\drivers\\etc\\hosts' },
  { label: 'newline', value: 'proj\nrm -rf /' },
  { label: 'carriage return', value: 'proj\r\nInjected: true' },
  { label: 'NUL byte', value: 'proj\u0000.txt' },
  { label: 'ANSI escape', value: 'proj\u001b[2J\u001b[H' },
  { label: 'argument injection: --add-dir', value: '--add-dir' },
  { label: 'argument injection: --add-dir with value', value: '--add-dir=C:\\Windows' },
  { label: 'argument injection: permission bypass', value: '--dangerously-skip-permissions' },
  { label: 'argument injection: permission mode', value: '--permission-mode=bypassPermissions' },
  { label: 'argument injection: single dash', value: '-p' },
  { label: 'argument injection: bare terminator', value: '--' },
  { label: 'traversal', value: '../../Windows/System32' },
  { label: 'UNC path', value: '\\\\attacker\\share' },
];

/** Characters that only matter because some interpreter would act on them. */
const METACHARACTERS = [';', '&', '|', '`', '$', '>', '<', '\n', '\r', '\u0000', '\u001b', '%', '(', ')', '{', '}'];

/* ========================================================================== */
/*  1. Static scan of the bridge source                                        */
/* ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BRIDGE_DIR = path.join(REPO_ROOT, 'src', 'bridge');
const SRC_DIR = path.join(REPO_ROOT, 'src');

function walkTypeScript(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTypeScript(full));
    else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) out.push(full);
  }
  return out;
}

/**
 * Remove comments so a doc block cannot satisfy — or trip — a source assertion.
 *
 * `//` is only treated as a comment when it is not preceded by a colon, so
 * "https://example" inside a string survives intact. This is a heuristic and is
 * stated as one; it is applied only to make the scan STRICTER, never to excuse
 * a match.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The text of the first argument of a call, given the offset just past its
 * opening parenthesis. Nesting and quoting aware, so `spawn(join(a, b), argv)`
 * yields `join(a, b)` rather than `join(a`.
 */
function firstArgumentOf(code: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < code.length && i < from + 400; i += 1) {
    const ch = code[i]!;
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' && depth === 0) return code.slice(from, i);
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) return code.slice(from, i);
  }
  return code.slice(from, from + 400);
}

interface BridgeFile {
  readonly file: string;
  readonly relative: string;
  readonly source: string;
  readonly code: string;
}

const BRIDGE_FILES: readonly BridgeFile[] = walkTypeScript(BRIDGE_DIR).map((file) => {
  const source = readFileSync(file, 'utf8');
  return { file, relative: path.relative(REPO_ROOT, file), source, code: stripComments(source) };
});

describe('static: the bridge never becomes a shell', () => {
  it('there is bridge source to scan at all', () => {
    // Guards against a walker bug turning this whole block into a no-op.
    expect(BRIDGE_FILES.length).toBeGreaterThan(10);
    expect(BRIDGE_FILES.some((f) => f.relative.includes('adapter'))).toBe(true);
    expect(BRIDGE_FILES.some((f) => f.relative.includes('git'))).toBe(true);
  });

  it('no bridge file passes shell: true', () => {
    const offenders = BRIDGE_FILES.filter((f) => /\bshell\s*:\s*(true|1)\b/.test(f.code)).map((f) => f.relative);
    expect(
      offenders,
      'shell: true hands the whole argv to cmd.exe, where every metacharacter in it becomes syntax',
    ).toEqual([]);
  });

  it('no bridge file passes windowsVerbatimArguments: true', () => {
    // With verbatim arguments Node stops quoting, so a space or a quote in any
    // argument re-splits the command line. It is a shell injection with extra
    // steps.
    const offenders = BRIDGE_FILES.filter((f) => /windowsVerbatimArguments\s*:\s*true/.test(f.code)).map(
      (f) => f.relative,
    );
    expect(offenders).toEqual([]);
  });

  it('no bridge file uses exec, execSync, execFile or execFileSync', () => {
    const offenders: string[] = [];
    for (const file of BRIDGE_FILES) {
      // `exec` takes a COMMAND STRING and runs it through a shell. `execFile`
      // does not, but it is excluded too: keeping exactly one spawn primitive in
      // the codebase means there is exactly one place to audit.
      if (/\b(execSync|execFileSync|execFile)\s*\(/.test(file.code)) offenders.push(`${file.relative} (execFile family)`);
      // `exec(` on its own would also match `RegExp#exec`, which is everywhere
      // and harmless, so this only flags it when child_process is the source.
      if (/from\s+['"]node:child_process['"]/.test(file.code) && /[^.\w]exec\s*\(/.test(file.code)) {
        offenders.push(`${file.relative} (exec with a command string)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('child_process is imported only for spawn and spawnSync', () => {
    const offenders: string[] = [];
    for (const file of BRIDGE_FILES) {
      for (const match of file.code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]node:child_process['"]/g)) {
        const named = match[2]!
          .split(',')
          .map((n) => n.trim().split(/\s+as\s+/)[0]!.trim())
          .filter((n) => n.length > 0);
        for (const name of named) {
          if (name !== 'spawn' && name !== 'spawnSync' && name !== 'ChildProcess') {
            offenders.push(`${file.relative} imports ${name}`);
          }
        }
      }
      // A namespace or default import would hide everything above.
      if (/import\s+\*\s+as\s+\w+\s+from\s+['"]node:child_process['"]/.test(file.code)) {
        offenders.push(`${file.relative} imports child_process as a namespace`);
      }
      if (/require\s*\(\s*['"](node:)?child_process['"]\s*\)/.test(file.code)) {
        offenders.push(`${file.relative} require()s child_process`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every spawn call site carries shell: false within sight of the call', () => {
    const offenders: string[] = [];
    for (const file of BRIDGE_FILES) {
      for (const match of file.code.matchAll(/\b(spawnSync|spawn)\s*\(/g)) {
        const window = file.code.slice(match.index, match.index + 600);
        if (!/\bshell\s*:\s*false\b/.test(window)) {
          offenders.push(`${file.relative} @${String(match.index)} (${match[1]!})`);
        }
      }
    }
    expect(
      offenders,
      'a spawn that omits `shell` inherits the platform default, and on Windows that has historically meant a shell for .cmd/.bat targets',
    ).toEqual([]);
  });

  it('no spawn call names a command interpreter as its executable', () => {
    // The precise question is not "does the word cmd appear" — it appears as a
    // MinGit directory name and as an entry in a payload-key DENY list, both of
    // which are fine. The question is what the FIRST argument to spawn is.
    const offenders: string[] = [];
    for (const file of BRIDGE_FILES) {
      for (const match of file.code.matchAll(/\b(spawnSync|spawn)\s*\(/g)) {
        const target = firstArgumentOf(file.code, match.index + match[0].length);
        if (/(^|[\\/'"`])(cmd|cmd\.exe|command\.com|powershell|powershell\.exe|pwsh|sh|bash|zsh|dash)['"`]/i.test(target)) {
          offenders.push(`${file.relative}: spawn target ${target.trim()}`);
        }
      }
    }
    expect(offenders, 'a spawn whose executable is an interpreter is a shell by another name').toEqual([]);
  });

  it('no interpreter switch is ever assembled', () => {
    const switches = [
      { pattern: /['"`]cmd\.exe['"`]/i, what: 'a cmd.exe literal' },
      { pattern: /['"`]command\.com['"`]/i, what: 'a command.com literal' },
      { pattern: /['"`](powershell|powershell\.exe|pwsh|pwsh\.exe)['"`]/i, what: 'a PowerShell literal' },
      { pattern: /['"`]\/[ck]['"`]/, what: 'a cmd.exe /c or /k switch' },
      { pattern: /['"`]-Command['"`]/i, what: 'a PowerShell -Command switch' },
      { pattern: /['"`](sh|bash|zsh|dash)['"`]\s*,\s*\[?\s*['"`]-c['"`]/, what: 'a POSIX shell with -c' },
    ];
    const offenders: string[] = [];
    for (const file of BRIDGE_FILES) {
      for (const { pattern, what } of switches) {
        if (pattern.test(file.code)) offenders.push(`${file.relative}: ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the frontend cannot spawn anything at all', () => {
    const frontend = walkTypeScript(SRC_DIR).filter((f) => !f.startsWith(BRIDGE_DIR + path.sep));
    expect(frontend.length).toBeGreaterThan(20);
    const offenders = frontend.filter((f) => /child_process/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('the three permission-bypass flags are refused by name, not merely absent', () => {
    // A probe that simply never saw the flag would let a hardcoded argv slip
    // past. The deny list is what stops a future edit reintroducing one.
    expect(FORBIDDEN_FLAGS).toContain('--dangerously-skip-permissions');
    expect(FORBIDDEN_FLAGS).toContain('--allow-dangerously-skip-permissions');
    expect(FORBIDDEN_FLAGS).toContain('--max-turns');
    expect(FORBIDDEN_PERMISSION_MODES).toContain('bypassPermissions');
    expect(ALLOWED_PERMISSION_MODES).not.toContain('bypassPermissions');
  });
});

/* ========================================================================== */
/*  2. Project display names                                                   */
/* ========================================================================== */

describe('project display names cannot carry a command', () => {
  for (const payload of INJECTION_PAYLOADS) {
    it(`neutralises or refuses ${payload.label}`, () => {
      const inspection = inspectSlug(payload.value);
      if (!inspection.ok) {
        expect(() => sanitizeSlug(payload.value)).toThrow();
        return;
      }
      const slug = inspection.slug;
      for (const meta of METACHARACTERS) {
        expect(
          slug.includes(meta),
          `"${payload.value}" produced the slug "${slug}", which still contains ${JSON.stringify(meta)}`,
        ).toBe(false);
      }
      // The slug becomes a directory name and is passed as `--add-dir <value>`.
      // A leading dash would turn that value into a second option.
      expect(slug.startsWith('-'), `"${slug}" would be read as a command-line option`).toBe(false);
      expect(/^[\p{L}\p{N}\p{M}_-]+$/u.test(slug), `"${slug}" left a character outside the allowlist`).toBe(true);
    });
  }

  it('a name that reduces to nothing is refused rather than becoming the root', () => {
    for (const empty of ['', '   ', '...', '!!!@@@###', '$$$', '&&&']) {
      expect(inspectSlug(empty).ok, `"${empty}" must not produce a usable slug`).toBe(false);
    }
  });
});

/* ========================================================================== */
/*  3. Attachment filenames                                                    */
/* ========================================================================== */

describe('attachment filenames cannot carry a command or a path', () => {
  for (const payload of INJECTION_PAYLOADS) {
    it(`neutralises or refuses ${payload.label}`, () => {
      const inspection = inspectFilename(payload.value);
      if (!inspection.ok) {
        expect(inspection.stored).toBe('');
        expect(inspection.findings.some((f) => f.severity === 'REJECT')).toBe(true);
        return;
      }
      const stored = inspection.stored;
      for (const meta of METACHARACTERS) {
        expect(stored.includes(meta), `"${payload.value}" stored as "${stored}", still carrying ${JSON.stringify(meta)}`).toBe(
          false,
        );
      }
      expect(/[\\/]/.test(stored)).toBe(false);
      expect(stored.includes('..')).toBe(false);
      expect(stored.startsWith('-')).toBe(false);
      expect(stored.length).toBeGreaterThan(0);
    });
  }

  it('a hostile conversation or attachment id can never become a directory', () => {
    const pipeline = createAttachmentPipeline();
    const root = process.cwd();
    const hostile = ['..', '../escape', '..\\escape', 'a/b', 'a\\b', 'CON', 'nul', '', '-p', 'a:b', 'x\u0000y'];
    for (const id of hostile) {
      expect(() => pipeline.attachmentDir(root, id, 'att_ok'), `conversationId ${JSON.stringify(id)}`).toThrow();
      expect(() => pipeline.attachmentDir(root, 'conv_ok', id), `attachmentId ${JSON.stringify(id)}`).toThrow();
    }
  });
});

/* ========================================================================== */
/*  4. Record ids and stream keys                                              */
/* ========================================================================== */

describe('record ids cannot escape a directory or forge a stream', () => {
  it('refuses every hostile id', () => {
    const hostile = [
      '..',
      '../../etc',
      '..\\..\\windows',
      'a/b',
      'a\\b',
      'CON',
      'lpt1',
      'nul',
      'id\u0000',
      'id\nnext',
      'id;calc',
      '-p',
      '--add-dir',
      'a'.repeat(200),
      '',
      'a:b',
    ];
    for (const id of hostile) {
      expect(() => assertSafeId(id, 'projectId'), JSON.stringify(id)).toThrow();
    }
  });

  it('a stream key round-trips only for ids the guard already accepted', () => {
    const key = makeStreamKey('project_a', 'run_1');
    expect(parseStreamKey(key)).toEqual({ projectId: 'project_a', runId: 'run_1' });
    // A separator smuggled into an id would let one project write another's
    // stream. The id guard runs first, so the key can never be built.
    expect(() => makeStreamKey('project~other', 'run_1')).toThrow();
    expect(() => makeStreamKey('project_a', 'run~other')).toThrow();
    expect(parseStreamKey('..~..')).toBeNull();
    expect(parseStreamKey('a/b~_')).toBeNull();
  });
});

/* ========================================================================== */
/*  5. The git wrapper                                                         */
/* ========================================================================== */

/** Absolute and guaranteed absent, so `runGit` returns before it can spawn. */
const NO_SUCH_CWD = path.join(REPO_ROOT, '.forge-security-test-no-such-directory');

describe('the git wrapper is not an execute endpoint', () => {
  it('refuses every network-capable subcommand', () => {
    for (const sub of ['fetch', 'pull', 'push', 'clone', 'ls-remote', 'submodule', 'daemon', 'credential']) {
      expect(() => git.runGit({ cwd: NO_SUCH_CWD, args: [sub] }), sub).toThrow(/never performs|allowlist/);
    }
  });

  it('refuses any subcommand outside the allowlist', () => {
    for (const sub of ['filter-branch', 'gc', 'apply', 'am', 'bisect', 'help', '--exec-path']) {
      expect(() => git.runGit({ cwd: NO_SUCH_CWD, args: [sub] }), sub).toThrow();
    }
  });

  it('refuses options that name an executable, wherever they appear', () => {
    for (const arg of ['--upload-pack=calc.exe', '--receive-pack=calc.exe', '--exec=calc.exe', '--config-env=x=Y']) {
      expect(() => git.runGit({ cwd: NO_SUCH_CWD, args: ['status', arg] }), arg).toThrow();
    }
  });

  it('refuses a control character in any argument', () => {
    // eslint-disable-next-line no-control-regex -- control characters are the subject
    for (const payload of INJECTION_PAYLOADS.filter((p) => /[\u0000-\u001f]/.test(p.value))) {
      expect(() => git.runGit({ cwd: NO_SUCH_CWD, args: ['log', payload.value] }), payload.label).toThrow();
    }
  });

  it('refuses a hostile initial branch name', () => {
    for (const branch of ['main; calc', 'main && calc', '--upload-pack=x', '-p', 'main\nnext', '../escape']) {
      expect(() => git.init(NO_SUCH_CWD, { initialBranch: branch }), branch).toThrow();
    }
    // The benign one must still work, or the check is just over-blocking.
    expect(() => git.init(NO_SUCH_CWD, { initialBranch: 'feature/x-1.0' })).not.toThrow();
  });

  it('a commit message that looks like a flag stays an inert argv element', () => {
    // `--message` takes the NEXT argv element as its value. The message is a
    // separate element, so even a message spelled like an option is data.
    const result = git.commit(NO_SUCH_CWD, 'release --force > C:\\x');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.failure).toMatch(/working directory does not exist/);
    expect(result.args).toEqual(['commit', '--no-gpg-sign', '--message', 'release --force > C:\\x']);
    // One element, unsplit: nothing turned the spaces or the redirect into
    // separate arguments.
    expect(result.args[result.args.length - 1]).toBe('release --force > C:\\x');
  });

  it('an author identity may only ever set two config keys', () => {
    expect(() =>
      git.runGit({ cwd: NO_SUCH_CWD, args: ['status'], configOverrides: { 'core.pager': 'calc.exe' } }),
    ).toThrow();
    expect(() =>
      git.runGit({ cwd: NO_SUCH_CWD, args: ['status'], configOverrides: { 'core.sshCommand': 'calc.exe' } }),
    ).toThrow();
    expect(() =>
      git.runGit({ cwd: NO_SUCH_CWD, args: ['status'], configOverrides: { 'user.name': 'a\nb' } }),
    ).toThrow();
    const ok = git.runGit({ cwd: NO_SUCH_CWD, args: ['status'], configOverrides: { 'user.name': 'A Person' } });
    expect(ok.args).toEqual(['-c', 'user.name=A Person', 'status']);
  });

  it('git config is limited to reading three harmless keys', () => {
    expect(() => git.runGit({ cwd: NO_SUCH_CWD, args: ['config', '--get', 'credential.helper'] })).toThrow();
    expect(() => git.runGit({ cwd: NO_SUCH_CWD, args: ['config', 'user.name', 'attacker'] })).toThrow();
    expect(() => git.runGit({ cwd: NO_SUCH_CWD, args: ['config', '--get', 'user.name'] })).not.toThrow();
  });
});

/* ========================================================================== */
/*  6. The Claude argv                                                         */
/* ========================================================================== */

/**
 * A hand-built `LocatedClaude` mirroring Claude Code 2.1.217's option surface.
 * Only the fields `buildClaudeArgv` reads are populated. The final describe
 * block in this file checks these flags against the real CLI.
 */
const SYNTHETIC_FLAGS: readonly string[] = [
  '-p',
  '--print',
  '--output-format',
  '--input-format',
  '--verbose',
  '--include-partial-messages',
  '--add-dir',
  '--permission-mode',
  '--resume',
  '--continue',
  '--session-id',
  '--model',
  '--effort',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--settings',
  '--help',
  '--version',
];

const SYNTHETIC_LOCATED: LocatedClaude = {
  executablePath: 'C:\\does-not-exist\\claude.exe',
  source: 'path-entry',
  version: '2.1.217',
  versionRaw: '2.1.217 (Claude Code)',
  flags: new Set(SYNTHETIC_FLAGS),
  choices: new Map<string, readonly string[]>([
    ['--output-format', ['text', 'json', 'stream-json']],
    ['--input-format', ['text', 'stream-json']],
    // `bypassPermissions` is listed because the real CLI lists it. That is
    // precisely why the bridge must never let it be reached.
    ['--permission-mode', ['acceptEdits', 'bypassPermissions', 'default', 'plan', 'auto', 'manual', 'dontAsk']],
  ]),
  descriptions: new Map<string, string>([
    ['--effort', 'Reasoning effort: low, medium, high, xhigh, max'],
    ['--permission-mode', 'Permission mode to use for the session'],
  ]),
  probedAt: new Date(0).toISOString(),
  candidatesConsidered: [],
  notes: [],
};

const PROJECT_PATH = 'C:\\Users\\test\\Documents\\ForgeProjecten\\demo';

function baseRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: 'run_1',
    projectId: 'project_a',
    projectPath: PROJECT_PATH,
    conversationId: 'conv_1',
    prompt: 'hello',
    permissionMode: 'plan',
    ...overrides,
  };
}

/** Everything before the `--` terminator: the part a parser reads as options. */
function optionSection(argv: readonly string[]): readonly string[] {
  const terminator = argv.indexOf('--');
  return terminator === -1 ? argv : argv.slice(0, terminator);
}

/** Option-looking tokens in the option section, as a counted multiset. */
function optionTokens(argv: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of optionSection(argv)) {
    if (!token.startsWith('-') || token === '-') continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Option tokens present in `attack` beyond what the same request produces with
 * clean inputs. Anything listed here is an option the CALLER introduced, which
 * is the definition of argument injection.
 */
function injectedOptions(baseline: readonly string[], attack: readonly string[]): readonly string[] {
  const before = optionTokens(baseline);
  const after = optionTokens(attack);
  const extra: string[] = [];
  for (const [token, count] of after) {
    const was = before.get(token) ?? 0;
    for (let i = 0; i < count - was; i += 1) extra.push(token);
  }
  return extra;
}

describe('the Claude prompt is data, and only data', () => {
  it('the prompt is always the single element behind a "--" terminator', () => {
    // `--session-id` carries a freshly generated UUID, so it is blanked before
    // two option sections are compared.
    const normalise = (argv: readonly string[]): readonly string[] => {
      const copy = [...optionSection(argv)];
      const at = copy.indexOf('--session-id');
      if (at >= 0) copy[at + 1] = '<generated>';
      return copy;
    };
    const benign = normalise(
      buildClaudeArgv(SYNTHETIC_LOCATED, baseRequest({ prompt: 'an ordinary message' }), PROJECT_PATH).argv,
    );

    for (const payload of INJECTION_PAYLOADS) {
      const built = buildClaudeArgv(SYNTHETIC_LOCATED, baseRequest({ prompt: payload.value }), PROJECT_PATH);
      const terminator = built.argv.indexOf('--');
      expect(terminator, `${payload.label}: the prompt was not fenced`).toBeGreaterThanOrEqual(0);
      const tail = built.argv.slice(terminator + 1);
      expect(tail, `${payload.label}: exactly one element must follow the terminator`).toHaveLength(1);
      // Verbatim: the bridge does not escape, quote or mangle the user's text.
      // It does not need to, because nothing downstream interprets it.
      expect(tail[0]).toBe(payload.value);
      // The strongest form of "the prompt is data": whatever it contains, the
      // OPTION section is element-for-element the one a harmless message
      // produces. Nothing the user typed reached the parser.
      expect(
        normalise(built.argv),
        `${payload.label}: the prompt changed the OPTION section of the argv`,
      ).toEqual(benign);
    }
  });

  it('a prompt spelled exactly like a bypass flag is still just a prompt', () => {
    const built = buildClaudeArgv(
      SYNTHETIC_LOCATED,
      baseRequest({ prompt: '--dangerously-skip-permissions' }),
      PROJECT_PATH,
    );
    expect(built.argv[built.argv.length - 1]).toBe('--dangerously-skip-permissions');
    expect(optionSection(built.argv)).not.toContain('--dangerously-skip-permissions');
  });

  it('refuses to spawn when the terminator is missing or the tail is wrong', () => {
    expect(() => assertArgvIsSafe(['-p', 'hello'], 'hello')).toThrow(AdapterError);
    expect(() => assertArgvIsSafe(['-p', '--', 'hello', 'extra'], 'hello')).toThrow(AdapterError);
    expect(() => assertArgvIsSafe(['-p', '--', 'different'], 'hello')).toThrow(AdapterError);
    expect(() => assertArgvIsSafe(['-p', '--', 'hello'], 'hello')).not.toThrow();
  });

  it('refuses a forbidden flag anywhere in the option section', () => {
    for (const forbidden of FORBIDDEN_FLAGS) {
      expect(() => assertArgvIsSafe(['-p', forbidden, '--', 'hi'], 'hi'), forbidden).toThrow(AdapterError);
      expect(() => assertArgvIsSafe(['-p', `${forbidden}=1`, '--', 'hi'], 'hi'), forbidden).toThrow(AdapterError);
    }
  });

  it('every argv element is a plain string', () => {
    const built = buildClaudeArgv(SYNTHETIC_LOCATED, baseRequest({ prompt: 'x' }), PROJECT_PATH);
    for (const element of built.argv) expect(typeof element).toBe('string');
  });

  it('--add-dir names the guard-returned project path exactly once', () => {
    const built = buildClaudeArgv(SYNTHETIC_LOCATED, baseRequest(), PROJECT_PATH);
    const at = built.argv.indexOf('--add-dir');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(built.argv[at + 1]).toBe(PROJECT_PATH);
    expect(built.argv.filter((a) => a === '--add-dir')).toHaveLength(1);
  });

  it('refuses a permission mode that is not on the allow list', () => {
    for (const mode of ['bypassPermissions', 'default', '--dangerously-skip-permissions', '']) {
      expect(
        () => buildClaudeArgv(SYNTHETIC_LOCATED, baseRequest({ permissionMode: mode as never }), PROJECT_PATH),
        mode,
      ).toThrow(AdapterError);
    }
  });

  it('refuses a session id that is not a UUID', () => {
    for (const bad of ['../../etc', 'not-a-uuid', '; calc', '00000000-0000-0000-0000-00000000000', '--resume']) {
      expect(
        () => buildClaudeArgv(SYNTHETIC_LOCATED, baseRequest({ resumeSessionId: bad }), PROJECT_PATH),
        bad,
      ).toThrow(AdapterError);
      expect(
        () => buildClaudeArgv(SYNTHETIC_LOCATED, baseRequest({ sessionId: bad }), PROJECT_PATH),
        bad,
      ).toThrow(AdapterError);
    }
  });

  it('a NUL byte cannot reach a process, whichever layer stops it', async () => {
    const prompt = 'safe\u0000--dangerously-skip-permissions';
    let argv: readonly string[] | null = null;
    try {
      argv = buildClaudeArgv(SYNTHETIC_LOCATED, baseRequest({ prompt }), PROJECT_PATH).argv;
    } catch {
      // Refused at the argv layer, which is the strongest outcome. Done.
      return;
    }
    // Not refused, so the NUL must at least be confined to the fenced prompt.
    const terminator = argv.indexOf('--');
    expect(argv.slice(0, terminator).some((a) => a.includes('\u0000'))).toBe(false);
    expect(argv[terminator + 1]).toBe(prompt);

    // And Node itself must refuse to hand it to the OS. This is a synchronous
    // argument validation; no process is created. The nonexistent executable
    // name means that even a regression here starts nothing.
    let spawnRefused = false;
    try {
      const child = spawn('forge-security-test-nonexistent-binary', ['a\u0000b'], { shell: false });
      child.on('error', () => undefined);
      child.kill();
    } catch {
      spawnRefused = true;
    }
    expect(spawnRefused, 'node:child_process accepted an argument containing a NUL byte').toBe(true);
  });
});

describe('caller-supplied strings cannot introduce new options', () => {
  const cleanBaseline = buildClaudeArgv(
    SYNTHETIC_LOCATED,
    baseRequest({ allowedTools: ['Read'], disallowedTools: ['Bash'], model: 'sonnet' }),
    PROJECT_PATH,
  ).argv;

  /**
   * THE ONE THAT MATTERS.
   *
   * `assertArgvIsSafe` is the last gate before spawn, and it denies exactly three
   * flag names. Every other option token a caller can smuggle into
   * `allowedTools`, `disallowedTools` or `model` lands in the OPTION SECTION of
   * the argv, where the CLI's own parser reads it as an option — not as data.
   *
   * `--permission-mode` is the worst case because the bridge emits its own
   * earlier in the argv, and a later occurrence wins in a Commander-style parser.
   * `--add-dir` is the second worst: it widens the directory the run may touch,
   * and it is never seen by the path guard, which only ever validated
   * `projectPath`.
   */
  const attacks: readonly { readonly label: string; readonly request: Partial<StartRunRequest> }[] = [
    {
      label: 'allowedTools smuggling a second --permission-mode',
      request: { allowedTools: ['Read', '--permission-mode', 'bypassPermissions'] },
    },
    {
      label: 'allowedTools smuggling --add-dir',
      request: { allowedTools: ['Read', '--add-dir', 'C:\\Users\\test\\.ssh'] },
    },
    {
      label: 'disallowedTools smuggling --add-dir',
      request: { disallowedTools: ['Bash', '--add-dir', 'C:\\Windows'] },
    },
    {
      label: 'allowedTools smuggling --settings',
      request: { allowedTools: ['Read', '--settings', 'C:\\attacker\\settings.json'] },
    },
    { label: 'model smuggling --add-dir', request: { model: '--add-dir' } },
  ];

  for (const attack of attacks) {
    it(`refuses or neutralises: ${attack.label}`, () => {
      let argv: readonly string[];
      try {
        argv = buildClaudeArgv(
          SYNTHETIC_LOCATED,
          baseRequest({ allowedTools: ['Read'], disallowedTools: ['Bash'], model: 'sonnet', ...attack.request }),
          PROJECT_PATH,
        ).argv;
      } catch (error) {
        // Refused outright. That is the correct answer.
        expect(error).toBeInstanceOf(AdapterError);
        return;
      }
      const injected = injectedOptions(cleanBaseline, argv);
      expect(
        injected,
        `ARGUMENT INJECTION: ${attack.label}. The caller's strings added ${JSON.stringify(injected)} to the ` +
          'argv OPTION SECTION, where the CLI parses them as options rather than as data. ' +
          '`assertArgvIsSafe` only denies the three names in FORBIDDEN_FLAGS, so anything else passes. ' +
          'Fix: reject any element of allowedTools / disallowedTools / model that begins with "-", or pass ' +
          'each list as a single comma-joined value.',
      ).toEqual([]);
    });
  }

  it('a benign tool list produces exactly the options the bridge chose', () => {
    const argv = buildClaudeArgv(
      SYNTHETIC_LOCATED,
      baseRequest({ allowedTools: ['Read', 'Grep'], disallowedTools: ['Bash'] }),
      PROJECT_PATH,
    ).argv;
    expect(injectedOptions(cleanBaseline, argv)).toEqual([]);
  });
});

/* ========================================================================== */
/*  7. The router's payload validators                                         */
/* ========================================================================== */

describe('the router validates payloads before anything acts on them', () => {
  it('refuses a payload that is not a plain object', () => {
    for (const bad of [null, undefined, 'a string', 42, [], true]) {
      expect(() => asObject(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('a __proto__ key in a payload does not pollute Object.prototype', () => {
    const payload = JSON.parse('{"__proto__":{"forgePolluted":true},"projectId":"p"}') as unknown;
    const body = asObject(payload);
    expect(optString(body, 'projectId')).toBe('p');
    expect(({} as Record<string, unknown>).forgePolluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'forgePolluted')).toBe(false);
  });

  it('caps every string and array that crosses the boundary', () => {
    expect(() => optString({ id: 'a'.repeat(129) }, 'id')).toThrow();
    expect(() => optString({ id: 42 }, 'id')).toThrow();
    expect(() => optStringArray({ t: ['a'.repeat(129)] }, 't', 4)).toThrow();
    expect(() => optStringArray({ t: ['a', 'b', 'c'] }, 't', 2)).toThrow();
    expect(() => optStringArray({ t: [1] }, 't', 4)).toThrow();
    expect(() => optStringArray({ t: 'not an array' }, 't', 4)).toThrow();
  });
});

/* ========================================================================== */
/*  8. The synthetic runtime, checked against the real one                     */
/* ========================================================================== */

describe('the synthetic Claude Code runtime is not a fiction', () => {
  it('the real CLI supports every flag these tests build argv from', async (ctx) => {
    const result = await locateClaudeCode();
    if (!result.ok) {
      console.warn(
        `[security] SKIPPED real-CLI cross-check - Claude Code could not be probed (${result.reason}: ${result.detail}). ` +
          'The argv assertions above still hold against the synthetic runtime, but nothing here was confirmed ' +
          'against the installed CLI.',
      );
      ctx.skip(`Claude Code could not be probed (${result.reason})`);
      return;
    }

    const located = result.located;
    const required = ['-p', '--output-format', '--verbose', '--permission-mode', '--add-dir', '--session-id', '--resume'];
    const missing = required.filter((flag) => !located.flags.has(flag));
    expect(missing, `the installed CLI (${located.version ?? 'unknown version'}) is missing flags the adapter relies on`).toEqual(
      [],
    );

    // The documented claim about --max-turns, checked rather than repeated.
    expect(located.flags.has('--max-turns')).toBe(false);

    // Every mode the bridge says it will run under must really exist, or the
    // allow list is describing a CLI that is not installed.
    const modes = located.choices.get('--permission-mode') ?? [];
    expect(modes.length).toBeGreaterThan(0);
    expect(ALLOWED_PERMISSION_MODES.filter((m) => !modes.includes(m))).toEqual([]);

    // Corroborating evidence for the argument-injection finding in the block
    // above: the installed runtime really does accept `bypassPermissions`, so a
    // smuggled `--permission-mode bypassPermissions` names a mode this machine
    // would honour. Printed rather than asserted, because the finding stands on
    // the argv assertions, not on this line.
    console.warn(
      `[security] installed Claude Code ${located.version ?? '?'} --permission-mode choices: ${modes.join(', ')}` +
        (modes.includes('bypassPermissions')
          ? ' <- the injected mode is one this runtime accepts'
          : ' <- bypassPermissions is not offered by this runtime'),
    );
  });
});
