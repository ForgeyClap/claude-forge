/**
 * The declaration honesty suite.
 *
 * `protocol.ts` names this file, and every invariant it declares names a test in
 * here by its full title. That is not decoration: a constant asserting something
 * about the build is worth exactly as much as the check behind it, so the check
 * has to exist, has to be findable, and has to fail when the claim stops being
 * true.
 *
 * The suite is in three parts, matching the three things that can go wrong.
 *
 * 1. INVARIANTS ARE PROVEN BY READING THE SOURCE. Each one is a property of the
 *    build — no vendor endpoint, no key path, no LAN. Those are decidable by a
 *    static scan of `src/`, using the same technique as
 *    `no-runtime-contact.test.ts`, and that is how they are decided here.
 *
 * 2. DERIVED DECLARATIONS ARE FALSE WITHOUT EVIDENCE. The empty state is
 *    constructed explicitly and every one of the eight must come back false with
 *    a stated reason. This is the test that would have caught the defect this
 *    work package exists to fix: a build that shipped
 *    `CONNECTED_TO_CLAUDE_CODE: true` while reporting that no probe had run.
 *
 * 3. NOTHING CAN BE TRUE WITHOUT EVIDENCE. For each declaration: supply exactly
 *    the evidence it requires and it turns true; take one piece away and it
 *    turns false again. Including the case that matters most — a positive value
 *    computed with no re-checkable reference is reported FALSE, because a claim
 *    nobody can audit is not a claim.
 *
 * A comment describing a ban is not a violation of it, so the scanners skip
 * comment lines exactly as the boundary scan does.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  DERIVED_DECLARATIONS,
  INVARIANT_DECLARATIONS,
  INVARIANT_DECLARATION_PROOFS,
  REQUIRED_BIND_ADDRESS,
} from '@/shared/protocol';
import type { DerivedDeclarationName } from '@/shared/protocol';
import {
  DEFAULT_CLAUDE_PROBE_FRESHNESS_MS,
  deriveDeclarations,
  emptyDeclarationInputs,
  explainDeclarations,
  unprovenDeclarations,
} from '@/shared/declarations';
import type { DeclarationInputs } from '@/shared/declarations';
import { BIND_ADDRESS, FROZEN_ENV_VARS, LAN_MODE, loadConfig, REMOTE_ACCESS } from '@/bridge/config.ts';

/* ========================================================================== */
/*  Source scanning                                                            */
/* ========================================================================== */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const BRIDGE = join(SRC, 'bridge');
const THIS_TEST = join(ROOT, 'tests', 'unit', 'runtime-declarations.test.ts');

interface SourceFile {
  readonly abs: string;
  readonly rel: string;
  readonly zone: 'browser' | 'bridge';
  readonly text: string;
}

function collect(dir: string, acc: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      collect(abs, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push({
        abs,
        rel: relative(ROOT, abs),
        zone: abs.startsWith(BRIDGE + sep) ? 'bridge' : 'browser',
        text: readFileSync(abs, 'utf8'),
      });
    }
  }
  return acc;
}

const FILES = collect(SRC);
const BRIDGE_FILES = FILES.filter((f) => f.zone === 'bridge');
const CLAUDE_FILES = FILES.filter((f) => f.rel.includes(join('bridge', 'claude')));

/** Matching lines, minus comment lines — documenting a ban is not breaking it. */
function offendingLines(file: SourceFile, pattern: RegExp): string[] {
  return file.text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => pattern.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
    .map(({ line, n }) => `${file.rel}:${n}  ${line.trim().slice(0, 120)}`);
}

function scan(files: readonly SourceFile[], pattern: RegExp): string[] {
  return files.flatMap((f) => offendingLines(f, pattern));
}

function fileFor(relativePath: string): SourceFile {
  const wanted = relativePath.split('/').join(sep);
  const found = FILES.find((f) => f.rel === wanted);
  if (found === undefined) throw new Error(`expected ${relativePath} to exist in the source tree`);
  return found;
}

describe('the scan sees the tree it is meant to check', () => {
  it('finds the bridge and the shared contract', () => {
    expect(FILES.length).toBeGreaterThan(40);
    expect(BRIDGE_FILES.length).toBeGreaterThan(5);
    expect(CLAUDE_FILES.length).toBeGreaterThan(0);
  });

  /**
   * A positive control. Every other scan in this file asserts that something is
   * ABSENT, and an empty result is exactly what a broken scanner returns — so
   * the scanner is first shown to find something that is certainly there, and
   * to skip a line that only mentions it in a comment.
   */
  it('finds a pattern that is certainly present, and skips comments', () => {
    expect(scan(FILES, /REQUIRED_BIND_ADDRESS/).length).toBeGreaterThan(3);
    const commentOnly: SourceFile = {
      abs: 'x',
      rel: 'x',
      zone: 'bridge',
      text: ['// api.anthropic.com', ' * api.anthropic.com', 'const url = "api.anthropic.com";'].join('\n'),
    };
    expect(offendingLines(commentOnly, /api\.anthropic\.com/)).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  Every invariant names a real test                                          */
/* ========================================================================== */

describe('every invariant names the test that proves it', () => {
  const proofNames = Object.keys(INVARIANT_DECLARATION_PROOFS).sort();
  const declaredNames = Object.keys(INVARIANT_DECLARATIONS).sort();
  const selfText = readFileSync(THIS_TEST, 'utf8');

  it('has exactly one proof per invariant', () => {
    expect(proofNames).toEqual(declaredNames);
  });

  it.each(declaredNames)('%s points at a test that exists in this file', (name) => {
    const proof = INVARIANT_DECLARATION_PROOFS[name as keyof typeof INVARIANT_DECLARATION_PROOFS];
    expect(proof.startsWith('tests/unit/runtime-declarations.test.ts'), `${name}: ${proof}`).toBe(true);

    // The proof is `<file> > <describe> > <it>`. Both titles must appear
    // verbatim in this file, so a renamed test breaks the claim it supports
    // instead of leaving a dangling reference nobody notices.
    const segments = proof.split(' > ').map((s) => s.trim());
    expect(segments.length, `${name}: proof must name a describe and an it`).toBe(3);
    expect(selfText.includes(segments[1]!), `${name}: no describe titled "${segments[1]!}"`).toBe(true);
    expect(selfText.includes(segments[2]!), `${name}: no test titled "${segments[2]!}"`).toBe(true);
  });
});

/* ========================================================================== */
/*  INVARIANT USES_ANTHROPIC_API=false                                         */
/* ========================================================================== */

describe('INVARIANT USES_ANTHROPIC_API=false', () => {
  it('no vendor API host or SDK import exists anywhere in src/', () => {
    expect(INVARIANT_DECLARATIONS.USES_ANTHROPIC_API).toBe(false);

    const bans: readonly [string, RegExp][] = [
      ['Anthropic API host', /api\.anthropic\.com/i],
      ['Claude web API', /claude\.ai\/api/i],
      ['Anthropic SDK import', /from\s+['"]@anthropic-ai\//],
      ['Anthropic SDK require', /require\(\s*['"]@anthropic-ai\//],
      ['OpenAI API host', /api\.openai\.com/i],
      ['OpenAI SDK import', /from\s+['"]openai['"]/],
      ['bearer authorization header', /authorization\s*:\s*[`'"]\s*bearer/i],
      ['anthropic version header', /anthropic-version/i],
    ];

    const hits = bans.flatMap(([label, pattern]) => scan(FILES, pattern).map((h) => `${label}: ${h}`));
    expect(hits, `a vendor API path exists:\n${hits.join('\n')}`).toEqual([]);
  });
});

/* ========================================================================== */
/*  INVARIANT REQUIRES_ANTHROPIC_API_KEY=false                                 */
/* ========================================================================== */

describe('INVARIANT REQUIRES_ANTHROPIC_API_KEY=false', () => {
  it('no code path reads a key from the environment, a file or an input', () => {
    expect(INVARIANT_DECLARATIONS.REQUIRES_ANTHROPIC_API_KEY).toBe(false);

    const bans: readonly [string, RegExp][] = [
      ['env read of a named key', /env\s*(\.\s*[A-Z_]*API_KEY|\[\s*['"][A-Z_]*API_KEY)/],
      ['env read of a token', /env\s*(\.\s*[A-Z_]*AUTH_TOKEN|\[\s*['"][A-Z_]*AUTH_TOKEN)/],
      ['a key being assigned', /\bapiKey\s*[:=]/],
      ['apiKeyHelper wiring', /\bapiKeyHelper\b/],
      ['a password input control', /type\s*=\s*["']password["']/],
      ['copy that asks for a key', /enter[^.\n]{0,40}api\s*key/i],
      ['a credentials file being read', /readFileSync\([^)]*\.(credentials|netrc)\b/i],
    ];

    const hits = bans.flatMap(([label, pattern]) => scan(FILES, pattern).map((h) => `${label}: ${h}`));
    expect(hits, `an API-key path exists:\n${hits.join('\n')}`).toEqual([]);
  });

  it('the probe reports the NAME of a credential source and never a credential', () => {
    // `locate.ts` carries an `apiKeySource` field. It is the name of a source
    // ("none" on this machine), and the health path must never surface a value.
    const locate = fileFor('src/bridge/claude/locate.ts');
    expect(locate.text).toMatch(/apiKeySource/);
    // Nothing may put captured child output into a result by default.
    expect(scan(FILES, /includeDiagnosticExcerpt\s*:\s*true/)).toEqual([]);
  });
});

/* ========================================================================== */
/*  INVARIANT USES_LOCAL_CLAUDE_CODE=true                                      */
/* ========================================================================== */

describe('INVARIANT USES_LOCAL_CLAUDE_CODE=true', () => {
  it('the only runtime the bridge invokes is a local executable started from an argv array with no shell', () => {
    expect(INVARIANT_DECLARATIONS.USES_LOCAL_CLAUDE_CODE).toBe(true);

    const locate = fileFor('src/bridge/claude/locate.ts');
    expect(locate.text, 'locate.ts must spawn through node:child_process').toMatch(
      /from\s+['"]node:child_process['"]/,
    );
    // An argv ARRAY and shell:false. A shell would reinterpret quoting, `&` and
    // `%VAR%` in anything that reached it.
    expect(locate.text).toMatch(/shell:\s*false/);
    expect(scan(FILES, /shell\s*:\s*true/), 'shell execution is enabled somewhere').toEqual([]);

    // No string-command API anywhere in the bridge. `RegExp.prototype.exec` is
    // not process execution and is excluded by the leading-dot filter.
    const stringCommands = scan(BRIDGE_FILES, /\b(execSync|exec)\s*\(/).filter(
      (line) => !/\.\s*exec\s*\(/.test(line),
    );
    expect(stringCommands, `string-command execution:\n${stringCommands.join('\n')}`).toEqual([]);
  });

  it('discovers the executable at run time instead of hardcoding a machine', () => {
    const locate = fileFor('src/bridge/claude/locate.ts');
    expect(locate.text, 'the install root must be read from the environment at run time').toMatch(
      /process\.env\.APPDATA/,
    );
    expect(locate.text, 'PATH must be searched too').toMatch(/process\.env\.PATH/);

    const hardcoded = scan(CLAUDE_FILES, /[A-Za-z]:\\{1,2}Users\\{1,2}|\/Users\/[a-z]/i);
    expect(hardcoded, `a user path is hardcoded:\n${hardcoded.join('\n')}`).toEqual([]);
  });
});

/* ========================================================================== */
/*  INVARIANT PRODUCTION_MOCK_DATA_ALLOWED=false                               */
/* ========================================================================== */

describe('INVARIANT PRODUCTION_MOCK_DATA_ALLOWED=false', () => {
  it('no bridge module imports the prototype fixture tree', () => {
    expect(INVARIANT_DECLARATIONS.PRODUCTION_MOCK_DATA_ALLOWED).toBe(false);

    const fixtureImports = scan(BRIDGE_FILES, /from\s+['"][^'"]*prototype[^'"]*['"]/);
    expect(fixtureImports, `the bridge imports fixtures:\n${fixtureImports.join('\n')}`).toEqual([]);

    // The contract itself must stay clean too: everything downstream imports it.
    const sharedImports = scan(
      FILES.filter((f) => f.rel.includes(join('src', 'shared'))),
      /from\s+['"][^'"]*prototype[^'"]*['"]/,
    );
    expect(sharedImports, `the shared contract imports fixtures:\n${sharedImports.join('\n')}`).toEqual([]);
  });

  it('USES_MOCK_DATA is derived from the running process, not asserted', () => {
    // The scan above covers the code as written; the derived declaration covers
    // the process as it runs. Both are needed, and neither is a constant.
    expect(DERIVED_DECLARATIONS).toContain('USES_MOCK_DATA');
    expect(Object.keys(INVARIANT_DECLARATIONS)).not.toContain('USES_MOCK_DATA');
  });
});

/* ========================================================================== */
/*  INVARIANT LAN_MODE=false                                                   */
/* ========================================================================== */

describe('INVARIANT LAN_MODE=false', () => {
  it('LAN mode is a compile-time false with no environment path into it', () => {
    expect(INVARIANT_DECLARATIONS.LAN_MODE).toBe(false);
    expect(LAN_MODE, 'the declaration and the config constant must agree').toBe(
      INVARIANT_DECLARATIONS.LAN_MODE,
    );

    const config = fileFor('src/bridge/config.ts');
    expect(config.text).toMatch(/export const LAN_MODE = false;/);

    // Not merely ignored — REFUSED. A variable that appears to work and does
    // nothing would leave an operator believing the bridge was on the LAN.
    for (const name of ['FORGE_BRIDGE_LAN', 'FORGE_BRIDGE_LAN_MODE']) {
      expect(FROZEN_ENV_VARS).toContain(name);
      const result = loadConfig({ [name]: '1' });
      expect(result.ok, `${name} did not stop the bridge starting`).toBe(false);
    }

    // Nothing anywhere may assign LAN_MODE a truthy value.
    const reassigned = scan(FILES, /\bLAN_MODE\s*=\s*(?:true|1\b|['"])/);
    expect(reassigned, `LAN_MODE is switched on somewhere:\n${reassigned.join('\n')}`).toEqual([]);
  });
});

/* ========================================================================== */
/*  INVARIANT REMOTE_ACCESS=false                                              */
/* ========================================================================== */

describe('INVARIANT REMOTE_ACCESS=false', () => {
  it('remote access is a compile-time false and no tunnel, proxy or relay client exists', () => {
    expect(INVARIANT_DECLARATIONS.REMOTE_ACCESS).toBe(false);
    expect(REMOTE_ACCESS).toBe(INVARIANT_DECLARATIONS.REMOTE_ACCESS);

    const config = fileFor('src/bridge/config.ts');
    expect(config.text).toMatch(/export const REMOTE_ACCESS = false;/);

    for (const name of ['FORGE_BRIDGE_REMOTE', 'FORGE_BRIDGE_TUNNEL', 'FORGE_BRIDGE_EXPOSE']) {
      expect(FROZEN_ENV_VARS).toContain(name);
      expect(loadConfig({ [name]: 'yes' }).ok, `${name} did not stop the bridge starting`).toBe(false);
    }

    const clients = scan(FILES, /from\s+['"](ngrok|localtunnel|cloudflared|http-proxy|socks|ssh2)['"]/);
    expect(clients, `a remote-access client is imported:\n${clients.join('\n')}`).toEqual([]);

    const reassigned = scan(FILES, /\bREMOTE_ACCESS\s*=\s*(?:true|1\b|['"])/);
    expect(reassigned, `REMOTE_ACCESS is switched on somewhere:\n${reassigned.join('\n')}`).toEqual([]);
  });
});

/* ========================================================================== */
/*  INVARIANT BIND_ADDRESS=127.0.0.1                                           */
/* ========================================================================== */

describe('INVARIANT BIND_ADDRESS=127.0.0.1', () => {
  it('the listener is pinned to the contract address and no non-loopback bind appears in the tree', () => {
    expect(INVARIANT_DECLARATIONS.BIND_ADDRESS).toBe('127.0.0.1');
    expect(REQUIRED_BIND_ADDRESS).toBe(INVARIANT_DECLARATIONS.BIND_ADDRESS);
    expect(BIND_ADDRESS).toBe(REQUIRED_BIND_ADDRESS);

    // `listen` is called with the contract constant, never with a config value
    // that something upstream could have changed.
    const server = fileFor('src/bridge/server.ts');
    expect(server.text).toMatch(/listen\(this\.config\.port,\s*REQUIRED_BIND_ADDRESS/);
    // And the address the OS reported is checked against it afterwards.
    expect(server.text).toMatch(/address\.address !== REQUIRED_BIND_ADDRESS/);

    const wildcard = scan(FILES, /0\.0\.0\.0/);
    expect(wildcard, `a non-loopback bind address appears:\n${wildcard.join('\n')}`).toEqual([]);

    for (const name of ['FORGE_BRIDGE_BIND', 'FORGE_BRIDGE_HOST']) {
      expect(FROZEN_ENV_VARS).toContain(name);
      expect(loadConfig({ [name]: '0.0.0.0' }).ok).toBe(false);
    }
  });
});

/* ========================================================================== */
/*  Fixtures for the derived half                                              */
/* ========================================================================== */

const NOW_MS = Date.UTC(2026, 6, 24, 12, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();

const EMPTY = emptyDeclarationInputs(NOW_MS);

/** Every observation present and positive. The only fully-supported state. */
const SUPPORTED: DeclarationInputs = {
  ...EMPTY,
  claudeProbe: {
    available: true,
    authenticated: true,
    failure: null,
    checkedAtMs: NOW_MS - 1_000,
    checkedAt: new Date(NOW_MS - 1_000).toISOString(),
    executablePath: 'C:\\probe\\claude.exe',
    version: '2.1.217',
    sessionObserved: true,
    note: 'a real -p call returned exit 0 with a result envelope and session id',
  },
  projectsRoot: {
    projectsRoot: 'C:\\home\\Documents\\ForgeProjecten',
    documentsDir: 'C:\\home\\Documents',
    documentsDirExists: true,
    source: 'home-documents',
    projectsRootExists: true,
  },
  registry: {
    loaded: true,
    detail: 'the registry answered a list request with 1 record(s)',
    projectsRoot: 'C:\\home\\Documents\\ForgeProjecten',
    recordCount: 1,
    unreadableCount: 0,
    pathsPresent: 1,
    pathsMissing: [],
  },
  agentActivations: {
    count: 2,
    lastAt: NOW_ISO,
    detail: 'counted over 1 stream(s)',
    refs: [{ kind: 'event', ref: 'evt-agent-1' }],
  },
  processExecutions: {
    spawned: 1,
    withExitCode: 1,
    lastAt: NOW_ISO,
    detail: '1 run record(s) inspected',
    refs: [{ kind: 'file', ref: 'records/run/r1.json' }],
  },
  fixtureSources: [],
  usage: [{ scope: 'run', scopeId: 'r1', exactFields: ['inputTokens', 'outputTokens'], fieldsExamined: 20 }],
  attachments: {
    pipelineRegistered: true,
    stagingRoot: 'C:\\home\\Documents\\ForgeProjecten\\p\\.forge\\attachments',
    writable: true,
    detail: 'a probe file was written and read back unchanged',
  },
};

/** Everything except USES_MOCK_DATA, whose true is the failure, not the goal. */
const POSITIVE_DECLARATIONS: readonly DerivedDeclarationName[] = DERIVED_DECLARATIONS.filter(
  (name) => name !== 'USES_MOCK_DATA',
);

/* ========================================================================== */
/*  DERIVED: false without evidence                                            */
/* ========================================================================== */

describe('DERIVED declarations are false when their evidence is absent', () => {
  const report = deriveDeclarations(EMPTY);

  it.each([...DERIVED_DECLARATIONS])('%s is false in the empty state', (name) => {
    expect(report.derived[name].value).toBe(false);
  });

  it.each([...DERIVED_DECLARATIONS])('%s says exactly what was missing', (name) => {
    const declaration = report.derived[name];
    expect(declaration.evidence.missing.length, `${name} is false with no stated reason`).toBeGreaterThan(0);
    expect(declaration.evidence.summary.length).toBeGreaterThan(10);
    expect(declaration.checkedAt).toBe(NOW_ISO);
  });

  it.each([...DERIVED_DECLARATIONS])('%s carries no evidence reference it does not have', (name) => {
    expect(report.derived[name].evidence.refs).toEqual([]);
    expect(report.derived[name].evidence.kind).toBe('NONE');
  });

  it('is exactly the state a freshly started bridge is in', () => {
    // The defect this file exists to prevent: a build that published
    // CONNECTED_TO_CLAUDE_CODE true while reporting that no probe had run.
    expect(report.derived.CONNECTED_TO_CLAUDE_CODE.value).toBe(false);
    expect(report.derived.CONNECTED_TO_CLAUDE_CODE.evidence.summary).toMatch(/no claude code probe/i);
    expect(report.derived.CONNECTED_TO_FORGE.value).toBe(false);
  });

  it('still reports the invariants, which do not depend on a running system', () => {
    expect(report.invariant).toEqual(INVARIANT_DECLARATIONS);
    expect(report.invariantProofs).toEqual(INVARIANT_DECLARATION_PROOFS);
    expect(report.computedAt).toBe(NOW_ISO);
  });
});

/* ========================================================================== */
/*  DERIVED: true only with evidence                                           */
/* ========================================================================== */

describe('DERIVED declarations turn true only when the evidence is there', () => {
  const supported = deriveDeclarations(SUPPORTED);

  it.each([...POSITIVE_DECLARATIONS])('%s is true when fully supported', (name) => {
    expect(supported.derived[name].value, supported.derived[name].evidence.missing.join(' | ')).toBe(true);
  });

  it.each([...POSITIVE_DECLARATIONS])('%s carries a re-checkable reference when true', (name) => {
    const declaration = supported.derived[name];
    expect(declaration.evidence.refs.length, `${name} is true with nothing to re-check`).toBeGreaterThan(0);
    expect(declaration.evidence.missing).toEqual([]);
    expect(declaration.evidence.kind).not.toBe('NONE');
  });

  it('does not report mock data when no fixture source is loaded', () => {
    expect(supported.derived.USES_MOCK_DATA.value).toBe(false);
  });

  it('reports mock data, with evidence, when a fixture source announces itself', () => {
    const withFixtures = deriveDeclarations({
      ...SUPPORTED,
      fixtureSources: [{ id: 'prototype/data/projects', detail: 'loaded by a test' }],
    });
    expect(withFixtures.derived.USES_MOCK_DATA.value).toBe(true);
    expect(withFixtures.derived.USES_MOCK_DATA.evidence.refs.length).toBeGreaterThan(0);
  });

  it('is deterministic — the same observations always produce the same report', () => {
    expect(deriveDeclarations(SUPPORTED)).toEqual(deriveDeclarations(SUPPORTED));
  });
});

/* ========================================================================== */
/*  DERIVED: every way each one can fail                                       */
/* ========================================================================== */

interface Weakening {
  readonly name: DerivedDeclarationName;
  readonly what: string;
  readonly inputs: DeclarationInputs;
}

const WEAKENINGS: readonly Weakening[] = [
  {
    name: 'CONNECTED_TO_CLAUDE_CODE',
    what: 'the probe never authenticated',
    inputs: { ...SUPPORTED, claudeProbe: { ...SUPPORTED.claudeProbe!, authenticated: false } },
  },
  {
    name: 'CONNECTED_TO_CLAUDE_CODE',
    what: 'the executable was not locatable',
    inputs: { ...SUPPORTED, claudeProbe: { ...SUPPORTED.claudeProbe!, available: false } },
  },
  {
    name: 'CONNECTED_TO_CLAUDE_CODE',
    what: 'the probe recorded a failure',
    inputs: { ...SUPPORTED, claudeProbe: { ...SUPPORTED.claudeProbe!, failure: 'TIMEOUT' } },
  },
  {
    name: 'CONNECTED_TO_CLAUDE_CODE',
    what: 'no session id came back',
    inputs: { ...SUPPORTED, claudeProbe: { ...SUPPORTED.claudeProbe!, sessionObserved: false } },
  },
  {
    name: 'CONNECTED_TO_CLAUDE_CODE',
    what: 'the last success is older than the freshness window',
    inputs: {
      ...SUPPORTED,
      claudeProbe: {
        ...SUPPORTED.claudeProbe!,
        checkedAtMs: NOW_MS - DEFAULT_CLAUDE_PROBE_FRESHNESS_MS - 1,
      },
    },
  },
  {
    name: 'CONNECTED_TO_FORGE',
    what: 'the registry did not load',
    inputs: { ...SUPPORTED, registry: { ...SUPPORTED.registry!, loaded: false } },
  },
  {
    name: 'CONNECTED_TO_FORGE',
    what: 'nothing on disk confirmed the Documents directory',
    inputs: { ...SUPPORTED, projectsRoot: { ...SUPPORTED.projectsRoot!, documentsDirExists: false } },
  },
  {
    name: 'CONNECTED_TO_FORGE',
    what: 'the projects root was a convention rather than a finding',
    inputs: { ...SUPPORTED, projectsRoot: { ...SUPPORTED.projectsRoot!, source: 'fallback-unverified' } },
  },
  {
    name: 'USES_REAL_PROJECTS',
    what: 'no project is registered at all',
    inputs: { ...SUPPORTED, registry: { ...SUPPORTED.registry!, recordCount: 0, pathsPresent: 0 } },
  },
  {
    name: 'USES_REAL_PROJECTS',
    what: 'a recorded path is not on disk',
    inputs: {
      ...SUPPORTED,
      registry: {
        ...SUPPORTED.registry!,
        pathsPresent: 0,
        pathsMissing: [{ id: 'p1', canonicalPath: 'C:\\gone', detail: 'nothing exists at the recorded path' }],
      },
    },
  },
  {
    name: 'USES_REAL_PROJECTS',
    what: 'a project record could not be read',
    inputs: { ...SUPPORTED, registry: { ...SUPPORTED.registry!, unreadableCount: 1 } },
  },
  {
    name: 'USES_REAL_AGENTS',
    what: 'no activation was ever recorded',
    inputs: { ...SUPPORTED, agentActivations: { ...SUPPORTED.agentActivations!, count: 0, refs: [] } },
  },
  {
    name: 'USES_REAL_COMMANDS',
    what: 'no process id and no exit code was ever recorded',
    inputs: {
      ...SUPPORTED,
      processExecutions: { ...SUPPORTED.processExecutions!, spawned: 0, withExitCode: 0, refs: [] },
    },
  },
  {
    name: 'USES_REAL_USAGE_TELEMETRY',
    what: 'snapshots exist but nothing in them is EXACT',
    inputs: { ...SUPPORTED, usage: [{ scope: 'run', scopeId: 'r1', exactFields: [], fieldsExamined: 20 }] },
  },
  {
    name: 'USES_REAL_USAGE_TELEMETRY',
    what: 'no snapshot exists',
    inputs: { ...SUPPORTED, usage: [] },
  },
  {
    name: 'SUPPORTS_FILE_ATTACHMENTS',
    what: 'the staging root did not accept a write',
    inputs: { ...SUPPORTED, attachments: { ...SUPPORTED.attachments!, writable: false } },
  },
  {
    name: 'SUPPORTS_FILE_ATTACHMENTS',
    what: 'no staging root could be resolved',
    inputs: { ...SUPPORTED, attachments: { ...SUPPORTED.attachments!, stagingRoot: null } },
  },
  {
    name: 'SUPPORTS_FILE_ATTACHMENTS',
    what: 'no pipeline is registered',
    inputs: { ...SUPPORTED, attachments: { ...SUPPORTED.attachments!, pipelineRegistered: false } },
  },
];

describe('a declaration cannot survive losing its evidence', () => {
  it.each(WEAKENINGS.map((w): [string, string, Weakening] => [w.name, w.what, w]))(
    '%s is false when %s',
    (_name, _what, weakening) => {
      const declaration = deriveDeclarations(weakening.inputs).derived[weakening.name];
      expect(declaration.value).toBe(false);
      expect(declaration.evidence.missing.length).toBeGreaterThan(0);
    },
  );

  it('covers every declaration that can be positively claimed', () => {
    const covered = new Set(WEAKENINGS.map((w) => w.name));
    for (const name of POSITIVE_DECLARATIONS) {
      expect(covered.has(name), `${name} has no weakening case`).toBe(true);
    }
  });
});

/* ========================================================================== */
/*  No declaration can be true without a reference                             */
/* ========================================================================== */

describe('no declaration can be true without a re-checkable reference', () => {
  it('downgrades a positive count that carries no evidence reference', () => {
    // The counts say something happened; nothing points at where. That is not
    // evidence, and the constructor refuses to let it become a claim.
    const report = deriveDeclarations({
      ...SUPPORTED,
      agentActivations: { count: 7, lastAt: NOW_ISO, detail: 'counted, but nothing recorded', refs: [] },
      processExecutions: { spawned: 3, withExitCode: 3, lastAt: NOW_ISO, detail: 'counted only', refs: [] },
    });
    expect(report.derived.USES_REAL_AGENTS.value).toBe(false);
    expect(report.derived.USES_REAL_AGENTS.evidence.missing.join(' ')).toMatch(/evidence reference/i);
    expect(report.derived.USES_REAL_COMMANDS.value).toBe(false);
  });

  it('holds across every declaration in every state exercised by this suite', () => {
    const states: readonly DeclarationInputs[] = [
      EMPTY,
      SUPPORTED,
      ...WEAKENINGS.map((w) => w.inputs),
      { ...SUPPORTED, fixtureSources: [{ id: 'fixture', detail: 'loaded' }] },
    ];
    for (const inputs of states) {
      const report = deriveDeclarations(inputs);
      for (const name of DERIVED_DECLARATIONS) {
        const declaration = report.derived[name];
        if (declaration.value) {
          expect(declaration.evidence.refs.length, `${name} is true with no reference`).toBeGreaterThan(0);
          expect(declaration.evidence.missing, `${name} is true and still lists a shortfall`).toEqual([]);
        } else {
          expect(declaration.evidence.missing.length, `${name} is false with no reason`).toBeGreaterThan(0);
        }
      }
    }
  });
});

/* ========================================================================== */
/*  Explaining a report                                                        */
/* ========================================================================== */

describe('explainDeclarations says why, for every declaration', () => {
  it('covers the invariants and the derived half with no gaps', () => {
    const explanations = explainDeclarations(deriveDeclarations(EMPTY));
    const names = explanations.map((e) => e.name).sort();
    const expected = [...Object.keys(INVARIANT_DECLARATIONS), ...DERIVED_DECLARATIONS].sort();
    expect(names).toEqual(expected);
  });

  it('gives every invariant the name of its proof', () => {
    for (const explanation of explainDeclarations(deriveDeclarations(EMPTY))) {
      if (explanation.kind !== 'INVARIANT') continue;
      expect(explanation.reason).toMatch(/runtime-declarations\.test\.ts/);
      expect(explanation.checkedAt).toBeNull();
    }
  });

  it('lists what is unproven without listing what is correctly false', () => {
    // USES_MOCK_DATA false IS the required value. Reporting it as a shortfall
    // would send an operator to fix the one thing that is already right.
    const empty = unprovenDeclarations(deriveDeclarations(EMPTY));
    expect(empty).not.toContain('USES_MOCK_DATA');
    expect([...empty].sort()).toEqual([...POSITIVE_DECLARATIONS].sort());
    expect(unprovenDeclarations(deriveDeclarations(SUPPORTED))).toEqual([]);
  });

  it('gives every unproven derived declaration a reason and a shortfall', () => {
    for (const explanation of explainDeclarations(deriveDeclarations(EMPTY))) {
      if (explanation.kind !== 'DERIVED') continue;
      expect(explanation.value).toBe(false);
      expect(explanation.reason.length).toBeGreaterThan(10);
      expect(explanation.missing.length).toBeGreaterThan(0);
      expect(explanation.checkedAt).toBe(NOW_ISO);
    }
  });
});
