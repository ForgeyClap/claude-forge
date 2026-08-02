#!/usr/bin/env node
/**
 * Forge Workspace — restore.
 *
 * Zero dependencies. Restores a backup produced by `backup.cjs` into a target
 * directory, verifying every file's SHA-256 against the archive's own manifest
 * before anything is written, printing a preview first, and refusing to
 * overwrite an existing file unless --force is given.
 *
 *   node scripts/restore.cjs --zip <file> --target <dir> [--force] [--dry-run]
 *                            [--only workspace|project|all]
 *
 * The order is deliberate and safe:
 *   1. read the archive and its MANIFEST.json;
 *   2. extract every member and check its CRC-32 and its manifest SHA-256 — a
 *      mismatch aborts the whole restore, because a restore that writes files it
 *      cannot vouch for is worse than no restore;
 *   3. print a preview: every target path, whether it is new or would overwrite,
 *      and the verification result;
 *   4. refuse (non-zero exit) if any file already exists and --force was not
 *      given, or if --dry-run was requested;
 *   5. only then write, each file to `<target>/<archived path>`.
 *
 * Entry names are checked for path traversal (a "zip-slip" `..` or an absolute
 * path) and every resolved destination is proven to stay under the target.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

/* -------------------------------------------------------------------------- */
/*  Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const flags = {};
  const bools = new Set();
  const takesValue = new Set(['--zip', '--target', '--only']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (takesValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value.`);
      flags[arg] = value;
      i += 1;
    } else if (arg === '--force' || arg === '--dry-run' || arg === '--help' || arg === '-h') {
      bools.add(arg);
    } else {
      fail(`Unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  return { flags, bools };
}

function fail(message) {
  process.stderr.write(`[restore] ERROR: ${message}\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  CRC-32                                                                     */
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

/* -------------------------------------------------------------------------- */
/*  ZIP reader (whole file in memory; no ZIP64)                                */
/* -------------------------------------------------------------------------- */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(buf) {
  const minLen = 22;
  const maxComment = 0xffff;
  const start = Math.max(0, buf.length - (minLen + maxComment));
  for (let i = buf.length - minLen; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Parse the central directory into { name, method, crc, cSize, uSize, localOffset }. */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) fail('this file has no ZIP end-of-central-directory record; it is not a readable zip.');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) fail('the central directory points past the end of the file; the archive is corrupt.');

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(p) !== CD_SIG) fail(`central directory entry ${i} has a bad signature; the archive is corrupt.`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const cSize = buf.readUInt32LE(p + 20);
    const uSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, crc, cSize, uSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one member's bytes, verifying its CRC-32. */
function extract(buf, entry) {
  if (buf.readUInt32LE(entry.localOffset) !== LOCAL_SIG) {
    fail(`local header for "${entry.name}" is missing; the archive is corrupt.`);
  }
  const nameLen = buf.readUInt16LE(entry.localOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const raw = buf.slice(dataStart, dataStart + entry.cSize);

  let content;
  if (entry.method === 0) content = raw;
  else if (entry.method === 8) content = zlib.inflateRawSync(raw);
  else fail(`"${entry.name}" uses unsupported compression method ${entry.method}.`);

  if (content.length !== entry.uSize) {
    fail(`"${entry.name}" inflated to ${content.length} bytes, not the ${entry.uSize} the directory declares.`);
  }
  if (crc32(content) !== entry.crc) {
    fail(`"${entry.name}" failed its CRC-32 check; the archive is damaged.`);
  }
  return content;
}

/* -------------------------------------------------------------------------- */
/*  Traversal-safe destination                                                 */
/* -------------------------------------------------------------------------- */

function safeJoin(target, entryName) {
  const normalised = entryName.split('\\').join('/');
  if (normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised)) {
    fail(`archive entry "${entryName}" is an absolute path; refusing to restore it.`);
  }
  for (const segment of normalised.split('/')) {
    if (segment === '..') fail(`archive entry "${entryName}" contains a ".." segment; refusing to restore it.`);
  }
  const resolvedTarget = path.resolve(target);
  const dest = path.resolve(resolvedTarget, normalised);
  const prefix = resolvedTarget.endsWith(path.sep) ? resolvedTarget : resolvedTarget + path.sep;
  if (dest !== resolvedTarget && !dest.startsWith(prefix)) {
    fail(`archive entry "${entryName}" resolves outside the target directory; refusing.`);
  }
  return dest;
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

function main() {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  if (bools.has('--help') || bools.has('-h')) {
    process.stdout.write(
      'Usage: node scripts/restore.cjs --zip <file> --target <dir> [--force] [--dry-run] [--only workspace|project|all]\n',
    );
    return 0;
  }

  const zipPath = flags['--zip'] ? path.resolve(flags['--zip']) : null;
  const target = flags['--target'] ? path.resolve(flags['--target']) : null;
  const only = flags['--only'] || 'all';
  const force = bools.has('--force');
  const dryRun = bools.has('--dry-run');

  if (zipPath === null) fail('--zip <file> is required.');
  if (target === null) fail('--target <dir> is required.');
  if (!['all', 'workspace', 'project'].includes(only)) fail('--only must be one of: all, workspace, project.');
  if (!fileExists(zipPath)) fail(`no such archive: ${zipPath}`);

  const buf = fs.readFileSync(zipPath);
  const entries = readCentralDirectory(buf);

  const manifestEntry = entries.find((e) => e.name === 'MANIFEST.json');
  if (manifestEntry === undefined) fail('the archive has no MANIFEST.json; it was not produced by backup.cjs.');
  let manifest;
  try {
    manifest = JSON.parse(extract(buf, manifestEntry).toString('utf8'));
  } catch (err) {
    fail(`MANIFEST.json could not be parsed: ${err.message}`);
  }
  const manifestByPath = new Map();
  for (const file of manifest.files || []) manifestByPath.set(file.path, file);

  // Build the plan: every member except the manifest, filtered by --only, each
  // extracted, CRC-checked and SHA-256-verified against the manifest up front.
  const plan = [];
  const problems = [];
  for (const entry of entries) {
    if (entry.name === 'MANIFEST.json') continue;
    const role = entry.name.startsWith('workspace/') ? 'workspace' : entry.name.startsWith('project/') ? 'project' : 'other';
    if (only !== 'all' && role !== only) continue;

    const content = extract(buf, entry);
    const declared = manifestByPath.get(entry.name);
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    let verified = true;
    if (declared === undefined) {
      verified = false;
      problems.push(`"${entry.name}" is in the archive but not in its manifest.`);
    } else if (declared.sha256 !== sha256) {
      verified = false;
      problems.push(`"${entry.name}" does not match its manifest SHA-256.`);
    }
    const dest = safeJoin(target, entry.name);
    plan.push({ name: entry.name, dest, content, sha256, verified, exists: fileExists(dest) });
  }

  if (plan.length === 0) fail(`the archive holds no files matching --only ${only}.`);

  // ---- preview ----------------------------------------------------------
  const collisions = plan.filter((p) => p.exists);
  process.stdout.write(`\n[restore] preview — ${zipPath}\n`);
  process.stdout.write(`  archived at : ${manifest.createdAt || 'unknown'}\n`);
  process.stdout.write(`  target      : ${target}\n`);
  process.stdout.write(`  selecting   : --only ${only}\n`);
  process.stdout.write(`  files       : ${plan.length}\n`);
  process.stdout.write(`  new         : ${plan.length - collisions.length}\n`);
  process.stdout.write(`  overwrite   : ${collisions.length}\n`);
  process.stdout.write(`  verified    : ${plan.filter((p) => p.verified).length}/${plan.length} against the manifest\n\n`);
  for (const item of plan.slice(0, 200)) {
    const state = item.exists ? 'OVERWRITE' : 'new      ';
    const mark = item.verified ? 'ok  ' : 'BAD ';
    process.stdout.write(`  [${state}] [${mark}] ${item.name}\n`);
  }
  if (plan.length > 200) process.stdout.write(`  ... and ${plan.length - 200} more\n`);

  // ---- gates ------------------------------------------------------------
  if (problems.length > 0) {
    process.stderr.write('\n[restore] REFUSING — verification failed:\n');
    for (const p of problems.slice(0, 50)) process.stderr.write(`  - ${p}\n`);
    process.stderr.write('Nothing was written.\n');
    return 2;
  }
  if (dryRun) {
    process.stdout.write('\n[restore] --dry-run: nothing was written.\n');
    return 0;
  }
  if (collisions.length > 0 && !force) {
    process.stderr.write(
      `\n[restore] REFUSING — ${collisions.length} file(s) already exist at the target. ` +
        'Re-run with --force to overwrite them. Nothing was written.\n',
    );
    return 3;
  }

  // ---- write ------------------------------------------------------------
  let written = 0;
  for (const item of plan) {
    fs.mkdirSync(path.dirname(item.dest), { recursive: true });
    // Temp-then-rename, so a crash mid-write cannot leave a half-file that would
    // pass as restored.
    const tmp = `${item.dest}.forge-restore.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, item.content, 0, item.content.length, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, item.dest);
    written += 1;
  }

  process.stdout.write(`\n[restore] done — ${written} file(s) written under ${target}.\n`);
  return 0;
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

try {
  process.exit(main());
} catch (err) {
  fail(err && err.stack ? err.stack : String(err));
}
