/**
 * `gateway-files.ts` — the real lazy file-tree builder + read-preview parser
 * (cc-wire-views). No network, no React, no timers: pure-function tests
 * against representative `/api/files` / `/api/files/read` response shapes,
 * mirroring `account-usage.test.ts`'s own precedent for this seam.
 */

import { describe, expect, it } from 'vitest';

import {
  buildGatewayFileTree,
  errorFilePreview,
  formatFileBytes,
  parseDirectoryEntries,
  parseFilePreviewResponse,
  type GatewayDirState,
} from '@/prototype/state/gateway-files';

describe('parseDirectoryEntries — maps GET /api/files 1:1, never inventing a field', () => {
  it('reads name/type/size/mtime straight off real entries', () => {
    const entries = parseDirectoryEntries({
      ok: true,
      path: '.',
      entries: [
        { name: 'src', type: 'dir', size: null, mtime: '2026-07-28T10:00:00.000Z' },
        { name: 'package.json', type: 'file', size: 1234, mtime: '2026-07-28T09:00:00.000Z' },
      ],
      entries_count: 2,
    });

    expect(entries).toEqual([
      { name: 'src', type: 'dir', size: null, mtime: '2026-07-28T10:00:00.000Z' },
      { name: 'package.json', type: 'file', size: 1234, mtime: '2026-07-28T09:00:00.000Z' },
    ]);
  });

  it('an empty entries array (a genuinely empty real directory) parses to empty, not a fabricated row', () => {
    expect(parseDirectoryEntries({ ok: true, path: 'empty-dir', entries: [], entries_count: 0 })).toEqual([]);
  });

  it('a missing entries array resolves to empty rather than throwing', () => {
    expect(parseDirectoryEntries({ ok: false, error: 'path not found' })).toEqual([]);
  });

  it('an unrecognised type value falls back to file, never dir (the safer under-recursion)', () => {
    const entries = parseDirectoryEntries({ entries: [{ name: 'weird', type: 'symlink', size: null, mtime: null }] });
    expect(entries[0].type).toBe('file');
  });
});

describe('formatFileBytes — a real byte count into a short display string', () => {
  it('stays in bytes under 1024', () => {
    expect(formatFileBytes(0)).toBe('0 B');
    expect(formatFileBytes(512)).toBe('512 B');
    expect(formatFileBytes(1023)).toBe('1023 B');
  });

  it('steps to KB at the 1024 boundary', () => {
    expect(formatFileBytes(1024)).toBe('1.0 KB');
    expect(formatFileBytes(1536)).toBe('1.5 KB');
  });

  it('steps to MB and GB at their own boundaries', () => {
    expect(formatFileBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('never fabricates a size for an invalid input', () => {
    expect(formatFileBytes(-5)).toBe('');
    expect(formatFileBytes(Number.NaN)).toBe('');
  });
});

describe('buildGatewayFileTree — lazy: loaded vs not-yet-expanded vs genuinely empty', () => {
  function dirs(entries: readonly [string, GatewayDirState][]): ReadonlyMap<string, GatewayDirState> {
    return new Map(entries);
  }

  it('an empty map (root never fetched yet) is an empty tree, not an error', () => {
    expect(buildGatewayFileTree(new Map())).toEqual([]);
  });

  it('the root level IS the tree — no wrapping "." node, matching the fixture tree shape', () => {
    const tree = buildGatewayFileTree(
      dirs([
        [
          '.',
          {
            status: 'loaded',
            entries: [
              { name: 'src', type: 'dir', size: null, mtime: '2026-07-28T10:00:00.000Z' },
              { name: 'README.md', type: 'file', size: 2048, mtime: '2026-07-28T09:00:00.000Z' },
            ],
          },
        ],
      ]),
    );

    expect(tree).toHaveLength(2);
    expect(tree[0].id).toBe('src');
    expect(tree[0].path).toBe('src');
    expect(tree[0].kind).toBe('dir');
    expect(tree[1].id).toBe('README.md');
    expect(tree[1].kind).toBe('file');
    expect(tree[1].size).toBe('2.0 KB');
  });

  it('a directory not yet fetched has children undefined — the disclosure chevron still shows, nothing recurses', () => {
    const tree = buildGatewayFileTree(
      dirs([['.', { status: 'loaded', entries: [{ name: 'src', type: 'dir', size: null, mtime: null }] }]]),
    );
    expect(tree[0].children).toBeUndefined();
  });

  it('a directory that WAS fetched and is genuinely empty gets children: [], distinct from "not fetched"', () => {
    const tree = buildGatewayFileTree(
      dirs([
        ['.', { status: 'loaded', entries: [{ name: 'empty', type: 'dir', size: null, mtime: null }] }],
        ['empty', { status: 'loaded', entries: [] }],
      ]),
    );
    expect(tree[0].children).toEqual([]);
  });

  it('a loaded nested directory attaches its own children at the right relative path', () => {
    const tree = buildGatewayFileTree(
      dirs([
        ['.', { status: 'loaded', entries: [{ name: 'src', type: 'dir', size: null, mtime: null }] }],
        ['src', { status: 'loaded', entries: [{ name: 'index.ts', type: 'file', size: 100, mtime: null }] }],
      ]),
    );
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children?.[0].id).toBe('src/index.ts');
    expect(tree[0].children?.[0].path).toBe('src/index.ts');
  });

  it('a directory still loading or errored is also treated as not-yet-expanded (children undefined)', () => {
    const loading = buildGatewayFileTree(
      dirs([['.', { status: 'loading', entries: null }]]),
    );
    const errored = buildGatewayFileTree(dirs([['.', { status: 'error', entries: null }]]));
    expect(loading).toEqual([]);
    expect(errored).toEqual([]);
  });

  it('a file never carries a diff, a change marker, or the prototype flag — real nodes are not fixtures', () => {
    const tree = buildGatewayFileTree(
      dirs([['.', { status: 'loaded', entries: [{ name: 'a.ts', type: 'file', size: 10, mtime: null }] }]]),
    );
    const node = tree[0] as unknown as Record<string, unknown>;
    expect(node.diff).toBeUndefined();
    expect(node.changed).toBeUndefined();
    expect(node.prototype).not.toBe(true);
  });
});

describe('parseFilePreviewResponse — GET /api/files/read outcomes', () => {
  it('a blocked file carries the reason, never the content field', () => {
    const preview = parseFilePreviewResponse('.env', {
      ok: true,
      blocked: true,
      reason: 'env-file',
      path: '.env',
    });
    expect(preview.status).toBe('blocked');
    expect(preview.reason).toBe('env-file');
    expect(preview.content).toBeNull();
  });

  it('a binary file reports size but no content', () => {
    const preview = parseFilePreviewResponse('logo.png', {
      ok: true,
      binary: true,
      path: 'logo.png',
      size: 45000,
    });
    expect(preview.status).toBe('binary');
    expect(preview.size).toBe(45000);
    expect(preview.content).toBeNull();
  });

  it('a real text file carries its content and truncation flag', () => {
    const preview = parseFilePreviewResponse('README.md', {
      ok: true,
      binary: false,
      blocked: false,
      path: 'README.md',
      size: 20,
      truncated: false,
      content: '# Hello\n',
    });
    expect(preview.status).toBe('text');
    expect(preview.content).toBe('# Hello\n');
    expect(preview.truncated).toBe(false);
  });

  it('an empty real file is real content, not absence — never coerced to null', () => {
    const preview = parseFilePreviewResponse('empty.txt', {
      ok: true,
      binary: false,
      blocked: false,
      path: 'empty.txt',
      size: 0,
      truncated: false,
      content: '',
    });
    expect(preview.status).toBe('text');
    expect(preview.content).toBe('');
  });

  it('a truncated file reports truncated: true', () => {
    const preview = parseFilePreviewResponse('big.log', {
      ok: true,
      binary: false,
      blocked: false,
      path: 'big.log',
      size: 999999,
      truncated: true,
      content: 'partial…',
    });
    expect(preview.truncated).toBe(true);
  });
});

describe('errorFilePreview', () => {
  it('carries the real transport error, never a fabricated one', () => {
    const preview = errorFilePreview('x.ts', 'HTTP 502');
    expect(preview.status).toBe('error');
    expect(preview.error).toBe('HTTP 502');
    expect(preview.content).toBeNull();
  });
});
