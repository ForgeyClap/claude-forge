#!/usr/bin/env node
/**
 * Forge Workspace — backup.
 *
 * Zero dependencies: Node built-ins only (fs, path, os, zlib, crypto). Archives
 * the workspace (`.forge-workspace`) and, optionally, a chosen project folder
 * into a single timestamped ZIP under a backups directory, writes a hash
 * manifest, and prints the paths.
 *
 *   node scripts/backup.cjs [--project <dir>] [--workspace <dir>] [--out <dir>]
 *                           [--include-all]
 *
 * A minimal, standard (no ZIP64) PKZIP writer is implemented here rather than
 * pulled from npm, so a backup never depends on a network install being
 * reachable — which is exactly the situation a backup is for. Every archived
 * file's SHA-256 is recorded both inside the ZIP (`MANIFEST.json`) and in a
 * sidecar `<zip>.manifest.json`, so `restore.cjs` can prove what it restores is
 * byte-for-byte what was archived.
 *
 * By default `node_modules` and `.git` are skipped (they are regenerated, not
 * data); pass --include-all to archive them too.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const WORKSPACE_DIR_NAME = '.forge-workspace';
const DEFAULT_EXCLUDED_DIRS = new Set(['node_modules', '.git']);
const MAX_ZIP_MEMBER = 0xffffffff; // no ZIP64 — refuse a >4 GiB member honestly.

/* -------------------------------------------------------------------------- */
/*  Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { flags: {}, bools: new Set() };
  const takesValue = new Set(['--project', '--workspace', '--out']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value.`);
      out.flags[arg] = value;
      i += 1;
    } else if (arg === '--include-all' || arg === '--help' || arg === '-h') {
      out.bools.add(arg);
    } else {
      fail(`Unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  return out;
}

function fail(message) {
  process.stderr.write(`[backup] ERROR: ${message}\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  CRC-32 and DOS time                                                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const dt = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  const year = Math.max(1980, dt.getFullYear());
  const date = ((year - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  const time = (dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2);
  return { date: date & 0xffff, time: time & 0xffff };
}

/* -------------------------------------------------------------------------- */
/*  ZIP writer (streamed to an fd)                                             */
/* -------------------------------------------------------------------------- */

class ZipWriter {
  constructor(fd) {
    this.fd = fd;
    this.offset = 0;
    this.entries = [];
  }

  _write(buf) {
    let written = 0;
    while (written < buf.length) written += fs.writeSync(this.fd, buf, written, buf.length - written, null);
    this.offset += buf.length;
  }

  addFile(entryName, content, mtime) {
    if (content.length > MAX_ZIP_MEMBER) {
      fail(`"${entryName}" is ${content.length} bytes; this backup format (no ZIP64) tops out at 4 GiB per file.`);
    }
    const nameBuf = Buffer.from(entryName.split('\\').join('/'), 'utf8');
    const crc = crc32(content);
    const uSize = content.length;
    const compressed = zlib.deflateRawSync(content);
    let method = 8;
    let data = compressed;
    if (compressed.length >= content.length) {
      method = 0; // storing is smaller for already-compressed or tiny inputs.
      data = content;
    }
    const { date, time } = dosDateTime(mtime);
    const localOffset = this.offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // bit 11: UTF-8 filenames
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    this._write(local);
    this._write(nameBuf);
    this._write(data);

    this.entries.push({ nameBuf, crc, cSize: data.length, uSize, method, date, time, localOffset });
  }

  end() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.cSize, 20);
      h.writeUInt32LE(e.uSize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30);
      h.writeUInt16LE(0, 32);
      h.writeUInt16LE(0, 34);
      h.writeUInt16LE(0, 36);
      h.writeUInt32LE(0, 38);
      h.writeUInt32LE(e.localOffset, 42);
      this._write(h);
      this._write(e.nameBuf);
    }
    const cdSize = this.offset - cdStart;
    if (this.entries.length > 0xffff) fail('too many files for a non-ZIP64 archive (65535 max).');

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    this._write(eocd);
  }
}

/* -------------------------------------------------------------------------- */
/*  Filesystem walking                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Collect every regular file under `root`, as { abs, rel }. Symlinks are NOT
 * followed — a backup that chased a link out of the tree would archive whatever
 * it pointed at, which is neither expected nor safe.
 */
function walk(root, includeAll, skipped) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dir, reason: `unreadable directory (${err.code || err.message})` });
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push({ path: abs, reason: 'symbolic link (not followed)' });
        continue;
      }
      if (entry.isDirectory()) {
        if (!includeAll && DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
          skipped.push({ path: abs, reason: `excluded directory "${entry.name}" (use --include-all to keep it)` });
          continue;
        }
        stack.push(abs);
      } else if (entry.isFile()) {
        files.push({ abs, rel: path.relative(root, abs) });
      } else {
        skipped.push({ path: abs, reason: 'not a regular file' });
      }
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

function timestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bools.has('--help') || args.bools.has('-h')) {
    process.stdout.write(
      'Usage: node scripts/backup.cjs [--project <dir>] [--workspace <dir>] [--out <dir>] [--include-all]\n',
    );
    return 0;
  }

  const repoRoot = path.resolve(__dirname, '..');
  const includeAll = args.bools.has('--include-all');

  const workspaceDir = path.resolve(
    args.flags['--workspace'] ||
      (process.env.FORGE_WORKSPACE_DIR && process.env.FORGE_WORKSPACE_DIR.trim()) ||
      path.join(repoRoot, WORKSPACE_DIR_NAME),
  );
  const projectDir = args.flags['--project'] ? path.resolve(args.flags['--project']) : null;
  const outDir = path.resolve(args.flags['--out'] || path.join(repoRoot, 'backups'));

  /** @type {{ role: string, path: string, prefix: string }[]} */
  const sources = [];
  if (isDirectory(workspaceDir)) {
    sources.push({ role: 'workspace', path: workspaceDir, prefix: 'workspace' });
  } else {
    process.stdout.write(`[backup] note: no workspace at ${workspaceDir} — nothing to archive from it.\n`);
  }
  if (projectDir !== null) {
    if (!isDirectory(projectDir)) fail(`--project ${projectDir} is not a directory.`);
    sources.push({ role: 'project', path: projectDir, prefix: `project/${path.basename(projectDir)}` });
  }
  if (sources.length === 0) fail('nothing to back up: the workspace does not exist and no --project was given.');

  fs.mkdirSync(outDir, { recursive: true });
  const now = new Date();
  const zipName = `forge-backup-${timestamp(now)}.zip`;
  const zipPath = path.join(outDir, zipName);
  const manifestPath = `${zipPath}.manifest.json`;

  const skipped = [];
  /** @type {{ path: string, role: string, bytes: number, sha256: string }[]} */
  const manifestFiles = [];
  let totalBytes = 0;

  const fd = fs.openSync(zipPath, 'w');
  const zip = new ZipWriter(fd);
  try {
    for (const source of sources) {
      const files = walk(source.path, includeAll, skipped);
      for (const file of files) {
        // Never archive the backup we are in the middle of writing.
        if (path.resolve(file.abs) === zipPath) continue;
        let content;
        try {
          content = fs.readFileSync(file.abs);
        } catch (err) {
          skipped.push({ path: file.abs, reason: `unreadable (${err.code || err.message})` });
          continue;
        }
        const entryName = `${source.prefix}/${file.rel.split('\\').join('/')}`;
        let mtime = now;
        try {
          mtime = fs.statSync(file.abs).mtime;
        } catch {
          /* keep the default */
        }
        zip.addFile(entryName, content, mtime);
        manifestFiles.push({
          path: entryName,
          role: source.role,
          bytes: content.length,
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
        });
        totalBytes += content.length;
      }
    }

    const manifest = {
      tool: 'forge-backup',
      formatVersion: 1,
      createdAt: now.toISOString(),
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      sources: sources.map((s) => ({ role: s.role, path: s.path, entryPrefix: s.prefix })),
      fileCount: manifestFiles.length,
      totalBytes,
      excludedByDefault: includeAll ? [] : [...DEFAULT_EXCLUDED_DIRS],
      skipped: skipped.map((s) => ({ path: s.path, reason: s.reason })),
      files: manifestFiles,
    };
    const manifestJson = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // The manifest itself is archived (so a lone .zip is self-describing) and
    // also written beside the zip as the printed hash manifest.
    zip.addFile('MANIFEST.json', manifestJson, now);
    zip.end();
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.writeFileSync(manifestPath, manifestJson);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    throw err;
  }

  const zipBytes = fs.statSync(zipPath).size;
  process.stdout.write('\n[backup] done.\n');
  process.stdout.write(`  files archived : ${manifestFiles.length}\n`);
  process.stdout.write(`  original bytes : ${totalBytes}\n`);
  process.stdout.write(`  archive bytes  : ${zipBytes}\n`);
  if (skipped.length > 0) process.stdout.write(`  skipped        : ${skipped.length} (see manifest.skipped)\n`);
  process.stdout.write(`  zip            : ${zipPath}\n`);
  process.stdout.write(`  manifest       : ${manifestPath}\n`);
  return 0;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

try {
  process.exit(main());
} catch (err) {
  fail(err && err.stack ? err.stack : String(err));
}
