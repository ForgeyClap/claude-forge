/**
 * The boundary scan.
 *
 * The prototype was inert everywhere. The connected workspace is not: the bridge
 * must touch the filesystem and must spawn the Claude Code CLI — that is its
 * entire job. So a single blanket ban is now the wrong test. It would either
 * fail honest code or, worse, be relaxed into meaninglessness.
 *
 * Instead the source is split into two zones with DIFFERENT rules, and each zone
 * is held to the rule that actually protects the user there:
 *
 *   BROWSER ZONE (everything in src/ except src/bridge)
 *     Runs inside the page. Must never reach the filesystem, never spawn a
 *     process, and never open a socket to anything but the local bridge.
 *
 *   BRIDGE ZONE (src/bridge)
 *     Runs in Node with the user's privileges. Filesystem and process spawning
 *     are expected. What is forbidden is the way those powers get abused:
 *     shell interpolation, binding beyond loopback, and reaching the internet.
 *
 * Both zones share one absolute rule: no Anthropic/vendor API endpoint, and no
 * code path that reads an API key.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');
const BRIDGE = join(SRC, 'bridge');

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
        rel: relative(process.cwd(), abs),
        zone: abs.startsWith(BRIDGE + sep) ? 'bridge' : 'browser',
        text: readFileSync(abs, 'utf8'),
      });
    }
  }
  return acc;
}

const FILES = collect(SRC);
const BROWSER = FILES.filter((f) => f.zone === 'browser');
const BRIDGE_FILES = FILES.filter((f) => f.zone === 'bridge');

/** A comment documenting a ban is not a violation of it. */
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

describe('the source tree is split into the two zones this test assumes', () => {
  it('finds a substantial browser zone', () => {
    expect(BROWSER.length).toBeGreaterThan(40);
  });

  it('finds a bridge zone', () => {
    expect(BRIDGE_FILES.length).toBeGreaterThan(5);
  });
});

/* ------------------------------------------------------------ both zones */

describe('no vendor API endpoint exists anywhere', () => {
  const RULES: [string, RegExp][] = [
    ['Anthropic API host', /api\.anthropic\.com/i],
    ['Claude web API', /claude\.ai\/api/i],
    ['OpenAI API host', /api\.openai\.com/i],
    ['NVIDIA API host', /api\.nvidia\.com|integrate\.api\.nvidia/i],
    ['Anthropic SDK import', /from\s+['"]@anthropic-ai\//],
    ['OpenAI SDK import', /from\s+['"]openai['"]/],
  ];

  it.each(RULES)('contains no %s', (_name, pattern) => {
    const hits = scan(FILES, pattern);
    expect(hits, `forbidden endpoint:\n${hits.join('\n')}`).toEqual([]);
  });
});

describe('no code path reads an API key', () => {
  // The DECLARATION `REQUIRES_ANTHROPIC_API_KEY: false` is the honest statement
  // that we need no key, so the bare identifier is allowed. What must not exist
  // is anything that would READ one.
  const RULES: [string, RegExp][] = [
    ['env read of ANTHROPIC_API_KEY', /env\s*(\.\s*ANTHROPIC_API_KEY|\[\s*['"]ANTHROPIC_API_KEY)/],
    ['env read of a generic api key', /env\s*(\.\s*[A-Z_]*API_KEY|\[\s*['"][A-Z_]*API_KEY)/],
    ['apiKey property assignment', /\bapiKey\s*[:=]/],
    ['apiKeyHelper wiring', /\bapiKeyHelper\b/],
    ['password input control', /type\s*=\s*["']password["']/],
    ['"enter ... api key" copy', /enter[^.\n]{0,40}api\s*key/i],
  ];

  it.each(RULES)('contains no %s', (_name, pattern) => {
    const hits = scan(FILES, pattern);
    expect(hits, `API-key path found:\n${hits.join('\n')}`).toEqual([]);
  });
});

/* ---------------------------------------------------------- browser zone */

describe('the browser zone cannot touch the machine', () => {
  const RULES: [string, RegExp][] = [
    ['node:fs import', /from\s+['"](node:)?fs(\/promises)?['"]/],
    ['node:child_process import', /from\s+['"](node:)?child_process['"]/],
    // Not `.exec(` — that is RegExp.prototype.exec, which every Markdown and
    // diff parser in the browser zone uses legitimately.
    ['process spawning', /(^|[^.\w])(spawn|spawnSync|execSync|execFile|fork)\s*\(/],
    ['node:os import', /from\s+['"](node:)?os['"]/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['sendBeacon', /\bsendBeacon\b/],
    ['EventSource', /\bnew\s+EventSource\b/],
  ];

  it.each(RULES)('contains no %s', (_name, pattern) => {
    const hits = scan(BROWSER, pattern);
    expect(hits, `browser zone violation:\n${hits.join('\n')}`).toEqual([]);
  });

  it('opens sockets only to the local bridge', () => {
    // The connected UI legitimately holds a WebSocket. It may only ever point at
    // loopback: any other host would be the browser talking to the internet.
    const sockets = BROWSER.flatMap((f) =>
      offendingLines(f, /new\s+WebSocket\s*\(|wss?:\/\//),
    );
    const external = sockets.filter(
      (line) => !/127\.0\.0\.1|localhost|\[::1\]|BRIDGE_URL|bridgeUrl|location\.host/i.test(line),
    );
    expect(external, `browser socket to a non-local host:\n${external.join('\n')}`).toEqual([]);
  });

  it('makes no fetch to an absolute non-local URL', () => {
    const fetches = BROWSER.flatMap((f) => offendingLines(f, /fetch\s*\(\s*['"`]https?:\/\//));
    const external = fetches.filter((line) => !/127\.0\.0\.1|localhost|\[::1\]/i.test(line));
    expect(external, `browser fetch to a non-local host:\n${external.join('\n')}`).toEqual([]);
  });

  /**
   * WP10 should-fix-now #13 (AP-7): `gateway-client.ts` reaches the network through
   * `globalThis.fetch(` / `new globalThis.EventSource(` — a MemberExpression, not the bare
   * `fetch(`/`new EventSource(` identifiers the two checks above (and the repo's ESLint
   * `no-restricted-globals`/`no-restricted-syntax` rules) actually scan for. That is a DELIBERATE,
   * legitimate pattern (see bridge-client.ts's own header comment: "the one legitimate place the
   * frontend reaches its own loopback backend"), but until now nothing here asserted that every
   * such call site is actually scoped to loopback — the "offline-only" guarantee did not cover
   * this production path, resting only on the GATEWAY_ORIGIN literal happening to be loopback.
   * This closes that gap the same way the bridge zone's "makes no outbound network call" check
   * (below) already does: read a window of context around each call site, but ALSO accept a
   * loopback marker declared anywhere in the same file's head (constants such as GATEWAY_ORIGIN /
   * BRIDGE base URLs are conventionally declared near the top of the file, well outside a small
   * fixed-line window from a call site many lines below).
   */
  it('reaches the gateway/bridge via globalThis.fetch/EventSource only with a loopback target in scope', () => {
    const CALL = /\bglobalThis\.fetch\s*\(|\bnew\s+globalThis\.EventSource\s*\(/;
    const LOOPBACK = /127\.0\.0\.1|localhost|\[::1\]|GATEWAY_ORIGIN|gatewayUrl|BRIDGE_URL|bridgeUrl/i;
    const HEAD_LINES = 40; // where a loopback base-URL constant is conventionally declared

    const external: string[] = [];
    for (const file of BROWSER) {
      const lines = file.text.split('\n');
      const fileHead = lines.slice(0, HEAD_LINES).join('\n');
      lines.forEach((line, i) => {
        if (!CALL.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const window = lines.slice(Math.max(0, i - 2), i + 8).join('\n');
        if (!LOOPBACK.test(window) && !LOOPBACK.test(fileHead)) {
          external.push(`${file.rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(
      external,
      `globalThis.fetch/EventSource call with no loopback target anywhere in scope:\n${external.join('\n')}`,
    ).toEqual([]);
  });

  it('asserts at least one real globalThis.fetch/EventSource call site exists (this check is meaningful, not vacuously passing)', () => {
    const CALL = /\bglobalThis\.fetch\s*\(|\bnew\s+globalThis\.EventSource\s*\(/;
    const hits = scan(BROWSER, CALL);
    expect(hits.length, 'expected at least one globalThis.fetch/EventSource call site in the browser zone').toBeGreaterThan(0);
  });
});

/**
 * WP10 should-fix-now #13 (AP-7): the gateway's production entry point is a hardcoded literal
 * (`gateway-client.ts`'s `GATEWAY_ORIGIN`) — this asserts its exact SHAPE directly, rather than only
 * relying on the window-scan above to notice a stray non-loopback host inside a nearby call.
 */
describe('the gateway client origin is provably loopback-only', () => {
  it('GATEWAY_ORIGIN matches http://(127.0.0.1|localhost|[::1])[:port] and nothing else', async () => {
    const { GATEWAY_ORIGIN } = await import('@/prototype/state/gateway-client');
    expect(GATEWAY_ORIGIN).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/);
  });
});

/* ----------------------------------------------------------- bridge zone */

describe('the bridge holds real power safely', () => {
  it('never spawns through a shell', () => {
    // shell:true turns an argv array back into an interpretable command line,
    // which is exactly how a filename or project name becomes code execution.
    const hits = scan(BRIDGE_FILES, /shell\s*:\s*true/);
    expect(hits, `shell execution enabled:\n${hits.join('\n')}`).toEqual([]);
  });

  it('never uses the string-command exec APIs', () => {
    // execSync/exec take a command LINE. execFile/spawn take an argv ARRAY.
    // Only the array forms are permitted.
    const hits = scan(BRIDGE_FILES, /\b(execSync|exec)\s*\(/).filter(
      // `RegExp.prototype.exec` is not process execution.
      (line) => !/\.\s*exec\s*\(/.test(line),
    );
    expect(hits, `string-command execution:\n${hits.join('\n')}`).toEqual([]);
  });

  it('never binds beyond loopback', () => {
    const hits = scan(BRIDGE_FILES, /0\.0\.0\.0|::\s*['"]?0\.0\.0\.0|host\s*:\s*['"]\s*['"]/);
    expect(hits, `non-loopback bind:\n${hits.join('\n')}`).toEqual([]);
  });

  it('makes no outbound network call', () => {
    // Importing node:http is expected — that is how the bridge SERVES on
    // loopback. What must not exist is a CLIENT call to a non-local host.
    //
    // The target is almost never on the same line as the call: an options object
    // spans several lines. So the check reads a window around each call site and
    // requires a loopback marker somewhere inside it.
    const LOOPBACK = /127\.0\.0\.1|localhost|\[::1\]|BIND_ADDRESS|bindAddress/i;
    const CALL = /\bfetch\s*\(|\baxios\b|https?Request\s*\(|https?\.request\s*\(/;

    const external: string[] = [];
    for (const file of BRIDGE_FILES) {
      const lines = file.text.split('\n');
      lines.forEach((line, i) => {
        if (!CALL.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
        const window = lines.slice(Math.max(0, i - 2), i + 8).join('\n');
        if (!LOOPBACK.test(window)) {
          external.push(`${file.rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(external, `bridge call with no loopback target in scope:\n${external.join('\n')}`).toEqual(
      [],
    );
  });

  /**
   * The two flag bans below are asserted the strict way round.
   *
   * A naive "this string must not appear" test punishes the denylist that makes
   * the ban real. So instead: the denylist MUST exist and MUST contain the flag,
   * and the flag may appear nowhere else in the tree. That proves both halves —
   * the guard is present, and nothing bypasses it.
   */
  const DENYLIST_FILE = 'src\\bridge\\claude\\locate.ts';

  function assertOnlyInDenylist(flag: string): void {
    const hits = scan(FILES, new RegExp(flag.replace(/-/g, '\\-')));
    const outside = hits.filter((h) => !h.startsWith(DENYLIST_FILE));
    expect(hits.length, `${flag} is not declared in any denylist`).toBeGreaterThan(0);
    expect(outside, `${flag} used outside the denylist:\n${outside.join('\n')}`).toEqual([]);
  }

  it('declares --dangerously-skip-permissions as forbidden and uses it nowhere', () => {
    assertOnlyInDenylist('--dangerously-skip-permissions');
  });

  it('declares --max-turns as forbidden and uses it nowhere', () => {
    // Confirmed absent from Claude Code 2.1.217 by reading the installed CLI's
    // own --help. Passing it would abort every run at argument parsing.
    assertOnlyInDenylist('--max-turns');
  });

  it('refuses the bypassPermissions mode', () => {
    const declared = scan(FILES, /bypassPermissions/);
    expect(declared.length, 'bypassPermissions is not refused anywhere').toBeGreaterThan(0);
    const outside = declared.filter((h) => !h.startsWith(DENYLIST_FILE));
    expect(outside, `bypassPermissions referenced outside the denylist:\n${outside.join('\n')}`).toEqual(
      [],
    );
  });
});
